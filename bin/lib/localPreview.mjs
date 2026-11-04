import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { AIVIN_LOGO_PNG_BASE64 } from './remote/brand.mjs';
import { mascotLang } from './remote/mascot/strings.mjs';
import { PREVIEW_CACHE_DIR, contentKey, readCachedPdf, writeCachedPdf } from './previewCache.mjs';

/**
 * Xem tệp khi CHƯA đăng nhập (04/11/2026): `aivin open` dựng một trang chỉ-xem trên 127.0.0.1, không tải tệp lên Drive.
 * .pdf / .md / .txt / .csv hiển thị tại máy. Tệp Office cần đổi sang PDF nên đi qua `POST /fileshare/anonymous-preview` (không lưu ở máy chủ),
 * chỉ sau khi người dùng đồng ý. Nút đăng nhập tải tệp lên Drive rồi chuyển cửa sổ sang trình soạn.
 * Trang đóng thì tiến trình tự thoát (không còn nhịp ping).
 */

export const PreviewKind = Object.freeze({ PDF: 'pdf', MARKDOWN: 'markdown', TEXT: 'text', CSV: 'csv', OFFICE: 'office', UNSUPPORTED: 'unsupported' });

const KIND_BY_EXTENSION = Object.freeze({
  pdf: PreviewKind.PDF,
  md: PreviewKind.MARKDOWN,
  markdown: PreviewKind.MARKDOWN,
  txt: PreviewKind.TEXT,
  csv: PreviewKind.CSV,
  docx: PreviewKind.OFFICE, doc: PreviewKind.OFFICE, odt: PreviewKind.OFFICE, rtf: PreviewKind.OFFICE,
  xlsx: PreviewKind.OFFICE, xls: PreviewKind.OFFICE, xlsm: PreviewKind.OFFICE, ods: PreviewKind.OFFICE,
  pptx: PreviewKind.OFFICE, ppt: PreviewKind.OFFICE, odp: PreviewKind.OFFICE,
});

const SETTINGS_FILE = path.join(os.homedir(), '.aivin', 'open-settings.json');
const MAX_INLINE_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_CSV_ROWS = 5000;
const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const SHUTDOWN_AFTER_LOGIN_MS = 5_000;
const CONVERT_TIMEOUT_MS = 3 * 60_000;
const BUSY_RETRIES = 5;
const BUSY_RETRY_MS = 3_000;
const BUSY_CODE = 'FILESHARE.ANON_PREVIEW_BUSY';

const TEXT = Object.freeze({
  vi: {
    view_only: 'Chỉ xem',
    login: 'Đăng nhập để sửa và dùng AI',
    logging_in: 'Đang chờ đăng nhập trên trình duyệt…',
    login_failed: 'Chưa đăng nhập được. Vui lòng thử lại.',
    login_note: 'Sau khi đăng nhập, tệp được tải lên Drive của bạn để sửa.',
    consent_title: 'Xem tệp này cần gửi lên máy chủ Aivin',
    consent_body: 'Để hiển thị tệp Office, tệp được gửi tới máy chủ Aivin để đổi sang PDF. Máy chủ không lưu tệp và xoá ngay sau khi đổi xong.',
    consent_remember: 'Không hỏi lại trên máy này',
    consent_accept: 'Gửi và xem',
    converting: 'Đang chuẩn bị tệp để xem…',
    convert_failed: 'Không xem được tệp này.',
    unsupported: 'Loại tệp này chưa xem được khi chưa đăng nhập. Hãy đăng nhập để mở tệp.',
    truncated: 'Tệp quá dài, chỉ hiện phần đầu. Đăng nhập để xem toàn bộ.',
    disconnected: 'Trang xem đã ngắt. Hãy mở lại tệp.',
  },
  en: {
    view_only: 'View only',
    login: 'Sign in to edit and use AI',
    logging_in: 'Waiting for sign-in in your browser…',
    login_failed: 'Sign-in did not complete. Please try again.',
    login_note: 'After you sign in, the file is uploaded to your Drive for editing.',
    consent_title: 'Viewing this file means sending it to the Aivin server',
    consent_body: 'To display an Office file, it is sent to the Aivin server and converted to PDF. The server does not keep the file and discards it right after converting.',
    consent_remember: "Don't ask again on this computer",
    consent_accept: 'Send and view',
    converting: 'Preparing your file…',
    convert_failed: 'This file could not be displayed.',
    unsupported: 'This file type cannot be viewed without signing in. Sign in to open it.',
    truncated: 'This file is long, so only the beginning is shown. Sign in to see all of it.',
    disconnected: 'The viewer has disconnected. Please open the file again.',
  },
});

