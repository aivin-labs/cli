import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { DeviceErrorCode, ToolGroup } from '../constants.mjs';
import { DeviceToolError, resolveInRoots } from '../sandbox.mjs';
import { showOSNotification } from '../notify.mjs';
import { createWindowsHost } from './windowsHost.mjs';

/**
 * Tầng điều khiển giao diện (28/10/2026, đợt 1: Windows). Nhìn cửa sổ bằng cây trợ năng của hệ điều hành (UI Automation) + ảnh khi cây
 * nghèo; thao tác theo "pattern" (Invoke / Value / Toggle…) trước, chuột / phím giả lập sau. Mọi thao tác ghi trả bằng chứng đọc lại
 * sau khi làm (giá trị mới, tiêu đề cửa sổ, phần tử còn / mất).
 *
 * Sàn cứng trên máy (BE không đổi được): không gõ vào ô mật khẩu (host chặn), không điều khiển ứng dụng nhạy cảm (`BLOCKED_PROCESSES`),
 * máy chỉ mở thư mục (không toàn quyền) thì không điều khiển cửa sổ dòng lệnh / registry — không lách vùng thư mục bằng cách gõ lệnh
 * vào terminal; người dùng đang dùng chuột / phím → dừng (`GUI_USER_ACTIVE`).
 */

/** Tiến trình không bao giờ điều khiển: quản lý mật khẩu, hộp nâng quyền, bảo mật hệ thống, màn hình khoá. */
const BLOCKED_PROCESSES = new Set([
  'consent', 'credentialuihost', 'lockapp', 'logonui', 'securityhealthsystray', 'securityhealthhost', 'windowsdefender', 'msmpeng',
  'keepass', 'keepassxc', '1password', 'bitwarden', 'lastpass', 'dashlane', 'enpass', 'nordpass', 'roboform',
]);
/** Chỉ cho khi máy toàn quyền — điều khiển được những thứ này là chạy lệnh tuỳ ý ngoài vùng thư mục. */
const SHELL_PROCESSES = new Set([
  'cmd', 'powershell', 'pwsh', 'windowsterminal', 'wt', 'openconsole', 'conhost', 'regedit', 'mmc', 'taskmgr', 'wsl', 'bash', 'mintty',
]);
/** Không mở tệp có đuôi chạy được bằng `gui.open_app` (mở = chạy chương trình). */
const EXECUTABLE_EXT = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|scr|pif|hta|cpl|jar|reg|url|appref-ms|application)$/i;

const OBSERVE_MAX_NODES = 300;
const APPS_CACHE_MS = 10 * 60_000;
const OPEN_WAIT_MS = 10_000;
/** Báo người dùng "AI đang điều khiển" một lần mỗi quãng này (lần thao tác ghi đầu tiên). */
const NOTIFY_EVERY_MS = 5 * 60_000;

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

export const GuiAction = Object.freeze({
  CLICK: 'click', DOUBLE_CLICK: 'double_click', RIGHT_CLICK: 'right_click', SET_VALUE: 'set_value', TYPE: 'type', KEY: 'key',
  SCROLL: 'scroll', SELECT: 'select', TOGGLE: 'toggle', EXPAND: 'expand', COLLAPSE: 'collapse', DRAG: 'drag',
});

/** Năng lực GUI khai trong hồ sơ máy. Chỉ Windows ở đợt này; máy tính tổ chức (nhiều người chung) không có màn hình. */
export function detectGui({ disabled = false, multiUser = false, platform = process.platform } = {}) {
  if (disabled || multiUser || platform !== 'win32') return null;
  // Phiên 0 (dịch vụ) không có màn hình tương tác.
  if (process.env.SESSIONNAME === 'Services') return null;
  return { backend: 'uia', actions: Object.values(GuiAction) };
}

const normalizeProcess = (name) => String(name || '').toLowerCase().replace(/\.exe$/, '');

/** Ứng dụng này có được điều khiển không — ném lỗi nếu bị chặn. */
export function assertWindowAllowed(windowInfo, { fullAccess }) {
  const proc = normalizeProcess(windowInfo?.process);
  if (!proc) return;
  if (BLOCKED_PROCESSES.has(proc)) throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, `Controlling "${windowInfo.process}" is not allowed on this device`);
  if (!fullAccess && SHELL_PROCESSES.has(proc)) {
    throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, `Controlling "${windowInfo.process}" needs full device access (aivin remote start --full-access)`);
  }
}

