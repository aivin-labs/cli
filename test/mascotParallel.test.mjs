import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascotChat, ChatRole, AskCommand } = await import('../bin/lib/remote/mascot/ask.mjs');

function setup(features) {
  const sent = [];
  const emitted = [];
  const socket = { connected: true, timeout() { return this; }, async emitWithAck(event, payload) { emitted.push({ event, payload }); return { ok: true, session_id: payload.parallel ? 'sp' : 's1' }; } };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi' });
  chat.setServerFeatures(features);
  return { chat, sent, emitted };
}

test('04/11/2026 — BE có chat_parallel: câu mới lúc lượt trước còn chạy được giao song song, không chiếm ô hỏi của lượt chính', async () => {
  const { chat, sent, emitted } = setup(['inbox', 'chat_cancel', 'chat_parallel']);
  await chat.ask('Soạn báo cáo tuần');
  const main = emitted[0].payload.request_id;
  await chat.ask('Tra giá vàng hôm nay');
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].payload.parallel, true);
  assert.notEqual(emitted[1].payload.request_id, main);
  assert.ok(sent.some((c) => c.t === AskCommand.CHAT && c.role === ChatRole.USER && c.text === 'Tra giá vàng hôm nay'));
  assert.ok(sent.some((c) => c.t === AskCommand.CHAT && c.role === ChatRole.ASSISTANT && /song song/.test(c.text)));
  // Lượt chính vẫn nhận câu trả lời của nó.
  assert.equal(chat.busy(), true);
  chat.onChatEvent({ request_id: main, kind: 'answer', text: 'Báo cáo xong.' });
  assert.ok(sent.some((c) => c.t === AskCommand.CHAT && c.text === 'Báo cáo xong.'));
  assert.equal(chat.busy(), false);
});

test('BE cũ (không có chat_parallel): vẫn báo bận như trước, không gửi', async () => {
  const { chat, emitted } = setup(['inbox']);
  await chat.ask('câu 1');
  await chat.ask('câu 2');
  assert.equal(emitted.length, 1);
});
