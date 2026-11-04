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

test('withVideoBitrate: thêm vào fmtp của VP8, không đụng codec khác, thiếu số thì giữ nguyên', async () => {
  const { withVideoBitrate } = await import('../bin/lib/remote/desktop/desktopWebRtc.mjs');
  const bitrate = { start_kbps: 2500, min_kbps: 500, max_kbps: 8000 };
  const want = 'x-google-start-bitrate=2500;x-google-min-bitrate=500;x-google-max-bitrate=8000';
  const noFmtp = ['m=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96', ''].join('\r\n');
  assert.deepEqual(withVideoBitrate(noFmtp, bitrate).split('\r\n'), ['m=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=rtpmap:96 VP8/90000', `a=fmtp:96 ${want}`, 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96', '']);
  const hasFmtp = 'a=rtpmap:96 VP8/90000\na=fmtp:96 foo=1\n';
  assert.equal(withVideoBitrate(hasFmtp, bitrate), `a=rtpmap:96 VP8/90000\na=fmtp:96 foo=1;${want}\n`);
  assert.equal(withVideoBitrate(noFmtp, null), noFmtp);
  assert.equal(withVideoBitrate(noFmtp, {}), noFmtp);
});

function fakeRtcRuntime() {
  const pcs = [];
  class RTCPeerConnection {
    connectionState = 'new';
    localDescription = { sdp: 'offer' };
    constructor() { pcs.push(this); }
    createDataChannel(label) {
      const channel = { label, readyState: 'connecting', close() { this.readyState = 'closed'; } };
      if (label === 'aivin-desktop-frames') this.frames = channel;
      return channel;
    }
    async createOffer() { return { sdp: 'offer' }; }
    async setLocalDescription() {}
    async setRemoteDescription(desc) { this.remote = desc; }
    close() { this.closed = true; }
    open() { this.frames.readyState = 'open'; this.frames.onopen(); }
    become(state) { this.connectionState = state; this.onconnectionstatechange(); }
  }
  return { pcs, runtime: { RTCPeerConnection } };
}

test('WebRTC: mạng chập chờn hồi lại thì về WebRTC, không kẹt JPEG', async () => {
  const { pcs, runtime } = fakeRtcRuntime();
  const statuses = [];
  const ready = [];
  const device = createDesktopWebRtc({ loadRuntime: async () => runtime, emitStatus: (s) => statuses.push([s.state, s.transport]), onPeerReady: (v) => ready.push(v) });
  await device.start({ sessionId: 's', viewerId: 'v' });
  pcs[0].open();
  assert.equal(device.needsFallback(), false);
  pcs[0].become('disconnected');
  assert.equal(device.needsFallback(), true);
  pcs[0].become('connected');
  assert.equal(device.needsFallback(), false);
  assert.deepEqual(statuses, [['connected', 'webrtc'], ['disconnected', 'jpeg'], ['connected', 'webrtc']]);
  assert.deepEqual(ready, ['v', 'v']);
  pcs[0].frames.readyState = 'closed';
  pcs[0].frames.onclose();
  assert.deepEqual(statuses.at(-1), ['disconnected', 'jpeg'], 'kênh đóng trước khi peer failed cũng phải lùi JPEG ngay');
  device.closeAll();
});

test('WebRTC: peer hỏng hẳn thì dựng peer mới cùng người xem, giữ băng thông; đóng phiên thì thôi thử', { timeout: 5000 }, async () => {
  const { pcs, runtime } = fakeRtcRuntime();
  const offers = [];
  const device = createDesktopWebRtc({ loadRuntime: async () => runtime, emitSignal: (m) => { if (m.type === 'offer') offers.push(m); } });
  const videoBitrate = { max_kbps: 8000 };
  await device.start({ sessionId: 's', viewerId: 'v', videoBitrate });
  pcs[0].open();
  pcs[0].become('failed');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(pcs.length, 2);
  assert.equal(pcs[0].closed, true);
  assert.equal(offers.length, 2);
  await device.signal({ session_id: 's', viewer_id: 'v', type: 'answer', sdp: 'a=rtpmap:96 VP8/90000\n' });
  assert.match(pcs[1].remote.sdp, /x-google-max-bitrate=8000/);
  pcs[1].become('failed');
  device.close('v');
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal(pcs.length, 2, 'đã đóng thì không dựng lại');
});

test('con trỏ: chỉ gửi cho người xem đã báo tự vẽ, người nối sau nhận đủ hình, báo tắt thì quay về trong khung', async () => {
  const { pcs, runtime } = fakeRtcRuntime();
  const sentInput = [];
  const sentFrames = [];
  const VideoSource = class { createTrack() { return { stop() {} }; } onFrame() {} };
  let modes = 0;
  const device = createDesktopWebRtc({ loadRuntime: async () => ({ ...runtime, nonstandard: { RTCVideoSource: VideoSource } }), onCursorMode: () => { modes++; } });
  runtime.RTCPeerConnection.prototype.addTrack = () => {};
  const origin = runtime.RTCPeerConnection.prototype.createDataChannel;
  runtime.RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
    const channel = origin.call(this, label, opts);
    if (label === INPUT_CHANNEL) { this.input = channel; channel.send = (m) => sentInput.push(JSON.parse(m)); }
    else channel.send = (m) => sentFrames.push(m);
    return channel;
  };
  await device.start({ sessionId: 's', viewerId: 'v' });
  const pc = pcs[0];
  pc.open();
  pc.input.readyState = 'open';
  device.pushCursorShape({ id: 1, png: 'x', hotX: 1, hotY: 2 });
  device.pushCursor({ x: 5, y: 6, visible: true, shape: 1 });
  assert.equal(sentInput.length, 0, 'chưa báo tự vẽ thì không gửi hình');
  assert.equal(sentFrames.length, 0, 'FE cũ không hiểu gói con trỏ');
  assert.equal(device.localCursor(), false);
  pc.input.onmessage({ data: JSON.stringify({ control: 'cursor', local: true }) });
  assert.equal(modes, 1);
  assert.equal(device.localCursor(), true);
  assert.deepEqual(sentInput, [{ t: 'cursor_shape', id: 1, png: 'x', hotX: 1, hotY: 2 }], 'nhận hình đã có từ trước');
  device.pushCursor({ x: 5, y: 6, visible: true, shape: 1 });
  assert.deepEqual(JSON.parse(sentFrames[0].toString()), { t: 'cursor', x: 5, y: 6, visible: true, shape: 1 });
  pc.input.onmessage({ data: JSON.stringify({ control: 'cursor', local: false }) });
  assert.equal(device.localCursor(), false);
  device.closeAll();
});

test('sanitizeCastInput: giữ toạ độ theo tỷ lệ trong khoảng, bỏ giá trị âm / quá lớn', () => {
  assert.deepEqual(sanitizeCastInput({ action: 'move', x: 1, y: 2, rx: 32768, ry: 65535 }), { action: 'move', x: 1, y: 2, rx: 32768, ry: 65535 });
  assert.deepEqual(sanitizeCastInput({ action: 'move', x: 1, y: 2, rx: -1, ry: 5 }), { action: 'move', x: 1, y: 2 });
  assert.deepEqual(sanitizeCastInput({ action: 'move', x: 1, y: 2, rx: 70000, ry: 5 }), { action: 'move', x: 1, y: 2 });
});
