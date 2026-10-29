import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

const { createClipboard, unixClipboardCommands, buildClipboardTools } = await import('../bin/lib/remote/clipboard.mjs');

/** spawn giả: trả `stdout` cho lệnh, ghi lại stdin. */
function fakeSpawn(stdout, seen = []) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { end: (input) => { seen.push({ cmd, args, input }); setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0); }); } };
    return child;
  };
}

test('clipboard Windows: chữ / tệp / ảnh; nội dung trình quản lý mật khẩu đánh dấu riêng tư thì không trả', async () => {
  assert.deepEqual(await createClipboard({ platform: 'win32', spawnImpl: fakeSpawn('{"text":"xin chào"}') }).read(), { kind: 'text', text: 'xin chào' });
  assert.deepEqual(await createClipboard({ platform: 'win32', spawnImpl: fakeSpawn(JSON.stringify({ files: ['C:/Users/a/b.pdf'] })) }).read(), { kind: 'files', files: ['C:/Users/a/b.pdf'] });
  const priv = await createClipboard({ platform: 'win32', spawnImpl: fakeSpawn('{"private":true,"text":"S3cret"}') }).read();
  assert.equal(priv.private, true);
  assert.equal(priv.text, undefined);
  assert.equal((await createClipboard({ platform: 'win32', spawnImpl: fakeSpawn('{}') }).read()).kind, 'empty');
});

test('clipboard ghi: chữ đi qua stdin (không nhét vào dòng lệnh), quá dài thì từ chối', async () => {
  const seen = [];
  const c = createClipboard({ platform: 'win32', spawnImpl: fakeSpawn('{"ok":true}', seen) });
  assert.deepEqual(await c.write({ text: 'a"; rm -rf /' }), { ok: true, chars: 12 });
  assert.equal(seen[0].input, 'a"; rm -rf /');
  assert.ok(!seen[0].args.join(' ').includes('rm -rf'));
  await assert.rejects(c.write({ text: 'x'.repeat(200_001) }), /too long/);
});

test('clipboard macOS / Linux: chọn công cụ có sẵn; máy không màn hình → không có clipboard', () => {
  assert.equal(unixClipboardCommands({ platform: 'darwin' }).read[0], 'pbpaste');
  assert.equal(unixClipboardCommands({ platform: 'linux', env: { WAYLAND_DISPLAY: 'w', DISPLAY: ':0' }, onPath: () => true }).write[0], 'wl-copy');
  assert.equal(unixClipboardCommands({ platform: 'linux', env: { DISPLAY: ':0' }, onPath: (n) => n === 'xsel' }).read[0], 'xsel');
  assert.equal(unixClipboardCommands({ platform: 'linux', env: {}, onPath: () => true }), null);
  assert.equal(createClipboard({ platform: 'linux', unix: null }), null);
  const tools = buildClipboardTools({});
  assert.deepEqual(tools.map((t) => [t.name, !!t.read_only]), [['clipboard.read', true], ['clipboard.write', false]]);
});
