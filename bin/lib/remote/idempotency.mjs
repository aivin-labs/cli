/**
 * Chống làm trùng (28/10/2026): BE gắn `idem_key` cho mỗi bước có tác dụng (theo nhiệm vụ + lượt + bước + tham số). BE khởi động lại giữa
 * chừng → agentic chạy tiếp → lô bước dở được gửi lại: bước đã làm (hoặc đang làm) trả lại đúng kết quả cũ thay vì ghi / gửi / chạy lần hai.
 * Bước hỏng thì quên khoá — lần sau được chạy lại. Chỉ trong bộ nhớ của daemon (daemon khởi động lại thì mất).
 */

const IDEM_TTL_MS = 24 * 3600_000;
const IDEM_MAX = 3000;

/** `run(call)` → Promise<{ tool, outcome }>; `isReadOnly(toolName)`. Trả hàm chạy có chống lặp + cờ báo lần trùng (`onDuplicate`). */
export function createIdempotentRunner(run, isReadOnly, { onDuplicate, now = () => Date.now() } = {}) {
  const seen = new Map();
  return (call, ...rest) => {
    if (!call.idem_key || isReadOnly(call.tool)) return run(call, ...rest);
    const t = now();
    for (const [k, v] of seen) {
      if (t - v.at > IDEM_TTL_MS || seen.size > IDEM_MAX) seen.delete(k);
      else break;
    }
    const hit = seen.get(call.idem_key);
    if (hit) {
      onDuplicate?.(call);
      return hit.promise.then((r) => ({
        ...r,
        outcome: r.outcome.ok && r.outcome.result && typeof r.outcome.result === 'object' ? { ...r.outcome, result: { ...r.outcome.result, deduplicated: true } } : r.outcome,
      }));
    }
    const promise = run(call, ...rest);
    seen.set(call.idem_key, { promise, at: t });
    promise.then((r) => { if (!r.outcome.ok) seen.delete(call.idem_key); }, () => seen.delete(call.idem_key));
    return promise;
  };
}
