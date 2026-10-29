import fs from 'fs';
import path from 'path';
import { DeviceErrorCode, REMOTE_CONFIG_DIR } from './constants.mjs';
import { DeviceToolError } from './sandbox.mjs';

/**
 * Sàn luật TẠI MÁY (29/10/2026). Trước đây máy tin BE gần như tuyệt đối: ngoài thư mục được phép + công tắc ngắt + vài lệnh thảm hoạ, mọi
 * quyết định duyệt nằm ở BE — BE / tài khoản admin bị chiếm hoặc agent bị prompt injection là chạy được lệnh trên mọi máy đã ghép (máy
 * toàn quyền còn không hỏi). Tệp `~/.aivin/remote-policy.json` do CHỦ MÁY đặt (`aivin remote policy …`); thư mục `.aivin` bị chặn với mọi
 * công cụ từ xa nên AI / BE không sửa được.
 *
 * - `deny_tools`: công cụ tắt hẳn trên máy này (không vào danh mục, gọi tới bị từ chối).
 * - `blocked_commands`: regex chặn thêm cho lệnh shell / tiến trình nền / lịch.
 * - `confirm`: việc nào phải có người bấm "Cho phép" NGAY TRÊN MÁY — `risky` (mặc định: lệnh nguy hiểm, xoá hẳn, gửi thư, đặt lịch),
 *   `always` (mọi việc có tác dụng), `never` (chỉ luật phía Aivin).
 */

export const REMOTE_POLICY_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-policy.json');

export const ConfirmMode = Object.freeze({ NEVER: 'never', RISKY: 'risky', ALWAYS: 'always' });

export const DEFAULT_LOCAL_POLICY = Object.freeze({ confirm: ConfirmMode.RISKY, deny_tools: [], blocked_commands: [], confirm_timeout_sec: 120 });

/** Công cụ mang lệnh để chạy → tham số chứa lệnh. */
const COMMAND_ARG = Object.freeze({ 'shell.exec': 'command', 'proc.start': 'command', 'proc.write': 'text', 'sys.schedule': 'command' });

/** Công cụ luôn xét là rủi ro: gửi ra ngoài thay người dùng, cài việc chạy định kỳ (cách bám trụ kinh điển của mã độc). */
const ALWAYS_RISKY_TOOLS = new Set(['office.outlook.send', 'sys.schedule']);

/**
 * Lệnh có hậu quả khó lấy lại / chạm bảo mật — khớp chuỗi nên lách được (ghép chuỗi, mã hoá), nhưng chính các cách lách thông dụng
 * (`-EncodedCommand`, `iex`, `| sh`) cũng nằm trong danh sách.
 */
const RISKY_COMMAND_PATTERNS = [
  // Xoá đệ quy / xoá hẳn
  /\brm\s+-[a-z]*r/i, /remove-item\b[^|;]*-recurse/i, /\b(rd|rmdir)\s+\/s/i, /\bdel\s+(\/[a-z]\s+)*\/s/i, /\bshred\b/i,
  // Registry, dịch vụ, khởi động, tường lửa, chính sách hệ thống
  /\breg(\.exe)?\s+(add|delete|import)\b/i, /(set|new|remove)-itemproperty\b[^|;]*\bhk(lm|cu)/i,
  /\bsc(\.exe)?\s+(config|delete|create|stop)\b/i, /\b(stop|set|new)-service\b/i, /\bsystemctl\s+(disable|stop|mask)\b/i,
  /\bbcdedit\b/i, /\bnetsh\b/i, /\bschtasks\b/i, /\bcrontab\s+-r\b/i, /\b(shutdown|restart-computer|stop-computer)\b/i, /\breboot\b/i,
  // Tắt bảo vệ / đổi quyền hàng loạt / nâng quyền
  /\b(set|add)-mppreference\b/i, /\bdisable-?(windows)?defender/i, /\btakeown\b/i, /\bicacls\b[^|;]*\/grant/i,
  /\bchmod\s+(-[a-z]*r[a-z]*\s+)?[0-7]*7{2,}/i, /\bchown\s+-[a-z]*r/i, /\bsudo\b/i, /\brunas\b/i, /-verb\s+runas/i,
  // Kho mật khẩu / khoá đăng nhập
  /\bcmdkey\b/i, /\bsecurity\s+(find|dump|export)-/i, /\bvaultcmd\b/i, /login data|cookies\.sqlite|keychain-db|\.ssh[\\/]id_/i,
  // Tải về rồi chạy / chạy chuỗi mã hoá
  /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;]*\|\s*(iex|invoke-expression)\b/i,
  /\b(iex|invoke-expression)\b/i, /-e(nc(odedcommand)?)?\s+[a-z0-9+/=]{20,}/i, /\bbase64\s+(-d|--decode)\b[^|;]*\|\s*(ba|z)?sh\b/i,
  // Đẩy đè lịch sử git
  /\bgit\s+push\b[^|;]*(--force\b|\s-f\b)/i,
];

