import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, createPublicKey, verify as verifySignature } from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'util';
import { gunzip } from 'zlib';
import { REMOTE_CONFIG_DIR } from './remote/constants.mjs';
import { RELEASE_PUBLIC_KEYS } from './releaseKeys.mjs';

/**
 * Tự cập nhật CLI (29/10/2026) — chỉ bản tệp chạy đóng gói (bộ cài install.ps1 / install.sh); bản npm cập nhật bằng npm.
 *
 * Lớp bảo vệ (rà 29/10/2026):
 * - Chữ ký Ed25519 trên `SHA256SUMS` (+ số phiên bản), khoá công khai nhúng trong CLI (releaseKeys.mjs), khoá bí mật không nằm trên trang
 *   tải → chiếm được get.aivin.vn cũng không đẩy được tệp chạy lạ. Mã băm cùng trang tải chỉ bắt tệp tải hỏng, không bắt tệp bị tráo.
 * - Nguồn tải chỉ từ biến môi trường của máy (không từ máy chủ Aivin, không từ tệp trong `~/.aivin` — một lần ghi được tệp đó không được
 *   trở thành chỗ cài lại mã độc sau mỗi lần cài sạch), chỉ https (http chỉ cho máy này), chuyển hướng cũng phải https.
 * - Trần dung lượng mọi tệp tải + trần giải nén; chạy thử `--version` với môi trường tối thiểu (không API key / token) trước khi thay.
 * - Giữ bản cũ `<tệp>.prev`; bản mới khởi động hỏng quá MAX_BOOTS_BEFORE_ROLLBACK lần trước khi nối được máy chủ → tự trả bản cũ + bỏ qua
 *   bản đó (checkBootAfterUpdate).
 */

export const DEFAULT_DOWNLOAD_ROOT = 'https://get.aivin.vn';
export const UPDATE_SETTINGS_FILE = path.join(REMOTE_CONFIG_DIR, 'update.json');
/** Bản vừa cài xuống đĩa (`aivin update` ở cửa sổ khác hoặc daemon tự cài) — daemon đang chạy bản cũ đọc tệp này để biết cần chạy lại. */
export const UPDATE_INSTALLED_FILE = path.join(REMOTE_CONFIG_DIR, 'update-installed.json');
/** Bản vừa cài chưa được xác nhận chạy ổn (nối được máy chủ / chạy đủ lâu) + số lần đã khởi động. */
export const UPDATE_STATE_FILE = path.join(REMOTE_CONFIG_DIR, 'update-state.json');
export const UPDATE_LOCK_FILE = path.join(REMOTE_CONFIG_DIR, 'update.lock');
/** Mã thoát "chạy lại tôi" (EX_TEMPFAIL): Task Scheduler + VBS / launchd / systemd chạy lại mọi mã khác 0. */
export const RESTART_EXIT_CODE = 75;
export const MAX_BOOTS_BEFORE_ROLLBACK = 3;
/** Bản mới chạy liền chừng này không sập → coi là ổn, bỏ bản cũ. */
export const UPDATE_CONFIRM_AFTER_MS = 10 * 60_000;
/** Mã lỗi `aivin remote start` khi vừa tự lùi bản: trình giữ chạy → thoát 75 (mở lại bằng bản cũ), cửa sổ tay → báo + thoát 1. */
export const UPDATE_ROLLED_BACK = 'UPDATE_ROLLED_BACK';

export const UpdateStatus = Object.freeze({
  UP_TO_DATE: 'up_to_date',
  AVAILABLE: 'available',
  INSTALLED: 'installed',
  NOT_BINARY: 'not_binary',
  /** Bản mới nhất là bản máy này đã tự lùi khỏi (khởi động hỏng) — chỉ cài lại khi người dùng chỉ định `--to`. */
  SKIPPED: 'skipped',
  /** Phát hành theo đợt (`rollout.json`): máy này chưa tới lượt. */
  DEFERRED: 'deferred',
  /** Một tiến trình khác đang cập nhật. */
  BUSY: 'busy',
});

export const BootAction = Object.freeze({ NONE: 'none', PENDING: 'pending', ROLLED_BACK: 'rolled_back' });

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const HTTP_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const VERIFY_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 15 * 60_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Biến môi trường bản mới được thấy khi chạy thử — không API key, token, mật khẩu proxy. */
const VERIFY_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL'];
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const require = createRequire(import.meta.url);

