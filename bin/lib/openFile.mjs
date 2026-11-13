import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { createHash } from 'crypto';
import { fetchWebUrl } from './context.mjs';
import { defaultWebUrl } from './servers.mjs';
import { startPreviewServer } from './localPreview.mjs';
import { missionAuthHeaders, missionServerUrl, resolveWorkspace } from './workspace.mjs';
import { spawn } from 'child_process';
import { LoginApp, browserLogin, openBrowser, saveGlobalApiKey, tryFetchWhoami } from './auth.mjs';
import { LOCAL_BROWSERS, detectDefaultBrowserId, resolveBrowserInstall } from './localBrowser.mjs';
import { mascotLang } from './remote/mascot/strings.mjs';

/**
 * `aivin open <tệp>` (04/11/2026) — mở tệp trên máy bằng Drive của Aivin (chưa đăng nhập: trang chỉ-xem, localPreview.mjs). Đã đăng nhập: tải lên workspace cá nhân (hoặc --workspace) rồi mở
 * `<web>/drive?open_file=<id>&workspace_id=<ws>` (deep-link sẵn có của FE, FileShareHook.useOpenFileDeepLink).
 *
 * Drive là bản chính sau khi mở: cùng NỘI DUNG (sha256) đã tải trước đó → mở lại đúng tệp Drive cũ (giữ mọi chỉnh sửa trên Aivin);
 * tệp trên máy đã đổi → tải thành tệp Drive MỚI, không ghi đè bản Drive (có thể đã sửa trên Aivin).
 */

export const OPEN_INDEX_FILE = path.join(os.homedir(), '.aivin', 'opened-files.json');
const MAX_INDEX_ENTRIES = 500;
const DEFAULT_WEB_URL = 'https://app.aivin.cloud';

export const OpenDisplay = Object.freeze({ WINDOW: 'window', TAB: 'tab', NONE: 'none' });

export const OpenFileError = Object.freeze({
  NOT_FOUND: 'not_found',
  NOT_A_FILE: 'not_a_file',
  NOT_LOGGED_IN: 'not_logged_in',
  UPLOAD_FAILED: 'upload_failed',
});

/** Chữ hiện cho người dùng (dòng lệnh + thông báo hệ điều hành), theo ngôn ngữ máy (mascotLang). */
const OPEN_TEXT = Object.freeze({
  vi: {
    [OpenFileError.NOT_FOUND]: 'Không tìm thấy tệp: {path}',
    [OpenFileError.NOT_A_FILE]: 'Không phải tệp: {path}',
    [OpenFileError.NOT_LOGGED_IN]: 'Máy này chưa đăng nhập Aivin — mở Terminal và chạy: aivin login',
    [OpenFileError.UPLOAD_FAILED]: 'Tải "{name}" lên Drive không được: {reason}',
    opening: 'Đang mở "{name}" trên Aivin…',
    uploading: 'Đang tải "{name}" lên Drive… ({percent}%)',
    processing: 'Đang xử lý "{name}" và mở tài liệu…',
    failed_title: 'Không mở được bằng AIVIN Bot',
  },
  en: {
    [OpenFileError.NOT_FOUND]: 'File not found: {path}',
    [OpenFileError.NOT_A_FILE]: 'Not a file: {path}',
    [OpenFileError.NOT_LOGGED_IN]: 'This computer is not signed in to Aivin — open a terminal and run: aivin login',
    [OpenFileError.UPLOAD_FAILED]: 'Could not upload "{name}" to Drive: {reason}',
    opening: 'Opening "{name}" in Aivin…',
    uploading: 'Uploading "{name}" to Drive… ({percent}%)',
    processing: 'Processing "{name}" and opening document…',
    failed_title: 'Could not open with AIVIN Bot',
  },
});

