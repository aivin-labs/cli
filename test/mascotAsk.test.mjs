import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascotChat, ChatRole, AskCommand, VoiceCommand, VoiceState } = await import('../bin/lib/remote/mascot/ask.mjs');
const { hostScript } = await import('../bin/lib/remote/mascot/index.mjs');
const { MASCOT_XAML } = await import('../bin/lib/remote/mascot/hostSource.mjs');

/** Socket giả: ghi lại các lần gửi, trả ack theo `reply(event, payload)`. */
function fakeSocket(reply, { connected = true } = {}) {
  const emitted = [];
  return {
    emitted,
    connected,
    timeout() { return this; },
    async emitWithAck(event, payload) { emitted.push({ event, payload }); return reply(event, payload); },
  };
}

function setup(reply, opts, extra = {}) {
  const sent = [];
  const socket = fakeSocket(reply, opts);
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', ...extra });
  return { chat, sent, socket };
}

const rows = (sent) => sent.filter((c) => c.t === AskCommand.CHAT);

test('hỏi: hiện câu của chủ máy + dòng "đang trả lời", gửi device:chat; tiến trình cập nhật đúng một dòng; câu trả lời xoá dòng đó', async () => {
  const { chat, sent, socket } = setup(() => ({ ok: true, session_id: 's1' }));
  await chat.ask('  Tóm tắt email hôm nay  ');
  const rid = socket.emitted[0].payload.request_id;
  assert.equal(socket.emitted[0].event, 'device:chat');
  assert.equal(socket.emitted[0].payload.text, 'Tóm tắt email hôm nay');
  assert.ok(rows(sent).some((r) => r.role === ChatRole.USER && r.text === 'Tóm tắt email hôm nay'));
  assert.ok(sent.some((c) => c.t === AskCommand.BUSY && c.busy === true));
  chat.onChatEvent({ request_id: rid, kind: 'progress', text: 'Đang đọc Gmail…' });
  chat.onChatEvent({ request_id: 'cau-khac', kind: 'answer', text: 'không phải của tôi' });
  chat.onChatEvent({ request_id: rid, kind: 'answer', text: 'Có 6 email.' });
  const progress = rows(sent).filter((r) => r.id === 'progress');
  assert.equal(progress.at(-1).remove, true, 'dòng tiến trình bị gỡ khi có câu trả lời');
  assert.ok(progress.some((r) => r.text === 'Đang đọc Gmail…'));
  assert.ok(rows(sent).some((r) => r.role === ChatRole.ASSISTANT && r.text === 'Có 6 email.'));
  assert.ok(!rows(sent).some((r) => r.text === 'không phải của tôi'));
  assert.deepEqual(sent.filter((c) => c.t === AskCommand.BUSY).at(-1), { t: AskCommand.BUSY, busy: false });
  assert.equal(chat.busy(), false);
});

test('đang chờ câu trước thì câu mới không gửi; máy chủ báo bận / tắt → báo lỗi bằng chữ của máy, không treo', async () => {
  const busy = setup(() => ({ ok: true }));
  await busy.chat.ask('câu 1');
  await busy.chat.ask('câu 2');
  assert.equal(busy.socket.emitted.length, 1);

  const refused = setup(() => ({ ok: false, error: 'disabled' }));
  await refused.chat.ask('câu 1');
  assert.ok(rows(refused.sent).some((r) => r.role === ChatRole.ERROR && /tạm tắt/.test(r.text)));
  assert.equal(refused.chat.busy(), false);
});

test('chưa nối máy chủ → báo ngay, không gửi; máy chủ cũ không hiểu sự kiện (hết giờ ack) → báo cần bản Aivin mới', async () => {
  const offline = setup(() => ({ ok: true }), { connected: false });
  await offline.chat.ask('xin chào');
  assert.equal(offline.socket.emitted.length, 0);
  assert.ok(rows(offline.sent).some((r) => r.role === ChatRole.ERROR));

  const old = setup(() => { throw new Error('operation has timed out'); });
  await old.chat.ask('xin chào');
  assert.ok(rows(old.sent).some((r) => r.role === ChatRole.ERROR && /bản Aivin mới/.test(r.text)));
});

