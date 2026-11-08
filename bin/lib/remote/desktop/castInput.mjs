/**
 * Cổng thao tác chuột / phím từ xa (Desktop Scenecast) — lớp chặn cuối trên máy, không tin BE / trình duyệt: chỉ nhận action đã biết,
 * chỉ chép trường đã biết (trường lạ như `op` không bao giờ xuống tiến trình điều khiển), bỏ khi chủ máy đã tạm dừng, khi AI đang thao tác
 * giao diện, hoặc gửi quá dồn. Thao tác qua kênh WebRTC cũng đi qua đây.
 */

export const CAST_INPUT_ACTIONS = Object.freeze([
  'move', 'click', 'dblclick', 'rightclick', 'mousedown', 'mouseup', 'scroll', 'type', 'paste', 'clipboard', 'key', 'hotkey',
  'paste_image', 'paste_file'
]);

export const CastInputRejection = Object.freeze({
  INVALID: 'invalid',
  PAUSED: 'paused',
  AI_ACTIVE: 'ai_active',
  RATE_LIMITED: 'rate_limited',
});

const ACTIONS = new Set(CAST_INPUT_ACTIONS);
const MAX_COORD = 100_000;
const MAX_SCROLL = 10_000;
/** Toạ độ theo tỷ lệ (rx, ry): 0 = mép trái / trên, 65535 = mép phải / dưới. */
const RATIO_SCALE = 65_535;
const MAX_KEY_CHARS = 24;
const MAX_PASTE_CHARS = 65_536;

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
  const charLimit = action === 'paste' || action === 'clipboard' ? MAX_PASTE_CHARS : maxTypeChars;
  if (typeof raw.text === 'string' && raw.text) cmd.text = raw.text.slice(0, charLimit);
  if (typeof raw.key === 'string' && raw.key && raw.key.length <= MAX_KEY_CHARS) cmd.key = raw.key;
  const keys = shortStrings(raw.keys, 6);
  if (keys) cmd.keys = keys;
  const modifiers = shortStrings(raw.modifiers, 4);
  if (modifiers) cmd.modifiers = modifiers;
  if (action === 'paste_image') {
    if (typeof raw.data !== 'string' || !raw.data) return null;
    cmd.data = raw.data.slice(0, 25_000_000); // Tối đa ~18MB ảnh base64
    if (typeof raw.mime === 'string') cmd.mime = raw.mime.slice(0, 64);
    if (raw.click) cmd.click = true;
    return cmd;
  }
  if (action === 'paste_file') {
    if (typeof raw.path !== 'string' || !raw.path) return null;
    cmd.path = raw.path;
    if (raw.click) cmd.click = true;
    return cmd;
  }
  if ((action === 'type' || action === 'paste' || action === 'clipboard') && !cmd.text) return null;
  if (action === 'key' && !cmd.key) return null;
  if (action === 'hotkey' && !cmd.keys) return null;
  return cmd;
}

/**
 * `isPaused()`: công tắc ngắt của chủ máy. `isAiBusy()`: AI đang chạy công cụ GUI ghi. `accept(raw)` → `{ ok, cmd }` hoặc `{ ok: false, reason }`.
 * `waitHumanIdle()`: công cụ GUI của AI chờ người thôi thao tác (tối đa `maxWaitMs`) trước khi bấm — hai bên không giành chuột cùng lúc.
 */
export function createCastInputGate({ isPaused = () => false, isAiBusy = () => false, maxPerSec = 120, now = Date.now, sleep } = {}) {
  let lastHumanAt = null;
  let accepted = 0;
  let window = { start: 0, count: 0 };
  /** Nút chuột người xem đang giữ trên máy: gói nhả của chúng luôn được qua cổng, không thì nút kẹt xuống tới hết phiên. */
  const heldButtons = new Set();
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function accept(raw) {
    const releasing = raw?.action === 'mouseup' && heldButtons.has(Number(raw.button) || 0);
    const blocked = isPaused() ? CastInputRejection.PAUSED : isAiBusy() ? CastInputRejection.AI_ACTIVE : null;
    if (blocked && !releasing) return { ok: false, reason: blocked };
    const t = now();
    if (t - window.start >= 1000) window = { start: t, count: 0 };
    if (++window.count > maxPerSec && !releasing) return { ok: false, reason: CastInputRejection.RATE_LIMITED };
    const cmd = sanitizeCastInput(raw);
    if (!cmd) return { ok: false, reason: CastInputRejection.INVALID };
    if (cmd.action === 'mousedown') heldButtons.add(cmd.button ?? 0);
    if (cmd.action === 'mouseup') heldButtons.delete(cmd.button ?? 0);
    if (blocked) {
      // Chỉ nhả nút, không kéo con trỏ khỏi chỗ AI đang bấm; không tính là người đang thao tác.
      const { x: _x, y: _y, rx: _rx, ry: _ry, ...release } = cmd;
      return { ok: true, cmd: release };
    }
    lastHumanAt = t;
    accepted++;
    return { ok: true, cmd };
  }

  async function waitHumanIdle({ idleMs = 1500, maxWaitMs = 3000 } = {}) {
    const deadline = now() + maxWaitMs;
    while (lastHumanAt !== null && now() - lastHumanAt < idleMs && now() < deadline) {
      await wait(Math.min(250, Math.max(10, idleMs - (now() - lastHumanAt))));
    }
  }

  /** Số thao tác đã nhận từ lần gọi trước (nhật ký phiên trên máy) — đọc xong đặt lại 0. */
  function takeAcceptedCount() { const n = accepted; accepted = 0; return n; }

  /** Máy vừa nhả hết nút (`release_all`): AI sắp bấm hoặc người xem đã rời. Trả có đang giữ nút nào không để nơi gọi biết cần gửi lệnh nhả. */
  function takeHeldInput() { const had = heldButtons.size > 0; heldButtons.clear(); return had; }

  return { accept, waitHumanIdle, takeAcceptedCount, takeHeldInput, lastHumanInputAt: () => lastHumanAt };
}
