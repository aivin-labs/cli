import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { LOCAL_BROWSERS, resolveBrowserInstall } from '../localBrowser.mjs';
import { verifySpawnArgs } from './agentEvidence.mjs';
import { agentEnv } from './sandbox.mjs';
import { killWindowsTree } from './winTree.mjs';

/**
 * Chụp app của một job lập trình đang chạy thật (cổng khớp wireframe, 18/11/2026). BE gọi `agent.preview` SAU khi job đo xong và trước khi gỡ
 * worktree: chạy lệnh mở app (`preview.argv` của hồ sơ dự án) TRONG worktree của job, chờ địa chỉ trả lời, chụp từng đường dẫn bằng Chrome / Edge
 * không giao diện (hồ sơ tạm riêng, không đụng trình duyệt của người dùng), rồi tắt cả cây tiến trình. Ảnh PNG trả về dạng base64 — BE so với
 * wireframe bằng model nhìn.
 *
 * An toàn: địa chỉ phải là máy này (localhost / 127.0.0.1 / ::1); địa chỉ đã có ai trả lời TRƯỚC khi chạy lệnh → từ chối (đang chụp nhầm một
 * app khác, vd bản dev ở thư mục chính). Không ném lỗi khi app không lên — trả `error` để BE ghi "không đo được".
 */

export const PREVIEW_MAX_SHOTS = 8;
const PREVIEW_MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const POLL_MS = 500;
const SHOT_TIMEOUT_MS = 45_000;
const DEFAULT_READY_MS = 90_000;
const LOG_TAIL_CHARS = 2000;
const STOP_WAIT_MS = 8000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const VIEWPORTS = { desktop: [1280, 800], tablet: [820, 1180], mobile: [390, 844] };

/** Chrome / Edge cài trên máy (ưu tiên Chrome) — null khi không có. */
export function findPreviewBrowser(resolve = resolveBrowserInstall) {
  for (const b of [...LOCAL_BROWSERS].sort((a, z) => (a.id === 'chrome' ? -1 : z.id === 'chrome' ? 1 : 0))) {
    const found = resolve(b);
    if (found?.exe) return found.exe;
  }
  return null;
}

/** Kiểm đầu vào: địa chỉ cục bộ http(s), đường dẫn bắt đầu bằng `/`, tối đa PREVIEW_MAX_SHOTS ảnh. Ném Error khi sai. */
export function normalizePreviewArgs(args) {
  let base;
  try { base = new URL(String(args?.url || '')); } catch { throw new Error('url must be an http(s) address on this computer'); }
  if (!/^https?:$/.test(base.protocol) || !LOCAL_HOSTS.has(base.hostname)) throw new Error('url must be http(s)://localhost (or 127.0.0.1) — the app started for this job');
  const argv = Array.isArray(args?.argv) ? args.argv.map(String) : [];
  if (!argv.length || argv.some((a) => !a || /[\r\n]/.test(a))) throw new Error('argv: the command that starts the app, as words');
  const shots = (Array.isArray(args?.shots) ? args.shots : []).slice(0, PREVIEW_MAX_SHOTS).map((s, i) => {
    const p = String(s?.path || '/');
    if (!p.startsWith('/') || /\s/.test(p)) throw new Error(`shots[${i}].path must start with /`);
    const vp = VIEWPORTS[s?.device] || VIEWPORTS.desktop;
    return { id: String(s?.id || `shot_${i + 1}`).slice(0, 40), url: new URL(p, base).toString(), width: vp[0], height: vp[1] };
  });
  if (!shots.length) throw new Error('shots: at least one { id, path }');
  const ready = Math.min(Math.max(5_000, Number(args?.ready_timeout_ms) || DEFAULT_READY_MS), 600_000);
  return { base: base.toString(), argv, shots, readyTimeoutMs: ready };
}

