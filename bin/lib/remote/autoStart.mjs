import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { REMOTE_CONFIG_DIR } from './deviceProfile.mjs';
import { DeviceAccess } from './constants.mjs';
import { loadDeviceCredentials } from './credentials.mjs';
import { RESTART_EXIT_CODE, UPDATE_PENDING_FILE, UPDATE_ROLLBACK_FILE } from '../selfUpdate.mjs';
import {
  DESKTOP_DIR, RUN_KEY, STARTUP_VALUE, TrayLaunch, installDesktop, isDesktopInstalled, launcherExePath, readSavedDaemonArgs, setStartupApproved,
  startMenuShortcutPath, startupState, uninstallDesktop,
} from './desktop/index.mjs';
import { installMacDesktop, isMacDesktopInstalled, macAgentPath, macAppPath, macStartupState, setMacStartup, uninstallMacDesktop } from './desktop/mac.mjs';
import {
  hasLinuxDesktopSession, installLinuxDesktop, isLinuxDesktopInstalled, linuxAppEntryPath, linuxAutostartPath, linuxStartupState, linuxTrayAvailable,
  setLinuxStartup, uninstallLinuxDesktop,
} from './desktop/linux.mjs';
import { mascotLang } from './mascot/strings.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '..', '..', 'cli.mjs');

/**
 * Quy ước mã thoát của `aivin remote start` (29/10/2026) cho trình giữ chạy (Task Scheduler + VBS trên Windows, launchd, systemd):
 * 0 = dừng có chủ đích (thu hồi, bị cửa sổ khác thay, đã có tiến trình khác nhận việc, Ctrl+C) → KHÔNG chạy lại; khác 0 = sập / lỗi
 * (mất mạng lúc ghép máy…) → chạy lại sau ít giây, giãn dần tới 5 phút.
 */
export const WINDOWS_TASK_NAME = 'Aivin Remote';
export const WINDOWS_WATCHDOG_FILE = path.join(REMOTE_CONFIG_DIR, 'aivin-remote.vbs');
const WINDOWS_TASK_XML_FILE = path.join(REMOTE_CONFIG_DIR, 'aivin-remote-task.xml');
/** macOS / Linux: launchd / systemd chạy kịch bản này (một lần mỗi lần khởi động) thay vì chạy thẳng tệp chạy — để tự lùi bản ngoài tệp chạy. */
export const POSIX_RUN_SCRIPT_FILE = path.join(REMOTE_CONFIG_DIR, 'aivin-remote-run.sh');
const FAST_FAIL_FILE = path.join(REMOTE_CONFIG_DIR, 'update-fastfail.txt');
/** Tự lùi bản ở trình giữ chạy: bản chờ xác nhận thoát lỗi trong chừng này giây, liên tiếp chừng này lần → trả `.prev` về. */
export const SUPERVISOR_ROLLBACK = Object.freeze({ fastExitSec: 30, failures: 3 });

/**
 * Thông tin để trình giữ chạy tự lùi bản — chỉ cho tệp chạy đóng gói (bản npm không có `.prev`). Tự lùi ở NGOÀI tệp chạy bắt được cả bản mới
 * sập ngay lúc nạp mã (trước khi checkBootAfterUpdate trong tệp chạy kịp chạy).
 */
function supervisorRollbackPaths(launch) {
  return process.env.AIVIN_CLI_BINARY ? { exe: launch[0], pendingFile: UPDATE_PENDING_FILE, rollbackFile: UPDATE_ROLLBACK_FILE, fastFailFile: FAST_FAIL_FILE } : null;
}

/** Lệnh chạy CLI: tệp chạy đóng gói (bộ cài install.ps1 / install.sh) là chính nó; bản npm là `node cli.mjs`. */
export function cliLaunchCommand() {
  return process.env.AIVIN_CLI_BINARY ? [process.execPath] : [process.execPath, CLI_PATH];
}

export const REMOTE_DAEMON_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-daemon.json');

/** Tệp tự khởi động chính: Windows = thư mục Startup (dự phòng khi không tạo được tác vụ), macOS = LaunchAgent, Linux = systemd user. */
export function getAutoStartFilePath() {
  if (process.platform === 'win32') {
    const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return path.join(startupDir, 'aivin-remote.vbs');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.aivin.remote.plist');
  }
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'aivin-remote.service');
}

