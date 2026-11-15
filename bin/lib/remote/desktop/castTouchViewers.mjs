/** Nhãn thiết bị FE khai lúc xin xem (`detectViewerDevice`) — các nhãn này là màn hình cảm ứng, không có con trỏ để nhìn theo. */
const TOUCH_DEVICES = new Set(['iphone', 'ipad', 'android']);

export function isTouchViewerDevice(device) {
  return typeof device === 'string' && TOUCH_DEVICES.has(device.trim().toLowerCase());
}

/** Theo dõi người xem trong phiên có phải màn hình cảm ứng không. Một người xem không rõ thiết bị được tính là không cảm ứng. */
export function createCastTouchViewers() {
  const viewers = new Map();
  return {
    add: (viewerId, device) => { viewers.set(viewerId, isTouchViewerDevice(device)); },
    remove: (viewerId) => { viewers.delete(viewerId); },
    clear: () => { viewers.clear(); },
    allTouch: () => viewers.size > 0 && [...viewers.values()].every(Boolean),
  };
}

/**
 * Bộ quay không vẽ con trỏ vào khung hình (cả JPEG lẫn video) để tránh hiện tượng 2 con trỏ không đồng bộ với chuột của người xem.
 */
export function shouldDrawCursorInFrame() {
  return false;
}
