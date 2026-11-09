import { confirmTokenRotation, revertTokenRotation } from './credentials.mjs';

/**
 * Xoay vòng token phía daemon (02/11/2026) — phần chốt / lùi tách khỏi client.mjs:
 * - token mới lưu kèm token cũ (`previous_sealed`, credentials.mjs) tới khi máy chủ xác nhận;
 * - máy chủ xác nhận = ack ROTATED `ok`, hoặc chào (HELLO) thành công bằng chính token mới → bỏ token cũ;
 * - máy chủ từ chối token mới (`DEVICE_UNAUTHORIZED`) mà còn token cũ → nối lại bằng token cũ TRƯỚC khi xoá ghép máy.
 */

/** Chào thành công bằng `token` → token cũ (nếu còn giữ) hết cần. Không ném. */
export function settleRotation(token, serverUrl) {
  try { return confirmTokenRotation(token, serverUrl); } catch { return false; }
}

/**
 * Máy chủ từ chối token hiện hành: còn token cũ chưa bỏ → đổi `creds` + `socket.auth` sang token cũ, hẹn nối lại, trả true (người gọi KHÔNG
 * xoá ghép máy). Không còn → false.
 */
export function fallBackToPreviousToken({ creds, socket, isStopped = () => false, delayMs = 1000, revert = revertTokenRotation }) {
  let previous;
  try { previous = revert(creds.device_token, creds.server_url); } catch { previous = null; }
  if (!previous) return false;
  creds.device_token = previous;
  socket.auth = { ...socket.auth, device_token: previous };
  // Lỗi từ middleware của máy chủ: socket.io-client không tự nối lại (socket.active = false) → nối tay.
  setTimeout(() => { if (!isStopped() && !socket.active) socket.connect(); }, delayMs);
  return true;
}
