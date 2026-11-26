import { ToolGroup } from './constants.mjs';
import { ensureLightcodeRunning, normalizeRunAs, readHeadlessConnector } from './lightcodeAgent.mjs';

/**
 * Đồng bộ đăng nhập tài khoản AI (Claude / Codex / Gemini) giữa LightCode trên máy cá nhân và Cloud Computer của CHÍNH người đó (26/11/2026,
 * hợp đồng: docs/aivin-account-sync.md bên LightCode). Chỉ BE gọi (`internal`, Planner không thấy): BE điều phối `key` (bên nhận) →
 * `export` (bên gửi) → `import` (bên nhận), CLI chỉ chuyển từng bước tới cửa cục bộ của LightCode.
 *
 * An toàn: `sealed` (đăng nhập đã niêm phong) không bao giờ được log, không ghi đĩa (công cụ `sensitive` → sổ lời gọi giữ kết quả trong bộ
 * nhớ), lỗi không kèm nội dung gửi lên. Cloud Computer: `run_as` lấy từ tài khoản Linux CLI cấp cho đúng vùng người dùng của lời gọi
 * (BE quyết định vùng từ người đang đăng nhập — trình duyệt không gửi được).
 */

export const ACCOUNT_SYNC_TOOL = 'lightcode.account_sync';
export const AccountSyncOp = Object.freeze({ LIST: 'list', KEY: 'key', EXPORT: 'export', IMPORT: 'import' });
const OPS = new Set(Object.values(AccountSyncOp));
const CALL_TIMEOUT_MS = 30_000;
/** Mã lỗi LightCode trả (`code`) — các mã khác gộp thành `failed`. */
const KNOWN_CODES = new Set([
  'local_only', 'not_synced', 'run_as_required', 'not_shared', 'not_signed_in', 'unsupported_provider',
  'invalid_key', 'key_expired', 'bad_payload', 'license_required', 'member_fs_failed',
]);

/** Chỉ những trường hợp đồng cho phép đi tiếp (không chuyển nguyên args của BE). */
export function bodyFor(op, args = {}) {
  const pick = (...keys) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
  if (op === AccountSyncOp.EXPORT) return pick('account_id', 'provider', 'recipient_key');
  if (op === AccountSyncOp.IMPORT) return { sealed: args.sealed, ...(args.replace === true ? { replace: true } : {}) };
  return {};
}

/**
 * Không ném lỗi: BE cần mã lý do để báo người dùng đúng việc phải làm. Kết quả thành công mang nguyên thân trả lời của LightCode.
 * `deps`: connector (đã biết), ensure, fetchImpl, headless (đọc connector Cloud Computer).
 */
export async function lightcodeAccountSync(args = {}, env = {}, deps = {}) {
  const refused = (reason, status) => ({ ok: false, reason, ...(status ? { status } : {}) });
  const op = args.op;
  if (!OPS.has(op)) return refused('bad_op');
  let runAs;
  if (env?.runAs) {
    try { runAs = normalizeRunAs(env.runAs); } catch { return refused('run_as_required'); }
  }
  let info;
  try {
    info = deps.connector || (runAs ? (deps.headless || readHeadlessConnector)() : await (deps.ensure || ensureLightcodeRunning)(deps));
  } catch { info = null; }
  if (!info) return refused('not_running');
  let res;
  try {
    res = await (deps.fetchImpl || globalThis.fetch)(`http://127.0.0.1:${info.port}/connector/v1/aivin/accounts/${op}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bodyFor(op, args), ...(runAs ? { run_as: runAs } : {}) }),
      signal: AbortSignal.timeout(deps.timeoutMs || CALL_TIMEOUT_MS),
    });
  } catch { return refused('not_running'); }
  // 404 không kèm `code` = bản LightCode chưa có cửa đồng bộ tài khoản.
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404 && !body?.code) return refused('outdated', 404);
    return refused(KNOWN_CODES.has(body?.code) ? body.code : 'failed', res.status);
  }
  return { ok: true, data: body };
}

export function buildAccountSyncTools() {
  return [
    // `sensitive`: kết quả (khoá + đăng nhập niêm phong) chỉ ở bộ nhớ, không vào hộp gửi trên đĩa. BE không gửi `idem_key` cho công cụ này.
    { name: ACCOUNT_SYNC_TOOL, group: ToolGroup.PROC, internal: true, sensitive: true, handler: (a, _c, env) => lightcodeAccountSync(a, env),
      description: 'BE-only: copy an AI account login (Claude, Codex, Gemini) between this LightCode and the owner\'s AIVIN Cloud Computer (list, key, export, import).',
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: [...OPS] },
        account_id: { type: 'string' }, provider: { type: 'string' }, recipient_key: { type: 'object' }, sealed: { type: 'object' }, replace: { type: 'boolean' },
      }, required: ['op'] } },
  ];
}
