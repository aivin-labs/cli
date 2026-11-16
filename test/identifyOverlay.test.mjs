import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { identifySupported, showIdentify } from '../bin/lib/remote/desktop/identifyOverlay.mjs';

const ready = async () => 'C:\\fake\\aivin-identify.exe';
const fromB64 = (s) => Buffer.from(s, 'base64').toString('utf8');

function fakeSpawn() {
  const calls = [];
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    calls.push({ file, args, opts, child });
    return child;
  };
  return { calls, impl };
}

test('identify: chỉ Windows', () => {
  assert.equal(identifySupported('win32'), true);
  assert.equal(identifySupported('darwin'), false);
});

test('identify: mở exe với tên + dòng phụ theo ngôn ngữ (base64) + thời gian đã kẹp', async () => {
  const { calls, impl } = fakeSpawn();
  assert.equal(await showIdentify({ name: '  PC   bàn trái ', durationMs: 999_999, lang: 'vi', platform: 'win32', prepare: ready, spawnImpl: impl }), true);
  const [title, subtitle, ms] = calls[0].args;
  assert.equal(fromB64(title), 'PC bàn trái');
  assert.equal(fromB64(subtitle), 'Máy tính này trên AIVIN');
  assert.equal(ms, '10000');
  calls[0].child.emit('exit', 0);
});

test('identify: lần mới thay lần đang hiện dở; thiếu tên / không dựng được exe → không mở', async () => {
  const { calls, impl } = fakeSpawn();
  await showIdentify({ name: 'A', platform: 'win32', prepare: ready, spawnImpl: impl });
  await showIdentify({ name: 'B', platform: 'win32', prepare: ready, spawnImpl: impl });
  assert.equal(calls[0].child.killed, true);
  calls[1].child.emit('exit', 0);
  assert.equal(await showIdentify({ name: '   ', platform: 'win32', prepare: ready, spawnImpl: impl }), false);
  assert.equal(await showIdentify({ name: 'C', platform: 'win32', prepare: async () => null, spawnImpl: impl }), false);
  assert.equal(calls.length, 2);
});
