import fs from 'fs';
import net from 'net';
import path from 'path';
import { execFile } from 'child_process';
import WSClient from 'ws';
import { LOCAL_BROWSERS, resolveBrowserInstall } from '../localBrowser.mjs';
import { applyDevicePolicy, executableDownloadGuid } from './cdpPolicy.mjs';

/**
 * Trình duyệt HẰNG NGÀY của người dùng cho AI Browser (27/10/2026) — dùng sẵn mọi đăng nhập, không phải đăng nhập lại trong cửa sổ Aivin.
 *
 * Chrome 136+ không cho `--remote-debugging-port` trên hồ sơ mặc định. Cách Chrome / Edge cho phép (Chrome 144+): người dùng tự bật "Allow remote
 * debugging for this browser instance" ở `chrome://inspect/#remote-debugging` (Edge: `edge://inspect` → Remote debugging); trình duyệt ghi cổng +
 * đường dẫn WebSocket vào `<thư mục dữ liệu>/DevToolsActivePort`, và MỖI kết nối mới hiện hộp thoại xin phép. Vì vậy CLI giữ MỘT kết nối duy nhất
 * (người dùng bấm Cho phép một lần) và chia cho mọi đường hầm: mỗi đường hầm một phiên trình duyệt riêng (`Target.attachToBrowserTarget`, chế độ
 * phiên phẳng) — Puppeteer phía BE thấy như một kết nối gốc của riêng nó.
 *
 * Lớp bảo vệ trình duyệt của người dùng (không phải cửa sổ riêng của Aivin) — DANH SÁCH CHO PHÉP (rà 28/10/2026: danh sách chặn cũ để lọt
 * `Network.enable` trên tab người dùng → lộ header / cookie / dữ liệu gửi đi, `Target.exposeDevToolsProtocol` mở kênh CDP ngoài tầm lọc…):
 *   - phiên trình duyệt của đường hầm: chỉ các lệnh `Target.*` / `Browser.*` Puppeteer cần (`BROWSER_SESSION_ALLOWED`);
 *   - tab KHÔNG do AI mở (tab của người dùng): chỉ khởi động / gỡ phiên gắn (`USER_TAB_ALLOWED`) — không bật miền nào, không điều hướng, gõ, bấm,
 *     chạy script, đóng;
 *   - tab AI mở: điều khiển như thường, trừ lệnh đụng kho cookie / dữ liệu của cả hồ sơ (`DAILY_BLOCKED`);
 *   - cộng bộ lọc chung `cdpPolicy.mjs` (không `file://`, ép thư mục tải, không chọn tệp trên đĩa…).
 * Tab mới mở ở nền (không giật tiêu điểm khỏi việc người dùng đang làm).
 */

/**
 * Chờ người dùng bấm Cho phép trên hộp thoại của trình duyệt. Cộng thời gian mở cửa sổ Aivin (dự phòng) phải nằm gọn trong `open_timeout_ms` 45 s
 * của máy chủ — trước 28/10/2026 chờ 35 s + mở cửa sổ ~10 s vượt trần, nhiệm vụ hỏng thay vì chuyển sang cửa sổ Aivin.
 */
export const CONSENT_TIMEOUT_MS = 20_000;
/** Không còn đường hầm nào bấy nhiêu lâu → nhả kết nối (thanh "đang bị điều khiển" biến mất; lần sau hỏi lại). */
export const IDLE_CLOSE_MS = 30 * 60_000;

/** Phiên trình duyệt của một đường hầm: chỉ quản lý tab / phiên — các lệnh khác ở cấp trình duyệt đụng tới cả hồ sơ của người dùng. */
const BROWSER_SESSION_ALLOWED = new Set([
  'Target.setDiscoverTargets', 'Target.setAutoAttach', 'Target.getTargets', 'Target.getTargetInfo', 'Target.createTarget', 'Target.closeTarget',
  'Target.activateTarget', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.getBrowserContexts', 'Target.createBrowserContext',
  'Target.disposeBrowserContext', 'Browser.getVersion', 'Browser.getWindowForTarget', 'Browser.cancelDownload',
]);