/** Địa chỉ có trả lời HTTP không (bất kỳ mã nào). */
export function urlResponds(url, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function runHeadless(browser, args, { spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(browser, args, { stdio: 'ignore', windowsHide: true }); } catch { resolve(false); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* đã thoát */ } resolve(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', () => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * Chạy app trong `cwd`, chụp các ảnh, tắt app. Trả `{ shots: [{ id, url, png_base64?, error? }], error?, log_tail? }`.
 * `spawnApp` / `spawnBrowser` / `responds` cho test.
 */
export async function capturePreview(args, {
  cwd, browser = findPreviewBrowser(), spawnApp = spawn, spawnBrowser = spawn, responds = urlResponds, signal, tmpRoot = os.tmpdir(), env: baseEnv = process.env,
} = {}) {
  const p = normalizePreviewArgs(args);
  if (!cwd || !fs.existsSync(cwd)) return { error: 'the job worktree is gone — nothing to start', shots: [] };
  if (!browser) return { error: 'no Chrome / Edge on this computer to take screenshots', shots: [] };
  if (await responds(p.base)) return { error: `${p.base} already answers before the app was started — another program uses that address; stop it or change preview.url`, shots: [] };

  const env = { ...agentEnv(baseEnv), BROWSER: 'none', CI: 'true' };
  let spawnArgs;
  try { spawnArgs = verifySpawnArgs(p.argv, { env }); } catch (e) { return { error: e.message, shots: [] }; }
  const [file, cmdArgs, extra] = spawnArgs;
  const startedAt = Date.now();
  let tail = '';
  let exited = null;
  let app;
  try {
    app = spawnApp(file, cmdArgs, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  } catch (e) {
    return { error: `cannot start the app: ${e.message}`, shots: [] };
  }
  const onData = (d) => { tail = (tail + String(d)).slice(-LOG_TAIL_CHARS); };
  app.stdout?.on('data', onData);
  app.stderr?.on('data', onData);
  app.on?.('exit', (code) => { exited = code ?? -1; });
  app.on?.('error', (e) => { exited = -1; tail += `\n${e.message}`; });
  // Tắt app và CHỜ nó thoát (taskkill chạy nền): job sau / bản dev của người dùng dùng lại được địa chỉ ngay.
  const stopApp = async () => {
    if (exited !== null) return;
    const gone = new Promise((r) => { app.once?.('exit', r); setTimeout(r, STOP_WAIT_MS); });
    if (process.platform === 'win32') killWindowsTree(app, startedAt);
    else { try { process.kill(-app.pid, 'SIGKILL'); } catch { try { app.kill('SIGKILL'); } catch { /* đã thoát */ } } }
    await gone;
    // Cây con (vd npm → vite) còn giữ địa chỉ sau khi tiến trình gốc thoát: chờ địa chỉ thôi trả lời.
    for (let i = 0; i < STOP_WAIT_MS / POLL_MS && await responds(p.base); i++) await new Promise((r) => setTimeout(r, POLL_MS));
  };
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'aivin-preview-'));
  try {
    const deadline = Date.now() + p.readyTimeoutMs;
    let up = false;
    while (!up && Date.now() < deadline && exited === null && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      up = await responds(p.base);
    }
    if (signal?.aborted) return { error: 'cancelled', shots: [] };
    if (!up) return { error: exited !== null ? `the app exited (code ${exited}) before ${p.base} answered` : `${p.base} did not answer within ${Math.round(p.readyTimeoutMs / 1000)} s`, shots: [], log_tail: tail.trim() || undefined };
    const shots = [];
    let total = 0;
    for (const s of p.shots) {
      const png = path.join(profile, `${s.id.replace(/[^A-Za-z0-9_-]/g, '_')}.png`);
      await runHeadless(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--hide-scrollbars',
        // Máy tổ chức: daemon chạy bằng root — Chromium từ chối chạy root khi còn sandbox.
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        `--user-data-dir=${path.join(profile, 'profile')}`, `--window-size=${s.width},${s.height}`, '--virtual-time-budget=6000', `--screenshot=${png}`, s.url,
      ], { spawnImpl: spawnBrowser, timeoutMs: SHOT_TIMEOUT_MS });
      if (!fs.existsSync(png)) { shots.push({ id: s.id, url: s.url, error: 'screenshot failed' }); continue; }
      const buf = fs.readFileSync(png);
      if (total + buf.length > PREVIEW_MAX_TOTAL_BYTES) { shots.push({ id: s.id, url: s.url, error: 'too large to send' }); continue; }
      total += buf.length;
      shots.push({ id: s.id, url: s.url, width: s.width, height: s.height, png_base64: buf.toString('base64') });
    }
    return { shots, log_tail: tail.trim() || undefined };
  } finally {
    await stopApp();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* thư mục tạm */ }
  }
}
