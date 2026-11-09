import fs from 'fs';
import path from 'path';

const RENAME_RETRIES = 4;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Ghi tệp NGUYÊN TỬ (02/11/2026): ghi tệp tạm cạnh bên rồi đổi tên đè — người đọc chỉ thấy bản cũ trọn vẹn hoặc bản mới trọn vẹn, máy tắt /
 * tiến trình bị giết giữa lúc ghi không để lại tệp cụt. Windows: đổi tên đè tệp đang bị tiến trình khác mở đọc có thể lỗi EPERM / EBUSY
 * thoáng qua → thử lại vài lần (chờ ngắn, đồng bộ). Hỏng hẳn → xoá tệp tạm, ném lỗi (tệp đích giữ nguyên).
 */
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (attempt >= RENAME_RETRIES || !RETRY_CODES.has(e?.code)) throw e;
        sleepSync(20 * (attempt + 1));
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* bỏ */ }
    throw e;
  }
}
