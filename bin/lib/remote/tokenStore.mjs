import { execFileSync } from 'child_process';
import fs from 'fs';

/**
 * Token thiết bị cất trong kho bí mật của hệ điều hành (29/10/2026). Trước đây `~/.aivin/device-credentials.json` giữ token dạng chữ thường
 * (chỉ có quyền 600) — chép thư mục `.aivin` (sao lưu, đồng bộ đám mây, ổ cứng bị lấy) là mang theo được quyền điều khiển máy.
 * - Windows: DPAPI phạm vi người dùng hiện tại (`ProtectedData`, qua PowerShell) — bản mã nằm trong tệp, chỉ đúng tài khoản Windows trên
 *   đúng máy này giải được.
 * - macOS: Keychain đăng nhập (`security`), tệp chỉ còn dấu "token ở Keychain".
 * - Linux: Secret Service (`secret-tool`, GNOME Keyring / KWallet) khi có phiên D-Bus; máy chủ không có kho → tệp quyền 600 như cũ.
 * Bảo vệ khỏi chép tệp sang nơi khác; KHÔNG chống được mã độc chạy dưới chính tài khoản người dùng (nó gọi được cùng API).
 */

export const TokenStoreKind = Object.freeze({ DPAPI: 'dpapi', KEYCHAIN: 'keychain', LIBSECRET: 'libsecret', FILE: 'file' });

const SERVICE = 'aivin-device-token';
/** Thêm vào DPAPI để ứng dụng khác của cùng người dùng không giải mã nhầm / tình cờ (không phải bí mật). */
const DPAPI_ENTROPY = 'aivin-device-token-v1';

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const DPAPI_PROTECT = `Add-Type -AssemblyName System.Security; $e = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}'); $b = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $e, 'CurrentUser'))`;
const DPAPI_UNPROTECT = `Add-Type -AssemblyName System.Security; $e = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}'); $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $e, 'CurrentUser'))`;

const run = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', timeout: 20_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

/** Kho dùng trên máy này. `AIVIN_TOKEN_STORE=file` ép tệp thường (máy không có kho / gỡ lỗi). */
export function preferredTokenStore({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const forced = String(env.AIVIN_TOKEN_STORE || '').toLowerCase();
  if (Object.values(TokenStoreKind).includes(forced)) return forced;
  if (platform === 'win32') return TokenStoreKind.DPAPI;
  if (platform === 'darwin' && exists('/usr/bin/security')) return TokenStoreKind.KEYCHAIN;
  if (platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS && ['/usr/bin/secret-tool', '/bin/secret-tool'].some((p) => exists(p))) return TokenStoreKind.LIBSECRET;
  return TokenStoreKind.FILE;
}

const quote = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;

/**
 * Cất token → phần ghi vào tệp: `{ token_store, token_enc? }` (kho hệ điều hành) hoặc `{ device_token }` (tệp thường). Kho lỗi (Keychain bị
 * khoá, không có keyring…) → tệp thường, kèm `fallback_reason` để in ra.
 */
export function sealToken(token, { account, store = preferredTokenStore() } = {}) {
  try {
    if (store === TokenStoreKind.DPAPI) return { token_store: store, token_enc: run('powershell.exe', [...PS, DPAPI_PROTECT], token) };
    if (store === TokenStoreKind.KEYCHAIN) {
      run('/usr/bin/security', ['-i'], `add-generic-password -U -a ${quote(account)} -s ${SERVICE} -l "Aivin device token" -w ${quote(token)}\n`);
      return { token_store: store };
    }
    if (store === TokenStoreKind.LIBSECRET) {
      run('secret-tool', ['store', '--label=Aivin device token', 'service', SERVICE, 'account', account], token);
      return { token_store: store };
    }
  } catch (e) {
    return { device_token: token, fallback_reason: String(e?.stderr || e?.message || e).trim().slice(0, 200) };
  }
  return { device_token: token };
}

/** Lấy lại token từ bản ghi trong tệp — `null` khi không giải được (tệp chép từ máy / tài khoản khác, kho đã xoá). */
export function openToken(record) {
  if (!record) return null;
  if (record.device_token) return record.device_token;
  try {
    if (record.token_store === TokenStoreKind.DPAPI && record.token_enc) return run('powershell.exe', [...PS, DPAPI_UNPROTECT], record.token_enc) || null;
    if (record.token_store === TokenStoreKind.KEYCHAIN) return run('/usr/bin/security', ['find-generic-password', '-a', record.device_id, '-s', SERVICE, '-w']) || null;
    if (record.token_store === TokenStoreKind.LIBSECRET) return run('secret-tool', ['lookup', 'service', SERVICE, 'account', record.device_id]) || null;
  } catch { /* không giải được */ }
  return null;
}

/** Xoá token khỏi kho hệ điều hành (DPAPI / tệp thường: xoá tệp là đủ). */
export function forgetToken(record) {
  try {
    if (record?.token_store === TokenStoreKind.KEYCHAIN) run('/usr/bin/security', ['delete-generic-password', '-a', record.device_id, '-s', SERVICE]);
    if (record?.token_store === TokenStoreKind.LIBSECRET) run('secret-tool', ['clear', 'service', SERVICE, 'account', record.device_id]);
  } catch { /* không có thì thôi */ }
}