export function openText(key, vars = {}, lang = mascotLang()) {
  const table = OPEN_TEXT[lang] || OPEN_TEXT.en;
  return String(table[key] ?? OPEN_TEXT.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export class OpenFileFailure extends Error {
  constructor(code, vars = {}, cause) {
    super(openText(code, vars), cause ? { cause } : undefined);
    this.code = code;
  }
}

export function fileSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Khoá chỉ mục: cùng máy chủ + workspace + nội dung (đổi tài khoản / máy chủ không dùng nhầm tệp của nơi khác). */
export function indexKey({ baseUrl, workspaceId, sha256 }) {
  return `${baseUrl}|${workspaceId}|${sha256}`;
}

export function readOpenIndex(file = OPEN_INDEX_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Ghi chỉ mục, giữ tối đa MAX_INDEX_ENTRIES mục mở gần nhất. */
export function writeOpenIndex(index, file = OPEN_INDEX_FILE) {
  const entries = Object.entries(index)
    .sort((a, b) => String(b[1]?.opened_at || '').localeCompare(String(a[1]?.opened_at || '')))
    .slice(0, MAX_INDEX_ENTRIES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2));
  fs.renameSync(tmp, file);
}

export function driveOpenUrl(webUrl, { fileId, workspaceId }) {
  const params = new URLSearchParams({ open_file: fileId, workspace_id: workspaceId });
  return `${String(webUrl).replace(/\/+$/, '')}/drive?${params.toString()}`;
}

function readLocalFile(filePath) {
  const abs = path.resolve(filePath);
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { throw new OpenFileFailure(OpenFileError.NOT_FOUND, { path: abs }, e); }
  if (!stat.isFile()) throw new OpenFileFailure(OpenFileError.NOT_A_FILE, { path: abs });
  return { abs, name: path.basename(abs), buffer: fs.readFileSync(abs) };
}

/** Tệp Drive đã tải trước đó còn mở được không (bị xoá / mất quyền → tải lại). */
async function driveFileExists(serverUrl, auth, { workspaceId, fileId }) {
  try {
    await axios.get(`${serverUrl}/fileshare/${encodeURIComponent(workspaceId)}/${encodeURIComponent(fileId)}`, { ...auth, timeout: 20_000 });
    return true;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404 || status === 403 || status === 400) return false;
    throw e;
  }
}

async function uploadToDrive(serverUrl, auth, { workspaceId, name, buffer }, onProgress) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  try {
    const res = await axios.post(`${serverUrl}/fileshare/${encodeURIComponent(workspaceId)}/upload`, form, {
      ...auth, maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 10 * 60_000,
      onUploadProgress: (e) => {
        if (e.total && onProgress) {
          const percent = Math.min(100, Math.round((e.loaded * 100) / e.total));
          onProgress(percent);
        }
      },
    });
    if (onProgress) onProgress(100, 'processing');
    const id = res.data?.id || res.data?._id;
    if (!id) throw new Error('no file id in the upload response');
    return String(id);
  } catch (e) {
    const reason = e?.response?.data?.message || e?.message || e?.code || 'unknown error';
    throw new OpenFileFailure(OpenFileError.UPLOAD_FAILED, { name, reason }, e);
  }
}

async function findReusable(serverUrl, auth, { index, key }) {
  const hit = index[key];
  if (!hit?.file_id) return null;
  return (await driveFileExists(serverUrl, auth, { workspaceId: hit.workspace_id, fileId: hit.file_id })) ? hit.file_id : null;
}

/**
 * Cửa sổ ứng dụng (`--app=`): không thanh địa chỉ / tab, biểu tượng riêng trên taskbar. Chỉ dùng trình duyệt MẶC ĐỊNH và chỉ khi nó là Chromium —
 * phiên đăng nhập Aivin nằm ở đó; trình duyệt khác sẽ bắt đăng nhập lại, nên Firefox / chưa rõ thì trả null (mở tab thường).
 */
export function appWindowCommand(url, { defaultId = detectDefaultBrowserId(), resolve = resolveBrowserInstall } = {}) {
  const browser = LOCAL_BROWSERS.find((b) => b.id === defaultId);
  const install = browser ? resolve(browser) : null;
  return install ? { exe: install.exe, args: ['--start-maximized', `--app=${url}`] } : null;
}

/**
 * Windows: `--start-maximized` chỉ có hiệu lực khi trình duyệt KHỞI ĐỘNG. Edge/Chrome đang chạy (Edge còn chạy nền sẵn nhờ startup boost) thì
 * tiến trình mới chỉ chuyển lệnh cho tiến trình cũ → cờ bị bỏ qua, cửa sổ app mở cỡ mặc định. Nên PowerShell mở trình duyệt rồi tự phóng to
 * cửa sổ mới lên trước (cùng cách khay LaunchPlatformApp). Đường dẫn + tham số qua biến môi trường, không phải lo thoát ký tự.
 */
const WINDOWS_MAXIMIZE_SCRIPT = [
  "$sig = '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'",
  '$w = Add-Type -MemberDefinition $sig -Name AivinOpenWindow -Namespace Aivin -PassThru',
  '$before = $w::GetForegroundWindow()',
  '$name = [IO.Path]::GetFileNameWithoutExtension($env:AIVIN_OPEN_EXE)',
  '[void][Diagnostics.Process]::Start($env:AIVIN_OPEN_EXE, $env:AIVIN_OPEN_ARGS)',
  'for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 100; $h = $w::GetForegroundWindow(); if ($h -ne [IntPtr]::Zero -and $h -ne $before) { $p = [uint32]0; [void]$w::GetWindowThreadProcessId($h, [ref]$p); try { if ((Get-Process -Id $p).ProcessName -eq $name) { [void]$w::ShowWindowAsync($h, 3); break } } catch { } } }',
].join('; ');

function spawnDirect(cmd, url) {
  const child = spawn(cmd.exe, cmd.args, { detached: true, stdio: 'ignore' });
  child.on('error', () => openBrowser(url));
  child.unref();
}

