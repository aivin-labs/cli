
function formatDeviceLabel(raw, lang = 'vi') {
  if (!raw) return null;
  const isVi = lang === 'vi';
  const s = String(raw).trim();
  if (/iphone/i.test(s)) return isVi ? 'Điện thoại iPhone' : 'iPhone';
  if (/ipad/i.test(s)) return isVi ? 'Máy tính bảng iPad' : 'iPad';
  if (/android/i.test(s)) return isVi ? 'Điện thoại Android' : 'Android phone';
  if (/mac/i.test(s)) return isVi ? 'Máy tính Mac' : 'Mac computer';
  if (/win/i.test(s)) return isVi ? 'Máy tính khác' : 'Another computer';
  if (/web/i.test(s)) return isVi ? 'Trình duyệt web' : 'Web browser';
  return s;
}
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { NotifyKind, REMOTE_CONFIG_DIR, ToolGroup } from '../constants.mjs';
import { AIVIN_LOGO_PNG_BASE64 } from '../brand.mjs';
import { MASCOT_LAYERS } from './assets.mjs';
import { MASCOT_GLYPHS, MASCOT_PALETTE, MASCOT_PS1, MASCOT_XAML } from './hostSource.mjs';
import { ASK_PS1 } from './askHostSource.mjs';
import { AskCommand, MAX_ATTACH, QUESTION_ROW, safeWebUrl, VoiceCommand } from './ask.mjs';
import { hostHotkeys } from './hotkey.mjs';

const ASK_HOOK = '# @ASK_HOOK';
import { describeStep } from './labels.mjs';
import { MOOD_GESTURE, moodOf, SUBDUED_MOODS } from './mood.mjs';
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
export const HostCommand = Object.freeze({ STATE: 'state', MAIN: 'main', LOG: 'log', GUI: 'gui', SHOW: 'show', QUIT: 'quit', OPEN_ASK: 'open_ask', QUICK_VOICE: 'quick_voice', VOICE_TOGGLE: 'voice_toggle', GESTURE: 'gesture', NOTIFY_FREQ: 'notify_freq', REMOTE_VIEW: 'remote_view' });

/** `aivin ui` (terminal khác) chạm tệp này → daemon đang chạy hiện linh vật + mở ô hỏi (mascot/ui.mjs). */
export const MASCOT_SHOW_FILE = path.join(REMOTE_CONFIG_DIR, 'mascot-show');
export const MASCOT_HIDE_FILE = path.join(REMOTE_CONFIG_DIR, 'mascot-hide');
/** Mục "Quick voice" của khay chạm tệp này → daemon hiện linh vật + bắt đầu voice. Xử lý xong xoá luôn: daemon khởi động lại không được tự mở mic. */
export const MASCOT_VOICE_FILE = path.join(REMOTE_CONFIG_DIR, 'mascot-voice');
/** Phím tắt cửa sổ linh vật đang giữ thật (`{ chat, voice }`, tổ hợp đầu tiên còn trống) — khay đọc để hiện cạnh mục menu; cửa sổ đóng thì xoá. */
export const MASCOT_HOTKEYS_FILE = path.join(REMOTE_CONFIG_DIR, 'mascot-hotkeys.json');
/**
 * "Gửi cho AIVIN Bot" (chuột phải tệp / Send to, Aivin.exe --share; `aivin share`): mỗi yêu cầu một tệp `<mốc>-<pid>.txt`, mỗi dòng một đường
 * dẫn — Explorer chạy một tiến trình cho mỗi tệp được chọn, nên không ghi chung một tệp. Daemon đọc xong xoá, đính vào ô hỏi như kéo thả.
 */
export const MASCOT_ATTACH_DIR = path.join(REMOTE_CONFIG_DIR, 'mascot-attach');
/** Yêu cầu cũ hơn chừng này (daemon không chạy lúc đó) thì bỏ — không bật ô hỏi với tệp gửi từ hôm qua. Đủ cho khay mở daemon từ đầu. */
const ATTACH_REQUEST_GRACE_MS = 2 * 60_000;
const SHOW_POLL_MS = 250;
const SHOW_REQUEST_GRACE_MS = 30_000;

