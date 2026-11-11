import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CastConsentDecision as D, createCastConsent } from '../bin/lib/remote/desktop/castConsent.mjs';
import { CAST_TRUST_TTL_MS, castViewerLabel, createCastTrust, createDeviceProver, verifyDeviceProof } from '../bin/lib/remote/desktop/castTrust.mjs';
import { CastConsentMode as M } from '../bin/lib/remote/localPolicy.mjs';

const { subtle } = crypto.webcrypto;

/** Khoá tạo đúng như trình duyệt: WebCrypto, P-256, khoá riêng không xuất được. */
async function browserDevice() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('base64');
  const sign = async (sessionId, nonce) => Buffer.from(await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(`aivin-cast-device-proof\n${sessionId}\n${nonce}`),
  )).toString('base64');
  return { publicKey, sign };
}

function store(now = () => 1_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-cast-trust-'));
  const file = path.join(dir, 'trusted.json');
  return { dir, file, trust: createCastTrust({ file, keyFile: path.join(dir, 'trusted.key'), now }) };
}

test('tên hiện cho chủ máy: cùng loại máy nhưng khác khoá thì khác tên, cùng khoá thì tên giữ nguyên dù đổi mạng', () => {
  const phone = castViewerLabel('Android', 'key-a', 'vk-wifi');
  assert.match(phone, /^Android - [0-9A-F]{6}$/);
  assert.equal(castViewerLabel('Android', 'key-a', 'vk-4g'), phone);
  assert.notEqual(castViewerLabel('Android', 'key-b', 'vk-wifi'), phone);
});

test('tên hiện cho chủ máy: không có khoá thì dựa vào mã người xem; không có gì để phân biệt thì giữ nguyên', () => {
  assert.notEqual(castViewerLabel('Android', '', 'vk-1'), castViewerLabel('Android', '', 'vk-2'));
  assert.equal(castViewerLabel('Android', '', undefined), 'Android');
  assert.equal(castViewerLabel(undefined, '', undefined), undefined);
});

test('tên đầy đủ từ web (model + trình duyệt) giữ nguyên dấu phân cách, vẫn kèm mã', () => {
  assert.match(castViewerLabel('Android SM-S918B · Samsung Internet', 'key-a'), /^Android SM-S918B · Samsung Internet - [0-9A-F]{6}$/);
  assert.match(castViewerLabel('iPhone · Safari', 'key-a'), /^iPhone · Safari - [0-9A-F]{6}$/);
});

test('tên lưu danh sách tin cậy vẫn còn đủ mã dù tên khai rất dài hoặc có ký tự lạ', () => {
  const { trust } = store();
  const label = castViewerLabel(`${'x'.repeat(200)}"<b>`, 'key-a');
  assert.ok(label.length <= 60);
  assert.match(label, / - [0-9A-F]{6}$/);
  return browserDevice().then(({ publicKey }) => {
    trust.add({ key: publicKey, name: label });
    assert.equal(trust.list()[0].name, label);
  });
});

test('chữ ký WebCrypto của trình duyệt được máy xác minh; sai phiên / sai chuỗi / khoá khác thì không', async () => {
  const device = await browserDevice();
  const other = await browserDevice();
  const signature = await device.sign('s1', 'n1');
  assert.equal(verifyDeviceProof({ deviceKey: device.publicKey, sessionId: 's1', nonce: 'n1', signature }), true);
  assert.equal(verifyDeviceProof({ deviceKey: device.publicKey, sessionId: 's2', nonce: 'n1', signature }), false);
  assert.equal(verifyDeviceProof({ deviceKey: device.publicKey, sessionId: 's1', nonce: 'n2', signature }), false);
  assert.equal(verifyDeviceProof({ deviceKey: other.publicKey, sessionId: 's1', nonce: 'n1', signature }), false);
  assert.equal(verifyDeviceProof({ deviceKey: 'rác', sessionId: 's1', nonce: 'n1', signature }), false);
});

