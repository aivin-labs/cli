import path from 'path';
import { DEFAULT_GROUP_LIMITS, DeviceErrorCode } from './constants.mjs';
import { DeviceToolError } from './sandbox.mjs';

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }
  };
  return {
    async acquire() {
      if (active < limit) { active++; return release; }
      await new Promise((resolve) => queue.push(resolve));
      return release;
    },
    stats: () => ({ active, queued: queue.length, limit }),
  };
}

function groupLimit(group) {
  const fromEnv = Number(process.env[`AIVIN_REMOTE_LIMIT_${String(group).toUpperCase()}`]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (DEFAULT_GROUP_LIMITS[group] ?? 4);
}

/**
 * Khoá đường dẫn so theo dạng chuẩn hoá: Windows / macOS không phân biệt hoa thường (`A.txt` và `a.txt` là một tệp), và có dấu phân cách cuối
 * để so cha – con (`C:\a` chứa `C:\a\b`, không chứa `C:\ab`).
 */
export function lockKeyOf(key, platform = process.platform) {
  const p = path.resolve(String(key));
  const folded = platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
  return folded.endsWith(path.sep) ? folded : folded + path.sep;
}

/** Hai khoá đụng nhau khi là cùng đường hoặc một bên nằm trong bên kia (xoá thư mục `a` và ghi `a/b.txt` phải chạy lần lượt). */
const overlaps = (a, b) => a.startsWith(b) || b.startsWith(a);

/** Lỗi trả về khi lời gọi bị huỷ / hết giờ TRƯỚC khi công cụ chạy: chưa có gì xảy ra, Planner làm lại được. */
function notStarted(reason) {
  const why = reason?.code === DeviceErrorCode.CALL_TIMEOUT ? 'timed out' : 'was cancelled';
  return new DeviceToolError(DeviceErrorCode.NOT_STARTED, `The step ${why} while waiting for its turn on this device — it did not run, nothing changed`);
}

/**
 * Bộ điều phối lời gọi trên máy: mỗi nhóm công cụ một semaphore (đọc tệp 16, chạy lệnh 3…), thao tác ghi khoá theo đường dẫn (hai lệnh ghi
 * cùng tệp — hoặc tệp nằm trong thư mục đang bị xoá / chuyển — chạy lần lượt, không liên quan thì song song), mỗi lời gọi một AbortController
 * (huỷ / hết giờ → dừng cả cây tiến trình con).
 *
 * Kết quả lỗi mang `ran`: công cụ đã bắt đầu chạy chưa. Huỷ / hết giờ lúc còn xếp hàng (semaphore, khoá đường dẫn) → `NOT_STARTED`, công cụ
 * không bao giờ chạy sau đó; huỷ / hết giờ giữa chừng → mã gốc (`CALL_TIMEOUT` / `CANCELLED`) với `ran: true` — có thể đã làm một phần
 * (idempotency.mjs không cho chạy lại mù quáng).
 *
 * `scopeLimits` (máy tính tổ chức): thêm trần theo từng thành viên (`call.user_scope`) trong mỗi nhóm. Lấy chỗ của vùng TRƯỚC rồi mới
 * tới chỗ chung — lời gọi đang chờ trần của riêng mình không giữ chỗ chung của người khác. Không truyền → như máy một người.
 */
export function createScheduler({ scopeLimits = null } = {}) {
  const semaphores = new Map();
  const scopeSemaphores = new Map();
  const lockEntries = new Set();
  const inflight = new Map();

  const semaphoreOf = (group) => {
    if (!semaphores.has(group)) semaphores.set(group, createSemaphore(groupLimit(group)));
    return semaphores.get(group);
  };

  const scopeSemaphoreOf = (scope, group) => {
    const fromEnv = Number(process.env[`AIVIN_REMOTE_SCOPE_LIMIT_${String(group).toUpperCase()}`]);
    const limit = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : scopeLimits?.[group];
    if (!limit || typeof scope !== 'string' || !scope) return null;
    const key = `${scope}\u0000${group}`;
    if (!scopeSemaphores.has(key)) scopeSemaphores.set(key, createSemaphore(limit));
    return scopeSemaphores.get(key);
  };

  /** Chờ mọi khoá vào TRƯỚC mà đụng nhau (thứ tự vào hàng — không có vòng chờ), rồi mới chạy. Bị huỷ trong lúc chờ → không chạy. */
  async function withPathLocks(keys, fn, signal) {
    const mine = [...new Set(keys.map((k) => lockKeyOf(k)))];
    const blockers = [...lockEntries].filter((e) => e.keys.some((k) => mine.some((m) => overlaps(k, m)))).map((e) => e.promise);
    let done;
    const entry = { keys: mine, promise: new Promise((resolve) => { done = resolve; }) };
    lockEntries.add(entry);
    try {
      if (blockers.length) await Promise.race([Promise.all(blockers), abortPromise(signal)]);
      if (signal.aborted) throw notStarted(signal.reason);
      return await fn();
    } finally {
      done();
      lockEntries.delete(entry);
    }
  }

  /**
   * Chạy một lời gọi. `spec`: { group, lockKeys?(args) }, `handler(args, ctx)`; ctx = { signal, onOutput }.
   * Không ném lỗi: trả { ok, result } hoặc { ok:false, error, error_code, ran }.
   */
  async function run(call, spec, handler, { onOutput } = {}) {
    const controller = new AbortController();
    inflight.set(call.call_id, controller);
    const startedAt = Date.now();
    const timeoutMs = Math.max(1000, Number(call.timeout_ms) || 60_000);
    const timer = setTimeout(() => controller.abort(new DeviceToolError(DeviceErrorCode.CALL_TIMEOUT, `Timed out after ${timeoutMs} ms`)), timeoutMs);
    let ran = false;
    let releaseScope = null;
    let release = null;
    try {
      releaseScope = scopeLimits ? await scopeSemaphoreOf(call.user_scope, spec.group)?.acquire() : null;
      release = await semaphoreOf(spec.group).acquire();
      if (controller.signal.aborted) throw notStarted(controller.signal.reason);
      const exec = () => {
        ran = true;
        return handler(call.args || {}, { signal: controller.signal, onOutput, timeoutMs });
      };
      const keys = spec.lockKeys ? spec.lockKeys(call.args || {}) : [];
      const result = keys.length ? await withPathLocks(keys, exec, controller.signal) : await exec();
      return { ok: true, result, duration_ms: Date.now() - startedAt };
    } catch (error) {
      const reason = !ran && error?.code === DeviceErrorCode.NOT_STARTED ? error : controller.signal.aborted ? controller.signal.reason : error;
      return {
        ok: false,
        error: reason?.message || String(reason),
        error_code: reason?.code || DeviceErrorCode.EXECUTION_FAILED,
        duration_ms: Date.now() - startedAt,
        ran,
      };
    } finally {
      clearTimeout(timer);
      release?.();
      releaseScope?.();
      inflight.delete(call.call_id);
    }
  }

  function cancel(callIds) {
    for (const id of callIds || []) {
      inflight.get(id)?.abort(new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled by server'));
    }
  }

  /** Huỷ mọi lời gọi đang chạy; chờ tối đa `waitMs` cho chúng dọn xong (giết cây tiến trình con) — dùng khi tạm dừng / dừng / bị thu hồi. */
  async function cancelAll(message = 'Cancelled on this device', { waitMs = 5000 } = {}) {
    for (const controller of inflight.values()) controller.abort(new DeviceToolError(DeviceErrorCode.CANCELLED, message));
    const deadline = Date.now() + waitMs;
    while (inflight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  return {
    run,
    cancel,
    cancelAll,
    stats: () => Object.fromEntries([...semaphores.entries()].map(([g, s]) => [g, s.stats()])),
    inflightCount: () => inflight.size,
  };
}

function abortPromise(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
