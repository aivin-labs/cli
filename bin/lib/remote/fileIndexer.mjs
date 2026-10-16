import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { IGNORED_DIRS, REMOTE_CONFIG_DIR } from './constants.mjs';
import { createTextIndex } from './textIndex.mjs';

/**
 * Chỉ mục tệp trong RAM cho các thư mục được phép: tên/đường dẫn + định danh đầu tệp (hàm, lớp, khoá…) → tìm tức thì theo tên lẫn nội
 * dung chính mà không quét đĩa mỗi lần. Khởi động: nạp bản chụp gzip, quét lại TĂNG DẦN (chỉ đọc tệp có mtime/size đổi). Chạy: theo
 * dõi thư mục (`fs.watch` đệ quy), cập nhật đúng tệp đổi.
 */

const SNAPSHOT_FILE = path.join(REMOTE_CONFIG_DIR, 'file-index.json.gz');
const SNAPSHOT_VERSION = 1;
const MAX_FILES = 200_000;
const HEAD_BYTES = 16 * 1024;
const MAX_HEAD_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IDENTIFIERS = 200;
const STAT_CONCURRENCY = 64;
const WATCH_DEBOUNCE_MS = 800;
const SNAPSHOT_DEBOUNCE_MS = 10_000;
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.ini', '.env', '.py', '.go', '.rs',
  '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.rb', '.swift', '.scala', '.sql', '.sh', '.ps1', '.bat', '.cmd',
  '.html', '.css', '.scss', '.vue', '.svelte', '.xml', '.gradle', '.proto', '.graphql', '.dart', '.lua', '.r', '.csv',
]);

function identifiersOf(text) {
  const seen = new Set();
  for (const m of text.matchAll(/[\p{L}_][\p{L}\p{N}_]{2,}/gu)) {
    seen.add(m[0]);
    if (seen.size >= MAX_IDENTIFIERS) break;
  }
  return [...seen].join(' ');
}

async function headTokens(abs, size) {
  if (!TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase()) || size > MAX_HEAD_FILE_BYTES) return '';
  let handle;
  try {
    handle = await fs.promises.open(abs, 'r');
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return identifiersOf(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Duyệt cây (bỏ thư mục rác, không theo symlink ra ngoài) → danh sách đường tuyệt đối của tệp. */
async function walk(root, limit) {
  const files = [];
  const queue = [root];
  while (queue.length && files.length < limit) {
    const batch = queue.splice(0, STAT_CONCURRENCY);
    await mapLimit(batch, STAT_CONCURRENCY, async (dir) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) queue.push(full); } else if (entry.isFile()) files.push(full);
      }
    });
  }
  return files.slice(0, limit);
}

export function createFileIndex(roots) {
  const resolvedRoots = roots.map((r) => path.resolve(r));
  const entries = new Map(); // abs → { mtime, size, tokens }
  const index = createTextIndex();
  const watchers = [];
  let snapshotTimer;
  let lastBuild = null;

  const docText = (abs, tokens) => `${abs.split(path.sep).slice(-6).join(' ')} ${tokens || ''}`;

  function setEntry(abs, entry) {
    entries.set(abs, entry);
    index.add(abs, docText(abs, entry.tokens));
  }

  function dropEntry(abs) {
    entries.delete(abs);
    index.remove(abs);
  }

  function loadSnapshot() {
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT_FILE)).toString('utf8'));
      if (data?.version !== SNAPSHOT_VERSION || JSON.stringify(data.roots) !== JSON.stringify(resolvedRoots)) return 0;
      for (const [abs, mtime, size, tokens] of data.entries || []) setEntry(abs, { mtime, size, tokens });
      return entries.size;
    } catch {
      return 0;
    }
  }

  function saveSnapshot() {
    try {
      const payload = { version: SNAPSHOT_VERSION, roots: resolvedRoots, entries: [...entries.entries()].map(([abs, e]) => [abs, e.mtime, e.size, e.tokens]) };
      fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
      const tmp = `${SNAPSHOT_FILE}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(payload)));
      fs.renameSync(tmp, SNAPSHOT_FILE);
    } catch { /* bản chụp chỉ để khởi động nhanh — hỏng thì lần sau quét lại */ }
  }

  function scheduleSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(saveSnapshot, SNAPSHOT_DEBOUNCE_MS);
    snapshotTimer.unref?.();
  }

  async function refreshFile(abs) {
    let stat;
    try { stat = await fs.promises.stat(abs); } catch { if (entries.has(abs)) dropEntry(abs); return 'removed'; }
    if (!stat.isFile()) return 'skipped';
    const mtime = Math.floor(stat.mtimeMs);
    const prev = entries.get(abs);
    if (prev && prev.mtime === mtime && prev.size === stat.size) return 'same';
    setEntry(abs, { mtime, size: stat.size, tokens: await headTokens(abs, stat.size) });
    return 'updated';
  }

  /** Quét tăng dần mọi gốc: tệp mới / đổi được đọc lại, tệp mất bị bỏ. */
  async function build() {
    const startedAt = Date.now();
    const fromSnapshot = entries.size ? 0 : loadSnapshot();
    const found = new Set();
    let updated = 0;
    for (const root of resolvedRoots) {
      const files = await walk(root, MAX_FILES - found.size);
      files.forEach((f) => found.add(f));
      await mapLimit(files, STAT_CONCURRENCY, async (abs) => { if ((await refreshFile(abs)) === 'updated') updated++; });
    }
    let removed = 0;
    for (const abs of [...entries.keys()]) if (!found.has(abs)) { dropEntry(abs); removed++; }
    saveSnapshot();
    lastBuild = { files: entries.size, updated, removed, from_snapshot: fromSnapshot, ms: Date.now() - startedAt, at: new Date().toISOString() };
    return lastBuild;
  }

  function watch() {
    const pending = new Set();
    let timer;
    const flush = async () => {
      const batch = [...pending];
      pending.clear();
      await mapLimit(batch, STAT_CONCURRENCY, refreshFile);
      scheduleSnapshot();
    };
    for (const root of resolvedRoots) {
      try {
        const w = fs.watch(root, { recursive: true }, (_event, name) => {
          if (!name) return;
          const rel = String(name);
          if (rel.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg))) return;
          pending.add(path.join(root, rel));
          clearTimeout(timer);
          timer = setTimeout(() => void flush(), WATCH_DEBOUNCE_MS);
        });
        w.unref?.();
        watchers.push(w);
      } catch { /* không theo dõi được (hệ thống tệp mạng…) — chỉ mục cập nhật ở lần quét sau */ }
    }
  }

  function close() {
    watchers.splice(0).forEach((w) => w.close());
    clearTimeout(snapshotTimer);
    saveSnapshot();
  }

  /** Tìm theo tên / đường dẫn / định danh trong đầu tệp. Trả đường hiển thị tương đối với gốc. */
  function search(query, limit = 10) {
    return index.search(query, { limit }).map(({ id, score }) => {
      const root = resolvedRoots.find((r) => id.startsWith(r)) || resolvedRoots[0];
      return { path: path.relative(root, id) || id, size: entries.get(id)?.size, score: Number(score.toFixed(3)) };
    });
  }

  return { build, watch, close, search, refreshFile, stats: () => ({ files: entries.size, last_build: lastBuild }) };
}
