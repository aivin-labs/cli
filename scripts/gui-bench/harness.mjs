import { execFileSync } from 'child_process';

/**
 * Khung đo tầng gui.* của máy (computer use trên Windows). Mỗi tác vụ chạy như một Planner thật gọi công cụ: nói theo chữ NHÌN THẤY trên
 * màn hình (kiểu model nhìn ảnh), gặp mơ hồ thì chọn trong danh sách máy trả, không thấy thì observe rồi chọn — mỗi lời gọi là một lượt
 * Planner (một vòng gọi model trên BE). Kết quả kiểm bằng nguồn độc lập (tệp trên đĩa, trạng thái ứng dụng mẫu), không tin lời máy tự báo.
 *
 * Ghi cho từng lời gọi: thời gian trên máy, phương thức (invoke / value / posted / mouse…), mã lỗi, cỡ dữ liệu trả Planner (ước token),
 * có ảnh không. Cho từng tác vụ: đạt / trượt, số lượt, tổng thời gian, có giành cửa sổ trước mặt người dùng không, có mượn chuột / phím thật không.
 */

const REAL_INPUT = new Set(['mouse', 'keyboard']);
/** Ảnh JPEG gửi kèm ~ token của model nhìn ảnh (ước theo cỡ 1366 px): để so tổng chi phí, không cần chính xác. */
const IMAGE_TOKENS = 1600;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Đóng cửa sổ bằng WM_CLOSE (không giết tiến trình chủ — ApplicationFrameHost chứa mọi cửa sổ ứng dụng Store). */
export function closeWindow(handle) {
  if (!handle) return;
  const h = parseInt(String(handle), 16);
  if (!h) return;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);'; [void][N.W]::PostMessage([IntPtr]${h},0x10,[IntPtr]::Zero,[IntPtr]::Zero)`], { windowsHide: true, timeout: 15_000 });
  } catch { /* đã đóng */ }
}

const stripImages = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 2000 && /^[A-Za-z0-9+/=]+$/.test(x.slice(0, 200)) ? '[img]' : x));
const hasImage = (v) => !!(v && (v.image || v.observation?.image || v._raw_observation?.image));
const label = (n) => [n?.name, n?.automation_id].filter(Boolean).join(' | ');

/** Chuẩn hoá chữ để so (bỏ dấu, thường) — giống cách Planner đọc lỏng. */
export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * `pick`: cách Planner nhận ra phần tử mình muốn khi đã thấy danh sách (tên ngữ nghĩa / regex / hàm). Chuỗi → khớp chuẩn hoá trùng tên hoặc
 * AutomationId; RegExp → thử trên "name | automation_id"; hàm → tự xét node.
 */
export function matcher(pick) {
  if (!pick) return () => false;
  if (typeof pick === 'function') return pick;
  if (pick instanceof RegExp) return (n) => pick.test(label(n)) || pick.test(n?.label || '');
  const want = norm(pick);
  return (n) => norm(n?.name) === want || norm(n?.automation_id) === want || norm(String(n?.label || '').split(' — ')[0]) === want;
}

