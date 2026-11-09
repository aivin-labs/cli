import fs from 'fs';
import path from 'path';
import { DeviceErrorCode } from './constants.mjs';

/**
 * Chống làm trùng (28/10/2026): BE gắn `idem_key` cho mỗi bước có tác dụng (theo nhiệm vụ + lượt + bước + tham số). BE khởi động lại giữa
 * chừng → agentic chạy tiếp → lô bước dở được gửi lại: bước đã làm (hoặc đang làm) trả lại đúng kết quả cũ thay vì ghi / gửi / chạy lần hai.
 * Bước hỏng thì quên khoá — lần sau được chạy lại; trừ khi bị dừng GIỮA CHỪNG (hết giờ / huỷ sau khi đã bắt đầu, `ran` của scheduler) → lần
 * gửi lại nhận `INTERRUPTED` thay vì làm lần hai.
 *
 * Sổ trên đĩa (29/10/2026, `file`): daemon khởi động lại (sập, máy khởi động lại, tự cập nhật) vẫn nhớ. Bước xong → trả kết quả cũ; bước
 * ĐANG chạy lúc daemon chết → `INTERRUPTED` (không biết đã làm tới đâu — không tự làm lần hai, Planner kiểm lại rồi mới làm).
 */

const IDEM_TTL_MS = 24 * 3600_000;
const IDEM_MAX = 3000;
/** Số khoá giữ trên đĩa (mới nhất) và trần kết quả lưu kèm — kết quả lớn hơn chỉ lưu "đã làm", không lưu nội dung. */
const PERSIST_MAX = 500;
const KEEP_RESULT_BYTES = 16 * 1024;
/** Tệp sổ dài quá bấy nhiêu dòng thì viết gọn lại (mỗi bước ghi 2 dòng). */
const COMPACT_LINES = 2000;

const IdemState = Object.freeze({ START: 'start', DONE: 'done', FAIL: 'fail', INTERRUPTED: 'interrupted' });

function keptOutcome(outcome) {
  let size = Infinity;
  try { size = Buffer.byteLength(JSON.stringify(outcome)); } catch { /* không tuần tự hoá được */ }
  if (size <= KEEP_RESULT_BYTES) return outcome;
  return { ok: true, result: { note: 'Done before the Aivin agent on this device restarted — the full result was not kept' }, duration_ms: outcome.duration_ms };
}

const interruptedOutcome = () => ({
  ok: false,
  error: 'This step had already started on this device when the Aivin agent restarted — it may have partly run. Check its effect before doing it again.',
  error_code: DeviceErrorCode.INTERRUPTED,
  duration_ms: 0,
});

/** Bước bị dừng giữa chừng (hết giờ / huỷ / tạm dừng) SAU khi đã bắt đầu: có thể đã làm một phần — lần gửi lại không chạy mù lần hai. */
const STOPPED_MIDWAY = new Set([DeviceErrorCode.CALL_TIMEOUT, DeviceErrorCode.CANCELLED]);
export const stoppedMidway = (outcome) => !outcome?.ok && outcome?.ran === true && STOPPED_MIDWAY.has(outcome.error_code);

const stoppedOutcome = (outcome) => ({
  ok: false,
  error: `This step was stopped after it had started on this device (${outcome.error_code === DeviceErrorCode.CALL_TIMEOUT ? 'timed out' : 'cancelled'}) — it may have partly run. Check its effect before doing it again.`,
  error_code: DeviceErrorCode.INTERRUPTED,
  duration_ms: 0,
});

