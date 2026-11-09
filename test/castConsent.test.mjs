import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CastConsentDecision as D, createCastConsent } from '../bin/lib/remote/desktop/castConsent.mjs';
import { CastConsentMode as M, createPolicyGuard, saveLocalPolicy, stricterPolicy, verifyLocalPolicy, loadLocalPolicy } from '../bin/lib/remote/localPolicy.mjs';

function setup({ mode = M.ASK, answer = D.ALLOW, blocked = false } = {}) {
  const asks = [];
  const waits = [];
  const unblocked = [];
  const consent = createCastConsent({
    ask: (o) => { asks.push(o); return typeof answer === 'function' ? answer(o) : answer; },
    getMode: () => mode,
    isLocked: () => blocked,
    unlock: () => unblocked.push(true),
    onWaiting: (o) => waits.push(o),
  });
  return { consent, asks, waits, unblocked };
}
const req = (extra = {}) => ({ sessionId: 's1', viewerId: 'v1', viewerDevice: 'Chrome', ...extra });

test('mặc định: phiên mới phải hỏi, báo người xem đang chờ', async () => {
  const { consent, asks, waits } = setup();
  assert.equal(await consent.decide(req()), D.ALLOW);
  assert.equal(asks.length, 1);
  assert.equal(waits.length, 1);
});

test('từ chối / hết giờ / không hỏi được: không cho, và lần sau vẫn hỏi', async () => {
  for (const answer of [D.REJECTED, D.TIMEOUT, D.UNAVAILABLE]) {
    const { consent, asks } = setup({ answer });
    assert.equal(await consent.decide(req()), answer);
    assert.equal(await consent.decide(req()), answer);
    assert.equal(asks.length, 2);
  }
});

test('hộp hỏi lỗi: coi như không hỏi được, không cho xem', async () => {
  const { consent } = setup({ answer: () => { throw new Error('x'); } });
  assert.equal(await consent.decide(req()), D.UNAVAILABLE);
});

test('rớt mạng nối lại cùng phiên, cùng thiết bị: không hỏi lại', async () => {
  const { consent, asks } = setup();
  await consent.decide(req());
  assert.equal(await consent.decide(req({ viewerId: 'v2' })), D.ALLOW);
  assert.equal(asks.length, 1);
});

test('thiết bị khác vào cùng phiên: phải hỏi', async () => {
  const { consent, asks } = setup();
  await consent.decide(req());
  await consent.decide(req({ viewerDevice: 'iPhone' }));
  assert.equal(asks.length, 2);
});

test('phiên kết thúc thì quên, phiên mới phải hỏi lại', async () => {
  const { consent, asks } = setup();
  await consent.decide(req());
  consent.forget('s1');
  await consent.decide(req());
  await consent.decide(req({ sessionId: 's2' }));
  assert.equal(asks.length, 3);
});

test('yêu cầu trùng lúc đang hỏi: chỉ một hộp', async () => {
  let release;
  const { consent, asks } = setup({ answer: () => new Promise((r) => { release = r; }) });
  const one = consent.decide(req());
  const two = consent.decide(req({ viewerId: 'v2' }));
  await new Promise((r) => setImmediate(r));
  release(D.ALLOW);
  assert.deepEqual(await Promise.all([one, two]), [D.ALLOW, D.ALLOW]);
  assert.equal(asks.length, 1);
});

test('người xem rời lúc đang hỏi: huỷ, không cho bắt đầu', async () => {
  const { consent } = setup({ answer: ({ signal }) => new Promise((r) => signal.addEventListener('abort', () => r(D.CANCELLED))) });
  const pending = consent.decide(req());
  await new Promise((r) => setImmediate(r));
  consent.cancel({ sessionId: 'other' });
  consent.cancel({ sessionId: 's1' });
  assert.equal(await pending, D.CANCELLED);
});

