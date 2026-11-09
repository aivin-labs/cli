import { CastConsentMode } from '../localPolicy.mjs';

/** Kết quả hỏi; khác `ALLOW` / `CANCELLED` thì gửi nguyên giá trị làm lý do từ chối cho người xem. */
export const CastConsentDecision = Object.freeze({
  ALLOW: 'allow', DISABLED: 'cast_disabled', REJECTED: 'rejected_by_user', TIMEOUT: 'consent_timeout', UNAVAILABLE: 'consent_unavailable', CANCELLED: 'cancelled',
});

const MAX_REMEMBERED = 100;
/**
 * Phiên dừng vì máy rớt mạng (không phải chủ máy hay người xem kết thúc): giữ đồng ý bấy nhiêu lâu. Máy chủ giữ phiên
 * chờ máy nối lại rồi mời phát lại đúng phiên đó — hỏi lại thì chủ máy đang điều khiển từ xa bị khoá ngoài (không ai ở máy để bấm).
 */
export const CONSENT_RESUME_MS = 10 * 60_000;
/** `viewerKey` do máy chủ tính (tài khoản + IP + trình duyệt); máy chủ đời cũ không gửi thì dùng tên thiết bị. */
const key = (sessionId, viewerKey, viewerDevice) => `${sessionId}\n${viewerKey || viewerDevice || ''}`;

/**
 * Chủ máy đồng ý từng phiên, quyết định ngay trên máy nên máy chủ không trả lời thay được. Đồng ý có hiệu lực cho đúng phiên + đúng người xem đó
 * (người xem rớt mạng nối lại không hỏi lại). Phiên kết thúc hẳn (`forget`) là quên; phiên chỉ gián đoạn (`suspend`: máy rớt mạng) thì giữ thêm
 * `CONSENT_RESUME_MS`. Chủ máy vừa bấm ngắt thì `isLocked` đúng: luôn hỏi, kể cả chế độ không cần người ở máy.
 */
export function createCastConsent({ ask, getMode, isLocked = () => false, unlock = () => {}, onWaiting = () => {}, now = Date.now }) {
  /** khoá → hạn (Infinity khi phiên đang chạy). */
  const approved = new Map();
  const pending = new Map();

  const valid = (k) => {
    const until = approved.get(k);
    if (until === undefined) return false;
    if (until >= now()) return true;
    approved.delete(k);
    return false;
  };
  const keysOf = (sessionId) => [...approved.keys()].filter((k) => k.startsWith(`${sessionId}\n`));

  function request({ sessionId, viewerId, viewerDevice, viewerKey, locked }) {
    const k = key(sessionId, viewerKey, viewerDevice);
    const open = pending.get(k);
    if (open) return open.promise;
    const controller = new AbortController();
    onWaiting({ sessionId, viewerId, viewerDevice });
    const promise = new Promise((resolve) => resolve(ask({ viewerDevice, locked, signal: controller.signal })))
      .catch(() => CastConsentDecision.UNAVAILABLE)
      .then((answer) => {
        pending.delete(k);
        if (answer === CastConsentDecision.ALLOW) {
          if (approved.size >= MAX_REMEMBERED) approved.clear();
          approved.set(k, Infinity);
          if (locked) unlock();
        }
        return answer;
      });
    pending.set(k, { promise, controller, sessionId, viewerId });
    return promise;
  }

  return {
    async decide({ sessionId, viewerId, viewerDevice = '', viewerKey = '' }) {
      const mode = getMode();
      if (mode === CastConsentMode.OFF) return CastConsentDecision.DISABLED;
      const locked = isLocked();
      const k = key(sessionId, viewerKey, viewerDevice);
      if (!locked && mode === CastConsentMode.UNATTENDED) return CastConsentDecision.ALLOW;
      if (!locked && valid(k)) {
        // Phiên gián đoạn được mời phát lại: đồng ý cũ có hiệu lực lại cho tới khi phiên kết thúc.
        approved.set(k, Infinity);
        return CastConsentDecision.ALLOW;
      }
      return request({ sessionId, viewerId, viewerDevice, viewerKey, locked });
    },
    /** Người xem rời / huỷ trong lúc đang hỏi: đóng hộp, không bắt đầu chụp. */
    cancel({ sessionId, viewerId, final = true }) {
      for (const open of pending.values()) {
        if (open.sessionId === sessionId && (final || open.viewerId === viewerId)) open.controller.abort();
      }
    },
    /** Tạm dừng / tắt daemon / chủ máy bấm ngắt: đóng mọi hộp đang hỏi (bấm "Cho phép" muộn cũng không còn tác dụng). */
    cancelAll() {
      for (const open of pending.values()) open.controller.abort();
    },
    /** Phiên kết thúc hẳn: quên đồng ý. */
    forget(sessionId) {
      for (const k of keysOf(sessionId)) approved.delete(k);
    },
    /** Phiên chỉ gián đoạn (máy rớt mạng): giữ đồng ý thêm `ms` để phát lại không phải hỏi lại. */
    suspend(sessionId, ms = CONSENT_RESUME_MS) {
      for (const k of keysOf(sessionId)) approved.set(k, Math.min(approved.get(k), now() + ms));
    },
  };
}
