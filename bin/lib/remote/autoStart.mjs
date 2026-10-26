import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { REMOTE_CONFIG_DIR } from './deviceProfile.mjs';
import { DeviceAccess } from './constants.mjs';
import { loadDeviceCredentials } from './credentials.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '..', '..', 'cli.mjs');

/** Lệnh chạy CLI: tệp chạy đóng gói (bộ cài install.ps1 / install.sh) là chính nó; bản npm là `node cli.mjs`. */
export function cliLaunchCommand() {
  return process.env.AIVIN_CLI_BINARY ? [process.execPath] : [process.execPath, CLI_PATH];
}

export const REMOTE_DAEMON_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-daemon.json');

/**
 * Lấy đường dẫn tập tin khởi động tự động chính trên các hệ điều hành.
 */
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

/**
 * Lấy danh sách các đường dẫn tập tin tự khởi động tiềm năng cần dọn dẹp khi tắt.
 */
export function getAllAutoStartFilePaths() {
  const paths = [getAutoStartFilePath()];
  if (process.platform === 'linux') {
    paths.push(path.join(os.homedir(), '.config', 'autostart', 'aivin-remote.desktop'));
  }
  return paths;
}

/**
 * Kích hoạt tự khởi động cùng máy tính trên mọi hệ điều hành (Windows, macOS, Linux).
 */
export function enableAutoStart(options = {}) {
  const rootDir = path.resolve(options.dir || process.cwd());
  // Máy đang TOÀN QUYỀN và không nêu --dir: khởi động không kèm --dir để giữ chế độ đã lưu (kèm --dir là về chế độ một thư mục).
  const keepFullAccess = !options.dir && loadDeviceCredentials()?.access === DeviceAccess.FULL;
  const scopeArgs = keepFullAccess ? [] : ['--dir', rootDir];
  const filePath = getAutoStartFilePath();
  const launch = cliLaunchCommand();
  const nodeExec = launch[0];
  const logOut = path.join(REMOTE_CONFIG_DIR, 'remote-service.log');

  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });

  if (process.platform === 'win32') {
    // Windows: Dùng VBScript trong thư mục Startup người dùng để chạy ngầm không hiện cửa sổ
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run "${launch.map((part) => `""${part}""`).join(' ')} remote start --quiet${keepFullAccess ? '' : ` --dir ""${rootDir}""`}", 0, False`,
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(filePath, vbsContent, 'utf8');
  } else if (process.platform === 'darwin') {
    // macOS: Dùng LaunchAgent plist
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aivin.remote</string>
    <key>ProgramArguments</key>
    <array>
${launch.map((part) => `        <string>${part}</string>`).join('\n')}
        <string>remote</string>
        <string>start</string>
        <string>--quiet</string>
${scopeArgs.map((part) => `        <string>${part}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logOut}</string>
    <key>StandardErrorPath</key>
    <string>${logOut}</string>
</dict>
</plist>
`;
    fs.writeFileSync(filePath, plistContent, 'utf8');
  } else {
    // Linux: Thiết lập dịch vụ người dùng systemd và tệp khởi động desktop XDG
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const serviceContent = `[Unit]
Description=AIVIN Remote Control Daemon
After=network.target

[Service]
Type=simple
ExecStart=${launch.map((part) => `"${part}"`).join(' ')} remote start --quiet${keepFullAccess ? '' : ` --dir "${rootDir}"`}
Restart=always
RestartSec=10
WorkingDirectory=${rootDir}
StandardOutput=append:${logOut}
StandardError=append:${logOut}

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(filePath, serviceContent, 'utf8');

    // Đồng thời tạo tệp XDG autostart để phòng trường hợp máy Linux không bật systemd user session
    const desktopPath = path.join(os.homedir(), '.config', 'autostart', 'aivin-remote.desktop');
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    const desktopContent = `[Desktop Entry]
Type=Application
Name=AIVIN Remote Control
Exec=${launch.map((part) => `"${part}"`).join(' ')} remote start --quiet${keepFullAccess ? '' : ` --dir "${rootDir}"`}
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
    nodeExec,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(REMOTE_DAEMON_FILE, JSON.stringify(daemonConfig, null, 2) + '\n', 'utf8');

  return { success: true, filePath, rootDir, platform: process.platform };
}

/**
 * Hủy kích hoạt tự khởi động.
 */
export function disableAutoStart() {
  const targetFiles = getAllAutoStartFilePaths();
  for (const filePath of targetFiles) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Bỏ qua nếu tập tin đang bị khóa hoặc đã xóa
      }
    }
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

/**
 * Kiểm tra trạng thái tự khởi động của thiết bị.
 */
export function getAutoStartStatus() {
  const filePath = getAutoStartFilePath();
  const fileExists = fs.existsSync(filePath);

  let daemonConfig = null;
  if (fs.existsSync(REMOTE_DAEMON_FILE)) {
    try {
      daemonConfig = JSON.parse(fs.readFileSync(REMOTE_DAEMON_FILE, 'utf8'));
    } catch {
      daemonConfig = null;
    }
  }

  return {
    enabled: Boolean(fileExists && daemonConfig?.enabled !== false),
    filePath,
    rootDir: daemonConfig?.rootDir || process.cwd(),
    updatedAt: daemonConfig?.updatedAt || null,
  };
}
