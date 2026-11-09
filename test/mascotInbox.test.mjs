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

test('khách cần nhân viên: mức Min / Mid không hiện, không xác nhận; Max hiện đúng tiêu đề, không gắn nhãn "Cần bạn" / "Xong"', () => {
  const notice = { id: 'widget_handoff:s9:1', kind: 'customer', title: 'Khách trên shop.vn muốn gặp nhân viên', text: 'Minh: Hoàn tiền đơn 123. Bấm để mở hội thoại và trả lời.', session_id: 's9' };
  const make = (notifyFreq) => {
    const sent = [];
    const emitted = [];
    const alerts = [];
    const socket = { connected: true, timeout() { return this; }, emit(event, payload) { emitted.push({ event, payload }); } };
    const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), onAlert: (a) => alerts.push(a), lang: 'vi', notifyFreq });
    chat.setServerFeatures([ServerFeature.INBOX]);
    chat.onNotify(notice);
    return { sent, emitted, alerts };
  };
  for (const level of [0, 1]) {
    const { sent, emitted, alerts } = make(level);
    assert.equal(rows(sent).length, 0, `mức ${level} không hiện dòng`);
    assert.equal(alerts.length, 0, `mức ${level} không bật bong bóng`);
    assert.deepEqual(acked(emitted), [], `mức ${level} không xác nhận`);
  }
  const { sent, alerts } = make(2);
  assert.equal(rows(sent)[0].text, `${notice.title}\n${notice.text}`);
  assert.equal(alerts[0].kind, 'customer');
  assert.equal(alerts[0].text, notice.title);
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

test('việc chờ duyệt của kênh canh (không gắn phiên): nút Duyệt gửi / Bỏ qua + mở hội thoại; bấm → device:chat chỉ reply_id + option_ids; kiểm câu hỏi gửi cả mục không phiên', async () => {
  const sent = [];
  const emitted = [];
  let closed = [];
  const socket = {
    connected: true, timeout() { return this; }, emit() {},
    async emitWithAck(event, payload) { emitted.push({ event, payload }); return event === DeviceEvent.QUESTIONS ? { ok: true, closed } : { ok: true }; },
  };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi' });
  chat.setServerFeatures([ServerFeature.INBOX]);
  const question = { reply_id: 'watch-draft:d1', kind: 'choice', question: 'x', options: [{ id: 'approve', text: 'Duyệt gửi', icon: 'check' }, { id: 'discard', text: 'Bỏ qua', icon: 'x' }] };
  chat.onNotify({
    id: 'n1', kind: 'needs_you', title: 'Kênh FB: có việc chờ bạn duyệt', text: 'Hằng: “alo”\nAI định trả lời: “Dạ em đây”', question,
    links: [{ text: 'Mở hội thoại', url: 'https://www.facebook.com/messages/t/1', icon: 'external-link' }],
  });
  const choices = sent.filter((c) => c.t === AskCommand.CHOICES).at(-1);
  assert.deepEqual(choices.options.map((o) => [o.id, o.text]), [['approve', 'Duyệt gửi'], ['discard', 'Bỏ qua']]);
  const qRow = rows(sent).find((r) => r.id === 'q-watch-draft:d1');
  assert.equal(qRow.links[0].url, 'https://www.facebook.com/messages/t/1');

  await chat.checkQuestions();
  assert.deepEqual(emitted.at(-1).payload.items, [{ reply_id: 'watch-draft:d1' }]);

  await chat.choose('approve');
  const ask = emitted.find((e) => e.event === DeviceEvent.CHAT).payload;
  assert.equal(ask.reply_id, 'watch-draft:d1');
  assert.deepEqual(ask.option_ids, ['approve']);
  assert.equal(ask.session_id, undefined);
  chat.onChatEvent({ request_id: ask.request_id, kind: 'answer', text: 'Đã duyệt — đang gửi cho Hằng.' });
  assert.equal(chat.busy(), false);
  assert.equal(chat.hasPending(), false, 'duyệt xong → bỏ nút');
});

test('câu chỉ nhận nút: gõ chữ không khớp nút → câu hỏi mới, nút vẫn còn; gõ đúng tên nút → như bấm nút', async () => {
  const sent = [];
  const emitted = [];
  const socket = {
    connected: true, timeout() { return this; }, emit() {},
    async emitWithAck(event, payload) { emitted.push({ event, payload }); return { ok: true, request_id: payload.request_id }; },
  };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi' });
  chat.onNotify({ id: 'n1', kind: 'needs_you', title: 'A', text: 'a', question: { reply_id: 'watch-draft:d1', kind: 'choice', question: 'x', buttons_only: true, options: [{ id: 'discard', text: 'Bỏ qua' }] } });

  await chat.reply('thời tiết hôm nay sao');
  const first = emitted.at(-1).payload;
  assert.equal(first.reply_id, undefined, 'không gửi như câu trả lời');
  assert.equal(chat.hasPending(), true, 'nút vẫn còn');
  chat.onChatEvent({ request_id: first.request_id, kind: 'answer', text: 'Nắng' });

  await chat.reply('bỏ qua');
  assert.equal(emitted.at(-1).payload.reply_id, 'watch-draft:d1');
  assert.deepEqual(emitted.at(-1).payload.option_ids, ['discard']);
});

test('BE báo câu hỏi đã xử lý nơi khác (device:question_closed) → bỏ nút ngay; câu chính máy này đang trả lời thì không báo "nơi khác"', async () => {
  const sent = [];
  let release;
  const socket = {
    connected: true, timeout() { return this; }, emit() {},
    emitWithAck: () => new Promise((r) => { release = r; }),
  };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi' });
  const q = (id) => ({ reply_id: id, kind: 'choice', question: 'x', options: [{ id: 'approve', text: 'Duyệt gửi' }] });
  chat.onNotify({ id: 'n1', kind: 'needs_you', title: 'A', text: 'a', question: q('watch-draft:d1') });
  chat.onNotify({ id: 'n2', kind: 'needs_you', title: 'B', text: 'b', question: q('watch-draft:d2') });
  chat.onQuestionClosed({ reply_ids: ['watch-draft:d2', 'không-có'] });
  assert.equal(chat.hasPending(), true, 'd1 còn');
  assert.equal(rows(sent).at(-1).text, 'Câu hỏi này đã được trả lời ở nơi khác');

  const pending = chat.choose('approve');
  const before = rows(sent).length;
  chat.onQuestionClosed({ reply_ids: ['watch-draft:d1'] });
  assert.equal(rows(sent).slice(before).some((r) => r.text === 'Câu hỏi này đã được trả lời ở nơi khác'), false, 'máy này vừa bấm');
  release({ ok: true });
  await pending;
  assert.equal(chat.hasPending(), false);
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
