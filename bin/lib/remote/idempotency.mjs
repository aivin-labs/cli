import fs from 'fs';
import path from 'path';
import { DeviceErrorCode } from './constants.mjs';

/**
 * Chống làm trùng (28/10/2026): BE gắn `idem_key` cho mỗi bước có tác dụng (theo nhiệm vụ + lượt + bước + tham số). BE khởi động lại giữa
 * chừng → agentic chạy tiếp → lô bước dở được gửi lại: bước đã làm (hoặc đang làm) trả lại đúng kết quả cũ thay vì ghi / gửi / chạy lần hai.
 * Bước hỏng thì quên khoá — lần sau được chạy lại.
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

/** Sổ khoá trên đĩa, mỗi dòng một sự kiện `{ k, s, at, o? }`. Đọc: dòng sau đè dòng trước; `start` không có `done` / `fail` → bị ngắt. */
export function createIdemLog(file, { now = () => Date.now() } = {}) {
  const entries = new Map();
  let lines = 0;

  const write = (record) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
      lines++;
      if (lines > COMPACT_LINES) compact();
    } catch { /* ổ đầy / không ghi được: chống trùng vẫn chạy trong bộ nhớ */ }
  };

  function compact() {
    const keep = [...entries.entries()].slice(-PERSIST_MAX);
    entries.clear();
    keep.forEach(([k, v]) => entries.set(k, v));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, keep.map(([k, v]) => JSON.stringify({ k, s: v.state, at: v.at, ...(v.outcome ? { o: v.outcome } : {}) }) + '\n').join(''));
    fs.renameSync(tmp, file);
    lines = keep.length;
  }

  /** Đọc sổ cũ: trả các khoá còn hạn (đã xong / bị ngắt), viết gọn tệp. */
  function load() {
    let raw = '';
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
    try { compact(); } catch { /* giữ tệp cũ */ }
    return entries;
  }

  return {
    load,
    started: (k) => { entries.set(k, { state: IdemState.START, at: now() }); write({ k, s: IdemState.START, at: now() }); },
    done: (k, outcome) => {
      const o = keptOutcome(outcome);
      entries.set(k, { state: IdemState.DONE, at: now(), outcome: o });
      write({ k, s: IdemState.DONE, at: now(), o });
    },
    failed: (k) => { entries.delete(k); write({ k, s: IdemState.FAIL, at: now() }); },
  };
}

const markDeduplicated = (r) => ({
  ...r,
  outcome: r.outcome.ok && r.outcome.result && typeof r.outcome.result === 'object' ? { ...r.outcome, result: { ...r.outcome.result, deduplicated: true } } : r.outcome,
});

/**
 * `run(call)` → Promise<{ tool, outcome }>; `isReadOnly(toolName)`. Trả hàm chạy có chống lặp + cờ báo lần trùng (`onDuplicate`). `file`: sổ
 * trên đĩa (bỏ trống = chỉ trong bộ nhớ).
 */
export function createIdempotentRunner(run, isReadOnly, { onDuplicate, now = () => Date.now(), file } = {}) {
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
    log?.started(key);
    const promise = run(call, ...rest);
    seen.set(key, { promise, at: t });
    promise.then((r) => {
      if (r.outcome.ok) log?.done(key, r.outcome);
      else { seen.delete(key); log?.failed(key); }
    }, () => { seen.delete(key); log?.failed(key); });
    return promise;
  };
}