let attachRequestSeq = 0;

/** Ghi yêu cầu đính tệp cho daemon đang chạy (hoặc sắp chạy). Số thứ tự giữ đúng thứ tự gửi khi trùng mili giây (nơi đọc xếp theo tên tệp). */
export function requestMascotAttach(paths, dir = MASCOT_ATTACH_DIR) {
  const list = (paths || []).filter((p) => typeof p === 'string' && p).map((p) => path.resolve(p));
  if (!list.length) return;
  fs.mkdirSync(dir, { recursive: true });
  const seq = String(++attachRequestSeq).padStart(6, '0');
  const file = path.join(dir, `${Date.now()}-${process.pid}-${seq}-${randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(`${file}.tmp`, list.join('\r\n'));
  fs.renameSync(`${file}.tmp`, file);
}

/** Đọc + xoá mọi yêu cầu có đuôi `ext`; trả các dòng còn trong hạn (theo thứ tự gửi, không trùng). */
function takeRequests(dir, ext, now) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(ext)).sort(); } catch { return []; }
  const lines = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const fresh = now - fs.statSync(file).mtimeMs <= ATTACH_REQUEST_GRACE_MS;
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      fs.rmSync(file, { force: true });
      if (!fresh) continue;
      for (const line of text.split(/\r?\n/)) {
        const p = line.trim();
        if (p && !lines.includes(p)) lines.push(p);
      }
    } catch { /* đang ghi dở / vừa bị xoá — lần quét sau */ }
  }
  return lines;
}

/** Các đường dẫn "Gửi cho AIVIN Bot" đang chờ. */
export function takeAttachRequests(dir = MASCOT_ATTACH_DIR, now = Date.now()) {
  return takeRequests(dir, '.txt', now);
}

/** "Làm việc ở đây với AIVIN Bot" (Aivin.exe --workdir, cùng thư mục yêu cầu, đuôi `.workdir`): chọn nhiều lần thì lần sau cùng thắng. */
export function takeWorkFolderRequest(dir = MASCOT_ATTACH_DIR, now = Date.now()) {
  return takeRequests(dir, '.workdir', now).at(-1) || null;
}

/** Ghi yêu cầu hiện linh vật cho daemon đang chạy (hoặc sắp chạy). */
export function requestMascotShow(file = MASCOT_SHOW_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(Date.now()));
}

/** Ghi yêu cầu ẩn linh vật cho daemon đang chạy. */
export function requestMascotHide(file = MASCOT_HIDE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(Date.now()));
}
export const HostEvent = Object.freeze({
  READY: 'ready', POS: 'pos', PAUSE: 'pause', RESUME: 'resume', HIDE: 'hide', OFF: 'off', ASK: 'ask', CHOOSE: 'choose', CANCEL: 'cancel', NEW_CHAT: 'new_chat', OPEN_WEBVIEW: 'open_webview',
  DROP: 'drop', DETACH: 'detach', AWAY: 'away', BACK: 'back', NOTIFY_FREQ: 'notify_freq', HOTKEYS: 'hotkeys',
  VOICE_START: 'voice_start', VOICE_AUDIO: 'voice_audio', VOICE_INTERRUPT: 'voice_interrupt', VOICE_STOP: 'voice_stop', VOICE_MIC_LOST: 'voice_mic_lost',
});
const VOICE_EVENTS = new Set([HostEvent.VOICE_START, HostEvent.VOICE_AUDIO, HostEvent.VOICE_INTERRUPT, HostEvent.VOICE_STOP, HostEvent.VOICE_MIC_LOST]);

const THINK_MS = 8000;
const RESULT_MS = 6000;
const MAIN_THROTTLE_MS = 600;
/** Chờ chừng này trước khi báo mất kết nối: rớt mạng thoáng qua vài giây rồi tự nối lại ngay thì giữ im lặng, không bật bong bóng. */
const OFFLINE_GRACE_MS = 8000;
const RESTART_DELAYS_MS = [5000, 30_000, 120_000];
const QUEUE_LOGS = 40;
/** Vắng lâu chừng này mà không có việc gì xảy ra → quay lại vẫn được vẫy chào (không bong bóng). */
const AWAY_WAVE_MS = 30 * 60_000;

/** mascot.json có nhưng không đọc được thành object JSON (đang ghi dở, hỏng tay…) → lượt lưu không ghi đè (02/11/2026). */
export class MascotSettingsUnreadable extends Error {}

function readMascotFile(file) {
  let raw;
  const unreadable = (why) => new MascotSettingsUnreadable(`${file} could not be read (${why}) — fix or delete it`);
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw unreadable(e?.code || e?.message); }
  let data;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { throw unreadable(e?.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unreadable('not a JSON object');
  return data;
}

function normalizeMascotSettings(data) {
  const pos = Number.isFinite(data.x) && Number.isFinite(data.y) ? { x: data.x, y: data.y } : {};
  const freq = Number.isInteger(data.notify_freq) && data.notify_freq >= 0 && data.notify_freq <= 2 ? { notify_freq: data.notify_freq } : {};
  // `aivin remote mascot hotkey …` (cli.mjs): tổ hợp chủ máy đặt / 'off'; trước đây bị bỏ khi đọc → lượt lưu vị trí kế tiếp xoá mất.
  // Thư mục làm việc của ô hỏi ("Làm việc ở đây với AIVIN Bot"): giữ qua các lần khởi động lại, tới khi chủ máy bấm × trên chip.
  const workDir = typeof data.work_dir === 'string' && data.work_dir ? { work_dir: data.work_dir } : {};
  const hotkey = typeof data.hotkey === 'string' && data.hotkey ? { hotkey: data.hotkey } : {};
  const chatHotkey = typeof data.chat_hotkey === 'string' && data.chat_hotkey ? { chat_hotkey: data.chat_hotkey } : {};
  return { enabled: data.enabled !== false, ...freq, ...workDir, ...hotkey, ...chatHotkey, ...pos };
}

export function loadMascotSettings(file = MASCOT_SETTINGS_FILE) {
  try {
    return normalizeMascotSettings(readMascotFile(file) || {});
  } catch {
    return { enabled: true };
  }
}

/**
 * Đọc–sửa–ghi mascot.json, ghi nguyên tử (tệp tạm + rename: daemon, lệnh CLI, khay Aivin.exe cùng ghi tệp này). Tệp có mà hỏng → ném
 * MascotSettingsUnreadable, KHÔNG ghi đè (trước đây đọc hỏng = `{ enabled: true }` rồi ghi đè mất vị trí / phím tắt / mức báo); nơi gọi bỏ
 * qua, lượt lưu sau thử lại.
 */
export function saveMascotSettings(patch, file = MASCOT_SETTINGS_FILE) {
  const next = { ...normalizeMascotSettings(readMascotFile(file) || {}), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* đã dọn */ }
    throw e;
  }
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
    strings: windowStrings(lang), palette: MASCOT_PALETTE, glyphs: MASCOT_GLYPHS, x: settings.x ?? null, y: settings.y ?? null, max_files: MAX_ATTACH,
    notify_freq: settings.notify_freq ?? 1, hotkeys: hostHotkeys(settings.hotkey, settings.chat_hotkey),
  }));
  for (const name of fs.readdirSync(dir)) {
    if (name !== hash && /^[0-9a-f]{12}$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  return home;
}

const NOOP = Object.freeze({
  connected() {}, disconnected() {}, paused() {}, remoteView() {}, callStarted() {}, callFinished() {}, waitingConfirm() {}, confirmDone() {}, chat() {}, close() {},
  alert() {}, needsYou() {}, openAsk() {}, setNotifyFreq() {}, setLang() {}, get lang() { return 'en'; }, pid: () => null, enabled: false,
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
 * `onCancel()`: bấm nút dừng lượt chat đang chạy. `onNewChat()`: nút "Phiên chat mới" trên bảng nhật ký. `onOpenTool(msg)`: bấm mở công cụ tương tác trong câu trả lời.
 * `onAsk(text, window)`: câu gõ trong ô hỏi + cửa sổ chủ máy đang dùng (`userWindow`). `pid()`: tiến trình của cửa sổ linh vật (null khi
 * chưa chạy). `spawnImpl`, `timers`, `now`, `dir`, `settingsFile`, các mốc `*Ms`: cho test.
 */
export function createMascot({
  enabled = true, platform = process.platform, env = process.env, lang: preferredLang, onPause = () => {}, onResume = () => {}, say = () => {},
  onAsk = () => {}, onVoice = () => {}, onChoose = () => {}, onCancel = () => {}, onNewChat = () => {}, onOpenTool = () => {}, onDrop = () => {}, onWorkFolder = () => {}, onDetach = () => {}, onNotifyFreq = () => {},
  spawnImpl = spawn, dir = MASCOT_DIR, settingsFile = MASCOT_SETTINGS_FILE, showFile = MASCOT_SHOW_FILE, hideFile = MASCOT_HIDE_FILE, voiceFile = MASCOT_VOICE_FILE, hotkeysFile = MASCOT_HOTKEYS_FILE,
  attachDir = MASCOT_ATTACH_DIR, now = Date.now, timers = { setTimeout, clearTimeout },
  thinkMs = THINK_MS, resultMs = RESULT_MS, mainThrottleMs = MAIN_THROTTLE_MS, offlineGraceMs = OFFLINE_GRACE_MS, restartDelaysMs = RESTART_DELAYS_MS, awayWaveMs = AWAY_WAVE_MS,
} = {}) {
  if (!enabled || platform !== 'win32') return NOOP;
  let currentLang = preferredLang ? mascotLang(env, platform, preferredLang) : mascotLang(env, platform);
  const t = (key, vars) => mascotText(currentLang, key, vars);

  let child = null;
  let ready = false;
  let closed = false;
  // Linh vật đang tắt (`aivin remote mascot off` / nút "Tắt linh vật"): không mở cửa sổ, chỉ chờ `aivin ui` đánh thức.
  let dormant = !loadMascotSettings(settingsFile).enabled;
  // Lệnh chờ cửa sổ sẵn sàng sau khi được đánh thức: mở ô hỏi / bấm mic.
  let commandOnReady = null;
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
  // Tệp thả vào bot đang chờ: cửa sổ dựng lại vẫn ôm thùng có số tệp.
  let lastFiles = null;
  let lastRemoteView = null;
  // Đang nói chuyện bằng giọng (cửa sổ báo voice_start … voice_stop / daemon gửi voice_end): đổi ngôn ngữ chờ tới khi xong mới dựng lại.
  let voiceOn = false;
  let langRebuild = false;
  // Đang dựng lại cửa sổ có chủ đích (đổi ngôn ngữ): cửa sổ cũ đóng thì mở ngay, không tính là lần chết / không giãn thời gian thử lại.
  let rebuilding = false;
  const send = (msg) => {
    if (msg.t === HostCommand.STATE) lastState = msg;
    if (msg.t === HostCommand.MAIN) lastMain = msg;
    if (msg.t === AskCommand.CHAT && String(msg.id || '').startsWith(QUESTION_ROW)) lastQuestion = msg;
    if (msg.t === AskCommand.CHOICES) lastChoices = msg;
    if (msg.t === AskCommand.PIN) lastPin = msg;
    if (msg.t === AskCommand.FILES) lastFiles = msg;
    if (msg.t === HostCommand.REMOTE_VIEW) lastRemoteView = msg;
    if (msg.t === VoiceCommand.END) { voiceOn = false; if (langRebuild) timers.setTimeout(rebuildForLang, 0); }
    if (ready) return write(msg);
    if (msg.t === HostCommand.LOG) {
      pending.push(msg);
      if (pending.length > QUEUE_LOGS) pending.shift();
    }
    queueChat(msg);
  };
  // Ô hỏi lúc cửa sổ chưa sẵn sàng (đang mở / dựng lại): giữ dòng chat (theo id — dòng chữ chạy cập nhật tại chỗ), trạng thái bận, dòng
  // trạng thái mới nhất; trước 02/11/2026 bị bỏ hết → câu trả lời tới đúng lúc cửa sổ dựng lại thì mất.
  const pendingChat = new Map();
  let pendingBusy = null;
  let pendingStatus = null;
  let rowSeq = 0;
  function queueChat(msg) {
    if (msg.t === AskCommand.CLEAR) { pendingChat.clear(); pendingChat.set('\0clear', msg); return; }
    if (msg.t === AskCommand.BUSY) { pendingBusy = msg; return; }
    if (msg.t === AskCommand.STATUS) { pendingStatus = msg; return; }
    if (msg.t !== AskCommand.CHAT) return;
    const id = String(msg.id || '');
    if (msg.remove) { if (pendingChat.has(id)) { pendingChat.delete(id); return; } }
    pendingChat.set(id || `\0row${rowSeq++}`, msg);
    while (pendingChat.size > QUEUE_LOGS) pendingChat.delete(pendingChat.keys().next().value);
  }
  const flush = () => {
    for (const msg of pending.splice(0)) write(msg);
    for (const msg of pendingChat.values()) write(msg);
    pendingChat.clear();
    if (pendingBusy) write(pendingBusy);
    if (pendingStatus) write(pendingStatus);
    pendingBusy = null;
    pendingStatus = null;
    if (lastState) write(lastState);
    if (lastMain) write({ ...lastMain, quiet: true });
    if (guiActive > 0) write({ t: HostCommand.GUI, active: true });
    if (lastPin?.on) {
      if (lastQuestion) write(lastQuestion);
      if (lastChoices) write(lastChoices);
      write(lastPin);
    }
    if (lastFiles?.files?.length) write(lastFiles);
    if (lastRemoteView?.on) write(lastRemoteView);
    if (commandOnReady) { write({ t: commandOnReady }); commandOnReady = null; }
  };

  const onEvent = (msg) => {
    if (msg.t === HostEvent.READY) { ready = true; restarts = 0; flush(); return; }
    if (msg.t === HostEvent.POS && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
      try { saveMascotSettings({ x: msg.x, y: msg.y }, settingsFile); } catch { /* không lưu được vị trí — lần sau về chỗ cũ */ }
      return;
    }
    if (msg.t === HostEvent.PAUSE) return onPause();
    if (msg.t === HostEvent.RESUME) return onResume();
    if (msg.t === HostEvent.HOTKEYS) return writeHotkeys(msg);
    if (msg.t === HostEvent.HIDE) { hiddenUntilWork = true; return; }
    // Ô hỏi: chủ máy gõ / nói với bot → daemon gửi lên Aivin (ask.mjs).
    if (msg.t === HostEvent.ASK && typeof msg.text === 'string') return onAsk(msg.text, userWindow(msg.window));
    if (msg.t === HostEvent.CHOOSE) {
      // Câu chọn nhiều: `ids` = các mục đã tích; chọn một: `id`.
      if (Array.isArray(msg.ids) && msg.ids.length && msg.ids.every((x) => typeof x === 'string')) return onChoose(msg.ids);
      if (typeof msg.id === 'string') return onChoose(msg.id);
    }
    // Nút dừng (nút mic khi đang chờ lượt chat): dừng lượt đang chạy.
    if (msg.t === HostEvent.CANCEL) return onCancel();
    // Nút "Chat mới" trên bảng: phiên chat mới cho linh vật.
    if (msg.t === HostEvent.NEW_CHAT) return onNewChat();
    if (msg.t === HostEvent.OPEN_WEBVIEW) return onOpenTool(msg);
    if (msg.t === HostEvent.NOTIFY_FREQ && Number.isFinite(msg.value)) {
      const val = Number(msg.value);
      if (val >= 0 && val <= 2) {
        try { saveMascotSettings({ notify_freq: val }, settingsFile); } catch {}
        onNotifyFreq(val);
      }
      return;
    }
    if (msg.t === HostEvent.DROP && Array.isArray(msg.files)) return onDrop(msg.files.filter((f) => typeof f === 'string' && f));
    if (msg.t === HostEvent.DETACH && typeof msg.path === 'string' && msg.path) return onDetach(msg.path);
    if (msg.t === HostEvent.AWAY) { away = { since: now(), done: 0, failed: 0, needs: 0 }; return; }
    if (msg.t === HostEvent.BACK) return welcomeBack();
    if (msg.t === HostEvent.VOICE_START) { voiceOn = true; return onVoice({ t: msg.t, window: userWindow(msg.window) }); }
    if (msg.t === HostEvent.VOICE_STOP || msg.t === HostEvent.VOICE_MIC_LOST) {
      voiceOn = false;
      onVoice(msg);
      return rebuildForLang();
    }
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

  /** Dựng lại cửa sổ theo ngôn ngữ mới khi rảnh (không nói chuyện); chưa có cửa sổ / đang tắt → lần mở kế tiếp tự dùng chữ mới. */
  function rebuildForLang() {
    if (!langRebuild || voiceOn || closed) return;
    langRebuild = false;
    if (!child || dormant) return;
    rebuilding = true;
    quitHost(300);
  }

  function quitHost(killAfterMs = 1500) {
    const c = child;
    if (!c) return;
    write({ t: HostCommand.QUIT });
    try { c.stdin?.end(); } catch { /* đã đóng */ }
    const kill = timers.setTimeout(() => { try { c.kill(); } catch { /* đã thoát */ } }, killAfterMs);
    kill?.unref?.();
  }

  function writeHotkeys({ chat, voice }) {
    const labels = { ...(typeof chat === 'string' && chat ? { chat } : {}), ...(typeof voice === 'string' && voice ? { voice } : {}) };
    try { fs.writeFileSync(hotkeysFile, JSON.stringify(labels)); } catch { /* khay chỉ không hiện phím tắt */ }
  }

  /**
   * `aivin ui` / khay: bật lại nếu đang tắt, hiện linh vật (kể cả đang "ẩn tới khi có việc"), rồi `command`: mở ô hỏi để gõ ngay (mặc định)
   * hoặc bắt đầu voice (Quick voice).
   */
  function wake(command = HostCommand.OPEN_ASK) {
    if (closed) return;
    hiddenUntilWork = false;
    try { saveMascotSettings({ enabled: true }, settingsFile); } catch {}
    if (dormant || !child) {
      dormant = false;
      restarts = 0;
      commandOnReady = command;
      return start();
    }
    if (!ready) { commandOnReady = command; return; }
    write({ t: HostCommand.SHOW });
    write({ t: command });
  }

  // Yêu cầu hiện/ẩn linh vật từ khay hệ thống hoặc lệnh `aivin ui`: tệp đánh dấu đổi giờ sửa.
  // Tệp đánh dấu còn lại từ lần bật trước (không bao giờ bị xoá) không được bật lại linh vật mỗi lần daemon khởi động dù chủ máy đã tắt —
  // chỉ yêu cầu mới trong khoảng ân hạn (vd `aivin ui` vừa chạy, daemon đang lên) mới tính, như tệp ẩn (02/11/2026).
  let showSeenAt = now() - SHOW_REQUEST_GRACE_MS;
  let hideSeenAt = now() - SHOW_REQUEST_GRACE_MS;
  const voiceSeenAt = now() - SHOW_REQUEST_GRACE_MS;
  const showWatch = setInterval(() => {
    try {
      const showAt = fs.statSync(showFile).mtimeMs;
      if (showAt > showSeenAt) {
        showSeenAt = showAt;
        wake();
      }
    } catch {}
    try {
      const hideAt = fs.statSync(hideFile).mtimeMs;
      if (hideAt > hideSeenAt) {
        hideSeenAt = hideAt;
        try { saveMascotSettings({ enabled: false }, settingsFile); } catch {}
        sleep();
      }
    } catch {}
    try {
      const voiceAt = fs.statSync(voiceFile).mtimeMs;
      fs.rmSync(voiceFile, { force: true });
      if (voiceAt > voiceSeenAt) wake(HostCommand.QUICK_VOICE);
    } catch {}
    const shared = takeAttachRequests(attachDir, now());
    if (shared.length) {
      onDrop(shared);
      wake();
    }
    const workFolder = takeWorkFolderRequest(attachDir, now());
    if (workFolder) {
      onWorkFolder(workFolder);
      wake();
    }
  }, SHOW_POLL_MS);
  showWatch.unref?.();

  function start() {
    if (closed || dormant || child) return;
    let home;
    try {
      home = writeHostFiles({ dir, lang: currentLang, settings: loadMascotSettings(settingsFile) });
    } catch {
      return;
    }
    let c;
    try {
      c = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(home, 'host.ps1')], {
        env: { ...env, AIVIN_MASCOT_DIR: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch {
      return;
    }
    child = c;
    ready = false;
    let stderr = '';
    // Chuỗi (không phải Buffer) theo UTF-8: ký tự nhiều byte bị cắt giữa hai mẩu không vỡ thành "�".
    c.stderr?.setEncoding?.('utf8');
    c.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    c.stdin?.on('error', () => { /* cửa sổ đã đóng */ });
    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      try { onEvent(JSON.parse(line)); } catch { /* dòng lạ */ }
    });
    c.on('error', () => { /* xử lý ở close */ });
    c.on('close', () => {
      if (child === c) { child = null; ready = false; }
      try { fs.rmSync(hotkeysFile, { force: true }); } catch { /* khay vẫn kiểm tra daemon + linh vật đang bật */ }
      voiceOn = false;
      onVoice({ t: HostEvent.VOICE_STOP });
      if (closed || dormant) return;
      if (rebuilding) { rebuilding = false; return start(); }
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
    timers.clearTimeout(offlineTimer);
    quitHost();
  }

  // --- Trạng thái ---------------------------------------------------------------------------------------------------------------------
  const active = new Map();
  const waiting = new Set();
  let guiActive = 0;
  let paused = false;
  let offline = false;
  let offlineTimer = null;
  let everConnected = false;
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
  const main = (text, url = null) => {
    mainNext = { text, url };
    const wait = mainThrottleMs - (now() - mainAt);
    if (wait > 0) {
      if (!mainTimer) mainTimer = timers.setTimeout(() => { mainTimer = null; main(mainNext.text, mainNext.url); }, wait);
      return;
    }
    mainAt = now();
    send({ t: HostCommand.MAIN, text, ...(url ? { url } : {}) });
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
    get lang() { return currentLang; },
    /** Lệnh của ô hỏi (ask.mjs: chat / chat_busy / ask_status) → cửa sổ. */
    chat(cmd) { send(cmd); },
    connected() {
      const hadBlip = offlineTimer !== null && !offline && everConnected;
      timers.clearTimeout(offlineTimer);
      offlineTimer = null;
      everConnected = true;
      if (hadBlip) return;
      offline = false;
      syncState();
      log({ status: LogStatus.INFO, title: t(MascotText.CONNECTED) });
      // Không bật bong bóng khi vừa nối (người dùng thấy thừa) — chỉ đặt lại mục "Đang làm" của bảng nhật ký.
      send({ t: HostCommand.MAIN, text: t(MascotText.READY), quiet: true });
    },
    disconnected() {
      if (offline || offlineTimer) return;
      const showOffline = () => {
        offlineTimer = null;
        if (offline || closed) return;
        offline = true;
        syncState();
        log({ status: LogStatus.WARN, title: t(MascotText.DISCONNECTED) });
        main(t(MascotText.DISCONNECTED));
      };
      if (offlineGraceMs <= 0) return showOffline();
      offlineTimer = timers.setTimeout(showOffline, offlineGraceMs);
    },
    paused(on) {
      if (paused === on) return;
      paused = on;
      syncState();
      const text = t(on ? MascotText.PAUSED : MascotText.RESUMED);
      log({ status: on ? LogStatus.WARN : LogStatus.INFO, title: text });
      main(text);
    },
        /** Có người đang xem + điều khiển màn hình máy này từ web (Desktop Scenecast) — chủ máy luôn biết. */
    remoteView(on, { device } = {}) {
      send({ t: HostCommand.REMOTE_VIEW, on: !!on });
      if (on) {
        const devName = formatDeviceLabel(device, currentLang);
        const text = devName
          ? t(MascotText.CAST_VIEWING_DEVICE, { device: devName })
          : t(MascotText.CAST_VIEWING);
        log({ status: LogStatus.WARN, title: text });
        main(text);
        send({ t: HostCommand.GESTURE, g: 'startle', face: 'curious', sec: 4.5 });
      } else {
        const text = t(MascotText.CAST_ENDED);
        log({ status: LogStatus.INFO, title: text });
        main(text);
        send({ t: HostCommand.GESTURE, g: 'relief', face: 'relief', sec: 2.5 });
      }
    },
    callStarted(call, tool) {
      if (!call?.call_id || tool?.internal) return;
      const { title, detail } = describeStep({ call, tool, lang: currentLang });
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
      const { title } = describeStep({ call, tool, lang: currentLang });
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
     * Emoji cảm xúc trong câu (mood.mjs) → thêm cử chỉ + nét mặt; buồn / ngượng thì không nhảy mừng "xong", về thẳng chờ việc. Báo lỗi
     * đã có nét mặt riêng (lắc đầu) nên không xét emoji.
     */
    alert({ kind, text, url: rawUrl } = {}) {
      if (!text) return;
      // Cửa sổ mở link bằng Process.Start khi bấm bong bóng / dòng nhật ký: chỉ http(s).
      const url = safeWebUrl(rawUrl);
      if (hiddenUntilWork) { hiddenUntilWork = false; send({ t: HostCommand.SHOW }); }
      // Khách cần nhân viên không phải việc AI làm trên máy: chỉ hiện chữ, không báo "xong", không nét mặt theo emoji trong lời khách.
      if (kind === NotifyKind.CUSTOMER) {
        log({ status: LogStatus.WARN, title: text, ...(url ? { url } : {}) });
        return main(text, url);
      }
      const failed = kind === NotifyKind.FAILED;
      const mood = failed ? null : moodOf(text);
      const react = () => { if (mood) send({ t: HostCommand.GESTURE, ...MOOD_GESTURE[mood] }); };
      if (away) away[failed ? 'failed' : kind === NotifyKind.NEEDS_YOU ? 'needs' : 'done']++;
      log({ status: failed ? LogStatus.FAIL : kind === NotifyKind.NEEDS_YOU ? LogStatus.WARN : LogStatus.OK, title: text, ...(url ? { url } : {}) });
      main(text, url);
      if (kind === NotifyKind.NEEDS_YOU || active.size || waiting.size) return react();
      timers.clearTimeout(thinkTimer);
      timers.clearTimeout(resultTimer);
      if (SUBDUED_MOODS.has(mood)) {
        phase = MascotState.IDLE;
        syncState();
        return react();
      }
      phase = failed ? MascotState.ERROR : MascotState.DONE;
      syncState();
      react();
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
    openAsk: () => wake(),
    setNotifyFreq: (val) => send({ t: HostCommand.NOTIFY_FREQ, value: Number(val) }),
    /**
     * Ngôn ngữ người dùng trên Aivin (HELLO) khác ngôn ngữ đang hiện: chữ trên cửa sổ nằm trong config.json → phải dựng lại cửa sổ. Cùng
     * ngôn ngữ → không làm gì; đang nói chuyện bằng giọng → chờ tới khi xong (02/11/2026: trước đây kill cửa sổ ngay mỗi lần nối lại).
     */
    setLang(nextLang) {
      if (!nextLang) return;
      const resolved = mascotLang(env, platform, nextLang);
      if (resolved === currentLang) return;
      currentLang = resolved;
      langRebuild = true;
      rebuildForLang();
    },
    pid: () => child?.pid ?? null,
    close,
  };
}
