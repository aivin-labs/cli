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

/**
 * Đường dẫn mạng / thiết bị (`\\host\share`, `//host/share`, `\\?\`, `\\.\`): chạm vào (kể cả `existsSync`) là Windows tự gửi thông tin xác thực
 * NTLM ra máy ngoài — chặn theo CHUỖI trước mọi lời gọi fs (rà 28/10/2026).
 */
export function isNetworkPath(raw) {
  return /^[\\/]{2}/.test(String(raw || '').trim());
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Đường dẫn → đường tuyệt đối NẰM TRONG một thư mục gốc được phép. So bằng realpath (cả gốc lẫn đích), nên symlink / junction trỏ ra
 * ngoài gốc bị chặn. Đường tương đối tính từ gốc đầu tiên. Trả về CHÍNH đường realpath đã kiểm (không phải đường chưa giải): thao tác
 * sau đó không đi lại qua symlink mà tiến trình khác có thể tráo giữa lúc kiểm và lúc dùng.
 */
export function resolveInRoots(roots, target = '') {
  if (!roots?.length) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, 'No allowed root directory on this device');
  const raw = String(target || '');
  if (isNetworkPath(raw)) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, `Network / device paths are not allowed: ${raw}`);
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots[0], raw);
  const real = realpathNearest(candidate);
  const allowed = roots.some((root) => isInside(realpathNearest(root), real));
  if (!allowed) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, `Path is outside the allowed folders: ${raw}`);
  if (isProtectedPath(real)) throw new DeviceToolError(DeviceErrorCode.PROTECTED_PATH, `Path holds Aivin credentials and is never accessible remotely: ${raw}`);
  return real;
}

/**
 * Như resolveInRoots nhưng KHÔNG đi theo thành phần cuối (cho xoá / chuyển): thư mục cha giải realpath + kiểm trong gốc, tên cuối giữ
 * nguyên — xoá một symlink là xoá chính symlink đó, không xoá thư mục nó trỏ tới.
 */
export function resolveEntryInRoots(roots, target = '') {
  const real = resolveInRoots(roots, target);
  const raw = String(target || '');
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots[0], raw);
  const parent = path.dirname(candidate);
  if (parent === candidate || isRootPath(roots, real)) return real;
  return path.join(resolveInRoots(roots, parent), path.basename(candidate));
}

/** Đường (đã giải) có phải chính một thư mục gốc không — so cả dạng gốc lẫn realpath của gốc. */
export function isRootPath(roots, absolute) {
  return (roots || []).some((r) => path.resolve(r) === absolute || realpathNearest(r) === absolute);
}

/**
 * Thư mục cấu hình Aivin (`~/.aivin` + `AIVIN_REMOTE_HOME`): token thiết bị, API key của CLI, hồ sơ trình duyệt `aivin browser` (cookie
 * đăng nhập). Chặn kể cả khi người dùng cho phép cả thư mục nhà (`--dir ~`) — lộ ra là chiếm được tài khoản / phiên web của chủ máy.
 * `~/.aivin-release` (29/10/2026): chỗ mặc định giữ khoá ký bản phát hành CLI (scripts/release-key.mjs) — máy của người phát hành mà ghép
 * toàn quyền thì agent bị lừa đọc được khoá là ký được bản độc cho mọi máy đã cài.
 */
const PROTECTED_DIRS = [...new Set([REMOTE_CONFIG_DIR, path.join(os.homedir(), '.aivin'), path.join(os.homedir(), '.aivin-release')].map((d) => path.resolve(d)))];

let protectedReal;

export function isProtectedPath(absolute) {
  // realpath thư mục bảo vệ tính một lần — chỉ mục tệp gọi hàm này cho từng tệp.
  protectedReal ??= PROTECTED_DIRS.map(realpathNearest);
  const real = realpathNearest(absolute);
  return protectedReal.some((dir) => isInside(dir, real));
}

/** Thư mục BAO TRỌN một thư mục bảo vệ — xoá / chuyển nó là xoá / chuyển luôn token. */
export function containsProtectedPath(absolute) {
  protectedReal ??= PROTECTED_DIRS.map(realpathNearest);
  const real = realpathNearest(absolute);
  return protectedReal.some((dir) => isInside(real, dir));
}

/**
 * Tên thư mục cần loại khỏi ripgrep khi tìm dưới `base`: luôn `.aivin`, cộng tên thư mục `AIVIN_REMOTE_HOME` nếu nó nằm trong `base`
 * (chỉ khi đó — loại theo tên ở mọi nơi sẽ bỏ sót cả thư mục trùng tên của người dùng).
 */
