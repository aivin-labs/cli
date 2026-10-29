import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';
import { AIVIN_LOGO_PNG_BASE64 } from '../brand.mjs';
import { TRAY_CS } from './traySource.mjs';
import { trayStrings } from './strings.mjs';

/**
 * Aivin trên màn hình Windows (29/10/2026): `Aivin.exe` (khay hệ thống + trình giữ chạy daemon, traySource.mjs) biên dịch trên máy, lối tắt
 * Start menu (tìm "Aivin" là thấy), mục khởi động cùng Windows ở khoá HKCU Run — Task Manager → Startup apps liệt kê và bật / tắt được
 * (Task Manager ghi vào StartupApproved\Run, Aivin.exe và `aivin remote enable|disable` đọc / ghi cùng chỗ đó). Tác vụ Task Scheduler cũ
 * không hiện trong Task Manager, nên Windows chuyển sang cách này; không biên dịch được (máy chặn csc) thì autoStart.mjs lùi về tác vụ.
 */

export const DESKTOP_DIR = path.join(REMOTE_CONFIG_DIR, 'desktop');
export const LAUNCH_CONFIG_FILE = path.join(DESKTOP_DIR, 'launch.cfg');
const LOGO_FILE = path.join(DESKTOP_DIR, 'logo.png');
const SOURCE_HASH_FILE = path.join(DESKTOP_DIR, 'launcher.sha');
const LAUNCHER_VERSION = '1.0.0.0';

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
export const STARTUP_VALUE = 'Aivin';

/** %LOCALAPPDATA%\Aivin\Aivin.exe — không đặt trong bin\ (cạnh aivin.exe): Windows không phân biệt hoa thường, hai tệp sẽ trùng tên. */
export function launcherExePath(env = process.env) {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Aivin', 'Aivin.exe');
}

/** Tên hiện ở Start menu / Task Manager → Startup apps (mô tả của Aivin.exe) / khay: "AIVIN Bot CLI" (30/10/2026; trước là "Aivin"). */
export const DISPLAY_NAME = 'AIVIN Bot CLI';
const startMenuDir = (env) => path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');

export function startMenuShortcutPath(env = process.env) {
  return path.join(startMenuDir(env), `${DISPLAY_NAME}.lnk`);
}

/** Lối tắt tên cũ ("Aivin.lnk") — dọn khi cài / gỡ để Start menu không có hai mục. */
export function legacyStartMenuShortcutPath(env = process.env) {
  return path.join(startMenuDir(env), 'Aivin.lnk');
}

/** Mã C# của Aivin.exe cho thư mục cấu hình này (gắn cứng: lối tắt / khoá Run không mang biến môi trường AIVIN_REMOTE_HOME theo). */
export function launcherSource(home = REMOTE_CONFIG_DIR) {
  const literal = `@"${String(home).replace(/"/g, '""')}"`;
  return TRAY_CS.replace('@@HOME@@', literal).replaceAll('@@VERSION@@', LAUNCHER_VERSION);
}

