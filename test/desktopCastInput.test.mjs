import test from 'node:test';
import assert from 'node:assert/strict';
import { CastInputRejection, createCastInputGate, sanitizeCastInput } from '../bin/lib/remote/desktop/castInput.mjs';
import { createDesktopWebRtc, INPUT_CHANNEL } from '../bin/lib/remote/desktop/desktopWebRtc.mjs';

test('sanitizeCastInput: trường lạ (op) không lọt, action lạ bị bỏ', () => {
  assert.deepEqual(sanitizeCastInput({ action: 'click', x: 1.6, y: 2, op: 'stop', button: 2 }), { action: 'click', x: 2, y: 2, button: 2 });
  assert.equal(sanitizeCastInput({ action: 'exec' }), null);
  assert.equal(sanitizeCastInput({ action: 'type', text: '' }), null);
  assert.equal(sanitizeCastInput({ action: 'type', text: 'abcdef' }, 3).text, 'abc');
  assert.equal(sanitizeCastInput({ action: 'paste', text: 'abcdef' }, 3).text, 'abcdef', 'paste dùng trần riêng (64 KB), không bị cắt bởi maxTypeChars');
  assert.equal(sanitizeCastInput({ action: 'clipboard', text: 'xyz' }).text, 'xyz');
  assert.equal(sanitizeCastInput({ action: 'paste', text: '' }), null);
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

test('tạm cầm lái: AI chờ tới khi người ngừng thao tác đủ lâu', async () => {
  let t = 0;
  const moves = new Map([[10_000, true], [20_000, true]]);
  let gate;
  gate = createCastInputGate({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      for (const at of moves.keys()) if (t >= at) { moves.delete(at); gate.accept({ action: 'move', x: 1, y: 1 }); }
    },
  });
  gate.setHumanTakeover({ idleMs: 30_000, maxWaitMs: 120_000 });
  assert.equal(gate.takeoverWaitMs(), 120_000);
  assert.equal(await gate.waitHumanIdle({ idleMs: 1, maxWaitMs: 1 }), true);
  assert.ok(t >= 50_000 && t < 51_000, `chờ 30 s sau thao tác cuối (20 s): ${t}`);
  assert.equal(gate.takeoverWaitMs(), 0, 'hết hạn thì quyền tự về AI');
});

test('tạm cầm lái: người vẫn thao tác tới hết hạn chờ → báo chưa bấm được', async () => {
  let t = 0;
  let gate;
  gate = createCastInputGate({ now: () => t, sleep: async (ms) => { t += ms; gate.accept({ action: 'move', x: 1, y: 1 }); } });
  gate.setHumanTakeover({ idleMs: 30_000, maxWaitMs: 5_000 });
  assert.equal(await gate.waitHumanIdle(), false);
  assert.ok(t >= 5_000 && t < 5_500, `không chờ quá hạn: ${t}`);
});

test('tạm cầm lái: trả quyền hoặc huỷ bước thì thôi chờ ngay', async () => {
  let t = 0;
  const controller = new AbortController();
  let gate;
  gate = createCastInputGate({ now: () => t, sleep: async (ms) => { t += ms; if (t >= 1_000) controller.abort(); } });
  gate.setHumanTakeover({ idleMs: 30_000, maxWaitMs: 120_000 });
  assert.equal(await gate.waitHumanIdle({ signal: controller.signal }), false);
  assert.ok(t < 1_500, 'huỷ thì dừng chờ');

  t = 0;
  gate = createCastInputGate({ now: () => t, sleep: async (ms) => { t += ms; if (t >= 1_000) gate.setHumanTakeover(null); } });
  gate.setHumanTakeover({ idleMs: 30_000, maxWaitMs: 120_000 });
  assert.equal(await gate.waitHumanIdle(), true);
  assert.ok(t < 1_500, 'trả quyền thì AI làm tiếp ngay');
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

test('createRawFrameReader: phân tách khung âm thanh PCM 16-bit (width < 0) xen kẽ khung video I420', async () => {
  const { createRawFrameReader } = await import('../bin/lib/remote/desktop/desktopCast.mjs');
  const videos = [];
  const audios = [];
  let corrupt = 0;
  const read = createRawFrameReader((f) => videos.push(f), () => corrupt++, (a) => audios.push(a));
  const videoHead = Buffer.alloc(12);
  videoHead.writeInt32LE(2, 0); videoHead.writeInt32LE(2, 4); videoHead.writeInt32LE(6, 8);
  const videoBuf = Buffer.concat([videoHead, Buffer.alloc(6, 9)]);

  const pcmSamples = new Int16Array(960);
  pcmSamples[0] = 1234;
  pcmSamples[959] = -4321;
  const pcmBytes = Buffer.from(pcmSamples.buffer);
  const audioHead = Buffer.alloc(12);
  audioHead.writeInt32LE(-2, 0); audioHead.writeInt32LE(48000, 4); audioHead.writeInt32LE(pcmBytes.length, 8);
  const audioBuf = Buffer.concat([audioHead, pcmBytes]);

  const combined = Buffer.concat([videoBuf, audioBuf]);
  read(combined.subarray(0, 15));
  read(combined.subarray(15, 300));
  read(combined.subarray(300));

  assert.equal(corrupt, 0);
  assert.equal(videos.length, 1);
  assert.equal(audios.length, 1);
  assert.equal(audios[0].sampleRate, 48000);
  assert.equal(audios[0].channelCount, 2);
  assert.equal(audios[0].bitsPerSample, 16);
  assert.equal(audios[0].numberOfFrames, 480);
  assert.equal(audios[0].samples[0], 1234);
  assert.equal(audios[0].samples[959], -4321);
});

test('WebRTC âm thanh: gắn RTCAudioSource track, đẩy khúc 10 ms và tắt/bật tiếng qua kênh điều khiển', async () => {
  const { pcs, runtime } = fakeRtcRuntime();
  const audioChunks = [];
  const addedTracks = [];
  const VideoSource = class { createTrack() { return { kind: 'video', stop() {} }; } onFrame() {} };
  const AudioSource = class {
    createTrack() { return { kind: 'audio', enabled: true, stop() { this.stopped = true; } }; }
    onData(d) { audioChunks.push(d); }
  };
  const MediaStream = class { constructor(tracks) { this.tracks = tracks; } };
  let modeChanges = 0;
  runtime.RTCPeerConnection.prototype.addTrack = function (track, stream) { addedTracks.push({ track, stream }); };
  const origin = runtime.RTCPeerConnection.prototype.createDataChannel;
  runtime.RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
    const channel = origin.call(this, label, opts);
    if (label === INPUT_CHANNEL) this.input = channel;
    return channel;
  };
  const device = createDesktopWebRtc({
    loadRuntime: async () => ({ ...runtime, MediaStream, nonstandard: { RTCVideoSource: VideoSource, RTCAudioSource: AudioSource } }),
    onCursorMode: () => { modeChanges++; },
  });
  await device.start({ sessionId: 's', viewerId: 'v' });
  assert.equal(addedTracks.length, 2);
  assert.equal(addedTracks[0].stream, addedTracks[1].stream, 'video và audio chung một MediaStream');
  assert.equal(device.hasAudio(), true);
  assert.equal(device.needsAudio(), false, 'chưa mở kết nối thì chưa cần thu âm');
  pcs[0].open();
  assert.equal(device.needsAudio(), true);
  const samples20ms = new Int16Array(480 * 2 * 2);
  assert.equal(device.pushAudio({ samples: samples20ms, sampleRate: 48000, channelCount: 2, bitsPerSample: 16 }), true);
  assert.equal(audioChunks.length, 2, 'khúc 20 ms tự cắt thành 2 khúc 10 ms (480 khung) đúng chuẩn RTCAudioSource');
  assert.equal(audioChunks[0].numberOfFrames, 480);

  pcs[0].input.onmessage({ data: JSON.stringify({ control: 'audio', enabled: false }) });
  assert.equal(device.needsAudio(), false);
  assert.equal(addedTracks[1].track.enabled, false);
  assert.equal(modeChanges, 1);
  assert.equal(device.pushAudio({ samples: samples20ms, sampleRate: 48000, channelCount: 2, bitsPerSample: 16 }), false);

  device.setAudio(true);
  assert.equal(device.needsAudio(), true);
  assert.equal(addedTracks[1].track.enabled, true);
  device.closeAll();
  assert.equal(addedTracks[1].track.stopped, true);
});

test('WebRTC Clipboard + Secure Desktop: đẩy hai chiều qua kênh điều khiển, kèm mã phiên của peer', async () => {
  const { pcs, runtime } = fakeRtcRuntime();
  const sentInput = [];
  const receivedCmds = [];
  const origin = runtime.RTCPeerConnection.prototype.createDataChannel;
  runtime.RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
    const channel = origin.call(this, label, opts);
    if (label === INPUT_CHANNEL) { this.input = channel; channel.send = (m) => sentInput.push(JSON.parse(m)); }
    return channel;
  };
  const device = createDesktopWebRtc({
    loadRuntime: async () => runtime,
    onInput: (cmd, viewerId) => receivedCmds.push({ cmd, viewerId }),
  });
  await device.start({ sessionId: 'cast-9', viewerId: 'v1' });
  pcs[0].open();
  pcs[0].input.readyState = 'open';

  device.pushClipboard({ text: 'copied from remote' });
  device.pushSecureDesktop({ active: true });
  assert.deepEqual(sentInput, [
    { t: 'clipboard', text: 'copied from remote' },
    { t: 'secure_desktop', active: true },
  ]);

  pcs[0].input.onmessage({ data: JSON.stringify({ control: 'clipboard', text: 'pasted from viewer', paste: true }) });
  pcs[0].input.onmessage({ data: JSON.stringify({ control: 'clipboard', text: 'sync only', paste: false }) });
  assert.deepEqual(receivedCmds, [
    { cmd: { action: 'paste', text: 'pasted from viewer', session_id: 'cast-9' }, viewerId: 'v1' },
    { cmd: { action: 'clipboard', text: 'sync only', session_id: 'cast-9' }, viewerId: 'v1' },
  ]);
  device.closeAll();
});

test('WebRTC: kênh chuột không gửi lại, chỉ nhận di chuột, bỏ gói đến muộn', async () => {
  const { runtime } = fakeRtcRuntime();
  const channels = {};
  const origin = runtime.RTCPeerConnection.prototype.createDataChannel;
  runtime.RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
    const channel = origin.call(this, label, opts);
    channels[label] = { channel, opts };
    return channel;
  };
  const got = [];
  const device = createDesktopWebRtc({ loadRuntime: async () => runtime, onInput: (m) => got.push(m) });
  await device.start({ sessionId: 's', viewerId: 'v' });
  const { channel, opts } = channels['aivin-desktop-pointer'];
  assert.deepEqual(opts, { ordered: false, maxRetransmits: 0 });
  const send = (m) => channel.onmessage({ data: JSON.stringify(m) });
  send({ action: 'move', rx: 1, ry: 1, n: 2 });
  send({ action: 'move', rx: 2, ry: 2, n: 1 });
  send({ action: 'click', rx: 3, ry: 3, n: 3 });
  send({ action: 'move', rx: 4, ry: 4, n: 4 });
  assert.deepEqual(got.map((m) => m.rx), [1, 4]);
  assert.equal(got[0].n, undefined);
  assert.equal(got[0].session_id, 's');
  device.closeAll();
});

