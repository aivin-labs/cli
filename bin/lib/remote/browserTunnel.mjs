import fs from 'fs';
import os from 'os';
import path from 'path';
import WSClient from 'ws';
import {
  AIVIN_BROWSER_PROFILE_DIR, DEBUG_PORTS, LOCAL_BROWSERS, detectDefaultBrowserId, launchLocalChromeWithDebugging, probeLocalChromeDebugger,
  resolveBrowserInstall,
} from '../localBrowser.mjs';
import { DeviceErrorCode } from './constants.mjs';
import { EXTENSION_SESSION_ALLOWED, applyDevicePolicy, executableDownloadGuid, isExtensionUrl } from './cdpPolicy.mjs';
import { activeBrowserEndpoint, browserPortFromProcesses, createCdpMux, findDailyBrowser } from './dailyBrowser.mjs';
import { proxyAgentFor } from './netProxy.mjs';
import { showOSNotification } from './notify.mjs';
import { DeviceToolError } from './sandbox.mjs';
import { createTabGrouper, groupTitle } from './tabGroups.mjs';

/**
 * Trình duyệt của máy cho AI Browser (CLI ≥ 1.0.8, 27/10/2026). BE gọi `browser.open_tunnel` khi một nhiệm vụ web chạy trên máy này: mở (hoặc dùng
 * lại) cửa sổ Chrome/Edge hồ sơ RIÊNG của Aivin (`~/.aivin/browser-profile`, dùng chung với `aivin browser` — đăng nhập một lần là dùng mãi, không
 * đụng trình duyệt hằng ngày của người dùng), rồi nối đường hầm CDP: một WebSocket tới `/browser-tunnel/external` của BE (xác thực bằng token MÁY)
 * và một tới cổng gỡ lỗi của trình duyệt, chuyển khung hai chiều nguyên văn. Mỗi nhiệm vụ / việc con một đường hầm (chạy song song được).
 *
 * Tệp AI tải trong cửa sổ đó vào `~/Downloads/Aivin` (BE đặt), BE đọc lại qua `browser.read_download` — chỉ đọc được trong thư mục này.
 *
 * Ưu tiên trình duyệt HẰNG NGÀY của người dùng nếu họ đã bật gỡ lỗi từ xa ở `chrome://inspect/#remote-debugging` (dailyBrowser.mjs, 27/10/2026):
 * dùng sẵn mọi đăng nhập; một kết nối chung (bấm Cho phép một lần), mỗi đường hầm một phiên riêng, tab của người dùng chỉ đọc. Người dùng không bật,
 * từ chối, hoặc chạy `--separate-browser` → cửa sổ riêng của Aivin như trên.
 *
 * Từ 29/10/2026 `aivin browser` (chế độ local) cũng đi qua bộ đường hầm này (xác thực bằng API key thay vì token máy) — trước đó nó có đường ống
 * riêng không qua `cdpPolicy.mjs` và nhận bừa Chrome / Edge nào đang nghe ở 9222–9225. Tab AI mở trong cửa sổ Aivin được gom vào một nhóm tab mỗi
 * đường hầm (tabGroups.mjs).
 */

const TUNNEL_ID_RE = /^[a-z0-9-]{8,64}$/i;
const MAX_READ_BYTES = 1024 * 1024;
const DOWNLOAD_WAIT_MS = 8000;
/** Chrome đổi tên khi trùng: `x.pdf` → `x (1).pdf`. */
const PARTIAL_SUFFIX = '.crdownload';
/** Người dùng từ chối / không bấm Cho phép → bấy nhiêu lâu dùng cửa sổ Aivin, không hỏi lại mỗi nhiệm vụ. */
const DAILY_RETRY_COOLDOWN_MS = 10 * 60_000;

export const AIVIN_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'Aivin');

/** Trình duyệt dùng được trên máy (Chrome / Edge) — ưu tiên trình duyệt mặc định. Không in gì (gửi trong hồ sơ máy). */
export function detectLocalBrowser() {
  try {
    const installed = LOCAL_BROWSERS.map(resolveBrowserInstall).filter(Boolean);
    if (!installed.length) return null;
    const defaultId = installed.length > 1 ? detectDefaultBrowserId() : null;
    const picked = installed.find((b) => b.id === defaultId) || installed[0];
    return { id: picked.id, name: picked.name };
  } catch {
    return null;
  }
}

