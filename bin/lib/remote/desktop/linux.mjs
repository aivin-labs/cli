import fs from 'fs';
import os from 'os';
import { posix as path } from 'path';
import { execFileSync, spawn } from 'child_process';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';
import { AIVIN_LOGO_PNG_BASE64 } from '../brand.mjs';
import { DESKTOP_DIR, LAUNCH_CONFIG_FILE, TrayLaunch, launchConfigText } from './index.mjs';
import { LINUX_LAUNCHER_SH, LINUX_TRAY_PY } from './linuxTraySource.mjs';
import { trayStrings } from './strings.mjs';

/**
 * Aivin trên màn hình Linux (29/10/2026): mục "Aivin" trong menu ứng dụng (~/.local/share/applications — GNOME Activities, KDE, XFCE…
 * tìm được), tự khởi động bằng ~/.config/autostart/aivin.desktop — "Startup Applications" (GNOME), Autostart (KDE)… liệt kê và bật / tắt
 * được; một cơ chế duy nhất (bản cũ ghi aivin-remote.desktop chạy thẳng daemon, gỡ khi cài). Khay: linuxTraySource.mjs.
 */

const dataHome = (env = process.env) => env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const configHome = (env = process.env) => env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
export const linuxAppEntryPath = (env) => path.join(dataHome(env), 'applications', 'aivin.desktop');
export const linuxAutostartPath = (env) => path.join(configHome(env), 'autostart', 'aivin.desktop');
const LEGACY_AUTOSTART = (env) => path.join(configHome(env), 'autostart', 'aivin-remote.desktop');
export const LINUX_LAUNCHER_FILE = path.join(DESKTOP_DIR, 'aivin-desktop.sh');
const TRAY_FILE = path.join(DESKTOP_DIR, 'tray.py');
const LOGO_FILE = path.join(DESKTOP_DIR, 'logo.png');
/** Bản sao mục autostart: menu khay bật lại = chép lại (GNOME Tweaks xoá hẳn tệp khi tắt). */
const AUTOSTART_COPY_FILE = path.join(DESKTOP_DIR, 'autostart.desktop');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Một đối số của dòng Exec= (Desktop Entry spec): bọc nháy kép, thoát " ` $ \ — rồi thoát \ lần nữa vì giá trị chuỗi cũng thoát \. */
export function desktopExecArg(s) {
  const quoted = `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
  return quoted.replace(/\\/g, '\\\\');
}

/** Có phiên màn hình (X11 / Wayland) — không có (máy chủ, SSH) thì tự khởi động bằng systemd như trước. */
export function hasLinuxDesktopSession(env = process.env) {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_CURRENT_DESKTOP);
}

export function linuxDesktopEntry({ launcher = LINUX_LAUNCHER_FILE, icon = LOGO_FILE, lang = 'en', autostart = false } = {}) {
  const s = trayStrings(lang, 'linux');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=AIVIN Bot CLI',
    `Comment=${s.shortcut}`,
    `Exec=${desktopExecArg(launcher)}${autostart ? ' --autostart' : ''}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Utility;Network;',
    'Keywords=aivin;ai;agent;assistant;',
    'StartupNotify=false',
    ...(autostart ? ['X-GNOME-Autostart-enabled=true', 'Hidden=false'] : []),
  ].join('\n') + '\n';
}

export function linuxLauncherScript({ runScript, home = REMOTE_CONFIG_DIR } = {}) {
  return LINUX_LAUNCHER_SH
    .replace('@@LOG@@', shq(path.join(home, 'remote-service.log')))
    .replace('@@TRAY@@', shq(path.join(home, 'desktop', 'tray.py')))
    .replace('@@CREDS@@', shq(path.join(home, 'device-credentials.json')))
    .replace('@@RUN@@', shq(runScript));
}

export function linuxTraySource(home = REMOTE_CONFIG_DIR) {
  return LINUX_TRAY_PY.replace('@@HOME@@', JSON.stringify(home));
}

