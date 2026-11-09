/**
 * Link cửa sổ linh vật được phép mở khi bấm (02/11/2026): chỉ `http(s)://` — url trong báo chủ động / câu hỏi đến từ BE, cửa sổ mở bằng
 * `Process.Start` (file:, ms-settings:, .exe… sẽ chạy thẳng trên máy). Không hợp lệ → null (dòng vẫn hiện, chỉ không bấm được).
 */
export function safeWebUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return null;
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Link của nút trong câu trả lời: http(s), hoặc gọi / mail / tin nhắn do ứng dụng trên máy xử lý. Bỏ tham số `attach` của mailto (vài ứng dụng thư tự đính kèm tệp trên máy).
 */
export function safeLinkUrl(url) {
  const web = safeWebUrl(url);
  if (web) return web;
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (/^(tel|sms):[+\d][\d\s().*#-]{0,40}$/i.test(raw)) return raw;
  if (!/^mailto:[^\s?&]+(\?\S*)?$/i.test(raw)) return null;
  const [head, query] = raw.split('?');
  if (!query) return head;
  const kept = query.split('&').filter((p) => !/^attach/i.test(p));
  return kept.length ? `${head}?${kept.join('&')}` : head;
}