/** Mọi tệp tự khởi động cần dọn khi tắt. */
export function getAllAutoStartFilePaths() {
  const paths = [getAutoStartFilePath()];
  if (process.platform === 'win32') paths.push(WINDOWS_WATCHDOG_FILE, WINDOWS_TASK_XML_FILE);
  else paths.push(POSIX_RUN_SCRIPT_FILE);
  if (process.platform === 'linux') {
    paths.push(path.join(os.homedir(), '.config', 'autostart', 'aivin-remote.desktop'));
  }
  return paths;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Kịch bản VBS giữ daemon chạy nền (cửa sổ ẩn): chạy, chờ thoát; mã 0 → thôi; khác 0 → chờ 10 s (giãn gấp đôi tới 5 phút, chạy ổn > 5 phút
 * thì về lại 10 s) rồi chạy lại. Trước 29/10/2026 tệp Startup chỉ chạy một lần lúc đăng nhập — daemon sập là máy offline tới lần đăng nhập sau.
 * Mã 75 (đã cài bản mới / đã tự lùi bản) → chạy lại sau 1 s, không giãn nhịp. Đặt AIVIN_SUPERVISOR cho tiến trình con: daemon biết có
 * trình giữ chạy, tự thoát để chuyển bản được (xem detectSupervisor).
 * `rollback` (tệp chạy đóng gói): bản còn chờ xác nhận (có update-pending.txt) thoát lỗi trong < 30 s, 3 lần liền, mà còn `.prev` → đổi bản
 * hỏng sang `.trash`, trả `.prev` về, ghi phiên bản vào update-rollback.txt (bản cũ đọc ở lần chạy sau, đưa vào danh sách bỏ qua).
 */
export function windowsWatchdogScript(argv, { rollback = null } = {}) {
  const cmd = argv.map((part) => `""${part}""`).join(' ');
  const vbsStr = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const { fastExitSec, failures } = SUPERVISOR_ROLLBACK;
  return [
    "' Aivin Device Agent - keeps `aivin remote start` running in the background.",
    "' Exit code 0 = stopped on purpose (revoked, replaced, already running) -> stop; 75 = switch to the newly installed release -> restart now;",
    "' anything else -> restart with backoff. A new release that keeps crashing right away is replaced by the previous one.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Environment("Process").Item("${SUPERVISOR_ENV}") = "${Supervisor.WSCRIPT}"`,
    ...(rollback ? [
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `exe = ${vbsStr(rollback.exe)}`,
      `pending = ${vbsStr(rollback.pendingFile)}`,
      `rollback = ${vbsStr(rollback.rollbackFile)}`,
      'fast = 0',
    ] : []),
    'delay = 10',
    'Do',
    '  started = Now',
    `  rc = sh.Run("${cmd}", 0, True)`,
    '  If rc = 0 Then Exit Do',
    ...(rollback ? [
      `  If rc <> ${RESTART_EXIT_CODE} And DateDiff("s", started, Now) < ${fastExitSec} And fso.FileExists(pending) And fso.FileExists(exe & ".prev") Then`,
      '    fast = fast + 1',
      '  Else',
      '    fast = 0',
      '  End If',
      `  If fast >= ${failures} Then`,
      '    fast = 0',
      '    On Error Resume Next',
      '    Set t = fso.OpenTextFile(pending, 1)',
      '    ver = t.ReadLine',
      '    t.Close',
      '    fso.MoveFile exe, exe & "-" & CLng(Timer * 100) & ".trash"',
      '    If Err.Number = 0 Then fso.MoveFile exe & ".prev", exe',
      '    If Err.Number = 0 Then',
      '      Set t = fso.CreateTextFile(rollback, True)',
      '      t.WriteLine ver',
      '      t.Close',
      '      fso.DeleteFile pending, True',
      '    End If',
      '    Err.Clear',
      '    On Error GoTo 0',
      `    rc = ${RESTART_EXIT_CODE}`,
      '  End If',
    ] : []),
    `  If rc = ${RESTART_EXIT_CODE} Then`,
    '    WScript.Sleep 1000',
    '  Else',
    '    If DateDiff("s", started, Now) > 300 Then delay = 10',
    '    WScript.Sleep delay * 1000',
    '    delay = delay * 2',
    '    If delay > 300 Then delay = 300',
    '  End If',
    'Loop',
  ].join('\r\n') + '\r\n';
}

/**
 * macOS / Linux: kịch bản sh launchd / systemd chạy mỗi lần khởi động (chúng tự chạy lại khi mã thoát khác 0). Đặt AIVIN_SUPERVISOR, chạy
 * daemon một lần, rồi — với tệp chạy đóng gói — tự lùi bản như VBS (đếm lần sập nhanh liên tiếp trong tệp, vì mỗi lần là một tiến trình mới).
 */
export function posixRunScript(argv, { supervisor, rollback = null }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const { fastExitSec, failures } = SUPERVISOR_ROLLBACK;
  return [
    '#!/bin/sh',
    '# Aivin Device Agent - runs `aivin remote start` once; launchd / systemd restart it on a non-zero exit (75 = switch release).',
    '# A new release that crashes right away, several times in a row, while still unconfirmed is replaced by the previous one.',
    `${SUPERVISOR_ENV}=${q(supervisor)}`,
    `export ${SUPERVISOR_ENV}`,
    ...(rollback ? [
      `BIN=${q(rollback.exe)}`,
      `PENDING=${q(rollback.pendingFile)}`,
      `ROLLBACK=${q(rollback.rollbackFile)}`,
      `FAST=${q(rollback.fastFailFile)}`,
      'started=$(date +%s)',
    ] : []),
    `${argv.map(q).join(' ')} "$@"`,
    'rc=$?',
    ...(rollback ? [
      'elapsed=$(( $(date +%s) - started ))',
      `if [ "$rc" -ne 0 ] && [ "$rc" -ne ${RESTART_EXIT_CODE} ] && [ "$elapsed" -lt ${fastExitSec} ] && [ -f "$PENDING" ] && [ -f "$BIN.prev" ]; then`,
      '  n=$(( $(cat "$FAST" 2>/dev/null || echo 0) + 1 ))',
      `  if [ "$n" -ge ${failures} ]; then`,
      '    if mv -f "$BIN.prev" "$BIN"; then head -n 1 "$PENDING" > "$ROLLBACK"; rm -f "$PENDING"; fi',
      '    rm -f "$FAST"',
      `    exit ${RESTART_EXIT_CODE}`,
      '  fi',
      '  echo "$n" > "$FAST"',
      'else',
      '  rm -f "$FAST"',
      'fi',
    ] : []),
    'exit "$rc"',
  ].join('\n') + '\n';
}

function writePosixRunScript(argv, supervisor, launch) {
  fs.mkdirSync(path.dirname(POSIX_RUN_SCRIPT_FILE), { recursive: true });
  fs.writeFileSync(POSIX_RUN_SCRIPT_FILE, posixRunScript(argv, { supervisor, rollback: supervisorRollbackPaths(launch) }), { mode: 0o755 });
  fs.chmodSync(POSIX_RUN_SCRIPT_FILE, 0o755);
  return ['/bin/sh', POSIX_RUN_SCRIPT_FILE];
}

/** Biến môi trường trình giữ chạy của Aivin đặt cho daemon. */
export const SUPERVISOR_ENV = 'AIVIN_SUPERVISOR';
export const Supervisor = Object.freeze({ WSCRIPT: 'wscript', TRAY: 'tray', LAUNCHD: 'launchd', SYSTEMD: 'systemd' });

function parentCommandLine() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(process.ppid)}").CommandLine`], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Daemon có đang chạy dưới trình giữ chạy của Aivin không (thoát mã 75 thì được mở lại). Dấu AIVIN_SUPERVISOR (tệp tự khởi động từ bản có
 * tự cập nhật); tệp tự khởi động cũ không có dấu → launchd: nhãn `com.aivin.remote`; Windows: tiến trình cha là wscript chạy đúng
 * aivin-remote.vbs. systemd cũ không nhận ra được → coi như không có (chỉ nhắc, không tự thoát) — an toàn hơn đoán sai rồi mất máy.
 * Trước đây `--quiet` bị coi là có trình giữ chạy: ai tự chạy `--quiet` trong terminal / script riêng thì daemon tự thoát rồi máy offline.
 */
