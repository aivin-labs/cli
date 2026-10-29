import fs from 'fs';
import path from 'path';

/** Thay / trả tệp chạy trên đĩa. Bản cũ giữ ở `<tệp>.prev` để tự lùi (trong tệp chạy hoặc ở trình giữ chạy — xem autoStart.mjs). */

/** Xoá; Windows không xoá được tệp còn đang chạy nhưng đổi tên được → `<tệp>-<thời điểm>.trash`, dọn ở lần chạy sau. */
export function retire(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    fs.renameSync(file, `${file}-${Date.now()}.trash`);
  }
}

/**
 * Thay tệp chạy, giữ bản cũ ở `<tệp>.prev`. Windows: đổi tên bản đang chạy thành `.prev` rồi chép bản mới (chép hỏng thì trả tên cũ lại).
 * macOS / Linux: chép bản cũ ra `.prev`, chép bản mới cạnh bên rồi đổi tên nguyên khối. Trả đường dẫn bản cũ (null nếu chưa có).
 */
export function replaceBinary({ newFile, target, platform = process.platform }) {
  const backup = `${target}.prev`;
  if (fs.existsSync(backup)) retire(backup);
  const had = fs.existsSync(target);
  if (platform === 'win32') {
    if (had) fs.renameSync(target, backup);
    try {
      fs.copyFileSync(newFile, target);
    } catch (e) {
      if (had) {
        fs.rmSync(target, { force: true });
        fs.renameSync(backup, target);
      }
      throw e;
    }
    return had ? backup : null;
  }
  if (had) {
    fs.copyFileSync(target, backup);
    fs.chmodSync(backup, 0o755);
  }
  const staged = `${target}.new`;
  fs.copyFileSync(newFile, staged);
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, target);
  return had ? backup : null;
}

/** Trả bản cũ về chỗ (bản mới đang chạy trên Windows bị khoá → đổi tên đi trước). */
export function restoreBackup({ target, backup, platform = process.platform }) {
  if (platform === 'win32' && fs.existsSync(target)) retire(target);
  fs.renameSync(backup, target);
}

/** Dọn bản cũ đã bỏ: `.old` (bản đầu của tính năng) + `*.trash`. Không đụng `.prev` — còn cần để tự lùi tới khi bản mới được xác nhận. */
export function cleanupRetired(target = process.execPath) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name !== `${base}.old` && !(name.startsWith(base) && name.endsWith('.trash'))) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* bản cũ còn đang chạy — lần sau */ }
  }
}