/** Hộp hỏi chờ tới khi test trả lời; bị huỷ thì trả `CANCELLED` như hộp thật. */
function heldDialog() {
  let answerDialog;
  const answer = ({ signal }) => new Promise((resolve) => {
    answerDialog = resolve;
    signal.addEventListener('abort', () => resolve(D.CANCELLED));
  });
  return { answer, click: (decision) => answerDialog(decision) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('người xem rời tạm lúc đang hỏi: hộp vẫn mở, bấm xong chưa phát, quay lại vào thẳng không hỏi nữa', async () => {
  const dialog = heldDialog();
  const { consent, asks } = setup({ answer: dialog.answer });
  const first = consent.decide(req());
  await tick();
  consent.cancel({ sessionId: 's1', viewerId: 'v1', final: false, away: true });
  await tick();
  dialog.click(D.ALLOW);
  assert.equal(await first, D.CANCELLED);
  assert.equal(await consent.decide(req()), D.ALLOW);
  assert.equal(asks.length, 1);
});

test('người xem quay lại khi hộp còn mở: dùng chung hộp đó, được báo đang chờ, bấm xong vào luôn', async () => {
  const dialog = heldDialog();
  const { consent, asks, waits } = setup({ answer: dialog.answer });
  const first = consent.decide(req());
  await tick();
  consent.cancel({ sessionId: 's1', viewerId: 'v1', final: false, away: true });
  const back = consent.decide(req({ viewerId: 'v2' }));
  await tick();
  dialog.click(D.ALLOW);
  assert.equal(await first, D.CANCELLED);
  assert.equal(await back, D.ALLOW);
  assert.equal(asks.length, 1);
  assert.equal(waits.length, 2);
});

test('rời tạm rồi phiên kết thúc hẳn: đóng hộp, không còn đồng ý nào', async () => {
  const dialog = heldDialog();
  const { consent, asks } = setup({ answer: dialog.answer });
  const first = consent.decide(req());
  await tick();
  consent.cancel({ sessionId: 's1', viewerId: 'v1', final: false, away: true });
  consent.cancel({ sessionId: 's1' });
  assert.equal(await first, D.CANCELLED);
  consent.forget('s1');
  void consent.decide(req());
  await tick();
  assert.equal(asks.length, 2);
  consent.cancelAll();
});

test('người xem rời hẳn (không phải rời tạm) lúc đang hỏi: vẫn đóng hộp như cũ', async () => {
  const dialog = heldDialog();
  const { consent } = setup({ answer: dialog.answer });
  const first = consent.decide(req());
  await tick();
  consent.cancel({ sessionId: 's1', viewerId: 'v1', final: false });
  assert.equal(await first, D.CANCELLED);
});

test('không cần người ở máy: cho ngay; tắt hẳn: từ chối, không hỏi', async () => {
  const on = setup({ mode: M.UNATTENDED });
  assert.equal(await on.consent.decide(req()), D.ALLOW);
  assert.equal(on.asks.length, 0);
  const off = setup({ mode: M.OFF });
  assert.equal(await off.consent.decide(req()), D.DISABLED);
  assert.equal(off.asks.length, 0);
});

test('người xem khác cùng tên thiết bị nhưng khác mã máy chủ: phải hỏi', async () => {
  const { consent, asks } = setup();
  await consent.decide(req({ viewerKey: 'a' }));
  await consent.decide(req({ viewerKey: 'a', viewerId: 'v2' }));
  assert.equal(asks.length, 1);
  await consent.decide(req({ viewerKey: 'b' }));
  assert.equal(asks.length, 2);
});

test('chủ máy vừa bấm ngắt: luôn hỏi kể cả không cần người ở máy, đồng ý thì mở khoá', async () => {
  const { consent, asks, unblocked } = setup({ mode: M.UNATTENDED, blocked: true });
  assert.equal(await consent.decide(req()), D.ALLOW);
  assert.equal(asks[0].locked, true);
  assert.equal(unblocked.length, 1);
});

test('luật: mặc định hỏi, giá trị lạ về mặc định, bản chặt hơn thắng', () => {
  assert.equal(loadLocalPolicy(path.join(os.tmpdir(), 'khong-co-tep.json')).cast_consent, M.ASK);
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cast-policy-')), 'p.json');
  for (const value of ['constructor', 'toString', 'sometimes', 7]) {
    fs.writeFileSync(bad, JSON.stringify({ cast_consent: value }));
    assert.equal(loadLocalPolicy(bad).cast_consent, M.ASK, String(value));
  }
  const base = { confirm: 'risky', deny_tools: [], blocked_commands: [], confirm_timeout_sec: 120 };
  assert.equal(stricterPolicy({ ...base, cast_consent: M.ASK }, { ...base, cast_consent: M.UNATTENDED }).cast_consent, M.ASK);
  assert.equal(stricterPolicy({ ...base, cast_consent: M.UNATTENDED }, { ...base, cast_consent: M.OFF }).cast_consent, M.OFF);
});

test('tệp luật: agent sửa thành unattended không có chữ ký thì không có tác dụng; lưu đúng cách thì có', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-policy-'));
  const file = path.join(dir, 'policy.json');
  const keyFile = path.join(dir, 'key.json');
  const sealedMarker = { seen: () => true, note: () => {} };
  saveLocalPolicy({ cast_consent: M.ASK }, file, { keyFile });
  assert.equal(verifyLocalPolicy(file, { keyFile }).trusted, true);
  const guard = createPolicyGuard({ file, keyFile, sealedMarker });
  const signed = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...signed, cast_consent: M.UNATTENDED }));
  assert.equal(guard.read().cast_consent, M.ASK);
  saveLocalPolicy({ cast_consent: M.UNATTENDED }, file, { keyFile });
  assert.equal(verifyLocalPolicy(file, { keyFile }).trusted, true);
  assert.equal(guard.read().cast_consent, M.UNATTENDED);
});

test('tệp luật đã ký từ bản CLI trước (chưa có trường này) vẫn khớp chữ ký', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-policy-'));
  const file = path.join(dir, 'policy.json');
  const keyFile = path.join(dir, 'key.json');
  saveLocalPolicy({ confirm: 'always' }, file, { keyFile });
  const { cast_consent: _drop, ...older } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(older));
  const verdict = verifyLocalPolicy(file, { keyFile });
  assert.equal(verdict.trusted, true);
  assert.equal(verdict.policy.cast_consent, M.ASK);
});
