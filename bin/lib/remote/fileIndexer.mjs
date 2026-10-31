import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { REMOTE_CONFIG_DIR } from './constants.mjs';
import { cloudOnlyFiles, inCloudFolder } from './cloudFiles.mjs';
import { extractDocText, isDocFile, wellFormed } from './docText.mjs';
import { FolderKind, classifyDir, folderSummary, skipDir, skipFile } from './folderRules.mjs';
import { isProtectedPath } from './sandbox.mjs';
import { openSqlite } from './sqliteDb.mjs';
import { decodeInt8, int8Cosine, tokenize } from './textIndex.mjs';

/**
 * Chỉ mục tệp (SQLite trên đĩa) cho các thư mục được phép: tên/đường dẫn + định danh đầu tệp (hàm, lớp, khoá…) → tìm tức thì theo tên lẫn
 * nội dung chính mà không quét đĩa mỗi lần. Khởi động: mở chỉ mục đã có, quét lại TĂNG DẦN (chỉ đọc tệp có mtime/size đổi). Chạy: theo
 * dõi thư mục (`fs.watch` đệ quy), cập nhật đúng tệp đổi.
 *
 * Tệp dạng tài liệu (docx/xlsx/pptx/pdf/txt…) có thêm đoạn chữ đầu (`preview`, đọc cả trong gói Office) và vector bge-m3 do BE tính
 * (`vectorize`, chạy nền): tìm kết hợp từ khoá BM25 + ngữ nghĩa (cosine) gộp bằng RRF — "hợp đồng thuê văn phòng" ra
 * `HD_thue_VP_2026.pdf`. Thư mục người dùng (Desktop, Documents, Downloads, OneDrive…) quét trước để trần số tệp không cắt mất chúng.
 *
 * Bỏ / gộp theo folderRules.mjs (thư mục ẩn, tệp tạm, thư mục ứng dụng, thư mục hàng loạt ảnh / log, kho git → một mục đại diện). Tệp chỉ có
 * trên mây: chỉ lập chỉ mục tên (cloudFiles.mjs). Thư mục làm việc người dùng chỉ định (`addFolder`, `index-folders.json`) lập chỉ mục đầy
 * đủ, kể cả code trong kho git.
 */

const DB_FILE = path.join(REMOTE_CONFIG_DIR, 'file-index.db');
/** Thư mục làm việc người dùng chỉ định (qua chat — công cụ fs.index_folder — hoặc `aivin remote index add`). */
const INDEX_FOLDERS_FILE = path.join(REMOTE_CONFIG_DIR, 'index-folders.json');
/** Bản chụp gzip của bản giữ chỉ mục trong RAM (≤ 1.0.11) — chép sang SQLite lần đầu rồi xoá. */
const LEGACY_SNAPSHOT_FILE = path.join(REMOTE_CONFIG_DIR, 'file-index.json.gz');
const LEGACY_VECTORS_FILE = path.join(REMOTE_CONFIG_DIR, 'file-vectors.json.gz');
const LEGACY_SNAPSHOT_VERSION = 3;
const MAX_FILES = 200_000;
const HEAD_BYTES = 16 * 1024;
const MAX_HEAD_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IDENTIFIERS = 200;
const STAT_CONCURRENCY = 64;
const WATCH_DEBOUNCE_MS = 800;
/** Từ trong câu hỏi dài từ chừng này trở lên thì khớp cả tiền tố ("auth" ↔ "authentication"). */
const PREFIX_MIN = 4;
/** Số vector đọc mỗi lần khi tìm theo nghĩa. */
const VECTOR_SCAN_CHUNK = 2000;
/** Số tệp tài liệu tối đa có vector (mỗi vector ~1,4 KB). */
const MAX_VECTOR_FILES = Number(process.env.AIVIN_REMOTE_MAX_VECTOR_FILES) || 20_000;
const EMBED_BATCH = 32;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const RANK_DEPTH = 50;
/** Hằng số k của Reciprocal Rank Fusion. */
const RRF_K = 60;
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.py', '.go', '.rs',
  '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.rb', '.swift', '.scala', '.sql', '.sh', '.ps1', '.bat', '.cmd',
  '.html', '.css', '.scss', '.vue', '.svelte', '.xml', '.gradle', '.proto', '.graphql', '.dart', '.lua', '.r', '.csv',
]);
/** Thư mục người dùng quét trước (ngay dưới gốc) — tài liệu thật thường nằm ở đây. */
const PRIORITY_DIRS = ['Desktop', 'Documents', 'Downloads', 'OneDrive', 'Pictures', 'Dropbox', 'Google Drive'];
/** Bộ theo dõi thư mục hỏng (gốc bị xoá, rút ổ ngoài, Linux hết inotify) → quét lại tăng dần theo nhịp này thay vì để chỉ mục cũ mãi. */
const RESCAN_MS = 10 * 60_000;
/** CLI (`aivin remote index add`) sửa danh sách thư mục làm việc khi listener đang chạy → listener thấy sau chừng này. */
const INDEX_FOLDERS_POLL_MS = 5_000;

