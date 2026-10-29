import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DeviceErrorCode, REMOTE_CONFIG_DIR, ToolGroup } from '../constants.mjs';
import { DeviceToolError, resolveInRoots } from '../sandbox.mjs';
import { createMediaHost } from './recorder.mjs';
import { Speaker, clock, formatTranscript, transcribeRecording } from './transcribe.mjs';

/**
 * Ghi chú cuộc họp (29/10/2026): "vào họp cùng tôi, ghi chú, họp xong gửi báo cáo cho sếp". Không ai vào phòng họp thay người dùng — máy ghi
 * tiếng của chính máy này (âm thanh máy = người khác nói, micro = chủ máy) + ảnh màn hình khi đổi (slide chia sẻ), chạy với mọi app họp (Meet,
 * Zoom, Teams, Zalo…). Ghi xong mới xử lý một thể: chuyển chữ từng đoạn qua `device:stt`, ghi `transcript.md`, xoá tệp âm thanh (trừ
 * `keep_audio`), rồi — nếu lúc bắt đầu có dặn `then` — tự mở một lượt chat trên Aivin (`device:chat`, như chủ máy gõ cho linh vật) với việc đã dặn
 * kèm id biên bản; agent đọc biên bản bằng `meeting.transcript`, tóm tắt, soạn thư (gửi thư vẫn phải bấm xác nhận trên máy).
 *
 * Tự dừng khi: cửa sổ họp (đã thấy lúc đầu) đóng VÀ máy im ≥ 60 s; cả hai luồng im `silence_minutes`; quá `max_minutes`; bật công tắc ngắt.
 * Bắt đầu ghi luôn phải có người bấm Cho phép trên máy (localPolicy.mjs) — AI không tự bật ghi âm khi không ai biết.
 * Dữ liệu nằm trong `~/.aivin/meetings/<id>/` (công cụ tệp không đọc được), hoặc `save_dir` trong vùng được phép nếu người dùng muốn tự giữ.
 */

export const MEETINGS_DIR = path.join(REMOTE_CONFIG_DIR, 'meetings');
export const MeetingStatus = Object.freeze({ RECORDING: 'recording', TRANSCRIBING: 'transcribing', DONE: 'done', FAILED: 'failed' });
export const StopReason = Object.freeze({
  REQUESTED: 'requested', MEETING_CLOSED: 'meeting_closed', SILENCE: 'silence', MAX_DURATION: 'max_duration', PAUSED: 'paused',
  SHUTDOWN: 'shutdown', RECORDER_EXITED: 'recorder_exited',
});

/** Tiêu đề cửa sổ / tab của app họp đang trong cuộc họp. */
export const MEETING_TITLE_RE = /google meet|\bmeet\s*[-–—:]|zoom meeting|zoom workplace|cuộc họp zoom|microsoft teams|webex|skype|zalo|huddle|discord|jitsi|whereby|lark|feishu/i;

const SOUND_RMS = 0.01;
const WINDOW_GONE_MS = 60_000;
const TICK_MS = 5000;
const STOP_WAIT_MS = 20_000;
const MAX_INDEX = 100;
const MAX_THEN = 2000;
const TRANSCRIPT_PAGE = 30_000;
const FOLLOW_UP_RETRY_MS = 60_000;
const FOLLOW_UP_TRIES = 30;

const safeName = (s) => [...String(s || '')].map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim().slice(0, 60);
const bad = (m) => new DeviceToolError(DeviceErrorCode.INVALID_ARGS, m);
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, lo), hi) : d; };

/** Câu mở lượt chat sau buổi họp (gửi như chủ máy gõ). */
export function followUpText(meta) {
  const vi = meta.lang !== 'en';
  const mins = Math.max(1, Math.round((meta.duration_s || 0) / 60));
  const screens = meta.screens?.length || 0;
  if (vi) {
    return `[Tự động sau cuộc họp] Cuộc họp "${meta.title}" đã kết thúc (${mins} phút). Biên bản ghi âm đã có trên máy này: đọc bằng công cụ meeting.transcript với id "${meta.id}"`
      + `${screens ? ` (có ${screens} ảnh màn hình, xem bằng meeting.screenshot)` : ''}. Việc tôi đã dặn: ${meta.then}`;
  }
  return `[Automatic, after the meeting] The meeting "${meta.title}" has ended (${mins} min). Its transcript is on this computer: read it with the meeting.transcript tool, id "${meta.id}"`
    + `${screens ? ` (${screens} screenshots, view with meeting.screenshot)` : ''}. What I asked for: ${meta.then}`;
}

