import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascotChat, ChatRole, AskCommand } = await import('../bin/lib/remote/mascot/ask.mjs');
const { createMascot, hostScript, HostCommand } = await import('../bin/lib/remote/mascot/index.mjs');
const { MASCOT_XAML } = await import('../bin/lib/remote/mascot/hostSource.mjs');

/** Socket giả: ghi lại các lần gửi, trả ack theo `reply(event, payload)`. */
function fakeSocket(reply) {
  const emitted = [];
  return {
    emitted,
    connected: true,
    timeout() { return this; },
    async emitWithAck(event, payload) { emitted.push({ event, payload }); return reply(event, payload); },
  };
}

function setup(reply = () => ({ ok: true })) {
  const sent = [];
  const alerts = [];
  const pending = [];
  const socket = fakeSocket(reply);
  const chat = createMascotChat({
    socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onAlert: (a) => alerts.push(a), onPending: (on) => pending.push(on),
  });
  return { chat, sent, socket, alerts, pending };
}

const rows = (sent) => sent.filter((c) => c.t === AskCommand.CHAT);
const choices = (sent) => sent.filter((c) => c.t === AskCommand.CHOICES);
const QUESTION = {
  reply_id: 'm9', kind: 'choice', question: 'Gửi báo cáo cho ai?',
  options: [{ id: 'boss', text: 'Sếp' }, { id: 'team', text: 'Cả nhóm' }],
};

test('Aivin hỏi lại trong lượt chat → hiện câu hỏi + nút, linh vật "cần bạn"; bấm nút → trả lời đúng câu hỏi, nút biến mất', async () => {
  const { chat, sent, socket, alerts, pending } = setup();
  await chat.ask('Gửi báo cáo tuần');
  const rid = socket.emitted[0].payload.request_id;
  chat.onChatEvent({ request_id: rid, kind: 'needs_input', text: 'Gửi báo cáo cho ai?', session_id: 's1', question: QUESTION });
  assert.ok(rows(sent).some((r) => r.role === ChatRole.ASSISTANT && r.text === 'Gửi báo cáo cho ai?'));
  assert.deepEqual(choices(sent).at(-1).options, [{ id: 'boss', text: 'Sếp' }, { id: 'team', text: 'Cả nhóm' }]);
  assert.deepEqual(alerts.at(-1), { kind: 'needs_you', text: 'Gửi báo cáo cho ai?' });
  assert.equal(chat.hasPending(), true);
  assert.deepEqual(pending, [true]);

  await chat.choose('team');
  assert.deepEqual(socket.emitted[1].payload, { text: '', request_id: socket.emitted[1].payload.request_id, session_id: 's1', reply_id: 'm9', option_ids: ['team'] });
  assert.ok(rows(sent).some((r) => r.role === ChatRole.USER && r.text === 'Cả nhóm'), 'dòng của chủ máy là tên nút');
  assert.deepEqual(choices(sent).at(-1).options, []);
  assert.equal(chat.hasPending(), false);
  assert.deepEqual(pending, [true, false]);
});

test('đang có câu hỏi: gõ chữ = câu trả lời (khớp tên nút thì gửi kèm lựa chọn); ask() vẫn là câu hỏi mới vào phiên của máy', async () => {
  const { chat, socket } = setup();
  chat.onNotify({ id: 'n1', kind: 'needs_you', title: 'Duyệt gửi thư', text: 'Gửi báo cáo cho ai?', session_id: 'web-7', question: QUESTION });
  await chat.reply('sếp');
  assert.deepEqual(socket.emitted[0].payload.option_ids, ['boss']);
  assert.equal(socket.emitted[0].payload.session_id, 'web-7');
  assert.equal(socket.emitted[0].payload.reply_id, 'm9');

  const free = setup();
  free.chat.onNotify({ id: 'n2', kind: 'needs_you', title: 'Hỏi thêm', text: 'Hạn chót là ngày nào?', session_id: 'web-8', question: { reply_id: 'm2', kind: 'text', question: 'Hạn chót?' } });
  await free.chat.ask('việc khác');
  assert.equal(free.socket.emitted[0].payload.reply_id, undefined, 'ask() không trả lời hộ câu hỏi đang chờ');
  free.chat.onChatEvent({ request_id: free.socket.emitted[0].payload.request_id, kind: 'answer', text: 'ok' });
  await free.chat.reply('thứ Sáu');
  assert.equal(free.socket.emitted[1].payload.reply_id, 'm2');
  assert.equal(free.socket.emitted[1].payload.text, 'thứ Sáu');
  assert.equal(free.socket.emitted[1].payload.option_ids, undefined);
});

test('câu hỏi đã hết hạn → báo bằng chữ của máy và bỏ nút; trả lời sai dạng → giữ nút để chọn lại', async () => {
  const expired = setup(() => ({ ok: false, error: 'no_question' }));
  expired.chat.onNotify({ id: 'n1', kind: 'needs_you', title: 't', text: 'q', session_id: 's', question: QUESTION });
  await expired.chat.choose('boss');
  assert.ok(rows(expired.sent).some((r) => r.role === ChatRole.ERROR && /hết hạn/.test(r.text)));
  assert.equal(expired.chat.hasPending(), false);

  const invalid = setup(() => ({ ok: false, error: 'invalid_answer' }));
  invalid.chat.onNotify({ id: 'n1', kind: 'needs_you', title: 't', text: 'q', session_id: 's', question: QUESTION });
  await invalid.chat.reply('không biết');
  assert.equal(invalid.chat.hasPending(), true);
});