/**
 * Tệp nhìn như chứa bí mật (tên hoặc đoạn đầu): không giữ đoạn chữ / định danh trong chỉ mục, không gửi đi tính vector, không đưa vào gợi
 * ý của Planner — "mat-khau.txt" tên bình thường mà nội dung là mật khẩu (rà 28/10/2026). Vẫn tìm được theo TÊN tệp.
 */
const SECRET_NAME_RE = /(passw|mat[-_ ]?khau|mật[-_ ]?khẩu|secret|credential|(^|[^a-z])tokens?([^a-z]|$)|private[-_ ]?key|recovery[-_ ]?code|seed[-_ ]?phrase|(^|[^a-z0-9])(2fa|otp)([^a-z]|$)|\.env$|id_(rsa|ed25519|ecdsa|dsa)|\.(pem|key|p12|pfx|kdbx|ovpn)$)/i;
const SECRET_TEXT_RE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(password|passwd|pwd|mật khẩu|mat khau|api[_-]?key|secret|token)\s*[:=]\s*\S{4,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[abpr]-[A-Za-z0-9-]{10,})/i;

export function looksSecret(abs, text = '') {
  return SECRET_NAME_RE.test(path.basename(abs)) || (!!text && SECRET_TEXT_RE.test(text));
}

function identifiersOf(text) {
  const seen = new Set();
  for (const m of text.matchAll(/[\p{L}_][\p{L}\p{N}_]{2,}/gu)) {
    seen.add(m[0]);
    if (seen.size >= MAX_IDENTIFIERS) break;
  }
  return [...seen].join(' ');
}

const readsContent = (abs) => isDocFile(abs) || TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase());

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

/**
 * Duyệt cây theo folderRules (không theo symlink ra ngoài): bỏ thư mục ẩn / rác, gộp thư mục ứng dụng / hàng loạt / kho git thành một mục.
 * `full` (thư mục làm việc người dùng chỉ định): kho git bên trong cũng lập chỉ mục đầy đủ. Gốc của lần duyệt không bị gộp.
 * → `{ files: [{ abs, repo }], folders: [{ abs, kind, mtime, count, note, words }] }` (`repo` = nằm trong kho git → chỉ giữ tài liệu).
 */
async function walk(root, limit, { skip = new Set(), full = false } = {}) {
  const files = [];
  const folders = [];
  const queue = [{ dir: root, repo: false }];
  const collapse = async (dir, kind, entries) => {
    const stat = await fs.promises.stat(dir).catch(() => null);
    folders.push({ abs: dir, kind, mtime: stat ? Math.floor(stat.mtimeMs) : 0, ...folderSummary(kind, dir, entries) });
  };
  while (queue.length && files.length < limit) {
    const batch = queue.splice(0, STAT_CONCURRENCY);
    await mapLimit(batch, STAT_CONCURRENCY, async ({ dir, repo }) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      const kind = dir === root ? null : classifyDir(path.basename(dir), entries);
      if (kind === FolderKind.APP) return collapse(dir, kind, entries);
      let inRepo = repo;
      if (kind === FolderKind.REPO && !full) {
        if (!repo) await collapse(dir, kind, entries);
        inRepo = true;
      }
      const bulk = kind === FolderKind.BULK;
      if (bulk) await collapse(dir, kind, entries);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(dir, entry.name);
        if (isProtectedPath(abs) || skip.has(abs)) continue;
        if (entry.isDirectory()) {
          if (!skipDir(entry.name)) queue.push({ dir: abs, repo: inRepo });
        } else if (entry.isFile() && !skipFile(entry.name) && (!(bulk || inRepo) || isDocFile(entry.name))) {
          files.push({ abs, repo: inRepo });
        }
      }
    });
  }
  return { files: files.slice(0, limit), folders };
}

/** Thư mục ưu tiên có thật ngay dưới các gốc (kể cả `OneDrive - Công ty`). */
function priorityDirsOf(roots) {
  const out = [];
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const want of PRIORITY_DIRS) {
      for (const name of names) if (name === want || name.startsWith(`${want} -`)) out.push(path.join(root, name));
    }
  }
  return out;
}

