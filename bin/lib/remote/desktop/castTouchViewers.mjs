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
 * Bộ quay có vẽ con trỏ vào khung hình không.
 * Đường JPEG: chỉ bỏ khi mọi người xem đều cảm ứng, còn người dùng chuột thì họ cần thấy con trỏ.
 * Đường video: theo từng người xem báo tự vẽ hay chưa, để lúc đang ghi hình con trỏ vẫn nằm trong bản ghi.
 */
export function shouldDrawCursorInFrame({ jpeg, localCursor, allTouch }) {
  return jpeg ? !allTouch : !localCursor;
}
