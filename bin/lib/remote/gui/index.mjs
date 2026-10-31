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
 * Đợt 2 (30/10/2026): cây nghèo → host đọc chữ trên ảnh bằng OCR có sẵn của Windows (chạy trên máy), mỗi cụm chữ thành node `<snap>.t<k>`
 * click / gõ được — BE tìm "nút Ghi sổ" theo chữ thay vì nhờ VLM đoán toạ độ; `gui.wait_for` chờ phần tử / cửa sổ hiện ra hoặc mất đi
 * thay cho observe lặp.
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
/**
 * Chỉ cho khi máy toàn quyền — điều khiển được những thứ này là chạy lệnh tuỳ ý ngoài vùng thư mục: terminal / registry, và (30/10/2026)
 * trình soạn code có terminal tích hợp + ứng dụng agent tự chạy lệnh (VS Code, Cursor, Claude…) — gõ vào terminal của VS Code hay nhờ panel
 * Claude chạy lệnh cũng là lách vùng thư mục như gõ vào cmd.
 */
const SHELL_PROCESSES = new Set([
  'cmd', 'powershell', 'pwsh', 'windowsterminal', 'wt', 'openconsole', 'conhost', 'regedit', 'mmc', 'taskmgr', 'wsl', 'bash', 'mintty',
  'code', 'code - insiders', 'codium', 'cursor', 'windsurf', 'zed', 'devenv', 'idea64', 'pycharm64', 'webstorm64', 'rider64', 'goland64',
  'claude', 'chatgpt', 'warp', 'alacritty', 'wezterm-gui', 'hyper', 'tabby',
]);
/** Cùng nhóm đó theo tên trong menu Start (`gui.open_app` tìm theo tên, khác tên tiến trình) — chặn trước khi mở. */
const SHELL_APP_NAME = /\b(command prompt|powershell|terminal|registry editor|task manager|visual studio|vs ?code|cursor|windsurf|zed|intellij|pycharm|webstorm|rider|goland|claude|chatgpt|warp|alacritty|wezterm|hyper|tabby|wsl|ubuntu|git bash)\b/i;
/** Không mở tệp có đuôi chạy được bằng `gui.open_app` (mở = chạy chương trình). */
const EXECUTABLE_EXT = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|scr|pif|hta|cpl|jar|reg|url|appref-ms|application)$/i;

const OBSERVE_MAX_NODES = 300;
const APPS_CACHE_MS = 10 * 60_000;
const OPEN_WAIT_MS = 10_000;
const WAIT_MAX_MS = 60_000;
const FIND_DEFAULT = 20;
const FIND_MAX = 60;
const SEMANTIC_CHOICES = 5;
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

/** Ứng dụng này (tên trong menu Start) có được mở không — ném lỗi trước khi mở. */
export function assertAppAllowed(name, { fullAccess }) {
  if (BLOCKED_PROCESSES.has(normalizeProcess(String(name || '').replace(/\s+/g, '')))) throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, `Opening "${name}" is not allowed`);
  if (!fullAccess && SHELL_APP_NAME.test(String(name || ''))) {
    throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, `Opening "${name}" needs full device access (aivin remote start --full-access)`);
  }
}

const normalizeName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Rank UI nodes with richer evidence while keeping the model-facing schema small. Hard exclusions happen
 * before scoring; exact accessible names and AutomationIds beat loose word matches. The margin between the
 * first two candidates is used by gui.do to refuse ambiguous actions instead of guessing.
 */