function openInWindow(url) {
  const cmd = appWindowCommand(url);
  if (!cmd) return openBrowser(url);
  if (process.platform !== 'win32') return spawnDirect(cmd, url);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_MAXIMIZE_SCRIPT], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, AIVIN_OPEN_EXE: cmd.exe, AIVIN_OPEN_ARGS: cmd.args.map((a) => `"${a}"`).join(' ') },
  });
  child.on('error', () => spawnDirect(cmd, url));
  child.unref();
}

function showUrl(url, mode) {
  if (mode === OpenDisplay.WINDOW) openInWindow(url);
  else if (mode === OpenDisplay.TAB) openBrowser(url);
}

async function resolveWebUrl(serverUrl) {
  return process.env.AIVIN_WEB_URL || (await fetchWebUrl(serverUrl)) || defaultWebUrl(serverUrl) || DEFAULT_WEB_URL;
}

/**
 * Tải (hoặc dùng lại) rồi mở. Trả `{ url, fileId, workspaceId, reused }`; lỗi → OpenFileFailure.
 * `display`: OpenDisplay — cửa sổ riêng (mặc định), tab thường, hoặc chỉ trả đường dẫn (--print).
 */
export async function openLocalFile(filePath, { workspace, display: displayMode = OpenDisplay.WINDOW, indexFile = OPEN_INDEX_FILE, onProgress } = {}) {
  if (!process.env.API_KEY) throw new OpenFileFailure(OpenFileError.NOT_LOGGED_IN);
  const local = readLocalFile(filePath);
  const serverUrl = missionServerUrl();
  const auth = missionAuthHeaders();
  const ws = await resolveWorkspace(serverUrl, auth, workspace);
  const workspaceId = String(ws.id || ws._id);
  const sha256 = fileSha256(local.buffer);
  const key = indexKey({ baseUrl: serverUrl, workspaceId, sha256 });

  const index = readOpenIndex(indexFile);
  const reusedId = await findReusable(serverUrl, auth, { index, key });
  const fileId = reusedId || await uploadToDrive(serverUrl, auth, { workspaceId, name: local.name, buffer: local.buffer }, onProgress);

  index[key] = { file_id: fileId, workspace_id: workspaceId, name: local.name, path: local.abs, opened_at: new Date().toISOString() };
  try { writeOpenIndex(index, indexFile); } catch { /* chỉ mất lần dùng lại sau */ }

  const url = driveOpenUrl(await resolveWebUrl(serverUrl), { fileId, workspaceId });
  showUrl(url, displayMode);
  return { url, fileId, workspaceId, reused: !!reusedId, name: local.name };
}

const isAuthRejected = (error) => (error?.cause?.response?.status ?? error?.response?.status) === 401;

/** Nút đăng nhập trên trang xem: đăng nhập qua trình duyệt, lưu khoá, tải tệp lên Drive, trả link trình soạn để chính cửa sổ đó chuyển sang. */
async function loginAndUpload(filePath, workspace) {
  const serverUrl = missionServerUrl();
  if (!process.env.AIVIN_WEB_URL) process.env.AIVIN_WEB_URL = await resolveWebUrl(serverUrl);
  // Trang xem mở từ "Mở bằng AIVIN Bot": người dùng đang ở app desktop, không phải terminal.
  const apiKey = await browserLogin({ app: LoginApp.DESKTOP, serverUrl });
  saveGlobalApiKey(apiKey, serverUrl, await tryFetchWhoami(serverUrl, apiKey));
  process.env.API_KEY = apiKey;
  const { url } = await openLocalFile(filePath, { workspace, display: OpenDisplay.NONE });
  return url;
}

let activePreviews = 0;

/** Chưa đăng nhập: trang chỉ-xem tại máy. Tiến trình sống tới khi mọi trang đã đóng. */
async function openViewOnly(filePath, { workspace, display: mode = OpenDisplay.WINDOW }) {
  const abs = readLocalFile(filePath).abs;
  activePreviews++;
  const { url } = await startPreviewServer({
    filePath: abs,
    serverUrl: missionServerUrl(),
    onLogin: () => loginAndUpload(abs, workspace),
    onClosed: () => { if (--activePreviews === 0) process.exit(process.exitCode ?? 0); },
  });
  showUrl(url, mode);
  return { url, name: path.basename(abs), viewOnly: true };
}

/** Lối vào của `aivin open`: đã đăng nhập → trình soạn trên Drive; chưa đăng nhập hoặc khoá đã bị thu hồi → trang chỉ-xem. */
export async function openFile(filePath, options = {}) {
  if (!process.env.API_KEY) return openViewOnly(filePath, options);
  try {
    return await openLocalFile(filePath, options);
  } catch (error) {
    if (!isAuthRejected(error)) throw error;
    delete process.env.API_KEY;
    return openViewOnly(filePath, options);
  }
}