/**
 * `stt(wav, lang)` → `{ ok, text, error }`; `followUp(text)` → `{ ok, error? }` (mở lượt chat); `isPaused()` — công tắc ngắt; `keepAwake` —
 * `{ hold, release }`; `notify({ title, body })`; `say(text)` — nhật ký daemon.
 */
export function createMeetingManager({
  roots = [], media = createMediaHost(), stt, followUp = async () => ({ ok: false, error: 'unavailable' }), isPaused = () => false,
  keepAwake = { hold() {}, release() {} }, notify = () => {}, say = () => {}, lang = 'vi', baseDir = MEETINGS_DIR, tickMs = TICK_MS,
  now = () => Date.now(), micBusy = () => false,
} = {}) {
  const indexFile = path.join(baseDir, 'index.json');
  let current = null; // { meta, rec, timer, lastSound, windowSeen, windowAt, stopping }
  let queue = Promise.resolve();
  let processing = null; // id đang chuyển chữ

  const readIndex = () => { try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return []; } };
  const writeIndex = (list) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(indexFile, JSON.stringify(list.slice(0, MAX_INDEX), null, 2)); };
  const metaFile = (dir) => path.join(dir, 'meeting.json');
  const save = (meta) => { fs.mkdirSync(meta.dir, { recursive: true }); fs.writeFileSync(metaFile(meta.dir), JSON.stringify(meta, null, 2)); };
  const load = (dir) => { try { return JSON.parse(fs.readFileSync(metaFile(dir), 'utf8')); } catch { return null; } };

  function find(id) {
    const list = readIndex();
    const entry = id ? list.find((e) => e.id === id) : list[0];
    const meta = entry ? load(entry.dir) : null;
    if (!meta) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, id ? `No meeting recording with id ${id}` : 'No meeting has been recorded on this computer yet');
    return meta;
  }

  async function start(args = {}) {
    if (current) throw bad(`A meeting is already being recorded ("${current.meta.title}", id ${current.meta.id}) — stop it first with meeting.stop`);
    if (isPaused()) throw new DeviceToolError(DeviceErrorCode.KILL_SWITCH, 'This computer is paused');
    // The owner is talking with the mascot: the bot's voice and that conversation would end up in the meeting notes.
    if (micBusy()) throw bad('The owner is talking with Aivin through the mascot right now — ask them to end that conversation first, then start the recording');
    const id = `m-${new Date(now()).toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const title = String(args.title || '').trim().slice(0, 120) || (lang === 'en' ? 'Meeting' : 'Cuộc họp');
    const then = String(args.then || '').trim();
    if (then.length > MAX_THEN) throw bad(`then is too long (max ${MAX_THEN} characters)`);
    let dir = path.join(baseDir, id);
    if (args.save_dir) {
      const stamp = new Date(now()).toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
      dir = path.join(resolveInRoots(roots, String(args.save_dir)), `${stamp} ${safeName(title)}`.trim());
    }
    const meta = {
      id, title, then: then || null, lang: args.lang === 'en' || args.lang === 'vi' ? args.lang : lang, dir, status: MeetingStatus.RECORDING,
      started_at: new Date(now()).toISOString(), ended_at: null, duration_s: 0, stop_reason: null,
      screens_enabled: args.screens !== false, keep_audio: args.keep_audio === true,
      max_minutes: clamp(args.max_minutes, 5, 480, 180), silence_minutes: clamp(args.silence_minutes, 2, 60, 10),
      sources: null, screens: [], progress: null, error: null, follow_up: then ? 'pending' : null, by: args.by || 'ai',
    };
    fs.mkdirSync(dir, { recursive: true });
    const rec = media.record({ dir, screens: meta.screens_enabled });
    try {
      meta.sources = await rec.ready;
    } catch (e) {
      rec.kill();
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    save(meta);
    writeIndex([{ id, dir }, ...readIndex().filter((e) => e.id !== id)]);
    const c = { meta, rec, lastSound: now(), windowSeen: false, windowAt: 0, stopping: null, startedMs: now() };
    current = c;
    rec.on('level', (m) => { if (Number(m.system) > SOUND_RMS || Number(m.mic) > SOUND_RMS) c.lastSound = now(); c.level = { system: m.system, mic: m.mic }; c.systemSoundAt = Number(m.system) > SOUND_RMS ? now() : c.systemSoundAt; });
    rec.on('windows', (m) => {
      const hit = (m.titles || []).find((t) => MEETING_TITLE_RE.test(t));
      if (hit) { c.windowSeen = true; c.windowAt = now(); c.windowTitle = hit; }
    });
    rec.on('screen', (m) => { meta.screens.push({ file: m.file, secs: m.secs }); save(meta); });
    rec.on('warn', (m) => say(`⚠️  Ghi họp: ${m.what} — ${m.error}`));
    void rec.done.then(() => { if (current === c && !c.stopping) void stop({ reason: StopReason.RECORDER_EXITED }).catch(() => undefined); });
    c.timer = setInterval(() => tick(c), tickMs);
    c.timer.unref?.();
    keepAwake.hold();
    const missing = !meta.sources.system ? 'âm thanh máy' : !meta.sources.mic ? 'micro' : null;
    say(`🎙️  Đang ghi cuộc họp "${title}"${missing ? ` (không mở được ${missing})` : ''} — dừng: "aivin remote meeting stop" hoặc bảo AI dừng ghi.`);
    notify({
      title: lang === 'en' ? 'Aivin is recording your meeting' : 'Aivin đang ghi cuộc họp',
      body: lang === 'en' ? `"${title}" — let the other participants know. Stop: aivin remote meeting stop` : `"${title}" — hãy báo cho mọi người trong cuộc họp biết. Dừng: aivin remote meeting stop`,
    });
    return {
      id, title, status: meta.status, sources: meta.sources, screens: meta.screens_enabled, max_minutes: meta.max_minutes,
      ...(args.save_dir ? { dir } : {}),
      note: 'Recording. Tell the user to let the other participants know they are being recorded. It stops by itself when the meeting window closes, after a long silence or at max_minutes; the transcript is made afterwards'
        + (then ? ' and a new chat turn starts with the "then" instruction.' : '.'),
    };
  }

  function tick(c) {
    if (current !== c || c.stopping) return;
    const t = now();
    let reason = null;
    if (isPaused()) reason = StopReason.PAUSED;
    else if (t - c.startedMs >= c.meta.max_minutes * 60_000) reason = StopReason.MAX_DURATION;
    else if (c.windowSeen && t - c.windowAt >= WINDOW_GONE_MS && t - (c.systemSoundAt || 0) >= WINDOW_GONE_MS) reason = StopReason.MEETING_CLOSED;
    else if (t - c.lastSound >= c.meta.silence_minutes * 60_000) reason = StopReason.SILENCE;
    if (reason) void stop({ reason }).catch((e) => say(`⚠️  Dừng ghi họp lỗi: ${e?.message || e}`));
  }

  async function stop({ id, reason = StopReason.REQUESTED } = {}) {
    const c = current;
    if (!c || (id && c.meta.id !== id)) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, 'No meeting is being recorded');
    if (c.stopping) return c.stopping;
    c.stopping = (async () => {
      clearInterval(c.timer);
      c.rec.stop();
      const timeout = new Promise((r) => setTimeout(() => r('timeout'), STOP_WAIT_MS));
      const finished = await Promise.race([c.rec.done, timeout]);
      if (finished === 'timeout') c.rec.kill();
      const meta = c.meta;
      meta.ended_at = new Date(now()).toISOString();
      meta.duration_s = Math.round((now() - c.startedMs) / 1000);
      meta.stop_reason = reason;
      meta.status = MeetingStatus.TRANSCRIBING;
      save(meta);
      current = null;
      keepAwake.release();
      say(`⏹  Đã dừng ghi "${meta.title}" (${clock(meta.duration_s)}, ${reason}) — đang làm biên bản…`);
      if (reason !== StopReason.SHUTDOWN) enqueue(meta);
      return { id: meta.id, title: meta.title, status: meta.status, duration_s: meta.duration_s, stop_reason: reason };
    })();
    return c.stopping;
  }

  function enqueue(meta) {
    queue = queue.then(() => processMeeting(meta)).catch(() => undefined);
    return queue;
  }

  async function processMeeting(meta) {
    processing = meta.id;
    try {
      const files = ['system.wav', 'mic.wav'].map((f) => path.join(meta.dir, f));
      const result = await transcribeRecording({
        files,
        labels: [Speaker.OTHERS, Speaker.ME], // thứ tự như files: âm thanh máy, micro
        stt: (wav) => stt(wav, meta.lang),
        onProgress: ({ done, total }) => { meta.progress = { done, total }; if (done % 5 === 0 || done === total) save(meta); },
      });
      fs.writeFileSync(path.join(meta.dir, 'transcript.md'), formatTranscript({
        title: meta.title, startedAt: meta.started_at, seconds: result.seconds || meta.duration_s, segments: result.segments, failed: result.failed,
        screens: meta.screens, lang: meta.lang,
      }));
      meta.segments = result.segments.length;
      meta.failed_parts = result.failed.length;
      if (!meta.keep_audio && result.failed.length === 0) for (const f of files) fs.rmSync(f, { force: true });
      meta.status = MeetingStatus.DONE;
      save(meta);
      say(`📝 Biên bản "${meta.title}" xong — ${result.segments.length} đoạn${result.failed.length ? `, ${result.failed.length} đoạn không chuyển được (giữ tệp âm thanh)` : ''}.`);
      notify({
        title: meta.lang === 'en' ? 'Meeting transcript ready' : 'Biên bản cuộc họp đã xong',
        body: meta.then ? (meta.lang === 'en' ? `"${meta.title}" — Aivin is now doing what you asked.` : `"${meta.title}" — Aivin đang làm việc bạn đã dặn.`) : `"${meta.title}"`,
      });
      if (meta.then) await sendFollowUp(meta);
    } catch (e) {
      meta.status = MeetingStatus.FAILED;
      meta.error = e?.message || String(e);
      save(meta);
      say(`❌ Không làm được biên bản "${meta.title}": ${meta.error} (tệp âm thanh vẫn giữ trong ${meta.dir})`);
    } finally {
      processing = null;
    }
  }

  /** Lượt chat sau họp — BE bận / máy mất mạng thì thử lại mỗi phút (tối đa nửa giờ). Công tắc ngắt đang bật → không gửi. */
  async function sendFollowUp(meta) {
    for (let i = 0; i < FOLLOW_UP_TRIES; i++) {
      if (isPaused()) { meta.follow_up = 'skipped_paused'; save(meta); return; }
      let res;
      try { res = await followUp(followUpText(meta)); } catch (e) { res = { ok: false, error: e?.message || String(e) }; }
      if (res?.ok) { meta.follow_up = 'sent'; save(meta); return; }
      if (res?.error && !['busy', 'offline'].includes(res.error)) { meta.follow_up = `failed: ${res.error}`; save(meta); return; }
      await new Promise((r) => setTimeout(r, FOLLOW_UP_RETRY_MS));
    }
    meta.follow_up = 'failed: gave up';
    save(meta);
  }

  /** Daemon vừa chạy: buổi ghi dở (daemon chết giữa chừng) / biên bản dở → làm nốt. */
  function recover() {
    for (const entry of readIndex().slice(0, 20)) {
      const meta = load(entry.dir);
      if (!meta || (meta.status !== MeetingStatus.RECORDING && meta.status !== MeetingStatus.TRANSCRIBING)) continue;
      if (meta.status === MeetingStatus.RECORDING) {
        let mtime = Date.parse(meta.started_at);
        for (const f of ['system.wav', 'mic.wav']) { try { mtime = Math.max(mtime, fs.statSync(path.join(meta.dir, f)).mtimeMs); } catch { /* không có */ } }
        meta.ended_at = new Date(mtime).toISOString();
        meta.duration_s = Math.round((mtime - Date.parse(meta.started_at)) / 1000);
        meta.stop_reason = meta.stop_reason || StopReason.RECORDER_EXITED;
        meta.status = MeetingStatus.TRANSCRIBING;
        save(meta);
      }
      say(`📝 Làm nốt biên bản "${meta.title}" (dở từ lần chạy trước)…`);
      enqueue(meta);
    }
  }

  function status() {
    const c = current;
    return {
      recording: c ? {
        id: c.meta.id, title: c.meta.title, elapsed_s: Math.round((now() - c.startedMs) / 1000), sources: c.meta.sources, level: c.level || null,
        screens: c.meta.screens.length, meeting_window: c.windowTitle || null, then: c.meta.then,
      } : null,
      transcribing: processing ? (() => { try { const m = find(processing); return { id: m.id, title: m.title, progress: m.progress }; } catch { return { id: processing }; } })() : null,
    };
  }

  function list({ limit = 20 } = {}) {
    return readIndex().slice(0, Math.min(Number(limit) || 20, MAX_INDEX)).map((e) => load(e.dir)).filter(Boolean).map((m) => ({
      id: m.id, title: m.title, status: m.status, started_at: m.started_at, duration_s: m.duration_s, stop_reason: m.stop_reason,
      screens: m.screens?.length || 0, follow_up: m.follow_up, ...(m.dir.startsWith(baseDir) ? {} : { dir: m.dir }),
    }));
  }

  function transcript({ id, offset = 0, max_chars = TRANSCRIPT_PAGE } = {}) {
    const meta = find(id);
    const base = { id: meta.id, title: meta.title, status: meta.status, started_at: meta.started_at, duration_s: meta.duration_s };
    if (meta.status === MeetingStatus.RECORDING) return { ...base, text: null, note: 'Still recording — the transcript is made after the meeting ends.' };
    if (meta.status === MeetingStatus.TRANSCRIBING) return { ...base, text: null, progress: meta.progress, note: 'Still transcribing — try again in a minute.' };
    let text;
    try { text = fs.readFileSync(path.join(meta.dir, 'transcript.md'), 'utf8'); } catch { throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, meta.error ? `Transcript failed: ${meta.error}` : 'Transcript file is missing'); }
    const from = Math.max(0, Number(offset) || 0);
    const size = Math.min(Math.max(1000, Number(max_chars) || TRANSCRIPT_PAGE), 100_000);
    const page = text.slice(from, from + size);
    return {
      ...base, text: page, total_chars: text.length, ...(from + size < text.length ? { next_offset: from + size } : {}),
      screens: (meta.screens || []).map((s) => ({ file: s.file, at: clock(s.secs) })),
      ...(meta.dir.startsWith(baseDir) ? {} : { file: path.join(meta.dir, 'transcript.md') }),
    };
  }

  function screenshot({ id, file } = {}) {
    const meta = find(id);
    const name = String(file || '');
    if (!(meta.screens || []).some((s) => s.file === name)) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No screenshot ${name} in this meeting`);
    const buf = fs.readFileSync(path.join(meta.dir, 'screens', name));
    return { id: meta.id, file: name, image: { mime: 'image/jpeg', base64: buf.toString('base64') } };
  }

  /** Daemon dừng: đóng tệp ghi cho đúng; biên bản làm ở lần chạy sau (recover). */
  async function shutdown() {
    if (current) await stop({ reason: StopReason.SHUTDOWN }).catch(() => undefined);
  }

  return {
    start, stop, status, list, transcript, screenshot, recover, shutdown,
    busy: () => !!current || !!processing,
    /** Chờ hết việc chuyển chữ đang xếp hàng (test). */
    idle: () => queue,
  };
}

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