test('outgoingBitrateKbps: lấy ước lượng của cặp đường đang dùng; không có thì null', async () => {
  const { outgoingBitrateKbps } = await import('../bin/lib/remote/desktop/desktopWebRtc.mjs');
  const report = (...stats) => new Map(stats.map((s, i) => [s.id || `s${i}`, s]));
  assert.equal(outgoingBitrateKbps(report(
    { type: 'transport', id: 't', selectedCandidatePairId: 'p2' },
    { type: 'candidate-pair', id: 'p1', nominated: true, availableOutgoingBitrate: 300_000 },
    { type: 'candidate-pair', id: 'p2', availableOutgoingBitrate: 2_480_400 },
  )), 2480);
  assert.equal(outgoingBitrateKbps(report({ type: 'candidate-pair', id: 'p1', nominated: true, availableOutgoingBitrate: 650_000 })), 650);
  assert.equal(outgoingBitrateKbps(report({ type: 'candidate-pair', id: 'p1', nominated: true })), null);
  assert.equal(outgoingBitrateKbps(null), null);
});

test('castLeadInConfig: ảnh mở màn từ lead_in máy chủ gửi, sai / thiếu thì không có (12/11/2026)', async () => {
  const { castLeadInConfig } = await import('../bin/lib/remote/desktop/desktopCast.mjs');
  assert.deepEqual(castLeadInConfig({ max_width: 1920, quality: 80 }), { lead_in_width: 1920, lead_in_quality: 80 });
  assert.deepEqual(castLeadInConfig({ max_width: 1600 }), { lead_in_width: 1600, lead_in_quality: 80 });
  assert.equal(castLeadInConfig({ max_width: 320 }), null);
  assert.equal(castLeadInConfig({ max_width: 1920, quality: 200 }), null);
  assert.equal(castLeadInConfig(undefined), null);
});