/** Sổ khoá trên đĩa, mỗi dòng một sự kiện `{ k, s, at, o? }`. Đọc: dòng sau đè dòng trước; `start` không có `done` / `fail` → bị ngắt. */
export function createIdemLog(file, { now = () => Date.now() } = {}) {
  const entries = new Map();
  let lines = 0;
  const pendingLines = [];
  let writeChain = Promise.resolve();
  let dirEnsured = false;

  function compactSync() {
    const keep = [...entries.entries()].slice(-PERSIST_MAX);
    entries.clear();
    keep.forEach(([k, v]) => entries.set(k, v));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, keep.map(([k, v]) => JSON.stringify({ k, s: v.state, at: v.at, ...(v.outcome ? { o: v.outcome } : {}) }) + '\n').join(''));
    fs.renameSync(tmp, file);
    lines = keep.length;
  }

  async function compactAsync() {
    const keep = [...entries.entries()].slice(-PERSIST_MAX);
    entries.clear();
    keep.forEach(([k, v]) => entries.set(k, v));
    const tmp = `${file}.tmp`;
    const body = keep.map(([k, v]) => JSON.stringify({ k, s: v.state, at: v.at, ...(v.outcome ? { o: v.outcome } : {}) }) + '\n').join('');
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, file);
    lines = keep.length;
  }

  const write = (record) => {
    pendingLines.push(JSON.stringify(record) + '\n');
    writeChain = writeChain.then(async () => {
      if (!pendingLines.length) return;
      const batch = pendingLines.splice(0, pendingLines.length);
      try {
        if (!dirEnsured) {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          dirEnsured = true;
        }
        await fs.promises.appendFile(file, batch.join(''));
        lines += batch.length;
        if (lines > COMPACT_LINES) await compactAsync();
      } catch { /* ổ đầy / không ghi được: chống trùng vẫn chạy trong bộ nhớ */ }
    });
    return writeChain;
  };

  /** Đọc sổ cũ: trả các khoá còn hạn (đã xong / bị ngắt), viết gọn tệp. */
  function load() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return entries; }
    const t = now();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (typeof r?.k !== 'string' || t - Number(r.at) > IDEM_TTL_MS) continue;
      entries.delete(r.k);
      if (r.s === IdemState.FAIL) continue;
      entries.set(r.k, { state: r.s === IdemState.START ? IdemState.INTERRUPTED : r.s, at: Number(r.at), ...(r.o ? { outcome: r.o } : {}) });
    }
    try { compactSync(); dirEnsured = true; } catch { /* giữ tệp cũ */ }
    return entries;
  }

  return {
    load,
    flush: () => writeChain,
    started: (k) => { entries.set(k, { state: IdemState.START, at: now() }); return write({ k, s: IdemState.START, at: now() }); },
    done: (k, outcome) => {
      const o = keptOutcome(outcome);
      entries.set(k, { state: IdemState.DONE, at: now(), outcome: o });
      return write({ k, s: IdemState.DONE, at: now(), o });
    },
    failed: (k) => { entries.delete(k); return write({ k, s: IdemState.FAIL, at: now() }); },
  };
}

const markDeduplicated = (r) => ({
  ...r,
  outcome: r.outcome.ok && r.outcome.result && typeof r.outcome.result === 'object' ? { ...r.outcome, result: { ...r.outcome.result, deduplicated: true } } : r.outcome,
});

/**
 * `run(call)` → Promise<{ tool, outcome }>; `isReadOnly(toolName)`. Trả hàm chạy có chống lặp + cờ báo lần trùng (`onDuplicate`). `file`: sổ
 * trên đĩa (bỏ trống = chỉ trong bộ nhớ).
 *
 * `deferStart`: chỉ ghi "đã bắt đầu" ra đĩa khi `run` gọi `hooks.started()` (tham số cuối) — lời gọi còn chờ người bấm xác nhận trên máy
 * thì chưa chạy gì; daemon khởi động lại lúc đó không được báo `INTERRUPTED` ("có thể đã chạy một phần") cho bước chưa hề chạy.
 */
export function createIdempotentRunner(run, isReadOnly, { onDuplicate, now = () => Date.now(), file, deferStart = false } = {}) {
  const seen = new Map();
  const log = file ? createIdemLog(file, { now }) : null;
  for (const [k, v] of log?.load() || []) {
    const outcome = v.state === IdemState.DONE && v.outcome ? v.outcome : interruptedOutcome();
    seen.set(k, { promise: Promise.resolve({ tool: undefined, outcome }), at: v.at });
  }
  return (call, ...rest) => {
    if (!call.idem_key || isReadOnly(call.tool)) return run(call, ...rest);
    const t = now();
    for (const [k, v] of seen) {
      if (t - v.at > IDEM_TTL_MS || seen.size > IDEM_MAX) seen.delete(k);
      else break;
    }
    const key = call.idem_key;
    const hit = seen.get(key);
    if (hit) {
      onDuplicate?.(call);
      return hit.promise.then(markDeduplicated);
    }
    let marked = false;
    const started = () => { if (!marked) { marked = true; void log?.started(key); } };
    if (!deferStart) started();
    const rawPromise = run(call, ...rest, ...(deferStart ? [{ started }] : []));
    const promise = rawPromise.then(async (r) => {
      if (r.outcome.ok) await log?.done(key, r.outcome);
      else if (stoppedMidway(r.outcome)) {
        // Lần này trả đúng lỗi gốc; lần gửi lại cùng khoá nhận INTERRUPTED (như bước đang chạy lúc daemon chết).
        const kept = stoppedOutcome(r.outcome);
        seen.set(key, { promise: Promise.resolve({ tool: r.tool, outcome: kept }), at: t });
        await log?.done(key, kept);
      } else { seen.delete(key); await log?.failed(key); }
      return r;
    }, async (err) => {
      seen.delete(key);
      await log?.failed(key);
      throw err;
    });
    seen.set(key, { promise, at: t });
    return promise;
  };
}
