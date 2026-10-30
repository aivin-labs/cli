import { randomUUID } from 'crypto';
import path from 'path';
import { ChatEventKind, DeviceEvent, NotifyKind, VoiceEventKind } from '../constants.mjs';
import { createAdpcmEncoder, decodeAdpcm, VOICE_CODEC } from './adpcm.mjs';
import { MascotText, mascotText } from './strings.mjs';

/**
 * Ô hỏi của linh vật, phía daemon (29/10/2026): chủ máy gõ hoặc nói với bot → lượt chat THẬT trên Aivin qua socket của máy
 * (`device:chat`, BE chạy như gõ trên web, trong phiên riêng của máy) → tiến trình + câu trả lời về qua `device:chat_event` rồi hiện trong
 * ô hỏi. Mỗi lúc một câu.
 *
 * Nói chuyện (realtime): cửa sổ bấm mic → `device:voice_start` → BE mở đúng phiên thoại của nút mic trên web (model giọng nói, nói chen,
 * việc nặng giao agent) → `ready` báo tần số → cửa sổ mở mic + loa; mic đi lên từng đoạn ~100 ms (`device:voice_audio`), tiếng bot về
 * (`audio`) chuyển thẳng xuống cửa sổ (`voice_play`), chữ hai bên hiện thành dòng chat. Rớt mạng / BE đóng phiên → báo cửa sổ dừng.
 * BE chưa có nói chuyện (không báo `voice` khi chào): cùng bộ thu đó nhưng gom lại, bấm mic lần nữa → WAV → `device:stt` → hỏi như câu gõ
 * (CLI phát hành trước BE vẫn dùng được mic).
 *
 * Màn hình: câu hỏi / cuộc nói chuyện mang theo `context.window` = cửa sổ chủ máy đang dùng ngay trước khi với tới bot (`{ window: '0x..',
 * title, process }`) — agent biết "cái này" là gì để `gui.observe` / `screen.capture` đúng chỗ. Công cụ `gui.*` không nói cửa sổ mà focus
 * đang ở chính bot → dùng cửa sổ đó (`userWindow()`, client.mjs nối vào gui/index.mjs).
 * Phiên realtime tính phí theo thời gian mà mic gửi cả lúc im lặng (BE chỉ tự đóng sau 30 phút): không ai nói, bot không nói 60 s → tự kết
 * thúc (đang chờ agent làm việc thì 3 phút). Đang ghi biên bản họp (`micBusy()`) thì không mở — giọng bot / câu nói với bot sẽ lọt vào biên bản.
 *
 * Chữ chạy (30/10/2026): câu hỏi xin `stream: true` → BE (mới) gửi `delta` = câu trả lời đang viết (cả câu tới lúc đó) → một dòng bot cập nhật
 * tại chỗ (nhạt); câu chốt (bản rút gọn, "(chi tiết trên Aivin)") thay đúng dòng đó. BE cũ / lượt chạy ở node khác: chỉ có câu chốt như trước.
 *
 * Lệnh gửi cửa sổ: `chat { role: user | assistant | progress | error, id, text, remove? }`, `chat_busy { busy }`, `ask_status { text }`,
 * `ask_choices { options: [{ id, text, icon? }], multiple }` (rỗng = bỏ nút; multiple = tích nhiều mục rồi xác nhận),
 * `voice_begin { in_rate, out_rate, state? }`, `voice_play { audio }`, `voice_flush`, `voice_state { state }`, `voice_end { text? }`.
 */