export function createTaskContext({ gui, host, env, task, log }) {
  const steps = [];
  const checks = [];
  const owned = new Set();
  const ownedPids = new Set();
  const notes = [];
  let userForeground = null;
  let focusSteals = 0;
  let skipped = null;
  /** Cây đã thấy gần nhất của từng cửa sổ — Planner nhớ id trong ngữ cảnh, không observe lại khi chưa cần. */
  const seen = new Map();

  async function foreground() {
    return host.call('window_info', {}, {}).catch(() => null);
  }

  async function trackFocus(stepRec) {
    const fg = await foreground();
    if (!fg || !userForeground) return;
    const mine = owned.has(fg.window) || ownedPids.has(fg.pid);
    if (fg.window !== userForeground.window && mine) {
      stepRec.stole_focus = fg.title || fg.process;
      focusSteals++;
    }
  }

  const HANDLERS = {
    windows: (a, c) => gui.windows(a, c),
    observe: (a, c) => gui.observe(a, c),
    find: (a, c) => gui.find(a, c),
    wait_for: (a, c) => gui.waitFor(a, c),
    read_table: (a, c) => gui.readTable(a, c),
    focus: (a, c) => gui.focus(a, c),
    act: (a, c) => gui.act(a, c),
    do: (a, c) => gui.semanticDo(a, c, env),
    open_app: (a, c) => gui.openApp(a, c, env),
  };

  /** Một lượt Planner = một lời gọi công cụ. `allowError` = lỗi là kết quả hợp lệ để Planner xử lý tiếp (không ném). */
  async function call(tool, args = {}, { allowError = false, why = '' } = {}) {
    const ctl = new AbortController();
    const ctx = { signal: ctl.signal, timeoutMs: 60_000 };
    const timer = setTimeout(() => ctl.abort(new Error('bench step timeout 60s')), 60_000);
    const started = Date.now();
    const rec = { tool, args: shortArgs(args), why };
    let result;
    let error;
    try {
      result = await HANDLERS[tool](args, ctx);
    } catch (e) {
      error = e;
    } finally {
      clearTimeout(timer);
    }
    rec.ms = Date.now() - started;
    if (error) {
      rec.ok = false;
      rec.code = error.code || 'ERROR';
      rec.error = String(error.message || error).slice(0, 240);
    } else {
      rec.ok = result?.ok !== false;
      if (result?.ok === false) rec.code = result.code;
      rec.method = result?.method;
      if (result?.verified !== undefined) rec.verified = result.verified;
      if (result?.tree_quality) rec.tree = result.tree_quality;
      if (Array.isArray(result?.nodes)) rec.nodes = result.nodes.length;
      if (result?.truncated_by) rec.truncated = result.truncated_by;
      if (result?.choices) rec.choices = result.choices.length;
      if (result?.app_busy) rec.app_busy = true;
      const payload = stripImages(result);
      rec.chars = payload.length;
      rec.image = hasImage(result) || undefined;
      if (result?.window?.window) remember(result.window);
      if (Array.isArray(result?.nodes) && result.snapshot !== undefined && result.window?.window) seen.set(result.window.window, result);
    }
    rec.real_input = REAL_INPUT.has(rec.method) || undefined;
    await trackFocus(rec);
    steps.push(rec);
    log?.(`   ${rec.ok ? '✓' : '✗'} ${tool} ${rec.args} ${rec.ms}ms${rec.method ? ` [${rec.method}]` : ''}${rec.code ? ` ${rec.code}` : ''}${rec.error ? ` — ${rec.error.slice(0, 120)}` : ''}${rec.stole_focus ? ` ⚠ focus→${rec.stole_focus}` : ''}`);
    if (error && !allowError) throw error;
    return error ? { ok: false, code: error.code, error: error.message } : result;
  }

  function remember(win) {
    if (!win?.window) return;
    owned.add(win.window);
    if (win.pid) ownedPids.add(win.pid);
  }

  /**
   * Planner nói theo chữ nhìn thấy (`visible`), biết mình muốn phần tử nào (`pick`). Chiến lược giống model thật:
   *  1. Đã có cây của cửa sổ này trong ngữ cảnh và thấy phần tử → gui.act theo id (1 lượt).
   *  2. Chưa → gui.do theo chữ nhìn thấy. Mơ hồ → chọn trong choices (thêm 1 lượt). Không thấy → observe (thêm 1) rồi act (thêm 1).
   */
  async function press({ do: command = 'click', visible, pick, within, value, role }) {
    const act = { click: 'click', fill: 'set_value', select: 'select', toggle: 'toggle' }[command] || command;
    const extra = (nodeId) => ({
      action: act, node_id: nodeId,
      ...(command === 'fill' ? { text: value } : {}), ...(command === 'select' ? { option: value } : {}), ...(command === 'toggle' ? { state: value } : {}),
    });
    const tree = within && seen.get(within);
    const match = matcher(pick || visible);
    const known = tree?.nodes?.find(match);
    if (known) return call('act', extra(known.id), { why: `id từ cây đã thấy: ${label(known)}` });
    const r = await call('do', { do: command, target: visible, within, value, role }, { allowError: true });
    if (r.ok) return r;
    if (r.code === 'GUI_AMBIGUOUS_TARGET' && r.choices?.length) {
      const choice = r.choices.find(match) || r.choices.find((c) => matcher(visible)(c));
      if (r.observation?.window?.window) seen.set(r.observation.window.window, r.observation);
      if (choice) return call('act', extra(choice.ref), { why: `chọn trong choices: ${choice.label}` });
    }
    const obs = await call('observe', { window: within }, { why: `không thấy "${visible}" bằng gui.do` });
    const node = obs.nodes?.find(match);
    if (!node) {
      const ocr = await call('observe', { window: within, ocr: true }, { allowError: true, why: 'đọc chữ trên ảnh' });
      const viaOcr = ocr.nodes?.find((n) => matcher(pick || visible)(n) || norm(n.name).includes(norm(visible)));
      if (!viaOcr) throw Object.assign(new Error(`Planner không tìm được "${visible}"`), { code: 'BENCH_NOT_FOUND' });
      return call('act', extra(viaOcr.id), { why: `node OCR: ${viaOcr.name}` });
    }
    return call('act', extra(node.id), { why: `observe rồi chọn: ${label(node)}` });
  }

  return {
    call, press, remember, env, notes,
    note: (s) => { notes.push(s); log?.(`   ℹ ${s}`); },
    check(name, ok, detail) {
      checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : String(detail).slice(0, 300) });
      log?.(`   ${ok ? '☑' : '☒'} ${name}${detail !== undefined && !ok ? ` — ${String(detail).slice(0, 200)}` : ''}`);
      return !!ok;
    },
    forget: (win) => seen.delete(win),
    /** Tác vụ không áp dụng được trên máy này (vd .csv không mở bằng Excel) — không tính vào tỉ lệ đạt. */
    skip(reason) { notes.push(`BỎ QUA: ${reason}`); log?.(`   ⏭ ${reason}`); skipped = reason; },
    async begin() { userForeground = await foreground(); },
    summary() {
      const sum = (k) => steps.reduce((s, x) => s + (x[k] || 0), 0);
      return {
        id: task.id, app: task.app, steps, checks, notes,
        turns: steps.length,
        device_ms: sum('ms'),
        tokens_est: Math.round(sum('chars') / 3.5) + steps.filter((s) => s.image).length * IMAGE_TOKENS,
        images: steps.filter((s) => s.image).length,
        real_input: steps.filter((s) => s.real_input).length,
        focus_steals: focusSteals,
        errors: steps.filter((s) => !s.ok).map((s) => s.code),
        user_foreground: userForeground?.title,
        skipped: skipped || undefined,
      };
    },
    owned,
  };
}

function shortArgs(a) {
  const parts = [];
  for (const [k, v] of Object.entries(a || {})) {
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${s.length > 50 ? `${s.slice(0, 47)}…` : s}`);
  }
  return parts.join(' ');
}
