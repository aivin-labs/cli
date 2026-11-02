import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascot, HostCommand, MascotState } = await import('../bin/lib/remote/mascot/index.mjs');
const { Mood, MOOD_GESTURE, moodOf } = await import('../bin/lib/remote/mascot/mood.mjs');
const { BOT_FACES } = await import('../bin/lib/remote/mascot/bot.mjs');
const { MASCOT_PS1 } = await import('../bin/lib/remote/mascot/hostSource.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function readyMascot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-mascot-'));
  const host = fakeHost();
  const m = createMascot({
    platform: 'win32', env: { AIVIN_LANG: 'vi' }, spawnImpl: host.spawnImpl, dir: path.join(dir, 'host'), settingsFile: path.join(dir, 'mascot.json'),
    thinkMs: 30, resultMs: 30, mainThrottleMs: 0, restartDelaysMs: [10],
  });
  const child = host.spawned[0];
  child.send({ t: 'ready' });
  await sleep(20);
  return { m, child };
}

test('emoji cảm xúc → mood; lấy emoji cuối; bỏ code, dấu đầu dòng của danh sách, emoji không có nghĩa', () => {
  assert.equal(moodOf('Mình xin lỗi 😔, mình sẽ làm lại ngay.'), Mood.SAD);
  assert.equal(moodOf('Sorry about that 😢'), Mood.CRY);
  assert.equal(moodOf('Mình làm mất tệp của bạn rồi 😭'), Mood.CRY);
  assert.equal(moodOf('Oops, nhầm tệp rồi 😅'), Mood.SHEEPISH);
  assert.equal(moodOf('Xong rồi 🎉'), Mood.CELEBRATE);
  assert.equal(moodOf('Đã gửi thư ❤️'), Mood.HAPPY, 'bỏ ký tự biến thể FE0F');
  assert.equal(moodOf('Tuyệt 👍🏽'), Mood.HAPPY, 'bỏ màu da');
  assert.equal(moodOf('🎉 Đã xong 9 tệp. Tiếc là 1 tệp lỗi 😔'), Mood.SAD, 'nhiều emoji → giọng kết câu');
  assert.equal(moodOf('✅ Đọc tệp\n✅ Gửi thư\n🎉 Lưu bản nháp'), null, 'đầu dòng của danh sách không phải cảm xúc');
  assert.equal(moodOf('✅ Bước 1\n✅ Bước 2\nXong hết rồi 🥳'), Mood.CELEBRATE, 'danh sách vẫn đọc emoji cuối câu');
  assert.equal(moodOf('Chạy `echo 😔` là được'), null, 'mã nội dòng');
  assert.equal(moodOf('```\nlog 😢\n```\nĐã sửa xong.'), null, 'khối code');
  assert.equal(moodOf('Đã lưu ✅ 📄'), null, 'emoji không có trong bảng');
  assert.equal(moodOf('Không có emoji.'), null);
  assert.equal(moodOf(''), null);
  assert.equal(moodOf(undefined), null);
});

test('mọi mood có cử chỉ + nét mặt có thật trên bot; host.ps1 vẫn toàn ASCII', () => {
  for (const mood of Object.values(Mood)) {
    const g = MOOD_GESTURE[mood];
    assert.ok(g?.g && g.sec > 0, mood);
    assert.ok(BOT_FACES[g.face], `${mood}: nét mặt ${g.face}`);
  }
  assert.ok([...MASCOT_PS1].every((c) => c.charCodeAt(0) < 128));
});

test('ui --demo --moods: đi qua đủ 7 nét mặt bằng moodOf; buồn / ngượng không qua "xong"', async () => {
  const { DemoScope, MASCOT_DEMO_MOODS, showMascotDemo } = await import('../bin/lib/remote/mascot/ui.mjs');
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.sent = [];
  child.stdin = { write: (line) => child.sent.push(JSON.parse(String(line))), end: () => {} };
  let intervalFn = null;
  showMascotDemo({ platform: 'win32', scope: DemoScope.MOODS, deps: {
    writeHostFiles: () => 'C:\\preview', loadMascotSettings: () => ({ enabled: true }), spawn: () => child,
    setInterval: (fn) => { intervalFn = fn; return 1; }, clearInterval: () => {},
  } });
  child.stdout.write(`${JSON.stringify({ t: 'ready' })}\n`);
  await sleep(10);
  for (let i = 1; i < MASCOT_DEMO_MOODS.length; i++) intervalFn();
  const gestures = child.sent.filter((c) => c.t === HostCommand.GESTURE);
  assert.deepEqual(gestures.map((c) => c.g), Object.values(Mood).map((m) => MOOD_GESTURE[m].g));
  const states = child.sent.filter((c) => c.t === HostCommand.STATE).map((c) => c.state);
  assert.deepEqual(states.slice(0, 4), [MascotState.IDLE, MascotState.IDLE, MascotState.IDLE, MascotState.DONE]);
  child.emit('close', 0);
});

test('câu trả lời xin lỗi 😔 → cử chỉ buồn, không nhảy mừng "xong" (về chờ việc); 🎉 → xong + mừng; báo lỗi không xét emoji', async () => {
  const { m, child } = await readyMascot();
  let from = child.sent.length;
  m.alert({ kind: 'done', text: 'Mình xin lỗi, mình đọc nhầm tệp 😔' });
  let sent = child.sent.slice(from);
  assert.ok(sent.some((c) => c.t === HostCommand.GESTURE && c.g === 'sad' && c.face === 'sad'));
  assert.ok(!sent.some((c) => c.t === HostCommand.STATE && c.state === MascotState.DONE), 'buồn thì không nhảy "xong"');

  await sleep(50);
  from = child.sent.length;
  m.alert({ kind: 'done', text: 'Đã gửi 3 thư 🎉' });
  sent = child.sent.slice(from);
  const done = sent.findIndex((c) => c.t === HostCommand.STATE && c.state === MascotState.DONE);
  const gesture = sent.findIndex((c) => c.t === HostCommand.GESTURE && c.g === 'wave' && c.face === 'star');
  assert.ok(done >= 0 && gesture > done, 'trạng thái xong trước, cử chỉ mừng sau');

  await sleep(50);
  from = child.sent.length;
  m.alert({ kind: 'failed', text: 'Không gửi được thư 😢' });
  m.alert({ kind: 'done', text: 'Đã xong.' });
  assert.ok(!child.sent.slice(from).some((c) => c.t === HostCommand.GESTURE), 'lỗi / không emoji → không thêm cử chỉ');

  from = child.sent.length;
  m.alert({ kind: 'needs_you', text: 'Xin lỗi 😔, bạn muốn gửi cho ai?' });
  assert.ok(child.sent.slice(from).some((c) => c.t === HostCommand.GESTURE && c.g === 'sad'), 'câu hỏi lại vẫn có nét mặt');
  m.close();
});
