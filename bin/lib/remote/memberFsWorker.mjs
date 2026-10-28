import { DeviceErrorCode } from './constants.mjs';
import { DeviceToolError } from './sandbox.mjs';
import { buildTools, toolMap } from './toolHandlers.mjs';
import { MEMBER_FS_CONFIG_ENV, runsInMemberWorker } from './memberFsPool.mjs';

/**
 * Tiến trình con chạy công cụ tệp dưới tài khoản một thành viên máy tính tổ chức (xem memberFsPool.mjs). Dùng đúng các handler `fs.*`
 * của toolHandlers.mjs với gốc = thư mục nhà của thành viên + thư mục chung; không giữ bí mật nào của daemon.
 */

function readConfig() {
  try { return JSON.parse(process.env[MEMBER_FS_CONFIG_ENV] || '{}') || {}; } catch { return {}; }
}
const config = readConfig();
delete process.env[MEMBER_FS_CONFIG_ENV];

// Lưới cuối: đổi tài khoản không thành (vẫn là root / sai uid) thì không chạy gì cả.
if (typeof config.expectUid === 'number' && process.getuid?.() !== config.expectUid) {
  console.error(`[aivin fs worker] wrong uid ${process.getuid?.()} (expected ${config.expectUid}) — exiting`);
  process.exit(70);
}

const env = { roots: Array.isArray(config.roots) ? config.roots : [], binaries: Array.isArray(config.binaries) ? config.binaries : [], projects: [], fileIndex: null };
const tools = toolMap(buildTools(env).filter((t) => runsInMemberWorker(t.name)));
const inflight = new Map();

function reply(payload) {
  try { process.send?.(payload); } catch { /* daemon đã ngắt */ }
}

async function runCall({ id, tool, args, timeoutMs }) {
  const spec = tools.get(tool);
  if (!spec) return reply({ id, ok: false, error: `Unknown tool: ${tool}`, error_code: DeviceErrorCode.TOOL_UNKNOWN });
  const controller = new AbortController();
  inflight.set(id, controller);
  const ms = Math.max(1000, Number(timeoutMs) || 60_000);
  const timer = setTimeout(() => controller.abort(new DeviceToolError(DeviceErrorCode.CALL_TIMEOUT, `Timed out after ${ms} ms`)), ms);
  try {
    const result = await spec.handler(args && typeof args === 'object' ? args : {}, { signal: controller.signal, timeoutMs: ms }, env);
    reply({ id, ok: true, result });
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    reply({ id, ok: false, error: reason?.message || String(reason), error_code: reason?.code || DeviceErrorCode.EXECUTION_FAILED });
  } finally {
    clearTimeout(timer);
    inflight.delete(id);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.cancel !== undefined) {
    inflight.get(msg.cancel)?.abort(new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled by server'));
    return;
  }
  void runCall(msg).catch((e) => reply({ id: msg.id, ok: false, error: e?.message || String(e), error_code: DeviceErrorCode.EXECUTION_FAILED }));
});
// Daemon thoát / tắt vì rảnh → kênh IPC đóng → tiến trình con thoát theo.
process.on('disconnect', () => process.exit(0));
process.on('unhandledRejection', (e) => console.error('[aivin fs worker] unhandled rejection:', e?.message || e));
