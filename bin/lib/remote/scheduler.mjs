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
 * Bộ điều phối lời gọi trên máy: mỗi nhóm công cụ một semaphore (đọc tệp 16, chạy lệnh 3…), thao tác ghi khoá theo từng đường dẫn
 * (hai lệnh ghi cùng tệp chạy lần lượt, khác tệp chạy song song), mỗi lời gọi một AbortController (huỷ / hết giờ → dừng cả cây tiến
 * trình con).
 */
export function createScheduler() {
  const semaphores = new Map();
  const pathLocks = new Map();
  const inflight = new Map();

  const semaphoreOf = (group) => {
    if (!semaphores.has(group)) semaphores.set(group, createSemaphore(groupLimit(group)));
    return semaphores.get(group);
  };

  async function withPathLocks(keys, fn) {
    const sorted = [...new Set(keys)].sort();
    const previous = sorted.map((k) => pathLocks.get(k) || Promise.resolve());
    let done;
    const mine = new Promise((resolve) => { done = resolve; });
    sorted.forEach((k) => pathLocks.set(k, mine));
    try {
      await Promise.all(previous);
      return await fn();
    } finally {
      done();
      sorted.forEach((k) => { if (pathLocks.get(k) === mine) pathLocks.delete(k); });
    }
  }

  /**
   * Chạy một lời gọi. `spec`: { group, lockKeys?(args) }, `handler(args, ctx)`; ctx = { signal, onOutput }.
   * Không ném lỗi: trả { ok, result } hoặc { ok:false, error, error_code }.
   */
  async function run(call, spec, handler, { onOutput } = {}) {
    const controller = new AbortController();
    inflight.set(call.call_id, controller);
    const startedAt = Date.now();
    const timeoutMs = Math.max(1000, Number(call.timeout_ms) || 60_000);
    const timer = setTimeout(() => controller.abort(new DeviceToolError(DeviceErrorCode.CALL_TIMEOUT, `Timed out after ${timeoutMs} ms`)), timeoutMs);
    const release = await semaphoreOf(spec.group).acquire();
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const exec = () => handler(call.args || {}, { signal: controller.signal, onOutput, timeoutMs });
      const keys = spec.lockKeys ? spec.lockKeys(call.args || {}) : [];
      const result = keys.length ? await withPathLocks(keys, exec) : await exec();
      return { ok: true, result, duration_ms: Date.now() - startedAt };
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      return {
        ok: false,
        error: reason?.message || String(reason),
        error_code: reason?.code || DeviceErrorCode.EXECUTION_FAILED,
        duration_ms: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
      release();
      inflight.delete(call.call_id);
    }
  }

  function cancel(callIds) {
    for (const id of callIds || []) {
      inflight.get(id)?.abort(new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled by server'));
    }
  }

  return {
    run,
    cancel,
    stats: () => Object.fromEntries([...semaphores.entries()].map(([g, s]) => [g, s.stats()])),
    inflightCount: () => inflight.size,
  };
}