test('báo chủ động: một dòng ngắn "Xong: …" / "Lỗi: …" + bong bóng; cùng id (nối lại) không báo lần hai; loại lạ bỏ qua', () => {
  const { chat, sent, alerts } = setup();
  chat.onNotify({ id: 'w1', kind: 'done', title: 'Tổng hợp doanh thu', text: 'Tổng 1,2 tỷ, tăng 8%.' });
  chat.onNotify({ id: 'w1', kind: 'done', title: 'Tổng hợp doanh thu', text: 'Tổng 1,2 tỷ, tăng 8%.' });
  chat.onNotify({ id: 'w2', kind: 'failed', title: 'Đồng bộ CRM', text: 'Hết hạn đăng nhập.' });
  chat.onNotify({ id: 'w3', kind: 'started', title: 'x', text: 'y' });
  assert.deepEqual(alerts, [{ kind: 'done', text: 'Xong: Tổng 1,2 tỷ, tăng 8%.' }, { kind: 'failed', text: 'Lỗi: Hết hạn đăng nhập.' }]);
  assert.ok(rows(sent).some((r) => r.role === ChatRole.ASSISTANT && r.text === 'Xong: Tổng hợp doanh thu\nTổng 1,2 tỷ, tăng 8%.'));
  assert.ok(rows(sent).some((r) => r.role === ChatRole.ERROR && r.text.startsWith('Lỗi: Đồng bộ CRM')));
  assert.equal(choices(sent).length, 0);
});

test('câu trả lời đã rút gọn ghi "(chi tiết trên Aivin)"; hết giờ chờ (việc còn chạy) không báo "xong"', async () => {
  const { chat, sent, socket, alerts } = setup();
  await chat.ask('Phân tích log tháng 10');
  chat.onChatEvent({ request_id: socket.emitted[0].payload.request_id, kind: 'timeout', text: 'Việc còn đang chạy — xong mình báo.' });
  assert.equal(alerts.length, 0);
  await chat.ask('Tóm tắt báo cáo');
  chat.onChatEvent({ request_id: socket.emitted[1].payload.request_id, kind: 'answer', text: 'Doanh thu tăng 8%.', more: true });
  assert.ok(rows(sent).some((r) => r.text === 'Doanh thu tăng 8%. (chi tiết trên Aivin)'));
  assert.deepEqual(alerts, [{ kind: 'done', text: 'Doanh thu tăng 8%.' }]);
});

test('cửa sổ có hàng nút lựa chọn + lệnh ask_choices, bấm nút gửi sự kiện choose', () => {
  assert.match(MASCOT_XAML, /x:Name="Choices"/);
  const ps = hostScript();
  assert.match(ps, /'ask_choices' \{ ChoiceButtons \$m\.options; return \}/);
  assert.match(ps, /t = 'choose'; id = \[string\]\$s\.CommandParameter/);
  assert.ok([...ps].every((c) => c.charCodeAt(0) < 128), 'host.ps1 giữ toàn ASCII');
});

test('thả tệp vào bot: hiện "📎 tên tệp", câu gõ kế tiếp mang đường dẫn đầy đủ; gửi xong thì bỏ tệp', async () => {
  const { chat, sent, socket } = setup();
  chat.attach(['C:/Users/a/Bao cao Q3.xlsx', 'D:/Hop dong/', 'C:/Users/a/Bao cao Q3.xlsx']);
  assert.ok(rows(sent).some((r) => r.role === ChatRole.USER && r.text.startsWith('📎 Bao cao Q3.xlsx, Hop dong')));
  await chat.reply('tóm tắt rồi gửi sếp');
  assert.equal(socket.emitted[0].payload.text, 'tóm tắt rồi gửi sếp\n\nTệp trên máy này:\n- C:/Users/a/Bao cao Q3.xlsx\n- D:/Hop dong/');
  assert.ok(rows(sent).some((r) => r.role === ChatRole.USER && r.text === 'tóm tắt rồi gửi sếp'), 'dòng của chủ máy chỉ là câu gõ');
  chat.onChatEvent({ request_id: socket.emitted[0].payload.request_id, kind: 'answer', text: 'ok' });
  await chat.reply('câu sau');
  assert.equal(socket.emitted[1].payload.text, 'câu sau');
});

