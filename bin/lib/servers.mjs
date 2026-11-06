import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { writeFileAtomic } from './remote/atomicFile.mjs';

export const SERVER_CONFIG_FILE = path.join(process.env.AIVIN_REMOTE_HOME || path.join(os.homedir(), '.aivin'), 'server.json');
export const DEFAULT_SERVER_URL = 'https://api.aivin.cloud';

export function resolveServerUrl(input, { fallback = DEFAULT_SERVER_URL } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return resolveServerUrl(fallback);
  const alias = raw.toLowerCase();
  if (alias === 'cloud') return 'https://api.aivin.cloud';
  if (alias === 'vn') return 'https://api.aivin.vn';
  const local = alias.match(/^local(?::(\d+))?$/);
  if (local) {
    const port = Number(local[1] || 3001);
    if (port < 1 || port > 65535) throw new Error('Cổng local phải nằm trong khoảng 1–65535.');
    return `http://localhost:${port}`;
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error(`Máy chủ không hợp lệ: ${raw}`); }
  if (url.username || url.password) throw new Error('URL máy chủ không được chứa username hoặc password.');
  const host = url.hostname.toLowerCase();
  // Migrate the retired Vietnam beta endpoint to production. The device credential migration
  // below keeps the old sealed record until production accepts the token.
  if (host === 'beta-api.aivin.vn') return 'https://api.aivin.vn';
  if (host === 'beta-api.aivin.cloud') return 'https://api.aivin.cloud';
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Chỉ localhost mới được dùng HTTP; máy chủ khác phải dùng HTTPS.');
  }
  for (const domain of ['aivin.cloud', 'aivin.vn']) {
    if (host === domain) return `https://api.${domain}`;
    if (host.endsWith(`.${domain}`)) {
      const first = host.slice(0, -(domain.length + 1)).split('.').at(-1);
      if (!/(^|-)api$/.test(first)) return `https://api.${domain}`;
    }
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

export function serverKey(serverUrl) {
  return createHash('sha256').update(resolveServerUrl(serverUrl)).digest('hex').slice(0, 24);
}

export function readActiveServer() {
  try {
    const value = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'))?.server_url;
    if (!value) return null;
    const normalized = resolveServerUrl(value);
    if (String(value).trim().replace(/\/+$/, '') !== normalized) {
      try { setActiveServer(normalized); } catch { /* old value is still readable */ }
    }
    return normalized;
  } catch { return null; }
}

export function setActiveServer(serverUrl) {
  const normalized = resolveServerUrl(serverUrl);
  fs.mkdirSync(path.dirname(SERVER_CONFIG_FILE), { recursive: true });
  writeFileAtomic(SERVER_CONFIG_FILE, `${JSON.stringify({ server_url: normalized }, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(SERVER_CONFIG_FILE, 0o600); } catch { /* Windows ACL follows the user profile */ }
  return normalized;
}

export function serverLabel(serverUrl) {
  const url = resolveServerUrl(serverUrl);
  if (url === 'https://api.aivin.cloud') return 'Cloud';
  if (url === 'https://api.aivin.vn') return 'VN';
  if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) return 'Local';
  return new URL(url).host;
}
