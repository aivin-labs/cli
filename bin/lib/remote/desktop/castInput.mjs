/**
 * Cổng thao tác chuột / phím từ xa (Desktop Scenecast) — lớp chặn cuối trên máy, không tin BE / trình duyệt: chỉ nhận action đã biết,
 * chỉ chép trường đã biết (trường lạ như `op` không bao giờ xuống tiến trình điều khiển), bỏ khi chủ máy đã tạm dừng, khi AI đang thao tác
 * giao diện, hoặc gửi quá dồn. Thao tác qua kênh WebRTC cũng đi qua đây.
 */

export const CAST_INPUT_ACTIONS = Object.freeze([
  'move', 'click', 'dblclick', 'rightclick', 'mousedown', 'mouseup', 'scroll', 'type', 'paste', 'clipboard', 'key', 'hotkey',
  'paste_image', 'paste_html'
]);

export const CastInputRejection = Object.freeze({
  INVALID: 'invalid',
  PAUSED: 'paused',
  AI_ACTIVE: 'ai_active',
  RATE_LIMITED: 'rate_limited',
  /** Người xem khác đang cầm lái (vừa thao tác / đang giữ nút) — hai người không giành chuột cùng lúc. */
  OTHER_VIEWER: 'other_viewer',
});

const ACTIONS = new Set(CAST_INPUT_ACTIONS);
const MAX_COORD = 100_000;
const MAX_SCROLL = 10_000;
/** Toạ độ theo tỷ lệ (rx, ry): 0 = mép trái / trên, 65535 = mép phải / dưới. */
const RATIO_SCALE = 65_535;
const MAX_KEY_CHARS = 24;
const MAX_PASTE_CHARS = 65_536;
const MAX_PASTE_IMAGE_CHARS = 25_000_000;
const MAX_PASTE_HTML_CHARS = 12_000_000;

function finiteIn(value, limit) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

function shortStrings(value, maxCount) {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((k) => typeof k === 'string' && k && k.length <= MAX_KEY_CHARS).slice(0, maxCount);
  return out.length ? out : undefined;
}

/** Lọc một thao tác thành lệnh hợp lệ (cùng luật với BE `sanitizeCastInput`); không hợp lệ → null. */
export function sanitizeCastInput(raw, maxTypeChars = 2000) {
  if (!raw || typeof raw !== 'object') return null;
  const action = String(raw.action || '');
  if (!ACTIONS.has(action)) return null;
  const cmd = { action };
  const x = finiteIn(raw.x, MAX_COORD);
  const y = finiteIn(raw.y, MAX_COORD);
  if (x !== undefined && y !== undefined) { cmd.x = Math.round(x); cmd.y = Math.round(y); }
  const rx = finiteIn(raw.rx, RATIO_SCALE);
  const ry = finiteIn(raw.ry, RATIO_SCALE);
  if (rx >= 0 && ry >= 0) { cmd.rx = Math.round(rx); cmd.ry = Math.round(ry); }
  const button = Number(raw.button);
  if (button === 0 || button === 1 || button === 2) cmd.button = button;
  const deltaX = finiteIn(raw.deltaX, MAX_SCROLL);
  const deltaY = finiteIn(raw.deltaY, MAX_SCROLL);
  if (deltaX !== undefined) cmd.deltaX = Math.round(deltaX);
  if (deltaY !== undefined) cmd.deltaY = Math.round(deltaY);
  const charLimit = action === 'paste' || action === 'clipboard' || action === 'paste_html' ? MAX_PASTE_CHARS : maxTypeChars;
  if (typeof raw.text === 'string' && raw.text) cmd.text = raw.text.slice(0, charLimit);
  if (typeof raw.key === 'string' && raw.key && raw.key.length <= MAX_KEY_CHARS) cmd.key = raw.key;
  const keys = shortStrings(raw.keys, 6);
  if (keys) cmd.keys = keys;
  // Số thao tác để đo bấm -> thấy hình đổi (12/11/2026); máy chỉ chép lại vào khung sau, không dùng làm gì khác.
  const iseq = Number(raw.iseq);
  if (Number.isInteger(iseq) && iseq > 0 && iseq < 2 ** 31) cmd.iseq = iseq;
  const modifiers = shortStrings(raw.modifiers, 4);
  if (modifiers) cmd.modifiers = modifiers;
  if (action === 'paste_image') {
    // Quá trần thì bỏ hẳn: cắt ngắn base64 là ảnh hỏng.
    if (typeof raw.data !== 'string' || !raw.data || raw.data.length > MAX_PASTE_IMAGE_CHARS) return null;
    cmd.data = raw.data;
    if (typeof raw.mime === 'string') cmd.mime = raw.mime.slice(0, 64);
    if (raw.click) cmd.click = true;
    return cmd;
  }
  if (action === 'paste_html') {
    if (typeof raw.html !== 'string' || !raw.html || raw.html.length > MAX_PASTE_HTML_CHARS) return null;
    cmd.html = raw.html;
    return cmd;
  }
  if ((action === 'type' || action === 'paste' || action === 'clipboard') && !cmd.text) return null;
  if (action === 'key' && !cmd.key) return null;
  if (action === 'hotkey' && !cmd.keys) return null;
  return cmd;
}