/** Phiên bản đang chạy: tệp chạy đóng gói ghi sẵn lúc build, bản npm đọc package.json. */
export function currentCliVersion() {
  if (process.env.AIVIN_CLI_BINARY) return process.env.AIVIN_CLI_BINARY;
  try { return require('../../package.json').version; } catch { return '0.0.0'; }
}

export const isStandaloneBinary = () => !!process.env.AIVIN_CLI_BINARY;

export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v || '').trim());
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/** So sánh phiên bản (`v` đầu tuỳ ý): âm / 0 / dương. Bản thử nghiệm (`-beta`) nhỏ hơn bản chính cùng số. Không đọc được → nhỏ nhất. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export const tagOf = (v) => `v${String(v).replace(/^v/, '')}`;

function isMusl() {
  try { return fs.readdirSync('/lib').some((f) => f.startsWith('ld-musl-')); } catch { return false; }
}

/** Tệp x64 chạy dưới Rosetta trên Apple Silicon → lên bản arm64 gốc (như install.sh). */
function underRosetta() {
  try { return execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 5000 }).trim() === '1'; } catch { return false; }
}

/** Tên bản build cho máy này — khớp TARGETS của scripts/build-binary.mjs. */
export function releaseAsset({ platform = process.platform, arch = process.arch, musl, rosetta } = {}) {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return `aivin-windows-${cpu}.exe`;
  if (platform === 'darwin') return `aivin-darwin-${cpu === 'x64' && (rosetta ?? underRosetta()) ? 'arm64' : cpu}`;
  if (platform === 'linux') return `aivin-linux-${cpu}${(musl ?? isMusl()) ? '-musl' : ''}`;
  throw new Error(`Nền tảng ${platform} chưa có bản tự cập nhật`);
}

/** Dòng `<sha256>  <tệp>` (dấu `*` chế độ nhị phân tuỳ ý) → mã của đúng tệp. */
export function checksumFor(sumsText, file) {
  for (const line of String(sumsText).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return null;
}

/** Nội dung được ký: số phiên bản + nguyên văn SHA256SUMS — chữ ký của bản này không dùng lại được cho bản khác. */
export const signedMessage = (version, sums) => Buffer.concat([Buffer.from(`aivin-release ${tagOf(version)}\n`), Buffer.from(sums)]);

const publicKeyOf = (raw) => createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });

/** Mã khoá = 16 ký tự hex đầu SHA-256 của khoá công khai thô (32 byte). */
export function releaseKeyId(key) {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(pub.export({ format: 'der', type: 'spki' }).subarray(-32)).digest('hex').slice(0, 16);
}

/** `SHA256SUMS.sig` = `{ alg: 'ed25519', key_id, version, sig }`. Khoá không có trong danh sách / chữ ký sai / lệch phiên bản → ném. */
export function verifyReleaseSignature({ version, sums, sigText, keys = RELEASE_PUBLIC_KEYS }) {
  let sig;
  try { sig = JSON.parse(String(sigText)); } catch { throw new Error(`Chữ ký của ${tagOf(version)} hỏng — dừng cập nhật để an toàn`); }
  const key = keys.find((k) => k.id === sig?.key_id);
  if (sig?.alg !== 'ed25519' || !key) throw new Error(`Bản ${tagOf(version)} không ký bằng khoá máy này tin (${sig?.key_id || 'không rõ khoá'}) — dừng cập nhật`);
  if (sig.version !== undefined && compareVersions(sig.version, version) !== 0) throw new Error(`Chữ ký dành cho ${sig.version}, không phải ${tagOf(version)} — dừng cập nhật`);
  let ok;
  try { ok = verifySignature(null, signedMessage(version, sums), publicKeyOf(key.key), Buffer.from(String(sig.sig || ''), 'base64')); } catch { ok = false; }
  if (!ok) throw new Error(`Chữ ký của ${tagOf(version)} không hợp lệ — dừng cập nhật để an toàn`);
}

/** https, hoặc http chỉ tới chính máy này (gương thử tại chỗ). */
export function assertSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Nguồn tải không hợp lệ: ${url}`); }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))) return;
  throw new Error(`Nguồn tải phải là https (${u.protocol}//${u.host})`);
}

/** Nguồn tải: AIVIN_DOWNLOAD_ROOT (máy dùng gương nội bộ) → get.aivin.vn. Không đọc từ tệp trong `~/.aivin` (xem đầu tệp). */
export function downloadRoot({ env = process.env } = {}) {
  const root = String(env.AIVIN_DOWNLOAD_ROOT || DEFAULT_DOWNLOAD_ROOT).replace(/\/+$/, '');
  assertSafeUrl(root);
  return root;
}