/** Công cụ ghi chú cuộc họp + chụp màn hình cho danh mục của Planner. */
export function buildMeetingTools({ meetings, media }) {
  const tools = [];
  if (meetings) {
    tools.push(
      { name: 'meeting.start', group: ToolGroup.MEDIA,
        handler: (a) => meetings.start({ ...a, by: 'ai' }),
        description: 'Take notes of a meeting the user is in on this computer (Google Meet, Zoom, Teams, Zalo… any app; nobody joins the meeting): records what the others say (the computer\'s sound) and the user\'s microphone, plus a screenshot whenever the screen changes (shared slides). Recording ends by itself when the meeting window closes, after a long silence or at max_minutes (or with meeting.stop); the transcript is made afterwards. Give "then" for what to do when it is ready (e.g. "summarize the decisions and action items and draft an email to my manager anh.nguyen@x.com") — a new chat turn starts with it automatically. The person at this computer must approve; tell them to let the participants know they are recorded.',
        input_schema: schema({
          title: str('meeting name, e.g. "Weekly sales review"'), then: str('what to do with the transcript when the meeting is over'),
          lang: str('vi | en — language spoken (default the mascot language)'), screens: bool('save screenshots when the screen changes (default true)'),
          max_minutes: num('stop after this long, default 180, max 480'), silence_minutes: num('stop after this long without any sound, default 10'),
          save_dir: str('also keep the transcript + screenshots in this folder (inside the allowed area) so they can be attached to an email'),
          keep_audio: bool('keep the audio files after transcribing (default: deleted)'),
        }) },
      { name: 'meeting.stop', group: ToolGroup.MEDIA,
        handler: (a) => meetings.stop({ id: a.id }),
        description: 'Stop the meeting recording now; the transcript is then made (and the "then" instruction runs when it is ready).',
        input_schema: schema({ id: str('meeting id (default the one recording)') }) },
      { name: 'meeting.status', group: ToolGroup.MEDIA, read_only: true, handler: () => meetings.status(),
        description: 'Whether a meeting is being recorded (elapsed time, sound levels, screenshots so far) and transcription progress.', input_schema: schema({}) },
      { name: 'meeting.list', group: ToolGroup.MEDIA, read_only: true, handler: (a) => ({ meetings: meetings.list(a) }),
        description: 'Meetings recorded on this computer, newest first: id, title, when, duration, status.', input_schema: schema({ limit: num('default 20') }) },
      { name: 'meeting.transcript', group: ToolGroup.MEDIA, read_only: true, handler: (a) => meetings.transcript(a),
        description: 'Read the transcript of a recorded meeting (timestamped; screenshots are marked where they were taken). Long transcripts come in pages: pass next_offset.',
        input_schema: schema({ id: str('meeting id (default the latest)'), offset: num('character offset from next_offset'), max_chars: num('default 30000') }) },
      { name: 'meeting.screenshot', group: ToolGroup.MEDIA, read_only: true, handler: (a) => meetings.screenshot(a),
        description: 'View one screenshot taken during a meeting (file name from meeting.transcript).',
        input_schema: schema({ id: str('meeting id'), file: str('screenshot file, e.g. "00-12-30.jpg"') }, ['file']) },
    );
  }
  if (media) {
    tools.push({ name: 'screen.capture', group: ToolGroup.MEDIA, read_only: true,
      handler: (a, c) => media.snap({ monitor: Number.isInteger(a.monitor) ? a.monitor : -1, max_width: Number(a.max_width) || 1600 }, c?.signal),
      description: 'Screenshot of the whole screen (all monitors side by side) or one monitor; also lists the monitors. The Aivin mascot is never in it.',
      input_schema: schema({ monitor: num('monitor index from a previous call; default all'), max_width: num('default 1600, max 3840') }) });
  }
  return tools;
}