/** Tắt = Hidden=true / X-GNOME-Autostart-enabled=false (như các trình quản lý khởi động ghi), hoặc đã bị xoá. */
export function isAutostartEnabled(text) {
  if (text == null) return false;
  return !/^Hidden\s*=\s*true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(text);
}

export function linuxStartupState() {
  let text = null;
  try { text = fs.readFileSync(linuxAutostartPath(), 'utf8'); } catch { /* chưa có / đã bị xoá */ }
  return { registered: text != null, enabled: isAutostartEnabled(text) };
}

export function setLinuxStartup(enabled) {
  const file = linuxAutostartPath();
  if (enabled) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(AUTOSTART_COPY_FILE, file);
    return;
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  fs.writeFileSync(file, text.replace(/^X-GNOME-Autostart-enabled=.*$/m, 'X-GNOME-Autostart-enabled=false').replace(/^Hidden=.*$/m, 'Hidden=true'));
}

/** python3 + PyGObject + AppIndicator có trên máy không (chỉ để báo ở `aivin desktop`). */
export function linuxTrayAvailable() {
  const probe = "import gi\ntry:\n gi.require_version('AyatanaAppIndicator3','0.1')\nexcept ValueError:\n gi.require_version('AppIndicator3','0.1')";
  try {
    execFileSync('python3', ['-c', probe], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function launchLinuxTray({ mode = TrayLaunch.OPEN } = {}) {
  const args = mode === TrayLaunch.OPEN ? [] : [`--${mode}`];
  spawn('/bin/sh', [LINUX_LAUNCHER_FILE, ...args], { detached: true, stdio: 'ignore' }).unref();
}

export function installLinuxDesktop({ runScript, lang = 'en', autostart = true, launch = true, launchMode = TrayLaunch.INSTALLED }) {
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  const autostartFile = linuxAutostartPath();
  fs.writeFileSync(LAUNCH_CONFIG_FILE, launchConfigText({
    argv: ['/bin/sh', runScript], lang, platform: 'linux', extra: { autostart: autostartFile, autostart_copy: AUTOSTART_COPY_FILE },
  }));
  fs.writeFileSync(LOGO_FILE, Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64'));
  fs.writeFileSync(TRAY_FILE, linuxTraySource());
  fs.writeFileSync(LINUX_LAUNCHER_FILE, linuxLauncherScript({ runScript }), { mode: 0o755 });
  fs.chmodSync(LINUX_LAUNCHER_FILE, 0o755);
  const entry = linuxAppEntryPath();
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, linuxDesktopEntry({ lang }));
  fs.writeFileSync(AUTOSTART_COPY_FILE, linuxDesktopEntry({ lang, autostart: true }));
  fs.rmSync(LEGACY_AUTOSTART(), { force: true });
  if (autostart) setLinuxStartup(true);
  try { execFileSync('update-desktop-database', [path.dirname(entry)], { stdio: 'ignore', timeout: 15_000 }); } catch { /* không bắt buộc */ }
  if (launch) launchLinuxTray({ mode: launchMode });
  return { exe: LINUX_LAUNCHER_FILE, shortcut: entry, built: true, autostart: linuxStartupState().enabled };
}

export function isLinuxDesktopInstalled() {
  return fs.existsSync(LINUX_LAUNCHER_FILE) && fs.existsSync(LAUNCH_CONFIG_FILE);
}

export function uninstallLinuxDesktop({ wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  if (fs.existsSync(LINUX_LAUNCHER_FILE)) {
    try { execFileSync('/bin/sh', [LINUX_LAUNCHER_FILE, '--quit'], { stdio: 'ignore', timeout: 15_000 }); } catch { /* không chạy */ }
    wait(3000);
  }
  for (const file of [linuxAutostartPath(), linuxAppEntryPath()]) fs.rmSync(file, { force: true });
  fs.rmSync(DESKTOP_DIR, { recursive: true, force: true });
  return { removed: true };
}