async function fetchBytes(url, { maxBytes, timeout = HTTP_TIMEOUT_MS, signal }) {
  assertSafeUrl(url);
  const res = await axios.get(url, {
    responseType: 'arraybuffer', timeout, signal, maxContentLength: maxBytes, maxRedirects: 3, headers: { 'Cache-Control': 'no-cache' },
    // Chuyển hướng sang http (follow-redirects mặc định cho phép, chỉ bỏ header nhạy cảm) → dừng.
    beforeRedirect: (options) => assertSafeUrl(`${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}/`),
  });
  return Buffer.from(res.data);
}

const fetchText = async (url, opts) => (await fetchBytes(url, { maxBytes: MAX_TEXT_BYTES, ...opts })).toString('utf8');

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

/** Máy nào thuộc đợt nào cố định theo (mã máy, phiên bản): tăng % chỉ thêm máy, không đổi máy đã lên. */
export function rolloutBucket(deviceId, version) {
  return parseInt(createHash('sha256').update(`${deviceId}:${tagOf(version)}`).digest('hex').slice(0, 8), 16) % 100;
}

/** Tải chữ ký + danh sách mã băm trước (nhỏ), kiểm chữ ký, rồi mới tải bản build, kiểm SHA-256, giải nén có trần vào `destDir`. */
export async function downloadRelease({ root, version, asset, destDir, signal, keys = RELEASE_PUBLIC_KEYS }) {
  const base = `${root}/${tagOf(version)}`;
  const [sums, sigText] = await Promise.all([
    fetchBytes(`${base}/SHA256SUMS`, { maxBytes: MAX_TEXT_BYTES, signal }),
    fetchText(`${base}/SHA256SUMS.sig`, { signal }).catch((e) => { if (e?.response?.status === 404) return null; throw e; }),
  ]);
  if (!sigText) throw new Error(`Bản ${tagOf(version)} không có chữ ký (SHA256SUMS.sig) — dừng cập nhật`);
  verifyReleaseSignature({ version, sums, sigText, keys });
  const expected = checksumFor(sums.toString('utf8'), `${asset}.gz`);
  if (!expected) throw new Error(`SHA256SUMS của ${tagOf(version)} không có ${asset}.gz`);
  const gz = await fetchBytes(`${base}/${asset}.gz`, { maxBytes: MAX_DOWNLOAD_BYTES, timeout: DOWNLOAD_TIMEOUT_MS, signal });
  const actual = createHash('sha256').update(gz).digest('hex');
  if (actual !== expected) throw new Error(`Tệp tải về không khớp mã kiểm tra (${asset}.gz) — dừng cập nhật để an toàn`);
  const file = path.join(destDir, asset);
  fs.writeFileSync(file, await gunzipAsync(gz, { maxOutputLength: MAX_BINARY_BYTES }), { mode: 0o755 });
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

/** Xoá; Windows không xoá được tệp còn đang chạy nhưng đổi tên được → `<tệp>-<thời điểm>.trash`, dọn ở lần chạy sau. */
function retire(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    fs.renameSync(file, `${file}-${Date.now()}.trash`);
  }
}

/**
 * Thay tệp chạy, giữ bản cũ ở `<tệp>.prev` (để tự lùi). Windows: đổi tên bản đang chạy thành `.prev` rồi chép bản mới (chép hỏng thì trả
 * tên cũ lại). macOS / Linux: chép bản cũ ra `.prev`, chép bản mới cạnh bên rồi đổi tên nguyên khối. Trả đường dẫn bản cũ (null nếu chưa có).
 */
export function replaceBinary({ newFile, target, platform = process.platform }) {
  const backup = `${target}.prev`;
  if (fs.existsSync(backup)) retire(backup);
  const had = fs.existsSync(target);
  if (platform === 'win32') {
    if (had) fs.renameSync(target, backup);
    try {
      fs.copyFileSync(newFile, target);
    } catch (e) {
      if (had) {
        fs.rmSync(target, { force: true });
        fs.renameSync(backup, target);
      }
      throw e;
    }
    return had ? backup : null;
  }
  if (had) {
    fs.copyFileSync(target, backup);
    fs.chmodSync(backup, 0o755);
  }
  const staged = `${target}.new`;
  fs.copyFileSync(newFile, staged);
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, target);
  return had ? backup : null;
}

