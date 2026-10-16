/**
 * Chỉ mục tìm kiếm trong RAM, dùng chung cho bộ nhớ trên máy và chỉ mục tệp: tách từ theo Unicode (mọi ngôn ngữ, bỏ dấu, tách
 * camelCase/snake_case, chữ Hán/Kana/Hangul tách cặp ký tự), chấm điểm BM25; cosine cho vector int8 do BE tính (bge-m3).
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MIN_TOKEN = 2;
const MAX_TOKEN = 48;
const K1 = 1.2;
const B = 0.75;
const PREFIX_MIN = 4;
const PREFIX_MAX_TERMS = 30;

export function normalizeText(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/** Tách từ: chữ/số Unicode; cụm CJK (không có dấu cách) → các cặp ký tự liền nhau. */
export function tokenize(text) {
  const out = [];
  for (const raw of normalizeText(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      const chars = [...raw];
      if (chars.length === 1) out.push(raw);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      continue;
    }
    if (raw.length >= MIN_TOKEN && raw.length <= MAX_TOKEN) out.push(raw);
  }
  return out;
}

/** Chỉ mục BM25 thêm/xoá từng tài liệu, không dựng lại cả khối. */
export function createTextIndex() {
  const docs = new Map(); // id → { len, tf: Map<term, n> }
  const postings = new Map(); // term → Set<id>
  let totalLen = 0;

  function remove(id) {
    const doc = docs.get(id);
    if (!doc) return;
    for (const term of doc.tf.keys()) {
      const set = postings.get(term);
      set?.delete(id);
      if (set && !set.size) postings.delete(term);
    }
    totalLen -= doc.len;
    docs.delete(id);
  }

  function add(id, text) {
    remove(id);
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docs.set(id, { len: tokens.length, tf });
    totalLen += tokens.length;
    for (const term of tf.keys()) {
      if (!postings.has(term)) postings.set(term, new Set());
      postings.get(term).add(id);
    }
  }

  /** Từ trong câu hỏi không có nguyên dạng → khớp tiền tố ("auth" ↔ "authentication"), có trần để không quét cả từ điển mỗi lần. */
  function expand(term) {
    if (postings.has(term) || term.length < PREFIX_MIN) return postings.has(term) ? [term] : [];
    const found = [];
    for (const key of postings.keys()) {
      if (key.startsWith(term)) {
        found.push(key);
        if (found.length >= PREFIX_MAX_TERMS) break;
      }
    }
    return found;
  }

  function search(query, { limit = 10, filter } = {}) {
    const n = docs.size;
    if (!n) return [];
    const avg = totalLen / n || 1;
    const scores = new Map();
    for (const qTerm of new Set(tokenize(query))) {
      for (const term of expand(qTerm)) {
        const ids = postings.get(term);
        if (!ids) continue;
        const idf = Math.log(1 + (n - ids.size + 0.5) / (ids.size + 0.5));
        const weight = term === qTerm ? 1 : 0.6;
        for (const id of ids) {
          if (filter && !filter(id)) continue;
          const doc = docs.get(id);
          const f = doc.tf.get(term);
          const s = idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avg))) * weight;
          scores.set(id, (scores.get(id) || 0) + s);
        }
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, score]) => ({ id, score }));
  }

  return { add, remove, search, size: () => docs.size, clear: () => { docs.clear(); postings.clear(); totalLen = 0; } };
}

export function decodeInt8(base64) {
  if (!base64) return null;
  const buf = Buffer.from(String(base64), 'base64');
  return buf.length ? new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
}

/** Cosine xấp xỉ giữa hai vector int8 đã chuẩn hoá (BE lượng tử `round(v/|v| * 127)`). */
export function int8Cosine(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot / (127 * 127);
}

/** Gộp nhiều bảng xếp hạng (Reciprocal Rank Fusion) — không cần đưa BM25 và cosine về cùng thang điểm. */
export function fuseRankings(rankings, k = 60) {
  const fused = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => fused.set(id, (fused.get(id) || 0) + 1 / (k + rank + 1)));
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