/** Tab của người dùng (không do AI mở): Puppeteer tự gắn mọi tab để biết danh sách — chỉ cho khởi động lại tab đang chờ và gỡ phiên. */
const USER_TAB_ALLOWED = new Set([
  'Runtime.runIfWaitingForDebugger', 'Target.setAutoAttach', 'Target.detachFromTarget', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
]);

/** Kể cả trên tab AI mở: kho cookie / dữ liệu / cửa sổ của cả hồ sơ người dùng (cookie httpOnly của mọi site đã đăng nhập). */
const DAILY_BLOCKED = new Set([
  'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies',
  'Network.clearBrowserCache', 'Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies', 'Storage.clearDataForOrigin',
  'Storage.clearDataForStorageKey', 'Browser.grantPermissions', 'Browser.resetPermissions', 'Browser.setPermission', 'Browser.setWindowBounds',
  'Browser.setDownloadBehavior', 'Tracing.start',
]);

/** Trang người dùng bật "cho phép gỡ lỗi từ xa" của trình duyệt (Edge dùng tiền tố riêng). */
export function remoteDebuggingPage(browserId) {
  return browserId === 'edge' ? 'edge://inspect/#remote-debugging' : 'chrome://inspect/#remote-debugging';
}

/** `DevToolsActivePort`: dòng 1 cổng, dòng 2 đường dẫn WebSocket (`/devtools/browser/<id>`). Không có / sai → null. */
export function parseDevToolsActivePort(text) {
  const [portLine, pathLine] = String(text || '').split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(String(pathLine || '').trim())) return null;
  return { port, path: pathLine.trim() };
}

function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Đầu nối CDP của trình duyệt đang chạy trên thư mục dữ liệu `dir` (theo `DevToolsActivePort`, cổng đang nghe) — không có → null. */
export async function activeBrowserEndpoint(dir, { isOpen = portOpen } = {}) {
  let active;
  try {
    active = parseDevToolsActivePort(await fs.promises.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8'));
  } catch {
    return null;
  }
  if (!active || !(await isOpen(active.port))) return null;
  return { port: active.port, wsUrl: `ws://127.0.0.1:${active.port}${active.path}` };
}

/**
 * Cổng gỡ lỗi trong DÒNG LỆNH của một tiến trình trình duyệt chạy đúng thư mục dữ liệu `dir` (`--user-data-dir=<dir>` +
 * `--remote-debugging-port=<cổng>`, cổng 0 thì không tính). Sai thư mục / không có cổng → null. So đường dẫn không phân biệt hoa thường,
 * bỏ dấu nháy và dấu `\`/`/` cuối.
 */
export function debugPortFromCommandLine(commandLine, dir) {
  const cmd = String(commandLine || '');
  const norm = (p) => String(p || '').replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const dataDir = /--user-data-dir=("[^"]+"|'[^']+'|\S+)/.exec(cmd)?.[1];
  if (!dataDir || norm(dataDir) !== norm(dir)) return null;
  const port = Number(/--remote-debugging-port=(\d+)/.exec(cmd)?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function listProcessCommandLines() {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe'\" | ForEach-Object { $_.CommandLine }"]]
      : ['ps', ['-axo', 'args=']];
    execFile(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : String(stdout).split(/\r?\n/)));
  });
}

/**
 * Trình duyệt đang chạy trên thư mục dữ liệu `dir` mà KHÔNG có `DevToolsActivePort` (28/10/2026: Edge 156 mở với cổng cố định không ghi
 * tệp này → CLI tưởng chưa có cửa sổ, mở thêm Edge cùng hồ sơ, tiến trình mới chỉ chuyển giao cho cửa sổ cũ rồi thoát — mọi nhiệm vụ sau lần
 * đầu báo "debug port never came up"). Tìm theo dòng lệnh tiến trình: chỉ nhận đúng thư mục `dir`, không nhận bừa trình duyệt khác đang mở
 * cổng gỡ lỗi. Trả cổng đang nghe, không có → null.
 */
