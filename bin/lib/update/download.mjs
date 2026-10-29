import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { createGunzip } from 'zlib';
import { RELEASE_PUBLIC_KEYS } from '../releaseKeys.mjs';
import {
  DEFAULT_DOWNLOAD_ROOT, DOWNLOAD_TIMEOUT_MS, HTTP_TIMEOUT_MS, MAX_BINARY_BYTES, MAX_DOWNLOAD_BYTES, MAX_TEXT_BYTES, VERIFY_TIMEOUT_MS,
} from './constants.mjs';
import { checksumFor, verifyReleaseSignature } from './signature.mjs';
import { compareVersions, parseVersion, tagOf } from './versions.mjs';

/**
 * Tải từ trang tải: nguồn chỉ từ biến môi trường của máy (không từ máy chủ Aivin, không từ tệp trong `~/.aivin` — một lần ghi được tệp đó
 * không được trở thành chỗ cài lại mã độc sau mỗi lần cài sạch), chỉ https (http chỉ cho máy này), chuyển hướng cũng phải https, trần dung
 * lượng mọi tệp. Bản build đi thẳng ra đĩa (tính SHA-256 + giải nén trong lúc tải) — không giữ ~50 MB tệp nén + ~110 MB tệp chạy trong RAM.
 */

const execFileAsync = promisify(execFile);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Biến môi trường bản mới được thấy khi chạy thử — không API key, token, mật khẩu proxy. */
const VERIFY_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL'];

/** https, hoặc http chỉ tới chính máy này (gương thử tại chỗ). */
export function assertSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Nguồn tải không hợp lệ: ${url}`); }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))) return;
  throw new Error(`Nguồn tải phải là https (${u.protocol}//${u.host})`);
}

/** Nguồn tải: AIVIN_DOWNLOAD_ROOT (máy dùng gương nội bộ) → get.aivin.vn. */
export function downloadRoot({ env = process.env } = {}) {
  const root = String(env.AIVIN_DOWNLOAD_ROOT || DEFAULT_DOWNLOAD_ROOT).replace(/\/+$/, '');
  assertSafeUrl(root);
  return root;
}

const requestOptions = ({ timeout, signal }) => ({
  timeout, signal, maxRedirects: 3, headers: { 'Cache-Control': 'no-cache' },
  // Chuyển hướng sang http (follow-redirects mặc định cho phép, chỉ bỏ header nhạy cảm) → dừng.
  beforeRedirect: (options) => assertSafeUrl(`${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}/`),
});

async function fetchBytes(url, { maxBytes, timeout = HTTP_TIMEOUT_MS, signal }) {
  assertSafeUrl(url);
  const res = await axios.get(url, { ...requestOptions({ timeout, signal }), responseType: 'arraybuffer', maxContentLength: maxBytes });
  return Buffer.from(res.data);
}

const fetchText = async (url, opts) => (await fetchBytes(url, { maxBytes: MAX_TEXT_BYTES, ...opts })).toString('utf8');

/** Đếm byte qua luồng, quá trần thì dừng cả đường ống; `onChunk` thấy từng khúc (tính mã băm). */
function byteCap(max, label, onChunk) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > max) return cb(new Error(`${label} vượt trần ${Math.round(max / 1048576)} MB — dừng cập nhật`));
      onChunk?.(chunk);
      cb(null, chunk);
    },
  });
}

/** Tải `url` (tệp .gz) thẳng ra `file` đã giải nén; trả SHA-256 của các byte NÉN đã tải (so với danh sách mã băm đã ký). */
async function downloadGzToFile({ url, file, signal, maxBinaryBytes }) {
  assertSafeUrl(url);
  const res = await axios.get(url, { ...requestOptions({ timeout: DOWNLOAD_TIMEOUT_MS, signal }), responseType: 'stream' });
  const hash = createHash('sha256');
  await pipeline(
    res.data,
    byteCap(MAX_DOWNLOAD_BYTES, 'Tệp tải về', (chunk) => hash.update(chunk)),
    createGunzip(),
    byteCap(maxBinaryBytes, 'Tệp giải nén'),
    fs.createWriteStream(file, { mode: 0o755 }),
    { signal },
  );
  return hash.digest('hex');
}

export async function fetchLatestVersion({ root = downloadRoot(), signal } = {}) {
  const version = (await fetchText(`${root}/latest.txt`, { signal })).trim();
  if (!parseVersion(version)) throw new Error(`Không đọc được phiên bản mới nhất từ ${root}/latest.txt`);
  return tagOf(version);
}

/** Phát hành theo đợt: `<root>/rollout.json` = `{ version, percent }`. Không có / hỏng → cả đội máy. Tệp này chỉ hoãn được, không cài được gì. */
export async function fetchRollout({ root = downloadRoot(), signal } = {}) {
  try {
    const data = JSON.parse(await fetchText(`${root}/rollout.json`, { signal }));
    const percent = Number(data?.percent);
    return parseVersion(data?.version) && Number.isFinite(percent) ? { version: tagOf(data.version), percent: Math.max(0, Math.min(100, percent)) } : null;
  } catch {
    return null;
  }
}

/**
 * Tải chữ ký + danh sách mã băm trước (nhỏ), kiểm chữ ký, rồi mới tải bản build ra `destDir` (giải nén trong lúc tải, có trần) và so SHA-256.
 * Mã băm lệch → xoá tệp vừa ghi, ném.
 */
export async function downloadRelease({ root, version, asset, destDir, signal, keys = RELEASE_PUBLIC_KEYS, maxBinaryBytes = MAX_BINARY_BYTES }) {
  const base = `${root}/${tagOf(version)}`;
  const [sums, sigText] = await Promise.all([
    fetchBytes(`${base}/SHA256SUMS`, { maxBytes: MAX_TEXT_BYTES, signal }),
    fetchText(`${base}/SHA256SUMS.sig`, { signal }).catch((e) => { if (e?.response?.status === 404) return null; throw e; }),
  ]);
  if (!sigText) throw new Error(`Bản ${tagOf(version)} không có chữ ký (SHA256SUMS.sig) — dừng cập nhật`);
  verifyReleaseSignature({ version, sums, sigText, keys });
  const expected = checksumFor(sums.toString('utf8'), `${asset}.gz`);
  if (!expected) throw new Error(`SHA256SUMS của ${tagOf(version)} không có ${asset}.gz`);
  const file = path.join(destDir, asset);
  let actual;
  try {
    actual = await downloadGzToFile({ url: `${base}/${asset}.gz`, file, signal, maxBinaryBytes });
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  if (actual !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error(`Tệp tải về không khớp mã kiểm tra (${asset}.gz) — dừng cập nhật để an toàn`);
  }
  return file;
}

export function verifyEnv(env = process.env) {
  return Object.fromEntries(VERIFY_ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/** Bản mới phải chạy được trên máy này và đúng phiên bản đã hứa, trước khi thay bản đang dùng (bất đồng bộ: daemon vẫn nhận việc). */
export async function verifyStarts(file, version) {
  let out;
  try {
    ({ stdout: out } = await execFileAsync(file, ['--version'], { timeout: VERIFY_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024, env: verifyEnv(), cwd: path.dirname(file) }));
  } catch (e) {
    throw new Error(`Bản ${tagOf(version)} không chạy được trên máy này (${e?.message || e})`, { cause: e });
  }
  if (compareVersions(String(out).trim(), version) !== 0) throw new Error(`Bản tải về báo phiên bản "${String(out).trim()}", không phải ${tagOf(version)}`);
}
