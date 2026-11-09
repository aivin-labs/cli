import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';

/**
 * Tải ảnh cho ô hỏi của linh vật (03/11/2026). Daemon tải thay cho cửa sổ vì URL ảnh đến từ câu trả lời của AI (có thể lấy từ trang web lạ), còn bộ giải
 * mã ảnh của cửa sổ chạy ngay trên máy chủ máy, không có sandbox như trình duyệt:
 * - chỉ `http(s)`; địa chỉ nội bộ (router, máy trong LAN, localhost) bị từ chối, trừ chính máy chủ Aivin, để nội dung độc hại không gọi được vào mạng của chủ máy;
 * - theo redirect thủ công, mỗi bước kiểm lại địa chỉ;
 * - giới hạn dung lượng + thời gian; định dạng lấy theo byte đầu tệp, không tin Content-Type.
 * Ảnh hỏng / bị từ chối → null, nơi gọi đổi thành nút mở link.
 */
export const MASCOT_IMAGE_DIR = path.join(REMOTE_CONFIG_DIR, 'mascot-images');
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const KEEP_FILES = 60;

/** Đuôi tệp theo byte đầu; loại khác (SVG, HTML…) không đưa vào bộ giải mã. */
export function imageExtension(head) {
  if (head.length < 12) return null;
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (head.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return null;
}

/** Tên máy / IP nội bộ. Chỉ xét chữ trong URL (không phân giải DNS) — đủ cho link AI viết ra, không chống được DNS rebinding. */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || !h.includes('.') && !h.includes(':')) return true;
  if (h === '::1' || /^(fc|fd|fe[89ab])/.test(h)) return true;
  const ip = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function allowedUrl(url, serverHost) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname === serverHost || !isPrivateHost(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

async function readLimited(stream, signal) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error('timeout');
    total += chunk.length;
    if (total > MAX_BYTES) { stream.destroy(); throw new Error('too big'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function download(url, serverHost, http, signal) {
  let current = allowedUrl(url, serverHost);
  for (let hop = 0; current && hop <= MAX_REDIRECTS; hop++) {
    const res = await http.get(current, { responseType: 'stream', maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400, signal, timeout: TIMEOUT_MS });
    if (res.status < 300) return readLimited(res.data, signal);
    res.data?.destroy?.();
    const next = res.headers?.location ? new URL(res.headers.location, current).href : null;
    current = next && allowedUrl(next, serverHost);
  }
  return null;
}

/** Xoá ảnh cũ, giữ `KEEP_FILES` tệp mới nhất. */
function prune(dir) {
  const files = fs.readdirSync(dir).map((name) => {
    const file = path.join(dir, name);
    return { file, at: fs.statSync(file).mtimeMs };
  }).sort((a, b) => b.at - a.at);
  for (const { file } of files.slice(KEEP_FILES)) fs.rmSync(file, { force: true });
}

/** Ảnh tại `url` → đường dẫn tệp đã kiểm (dùng lại nếu đã tải), không được → null. Không ném lỗi. */
export async function fetchMascotImage(url, { dir = MASCOT_IMAGE_DIR, serverUrl = '', http = axios } = {}) {
  const name = createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cached = fs.readdirSync(dir).find((f) => f.startsWith(`${name}.`));
    if (cached) return path.join(dir, cached);
    let serverHost = '';
    try { serverHost = new URL(serverUrl).hostname; } catch { /* không biết máy chủ thì mọi địa chỉ nội bộ đều bị từ chối */ }
    const body = await download(url, serverHost, http, controller.signal);
    const ext = body && imageExtension(body.subarray(0, 12));
    if (!ext) return null;
    const file = path.join(dir, `${name}.${ext}`);
    const tmp = `${file}.tmp${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    prune(dir);
    return file;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