test('bộ quay: thao tác (trừ di chuột / clipboard) đánh thức vòng quay, ảnh mở màn gửi một lần (12/11/2026)', async () => {
  const { DESKTOP_CAST_CSHARP } = await import('../bin/lib/remote/desktop/desktopCastSource.mjs');
  assert.match(DESKTOP_CAST_CSHARP, /if \(act != "move" && act != "clipboard"\) inputWake\.Set\(\);/);
  assert.match(DESKTOP_CAST_CSHARP, /if \(inputWake\.WaitOne\(\(int\)sleepMs\)\)/);
  assert.match(DESKTOP_CAST_CSHARP, /if \(leadInWidth > 0\) SendLeadIn\(encodeBmp, nowMs\);/);
  assert.match(DESKTOP_CAST_CSHARP, /leadInWidth = 0;\s+Bitmap leadBmp/);
});

test('preferVideoCodecs: xếp codec theo thứ tự máy chủ gửi, giữ codec khác phía sau, sai / thiếu thì giữ nguyên (12/11/2026)', async () => {
  const { preferVideoCodecs } = await import('../bin/lib/remote/desktop/desktopWebRtc.mjs');
  const sdp = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 45', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=rtpmap:98 VP9/90000', 'a=rtpmap:45 AV1/90000', ''].join('\r\n');
  assert.equal(preferVideoCodecs(sdp, ['AV1', 'VP8']).split('\r\n')[1], 'm=video 9 UDP/TLS/RTP/SAVPF 45 96 97 98');
  assert.equal(preferVideoCodecs(sdp, ['av1']).split('\r\n')[1], 'm=video 9 UDP/TLS/RTP/SAVPF 45 96 97 98');
  assert.equal(preferVideoCodecs(sdp, []), sdp);
  assert.equal(preferVideoCodecs(sdp, ['H264']), sdp);
  assert.equal(preferVideoCodecs(sdp, ['A V1; x']), sdp);
  assert.equal(preferVideoCodecs(sdp, null), sdp);
});

test('sanitizeCastInput: giữ iseq hợp lệ để đo bấm → thấy hình đổi, bỏ giá trị lạ (12/11/2026)', async () => {
  const { sanitizeCastInput } = await import('../bin/lib/remote/desktop/castInput.mjs');
  assert.equal(sanitizeCastInput({ action: 'click', x: 1, y: 2, iseq: 7 }).iseq, 7);
  assert.equal(sanitizeCastInput({ action: 'click', x: 1, y: 2, iseq: -1 }).iseq, undefined);
  assert.equal(sanitizeCastInput({ action: 'click', x: 1, y: 2, iseq: '7; rm' }).iseq, undefined);
  const { DESKTOP_CAST_CSHARP } = await import('../bin/lib/remote/desktop/desktopCastSource.mjs');
  assert.match(DESKTOP_CAST_CSHARP, /frameEchoSeq = sendChange \? Interlocked\.Exchange\(ref inputEchoSeq, 0\) : 0;/);
});