/** Socket giả cho nói chuyện: ghi cả `emit` thường (âm thanh, dừng, ngắt lời). */
function voiceSetup(reply = () => ({ ok: true, session_id: 's1' }), opts, extra) {
  const s = setup(reply, opts, extra);
  s.socket.plain = [];
  s.socket.emit = (event, payload) => s.socket.plain.push({ event, payload });
  return s;
}
const ofType = (sent, t) => sent.filter((c) => c.t === t);

test('nói chuyện: bấm mic → device:voice_start; ready → cửa sổ mở mic/loa đúng tần số; mic chỉ đi lên sau ready', async () => {
  const { chat, sent, socket } = voiceSetup();
  chat.voiceAudio('AAAA');
  await chat.voiceStart();
  assert.equal(socket.emitted[0].event, 'device:voice_start');
  chat.voiceAudio('AAAA');
  assert.equal(socket.plain.length, 0, 'chưa ready thì bỏ đoạn mic');
  chat.onVoiceEvent({ kind: 'ready', input_sample_rate: 24000, output_sample_rate: 24000 });
  assert.deepEqual(ofType(sent, VoiceCommand.BEGIN), [{ t: VoiceCommand.BEGIN, in_rate: 24000, out_rate: 24000 }]);
  chat.voiceAudio('BBBB');
  assert.deepEqual(socket.plain, [{ event: 'device:voice_audio', payload: { audio: 'BBBB' } }]);
  assert.equal(chat.busy(), true, 'đang nói chuyện thì không nhận câu gõ');
});

test('nói chuyện: chữ người nói cập nhật một dòng tới khi chốt; chữ bot ghép dần; tiếng bot chuyển xuống cửa sổ; nói chen → bỏ tiếng chưa phát', async () => {
  const { chat, sent } = voiceSetup();
  await chat.voiceStart();
  chat.onVoiceEvent({ kind: 'ready' });
  chat.onVoiceEvent({ kind: 'user_transcript', text: 'mở', final: false });
  chat.onVoiceEvent({ kind: 'user_transcript', text: 'mở báo cáo', final: true });
  const users = rows(sent).filter((r) => r.role === ChatRole.USER);
  assert.equal(new Set(users.map((r) => r.id)).size, 1);
  assert.equal(users.at(-1).text, 'mở báo cáo');
  assert.equal(ofType(sent, VoiceCommand.STATE).at(-1).state, VoiceState.THINKING);

  chat.onVoiceEvent({ kind: 'assistant_transcript', text: 'Đây ', final: false });
  chat.onVoiceEvent({ kind: 'assistant_transcript', text: 'là báo cáo', final: false });
  chat.onVoiceEvent({ kind: 'audio', audio: 'CCCC' });
  chat.onVoiceEvent({ kind: 'audio', audio: 'DDDD' });
  const bots = rows(sent).filter((r) => r.role === ChatRole.ASSISTANT);
  assert.equal(bots.at(-1).text, 'Đây là báo cáo');
  assert.deepEqual(ofType(sent, VoiceCommand.PLAY).map((c) => c.audio), ['CCCC', 'DDDD']);
  assert.equal(ofType(sent, VoiceCommand.STATE).filter((c) => c.state === VoiceState.SPEAKING).length, 1);

  chat.onVoiceEvent({ kind: 'speech_started' });
  assert.equal(ofType(sent, VoiceCommand.FLUSH).length, 1);
  assert.equal(ofType(sent, VoiceCommand.STATE).at(-1).state, VoiceState.LISTENING);
  chat.onVoiceEvent({ kind: 'assistant_transcript', text: 'Câu mới', final: true });
  assert.notEqual(rows(sent).filter((r) => r.role === ChatRole.ASSISTANT).at(-1).id, bots.at(-1).id, 'lượt mới một dòng mới');
});

