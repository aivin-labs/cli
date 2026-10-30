import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { IGNORED_DIRS, REMOTE_CONFIG_DIR } from './constants.mjs';
import { extractDocText, isDocFile, wellFormed } from './docText.mjs';
import { isProtectedPath } from './sandbox.mjs';
import { createTextIndex, decodeInt8, int8Cosine } from './textIndex.mjs';

/**
 * Chỉ mục tệp trong RAM cho các thư mục được phép: tên/đường dẫn + định danh đầu tệp (hàm, lớp, khoá…) → tìm tức thì theo tên lẫn nội
 * dung chính mà không quét đĩa mỗi lần. Khởi động: nạp bản chụp gzip, quét lại TĂNG DẦN (chỉ đọc tệp có mtime/size đổi). Chạy: theo
 * dõi thư mục (`fs.watch` đệ quy), cập nhật đúng tệp đổi.
 *
 * Tệp dạng tài liệu (docx/xlsx/pptx/pdf/txt…) có thêm đoạn chữ đầu (`preview`, đọc cả trong gói Office) và vector bge-m3 do BE tính
 * (`vectorize`, chạy nền): tìm kết hợp từ khoá BM25 + ngữ nghĩa (cosine) gộp bằng RRF — "hợp đồng thuê văn phòng" ra
 * `HD_thue_VP_2026.pdf`. Thư mục người dùng (Desktop, Documents, Downloads, OneDrive…) quét trước để trần số tệp không cắt mất chúng.
 */

const SNAPSHOT_FILE = path.join(REMOTE_CONFIG_DIR, 'file-index.json.gz');
const VECTORS_FILE = path.join(REMOTE_CONFIG_DIR, 'file-vectors.json.gz');
const SNAPSHOT_VERSION = 3;
const MAX_FILES = 200_000;
const HEAD_BYTES = 16 * 1024;
const MAX_HEAD_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IDENTIFIERS = 200;
const STAT_CONCURRENCY = 64;
const WATCH_DEBOUNCE_MS = 800;
const SNAPSHOT_DEBOUNCE_MS = 10_000;
/** Số tệp tài liệu tối đa có vector (mỗi vector ~1,4 KB). */
const MAX_VECTOR_FILES = Number(process.env.AIVIN_REMOTE_MAX_VECTOR_FILES) || 20_000;
const EMBED_BATCH = 32;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const RANK_DEPTH = 50;
/** Hằng số k của Reciprocal Rank Fusion. */
const RRF_K = 60;
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.ini', '.env', '.py', '.go', '.rs',
  '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.rb', '.swift', '.scala', '.sql', '.sh', '.ps1', '.bat', '.cmd',
  '.html', '.css', '.scss', '.vue', '.svelte', '.xml', '.gradle', '.proto', '.graphql', '.dart', '.lua', '.r', '.csv',
]);
/** Chỉ bỏ khi LẬP CHỈ MỤC (fs.list / fs.grep vẫn vào được): dữ liệu ứng dụng, hệ điều hành, thùng rác, kho gói — hàng trăm nghìn tệp vô ích. */
const INDEX_SKIP_DIRS = new Set([
  'AppData', 'Application Data', 'Local Settings', '$Recycle.Bin', 'System Volume Information', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', 'Library', '.Trash', '.npm', '.yarn', '.pnpm-store', '.nuget', '.m2', '.cargo', '.rustup',
  '.vscode', '.cursor', '.docker', 'miniconda3', 'anaconda3', 'snap',
]);
/** Thư mục người dùng quét trước (ngay dưới gốc) — tài liệu thật thường nằm ở đây. */
const PRIORITY_DIRS = ['Desktop', 'Documents', 'Downloads', 'OneDrive', 'Pictures', 'Dropbox', 'Google Drive'];
/** Bộ theo dõi thư mục hỏng (gốc bị xoá, rút ổ ngoài, Linux hết inotify) → quét lại tăng dần theo nhịp này thay vì để chỉ mục cũ mãi. */
const RESCAN_MS = 10 * 60_000;

