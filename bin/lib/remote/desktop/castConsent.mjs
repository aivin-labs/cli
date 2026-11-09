import { CastConsentMode } from '../localPolicy.mjs';

/** Kết quả hỏi; khác `ALLOW` / `CANCELLED` thì gửi nguyên giá trị làm lý do từ chối cho người xem. */
export const CastConsentDecision = Object.freeze({
  ALLOW: 'allow', DISABLED: 'cast_disabled', REJECTED: 'rejected_by_user', TIMEOUT: 'consent_timeout', UNAVAILABLE: 'consent_unavailable', CANCELLED: 'cancelled',
});

const MAX_REMEMBERED = 100;
/** `viewerKey` do máy chủ tính (tài khoản + IP + trình duyệt); máy chủ đời cũ không gửi thì dùng tên thiết bị. */
const key = (sessionId, viewerKey, viewerDevice) => `${sessionId}\n${viewerKey || viewerDevice || ''}`;

/**
 * Chủ máy đồng ý từng phiên, quyết định ngay trên máy nên máy chủ không trả lời thay được. Đồng ý có hiệu lực cho đúng phiên + đúng người xem đó
 * (rớt mạng nối lại không hỏi lại), phiên kết thúc là quên. Chủ máy vừa bấm ngắt thì `isLocked` đúng: luôn hỏi, kể cả chế độ không cần người ở máy.
 */
export function createCastConsent({ ask, getMode, isLocked = () => false, unlock = () => {}, onWaiting = () => {} }) {
  const approved = new Set();
  const pending = new Map();

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
          approved.add(k);
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
      if (!locked && (mode === CastConsentMode.UNATTENDED || approved.has(key(sessionId, viewerKey, viewerDevice)))) return CastConsentDecision.ALLOW;
      return request({ sessionId, viewerId, viewerDevice, viewerKey, locked });
    },
    /** Người xem rời / huỷ trong lúc đang hỏi: đóng hộp, không bắt đầu chụp. */
    cancel({ sessionId, viewerId, final = true }) {
      for (const open of pending.values()) {
        if (open.sessionId === sessionId && (final || open.viewerId === viewerId)) open.controller.abort();
      }
    },
    forget(sessionId) {
      for (const k of approved) if (k.startsWith(`${sessionId}\n`)) approved.delete(k);
    },
  };
}
