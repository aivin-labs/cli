import fs from 'fs';
import os from 'os';
import { posix as path } from 'path';
import { execFileSync, spawn } from 'child_process';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';
import { AIVIN_LOGO_PNG_BASE64 } from '../brand.mjs';
import { DESKTOP_DIR, LAUNCH_CONFIG_FILE, TrayLaunch, launchConfigText } from './index.mjs';
import { MAC_TRAY_JS } from './macTraySource.mjs';

/**
 * Aivin trên macOS (29/10/2026): gói ~/Applications/Aivin.app (Spotlight / Launchpad tìm được "Aivin") chạy biểu tượng thanh menu
 * (macTraySource.mjs); LaunchAgent com.aivin.remote mở app lúc đăng nhập — AssociatedBundleIdentifiers để System Settings → General →
 * Login Items hiện "Aivin" kèm biểu tượng (không phải "sh") và bật / tắt được ở đó. Nhãn giữ com.aivin.remote như trước (detectSupervisor
 * nhận ra tiến trình cũ theo nhãn), cài đè lên LaunchAgent cũ chạy thẳng aivin-remote-run.sh.
 */

export const MAC_BUNDLE_ID = 'vn.aivin.desktop';
export const MAC_AGENT_LABEL = 'com.aivin.remote';

export const macAppPath = (home = os.homedir()) => path.join(home, 'Applications', 'Aivin.app');
export const macAppExecutable = (app = macAppPath()) => path.join(app, 'Contents', 'MacOS', 'Aivin');
export const macAgentPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${MAC_AGENT_LABEL}.plist`);
/** Bản sao LaunchAgent: menu "Mở khi đăng nhập" chép lại vào ~/Library/LaunchAgents khi bật lại. */
const AGENT_COPY_FILE = path.join(DESKTOP_DIR, `${MAC_AGENT_LABEL}.plist`);

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** .icns chứa nguyên ảnh PNG 64×64 (icp6 = 64 px, ic11 = 32 px @2x) — macOS 10.8+. */
export function pngToIcns(png) {
  const entries = ['icp6', 'ic11'].map((type) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** LSUIElement: không có biểu tượng trên Dock, chỉ ở thanh menu. */
export function macInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>AIVIN Bot CLI</string>
    <key>CFBundleDisplayName</key>
    <string>AIVIN Bot CLI</string>
    <key>CFBundleIdentifier</key>
    <string>${MAC_BUNDLE_ID}</string>
    <key>CFBundleExecutable</key>
    <string>Aivin</string>
    <key>CFBundleIconFile</key>
    <string>aivin</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
`;
}

export const MAC_APP_LAUNCHER = `#!/bin/sh
# Aivin menu bar app: the menu bar icon + keeps \`aivin remote start\` running (Resources/tray.js, JavaScript for Automation).
exec /usr/bin/osascript -l JavaScript "$(dirname "$0")/../Resources/tray.js" "$@"
`;

/** LaunchAgent: mở app lúc đăng nhập (chỉ phiên có màn hình), mở lại khi app sập (thoát khác 0); Thoát ở menu = mã 0 → không mở lại. */
export function macAgentPlist({ app = macAppPath(), logFile = path.join(REMOTE_CONFIG_DIR, 'remote-service.log') } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MAC_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(macAppExecutable(app))}</string>
        <string>--autostart</string>
    </array>
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>${MAC_BUNDLE_ID}</string>
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
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function macTraySource(home = REMOTE_CONFIG_DIR) {
  return MAC_TRAY_JS.replace('@@HOME@@', JSON.stringify(home));
}

/** Dựng / làm mới Aivin.app (ghi đè cả gói: mã + biểu tượng đổi theo bản CLI), báo LaunchServices để Spotlight thấy ngay. */
export function writeMacApp({ app = macAppPath(), home = REMOTE_CONFIG_DIR } = {}) {
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), macInfoPlist());
  fs.writeFileSync(path.join(contents, 'Resources', 'tray.js'), macTraySource(home));
  fs.writeFileSync(path.join(contents, 'Resources', 'aivin.icns'), pngToIcns(Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64')));
  const exe = macAppExecutable(app);
  fs.writeFileSync(exe, MAC_APP_LAUNCHER, { mode: 0o755 });
  fs.chmodSync(exe, 0o755);
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  try { execFileSync(lsregister, ['-f', app], { stdio: 'ignore', timeout: 15_000 }); } catch { /* Spotlight tự lập chỉ mục sau */ }
  return app;
}

export function macStartupState() {
  const registered = fs.existsSync(macAgentPath());
  return { registered, enabled: registered };
}

export function setMacStartup(enabled) {
  if (enabled) fs.copyFileSync(AGENT_COPY_FILE, macAgentPath());
  else fs.rmSync(macAgentPath(), { force: true });
}

/** `open` qua LaunchServices: app độc lập với cửa sổ terminal; đang chạy thì macOS gửi "mở lại" → app mở Aivin. */
export function launchMacTray({ app = macAppPath(), mode = TrayLaunch.OPEN } = {}) {
  const args = mode === TrayLaunch.OPEN ? [app] : [app, '--args', `--${mode}`];
  spawn('/usr/bin/open', args, { detached: true, stdio: 'ignore' }).unref();
}

/** `runScript` = aivin-remote-run.sh (autoStart.mjs ghi, dấu supervisor = tray) — app chạy nó, kèm `--code` khi kết nối bằng mã. */
export function installMacDesktop({ runScript, lang = 'en', autostart = true, launch = true, launchMode = TrayLaunch.INSTALLED }) {
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  const agent = macAgentPath();
  fs.writeFileSync(LAUNCH_CONFIG_FILE, launchConfigText({ argv: ['/bin/sh', runScript], lang, platform: 'darwin', extra: { agent, agent_copy: AGENT_COPY_FILE } }));
  fs.writeFileSync(path.join(DESKTOP_DIR, 'logo.png'), Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64'));
  const app = writeMacApp();
  fs.writeFileSync(AGENT_COPY_FILE, macAgentPlist({ app }));
  if (autostart) {
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    setMacStartup(true);
  }
  if (launch) launchMacTray({ app, mode: launchMode });
  return { exe: app, shortcut: app, built: true, autostart: macStartupState().enabled };
}

export function isMacDesktopInstalled() {
  return fs.existsSync(macAppExecutable()) && fs.existsSync(LAUNCH_CONFIG_FILE);
}

/** Gỡ: bảo app thoát (dừng daemon nó giữ), xoá LaunchAgent, Aivin.app, desktop\. */
export function uninstallMacDesktop({ wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const exe = macAppExecutable();
  if (fs.existsSync(exe)) {
    try { execFileSync(exe, ['--quit'], { stdio: 'ignore', timeout: 15_000 }); } catch { /* không chạy */ }
    wait(3000);
  }
  fs.rmSync(macAgentPath(), { force: true });
  fs.rmSync(macAppPath(), { recursive: true, force: true });
  fs.rmSync(DESKTOP_DIR, { recursive: true, force: true });
  return { removed: !fs.existsSync(macAppPath()) };
}
