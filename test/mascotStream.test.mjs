import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascotChat, ChatRole, AskCommand } = await import('../bin/lib/remote/mascot/ask.mjs');

function setup() {
  const sent = [];
  const emitted = [];
  const socket = { connected: true, timeout() { return this; }, async emitWithAck(event, payload) { emitted.push({ event, payload }); return { ok: true }; } };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onAlert: () => {}, onPending: () => {} });
  return { chat, sent, emitted };
}

const rows = (sent) => sent.filter((c) => c.t === AskCommand.CHAT);
const assistantRows = (sent) => rows(sent).filter((r) => r.role === ChatRole.ASSISTANT);

test('chữ chạy: câu hỏi xin stream; delta cập nhật MỘT dòng (nhạt), bỏ "Đang nghĩ…"; câu chốt rút gọn thay đúng dòng đó', async () => {
  const { chat, sent, emitted } = setup();
  await chat.ask('Tóm tắt email hôm nay');
  assert.equal(emitted[0].payload.stream, true);
  const rid = emitted[0].payload.request_id;
  chat.onChatEvent({ request_id: rid, kind: 'delta', text: 'Hôm nay có' });
  chat.onChatEvent({ request_id: rid, kind: 'delta', text: 'Hôm nay có 3 email quan trọng' });
  const live = assistantRows(sent);
  assert.equal(new Set(live.map((r) => r.id)).size, 1, 'cùng một dòng');
  assert.deepEqual(live.map((r) => [r.text, r.partial]), [['Hôm nay có', true], ['Hôm nay có 3 email quan trọng', true]]);
  assert.ok(rows(sent).some((r) => r.role === ChatRole.PROGRESS && r.remove), 'bỏ dòng "Đang nghĩ…" khi chữ đầu tới');

  chat.onChatEvent({ request_id: rid, kind: 'answer', text: '3 email quan trọng: hợp đồng, lịch họp, hoá đơn.', more: true });
  const final = assistantRows(sent).at(-1);
  assert.equal(final.id, live[0].id, 'câu chốt thay đúng dòng chữ chạy');
  assert.equal(final.partial, undefined);
  assert.match(final.text, /^3 email quan trọng: hợp đồng, lịch họp, hoá đơn\. /);
  assert.equal(new Set(assistantRows(sent).map((r) => r.id)).size, 1, 'không thêm dòng trả lời thứ hai');
});

test('chữ chạy: câu hỏi lại / lỗi → bỏ dòng dở; hết giờ chờ → giữ phần đã viết; delta của câu cũ bị bỏ qua; không delta → như cũ', async () => {
  const a = setup();
  await a.chat.ask('x');
  const rid = a.emitted[0].payload.request_id;
  a.chat.onChatEvent({ request_id: rid, kind: 'delta', text: 'Mình cần hỏi' });
  a.chat.onChatEvent({ request_id: rid, kind: 'needs_input', text: 'Gửi cho ai?', session_id: 's', question: { reply_id: 'm', kind: 'text', question: 'Gửi cho ai?' } });
  const streamId = assistantRows(a.sent)[0].id;
  assert.ok(rows(a.sent).some((r) => r.id === streamId && r.remove), 'dòng dở bị bỏ khi chuyển sang câu hỏi');
  a.chat.onChatEvent({ request_id: rid, kind: 'delta', text: 'muộn' });
  assert.ok(!rows(a.sent).some((r) => r.text === 'muộn'), 'delta tới sau khi lượt xong bị bỏ qua');

  const b = setup();
  await b.chat.ask('việc dài');
  const rb = b.emitted[0].payload.request_id;
  b.chat.onChatEvent({ request_id: rb, kind: 'delta', text: 'Đang tổng hợp 120 tệp' });
  b.chat.onChatEvent({ request_id: rb, kind: 'timeout', text: 'Việc còn chạy trên Aivin' });
  const kept = assistantRows(b.sent);
  assert.equal(kept.at(-2).text, 'Đang tổng hợp 120 tệp');
  assert.equal(kept.at(-2).partial, undefined, 'phần đã viết thôi nhạt');
  assert.equal(kept.at(-1).text, 'Việc còn chạy trên Aivin');

  const c = setup();
  await c.chat.ask('2+2');
  c.chat.onChatEvent({ request_id: c.emitted[0].payload.request_id, kind: 'answer', text: '4' });
  assert.deepEqual(assistantRows(c.sent).map((r) => r.text), ['4']);
});