export async function browserPortFromProcesses(dir, { list = listProcessCommandLines, isOpen = portOpen } = {}) {
  const ports = [...new Set((await list()).map((line) => debugPortFromCommandLine(line, dir)).filter(Boolean))];
  for (const port of ports) if (await isOpen(port)) return port;
  return null;
}

/**
 * Chrome / Edge hằng ngày đang chạy và đã bật gỡ lỗi từ xa (có `DevToolsActivePort` trong thư mục dữ liệu mặc định, cổng đang nghe). Trình duyệt
 * mặc định / đã chọn xét trước. Không có → null (dùng cửa sổ riêng của Aivin).
 */
export async function findDailyBrowser(preferredId, { browsers = LOCAL_BROWSERS, resolve = resolveBrowserInstall, isOpen = portOpen } = {}) {
  const ordered = [...browsers].sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId));
  for (const b of ordered) {
    const install = resolve(b);
    if (!install?.profileDir) continue;
    const active = await activeBrowserEndpoint(install.profileDir, { isOpen });
    if (active) return { id: install.id, name: install.name, wsUrl: active.wsUrl };
  }
  return null;
}

/**
 * Một kết nối tới trình duyệt hằng ngày, chia cho nhiều đường hầm. `connect()` mở (hoặc dùng lại) kết nối — lần đầu trình duyệt hỏi người dùng;
 * `attach(toClient, onClose)` → đường hầm mới `{ send(text), close() }`.
 */
