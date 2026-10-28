import fs from 'fs';
import path from 'path';
import { DeviceErrorCode, ToolGroup } from './constants.mjs';
import { DeviceToolError, displayPath, isProtectedPath, resolveInRoots } from './sandbox.mjs';

/**
 * Theo dõi trên máy kích hoạt việc của Aivin (28/10/2026): "có tệp mới trong thư mục X thì…", "log Y có dòng ERROR thì…". BE giữ danh sách
 * theo dõi (mỗi cái gắn một Automation Job kiểu `device`) và đẩy xuống bằng công cụ nội bộ `watch.set`; máy vừa nối thì tự xin lại. Có sự
 * kiện → gom trong `COALESCE_MS` rồi báo BE một lần (`device:event`), giới hạn `MAX_EVENTS_PER_HOUR` mỗi theo dõi — một thư mục chép vào
 * 500 tệp là một sự kiện, không phải 500 lượt agentic.
 *
 * Kiểu: `file_created` (tệp MỚI xuất hiện trong thư mục, lọc theo mẫu tên), `log_match` (dòng MỚI ghi thêm vào tệp khớp regex).
 */

export const WatchKind = Object.freeze({ FILE_CREATED: 'file_created', LOG_MATCH: 'log_match' });

const COALESCE_MS = 5000;
const MAX_EVENTS_PER_HOUR = 30;
const MAX_ITEMS_PER_EVENT = 50;
const MAX_WATCHES = 50;
const LOG_READ_MAX = 256 * 1024;

const globRe = (pattern) => (pattern ? new RegExp(`^${String(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i') : null);

export function createWatchManager({ roots, emit, say = () => {}, coalesceMs = COALESCE_MS, settleMs = 1500 }) {
  const active = new Map();

  function stopOne(id) {
    const w = active.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    try { w.watcher?.close(); } catch { /* đã đóng */ }
    active.delete(id);
  }

  function flush(w) {
    w.timer = null;
    if (!w.pending.length) return;
    const now = Date.now();
    w.sent = w.sent.filter((t) => now - t < 3600_000);
    if (w.sent.length >= MAX_EVENTS_PER_HOUR) { w.dropped += w.pending.length; w.pending = []; return; }
    w.sent.push(now);
    const items = w.pending.splice(0, MAX_ITEMS_PER_EVENT);
    const more = w.pending.length;
    w.pending = [];
    emit({ watch_id: w.spec.id, kind: w.spec.kind, items, more: more || undefined, dropped_before: w.dropped || undefined, at: new Date().toISOString() });
    w.dropped = 0;
  }

  function queue(w, item) {
    w.pending.push(item);
    if (!w.timer) w.timer = setTimeout(() => flush(w), coalesceMs);
  }

  function startFileCreated(spec, abs) {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Not a folder: ${spec.path}`);
    const match = globRe(spec.pattern);
    const known = new Set();
    const w = { spec, pending: [], sent: [], dropped: 0, timer: null };
    const watcher = fs.watch(abs, { recursive: !!spec.recursive }, (_e, name) => {
      if (!name) return;
      const full = path.join(abs, String(name));
      if (known.has(full) || isProtectedPath(full)) return;
      if (match && !match.test(path.basename(full))) return;
      // Đợi tệp ghi xong một chút rồi mới xét (trình duyệt tải xuống / chép tệp lớn bắn nhiều sự kiện).
      setTimeout(() => {
        const s = fs.statSync(full, { throwIfNoEntry: false });
        if (!s?.isFile() || known.has(full)) return;
        if (Date.now() - s.birthtimeMs > 10 * 60_000 && Date.now() - s.mtimeMs > 10 * 60_000) return;
        known.add(full);
        if (known.size > 5000) known.clear();
        queue(w, { path: displayPath(roots, full), size: s.size });
      }, settleMs);
    });
    watcher.on('error', () => { try { watcher.close(); } catch { /* đã đóng */ } say(`⚠️  Theo dõi "${spec.name || spec.id}" ngừng (thư mục không còn?)`); });
    w.watcher = watcher;
    return w;
  }

  function startLogMatch(spec, abs) {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Not a file: ${spec.path}`);
    let re;
    try { re = new RegExp(String(spec.pattern || ''), 'i'); } catch { throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'pattern is not a valid regex'); }
    const w = { spec, pending: [], sent: [], dropped: 0, timer: null, offset: st.size, partial: '' };
    const readNew = () => {
      const s = fs.statSync(abs, { throwIfNoEntry: false });
      if (!s) return;
      if (s.size < w.offset) w.offset = 0;
      if (s.size === w.offset) return;
      const len = Math.min(s.size - w.offset, LOG_READ_MAX);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(abs, 'r');
      try { fs.readSync(fd, buf, 0, len, s.size - len); } finally { fs.closeSync(fd); }
      w.offset = s.size;
      const lines = (w.partial + buf.toString('utf8')).split(/\r?\n/);
      w.partial = lines.pop() || '';
      for (const line of lines) if (re.test(line)) queue(w, { line: line.slice(0, 500) });
    };
    const watcher = fs.watch(abs, () => { try { readNew(); } catch { /* tệp đang xoay vòng */ } });
    watcher.on('error', () => { try { watcher.close(); } catch { /* đã đóng */ } });
    w.watcher = watcher;
    return w;
  }

  /** Đặt TOÀN BỘ danh sách theo dõi (BE là nguồn chân lý): bỏ cái không còn, mở cái mới, giữ cái không đổi. */
  function set(list) {
    const specs = (Array.isArray(list) ? list : []).slice(0, MAX_WATCHES).filter((s) => s && typeof s.id === 'string');
    const want = new Map(specs.map((s) => [s.id, s]));
    for (const id of [...active.keys()]) {
      if (!want.has(id) || JSON.stringify(active.get(id).spec) !== JSON.stringify(want.get(id))) stopOne(id);
    }
    const errors = [];
    for (const spec of specs) {
      if (active.has(spec.id)) continue;
      try {
        const abs = resolveInRoots(roots, String(spec.path || ''));
        const w = spec.kind === WatchKind.LOG_MATCH ? startLogMatch(spec, abs) : startFileCreated(spec, abs);
        active.set(spec.id, w);
      } catch (e) {
        errors.push({ id: spec.id, error: e.message, code: e.code });
      }
    }
    if (specs.length) say(`👁  Đang theo dõi ${active.size} mục trên máy cho Aivin`);
    return { active: [...active.keys()], errors };
  }

  return { set, closeAll: () => [...active.keys()].forEach(stopOne), size: () => active.size };
}

/** Công cụ nội bộ (chỉ BE gọi) — đặt danh sách theo dõi. */
export function buildWatchTools(manager) {
  return [
    { name: 'watch.set', group: ToolGroup.SYSTEM, internal: true, handler: (a) => manager.set(a.watches),
      description: 'BE-only: replace the list of folder / log watches that trigger Aivin jobs.', input_schema: { type: 'object', properties: {} } },
  ];
}
