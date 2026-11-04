import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomBytes } from 'crypto';

/**
 * Cache PDF xem trước trên CHÍNH máy người dùng (04/11/2026): mở lại tệp Office chưa sửa → hiện ngay, không gửi lại lên máy chủ, không tốn
 * lượt xem trong ngày. Máy chủ vẫn không lưu gì. Khoá = sha256 nội dung tệp (tệp sửa → khoá mới); `v1` đổi khi cách đổi PDF đổi.
 * Tổng tối đa 500 MB, tệp không dùng quá 30 ngày bị xoá; đọc trúng thì cập nhật mtime → dọn tệp lâu không dùng nhất trước.
 */

export const PREVIEW_CACHE_DIR = path.join(os.homedir(), '.aivin', 'preview-cache');
const CACHE_VERSION = 'v1';
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PDF_MAGIC = '%PDF-';

export function contentKey(buffer) {
  return `${CACHE_VERSION}-${createHash('sha256').update(buffer).digest('hex')}`;
}

const entryPath = (dir, key) => path.join(dir, `${key}.pdf`);

/** PDF đã cache cho nội dung này, hoặc null (thiếu / hỏng / không phải PDF). */
export function readCachedPdf(key, { dir = PREVIEW_CACHE_DIR } = {}) {
  const file = entryPath(dir, key);
  try {
    const pdf = fs.readFileSync(file);
    if (pdf.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) return null;
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch { /* chỉ ảnh hưởng thứ tự dọn */ }
    return pdf;
  } catch {
    return null;
  }
}

/** Ghi tệp tạm rồi đổi tên: hai cửa sổ cùng ghi một khoá, hoặc tiến trình chết giữa chừng, không để lại PDF cụt. */
export function writeCachedPdf(key, pdf, { dir = PREVIEW_CACHE_DIR, maxTotalBytes = MAX_TOTAL_BYTES, maxAgeMs = MAX_AGE_MS } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${key}.${randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, pdf);
    fs.renameSync(tmp, entryPath(dir, key));
    prunePreviewCache({ dir, maxTotalBytes, maxAgeMs });
  } catch {
    // cache chỉ để nhanh hơn: ổ đầy / không ghi được thì lần sau đổi lại
  }
}

/** Xoá tệp quá hạn và tệp tạm mồ côi, rồi xoá tệp lâu không dùng nhất tới khi tổng dưới trần. */
export function prunePreviewCache({ dir = PREVIEW_CACHE_DIR, maxTotalBytes = MAX_TOTAL_BYTES, maxAgeMs = MAX_AGE_MS, now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const entries = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const expired = now - stat.mtimeMs > maxAgeMs;
    const staleTmp = name.endsWith('.tmp') && now - stat.mtimeMs > 60 * 60 * 1000;
    if (expired || staleTmp) { fs.rmSync(file, { force: true }); continue; }
    if (name.endsWith('.pdf')) entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxTotalBytes) break;
    fs.rmSync(e.file, { force: true });
    total -= e.size;
  }
}
