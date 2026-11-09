/**
 * Tệp / thư mục mang bí mật trên máy (khoá SSH, thông tin đăng nhập đám mây, `.env`, kho mật khẩu trình duyệt…). Công cụ quét cả cây thư mục
 * (`fs.grep`, chỉ mục tệp) tự bỏ qua: đường dẫn người gọi đưa chỉ là thư mục cha nên cổng duyệt phía BE không thấy gì để hỏi (rà 02/11/2026).
 * Đọc đúng tệp đó theo tên vẫn đi qua cổng duyệt như thường.
 */
const SECRET_PATH_PATTERNS = [
  /(^|[\\/])\.(ssh|gnupg|aws|azure|kube|password-store)([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|kdbx|keychain-db|ovpn)$/i,
  /(^|[\\/])(login data|cookies|web data|key4\.db|logins\.json|wallet\.dat)$/i,
  /[\\/]appdata[\\/]roaming[\\/]microsoft[\\/](credentials|protect)([\\/]|$)/i,
];

export function isSecretPath(p) {
  const text = String(p || '');
  return SECRET_PATH_PATTERNS.some((re) => re.test(text));
}
