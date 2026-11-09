import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { CLEANUP_PS1, safeDataDir } = await import('../bin/lib/remote/desktop/uninstall.mjs');
const { refreshLaunchStrings } = await import('../bin/lib/remote/desktop/index.mjs');
const { assertHumanCommand } = await import('../bin/lib/remote/sandbox.mjs');

test('chỉ xoá cả cây khi đúng là thư mục cấu hình: từ chối gốc ổ, thư mục nhà và tổ tiên của nó', () => {
  const home = path.resolve('nha', 'toi');
  assert.equal(safeDataDir(path.join(home, '.aivin'), home), path.join(home, '.aivin'));
  assert.equal(safeDataDir(home, home), null);
  assert.equal(safeDataDir(path.dirname(home), home), null);
  assert.equal(safeDataDir(path.parse(home).root, home), null);
});

test('agent không được tự gỡ Aivin', () => {
  assert.throws(() => assertHumanCommand('aivin', 'uninstall', { AIVIN_AGENT_CALL: '1' }));
  assert.throws(() => assertHumanCommand('desktop', 'uninstall', { AIVIN_AGENT_CALL: '1' }));
  assert.doesNotThrow(() => assertHumanCommand('aivin', 'uninstall', {}));
});

test('làm mới launch.cfg: giữ lệnh daemon, thay chữ theo ngôn ngữ, thêm chữ mới', () => {
  const cfg = 'exe=C:\\a.exe\r\narg=remote\r\npending=C:\\p\r\ns.quit=Cũ\r\n';
  const next = refreshLaunchStrings(cfg, 'en');
  assert.match(next, /^exe=C:\\a\.exe\r\narg=remote\r\npending=C:\\p\r\n/);
  assert.match(next, /s\.quit=Quit Aivin/);
  assert.match(next, /s\.uninstallPrompt=.*Remove AIVIN Bot/);
  assert.doesNotMatch(next, /s\.quit=Cũ/);
  assert.equal(refreshLaunchStrings(next, 'en'), next);
});

test('mã dọn cuối chạy thật: xoá aivin.exe*, giữ tệp khác và thư mục còn tệp, xoá dữ liệu, không đụng PATH khi không yêu cầu', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-cleanup-'));
  const app = path.join(root, 'Aivin Có Dấu');
  const bin = path.join(app, 'bin');
  const keepDir = path.join(root, 'tu-chon');
  const data = path.join(root, '.aivin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(keepDir);
  fs.mkdirSync(path.join(data, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'aivin.exe'), 'x');
  fs.writeFileSync(path.join(bin, 'aivin.exe.prev'), 'x');
  fs.writeFileSync(path.join(data, 'memory', 'a.json'), 'x');
  const run = (extra) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CLEANUP_PS1], {
    windowsHide: true, stdio: 'ignore', timeout: 60_000,
    env: { ...process.env, AIVIN_U_PID: '999999', AIVIN_U_PATH: '0', AIVIN_U_BIN: '', AIVIN_U_APP: '', AIVIN_U_DATA: '', ...extra },
  });

  run({ AIVIN_U_BIN: bin, AIVIN_U_APP: app, AIVIN_U_DATA: data });
  assert.equal(fs.existsSync(app), false, 'thư mục trống thì xoá');
  assert.equal(fs.existsSync(data), false);

  fs.writeFileSync(path.join(keepDir, 'aivin.exe'), 'x');
  fs.writeFileSync(path.join(keepDir, 'cua-toi.txt'), 'x');
  run({ AIVIN_U_BIN: keepDir });
  assert.deepEqual(fs.readdirSync(keepDir), ['cua-toi.txt'], 'thư mục cài do người dùng chọn: chỉ xoá aivin.exe*');
  fs.rmSync(root, { recursive: true, force: true });
});