/** Trả bản cũ về chỗ (bản mới đang chạy trên Windows bị khoá → đổi tên đi trước). */
export function restoreBackup({ target, backup, platform = process.platform }) {
  if (platform === 'win32' && fs.existsSync(target)) retire(target);
  fs.renameSync(backup, target);
}

/** Dọn bản cũ đã bỏ: `.old` (bản đầu của tính năng) + `*.trash`. Không đụng `.prev` — còn cần để tự lùi tới khi bản mới được xác nhận. */
export function cleanupRetired(target = process.execPath) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name !== `${base}.old` && !(name.startsWith(base) && name.endsWith('.trash'))) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* bản cũ còn đang chạy — lần sau */ }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function loadUpdateSettings(file = UPDATE_SETTINGS_FILE) {
  const data = readJson(file) || {};
  const skip = Array.isArray(data.skip) ? data.skip.filter((v) => parseVersion(v)).map(tagOf) : [];
  return { auto: data.auto !== false, skip };
}

export function saveUpdateSettings(patch, file = UPDATE_SETTINGS_FILE) {
  const next = { ...loadUpdateSettings(file), ...patch };
  writeJson(file, next);
  return next;
}

const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** Một lần cập nhật mỗi lúc (daemon tự cập nhật + `aivin update` ở cửa sổ khác cùng thay một tệp). */
async function withUpdateLock(fn, file = UPDATE_LOCK_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    const held = readJson(file);
    if (held && isAlive(Number(held.pid)) && Date.now() - Number(held.at) < LOCK_STALE_MS) return { status: UpdateStatus.BUSY };
    fs.writeFileSync(file, body);
  }
  try {
    return await fn();
  } finally {
    try { if (Number(readJson(file)?.pid) === process.pid) fs.rmSync(file, { force: true }); } catch { /* đã bị lấy lại */ }
  }
}

export function readInstalledMarker(file = UPDATE_INSTALLED_FILE) {
  const data = readJson(file);
  return data && parseVersion(data.version) && typeof data.path === 'string' ? data : null;
}

/** Đĩa đã có bản mới hơn bản đang chạy cho đúng tệp chạy này (cài ở cửa sổ khác / bởi daemon). Bản đã tự lùi khỏi không tính. */
export function installedNewerThanRunning({ target = process.execPath, current = currentCliVersion(), file = UPDATE_INSTALLED_FILE, settingsFile = UPDATE_SETTINGS_FILE } = {}) {
  const marker = readInstalledMarker(file);
  if (!marker || !samePath(marker.path, target) || compareVersions(marker.version, current) <= 0) return null;
  return loadUpdateSettings(settingsFile).skip.includes(tagOf(marker.version)) ? null : tagOf(marker.version);
}

/** Tiến trình vừa khởi động chính là tệp đang nằm trên đĩa → dấu "đã cài bản mới" cho tệp này đã cũ (cài lại bằng bộ cài, đã lùi bản…). */
export function clearStaleInstalledMarker({ target = process.execPath, file = UPDATE_INSTALLED_FILE } = {}) {
  const marker = readInstalledMarker(file);
  if (marker && samePath(marker.path, target)) fs.rmSync(file, { force: true });
}

/**
 * Gọi ĐẦU TIÊN khi `aivin remote start` khởi động. Đang chạy đúng bản vừa cài mà chưa được xác nhận: đếm lần khởi động; quá
 * MAX_BOOTS_BEFORE_ROLLBACK lần (mỗi lần sập trình giữ chạy mở lại) → trả bản cũ, ghi bản này vào danh sách bỏ qua.
 */
export function checkBootAfterUpdate({
  current = currentCliVersion(), target = process.execPath, maxBoots = MAX_BOOTS_BEFORE_ROLLBACK, platform = process.platform,
  stateFile = UPDATE_STATE_FILE, settingsFile = UPDATE_SETTINGS_FILE, markerFile = UPDATE_INSTALLED_FILE,
} = {}) {
  const state = readJson(stateFile);
  if (!state || !parseVersion(state.version) || !samePath(state.target, target)) return { action: BootAction.NONE };
  if (compareVersions(state.version, current) !== 0) {
    // Đang chạy bản khác bản vừa cài (người dùng đã lùi / cài đè) — trạng thái chờ hết nghĩa.
    fs.rmSync(stateFile, { force: true });
    return { action: BootAction.NONE };
  }
  // Lần trước dừng gọn (Ctrl+C, chuyển bản, thu hồi…) → không phải sập, không tính.
  const boots = (Number(state.boots) || 0) + (state.clean_exit ? 0 : 1);
  if (boots <= maxBoots || !state.backup || !fs.existsSync(state.backup)) {
    writeJson(stateFile, { ...state, boots, clean_exit: false });
    return { action: BootAction.PENDING, boots };
  }
  restoreBackup({ target, backup: state.backup, platform });
  const settings = loadUpdateSettings(settingsFile);
  saveUpdateSettings({ skip: [...new Set([...settings.skip, tagOf(state.version)])] }, settingsFile);
  fs.rmSync(stateFile, { force: true });
  fs.rmSync(markerFile, { force: true });
  return { action: BootAction.ROLLED_BACK, version: tagOf(state.version), previous: state.previous ? tagOf(state.previous) : null };
}