test('kho: thêm, gỡ, gỡ tất cả', async () => {
  const { trust } = store();
  const a = await browserDevice();
  const b = await browserDevice();
  assert.equal(trust.add({ key: a.publicKey, name: 'iPhone' }), true);
  assert.equal(trust.add({ key: b.publicKey, name: 'Android' }), true);
  assert.equal(trust.has(a.publicKey), true);
  trust.remove(a.publicKey);
  assert.equal(trust.has(a.publicKey), false);
  assert.equal(trust.has(b.publicKey), true);
  trust.removeAll();
  assert.deepEqual(trust.list(), []);
});

test('kho: chỉ nhận khoá P-256, tên lạ bị lọc', async () => {
  const { trust } = store();
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(trust.accepts(rsa), false);
  assert.equal(trust.add({ key: 'rác', name: 'x' }), false);
  const device = await browserDevice();
  trust.add({ key: device.publicKey, name: 'iPhone"},{"key":"x' });
  assert.equal(trust.list()[0].name.includes('"'), false);
});

test('kho: không dùng quá 30 ngày thì hết tin, dùng lại thì tính lại hạn', async () => {
  let t = 1_000_000;
  const { trust } = store(() => t);
  const device = await browserDevice();
  trust.add({ key: device.publicKey, name: 'iPhone' });
  t += CAST_TRUST_TTL_MS - 1000;
  trust.touch(device.publicKey);
  t += CAST_TRUST_TTL_MS - 1000;
  assert.equal(trust.has(device.publicKey), true);
  t += CAST_TRUST_TTL_MS + 1;
  assert.equal(trust.has(device.publicKey), false);
});

