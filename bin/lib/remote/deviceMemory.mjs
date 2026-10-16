import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import YAML from 'yaml';
import { MemoryKind, REMOTE_CONFIG_DIR } from './constants.mjs';
import { createTextIndex, decodeInt8, fuseRankings, int8Cosine } from './textIndex.mjs';

/**
 * Bộ nhớ dài hạn NẰM TRÊN MÁY. Nguồn sự thật là các tệp YAML người dùng đọc / sửa tay được (`~/.aivin/memory/<loại>.yaml`), vector
 * (do BE tính bằng bge-m3, int8 base64) để ở tệp riêng `vectors.json` khoá theo băm nội dung — sửa nội dung một mục thì vector cũ tự
 * bỏ, mục đó vẫn tìm được bằng từ khoá. Daemon nạp hết vào RAM: tìm kết hợp BM25 + cosine, truy cập ngẫu nhiên theo id / loại+khoá /
 * con trỏ phân trang.
 *
 * Ghi: một tiến trình ghi (daemon), ghi tệp tạm rồi đổi tên (mất điện giữa chừng không hỏng tệp). Người dùng sửa tay → theo dõi thư
 * mục, nạp lại.
 */

export const DEVICE_MEMORY_DIR = path.join(REMOTE_CONFIG_DIR, 'memory');
const VECTORS_FILE = path.join(DEVICE_MEMORY_DIR, 'vectors.json');
const KINDS = Object.values(MemoryKind);
const MAX_TEXT = 4000;
const MAX_KEY = 160;
const RELOAD_DEBOUNCE_MS = 300;

const state = {
  loaded: false,
  items: new Map(), // id → item
  byKind: new Map(), // kind → Map<key, id>
  vectors: {}, // contentHash → base64
  index: createTextIndex(),
  watcher: null,
  ownWriteAt: 0,
};

export function memoryItemId(kind, key) {
  return createHash('sha1').update(`${kind}\n${key}`).digest('hex').slice(0, 12);
}

function contentHash(item) {
  return createHash('sha1').update(`${item.kind}\n${item.key}\n${item.text}`).digest('hex').slice(0, 20);
}

function kindFile(kind) {
  return path.join(DEVICE_MEMORY_DIR, `${kind}.yaml`);
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  state.ownWriteAt = Date.now();
}

function normalizeItem(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key || '').trim().slice(0, MAX_KEY);
  const text = String(raw.text || '').trim().slice(0, MAX_TEXT);
  if (!key || !text) return null;
  return {
    id: memoryItemId(kind, key),
    kind,
    key,
    text,
    ...(raw.data !== undefined ? { data: raw.data } : {}),
    created_at: raw.created_at || new Date().toISOString(),
    updated_at: raw.updated_at || raw.created_at || new Date().toISOString(),
  };
}

function indexItem(item) {
  state.items.set(item.id, item);
  if (!state.byKind.has(item.kind)) state.byKind.set(item.kind, new Map());
  state.byKind.get(item.kind).set(item.key, item.id);
  state.index.add(item.id, `${item.key} ${item.text}`);
}

function unindexItem(id) {
  const item = state.items.get(id);
  if (!item) return;
  state.items.delete(id);
  state.byKind.get(item.kind)?.delete(item.key);
  state.index.remove(id);
}