/**
 * Tệp nhìn như chứa bí mật (tên hoặc đoạn đầu): không giữ đoạn chữ / định danh trong chỉ mục, không gửi đi tính vector, không đưa vào gợi
 * ý của Planner — "mat-khau.txt" tên bình thường mà nội dung là mật khẩu (rà 28/10/2026). Vẫn tìm được theo TÊN tệp.
 */
const SECRET_NAME_RE = /(passw|mat[-_ ]?khau|mật[-_ ]?khẩu|secret|credential|(^|[^a-z])tokens?([^a-z]|$)|private[-_ ]?key|recovery[-_ ]?code|seed[-_ ]?phrase|(^|[^a-z0-9])(2fa|otp)([^a-z]|$)|\.env$|id_(rsa|ed25519|ecdsa|dsa)|\.(pem|key|p12|pfx|kdbx|ovpn)$)/i;
const SECRET_TEXT_RE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(password|passwd|pwd|mật khẩu|mat khau|api[_-]?key|secret|token)\s*[:=]\s*\S{4,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[abpr]-[A-Za-z0-9-]{10,})/i;

export function looksSecret(abs, text = '') {
  return SECRET_NAME_RE.test(path.basename(abs)) || (!!text && SECRET_TEXT_RE.test(text));
}

const skipDir = (name) => IGNORED_DIRS.has(name) || INDEX_SKIP_DIRS.has(name);

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

/** Duyệt cây (bỏ thư mục rác / hệ thống, không theo symlink ra ngoài) → danh sách đường tuyệt đối của tệp. */
async function walk(root, limit, skip = new Set()) {
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
        if (isProtectedPath(full) || skip.has(full)) continue;
        if (entry.isDirectory()) { if (!skipDir(entry.name)) queue.push(full); } else if (entry.isFile()) files.push(full);
      }
    });
  }
  return files.slice(0, limit);
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

const vectorKey = (entry) => `${entry.mtime}:${entry.size}`;

