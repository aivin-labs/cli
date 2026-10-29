import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const {
  ensureLauncher, isStartupApproved, launchConfigText, launcherSource, parseRegQuery, pngToIco, savedDaemonArgs, startupApprovedHex,
} = await import('../bin/lib/remote/desktop/index.mjs');
const { TRAY_STRINGS } = await import('../bin/lib/remote/desktop/strings.mjs');
const { detectSupervisor } = await import('../bin/lib/remote/autoStart.mjs');
const { AIVIN_LOGO_PNG_BASE64 } = await import('../bin/lib/remote/brand.mjs');

test('pngToIco: một ảnh PNG 64×64 nhúng nguyên trong .ico', () => {
  const png = Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64');
  const ico = pngToIco(png);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico[6], 64);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.deepEqual(ico.subarray(22), png);
});

test('launch.cfg: lệnh daemon, tự lùi bản, chữ menu; cài lại giữ đối số sau `remote start`', () => {
  const argv = ['C:\\Aivin\\bin\\aivin.exe', 'remote', 'start', '--quiet', '--dir', 'D:\\Dự án\nx'];
  const text = launchConfigText({ argv, rollback: { pendingFile: 'C:\\p.txt', rollbackFile: 'C:\\r.txt' }, lang: 'vi' });
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'exe=C:\\Aivin\\bin\\aivin.exe');
  assert.ok(lines.includes('arg=D:\\Dự án x'), 'không để xuống dòng lọt vào tệp một-dòng-một-mục');
  assert.ok(lines.includes('pending=C:\\p.txt') && lines.includes('rollback=C:\\r.txt'));
  assert.ok(lines.includes(`s.quit=${TRAY_STRINGS.vi.quit}`));
  assert.deepEqual(savedDaemonArgs(text), ['--quiet', '--dir', 'D:\\Dự án x']);
  // Bản npm: node + cli.mjs đứng trước `remote start`.
  assert.deepEqual(savedDaemonArgs(launchConfigText({ argv: ['node.exe', 'C:\\cli.mjs', 'remote', 'start', '--quiet'] })), ['--quiet']);
  assert.equal(savedDaemonArgs(''), null);
});

test('chữ menu khay: vi và en đủ cùng bộ khoá', () => {
  assert.deepEqual(Object.keys(TRAY_STRINGS.vi).sort(), Object.keys(TRAY_STRINGS.en).sort());
});

test('StartupApproved: 02 = bật, 03 + FILETIME = tắt (như Task Manager)', () => {
  assert.equal(startupApprovedHex(true), '020000000000000000000000');
  const off = startupApprovedHex(false, Date.UTC(2026, 9, 29));
  assert.equal(off.slice(0, 8), '03000000');
  const filetime = Buffer.from(off, 'hex').readBigUInt64LE(4);
  assert.equal(filetime, (BigInt(Date.UTC(2026, 9, 29)) + 11_644_473_600_000n) * 10_000n);
  assert.equal(isStartupApproved('020000000000000000000000'), true);
  assert.equal(isStartupApproved('060000000000000000000000'), true);
  assert.equal(isStartupApproved(off), false);
  assert.equal(isStartupApproved(undefined), true, 'chưa có mục StartupApproved = Windows coi là bật');
});

test('parseRegQuery: đọc giá trị từ `reg query`', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Aivin    REG_SZ    "C:\\Users\\a\\AppData\\Local\\Aivin\\Aivin.exe" --autostart\r\n\r\n';
  assert.deepEqual(parseRegQuery(out, 'Aivin'), { type: 'REG_SZ', data: '"C:\\Users\\a\\AppData\\Local\\Aivin\\Aivin.exe" --autostart' });
  assert.equal(parseRegQuery(out, 'Other'), null);
  assert.equal(parseRegQuery('    AivinX    REG_SZ    x', 'Aivin'), null);
});