export function detectSupervisor({ env = process.env, platform = process.platform, quiet = false, readParent = parentCommandLine } = {}) {
  const marked = String(env[SUPERVISOR_ENV] || '');
  if (Object.values(Supervisor).includes(marked)) return marked;
  if (!quiet) return null;
  if (platform === 'darwin' && env.XPC_SERVICE_NAME === 'com.aivin.remote') return Supervisor.LAUNCHD;
  if (platform === 'win32' && /\bwscript(\.exe)?\b.*aivin-remote\.vbs/i.test(readParent())) return Supervisor.WSCRIPT;
  return null;
}

/**
 * Tác vụ Task Scheduler của người dùng hiện tại (không cần quyền quản trị): chạy lúc đăng nhập, phiên tương tác (điều khiển giao diện /
 * Office cần màn hình của người dùng), không dừng khi chạy pin, không giới hạn thời gian, không chạy chồng.
 */
export function windowsTaskXml({ userId, watchdogFile }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Aivin Device Agent - lets your Aivin agents work on this computer (aivin remote start)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B //Nologo "${xmlEscape(watchdogFile)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** UTF-16 LE có BOM: wscript đọc đúng đường dẫn có dấu (tên người dùng tiếng Việt…), schtasks /XML nhận đúng khai báo encoding. */
function writeUtf16(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

function windowsUserId() {
  const user = process.env.USERNAME || os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
}

function schtasks(args) {
  return execFileSync('schtasks', args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function windowsTaskExists() {
  try {
    schtasks(['/Query', '/TN', WINDOWS_TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}

/** Gỡ cách tự khởi động cũ của Windows (tác vụ Task Scheduler / VBS ở Startup) — tiến trình VBS đang chạy vẫn chạy tới khi tắt máy. */
function removeLegacyWindowsAutoStart() {
  try { schtasks(['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']); } catch { /* chưa có tác vụ */ }
  for (const file of [getAutoStartFilePath(), WINDOWS_WATCHDOG_FILE, WINDOWS_TASK_XML_FILE]) {
    try { fs.rmSync(file, { force: true }); } catch { /* tệp đang bị khoá */ }
  }
}

/** Dự phòng: tác vụ Task Scheduler chạy kịch bản VBS; máy chặn tạo tác vụ (chính sách công ty) → chép kịch bản vào thư mục Startup. */
function enableWindowsTask(argv, launch) {
  const script = windowsWatchdogScript(argv, { rollback: supervisorRollbackPaths(launch) });
  writeUtf16(WINDOWS_WATCHDOG_FILE, script);
  const startupFile = getAutoStartFilePath();
  try {
    writeUtf16(WINDOWS_TASK_XML_FILE, windowsTaskXml({ userId: windowsUserId(), watchdogFile: WINDOWS_WATCHDOG_FILE }));
    schtasks(['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', WINDOWS_TASK_XML_FILE, '/F']);
    fs.rmSync(startupFile, { force: true });
    return { filePath: `Task Scheduler: ${WINDOWS_TASK_NAME}`, method: 'task' };
  } catch (e) {
    writeUtf16(startupFile, script);
    return { filePath: startupFile, method: 'startup', warning: `Không tạo được tác vụ Task Scheduler (${String(e?.stderr || e?.message || e).trim()}) — dùng thư mục Startup` };
  } finally {
    fs.rmSync(WINDOWS_TASK_XML_FILE, { force: true });
  }
}

const RUN_ENTRY = `${RUN_KEY}\\${STARTUP_VALUE}`;

/**
 * Windows: ứng dụng khay Aivin.exe (desktop/) giữ daemon chạy, mục khởi động ở khoá Run (hiện + bật / tắt được trong Task Manager →
 * Startup apps), lối tắt Start menu. Không dựng được Aivin.exe (máy chặn csc / PowerShell) → lùi về tác vụ Task Scheduler như trước.
 */
function enableWindows(argv, launch) {
  try {
    installDesktop({ argv, rollback: supervisorRollbackPaths(launch), lang: mascotLang(), autostart: true, launch: true, launchMode: TrayLaunch.AUTOSTART });
    removeLegacyWindowsAutoStart();
    return { filePath: `${RUN_ENTRY} (Task Manager → Startup apps)`, method: 'run' };
  } catch (e) {
    const res = enableWindowsTask(argv, launch);
    const why = `Không dựng được ứng dụng khay Aivin (${String(e?.message || e).trim()}) — dùng ${res.method === 'task' ? 'Task Scheduler' : 'thư mục Startup'}`;
    return { ...res, warning: [why, res.warning].filter(Boolean).join('; ') };
  }
}

function writeDaemonConfig({ rootDir, filePath, method, nodeExec }) {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  const daemonConfig = {
    enabled: true,
    platform: process.platform,
    rootDir,
    autoStartFile: filePath,
    ...(method ? { method } : {}),
    nodeExec,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(REMOTE_DAEMON_FILE, JSON.stringify(daemonConfig, null, 2) + '\n', 'utf8');
}

/**
 * macOS / Linux: biểu tượng thanh menu / khay (desktop/mac.mjs, desktop/linux.mjs) chạy aivin-remote-run.sh — một kịch bản cho cả hai,
 * dấu trình giữ chạy = tray. Đối số daemon lưu riêng (daemon-args.json) để `aivin desktop install` sau giữ `--dir` / `--proxy`.
 */
const POSIX_DESKTOP = {
  darwin: {
    install: installMacDesktop, uninstall: uninstallMacDesktop, installed: isMacDesktopInstalled, state: macStartupState, setStartup: setMacStartup,
    entry: () => `${macAgentPath()} (System Settings → General → Login Items)`, app: () => macAppPath(), search: 'Spotlight / Launchpad',
  },
  linux: {
    install: installLinuxDesktop, uninstall: uninstallLinuxDesktop, installed: isLinuxDesktopInstalled, state: linuxStartupState, setStartup: setLinuxStartup,
    entry: () => linuxAutostartPath(), app: () => linuxAppEntryPath(), search: 'menu ứng dụng',
  },
};
const DAEMON_ARGS_FILE = path.join(DESKTOP_DIR, 'daemon-args.json');

function readPosixDaemonArgs() {
  try {
    const args = JSON.parse(fs.readFileSync(DAEMON_ARGS_FILE, 'utf8'));
    return Array.isArray(args) ? args.map(String) : null;
  } catch {
    return null;
  }
}

function installPosixDesktop(argv, launch, options) {
  const desktop = POSIX_DESKTOP[process.platform];
  const [runShell, runScript] = writePosixRunScript(argv, Supervisor.TRAY, launch);
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_ARGS_FILE, JSON.stringify(argv.slice(argv.indexOf('start') + 1)));
  const res = desktop.install({ runScript, lang: mascotLang(), ...options });
  return { ...res, runShell };
}

/** `aivin remote enable` trên macOS / Linux có màn hình: thanh menu / khay + mục khởi động; lỗi → cách cũ (LaunchAgent / systemd + autostart). */
function tryPosixDesktop(argv, launch) {
  const desktop = POSIX_DESKTOP[process.platform];
  if (!desktop || (process.platform === 'linux' && !hasLinuxDesktopSession())) return null;
  try {
    installPosixDesktop(argv, launch, { autostart: true, launch: true, launchMode: TrayLaunch.AUTOSTART });
    return { filePath: desktop.entry(), method: 'desktop' };
  } catch (e) {
    return { warning: `Không dựng được ứng dụng Aivin trên màn hình (${String(e?.message || e).trim()}) — dùng cách tự khởi động cũ` };
  }
}

/**
 * `aivin desktop install` (bộ cài install.ps1 / install.sh gọi): Windows = khay + Start menu, macOS = Aivin.app + thanh menu, Linux = menu ứng
 * dụng + khay; (mặc định) khởi động cùng máy. Giữ đối số daemon của lần `aivin remote enable` trước; chưa có thì `remote start --quiet`
 * trần — daemon dùng thư mục / chế độ đã lưu lúc ghép máy.
 */
export function installDesktopApp({ autostart = true, launch = true } = {}) {
  const cli = cliLaunchCommand();
  if (process.platform === 'win32') {
    const argv = [...cli, 'remote', 'start', ...(readSavedDaemonArgs() || ['--quiet'])];
    const res = installDesktop({ argv, rollback: supervisorRollbackPaths(cli), lang: mascotLang(), autostart, launch });
    if (autostart) {
      removeLegacyWindowsAutoStart();
      writeDaemonConfig({ rootDir: os.homedir(), filePath: RUN_ENTRY, method: 'run', nodeExec: cli[0] });
    }
    return res;
  }
  const desktop = POSIX_DESKTOP[process.platform];
  if (!desktop) throw new Error(`Chưa hỗ trợ ứng dụng Aivin trên màn hình cho ${process.platform}.`);
  const argv = [...cli, 'remote', 'start', ...(readPosixDaemonArgs() || ['--quiet'])];
  const res = installPosixDesktop(argv, cli, { autostart, launch, launchMode: TrayLaunch.INSTALLED });
  if (autostart) writeDaemonConfig({ rootDir: os.homedir(), filePath: desktop.entry(), method: 'desktop', nodeExec: cli[0] });
  return res;
}

/** `aivin desktop uninstall`: gỡ ứng dụng + mục khởi động (tiến trình daemon nó giữ cũng dừng). */
export function uninstallDesktopApp() {
  if (process.platform === 'win32') return uninstallDesktop();
  const desktop = POSIX_DESKTOP[process.platform];
  if (!desktop) return { removed: true };
  const res = desktop.uninstall();
  fs.rmSync(POSIX_RUN_SCRIPT_FILE, { force: true });
  return res;
}

/** `aivin desktop`: đã cài chưa, ở đâu, tìm bằng gì, khởi động cùng máy, (Linux) có biểu tượng khay không. */
export function desktopAppStatus() {
  if (process.platform === 'win32') {
    return {
      installed: isDesktopInstalled(), app: launcherExePath(), search: fs.existsSync(startMenuShortcutPath()) ? 'Start menu' : null,
      startup: startupState(), tray: true,
    };
  }
  const desktop = POSIX_DESKTOP[process.platform];
  if (!desktop) return { installed: false, supported: false };
  const installed = desktop.installed();
  return {
    installed, app: desktop.app(), search: installed ? desktop.search : null, startup: desktop.state(),
    tray: process.platform === 'darwin' ? true : linuxTrayAvailable(),
  };
}

/** Kích hoạt tự khởi động cùng máy tính trên mọi hệ điều hành (Windows, macOS, Linux). */
export function enableAutoStart(options = {}) {
  const rootDir = path.resolve(options.dir || process.cwd());
  // Máy đang TOÀN QUYỀN và không nêu --dir: khởi động không kèm --dir để giữ chế độ đã lưu (kèm --dir là về chế độ một thư mục).
  const keepFullAccess = !options.dir && loadDeviceCredentials()?.access === DeviceAccess.FULL;
  const scopeArgs = [...(keepFullAccess ? [] : ['--dir', rootDir]), ...(options.proxy ? ['--proxy', String(options.proxy)] : [])];
  const launch = cliLaunchCommand();
  const argv = [...launch, 'remote', 'start', '--quiet', ...scopeArgs];
  const nodeExec = launch[0];
  const logOut = path.join(REMOTE_CONFIG_DIR, 'remote-service.log');
  let filePath = getAutoStartFilePath();
  let extra = {};

  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });

  const desktop = process.platform === 'win32' ? null : tryPosixDesktop(argv, launch);
  if (process.platform === 'win32') {
    extra = enableWindows(argv, launch);
    filePath = extra.filePath;
  } else if (desktop?.filePath) {
    extra = desktop;
    filePath = desktop.filePath;
  } else if (process.platform === 'darwin') {
    if (desktop?.warning) extra = { warning: desktop.warning };
    // macOS: LaunchAgent chạy kịch bản sh (tự lùi bản ngoài tệp chạy), chỉ chạy lại khi thoát bất thường (mã khác 0).
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const runArgv = writePosixRunScript(argv, Supervisor.LAUNCHD, launch);
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aivin.remote</string>
    <key>ProgramArguments</key>
    <array>
${runArgv.map((part) => `        <string>${xmlEscape(part)}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>${SUPERVISOR_ENV}</key>
        <string>${Supervisor.LAUNCHD}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logOut)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logOut)}</string>
</dict>
</plist>
`;
    fs.writeFileSync(filePath, plistContent, 'utf8');
  } else {
    if (desktop?.warning) extra = { warning: desktop.warning };
    // Linux: dịch vụ người dùng systemd chạy kịch bản sh (chạy lại khi thoát bất thường, tự lùi bản) + tệp XDG autostart cho máy không bật
    // systemd user session (chạy thẳng, không có trình giữ chạy → không tự chuyển bản).
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const execLine = argv.map((part) => `"${part}"`).join(' ');
    const runLine = writePosixRunScript(argv, Supervisor.SYSTEMD, launch).map((part) => `"${part}"`).join(' ');
    const serviceContent = `[Unit]
Description=AIVIN Remote Control Daemon
After=network.target

[Service]
Type=simple
ExecStart=${runLine}
Restart=on-failure
RestartSec=10
Environment=${SUPERVISOR_ENV}=${Supervisor.SYSTEMD}
WorkingDirectory=${rootDir}
StandardOutput=append:${logOut}
StandardError=append:${logOut}

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(filePath, serviceContent, 'utf8');

    const desktopPath = path.join(os.homedir(), '.config', 'autostart', 'aivin-remote.desktop');
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    const desktopContent = `[Desktop Entry]
Type=Application
Name=AIVIN Remote Control
Exec=${execLine}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
    fs.writeFileSync(desktopPath, desktopContent, 'utf8');
  }

  writeDaemonConfig({ rootDir, filePath, method: extra.method, nodeExec });

  return { success: true, filePath, rootDir, platform: process.platform, ...(extra.warning ? { warning: extra.warning } : {}) };
}

/** Huỷ tự khởi động (tiến trình đang chạy vẫn chạy tới khi tắt). */
export function disableAutoStart() {
  if (process.platform === 'win32') {
    try { schtasks(['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']); } catch { /* chưa có tác vụ */ }
    // Khoá Run: đánh dấu tắt như Task Manager — mục vẫn hiện "Disabled", bật lại được ở đó / menu khay / `aivin remote enable`.
    if (startupState().registered) setStartupApproved(false);
  }
  // macOS / Linux đã cài ứng dụng: chỉ tắt mục khởi động (bật lại được ở menu / Login Items / Startup Applications); giữ kịch bản chạy cho app.
  const desktop = POSIX_DESKTOP[process.platform];
  const keepRunScript = Boolean(desktop?.installed());
  if (keepRunScript) desktop.setStartup(false);
  for (const filePath of getAllAutoStartFilePaths()) {
    if (keepRunScript && filePath === POSIX_RUN_SCRIPT_FILE) continue;
    try { fs.rmSync(filePath, { force: true }); } catch { /* tệp đang bị khoá */ }
  }

  if (fs.existsSync(REMOTE_DAEMON_FILE)) {
    try {
      const current = JSON.parse(fs.readFileSync(REMOTE_DAEMON_FILE, 'utf8'));
      current.enabled = false;
      current.updatedAt = new Date().toISOString();
      fs.writeFileSync(REMOTE_DAEMON_FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
    } catch {
      // Bỏ qua lỗi đọc ghi cấu hình
    }
  }

  return { success: true };
}

/** Trạng thái tự khởi động của máy. */
export function getAutoStartStatus() {
  const startupFile = getAutoStartFilePath();
  let daemonConfig = null;
  if (fs.existsSync(REMOTE_DAEMON_FILE)) {
    try {
      daemonConfig = JSON.parse(fs.readFileSync(REMOTE_DAEMON_FILE, 'utf8'));
    } catch {
      daemonConfig = null;
    }
  }
  // Windows: khoá Run là nguồn sự thật — người dùng có thể bật / tắt ở Task Manager hay menu khay, không qua aivin.
  const run = process.platform === 'win32' ? startupState() : null;
  if (run?.registered) {
    return { enabled: run.enabled, filePath: RUN_ENTRY, rootDir: daemonConfig?.rootDir || process.cwd(), updatedAt: daemonConfig?.updatedAt || null };
  }
  const desktop = POSIX_DESKTOP[process.platform];
  if (desktop?.installed() && desktop.state().registered) {
    return { enabled: desktop.state().enabled, filePath: desktop.entry(), rootDir: daemonConfig?.rootDir || process.cwd(), updatedAt: daemonConfig?.updatedAt || null };
  }
  const task = process.platform === 'win32' && daemonConfig?.method === 'task' && windowsTaskExists();
  const installed = task || fs.existsSync(startupFile);

  return {
    enabled: Boolean(installed && daemonConfig?.enabled !== false),
    filePath: task ? `Task Scheduler: ${WINDOWS_TASK_NAME}` : startupFile,
    rootDir: daemonConfig?.rootDir || process.cwd(),
    updatedAt: daemonConfig?.updatedAt || null,
  };
}
