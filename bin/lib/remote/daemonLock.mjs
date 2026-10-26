import fs from 'fs';
import { DAEMON_LOCK_FILE, REMOTE_CONFIG_DIR } from './constants.mjs';

/**
 * Một tiến trình `aivin remote start` cho mỗi thư mục cấu hình. Hai tiến trình cùng token máy (mở ở hai cửa sổ, hoặc tự khởi động
 * cùng máy rồi chạy tay thêm) đá nhau khỏi máy chủ mỗi ~1 s mãi, lời gọi đang chạy bị mất (chạy thật 27/10/2026). Khoá ghi PID;
 * PID không còn sống thì coi là khoá cũ, lấy lại.
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** PID đang giữ khoá (còn sống, khác tiến trình này) — `null` nếu không ai giữ. */
export function lockHolder(lockFile = DAEMON_LOCK_FILE) {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(lockFile, 'utf8'))?.pid);
    return pid !== process.pid && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Lấy khoá; đang có tiến trình khác giữ thì ném lỗi có hướng dẫn — trừ khi `takeOver` (ghép lại bằng mã: tiến trình cũ sẽ nhận token
 * hết hiệu lực / bị thay rồi tự dừng). Trả hàm nhả khoá (chỉ nhả khi khoá còn là của tiến trình này).
 */
export function acquireDaemonLock({ takeOver = false, lockFile = DAEMON_LOCK_FILE } = {}) {
  const holder = lockHolder(lockFile);
  if (holder && !takeOver) {
    throw new Error(`Máy này đang nhận việc ở một cửa sổ khác (PID ${holder}). Dùng cửa sổ đó, hoặc đóng nó rồi chạy lại — muốn ghép lại thì thêm --code <mã>.`);
  }
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  return () => {
    try {
      if (Number(JSON.parse(fs.readFileSync(lockFile, 'utf8'))?.pid) === process.pid) fs.unlinkSync(lockFile);
    } catch { /* đã bị tiến trình khác lấy / xoá */ }
  };
}
