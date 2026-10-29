import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { REMOTE_CONFIG_DIR } from './deviceProfile.mjs';
import { DeviceAccess } from './constants.mjs';
import { loadDeviceCredentials } from './credentials.mjs';

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
  if (process.platform === 'linux') {
    paths.push(path.join(os.homedir(), '.config', 'autostart', 'aivin-remote.desktop'));
  }
  return paths;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Kịch bản VBS giữ daemon chạy nền (cửa sổ ẩn): chạy, chờ thoát; mã 0 → thôi; khác 0 → chờ 10 s (giãn gấp đôi tới 5 phút, chạy ổn > 5 phút
 * thì về lại 10 s) rồi chạy lại. Trước 29/10/2026 tệp Startup chỉ chạy một lần lúc đăng nhập — daemon sập là máy offline tới lần đăng nhập sau.
 */
export function windowsWatchdogScript(argv) {
  const cmd = argv.map((part) => `""${part}""`).join(' ');
  return [
    "' Aivin Device Agent - keeps `aivin remote start` running in the background.",
    "' Exit code 0 = stopped on purpose (revoked, replaced, already running) -> stop; anything else -> restart with backoff.",
    'Set sh = CreateObject("WScript.Shell")',
    'delay = 10',
    'Do',
    '  started = Now',
    `  rc = sh.Run("${cmd}", 0, True)`,
    '  If rc = 0 Then Exit Do',
    '  If DateDiff("s", started, Now) > 300 Then delay = 10',
    '  WScript.Sleep delay * 1000',
    '  delay = delay * 2',
    '  If delay > 300 Then delay = 300',
    'Loop',
  ].join('\r\n') + '\r\n';
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

/** Windows: tác vụ Task Scheduler chạy kịch bản giữ chạy; máy chặn tạo tác vụ (chính sách công ty) → chép kịch bản vào thư mục Startup. */
function enableWindows(argv) {
  writeUtf16(WINDOWS_WATCHDOG_FILE, windowsWatchdogScript(argv));
  const startupFile = getAutoStartFilePath();
  try {
    writeUtf16(WINDOWS_TASK_XML_FILE, windowsTaskXml({ userId: windowsUserId(), watchdogFile: WINDOWS_WATCHDOG_FILE }));
    schtasks(['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', WINDOWS_TASK_XML_FILE, '/F']);
    fs.rmSync(startupFile, { force: true });
    return { filePath: `Task Scheduler: ${WINDOWS_TASK_NAME}`, method: 'task' };
  } catch (e) {
    writeUtf16(startupFile, windowsWatchdogScript(argv));
    return { filePath: startupFile, method: 'startup', warning: `Không tạo được tác vụ Task Scheduler (${String(e?.stderr || e?.message || e).trim()}) — dùng thư mục Startup` };
  } finally {
    fs.rmSync(WINDOWS_TASK_XML_FILE, { force: true });
  }
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

  if (process.platform === 'win32') {
    extra = enableWindows(argv);
    filePath = extra.filePath;
  } else if (process.platform === 'darwin') {
    // macOS: LaunchAgent, chỉ chạy lại khi thoát bất thường (mã khác 0).
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aivin.remote</string>
    <key>ProgramArguments</key>
    <array>
${argv.map((part) => `        <string>${xmlEscape(part)}</string>`).join('\n')}
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
    <key>StandardOutPath</key>
    <string>${xmlEscape(logOut)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logOut)}</string>
</dict>
</plist>
`;
    fs.writeFileSync(filePath, plistContent, 'utf8');
  } else {
    // Linux: dịch vụ người dùng systemd (chạy lại khi thoát bất thường) + tệp XDG autostart cho máy không bật systemd user session.
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const execLine = argv.map((part) => `"${part}"`).join(' ');
    const serviceContent = `[Unit]
Description=AIVIN Remote Control Daemon
After=network.target

[Service]
Type=simple
ExecStart=${execLine}
Restart=on-failure
RestartSec=10
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

  const daemonConfig = {
    enabled: true,
    platform: process.platform,
    rootDir,
    autoStartFile: filePath,
    ...(extra.method ? { method: extra.method } : {}),
    nodeExec,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(REMOTE_DAEMON_FILE, JSON.stringify(daemonConfig, null, 2) + '\n', 'utf8');

  return { success: true, filePath, rootDir, platform: process.platform, ...(extra.warning ? { warning: extra.warning } : {}) };
}

/** Huỷ tự khởi động (tiến trình đang chạy vẫn chạy tới khi tắt). */
export function disableAutoStart() {
  if (process.platform === 'win32') {
    try { schtasks(['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']); } catch { /* chưa có tác vụ */ }
  }
  for (const filePath of getAllAutoStartFilePaths()) {
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
  const task = process.platform === 'win32' && daemonConfig?.method === 'task' && windowsTaskExists();
  const installed = task || fs.existsSync(startupFile);

  return {
    enabled: Boolean(installed && daemonConfig?.enabled !== false),
    filePath: task ? `Task Scheduler: ${WINDOWS_TASK_NAME}` : startupFile,
    rootDir: daemonConfig?.rootDir || process.cwd(),
    updatedAt: daemonConfig?.updatedAt || null,
  };
}