test('mã Aivin.exe: gắn thư mục cấu hình, chỉ cú pháp C# 5 (csc của .NET Framework)', () => {
  const src = launcherSource('C:\\Users\\Thắng "x"\\.aivin');
  assert.ok(src.includes('public const string Home = @"C:\\Users\\Thắng ""x""\\.aivin";'));
  assert.ok(!src.includes('@@'));
  assert.ok(!/\$"/.test(src), 'không có chuỗi nội suy C# 6');
  assert.ok(!/\?\./.test(src), 'không có ?. của C# 6');
  assert.ok(src.includes('"AIVIN_SUPERVISOR"] = "tray"'));
});

test('detectSupervisor: daemon do khay Aivin.exe chạy', () => {
  assert.equal(detectSupervisor({ env: { AIVIN_SUPERVISOR: 'tray' } }), 'tray');
});

test('biên dịch được Aivin.exe (Windows): tên + hãng hiện ở Task Manager', { skip: process.platform !== 'win32', timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-desktop-'));
  const exe = path.join(dir, 'Aivin.exe');
  const res = ensureLauncher({ exe, home: path.join(dir, 'home'), dir: path.join(dir, 'build') });
  assert.equal(res.built, true);
  const info = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$v = (Get-Item '${exe}').VersionInfo; "$($v.FileDescription)|$($v.CompanyName)"`], { encoding: 'utf8' }).trim();
  assert.equal(info, 'AIVIN Bot CLI|Aivin Labs');
  assert.equal(ensureLauncher({ exe, home: path.join(dir, 'home'), dir: path.join(dir, 'build') }).built, false, 'mã không đổi → không biên dịch lại');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- macOS / Linux ---------------------------------------------------------------------------------------------------------------

const vm = await import('vm');
const { MAC_BUNDLE_ID, macAgentPlist, macInfoPlist, macTraySource, pngToIcns } = await import('../bin/lib/remote/desktop/mac.mjs');
const { desktopExecArg, isAutostartEnabled, linuxDesktopEntry, linuxLauncherScript, linuxTraySource } = await import('../bin/lib/remote/desktop/linux.mjs');
const { trayStrings } = await import('../bin/lib/remote/desktop/strings.mjs');
const { posixRunScript } = await import('../bin/lib/remote/autoStart.mjs');

test('pngToIcns: icp6 + ic11 chứa nguyên PNG, độ dài khai báo đúng', () => {
  const png = Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64');
  const icns = pngToIcns(png);
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(icns.toString('ascii', 8, 12), 'icp6');
  assert.equal(icns.readUInt32BE(12), png.length + 8);
  assert.equal(icns.toString('ascii', 16 + png.length, 20 + png.length), 'ic11');
});

test('macOS: app thanh menu (LSUIElement), LaunchAgent gắn bundle id để Login Items hiện "Aivin"', () => {
  assert.match(macInfoPlist(), /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.ok(macInfoPlist().includes(`<string>${MAC_BUNDLE_ID}</string>`));
  const agent = macAgentPlist({ app: '/Users/a & b/Applications/Aivin.app', logFile: '/tmp/l.log' });
  assert.ok(agent.includes('<string>/Users/a &amp; b/Applications/Aivin.app/Contents/MacOS/Aivin</string>'));
  assert.match(agent, /<key>AssociatedBundleIdentifiers<\/key>\s*<array>\s*<string>vn\.aivin\.desktop<\/string>/);
  assert.match(agent, /<key>Label<\/key>\s*<string>com\.aivin\.remote<\/string>/, 'giữ nhãn cũ: cài đè LaunchAgent cũ, detectSupervisor nhận ra');
  assert.match(agent, /<key>SuccessfulExit<\/key>\s*<false\/>/, 'Thoát ở menu (mã 0) thì không mở lại');
});

test('macOS: mã thanh menu (JXA) là JavaScript hợp lệ, gắn thư mục cấu hình', () => {
  const src = macTraySource('/Users/o\'k "x"/.aivin');
  assert.ok(src.includes('var HOME = "/Users/o\'k \\"x\\"/.aivin";'));
  assert.doesNotThrow(() => new vm.Script(src));
  assert.match(src, /function run\(argv\)/, 'osascript gọi run(argv)');
});

test('Linux: Exec= bọc nháy theo Desktop Entry spec, tắt / bật nhận cả Hidden và X-GNOME-Autostart-enabled', () => {
  assert.equal(desktopExecArg('/home/a b/x.sh'), '"/home/a b/x.sh"');
  assert.equal(desktopExecArg('/home/$x"y'), '"/home/\\\\$x\\\\"y"');
  const entry = linuxDesktopEntry({ launcher: '/h/aivin-desktop.sh', icon: '/h/logo.png', lang: 'en', autostart: true });
  assert.match(entry, /^Exec="\/h\/aivin-desktop\.sh" --autostart$/m);
  assert.match(entry, /^Name=AIVIN Bot CLI$/m);
  assert.equal(isAutostartEnabled(entry), true);
  assert.equal(isAutostartEnabled(entry.replace('Hidden=false', 'Hidden=true')), false);
  assert.equal(isAutostartEnabled(entry.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false')), false);
  assert.equal(isAutostartEnabled(null), false);
  assert.doesNotMatch(linuxDesktopEntry({ launcher: '/h/a.sh' }), /Autostart-enabled/);
});

test('Linux: kịch bản mở bọc nháy đường dẫn; khay Python gắn thư mục cấu hình', () => {
  const sh = linuxLauncherScript({ runScript: "/home/o'k/.aivin/aivin-remote-run.sh", home: '/home/o\'k/.aivin' });
  assert.ok(sh.includes(`/bin/sh '/home/o'\\''k/.aivin/aivin-remote-run.sh'`));
  assert.ok(!sh.includes('@@'));
  assert.ok(linuxTraySource('/home/x/.aivin').includes('HOME = "/home/x/.aivin"'));
});

test('chữ menu theo hệ điều hành; launch.cfg mang khoá riêng; kịch bản chạy nhận thêm đối số (--code)', () => {
  assert.equal(trayStrings('vi', 'darwin').startup, 'Mở khi đăng nhập');
  assert.equal(trayStrings('en', 'linux').startup, 'Start at login');
  assert.equal(trayStrings('xx', 'win32').startup, TRAY_STRINGS.en.startup);
  const cfg = launchConfigText({ argv: ['/bin/sh', '/h/run.sh'], lang: 'en', platform: 'darwin', extra: { agent: '/h/a.plist' } });
  assert.ok(cfg.split('\r\n').includes('agent=/h/a.plist'));
  assert.ok(cfg.split('\r\n').includes('s.startup=Open at login'));
  assert.match(posixRunScript(['/x/aivin', 'remote', 'start'], { supervisor: 'tray' }), /^'\/x\/aivin' 'remote' 'start' "\$@"$/m);
});
