/**
 * Bộ lọc lệnh CDP máy chủ gửi xuống trình duyệt của máy (28/10/2026) — áp cho MỌI đường hầm (cửa sổ riêng của Aivin lẫn trình duyệt hằng ngày).
 *
 * Đường hầm trao cho máy chủ quyền điều khiển trình duyệt; không lọc thì máy chủ (hoặc prompt injection đẩy AI tới đó) vượt được giới hạn thư mục
 * của Device Agent: mở `file://` đọc mọi tệp kể cả token máy trong `~/.aivin`, đặt thư mục tải về chỗ tuỳ ý (ghi tệp bất cứ đâu), chọn tệp trên đĩa
 * đưa lên trang web, mở kênh CDP không qua bộ chia (`exposeDevToolsProtocol`, phiên không phẳng). Hàm thuần: nhận lệnh, trả lệnh (có thể đã sửa)
 * hoặc lý do chặn.
 */

/** Scheme không bao giờ mở từ xa: tệp trên đĩa, trang nội bộ / cài đặt / tiện ích của trình duyệt. `about:blank` vẫn được. */
const BLOCKED_URL_RE = /^\s*(file|chrome|edge|brave|opera|vivaldi|devtools|view-source|chrome-extension|edge-extension|chrome-untrusted|filesystem|javascript):/i;
const BLOCKED_ABOUT_RE = /^\s*about:(?!blank\b|srcdoc\b)/i;

/** Lệnh mở kênh CDP / đọc tài nguyên ngoài tầm lọc — không bao giờ cho qua. */
const ALWAYS_BLOCKED = new Set([
  'Target.exposeDevToolsProtocol', 'Target.sendMessageToTarget', 'Target.attachToBrowserTarget', 'Network.loadNetworkResource',
  'DOM.setFileInputFiles', 'Page.setInterceptFileChooserDialog', 'Browser.close', 'Browser.crash', 'Browser.crashGpuProcess',
]);

export function isBlockedUrl(url) {
  const u = String(url ?? '');
  return BLOCKED_URL_RE.test(u) || BLOCKED_ABOUT_RE.test(u);
}

/**
 * `{ msg }` — lệnh được gửi (có thể đã sửa: thư mục tải ép về thư mục tải của Aivin); `{ error }` — lý do chặn. `downloadsDir` là thư mục tải
 * của Aivin trên máy (`~/Downloads/Aivin`).
 */
export function applyDevicePolicy(msg, { downloadsDir }) {
  const method = String(msg?.method || '');
  const params = msg?.params || {};
  if (ALWAYS_BLOCKED.has(method)) return { error: `${method} is not allowed on this computer` };
  if ((method === 'Target.setAutoAttach' || method === 'Target.attachToTarget') && params.flatten === false) {
    return { error: 'Only flattened sessions are allowed' };
  }
  if ((method === 'Target.createTarget' || method === 'Page.navigate') && isBlockedUrl(params.url)) {
    return { error: `Opening ${String(params.url).split(':')[0]}: URLs is not allowed on this computer` };
  }
  if ((method === 'Page.setDownloadBehavior' || method === 'Browser.setDownloadBehavior') && params.downloadPath !== undefined) {
    return { msg: { ...msg, params: { ...params, downloadPath: downloadsDir } } };
  }
  return { msg };
}

/** Tệp chạy được / cài đặt — AI tải trên máy người dùng thì huỷ ngay (máy chủ vốn không nhận chúng, nhưng tệp đã nằm lại trên đĩa). */
const EXECUTABLE_RE = /\.(exe|msi|msix|msixbundle|appx|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|dll|lnk|reg|jar|dmg|pkg|app|command|sh|run|deb|rpm|apk|xpi|crx)$/i;

export function isExecutableName(name) {
  return EXECUTABLE_RE.test(String(name || '').trim());
}

/**
 * Sự kiện trình duyệt gửi lên: bắt đầu tải một tệp chạy được → `guid` của lượt tải cần huỷ, không thì null. So chuỗi trước khi parse (mọi khung
 * CDP đi qua đây).
 */
export function executableDownloadGuid(frame) {
  const text = String(frame);
  if (!text.includes('downloadWillBegin')) return null;
  try {
    const msg = JSON.parse(text);
    if (msg.method !== 'Page.downloadWillBegin' && msg.method !== 'Browser.downloadWillBegin') return null;
    return isExecutableName(msg.params?.suggestedFilename) ? msg.params.guid : null;
  } catch {
    return null;
  }
}
