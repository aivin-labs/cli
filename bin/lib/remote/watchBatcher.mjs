/**
 * Gom sự kiện của bộ theo dõi tệp thành lô (02/11/2026). Trước đây chỉ debounce: tệp bị ghi liên tục (log, bản build, đồng bộ đám mây) đẩy
 * hẹn giờ lùi mãi → lô không bao giờ chạy, còn tập `pending` phình không giới hạn trong RAM.
 * - `debounceMs`: chờ yên chừng này rồi chạy;
 * - `maxWaitMs`: kể từ sự kiện đầu của lô, chạy chậm nhất sau chừng này dù sự kiện còn dồn tới;
 * - `maxPending`: quá chừng này đường dẫn khác nhau → bỏ danh sách, chạy `onOverflow` (quét lại tăng dần cả cây) thay vì `onBatch`.
 * `onBatch(paths)` / `onOverflow()` có thể async; lô chạy tuần tự (lô sau chờ lô trước xong).
 */
export function createWatchBatcher({ debounceMs = 800, maxWaitMs = 5_000, maxPending = 5_000, onBatch, onOverflow, now = Date.now } = {}) {
  const pending = new Set();
  let overflow = false;
  let firstAt = 0;
  let timer = null;
  let chain = Promise.resolve();

  const run = () => {
    timer = null;
    firstAt = 0;
    const batch = [...pending];
    const full = overflow;
    pending.clear();
    overflow = false;
    chain = chain.then(() => (full ? onOverflow?.() : batch.length ? onBatch?.(batch) : undefined)).catch(() => undefined);
    return chain;
  };

  return {
    add(abs) {
      if (!overflow) {
        pending.add(abs);
        if (pending.size > maxPending) {
          pending.clear();
          overflow = true;
        }
      }
      const t = now();
      if (!firstAt) firstAt = t;
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - t));
      timer = setTimeout(run, wait);
      timer.unref?.();
    },
    /** Chạy ngay lô đang chờ (test / đóng). */
    flushNow() {
      if (timer) clearTimeout(timer);
      return run();
    },
    size: () => pending.size,
    overflowed: () => overflow,
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