export function createCdpMux({ wsUrl, downloadsDir, consentTimeoutMs = CONSENT_TIMEOUT_MS, idleCloseMs = IDLE_CLOSE_MS, WebSocketImpl = WSClient, onClosed = () => {}, onBlocked = () => {} }) {
  let upstream = null;
  let opening = null;
  let nextId = 1;
  let idleTimer = null;
  const pending = new Map();
  /**
   * sessionId → { client, targetId?, type?, parent?, aivin } — phiên do mux mở cho đường hầm (phiên trình duyệt) hoặc trình duyệt gắn vào sau.
   * Puppeteer ≥ 23 gắn theo hai lớp: phiên `tab` → bên trong là phiên `page`. Chuyển sang tên miền khác (Google chuyển hướng qua accounts.google.com)
   * trình duyệt đổi sang một đích `page` MỚI trong cùng tab — nhận là của AI nhờ phiên `tab` cha (chạy thật 28/10/2026: không nhận → mọi lệnh trên
   * trang mới bị chặn như tab của người dùng, điều hướng treo 30 s).
   */
  const sessions = new Map();
  /** Tab AI mở (và tab bật ra từ chúng) — chỉ những tab này được điều khiển / đóng. */
  const aivinTargets = new Set();
  const clients = new Set();
  let downloadsTouched = false;

  const rootCall = (method, params = {}) => new Promise((resolve, reject) => {
    if (!upstream || upstream.readyState !== WebSocketImpl.OPEN) { reject(new Error('Browser connection closed')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    upstream.send(JSON.stringify({ id, method, params }));
  });

  const shutdown = () => {
    clearTimeout(idleTimer);
    for (const p of pending.values()) p.reject(new Error('Browser connection closed'));
    pending.clear();
    for (const c of [...clients]) c.close();
    sessions.clear();
    upstream = null;
    opening = null;
    onClosed();
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (clients.size || !idleCloseMs) return;
    idleTimer = setTimeout(() => { try { upstream?.close(); } catch { /* đã đóng */ } }, idleCloseMs);
    idleTimer.unref?.();
  };

  const isAivinSession = (sid) => !!sessions.get(sid)?.aivin;
  /** Tab của AI — kể cả phiên đã gắn trước khi kết quả `createTarget` về (tự gắn chạy ngay lúc tạo tab). */
  const markAivin = (targetId) => {
    aivinTargets.add(targetId);
    for (const [sid, s] of sessions) {
      if (s.targetId !== targetId) continue;
      s.aivin = true;
      markTabAivin(s.type === 'tab' ? sid : s.parent);
    }
  };
  /** Tab chứa trang của AI thuộc AI — mọi trang con của nó (kể cả trang mới sau khi đổi tên miền) cũng vậy. */
  const markTabAivin = (sid) => {
    const tab = sid ? sessions.get(sid) : null;
    if (!tab || tab.type !== 'tab') return;
    tab.aivin = true;
    if (tab.targetId) aivinTargets.add(tab.targetId);
    for (const s of sessions.values()) {
      if (s.parent !== sid || s.aivin) continue;
      s.aivin = true;
      if (s.targetId) aivinTargets.add(s.targetId);
    }
  };

  const onUpstreamMessage = (data) => {
    // Tệp chạy được AI bắt đầu tải → huỷ ngay (không để nằm lại trong thư mục tải của người dùng).
    const execGuid = executableDownloadGuid(data);
    if (execGuid) rootCall('Browser.cancelDownload', { guid: execGuid }).catch(() => undefined);
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg.sessionId) {
      const p = msg.id !== undefined ? pending.get(msg.id) : null;
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result || {});
      }
      return;
    }
    const owner = sessions.get(msg.sessionId);
    if (!owner) return;
    const { client } = owner;
    track(client, msg);
    const out = msg.sessionId === client.browserSession ? (({ sessionId: _s, ...rest }) => rest)(msg) : msg;
    client.toClient(JSON.stringify(out));
  };

  /** Ghi sổ phiên / tab của AI theo kết quả + sự kiện trình duyệt gửi về. */
  const track = (client, msg) => {
    const key = `${msg.sessionId}:${msg.id}`;
    if (msg.id !== undefined) {
      const req = client.requests.get(key);
      client.requests.delete(key);
      if (req && msg.result) {
        if (req.method === 'Target.createTarget' && msg.result.targetId) markAivin(msg.result.targetId);
        if (req.method === 'Target.attachToTarget' && msg.result.sessionId) {
          sessions.set(msg.result.sessionId, { client, targetId: req.targetId, aivin: aivinTargets.has(req.targetId) });
        }
      }
      return;
    }
    const params = msg.params || {};
    if (msg.method === 'Target.targetCreated' && aivinTargets.has(params.targetInfo?.openerId)) markAivin(params.targetInfo.targetId);
    if (msg.method === 'Target.attachedToTarget' && params.sessionId) {
      const targetId = params.targetInfo?.targetId;
      // Khung con / worker của tab AI thuộc AI; tab bật ra từ tab AI cũng vậy.
      const parent = msg.sessionId !== client.browserSession ? msg.sessionId : undefined;
      const aivin = aivinTargets.has(targetId) || aivinTargets.has(params.targetInfo?.openerId) || (!!parent && isAivinSession(parent));
      if (aivin && targetId) aivinTargets.add(targetId);
      sessions.set(params.sessionId, { client, targetId, type: params.targetInfo?.type, parent, aivin });
      if (aivin) markTabAivin(params.targetInfo?.type === 'tab' ? params.sessionId : parent);
    }
    if (msg.method === 'Target.detachedFromTarget' && params.sessionId) sessions.delete(params.sessionId);
    if (msg.method === 'Target.targetDestroyed' && params.targetId) aivinTargets.delete(params.targetId);
  };

  /** Lý do chặn một lệnh của đường hầm (null = cho qua). */
  const blockReason = (client, sid, method, params) => {
    if (DAILY_BLOCKED.has(method)) return `${method} is not allowed on the user's own browser`;
    if (method === 'Target.detachFromTarget' && params.sessionId && sessions.get(params.sessionId)?.client !== client) return 'Unknown session';
    if (sid === client.browserSession) {
      if (!BROWSER_SESSION_ALLOWED.has(method)) return `${method} is not allowed on the user's own browser`;
      if (method === 'Target.closeTarget' && !aivinTargets.has(params.targetId)) return 'Only tabs opened by Aivin can be closed';
      if (method === 'Target.activateTarget' && !aivinTargets.has(params.targetId)) return 'Only tabs opened by Aivin can be focused';
      return null;
    }
    if (!sessions.get(sid)?.aivin && !USER_TAB_ALLOWED.has(method)) return `Tabs not opened by Aivin are read-only (${method})`;
    return null;
  };

  const connect = () => {
    if (upstream && upstream.readyState === WebSocketImpl.OPEN) return Promise.resolve();
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: consentTimeoutMs });
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try { ws.terminate?.(); } catch { /* đã đóng */ }
        opening = null;
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error('The browser did not allow the connection in time')), consentTimeoutMs);
      ws.once('error', (e) => { clearTimeout(timer); fail(e); });
      ws.once('unexpected-response', (_req, res) => { clearTimeout(timer); fail(new Error(`HTTP ${res?.statusCode}`)); });
      ws.once('open', () => {
        upstream = ws;
        ws.on('message', onUpstreamMessage);
        ws.on('close', () => { if (upstream === ws) shutdown(); });
        // Hộp thoại xin phép có thể hiện SAU khi bắt tay: chờ lệnh đầu tiên được trả lời mới coi là đã cho phép.
        rootCall('Browser.getVersion').then(() => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          opening = null;
          armIdle();
          resolve();
        }, (e) => { clearTimeout(timer); fail(e); });
      });
    });
    return opening;
  };

  /** Đường hầm mới trên kết nối chung: một phiên trình duyệt riêng. */
  const attach = async (toClient, onClose = () => {}) => {
    await connect();
    const { sessionId } = await rootCall('Target.attachToBrowserTarget');
    let closed = false;
    const client = {
      browserSession: sessionId,
      requests: new Map(),
      toClient: (text) => { if (!closed) toClient(text); },
      send(text) {
        if (closed) return;
        let msg;
        try { msg = JSON.parse(String(text)); } catch { return; }
        const sid = msg.sessionId || client.browserSession;
        const owned = sessions.get(sid)?.client === client;
        const policy = applyDevicePolicy(msg, { downloadsDir });
        if (policy.msg) msg = policy.msg;
        const params = msg.params || {};
        const reason = policy.error || (owned ? blockReason(client, sid, msg.method, params) : 'Unknown session');
        if (reason) {
          onBlocked({ method: msg.method, reason, targetId: sessions.get(sid)?.targetId });
          if (msg.id !== undefined) toClient(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), error: { code: -32000, message: reason } }));
          return;
        }
        if (msg.id !== undefined) client.requests.set(`${sid}:${msg.id}`, { method: msg.method, targetId: params.targetId });
        // Thư mục tải đặt qua một trang áp cho cả hồ sơ: nhớ để trả về mặc định khi đường hầm cuối cùng đóng (tệp người dùng tự tải về đúng chỗ cũ).
        if (msg.method === 'Page.setDownloadBehavior') client.setDownloads = true;
        // Tab mới mở ở nền: không giật tiêu điểm khỏi cửa sổ người dùng đang làm việc.
        const outParams = msg.method === 'Target.createTarget' && params.background === undefined ? { ...params, background: true } : msg.params;
        upstream?.send(JSON.stringify({ ...msg, ...(outParams ? { params: outParams } : {}), sessionId: sid }));
      },
      close() {
        if (closed) return;
        closed = true;
        clients.delete(client);
        for (const [sid, s] of [...sessions]) if (s.client === client) sessions.delete(sid);
        client.requests.clear();
        if (client.setDownloads) downloadsTouched = true;
        if (downloadsTouched && !clients.size) {
          downloadsTouched = false;
          rootCall('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => undefined);
        }
        rootCall('Target.detachFromTarget', { sessionId }).catch(() => undefined);
        armIdle();
        onClose();
      },
    };
    sessions.set(sessionId, { client, aivin: false });
    clients.add(client);
    clearTimeout(idleTimer);
    return client;
  };

  return {
    connect,
    attach,
    close: () => { try { upstream?.close(); } catch { /* đã đóng */ } },
    isOpen: () => !!upstream && upstream.readyState === WebSocketImpl.OPEN,
    clientCount: () => clients.size,
  };
}