export function protectedDirNamesUnder(base) {
  protectedReal ??= PROTECTED_DIRS.map(realpathNearest);
  const real = realpathNearest(base);
  const names = new Set(['.aivin', '.aivin-release']);
  for (const dir of protectedReal) if (dir !== real && isInside(real, dir)) names.add(path.basename(dir));
  return [...names];
}

/**
 * Đường hiển thị: tương đối với gốc ĐẦU TIÊN (gọn cho Planner), ngoài nó thì tuyệt đối. Chỉ gốc đầu: đường tương đối luôn được hiểu
 * theo gốc đầu (resolveInRoots) — rút gọn theo gốc khác (vd ổ D: khi toàn quyền) thì Planner dùng lại sẽ trỏ nhầm sang thư mục nhà.
 */
const rootRealCache = new Map();

export function displayPath(roots, absolute) {
  const first = roots?.[0];
  if (!first) return absolute;
  // resolveInRoots trả realpath → so với realpath của gốc trước (gốc là junction / symlink), rồi mới tới dạng gốc.
  if (!rootRealCache.has(first)) rootRealCache.set(first, realpathNearest(first));
  for (const base of [rootRealCache.get(first), path.resolve(first)]) {
    if (isInside(base, absolute)) return path.relative(base, absolute) || '.';
  }
  return absolute;
}

/**
 * Gốc khi chủ máy cho TOÀN QUYỀN (`--full-access`): thư mục nhà đứng đầu (đường tương đối tính từ đây), rồi mọi ổ đĩa (Windows: các
 * ổ có mặt; macOS/Linux: `/`). Thư mục cấu hình Aivin vẫn bị chặn (isProtectedPath), lệnh thảm hoạ vẫn bị chặn.
 */
export function fullAccessRoots() {
  const home = os.homedir();
  if (process.platform !== 'win32') return [home, '/'];
  const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`).filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
  return [home, ...drives];
}

const SECRET_ENV = /(^API_KEY$|^AIVIN_|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|COOKIE|SESSION_KEY|ACCESS_KEY|_API_KEY$|CONNECTION_?STRING|CONN_?STR|DATABASE_URL)/i;
/**
 * Đoạn tên (tách theo `_`) mang bí mật: `DB_PASS`, `STRIPE_KEY`, `GH_PAT`, `X_SIGNING_KEY`, `SSH_AUTH_SOCK`, `SENTRY_DSN`… So nguyên
 * đoạn, không so chuỗi con — `PATH` không dính `PAT`, `KEYBOARD_LAYOUT` không dính `KEY`.
 */
const SECRET_SEGMENTS = new Set([
  'KEY', 'KEYS', 'APIKEY', 'ACCESSKEY', 'PASS', 'PASSWD', 'PASSWORD', 'PASSPHRASE', 'ASKPASS', 'PAT', 'TOKEN', 'TOKENS', 'SECRET', 'SECRETS',
  'AUTH', 'DSN', 'CREDENTIAL', 'CREDENTIALS', 'CREDS', 'COOKIE', 'COOKIES', 'SESSION', 'SIGNING', 'PRIVATE',
]);
/** Biến vô hại có đoạn trùng danh sách trên — vẫn giữ (thư mục hiện tại, D-Bus cho thông báo, loại phiên đồ hoạ). */
const SAFE_ENV = new Set(['PWD', 'OLDPWD', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_SESSION_CLASS', 'XDG_SESSION_DESKTOP']);
/** Giá trị là URL kèm mật khẩu (`postgres://u:p@host/db`) — bỏ bất kể tên biến. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

export function isSecretEnv(key, value = '') {
  const name = String(key).toUpperCase();
  if (SAFE_ENV.has(name)) return false;
  if (SECRET_ENV.test(name)) return true;
  const segments = name.split('_').filter(Boolean);
  // `PWD` đứng một mình là thư mục hiện tại; là một đoạn của tên dài hơn (`DB_PWD`) thì là mật khẩu.
  if (segments.some((seg) => SECRET_SEGMENTS.has(seg) || (seg === 'PWD' && segments.length > 1))) return true;
  return URL_WITH_PASSWORD.test(String(value ?? ''));
}

/** Biến môi trường cho lệnh chạy từ xa: bỏ mọi biến mang bí mật (API key của CLI, token, mật khẩu, chuỗi kết nối…). */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretEnv(key, value)) out[key] = value;
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

/** Lệnh nhắc tới thư mục cấu hình Aivin / khoá ký (`.aivin`, `.aivin-release` như một đoạn đường dẫn, hoặc đường tuyệt đối của `AIVIN_REMOTE_HOME`). */
const AIVIN_DIR_SEGMENT = /(?:^|[\\/\s'"`~=:(;,|&])\.aivin(?:-release)?(?=[\\/\s'"`);,|&]|$)/i;

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
