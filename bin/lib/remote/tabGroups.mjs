import fs from 'fs';
import os from 'os';
import path from 'path';
import WSClient from 'ws';

/**
 * Gom các tab AI đang làm vào một nhóm tab (tab group) trong cửa sổ Aivin (29/10/2026) — mỗi đường hầm (nhiệm vụ) một nhóm, có tên + màu riêng.
 *
 * CDP không có lệnh nào cho nhóm tab — chỉ API tiện ích `chrome.tabGroups` làm được. Nên CLI ghi một tiện ích nhỏ vào `~/.aivin/browser-extension/
 * tab-groups` và nạp qua CDP (`Extensions.loadUnpacked` — Chrome 137+ bỏ qua `--load-extension`; cần cửa sổ mở với
 * `--enable-unsafe-extension-debugging`, localBrowser.mjs thêm cờ này), rồi chạy hàm `aivinGroup` trong service worker của tiện ích qua một kết nối CDP
 * riêng của CLI. Đích CDP → id tab: `chrome.debugger.getTargets()` (quyền `debugger`; chỉ liệt kê, không gắn vào tab nào).
 *
 * Chỉ cho cửa sổ Aivin: trình duyệt hằng ngày của người dùng không mở với cờ đó và CLI không cài gì vào hồ sơ của họ. Cửa sổ Aivin mở bởi bản CLI cũ
 * (không có cờ) → bỏ qua, không lỗi; đóng mở lại cửa sổ là có. Máy chủ không đụng được tiện ích: cdpPolicy.mjs chặn `Extensions.*` và mọi lệnh vào
 * phiên của đích `chrome-extension://`.
 */

export const TAB_GROUPS_SW_FILE = 'aivin-tab-groups.js';
export const TAB_GROUPS_EXTENSION_DIR = path.join(os.homedir(), '.aivin', 'browser-extension', 'tab-groups');
/** Màu của Chrome cho nhóm tab — xoay vòng để các nhiệm vụ chạy song song phân biệt được. */
export const GROUP_COLORS = ['blue', 'purple', 'cyan', 'green', 'orange', 'pink', 'yellow', 'red'];
const CALL_TIMEOUT_MS = 5000;

const MANIFEST = {
  manifest_version: 3,
  name: 'Aivin tab groups',
  version: '1.0.0',
  description: 'Groups the tabs Aivin\'s AI Browser is working in. Loaded by the aivin CLI.',
  permissions: ['tabGroups', 'debugger'],
  background: { service_worker: TAB_GROUPS_SW_FILE },
};

// Nhúng dạng chuỗi (không phải tệp trong gói): bản chạy một tệp (bun build) không mang theo thư mục tài nguyên.
const SW_SOURCE = `// Aivin tab groups - written by the aivin CLI, which calls aivinGroup() over CDP.
// Keep the worker alive: Chrome stops an idle service worker after 30 s, any extension API call resets that timer.
setInterval(() => chrome.runtime.getPlatformInfo(), 20000);

/** Groups the tabs behind CDP target ids into groupId (if it still exists) or a new group. Returns the group id, or null. */
self.aivinGroup = async ({ targetIds, groupId, title, color }) => {
  let tabIds = [];
  // The tab may not be listed yet right after Target.createTarget returns.
  for (let i = 0; i < 20; i++) {
    const targets = await chrome.debugger.getTargets();
    tabIds = targets.filter((t) => targetIds.includes(t.id) && t.tabId !== undefined).map((t) => t.tabId);
    if (tabIds.length === targetIds.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!tabIds.length) return null;
  if (groupId !== null && groupId !== undefined) {
    try {
      await chrome.tabGroups.get(groupId);
      return await chrome.tabs.group({ groupId, tabIds });
    } catch {
      // the user closed / ungrouped it - start a new group below
    }
  }
  const created = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(created, { title, color, collapsed: false });
  return created;
};
`;

/** Ghi (hoặc cập nhật) tệp tiện ích vào `dir`, trả `dir`. Không đổi thì không ghi lại. */
export function ensureTabGroupsExtension(dir = TAB_GROUPS_EXTENSION_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const files = { 'manifest.json': `${JSON.stringify(MANIFEST, null, 2)}\n`, [TAB_GROUPS_SW_FILE]: SW_SOURCE };
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    let current = null;
    try { current = fs.readFileSync(full, 'utf8'); } catch { /* chưa có */ }
    if (current !== content) fs.writeFileSync(full, content);
  }
  return dir;
}

