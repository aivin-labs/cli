import { CastConsentMode } from '../localPolicy.mjs';

/** Kết quả hỏi; khác `ALLOW` / `CANCELLED` thì gửi nguyên giá trị làm lý do từ chối cho người xem. */
export const CastConsentDecision = Object.freeze({
  ALLOW: 'allow', ALLOW_ALWAYS: 'allow_always', DISABLED: 'cast_disabled', REJECTED: 'rejected_by_user', TIMEOUT: 'consent_timeout', UNAVAILABLE: 'consent_unavailable', CANCELLED: 'cancelled',
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
 *
 * `trust` (castTrust.mjs): thiết bị người ở máy đã bấm "Luôn cho phép" vào thẳng nếu `prove()` chứng minh đúng khoá của nó; sai thì hỏi như thường.
 * Thiết bị đã được cho vào phiên đang chạy cũng vào lại như vậy: `viewerKey` có cả IP, điện thoại đổi Wi-Fi / 4G giữa phiên không phải hỏi lại.
 * Chế độ `off` và trạng thái vừa bấm ngắt vẫn thắng quyền tin.
 */
export function createCastConsent({ ask, getMode, isLocked = () => false, unlock = () => {}, onWaiting = () => {}, now = Date.now, trust = null }) {
  /** khoá → hạn (Infinity khi phiên đang chạy). */
  const approved = new Map();
  const pending = new Map();
  /** Khoá thiết bị đã được cho vào từng phiên — chủ máy bấm ngắt thì các thiết bị đó mất luôn quyền tin. */
  const sessionDevices = new Map();
  /** Người xem rời tạm trong lúc hộp đang hỏi: mã người xem → mã phiên. Hộp vẫn mở, bấm xong thì nhớ đồng ý nhưng chưa phát cho người đã đi. */
  const awayViewers = new Map();

  const approve = (k, sessionId, deviceKey) => {
    if (approved.size >= MAX_REMEMBERED) approved.clear();
    approved.set(k, Infinity);
    if (!deviceKey) return;
    if (!sessionDevices.has(sessionId)) sessionDevices.set(sessionId, new Set());
    sessionDevices.get(sessionId).add(deviceKey);
  };

  const valid = (k) => {
    const until = approved.get(k);
    if (until === undefined) return false;
    if (until >= now()) return true;
    approved.delete(k);
    return false;
  };
  const keysOf = (sessionId) => [...approved.keys()].filter((k) => k.startsWith(`${sessionId}\n`));
  /** Khoá thiết bị này đã được cho vào phiên và đồng ý của phiên còn hiệu lực (phiên gián đoạn quá `CONSENT_RESUME_MS` thì thôi). */
  const allowedInSession = (sessionId, deviceKey) => Boolean(sessionDevices.get(sessionId)?.has(deviceKey)) && keysOf(sessionId).some(valid);

  function request({ sessionId, viewerId, viewerDevice, viewerKey, deviceKey, locked }) {
    const k = key(sessionId, viewerKey, viewerDevice);
    const open = pending.get(k);
    if (open) {
      // Người xem quay lại khi hộp còn mở: báo lại để họ thấy "đang chờ" thay vì báo lỗi không nhận được hình.
      onWaiting({ sessionId, viewerId, viewerDevice });
      return open.promise;
    }
    const controller = new AbortController();
    onWaiting({ sessionId, viewerId, viewerDevice });
    const canTrust = Boolean(deviceKey && trust?.accepts(deviceKey));
    const promise = new Promise((resolve) => resolve(ask({ viewerDevice, locked, canTrust, signal: controller.signal })))
      .catch(() => CastConsentDecision.UNAVAILABLE)
      .then((answer) => {
        pending.delete(k);
        if (answer !== CastConsentDecision.ALLOW && answer !== CastConsentDecision.ALLOW_ALWAYS) return answer;
        approve(k, sessionId, deviceKey);
        if (locked) unlock();
        if (answer === CastConsentDecision.ALLOW_ALWAYS && canTrust) {
          try { trust.add({ key: deviceKey, name: viewerDevice }); } catch { /* không lưu được: vẫn cho phiên này */ }
        }
        return CastConsentDecision.ALLOW;
      });
    pending.set(k, { promise, controller, sessionId, viewerId });
    return promise;
  }

  /** Đồng ý tới khi người xem đang rời tạm thì chưa phát: họ quay lại là `valid` cho vào thẳng. */
  async function requestForViewer(options) {
    const answer = await request(options);
    return answer === CastConsentDecision.ALLOW && awayViewers.has(String(options.viewerId)) ? CastConsentDecision.CANCELLED : answer;
  }

  const clearAway = (sessionId) => {
    for (const [viewer, session] of awayViewers) if (session === sessionId) awayViewers.delete(viewer);
  };

  return {
    async decide({ sessionId, viewerId, viewerDevice = '', viewerKey = '', deviceKey = '', prove = null }) {
      awayViewers.delete(String(viewerId));
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
      if (!locked && deviceKey && (trust?.has(deviceKey) || allowedInSession(sessionId, deviceKey))) {
        const proven = await Promise.resolve(prove?.()).catch(() => false);
        if (proven === null) return CastConsentDecision.CANCELLED;
        // Trong lúc chờ chữ ký chủ máy có thể vừa tắt hẳn hoặc bấm ngắt.
        if (getMode() === CastConsentMode.OFF) return CastConsentDecision.DISABLED;
        if (proven === true && !isLocked()) {
          approve(k, sessionId, deviceKey);
          try { trust?.touch(deviceKey); } catch { /* chỉ là gia hạn */ }
          return CastConsentDecision.ALLOW;
        }
        return requestForViewer({ sessionId, viewerId, viewerDevice, viewerKey, deviceKey, locked: isLocked() });
      }
      return requestForViewer({ sessionId, viewerId, viewerDevice, viewerKey, deviceKey, locked });
    },
    /**
     * Người xem rời / huỷ trong lúc đang hỏi: đóng hộp, không bắt đầu chụp. `away`: chỉ rời tạm (điện thoại tắt màn hình khi chủ máy quay sang
     * bấm trên máy) — giữ hộp, không thì hộp biến mất ngay lúc chủ máy định bấm.
     */
    cancel({ sessionId, viewerId, final = true, away = false }) {
      if (away && !final) {
        if ([...pending.values()].some((open) => open.sessionId === sessionId)) awayViewers.set(String(viewerId), sessionId);
        return;
      }
      if (final) clearAway(sessionId);
      for (const open of pending.values()) {
        if (open.sessionId === sessionId && (final || open.viewerId === viewerId)) open.controller.abort();
      }
    },
    /** Tạm dừng / tắt daemon / chủ máy bấm ngắt: đóng mọi hộp đang hỏi (bấm "Cho phép" muộn cũng không còn tác dụng). */
    cancelAll() {
      awayViewers.clear();
      for (const open of pending.values()) open.controller.abort();
    },
    /** Phiên kết thúc hẳn: quên đồng ý. */
    forget(sessionId) {
      for (const k of keysOf(sessionId)) approved.delete(k);
      sessionDevices.delete(sessionId);
      clearAway(sessionId);
    },
    /** Chủ máy bấm ngắt: mọi thiết bị đã vào phiên này mất quyền tin (phải gọi trước khi phiên bị quên). */
    revokeSessionTrust(sessionId) {
      for (const deviceKey of sessionDevices.get(sessionId) || []) {
        try { trust?.remove(deviceKey); } catch { /* đã khoá theo cả máy: phiên sau vẫn phải hỏi */ }
      }
    },
    /** Phiên chỉ gián đoạn (máy rớt mạng): giữ đồng ý thêm `ms` để phát lại không phải hỏi lại. */
    suspend(sessionId, ms = CONSENT_RESUME_MS) {
      for (const k of keysOf(sessionId)) approved.set(k, Math.min(approved.get(k), now() + ms));
    },
  };
}