test('nói chuyện: ngắt lời chỉ gửi khi bot đang nói; bấm kết thúc → device:voice_stop; BE đóng vì im lặng / rớt mạng → báo cửa sổ dừng', async () => {
  const { chat, sent, socket } = voiceSetup();
  await chat.voiceStart();
  chat.onVoiceEvent({ kind: 'ready' });
  chat.voiceInterrupt();
  assert.equal(socket.plain.length, 0, 'bot im thì không gửi ngắt lời');
  chat.onVoiceEvent({ kind: 'audio', audio: 'AAAA' });
  chat.voiceInterrupt();
  assert.deepEqual(socket.plain.map((e) => e.event), ['device:voice_interrupt']);
  chat.voiceStop();
  assert.deepEqual(socket.plain.map((e) => e.event), ['device:voice_interrupt', 'device:voice_stop']);
  assert.equal(chat.busy(), false);
  assert.equal(ofType(sent, VoiceCommand.END).length, 0, 'cửa sổ tự dừng, không báo lại');

  const idle = voiceSetup();
  await idle.chat.voiceStart();
  idle.chat.onVoiceEvent({ kind: 'closed', reason: 'idle_timeout' });
  assert.match(ofType(idle.sent, VoiceCommand.END)[0].text, /im lặng/);

  const dropped = voiceSetup();
  await dropped.chat.voiceStart();
  dropped.chat.voiceDisconnected();
  assert.match(ofType(dropped.sent, VoiceCommand.END)[0].text, /Chưa nối/);
});

