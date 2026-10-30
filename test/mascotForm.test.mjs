import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascotChat, ChatRole, AskCommand, FORM_SKIP_ID, QUESTION_ROW } = await import('../bin/lib/remote/mascot/ask.mjs');

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
  const pending = [];
  const socket = fakeSocket(reply);
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onPending: (on) => pending.push(on) });
  return { chat, sent, socket, pending };
}

const rows = (sent) => sent.filter((c) => c.t === AskCommand.CHAT);
const lastChoices = (sent) => sent.filter((c) => c.t === AskCommand.CHOICES).at(-1)?.options;
const FORM = {
  reply_id: 'f1', kind: 'form', question: 'Cần thêm thông tin để gửi thư',
  fields: [
    { name: 'to', label: 'Người nhận', required: true },
    { name: 'tone', label: 'Giọng văn', required: true, options: [{ id: 'formal', text: 'Trang trọng' }, { id: 'casual', text: 'Thân mật' }] },
    { name: 'note', label: 'Ghi chú', required: false },
  ],
};
const notify = (chat, question = FORM) => chat.onNotify({ id: `n-${question.reply_id}`, kind: 'needs_you', title: 'Gửi thư', text: question.question, session_id: 's1', question });

test('biểu mẫu nhiều trường: hỏi từng trường (nút cho trường có lựa chọn, "Bỏ qua" cho trường không bắt buộc), đủ thì gửi một lần `fields`', async () => {
  const { chat, sent, socket, pending } = setup();
  notify(chat);
  assert.equal(chat.hasPending(), true);
  assert.ok(rows(sent).some((r) => r.text === 'Người nhận (1/3)' && r.id.startsWith(QUESTION_ROW)), 'dòng trường đầu, id mang tiền tố câu hỏi');
  assert.deepEqual(lastChoices(sent), []);

  await chat.reply('an@aivin.vn');
  assert.equal(socket.emitted.length, 0, 'chưa gửi khi còn trường');
  assert.ok(rows(sent).some((r) => r.text === 'Giọng văn (2/3)'));
  assert.deepEqual(lastChoices(sent), [{ id: 'formal', text: 'Trang trọng' }, { id: 'casual', text: 'Thân mật' }]);

  await chat.reply('vui vẻ');
  assert.equal(rows(sent).at(-1).role, ChatRole.ERROR, 'trường có lựa chọn: chữ không khớp nút thì báo chọn lại');
  await chat.choose('casual');
  assert.ok(rows(sent).some((r) => r.role === ChatRole.USER && r.text === 'Thân mật'));
  assert.ok(rows(sent).some((r) => r.text === 'Ghi chú (3/3) (không bắt buộc)'));
  assert.deepEqual(lastChoices(sent), [{ id: FORM_SKIP_ID, text: 'Bỏ qua' }]);

  await chat.choose(FORM_SKIP_ID);
  assert.equal(socket.emitted.length, 1);
  const p = socket.emitted[0].payload;
  assert.deepEqual(p.fields, { to: 'an@aivin.vn', tone: 'casual' });
  assert.equal(p.reply_id, 'f1');
  assert.equal(p.session_id, 's1');
  assert.equal(p.text, 'Người nhận: an@aivin.vn\nGiọng văn: casual');
  assert.equal(p.option_ids, undefined);
  assert.equal(chat.hasPending(), false);
  assert.deepEqual(pending, [true, false]);
});

test('biểu mẫu một trường: không thêm dòng tên trường, `text` = giá trị (BE cũ chưa nhận `fields` vẫn hiểu)', async () => {
  const { chat, sent, socket } = setup();
  notify(chat, { reply_id: 'f2', kind: 'form', question: 'Thư mục dự án?', fields: [{ name: 'answer', label: 'Câu trả lời', required: true }] });
  assert.ok(!rows(sent).some((r) => r.text.includes('Câu trả lời')));
  await chat.reply('D:\\du-an');
  assert.deepEqual(socket.emitted[0].payload.fields, { answer: 'D:\\du-an' });
  assert.equal(socket.emitted[0].payload.text, 'D:\\du-an');
  assert.equal(rows(sent).filter((r) => r.role === ChatRole.USER && r.text === 'D:\\du-an').length, 1, 'dòng của chủ máy hiện một lần');
});

test('BE từ chối biểu mẫu (invalid_answer) → hỏi lại từ trường đầu; gửi lại được', async () => {
  let n = 0;
  const { chat, sent, socket } = setup(() => (++n === 1 ? { ok: false, error: 'invalid_answer' } : { ok: true }));
  notify(chat, { reply_id: 'f3', kind: 'form', question: 'Thông tin?', fields: [{ name: 'a', label: 'A', required: true }, { name: 'b', label: 'B', required: true }] });
  await chat.reply('1');
  await chat.reply('2');
  assert.equal(socket.emitted.length, 1);
  assert.equal(chat.hasPending(), true);
  assert.equal(rows(sent).filter((r) => r.text === 'A (1/2)').length, 2, 'hỏi lại trường đầu');
  await chat.reply('3');
  await chat.reply('4');
  assert.deepEqual(socket.emitted[1].payload.fields, { a: '3', b: '4' });
  assert.equal(chat.hasPending(), false);
});

test('gõ tên nút hoặc "bỏ qua" cũng được ở trường biểu mẫu', async () => {
  const { chat, socket } = setup();
  notify(chat, { reply_id: 'f4', kind: 'form', question: 'Q', fields: [FORM.fields[1], FORM.fields[2]] });
  await chat.reply('trang trọng');
  await chat.reply('Bỏ qua');
  assert.deepEqual(socket.emitted[0].payload.fields, { tone: 'formal' });
});