export function rankGuiNodes(nodes, query, role = '') {
  const q = normalizeName(query);
  const words = q.split(' ').filter(Boolean);
  const wantedRole = String(role || '').toLowerCase();
  if (!words.length) return [];
  return (nodes || [])
    .filter((n) => (!wantedRole || String(n.role || '').toLowerCase() === wantedRole) && !n.disabled && !n.offscreen)
    .map((node, order) => {
      const name = normalizeName(node.name);
      const aid = normalizeName(node.automation_id);
      const value = normalizeName(node.value);
      const help = normalizeName(node.help);
      const combined = [name, aid, value, help].filter(Boolean).join(' ');
      const hits = words.filter((word) => combined.includes(word)).length;
      if (!hits) return null;
      let score = Math.round((hits / words.length) * 50);
      const evidence = [];
      if (name === q) { score += 50; evidence.push('exact_name'); }
      else if (aid === q) { score += 45; evidence.push('exact_automation_id'); }
      else if (name.startsWith(q)) { score += 35; evidence.push('name_prefix'); }
      else if (words.every((word) => name.includes(word))) { score += 30; evidence.push('all_words_in_name'); }
      else if (words.every((word) => combined.includes(word))) { score += 20; evidence.push('all_words'); }
      if (node.source === 'ocr') { score -= 5; evidence.push('ocr'); }
      if (node.patterns?.length) { score += 3; evidence.push('actionable_pattern'); }
      return { node, score, hits, evidence, order };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.order - b.order);
}

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
export function createGuiController({
  fullAccess = false, host = createWindowsHost(), notify = showOSNotification, say = () => {}, background = true, defaultWindow = () => null,
} = {}) {
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

  /**
   * Không nói cửa sổ = cửa sổ đang focus; nhưng chủ máy vừa gõ vào ô hỏi của linh vật thì focus là chính linh vật → host đổi sang cửa sổ họ
   * đang dùng ngay trước đó (`defaultWindow()` = `{ avoid_pid, fallback }`).
   */
  const target = (args) => (args.window ? { window: args.window } : { ...defaultWindow() });
  const windowInfoOf = (args, ctx) => host.call('window_info', target(args), ctx);

  async function observe(args, ctx) {
    const res = await host.call('observe', {
      ...target(args),
      max_nodes: Math.min(Number(args.max_nodes) || OBSERVE_MAX_NODES, 1500),
      include_image: !!args.include_image,
      image_when_poor: args.image_when_poor !== false,
      ocr: typeof args.ocr === 'boolean' ? args.ocr : undefined,
      image_max_width: Number(args.image_max_width) || 1366,
      image_quality: Number(args.image_quality) || 70,
    }, ctx);
    assertWindowAllowed(res.window, { fullAccess });
    snapshotWindows.set(String(res.snapshot), res.window);
    if (snapshotWindows.size > 20) snapshotWindows.delete(snapshotWindows.keys().next().value);
    return res;
  }

  /**
   * Chỉ những phần tử khớp chữ cần tìm (cửa sổ lớn: Excel, ERP có hàng trăm phần tử) — đi cả cây (tới 1500) rồi lọc ở đây; id vẫn của lần
   * observe đó nên `gui.act` dùng được ngay. Mọi từ đều có trong tên / AutomationId / giá trị / chú thích (bỏ dấu); không phần tử nào đủ
   * hết từ thì lấy phần tử khớp nhiều từ nhất.
   */
  async function find(args, ctx) {
    const words = normalizeName(args.query).split(' ').filter(Boolean);
    if (!words.length) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give query (words of the element to find)');
    const role = String(args.role || '').toLowerCase();
    const max = Math.max(1, Math.min(Number(args.max) || FIND_DEFAULT, FIND_MAX));
    const res = await observe({ ...args, max_nodes: 1500 }, ctx);
    const scored = rankGuiNodes(res.nodes, args.query, role);
    const all = scored.filter((x) => x.hits === words.length);
    const pool = all.length ? all : scored.filter((x) => x.hits === scored[0]?.hits);
    const picked = pool.slice(0, max);
    const margin = picked.length > 1 ? picked[0].score - picked[1].score : picked.length ? picked[0].score : 0;
    return {
      ...res,
      nodes: picked.map((x) => x.node),
      query: String(args.query), matched: all.length || scored.length, exact: all.length > 0,
      confidence: !picked.length ? 'none' : margin >= 15 || picked.length === 1 ? 'high' : margin >= 5 ? 'medium' : 'low',
      ambiguous: picked.length > 1 && margin < 5 || undefined,
    };
  }

  /**
   * Compact semantic fast path. The caller states intent; candidate evidence, exclusions, ambiguity handling,
   * execution and cheap post-action verification stay inside the device runtime.
   */
  async function semanticDo(args, ctx, env) {
    const command = String(args.do || '').toLowerCase();
    if (command === 'open') return openApp({ name: args.target, file: args.file }, ctx, env);
    const action = {
      click: GuiAction.CLICK, fill: GuiAction.SET_VALUE, select: GuiAction.SELECT, toggle: GuiAction.TOGGLE,
      key: GuiAction.KEY, scroll: GuiAction.SCROLL,
    }[command];
    if (!action) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Unknown semantic action: ${args.do || ''}`);

    if ((command === 'key' || command === 'scroll') && !args.target) {
      const result = await act({
        action, window: args.within || args.window, keys: command === 'key' ? args.value : undefined,
        direction: command === 'scroll' ? args.value : undefined,
      }, ctx);
      return { ok: true, action: command, effect: result.window_title_changed || result.focused_element || command };
    }

    const query = String(args.target || '').trim();
    if (!query) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give target');
    const found = await find({ query, role: args.role, window: args.within || args.window, max: SEMANTIC_CHOICES }, ctx);
    if (!found.nodes.length) throw new DeviceToolError(DeviceErrorCode.GUI_TARGET_NOT_FOUND, `No enabled visible target matched "${query}"`);
    if (found.ambiguous) {
      return {
        ok: false, code: DeviceErrorCode.GUI_AMBIGUOUS_TARGET,
        choices: found.nodes.map((n) => ({ ref: n.id, label: [n.name || n.automation_id || n.role, n.role].filter(Boolean).join(' — ') })),
      };
    }

    const node = found.nodes[0];
    const result = await act({
      action, node_id: node.id,
      text: command === 'fill' ? args.value : undefined,
      option: command === 'select' ? args.value : undefined,
      state: command === 'toggle' ? args.value : undefined,
    }, ctx);
    let verified;
    if (command === 'fill' && Object.hasOwn(result.target || {}, 'value')) verified = String(result.target.value) === String(args.value ?? '');
    if (command === 'select' && Object.hasOwn(result.target || {}, 'selected')) verified = result.target.selected === true;
    if (command === 'toggle' && Object.hasOwn(result.target || {}, 'checked')) {
      const expected = String(args.value || '').toLowerCase();
      verified = expected === 'on' ? result.target.checked === 'on' : expected === 'off' ? result.target.checked === 'off' : undefined;
    }
    if (verified === false) {
      throw new DeviceToolError(DeviceErrorCode.GUI_NO_EFFECT, `${command} ran but the target did not reach the requested state`);
    }
    return {
      ok: true, action: command, target: node.name || node.automation_id || node.role,
      ...(verified === undefined ? {} : { verified }),
      effect: result.window_title_changed || result.target || result.focused_element || command,
    };
  }

  /** Chờ phần tử / cửa sổ hiện ra hoặc mất đi — chỉ đọc. Chờ trong một cửa sổ thì cửa sổ đó phải được phép điều khiển. */
  async function waitFor(args, ctx) {
    const elementWait = !!(args.name || args.automation_id);
    if (elementWait || args.window) assertWindowAllowed(await windowInfoOf(args, ctx), { fullAccess });
    return host.call('wait_for', {
      ...(elementWait || args.window ? target(args) : {}),
      until: args.until, name: args.name, automation_id: args.automation_id, role: args.role, title_contains: args.title_contains,
      timeout_ms: Math.min(Number(args.timeout_ms) || 10_000, WAIT_MAX_MS),
    }, ctx);
  }

  async function focus(args, ctx) {
    assertWindowAllowed(await windowInfoOf(args, ctx), { fullAccess });
    return host.call('focus', target(args), ctx);
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
      action, node_id: args.node_id, ...(args.node_id ? {} : target(args)), method: args.method, text: args.text, keys: args.keys,
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
    assertAppAllowed(app.name, { fullAccess });
    spawn('explorer.exe', [`shell:AppsFolder\\${app.app_id}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    const win = await waitNewWindow(before, ctx, app.name);
    await sendToBack(win, before, ctx);
    if (win) assertWindowAllowed(win, { fullAccess });
    return { opened: app.name, window: win, hint: win ? undefined : 'App started but no new window yet — call gui.windows in a moment' };
  }

  return { windows, observe, find, waitFor, focus, act, semanticDo, openApp, close: () => host.close() };
}

/** Công cụ GUI cho danh mục của Planner. */
export function buildGuiTools(gui) {
  const target = {
    node_id: str('target element id from the latest gui.observe (preferred)'),
    window: str('window handle (0x…) or a title/process to match; default the focused window (asked from the mascot: the window the person was using)'),
  };
  return [
    { name: 'gui.do', group: ToolGroup.GUI, handler: (a, c, e) => gui.semanticDo(a, c, e),
      description: 'Fast semantic desktop action. State the intent briefly; the device finds one enabled visible target, refuses ambiguity, acts, and verifies simple value/state changes. Use precise gui.find/gui.act only after an ambiguous result.',
      input_schema: schema({
        do: str('click | fill | select | toggle | key | scroll | open'), target: str('short visible label or app name'),
        value: str('text, option, on/off, key chord, or scroll direction'), within: str('optional window title/process'),
        role: str('optional role such as button or edit'), file: str('document path for open'),
      }, ['do']) },
    { name: 'gui.windows', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.windows(a, c),
      description: 'List open desktop windows: title, app process, handle, position, which is focused/minimized. blocked = the AI may not control it.',
      input_schema: schema({ include_dialogs: bool('also list owned dialogs') }) },
    { name: 'gui.observe', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.observe(a, c),
      description: 'Read a window as an accessibility tree: each element has an id (node_id), role, name, value, state and supported actions. tree_quality "poor" = the app draws its own UI; a screenshot is then attached and the text on it is read on the device (OCR): each text run becomes a node with role "text", source "ocr" and an id like "4.t2" that gui.act can click / type at. Ids are only valid until the next observe of that window.',
      input_schema: schema({
        window: target.window, include_image: bool('attach a screenshot even when the tree is good'), max_nodes: num('default 300'),
        ocr: bool('read the text on the window even when the tree is good (default: only when poor)'),
      }) },
    { name: 'gui.find', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.find(a, c),
      description: 'Like gui.observe but returns only the elements whose name / AutomationId / value contains the query words (accents ignored), optionally of one role — for big windows (spreadsheets, ERP forms) where the full tree is too long. Ids work with gui.act right away. exact=false means no element had every word; the closest ones are returned.',
      input_schema: schema({
        query: str('words of the element, e.g. "Save", "Số tiền", "Customer name"'), window: target.window,
        role: str('only this role, e.g. button, edit, menuitem, dataitem'), max: num('default 20, max 60'),
      }, ['query']) },
    { name: 'gui.wait_for', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.waitFor(a, c),
      description: 'Wait until the UI reaches a state instead of observing again and again: an element (name contains / automation_id, optional role) appears or is gone in a window, or a window whose title contains some text appears or is gone (no window = any window). Returns met + waited_ms + the match; GUI_WAIT_TIMEOUT if it did not happen in time.',
      input_schema: schema({
        until: str('appears (default) | gone'), window: target.window, name: str('element name contains this text (case-insensitive)'),
        automation_id: str('element AutomationId (exact)'), role: str('element role, e.g. button, menuitem, edit, window'),
        title_contains: str('wait on a window title instead of an element'), timeout_ms: num('default 10000, max 60000'),
      }) },
    { name: 'gui.focus', group: ToolGroup.GUI, handler: (a, c) => gui.focus(a, c),
      description: 'Bring a window to the front (restores it if minimized).',
      input_schema: schema({ window: target.window }, ['window']) },
    { name: 'gui.act', group: ToolGroup.GUI, handler: (a, c) => gui.act(a, c),
      description: 'Do one action on an element (node_id) or at a point of the last screenshot: click, double_click, right_click, set_value (replace a field\'s text), type (keystrokes into the focused element), key (shortcut like "ctrl+s", "alt+f4", "enter"), scroll, select (option of a list/combo), toggle, expand, collapse, drag. Uses accessibility actions first (works even when the window is behind), real mouse/keyboard otherwise. Returns evidence: the element\'s new value/state, window title change, focused element. OCR text nodes ("4.t2") take click / double_click / right_click, or set_value / type (clicks there, then types). Stops with GUI_USER_ACTIVE if the person is using the mouse/keyboard.',
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
