import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { SAMPLE_RATE, planChunks, openWav, transcribeRecording, wavBuffer, formatTranscript, clock } = await import('../bin/lib/remote/meeting/transcribe.mjs');
const { createMeetingManager, buildMeetingTools, followUpText, MeetingStatus, StopReason, requestMeeting, watchMeetingRequests } = await import('../bin/lib/remote/meeting/index.mjs');
const { evaluateLocalPolicy, describeCall, DEFAULT_LOCAL_POLICY } = await import('../bin/lib/remote/localPolicy.mjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Tín hiệu: các đoạn [giây bắt đầu, giây kết thúc] có tiếng (sóng sin), còn lại im lặng. */
function signal(totalSec, speech) {
  const out = new Int16Array(totalSec * SAMPLE_RATE);
  for (const [a, b] of speech) for (let i = a * SAMPLE_RATE; i < b * SAMPLE_RATE && i < out.length; i++) out[i] = Math.round(Math.sin(i / 8) * 8000);
  return out;
}
const writeWav = (file, samples) => fs.writeFileSync(file, wavBuffer(samples));

test('cắt đoạn: ~30 s, cắt vào chỗ im gần mốc, đoạn im lặng không gửi', () => {
  const dir = tmp('aivin-wav-');
  // Nói 0–29 s, nghỉ 29–31 s, nói 31–58 s, im 58–100 s.
  writeWav(path.join(dir, 'a.wav'), signal(100, [[0, 29], [31, 58]]));
  const src = openWav(path.join(dir, 'a.wav'));
  const plan = planChunks({ sources: [src, openWav(path.join(dir, 'missing.wav'))] });
  src.close();
  assert.ok(plan[0].end >= 29 && plan[0].end <= 31, `cut at ${plan[0].end}`);
  assert.equal(plan[0].silent, false);
  assert.ok(plan.slice(2).every((c) => c.silent));
  assert.equal(Math.round(plan.at(-1).end), 100);
});

test('chuyển chữ: trộn hai luồng, đoạn BE chê dài thì chia đôi, lỗi mãi thì ghi rõ đoạn hỏng', async () => {
  const dir = tmp('aivin-wav-');
  writeWav(path.join(dir, 'system.wav'), signal(70, [[0, 25]]));
  writeWav(path.join(dir, 'mic.wav'), signal(70, [[35, 60]]));
  const calls = [];
  let n = 0;
  const stt = async (wav) => {
    const secs = (wav.length - 44) / 2 / SAMPLE_RATE;
    calls.push(secs);
    if (secs > 20) return { ok: false, error: 'audio_too_big' };
    n++;
    return n === 3 ? { ok: false, error: 'server_error' } : { ok: true, text: `câu ${n}` };
  };
  const res = await transcribeRecording({ files: [path.join(dir, 'system.wav'), path.join(dir, 'mic.wav')], stt, retries: 0 });
  assert.ok(calls.some((s) => s > 20) && calls.some((s) => s <= 20), 'split after audio_too_big');
  assert.ok(res.segments.length >= 2);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].error, 'server_error');
  assert.equal(Math.round(res.seconds), 70);
  const md = formatTranscript({ title: 'Họp tuần', startedAt: '2026-10-29T02:00:00Z', seconds: res.seconds, segments: res.segments, failed: res.failed, screens: [{ file: '00-00-10.jpg', secs: 10 }] });
  assert.match(md, /^# Họp tuần/);
  assert.match(md, /ảnh màn hình: screens\/00-00-10\.jpg/);
  assert.match(md, /không chuyển được/);
  assert.ok(md.indexOf('[00:00]') < md.indexOf('00-00-10.jpg'));
  assert.equal(clock(3725), '1:02:05');
});

/** Bộ ghi giả: ghi WAV khi dừng, phát sự kiện theo ý test. */
function fakeMedia({ seconds = 40, speech = [[0, 20]], failStart = false } = {}) {
  const state = { recs: [] };
  return {
    state,
    record({ dir }) {
      const listeners = new Map();
      let finish;
      const done = new Promise((r) => { finish = r; });
      const rec = {
        dir,
        ready: failStart ? Promise.reject(new Error('No audio device could be opened')) : Promise.resolve({ system: true, mic: true }),
        done,
        stop() { writeWav(path.join(dir, 'system.wav'), signal(seconds, speech)); writeWav(path.join(dir, 'mic.wav'), signal(seconds, [])); finish({ secs: seconds }); },
        kill() { finish(null); },
        on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        emit(type, msg) { for (const fn of listeners.get(type) || []) fn(msg); },
      };
      state.recs.push(rec);
      return rec;
    },
  };
}

const okStt = async () => ({ ok: true, text: 'Chốt ngân sách quý 4.' });

