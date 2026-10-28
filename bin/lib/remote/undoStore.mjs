import fs from 'fs';
import path from 'path';
import { DeviceErrorCode, REMOTE_CONFIG_DIR } from './constants.mjs';
import { DeviceToolError, resolveEntryInRoots } from './sandbox.mjs';

/**
 * Kho hoàn tác trên máy (28/10/2026): mọi thao tác làm mất dữ liệu của AI đều lấy lại được. Xoá → chuyển vào thùng rác của kho (không xoá
 * thật); ghi đè / sửa → lưu bản cũ; chuyển / tạo → ghi lại để trả về. Nhật ký theo NHÓM (BE gắn `undo_group` = một nhiệm vụ) → "hoàn tác"
 * trả cả nhóm về như trước, theo thứ tự ngược.
 *
 * Kho nằm trong thư mục cấu hình Aivin (`~/.aivin/undo`) — vùng bảo vệ, AI không đọc / sửa / xoá được qua công cụ nào. Tự dọn: nhóm cũ
 * hơn `retentionDays`, tổng dung lượng quá `maxBytes` thì bỏ nhóm cũ nhất. Không người dùng nào phải cấu hình gì.
 */

const DAY_MS = 86_400_000;
const GROUP_RE = /[^A-Za-z0-9_-]/g;
const CLEANUP_EVERY_MS = 6 * 3600_000;

export const UndoItem = Object.freeze({
  /** Ghi đè / sửa tệp: bản cũ ở `backup`. */
  RESTORE: 'restore',
  /** Chuyển / đổi tên `from` → `to`. */
  UNMOVE: 'unmove',
  /** Xoá: nằm ở `trashed`. */
  UNTRASH: 'untrash',
  /** Tạo mới `path`. */
  UNCREATE: 'uncreate',
  /** Thư mục AI tạo ra (khi chuyển / ghi vào chỗ chưa có) — hoàn tác thì bỏ nếu còn rỗng. */
  UNCREATE_DIR: 'uncreate_dir',
});

const safeGroup = (g) => String(g || '').replace(GROUP_RE, '').slice(0, 48) || `manual-${new Date().toISOString().slice(0, 10)}`;

async function exists(p) {
  return !!(await fs.promises.lstat(p).catch(() => null));
}

/** Dung lượng + số tệp của một đường (đệ quy, dừng ở `limit` mục). */
export async function measurePath(abs, limit = 100_000) {
  const out = { files: 0, dirs: 0, bytes: 0, truncated: false };
  const stack = [abs];
  while (stack.length) {
    if (out.files + out.dirs >= limit) { out.truncated = true; break; }
    const p = stack.pop();
    const st = await fs.promises.lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      out.dirs++;
      const names = await fs.promises.readdir(p).catch(() => []);
      for (const n of names) stack.push(path.join(p, n));
    } else {
      out.files++;
      out.bytes += st.size;
    }
  }
  return out;
}

