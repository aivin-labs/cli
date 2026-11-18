import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalLinkRegistry, localOpenCommand, localOpenTarget, LocalOpenKind, openLocal } from '../bin/lib/remote/mascot/localOpen.mjs';

const fakeStat = (map) => (p) => {
  const kind = map[p];
  if (!kind) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return { isDirectory: () => kind === 'dir', isFile: () => kind === 'file' };
};
const stat = fakeStat({
  'C:\\proj\\wes-website': 'dir',
  'C:\\proj\\wes-website\\TEST_CHECK.md': 'file',
  'C:\\proj\\wes-website\\run.bat': 'file',
  'C:\\proj\\wes-website\\app.EXE': 'file',
});
const win = { stat, platform: 'win32' };

test('thư mục có thật → mở bằng Explorer; tài liệu → ứng dụng mặc định', () => {
  assert.deepEqual(localOpenTarget('C:\\proj\\wes-website', win), { path: 'C:\\proj\\wes-website', kind: LocalOpenKind.FOLDER });
  assert.equal(localOpenTarget('C:\\proj\\wes-website\\TEST_CHECK.md', win).kind, LocalOpenKind.DOCUMENT);
});

test('tệp chạy được (bat, exe — kể cả viết hoa) không bao giờ chạy: chỉ hiện trong thư mục', () => {
  assert.equal(localOpenTarget('C:\\proj\\wes-website\\run.bat', win).kind, LocalOpenKind.REVEAL);
  assert.equal(localOpenTarget('C:\\proj\\wes-website\\app.EXE', win).kind, LocalOpenKind.REVEAL);
  const cmd = localOpenCommand({ path: 'C:\\proj\\wes-website\\run.bat', kind: LocalOpenKind.REVEAL }, 'win32');
  assert.deepEqual(cmd.args, ['/select,"C:\\proj\\wes-website\\run.bat"']);
});

test('từ chối: không có trên máy / đường tương đối / đường mạng / url / rỗng', () => {
  for (const p of ['C:\\proj\\missing', 'proj\\wes-website', '\\\\server\\share\\x', '//server/share', 'https://x.test', 'file:///C:/proj', '', null]) {
    assert.equal(localOpenTarget(p, win), null, String(p));
  }
});

test('openLocal gọi lệnh đúng, không chạy khi bị từ chối', () => {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  assert.equal(openLocal('C:\\proj\\wes-website', { ...win, spawnImpl }), LocalOpenKind.FOLDER);
  assert.deepEqual(calls[0].cmd, 'explorer.exe');
  assert.deepEqual(calls[0].args, ['"C:\\proj\\wes-website"']);
  assert.equal(openLocal('\\\\evil\\share', { ...win, spawnImpl }), null);
  assert.equal(calls.length, 1);
});

test('macOS / Linux', () => {
  assert.deepEqual(localOpenCommand({ path: '/a/b.sh', kind: LocalOpenKind.REVEAL }, 'darwin'), { cmd: 'open', args: ['-R', '/a/b.sh'] });
  assert.deepEqual(localOpenCommand({ path: '/a/b.sh', kind: LocalOpenKind.REVEAL }, 'linux'), { cmd: 'xdg-open', args: ['/a'] });
});

test('bảng mã: cửa sổ chỉ cầm mã, daemon tra ra đường dẫn; giới hạn kích thước', () => {
  const reg = createLocalLinkRegistry(2);
  const a = reg.register('C:\\a'); const b = reg.register('C:\\b'); const c = reg.register('C:\\c');
  assert.equal(reg.pathOf(a), null);
  assert.equal(reg.pathOf(b), 'C:\\b');
  assert.equal(reg.pathOf(c), 'C:\\c');
  assert.equal(reg.pathOf('nope'), null);
});