/** Thư mục làm việc người dùng chỉ định (đường tuyệt đối). */
export function loadIndexFolders() {
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_FOLDERS_FILE, 'utf8'));
    return Array.isArray(data?.folders) ? data.folders.filter((f) => typeof f === 'string' && path.isAbsolute(f)) : [];
  } catch {
    return [];
  }
}

export function saveIndexFolders(folders) {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  const list = [...new Set(folders.map((f) => path.resolve(f)))];
  fs.writeFileSync(INDEX_FOLDERS_FILE, JSON.stringify({ folders: list }, null, 2));
  return list;
}

const within = (dir, abs) => abs === dir || abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const vectorKey = (entry) => `${entry.mtime}:${entry.size}`;

/** Đổi bảng → tăng số này: chỉ mục cũ bị bỏ, quét lại từ đầu. */
const SCHEMA_VERSION = '2';
const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -8000;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;
// FTS5 không giữ bản chữ (contentless) — chữ tách sẵn chỉ cần để lập chỉ mục; xem / xếp hạng dùng bảng files. `kind` ≠ NULL: mục đại diện
// cho một thư mục gộp (FolderKind), `size` = số mục bên trong, `preview` = ghi chú cho agent.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, mtime INTEGER, size INTEGER, preview TEXT, kind TEXT,
    secret INTEGER NOT NULL DEFAULT 0, doc INTEGER NOT NULL DEFAULT 0, prio INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS files_vector_order ON files (doc, secret, prio DESC, mtime DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5 (
    body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 0', prefix = '${PREFIX_MIN}'
  );
  CREATE TABLE IF NOT EXISTS vectors (id INTEGER PRIMARY KEY, key TEXT NOT NULL, vec BLOB NOT NULL);
`;

/**
 * Chỉ mục nằm trên đĩa (SQLite, `file-index.db`), không nạp vào RAM: bảng `files` (đường dẫn, mtime/size, chữ đầu tài liệu, mục thư mục
 * gộp), FTS5 cho từ khoá (BM25 + khớp tiền tố, chữ đã tách sẵn bằng `tokenize` — bỏ dấu, camelCase, chữ Hán thành cặp), `vectors` (int8
 * BLOB). Tìm chỉ đọc vài trang B-tree; vector quét theo khúc. ~100k tệp từng ngốn ~1 GB RAM khi mọi thứ là Map / Set trong bộ nhớ.
 */
export function createFileIndex(roots) {
  const resolvedRoots = roots.map((r) => path.resolve(r));
  const watchers = new Map(); // thư mục được theo dõi → fs.FSWatcher
  let db = null;
  let opening = null;
  let st = null;
  let migrated = 0;
  let rescanTimer = null;
  let vectorTimer;
  let lastBuild = null;
  let priorityDirs = [];
  let indexFolders = loadIndexFolders();
  /** Thư mục gộp đã biết (từ chỉ mục) — để bộ theo dõi không lập chỉ mục lẻ từng ảnh chụp màn hình mới. */
  let collapsed = [];
  let watching = false;
  let embedder = null;
  let vectorizing = false;
  let failures = 0;
  let pausedUntil = 0;

  const docText = (abs, entry) => `${abs.split(path.sep).slice(-6).join(' ')} ${entry.tokens || ''} ${entry.preview || ''}`;
  const isPriority = (abs) => priorityDirs.some((d) => within(d, abs)) || indexFolders.some((d) => within(d, abs));
  /** Nằm trong thư mục / là tệp không lập chỉ mục (tính từ gốc) — bản chụp cũ còn giữ những tệp này. */
  const skippedPath = (abs) => {
    const root = resolvedRoots.find((r) => within(r, abs));
    if (!root) return true;
    const segs = path.relative(root, abs).split(path.sep);
    return segs.slice(0, -1).some(skipDir) || skipFile(segs[segs.length - 1]);
  };

  function ensureOpen() {
    if (!opening) {
      opening = (async () => {
        fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
        db = await openSqlite(DB_FILE);
        db.exec(PRAGMAS);
        const meta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
        const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        if (meta('schema') !== SCHEMA_VERSION) {
          db.exec('DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS vectors; DELETE FROM meta;');
          setMeta.run('schema', SCHEMA_VERSION);
        }
        db.exec(SCHEMA);
        // Đổi gốc (ghép lại với thư mục khác / bật toàn quyền) → chỉ mục cũ vô dụng.
        if (meta('roots') !== JSON.stringify(resolvedRoots)) {
          db.exec('DELETE FROM files; DELETE FROM fts; DELETE FROM vectors;');
          setMeta.run('roots', JSON.stringify(resolvedRoots));
        }
        st = {
          find: db.prepare('SELECT id, mtime, size, kind, doc FROM files WHERE path = ?'),
          upsert: db.prepare(`INSERT INTO files (path, mtime, size, preview, kind, secret, doc, prio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, preview = excluded.preview, kind = excluded.kind,
            secret = excluded.secret, doc = excluded.doc, prio = excluded.prio RETURNING id`),
          flags: db.prepare('UPDATE files SET doc = ?, prio = ? WHERE id = ?'),
          ftsDelete: db.prepare('DELETE FROM fts WHERE rowid = ?'),
          ftsInsert: db.prepare('INSERT INTO fts (rowid, body) VALUES (?, ?)'),
          fileDelete: db.prepare('DELETE FROM files WHERE id = ?'),
          vectorDelete: db.prepare('DELETE FROM vectors WHERE id = ?'),
          vectorPut: db.prepare('INSERT INTO vectors (id, key, vec) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET key = excluded.key, vec = excluded.vec'),
          vectorChunk: db.prepare('SELECT id, vec FROM vectors WHERE id > ? ORDER BY id LIMIT ?'),
          lexical: db.prepare('SELECT rowid AS id FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?'),
          row: db.prepare('SELECT path, size, mtime, preview, kind FROM files WHERE id = ?'),
          paths: db.prepare('SELECT id, path FROM files'),
          collapsed: db.prepare('SELECT path, kind FROM files WHERE kind IS NOT NULL'),
          fileCount: db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL'),
          folderCount: db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NOT NULL'),
          vectorCount: db.prepare('SELECT count(*) AS n FROM vectors'),
        };
        priorityDirs = priorityDirsOf(resolvedRoots);
        migrated = migrateLegacySnapshot();
        collapsed = st.collapsed.all().map((r) => ({ abs: r.path, kind: r.kind }));
      })();
    }
    return opening;
  }

  function setEntry(abs, entry) {
    const { id } = st.upsert.get(abs, entry.mtime, entry.size, entry.preview || null, entry.kind || null, entry.secret ? 1 : 0,
      entry.doc ? 1 : 0, isPriority(abs) ? 1 : 0);
    st.ftsDelete.run(id);
    st.ftsInsert.run(id, tokenize(docText(abs, entry)).join(' '));
    return id;
  }

  function dropId(id) {
    st.ftsDelete.run(id);
    st.vectorDelete.run(id);
    st.fileDelete.run(id);
  }

  /** Bản chụp gzip của bản cũ (giữ mọi thứ trong RAM) → chép sang SQLite một lần, kể cả vector (khỏi bắt BE tính lại), rồi xoá. */
  function migrateLegacySnapshot() {
    if (!fs.existsSync(LEGACY_SNAPSHOT_FILE)) return 0;
    let count = 0;
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(LEGACY_SNAPSHOT_FILE)).toString('utf8'));
      if (data?.version === LEGACY_SNAPSHOT_VERSION && JSON.stringify(data.roots) === JSON.stringify(resolvedRoots) && !st.fileCount.get().n) {
        let vectors = [];
        try { vectors = JSON.parse(zlib.gunzipSync(fs.readFileSync(LEGACY_VECTORS_FILE)).toString('utf8')).vectors || []; } catch { /* chưa có */ }
        db.transaction(() => {
          const keys = new Map();
          for (const [abs, mtime, size, tokens, preview] of data.entries || []) {
            if (skippedPath(abs)) continue;
            const entry = { mtime, size, tokens, preview, secret: looksSecret(abs), doc: isDocFile(abs) };
            keys.set(abs, { id: setEntry(abs, entry), key: vectorKey(entry) });
            count++;
          }
          for (const [abs, key, b64] of vectors) {
            const file = keys.get(abs);
            if (file && file.key === key && b64) st.vectorPut.run(file.id, key, Buffer.from(b64, 'base64'));
          }
        });
      }
    } catch { count = 0; /* hỏng → quét lại từ đầu */ }
    for (const f of [LEGACY_SNAPSHOT_FILE, LEGACY_VECTORS_FILE]) fs.rmSync(f, { force: true });
    return count;
  }

  /** Mục đại diện cho thư mục gộp — chỉ ghi khi đổi (mtime thư mục / số mục / loại). */
  function setFolder(f) {
    const prev = st.find.get(f.abs);
    if (prev && prev.kind === f.kind && prev.mtime === f.mtime && prev.size === f.count) return false;
    setEntry(f.abs, { mtime: f.mtime, size: f.count, preview: f.note, tokens: f.words, kind: f.kind });
    return true;
  }

  /**
   * Đọc lại một tệp nếu mtime / size đổi. `repo`: nằm trong kho git (tài liệu ở đây không tính vector). `contentOk`: undefined = tệp trong
   * thư mục đám mây thì trả 'cloud' để người gọi hỏi thuộc tính cả lô; false = chỉ lập chỉ mục tên (tệp chỉ có trên mây).
   */
  async function refreshFile(abs, { repo = false, contentOk } = {}) {
    await ensureOpen();
    const prev = st.find.get(abs);
    let stat;
    try { stat = await fs.promises.stat(abs); } catch {
      if (prev) dropId(prev.id);
      return 'removed';
    }
    if (!stat.isFile()) return 'skipped';
    const mtime = Math.floor(stat.mtimeMs);
    const doc = isDocFile(abs) && !repo;
    if (prev && prev.mtime === mtime && prev.size === stat.size) {
      // Cùng tệp nhưng nay thuộc / không còn thuộc thư mục làm việc người dùng chỉ định → chỉ sửa cờ.
      if (Boolean(prev.doc) !== doc) st.flags.run(doc ? 1 : 0, isPriority(abs) ? 1 : 0, prev.id);
      return 'same';
    }
    if (contentOk === undefined && readsContent(abs) && inCloudFolder(abs)) return 'cloud';
    const read = contentOk !== false;
    const preview = read && isDocFile(abs) ? await extractDocText(abs, stat.size) : '';
    const tokens = read ? await headTokens(abs, stat.size) : '';
    // Tệp như chứa bí mật: chỉ giữ tên (tìm theo tên vẫn được), bỏ đoạn chữ + định danh.
    const id = looksSecret(abs, `${preview}\n${tokens}`)
      ? setEntry(abs, { mtime, size: stat.size, tokens: '', secret: true, doc })
      : setEntry(abs, { mtime, size: stat.size, tokens, preview, doc });
    st.vectorDelete.run(id);
    return 'updated';
  }

  /** Lô tệp ở thư mục đám mây: hỏi thuộc tính một lần, tệp chỉ có trên mây chỉ lập chỉ mục tên. */
  async function refreshCloud(list) {
    if (!list.length) return 0;
    const offline = await cloudOnlyFiles(list.map((f) => f.abs));
    let updated = 0;
    await mapLimit(list, STAT_CONCURRENCY, async (f) => {
      if ((await refreshFile(f.abs, { repo: f.repo, contentOk: !offline.has(f.abs) })) === 'updated') updated++;
    });
    return updated;
  }

  /** Lập chỉ mục một cây (gốc / thư mục ưu tiên / thư mục làm việc) → số tệp cập nhật; ghi nhận mọi đường đã thấy vào `found`. */
  async function indexTree(dir, { found, limit, skip, full }) {
    const { files, folders } = await walk(dir, limit, { skip, full });
    let updated = 0;
    for (const f of folders) {
      if (found.has(f.abs)) continue;
      found.add(f.abs);
      if (setFolder(f)) updated++;
    }
    const fresh = files.filter((f) => !found.has(f.abs));
    fresh.forEach((f) => found.add(f.abs));
    const cloud = [];
    await mapLimit(fresh, STAT_CONCURRENCY, async (f) => {
      const r = await refreshFile(f.abs, { repo: f.repo });
      if (r === 'updated') updated++;
      else if (r === 'cloud') cloud.push(f);
    });
    return updated + await refreshCloud(cloud);
  }

  /**
   * Quét tăng dần: thư mục làm việc người dùng chỉ định trước, rồi thư mục người dùng, rồi phần còn lại của các gốc. Tệp mới / đổi được đọc
   * lại, tệp không còn thấy bị bỏ.
   */
  async function build() {
    const startedAt = Date.now();
    const first = !lastBuild;
    await ensureOpen();
    priorityDirs = priorityDirsOf(resolvedRoots);
    indexFolders = loadIndexFolders();
    const found = new Set();
    let updated = 0;
    const plan = [
      ...indexFolders.map((dir) => ({ dir, full: true })),
      ...priorityDirs.map((dir) => ({ dir })),
      ...resolvedRoots.map((dir) => ({ dir, root: true })),
    ];
    for (const { dir, full, root } of plan) {
      if (found.size >= MAX_FILES) break;
      const skip = new Set([...indexFolders.filter((d) => d !== dir), ...(root ? priorityDirs : [])]);
      updated += await indexTree(dir, { found, limit: MAX_FILES - found.size, skip, full });
    }
    // Có trong chỉ mục mà lần quét này không thấy (đã xoá / đổi tên / nay bị bỏ qua) — một lần đọc, không ghi gì cho tệp không đổi.
    const gone = st.paths.all().filter((r) => !found.has(r.path));
    db.transaction(() => { for (const { id } of gone) dropId(id); });
    collapsed = st.collapsed.all().map((r) => ({ abs: r.path, kind: r.kind }));
    lastBuild = {
      files: st.fileCount.get().n, folders: st.folderCount.get().n, updated, removed: gone.length, from_snapshot: first ? migrated : 0,
      capped: found.size >= MAX_FILES, ms: Date.now() - startedAt, at: new Date().toISOString(),
    };
    scheduleVectorize(0);
    return lastBuild;
  }

  /**
   * Tệp bộ theo dõi báo đổi: có lập chỉ mục không, và có nằm trong kho git không. null = bỏ (thư mục ẩn / rác, tệp tạm, trong thư mục ứng
   * dụng, tệp không phải tài liệu trong thư mục hàng loạt hay kho git).
   */
  function ruleFor(abs) {
    const folder = indexFolders.filter((d) => within(d, abs)).sort((a, b) => b.length - a.length)[0];
    const base = folder || resolvedRoots.find((r) => within(r, abs));
    if (!base || isProtectedPath(abs)) return null;
    const segs = path.relative(base, abs).split(path.sep);
    if (segs.slice(0, -1).some(skipDir) || skipFile(segs[segs.length - 1])) return null;
    let repo = false;
    for (const c of collapsed) {
      // Chỉ thư mục gộp nằm GIỮA gốc và tệp; gộp bao trùm cả gốc (thư mục làm việc nằm trong một kho git…) không tính.
      if (c.abs === abs || !within(c.abs, abs) || within(c.abs, base)) continue;
      if (c.kind === FolderKind.APP) return null;
      if (c.kind === FolderKind.BULK && path.dirname(abs) === c.abs && !isDocFile(abs)) return null;
      if (c.kind === FolderKind.REPO && !folder) repo = true;
    }
    if (repo && !isDocFile(abs)) return null;
    return { repo };
  }

  function watchDir(dir, pending, flush, fallBackToRescan) {
    if (watchers.has(dir)) return;
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, name) => {
        if (!name) return;
        pending.add(path.join(dir, String(name)));
        flush();
      });
      // Không có listener 'error' thì lỗi của bộ theo dõi (gốc bị xoá, rút ổ ngoài, hết inotify) ném ra ngoài và làm sập daemon.
      w.on('error', () => {
        try { w.close(); } catch { /* đã đóng */ }
        watchers.delete(dir);
        fallBackToRescan();
      });
      w.unref?.();
      watchers.set(dir, w);
    } catch { fallBackToRescan(); /* không theo dõi được (hệ thống tệp mạng…) */ }
  }

  let rewatch = () => {};

  function watch() {
    watching = true;
    const pending = new Set();
    let timer;
    const run = async () => {
      const batch = [...pending];
      pending.clear();
      const cloud = [];
      await mapLimit(batch, STAT_CONCURRENCY, async (abs) => {
        const rule = ruleFor(abs);
        if (!rule) return;
        if ((await refreshFile(abs, { repo: rule.repo })) === 'cloud') cloud.push({ abs, repo: rule.repo });
      });
      await refreshCloud(cloud);
      scheduleVectorize(5_000);
    };
    const flush = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), WATCH_DEBOUNCE_MS);
    };
    const fallBackToRescan = () => {
      // Bộ theo dõi hỏng: chuyển sang quét lại định kỳ (tăng dần — chỉ đọc tệp có mtime / size đổi).
      if (rescanTimer) return;
      rescanTimer = setInterval(() => void build().catch(() => undefined), RESCAN_MS);
      rescanTimer.unref?.();
    };
    rewatch = () => {
      const want = [...resolvedRoots, ...indexFolders.filter((d) => !resolvedRoots.some((r) => within(r, d)))];
      for (const [dir, w] of watchers) if (!want.includes(dir)) { try { w.close(); } catch { /* đã đóng */ } watchers.delete(dir); }
      for (const dir of want) watchDir(dir, pending, flush, fallBackToRescan);
    };
    rewatch();
    // `aivin remote index add|remove` (tiến trình khác) sửa danh sách → quét lại tăng dần.
    fs.watchFile(INDEX_FOLDERS_FILE, { interval: INDEX_FOLDERS_POLL_MS, persistent: false }, () => {
      if (JSON.stringify(loadIndexFolders()) === JSON.stringify(indexFolders)) return;
      void build().then(() => rewatch()).catch(() => undefined);
    });
  }

  /**
   * Thư mục làm việc người dùng chỉ định (qua chat → fs.index_folder): lập chỉ mục đầy đủ ngay (kể cả code trong kho git), ưu tiên tính
   * vector, theo dõi thay đổi. Chờ tối đa `waitMs` — quá thì vẫn chạy tiếp ở nền (`done: false`).
   */
  async function addFolder(dir, { waitMs = 15_000 } = {}) {
    const abs = path.resolve(dir);
    indexFolders = saveIndexFolders([...loadIndexFolders(), abs]);
    await ensureOpen();
    const found = new Set();
    const job = indexTree(abs, { found, limit: MAX_FILES, skip: new Set(indexFolders.filter((d) => d !== abs)), full: true })
      .then((updated) => {
        collapsed = st.collapsed.all().map((r) => ({ abs: r.path, kind: r.kind }));
        if (watching) rewatch();
        scheduleVectorize(1_000);
        return updated;
      });
    let timer;
    const result = await Promise.race([job.then((updated) => ({ done: true, updated })), new Promise((r) => { timer = setTimeout(() => r({ done: false }), waitMs); })]);
    clearTimeout(timer);
    return { folder: abs, folders: indexFolders, indexed: [...found].length, ...result };
  }

  /** Bỏ thư mục làm việc: quét lại tăng dần để bỏ những gì chỉ có vì thư mục này (code trong kho git, thư mục ngoài gốc). */
  async function removeFolder(dir) {
    const abs = path.resolve(dir);
    indexFolders = saveIndexFolders(loadIndexFolders().filter((d) => d !== abs));
    const stats = await build();
    if (watching) rewatch();
    return { folder: abs, folders: indexFolders, removed: stats.removed };
  }

  /** Đoạn mô tả đưa đi tính vector: tên + thư mục gần nhất + chữ đầu tệp. */
  const embedText = (abs, entry) => `${path.basename(abs)} | ${path.dirname(abs).split(path.sep).slice(-3).join(' / ')}${entry.preview ? ` | ${entry.preview}` : ''}`;

  /** Tệp tài liệu cần (tính lại) vector: thư mục ưu tiên trước, mới sửa trước; giữ trong trần MAX_VECTOR_FILES. */
  function vectorQueue() {
    const order = 'FROM files WHERE doc = 1 AND secret = 0 ORDER BY prio DESC, mtime DESC LIMIT ?';
    db.prepare(`DELETE FROM vectors WHERE id NOT IN (SELECT id ${order})`).run(MAX_VECTOR_FILES);
    return db.prepare(`SELECT f.id, f.path, f.mtime, f.size, f.preview, v.key AS vkey FROM (SELECT * ${order}) f LEFT JOIN vectors v ON v.id = f.id`)
      .all(MAX_VECTOR_FILES).filter((r) => r.vkey !== vectorKey(r));
  }

  /**
   * Tính vector nền theo lô (`embed(texts) → base64[]`, BE tính bằng bge-m3). BE cũ / lỗi → dừng, lần sau thử lại; tìm theo từ khoá vẫn
   * chạy bình thường.
   */
  async function vectorize() {
    if (!db || !embedder || vectorizing || Date.now() < pausedUntil) return { embedded: 0, total: db ? st.vectorCount.get().n : 0 };
    vectorizing = true;
    let embedded = 0;
    let failed = false;
    try {
      const queue = vectorQueue();
      for (let i = 0; i < queue.length; i += EMBED_BATCH) {
        const batch = queue.slice(i, i + EMBED_BATCH);
        const out = await embedder(batch.map((r) => wellFormed(embedText(r.path, r))));
        if (!Array.isArray(out) || out.length !== batch.length) { failed = true; break; }
        if (!db) break;
        db.transaction(() => batch.forEach((r, j) => { if (out[j]) st.vectorPut.run(r.id, vectorKey(r), Buffer.from(out[j], 'base64')); }));
        embedded += batch.length;
        failures = 0;
      }
    } catch { failed = true; } finally {
      vectorizing = false;
    }
    // BE bận / lỗi → nghỉ giãn dần (30 s → tối đa 30 phút) thay vì thử lại mỗi lần tệp đổi — không dồn tải lên dịch vụ vector dùng chung.
    if (failed) {
      failures++;
      const pauseMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
      pausedUntil = Date.now() + pauseMs;
      scheduleVectorize(pauseMs + 1_000);
    }
    return { embedded, total: db ? st.vectorCount.get().n : 0, failed: failed || undefined };
  }

  function scheduleVectorize(delayMs) {
    if (!embedder) return;
    clearTimeout(vectorTimer);
    vectorTimer = setTimeout(() => void vectorize(), delayMs);
    vectorTimer.unref?.();
  }

  function setEmbedder(fn) {
    embedder = fn;
    if (lastBuild) scheduleVectorize(2_000);
  }

  function close() {
    if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
    for (const w of watchers.values()) { try { w.close(); } catch { /* đã đóng */ } }
    watchers.clear();
    if (watching) fs.unwatchFile(INDEX_FOLDERS_FILE);
    watching = false;
    clearTimeout(vectorTimer);
    try { db?.close(); } catch { /* đã đóng */ }
    db = null;
    opening = null;
  }

  /** Từ khoá → FTS5: mỗi từ một vế OR; từ ≥ PREFIX_MIN ký tự khớp cả tiền tố ("auth" ↔ "authentication"). Từ chỉ có chữ / số — không cần thoát. */
  const matchExpr = (query) => [...new Set(tokenize(query))].map((t) => `"${t}"${t.length >= PREFIX_MIN ? '*' : ''}`).join(' OR ');

  /** Vector gần câu hỏi nhất: quét bảng theo khúc (không giữ cả bảng trong RAM). */
  function nearest(q, depth) {
    let top = [];
    for (let after = 0; ;) {
      const rows = st.vectorChunk.all(after, VECTOR_SCAN_CHUNK);
      for (const r of rows) top.push([r.id, int8Cosine(q, new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength))]);
      top = top.sort((a, b) => b[1] - a[1]).slice(0, depth);
      if (rows.length < VECTOR_SCAN_CHUNK) return top;
      after = rows[rows.length - 1].id;
    }
  }

  /**
   * Tìm theo tên / đường dẫn / định danh / chữ đầu tài liệu; có `vector` (bge-m3 int8 base64 của câu hỏi) thì gộp thêm xếp hạng ngữ
   * nghĩa. Trả đường hiển thị (tương đối với gốc; thư mục làm việc ngoài gốc thì tuyệt đối) + dung lượng, ngày sửa, đoạn xem trước; thư mục
   * gộp có `type: 'folder'` + `note`. `abs` = đường tuyệt đối (để gộp với kết quả của bộ tìm hệ điều hành).
   */
  function search(query, limit = 10, vector) {
    if (!db) return [];
    const depth = Math.max(limit, RANK_DEPTH);
    const expr = matchExpr(query);
    const lexical = expr ? st.lexical.all(expr, depth).map((r) => r.id) : [];
    const q = vector ? decodeInt8(vector) : null;
    const semantic = q ? nearest(q, RANK_DEPTH) : [];
    const similarity = new Map(semantic);
    const ranked = semantic.length ? fuse(lexical, semantic.map(([id]) => id), similarity) : lexical;
    return ranked.slice(0, limit).flatMap((id) => {
      const e = st.row.get(id);
      if (!e) return [];
      const root = resolvedRoots.find((r) => within(r, e.path));
      const modified = e.mtime ? new Date(e.mtime).toISOString().slice(0, 10) : undefined;
      const shown = root ? path.relative(root, e.path) || e.path : e.path;
      if (e.kind) return [{ path: shown, abs: e.path, type: 'folder', kind: e.kind, items: e.size, modified, note: e.preview }];
      return [{
        path: shown, abs: e.path, size: e.size, modified,
        ...(e.preview ? { preview: e.preview.slice(0, 200) } : {}),
        ...(similarity.has(id) ? { similarity: Number(similarity.get(id).toFixed(3)) } : {}),
      }];
    });
  }

  return {
    build, watch, close, search, refreshFile, vectorize, setEmbedder, addFolder, removeFolder,
    folders: () => [...indexFolders],
    stats: () => ({
      files: db ? st.fileCount.get().n : 0, folders: db ? st.folderCount.get().n : 0, vectors: db ? st.vectorCount.get().n : 0,
      index_folders: [...indexFolders], last_build: lastBuild,
    }),
  };
}

/**
 * Gộp hai bảng xếp hạng (RRF). Hoà điểm — tệp đầu bảng từ khoá vs tệp đầu bảng ngữ nghĩa — thì tệp gần nghĩa hơn đứng trước: từ khoá
 * chỉ trùng một chữ chung ("thuê") hay gặp hơn là trùng nghĩa.
 */
function fuse(lexical, semantic, similarity) {
  const score = new Map();
  for (const list of [lexical, semantic]) list.forEach((id, rank) => score.set(id, (score.get(id) || 0) + 1 / (RRF_K + rank + 1)));
  return [...score.keys()].sort((a, b) => (score.get(b) - score.get(a)) || ((similarity.get(b) ?? -1) - (similarity.get(a) ?? -1)));
}

/** Gốc lập chỉ mục: máy toàn quyền chỉ quét thư mục nhà (cả ổ là hàng trăm nghìn tệp hệ thống). */
export function indexRootsFor(roots, fullAccess) {
  return fullAccess ? [os.homedir()] : roots;
}
