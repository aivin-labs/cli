/**
 * Khoá công khai ký bản phát hành CLI (Ed25519, 29/10/2026). Tự cập nhật chỉ cài bản có `SHA256SUMS.sig` ký bằng một khoá trong danh sách
 * này — chiếm được trang tải (get.aivin.vn) cũng không đẩy được tệp chạy lạ xuống máy đã cài. Khoá bí mật KHÔNG nằm trên trang tải / CI
 * (scripts/release-key.mjs tạo, scripts/sign-release.mjs ký). Đổi khoá: thêm khoá mới ở đây, phát hành một bản ký bằng khoá cũ, rồi mới ký
 * bằng khoá mới; gỡ khoá cũ ở bản sau đó.
 */
export const RELEASE_PUBLIC_KEYS = Object.freeze([
  { id: '05b62965e1847716', key: 'QlThaBcc4Yl+ctV2MD+VuOOa0lu3yBxhiexprDarWHM=' },
]);