test('cuộc họp: bắt đầu → dừng → biên bản → xoá âm thanh → tự mở lượt chat với việc đã dặn', async () => {
  const baseDir = tmp('aivin-meet-');
  const media = fakeMedia();
  const sent = [];
  const holds = [];
  const m = createMeetingManager({
    baseDir, media, stt: okStt, followUp: async (text) => { sent.push(text); return { ok: true }; },
    keepAwake: { hold: () => holds.push('hold'), release: () => holds.push('release') },
  });
  const started = await m.start({ title: 'Họp sales tuần', then: 'tóm tắt và soạn thư cho sếp' });
  assert.equal(started.status, MeetingStatus.RECORDING);
  assert.equal(m.busy(), true);
  await assert.rejects(m.start({ title: 'khác' }), /already being recorded/);
  media.state.recs[0].emit('screen', { file: '00-00-05.jpg', secs: 5 });
  const stopped = await m.stop();
  assert.equal(stopped.stop_reason, StopReason.REQUESTED);
  await m.idle();
  const meetingDir = path.join(baseDir, started.id);
  const meta = JSON.parse(fs.readFileSync(path.join(meetingDir, 'meeting.json'), 'utf8'));
  assert.equal(meta.status, MeetingStatus.DONE);
  assert.equal(meta.follow_up, 'sent');
  assert.ok(!fs.existsSync(path.join(meetingDir, 'system.wav')), 'audio deleted');
  assert.deepEqual(holds, ['hold', 'release']);
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(started.id));
  assert.match(sent[0], /meeting\.transcript/);
  assert.match(sent[0], /soạn thư cho sếp/);
  const t = m.transcript({});
  assert.match(t.text, /Chốt ngân sách quý 4/);
  assert.deepEqual(t.screens, [{ file: '00-00-05.jpg', at: '00:05' }]);
  assert.equal(m.list()[0].id, started.id);
  assert.equal(m.busy(), false);
});

test('tự dừng: cửa sổ họp đã thấy rồi đóng + máy im; im lặng lâu; công tắc ngắt', async () => {
  let clockMs = 1_000_000;
  const now = () => clockMs;
  const tick = () => new Promise((r) => setTimeout(r, 30));

  const baseDir = tmp('aivin-meet-');
  const media = fakeMedia();
  const m = createMeetingManager({ baseDir, media, stt: okStt, tickMs: 10, now });
  await m.start({ title: 'Meet' });
  const rec = media.state.recs[0];
  rec.emit('windows', { titles: ['Meet - abc-defg-hij - Google Chrome'] });
  rec.emit('level', { system: 0.05, mic: 0 });
  clockMs += 30_000;
  rec.emit('windows', { titles: ['Inbox - Outlook'] });
  await tick();
  assert.ok(m.status().recording, 'not yet: window gone only 30 s');
  clockMs += 61_000;
  await tick();
  await m.idle();
  assert.equal(m.list()[0].stop_reason, StopReason.MEETING_CLOSED);

  const m2 = createMeetingManager({ baseDir: tmp('aivin-meet-'), media: fakeMedia(), stt: okStt, tickMs: 10, now });
  await m2.start({ title: 'Zoom', silence_minutes: 3 });
  clockMs += 3 * 60_000 + 1000;
  await tick();
  await m2.idle();
  assert.equal(m2.list()[0].stop_reason, StopReason.SILENCE);

  let paused = false;
  const sent = [];
  const m3 = createMeetingManager({ baseDir: tmp('aivin-meet-'), media: fakeMedia(), stt: okStt, tickMs: 10, now, isPaused: () => paused, followUp: async (x) => { sent.push(x); return { ok: true }; } });
  await m3.start({ title: 'Teams', then: 'gửi báo cáo' });
  paused = true;
  await tick();
  await m3.idle();
  const last = m3.list()[0];
  assert.equal(last.stop_reason, StopReason.PAUSED);
  assert.equal(last.follow_up, 'skipped_paused');
  assert.equal(sent.length, 0);
});

test('không mở được thiết bị âm thanh → báo lỗi, không để lại buổi ghi dở', async () => {
  const baseDir = tmp('aivin-meet-');
  const m = createMeetingManager({ baseDir, media: fakeMedia({ failStart: true }), stt: okStt });
  await assert.rejects(m.start({ title: 'x' }), /No audio device/);
  assert.equal(m.busy(), false);
  assert.deepEqual(m.list(), []);
});

test('daemon chết giữa buổi ghi → lần chạy sau làm nốt biên bản từ tệp đã ghi', async () => {
  const baseDir = tmp('aivin-meet-');
  const media = fakeMedia();
  const m = createMeetingManager({ baseDir, media, stt: okStt });
  const { id } = await m.start({ title: 'Họp dở' });
  media.state.recs[0].stop(); // tệp WAV đã đóng, nhưng meeting.json vẫn ghi "recording" (daemon chết trước khi kịp cập nhật)
  const m2 = createMeetingManager({ baseDir, media: fakeMedia(), stt: okStt });
  m2.recover();
  await m2.idle();
  const t = m2.transcript({ id });
  assert.equal(t.status, MeetingStatus.DONE);
  assert.match(t.text, /Chốt ngân sách/);
});

