import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { NotifyKind, REMOTE_CONFIG_DIR, ToolGroup } from '../constants.mjs';
import { AIVIN_LOGO_PNG_BASE64 } from '../brand.mjs';
import { MASCOT_LAYERS } from './assets.mjs';
import { MASCOT_GLYPHS, MASCOT_PALETTE, MASCOT_PS1, MASCOT_XAML } from './hostSource.mjs';
import { ASK_PS1 } from './askHostSource.mjs';
import { AskCommand, QUESTION_ROW } from './ask.mjs';

const ASK_HOOK = '# @ASK_HOOK';
import { describeStep } from './labels.mjs';
import { MascotText, mascotLang, mascotText, windowStrings } from './strings.mjs';

/**
 * Linh vật Aivin trên màn hình máy người dùng (29/10/2026): một nhân vật nhỏ dựng từ logo, nổi trên mọi cửa sổ khi `aivin remote start`
 * chạy, bong bóng trên đầu hiện việc chính đang làm (mục đích bước / "Đọc baocao.xlsx"), kéo đi đâu cũng được, bấm vào ra bảng nhật ký chi
 * tiết + nút tạm dừng AI. Đợt đầu Windows (WPF, hostSource.mjs); hệ điều hành khác / máy tính tổ chức → không có gì (mọi hàm là no-op).
 *
 * Trạng thái: working (có bước đang chạy) → thinking (vừa xong lô, BE đang lập bước kế — chưa coi là xong) → done / error (yên THINK_MS
 * mà không có lô mới) → idle. waiting (chờ người bấm xác nhận trên máy), paused (công tắc ngắt), offline (mất kết nối) đè lên các trạng
 * thái kia. Bong bóng đổi tối đa mỗi MAIN_THROTTLE_MS (lô nhiều bước chỉ hiện bước mới nhất, không nhấp nháy).
 */

export const MASCOT_DIR = path.join(REMOTE_CONFIG_DIR, 'mascot');
export const MASCOT_SETTINGS_FILE = path.join(REMOTE_CONFIG_DIR, 'mascot.json');

export const MascotState = Object.freeze({
  IDLE: 'idle', WORKING: 'working', THINKING: 'thinking', WAITING: 'waiting', PAUSED: 'paused', OFFLINE: 'offline', DONE: 'done', ERROR: 'error',
});
export const LogStatus = Object.freeze({ RUN: 'run', OK: 'ok', FAIL: 'fail', INFO: 'info', WARN: 'warn' });
/** Lệnh gửi cửa sổ / sự kiện cửa sổ gửi về (một dòng JSON mỗi lệnh). */
export const HostCommand = Object.freeze({ STATE: 'state', MAIN: 'main', LOG: 'log', GUI: 'gui', SHOW: 'show', QUIT: 'quit', OPEN_ASK: 'open_ask', GESTURE: 'gesture' });

/** `aivin ui` (terminal khác) chạm tệp này → daemon đang chạy hiện linh vật + mở ô hỏi (mascot/ui.mjs). */
export const MASCOT_SHOW_FILE = path.join(REMOTE_CONFIG_DIR, 'mascot-show');
const SHOW_POLL_MS = 1000;
const SHOW_REQUEST_GRACE_MS = 30_000;

/** Ghi yêu cầu hiện linh vật cho daemon đang chạy (hoặc sắp chạy). */
export function requestMascotShow(file = MASCOT_SHOW_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(Date.now()));
}
export const HostEvent = Object.freeze({
  READY: 'ready', POS: 'pos', PAUSE: 'pause', RESUME: 'resume', HIDE: 'hide', OFF: 'off', ASK: 'ask', CHOOSE: 'choose',
  DROP: 'drop', AWAY: 'away', BACK: 'back',
  VOICE_START: 'voice_start', VOICE_AUDIO: 'voice_audio', VOICE_INTERRUPT: 'voice_interrupt', VOICE_STOP: 'voice_stop', VOICE_MIC_LOST: 'voice_mic_lost',
});
const VOICE_EVENTS = new Set([HostEvent.VOICE_START, HostEvent.VOICE_AUDIO, HostEvent.VOICE_INTERRUPT, HostEvent.VOICE_STOP, HostEvent.VOICE_MIC_LOST]);