/**
 * CDP của cửa sổ Aivin đang chạy, không có thì mở. Chỉ nhận trình duyệt chạy ĐÚNG hồ sơ Aivin (`DevToolsActivePort` trong
 * `~/.aivin/browser-profile`) — trước 28/10/2026 nhận bừa Chrome / Edge nào đang nghe ở 9222–9225, kể cả trình duyệt thật của người dùng mở cổng
 * gỡ lỗi (AI có toàn quyền CDP mà không qua lớp bảo vệ, không hỏi). Cổng bị dịch vụ / trình duyệt khác chiếm thì thử cổng kế bên.
 *
 * `ports` — cổng được thử khi phải mở mới (`aivin browser --debug-port` ghim một cổng); `launch: false` — chỉ dùng lại, không mở (nối lại sau khi rớt
 * mạng: người dùng đã đóng cửa sổ thì không tự mở lại giữa chừng). `browserId` trả về là trình duyệt THẬT đang chạy (`edge` / `chrome`, Brave và
 * Chromium báo là `chrome`).
 */
export async function ensureAivinBrowser(preferredId, { ports = DEBUG_PORTS, launch = true, log } = {}) {
  const running = await activeBrowserEndpoint(AIVIN_BROWSER_PROFILE_DIR);
  if (running) return { wsUrl: running.wsUrl, browserId: (await probeLocalChromeDebugger(running.port)).browserId || preferredId, port: running.port };
  // Cửa sổ Aivin đang mở mà không ghi DevToolsActivePort (Edge với cổng cố định) → dùng lại theo dòng lệnh tiến trình, không mở thêm.
  const processPort = await browserPortFromProcesses(AIVIN_BROWSER_PROFILE_DIR);
  if (processPort) {
    const { wsUrl, browserId } = await probeLocalChromeDebugger(processPort);
    if (wsUrl) return { wsUrl, browserId: browserId || preferredId, port: processPort };
  }
  if (!launch) throw new DeviceToolError(DeviceErrorCode.BROWSER_NOT_FOUND, 'The Aivin browser window is no longer running');
  const conflicts = [];
  let freePort;
  for (const port of ports) {
    const probed = await probeLocalChromeDebugger(port);
    if (probed.wsUrl) { conflicts.push(`${port} (another browser profile)`); continue; }
    if (probed.conflict) { conflicts.push(`${port} (${probed.conflict})`); continue; }
    if (freePort === undefined) freePort = port;
  }
  if (freePort === undefined) throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Browser debug ports are all taken by other services: ${conflicts.join(', ')}`);
  try {
    const wsUrl = await launchLocalChromeWithDebugging(freePort, preferredId, log ? { log } : undefined);
    return { wsUrl, browserId: (await probeLocalChromeDebugger(freePort)).browserId || preferredId, port: freePort, launched: true };
  } catch (e) {
    const notFound = /could not find/i.test(e?.message || '');
    throw new DeviceToolError(notFound ? DeviceErrorCode.BROWSER_NOT_FOUND : DeviceErrorCode.EXECUTION_FAILED, e?.message || String(e));
  }
}

/** Token máy / header xác thực: chuỗi, hoặc hàm trả giá trị hiện hành (daemon xoay vòng token khi đang chạy). */
const tokenOf = (t) => (typeof t === 'function' ? t() : t);

/** Khung trình duyệt gửi lên có thể đáng xem (gắn / gỡ phiên, tab mới, trả lời có targetId) — so chuỗi trước, chỉ parse khi cần. */
const UPSTREAM_INTEREST_RE = /attachedToTarget|detachedFromTarget|targetCreated|targetInfoChanged|"targetId"/;

/**
 * Hai WebSocket nối nhau (BE ↔ trình duyệt), chờ cả hai mở. Một đầu đóng → đóng đầu kia. Lệnh BE gửi xuống đi qua bộ lọc `cdpPolicy.mjs`, cộng:
 * không lệnh nào vào phiên / đích `chrome-extension://` ngoài `EXTENSION_SESSION_ALLOWED` (tiện ích gom nhóm tab có quyền `debugger`).
 * `onAivinTarget(targetId)` — tab AI vừa mở (`Target.createTarget` của BE, hoặc tab bật ra từ tab đó).
 */
export function pipeTunnel({ relayUrl, authorization, chromeWsUrl, signal, downloadsDir, onAivinTarget = () => {} }) {
  const toBackend = new WSClient(relayUrl, { headers: { Authorization: authorization }, agent: proxyAgentFor(relayUrl) });
  const toChrome = new WSClient(chromeWsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  const extensionTargets = new Set();
  const extensionSessions = new Set();
  const aivinTargets = new Set();
  const pendingCreates = new Set(); // `${sessionId}:${id}` của lệnh Target.createTarget chưa có trả lời
  const close = () => {
    try { toBackend.close(); } catch { /* đã đóng */ }
    try { toChrome.close(); } catch { /* đã đóng */ }
  };
  const relay = (from, to) => {
    from.on('message', (data, isBinary) => { if (to.readyState === WSClient.OPEN) to.send(data, { binary: isBinary }); });
    from.on('close', close);
    from.on('error', close);
  };
  const extensionBlock = (msg) => {
    if (msg.sessionId && extensionSessions.has(msg.sessionId) && !EXTENSION_SESSION_ALLOWED.has(msg.method)) return `${msg.method} is not allowed on browser extensions`;
    if (msg.method === 'Target.attachToTarget' && extensionTargets.has(msg.params?.targetId)) return 'Attaching to browser extensions is not allowed';
    return null;
  };
  toBackend.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    const { msg: out, error: policyError } = applyDevicePolicy(msg, { downloadsDir });
    const error = policyError || extensionBlock(msg);
    if (error) {
      if (msg.id !== undefined && toBackend.readyState === WSClient.OPEN) {
        toBackend.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), error: { code: -32000, message: error } }));
      }
      return;
    }
    if (msg.method === 'Target.createTarget' && msg.id !== undefined) pendingCreates.add(`${msg.sessionId || ''}:${msg.id}`);
    if (toChrome.readyState === WSClient.OPEN) toChrome.send(JSON.stringify(out));
  });
  toBackend.on('close', close);
  toBackend.on('error', close);
  const noteTarget = (info) => {
    if (!info?.targetId) return;
    if (isExtensionUrl(info.url)) extensionTargets.add(info.targetId);
  };
  const markAivin = (targetId) => {
    if (!targetId || aivinTargets.has(targetId)) return;
    aivinTargets.add(targetId);
    try { onAivinTarget(targetId); } catch { /* gom nhóm chỉ là hiển thị */ }
  };
  // Tệp chạy được AI bắt đầu tải → huỷ ngay ở trình duyệt (không để nằm lại trong thư mục tải của máy).
  let cancelId = 2_000_000_000;
  toChrome.on('message', (data) => {
    const text = String(data);
    const guid = executableDownloadGuid(text);
    if (guid && toChrome.readyState === WSClient.OPEN) toChrome.send(JSON.stringify({ id: cancelId++, method: 'Browser.cancelDownload', params: { guid } }));
    if (!UPSTREAM_INTEREST_RE.test(text)) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const params = msg.params || {};
    if (msg.id !== undefined) {
      const key = `${msg.sessionId || ''}:${msg.id}`;
      if (pendingCreates.delete(key) && msg.result?.targetId) markAivin(msg.result.targetId);
      // Target.getTargets / getTargetInfo: biết đích tiện ích trước khi BE xin gắn thẳng vào nó.
      for (const info of msg.result?.targetInfos || []) noteTarget(info);
      noteTarget(msg.result?.targetInfo);
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      noteTarget(params.targetInfo);
      if (params.sessionId && isExtensionUrl(params.targetInfo?.url)) extensionSessions.add(params.sessionId);
    } else if (msg.method === 'Target.detachedFromTarget') {
      extensionSessions.delete(params.sessionId);
    } else if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
      noteTarget(params.targetInfo);
      // Tab bật ra từ tab AI (window.open, target=_blank) cũng là của AI.
      const info = params.targetInfo;
      if (msg.method === 'Target.targetCreated' && info?.type === 'page' && aivinTargets.has(info.openerId)) markAivin(info.targetId);
    }
  });
  relay(toChrome, toBackend);
  const opened = (ws) => new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res?.statusCode}`)));
  });
  const onAbort = () => close();
  signal?.addEventListener('abort', onAbort, { once: true });
  const ready = Promise.all([opened(toBackend), opened(toChrome)])
    .finally(() => signal?.removeEventListener('abort', onAbort));
  const done = new Promise((resolve) => { toBackend.once('close', resolve); });
  return { ready, close, done };
}

/** Đường hầm trên kết nối chung tới trình duyệt hằng ngày: BE ↔ một phiên riêng của bộ chia. Khung BE gửi trước khi phiên sẵn sàng được giữ lại. */
function pipeTunnelToMux({ relayUrl, authorization, mux, signal }) {
  const toBackend = new WSClient(relayUrl, { headers: { Authorization: authorization }, agent: proxyAgentFor(relayUrl) });
  let client = null;
  let closed = false;
  const early = [];
  const close = () => {
    if (closed) return;
    closed = true;
    try { toBackend.close(); } catch { /* đã đóng */ }
    client?.close();
  };
  toBackend.on('message', (data) => { if (client) client.send(String(data)); else early.push(String(data)); });
  toBackend.on('close', close);
  toBackend.on('error', close);
  const onAbort = () => close();
  signal?.addEventListener('abort', onAbort, { once: true });
  const ready = (async () => {
    await new Promise((resolve, reject) => {
      toBackend.once('open', resolve);
      toBackend.once('error', reject);
      toBackend.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res?.statusCode}`)));
    });
    client = await mux.attach((text) => { if (toBackend.readyState === WSClient.OPEN) toBackend.send(text); }, close);
    if (closed) { client.close(); return; }
    for (const frame of early.splice(0)) client.send(frame);
  })().finally(() => signal?.removeEventListener('abort', onAbort));
  const done = new Promise((resolve) => { toBackend.once('close', resolve); });
  return { ready, close, done };
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new DeviceToolError(DeviceErrorCode.CANCELLED, 'The server stopped waiting for the browser');
}