/** Daemon dừng gọn khi bản mới còn chờ xác nhận → lần khởi động sau không bị tính là sập. */
export function noteCleanExit({ current = currentCliVersion(), target = process.execPath, stateFile = UPDATE_STATE_FILE } = {}) {
  const state = readJson(stateFile);
  if (!state || !samePath(state.target, target) || compareVersions(state.version, current) !== 0) return;
  try { writeJson(stateFile, { ...state, clean_exit: true }); } catch { /* không ghi được → lần sau tính là sập, chậm lắm là lùi oan một bản */ }
}

/** Bản đang chạy ổn (nối được máy chủ, hoặc chạy đủ lâu) → bỏ bản cũ, hết theo dõi khởi động. */
export function confirmUpdate({ current = currentCliVersion(), target = process.execPath, stateFile = UPDATE_STATE_FILE } = {}) {
  const state = readJson(stateFile);
  if (!state || !samePath(state.target, target) || compareVersions(state.version, current) !== 0) return false;
  if (state.backup && fs.existsSync(state.backup)) {
    try { retire(state.backup); } catch { /* lần sau */ }
  }
  fs.rmSync(stateFile, { force: true });
  return true;
}

/**
 * Kiểm + cài bản mới nhất (hoặc `version` chỉ định — được lùi bản, bỏ qua danh sách bỏ qua và đợt phát hành). `check` = chỉ báo có bản
 * mới. `deviceId` (daemon) → tôn trọng `rollout.json` trừ khi `urgent` (máy chủ đòi bản tối thiểu). Trả `{ status, current, latest }`.
 * `binary` / `target` / `verify` / `keys` / các tệp: cho test.
 */
export async function installUpdate({
  version, root = downloadRoot(), check = false, force = false, urgent = false, deviceId, signal,
  binary = isStandaloneBinary(), target = process.execPath, current = currentCliVersion(), verify = verifyStarts, keys = RELEASE_PUBLIC_KEYS,
  markerFile = UPDATE_INSTALLED_FILE, stateFile = UPDATE_STATE_FILE, lockFile = UPDATE_LOCK_FILE, settingsFile = UPDATE_SETTINGS_FILE,
} = {}) {
  const latest = version ? tagOf(version) : await fetchLatestVersion({ root, signal });
  if (!parseVersion(latest)) throw new Error(`Phiên bản không hợp lệ: ${version}`);
  const result = { current: tagOf(current), latest };
  if (!force && compareVersions(latest, current) <= 0) return { ...result, status: UpdateStatus.UP_TO_DATE };
  if (!binary) return { ...result, status: UpdateStatus.NOT_BINARY };
  if (!version && loadUpdateSettings(settingsFile).skip.includes(latest)) return { ...result, status: UpdateStatus.SKIPPED };
  if (check) return { ...result, status: UpdateStatus.AVAILABLE };
  if (deviceId && !urgent && !version) {
    const rollout = await fetchRollout({ root, signal });
    if (rollout && rollout.version === latest && rolloutBucket(deviceId, latest) >= rollout.percent) return { ...result, status: UpdateStatus.DEFERRED };
  }
  return withUpdateLock(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-update-'));
    try {
      const file = await downloadRelease({ root, version: latest, asset: releaseAsset(), destDir: tmp, signal, keys });
      await verify(file, latest);
      let backup;
      try {
        backup = replaceBinary({ newFile: file, target });
      } catch (e) {
        throw new Error(`Không thay được ${target} (${e?.code || e?.message}) — cài lại bằng bộ cài: https://get.aivin.vn`, { cause: e });
      }
      writeJson(stateFile, { version: latest, previous: tagOf(current), target, backup, boots: 0, installed_at: new Date().toISOString() });
      writeJson(markerFile, { version: latest, path: target, installed_at: new Date().toISOString() });
      return { ...result, status: UpdateStatus.INSTALLED };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, lockFile);
}
