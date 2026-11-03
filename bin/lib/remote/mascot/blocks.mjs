import { chartLayout } from './chartLayout.mjs';
import { lucidePath } from './lucideIcons.mjs';
import { safeWebUrl } from './safeUrl.mjs';
import { MascotText } from './strings.mjs';

/**
 * Rich component của câu trả lời (`blocks` trong `device:chat_event` / `device:notify`) → lệnh cho cửa sổ linh vật (03/11/2026). BE đã giới hạn cỡ; ở đây chặn thêm vì
 * cửa sổ dựng từng phần tử bằng PowerShell, gắn chữ đã dịch, tính độ rộng cột + hình biểu đồ, và gắn tệp ảnh sau khi daemon tải / dựng xong (images.mjs, diagramRender.mjs).
 */
export const BlockType = Object.freeze({ TABLE: 'table', CARDS: 'cards', IMAGE: 'image', CHART: 'chart', DIAGRAM: 'diagram', WEBVIEW: 'webview', SCREENCAST: 'screencast', LINK_CARD: 'link_card', SOURCES: 'sources' });
const MAX_BLOCKS = 12;
const MAX_ROWS = 20;
const MAX_COLS = 8;
const MAX_CARDS = 12;
const MAX_TEXT = 300;
const MAX_DIAGRAM_CHARS = 20000;
const MAX_SOURCES = 8;
/** Bề rộng bảng trong ô đã nới rộng, ước lượng một ký tự chữ cỡ 12 (kể cả đậm) + lề hai bên một ô (askBlocksSource.mjs). */
const TABLE_WIDTH = 286;
const CHAR_WIDTH = 6.9;
const CELL_PADDING = 16;
/** Từ dài hơn thì chấp nhận xuống dòng giữa từ; chữ dài hơn không đòi thêm chỗ. */
const MIN_WORD_CHARS = 3;
const MAX_WORD_CHARS = 14;
const MAX_LINE_CHARS = 40;
/** Tên icon lạ: cùng icon dự phòng với thẻ trên web. */
const DEFAULT_CARD_ICON = 'sparkles';
const LINK_CARD_ICONS = Object.freeze({ video: 'play', file: 'file-text', link: 'external-link' });
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ALIGNS = new Set(['left', 'center', 'right']);
/** Khoá tệp của sơ đồ trong bảng `files` của `withImageFiles` (URL ảnh là khoá của ảnh). */
const DIAGRAM_KEY = 'diagram:';

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : typeof v === 'number' ? String(v) : '');

function normalizeCell(c) {
  if (c?.covered === true) return { text: '', covered: true };
  const span = Number.isInteger(c?.span) && c.span > 1 ? { span: Math.min(c.span, MAX_COLS) } : {};
  const rowspan = Number.isInteger(c?.rowspan) && c.rowspan > 1 ? { rowspan: Math.min(c.rowspan, MAX_ROWS) } : {};
  return {
    text: str(c?.text), ...span, ...rowspan, ...(c?.bold === true ? { bold: true } : {}), ...(c?.italic === true ? { italic: true } : {}), ...(ALIGNS.has(c?.align) ? { align: c.align } : {}),
    ...(HEX_COLOR.test(c?.bg) ? { bg: c.bg } : {}), ...(HEX_COLOR.test(c?.color) ? { color: c.color } : {}),
  };
}

/**
 * Độ rộng từng cột (px trên bề rộng `TABLE_WIDTH`, cửa sổ dùng làm tỉ lệ). Trước hết cột nào cũng đủ chỗ cho từ dài nhất của nó để không bẻ giữa từ / giữa số
 * ("12.50 / 0.000"), chỗ còn lại chia theo độ dài chữ. Hết chỗ thì mới chia theo tỉ lệ phần tối thiểu. Hàng gộp ô không tính.
 */
export function columnWeights(rows, cols) {
  const plain = rows.filter((r) => !r.some((c) => c.span));
  const measure = (col, read) => Math.max(0, ...plain.map((r) => read(r[col]?.text || '')));
  const least = Array.from({ length: cols }, (_, col) => CELL_PADDING + CHAR_WIDTH * Math.max(MIN_WORD_CHARS, Math.min(MAX_WORD_CHARS, measure(col, (s) => Math.max(0, ...s.split(/[\s-]+/).map((w) => w.length))))));
  const want = Array.from({ length: cols }, (_, col) => CELL_PADDING + CHAR_WIDTH * Math.min(MAX_LINE_CHARS, measure(col, (s) => s.length)));
  const spare = TABLE_WIDTH - least.reduce((a, b) => a + b, 0);
  if (spare <= 0) return least.map(Math.round);
  const extra = want.map((w, i) => Math.max(0, w - least[i]));
  const totalExtra = extra.reduce((a, b) => a + b, 0);
  // Mọi cột đã đủ chỗ cho cả dòng: chia đều phần thừa.
  return least.map((w, i) => Math.round(w + (totalExtra ? (spare * extra[i]) / totalExtra : spare / cols)));
}

