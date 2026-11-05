import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';
import { lockHolder } from '../daemonLock.mjs';
import { disableAutoStart, uninstallDesktopApp } from '../autoStart.mjs';
import { clearDeviceCredentials, loadDeviceCredentials, unpairDevice } from '../credentials.mjs';
import { isStandaloneBinary } from '../../update/versions.mjs';
import { launcherExePath } from './index.mjs';

/**
 * `aivin uninstall` (05/11/2026) — gỡ Aivin khỏi máy Windows; mục trong Programs & Features chạy `Aivin.exe --uninstall`, hỏi chủ máy rồi gọi lệnh này.
 * Luôn bỏ: ứng dụng + mục chuột phải (uninstallDesktopApp), tự khởi động, daemon, token máy, khoá đăng nhập, PATH, aivin.exe.
 * Dữ liệu trong .aivin (ghi nhớ, bản sao hoàn tác, phiên đăng nhập trình duyệt, nhật ký) chỉ xoá khi được yêu cầu: xoá rồi không lấy lại được.
 *
 * aivin.exe đang chạy không tự xoá được chính nó, nên phần cuối giao cho một tiến trình PowerShell tách riêng, chạy sau khi lệnh này thoát.
 */

const SERVER_REVOKE_TIMEOUT_MS = 8000;

export const ServerRevoke = Object.freeze({ DONE: 'done', SKIPPED: 'skipped', FAILED: 'failed' });

/** Mã dọn cuối, tham số qua biến môi trường (không phải xử lý dấu ngoặc trong đường dẫn). Chỉ xoá aivin.exe* trong thư mục cài, không xoá cả thư mục: có thể do người dùng tự chọn. */
export const CLEANUP_PS1 = String.raw`
$p = Get-Process -Id ([int]$env:AIVIN_U_PID) -ErrorAction SilentlyContinue
if ($p) { [void]$p.WaitForExit(30000) }
Start-Sleep -Milliseconds 500
function Retry($action) { for ($i = 0; $i -lt 10; $i++) { try { & $action; return } catch { Start-Sleep -Seconds 1 } } }
if ($env:AIVIN_U_BIN) {
  $bin = $env:AIVIN_U_BIN
  if ($env:AIVIN_U_PATH -eq '1') {
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($u) {
      $n = @($u -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $bin.TrimEnd('\') }) -join ';'
      if ($n -ne $u) { [Environment]::SetEnvironmentVariable('Path', $n, 'User') }
    }
  }
  Get-ChildItem -LiteralPath $bin -Filter 'aivin.exe*' -Force -ErrorAction SilentlyContinue | ForEach-Object { $f = $_.FullName; Retry { Remove-Item -LiteralPath $f -Force -ErrorAction Stop } }
}
foreach ($d in @($env:AIVIN_U_BIN, $env:AIVIN_U_APP)) {
  if ($d -and (Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue }
}
if ($env:AIVIN_U_DATA) { $data = $env:AIVIN_U_DATA; Retry { Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction Stop } }
`;

/** Đường dẫn được phép xoá cả cây: không phải gốc ổ, không phải thư mục nhà hay tổ tiên của nó (AIVIN_REMOTE_HOME đặt sai không được xoá nhầm). */
export function safeDataDir(dir, home = os.homedir()) {
  const abs = path.resolve(dir);
  if (path.parse(abs).root === abs) return null;
  const rel = path.relative(abs, path.resolve(home));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? null : abs;
}

async function revokeOnServer({ serverUrl, apiKey, deviceId }) {
  if (!deviceId || !apiKey || !serverUrl) return ServerRevoke.SKIPPED;
  try {
    await Promise.race([
      unpairDevice({ serverUrl, apiKey, deviceId }),
      new Promise((_, reject) => { setTimeout(reject, SERVER_REVOKE_TIMEOUT_MS, new Error('timeout')).unref?.(); }),
    ]);
    return ServerRevoke.DONE;
  } catch {
    return ServerRevoke.FAILED;
  }
}

/**
 * Trả `{ server, removesBinary, dataDir }`. `server`: máy có được thu hồi trên máy chủ không — SKIPPED / FAILED thì máy còn trong danh sách của tài khoản
 * (ngoại tuyến, trên máy này không còn token) tới khi chủ tài khoản thu hồi. `removesBinary`: false = cài qua npm, lệnh `aivin` còn lại.
 */
export async function uninstallAivin({ deleteData = false, serverUrl, apiKey } = {}) {
  if (process.platform !== 'win32') throw new Error('`aivin uninstall` chỉ có trên Windows — trên macOS / Linux dùng `aivin desktop uninstall`.');
  const server = await revokeOnServer({ serverUrl, apiKey, deviceId: loadDeviceCredentials()?.device_id });

  try { disableAutoStart(); } catch { /* vẫn gỡ tiếp */ }
  uninstallDesktopApp();
  const running = lockHolder();
  if (running && running !== process.pid) try { process.kill(running); } catch { /* vừa tự thoát */ }

  try { clearDeviceCredentials(); } catch { /* còn tệp thì bước dưới xoá */ }
  for (const name of ['device-credentials.json', 'credentials']) fs.rmSync(path.join(REMOTE_CONFIG_DIR, name), { force: true });

  const removesBinary = isStandaloneBinary();
  const dataDir = deleteData ? safeDataDir(REMOTE_CONFIG_DIR) : null;
  if (removesBinary || dataDir) {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', CLEANUP_PS1], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: {
        ...process.env, AIVIN_U_PID: String(process.pid), AIVIN_U_PATH: removesBinary ? '1' : '0',
        AIVIN_U_BIN: removesBinary ? path.dirname(process.execPath) : '', AIVIN_U_APP: path.dirname(launcherExePath()), AIVIN_U_DATA: dataDir || '',
      },
    }).unref();
  }
  return { server, removesBinary, dataDir };
}
