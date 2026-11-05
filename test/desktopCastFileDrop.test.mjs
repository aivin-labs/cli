import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCastFileDrop, FileDropReason, revealInExplorer, safeDropName } from '../bin/lib/remote/desktop/castFileDrop.mjs';
import { createCastInputGate, CastInputRejection } from '../bin/lib/remote/desktop/castInput.mjs';
import { createDesktopWebRtc, FILE_CHANNEL } from '../bin/lib/remote/desktop/desktopWebRtc.mjs';
import { DESKTOP_CAST_CSHARP } from '../bin/lib/remote/desktop/desktopCastSource.mjs';

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-drop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replies = [];
  const saved = [];
  const drop = createCastFileDrop({ dir, reply: (_v, m) => replies.push(m), onSaved: (s) => saved.push(s), statfs: async () => ({ bavail: 1e9, bsize: 4096 }), ...options });
  return { dir, replies, saved, drop };
}
const parts = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.part'));
const last = (replies) => replies.at(-1);

test('safeDropName: bỏ đường dẫn, ký tự cấm, ký tự đảo chiều, tên thiết bị', () => {
  assert.equal(safeDropName('..\\..\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(safeDropName('../../etc/passwd'), 'passwd');
  assert.equal(safeDropName('a:b*c?.txt'), 'a_b_c_.txt');
  assert.equal(safeDropName('report:Zone.Identifier'), 'report_Zone.Identifier');
  assert.equal(safeDropName('photo\u202egpj.exe'), 'photogpj.exe');
  assert.equal(safeDropName('CON.txt'), '_CON.txt');
  assert.equal(safeDropName('tên tệp. . '), 'tên tệp');
  assert.equal(safeDropName(''), 'file');
  assert.equal(safeDropName('..'), 'file');
  const long = safeDropName(`${'a'.repeat(500)}.docx`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.docx'));
});

test('nhận tệp: ghi đủ, báo tiến độ, không để lại .part, trùng tên thì thêm số chứ không ghi đè', async (t) => {
  const { dir, replies, saved, drop } = setup(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'cũ');
  const big = Buffer.alloc(300 * 1024, 7);
  drop.message('v', { t: 'begin', id: 'f1', name: 'a.txt', size: big.length });
  drop.chunk('v', big.subarray(0, 280 * 1024));
  drop.chunk('v', big.subarray(280 * 1024));
  await drop.message('v', { t: 'end', id: 'f1', reveal: true });
  assert.deepEqual(replies.map((r) => r.t), ['accepted', 'ack', 'saved']);
  assert.equal(replies[1].bytes, 280 * 1024);
  const dest = path.join(dir, 'a (1).txt');
  assert.deepEqual({ name: last(replies).name, path: last(replies).path }, { name: 'a (1).txt', path: dest });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'cũ');
  assert.ok(fs.readFileSync(dest).equals(big));
  assert.deepEqual(parts(dir), []);
  assert.equal(saved[0].reveal, true);
  assert.equal(saved[0].bytes, big.length);
});

test('tệp rỗng vẫn nhận được', async (t) => {
  const { dir, replies, drop } = setup(t);
  drop.message('v', { t: 'begin', id: 'f', name: 'empty.txt', size: 0 });
  await drop.message('v', { t: 'end', id: 'f' });
  assert.equal(last(replies).t, 'saved');
  assert.equal(fs.statSync(path.join(dir, 'empty.txt')).size, 0);
});

test('từ chối: tạm dừng / AI đang bấm / quá cỡ / ổ đầy / dữ liệu lạ, không tạo tệp nào', async (t) => {
  let blocked = FileDropReason.PAUSED;
  const { dir, replies, drop } = setup(t, { checkAllowed: () => blocked, maxBytes: 1000 });
  await drop.message('v', { t: 'begin', id: 'a', name: 'x', size: 10 });
  assert.deepEqual(last(replies), { t: 'rejected', id: 'a', reason: 'paused' });
  blocked = FileDropReason.AI_ACTIVE;
  await drop.message('v', { t: 'begin', id: 'b', name: 'x', size: 10 });
  assert.equal(last(replies).reason, 'ai_active');
  blocked = null;
  await drop.message('v', { t: 'begin', id: 'c', name: 'x', size: 1001 });
  assert.equal(last(replies).reason, 'too_large');
  await drop.message('v', { t: 'begin', id: 'd', name: 'x', size: -1 });
  assert.equal(last(replies).reason, 'invalid');
  await drop.message('v', { t: 'begin', id: 'e', name: 42, size: 1 });
  assert.equal(last(replies).reason, 'invalid');
  assert.deepEqual(fs.readdirSync(dir), []);
  const full = setup(t, { statfs: async () => ({ bavail: 1, bsize: 4096 }) });
  await full.drop.message('v', { t: 'begin', id: 'f', name: 'x', size: 10 });
  assert.equal(last(full.replies).reason, 'no_space');
});

test('gửi lố cỡ đã khai / kết thúc khi thiếu byte → hỏng và xoá tệp dở', async (t) => {
  const { dir, replies, saved, drop } = setup(t);
  drop.message('v', { t: 'begin', id: 'a', name: 'x', size: 2 });
  await drop.chunk('v', Buffer.from('abc'));
  assert.deepEqual(last(replies), { t: 'failed', id: 'a', reason: 'invalid' });
  drop.message('v', { t: 'begin', id: 'b', name: 'x', size: 5 });
  drop.chunk('v', Buffer.from('ab'));
  await drop.message('v', { t: 'end', id: 'b' });
  assert.deepEqual(last(replies), { t: 'failed', id: 'b', reason: 'invalid' });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(saved.length, 0);
});

test('huỷ, người xem rời, im quá hạn, chủ máy dừng giữa chừng đều dọn sạch tệp dở', async (t) => {
  let blocked = null;
  const { dir, replies, drop } = setup(t, { idleMs: 20, checkAllowed: () => blocked });
  drop.message('v', { t: 'begin', id: 'a', name: 'x', size: 9 });
  await drop.chunk('v', Buffer.from('a'));
  await drop.message('v', { t: 'cancel', id: 'a' });
  assert.deepEqual(parts(dir), []);
  await drop.chunk('v', Buffer.from('muộn'));
  assert.deepEqual(parts(dir), [], 'khúc của lần đã huỷ bị bỏ');

  await drop.message('v', { t: 'begin', id: 'b', name: 'x', size: 9 });
  assert.equal(parts(dir).length, 1);
  await drop.close('v');
  assert.deepEqual(parts(dir), []);

  await drop.message('v2', { t: 'begin', id: 'c', name: 'x', size: 9 });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(last(replies), { t: 'failed', id: 'c', reason: 'timeout' });
  assert.deepEqual(parts(dir), []);

  await drop.message('v2', { t: 'begin', id: 'd', name: 'x', size: 9 });
  blocked = FileDropReason.PAUSED;
  await drop.chunk('v2', Buffer.from('a'));
  assert.deepEqual(last(replies), { t: 'failed', id: 'd', reason: 'paused' });
  assert.deepEqual(parts(dir), []);
});

test('người xem nối lại gửi tệp mới: bỏ tệp dở của lần trước', async (t) => {
  const { dir, replies, drop } = setup(t);
  await drop.message('v', { t: 'begin', id: 'a', name: 'old.txt', size: 9 });
  drop.message('v', { t: 'begin', id: 'b', name: 'new.txt', size: 2 });
  drop.chunk('v', Buffer.from('ok'));
  await drop.message('v', { t: 'end', id: 'b' });
  assert.equal(last(replies).name, 'new.txt');
  assert.deepEqual(fs.readdirSync(dir), ['new.txt']);
});

test('Explorer mở chọn sẵn tệp, giữ nguyên ngoặc kép cho đường dẫn có dấu cách, không chạy tệp', () => {
  const calls = [];
  revealInExplorer('C:\\Users\\a b\\Downloads\\x y.exe', (exe, args, opts) => { calls.push({ exe, args, opts }); return { on() {}, unref() {} }; });
  assert.equal(calls[0].exe, 'explorer.exe');
  assert.deepEqual(calls[0].args, ['/select,"C:\\Users\\a b\\Downloads\\x y.exe"']);
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  assert.doesNotThrow(() => revealInExplorer('x', () => { throw new Error('không có explorer'); }));
});

test('cổng thao tác: nhả nút đang giữ vẫn qua khi AI bấm / tạm dừng, không kéo con trỏ, không tính là người thao tác', () => {
  let paused = false;
  let busy = false;
  const gate = createCastInputGate({ isPaused: () => paused, isAiBusy: () => busy, now: () => 0 });
  assert.equal(gate.accept({ action: 'mousedown', button: 2, x: 1, y: 1 }).ok, true);
  busy = true;
  assert.equal(gate.accept({ action: 'mouseup', button: 0, x: 1, y: 1 }).reason, CastInputRejection.AI_ACTIVE, 'nút không giữ thì vẫn chặn');
  const before = gate.lastHumanInputAt();
  assert.deepEqual(gate.accept({ action: 'mouseup', button: 2, x: 1, y: 1, rx: 5, ry: 5 }), { ok: true, cmd: { action: 'mouseup', button: 2 } });
  assert.equal(gate.lastHumanInputAt(), before);
  assert.equal(gate.accept({ action: 'mouseup', button: 2, x: 1, y: 1 }).reason, CastInputRejection.AI_ACTIVE, 'đã nhả thì thôi');
  busy = false;
  assert.equal(gate.accept({ action: 'mousedown', x: 1, y: 1 }).ok, true);
  paused = true;
  assert.deepEqual(gate.accept({ action: 'mouseup', x: 1, y: 1 }), { ok: true, cmd: { action: 'mouseup' } });
  assert.equal(gate.takeHeldInput(), false);
});

test('cổng thao tác: nhả nút lúc gửi dồn vẫn qua; takeHeldInput báo đang giữ đúng một lần', () => {
  const gate = createCastInputGate({ maxPerSec: 1, now: () => 0 });
  assert.equal(gate.accept({ action: 'mousedown', x: 1, y: 1 }).ok, true);
  assert.equal(gate.accept({ action: 'move', x: 2, y: 2 }).reason, CastInputRejection.RATE_LIMITED);
  assert.deepEqual(gate.accept({ action: 'mouseup', x: 3, y: 3 }).cmd, { action: 'mouseup', x: 3, y: 3 });
  const held = createCastInputGate({ now: () => 0 });
  held.accept({ action: 'mousedown', x: 1, y: 1 });
  assert.equal(held.takeHeldInput(), true);
  assert.equal(held.takeHeldInput(), false);
  assert.equal(held.accept({ action: 'release_all' }).reason, CastInputRejection.INVALID, 'người xem không tự gửi được lệnh nội bộ');
});

test('bộ điều khiển C#: nhả phím theo những gì đã giữ, không theo gói mouseup; dừng phiên thì nhả hết', () => {
  const body = (name) => DESKTOP_CAST_CSHARP.slice(DESKTOP_CAST_CSHARP.indexOf(`action == "${name}"`), DESKTOP_CAST_CSHARP.indexOf('} else if', DESKTOP_CAST_CSHARP.indexOf(`action == "${name}"`) + 1));
  assert.match(body('mouseup'), /ReleaseHeldModifiers\(\)/);
  assert.doesNotMatch(body('mouseup'), /ReleaseModifiers\(mods\)/);
  assert.match(body('mousedown'), /heldModifiers\.AddRange/);
  const loop = DESKTOP_CAST_CSHARP.slice(DESKTOP_CAST_CSHARP.indexOf('static void ReadInputLoop'), DESKTOP_CAST_CSHARP.indexOf('static void HandleConfig'));
  assert.match(loop, /finally \{[\s\S]*ReleaseHeldInput\(\)/);
});

test('WebRTC: tệp đi kênh riêng tới đúng người xem, trả lời đi đúng kênh, mang mã phiên của peer', { timeout: 20_000 }, async (t) => {
  let wrtc;
  try { wrtc = await import('@roamhq/wrtc'); } catch { return t.skip('chưa cài @roamhq/wrtc'); }
  const RTCPeerConnection = wrtc.RTCPeerConnection || wrtc.default?.RTCPeerConnection;
  const viewer = new RTCPeerConnection({ iceServers: [] });
  const files = [];
  const chunks = [];
  let device;
  let gotAll;
  const done = new Promise((r) => { gotAll = r; });
  device = createDesktopWebRtc({
    loadRuntime: async () => ({ RTCPeerConnection }),
    emitSignal: async (msg) => {
      if (msg.type === 'offer') {
        await viewer.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        await viewer.setLocalDescription(await viewer.createAnswer());
        await device.signal({ session_id: 'cast-1', viewer_id: 'v1', type: 'answer', sdp: viewer.localDescription.sdp });
      } else if (msg.type === 'ice' && msg.candidate) {
        await viewer.addIceCandidate(msg.candidate).catch(() => {});
      }
    },
    onFile: (viewerId, msg, sessionId) => { files.push({ viewerId, msg, sessionId }); device.replyFile(viewerId, { t: 'accepted', id: msg.id }); },
    onFileChunk: (viewerId, bytes) => { chunks.push({ viewerId, bytes }); },
  });
  viewer.onicecandidate = ({ candidate }) => { if (candidate) void device.signal({ session_id: 'cast-1', viewer_id: 'v1', type: 'ice', candidate }); };
  viewer.ondatachannel = ({ channel }) => {
    if (channel.label !== FILE_CHANNEL) return;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      channel.send(JSON.stringify({ t: 'begin', id: 'f', name: 'x', size: 3, session_id: 'forged' }));
      channel.send(new Uint8Array([1, 2, 3]).buffer);
    };
    channel.onmessage = ({ data }) => gotAll(JSON.parse(data));
  };
  assert.equal(await device.start({ sessionId: 'cast-1', viewerId: 'v1', iceServers: [] }), true);
  assert.deepEqual(await done, { t: 'accepted', id: 'f' });
  for (let i = 0; i < 50 && !chunks.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(files[0].sessionId, 'cast-1');
  assert.equal(chunks[0].viewerId, 'v1');
  assert.deepEqual([...chunks[0].bytes], [1, 2, 3]);
  device.closeAll();
  viewer.close();
});