function tableBlock(b, { t }) {
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ROWS).filter(Array.isArray).map((r) => r.slice(0, MAX_COLS).map(normalizeCell));
  if (!rows.length) return null;
  const cols = Math.min(MAX_COLS, Math.max(...rows.map((r) => r.reduce((n, c) => n + (c.span || 1), 0))));
  const notes = [
    b.more_rows > 0 ? t(MascotText.ASK_MORE_ROWS, { n: b.more_rows }) : '',
    b.more_cols > 0 ? t(MascotText.ASK_MORE_COLS, { n: b.more_cols }) : '',
  ].filter(Boolean);
  return {
    type: BlockType.TABLE, ...(str(b.title) ? { title: str(b.title) } : {}), header: b.header !== false, ...(b.plain === true ? { plain: true } : {}), cols, weights: columnWeights(rows, cols), rows,
    ...(notes.length ? { note: notes.join(', ') } : {}),
  };
}

function cardsBlock(b, { t }) {
  const cards = (Array.isArray(b.cards) ? b.cards : []).slice(0, MAX_CARDS).filter((c) => str(c?.title)).map((c) => {
    const image = safeWebUrl(c.image);
    const tags = Array.isArray(c.tags) ? c.tags.map(str).filter(Boolean).slice(0, 4) : [];
    return {
      title: str(c.title), ...(str(c.text) ? { text: str(c.text) } : {}), ...(tags.length ? { tags } : {}), ...(str(c.footer) ? { footer: str(c.footer) } : {}),
      icon_path: lucidePath(c.icon) || lucidePath(DEFAULT_CARD_ICON), ...(image ? { image } : {}),
    };
  });
  if (!cards.length) return null;
  return {
    type: BlockType.CARDS, ...(str(b.title) ? { title: str(b.title) } : {}), cards,
    ...(b.more > 0 ? { note: t(MascotText.ASK_MORE_CARDS, { n: b.more }) } : {}),
  };
}

function imageBlock(b, { t }) {
  const url = safeWebUrl(b.url);
  if (!url) return null;
  return { type: BlockType.IMAGE, url, ...(str(b.caption) ? { caption: str(b.caption) } : {}), open_text: str(b.caption) || t(MascotText.ASK_OPEN_IMAGE) };
}

function chartBlock(b, { t, lang }) {
  const layout = chartLayout({ kind: b.kind, labels: (Array.isArray(b.labels) ? b.labels : []).map(str), series: Array.isArray(b.series) ? b.series.filter((s) => Array.isArray(s?.data)) : [] }, lang);
  if (!layout) return null;
  return {
    type: BlockType.CHART, ...(str(b.title) ? { title: str(b.title) } : {}), layout,
    ...(b.more > 0 ? { note: t(MascotText.ASK_MORE_POINTS, { n: b.more }) } : {}),
  };
}

/** Sơ đồ: dựng xong thành ảnh, bấm mở phiên trên web để xem lớn (sơ đồ lớn thu vào ô hỏi sẽ khó đọc). Dựng hỏng → nút mở web. */
function diagramBlock(b, { t, webUrl }) {
  if (typeof b.source !== 'string' || !b.source.trim() || b.source.length > MAX_DIAGRAM_CHARS) return null;
  return { type: BlockType.DIAGRAM, source: b.source, ...(webUrl ? { url: webUrl } : {}), open_text: t(MascotText.ASK_OPEN_DIAGRAM) };
}

function webviewBlock(b, { t, sessionId }) {
  if (typeof b.message_id !== 'string' || !b.message_id || !sessionId) return null;
  return {
    type: BlockType.WEBVIEW, session_id: sessionId, message_id: b.message_id, index: Number.isInteger(b.index) ? b.index : 0,
    title: str(b.title) || t(MascotText.ASK_WEBVIEW_TITLE), action: t(MascotText.ASK_WEBVIEW_OPEN), icon_path: lucidePath('app-window'),
  };
}

