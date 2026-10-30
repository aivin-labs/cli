import fs from 'fs';
import path from 'path';
import { REMOTE_OUTBOX_FILE } from './constants.mjs';

/** Giữ kết quả chưa gửi bấy nhiêu lâu — BE chờ một lời gọi tối đa 10 phút (+ thời gian ân hạn nối lại). */
const UNSENT_KEEP_MS = 15 * 60_000;
/** Kết quả đã gửi vẫn nhớ thêm chừng này (BE gửi lại đúng `call_id` vì ACK / kết quả lỡ mất → trả lại kết quả cũ, không chạy lần hai). */
const SENT_KEEP_MS = 3 * 60_000;
const MAX_UNSENT = 200;
/** Kết quả lớn hơn không ghi xuống đĩa (chỉ giữ trong bộ nhớ) — daemon chết thì BE nhận lỗi thay vì nội dung. */
const PERSIST_RESULT_BYTES = 4 * 1024 * 1024;

export const CallState = Object.freeze({ RUNNING: 'running', DONE: 'done' });

function payloadBytes(payload) {
  try { return Buffer.byteLength(JSON.stringify(payload)); } catch { return Infinity; }
}

/**
 * Sổ lời gọi của daemon (29/10/2026). Theo dõi từng `call_id` BE gửi xuống: đang chạy → xong (kết quả chờ gửi) → đã gửi.
 * - Lời gọi trùng `call_id` (BE gửi lại sau khi máy rớt mạng) không chạy lần hai: đang chạy thì bỏ qua, đã xong thì gửi lại kết quả cũ.
 * - Kết quả chưa gửi được (mất mạng, chưa có ack) ghi xuống `REMOTE_OUTBOX_FILE` — daemon khởi động lại vẫn gửi.
 * - `heldIds()`: lời gọi máy đang giữ, gửi lên khi chào để BE đối chiếu (huỷ việc không còn ai chờ, khỏi gửi lại việc máy đang làm).
 */
export function createCallLedger({ file = REMOTE_OUTBOX_FILE, now = () => Date.now() } = {}) {
  const calls = new Map();

  function persist() {
    const unsent = [...calls.entries()].filter(([, e]) => e.state === CallState.DONE && !e.sent);
    try {
      if (!unsent.length) {
        fs.rmSync(file, { force: true });
        return;
      }
      const rows = unsent.map(([id, e]) => {
        const payload = payloadBytes(e.payload) <= PERSIST_RESULT_BYTES ? e.payload
          : { call_id: id, ok: false, error: 'Result was too large to keep while offline — run the step again', error_code: 'OUTPUT_TOO_LARGE', duration_ms: e.payload.duration_ms };
        return { id, at: e.at, payload };
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* không ghi được: vẫn giữ trong bộ nhớ */ }
  }

  function load() {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    const t = now();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (typeof r?.id !== 'string' || !r.payload || t - Number(r.at) > UNSENT_KEEP_MS) continue;
      calls.set(r.id, { state: CallState.DONE, at: Number(r.at), payload: r.payload, sent: false, onDisk: true });
    }
  }

  function prune() {
    const t = now();
    let changed = false;
    for (const [id, e] of calls) {
      if (e.state !== CallState.DONE) continue;
      const age = t - e.at;
      if ((e.sent && age > SENT_KEEP_MS) || (!e.sent && age > UNSENT_KEEP_MS)) {
        calls.delete(id);
        changed ||= !e.sent;
      }
    }
    const unsent = [...calls.entries()].filter(([, e]) => e.state === CallState.DONE && !e.sent);
    for (const [id] of unsent.slice(0, Math.max(0, unsent.length - MAX_UNSENT))) {
      calls.delete(id);
      changed = true;
    }
    if (changed) persist();
  }

  load();

  return {
    /** Nhận một lời gọi: mới → ghi "đang chạy", trả `null`; trùng → trả mục đã có (`state`, `payload`). */
    admit(call) {
      const existing = calls.get(call.call_id);
      if (existing) return existing;
      calls.set(call.call_id, { state: CallState.RUNNING, at: now() });
      return null;
    },
    /** Lời gọi xong — kết quả chờ gửi. `persistNow`: ghi xuống đĩa ngay (đang mất kết nối). */
    finish(callId, payload, { persistNow = false } = {}) {
      calls.set(callId, { state: CallState.DONE, at: now(), payload, sent: false });
      if (persistNow) persist();
    },
    markSent(callId) {
      const e = calls.get(callId);
      if (!e || e.state !== CallState.DONE || e.sent) return;
      const wasOnDisk = e.onDisk;
      e.sent = true;
      e.payload = { call_id: callId, ...pick(e.payload) };
      if (wasOnDisk) persist();
    },
    /** Lời gọi đã xong bị BE gửi lại: đánh dấu chưa gửi, trả kết quả để gửi lần nữa. */
    reopen(callId) {
      const e = calls.get(callId);
      if (e?.state !== CallState.DONE) return null;
      e.sent = false;
      return e.payload;
    },
    /** Ghi các kết quả chưa gửi xuống đĩa (gửi chưa được xác nhận / daemon sắp dừng). */
    persist() {
      for (const e of calls.values()) if (e.state === CallState.DONE && !e.sent) e.onDisk = true;
      persist();
    },
    /** BE báo không còn ai chờ → bỏ kết quả chưa gửi của các lời gọi này. */
    drop(callIds) {
      let changed = false;
      for (const id of callIds || []) {
        const e = calls.get(id);
        if (e?.state === CallState.DONE && !e.sent) {
          calls.delete(id);
          changed = true;
        }
      }
      if (changed) persist();
    },
    unsent: () => [...calls.values()].filter((e) => e.state === CallState.DONE && !e.sent).map((e) => e.payload),
    heldIds: () => [...calls.entries()].filter(([, e]) => e.state === CallState.RUNNING || (e.state === CallState.DONE && !e.sent)).map(([id]) => id),
    runningIds: () => [...calls.entries()].filter(([, e]) => e.state === CallState.RUNNING).map(([id]) => id),
    prune,
  };
}

/** Kết quả đã gửi: chỉ giữ phần đủ để gửi lại cho lời gọi trùng (không giữ nội dung lớn quá lâu). */
function pick(payload) {
  if (payloadBytes(payload) <= 256 * 1024) return payload;
  return { ok: payload.ok, error: payload.error, error_code: payload.error_code, duration_ms: payload.duration_ms, result: payload.ok ? { note: 'Result already delivered' } : undefined };
}