const textFor = (lang) => TEXT[lang] || TEXT.en;

export function previewKind(fileName) {
  const extension = path.extname(String(fileName || '')).slice(1).toLowerCase();
  return KIND_BY_EXTENSION[extension] || PreviewKind.UNSUPPORTED;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Dựng nội dung chữ. Mọi thứ escape TRƯỚC, sau đó mới thêm thẻ: nội dung tệp không bao giờ thành HTML / script. ---------------------------

function renderInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

const isTableDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => renderInline(escapeHtml(cell.trim())));

function renderTable(lines, start) {
  const head = tableCells(lines[start]);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes('|')) rows.push(tableCells(lines[i++]));
  const cells = (row, tag) => `<tr>${row.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  return { html: `<table>${cells(head, 'th')}${rows.map((r) => cells(r, 'td')).join('')}</table>`, next: i };
}

function renderList(lines, start, pattern, tag) {
  const items = [];
  let i = start;
  while (i < lines.length && pattern.test(lines[i])) items.push(`<li>${renderInline(escapeHtml(lines[i++].replace(pattern, '')))}</li>`);
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

function renderFence(lines, start) {
  let i = start + 1;
  const code = [];
  while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
  return { html: `<pre>${escapeHtml(code.join('\n'))}</pre>`, next: i + 1 };
}

const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;

/** Markdown thường gặp: tiêu đề, danh sách, bảng, khối mã, trích dẫn, đậm / nghiêng, liên kết http(s). */
export function renderMarkdown(source) {
  const lines = String(source).split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    let block = null;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) block = renderFence(lines, i);
    else if (heading) block = { html: `<h${heading[1].length}>${renderInline(escapeHtml(heading[2]))}</h${heading[1].length}>`, next: i + 1 };
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) block = { html: '<hr>', next: i + 1 };
    else if (line.includes('|') && isTableDivider(lines[i + 1] || '')) block = renderTable(lines, i);
    else if (BULLET.test(line)) block = renderList(lines, i, BULLET, 'ul');
    else if (ORDERED.test(line)) block = renderList(lines, i, ORDERED, 'ol');
    else if (line.startsWith('>')) block = { html: `<blockquote>${renderInline(escapeHtml(line.replace(/^>\s?/, '')))}</blockquote>`, next: i + 1 };
    else block = { html: `<p>${renderInline(escapeHtml(line))}</p>`, next: i + 1 };
    out.push(block.html);
    i = block.next;
  }
  return out.join('\n');
}

function detectCsvDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  return [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
}

/** CSV theo RFC 4180: ô trong ngoặc kép có thể chứa dấu phân cách, xuống dòng, "" là một dấu ngoặc kép. */
export function parseCsv(text, { maxRows = MAX_CSV_ROWS } = {}) {
  const delimiter = detectCsvDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

function renderCsv(text) {
  const rows = parseCsv(text);
  const body = rows.map((row, i) => {
    const tag = i === 0 ? 'th' : 'td';
    return `<tr>${row.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
  }).join('');
  return { html: `<table>${body}</table>`, truncated: rows.length >= MAX_CSV_ROWS };
}