const THINK_MS = 8000;
const RESULT_MS = 6000;
const MAIN_THROTTLE_MS = 600;
const RESTART_DELAYS_MS = [5000, 30_000, 120_000];
const QUEUE_LOGS = 40;
/** Vắng lâu chừng này mà không có việc gì xảy ra → quay lại vẫn được vẫy chào (không bong bóng). */
const AWAY_WAVE_MS = 30 * 60_000;

export function loadMascotSettings(file = MASCOT_SETTINGS_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    const pos = Number.isFinite(data.x) && Number.isFinite(data.y) ? { x: data.x, y: data.y } : {};
    return { enabled: data.enabled !== false, ...pos };
  } catch {
    return { enabled: true };
  }
}

export function saveMascotSettings(patch, file = MASCOT_SETTINGS_FILE) {
  const next = { ...loadMascotSettings(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** host.ps1 = mã cửa sổ + ô hỏi (askHostSource.mjs) chèn tại dấu `# @ASK_HOOK`; thiếu dấu thì ô hỏi không có, cửa sổ vẫn chạy. */
export function hostScript() {
  return MASCOT_PS1.includes(ASK_HOOK) ? MASCOT_PS1.replace(ASK_HOOK, ASK_PS1) : MASCOT_PS1;
}

/** Tệp của cửa sổ: mã + ảnh theo dấu vân tay (đổi bản CLI → bộ mới, dọn bộ cũ); config.json (vị trí, chữ, màu) ghi mỗi lần mở. */
export function writeHostFiles({ dir, lang, settings }) {
  const hostPs1 = hostScript();
  const sha = createHash('sha256').update(hostPs1).update(MASCOT_XAML);
  for (const body of Object.values(MASCOT_LAYERS)) sha.update(body);
  const hash = sha.digest('hex').slice(0, 12);
  const home = path.join(dir, hash);
  fs.mkdirSync(home, { recursive: true });
  const files = { 'host.ps1': hostPs1, 'mascot.xaml': MASCOT_XAML };
  for (const [name, body] of Object.entries(files)) if (!fs.existsSync(path.join(home, name))) fs.writeFileSync(path.join(home, name), body);
  for (const [name, body] of Object.entries(MASCOT_LAYERS)) if (!fs.existsSync(path.join(home, name))) fs.writeFileSync(path.join(home, name), Buffer.from(body, 'base64'));
  if (!fs.existsSync(path.join(home, 'logo.png'))) fs.writeFileSync(path.join(home, 'logo.png'), Buffer.from(AIVIN_LOGO_PNG_BASE64, 'base64'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    strings: windowStrings(lang), palette: MASCOT_PALETTE, glyphs: MASCOT_GLYPHS, x: settings.x ?? null, y: settings.y ?? null,
  }));
  for (const name of fs.readdirSync(dir)) {
    if (name !== hash && /^[0-9a-f]{12}$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  return home;
}

const NOOP = Object.freeze({
  connected() {}, disconnected() {}, paused() {}, callStarted() {}, callFinished() {}, waitingConfirm() {}, confirmDone() {}, chat() {}, close() {},
  alert() {}, needsYou() {}, openAsk() {}, pid: () => null, enabled: false,
});

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

/** Cửa sổ chủ máy đang dùng khi hỏi bot (cửa sổ linh vật gửi kèm `ask` / `voice_start`): `{ window: '0x..', title, process }` hoặc null. */
export function userWindow(w) {
  if (!w || typeof w !== 'object' || typeof w.window !== 'string' || !/^0x[0-9a-f]{1,16}$/.test(w.window)) return null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return { window: w.window, title: text(w.title, 200), process: text(w.process, 64) };
}

/**
 * `onPause` / `onResume`: nút trên bảng nhật ký bật / tắt công tắc ngắt (như `aivin remote pause|resume`). `onVoice(msg)`: sự kiện nói
 * chuyện của cửa sổ (`voice_*`, xem ask.mjs); cửa sổ chết giữa chừng → `voice_stop`. `onChoose(id | ids)`: bấm nút trả lời câu Aivin hỏi (câu chọn nhiều: mảng id đã tích).
 * `onAsk(text, window)`: câu gõ trong ô hỏi + cửa sổ chủ máy đang dùng (`userWindow`). `pid()`: tiến trình của cửa sổ linh vật (null khi
 * chưa chạy). `spawnImpl`, `timers`, `now`, `dir`, `settingsFile`, các mốc `*Ms`: cho test.
 */
export function createMascot({
  enabled = true, platform = process.platform, env = process.env, onPause = () => {}, onResume = () => {}, say = () => {},
  onAsk = () => {}, onVoice = () => {}, onChoose = () => {}, onDrop = () => {},
  spawnImpl = spawn, dir = MASCOT_DIR, settingsFile = MASCOT_SETTINGS_FILE, showFile = MASCOT_SHOW_FILE, now = Date.now, timers = { setTimeout, clearTimeout },
  thinkMs = THINK_MS, resultMs = RESULT_MS, mainThrottleMs = MAIN_THROTTLE_MS, restartDelaysMs = RESTART_DELAYS_MS, awayWaveMs = AWAY_WAVE_MS,
} = {}) {
  if (!enabled || platform !== 'win32') return NOOP;
  const lang = mascotLang(env);
  const t = (key, vars) => mascotText(lang, key, vars);

  let child = null;
  let ready = false;
  let closed = false;
  // Linh vật đang tắt (`aivin remote mascot off` / nút "Tắt linh vật"): không mở cửa sổ, chỉ chờ `aivin ui` đánh thức.
  let dormant = !loadMascotSettings(settingsFile).enabled;
  let openAskOnReady = false;
  let restarts = 0;
  let restartTimer = null;
  const pending = [];
  let lastState = null;
  let lastMain = null;

  const write = (msg) => {
    try { child?.stdin?.write(`${JSON.stringify(msg)}\n`); } catch { /* cửa sổ vừa chết — lần dựng lại gửi trạng thái mới nhất */ }
  };
  // Câu hỏi đang chờ (dòng câu hỏi + nút + ghim ô hỏi): cửa sổ dựng lại / chưa sẵn sàng vẫn hiện lại đúng câu hỏi để trả lời.
  let lastQuestion = null;
  let lastChoices = null;
  let lastPin = null;
  const send = (msg) => {
    if (msg.t === HostCommand.STATE) lastState = msg;
    if (msg.t === HostCommand.MAIN) lastMain = msg;
    if (msg.t === AskCommand.CHAT && String(msg.id || '').startsWith(QUESTION_ROW)) lastQuestion = msg;
    if (msg.t === AskCommand.CHOICES) lastChoices = msg;
    if (msg.t === AskCommand.PIN) lastPin = msg;
    if (ready) return write(msg);
    if (msg.t === HostCommand.LOG) {
      pending.push(msg);
      if (pending.length > QUEUE_LOGS) pending.shift();
    }
  };
  const flush = () => {
    for (const msg of pending.splice(0)) write(msg);
    if (lastState) write(lastState);
    if (lastMain) write({ ...lastMain, quiet: true });
    if (guiActive > 0) write({ t: HostCommand.GUI, active: true });
    if (lastPin?.on) {
      if (lastQuestion) write(lastQuestion);
      if (lastChoices) write(lastChoices);
      write(lastPin);
    }
    if (openAskOnReady) { openAskOnReady = false; write({ t: HostCommand.OPEN_ASK }); }
  };

  const onEvent = (msg) => {
    if (msg.t === HostEvent.READY) { ready = true; restarts = 0; flush(); return; }
    if (msg.t === HostEvent.POS && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
      try { saveMascotSettings({ x: msg.x, y: msg.y }, settingsFile); } catch { /* không lưu được vị trí — lần sau về chỗ cũ */ }
      return;
    }
    if (msg.t === HostEvent.PAUSE) return onPause();
    if (msg.t === HostEvent.RESUME) return onResume();
    if (msg.t === HostEvent.HIDE) { hiddenUntilWork = true; return; }
    // Ô hỏi: chủ máy gõ / nói với bot → daemon gửi lên Aivin (ask.mjs).
    if (msg.t === HostEvent.ASK && typeof msg.text === 'string') return onAsk(msg.text, userWindow(msg.window));
    if (msg.t === HostEvent.CHOOSE) {
      // Câu chọn nhiều: `ids` = các mục đã tích; chọn một: `id`.
      if (Array.isArray(msg.ids) && msg.ids.length && msg.ids.every((x) => typeof x === 'string')) return onChoose(msg.ids);
      if (typeof msg.id === 'string') return onChoose(msg.id);
    }
    if (msg.t === HostEvent.DROP && Array.isArray(msg.files)) return onDrop(msg.files.filter((f) => typeof f === 'string' && f));
    if (msg.t === HostEvent.AWAY) { away = { since: now(), done: 0, failed: 0, needs: 0 }; return; }
    if (msg.t === HostEvent.BACK) return welcomeBack();
    if (msg.t === HostEvent.VOICE_START) return onVoice({ t: msg.t, window: userWindow(msg.window) });
    if (VOICE_EVENTS.has(msg.t)) return onVoice(msg);
    if (msg.t === HostEvent.OFF) {
      try { saveMascotSettings({ enabled: false }, settingsFile); } catch { /* tắt trong phiên này vẫn được */ }
      say(t(MascotText.TURNED_OFF));
      sleep();
    }
  };

  /** Tắt cửa sổ nhưng daemon vẫn giữ trạng thái — `aivin ui` đánh thức lại được. */
  function sleep() {
    dormant = true;
    timers.clearTimeout(restartTimer);
    quitHost();
  }

  function quitHost() {
    const c = child;
    if (!c) return;
    write({ t: HostCommand.QUIT });
    try { c.stdin?.end(); } catch { /* đã đóng */ }
    const kill = timers.setTimeout(() => { try { c.kill(); } catch { /* đã thoát */ } }, 1500);
    kill?.unref?.();
  }

  /** `aivin ui`: bật lại nếu đang tắt, hiện linh vật (kể cả đang "ẩn tới khi có việc"), mở ô hỏi để gõ ngay. */
  function wake() {
    if (closed) return;
    hiddenUntilWork = false;
    if (dormant || !child) {
      dormant = false;
      restarts = 0;
      openAskOnReady = true;
      return start();
    }
    if (!ready) { openAskOnReady = true; return; }
    write({ t: HostCommand.SHOW });
    write({ t: HostCommand.OPEN_ASK });
  }

  // Yêu cầu từ lệnh `aivin ui` (cửa sổ terminal khác): tệp đánh dấu đổi giờ sửa → đánh thức. Tính cả yêu cầu vừa ghi ngay trước khi daemon
  // này khởi động (`aivin ui` tự bật daemon rồi mới chờ).
  let showSeenAt = now() - SHOW_REQUEST_GRACE_MS;
  const showWatch = setInterval(() => {
    let at;
    try { at = fs.statSync(showFile).mtimeMs; } catch { return; }
    if (at <= showSeenAt) return;
    showSeenAt = at;
    wake();
  }, SHOW_POLL_MS);
  showWatch.unref?.();

  function start() {
    if (closed || dormant || child) return;
    let home;
    try {
      home = writeHostFiles({ dir, lang, settings: loadMascotSettings(settingsFile) });
    } catch {
      return;
    }
    let c;
    try {
      c = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(home, 'host.ps1')], {
        env: { ...env, AIVIN_MASCOT_DIR: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return;
    }
    child = c;
    ready = false;
    let stderr = '';
    c.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    c.stdin?.on('error', () => { /* cửa sổ đã đóng */ });
    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      try { onEvent(JSON.parse(line)); } catch { /* dòng lạ */ }
    });
    c.on('error', () => { /* xử lý ở close */ });
    c.on('close', () => {
      if (child === c) { child = null; ready = false; }
      onVoice({ t: HostEvent.VOICE_STOP });
      if (closed || dormant) return;
      // Không có màn hình (phiên dịch vụ), WPF hỏng… → thử lại giãn dần, quá số lần thì thôi (daemon vẫn chạy bình thường).
      const delay = restartDelaysMs[restarts++];
      if (delay === undefined) { say(`(mascot: ${stderr.trim().split(/\r?\n/).pop() || 'window could not start'})`); return; }
      restartTimer = timers.setTimeout(start, delay);
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(showWatch);
    timers.clearTimeout(restartTimer);
    timers.clearTimeout(thinkTimer);
    timers.clearTimeout(resultTimer);
    timers.clearTimeout(mainTimer);
    quitHost();
  }

  // --- Trạng thái ---------------------------------------------------------------------------------------------------------------------
  const active = new Map();
  const waiting = new Set();
  let guiActive = 0;
  let paused = false;
  let offline = false;
  let phase = MascotState.IDLE;
  let batchOk = 0;
  let batchFailed = null;
  let thinkTimer = null;
  let resultTimer = null;
  let hiddenUntilWork = false;
  /** Aivin đang hỏi chủ máy (câu hỏi chờ trả lời trong ô hỏi) — như chờ xác nhận: "!" tới khi trả lời. */
  let askingYou = false;
  /** Chủ máy đi vắng (cửa sổ báo không chạm chuột / phím một lúc): mốc + đếm việc xảy ra trong lúc đó, hoặc null. */
  let away = null;

  /** Quay lại sau khi vắng: có việc xảy ra → vẫy chào + bong bóng tóm tắt; vắng lâu mà không có gì → chỉ vẫy chào. */
  function welcomeBack() {
    const was = away;
    away = null;
    if (!was) return;
    const parts = [
      was.done && t(MascotText.AWAY_DONE, { n: was.done }),
      was.failed && t(MascotText.AWAY_FAILED, { n: was.failed }),
      was.needs && t(MascotText.AWAY_NEEDS, { n: was.needs }),
    ].filter(Boolean);
    if (!parts.length && now() - was.since < awayWaveMs) return;
    if (hiddenUntilWork) { hiddenUntilWork = false; send({ t: HostCommand.SHOW }); }
    send({ t: HostCommand.GESTURE, g: 'wave' });
    if (parts.length) main(t(MascotText.AWAY_SUMMARY, { parts: parts.join(', ') }));
  }

  const current = () => {
    if (paused) return MascotState.PAUSED;
    if (offline) return MascotState.OFFLINE;
    if (waiting.size || askingYou) return MascotState.WAITING;
    if (active.size) return MascotState.WORKING;
    return phase;
  };
  let shownState = null;
  const syncState = () => {
    const s = current();
    if (s === shownState) return;
    shownState = s;
    send({ t: HostCommand.STATE, state: s });
  };

  let mainTimer = null;
  let mainNext = null;
  let mainAt = 0;
  const main = (text) => {
    mainNext = text;
    const wait = mainThrottleMs - (now() - mainAt);
    if (wait > 0) {
      if (!mainTimer) mainTimer = timers.setTimeout(() => { mainTimer = null; main(mainNext); }, wait);
      return;
    }
    mainAt = now();
    send({ t: HostCommand.MAIN, text });
  };
  const log = (entry) => send({ t: HostCommand.LOG, time: hhmmss(now()), ...entry });

  const settle = () => {
    timers.clearTimeout(thinkTimer);
    timers.clearTimeout(resultTimer);
    if (active.size || waiting.size) return;
    // Hết lô bước: BE thường gửi lô kế trong vài giây (lượt Planner) — "đang nghĩ", chưa báo xong.
    phase = MascotState.THINKING;
    syncState();
    main(t(MascotText.THINKING));
    thinkTimer = timers.setTimeout(() => {
      phase = batchFailed ? MascotState.ERROR : MascotState.DONE;
      main(batchFailed ? t(MascotText.FAILED, { title: batchFailed }) : batchOk > 1 ? t(MascotText.DONE_MANY, { count: batchOk }) : t(MascotText.DONE_ONE));
      batchOk = 0;
      batchFailed = null;
      syncState();
      // Về chờ việc: mục "đang làm" của bảng nhật ký không giữ kết quả cũ (kết quả vẫn còn trong nhật ký); không bật bong bóng.
      resultTimer = timers.setTimeout(() => {
        phase = MascotState.IDLE;
        syncState();
        send({ t: HostCommand.MAIN, text: t(MascotText.READY), quiet: true });
      }, resultMs);
    }, thinkMs);
  };

  start();

  return {
    enabled: true,
    lang,
    /** Lệnh của ô hỏi (ask.mjs: chat / chat_busy / ask_status) → cửa sổ. */
    chat(cmd) { send(cmd); },
    connected() {
      offline = false;
      syncState();
      log({ status: LogStatus.INFO, title: t(MascotText.CONNECTED) });
      // Không bật bong bóng khi vừa nối (người dùng thấy thừa) — chỉ đặt lại mục "Đang làm" của bảng nhật ký.
      send({ t: HostCommand.MAIN, text: t(MascotText.READY), quiet: true });
    },
    disconnected() {
      if (offline) return;
      offline = true;
      syncState();
      log({ status: LogStatus.WARN, title: t(MascotText.DISCONNECTED) });
      main(t(MascotText.DISCONNECTED));
    },
    paused(on) {
      if (paused === on) return;
      paused = on;
      syncState();
      const text = t(on ? MascotText.PAUSED : MascotText.RESUMED);
      log({ status: on ? LogStatus.WARN : LogStatus.INFO, title: text });
      main(text);
    },
    callStarted(call, tool) {
      if (!call?.call_id || tool?.internal) return;
      const { title, detail } = describeStep({ call, tool, lang });
      active.set(call.call_id, { title, detail, gui: tool?.group === ToolGroup.GUI, at: now() });
      timers.clearTimeout(thinkTimer);
      timers.clearTimeout(resultTimer);
      phase = MascotState.WORKING;
      // AI sắp bấm / chụp cửa sổ: linh vật tránh đường (không che, không hứng cú bấm).
      if (tool?.group === ToolGroup.GUI && guiActive++ === 0) send({ t: HostCommand.GUI, active: true });
      if (hiddenUntilWork) { hiddenUntilWork = false; send({ t: HostCommand.SHOW }); }
      syncState();
      main(title);
      log({ id: call.call_id, status: LogStatus.RUN, title, sub: detail });
    },
    callFinished(call, tool, outcome) {
      const entry = active.get(call?.call_id);
      if (!entry) return;
      active.delete(call.call_id);
      if (entry.gui && --guiActive === 0) send({ t: HostCommand.GUI, active: false });
      const ms = Number(outcome?.duration_ms) || now() - entry.at;
      const took = ms >= 10_000 ? t(MascotText.SECONDS, { n: Math.round(ms / 1000) }) : t(MascotText.MS, { n: ms });
      if (outcome?.ok) batchOk++;
      else batchFailed = entry.title;
      log({ id: call.call_id, status: outcome?.ok ? LogStatus.OK : LogStatus.FAIL, sub: outcome?.ok ? `${entry.detail} · ${took}` : String(outcome?.error || '').slice(0, 300) });
      settle();
    },
    waitingConfirm(call, tool) {
      if (!call?.call_id) return;
      const { title } = describeStep({ call, tool, lang });
      waiting.add(call.call_id);
      syncState();
      main(t(MascotText.WAITING_CONFIRM, { title }));
    },
    confirmDone(call, allowed) {
      if (!waiting.delete(call?.call_id)) return;
      log({ status: allowed ? LogStatus.INFO : LogStatus.WARN, title: t(allowed ? MascotText.CONFIRM_ALLOWED : MascotText.CONFIRM_REJECTED) });
      syncState();
      if (!allowed) settle();
    },
    /**
     * Báo chủ động / câu trả lời của ô hỏi (ask.mjs `onAlert`): bong bóng ngắn + nét mặt — xong (nhảy, lấp lánh) / lỗi (lắc đầu) rồi về
     * chờ việc; cần bạn thì trạng thái do `needsYou` giữ. Đang có bước chạy trên máy thì chỉ hiện bong bóng, không đổi trạng thái.
     */
    alert({ kind, text } = {}) {
      if (!text) return;
      if (hiddenUntilWork) { hiddenUntilWork = false; send({ t: HostCommand.SHOW }); }
      const failed = kind === NotifyKind.FAILED;
      if (away) away[failed ? 'failed' : kind === NotifyKind.NEEDS_YOU ? 'needs' : 'done']++;
      log({ status: failed ? LogStatus.FAIL : kind === NotifyKind.NEEDS_YOU ? LogStatus.WARN : LogStatus.OK, title: text });
      main(text);
      if (kind === NotifyKind.NEEDS_YOU || active.size || waiting.size) return;
      timers.clearTimeout(thinkTimer);
      timers.clearTimeout(resultTimer);
      phase = failed ? MascotState.ERROR : MascotState.DONE;
      syncState();
      resultTimer = timers.setTimeout(() => {
        phase = MascotState.IDLE;
        syncState();
        send({ t: HostCommand.MAIN, text: t(MascotText.READY), quiet: true });
      }, resultMs);
    },
    /** Có / hết câu hỏi Aivin đang chờ chủ máy trả lời (ask.mjs `onPending`). */
    needsYou(on) {
      if (askingYou === !!on) return;
      askingYou = !!on;
      syncState();
    },
    /** Hiện linh vật + mở ô hỏi để gõ ngay (như `aivin ui`) — cho phím tắt / khay hệ thống; câu hỏi đang chờ (nếu có) đã nằm sẵn trong ô. */
    openAsk: wake,
    pid: () => child?.pid ?? null,
    close,
  };
}