test('sàn luật: bắt đầu ghi họp luôn phải bấm Cho phép trên máy; xem biên bản thì không', () => {
  const tools = buildMeetingTools({ meetings: {}, media: { snap() {} } });
  const byName = new Map(tools.map((t) => [t.name, t]));
  assert.deepEqual([...byName.keys()].sort(), ['meeting.list', 'meeting.screenshot', 'meeting.start', 'meeting.status', 'meeting.stop', 'meeting.transcript', 'screen.capture']);
  const decision = evaluateLocalPolicy(DEFAULT_LOCAL_POLICY, byName.get('meeting.start'), { title: 'Họp' });
  assert.equal(decision.action, 'confirm');
  assert.match(decision.reason, /Ghi âm cuộc họp/);
  assert.match(describeCall(byName.get('meeting.start'), { title: 'Họp sales', then: 'gửi sếp' }), /Họp sales — sau đó: gửi sếp/);
  assert.equal(evaluateLocalPolicy(DEFAULT_LOCAL_POLICY, byName.get('meeting.transcript'), {}).action, 'allow');
  assert.equal(evaluateLocalPolicy(DEFAULT_LOCAL_POLICY, byName.get('screen.capture'), {}).action, 'allow');
});

test('lệnh `aivin remote meeting start|stop` tới daemon qua tệp yêu cầu; daemon không chạy → lỗi rõ', async () => {
  const baseDir = tmp('aivin-meet-');
  const m = createMeetingManager({ baseDir, media: fakeMedia(), stt: okStt });
  const stopWatching = watchMeetingRequests(m, { baseDir, pollMs: 50 });
  const started = await requestMeeting('start', { title: 'Từ CLI' }, { baseDir });
  assert.equal(started.title, 'Từ CLI');
  assert.equal(JSON.parse(fs.readFileSync(path.join(baseDir, started.id, 'meeting.json'), 'utf8')).by, 'user');
  const stopped = await requestMeeting('stop', {}, { baseDir });
  assert.equal(stopped.id, started.id);
  await assert.rejects(requestMeeting('stop', {}, { baseDir }), /No meeting is being recorded/);
  stopWatching();
  await m.idle();
  await assert.rejects(requestMeeting('stop', {}, { baseDir, waitMs: 400 }), /not running/);
});

test('câu mở lượt chat sau họp: có id, số phút, ảnh, việc đã dặn; tiếng Anh khi họp tiếng Anh', () => {
  const meta = { id: 'm-1', title: 'Weekly', duration_s: 1500, screens: [{}, {}], then: 'email my boss', lang: 'en' };
  assert.match(followUpText(meta), /"Weekly" has ended \(25 min\).*id "m-1".*2 screenshots.*email my boss/);
  assert.match(followUpText({ ...meta, lang: 'vi', screens: [] }), /Cuộc họp "Weekly" đã kết thúc \(25 phút\)/);
});

test('người nói: cắt ở chỗ đổi lượt giữa micro và loa, gắn nhãn Chủ máy / Người khác; loa lọt micro vẫn tính là người khác', async () => {
  const dir = tmp('aivin-wav-');
  // Người khác nói 0–12 s (micro lọt tiếng loa ~1/4), chủ máy nói 12.5–22 s, người khác 22.5–40 s.
  const sys = signal(40, [[0, 12], [22.5, 40]]);
  const mic = signal(40, [[12.5, 22]]);
  for (let i = 0; i < mic.length; i++) if (sys[i]) mic[i] = Math.round(sys[i] / 4);
  writeWav(path.join(dir, 'system.wav'), sys);
  writeWav(path.join(dir, 'mic.wav'), mic);
  const plan = planChunks({ sources: [openWav(path.join(dir, 'system.wav')), openWav(path.join(dir, 'mic.wav'))], labels: ['others', 'me'] });
  const speech = plan.filter((c) => !c.silent);
  assert.deepEqual(speech.map((c) => c.speaker), ['others', 'me', 'others']);
  assert.ok(Math.abs(speech[1].start - 12.25) < 0.6, `turn cut at ${speech[1].start}`);
  const res = await transcribeRecording({ files: [path.join(dir, 'system.wav'), path.join(dir, 'mic.wav')], labels: ['others', 'me'], stt: okStt });
  const md = formatTranscript({ title: 'x', seconds: 40, segments: res.segments });
  assert.match(md, /\*\*Người khác:\*\* Chốt/);
  assert.match(md, /\*\*Chủ máy:\*\* Chốt/);
});
