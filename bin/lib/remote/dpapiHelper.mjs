import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { REMOTE_CONFIG_DIR } from './constants.mjs';

/**
 * DPAPI nhanh trên Windows (13/11/2026): tệp exe nhỏ biên dịch một lần bằng csc của .NET Framework có sẵn trong Windows, đặt trong
 * `~/.aivin/bin` (thư mục bị chặn với mọi công cụ từ xa). Mỗi lần giải ~0,1 s thay vì ~1–4 s của PowerShell — đủ nhanh để CLI giải khoá
 * API ở MỖI lệnh. Không biên dịch được (máy chặn csc, diệt virus xoá tệp) → `null`, tokenStore lùi về PowerShell như cũ.
 * Định dạng bản mã giống hệt bản PowerShell (UTF-8, entropy, CurrentUser, base64) nên đọc được bản mã cũ.
 */

const SOURCE = `using System; using System.Text; using System.Security.Cryptography;
class AivinDpapi {
  static int Main(string[] a) {
    try {
      if (a.Length < 2) return 2;
      string input = Console.In.ReadToEnd();
      byte[] entropy = Encoding.UTF8.GetBytes(a[1]);
      if (a[0] == "protect") {
        Console.Out.Write(Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(input), entropy, DataProtectionScope.CurrentUser)));
        return 0;
      }
      if (a[0] == "unprotect") {
        Console.Out.Write(Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(input.Trim()), entropy, DataProtectionScope.CurrentUser)));
        return 0;
      }
      return 2;
    } catch { return 1; }
  }
}
`;

const VERSION = createHash('sha256').update(SOURCE).digest('hex').slice(0, 10);
const BIN_DIR = path.join(REMOTE_CONFIG_DIR, 'bin');
export const DPAPI_HELPER_PATH = path.join(BIN_DIR, `aivin-dpapi-${VERSION}.exe`);
const FAILED_MARK = path.join(BIN_DIR, `aivin-dpapi-${VERSION}.failed`);
/** Biên dịch hỏng thì thôi thử lại trong ngần này — không bắt mọi lệnh chờ csc. */
const RETRY_AFTER_FAIL_MS = 24 * 3600_000;
const RUN_TIMEOUT_MS = 10_000;

export const DpapiMode = Object.freeze({ PROTECT: 'protect', UNPROTECT: 'unprotect' });

let resolved; // undefined = chưa dò; null = không dùng được; chuỗi = đường dẫn exe

function cscPath(env = process.env) {
  const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  return ['Framework64', 'Framework'].map((d) => path.join(windir, 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p)) || null;
}

function recentlyFailed() {
  try { return Date.now() - fs.statSync(FAILED_MARK).mtimeMs < RETRY_AFTER_FAIL_MS; } catch { return false; }
}

function build() {
  const csc = cscPath();
  if (!csc) return null;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const src = path.join(BIN_DIR, `aivin-dpapi-${VERSION}.cs`);
  const tmp = `${DPAPI_HELPER_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(src, SOURCE, 'utf8');
    execFileSync(csc, ['-nologo', '-target:exe', '-optimize+', '-r:System.Security.dll', `-out:${tmp}`, src], { timeout: 60_000, windowsHide: true, stdio: 'ignore' });
    fs.renameSync(tmp, DPAPI_HELPER_PATH);
    return DPAPI_HELPER_PATH;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* không có thì thôi */ }
    try { fs.writeFileSync(FAILED_MARK, new Date().toISOString()); } catch { /* chỉ là dấu */ }
    return fs.existsSync(DPAPI_HELPER_PATH) ? DPAPI_HELPER_PATH : null;
  } finally {
    try { fs.rmSync(src, { force: true }); } catch { /* không có thì thôi */ }
  }
}

/** Đường dẫn exe (biên dịch lần đầu nếu cần); `null` khi không phải Windows hoặc không dựng được. */
export function dpapiHelper({ platform = process.platform } = {}) {
  if (resolved !== undefined) return resolved;
  if (platform !== 'win32' || process.env.AIVIN_DPAPI_HELPER === '0') return (resolved = null);
  if (fs.existsSync(DPAPI_HELPER_PATH)) return (resolved = DPAPI_HELPER_PATH);
  if (recentlyFailed()) return (resolved = null);
  return (resolved = build());
}

/** Chạy exe; lỗi (bản mã của máy / tài khoản khác…) → ném lỗi như nhánh PowerShell. */
export function runDpapiHelper(exe, mode, input, entropy) {
  return execFileSync(exe, [mode, entropy], { input, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Chỉ cho test: quên kết quả dò. */
export function resetDpapiHelperForTest() { resolved = undefined; }