/**
 * `isPaused()`: công tắc ngắt của chủ máy. `isAiBusy()`: AI đang chạy công cụ GUI ghi. `accept(raw, viewerId)` → `{ ok, cmd }` hoặc
 * `{ ok: false, reason }`. `waitHumanIdle()`: công cụ GUI của AI chờ người thôi thao tác (tối đa `maxWaitMs`) trước khi bấm — hai bên không
 * giành chuột cùng lúc.
 *
 * Nhiều người xem (09/11/2026): mỗi lúc một người cầm lái — người khác vừa thao tác trong `exclusiveMs` hoặc đang giữ nút thì thao tác của
 * mình bị bỏ (`OTHER_VIEWER`). Nút đang giữ theo dõi theo từng người: một người rời phiên chỉ nhả nút của người đó (`releaseViewer`).
 */
export function createCastInputGate({ isPaused = () => false, isAiBusy = () => false, maxPerSec = 120, exclusiveMs = 1000, now = Date.now, sleep } = {}) {
  let lastHumanAt = null;
  let takeover = null;
  let accepted = 0;
  let window = { start: 0, count: 0 };
  /** Người xem đang cầm lái + lúc thao tác cuối của họ. */
  let driver = null;
  let driverAt = -Infinity;
  /** Nút chuột từng người xem đang giữ trên máy: gói nhả của chúng luôn được qua cổng, không thì nút kẹt xuống tới hết phiên. */
  const heldButtons = new Map();
  const heldOf = (viewer) => {
    if (!heldButtons.has(viewer)) heldButtons.set(viewer, new Set());
    return heldButtons.get(viewer);
  };
  const othersHolding = (viewer) => [...heldButtons].some(([v, set]) => v !== viewer && set.size > 0);
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function accept(raw, viewerId = '') {
    const viewer = String(viewerId ?? '');
    const releasing = raw?.action === 'mouseup' && !!heldButtons.get(viewer)?.has(Number(raw.button) || 0);
    const t = now();
    const blocked = isPaused() ? CastInputRejection.PAUSED : isAiBusy() ? CastInputRejection.AI_ACTIVE
      : driver !== null && driver !== viewer && (t - driverAt < exclusiveMs || othersHolding(viewer)) ? CastInputRejection.OTHER_VIEWER : null;
    if (blocked && !releasing) return { ok: false, reason: blocked };
    if (t - window.start >= 1000) window = { start: t, count: 0 };
    if (++window.count > maxPerSec && !releasing) return { ok: false, reason: CastInputRejection.RATE_LIMITED };
    const cmd = sanitizeCastInput(raw);
    if (!cmd) return { ok: false, reason: CastInputRejection.INVALID };
    if (cmd.action === 'mousedown') heldOf(viewer).add(cmd.button ?? 0);
    if (cmd.action === 'mouseup') heldButtons.get(viewer)?.delete(cmd.button ?? 0);
    if (blocked) {
      // Chỉ nhả nút, không kéo con trỏ khỏi chỗ AI / người khác đang bấm; không tính là đang thao tác.
      const { x: _x, y: _y, rx: _rx, ry: _ry, ...release } = cmd;
      return { ok: true, cmd: release };
    }
    lastHumanAt = t;
    driver = viewer;
    driverAt = t;
    accepted++;
    return { ok: true, cmd };
  }

  /**
   * Người xem rời phiên: trả các nút người đó còn giữ (nơi gọi gửi `mouseup` từng nút) và thả quyền cầm lái của họ. Thao tác đi qua máy chủ
   * (đường JPEG) không mang mã người xem, gộp vào `''`: không biết của ai nên nhả luôn — thà nhả nhầm một lần kéo còn hơn nút kẹt tới hết phiên.
   */
  function releaseViewer(viewerId = '') {
    const buttons = new Set();
    for (const viewer of new Set([String(viewerId ?? ''), ''])) {
      for (const button of heldButtons.get(viewer) || []) buttons.add(button);
      heldButtons.delete(viewer);
      if (driver === viewer) { driver = null; driverAt = -Infinity; }
    }
    return [...buttons];
  }

  /** Người xem bấm "Bạn" lúc AI đang chạy: `{ idleMs, maxWaitMs }` = bắt đầu tạm cầm lái, `null` = trả lại AI. */
  function setHumanTakeover(opts) {
    takeover = opts?.idleMs > 0 ? { idleMs: opts.idleMs, maxWaitMs: opts.maxWaitMs > 0 ? opts.maxWaitMs : opts.idleMs, at: now() } : null;
  }

  /** Còn đang tạm cầm lái không — người ngừng thao tác đủ lâu thì quyền tự về AI. */
  function humanTakeoverHeld() {
    if (!takeover) return false;
    if (now() - Math.max(takeover.at, lastHumanAt ?? 0) < takeover.idleMs) return true;
    takeover = null;
    return false;
  }

  /** Bước GUI kế tiếp có thể phải chờ người tối đa bao lâu (0 = không ai đang cầm lái) — để xin BE lùi hạn của lời gọi. */
  function takeoverWaitMs() { return humanTakeoverHeld() ? takeover.maxWaitMs : 0; }

  /** `false` = AI chưa được bấm: bị huỷ khi đang chờ, hoặc người vẫn cầm lái tới hết `maxWaitMs` của lần tạm cầm lái. */
  async function waitHumanIdle({ idleMs = 1500, maxWaitMs = 3000, signal } = {}) {
    if (humanTakeoverHeld()) {
      const takeoverDeadline = now() + takeover.maxWaitMs;
      while (humanTakeoverHeld()) {
        if (signal?.aborted || now() >= takeoverDeadline) return false;
        await wait(250);
      }
    }
    if (signal?.aborted) return false;
    const deadline = now() + maxWaitMs;
    while (lastHumanAt !== null && now() - lastHumanAt < idleMs && now() < deadline) {
      await wait(Math.min(250, Math.max(10, idleMs - (now() - lastHumanAt))));
    }
    return !signal?.aborted;
  }

  /** Số thao tác đã nhận từ lần gọi trước (nhật ký phiên trên máy) — đọc xong đặt lại 0. */
  function takeAcceptedCount() { const n = accepted; accepted = 0; return n; }

  /** Máy vừa nhả hết nút (`release_all`): AI sắp bấm hoặc phiên dừng. Trả có đang giữ nút nào không để nơi gọi biết cần gửi lệnh nhả. */
  function takeHeldInput() {
    const had = [...heldButtons.values()].some((set) => set.size > 0);
    heldButtons.clear();
    return had;
  }

  return { accept, releaseViewer, waitHumanIdle, setHumanTakeover, takeoverWaitMs, takeAcceptedCount, takeHeldInput, lastHumanInputAt: () => lastHumanAt };
}