const normalizeName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Chọn ứng dụng theo tên: trùng hẳn > bắt đầu bằng > chứa. Nhiều ứng viên ngang nhau → trả danh sách để Planner chọn lại. */
export function matchApps(apps, query) {
  const q = normalizeName(query);
  if (!q) return [];
  const scored = apps.map((app) => {
    const n = normalizeName(app.name);
    const score = n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0;
    return { app, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length);
  if (!scored.length) return [];
  const top = scored[0].score;
  return scored.filter((x) => x.score === top).map((x) => x.app);
}

function runPowerShellJson(script, signal) {
  return new Promise((resolve, reject) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    const onAbort = () => { try { c.kill(); } catch { /* đã thoát */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    c.on('error', (e) => reject(e));
    c.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      try { const v = JSON.parse(out || 'null'); resolve(Array.isArray(v) ? v : v ? [v] : []); } catch (e) { reject(e); }
    });
  });
}

/**
 * Bộ điều khiển GUI của máy. `env.fullAccess` quyết định có cho điều khiển terminal không. `host` truyền vào được (test dùng host giả).
 */
export function createGuiController({ fullAccess = false, host = createWindowsHost(), notify = showOSNotification, say = () => {}, background = true } = {}) {
  let appsCache = null;
  let lastNotifyAt = 0;
  /** Cửa sổ của từng lần observe — để kiểm ứng dụng bị chặn ở thao tác theo node_id. */
  const snapshotWindows = new Map();

  const announce = (windowInfo) => {
    const now = Date.now();
    if (now - lastNotifyAt < NOTIFY_EVERY_MS) return;
    lastNotifyAt = now;
    say(`🖱  AI đang điều khiển ${windowInfo?.process || 'màn hình'} — di chuột hoặc gõ phím để AI dừng lại.`);
    notify({ title: 'Aivin đang điều khiển máy này', body: `AI đang thao tác trên ${windowInfo?.title || windowInfo?.process || 'màn hình'}. Di chuột hoặc gõ phím để AI dừng và hỏi bạn.` });
  };

  async function windows(args, ctx) {
    const list = await host.call('windows', { all: !!args.include_dialogs }, ctx);
    return { windows: list.map((w) => ({ ...w, blocked: BLOCKED_PROCESSES.has(normalizeProcess(w.process)) || (!fullAccess && SHELL_PROCESSES.has(normalizeProcess(w.process))) || undefined })) };
  }

  const windowInfoOf = (args, ctx) => host.call('window_info', { window: args.window }, ctx);

  async function observe(args, ctx) {
    const res = await host.call('observe', {
      window: args.window,
      max_nodes: Math.min(Number(args.max_nodes) || OBSERVE_MAX_NODES, 1500),
      include_image: !!args.include_image,
      image_when_poor: args.image_when_poor !== false,
      image_max_width: Number(args.image_max_width) || 1366,
      image_quality: Number(args.image_quality) || 70,
    }, ctx);
    assertWindowAllowed(res.window, { fullAccess });
    snapshotWindows.set(String(res.snapshot), res.window);
    if (snapshotWindows.size > 20) snapshotWindows.delete(snapshotWindows.keys().next().value);
    return res;
  }

  async function focus(args, ctx) {
    assertWindowAllowed(await windowInfoOf(args, ctx), { fullAccess });
    return host.call('focus', { window: args.window }, ctx);
  }

  async function act(args, ctx) {
    const action = String(args.action || GuiAction.CLICK);
    if (!Object.values(GuiAction).includes(action)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Unknown action: ${action}`);
    const snap = args.node_id ? String(args.node_id).split('.')[0] : null;
    const windowInfo = snap ? snapshotWindows.get(snap) : await windowInfoOf(args, ctx);
    if (snap && !windowInfo) throw new DeviceToolError(DeviceErrorCode.GUI_STALE_NODE, `Node ${args.node_id} is from an old observation — observe again`);
    assertWindowAllowed(windowInfo, { fullAccess });
    announce(windowInfo);
    return host.call('act', {
      action, node_id: args.node_id, window: args.node_id ? undefined : args.window, method: args.method, text: args.text, keys: args.keys,
      option: args.option, state: args.state, direction: args.direction, amount: args.amount, point: args.point, to: args.to,
      image_scale: args.image_scale, settle_ms: args.settle_ms,
      check_user_input: true, user_input_grace_ms: Number(args.user_input_grace_ms) || 1500,
    }, ctx);
  }

  async function listApps(signal) {
    if (appsCache && Date.now() - appsCache.at < APPS_CACHE_MS) return appsCache.apps;
    const rows = await runPowerShellJson('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress', signal).catch(() => []);
    const apps = rows.filter((r) => r?.Name && r?.AppID).map((r) => ({ name: String(r.Name), app_id: String(r.AppID) }));
    appsCache = { at: Date.now(), apps };
    return apps;
  }

  async function waitNewWindow(before, ctx, hint) {
    const known = new Set(before.map((w) => w.window));
    const deadline = Date.now() + OPEN_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const now = await host.call('windows', {}, ctx);
      const fresh = now.filter((w) => !known.has(w.window));
      const pick = fresh.find((w) => hint && normalizeName(`${w.title} ${w.process}`).includes(normalizeName(hint).split(' ')[0])) || fresh[0];
      if (pick) return pick;
    }
    return null;
  }

  /** Cửa sổ AI vừa mở được Windows đưa lên trước → đẩy xuống dưới, trả focus cho cửa sổ người dùng đang dùng (chạy nền). */
  async function sendToBack(win, before, ctx) {
    if (!win || background === false) return;
    const userWindow = before.find((w) => w.focused)?.window;
    await host.call('to_back', { window: win.window, restore_to: userWindow }, ctx).catch(() => undefined);
  }

  /** Mở ứng dụng theo tên trong danh sách Start, hoặc mở một tệp trong vùng được phép bằng ứng dụng mặc định. Không chạy lệnh tuỳ ý. */
  async function openApp(args, ctx, env) {
    const before = await host.call('windows', {}, ctx);
    if (args.file) {
      const abs = resolveInRoots(env.roots, String(args.file));
      if (EXECUTABLE_EXT.test(abs)) throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, 'Opening programs or scripts is not allowed — use an app name, or shell.exec');
      if (!fs.existsSync(abs)) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `File not found: ${args.file}`);
      spawn('explorer.exe', [abs], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      const win = await waitNewWindow(before, ctx, path.basename(abs, path.extname(abs)));
      await sendToBack(win, before, ctx);
      return { opened: path.basename(abs), window: win, hint: win ? undefined : 'No new window appeared yet — the file may have opened in an existing window; check gui.windows' };
    }
    const name = String(args.name || '').trim();
    if (!name) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give name (an installed app) or file');
    const matches = matchApps(await listApps(ctx.signal), name);
    if (!matches.length) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No installed app named "${name}"`);
    if (matches.length > 1 && !args.first) return { ambiguous: true, candidates: matches.slice(0, 10).map((m) => m.name), hint: 'Call again with the exact name' };
    const app = matches[0];
    if (BLOCKED_PROCESSES.has(normalizeProcess(app.name.replace(/\s+/g, '')))) throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, `Opening "${app.name}" is not allowed`);
    spawn('explorer.exe', [`shell:AppsFolder\\${app.app_id}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    const win = await waitNewWindow(before, ctx, app.name);
    await sendToBack(win, before, ctx);
    if (win) assertWindowAllowed(win, { fullAccess });
    return { opened: app.name, window: win, hint: win ? undefined : 'App started but no new window yet — call gui.windows in a moment' };
  }

  return { windows, observe, focus, act, openApp, close: () => host.close() };
}

/** Công cụ GUI cho danh mục của Planner. */
export function buildGuiTools(gui) {
  const target = {
    node_id: str('target element id from the latest gui.observe (preferred)'),
    window: str('window handle (0x…) or a title/process to match; default the focused window'),
  };
  return [
    { name: 'gui.windows', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.windows(a, c),
      description: 'List open desktop windows: title, app process, handle, position, which is focused/minimized. blocked = the AI may not control it.',
      input_schema: schema({ include_dialogs: bool('also list owned dialogs') }) },
    { name: 'gui.observe', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.observe(a, c),
      description: 'Read a window as an accessibility tree: each element has an id (node_id), role, name, value, state and supported actions. tree_quality "poor" = the app draws its own UI; a screenshot is then attached automatically (or set include_image). Ids are only valid until the next observe of that window.',
      input_schema: schema({ window: target.window, include_image: bool('attach a screenshot even when the tree is good'), max_nodes: num('default 300') }) },
    { name: 'gui.focus', group: ToolGroup.GUI, handler: (a, c) => gui.focus(a, c),
      description: 'Bring a window to the front (restores it if minimized).',
      input_schema: schema({ window: target.window }, ['window']) },
    { name: 'gui.act', group: ToolGroup.GUI, handler: (a, c) => gui.act(a, c),
      description: 'Do one action on an element (node_id) or at a point of the last screenshot: click, double_click, right_click, set_value (replace a field\'s text), type (keystrokes into the focused element), key (shortcut like "ctrl+s", "alt+f4", "enter"), scroll, select (option of a list/combo), toggle, expand, collapse, drag. Uses accessibility actions first (works even when the window is behind), real mouse/keyboard otherwise. Returns evidence: the element\'s new value/state, window title change, focused element. Stops with GUI_USER_ACTIVE if the person is using the mouse/keyboard.',
      input_schema: schema({
        action: str(Object.values(GuiAction).join(' | ')), ...target, text: str('text for set_value / type'), keys: str('for key: e.g. "ctrl+s", several separated by spaces'),
        option: str('for select: the option name'), state: str('for toggle: on | off'), direction: str('for scroll: up | down | left | right'), amount: num('scroll steps, default 3'),
        point: { type: 'object', description: '{x,y} on the last screenshot when no node_id', properties: { x: num('x'), y: num('y') } },
        to: { type: 'object', description: 'drag destination {x,y} on the last screenshot', properties: { x: num('x'), y: num('y') } },
        image_scale: num('scale of the screenshot the point was taken from'), method: str('auto | pattern | mouse (default auto)'),
      }, ['action']) },
    { name: 'gui.open_app', group: ToolGroup.GUI, handler: (a, c, e) => gui.openApp(a, c, e),
      description: 'Open an installed app by name (from the Start menu list), or open a document file with its default app. Returns the new window. Does not run programs or scripts by path.',
      input_schema: schema({ name: str('app name, e.g. "Excel", "Calculator"'), file: str('a document path inside the allowed folders'), first: bool('take the first match when several apps share the name') }) },
  ];
}