/** Chuyển `src` → `dst`: đổi tên (cùng ổ, tức thì); khác ổ thì chép rồi xoá bản gốc. */
async function relocate(src, dst) {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.promises.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.promises.cp(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

export function createUndoStore({
  dir = path.join(REMOTE_CONFIG_DIR, 'undo'), retentionDays = 14, maxBytes = 10 * 1024 ** 3, maxBackupBytes = 512 * 1024 ** 2,
} = {}) {
  const journal = path.join(dir, 'journal.jsonl');
  /** Kiểu hoàn tác tuỳ chỉnh (lịch chạy…) — module sở hữu đăng ký cách trả về như trước. */
  const handlers = new Map();
  let seq = 0;
  let cleanupTimer = null;

  const groupDir = (group) => path.join(dir, 'store', safeGroup(group));
  const slot = (group, abs) => path.join(groupDir(group), `${Date.now().toString(36)}-${(seq++).toString(36)}-${path.basename(abs)}`);

  function append(record) {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(journal, `${JSON.stringify(record)}\n`);
  }

  function readJournal() {
    try {
      return fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Ghi lại một thao tác của nhóm. Gọi các hàm lưu TRƯỚC khi đổi tệp; `commit` sau khi đổi xong (lỗi giữa chừng thì phần đã lưu vẫn ghi). */
  function begin(group, op) {
    const items = [];
    const g = safeGroup(group);
    return {
      group: g,
      /** Lưu bản cũ trước khi ghi đè / sửa. Tệp quá lớn → không lưu, trả false (kết quả báo `backup: false`). */
      async backupFile(abs) {
        const st = await fs.promises.stat(abs).catch(() => null);
        if (!st?.isFile()) return false;
        if (st.size > maxBackupBytes) return false;
        const backup = slot(g, abs);
        await fs.promises.mkdir(path.dirname(backup), { recursive: true });
        await fs.promises.copyFile(abs, backup);
        items.push({ t: UndoItem.RESTORE, path: abs, backup });
        return true;
      },
      /** Xoá = chuyển vào thùng rác của kho. */
      async trash(abs) {
        const trashed = slot(g, abs);
        await relocate(abs, trashed);
        items.push({ t: UndoItem.UNTRASH, path: abs, trashed });
        return trashed;
      },
      moved(from, to) { items.push({ t: UndoItem.UNMOVE, from, to }); },
      /** Tạo thư mục `dir` (và các thư mục cha chưa có), ghi lại thư mục nào là do AI tạo — ngoài cùng trước. */
      async ensureDir(dirPath) {
        const missing = [];
        for (let d = dirPath; !(await exists(d)); d = path.dirname(d)) {
          missing.unshift(d);
          if (path.dirname(d) === d) break;
        }
        await fs.promises.mkdir(dirPath, { recursive: true });
        for (const d of missing) items.push({ t: UndoItem.UNCREATE_DIR, path: d });
      },
      created(abs) { items.push({ t: UndoItem.UNCREATE, path: abs }); },
      /** Thay đổi ngoài tệp (lịch chạy…): ghi ngay một mục kiểu `type` — trình xử lý đã đăng ký sẽ hoàn tác. */
      custom(type, payload) { items.push({ t: type, ...payload }); this.commit(); },
      commit() {
        if (items.length) append({ group: g, op, at: Date.now(), items: items.splice(0) });
        scheduleCleanup();
      },
    };
  }

  /** Nhóm gần nhất (mới trước): thao tác, số mục, đã hoàn tác chưa. */
  function history(limit = 10) {
    const groups = new Map();
    for (const r of readJournal()) {
      const g = groups.get(r.group) || { group: r.group, ops: {}, items: 0, first_at: r.at, last_at: r.at, undone: false, samples: [] };
      if (r.undone) { g.undone = true; groups.set(r.group, g); continue; }
      g.ops[r.op] = (g.ops[r.op] || 0) + 1;
      g.items += r.items?.length || 0;
      g.last_at = Math.max(g.last_at, r.at);
      for (const it of r.items || []) if (g.samples.length < 5) g.samples.push(`${it.t} ${path.basename(it.path || it.to || '')}`);
      groups.set(r.group, g);
    }
    return [...groups.values()].sort((a, b) => b.last_at - a.last_at).slice(0, limit)
      .map((g) => ({ ...g, first_at: new Date(g.first_at).toISOString(), last_at: new Date(g.last_at).toISOString() }));
  }

  /**
   * Hoàn tác cả nhóm theo thứ tự ngược. Mỗi mục trả về đúng chỗ cũ — chỉ khi chỗ đó còn trong vùng được phép (`roots` hiện tại) và không
   * bị một tệp khác chiếm (không đè thứ người dùng tạo sau). Tệp bị thay bởi bản cũ / tệp AI tạo ra được chuyển vào thùng rác của kho,
   * không xoá — hoàn tác cũng hoàn tác được.
   */
  async function undo(group, roots) {
    const records = readJournal();
    const target = group ? safeGroup(group) : history(1).find((g) => !g.undone)?.group;
    if (!target) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, 'Nothing to undo');
    if (records.some((r) => r.group === target && r.undone)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Group ${target} was already undone`);
    const items = records.filter((r) => r.group === target && !r.undone).flatMap((r) => r.items || []).reverse();
    if (!items.length) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No changes recorded for group ${target}`);
    const redo = begin(`${target}-undo`, 'undo');
    const done = [];
    const skipped = [];
    const inRoots = (p) => { try { resolveEntryInRoots(roots, p); return true; } catch { return false; } };
    for (const it of items) {
      try {
        if (it.t === UndoItem.RESTORE) {
          if (!inRoots(it.path)) { skipped.push({ path: it.path, reason: 'outside the allowed folders now' }); continue; }
          if (await exists(it.path)) await redo.trash(it.path);
          await relocate(it.backup, it.path);
          done.push({ restored: it.path });
        } else if (it.t === UndoItem.UNTRASH) {
          if (!inRoots(it.path)) { skipped.push({ path: it.path, reason: 'outside the allowed folders now' }); continue; }
          if (await exists(it.path)) { skipped.push({ path: it.path, reason: 'something else is there now' }); continue; }
          await relocate(it.trashed, it.path);
          done.push({ restored: it.path });
        } else if (it.t === UndoItem.UNMOVE) {
          if (!inRoots(it.from) || !inRoots(it.to)) { skipped.push({ path: it.to, reason: 'outside the allowed folders now' }); continue; }
          if (!(await exists(it.to))) { skipped.push({ path: it.to, reason: 'no longer there' }); continue; }
          if (await exists(it.from)) { skipped.push({ path: it.from, reason: 'something else is there now' }); continue; }
          await relocate(it.to, it.from);
          done.push({ moved_back: it.from });
        } else if (it.t === UndoItem.UNCREATE_DIR) {
          // Chỉ bỏ thư mục còn RỖNG — người dùng đã để gì vào thì giữ nguyên.
          if (!inRoots(it.path)) continue;
          const left = await fs.promises.readdir(it.path).catch(() => null);
          if (left && !left.length) { await fs.promises.rmdir(it.path); done.push({ removed_empty_folder: it.path }); }
        } else if (handlers.has(it.t)) {
          done.push(await handlers.get(it.t)(it));
        } else if (it.t === UndoItem.UNCREATE) {
          if (!inRoots(it.path) || !(await exists(it.path))) continue;
          await redo.trash(it.path);
          done.push({ removed: it.path });
        }
      } catch (e) {
        skipped.push({ path: it.path || it.to, reason: e.message });
      }
    }
    redo.commit();
    append({ group: target, undone: true, at: Date.now() });
    return { group: target, undone: done.length, skipped, changes: done.slice(0, 50) };
  }

  /** Dọn: nhóm quá hạn, rồi nhóm cũ nhất tới khi tổng dung lượng dưới trần. Nhật ký giữ dòng của nhóm còn lại. */
  async function cleanup() {
    const store = path.join(dir, 'store');
    const names = await fs.promises.readdir(store).catch(() => []);
    const last = new Map();
    for (const r of readJournal()) last.set(r.group, Math.max(last.get(r.group) || 0, r.at || 0));
    const groups = await Promise.all(names.map(async (name) => ({ name, at: last.get(name) || 0, size: (await measurePath(path.join(store, name))).bytes })));
    groups.sort((a, b) => a.at - b.at);
    let total = groups.reduce((n, g) => n + g.size, 0);
    const removed = new Set();
    for (const g of groups) {
      if (Date.now() - g.at > retentionDays * DAY_MS || total > maxBytes) {
        await fs.promises.rm(path.join(store, g.name), { recursive: true, force: true }).catch(() => undefined);
        total -= g.size;
        removed.add(g.name);
      }
    }
    const keep = readJournal().filter((r) => !removed.has(r.group) && Date.now() - (r.at || 0) <= retentionDays * DAY_MS);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(journal, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    return { removed: removed.size, bytes: total };
  }

  function scheduleCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => { cleanupTimer = null; void cleanup().catch(() => undefined); }, CLEANUP_EVERY_MS);
    cleanupTimer.unref?.();
  }

  return { begin, history, undo, cleanup, dir, registerHandler: (type, fn) => handlers.set(type, fn) };
}