/** Bản Chrome tự đánh số của cùng một tên: `bao-cao.pdf`, `bao-cao (1).pdf`… */
export function matchesDownloadName(file, wanted) {
  if (file === wanted) return true;
  const ext = path.extname(wanted);
  const base = wanted.slice(0, wanted.length - ext.length);
  return file.startsWith(`${base} (`) && file.endsWith(`)${ext}`) && /^\d+$/.test(file.slice(base.length + 2, file.length - ext.length - 1));
}

/** Tệp tải xong mới nhất trùng tên, sửa sau `since` (ms). Chờ một chút — Chrome có thể vừa đổi tên `.crdownload`. */
async function findDownload(dir, name, since, signal) {
  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  do {
    const names = await fs.promises.readdir(dir).catch(() => []);
    const candidates = [];
    for (const n of names) {
      if (n.endsWith(PARTIAL_SUFFIX) || !matchesDownloadName(n, name)) continue;
      const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
      if (st?.isFile() && st.mtimeMs >= since - 2000) candidates.push({ n, st });
    }
    candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (candidates.length) return { name: candidates[0].n, size: candidates[0].st.size };
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 300));
  } while (Date.now() < deadline);
  return null;
}

/**
 * Bộ đường hầm của daemon: `open` / `readDownload` cho hai công cụ nội bộ, `closeAll` khi dừng. `env.serverUrl` + `env.deviceToken` lấy từ thông
 * tin ghép máy. `ensureBrowser` thay được trong test (không mở trình duyệt thật).
 *
 * `authorization` — header xác thực đầy đủ (chuỗi / hàm), thay cho `Device <token máy>`: `aivin browser` dùng `Bearer <API key>`.
 * `say(text, event)` — `event` là dạng có cấu trúc của cùng thông báo (`{ type, browser, … }`) cho nơi gọi muốn tự viết câu (`aivin browser` nói
 * tiếng Anh). `groupTabs` — gom tab AI mở trong cửa sổ Aivin thành một nhóm tab mỗi đường hầm (tabGroups.mjs).
 */
