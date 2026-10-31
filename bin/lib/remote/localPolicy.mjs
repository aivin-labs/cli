import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { DeviceErrorCode, REMOTE_CONFIG_DIR } from './constants.mjs';
import { DeviceToolError } from './sandbox.mjs';
import { openToken, sealToken } from './tokenStore.mjs';

/**
 * Sàn luật TẠI MÁY (29/10/2026). Trước đây máy tin BE gần như tuyệt đối: ngoài thư mục được phép + công tắc ngắt + vài lệnh thảm hoạ, mọi
 * quyết định duyệt nằm ở BE — BE / tài khoản admin bị chiếm hoặc agent bị prompt injection là chạy được lệnh trên mọi máy đã ghép (máy
 * toàn quyền còn không hỏi). Tệp `~/.aivin/remote-policy.json` do CHỦ MÁY đặt (`aivin remote policy …`).
 *
 * Chống agent tự nới luật (29/10/2026): thư mục `.aivin` chỉ được che bằng khớp chuỗi với lệnh shell — ghép chuỗi / chạy tệp script là ghi
 * đè được tệp luật. Nên tệp luật mang chữ ký HMAC bằng khoá cất trong kho bí mật của hệ điều hành (tokenStore.mjs), chỉ `aivin remote policy`
 * ký. Daemon (`createPolicyGuard`) chỉ nhận bản có chữ ký đúng; bản không ký / ký sai chỉ được SIẾT thêm so với bản đúng gần nhất, không
 * được nới. Không chống được mã độc cùng tài khoản biết cách gọi DPAPI / Keychain để ký lại — cách ly thật cần tài khoản hệ điều hành riêng
 * (policy-approval.md mục 8 ở repo be).
 *
 * - `deny_tools`: công cụ tắt hẳn trên máy này (không vào danh mục, gọi tới bị từ chối).
 * - `blocked_commands`: regex chặn thêm cho lệnh shell / tiến trình nền / lịch.
 * - `confirm`: việc nào phải có người bấm "Cho phép" NGAY TRÊN MÁY — `risky` (mặc định: lệnh nguy hiểm, xoá hẳn, gửi thư, đặt lịch),
 *   `always` (mọi việc có tác dụng), `never` (chỉ luật phía Aivin).
 */

export const REMOTE_POLICY_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-policy.json');

export const ConfirmMode = Object.freeze({ NEVER: 'never', RISKY: 'risky', ALWAYS: 'always' });

export const DEFAULT_LOCAL_POLICY = Object.freeze({ confirm: ConfirmMode.RISKY, deny_tools: [], blocked_commands: [], confirm_timeout_sec: 120 });

/** Mức chặt của chế độ xác nhận — số lớn hơn là chặt hơn. */
export const CONFIRM_RANK = Object.freeze({ [ConfirmMode.NEVER]: 0, [ConfirmMode.RISKY]: 1, [ConfirmMode.ALWAYS]: 2 });

/** Khoá ký tệp luật (bản mã của kho bí mật hệ điều hành, như token máy). */
export const REMOTE_POLICY_KEY_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-policy.key.json');
const POLICY_KEY_ACCOUNT = 'remote-policy-key';

/**
 * Công cụ mang lệnh để chạy → tham số chứa lệnh. `gui.act`: chữ gõ vào cửa sổ (hộp Run, terminal đang mở) cũng là một cách chạy lệnh —
 * xét cùng mẫu lệnh rủi ro / luật chặn của chủ máy.
 */
const COMMAND_ARG = Object.freeze({
  'shell.exec': 'command', 'proc.start': 'command', 'proc.write': 'text', 'sys.schedule': 'command',
  'gui.act': 'text', 'gui.do': 'value',
});