// ── `aivin remote meeting start|stop` → daemon đang chạy: tệp yêu cầu trong `meetings/requests/` (như công tắc ngắt — lệnh cục bộ, người
// ngồi trước máy, nên bắt đầu ghi từ đây không cần hộp xác nhận). ───────────────────────────────────────────────────────────────────────

const REQUEST_POLL_MS = 1500;
const REQUEST_WAIT_MS = 30_000;
const requestsDir = (baseDir) => path.join(baseDir, 'requests');

/** Daemon: đọc yêu cầu, làm, ghi kết quả `<id>.res.json`. Trả hàm dừng. */
export function watchMeetingRequests(meetings, { baseDir = MEETINGS_DIR, pollMs = REQUEST_POLL_MS } = {}) {
  const dir = requestsDir(baseDir);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.req.json')); } catch { return; }
      for (const name of names) {
        const file = path.join(dir, name);
        let req;
        try { req = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { req = null; }
        fs.rmSync(file, { force: true });
        if (!req) continue;
        let res;
        try {
          if (req.action === 'start') res = { ok: true, result: await meetings.start({ ...req.args, by: 'user' }) };
          else if (req.action === 'stop') res = { ok: true, result: await meetings.stop({ id: req.args?.id }) };
          else res = { ok: false, error: `Unknown action ${req.action}` };
        } catch (e) {
          res = { ok: false, error: e?.message || String(e) };
        }
        fs.writeFileSync(path.join(dir, name.replace('.req.json', '.res.json')), JSON.stringify(res));
      }
    } finally {
      busy = false;
    }
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** CLI: gửi yêu cầu cho daemon, chờ kết quả. Daemon không chạy → lỗi rõ. */
export async function requestMeeting(action, args = {}, { baseDir = MEETINGS_DIR, waitMs = REQUEST_WAIT_MS } = {}) {
  const dir = requestsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const reqFile = path.join(dir, `${id}.req.json`);
  const resFile = path.join(dir, `${id}.res.json`);
  fs.writeFileSync(reqFile, JSON.stringify({ action, args, at: new Date().toISOString() }));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (!fs.existsSync(resFile)) continue;
    const res = JSON.parse(fs.readFileSync(resFile, 'utf8'));
    fs.rmSync(resFile, { force: true });
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }
  fs.rmSync(reqFile, { force: true });
  throw new Error('The Aivin device agent is not running on this computer — start it with `aivin remote start`, then try again.');
}