export function createBrowserTunnels({
  serverUrl, deviceToken, authorization, browser, downloadsDir = AIVIN_DOWNLOADS_DIR, say = () => {}, ensureBrowser = ensureAivinBrowser,
  useDailyBrowser = true, findDaily = findDailyBrowser, createMux = createCdpMux, notify = showOSNotification,
  groupTabs = true, createGrouper = createTabGrouper,
}) {
  const live = new Map(); // tunnelId → { close, done, deliberate }
  let daily = null;
  let dailyCooldownUntil = 0;
  let grouper = null; // { wsUrl, g } — một bộ gom nhóm cho cửa sổ Aivin đang dùng
  const authHeader = () => (authorization ? tokenOf(authorization) : `Device ${tokenOf(deviceToken)}`);

  function grouperFor(wsUrl) {
    if (!groupTabs || !wsUrl) return null;
    if (grouper?.wsUrl !== wsUrl) {
      grouper?.g.close();
      const g = createGrouper({
        wsUrl,
        onUnavailable: (e) => say(`🗂️  Không gom nhóm tab được (${e?.message || e}) — đóng rồi mở lại cửa sổ Aivin để bật.`, { type: 'groups-unavailable', reason: e?.message || String(e) }),
      });
      grouper = { wsUrl, g };
    }
    return grouper.g;
  }

  /** Kết nối chung tới trình duyệt hằng ngày (lần đầu trình duyệt hỏi người dùng). Không bật / bị từ chối → null (dùng cửa sổ Aivin). */
  async function dailyBrowser() {
    if (!useDailyBrowser || Date.now() < dailyCooldownUntil) return null;
    const found = await findDaily(browser?.id).catch(() => null);
    if (!found) return null;
    if (!daily || daily.wsUrl !== found.wsUrl) {
      daily?.mux.close();
      const blockedSeen = new Set();
      const onBlocked = ({ method, reason, targetId }) => {
        if (blockedSeen.has(method) || blockedSeen.size > 50) return;
        blockedSeen.add(method);
        say(`🛡️ Đã chặn ${method} trên ${found.name} của bạn — ${reason}${targetId ? ` (tab ${String(targetId).slice(0, 8)})` : ''}`, { type: 'blocked', browser: found.name, method, reason });
      };
      const onClosed = () => say(`🔌 Đã nhả ${found.name} hằng ngày của bạn`, { type: 'released', browser: found.name });
      daily = { ...found, mux: createMux({ wsUrl: found.wsUrl, downloadsDir, onBlocked, onClosed }) };
    }
    if (!daily.mux.isOpen()) {
      say(`🔐 ${found.name} đang hỏi: cho phép Aivin dùng trình duyệt này? Bấm "Allow" / "Cho phép" trên cửa sổ ${found.name}.`, { type: 'consent', browser: found.name });
      notify({ title: `Aivin muốn dùng ${found.name} của bạn`, body: `Bấm "Allow" trên hộp thoại của ${found.name} để AI làm việc bằng các tài khoản bạn đã đăng nhập.` });
    }
    try {
      await daily.mux.connect();
      return daily;
    } catch (e) {
      dailyCooldownUntil = Date.now() + DAILY_RETRY_COOLDOWN_MS;
      say(`↩️  ${found.name} chưa cho phép (${e?.message || e}) — dùng cửa sổ riêng của Aivin.`, { type: 'daily-declined', browser: found.name, reason: e?.message || String(e) });
      return null;
    }
  }

  async function open(args, ctx) {
    const tunnelId = String(args?.tunnel_id || '');
    if (!TUNNEL_ID_RE.test(tunnelId)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Invalid tunnel_id');
    const shared = await dailyBrowser();
    // Máy chủ đã bỏ cuộc (hết `open_timeout_ms`) trong lúc chờ Cho phép / mở cửa sổ → không nối đường hầm mồ côi.
    assertNotAborted(ctx?.signal);
    const { wsUrl } = shared ? { wsUrl: null } : await ensureBrowser(browser?.id);
    assertNotAborted(ctx?.signal);
    await fs.promises.mkdir(downloadsDir, { recursive: true }).catch(() => undefined);
    const relayUrl = `${serverUrl.replace(/^http/i, 'ws')}/browser-tunnel/external?tunnel_id=${encodeURIComponent(tunnelId)}`;
    const g = shared ? null : grouperFor(wsUrl);
    const title = groupTitle(typeof args?.label === 'string' ? args.label : '');
    const tunnel = shared
      ? pipeTunnelToMux({ relayUrl, authorization: authHeader(), mux: shared.mux, signal: ctx?.signal })
      : pipeTunnel({
        relayUrl, authorization: authHeader(), chromeWsUrl: wsUrl, signal: ctx?.signal, downloadsDir,
        onAivinTarget: (targetId) => { g?.add(targetId, { key: tunnelId, title }); },
      });
    try {
      await tunnel.ready;
    } catch (e) {
      tunnel.close();
      throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Could not open the browser tunnel: ${e?.message || e}`);
    }
    if (ctx?.signal?.aborted) {
      tunnel.close();
      assertNotAborted(ctx.signal);
    }
    const entry = { close: tunnel.close, deliberate: false };
    close(tunnelId); // BE mở lại cùng tunnel_id (thử lại phía máy chủ) → thay đường hầm cũ
    live.set(tunnelId, entry);
    // `ctx.onClose({ deliberate })` — đường hầm đóng: do `close(tunnelId)` / `closeAll()` (deliberate) hay tự rớt (mạng, trình duyệt bị đóng).
    tunnel.done.then(() => {
      if (live.get(tunnelId) === entry) live.delete(tunnelId);
      g?.forget(tunnelId);
      ctx?.onClose?.({ deliberate: entry.deliberate });
    });
    const name = shared?.name || browser?.name || '';
    say(
      shared ? `🌐 AI đang dùng ${shared.name} hằng ngày của bạn (tab mới, mở ở nền)` : `🌐 AI đang dùng trình duyệt ${name ? `${name} ` : ''}trên máy này`,
      { type: 'using', browser: name, daily: !!shared },
    );
    return { browser: shared?.name || browser?.name, downloads_dir: downloadsDir, ...(shared ? { daily: true } : {}) };
  }

  async function readDownload(args, ctx) {
    const name = String(args?.name || '');
    if (!name || name !== path.basename(name) || name.includes('..')) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Invalid file name');
    const hit = await findDownload(downloadsDir, name, Number(args?.since) || 0, ctx?.signal);
    if (!hit) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Downloaded file not found: ${name}`);
    const offset = Math.max(0, Number(args?.offset) || 0);
    const length = Math.min(Math.max(0, Number(args?.length) || MAX_READ_BYTES), MAX_READ_BYTES, Math.max(0, hit.size - offset));
    const full = path.join(downloadsDir, hit.name);
    const handle = await fs.promises.open(full, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return { name: hit.name, path: full, size: hit.size, offset, content: buf.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= hit.size };
    } finally {
      await handle.close();
    }
  }

  /** Đóng một đường hầm (chủ động — `ctx.onClose` nhận `deliberate: true`). */
  function close(tunnelId) {
    const entry = live.get(tunnelId);
    if (!entry) return;
    entry.deliberate = true;
    entry.close();
  }

  function closeAll() {
    for (const entry of live.values()) {
      entry.deliberate = true;
      entry.close();
    }
    live.clear();
    daily?.mux.close();
    daily = null;
    grouper?.g.close();
    grouper = null;
  }

  return { open, readDownload, close, closeAll, liveCount: () => live.size };
}