/** Tệp .ico chứa nguyên ảnh PNG (Windows Vista+, csc /win32icon nhận được). */
export function pngToIco(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = width >= 256 ? 0 : width;
  header[7] = height >= 256 ? 0 : height;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

/**
 * launch.cfg: `exe=` tệp chạy, mỗi `arg=` một đối số, `pending=` / `rollback=` để tự lùi bản (Windows; macOS / Linux tự lùi trong
 * aivin-remote-run.sh), `extra` = khoá riêng của từng hệ điều hành (chỗ đặt mục tự khởi động…), `s.<khoá>=` chữ trên menu.
 */
export function launchConfigText({ argv, rollback = null, lang = 'en', extra = {}, platform = 'win32' }) {
  const clean = (v) => String(v).replace(/[\r\n]+/g, ' ');
  const lines = [`exe=${clean(argv[0])}`, ...argv.slice(1).map((a) => `arg=${clean(a)}`)];
  if (rollback) lines.push(`pending=${clean(rollback.pendingFile)}`, `rollback=${clean(rollback.rollbackFile)}`);
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}=${clean(value)}`);
  for (const [key, value] of Object.entries(trayStrings(lang, platform))) lines.push(`s.${key}=${clean(value)}`);
  return lines.join('\r\n') + '\r\n';
}

/** Đối số daemon đã lưu (sau `remote start`) — cài lại giữ `--dir` / `--proxy` của lần `aivin remote enable` trước. */
export function savedDaemonArgs(text) {
  const args = String(text || '').split(/\r?\n/).filter((l) => l.startsWith('arg=')).map((l) => l.slice(4));
  const at = args.indexOf('start');
  return at > 0 && args[at - 1] === 'remote' ? args.slice(at + 1) : null;
}

export function readSavedDaemonArgs(file = LAUNCH_CONFIG_FILE) {
  try { return savedDaemonArgs(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// --- Registry: khoá Run + StartupApproved (Task Manager) ---------------------------------------------------------------------------

/** StartupApproved: byte đầu chẵn (02) = bật, lẻ (03) = Task Manager / người dùng đã tắt, kèm thời điểm tắt (FILETIME). */
export function startupApprovedHex(enabled, now = Date.now()) {
  const data = Buffer.alloc(12);
  data[0] = enabled ? 2 : 3;
  if (!enabled) data.writeBigUInt64LE((BigInt(now) + 11_644_473_600_000n) * 10_000n, 4);
  return data.toString('hex');
}

export function isStartupApproved(hex) {
  const first = parseInt(String(hex || '').slice(0, 2), 16);
  return Number.isNaN(first) || (first & 1) === 0;
}

const reg = (args) => execFileSync('reg', args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/** Dữ liệu một giá trị từ `reg query` (null nếu không có). */
export function parseRegQuery(out, name) {
  const line = String(out).split(/\r?\n/).find((l) => l.trim().startsWith(`${name} `) || l.trim().startsWith(`${name}\t`));
  const m = line?.trim().match(/^\S+\s+(REG_\w+)\s*(.*)$/);
  return m ? { type: m[1], data: m[2].trim() } : null;
}

function regValue(key, name) {
  try { return parseRegQuery(reg(['query', key, '/v', name]), name); } catch { return null; }
}

/** registered = có mục ở khoá Run; enabled = có và không bị tắt ở Task Manager. */
export function startupState() {
  const run = regValue(RUN_KEY, STARTUP_VALUE);
  if (!run) return { registered: false, enabled: false };
  return { registered: true, enabled: isStartupApproved(regValue(STARTUP_APPROVED_KEY, STARTUP_VALUE)?.data) };
}

export function setStartupApproved(enabled) {
  reg(['add', STARTUP_APPROVED_KEY, '/v', STARTUP_VALUE, '/t', 'REG_BINARY', '/d', startupApprovedHex(enabled), '/f']);
}

export function registerStartup(exe = launcherExePath()) {
  reg(['add', RUN_KEY, '/v', STARTUP_VALUE, '/t', 'REG_SZ', '/d', `"${exe}" --autostart`, '/f']);
  setStartupApproved(true);
}

export function unregisterStartup() {
  for (const key of [RUN_KEY, STARTUP_APPROVED_KEY]) {
    try { reg(['delete', key, '/v', STARTUP_VALUE, '/f']); } catch { /* chưa có */ }
  }
}

// --- Biên dịch Aivin.exe + lối tắt Start menu ------------------------------------------------------------------------------------

const SETUP_PS1 = `param([string]$Src, [string]$Ico, [string]$Out, [string]$Lnk, [string]$Target, [string]$Desc)
$ErrorActionPreference = 'Stop'
if ($Src) {
  $p = New-Object System.CodeDom.Compiler.CompilerParameters
  $p.GenerateExecutable = $true
  $p.OutputAssembly = $Out
  $p.CompilerOptions = '/target:winexe /optimize+ /win32icon:"' + $Ico + '"'
  [void]$p.ReferencedAssemblies.AddRange([string[]]@('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll'))
  $r = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($p, [IO.File]::ReadAllText($Src, [Text.Encoding]::UTF8))
  if ($r.Errors.HasErrors) { $r.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }
}
if ($Lnk) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Lnk) | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($Lnk)
  $s.TargetPath = $Target
  $s.IconLocation = "$Target,0"
  $s.WorkingDirectory = Split-Path $Target
  $s.Description = $Desc
  $s.Save()
}
`;

function runSetup(params, dir) {
  const script = path.join(dir, 'setup.ps1');
  fs.writeFileSync(script, SETUP_PS1);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
  for (const [k, v] of Object.entries(params)) if (v) args.push(`-${k}`, v);
  try {
    execFileSync('powershell.exe', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(String(e?.stderr || e?.message || e).trim().split(/\r?\n/).slice(-3).join(' '), { cause: e });
  }
}

/** Dọn bản Aivin.exe cũ đã đổi tên (lúc đó còn đang chạy). */
function cleanupOldLaunchers(exe) {
  const dir = path.dirname(exe);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (/^Aivin\.exe\.old-\d+$/i.test(name)) try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* vẫn đang chạy */ }
  }
}

/**
 * Biên dịch Aivin.exe khi chưa có / mã đổi. Bản cũ đang chạy (khoá tệp) thì đổi tên sang `.old-*` (Windows cho đổi tên tệp đang chạy) —
 * khay đang mở vẫn chạy bản cũ tới lần mở sau.
 */
export function ensureLauncher({ exe = launcherExePath(), home = REMOTE_CONFIG_DIR, dir = DESKTOP_DIR, force = false } = {}) {
  const source = launcherSource(home);
  const png = Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64');
  const hash = createHash('sha256').update(source).update(png).digest('hex');
  fs.mkdirSync(dir, { recursive: true });
  const hashFile = path.join(dir, path.basename(SOURCE_HASH_FILE));
  let current = null;
  try { current = fs.readFileSync(hashFile, 'utf8').trim(); } catch { /* chưa biên dịch */ }
  if (!force && current === hash && fs.existsSync(exe)) return { exe, built: false };

  fs.mkdirSync(path.dirname(exe), { recursive: true });
  cleanupOldLaunchers(exe);
  const src = path.join(dir, 'tray.cs');
  const ico = path.join(dir, 'aivin.ico');
  fs.writeFileSync(src, source);
  fs.writeFileSync(ico, pngToIco(png));
  const out = `${exe}.new`;
  fs.rmSync(out, { force: true });
  runSetup({ Src: src, Ico: ico, Out: out }, dir);
  if (fs.existsSync(exe)) {
    try { fs.rmSync(exe, { force: true }); } catch { fs.renameSync(exe, `${exe}.old-${Date.now()}`); }
  }
  fs.renameSync(out, exe);
  fs.writeFileSync(hashFile, hash);
  return { exe, built: true };
}

export function ensureStartMenuShortcut({ exe = launcherExePath(), lnk = startMenuShortcutPath(), lang = 'en', dir = DESKTOP_DIR } = {}) {
  runSetup({ Lnk: lnk, Target: exe, Desc: trayStrings(lang).shortcut }, dir);
  return lnk;
}

export function isDesktopInstalled() {
  return fs.existsSync(launcherExePath()) && fs.existsSync(LAUNCH_CONFIG_FILE);
}

/**
 * Cách mở khay: OPEN = như bấm Start menu (mở Aivin; khay đang chạy thì nó mở); AUTOSTART = im lặng (khởi động cùng Windows);
 * INSTALLED = vừa cài: chỉ hiện bong bóng gợi ý, không bật hộp nhập mã.
 */
export const TrayLaunch = Object.freeze({ OPEN: 'open', AUTOSTART: 'autostart', INSTALLED: 'installed' });

export function launchTray({ exe = launcherExePath(), mode = TrayLaunch.OPEN } = {}) {
  const args = mode === TrayLaunch.OPEN ? [] : [`--${mode}`];
  spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Cài trọn: launch.cfg (lệnh daemon + chữ menu), logo, Aivin.exe, lối tắt Start menu; `autostart` → mục khởi động cùng Windows (bật);
 * `launch` → mở khay ngay theo `launchMode` (TrayLaunch).
 */
export function installDesktop({ argv, rollback = null, lang = 'en', autostart = true, launch = true, launchMode = TrayLaunch.INSTALLED }) {
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  fs.writeFileSync(LAUNCH_CONFIG_FILE, launchConfigText({ argv, rollback, lang }));
  fs.writeFileSync(LOGO_FILE, Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64'));
  const { exe, built } = ensureLauncher();
  const lnk = startMenuShortcutPath();
  fs.rmSync(legacyStartMenuShortcutPath(), { force: true });
  if (built || !fs.existsSync(lnk)) ensureStartMenuShortcut({ exe, lnk, lang });
  if (autostart) registerStartup(exe);
  if (launch) launchTray({ exe, mode: launchMode });
  return { exe, shortcut: lnk, built, autostart: startupState().enabled };
}

/** Gỡ: đóng khay (dừng daemon nó đang giữ), xoá mục khởi động, lối tắt, Aivin.exe, desktop\. */
export function uninstallDesktop({ wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const exe = launcherExePath();
  if (fs.existsSync(exe)) {
    try { execFileSync(exe, ['--quit'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }); } catch { /* không chạy */ }
  }
  unregisterStartup();
  fs.rmSync(startMenuShortcutPath(), { force: true });
  fs.rmSync(legacyStartMenuShortcutPath(), { force: true });
  for (let i = 0; i < 20 && fs.existsSync(exe); i++) {
    try { fs.rmSync(exe, { force: true }); } catch { wait(250); }
  }
  cleanupOldLaunchers(exe);
  fs.rmSync(DESKTOP_DIR, { recursive: true, force: true });
  return { removed: !fs.existsSync(exe) };
}