test('lượt im lặng quá lâu (sự kiện mất khi rớt mạng / BE khởi động lại) → thôi chờ, ô hỏi rảnh; câu trả lời tới muộn vẫn hiện', async () => {
  const sent = [];
  const emitted = [];
  const alerts = [];
  const pendingTimers = new Set();
  const timers = {
    setTimeout: (fn) => { const h = { fn }; pendingTimers.add(h); return h; },
    clearTimeout: (h) => pendingTimers.delete(h),
  };
  const fire = () => { const all = [...pendingTimers]; pendingTimers.clear(); all.forEach((h) => h.fn()); };
  const socket = { connected: true, timeout() { return this; }, async emitWithAck(event, payload) { emitted.push({ event, payload }); return { ok: true }; } };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', timers, onAlert: (a) => alerts.push(a) });

  await chat.ask('Việc A');
  const stale = emitted[0].payload.request_id;
  chat.onChatEvent({ request_id: stale, kind: 'delta', text: 'Đang viết' });
  fire();
  assert.equal(chat.busy(), false, 'ô hỏi rảnh lại');
  assert.ok(assistantRows(sent).some((r) => r.text === 'Đang viết' && !r.partial), 'giữ phần đã viết');
  assert.ok(assistantRows(sent).at(-1).text.startsWith('Chưa nghe Aivin trả lời'));

  await chat.ask('Việc B');
  const now = emitted[1].payload.request_id;
  chat.onChatEvent({ request_id: stale, kind: 'delta', text: 'chữ cũ' });
  chat.onChatEvent({ request_id: stale, kind: 'answer', text: 'Kết quả A' });
  assert.equal(chat.busy(), true, 'câu trả lời muộn không kết thúc lượt B');
  assert.ok(assistantRows(sent).some((r) => r.text === 'Kết quả A'));
  assert.ok(!rows(sent).some((r) => r.text === 'chữ cũ'));
  chat.onChatEvent({ request_id: now, kind: 'answer', text: 'Kết quả B' });
  assert.equal(chat.busy(), false);
  assert.deepEqual(alerts.map((a) => a.text), ['Kết quả A', 'Kết quả B']);
});

test('nút mở link: câu hỏi xin links; câu chốt kèm nút (lọc link lạ), thành phần không vẽ được thêm nút xem trên Aivin', async () => {
  const { chat, sent, emitted } = setup();
  await chat.ask('Mở trang đơn hàng');
  assert.equal(emitted[0].payload.links, true);
  chat.onChatEvent({
    request_id: emitted[0].payload.request_id, kind: 'answer', text: 'Đây bạn nhé 😊', session_id: 's1', rich: true,
    links: [{ text: 'Mở trang đơn hàng', url: 'https://shop.vn/orders' }, { text: 'Chạy lệnh', url: 'file:///c:/x.exe' }, { text: '', url: 'https://x.vn' }],
  });
  const final = assistantRows(sent).at(-1);
  assert.equal(final.text, 'Đây bạn nhé 😊');
  assert.deepEqual([final.links[0].text, final.links[0].url], ['Mở trang đơn hàng', 'https://shop.vn/orders']);
  assert.ok(final.links[0].icon_path);
  assert.equal(final.links.length, 2, 'bỏ link không phải http(s) và nút không tên');
  assert.match(final.links[1].url, /session_id=s1/);
  assert.equal(final.links[1].text, 'Xem đầy đủ trên Aivin');
});

test('nút mở link: câu trả lời thường không kèm trường links', async () => {
  const { chat, sent, emitted } = setup();
  await chat.ask('Chào');
  chat.onChatEvent({ request_id: emitted[0].payload.request_id, kind: 'answer', text: 'Chào bạn', session_id: 's1' });
  assert.equal(assistantRows(sent).at(-1).links, undefined);
});
