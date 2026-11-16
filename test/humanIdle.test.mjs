import test from 'node:test';
import assert from 'node:assert/strict';
import { humanIdleSupported, readHumanIdleMs } from '../bin/lib/remote/desktop/humanIdle.mjs';

const fakeExec = (out, error = null) => (_file, _args, _opts, cb) => cb(error, out);
const ready = async () => 'C:\\fake\\aivin-idle.exe';

test('humanIdle: chỉ Windows mới đọc được', () => {
  assert.equal(humanIdleSupported('win32'), true);
  assert.equal(humanIdleSupported('darwin'), false);
  assert.equal(humanIdleSupported('linux'), false);
});

test('humanIdle: đọc số ms từ exe', async () => {
  assert.equal(await readHumanIdleMs({ platform: 'win32', prepare: ready, execFileImpl: fakeExec('12345\r\n') }), 12345);
});

test('humanIdle: exe lỗi / in rác / chưa dựng được → null', async () => {
  assert.equal(await readHumanIdleMs({ platform: 'win32', prepare: ready, execFileImpl: fakeExec('', new Error('boom')) }), null);
  assert.equal(await readHumanIdleMs({ platform: 'win32', prepare: ready, execFileImpl: fakeExec('abc') }), null);
  assert.equal(await readHumanIdleMs({ platform: 'win32', prepare: async () => null, execFileImpl: fakeExec('1') }), null);
});

test('humanIdle: thật trên Windows trả số không âm', { skip: process.platform !== 'win32' || !process.env.AIVIN_REMOTE_HOME }, async () => {
  const ms = await readHumanIdleMs();
  assert.equal(typeof ms, 'number');
  assert.ok(ms >= 0);
});