function readKindFile(kind) {
  try {
    const parsed = YAML.parse(fs.readFileSync(kindFile(kind), 'utf8'));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    return list.map((raw) => normalizeItem(raw, kind)).filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[remote] Không đọc được ${kindFile(kind)}: ${error.message}`);
    return [];
  }
}

function reloadAll() {
  state.items.clear();
  state.byKind.clear();
  state.index.clear();
  for (const kind of KINDS) readKindFile(kind).forEach(indexItem);
  try { state.vectors = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8')) || {}; } catch { state.vectors = {}; }
  state.loaded = true;
}

export function ensureMemoryLoaded() {
  if (!state.loaded) reloadAll();
}

/** Theo dõi người dùng sửa tay tệp YAML → nạp lại (bỏ qua sự kiện do chính mình ghi). */
export function watchMemoryDir() {
  if (state.watcher) return;
  fs.mkdirSync(DEVICE_MEMORY_DIR, { recursive: true });
  let timer;
  try {
    state.watcher = fs.watch(DEVICE_MEMORY_DIR, () => {
      if (Date.now() - state.ownWriteAt < 1000) return;
      clearTimeout(timer);
      timer = setTimeout(reloadAll, RELOAD_DEBOUNCE_MS);
    });
    state.watcher.unref?.();
  } catch { /* hệ thống tệp không hỗ trợ theo dõi — sửa tay có hiệu lực ở lần khởi động sau */ }
}

export function stopWatchingMemory() {
  state.watcher?.close();
  state.watcher = null;
}

function persistKind(kind) {
  const ids = [...(state.byKind.get(kind)?.values() || [])];
  const list = ids.map((id) => {
    const { id: _id, kind: _kind, ...rest } = state.items.get(id);
    return rest;
  });
  atomicWrite(kindFile(kind), list.length ? YAML.stringify(list, { lineWidth: 0 }) : '[]\n');
}

function persistVectors() {
  const live = new Set([...state.items.values()].map(contentHash));
  for (const hash of Object.keys(state.vectors)) if (!live.has(hash)) delete state.vectors[hash];
  atomicWrite(VECTORS_FILE, JSON.stringify(state.vectors));
}

function publicItem(item, score) {
  return { id: item.id, kind: item.kind, key: item.key, text: item.text, ...(item.data !== undefined ? { data: item.data } : {}), updated_at: item.updated_at, ...(score !== undefined ? { score } : {}) };
}

/** Thêm / cập nhật theo (loại, khoá). `vector`: int8 base64 BE gửi kèm. */
export function putMemoryItems(items = []) {
  ensureMemoryLoaded();
  const touched = new Set();
  let vectorsChanged = false;
  let saved = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const kind = KINDS.includes(raw?.kind) ? raw.kind : MemoryKind.FACT;
    const existing = state.items.get(memoryItemId(kind, String(raw?.key || '').trim().slice(0, MAX_KEY)));
    const item = normalizeItem({ ...raw, created_at: existing?.created_at, updated_at: new Date().toISOString() }, kind);
    if (!item) continue;
    indexItem(item);
    if (raw.vector) { state.vectors[contentHash(item)] = String(raw.vector); vectorsChanged = true; }
    touched.add(kind);
    saved++;
  }
  touched.forEach(persistKind);
  if (vectorsChanged || touched.size) persistVectors();
  return { saved };
}

export function getMemoryItem({ id, kind, key } = {}) {
  ensureMemoryLoaded();
  const itemId = id || (kind && key ? memoryItemId(kind, key) : null);
  const item = itemId ? state.items.get(itemId) : null;
  return item ? publicItem(item) : null;
}

/** Phân trang theo con trỏ (vị trí), mới cập nhật trước. */
export function listMemoryItems({ kind, cursor = 0, limit = 50 } = {}) {
  ensureMemoryLoaded();
  const all = [...state.items.values()]
    .filter((i) => !kind || i.kind === kind)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const start = Math.max(0, Number(cursor) || 0);
  const size = Math.min(Math.max(1, Number(limit) || 50), 200);
  const page = all.slice(start, start + size).map((i) => publicItem(i));
  return { total: all.length, items: page, next_cursor: start + size < all.length ? start + size : null };
}

export function deleteMemoryItems({ ids = [], kind, key } = {}) {
  ensureMemoryLoaded();
  const targets = [...ids];
  if (kind && key) targets.push(memoryItemId(kind, key));
  const touched = new Set();
  let deleted = 0;
  for (const id of new Set(targets)) {
    const item = state.items.get(id);
    if (!item) continue;
    touched.add(item.kind);
    unindexItem(id);
    deleted++;
  }
  touched.forEach(persistKind);
  if (touched.size) persistVectors();
  return { deleted };
}

export function clearDeviceMemory(kind) {
  ensureMemoryLoaded();
  const kinds = kind ? [kind] : KINDS;
  for (const k of kinds) {
    for (const id of [...(state.byKind.get(k)?.values() || [])]) unindexItem(id);
    persistKind(k);
  }
  persistVectors();
}

/**
 * Tìm kết hợp: BM25 (từ khoá) và cosine (vector đề bài do BE gửi) gộp bằng RRF. `score` trả về là cosine (0 khi mục chưa có vector) —
 * BE dùng nó làm ngưỡng "đủ giống để chạy lại quy trình".
 */
export function searchMemory({ query = '', vector, kinds, limit = 8 } = {}) {
  ensureMemoryLoaded();
  const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  const allowed = (id) => !kindSet || kindSet.has(state.items.get(id)?.kind);
  const wide = Math.max(limit * 3, 20);
  const lexical = query ? state.index.search(query, { limit: wide, filter: allowed }).map((h) => h.id) : [];
  const q = decodeInt8(vector);
  const cosine = new Map();
  if (q) {
    for (const item of state.items.values()) {
      if (!allowed(item.id)) continue;
      const v = decodeInt8(state.vectors[contentHash(item)]);
      if (v) cosine.set(item.id, int8Cosine(q, v));
    }
  }
  const semantic = [...cosine.entries()].sort((a, b) => b[1] - a[1]).slice(0, wide).map(([id]) => id);
  return fuseRankings([lexical, semantic]).slice(0, limit).map((id) => publicItem(state.items.get(id), Number((cosine.get(id) || 0).toFixed(4))));
}

export function memoryStats() {
  ensureMemoryLoaded();
  const byKind = {};
  for (const item of state.items.values()) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  const withVector = [...state.items.values()].filter((i) => state.vectors[contentHash(i)]).length;
  return { total: state.items.size, by_kind: byKind, with_vector: withVector, dir: DEVICE_MEMORY_DIR };
}
