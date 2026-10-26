import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeviceErrorCode, KILL_SWITCH_FILE, REMOTE_CONFIG_DIR } from './constants.mjs';

/** Lỗi có mã để BE / Planner đọc được lý do. */
export class DeviceToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** realpath của tổ tiên gần nhất đã tồn tại + phần còn lại — dùng được cho đường dẫn chưa tồn tại (tệp sắp ghi). */
function realpathNearest(target) {
  let current = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  let real;
  try { real = fs.realpathSync.native(current); } catch { real = current; }
  return path.join(real, ...rest);
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Đường dẫn → đường tuyệt đối NẰM TRONG một thư mục gốc được phép. So bằng realpath (cả gốc lẫn đích), nên symlink / junction trỏ ra
 * ngoài gốc bị chặn. Đường tương đối tính từ gốc đầu tiên.
 */
export function resolveInRoots(roots, target = '') {
  if (!roots?.length) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, 'No allowed root directory on this device');
  const raw = String(target || '');
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots[0], raw);
  const real = realpathNearest(candidate);
  const allowed = roots.some((root) => isInside(realpathNearest(root), real));
  if (!allowed) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, `Path is outside the allowed folders: ${raw}`);
  if (isProtectedPath(real)) throw new DeviceToolError(DeviceErrorCode.PROTECTED_PATH, `Path holds Aivin credentials and is never accessible remotely: ${raw}`);
  return candidate;
}

/**
 * Thư mục cấu hình Aivin (`~/.aivin` + `AIVIN_REMOTE_HOME`): token thiết bị, API key của CLI, hồ sơ trình duyệt `aivin browser` (cookie
 * đăng nhập). Chặn kể cả khi người dùng cho phép cả thư mục nhà (`--dir ~`) — lộ ra là chiếm được tài khoản / phiên web của chủ máy.
 */
const PROTECTED_DIRS = [...new Set([REMOTE_CONFIG_DIR, path.join(os.homedir(), '.aivin')].map((d) => path.resolve(d)))];

let protectedReal;

export function isProtectedPath(absolute) {
  // realpath thư mục bảo vệ tính một lần — chỉ mục tệp gọi hàm này cho từng tệp.
  protectedReal ??= PROTECTED_DIRS.map(realpathNearest);
  const real = realpathNearest(absolute);
  return protectedReal.some((dir) => isInside(dir, real));
}

/** Đường hiển thị: tương đối với gốc chứa nó (gọn cho Planner), không thì tuyệt đối. */
export function displayPath(roots, absolute) {
  for (const root of roots || []) {
    if (isInside(path.resolve(root), absolute)) return path.relative(path.resolve(root), absolute) || '.';
  }
  return absolute;
}

const SECRET_ENV = /(^API_KEY$|^AIVIN_|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|COOKIE|SESSION_KEY|ACCESS_KEY|_API_KEY$)/i;

/** Biến môi trường cho lệnh chạy từ xa: bỏ mọi biến mang bí mật (API key của CLI, token, mật khẩu…). */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_ENV.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Lưới an toàn CUỐI cho lệnh shell: chỉ chặn các lệnh phá huỷ cả hệ thống (format ổ, xoá gốc, ghi đè thiết bị, fork bomb). Đây KHÔNG
 * phải cơ chế phân quyền — quyền nằm ở luật của agent phía BE; lưới này chỉ để một lệnh thảm hoạ không bao giờ chạy.
 */
const CATASTROPHIC_COMMANDS = [
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(del|erase)\s+(\/[a-z]\s+)*[a-z]:\\\s*(\*|$)/i,
  /\brmdir\s+(\/[a-z]\s+)*[a-z]:\\\s*$/i,
  /remove-item\s+.*-recurse.*\s[a-z]:\\\s*(\*\s*)?(-|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?(\/|\/\*|~|~\/|\$HOME)(\s|$)/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\s+.*of=\/dev\/(sd|nvme|hd|disk)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bdiskpart\b/i,
];

/** Lệnh nhắc tới thư mục cấu hình Aivin (`.aivin` như một đoạn đường dẫn, hoặc đường tuyệt đối của `AIVIN_REMOTE_HOME`). */
const AIVIN_DIR_SEGMENT = /(?:^|[\\/\s'"`~=:(;,|&])\.aivin(?=[\\/\s'"`);,|&]|$)/i;

function mentionsProtectedDir(command) {
  if (AIVIN_DIR_SEGMENT.test(command)) return true;
  const lower = command.toLowerCase().replace(/\\/g, '/');
  return PROTECTED_DIRS.some((dir) => lower.includes(dir.toLowerCase().replace(/\\/g, '/')));
}

/**
 * Lệnh nhắc tới thư mục bảo vệ bị chặn. Khớp chuỗi nên lách được (ghép chuỗi, mã hoá) — chỉ là sàn chống lỗi Planner / prompt injection
 * thông thường; cách ly thật cần sandbox của hệ điều hành (xem docs/official/device-agent/policy-approval.md ở repo be).
 */
export function assertCommandAllowed(command) {
  if (CATASTROPHIC_COMMANDS.some((re) => re.test(command))) {
    throw new DeviceToolError(DeviceErrorCode.BLOCKED_COMMAND, 'Command blocked by the device safety floor (destroys the whole system)');
  }
  if (mentionsProtectedDir(command)) {
    throw new DeviceToolError(DeviceErrorCode.PROTECTED_PATH, 'Command touches the Aivin credentials folder (.aivin), which is never accessible remotely');
  }
}

export function isRemotePaused() {
  return fs.existsSync(KILL_SWITCH_FILE);
}

/** Bật/tắt công tắc ngắt — chỉ người ngồi trước máy làm được (lệnh CLI cục bộ), BE không đổi được. */
export function setRemotePaused(paused) {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  if (paused) fs.writeFileSync(KILL_SWITCH_FILE, new Date().toISOString());
  else if (fs.existsSync(KILL_SWITCH_FILE)) fs.unlinkSync(KILL_SWITCH_FILE);
}