test('kho: ghi thêm thiết bị vào tệp từ bên ngoài → sai chữ ký, cả danh sách không còn được tin', async () => {
  const { trust, file } = store();
  const owner = await browserDevice();
  const attacker = await browserDevice();
  trust.add({ key: owner.publicKey, name: 'iPhone' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.devices.push({ ...saved.devices[0], key: attacker.publicKey });
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(trust.has(attacker.publicKey), false);
  assert.equal(trust.has(owner.publicKey), false);
});

test('kho: tệp không chữ ký hoặc hỏng → không tin ai', async () => {
  const { trust, file } = store();
  const device = await browserDevice();
  fs.writeFileSync(file, JSON.stringify({ devices: [{ key: device.publicKey, name: 'x', expires_at: 9e15 }] }));
  assert.equal(trust.has(device.publicKey), false);
  fs.writeFileSync(file, '{hỏng');
  assert.deepEqual(trust.list(), []);
});

test('xác minh: chữ ký đúng → true, mỗi lần một chuỗi mới, không dùng lại được chữ ký cũ', async () => {
  const device = await browserDevice();
  const sent = [];
  const prover = createDeviceProver({ send: (m) => sent.push(m) });
  const first = prover.prove({ sessionId: 's1', viewerId: 'v1', deviceKey: device.publicKey });
  const signature = await device.sign('s1', sent[0].nonce);
  prover.answer({ viewer_id: 'v1', session_id: 's1', sdp: signature });
  assert.equal(await first, true);
  assert.equal(sent[0].state, 'device_challenge');

  const second = prover.prove({ sessionId: 's1', viewerId: 'v1', deviceKey: device.publicKey });
  assert.notEqual(sent[1].nonce, sent[0].nonce);
  prover.answer({ viewer_id: 'v1', session_id: 's1', sdp: signature });
  assert.equal(await second, false);
});

test('xác minh: quá giờ → false; người xem rời → null; sai phiên bị bỏ qua', async () => {
  const device = await browserDevice();
  const sent = [];
  const prover = createDeviceProver({ send: (m) => sent.push(m), timeoutMs: 20 });
  // Bộ đếm hết giờ không giữ tiến trình (`unref`): test phải tự giữ vòng lặp sự kiện thì mới chờ tới được.
  const keepAlive = setInterval(() => {}, 5);
  try {
    assert.equal(await prover.prove({ sessionId: 's1', viewerId: 'v1', deviceKey: device.publicKey }), false);
  } finally {
    clearInterval(keepAlive);
  }

  const slow = createDeviceProver({ send: (m) => sent.push(m), timeoutMs: 60_000 });
  const left = slow.prove({ sessionId: 's1', viewerId: 'v2', deviceKey: device.publicKey });
  slow.answer({ viewer_id: 'v2', session_id: 'phiên-khác', sdp: 'x' });
  slow.cancel('v2');
  assert.equal(await left, null);
});

function setupConsent({ trusted = true, answer = D.ALLOW, mode = M.ASK, locked = false } = {}) {
  const asks = [];
  const added = [];
  const removed = [];
  const touched = [];
  const state = { mode, locked };
  const trust = {
    accepts: (k) => k === 'k1',
    has: () => trusted,
    add: (d) => added.push(d),
    touch: (k) => touched.push(k),
    remove: (k) => removed.push(k),
  };
  const consent = createCastConsent({
    trust,
    ask: (o) => { asks.push(o); return answer; },
    getMode: () => state.mode,
    isLocked: () => state.locked,
  });
  return { consent, asks, added, removed, touched, state };
}
const req = (extra = {}) => ({ sessionId: 's1', viewerId: 'v1', viewerDevice: 'iPhone', viewerKey: 'vk', deviceKey: 'k1', ...extra });

test('thiết bị tin cậy chứng minh đúng: vào thẳng, không hỏi, được gia hạn', async () => {
  const { consent, asks, touched } = setupConsent();
  assert.equal(await consent.decide(req({ prove: async () => true })), D.ALLOW);
  assert.equal(asks.length, 0);
  assert.deepEqual(touched, ['k1']);
});

test('thiết bị tin cậy nhưng không chứng minh được: hỏi như thường', async () => {
  const { consent, asks } = setupConsent();
  assert.equal(await consent.decide(req({ prove: async () => false })), D.ALLOW);
  assert.equal(asks.length, 1);
  const thrown = setupConsent();
  await thrown.consent.decide(req({ prove: async () => { throw new Error('x'); } }));
  assert.equal(thrown.asks.length, 1);
});

test('người xem rời lúc đang chứng minh: không mở hộp hỏi cho người đã đi', async () => {
  const { consent, asks } = setupConsent();
  assert.equal(await consent.decide(req({ prove: async () => null })), D.CANCELLED);
  assert.equal(asks.length, 0);
});

test('vừa bấm ngắt: quyền tin không có tác dụng, không cần chứng minh', async () => {
  let proved = 0;
  const { consent, asks } = setupConsent({ locked: true });
  await consent.decide(req({ prove: async () => { proved++; return true; } }));
  assert.equal(proved, 0);
  assert.equal(asks.length, 1);
});

test('chủ máy bấm ngắt hoặc tắt hẳn trong lúc đang chứng minh: không cho vào', async () => {
  const locked = setupConsent();
  await locked.consent.decide(req({ prove: async () => { locked.state.locked = true; return true; } }));
  assert.equal(locked.asks.length, 1);
  assert.equal(locked.asks[0].locked, true);
  const off = setupConsent();
  assert.equal(await off.consent.decide(req({ prove: async () => { off.state.mode = M.OFF; return true; } })), D.DISABLED);
});

test('chế độ tắt hẳn thắng quyền tin', async () => {
  const { consent } = setupConsent({ mode: M.OFF });
  assert.equal(await consent.decide(req({ prove: async () => true })), D.DISABLED);
});

test('hộp hỏi: chỉ hiện "Luôn cho phép" khi có khoá hợp lệ; chọn nút đó mới lưu, "Cho phép lần này" thì không', async () => {
  const always = setupConsent({ trusted: false, answer: D.ALLOW_ALWAYS });
  assert.equal(await always.consent.decide(req()), D.ALLOW);
  assert.equal(always.asks[0].canTrust, true);
  assert.deepEqual(always.added, [{ key: 'k1', name: 'iPhone' }]);

  const once = setupConsent({ trusted: false, answer: D.ALLOW });
  assert.equal(await once.consent.decide(req()), D.ALLOW);
  assert.deepEqual(once.added, []);

  const oldBrowser = setupConsent({ trusted: false, answer: D.ALLOW_ALWAYS });
  assert.equal(await oldBrowser.consent.decide(req({ deviceKey: '' })), D.ALLOW);
  assert.equal(oldBrowser.asks[0].canTrust, false);
  assert.deepEqual(oldBrowser.added, []);
});

test('đổi mạng giữa phiên (viewerKey đổi vì IP): cùng khoá thiết bị chứng minh đúng thì không hỏi lại', async () => {
  const { consent, asks } = setupConsent({ trusted: false, answer: D.ALLOW });
  assert.equal(await consent.decide(req({ viewerKey: 'wifi' })), D.ALLOW);
  let proved = 0;
  assert.equal(await consent.decide(req({ viewerId: 'v2', viewerKey: '4g', prove: async () => { proved++; return true; } })), D.ALLOW);
  assert.equal(proved, 1);
  assert.equal(asks.length, 1);
});

test('đổi mạng giữa phiên nhưng không chứng minh được, hoặc khoá khác: vẫn hỏi', async () => {
  const failed = setupConsent({ trusted: false, answer: D.ALLOW });
  await failed.consent.decide(req({ viewerKey: 'wifi' }));
  await failed.consent.decide(req({ viewerId: 'v2', viewerKey: '4g', prove: async () => false }));
  assert.equal(failed.asks.length, 2);

  const other = setupConsent({ trusted: false, answer: D.ALLOW });
  await other.consent.decide(req({ viewerKey: 'wifi' }));
  await other.consent.decide(req({ viewerId: 'v2', viewerKey: '4g', deviceKey: 'k2', prove: async () => true }));
  assert.equal(other.asks.length, 2);
});

test('đồng ý theo khoá thiết bị hết tác dụng khi phiên kết thúc, khi bấm ngắt hoặc gián đoạn quá lâu', async () => {
  const ended = setupConsent({ trusted: false, answer: D.ALLOW });
  await ended.consent.decide(req({ viewerKey: 'wifi' }));
  ended.consent.forget('s1');
  await ended.consent.decide(req({ viewerKey: '4g', prove: async () => true }));
  assert.equal(ended.asks.length, 2);

  const blocked = setupConsent({ trusted: false, answer: D.ALLOW });
  await blocked.consent.decide(req({ viewerKey: 'wifi' }));
  blocked.state.locked = true;
  await blocked.consent.decide(req({ viewerKey: '4g', prove: async () => true }));
  assert.equal(blocked.asks.length, 2);

  let t = 0;
  const asks = [];
  const consent = createCastConsent({ ask: (o) => { asks.push(o); return D.ALLOW; }, getMode: () => M.ASK, now: () => t });
  await consent.decide(req({ viewerKey: 'wifi' }));
  consent.suspend('s1', 1000);
  t = 2000;
  await consent.decide(req({ viewerKey: '4g', prove: async () => true }));
  assert.equal(asks.length, 2);
});

test('bấm ngắt: thiết bị đã vào phiên mất quyền tin, thiết bị khác giữ nguyên', async () => {
  const { consent, removed } = setupConsent();
  await consent.decide(req({ prove: async () => true }));
  consent.revokeSessionTrust('s1');
  consent.revokeSessionTrust('phiên-khác');
  assert.deepEqual(removed, ['k1']);
});
