import fs from 'fs';
import path from 'path';
import { DAEMON_LOCK_FILE } from './constants.mjs';
import { writeFileAtomic } from './atomicFile.mjs';

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

/** Tệp khoá đọc không ra JSON mà vừa được ghi trong chừng này → coi là đang có tiến trình giữ (đang ghi dở), không chiếm. */
export const LOCK_UNREADABLE_GRACE_MS = 10_000;

/** Đọc tệp khoá: `{ pid }` hợp lệ / `{ unreadable: true, recent }` (có tệp mà không ra JSON) / `null` (không có tệp). */
function readLock(lockFile) {
  let raw;
  try { raw = fs.readFileSync(lockFile, 'utf8'); } catch { return null; }
  try {
    const data = JSON.parse(raw) || {};
    return { pid: Number(data.pid), beatAt: Date.parse(data.beat_at || data.started_at || '') };
  } catch {
    let recent = false;
    try { recent = Date.now() - fs.statSync(lockFile).mtimeMs < LOCK_UNREADABLE_GRACE_MS; } catch { /* vừa bị xoá */ }
    return { unreadable: true, recent };
  }
}

/** PID đang giữ khoá (còn sống, khác tiến trình này, khoá còn được làm mới) — `null` nếu không ai giữ. */
export function lockHolder(lockFile = DAEMON_LOCK_FILE) {
  const lock = readLock(lockFile);
  if (!lock || lock.unreadable) return null;
  const fresh = !Number.isFinite(lock.beatAt) || Date.now() - lock.beatAt < LOCK_STALE_MS;
  return lock.pid !== process.pid && isAlive(lock.pid) && fresh ? lock.pid : null;
}

/**
 * Lúc lấy khoá: như `lockHolder`, thêm tệp khoá đọc không ra JSON mà mtime còn mới → coi là ĐANG GIỮ (`'?'`), không chiếm (02/11/2026 —
 * trước đây đọc trúng tệp đang ghi dở là coi như không ai giữ, hai daemon cùng chạy). Không trả PID giả cho người gọi `process.kill`.
 */
function holderForAcquire(lockFile) {
  const lock = readLock(lockFile);
  if (lock?.unreadable) return lock.recent ? '?' : null;
  return lockHolder(lockFile);
}

/** Đã có tiến trình khác nhận việc — `code` để lệnh tự khởi động thoát 0 (không phải lỗi, trình giữ chạy không chạy lại). */
export const DAEMON_RUNNING = 'DAEMON_RUNNING';

function daemonRunningError(pid) {
  const err = new Error(`Máy này đang nhận việc ở một cửa sổ khác (PID ${pid}). Dùng cửa sổ đó, hoặc đóng nó rồi chạy lại — muốn ghép lại thì thêm --code <mã>.`);
  err.code = DAEMON_RUNNING;
  return err;
}

/**
 * Ghi khoá với nội dung trọn vẹn ngay từ đầu (02/11/2026). `exclusive`: tạo nguyên tử chỉ khi chưa có — ghi tệp tạm rồi `link` (link lỗi
 * EEXIST nếu đã có tệp; người đọc không bao giờ thấy tệp rỗng như với `wx`); ổ không hỗ trợ link cứng → `wx` như cũ. Không exclusive: tạm +
 * đổi tên đè.
 */
function writeLock(lockFile, exclusive) {
  const now = new Date().toISOString();
  const body = JSON.stringify({ pid: process.pid, started_at: now, beat_at: now });
  if (!exclusive) return writeFileAtomic(lockFile, body, { mode: 0o644 });
  const tmp = `${lockFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.linkSync(tmp, lockFile);
  } catch (e) {
    if (e?.code === 'EEXIST') throw e;
    fs.writeFileSync(lockFile, body, { flag: 'wx' });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* bỏ */ }
  }
}

/**
 * Lấy khoá; đang có tiến trình khác giữ thì ném lỗi có hướng dẫn — trừ khi `takeOver` (ghép lại bằng mã: tiến trình cũ sẽ nhận token
 * hết hiệu lực / bị thay rồi tự dừng). Trả hàm nhả khoá (chỉ nhả khi khoá còn là của tiến trình này).
 */
export function acquireDaemonLock({ takeOver = false, lockFile = DAEMON_LOCK_FILE } = {}) {
  const holder = holderForAcquire(lockFile);
  if (holder && !takeOver) {
    throw daemonRunningError(holder);
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // Tạo nguyên tử: hai tiến trình khởi động cùng lúc (systemd + .desktop lúc đăng nhập) chỉ một bên tạo được tệp.
  try {
    writeLock(lockFile, !takeOver);
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    const again = holderForAcquire(lockFile);
    if (again) throw daemonRunningError(again);
    writeLock(lockFile, false); // khoá cũ của tiến trình đã chết
  }
  const mine = () => {
    try { return Number(JSON.parse(fs.readFileSync(lockFile, 'utf8'))?.pid) === process.pid; } catch { return false; }
  };
  const beat = setInterval(() => {
    if (!mine()) return;
    try {
      const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      writeFileAtomic(lockFile, JSON.stringify({ ...data, beat_at: new Date().toISOString() }), { mode: 0o644 });
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