/** Cửa sổ giả cho createMascot: ghi lại lệnh daemon gửi; `send(evt)` = cửa sổ gửi sự kiện về. */
function fakeHost() {
  const spawned = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.sent = [];
    child.stdin = { write: (s) => { child.sent.push(...String(s).trim().split('\n').map((l) => JSON.parse(l))); }, end: () => {}, on: () => {} };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 0);
    child.send = (evt) => child.stdout.write(`${JSON.stringify(evt)}\n`);
    spawned.push(child);
    return child;
  };
  return { spawned, spawnImpl };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMascot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-mascot-'));
  const host = fakeHost();
  const m = createMascot({
    platform: 'win32', env: { AIVIN_LANG: 'vi' }, spawnImpl: host.spawnImpl, dir: path.join(dir, 'host'), settingsFile: path.join(dir, 'mascot.json'),
    thinkMs: 30, resultMs: 30, mainThrottleMs: 0, restartDelaysMs: [10], ...extra,
  });
  return { m, host };
}

test('quay lại sau khi vắng: vẫy chào + "Lúc bạn vắng: 1 việc xong, 1 cần bạn"; vắng ngắn không có gì → im lặng', async () => {
  const { m, host } = makeMascot({ awayWaveMs: 60_000 });
  const child = host.spawned[0];
  child.send({ t: 'ready' });
  await sleep(20);
  child.send({ t: 'away' });
  await sleep(20);
  m.alert({ kind: 'done', text: 'Xong: Tổng hợp doanh thu' });
  m.alert({ kind: 'needs_you', text: 'Cần bạn: Gửi cho ai?' });
  child.send({ t: 'back' });
  await sleep(20);
  assert.ok(child.sent.some((c) => c.t === HostCommand.GESTURE && c.g === 'wave'));
  assert.ok(child.sent.some((c) => c.t === HostCommand.MAIN && c.text === 'Lúc bạn vắng: 1 việc xong, 1 cần bạn'));

  const before = child.sent.length;
  child.send({ t: 'away' });
  child.send({ t: 'back' });
  await sleep(20);
  assert.ok(!child.sent.slice(before).some((c) => c.t === HostCommand.GESTURE), 'vắng ngắn, không có việc → không vẫy');
  m.close();
});

test('cửa sổ báo thả tệp → daemon chuyển danh sách đường dẫn (bỏ mục rỗng / sai kiểu)', async () => {
  const dropped = [];
  const { m, host } = makeMascot({ onDrop: (files) => dropped.push(files) });
  const child = host.spawned[0];
  child.send({ t: 'drop', files: ['C:/a.txt', '', 3, 'D:/b'] });
  await sleep(20);
  assert.deepEqual(dropped, [['C:/a.txt', 'D:/b']]);
  m.close();
});

test('cửa sổ: thả tệp, theo dõi đi vắng, chơi với bot (lắc → chóng mặt, bấm nhanh → cười, vuốt → lim dim), lệnh gesture', () => {
  const ps = hostScript();
  assert.match(ps, /\.AllowDrop = \$true/);
  assert.match(ps, /Send @\{ t = 'drop'; files = @\(\$files\) \}/);
  assert.match(ps, /Send @\{ t = 'away' \}/);
  assert.match(ps, /Send @\{ t = 'back' \}/);
  assert.match(ps, /PlayFace 'dizzy' 'dizzy'/);
  assert.match(ps, /PlayFace 'giggle' 'hello'/);
  assert.match(ps, /PlayFace 'purr' 'purr'/);
  assert.match(ps, /'gesture' \{/);
  assert.match(ps, /public void Play\(string g\)/);
  assert.match(MASCOT_XAML, /x:Name="SpinL"/);
});

test('câu hỏi đang chờ: ô hỏi tự ghim ra (kèm câu hỏi + nút), trả lời xong thì bỏ ghim', async () => {
  const { chat, sent } = setup();
  chat.onNotify({ id: 'p1', kind: 'needs_you', title: 'Duyệt gửi thư', text: 'Gửi báo cáo cho ai?', session_id: 'web-7', question: QUESTION });
  const order = sent.map((c) => c.t);
  assert.ok(rows(sent).some((r) => r.id === 'q-m9' && r.text === 'Cần bạn: Duyệt gửi thư\nGửi báo cáo cho ai?'));
  assert.ok(order.indexOf('ask_choices') < order.indexOf('ask_pin'), 'nút có trước khi ô bật ra');
  assert.deepEqual(sent.filter((c) => c.t === 'ask_pin'), [{ t: 'ask_pin', on: true }]);
  await chat.choose('boss');
  assert.deepEqual(sent.filter((c) => c.t === 'ask_pin').at(-1), { t: 'ask_pin', on: false });
});

test('cửa sổ dựng lại / chưa sẵn sàng khi có câu hỏi chờ → gửi lại dòng câu hỏi, nút và ghim', async () => {
  const { m, host } = makeMascot();
  m.chat({ t: 'chat', role: 'assistant', id: 'q-m9', text: 'Gửi báo cáo cho ai?' });
  m.chat({ t: 'ask_choices', options: [{ id: 'boss', text: 'Sếp' }] });
  m.chat({ t: 'ask_pin', on: true });
  const child = host.spawned[0];
  child.send({ t: 'ready' });
  await sleep(20);
  const ts = child.sent.map((c) => c.t);
  assert.ok(child.sent.some((c) => c.t === 'chat' && c.id === 'q-m9'));
  assert.ok(ts.includes('ask_choices') && ts.lastIndexOf('ask_pin') > ts.indexOf('ask_choices'));
  m.close();
});