function screencastBlock(b, { t, webUrl }) {
  if (!webUrl) return null;
  const site = safeWebUrl(b.url);
  return {
    type: BlockType.LINK_CARD, title: str(b.title) || t(MascotText.ASK_SCREENCAST_TITLE), text: site ? new URL(site).hostname : t(MascotText.ASK_SCREENCAST_HINT),
    url: webUrl, action: t(MascotText.ASK_OPEN_WEB), icon_path: lucidePath('globe'),
  };
}

function linkCardBlock(b) {
  const url = safeWebUrl(b.url);
  if (!url || !str(b.title)) return null;
  return {
    type: BlockType.LINK_CARD, title: str(b.title), ...(str(b.text) ? { text: str(b.text) } : {}), url, ...(str(b.label) ? { action: str(b.label) } : {}),
    icon_path: lucidePath(b.icon) || lucidePath(LINK_CARD_ICONS[b.kind] || LINK_CARD_ICONS.link),
  };
}

function sourcesBlock(b, { t }) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_SOURCES).filter((i) => str(i?.name)).map((i) => {
    const url = safeWebUrl(i.url);
    return { name: str(i.name), ...(url ? { url } : {}) };
  });
  return items.length ? { type: BlockType.SOURCES, label: t(MascotText.ASK_SOURCES), items } : null;
}

const BUILDERS = Object.freeze({
  [BlockType.TABLE]: tableBlock, [BlockType.CARDS]: cardsBlock, [BlockType.IMAGE]: imageBlock, [BlockType.CHART]: chartBlock, [BlockType.DIAGRAM]: diagramBlock,
  [BlockType.WEBVIEW]: webviewBlock, [BlockType.SCREENCAST]: screencastBlock, [BlockType.LINK_CARD]: linkCardBlock, [BlockType.SOURCES]: sourcesBlock,
});

/** Khối BE gửi → khối gửi cửa sổ; loại lạ / rỗng bị bỏ. Không còn gì → null. `ctx`: `{ t, lang, webUrl (phiên trên web), sessionId }`. */
export function normalizeBlocks(raw, ctx) {
  if (!Array.isArray(raw)) return null;
  const out = raw.slice(0, MAX_BLOCKS).map((b) => {
    const build = typeof b?.type === 'string' && Object.prototype.hasOwnProperty.call(BUILDERS, b.type) ? BUILDERS[b.type] : null;
    return build ? build(b, ctx) : null;
  }).filter(Boolean);
  return out.length ? out : null;
}

/** Mọi tài nguyên cần tải / dựng trong các khối (URL ảnh, thẻ, `diagram:<mã>`), không trùng. */
export function imageUrlsOf(blocks) {
  const urls = new Set();
  for (const b of blocks || []) {
    if (b.type === BlockType.IMAGE) urls.add(b.url);
    if (b.type === BlockType.DIAGRAM) urls.add(`${DIAGRAM_KEY}${b.source}`);
    if (b.type === BlockType.CARDS) for (const c of b.cards) if (c.image) urls.add(c.image);
  }
  return [...urls];
}

/** Khoá `imageUrlsOf` → mã sơ đồ, không phải sơ đồ → null. */
export function diagramSourceOf(key) {
  return String(key).startsWith(DIAGRAM_KEY) ? String(key).slice(DIAGRAM_KEY.length) : null;
}

/**
 * Gắn tệp đã tải (`files`: khoá → đường dẫn | null) vào các khối, bỏ cờ chờ. Khối ảnh / sơ đồ hỏng giữ lại không có `file`: cửa sổ vẽ thành nút mở link. Thẻ tải ảnh
 * hỏng về icon. Sơ đồ đã xong thì bỏ mã nguồn, cửa sổ không cần.
 */
export function withImageFiles(blocks, files) {
  return blocks.map((b) => {
    if (b.type === BlockType.IMAGE) return { ...b, done: true, ...(files.get(b.url) ? { file: files.get(b.url) } : {}) };
    if (b.type === BlockType.DIAGRAM) {
      const { source, ...rest } = b;
      const file = files.get(`${DIAGRAM_KEY}${source}`);
      return { ...rest, done: true, ...(file ? { file } : {}) };
    }
    if (b.type !== BlockType.CARDS) return b;
    return {
      ...b,
      cards: b.cards.map((c) => {
        if (!c.image) return c;
        const { image, ...rest } = c;
        return files.get(image) ? { ...rest, file: files.get(image) } : rest;
      }),
    };
  });
}
