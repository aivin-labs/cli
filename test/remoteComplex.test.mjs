import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';

// Thư mục cấu hình riêng cho test — đặt TRƯỚC khi nạp mô-đun (hằng số tính lúc import).
process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-complex-'));

const { createScheduler, lockKeyOf } = await import('../bin/lib/remote/scheduler.mjs');
const { createIdempotentRunner } = await import('../bin/lib/remote/idempotency.mjs');
const { createConfirmBarrier } = await import('../bin/lib/remote/confirmBarrier.mjs');
const { createCastConsent, CastConsentDecision } = await import('../bin/lib/remote/desktop/castConsent.mjs');
const { createCastInputGate, CastInputRejection } = await import('../bin/lib/remote/desktop/castInput.mjs');
const { confirmCommand } = await import('../bin/lib/remote/localConfirm.mjs');
const {
  CAST_CONSENT_WINDOW_TITLE, CONFIRM_WINDOW_TITLE, HUMAN_GUARD_CSHARP, isProtectedPromptWindow, newInputTag,
} = await import('../bin/lib/remote/humanInput.mjs');
const { assertWindowAllowed } = await import('../bin/lib/remote/gui/index.mjs');
const { keepAwakeCommand } = await import('../bin/lib/remote/keepAwake.mjs');
const { orphanSweepScript } = await import('../bin/lib/remote/winTree.mjs');
const { createDesktopCastManager } = await import('../bin/lib/remote/desktop/desktopCast.mjs');
const { DeviceErrorCode, ToolGroup } = await import('../bin/lib/remote/constants.mjs');
const { CastConsentMode } = await import('../bin/lib/remote/localPolicy.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const root = path.resolve(os.tmpdir(), 'aivin-locks');
const at = (...p) => path.join(root, ...p);

// ── scheduler ────────────────────────────────────────────────────────────────────────────────────

test('khoá đường dẫn: lệnh ghi bị huỷ lúc đang chờ khoá thì KHÔNG ghi, trả NOT_STARTED', async () => {
  const sched = createScheduler();
  const first = deferred();
  const ran = [];
  const spec = { group: ToolGroup.FS_WRITE, lockKeys: () => [at('f.txt')] };
  const a = sched.run({ call_id: 'a', timeout_ms: 5000 }, spec, async () => { ran.push('a'); await first.promise; return 'a'; });
  await sleep(10);
  const b = sched.run({ call_id: 'b', timeout_ms: 5000 }, spec, async () => { ran.push('b'); return 'b'; });
  await sleep(10);
  sched.cancel(['b']);
  first.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, false);
  assert.equal(rb.error_code, DeviceErrorCode.NOT_STARTED);
  assert.equal(rb.ran, false);
  assert.deepEqual(ran, ['a']);
});

test('khoá đường dẫn theo cha – con: xoá thư mục và ghi tệp bên trong chạy lần lượt; tên gần giống (ab) vẫn song song', async () => {
  const sched = createScheduler();
  const order = [];
  const gate = deferred();
  const del = sched.run({ call_id: 'del', timeout_ms: 5000 }, { group: ToolGroup.FS_WRITE, lockKeys: () => [at('a')] }, async () => {
    order.push('del:start'); await gate.promise; order.push('del:end');
  });
  await sleep(5);
  const write = sched.run({ call_id: 'w', timeout_ms: 5000 }, { group: ToolGroup.FS_WRITE, lockKeys: () => [at('a', 'b.txt')] }, async () => { order.push('write'); });
  const sibling = sched.run({ call_id: 's', timeout_ms: 5000 }, { group: ToolGroup.FS_WRITE, lockKeys: () => [at('ab', 'c.txt')] }, async () => { order.push('sibling'); });
  await sibling;
  assert.deepEqual(order, ['del:start', 'sibling']);
  gate.resolve();
  await Promise.all([del, write]);
  assert.deepEqual(order, ['del:start', 'sibling', 'del:end', 'write']);
});

test('khoá đường dẫn: Windows / macOS không phân biệt hoa thường', () => {
  assert.equal(lockKeyOf(at('A.txt'), 'win32'), lockKeyOf(at('a.txt'), 'win32'));
  assert.equal(lockKeyOf(at('A.txt'), 'darwin'), lockKeyOf(at('a.txt'), 'darwin'));
  assert.notEqual(lockKeyOf(at('A.txt'), 'linux'), lockKeyOf(at('a.txt'), 'linux'));
});

