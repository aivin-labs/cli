/**
 * Rào xác nhận (09/11/2026): khi có hộp "Cho phép / Từ chối" đang chờ trên máy, lời gọi CÓ TÁC DỤNG khác chưa được bắt đầu. Trước đây lời
 * gọi rủi ro A đứng chờ người bấm còn lời gọi B cùng lô vẫn chạy — B (`gui.do` bấm "Cho phép", hay `shell.exec` chạy script UIAutomation)
 * tự duyệt được A, vô hiệu cả sàn xác nhận tại máy. Lời gọi chỉ đọc vẫn chạy (không bấm / gõ được gì).
 *
 * `hold()` → hàm thả (gọi nhiều lần vô hại); `waitClear(signal)` → `true` khi không còn hộp nào, `false` khi bị huỷ lúc chờ.
 */
export function createConfirmBarrier() {
  let pending = 0;
  let waiters = [];

  const wake = () => {
    const list = waiters;
    waiters = [];
    list.forEach((fn) => fn());
  };

  return {
    hold() {
      pending++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending--;
        if (pending === 0) wake();
      };
    },
    pending: () => pending,
    async waitClear(signal) {
      while (pending > 0) {
        if (signal?.aborted) return false;
        await new Promise((resolve) => {
          const done = () => {
            signal?.removeEventListener('abort', done);
            resolve();
          };
          waiters.push(done);
          signal?.addEventListener('abort', done, { once: true });
        });
      }
      return !signal?.aborted;
    },
  };
}