/** Nội dung chữ dựng sẵn cho trang (null với PDF / Office: hiện trong khung). */
export function renderInlineContent(kind, buffer) {
  if (![PreviewKind.MARKDOWN, PreviewKind.TEXT, PreviewKind.CSV].includes(kind)) return null;
  const sliced = buffer.length > MAX_INLINE_TEXT_BYTES;
  const text = buffer.subarray(0, MAX_INLINE_TEXT_BYTES).toString('utf8').replace(/^﻿/, '');
  if (kind === PreviewKind.MARKDOWN) return { html: `<article>${renderMarkdown(text)}</article>`, truncated: sliced };
  if (kind === PreviewKind.TEXT) return { html: `<pre class="plain">${escapeHtml(text)}</pre>`, truncated: sliced };
  const csv = renderCsv(text);
  return { html: csv.html, truncated: sliced || csv.truncated };
}

// --- Trang ------------------------------------------------------------------------------------------------------------------------------

const PAGE_CSS = `
:root { --bg:#f2f3f5; --card:#fff; --text:#1d2129; --muted:#4e5969; --line:#e5e6eb; --primary:#165dff; --primary-text:#fff; --warn:#cb2634; }
* { box-sizing:border-box; }
html, body { height:100%; margin:0; }
body { display:flex; flex-direction:column; background:var(--bg); color:var(--text); font:14px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
header { display:flex; align-items:center; gap:10px; padding:8px 16px; background:var(--card); border-bottom:1px solid var(--line); flex-wrap:wrap; }
header img { width:24px; height:24px; border-radius:6px; }
.name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:0 1 auto; }
.badge { font-size:13px; color:var(--muted); background:var(--bg); border-radius:6px; padding:1px 8px; white-space:nowrap; }
.spacer { flex:1; }
button { font:inherit; border-radius:8px; padding:5px 14px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; transition:background .15s, opacity .15s; }
button.primary { background:var(--primary); border-color:var(--primary); color:var(--primary-text); }
button:disabled { opacity:.6; cursor:default; }
main { flex:1; min-height:0; overflow:auto; }
iframe { width:100%; height:100%; border:0; display:block; }
.doc { max-width:960px; margin:16px auto; padding:24px 32px; background:var(--card); border-radius:12px; overflow:auto; }
.wide { max-width:none; margin:16px; }
.plain { white-space:pre-wrap; word-break:break-word; margin:0; font:13px/1.6 ui-monospace,Consolas,monospace; }
pre { background:var(--bg); padding:12px; border-radius:8px; overflow:auto; }
code { background:var(--bg); padding:0 4px; border-radius:4px; }
table { border-collapse:collapse; font-size:13px; }
th, td { border:1px solid var(--line); padding:4px 10px; text-align:left; vertical-align:top; }
th { background:var(--bg); }
blockquote { margin:8px 0; padding-left:12px; border-left:3px solid var(--line); color:var(--muted); }
.card { max-width:480px; margin:48px auto; padding:24px; background:var(--card); border-radius:12px; }
.card h2 { margin:0 0 8px; font-size:16px; }
.card p { margin:0 0 16px; color:var(--muted); }
.card label { display:flex; gap:8px; align-items:center; margin-bottom:16px; }
.actions { display:flex; justify-content:flex-end; }
.notice { padding:6px 16px; background:#fff7e8; font-size:13px; }
.error { color:var(--warn); }
[hidden] { display:none !important; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#17171a; --card:#232324; --text:#e5e6eb; --muted:#a9aeb8; --line:#3a3a3d; --primary:#3c7eff; }
  .notice { background:#3a2f16; }
}
`;

