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

/** Khoá không được làm mới quá lâu → tiến trình giữ khoá đã chết (PID trong tệp có thể đã bị Windows cấp cho tiến trình khác). */
export const LOCK_STALE_MS = 90_000;
export const LOCK_BEAT_MS = 30_000;

/** PID đang giữ khoá (còn sống, khác tiến trình này, khoá còn được làm mới) — `null` nếu không ai giữ. */
export function lockHolder(lockFile = DAEMON_LOCK_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8')) || {};
    const pid = Number(data.pid);
    const beatAt = Date.parse(data.beat_at || data.started_at || '');
    const fresh = !Number.isFinite(beatAt) || Date.now() - beatAt < LOCK_STALE_MS;
    return pid !== process.pid && isAlive(pid) && fresh ? pid : null;
  } catch {
    return null;
  }
}

/** Đã có tiến trình khác nhận việc — `code` để lệnh tự khởi động thoát 0 (không phải lỗi, trình giữ chạy không chạy lại). */
export const DAEMON_RUNNING = 'DAEMON_RUNNING';

function daemonRunningError(pid) {
  const err = new Error(`Máy này đang nhận việc ở một cửa sổ khác (PID ${pid}). Dùng cửa sổ đó, hoặc đóng nó rồi chạy lại — muốn ghép lại thì thêm --code <mã>.`);
  err.code = DAEMON_RUNNING;
  return err;
}

function writeLock(lockFile, flag) {
  const now = new Date().toISOString();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: now, beat_at: now }), { flag });
}

/**
 * Lấy khoá; đang có tiến trình khác giữ thì ném lỗi có hướng dẫn — trừ khi `takeOver` (ghép lại bằng mã: tiến trình cũ sẽ nhận token
 * hết hiệu lực / bị thay rồi tự dừng). Trả hàm nhả khoá (chỉ nhả khi khoá còn là của tiến trình này).
 */
export function acquireDaemonLock({ takeOver = false, lockFile = DAEMON_LOCK_FILE } = {}) {
  const holder = lockHolder(lockFile);
  if (holder && !takeOver) {
    throw daemonRunningError(holder);
  }
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  // Tạo nguyên tử: hai tiến trình khởi động cùng lúc (systemd + .desktop lúc đăng nhập) chỉ một bên tạo được tệp.
  try {
    writeLock(lockFile, takeOver ? 'w' : 'wx');
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    const again = lockHolder(lockFile);
    if (again) throw daemonRunningError(again);
    writeLock(lockFile, 'w'); // khoá cũ của tiến trình đã chết
  }
  const mine = () => {
    try { return Number(JSON.parse(fs.readFileSync(lockFile, 'utf8'))?.pid) === process.pid; } catch { return false; }
  };
  const beat = setInterval(() => {
    if (!mine()) return;
    try {
      const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      fs.writeFileSync(lockFile, JSON.stringify({ ...data, beat_at: new Date().toISOString() }));
    } catch { /* tệp khoá bị xoá — lần sau tạo lại */ }
  }, LOCK_BEAT_MS);
  beat.unref?.();
  return () => {
    clearInterval(beat);
    try {
      if (mine()) fs.unlinkSync(lockFile);
    } catch { /* đã bị tiến trình khác lấy / xoá */ }
  };
}
