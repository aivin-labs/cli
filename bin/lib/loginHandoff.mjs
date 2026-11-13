import { createHash, randomBytes } from 'crypto';

/**
 * Hàm thuần cho đăng nhập qua trình duyệt (auth.mjs `browserLogin`), 13/11/2026.
 * Trước đây web trả thẳng khoá toàn quyền về `127.0.0.1:<cổng>/callback?key=…` → khoá nằm trong lịch sử trình duyệt (đồng bộ theo tài
 * khoản Chrome sang máy khác). Nay web chỉ trả MÃ dùng một lần; app đổi mã + verifier PKCE (chỉ app giữ) lấy khoá qua máy chủ
 * (`POST /apikey/cli-login/exchange`). Mã trong lịch sử trình duyệt vô dụng: đã dùng / hết hạn sau 2 phút / thiếu verifier.
 */

/** App đang xin đăng nhập — web dựa vào đây để gọi đúng tên (FE `CliApp`, BE `CliLoginApp`). */
export const LoginApp = Object.freeze({ CLI: 'cli', DESKTOP: 'desktop' });

/** Kết quả hiện trên trang cuối ở trình duyệt. */
export const LoginOutcome = Object.freeze({ OK: 'ok', FAILED: 'failed', CANCELLED: 'cancelled', BAD_REQUEST: 'bad_request' });

export const normalizeLoginApp = (app) => (Object.values(LoginApp).includes(app) ? app : LoginApp.CLI);

/** PKCE S256 (RFC 7636): verifier 43 ký tự base64url, challenge = base64url(sha256(verifier)). */
export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * URL trang web mở cho người dùng. `hints`: chính sách hiện tại trên máy (chỉ để màn cấp quyền nói đúng mức máy còn hỏi lại — sai thì chỉ
 * hiện sai chữ, không đổi quyền thật): `access` full | folders | none (chưa ghép), `confirm` never | risky | always, `cast` off | ask | unattended.
 */
export function buildLoginUrl({ webBaseUrl, port, state, name, app, challenge, hints = {} }) {
  const url = new URL('/', webBaseUrl);
  url.searchParams.set('cli_redirect', `http://127.0.0.1:${port}/callback`);
  url.searchParams.set('cli_state', state);
  url.searchParams.set('cli_name', name);
  url.searchParams.set('cli_app', normalizeLoginApp(app));
  url.searchParams.set('cli_challenge', challenge);
  if (hints.access) url.searchParams.set('cli_access', hints.access);
  if (hints.confirm) url.searchParams.set('cli_confirm', hints.confirm);
  if (hints.cast) url.searchParams.set('cli_cast', hints.cast);
  return url;
}

/** Trình duyệt quay về `/callback`: phân loại lời gọi. Sai `state` → bỏ qua (không huỷ đăng nhập đang chờ vì một lời gọi lạ). */
export function parseCallback(searchParams, expectedState) {
  if (searchParams.get('state') !== expectedState) return { kind: LoginOutcome.BAD_REQUEST };
  if (searchParams.get('error') === 'cancelled') return { kind: LoginOutcome.CANCELLED };
  const code = searchParams.get('code');
  if (code) return { kind: 'code', code };
  // Web đời cũ (chưa có luồng mã) vẫn trả khoá thẳng.
  const key = searchParams.get('key');
  if (key) return { kind: 'key', key };
  return { kind: LoginOutcome.FAILED };
}

const TEXT = Object.freeze({
  vi: {
    [LoginOutcome.OK]: ['Đã đăng nhập', { [LoginApp.DESKTOP]: 'Bạn có thể đóng cửa sổ này và quay lại AIVIN Bot.', [LoginApp.CLI]: 'Bạn có thể đóng cửa sổ này và quay lại cửa sổ dòng lệnh.' }],
    [LoginOutcome.FAILED]: ['Đăng nhập không thành công', { [LoginApp.DESKTOP]: 'Đóng cửa sổ này rồi bấm kết nối lại từ biểu tượng AIVIN Bot trên khay.', [LoginApp.CLI]: 'Đóng cửa sổ này rồi chạy lại aivin login.' }],
    [LoginOutcome.CANCELLED]: ['Đã huỷ đăng nhập', { [LoginApp.DESKTOP]: 'Chưa cấp quyền nào. Bạn có thể đóng cửa sổ này.', [LoginApp.CLI]: 'Chưa cấp quyền nào. Bạn có thể đóng cửa sổ này.' }],
    [LoginOutcome.BAD_REQUEST]: ['Liên kết không hợp lệ', { [LoginApp.DESKTOP]: 'Liên kết này không thuộc lần đăng nhập đang chờ.', [LoginApp.CLI]: 'Liên kết này không thuộc lần đăng nhập đang chờ.' }],
  },
  en: {
    [LoginOutcome.OK]: ['Signed in', { [LoginApp.DESKTOP]: 'You can close this window and go back to AIVIN Bot.', [LoginApp.CLI]: 'You can close this window and go back to your terminal.' }],
    [LoginOutcome.FAILED]: ['Sign-in failed', { [LoginApp.DESKTOP]: 'Close this window and connect again from the AIVIN Bot icon in the system tray.', [LoginApp.CLI]: 'Close this window and run aivin login again.' }],
    [LoginOutcome.CANCELLED]: ['Sign-in cancelled', { [LoginApp.DESKTOP]: 'No access was granted. You can close this window.', [LoginApp.CLI]: 'No access was granted. You can close this window.' }],
    [LoginOutcome.BAD_REQUEST]: ['Invalid link', { [LoginApp.DESKTOP]: 'This link does not belong to the sign-in in progress.', [LoginApp.CLI]: 'This link does not belong to the sign-in in progress.' }],
  },
});

/** Ngôn ngữ trang cuối: web gửi `lang` theo giao diện người dùng; không có thì theo máy. Chỉ có vi / en, còn lại tiếng Anh. */
export function resultLang(langParam, systemLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const tag = String(langParam || systemLocale || '').toLowerCase();
  return tag.startsWith('vi') ? 'vi' : 'en';
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function resultPageHtml({ outcome, app, lang }) {
  const dict = TEXT[lang] || TEXT.en;
  const [title, bodies] = dict[outcome] || dict[LoginOutcome.FAILED];
  const body = bodies[normalizeLoginApp(app)];
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(title)}</title></head>`
    + '<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 16px;color:#1d2129">'
    + `<h2 style="font-size:20px">${escapeHtml(title)}</h2><p style="font-size:15px;color:#4e5969">${escapeHtml(body)}</p>`
    // Chỉ đóng được tab mở bằng script; không đóng được thì chữ trên vẫn đủ.
    + (outcome === LoginOutcome.BAD_REQUEST ? '' : '<script>setTimeout(function(){window.close()},1200)</script>')
    + '</body></html>';
}