test('BE cũ (không báo voice): mic ghi 16 kHz, bấm lần nữa → WAV qua device:stt → hỏi như câu gõ; quá ngắn → chỉ báo', async () => {
  const old = voiceSetup((event) => (event === 'device:stt' ? { ok: true, text: 'mở báo cáo quý 4' } : { ok: true }));
  old.chat.setVoiceSupported(false);
  await old.chat.voiceStart();
  assert.deepEqual(ofType(old.sent, VoiceCommand.BEGIN), [{ t: VoiceCommand.BEGIN, in_rate: 16000, out_rate: 24000, state: VoiceState.RECORDING }]);
  const second = Buffer.alloc(32000, 1).toString('base64');
  old.chat.voiceAudio(second);
  old.chat.voiceAudio(second);
  assert.equal(old.socket.plain.length, 0, 'không đẩy mic lên khi ghi');
  old.chat.voiceStop();
  await new Promise((r) => setImmediate(r));
  const stt = old.socket.emitted.find((e) => e.event === 'device:stt');
  assert.equal(stt.payload.audio.length, 44 + 64000);
  assert.equal(stt.payload.audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(stt.payload.audio.readUInt32LE(24), 16000);
  assert.equal(stt.payload.lang, 'vi');
  assert.equal(old.socket.emitted.at(-1).event, 'device:chat');
  assert.equal(old.socket.emitted.at(-1).payload.text, 'mở báo cáo quý 4');

  const short = voiceSetup();
  short.chat.setVoiceSupported(false);
  await short.chat.voiceStart();
  short.chat.voiceAudio(Buffer.alloc(3200).toString('base64'));
  short.chat.voiceStop();
  await new Promise((r) => setImmediate(r));
  assert.equal(short.socket.emitted.length, 0);
  assert.ok(short.sent.some((c) => c.t === AskCommand.STATUS && /ngắn/.test(c.text)));
});

/** Đồng hồ + hẹn giờ giả: `advance(ms)` chạy các hẹn giờ tới hạn. */
function fakeClock() {
  let at = 0;
  let jobs = [];
  return {
    now: () => at,
    timers: {
      setTimeout: (fn, ms) => { const j = { fn, due: at + ms }; jobs.push(j); return j; },
      clearTimeout: (j) => { jobs = jobs.filter((x) => x !== j); },
    },
    advance(ms) {
      const end = at + ms;
      for (;;) {
        const next = jobs.filter((j) => j.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        jobs = jobs.filter((j) => j !== next);
        at = next.due;
        next.fn();
      }
      at = end;
    },
  };
}

test('nói chuyện: im lặng 60 s (không ai nói, bot không nói) → tự kết thúc + device:voice_stop; đang chờ agent thì nới tới 3 phút', async () => {
  const clock = fakeClock();
  const quiet = voiceSetup(undefined, undefined, { now: clock.now, timers: clock.timers });
  await quiet.chat.voiceStart();
  quiet.chat.onVoiceEvent({ kind: 'ready' });
  clock.advance(45_000);
  quiet.chat.onVoiceEvent({ kind: 'speech_started' });
  clock.advance(45_000);
  assert.equal(ofType(quiet.sent, VoiceCommand.END).length, 0, 'có người nói giữa chừng → tính lại');
  clock.advance(20_000);
  assert.match(ofType(quiet.sent, VoiceCommand.END)[0].text, /im lặng/);
  assert.deepEqual(quiet.socket.plain.map((e) => e.event), ['device:voice_stop']);

  const clock2 = fakeClock();
  const waiting = voiceSetup(undefined, undefined, { now: clock2.now, timers: clock2.timers });
  await waiting.chat.voiceStart();
  waiting.chat.onVoiceEvent({ kind: 'ready' });
  waiting.chat.onVoiceEvent({ kind: 'user_transcript', text: 'tổng hợp email tuần này', final: true });
  clock2.advance(150_000);
  assert.equal(ofType(waiting.sent, VoiceCommand.END).length, 0, 'agent đang làm → chưa cắt');
  clock2.advance(40_000);
  assert.equal(ofType(waiting.sent, VoiceCommand.END).length, 1);
});

test('nói chuyện: dòng tiến trình của agent hiện rồi mất khi bot trả lời; mất mic → kết thúc; đang ghi biên bản họp → không mở', async () => {
  const { chat, sent, socket } = voiceSetup();
  await chat.voiceStart();
  chat.onVoiceEvent({ kind: 'ready' });
  chat.onVoiceEvent({ kind: 'progress', text: 'Đang đọc Gmail…' });
  assert.ok(rows(sent).some((r) => r.role === ChatRole.PROGRESS && r.text === 'Đang đọc Gmail…'));
  chat.onVoiceEvent({ kind: 'assistant_transcript', text: 'Có 6 email', final: true });
  assert.equal(rows(sent).filter((r) => r.role === ChatRole.PROGRESS).at(-1).remove, true);
  chat.voiceMicLost();
  assert.match(ofType(sent, VoiceCommand.END)[0].text, /micro/);
  assert.deepEqual(socket.plain.map((e) => e.event), ['device:voice_stop']);
  assert.equal(chat.inCall(), false);

  const meeting = voiceSetup(undefined, undefined, { micBusy: () => true });
  await meeting.chat.voiceStart();
  assert.equal(meeting.socket.emitted.length, 0);
  assert.match(ofType(meeting.sent, VoiceCommand.END)[0].text, /biên bản họp/);
});

test('nói chuyện: BE nhận ADPCM → mic đi lên nhị phân (nhỏ ~4 lần), tiếng bot ADPCM giải về PCM cho cửa sổ; BE cũ (không trả codec) → PCM base64', async () => {
  const { createAdpcmEncoder } = await import('../bin/lib/remote/mascot/adpcm.mjs');
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
  const nu = voiceSetup((event) => (event === 'device:voice_start' ? { ok: true, session_id: 's1', codec: 'ima-adpcm' } : { ok: true }));
  await nu.chat.voiceStart();
  assert.equal(nu.socket.emitted[0].payload.codec, 'ima-adpcm');
  nu.chat.onVoiceEvent({ kind: 'ready' });
  nu.chat.voiceAudio(pcm.toString('base64'));
  const up = nu.socket.plain[0].payload.audio;
  assert.ok(Buffer.isBuffer(up) && up.length === 804, 'ADPCM: 4 byte đầu + 800 byte');
  nu.chat.onVoiceEvent({ kind: 'audio', audio: createAdpcmEncoder()(pcm), codec: 'ima-adpcm' });
  const played = Buffer.from(ofType(nu.sent, VoiceCommand.PLAY)[0].audio, 'base64');
  assert.equal(played.length, 3200);

  const old = voiceSetup();
  await old.chat.voiceStart();
  old.chat.onVoiceEvent({ kind: 'ready' });
  old.chat.voiceAudio('QUJD');
  assert.equal(old.socket.plain[0].payload.audio, 'QUJD');
  nu.chat.voiceStop();
  old.chat.voiceStop();
});

test('nói chuyện: chưa nối / BE từ chối / lỗi phiên → báo bằng chữ, không treo', async () => {
  const offline = voiceSetup(undefined, { connected: false });
  await offline.chat.voiceStart();
  assert.equal(offline.socket.emitted.length, 0);

  const refused = voiceSetup(() => ({ ok: false, error: 'disabled' }));
  await refused.chat.voiceStart();
  assert.match(ofType(refused.sent, VoiceCommand.END)[0].text, /tạm tắt/);
  assert.equal(refused.chat.busy(), false);

  const failed = voiceSetup();
  await failed.chat.voiceStart();
  failed.chat.onVoiceEvent({ kind: 'error', message: 'Model này chưa có giọng nói' });
  assert.equal(ofType(failed.sent, VoiceCommand.END)[0].text, 'Model này chưa có giọng nói');
  assert.deepEqual(failed.socket.plain.map((e) => e.event), ['device:voice_stop']);
});

test('host.ps1 có ô hỏi chèn đúng dấu, vẫn toàn ASCII; XAML có đủ khung ô hỏi + viền xoay; ô hỏi hiện khi rê chuột', () => {
  const script = hostScript();
  assert.ok(!script.includes('# @ASK_HOOK') && script.includes('function MascotClick { if ($script:askFocused)'));
  // Rê chuột vào bot → hiện ô (chưa lấy bàn phím); rời cửa sổ → hẹn ẩn; bấm ra ngoài → trả bàn phím.
  assert.ok(script.includes("(E 'Mascot').Add_MouseEnter(") && script.includes('$w.Add_MouseLeave(') && script.includes('$w.Add_Deactivated('));
  assert.ok([...script].every((c) => c.charCodeAt(0) < 128));
  // Nói chuyện: mic / loa C# trong cùng khối Add-Type, Input chặn dòng âm thanh, stdout chung một khoá; không còn ghi WAV bằng MCI.
  assert.ok(script.includes('public static class Voice') && script.includes('if (!Voice.Take(line)) Lines.Enqueue(line);'));
  assert.ok(script.includes('[AivinMascot.Output]::Line(') && !script.includes('mciSendString'));
  // Bộ khử tiếng vọng (Voice Capture DSP) + phím tắt nói chuyện + mặt bot theo trạng thái nói chuyện.
  assert.ok(script.includes('public sealed class Aec') && script.includes('RegisterHotKey($script:hwnd') && script.includes("'speaking' { 'speaking' }"));
  for (const name of ['x:Name="Ask"', 'x:Name="AskBox"', 'x:Name="MicBtn"', 'x:Name="MicIcon"', 'x:Name="SendIcon"', 'x:Name="AskGlowSpin"', 'x:Key="AskGlow"']) {
    assert.ok(MASCOT_XAML.includes(name), name);
  }
});

const { showMascotUi, UiResult } = await import('../bin/lib/remote/mascot/ui.mjs');
const { createMascot } = await import('../bin/lib/remote/mascot/index.mjs');

function uiDeps(over = {}) {
  const calls = [];
  const deps = {
    lockHolder: () => null, loadDeviceCredentials: () => ({ device_id: 'd' }), requestMascotShow: () => calls.push('request'),
    saveMascotSettings: (p) => calls.push(`settings:${p.enabled}`), startDaemon: () => calls.push('start'), ...over,
  };
  return { deps, calls };
}

test('aivin ui: daemon đang chạy → chỉ bật + ghi yêu cầu hiện; chưa chạy → khởi động rồi chờ nhận việc; chưa ghép / không phải Windows → báo', async () => {
  const running = uiDeps({ lockHolder: () => 1234 });
  assert.equal(await showMascotUi({ platform: 'win32', deps: running.deps }), UiResult.SHOWN);
  assert.deepEqual(running.calls, ['settings:true', 'request']);

  let up = false;
  const idle = uiDeps({ lockHolder: () => (up ? 99 : null), startDaemon: () => { up = true; } });
  let starting = 0;
  assert.equal(await showMascotUi({ platform: 'win32', deps: idle.deps, sleep: async () => {}, onStarting: () => starting++ }), UiResult.STARTED);
  assert.equal(starting, 1);

  assert.equal(await showMascotUi({ platform: 'win32', deps: uiDeps({ loadDeviceCredentials: () => null }).deps }), UiResult.NOT_PAIRED);
  assert.equal(await showMascotUi({ platform: 'win32', deps: uiDeps({ startDaemon: () => {} }).deps, sleep: async () => {} }), UiResult.START_FAILED);
  assert.equal(await showMascotUi({ platform: 'linux', deps: uiDeps().deps }), UiResult.UNSUPPORTED);
});

test('linh vật đã tắt: daemon không mở cửa sổ, `aivin ui` (tệp yêu cầu) đánh thức → mở cửa sổ + mở ô hỏi khi sẵn sàng', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-ui-'));
  const settingsFile = path.join(dir, 'mascot.json');
  const showFile = path.join(dir, 'show');
  fs.writeFileSync(settingsFile, JSON.stringify({ enabled: false }));
  const spawned = [];
  const { PassThrough } = await import('stream');
  const { EventEmitter } = await import('events');
  const spawnImpl = () => {
    const c = new EventEmitter();
    c.sent = [];
    c.stdin = { write: (s) => c.sent.push(...String(s).trim().split('\n').map((l) => JSON.parse(l))), end: () => {}, on: () => {} };
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = () => {};
    spawned.push(c);
    return c;
  };
  const m = createMascot({ platform: 'win32', env: { AIVIN_LANG: 'vi' }, spawnImpl, dir: path.join(dir, 'host'), settingsFile, showFile });
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(spawned.length, 0, 'đang tắt → không mở cửa sổ');
  fs.writeFileSync(showFile, 'x');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(spawned.length, 1, 'yêu cầu hiện → mở cửa sổ');
  spawned[0].stdout.write('{"t":"ready"}\n');
  await new Promise((r) => setImmediate(r));
  assert.ok(spawned[0].sent.some((c) => c.t === 'open_ask'));
  m.close();
});

test('màn hình: cửa sổ chủ máy đang dùng đi kèm câu hỏi / nói chuyện (context.window); bấm nút giữ cửa sổ cũ; lượt không từ ô hỏi thì không có', async () => {
  const win = { window: '0x1a2b', title: 'Bao cao.xlsx - Excel', process: 'EXCEL' };
  const { chat, socket } = setup(() => ({ ok: true, session_id: 's1' }));
  await chat.reply('cái này lỗi gì?', win);
  assert.deepEqual(socket.emitted[0].payload.context, { window: win });
  assert.deepEqual(chat.userWindow(), win);
  const rid = socket.emitted[0].payload.request_id;
  chat.onChatEvent({ request_id: rid, kind: 'needs_input', session_id: 's1', text: 'Sửa ô nào?', question: { reply_id: 'q1', kind: 'choice', options: [{ id: 'a', text: 'A1' }] } });
  await chat.choose('a');
  assert.deepEqual(socket.emitted[1].payload.context, { window: win }, 'bấm nút trả lời: vẫn cửa sổ đó');
  chat.onChatEvent({ request_id: socket.emitted[1].payload.request_id, kind: 'answer', text: 'xong' });
  await chat.ask('tóm tắt cuộc họp');
  assert.equal(socket.emitted[2].payload.context, undefined);
  assert.equal(chat.userWindow(), null);

  const v = voiceSetup();
  await v.chat.voiceStart(win);
  assert.deepEqual(v.socket.emitted[0], { event: 'device:voice_start', payload: { context: { window: win }, codec: 'ima-adpcm' } });
});