const PAGE_SCRIPT = `
const cfg = JSON.parse(document.getElementById('cfg').textContent);
const $ = (id) => document.getElementById(id);
const post = (name, body) => fetch(cfg.base + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const show = (id) => { for (const s of ['consent', 'status', 'frame']) { const el = $(s); if (el) el.hidden = s !== id; } };
function showStatus(message, isError) { const el = $('status'); el.textContent = message; el.className = isError ? 'card error' : 'card'; show('status'); }
function showFile() { const f = $('frame'); f.src = cfg.base + 'file'; show('frame'); }
async function convert(remember) {
  showStatus(cfg.t.converting);
  try {
    const res = await post('convert', { remember });
    const data = await res.json();
    if (data.ok) showFile(); else showStatus(data.message || cfg.t.convert_failed, true);
  } catch { showStatus(cfg.t.disconnected, true); }
}
$('login').addEventListener('click', async () => {
  const btn = $('login');
  btn.disabled = true;
  btn.textContent = cfg.t.logging_in;
  try {
    const data = await (await post('login')).json();
    if (data.url) { location.href = data.url; return; }
    btn.textContent = data.message || cfg.t.login_failed;
  } catch { btn.textContent = cfg.t.disconnected; }
  btn.disabled = false;
});
if ($('accept')) $('accept').addEventListener('click', () => convert($('remember').checked));
if (cfg.kind === 'pdf' || cfg.ready) showFile();
else if (cfg.kind === 'office' && cfg.consented) convert(false);
setInterval(() => { fetch(cfg.base + 'ping').catch(() => { const n = $('gone'); if (n) n.hidden = false; }); }, cfg.heartbeat);
`;

function consentCard(t) {
  return `<section class="card" id="consent"><h2>${escapeHtml(t.consent_title)}</h2><p>${escapeHtml(t.consent_body)}</p>`
    + `<label><input type="checkbox" id="remember" checked>${escapeHtml(t.consent_remember)}</label>`
    + `<div class="actions"><button class="primary" id="accept">${escapeHtml(t.consent_accept)}</button></div></section>`;
}

function mainContent({ kind, inline, consented, ready, t }) {
  if (inline) return `<div class="doc${kind === PreviewKind.CSV ? ' wide' : ''}">${inline.html}</div>`;
  if (kind === PreviewKind.UNSUPPORTED) return `<section class="card"><p>${escapeHtml(t.unsupported)}</p></section>`;
  const consent = kind === PreviewKind.OFFICE && !consented && !ready ? consentCard(t) : '';
  return `${consent}<section class="card" id="status" hidden></section><iframe id="frame" title="preview" hidden></iframe>`;
}

/** `<` trong JSON bị escape để tên tệp không đóng được thẻ script. */
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export function previewPageHtml({ name, kind, inline, consented, ready = false, base, nonce, lang }) {
  const t = textFor(lang);
  const cfg = { base, kind, consented, ready, heartbeat: HEARTBEAT_INTERVAL_MS, t };
  const truncated = inline?.truncated ? `<div class="notice">${escapeHtml(t.truncated)}</div>` : '';
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(name)} - AIVIN Bot</title><link rel="icon" href="data:image/png;base64,${AIVIN_LOGO_PNG_BASE64}"><style>${PAGE_CSS}</style></head><body>`
    + `<header><img alt="" src="data:image/png;base64,${AIVIN_LOGO_PNG_BASE64}"><span class="name">${escapeHtml(name)}</span><span class="badge">${escapeHtml(t.view_only)}</span>`
    + `<span class="spacer"></span><button class="primary" id="login" title="${escapeHtml(t.login_note)}">${escapeHtml(t.login)}</button></header>`
    + `<div class="notice" id="gone" hidden>${escapeHtml(t.disconnected)}</div>${truncated}`
    + `<main>${mainContent({ kind, inline, consented, ready, t })}</main>`
    + `<script type="application/json" id="cfg">${safeJson(cfg)}</script><script nonce="${nonce}">${PAGE_SCRIPT}</script></body></html>`;
}

// --- Đồng ý + chuyển đổi trên cloud -----------------------------------------------------------------------------------------------------

export function hasOfficeConsent(file = SETTINGS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).office_preview_consent === true; } catch { return false; }
}

export function saveOfficeConsent(file = SETTINGS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ office_preview_consent: true }, null, 2));
}

function errorBody(error) {
  try { return JSON.parse(Buffer.from(error.response.data).toString('utf8')); } catch { return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Máy chủ bận thì tự thử lại, người dùng chỉ thấy "đang chuẩn bị". */
export async function convertOfficeOnCloud({ serverUrl, name, buffer, post = axios.post, wait = sleep }) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([buffer]), name);
    try {
      const res = await post(`${serverUrl}/fileshare/anonymous-preview`, form, { responseType: 'arraybuffer', timeout: CONVERT_TIMEOUT_MS, maxBodyLength: Infinity, maxContentLength: Infinity });
      return Buffer.from(res.data);
    } catch (error) {
      const body = errorBody(error);
      if (body?.code === BUSY_CODE && attempt < BUSY_RETRIES) { await wait(BUSY_RETRY_MS); continue; }
      throw new Error(body?.message || error?.code || error?.message, { cause: error });
    }
  }
}

// --- Máy chủ cục bộ ---------------------------------------------------------------------------------------------------------------------

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Chống DNS rebinding + trang web khác gọi vào cổng cục bộ: Host phải đúng, POST phải cùng nguồn. */
export function isTrustedRequest({ method, host, origin, port }) {
  const self = `127.0.0.1:${port}`;
  if (host !== self) return false;
  return method === 'GET' || origin === `http://${self}`;
}