function normalize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const confirm = Object.values(ConfirmMode).includes(p.confirm) ? p.confirm : DEFAULT_LOCAL_POLICY.confirm;
  const timeout = Number(p.confirm_timeout_sec);
  return {
    confirm,
    deny_tools: list(p.deny_tools),
    blocked_commands: list(p.blocked_commands).filter((re) => { try { new RegExp(re, 'i'); return true; } catch { return false; } }),
    confirm_timeout_sec: Number.isFinite(timeout) && timeout >= 15 && timeout <= 900 ? Math.round(timeout) : DEFAULT_LOCAL_POLICY.confirm_timeout_sec,
  };
}

/** Đọc luật của máy (không có tệp → mặc định). Đọc lại mỗi lần gọi: chủ máy sửa bằng lệnh CLI ở cửa sổ khác thì có hiệu lực ngay. */
export function loadLocalPolicy(file = REMOTE_POLICY_FILE) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalize(null);
  }
}

export function saveLocalPolicy(policy, file = REMOTE_POLICY_FILE) {
  const clean = normalize(policy);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  return clean;
}

const commandOf = (toolName, args) => (COMMAND_ARG[toolName] ? String(args?.[COMMAND_ARG[toolName]] ?? '') : '');

/** Vì sao một lời gọi rủi ro (chuỗi ngắn để hiện cho người dùng) — `null` = không rủi ro. */
export function riskReason(tool, args = {}) {
  if (ALWAYS_RISKY_TOOLS.has(tool.name)) return tool.name === 'office.outlook.send' ? 'Gửi thư thay bạn' : 'Đặt việc chạy định kỳ trên máy';
  if (tool.destructive && args.permanent === true) return 'Xoá hẳn, không lấy lại được';
  const command = commandOf(tool.name, args);
  if (command && RISKY_COMMAND_PATTERNS.some((re) => re.test(command))) return 'Lệnh có thể thay đổi hệ thống hoặc cài đặt bảo mật';
  return null;
}

/**
 * Quyết định của sàn luật cho một lời gọi: `{ action: 'allow' }`, `{ action: 'confirm', reason }` hoặc ném `DeviceToolError` khi bị cấm.
 * Lời gọi nội bộ (BE tự dùng: đọc khúc tệp, ghi nhớ…) và chỉ đọc không bao giờ cần xác nhận.
 */
export function evaluateLocalPolicy(policy, tool, args = {}) {
  if (policy.deny_tools.includes(tool.name)) {
    throw new DeviceToolError(DeviceErrorCode.LOCAL_DENIED, `The owner of this computer turned off ${tool.name} here`);
  }
  const command = commandOf(tool.name, args);
  if (command && policy.blocked_commands.some((re) => new RegExp(re, 'i').test(command))) {
    throw new DeviceToolError(DeviceErrorCode.LOCAL_DENIED, 'Command blocked by a rule the owner of this computer set');
  }
  if (tool.read_only || tool.internal || policy.confirm === ConfirmMode.NEVER) return { action: 'allow' };
  if (policy.confirm === ConfirmMode.ALWAYS) return { action: 'confirm', reason: riskReason(tool, args) || 'Thay đổi trên máy (bạn đặt luật hỏi mọi việc)' };
  const reason = riskReason(tool, args);
  return reason ? { action: 'confirm', reason } : { action: 'allow' };
}

/** Một dòng mô tả lời gọi cho hộp xác nhận (lệnh / người nhận / đường dẫn), cắt gọn. */
export function describeCall(tool, args = {}) {
  const cut = (s, n = 500) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
  const command = commandOf(tool.name, args);
  if (command) return cut(command);
  if (tool.name === 'office.outlook.send') return cut(`Tới: ${args.to || '?'} — ${args.subject || ''}`, 300);
  if (args.path) return cut(args.path, 300);
  if (Array.isArray(args.paths)) return cut(args.paths.join(', '), 300);
  return tool.name;
}