export const ChatRole = Object.freeze({ USER: 'user', ASSISTANT: 'assistant', PROGRESS: 'progress', ERROR: 'error' });
export const AskCommand = Object.freeze({ CHAT: 'chat', BUSY: 'chat_busy', STATUS: 'ask_status', CHOICES: 'ask_choices', PIN: 'ask_pin' });
/** Tiền tố id dòng câu hỏi đang chờ (index.mjs gửi lại dòng này khi cửa sổ dựng lại). */
export const QUESTION_ROW = 'q-';
export const VoiceCommand = Object.freeze({ BEGIN: 'voice_begin', PLAY: 'voice_play', FLUSH: 'voice_flush', STATE: 'voice_state', END: 'voice_end' });
export const VoiceState = Object.freeze({ LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking', RECORDING: 'recording' });

const PROGRESS_ROW = 'progress';
const ACK_TIMEOUT_MS = 15_000;
/** BE mở phiên với nhà cung cấp giọng nói rồi mới báo `ready` — quá lâu thì coi như hỏng. */
const VOICE_READY_TIMEOUT_MS = 20_000;
const VOICE_IN_RATE = 16_000;
const VOICE_OUT_RATE = 24_000;
const TIMED_OUT_REASONS = new Set(['idle_timeout', 'max_duration']);
/** Chế độ ghi (BE cũ): 16 kHz mono, tối thiểu 0,6 s, tối đa ~75 s (BE nhận tối đa 2,5 MB). */
const RECORD_RATE = 16_000;
const MIN_RECORD_BYTES = RECORD_RATE * 2 * 0.6;
const MAX_RECORD_BYTES = 2_400_000;
const STT_TIMEOUT_MS = 60_000;
/** Im lặng (không ai nói, bot không nói) quá lâu → tự kết thúc; đang chờ agent trả lời thì nới. */
const VOICE_IDLE_MS = 60_000;
const VOICE_AWAIT_MS = 180_000;
const VOICE_IDLE_CHECK_MS = 5_000;

/** PCM16 mono → tệp WAV trong bộ nhớ. */
export function pcmToWav(pcm, rate = RECORD_RATE) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** Mã lỗi BE (DeviceChatError) → khoá chữ. */
const ERROR_TEXT = {
  busy: MascotText.ASK_ERR_BUSY,
  too_long: MascotText.ASK_ERR_TOO_LONG,
  not_understood: MascotText.ASK_ERR_NOT_UNDERSTOOD,
  disabled: MascotText.ASK_ERR_DISABLED,
  empty: MascotText.ASK_ERR_NOT_UNDERSTOOD,
  no_question: MascotText.ASK_ERR_NO_QUESTION,
  invalid_answer: MascotText.ASK_ERR_INVALID_ANSWER,
};

const NOTIFY_LABEL = { [NotifyKind.DONE]: MascotText.NOTIFY_DONE, [NotifyKind.FAILED]: MascotText.NOTIFY_FAILED, [NotifyKind.NEEDS_YOU]: MascotText.NOTIFY_NEEDS_YOU };
/** `kind` câu hỏi có cấu trúc của BE (DeviceDirectQuestionKind). */
export const QuestionKind = Object.freeze({ CHOICE: 'choice', FORM: 'form', TEXT: 'text' });
/** id nút "Bỏ qua" của trường không bắt buộc trong biểu mẫu. */
export const FORM_SKIP_ID = '__skip__';
const SEEN_NOTIFY_MAX = 50;
const MAX_ATTACH = 10;
/** Câu hỏi chờ tối đa; quá thì bỏ câu cũ nhất sau câu đang hiện nút. */
const MAX_PENDING = 20;

/**
 * `socket()`: socket `/device` hiện tại (có thể chưa nối). `send(cmd)`: gửi lệnh cho cửa sổ linh vật. `lang`: ngôn ngữ chữ hiện ra.
 * `onAlert({ kind, text })`: báo chủ động / Aivin hỏi lại → linh vật bật bong bóng + trạng thái (kind = NotifyKind).
 * `onPending(on)`: có / hết câu hỏi đang chờ chủ máy trả lời. `micBusy()`: mic đang dùng cho việc khác (ghi biên bản họp) → không mở nói chuyện.
 *
 * Câu hỏi đang chờ (`needs_input` của lượt chat, hoặc báo chủ động kèm câu hỏi): thẻ chọn → nút trong ô hỏi (`ask_choices`); bấm nút
 * (`choose`) hoặc gõ (`reply`) → `device:chat` kèm `session_id` + `reply_id` — BE trả lời đúng câu hỏi đó rồi theo dõi câu trả lời kế.
 * Nhiều việc cùng hỏi → xếp hàng theo thứ tự đến: nút là của câu đầu hàng, dòng của nó ghi "(còn N câu hỏi nữa)"; trả lời xong thì câu
 * kế lên đầu (dòng + nút mới, ô vẫn ghim). Cùng `reply_id` hỏi lại → cập nhật tại chỗ, không xếp thêm.
 * Biểu mẫu (`kind: form`): hỏi lần lượt từng trường trong ô hỏi (trường có lựa chọn → nút, không bắt buộc → thêm nút "Bỏ qua"), đủ thì gửi
 * một lần `fields` (+ `text` = giá trị khi chỉ một trường — BE cũ chưa nhận `fields` vẫn hiểu). BE từ chối → hỏi lại từ trường đầu.
 */
export function createMascotChat({
  socket, send, lang, timers = { setTimeout, clearTimeout }, now = Date.now, onAlert = () => {}, onPending = () => {}, micBusy = () => false,
}) {
  const t = (key, vars) => mascotText(lang, key, vars);
  let current = null;
  /** Câu hỏi đang chờ theo thứ tự đến: `{ session_id, reply_id, kind, options, text }`; đầu hàng = câu đang có nút. */
  const queue = [];
  const head = () => queue[0] || null;
  const seenNotify = new Set();
  /** Tệp thả vào bot, chờ đi kèm câu kế tiếp; `attachRow` = dòng "📎" đang hiện. */
  const files = [];
  let attachRow = null;
  /** Cửa sổ chủ máy đang dùng khi hỏi (mascot/index.mjs `userWindow`) của lượt / cuộc nói chuyện gần nhất, hoặc null. */
  let target = null;
  const context = () => (target ? { context: { window: target } } : {});

  /**
   * Câu hỏi đang chờ: dòng câu hỏi (id `q-<reply_id>`, cửa sổ dựng lại thì daemon gửi lại) + nút lựa chọn, rồi ghim ô hỏi — ô tự bật ra
   * (không lấy bàn phím) và ở đó tới khi trả lời. Không phải câu hỏi (thiếu reply_id) → chỉ là một dòng chữ.
   */
  const questionRow = (q, more = 0) => row(ChatRole.ASSISTANT, more ? `${q.text}\n${t(MascotText.ASK_QUEUED, { n: more })}` : q.text, `${QUESTION_ROW}${q.reply_id}`);
  /** Dòng + nút của câu đầu hàng, rồi ghim ô hỏi (gửi lại được — cửa sổ cập nhật dòng theo id). */
  const showHead = () => {
    const q = head();
    questionRow(q, queue.length - 1);
    if (q.fields) promptField(q);
    else showChoices(q.options, q.multiple);
    send({ t: AskCommand.PIN, on: true });
  };
  /** Nút lựa chọn: `multiple` = câu chọn nhiều (cửa sổ cho tích nhiều mục rồi xác nhận); `icon` của mục (nếu có) đi kèm để hiện cuối nút. */
  const showChoices = (options, multiple = false) => send({
    t: AskCommand.CHOICES, multiple,
    options: options.map((o) => ({ id: String(o.id), text: String(o.text), ...(typeof o.icon === 'string' && o.icon ? { icon: o.icon } : {}) })),
  });
  const setPending = (sessionId, question, text) => {
    if (!question?.reply_id) return row(ChatRole.ASSISTANT, text);
    const entry = { session_id: sessionId, reply_id: question.reply_id, kind: question.kind, options: Array.isArray(question.options) ? question.options : [], multiple: question.multiple === true, text };
    const fields = question.kind === QuestionKind.FORM && Array.isArray(question.fields) ? question.fields.filter((f) => f?.name) : [];
    if (fields.length) Object.assign(entry, { fields, values: {}, step: 0 });
    const at = queue.findIndex((q) => q.reply_id === entry.reply_id);
    if (at >= 0) {
      // BE gửi lại cùng câu hỏi (nối lại / báo chủ động): giữ các trường đã điền.
      if (entry.fields && queue[at].fields) Object.assign(entry, { values: queue[at].values, step: queue[at].step });
      queue[at] = entry;
      return at === 0 ? showHead() : undefined;
    }
    if (queue.length >= MAX_PENDING) queue.splice(1, 1);
    queue.push(entry);
    // Câu xếp sau: hiện ngay một dòng thường để chủ máy biết; câu đầu hàng ghi thêm số câu còn chờ.
    if (queue.length > 1) row(ChatRole.ASSISTANT, text);
    showHead();
    if (queue.length === 1) onPending(true);
  };
  /** Câu hỏi `replyId` đã xong (trả lời được / hết hạn): bỏ khỏi hàng; là câu đầu thì đưa câu kế lên, hết hàng thì bỏ nút + ghim. */
  const resolve = (replyId) => {
    const at = queue.findIndex((q) => q.reply_id === replyId);
    if (at < 0) return;
    const [done] = queue.splice(at, 1);
    // Dòng câu vừa xong bỏ "(còn N câu hỏi nữa)" — câu kế hiện dòng riêng ở cuối.
    if (at === 0) questionRow(done);
    if (queue.length) return showHead();
    send({ t: AskCommand.CHOICES, options: [] });
    send({ t: AskCommand.PIN, on: false });
    onPending(false);
  };

  // ---- Biểu mẫu: từng trường một (`q.fields`, `q.values`, `q.step`) ----
  /** Dòng hỏi trường hiện tại (id mang tiền tố câu hỏi — cửa sổ dựng lại thì hiện lại đúng trường đang hỏi) + nút của trường. */
  function promptField(q) {
    const f = q.fields[q.step];
    const total = q.fields.length;
    const options = Array.isArray(f.options) ? f.options : [];
    // Một trường bắt buộc không có lựa chọn: câu hỏi đã đủ, không cần dòng tên trường.
    if (total > 1 || options.length || !f.required) {
      const label = total > 1 ? t(MascotText.FORM_FIELD, { label: f.label || f.name, n: q.step + 1, total }) : String(f.label || f.name);
      row(ChatRole.ASSISTANT, f.required ? label : `${label} ${t(MascotText.FORM_OPTIONAL)}`, `${QUESTION_ROW}${q.reply_id}-${q.step}`);
    }
    showChoices(f.required ? options : [...options, { id: FORM_SKIP_ID, text: t(MascotText.FORM_SKIP) }]);
  }
  /** Ghi giá trị trường hiện tại (`null` = bỏ qua) → trường kế, hoặc gửi cả biểu mẫu một lần. */
  async function fillField(q, value, shown) {
    const last = q.step === q.fields.length - 1;
    // Đang bận: không ghi trường cuối — bấm / gõ lại được, không phải điền lại từ đầu.
    if (last && refuseBusy()) return;
    row(ChatRole.USER, shown);
    if (value !== null) q.values[q.fields[q.step].name] = value;
    q.step += 1;
    if (!last) return promptField(q);
    showChoices([]);
    const { fields, values } = q;
    // Một trường: `text` = giá trị (BE chưa nhận `fields` vẫn gán vào trường đó); nhiều trường: tóm tắt cho lịch sử chat.
    const text = fields.length === 1 ? values[fields[0].name] || '' : fields.filter((f) => f.name in values).map((f) => `${f.label || f.name}: ${values[f.name]}`).join('\n');
    await turn(text, null, { session_id: q.session_id, reply_id: q.reply_id, fields: values }, undefined);
    // Không gửi được / BE từ chối mà câu hỏi còn đó → hỏi lại từ trường đầu.
    if (head() === q) {
      Object.assign(q, { values: {}, step: 0 });
      promptField(q);
    }
  }
  /** Chữ gõ cho trường hiện tại: trường có lựa chọn phải khớp tên một nút (hoặc "Bỏ qua" khi không bắt buộc). */
  function typeField(q, answer) {
    const f = q.fields[q.step];
    const options = Array.isArray(f.options) ? f.options : [];
    const key = answer.toLowerCase();
    if (!f.required && key === t(MascotText.FORM_SKIP).toLowerCase()) return fillField(q, null, t(MascotText.FORM_SKIP));
    if (!options.length) return fillField(q, answer, answer);
    const match = options.find((o) => String(o.text).trim().toLowerCase() === key || String(o.id).toLowerCase() === key);
    if (match) return fillField(q, String(match.id), String(match.text));
    row(ChatRole.USER, answer);
    row(ChatRole.ERROR, t(MascotText.ASK_ERR_INVALID_ANSWER));
  }
  /** Nút của trường hiện tại. */
  function chooseField(q, id) {
    const f = q.fields[q.step];
    if (id === FORM_SKIP_ID && !f.required) return fillField(q, null, t(MascotText.FORM_SKIP));
    const option = (Array.isArray(f.options) ? f.options : []).find((o) => String(o.id) === String(id));
    return option ? fillField(q, String(option.id), String(option.text)) : undefined;
  }

  const row = (role, text, id = `${role}-${randomUUID()}`, extra = {}) => send({ t: AskCommand.CHAT, role, id, text, ...extra });
  const setBusy = (busy) => send({ t: AskCommand.BUSY, busy });
  const errorText = (code) => t(ERROR_TEXT[code] || MascotText.ASK_ERR_FAILED);
  /** Dòng chữ chạy của câu trả lời đang viết (id + chữ tới lúc đó) — câu chốt thay vào đúng dòng này. */
  let streaming = null;
  const finish = () => {
    current = null;
    row(ChatRole.PROGRESS, '', PROGRESS_ROW, { remove: true });
    setBusy(false);
    send({ t: AskCommand.STATUS, text: '' });
  };

  /** Lỗi "không biết sự kiện" từ BE cũ: socket.io không ack → hết giờ. Phân biệt bằng việc máy vẫn nối. */
  const failedSend = (e) => (String(e?.message || '').includes('timed out') ? t(MascotText.ASK_ERR_UNSUPPORTED) : t(MascotText.ASK_ERR_FAILED));
  /**
   * Đang chờ lượt trước / đang nói chuyện → không gửi, nhưng báo trong ô hỏi (trước đây bấm nút trả lời giữa cuộc nói chuyện thì không có
   * gì xảy ra). Câu gõ / nút vẫn còn đó để làm lại.
   */
  const refuseBusy = () => {
    if (!current && !call) return false;
    send({ t: AskCommand.STATUS, text: t(call ? MascotText.ASK_BUSY_VOICE : MascotText.ASK_ERR_BUSY) });
    return true;
  };

  /**
   * Một lượt `device:chat`: `shown` = dòng người dùng hiện ra (null = đã hiện rồi, như các trường biểu mẫu), `extra` = trả lời câu hỏi
   * (`session_id`, `reply_id`, `option_ids` / `fields`).
   * `window` (câu gõ / nói từ ô hỏi) đi kèm thành `context.window` — BE nói cho agent biết "cái này" là cửa sổ nào; câu không đến từ ô hỏi
   * (lượt sau họp) thì không có. Bấm nút trả lời giữ cửa sổ của câu trước (`undefined`).
   */
  async function turn(text, shown, extra, window) {
    if (refuseBusy()) return;
    if (window !== undefined) target = window;
    const s = socket();
    if (shown !== null) row(ChatRole.USER, shown);
    if (!s?.connected) return row(ChatRole.ERROR, t(MascotText.ASK_OFFLINE));
    current = `ask-${randomUUID()}`;
    streaming = null;
    setBusy(true);
    row(ChatRole.PROGRESS, t(MascotText.ASK_THINKING), PROGRESS_ROW);
    let ack;
    try {
      // `stream`: xin chữ chạy của câu trả lời (`delta`) — BE cũ bỏ qua trường này.
      ack = await s.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.CHAT, { text, request_id: current, stream: true, ...context(), ...extra });
    } catch (e) {
      finish();
      return row(ChatRole.ERROR, failedSend(e));
    }
    if (!ack?.ok) {
      finish();
      // Câu hỏi đã hết hạn / có người trả lời ở nơi khác → bỏ nút; trả lời sai dạng → giữ để chọn lại.
      if (extra.reply_id && ack?.error !== 'invalid_answer') resolve(extra.reply_id);
      return row(ChatRole.ERROR, errorText(ack?.error));
    }
    if (extra.reply_id) resolve(extra.reply_id);
  }

  /** Tệp / thư mục thả vào bot: giữ tới câu gõ kế tiếp (tối đa MAX_ATTACH), hiện một dòng "📎 tên tệp" trong ô hỏi. */
  function attach(paths) {
    for (const f of paths || []) if (typeof f === 'string' && f && !files.includes(f) && files.length < MAX_ATTACH) files.push(f);
    if (!files.length) return;
    attachRow ||= `attach-${randomUUID()}`;
    row(ChatRole.USER, t(MascotText.ASK_ATTACHED, { names: files.map((f) => path.basename(f.replace(/[\\/]+$/, '')) || f).join(', ') }), attachRow);
  }

  /** Câu hỏi mới như chủ máy gõ (luôn vào phiên riêng của máy, kể cả khi đang có câu hỏi chờ). */
  async function ask(text, window = null) {
    const question = String(text || '').trim();
    if (question) await turn(question, question, {}, window);
  }

  /**
   * Chủ máy gõ trong ô hỏi: đang có câu hỏi chờ → là câu trả lời (khớp tên một nút thì như bấm nút); không thì hỏi mới. Có tệp vừa thả
   * vào bot → đường dẫn đi kèm cuối câu (agent dùng công cụ tệp của máy để đọc / chuyển).
   */
  async function reply(text, window = null) {
    const answer = String(text || '').trim();
    const pending = head();
    if (files.length) {
      if (refuseBusy()) return;
      const sent = files.splice(0);
      attachRow = null;
      const shown = answer || t(MascotText.ASK_FILES_DEFAULT);
      const body = `${shown}\n\n${t(MascotText.ASK_FILES_LABEL)}\n${sent.map((f) => `- ${f}`).join('\n')}`;
      return turn(body, shown, pending ? { session_id: pending.session_id, reply_id: pending.reply_id } : {}, window);
    }
    if (!answer) return;
    if (!pending) return ask(answer, window);
    if (pending.fields) return typeField(pending, answer);
    const byText = (s) => pending.options.find((o) => String(o.text).trim().toLowerCase() === s.toLowerCase());
    // Chọn nhiều: gõ tên các mục cách nhau dấu phẩy — khớp hết mới tính như tích các nút đó.
    const matches = (pending.multiple ? answer.split(/\s*[,;]\s*/).filter(Boolean) : [answer]).map(byText);
    const ids = matches.every(Boolean) ? [...new Set(matches.map((o) => String(o.id)))] : [];
    await turn(answer, answer, { session_id: pending.session_id, reply_id: pending.reply_id, ...(ids.length ? { option_ids: ids } : {}) }, window);
  }

  /** Bấm một nút lựa chọn (`id`), hoặc xác nhận các mục đã tích của câu chọn nhiều (`ids`). */
  async function choose(id) {
    const pending = head();
    if (pending?.fields) return Array.isArray(id) ? undefined : chooseField(pending, id);
    const ids = [...new Set((Array.isArray(id) ? id : [id]).map(String))];
    const picked = ids.map((x) => pending?.options.find((o) => String(o.id) === x));
    if (!ids.length || picked.some((o) => !o) || (ids.length > 1 && !pending.multiple)) return;
    await turn('', picked.map((o) => String(o.text)).join(', '), { session_id: pending.session_id, reply_id: pending.reply_id, option_ids: ids }, undefined);
  }

  /** Sự kiện của lượt đang hỏi (sự kiện của câu cũ / máy khác cùng phòng bị bỏ qua). */
  function onChatEvent(payload) {
    if (!payload || payload.request_id !== current) return;
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (payload.kind === ChatEventKind.PROGRESS) return row(ChatRole.PROGRESS, text, PROGRESS_ROW);
    if (payload.kind === ChatEventKind.DELTA) {
      if (!text) return;
      // Chữ đầu tiên tới: thôi "Đang nghĩ…", câu trả lời hiện dần (nhạt hơn tới khi chốt).
      if (!streaming) { streaming = { id: `${ChatRole.ASSISTANT}-${randomUUID()}` }; row(ChatRole.PROGRESS, '', PROGRESS_ROW, { remove: true }); }
      streaming.text = text;
      return row(ChatRole.ASSISTANT, text, streaming.id, { partial: true });
    }
    const streamed = streaming;
    streaming = null;
    finish();
    // Câu chốt (bản rút gọn) thay đúng dòng chữ chạy; hết giờ chờ thì giữ phần đã viết; câu hỏi / lỗi thì bỏ dòng dở.
    const answerRow = streamed?.id;
    if (streamed && payload.kind === ChatEventKind.TIMEOUT) row(ChatRole.ASSISTANT, streamed.text, streamed.id);
    else if (streamed && payload.kind !== ChatEventKind.ANSWER) row(ChatRole.ASSISTANT, '', streamed.id, { remove: true });
    if (payload.kind === ChatEventKind.NEEDS_INPUT) {
      setPending(payload.session_id, payload.question, text);
      return onAlert({ kind: NotifyKind.NEEDS_YOU, text });
    }
    if (payload.kind === ChatEventKind.ANSWER || payload.kind === ChatEventKind.TIMEOUT) {
      const final = payload.more ? `${text} ${t(MascotText.ASK_MORE)}` : text;
      if (payload.kind === ChatEventKind.ANSWER && answerRow) row(ChatRole.ASSISTANT, final, answerRow);
      else row(ChatRole.ASSISTANT, final);
      // Hết giờ chờ = việc còn chạy (BE báo chủ động khi xong) — chưa phải "xong".
      return payload.kind === ChatEventKind.ANSWER ? onAlert({ kind: NotifyKind.DONE, text }) : undefined;
    }
    row(ChatRole.ERROR, errorText(text));
  }

  /**
   * Báo chủ động (`device:notify`): việc của chủ máy xong / lỗi / cần trả lời — hiện một dòng trong ô hỏi + bong bóng; có câu hỏi thì
   * thành câu hỏi đang chờ (nút / gõ để trả lời). Máy nối lại có thể nhận lại cùng `id` → bỏ trùng.
   */
  function onNotify(payload) {
    if (!payload || typeof payload.kind !== 'string' || !NOTIFY_LABEL[payload.kind]) return;
    if (payload.id) {
      if (seenNotify.has(payload.id)) return;
      seenNotify.add(payload.id);
      if (seenNotify.size > SEEN_NOTIFY_MAX) seenNotify.delete(seenNotify.values().next().value);
    }
    const label = t(NOTIFY_LABEL[payload.kind]);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const line = [`${label}${title ? `: ${title}` : ''}`, text].filter(Boolean).join('\n');
    if (payload.kind === NotifyKind.NEEDS_YOU && payload.question) setPending(payload.session_id, payload.question, line);
    else row(payload.kind === NotifyKind.FAILED ? ChatRole.ERROR : ChatRole.ASSISTANT, line);
    onAlert({ kind: payload.kind, text: `${label}: ${text || title}` });
  }

  // ---- Nói chuyện realtime ----
  /** null = không nói chuyện; còn lại: đã `ready` chưa, dòng chat của người / của bot đang dựng, bot có đang phát tiếng. */
  let call = null;
  let voiceSupported = true;

  const voiceState = (state) => send({ t: VoiceCommand.STATE, state });
  const emitVoice = (event) => { try { socket()?.emit(event); } catch { /* đã rớt */ } };
  /** Hẹn giờ của phiên nói chuyện không giữ tiến trình sống (daemon đã có socket giữ). */
  const later = (fn, ms) => { const h = timers.setTimeout(fn, ms); h?.unref?.(); return h; };
  const clearCallTimers = (c) => {
    timers.clearTimeout(c.readyTimer);
    timers.clearTimeout(c.idleTimer);
  };
  const dropProgress = () => row(ChatRole.PROGRESS, '', PROGRESS_ROW, { remove: true });
  const endCall = (text = '') => {
    if (!call) return;
    clearCallTimers(call);
    if (!call.record) dropProgress();
    call = null;
    send({ t: VoiceCommand.END, text });
  };
  /** Có ai đó nói / bot đang trả lời → tính lại giờ im lặng. */
  const touch = () => { if (call) call.lastActivity = now(); };
  const checkIdle = (me) => {
    if (call !== me) return;
    if (me.speaking) touch();
    const limit = me.awaiting ? VOICE_AWAIT_MS : VOICE_IDLE_MS;
    if (now() - me.lastActivity >= limit) {
      emitVoice(DeviceEvent.VOICE_STOP);
      return endCall(t(MascotText.VOICE_IDLE_ENDED));
    }
    me.idleTimer = later(() => checkIdle(me), VOICE_IDLE_CHECK_MS);
  };
  /** Chữ lỗi BE gửi: mã quen (DeviceChatError) → câu của máy; còn lại BE đã viết sẵn theo ngôn ngữ người dùng. */
  const voiceErrorText = (message) => (!message || ERROR_TEXT[message] || message === 'failed' ? errorText(message) : String(message));
  const finishBotRow = () => {
    call.botRow = null;
    call.botText = '';
  };

  /** BE báo trong ack của `device:hello` có `voice` hay không — BE cũ thì bấm mic báo cần bản mới ngay. */
  function setVoiceSupported(on) {
    voiceSupported = !!on;
  }

  async function voiceStart(window = null) {
    if (call) return;
    const s = socket();
    if (!s?.connected) return send({ t: VoiceCommand.END, text: t(MascotText.ASK_OFFLINE) });
    if (current) return send({ t: VoiceCommand.END, text: t(MascotText.ASK_ERR_BUSY) });
    if (micBusy()) return send({ t: VoiceCommand.END, text: t(MascotText.VOICE_MIC_BUSY) });
    if (!voiceSupported) {
      call = { record: true, ready: true, chunks: [], bytes: 0 };
      return send({ t: VoiceCommand.BEGIN, in_rate: RECORD_RATE, out_rate: VOICE_OUT_RATE, state: VoiceState.RECORDING });
    }
    target = window;
    const me = { ready: false, userRow: null, botRow: null, botText: '', speaking: false, awaiting: false, turn: 0, lastActivity: now() };
    call = me;
    me.readyTimer = later(() => {
      if (call !== me || me.ready) return;
      emitVoice(DeviceEvent.VOICE_STOP);
      endCall(t(MascotText.ASK_ERR_FAILED));
    }, VOICE_READY_TIMEOUT_MS);
    let ack;
    try {
      // Xin âm thanh ADPCM nhị phân (~5 lần nhỏ hơn PCM base64); BE cũ không trả `codec` → PCM base64 như trước.
      ack = await s.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.VOICE_START, { ...context(), codec: VOICE_CODEC });
    } catch (e) {
      if (call === me) endCall(failedSend(e));
      return;
    }
    // Đã bấm kết thúc trong lúc chờ ack → đóng phiên BE vừa mở.
    if (call !== me) return ack?.ok ? emitVoice(DeviceEvent.VOICE_STOP) : undefined;
    if (!ack?.ok) return endCall(errorText(ack?.error));
    if (ack.codec === VOICE_CODEC) me.encode = createAdpcmEncoder();
  }

  /** Đoạn mic từ cửa sổ → BE (bỏ khi chưa `ready` / đã rớt mạng). */
  function voiceAudio(audio) {
    const s = socket();
    if (!call?.ready || typeof audio !== 'string' || !audio) return;
    if (call.record) {
      const pcm = Buffer.from(audio, 'base64');
      call.chunks.push(pcm);
      call.bytes += pcm.length;
      if (call.bytes >= MAX_RECORD_BYTES) void finishRecording(true);
      return;
    }
    if (!s?.connected) return;
    s.emit(DeviceEvent.VOICE_AUDIO, { audio: call.encode ? call.encode(Buffer.from(audio, 'base64')) : audio });
  }

  /**
   * Bấm mic khi bot đang nói: cửa sổ đã tự bỏ phần chưa phát; BE huỷ lượt trả lời. Chỉ gửi khi bot thật sự đang nói — gửi lúc bot im thì
   * nhà cung cấp báo lỗi và đóng phiên (đo thật trên web 25/09/2026).
   */
  function voiceInterrupt() {
    if (!call?.speaking) return;
    call.speaking = false;
    finishBotRow();
    emitVoice(DeviceEvent.VOICE_INTERRUPT);
    voiceState(VoiceState.LISTENING);
  }

  /** Cửa sổ kết thúc (bấm mic / đóng ô / cửa sổ chết): đóng phiên BE, cửa sổ đã tự dừng. */
  function voiceStop() {
    if (!call) return;
    if (call.record) return void finishRecording(false);
    clearCallTimers(call);
    dropProgress();
    call = null;
    emitVoice(DeviceEvent.VOICE_STOP);
  }

  /** Cửa sổ mất mic (rút ra / Bluetooth rớt, mở lại không được) → kết thúc, báo kiểm tra micro. */
  function voiceMicLost() {
    if (!call) return;
    if (!call.record) emitVoice(DeviceEvent.VOICE_STOP);
    endCall(t(MascotText.ASK_NO_MIC));
  }

  /** Mất kết nối máy chủ: phiên thoại trên BE đã đóng theo socket. */
  function voiceDisconnected() {
    endCall(t(MascotText.ASK_OFFLINE));
  }

  /** Chế độ ghi: nói xong (bấm mic, hoặc chạm giới hạn → tự dừng cửa sổ) → chữ → hỏi như câu gõ. */
  async function finishRecording(auto) {
    const rec = call;
    call = null;
    const status = (text) => send({ t: AskCommand.STATUS, text });
    const transcribing = t(MascotText.ASK_TRANSCRIBING);
    if (auto) send({ t: VoiceCommand.END, text: transcribing });
    else status(transcribing);
    if (rec.bytes < MIN_RECORD_BYTES) return status(t(MascotText.ASK_TOO_SHORT));
    const s = socket();
    if (!s?.connected) return status(t(MascotText.ASK_OFFLINE));
    let res;
    try {
      res = await s.timeout(STT_TIMEOUT_MS).emitWithAck(DeviceEvent.STT, { audio: pcmToWav(Buffer.concat(rec.chunks)), lang });
    } catch (e) {
      return status(failedSend(e));
    }
    if (!res?.ok || !res.text) return status(errorText(res?.error));
    status('');
    return ask(res.text, target);
  }

  function onVoiceEvent(payload) {
    if (!call || call.record || !payload || typeof payload.kind !== 'string') return;
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (payload.kind !== VoiceEventKind.ERROR && payload.kind !== VoiceEventKind.CLOSED) touch();
    switch (payload.kind) {
      case VoiceEventKind.READY:
        if (call.ready) return;
        call.ready = true;
        timers.clearTimeout(call.readyTimer);
        { const me = call; me.idleTimer = later(() => checkIdle(me), VOICE_IDLE_CHECK_MS); }
        send({ t: VoiceCommand.BEGIN, in_rate: Number(payload.input_sample_rate) || VOICE_IN_RATE, out_rate: Number(payload.output_sample_rate) || VOICE_OUT_RATE });
        return;
      case VoiceEventKind.USER_TRANSCRIPT:
        // Chữ cả câu đến giờ (không phải phần thêm) — cùng một dòng tới khi chốt.
        if (!text) return;
        call.userRow ||= `voice-user-${++call.turn}`;
        row(ChatRole.USER, text, call.userRow, payload.final ? {} : { partial: true });
        if (payload.final) {
          call.userRow = null;
          call.awaiting = true;
          voiceState(VoiceState.THINKING);
        }
        return;
      case VoiceEventKind.ASSISTANT_TRANSCRIPT:
        // final=false là phần thêm, final=true là cả câu.
        call.botText = payload.final ? text : call.botText + text;
        if (!call.botText) return;
        call.botRow ||= `voice-bot-${++call.turn}`;
        call.awaiting = false;
        dropProgress();
        row(ChatRole.ASSISTANT, call.botText, call.botRow);
        return;
      case VoiceEventKind.AUDIO:
        {
          // Cửa sổ nhận PCM base64 (stdin là chữ): tiếng ADPCM nhị phân giải ở đây.
          const audio = payload.codec === VOICE_CODEC ? decodeAdpcm(payload.audio).toString('base64') : payload.audio;
          if (typeof audio !== 'string' || !audio) return;
          send({ t: VoiceCommand.PLAY, audio });
        }
        call.awaiting = false;
        if (!call.speaking) {
          call.speaking = true;
          voiceState(VoiceState.SPEAKING);
        }
        return;
      case VoiceEventKind.AUDIO_DONE:
        call.speaking = false;
        finishBotRow();
        voiceState(VoiceState.LISTENING);
        return;
      case VoiceEventKind.SPEECH_STARTED:
        // Người dùng nói chen: bỏ phần tiếng bot chưa phát (BE tự huỷ lượt trả lời).
        send({ t: VoiceCommand.FLUSH });
        call.speaking = false;
        finishBotRow();
        voiceState(VoiceState.LISTENING);
        return;
      case VoiceEventKind.PROGRESS:
        // Agent đang làm việc được giao (run_agent_task): một dòng tiến trình, mất khi bot nói tiếp.
        if (text) row(ChatRole.PROGRESS, text, PROGRESS_ROW);
        return;
      case VoiceEventKind.ERROR:
        emitVoice(DeviceEvent.VOICE_STOP);
        endCall(voiceErrorText(payload.message));
        return;
      case VoiceEventKind.CLOSED:
        endCall(t(TIMED_OUT_REASONS.has(payload.reason) ? MascotText.VOICE_TIMED_OUT : MascotText.VOICE_ENDED));
        return;
      default:
    }
  }

  return {
    ask, reply, choose, attach, onChatEvent, onNotify, busy: () => !!current || !!call, hasPending: () => queue.length > 0, userWindow: () => target,
    voiceStart, voiceAudio, voiceInterrupt, voiceStop, voiceMicLost, voiceDisconnected, onVoiceEvent, setVoiceSupported, inCall: () => !!call,
  };
}
