import test from 'node:test';
import assert from 'node:assert/strict';
import { CastInputRejection, createCastInputGate, sanitizeCastInput } from '../bin/lib/remote/desktop/castInput.mjs';
import { createDesktopWebRtc, INPUT_CHANNEL } from '../bin/lib/remote/desktop/desktopWebRtc.mjs';

test('sanitizeCastInput: trường lạ (op) không lọt, action lạ bị bỏ', () => {
  assert.deepEqual(sanitizeCastInput({ action: 'click', x: 1.6, y: 2, op: 'stop', button: 2 }), { action: 'click', x: 2, y: 2, button: 2 });
  assert.equal(sanitizeCastInput({ action: 'exec' }), null);
  assert.equal(sanitizeCastInput({ action: 'type', text: '' }), null);
  assert.equal(sanitizeCastInput({ action: 'type', text: 'abcdef' }, 3).text, 'abc');
});

test('cổng thao tác: tạm dừng / AI đang bấm / gửi dồn đều bị chặn', () => {
  let paused = false;
  let busy = false;
  let t = 0;
  const gate = createCastInputGate({ isPaused: () => paused, isAiBusy: () => busy, maxPerSec: 2, now: () => t });
  assert.equal(gate.accept({ action: 'move', x: 1, y: 1 }).ok, true);
  paused = true;
  assert.equal(gate.accept({ action: 'move', x: 1, y: 1 }).reason, CastInputRejection.PAUSED);
  paused = false; busy = true;
  assert.equal(gate.accept({ action: 'move', x: 1, y: 1 }).reason, CastInputRejection.AI_ACTIVE);
  busy = false;
  assert.equal(gate.accept({ action: 'move', x: 1, y: 1 }).ok, true);
  assert.equal(gate.accept({ action: 'move', x: 1, y: 1 }).reason, CastInputRejection.RATE_LIMITED);
  t = 1000;
  assert.equal(gate.accept({ action: 'nope' }).reason, CastInputRejection.INVALID);
});

test('waitHumanIdle: AI chờ người thôi thao tác, có trần', async () => {
  let t = 0;
  const gate = createCastInputGate({ now: () => t, sleep: async (ms) => { t += ms; } });
  await gate.waitHumanIdle();
  assert.equal(t, 0, 'chưa ai thao tác thì không chờ');
  gate.accept({ action: 'move', x: 1, y: 1 });
  await gate.waitHumanIdle({ idleMs: 1500, maxWaitMs: 3000 });
  assert.ok(t >= 1500 && t < 3000, `chờ đủ lúc người yên: ${t}`);
  gate.accept({ action: 'move', x: 1, y: 1 });
  t += 0;
  const start = t;
  await gate.waitHumanIdle({ idleMs: 10_000, maxWaitMs: 500 });
  assert.ok(t - start <= 750, 'không chờ quá trần');
});

test('WebRTC: thao tác đi kênh input peer-to-peer, mang mã phiên của peer', { timeout: 20_000 }, async (t) => {
  let wrtc;
  try { wrtc = await import('@roamhq/wrtc'); } catch { return t.skip('chưa cài @roamhq/wrtc'); }
  const RTCPeerConnection = wrtc.RTCPeerConnection || wrtc.default?.RTCPeerConnection;
  const viewer = new RTCPeerConnection({ iceServers: [] });
  const received = [];
  let resolveInput;
  const gotInput = new Promise((r) => { resolveInput = r; });
  let device;
  device = createDesktopWebRtc({
    // Không có nguồn video: wrtc tạo RTCVideoSource rồi để tiến trình thoát tự nhiên là segfault (xem desktopWebRtc.mjs).
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
    onInput: (cmd, viewerId) => { received.push({ cmd, viewerId }); resolveInput(); },
  });
  viewer.onicecandidate = ({ candidate }) => {
    if (candidate) void device.signal({ session_id: 'cast-1', viewer_id: 'v1', type: 'ice', candidate });
  };
  viewer.ondatachannel = ({ channel }) => {
    if (channel.label !== INPUT_CHANNEL) return;
    channel.onopen = () => channel.send(JSON.stringify({ action: 'click', x: 5, y: 6, session_id: 'forged' }));
  };
  assert.equal(await device.start({ sessionId: 'cast-1', viewerId: 'v1', iceServers: [] }), true);
  await gotInput;
  assert.deepEqual(received[0], { cmd: { action: 'click', x: 5, y: 6, session_id: 'cast-1' }, viewerId: 'v1' });
  device.closeAll();
  viewer.close();
});

test('createRawFrameReader: ghép khung I420 bị cắt nhiều khúc, bỏ đầu khung vô lý', async () => {
  const { createRawFrameReader } = await import('../bin/lib/remote/desktop/desktopCast.mjs');
  const frames = [];
  let corrupt = 0;
  const read = createRawFrameReader((f) => frames.push(f), () => corrupt++);
  const frame = (w, h) => {
    const head = Buffer.alloc(12);
    head.writeInt32LE(w, 0); head.writeInt32LE(h, 4); head.writeInt32LE(w * h * 1.5, 8);
    return Buffer.concat([head, Buffer.alloc(w * h * 1.5, 7)]);
  };
  const two = Buffer.concat([frame(4, 2), frame(2, 2)]);
  read(two.subarray(0, 5)); read(two.subarray(5, 20)); read(two.subarray(20));
  assert.deepEqual(frames.map((f) => [f.width, f.height, f.data.length]), [[4, 2, 12], [2, 2, 6]]);
  const bad = Buffer.alloc(12); bad.writeInt32LE(4, 0); bad.writeInt32LE(4, 4); bad.writeInt32LE(999, 8);
  read(bad);
  assert.equal(corrupt, 1);
});
