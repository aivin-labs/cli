import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopWebRtc, isOwnAddress, selectedRemoteAddress } from '../bin/lib/remote/desktop/desktopWebRtc.mjs';
import { WINDOW_PROBE_NONCE_RE, findWindowTitle } from '../bin/lib/remote/desktop/windowProbe.mjs';

/**
 * Không tự xem chính mình (16/11/2026): trình duyệt mở ngay trên máy được xem → hình lặp vô tận. Máy tự nhận ra và báo lên máy chủ bằng hai cách:
 * cửa sổ mang mã trang gắn vào tiêu đề tab (`device:window_probe`), và địa chỉ đầu bên kia của kết nối WebRTC là chính máy (`local_viewer`).
 */

const ifaces = {
  Ethernet: [{ address: '192.168.100.214', family: 'IPv4', internal: false }, { address: 'fe80::1c2d:3e4f:5a6b:7c8d%12', family: 'IPv6', internal: false }],
  Wifi: [{ address: '2405:4802:1be9:a890:15c4:332e:663c:7f7d', family: 'IPv6', internal: false }],
  Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
};

test('isOwnAddress: loopback, địa chỉ của card mạng (cả IPv4 ánh xạ, zone); không: máy khác cùng LAN, IP công cộng, tên .local', () => {
  for (const a of ['127.0.0.1', '127.5.5.5', '::1', '192.168.100.214', '::ffff:192.168.100.214', '2405:4802:1BE9:A890:15C4:332E:663C:7F7D', 'fe80::1c2d:3e4f:5a6b:7c8d']) {
    assert.equal(isOwnAddress(a, ifaces), true, a);
  }
  for (const a of ['192.168.100.15', '2405:4802:1be9:a890::99', '113.161.1.1', '3f1c2a.local', '', null]) {
    assert.equal(isOwnAddress(a, ifaces), false, String(a));
  }
});

/** Số liệu `getStats()` dạng libwebrtc: transport trỏ cặp đang dùng, cặp trỏ ứng viên đầu bên kia. */
const stats = (remote, { viaTransport = true } = {}) => new Map([
  ['T1', { id: 'T1', type: 'transport', ...(viaTransport ? { selectedCandidatePairId: 'CP1' } : {}) }],
  ['CP0', { id: 'CP0', type: 'candidate-pair', state: 'failed', remoteCandidateId: 'RC0' }],
  ['CP1', { id: 'CP1', type: 'candidate-pair', state: 'succeeded', nominated: true, remoteCandidateId: 'RC1' }],
  ['RC0', { id: 'RC0', type: 'remote-candidate', address: '10.0.0.9', candidateType: 'host' }],
  ['RC1', { id: 'RC1', type: 'remote-candidate', ...remote }],
]);

test('selectedRemoteAddress: theo transport, không có thì cặp nominated + succeeded; trình duyệt che IP (.local) → địa chỉ prflx thật', () => {
  assert.deepEqual(selectedRemoteAddress(stats({ address: '192.168.100.214', candidateType: 'prflx' })), { address: '192.168.100.214', type: 'prflx' });
  assert.deepEqual(selectedRemoteAddress(stats({ ip: '127.0.0.1', candidateType: 'host' }, { viaTransport: false })), { address: '127.0.0.1', type: 'host' });
  assert.equal(selectedRemoteAddress(new Map([['T1', { id: 'T1', type: 'transport' }]])), null);
  assert.equal(selectedRemoteAddress(null), null);
});

function fakeRuntime(report) {
  const pcs = [];
  class RTCPeerConnection {
    connectionState = 'new';
    constructor() { pcs.push(this); }
    createDataChannel(label) {
      const channel = { label, readyState: 'connecting', close() { this.readyState = 'closed'; } };
      if (label === 'aivin-desktop-frames') this.frames = channel;
      return channel;
    }
    async createOffer() { return { sdp: 'offer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async getStats() { return report(); }
    close() { this.closed = true; }
    open() { this.frames.readyState = 'open'; this.frames.onopen(); }
  }
  return { pcs, runtime: { RTCPeerConnection } };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('WebRTC: đầu bên kia là chính máy này → báo local_viewer và đóng kết nối người xem đó', async () => {
  const { pcs, runtime } = fakeRuntime(() => stats({ address: '127.0.0.1', candidateType: 'host' }));
  const statuses = [];
  const device = createDesktopWebRtc({ loadRuntime: async () => runtime, emitStatus: (s) => statuses.push(s) });
  await device.start({ sessionId: 's', viewerId: 'v' });
  pcs[0].open();
  await settle();
  assert.deepEqual(statuses.map((s) => s.state), ['connected', 'local_viewer']);
  assert.equal(statuses[1].viewer_id, 'v');
  assert.equal(statuses[1].session_id, 's');
  assert.equal(pcs[0].closed, true);
  device.closeAll();
});

test('WebRTC: người xem ở máy khác (IP công cộng / LAN khác) → không báo, giữ kết nối; chưa có cặp → hỏi lại một lần', async () => {
  let calls = 0;
  const { pcs, runtime } = fakeRuntime(() => (++calls === 1 ? new Map() : stats({ address: '113.161.1.1', candidateType: 'srflx' })));
  const statuses = [];
  const device = createDesktopWebRtc({ loadRuntime: async () => runtime, emitStatus: (s) => statuses.push(s.state) });
  await device.start({ sessionId: 's', viewerId: 'v' });
  pcs[0].open();
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(calls >= 2, true, 'hỏi lại khi cặp chưa chốt');
  assert.deepEqual(statuses, ['connected']);
  assert.notEqual(pcs[0].closed, true);
  device.closeAll();
});

test('windowProbe: mã sai luật → null (không đưa chuỗi tuỳ ý vào dòng lệnh); có / không cửa sổ; exe lỗi → null', async () => {
  assert.equal(WINDOW_PROBE_NONCE_RE.test('k3f9x2ab'), true);
  for (const bad of ['', 'abc', 'ABCDEFGH', 'k3f9 x2', 'k3f9x2"&calc', 'a'.repeat(17)]) assert.equal(await findWindowTitle(bad, { prepare: async () => 'probe.exe' }), null, bad);
  const exec = (out, err = null) => (file, args, opts, cb) => { exec.last = args; cb(err, out); };
  assert.equal(await findWindowTitle('k3f9x2ab', { prepare: async () => 'probe.exe', execFileImpl: exec('1') }), true);
  assert.deepEqual(exec.last, ['k3f9x2ab']);
  assert.equal(await findWindowTitle('k3f9x2ab', { prepare: async () => 'probe.exe', execFileImpl: exec('0') }), false);
  assert.equal(await findWindowTitle('k3f9x2ab', { prepare: async () => 'probe.exe', execFileImpl: exec('', new Error('boom')) }), null);
  assert.equal(await findWindowTitle('k3f9x2ab', { prepare: async () => null }), null);
});
