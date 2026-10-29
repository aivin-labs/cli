import { execFileSync } from 'child_process';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Proxy của mạng công ty (29/10/2026). Trước đây daemon nối websocket thẳng, không đọc proxy → sau proxy công ty máy không bao giờ online.
 * Thứ tự: `--proxy` / `AIVIN_PROXY` → biến môi trường `HTTPS_PROXY` / `ALL_PROXY` → proxy hệ thống (Windows: Internet Settings, macOS:
 * `scutil --proxy`). Tệp PAC (tự cấu hình theo địa chỉ) chưa đọc được — khi đó nêu `--proxy` tường minh.
 *
 * Chỉ áp cho máy chủ Aivin qua https/wss (đường hầm CONNECT); địa chỉ nội bộ (localhost, NO_PROXY) đi thẳng.
 */

export const ProxySource = Object.freeze({ EXPLICIT: 'explicit', ENV: 'env', SYSTEM: 'system' });

const NONE = new Set(['none', 'off', 'direct', 'false', '0']);
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1', '[::1]'];

let active = null;
let interceptorInstalled = false;

function withScheme(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
}

/** `ProxyServer` của Windows: `host:port` hoặc `http=h:p;https=h:p;…` → ưu tiên https, rồi http. */
export function parseWindowsProxyServer(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!v.includes('=')) return withScheme(v.split(';')[0]);
  const parts = Object.fromEntries(v.split(';').map((p) => p.split('=').map((s) => s.trim())).filter(([k, x]) => k && x));
  return withScheme(parts.https || parts.http || '');
}

/** Bảng `reg query …\Internet Settings` → `{ enabled, server, override, pac }`. */
export function parseWindowsInternetSettings(text) {
  const read = (name) => String(text || '').match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi'))?.[1]?.trim() || '';
  const enabled = /^0x0*1$/i.test(read('ProxyEnable'));
  return { enabled, server: parseWindowsProxyServer(read('ProxyServer')), override: read('ProxyOverride'), pac: read('AutoConfigURL') };
}

/** Kết quả `scutil --proxy` (macOS) → URL proxy HTTPS (hoặc HTTP) đang bật + danh sách bỏ qua. */
export function parseScutilProxy(text) {
  const read = (name) => String(text || '').match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'mi'))?.[1]?.trim() || '';
  const pick = (kind) => (read(`${kind}Enable`) === '1' && read(`${kind}Proxy`) ? `http://${read(`${kind}Proxy`)}:${read(`${kind}Port`) || 80}` : '');
  const exceptions = [...String(text || '').matchAll(/^\s*\d+\s*:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  return { server: pick('HTTPS') || pick('HTTP'), override: exceptions.join(';'), pac: read('ProxyAutoConfigURLString') };
}

function systemProxy(platform) {
  try {
    if (platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const s = parseWindowsInternetSettings(out);
      return { server: s.enabled ? s.server : '', bypass: s.override, pac: s.pac };
    }
    if (platform === 'darwin') {
      const s = parseScutilProxy(execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 }));
      return { server: s.server, bypass: s.override, pac: s.pac };
    }
  } catch { /* không đọc được → không dùng proxy hệ thống */ }
  return { server: '', bypass: '', pac: '' };
}

/** Chọn proxy theo thứ tự ở đầu tệp. Trả `{ url, source, bypass, pac }` — `url` rỗng = đi thẳng. */
export function resolveProxy({ explicit, env = process.env, platform = process.platform, readSystem = systemProxy } = {}) {
  const chosen = explicit ?? env.AIVIN_PROXY;
  const bypass = env.NO_PROXY || env.no_proxy || '';
  if (chosen !== undefined && chosen !== null && String(chosen).trim() !== '') {
    return NONE.has(String(chosen).trim().toLowerCase())
      ? { url: '', source: ProxySource.EXPLICIT, bypass, pac: '' }
      : { url: withScheme(chosen), source: ProxySource.EXPLICIT, bypass, pac: '' };
  }
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (fromEnv) return { url: withScheme(fromEnv), source: ProxySource.ENV, bypass, pac: '' };
  const sys = readSystem(platform);
  return { url: sys.server, source: sys.server ? ProxySource.SYSTEM : null, bypass: [bypass, sys.bypass].filter(Boolean).join(';'), pac: sys.pac };
}

const escapeRegex = (s) => s.replace(/[.+?^$()|[\]{}\\]/g, '\\$&');
/** Mẫu kiểu Windows `10.*` / `*internal*` → regex khớp trọn tên máy. */
const wildcardRegex = (rule) => new RegExp(`^${rule.split('*').map(escapeRegex).join('.*')}$`);

/** Địa chỉ đi thẳng: localhost, mạng nội bộ của Windows (`<local>` = tên không có dấu chấm), danh sách NO_PROXY / ProxyOverride. */
export function shouldBypass(targetUrl, bypass = '') {
  let host;
  try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { return true; }
  if (ALWAYS_DIRECT.includes(host)) return true;
  for (const raw of String(bypass).split(/[;,\s]+/)) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    if (rule === '<local>') {
      if (!host.includes('.')) return true;
      continue;
    }
    if (rule.includes('*') && !rule.startsWith('*.')) {
      if (wildcardRegex(rule).test(host)) return true;
      continue;
    }
    const domain = rule.replace(/^\*?\./, '');
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Bật proxy cho cả tiến trình: axios (đăng ký máy, tệp lớn, `remote do`) dùng agent CONNECT thay cách tự đọc biến môi trường của axios (gửi
 * URL đầy đủ cho proxy, nhiều proxy công ty từ chối với https). Trả thông tin để in ra màn hình.
 */
export function configureProxy(opts = {}) {
  const resolved = resolveProxy(opts);
  active = resolved.url ? { ...resolved, agent: new HttpsProxyAgent(resolved.url) } : { ...resolved, agent: null };
  // Proxy do tệp này quyết (kể cả `--proxy none` khi môi trường có HTTPS_PROXY) — tắt cách tự đọc biến môi trường của axios.
  axios.defaults.proxy = false;
  if (!interceptorInstalled) {
    interceptorInstalled = true;
    axios.interceptors.request.use((config) => {
      const agent = proxyAgentFor(axios.getUri(config));
      if (agent) config.httpsAgent = agent;
      return config;
    });
  }
  return { url: redact(resolved.url), source: resolved.source, pac: resolved.pac };
}

/** Agent cho một kết nối tới máy chủ Aivin (socket.io / ws) — `undefined` = đi thẳng. */
export function proxyAgentFor(targetUrl) {
  if (!active?.agent) return undefined;
  if (!/^(https|wss):/i.test(String(targetUrl)) || shouldBypass(targetUrl, active.bypass)) return undefined;
  return active.agent;
}

/** URL proxy để in: bỏ mật khẩu. */
export function redact(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}