export function createFileIndex(roots) {
  const resolvedRoots = roots.map((r) => path.resolve(r));
  const entries = new Map(); // abs → { mtime, size, tokens, preview? }
  const vectors = new Map(); // abs → { key, b64, vec: Int8Array }
  const index = createTextIndex();
  const watchers = [];
  let rescanTimer = null;
  let snapshotTimer;
  let vectorTimer;
  let lastBuild = null;
  let priorityDirs = [];
  let embedder = null;
  let vectorizing = false;
  let failures = 0;
  let pausedUntil = 0;

  const docText = (abs, entry) => `${abs.split(path.sep).slice(-6).join(' ')} ${entry.tokens || ''} ${entry.preview || ''}`;
  const isPriority = (abs) => priorityDirs.some((d) => abs.startsWith(d + path.sep));

  function setEntry(abs, entry) {
    entries.set(abs, entry);
    index.add(abs, docText(abs, entry));
  }

  function dropEntry(abs) {
    entries.delete(abs);
    vectors.delete(abs);
    index.remove(abs);
  }

  function loadSnapshot() {
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT_FILE)).toString('utf8'));
      if (data?.version !== SNAPSHOT_VERSION || JSON.stringify(data.roots) !== JSON.stringify(resolvedRoots)) return 0;
      for (const [abs, mtime, size, tokens, preview] of data.entries || []) setEntry(abs, { mtime, size, tokens, ...(preview ? { preview } : {}) });
      loadVectors();
      return entries.size;
    } catch {
      return 0;
    }
  }

  function loadVectors() {
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(VECTORS_FILE)).toString('utf8'));
      for (const [abs, key, b64] of data.vectors || []) {
        const entry = entries.get(abs);
        if (entry && vectorKey(entry) === key) vectors.set(abs, { key, b64, vec: decodeInt8(b64) });
      }
    } catch { /* chưa có vector — tính dần */ }
  }

  function atomicGzip(file, payload) {
    fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(payload)));
    fs.renameSync(tmp, file);
  }

  function saveSnapshot() {
    try {
      atomicGzip(SNAPSHOT_FILE, {
        version: SNAPSHOT_VERSION, roots: resolvedRoots,
        entries: [...entries.entries()].map(([abs, e]) => (e.preview ? [abs, e.mtime, e.size, e.tokens, e.preview] : [abs, e.mtime, e.size, e.tokens])),
      });
      atomicGzip(VECTORS_FILE, { vectors: [...vectors.entries()].map(([abs, v]) => [abs, v.key, v.b64]) });
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
    const preview = isDocFile(abs) ? await extractDocText(abs, stat.size) : '';
    const tokens = await headTokens(abs, stat.size);
    // Tệp như chứa bí mật: chỉ giữ tên (tìm theo tên vẫn được), bỏ đoạn chữ + định danh.
    if (looksSecret(abs, `${preview}\n${tokens}`)) setEntry(abs, { mtime, size: stat.size, tokens: '', secret: true });
    else setEntry(abs, { mtime, size: stat.size, tokens, ...(preview ? { preview } : {}) });
    vectors.delete(abs);
    return 'updated';
  }

  /** Quét tăng dần: thư mục người dùng trước, rồi phần còn lại của các gốc. Tệp mới / đổi được đọc lại, tệp mất bị bỏ. */
  async function build() {
    const startedAt = Date.now();
    const fromSnapshot = entries.size ? 0 : loadSnapshot();
    priorityDirs = priorityDirsOf(resolvedRoots);
    const found = new Set();
    let updated = 0;
    for (const dir of [...priorityDirs, ...resolvedRoots]) {
      if (found.size >= MAX_FILES) break;
      const skip = resolvedRoots.includes(dir) ? new Set(priorityDirs) : new Set();
      const files = (await walk(dir, MAX_FILES - found.size, skip)).filter((f) => !found.has(f));
      files.forEach((f) => found.add(f));
      await mapLimit(files, STAT_CONCURRENCY, async (abs) => { if ((await refreshFile(abs)) === 'updated') updated++; });
    }
    let removed = 0;
    for (const abs of [...entries.keys()]) if (!found.has(abs)) { dropEntry(abs); removed++; }
    saveSnapshot();
    lastBuild = { files: entries.size, updated, removed, from_snapshot: fromSnapshot, capped: found.size >= MAX_FILES, ms: Date.now() - startedAt, at: new Date().toISOString() };
    scheduleVectorize(0);
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
      scheduleVectorize(5_000);
    };
    const fallBackToRescan = () => {
      // Bộ theo dõi hỏng: đóng, chuyển sang quét lại định kỳ (tăng dần — chỉ đọc tệp có mtime / size đổi).
      if (rescanTimer) return;
      rescanTimer = setInterval(() => void build().catch(() => undefined), RESCAN_MS);
      rescanTimer.unref?.();
    };
    for (const root of resolvedRoots) {
      try {
        const w = fs.watch(root, { recursive: true }, (_event, name) => {
          if (!name) return;
          const rel = String(name);
          if (rel.split(/[\\/]/).some((seg) => skipDir(seg))) return;
          if (isProtectedPath(path.join(root, rel))) return;
          pending.add(path.join(root, rel));
          clearTimeout(timer);
          timer = setTimeout(() => void flush(), WATCH_DEBOUNCE_MS);
        });
        // Không có listener 'error' thì lỗi của bộ theo dõi (gốc bị xoá, rút ổ ngoài, hết inotify) ném ra ngoài và làm sập daemon.
        w.on('error', () => {
          try { w.close(); } catch { /* đã đóng */ }
          fallBackToRescan();
        });
        w.unref?.();
        watchers.push(w);
      } catch { fallBackToRescan(); /* không theo dõi được (hệ thống tệp mạng…) */ }
    }
  }

  /** Đoạn mô tả đưa đi tính vector: tên + thư mục gần nhất + chữ đầu tệp. */
  const embedText = (abs, entry) => `${path.basename(abs)} | ${path.dirname(abs).split(path.sep).slice(-3).join(' / ')}${entry.preview ? ` | ${entry.preview}` : ''}`;

  /** Tệp tài liệu cần (tính lại) vector: thư mục người dùng trước, mới sửa trước; giữ trong trần MAX_VECTOR_FILES. */
  function vectorQueue() {
    const docs = [...entries.entries()].filter(([abs, e]) => isDocFile(abs) && !e.secret)
      .sort(([a, ea], [b, eb]) => (Number(isPriority(b)) - Number(isPriority(a))) || (eb.mtime - ea.mtime))
      .slice(0, MAX_VECTOR_FILES);
    const keep = new Set(docs.map(([abs]) => abs));
    for (const abs of [...vectors.keys()]) if (!keep.has(abs)) vectors.delete(abs);
    return docs.filter(([abs, e]) => vectors.get(abs)?.key !== vectorKey(e));
  }

  /**
   * Tính vector nền theo lô (`embed(texts) → base64[]`, BE tính bằng bge-m3). BE cũ / lỗi → dừng, lần sau thử lại; tìm theo từ khoá vẫn
   * chạy bình thường.
   */
  async function vectorize() {
    if (!embedder || vectorizing || Date.now() < pausedUntil) return { embedded: 0, total: vectors.size };
    vectorizing = true;
    let embedded = 0;
    let failed = false;
    try {
      const queue = vectorQueue();
      for (let i = 0; i < queue.length; i += EMBED_BATCH) {
        const batch = queue.slice(i, i + EMBED_BATCH);
        const out = await embedder(batch.map(([abs, e]) => wellFormed(embedText(abs, e))));
        if (!Array.isArray(out) || out.length !== batch.length) { failed = true; break; }
        batch.forEach(([abs, e], j) => { if (out[j]) vectors.set(abs, { key: vectorKey(e), b64: out[j], vec: decodeInt8(out[j]) }); });
        embedded += batch.length;
        failures = 0;
        if (embedded % 512 === 0) scheduleSnapshot();
      }
    } catch { failed = true; } finally {
      vectorizing = false;
    }
    if (embedded) scheduleSnapshot();
    // BE bận / lỗi → nghỉ giãn dần (30 s → tối đa 30 phút) thay vì thử lại mỗi lần tệp đổi — không dồn tải lên dịch vụ vector dùng chung.
    if (failed) {
      failures++;
      const pauseMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
      pausedUntil = Date.now() + pauseMs;
      scheduleVectorize(pauseMs + 1_000);
    }
    return { embedded, total: vectors.size, failed: failed || undefined };
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
    watchers.splice(0).forEach((w) => w.close());
    clearTimeout(snapshotTimer);
    clearTimeout(vectorTimer);
    saveSnapshot();
  }

  /**
   * Tìm theo tên / đường dẫn / định danh / chữ đầu tài liệu; có `vector` (bge-m3 int8 base64 của câu hỏi) thì gộp thêm xếp hạng ngữ
   * nghĩa. Trả đường hiển thị tương đối với gốc + dung lượng, ngày sửa, đoạn xem trước.
   */
  function search(query, limit = 10, vector) {
    const lexical = index.search(query, { limit: Math.max(limit, RANK_DEPTH) }).map((r) => r.id);
    const q = vector ? decodeInt8(vector) : null;
    const semantic = q && vectors.size
      ? [...vectors.entries()].map(([abs, v]) => [abs, int8Cosine(q, v.vec)]).sort((a, b) => b[1] - a[1]).slice(0, RANK_DEPTH)
      : [];
    const similarity = new Map(semantic);
    const ranked = semantic.length ? fuse(lexical, semantic.map(([abs]) => abs), similarity) : lexical;
    return ranked.slice(0, limit).map((id) => {
      const root = resolvedRoots.find((r) => id.startsWith(r)) || resolvedRoots[0];
      const e = entries.get(id);
      return {
        path: path.relative(root, id) || id,
        size: e?.size,
        modified: e?.mtime ? new Date(e.mtime).toISOString().slice(0, 10) : undefined,
        ...(e?.preview ? { preview: e.preview.slice(0, 200) } : {}),
        ...(similarity.has(id) ? { similarity: Number(similarity.get(id).toFixed(3)) } : {}),
      };
    });
  }

  return {
    build, watch, close, search, refreshFile, vectorize, setEmbedder,
    stats: () => ({ files: entries.size, vectors: vectors.size, last_build: lastBuild }),
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
