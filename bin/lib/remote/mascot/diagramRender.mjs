import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';

/**
 * Dựng sơ đồ và mở công cụ tương tác cho linh vật (03/11/2026). WPF không chạy được JavaScript hiện đại nên dùng trình duyệt có sẵn trên máy (Edge luôn có trên
 * Windows 10/11, không có thì Chrome):
 * - Sơ đồ: Mermaid (cùng thư viện với web, đóng gói trong CLI) chạy trong trình duyệt không giao diện, chặn hẳn mạng (`--host-resolver-rules`), hồ sơ riêng,
 *   `securityLevel: strict`; đo cỡ rồi chụp thành PNG. Không dựng được → null, nơi gọi đổi thành nút mở trên web.
 * - Công cụ tương tác: cửa sổ ứng dụng riêng (`--app`), HTML của AI nằm trong iframe `sandbox="allow-scripts allow-modals"` — cùng cờ với web: origin riêng, không
 *   đọc được tệp trên máy, không điều hướng được trang ngoài, không mở cửa sổ khác. Chỉ mở khi chủ máy bấm.
 */
export const MASCOT_RENDER_DIR = path.join(REMOTE_CONFIG_DIR, 'mascot-render');
const RENDER_TIMEOUT_MS = 20000;
const KEEP_IMAGES = 40;
const DIAGRAM_PADDING = 16;
const MAX_SIDE = 4000;
const BROWSER_PATHS = [
  ['ProgramFiles(x86)', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['ProgramFiles', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['LOCALAPPDATA', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'],
  ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'],
  ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
];
const SIZE_MARK = /<title>OK (\d+) (\d+)<\/title>/;

export function findBrowser(env = process.env, exists = fs.existsSync) {
  for (const [base, rel] of BROWSER_PATHS) {
    const file = env[base] ? path.win32.join(env[base], rel) : null;
    if (file && exists(file)) return file;
  }
  return null;
}

const fileUrl = (file) => `file:///${path.resolve(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;

/** Chạy trình duyệt không giao diện, trả stdout; quá giờ / lỗi → ném. */
function runHeadless(browser, args, { spawnImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(browser, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/** Chuỗi JSON đặt được trong thẻ script: `</script>` trong sơ đồ không thoát ra ngoài. */
const scriptSafeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

function diagramPage(source, mermaidFile, size) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>WAIT</title><style>html,body{margin:0;background:#fff}#d{display:inline-block;padding:${DIAGRAM_PADDING / 2}px}</style></head><body><div id="d"></div>
<script src="${path.basename(mermaidFile)}"></script>
<script>
var source = ${scriptSafeJson(source)};
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: 'Segoe UI, sans-serif',
  themeVariables: { fontFamily: 'Segoe UI, sans-serif', fontSize: '14px', primaryColor: '#EFF6FF', primaryBorderColor: '#93C5FD', primaryTextColor: '#1D2129', lineColor: '#86909C', secondaryColor: '#F5F3FF', tertiaryColor: '#F7F8FA' } });
mermaid.render('g', source).then(function (r) {
  var d = document.getElementById('d'); d.innerHTML = r.svg;
  var svg = d.querySelector('svg'); var box = svg.viewBox.baseVal; var w = Math.ceil(box.width || svg.getBoundingClientRect().width); var h = Math.ceil(box.height || svg.getBoundingClientRect().height);
  svg.style.maxWidth = 'none'; svg.setAttribute('width', w); svg.setAttribute('height', h);
  document.title = 'OK ' + w + ' ' + h;
}).catch(function (e) { document.title = 'FAIL'; });
</script>${size ? '' : ''}</body></html>`;
}

/** Tệp mermaid.min.js trong thư mục dựng: giải nén một lần theo phiên bản, chỉ khi gặp sơ đồ đầu tiên (bộ nén nặng ~1 MB, không nạp lúc daemon khởi động). */
async function ensureMermaid(dir) {
  const { MERMAID_GZ_BASE64, MERMAID_VERSION } = await import('./mermaidBundle.mjs');
  const file = path.join(dir, `mermaid-${MERMAID_VERSION}.min.js`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.tmp${process.pid}`;
    fs.writeFileSync(tmp, gunzipSync(Buffer.from(MERMAID_GZ_BASE64, 'base64')));
    fs.renameSync(tmp, file);
  }
  return file;
}

function pruneImages(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((name) => {
    const file = path.join(dir, name);
    return { file, at: fs.statSync(file).mtimeMs };
  }).sort((a, b) => b.at - a.at);
  for (const { file } of files.slice(KEEP_IMAGES)) fs.rmSync(file, { force: true });
}

/** Mỗi lúc một sơ đồ: mỗi lần dựng mở một tiến trình trình duyệt. */
let queue = Promise.resolve();

/** Mã Mermaid → đường dẫn PNG (dùng lại nếu đã dựng), không dựng được → null. Không ném lỗi. */
export function renderDiagram(source, { dir = MASCOT_RENDER_DIR, browser = findBrowser(), spawnImpl = spawn, timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  const run = async () => {
    if (!browser) return null;
    const name = createHash('sha256').update(String(source)).digest('hex').slice(0, 32);
    const png = path.join(dir, `${name}.png`);
    const page = path.join(dir, `${name}.html`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(png)) return png;
      const mermaidFile = await ensureMermaid(dir);
      fs.writeFileSync(page, diagramPage(String(source), mermaidFile));
      const base = [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
        '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=8000',
      ];
      // Lượt đầu đo cỡ sơ đồ, lượt sau chụp đúng cỡ đó, độ phân giải gấp đôi để thu nhỏ trong ô hỏi vẫn nét.
      const dom = await runHeadless(browser, [...base, '--dump-dom', fileUrl(page)], { spawnImpl, timeoutMs });
      const size = String(dom).match(SIZE_MARK);
      if (!size) return null;
      const w = Math.min(MAX_SIDE, Number(size[1]) + DIAGRAM_PADDING);
      const h = Math.min(MAX_SIDE, Number(size[2]) + DIAGRAM_PADDING);
      await runHeadless(browser, [...base, '--force-device-scale-factor=2', '--hide-scrollbars', `--window-size=${w},${h}`, `--screenshot=${png}`, fileUrl(page)], { spawnImpl, timeoutMs });
      if (!fs.existsSync(png)) return null;
      pruneImages(dir);
      return png;
    } catch {
      return null;
    } finally {
      fs.rmSync(page, { force: true });
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => null);
  return result;
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Trang bọc công cụ tương tác: bản thân trang không có script, mọi thứ của AI nằm trong iframe sandbox (cùng cờ `WebViewRenderer` trên web). */
export function webviewPage(html, title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeAttr(title)}</title><style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe sandbox="allow-scripts allow-modals" referrerpolicy="no-referrer" srcdoc="${escapeAttr(html)}"></iframe></body></html>`;
}

/** Mở công cụ tương tác trong cửa sổ riêng. Không có trình duyệt → false, nơi gọi mở phiên trên web. */
export function openWebview(html, title, { dir = MASCOT_RENDER_DIR, browser = findBrowser(), spawnImpl = spawn } = {}) {
  if (!browser) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `webview-${createHash('sha256').update(html).digest('hex').slice(0, 24)}.html`);
    fs.writeFileSync(file, webviewPage(html, title));
    const child = spawnImpl(browser, [`--app=${fileUrl(file)}`, '--window-size=560,720', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore', detached: true, windowsHide: false });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