/** Công cụ luôn xét là rủi ro: gửi ra ngoài thay người dùng, cài việc chạy định kỳ (cách bám trụ kinh điển của mã độc). */
// meeting.start: ghi âm micro + âm thanh máy — AI không tự bật ghi âm khi không ai ngồi trước máy biết (29/10/2026).
const ALWAYS_RISKY_TOOLS = new Set(['office.outlook.send', 'sys.schedule', 'meeting.start']);
const ALWAYS_RISKY_REASON = {
  'office.outlook.send': 'Gửi thư thay bạn',
  'sys.schedule': 'Đặt việc chạy định kỳ trên máy',
  'meeting.start': 'Ghi âm cuộc họp (micro + âm thanh máy) và chụp màn hình',
};

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

/** Đọc luật trong tệp (không có tệp → mặc định), KHÔNG xét chữ ký — để hiện cho chủ máy. Daemon đọc qua `createPolicyGuard`. */
export function loadLocalPolicy(file = REMOTE_POLICY_FILE) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalize(null);
  }
}

/** Khoá đã giải theo bản mã trong tệp khoá — giải DPAPI tốn một tiến trình con, daemon đọc luật ở mỗi lời gọi. */
const keyCache = new Map();

function readKeyRecord(keyFile) {
  try { return JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch { return null; }
}

function writeKeyRecord(keyFile, record) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

/** Khoá ký luật; `create` → chưa có thì sinh + cất vào kho bí mật. `null` khi không có / không giải được. */
function policyKey(keyFile, { create = false } = {}) {
  const record = readKeyRecord(keyFile);
  const fingerprint = record ? `${record.token_store || ''}:${record.token_enc || record.device_token || ''}` : null;
  if (fingerprint && keyCache.get(keyFile)?.fingerprint === fingerprint) return keyCache.get(keyFile).key;
  let key = record ? openToken(record) : null;
  let fp = fingerprint;
  if (!key && create) {
    key = randomBytes(32).toString('hex');
    const { fallback_reason: _why, ...sealed } = sealToken(key, { account: POLICY_KEY_ACCOUNT });
    writeKeyRecord(keyFile, { device_id: POLICY_KEY_ACCOUNT, ...sealed });
    fp = `${sealed.token_store || ''}:${sealed.token_enc || sealed.device_token || ''}`;
  }
  if (key) keyCache.set(keyFile, { fingerprint: fp, key });
  return key;
}

const signPolicy = (clean, key) => createHmac('sha256', key).update(JSON.stringify(normalize(clean))).digest('hex');

function sealMatches(clean, seal, key) {
  if (typeof seal !== 'string' || !key) return false;
  const expected = Buffer.from(signPolicy(clean, key), 'hex');
  const actual = Buffer.from(seal, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Lưu luật + ký (chỉ `aivin remote policy` gọi). Bản có chữ ký được chép thêm vào tệp khoá (`policy`): tệp luật bị ghi đè trước khi daemon kịp
 * đọc bản đúng (hoặc daemon khởi động lại sau đó) thì vẫn có bản đúng làm gốc — chạy thật 29/10/2026: chỉ nhớ trong RAM là agent bật lại
 * được công cụ chủ máy vừa tắt.
 */
export function saveLocalPolicy(policy, file = REMOTE_POLICY_FILE, { keyFile = REMOTE_POLICY_KEY_FILE } = {}) {
  const clean = normalize(policy);
  const key = policyKey(keyFile, { create: true });
  const signed = { ...clean, ...(key ? { seal: signPolicy(clean, key) } : {}) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(signed, null, 2) + '\n', { mode: 0o600 });
  const record = key ? readKeyRecord(keyFile) : null;
  if (record) writeKeyRecord(keyFile, { ...record, policy: signed });
  return clean;
}

/** Bản có chữ ký đúng chép trong tệp khoá — `null` khi không có / sai chữ ký. */
function signedBackup(keyFile, key) {
  const saved = readKeyRecord(keyFile)?.policy;
  if (!saved || !key) return null;
  const policy = normalize(saved);
  return sealMatches(policy, saved.seal, key) ? policy : null;
}

/**
 * Luật trong tệp + có đúng chữ ký không + `base`: bản có chữ ký gần nhất (chép trong tệp khoá) để làm gốc khi tệp không đúng. Chưa từng đặt
 * luật (không có tệp lẫn khoá) → mặc định, coi là đúng. Có khoá mà mất tệp luật → bị xoá ngoài lệnh policy: không đúng.
 */
export function verifyLocalPolicy(file = REMOTE_POLICY_FILE, { keyFile = REMOTE_POLICY_KEY_FILE } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const keyExists = fs.existsSync(keyFile);
    return { policy: normalize(null), trusted: e?.code === 'ENOENT' && !keyExists, base: keyExists ? signedBackup(keyFile, policyKey(keyFile)) : null };
  }
  const policy = normalize(raw);
  const key = policyKey(keyFile);
  if (sealMatches(policy, raw?.seal, key)) return { policy, trusted: true, base: null };
  return { policy, trusted: false, base: signedBackup(keyFile, key) };
}

/** Bản chặt hơn của hai luật: xác nhận mức cao hơn, cộng dồn công cụ tắt / lệnh chặn; giờ chờ giữ theo bản đúng. */
export function stricterPolicy(trusted, other) {
  return {
    confirm: CONFIRM_RANK[other.confirm] > CONFIRM_RANK[trusted.confirm] ? other.confirm : trusted.confirm,
    deny_tools: [...new Set([...trusted.deny_tools, ...other.deny_tools])],
    blocked_commands: [...new Set([...trusted.blocked_commands, ...other.blocked_commands])],
    confirm_timeout_sec: trusted.confirm_timeout_sec,
  };
}

/**
 * Luật daemon dùng (đọc lại mỗi lời gọi — chủ máy đổi ở cửa sổ khác thì có hiệu lực ngay). Tệp có chữ ký đúng → dùng và nhớ làm bản đúng;
 * tệp bị sửa ngoài `aivin remote policy` → chặt hơn của (bản có chữ ký gần nhất — chép trong tệp khoá, không có thì bản đúng daemon đã thấy,
 * tệp): siết thì nhận, nới thì bỏ. `onTamper(policy)` báo một lần mỗi lần nội dung tệp đổi.
 */
export function createPolicyGuard({ file = REMOTE_POLICY_FILE, keyFile = REMOTE_POLICY_KEY_FILE, onTamper } = {}) {
  const first = verifyLocalPolicy(file, { keyFile });
  let lastTrusted = first.trusted ? first.policy : first.base || normalize(null);
  let reported = null;
  return {
    read() {
      const { policy, trusted, base } = verifyLocalPolicy(file, { keyFile });
      if (trusted) {
        lastTrusted = policy;
        reported = null;
        return policy;
      }
      if (base) lastTrusted = base;
      const effective = stricterPolicy(lastTrusted, policy);
      const fingerprint = JSON.stringify(policy);
      if (reported !== fingerprint) {
        reported = fingerprint;
        onTamper?.(effective);
      }
      return effective;
    },
  };
}

const commandOf = (toolName, args) => (COMMAND_ARG[toolName] ? String(args?.[COMMAND_ARG[toolName]] ?? '') : '');

/** Vì sao một lời gọi rủi ro (chuỗi ngắn để hiện cho người dùng) — `null` = không rủi ro. */
export function riskReason(tool, args = {}) {
  if (ALWAYS_RISKY_TOOLS.has(tool.name)) return ALWAYS_RISKY_REASON[tool.name];
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
  // gui.do is only a compact route into the same GUI actuator. A device owner who disabled the
  // lower-level actuator must not get it back merely because a newer CLI advertised the fast path.
  const deniedByAlias = tool.name === 'gui.do' && policy.deny_tools.includes('gui.act');
  if (policy.deny_tools.includes(tool.name) || deniedByAlias) {
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
  if (tool.name === 'meeting.start') return cut(`${args.title || 'Cuộc họp'}${args.then ? ` — sau đó: ${args.then}` : ''}`, 300);
  if (args.path) return cut(args.path, 300);
  if (Array.isArray(args.paths)) return cut(args.paths.join(', '), 300);
  return tool.name;
}