/**
 * Mở máy chủ xem tệp. `onLogin()` đăng nhập + tải lên Drive, trả link trình soạn. `onClosed()` khi trang đã đóng.
 * Trả `{ url, close }`.
 */
export async function startPreviewServer({ filePath, serverUrl, onLogin, onClosed = () => {}, lang = mascotLang(), settingsFile = SETTINGS_FILE, cacheDir = PREVIEW_CACHE_DIR, heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS }) {
  const name = path.basename(filePath);
  const kind = previewKind(name);
  const buffer = fs.readFileSync(filePath);
  const inline = renderInlineContent(kind, buffer);
  const token = randomBytes(24).toString('hex');
  const base = `/${token}/`;
  const t = textFor(lang);
  const cacheKey = kind === PreviewKind.OFFICE ? contentKey(buffer) : null;
  let pdf = kind === PreviewKind.PDF ? buffer : (cacheKey && readCachedPdf(cacheKey, { dir: cacheDir }));
  const fromCache = kind === PreviewKind.OFFICE && !!pdf;
  let lastSeen = Date.now();
  let port = 0;
  let closed = false;

  const server = http.createServer();
  const watchdog = setInterval(() => { if (Date.now() - lastSeen > heartbeatTimeoutMs) close(); }, 15_000);
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    server.closeAllConnections?.();
    server.close(() => onClosed());
  }

  const handlers = {
    'GET ': (req, res) => {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `${PAGE_CSP}; script-src 'nonce-${nonce}'` });
      res.end(previewPageHtml({ name, kind, inline, consented: hasOfficeConsent(settingsFile), ready: !!pdf, base, nonce, lang }));
    },
    'GET ping': (req, res) => sendJson(res, 200, { ok: true }),
    'GET file': (req, res) => {
      if (!pdf) return sendJson(res, 404, { ok: false });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(pdf);
    },
    'POST convert': async (req, res) => {
      if (kind !== PreviewKind.OFFICE) return sendJson(res, 400, { ok: false });
      const body = await readJsonBody(req);
      try {
        if (body.remember) saveOfficeConsent(settingsFile);
        if (!pdf) {
          pdf = await convertOfficeOnCloud({ serverUrl, name, buffer });
          writeCachedPdf(cacheKey, pdf, { dir: cacheDir });
        }
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error.message || t.convert_failed });
      }
    },
    'POST login': async (req, res) => {
      try {
        const url = await onLogin();
        sendJson(res, 200, { url });
        setTimeout(close, SHUTDOWN_AFTER_LOGIN_MS).unref();
      } catch (error) {
        sendJson(res, 200, { message: error.message || t.login_failed });
      }
    },
  };

  server.on('request', (req, res) => {
    lastSeen = Date.now();
    const pathname = (req.url || '').split('?')[0];
    if (!isTrustedRequest({ method: req.method, host: req.headers.host, origin: req.headers.origin, port }) || !pathname.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    const handler = handlers[`${req.method} ${pathname.slice(base.length)}`];
    if (!handler) { res.writeHead(404).end(); return; }
    Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });

  port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return { url: `http://127.0.0.1:${port}${base}`, close, fromCache };
}