test('hết giờ lúc còn xếp hàng → NOT_STARTED (chưa chạy); hết giờ giữa chừng → CALL_TIMEOUT kèm ran', async () => {
  const sched = createScheduler();
  const spec = { group: ToolGroup.GUI }; // nhóm GUI chỉ 1 chỗ
  let secondRan = false;
  const long = sched.run({ call_id: 'long', timeout_ms: 2000 }, spec, (_a, { signal }) => new Promise((_r, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const queued = sched.run({ call_id: 'queued', timeout_ms: 1000 }, spec, async () => { secondRan = true; });
  const [rl, rq] = await Promise.all([long, queued]);
  assert.equal(rl.error_code, DeviceErrorCode.CALL_TIMEOUT);
  assert.equal(rl.ran, true);
  assert.equal(rq.error_code, DeviceErrorCode.NOT_STARTED);
  assert.equal(rq.ran, false);
  assert.equal(secondRan, false);
});

// ── idempotency ──────────────────────────────────────────────────────────────────────────────────

test('chống làm trùng: bước bị dừng GIỮA CHỪNG không tự chạy lại khi BE gửi lại (cả sau khi daemon khởi động lại); bước chưa chạy thì chạy lại được', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-idem-')), 'idem.log');
  let runs = 0;
  const outcomes = [
    { ok: false, error: 'Timed out', error_code: DeviceErrorCode.CALL_TIMEOUT, ran: true, duration_ms: 1 },
    { ok: false, error: 'not started', error_code: DeviceErrorCode.NOT_STARTED, ran: false, duration_ms: 1 },
    { ok: true, result: { done: true }, duration_ms: 1 },
  ];
  const run = async (call) => { runs++; return { tool: { name: call.tool }, outcome: outcomes[call.n] }; };
  const once = createIdempotentRunner(run, () => false, { file });

  const first = await once({ tool: 'shell.exec', idem_key: 'k1', n: 0 });
  assert.equal(first.outcome.error_code, DeviceErrorCode.CALL_TIMEOUT); // lần đầu: đúng lỗi gốc
  const again = await once({ tool: 'shell.exec', idem_key: 'k1', n: 2 });
  assert.equal(again.outcome.error_code, DeviceErrorCode.INTERRUPTED);
  assert.equal(runs, 1);

  await once({ tool: 'shell.exec', idem_key: 'k2', n: 1 });
  const retry = await once({ tool: 'shell.exec', idem_key: 'k2', n: 2 });
  assert.equal(retry.outcome.ok, true);
  assert.equal(runs, 3);

  await sleep(20); // sổ ghi bất đồng bộ
  const reloaded = createIdempotentRunner(run, () => false, { file });
  const afterRestart = await reloaded({ tool: 'shell.exec', idem_key: 'k1', n: 2 });
  assert.equal(afterRestart.outcome.error_code, DeviceErrorCode.INTERRUPTED);
  assert.equal(runs, 3);
});

// ── rào xác nhận ─────────────────────────────────────────────────────────────────────────────────

test('rào xác nhận: lời gọi khác chờ tới khi hộp được trả lời; huỷ lúc chờ → false', async () => {
  const barrier = createConfirmBarrier();
  assert.equal(await barrier.waitClear(), true);
  const release = barrier.hold();
  const release2 = barrier.hold();
  let cleared = false;
  const waiting = barrier.waitClear().then((v) => { cleared = v; });
  release();
  release(); // thả hai lần vô hại
  await sleep(5);
  assert.equal(cleared, false);
  release2();
  await waiting;
  assert.equal(cleared, true);

  const r3 = barrier.hold();
  const ctrl = new AbortController();
  const aborted = barrier.waitClear(ctrl.signal);
  ctrl.abort();
  assert.equal(await aborted, false);
  r3();
});

// ── đồng ý xem màn hình ──────────────────────────────────────────────────────────────────────────

// ── nhiều người xem ──────────────────────────────────────────────────────────────────────────────

test('nhiều người xem: mỗi lúc một người cầm lái; người rời chỉ nhả nút của chính họ', () => {
  let t = 0;
  const gate = createCastInputGate({ now: () => t, exclusiveMs: 1000 });
  assert.equal(gate.accept({ action: 'mousedown', button: 0, x: 1, y: 1 }, 'A').ok, true);
  // B thao tác lúc A đang giữ nút → bị bỏ (kể cả quá exclusiveMs).
  t = 5000;
  assert.deepEqual(gate.accept({ action: 'click', x: 2, y: 2 }, 'B'), { ok: false, reason: CastInputRejection.OTHER_VIEWER });
  assert.equal(gate.accept({ action: 'mouseup', button: 0 }, 'A').ok, true);
  // A vừa thao tác (< 1 s) → B vẫn chờ.
  t = 5500;
  assert.equal(gate.accept({ action: 'click', x: 2, y: 2 }, 'B').reason, CastInputRejection.OTHER_VIEWER);
  t = 6100;
  assert.equal(gate.accept({ action: 'mousedown', button: 2, x: 2, y: 2 }, 'B').ok, true);
  // A rời phiên: không có nút nào của A để nhả, nút phải của B vẫn giữ.
  assert.deepEqual(gate.releaseViewer('A'), []);
  assert.deepEqual(gate.releaseViewer('B'), [2]);
  // B rời → A cầm lái lại ngay.
  assert.equal(gate.accept({ action: 'click', x: 3, y: 3 }, 'A').ok, true);
});

test('nhiều người xem: gói nhả nút của người không cầm lái vẫn qua (không kẹt nút)', () => {
  let t = 0;
  const gate = createCastInputGate({ now: () => t });
  assert.equal(gate.accept({ action: 'mousedown', button: 0 }, 'A').ok, true);
  t = 10;
  // B nhả nút B chưa từng giữ → không phải gói nhả → bị bỏ.
  assert.equal(gate.accept({ action: 'mouseup', button: 0 }, 'B').ok, false);
  const res = gate.accept({ action: 'mouseup', button: 0, x: 9, y: 9 }, 'A');
  assert.equal(res.ok, true);
});

// ── hộp xác nhận: chỉ người thật ─────────────────────────────────────────────────────────────────

test('người xem JPEG (thao tác qua máy chủ không có mã người xem) rời phiên lúc giữ chuột: nút vẫn được nhả', () => {
  const gate = createCastInputGate({ now: () => 0 });
  assert.equal(gate.accept({ action: 'mousedown', button: 0, x: 1, y: 1 }).ok, true);
  assert.deepEqual(gate.releaseViewer('viewer-that-left'), [0]);
  assert.deepEqual(gate.releaseViewer('viewer-that-left'), []);
});

test('hộp xác nhận Windows: cài chốt người thật, "Cho phép" phải qua Test-Human, tag tin cậy chỉ khi được truyền', () => {
  const plain = confirmCommand({ request: { reason: 'r', detail: 'd' }, timeoutSec: 30, platform: 'win32' });
  const script = plain.args[plain.args.length - 1];
  assert.match(script, /Install-Guard \$w/);
  assert.match(script, /Add_Click\(\{ if \(Test-Human\) \{ Finish 'Yes' \}/);
  assert.equal(plain.env.AIVIN_GUARD_TAG, '');
  assert.equal(Buffer.from(plain.env.AIVIN_GUARD_CS, 'base64').toString('utf8'), HUMAN_GUARD_CSHARP);
  assert.match(HUMAN_GUARD_CSHARP, /SetWindowsHookEx\(14, mouseProc/); // WH_MOUSE_LL
  assert.match(HUMAN_GUARD_CSHARP, /SetWindowsHookEx\(13, keyProc/); // WH_KEYBOARD_LL
  const tagged = confirmCommand({ request: { reason: 'r', detail: 'd', trustTag: 123456789 }, timeoutSec: 30, platform: 'win32' });
  assert.equal(tagged.env.AIVIN_GUARD_TAG, '123456789');
});

test('hộp xác nhận / đồng ý: chữ dài cạnh nút không đẩy nút ra ngoài (nút giữ chỗ trước, chữ xuống dòng trong phần còn lại)', async () => {
  const { CONSENT_XAML } = await import('../bin/lib/remote/desktop/castAuth.mjs');
  const confirmXaml = Buffer.from(confirmCommand({ request: { reason: 'r', detail: 'd' }, timeoutSec: 30, platform: 'win32' }).env.AIVIN_C_XAML, 'base64').toString('utf8');
  const rowOf = (xaml) => xaml.slice(xaml.lastIndexOf('<DockPanel'), xaml.lastIndexOf('</DockPanel>'));
  const confirmRow = rowOf(confirmXaml);
  assert.match(confirmRow, /LastChildFill="True"/);
  assert.ok(confirmRow.indexOf('x:Name="Allow"') < confirmRow.indexOf('x:Name="Reject"'));
  assert.ok(confirmRow.indexOf('x:Name="Reject"') < confirmRow.indexOf('x:Name="Countdown"'));
  assert.match(confirmRow, /x:Name="Countdown"[^>]*TextWrapping="Wrap"/);
  // Hộp đồng ý: số đếm nằm trong nút Từ chối, lời nhắc ở hàng riêng dưới các nút nên không chen được vào hàng nút.
  const consentRow = rowOf(CONSENT_XAML);
  assert.ok(consentRow.indexOf('x:Name="Allow"') < consentRow.indexOf('x:Name="Reject"'));
  assert.equal(consentRow.includes('x:Name="Hint"'), false);
  assert.match(CONSENT_XAML, /x:Name="Hint"[^>]*TextWrapping="Wrap"/);
});

test('chốt người thật: tag 31 bit (Windows chỉ chuyển 32 bit thấp của dwExtraInfo tới hook), so đúng 32 bit thấp', () => {
  for (let i = 0; i < 50; i++) {
    const tag = newInputTag();
    assert.ok(Number.isSafeInteger(tag) && tag > 0 && tag <= 0x7fffffff);
  }
  assert.match(HUMAN_GUARD_CSHARP, /extra\.ToInt64\(\) & 0xFFFFFFFFL\) == tag/);
  assert.match(HUMAN_GUARD_CSHARP, /flags & 0x3\) != 0/); // LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED
  assert.match(HUMAN_GUARD_CSHARP, /flags & 0x12\) != 0/); // LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED
});

test('công cụ GUI không thao tác lên hộp xác nhận / đồng ý của Aivin, kể cả máy toàn quyền', () => {
  for (const title of [CONFIRM_WINDOW_TITLE, CAST_CONSENT_WINDOW_TITLE, `  ${CONFIRM_WINDOW_TITLE.toUpperCase()} `]) {
    assert.ok(isProtectedPromptWindow(title));
    assert.throws(() => assertWindowAllowed({ title, process: 'powershell' }, { fullAccess: true }), (e) => e.code === DeviceErrorCode.GUI_BLOCKED_APP);
  }
  assert.doesNotThrow(() => assertWindowAllowed({ title: 'Aivin — notes.txt - Notepad', process: 'notepad' }, { fullAccess: false }));
});

// ── giữ màn hình sáng / dọn tiến trình mồ côi ────────────────────────────────────────────────────

test('giữ máy thức cho phiên xem màn hình: thêm cờ giữ màn hình sáng', () => {
  const plain = keepAwakeCommand('win32').args.at(-1);
  const display = keepAwakeCommand('win32', { display: true }).args.at(-1);
  assert.match(plain, /2147483649/);
  assert.match(display, /2147483651/);
  assert.deepEqual(keepAwakeCommand('darwin', { pid: 7, display: true }).args, ['-d', '-i', '-w', '7']);
});

test('dọn tiến trình mồ côi trên Windows: lần theo PID cha, chỉ tiến trình tạo sau lúc chạy lệnh', () => {
  assert.equal(orphanSweepScript(0, Date.now()), null);
  assert.equal(orphanSweepScript('abc', Date.now()), null);
  const script = orphanSweepScript(4242, 1_700_000_001_000);
  assert.match(script, /\[uint32\]4242/);
  assert.match(script, /FromUnixTimeMilliseconds\(1700000000000\)/);
  assert.match(script, /CreationDate -ge \$since/);
});

// ── tiến trình cast nhận tag của phiên ───────────────────────────────────────────────────────────

test('desktop cast: tag của phiên đi vào tham số tiến trình quay (chuỗi), không có thì không gửi', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-cast-'));
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    spawned.push(JSON.parse(opts.env.AIVIN_CAST_ARGS));
    return child;
  };
  const cast = createDesktopCastManager({ dir, spawnImpl });
  cast.start({ sessionId: 's1', inputTag: 987654321 });
  cast.stop();
  cast.start({ sessionId: 's2' });
  cast.stop();
  assert.equal(spawned[0].input_tag, '987654321');
  assert.equal('input_tag' in spawned[1], false);
});

// ── luồng kết thúc phiên xem màn hình ────────────────────────────────────────────────────────────

const { CONSENT_RESUME_MS } = await import('../bin/lib/remote/desktop/castConsent.mjs');
const { CAST_SESSION_FILE, recordCastSession, requestCastStop } = await import('../bin/lib/remote/desktop/castAuth.mjs');
const { createDesktopWebRtcWorker } = await import('../bin/lib/remote/desktop/webrtcWorker.mjs');

test('đồng ý xem màn hình: máy rớt mạng thì giữ đồng ý có hạn; kết thúc hẳn thì quên', async () => {
  let t = 0;
  let asked = 0;
  const consent = createCastConsent({ ask: async () => { asked++; return CastConsentDecision.ALLOW; }, getMode: () => CastConsentMode.ASK, now: () => t });
  const viewer = { sessionId: 's1', viewerId: 'v1', viewerKey: 'acc|ip|ua' };
  assert.equal(await consent.decide(viewer), CastConsentDecision.ALLOW);
  assert.equal(asked, 1);
  // Máy rớt mạng → phiên dừng ở máy, máy chủ mời phát lại cùng phiên (viewer_id mới, cùng viewer_key): không hỏi lại.
  consent.suspend('s1');
  t += CONSENT_RESUME_MS - 1;
  assert.equal(await consent.decide({ ...viewer, viewerId: 'v1-again' }), CastConsentDecision.ALLOW);
  assert.equal(asked, 1);
  // Phát lại xong → đồng ý về "vô hạn" tới khi phiên kết thúc; lần gián đoạn sau tính hạn lại từ đầu.
  t += CONSENT_RESUME_MS * 5;
  assert.equal(await consent.decide(viewer), CastConsentDecision.ALLOW);
  assert.equal(asked, 1);
  consent.suspend('s1');
  t += CONSENT_RESUME_MS + 1;
  assert.equal(await consent.decide(viewer), CastConsentDecision.ALLOW);
  assert.equal(asked, 2);
  consent.forget('s1');
  await consent.decide(viewer);
  assert.equal(asked, 3);
});

test('đồng ý xem màn hình: tạm dừng / tắt daemon đóng mọi hộp đang hỏi', async () => {
  const signals = [];
  const consent = createCastConsent({
    ask: ({ signal }) => new Promise((resolve) => { signals.push(signal); signal.addEventListener('abort', () => resolve(CastConsentDecision.CANCELLED)); }),
    getMode: () => CastConsentMode.ASK,
  });
  const a = consent.decide({ sessionId: 's1', viewerId: 'v1', viewerKey: 'a' });
  const b = consent.decide({ sessionId: 's2', viewerId: 'v2', viewerKey: 'b' });
  consent.cancelAll();
  assert.deepEqual(await Promise.all([a, b]), [CastConsentDecision.CANCELLED, CastConsentDecision.CANCELLED]);
  assert.ok(signals.every((s) => s.aborted));
});

test('aivin remote disconnect: tệp phiên sót sau khi daemon chết → dọn, không báo "đã ngắt"', () => {
  recordCastSession({ active: true, sessionId: 's', viewerId: 'v', viewerDevice: 'd' });
  assert.equal(JSON.parse(fs.readFileSync(CAST_SESSION_FILE, 'utf8')).pid, process.pid);
  assert.equal(requestCastStop({ daemonAlive: () => false }), false);
  assert.equal(fs.existsSync(CAST_SESSION_FILE), false);
  recordCastSession({ active: true, sessionId: 's', viewerId: 'v', viewerDevice: 'd' });
  assert.equal(requestCastStop({ daemonAlive: () => true }), true);
});

test('WebRTC: phiên dừng lúc người xem đang dựng kết nối → trả "không dựng được" ngay, không chờ 30 s', async () => {
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.kill = () => {};
    return proc;
  };
  const worker = createDesktopWebRtcWorker({ command: ['node'], spawnImpl });
  const started = worker.start({ sessionId: 's', viewerId: 'v' });
  const t0 = Date.now();
  worker.closeAll();
  assert.equal(await started, false);
  assert.ok(Date.now() - t0 < 1000);
});

test('desktop cast: dừng chờ tiến trình quay tự thoát (nhả phím / nút) — chỉ giết khi quá hạn, gọi dừng hai lần không gửi hai lần', { skip: process.platform !== 'win32' }, async () => {
  const { STOP_GRACE_MS } = await import('../bin/lib/remote/desktop/desktopCast.mjs');
  assert.ok(STOP_GRACE_MS >= 2000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-cast-stop-'));
  let killed = 0;
  let child;
  const written = [];
  const spawnImpl = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d) => written.push(String(d)));
    child.kill = () => { killed++; };
    return child;
  };
  const cast = createDesktopCastManager({ dir, spawnImpl });
  const session = cast.start({ sessionId: 's' });
  session.stop();
  session.stop();
  await sleep(600); // trước đây giết sau 500 ms
  assert.equal(killed, 0);
  assert.equal(written.join('').split('stop\n').length - 1, 1);
  child.emit('close'); // tự thoát → huỷ hẹn giết
  await sleep(10);
  assert.equal(killed, 0);
});
