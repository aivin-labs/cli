/**
 * Cổng thao tác chuột / phím từ xa (Desktop Scenecast) — lớp chặn cuối trên máy, không tin BE / trình duyệt: chỉ nhận action đã biết,
 * chỉ chép trường đã biết (trường lạ như `op` không bao giờ xuống tiến trình điều khiển), bỏ khi chủ máy đã tạm dừng, khi AI đang thao tác
 * giao diện, hoặc gửi quá dồn. Thao tác qua kênh WebRTC cũng đi qua đây.
 */

export const CAST_INPUT_ACTIONS = Object.freeze(['move', 'click', 'dblclick', 'rightclick', 'mousedown', 'mouseup', 'scroll', 'type', 'key', 'hotkey']);

export const CastInputRejection = Object.freeze({
  INVALID: 'invalid',
  PAUSED: 'paused',
  AI_ACTIVE: 'ai_active',
  RATE_LIMITED: 'rate_limited',
});

const ACTIONS = new Set(CAST_INPUT_ACTIONS);
const MAX_COORD = 100_000;
const MAX_SCROLL = 10_000;
const MAX_KEY_CHARS = 24;

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
  const button = Number(raw.button);
  if (button === 0 || button === 1 || button === 2) cmd.button = button;
  const deltaX = finiteIn(raw.deltaX, MAX_SCROLL);
  const deltaY = finiteIn(raw.deltaY, MAX_SCROLL);
  if (deltaX !== undefined) cmd.deltaX = Math.round(deltaX);
  if (deltaY !== undefined) cmd.deltaY = Math.round(deltaY);
  if (typeof raw.text === 'string' && raw.text) cmd.text = raw.text.slice(0, maxTypeChars);
  if (typeof raw.key === 'string' && raw.key && raw.key.length <= MAX_KEY_CHARS) cmd.key = raw.key;
  const keys = shortStrings(raw.keys, 6);
  if (keys) cmd.keys = keys;
  const modifiers = shortStrings(raw.modifiers, 4);
  if (modifiers) cmd.modifiers = modifiers;
  if (action === 'type' && !cmd.text) return null;
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
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function accept(raw) {
    if (isPaused()) return { ok: false, reason: CastInputRejection.PAUSED };
    if (isAiBusy()) return { ok: false, reason: CastInputRejection.AI_ACTIVE };
    const t = now();
    if (t - window.start >= 1000) window = { start: t, count: 0 };
    if (++window.count > maxPerSec) return { ok: false, reason: CastInputRejection.RATE_LIMITED };
    const cmd = sanitizeCastInput(raw);
    if (!cmd) return { ok: false, reason: CastInputRejection.INVALID };
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

  return { accept, waitHumanIdle, takeAcceptedCount, lastHumanInputAt: () => lastHumanAt };
}
