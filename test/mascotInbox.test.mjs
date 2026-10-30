import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascotChat, ChatRole, AskCommand } = await import('../bin/lib/remote/mascot/ask.mjs');
const { DeviceEvent, ServerFeature } = await import('../bin/lib/remote/constants.mjs');

/** Socket giả: `emit` (không ack) và `emitWithAck` ghi lại; ack theo `reply(event, payload)`. */
function setup(reply = () => ({ ok: true }), features = [ServerFeature.INBOX, ServerFeature.CHAT_CANCEL]) {
  const sent = [];
  const emitted = [];
  const socket = {
    connected: true,
    timeout() { return this; },
    emit(event, payload) { emitted.push({ event, payload }); },
    async emitWithAck(event, payload) { emitted.push({ event, payload }); return reply(event, payload); },
  };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi' });
  chat.setServerFeatures(features);
  return { chat, sent, emitted };
}

const rows = (sent) => sent.filter((c) => c.t === AskCommand.CHAT);
const acked = (emitted) => emitted.filter((e) => e.event === DeviceEvent.NOTIFY_ACK).flatMap((e) => e.payload.ids);
const QUESTION = { reply_id: 'q1', kind: 'choice', question: 'Gửi chưa?', options: [{ id: 'y', text: 'Gửi' }] };

test('hộp báo: nối lại → lấy báo lỡ lúc offline, hiện + xác nhận từng báo; báo đã nhận (cả qua notice_id của câu chốt) thì bỏ trùng', async () => {
  const { chat, sent, emitted } = setup((event) => (event === DeviceEvent.INBOX
    ? { ok: true, notices: [{ id: 'chat:a1', kind: 'done', title: 'Việc A', text: 'Xong A' }, { id: 'n2', kind: 'failed', title: 'Việc B', text: 'Lỗi B' }] }
    : { ok: true }));
  await chat.ask('Việc A');
  const rid = emitted.find((e) => e.event === DeviceEvent.CHAT).payload.request_id;
  chat.onChatEvent({ request_id: rid, kind: 'answer', text: 'Xong A', notice_id: 'chat:a1' });
  assert.deepEqual(acked(emitted), ['chat:a1'], 'câu chốt xác nhận notice_id ngay');

  await chat.syncInbox();
  assert.equal(rows(sent).filter((r) => r.text.includes('Xong A')).length, 1, 'câu chốt đã hiện → báo cùng id trong hộp không hiện lại');
  assert.ok(rows(sent).some((r) => r.role === ChatRole.ERROR && r.text.includes('Lỗi B')));
  assert.deepEqual(acked(emitted), ['chat:a1', 'chat:a1', 'n2'], 'mọi báo trong hộp đều được xác nhận (kể cả bản trùng) để BE dọn');
});

test('BE cũ (không có inbox): không xin hộp báo, không gửi xác nhận, không kiểm câu hỏi', async () => {
  const { chat, emitted } = setup(() => ({ ok: true }), [ServerFeature.VOICE]);
  chat.onNotify({ id: 'n1', kind: 'needs_you', title: 'T', text: 'Q', session_id: 's1', question: QUESTION });
  await chat.syncInbox();
  await chat.checkQuestions();
  assert.deepEqual(emitted, []);
});

test('câu hỏi đã trả lời nơi khác: kiểm lúc nối lại → bỏ nút + ghim, báo một dòng; câu còn chờ thì giữ', async () => {
  const pendingFlags = [];
  const sent = [];
  const emitted = [];
  let closed = [];
  const socket = {
    connected: true, timeout() { return this; }, emit() {},
    async emitWithAck(event, payload) { emitted.push({ event, payload }); return event === DeviceEvent.QUESTIONS ? { ok: true, closed } : { ok: true, notices: [] }; },
  };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onPending: (on) => pendingFlags.push(on) });
  chat.setServerFeatures([ServerFeature.INBOX]);
  chat.onNotify({ id: 'n1', kind: 'needs_you', title: 'T', text: 'Q1', session_id: 's1', question: QUESTION });
  chat.onNotify({ id: 'n2', kind: 'needs_you', title: 'T', text: 'Q2', session_id: 's2', question: { ...QUESTION, reply_id: 'q2' } });

  await chat.syncInbox();
  assert.deepEqual(emitted.at(-1).payload.items, [{ session_id: 's1', reply_id: 'q1' }, { session_id: 's2', reply_id: 'q2' }]);
  assert.equal(chat.hasPending(), true, 'chưa câu nào đóng');

  closed = ['q1'];
  await chat.checkQuestions();
  assert.equal(chat.hasPending(), true, 'q2 còn chờ');
  assert.ok(rows(sent).some((r) => r.text === 'Câu hỏi này đã được trả lời ở nơi khác'));
  closed = ['q2'];
  await chat.checkQuestions();
  assert.equal(chat.hasPending(), false);
  assert.deepEqual(pendingFlags, [true, false], 'hết câu hỏi → bỏ ghim');
});

test('nút dừng: chat_busy báo cancel khi BE dừng được; bấm → device:chat_cancel đúng lượt; BE báo cancelled → "Đã dừng", ô hỏi rảnh', async () => {
  const { chat, sent, emitted } = setup();
  await chat.ask('Việc dài');
  assert.deepEqual(sent.filter((c) => c.t === AskCommand.BUSY)[0], { t: AskCommand.BUSY, busy: true, cancel: true });
  const rid = emitted.find((e) => e.event === DeviceEvent.CHAT).payload.request_id;
  await chat.cancel();
  assert.deepEqual(emitted.at(-1), { event: DeviceEvent.CHAT_CANCEL, payload: { request_id: rid } });
  chat.onChatEvent({ request_id: rid, kind: 'error', text: 'cancelled' });
  assert.equal(chat.busy(), false);
  assert.equal(rows(sent).at(-1).text, 'Đã dừng');

  const old = setup(() => ({ ok: true }), []);
  await old.chat.ask('x');
  assert.deepEqual(old.sent.filter((c) => c.t === AskCommand.BUSY)[0], { t: AskCommand.BUSY, busy: true }, 'BE cũ: không có nút dừng');
  await old.chat.cancel();
  assert.ok(!old.emitted.some((e) => e.event === DeviceEvent.CHAT_CANCEL));
});

test('chat mới: BE mở phiên mới → xoá hội thoại trong ô hỏi, câu hỏi đang chờ hiện lại; đang bận / BE cũ → chỉ báo', async () => {
  const { chat, sent, emitted } = setup(() => ({ ok: true }), [ServerFeature.INBOX, ServerFeature.CHAT_NEW]);
  chat.onNotify({ id: 'n1', kind: 'needs_you', title: 'T', text: 'Q1', session_id: 's1', question: QUESTION });
  await chat.newChat();
  assert.equal(emitted.at(-1).event, DeviceEvent.CHAT_NEW);
  const clearAt = sent.findIndex((c) => c.t === AskCommand.CLEAR);
  assert.ok(clearAt >= 0);
  assert.ok(sent.slice(clearAt).some((c) => c.t === AskCommand.CHAT && c.id === 'q-q1'), 'câu hỏi đang chờ hiện lại sau khi xoá');
  assert.equal(sent.at(-1).text, 'Đã mở phiên chat mới');

  await chat.ask('Việc dài');
  const before = emitted.length;
  await chat.newChat();
  assert.equal(emitted.length, before, 'đang chờ lượt → không đổi phiên');

  const old = setup(() => ({ ok: true }), []);
  await old.chat.newChat();
  assert.deepEqual(old.emitted, []);
  assert.ok(!old.sent.some((c) => c.t === AskCommand.CLEAR));
});