/** Tên nhóm: gọn một dòng, tối đa `max` ký tự. */
export function groupTitle(label, max = 28) {
  const s = String(label || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Aivin';
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Bộ gom nhóm cho MỘT trình duyệt (`wsUrl` cấp trình duyệt của cửa sổ Aivin). `add(targetId, { key, title })` đưa tab vào nhóm của `key` (đường hầm);
 * không bao giờ ném lỗi — gom nhóm chỉ là tiện ích hiển thị. Nạp tiện ích không được → tắt hẳn cho trình duyệt này, gọi `onUnavailable` một lần.
 */
export function createTabGrouper({ wsUrl, extensionDir, WebSocketImpl = WSClient, onUnavailable = () => {} }) {
  let ws = null;
  let connecting = null;
  let worker = null; // sessionId của phiên gắn vào service worker
  let disabled = false;
  let closed = false;
  let nextId = 1;
  let colorIndex = 0;
  const pending = new Map();
  const groups = new Map(); // key → { groupId, color }
  const queues = new Map(); // key → Promise — các tab của cùng một nhóm gom lần lượt (không tạo hai nhóm)

  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocketImpl.OPEN) { reject(new Error('Browser connection closed')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const connect = () => {
    if (ws && ws.readyState === WebSocketImpl.OPEN) return Promise.resolve();
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const sock = new WebSocketImpl(wsUrl, { perMessageDeflate: false });
      sock.once('open', () => { ws = sock; connecting = null; resolve(); });
      sock.once('error', (e) => { connecting = null; reject(e); });
      sock.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        const p = msg.id !== undefined ? pending.get(msg.id) : null;
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result || {});
      });
      sock.on('close', () => {
        if (ws === sock) { ws = null; worker = null; }
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser connection closed')); }
        pending.clear();
      });
    });
    return connecting;
  };

  const findWorker = async () => {
    const { targetInfos = [] } = await call('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && /^(chrome|edge)-extension:\/\//.test(t.url || '') && t.url.endsWith(`/${TAB_GROUPS_SW_FILE}`));
  };

  /** Gắn vào service worker của tiện ích; chưa nạp (hoặc `reload` — bản cũ thiếu hàm) thì nạp. Không được → ném lỗi. */
  const attachWorker = async ({ reload = false } = {}) => {
    await connect();
    let sw = reload ? null : await findWorker();
    if (!sw) {
      await call('Extensions.loadUnpacked', { path: extensionDir || ensureTabGroupsExtension() });
      for (let i = 0; i < 30 && !sw; i++) {
        await new Promise((r) => setTimeout(r, 100));
        sw = await findWorker();
      }
    }
    if (!sw) throw new Error('The tab groups extension did not start');
    const { sessionId } = await call('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await call('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    worker = sessionId;
  };

  const groupNow = async (targetId, key, title) => {
    let entry = groups.get(key);
    if (!entry) {
      entry = { groupId: null, color: GROUP_COLORS[colorIndex++ % GROUP_COLORS.length] };
      groups.set(key, entry);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!worker) {
        try {
          await attachWorker({ reload: attempt > 0 });
        } catch (e) {
          disabled = true;
          onUnavailable(e);
          return;
        }
      }
      let res;
      try {
        const args = { targetIds: [targetId], groupId: entry.groupId, title, color: entry.color };
        res = await call('Runtime.evaluate', { expression: `self.aivinGroup(${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, worker);
      } catch {
        worker = null; // service worker đã dừng / phiên rớt — gắn lại một lần
        continue;
      }
      if (res.exceptionDetails) {
        // Bản tiện ích cũ hơn (không có aivinGroup) → nạp lại; lỗi khác (tab vừa đóng…) thì thôi.
        if (/aivinGroup/.test(JSON.stringify(res.exceptionDetails))) { worker = null; continue; }
        return;
      }
      if (typeof res.result?.value === 'number') entry.groupId = res.result.value;
      return;
    }
  };

  return {
    add(targetId, { key = 'aivin', title = 'Aivin' } = {}) {
      if (disabled || closed || !targetId) return Promise.resolve();
      const prev = queues.get(key) || Promise.resolve();
      const next = prev.then(() => (disabled || closed ? undefined : groupNow(targetId, key, title))).catch(() => undefined);
      queues.set(key, next);
      return next;
    },
    /** Đường hầm đóng: quên nhóm của nó (nhóm trong trình duyệt vẫn còn tới khi người dùng đóng tab). */
    forget(key) {
      groups.delete(key);
      queues.delete(key);
    },
    close() {
      closed = true;
      try { ws?.close(); } catch { /* đã đóng */ }
    },
    isDisabled: () => disabled,
  };
}
