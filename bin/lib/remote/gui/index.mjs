import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { DeviceErrorCode, ToolGroup } from '../constants.mjs';
import { DeviceToolError, resolveInRoots } from '../sandbox.mjs';
import { showOSNotification } from '../notify.mjs';
import { PS_UTF8_PREFIX } from '../processes.mjs';
import { createWindowsHost } from './windowsHost.mjs';
import { isProtectedPromptWindow } from '../humanInput.mjs';

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
  'consent', 'credentialuihost', 'credentialuibroker', 'lockapp', 'logonui', 'securityhealthsystray', 'securityhealthhost', 'windowsdefender', 'msmpeng',
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
/** Mở tệp: Excel / Word khởi động nguội mất 10–15 s mới ghi tên tệp lên tiêu đề. */
const OPEN_FILE_WAIT_MS = 20_000;
const WAIT_MAX_MS = 60_000;
const FIND_DEFAULT = 20;
const FIND_MAX = 60;
const SEMANTIC_CHOICES = 5;
/** Báo người dùng "AI đang điều khiển" một lần mỗi quãng này (lần thao tác ghi đầu tiên). */
const NOTIFY_EVERY_MS = 5 * 60_000;
/** Không hỏi người dùng (10/11/2026, user: "xin quyền gì lắt nhắt thế"): cần chuột / phím thật thì chờ họ ngừng tay chừng này rồi mượn thật nhanh. */
export const REAL_INPUT_IDLE_MS = 2500;
/** Họ bận liên tục quá chừng này thì thôi, báo Planner để nói trong khung chat. */
export const REAL_INPUT_WAIT_MS = 30_000;
const REAL_INPUT_POLL_MS = 400;
const GUI_PERSON_PRESENT = 'GUI_PERSON_PRESENT';

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

/** PickerHost còn mở các hộp chọn tệp bình thường, nên chỉ chặn đúng hộp xác thực "Windows Security" của nó. */
function isWindowsSecurityPrompt(windowInfo) {
  if (normalizeProcess(windowInfo?.process) !== 'pickerhost') return false;
  const title = normalizeName(windowInfo?.title);
  return title === 'windows security' || title === 'bao mat windows';
}

/** Ứng dụng này có được điều khiển không — ném lỗi nếu bị chặn. */
export function assertWindowAllowed(windowInfo, { fullAccess }) {
  if (isWindowsSecurityPrompt(windowInfo)) throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, 'This is a Windows Security prompt — only the person at this computer can answer it');
  // Hộp xác nhận / đồng ý của chính Aivin: chỉ người ở máy trả lời — AI bấm "Cho phép" là tự duyệt việc của mình (humanInput.mjs).
  if (isProtectedPromptWindow(windowInfo?.title)) {
    throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, 'This is an Aivin confirmation box — only the person at this computer can answer it');
  }
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

const normalizeName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Planner nhìn ảnh nói theo KÝ HIỆU trên nút ("×", "7", "☰"); cây trợ năng gọi nút bằng chữ của ngôn ngữ giao diện ("Multiply by" / "Nhân",
 * "Seven" / "Bảy"). Không so ký hiệu với tên hiển thị (phải liệt kê chữ từng ngôn ngữ — bản 13/11 bị bác vì vậy) mà với AutomationId: mã lập
 * trình viên đặt, GIỐNG NHAU dù giao diện ngôn ngữ nào (`multiplyButton`, `num7Button`, `TogglePaneButton`) — cùng nguyên tắc BE nhận nút sắp
 * xếp qua tên mã sort / order. Mỗi ký hiệu → các gốc tên mã hay gặp; chữ số đơn khớp nguyên một số trong AutomationId.
 */
const GLYPH_ID_STEMS = {
  '×': ['multiply', 'times'], '*': ['multiply'], '✕': ['close', 'dismiss'], '✖': ['close', 'dismiss'], '╳': ['close', 'dismiss'],
  '÷': ['divide'], '/': ['divide'], '+': ['plus', 'add'], '-': ['minus', 'subtract'], '−': ['minus', 'subtract'], '–': ['minus', 'subtract'],
  '=': ['equal'], '%': ['percent'], '±': ['negate', 'plusminus', 'positivenegative'], '.': ['decimal'], ',': ['decimal'],
  '←': ['back'], '→': ['forward', 'next'], '⌫': ['backspace'], '☰': ['togglepane', 'navigation', 'hamburger'], '≡': ['togglepane', 'navigation', 'hamburger'],
  '⋯': ['more', 'overflow'], '…': ['more', 'overflow'], '...': ['more', 'overflow'], '⋮': ['more', 'overflow'], '🔍': ['search'], '⚙': ['setting'], '⚙️': ['setting'],
  '⟳': ['refresh', 'reload'], '↻': ['refresh', 'reload'],
};

/** Từ của AutomationId tách theo chữ hoa / chữ số ("num7Button" → "num 7 button", "TogglePaneButton" → "toggle pane button"). */
const idWords = (aid) => normalizeName(String(aid || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'));

/** Các cách hiểu một mô tả: nguyên văn, và (ký hiệu / chữ số đơn) qua gốc tên mã trong AutomationId (`idStems` / `idDigit`). */
function queryVariants(raw) {
  const text = String(raw || '').trim();
  const out = [];
  const q = normalizeName(text);
  if (q) out.push({ q, words: q.split(' ').filter(Boolean) });
  const glyph = text.toLowerCase();
  if (GLYPH_ID_STEMS[glyph]) out.push({ q: glyph, words: [], idStems: GLYPH_ID_STEMS[glyph], raw: text });
  else if (!q && text) out.push({ q: text, words: [], raw: text }); // ký hiệu lạ: chỉ khớp tên trùng nguyên văn
  if (/^\d$/.test(text)) out.push({ q: text, words: [], idDigit: text, raw: text });
  return out;
}

const EDITABLE_ROLES = ['edit', 'document', 'combobox'];

/** Phần tử làm được thao tác này không (fill cần ô nhập, toggle cần ô tích…). undefined = không biết thao tác. */
function compatibleWith(node, action) {
  const role = String(node.role || '').toLowerCase();
  const p = node.patterns || [];
  if (node.source === 'ocr') return true;
  switch (action) {
    case GuiAction.SET_VALUE: case GuiAction.TYPE: return !node.readonly && (EDITABLE_ROLES.includes(role) || p.includes('value'));
    case GuiAction.TOGGLE: return p.includes('toggle') || role === 'checkbox' || role === 'radiobutton';
    case GuiAction.SELECT: return p.includes('select') || p.includes('expand') || ['combobox', 'list', 'listitem', 'tabitem', 'radiobutton', 'dataitem', 'treeitem'].includes(role);
    case GuiAction.CLICK: case GuiAction.DOUBLE_CLICK: return p.length > 0 || ['button', 'menuitem', 'hyperlink', 'listitem', 'tabitem', 'treeitem', 'checkbox', 'radiobutton', 'dataitem', 'splitbutton'].includes(role);
    default: return undefined;
  }
}

/** Từ ngắn (≤ 2 ký tự) và số chỉ khớp nguyên một từ của chữ hiện trên phần tử — không khớp đầu từ, không khớp AutomationId ("1" ≠ "Item 1"). */
const strictWord = (word) => word.length <= 2 || /^\d+$/.test(word);

/**
 * Rank UI nodes with richer evidence while keeping the model-facing schema small. Hard exclusions happen
 * before scoring; exact accessible names and AutomationIds beat loose word matches. The margin between the
 * first two candidates is used by gui.do to refuse ambiguous actions instead of guessing.
 * `complete` = mọi từ của (một cách hiểu) mô tả đều khớp. `action` (tuỳ chọn) ưu tiên phần tử làm được thao tác đó.
 */
export function rankGuiNodes(nodes, query, role = '', { matchValue = true, action, includeOffscreen = false } = {}) {
  const variants = queryVariants(query);
  const wantedRole = String(role || '').toLowerCase();
  if (!variants.length) return [];
  // Chữ OCR nằm trên một phần tử đã tắt cũng là đã tắt: bấm vào đó không có tác dụng mà vẫn báo thành công.
  const disabledRects = (nodes || []).filter((n) => n.disabled && n.rect).map((n) => n.rect);
  const onDisabled = (n) => n.source === 'ocr' && n.rect && disabledRects.some((r) => {
    const cx = n.rect.x + n.rect.w / 2;
    const cy = n.rect.y + n.rect.h / 2;
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  });
  const pool = (nodes || []).filter((n) => (!wantedRole || String(n.role || '').toLowerCase() === wantedRole || n.source === 'ocr')
    && !n.disabled && (includeOffscreen || !n.offscreen) && !onDisabled(n));
  return pool
    .map((node, order) => {
      const name = normalizeName(node.name);
      const aid = normalizeName(node.automation_id);
      const value = matchValue ? normalizeName(node.value) : '';
      const help = normalizeName(node.help);
      const combined = [name, aid, value, help].filter(Boolean).join(' ');
      const shown = [name, value, help].filter(Boolean).join(' ').split(' ');
      // Khớp theo đầu từ; chỉ từ đủ dài mới được khớp giữa chuỗi (AutomationId dính liền) — "ton" (tồn) không được khớp "TogglePaneButton".
      const tokens = combined.split(' ');
      const nodeRole = String(node.role || '').toLowerCase();
      const compat = compatibleWith(node, action);
      const ids = idWords(node.automation_id);
      const idFlat = ids.replace(/ /g, '');
      let best = null;
      for (const v of variants) {
        if (!v.words.length) {
          // Ký hiệu / chữ số: tên trùng nguyên văn ký hiệu (nút tên "+"), hoặc gốc tên mã trong AutomationId (không phụ thuộc ngôn ngữ giao diện).
          let entry = null;
          if (v.raw && String(node.name || '').trim().toLowerCase() === v.raw.toLowerCase()) entry = { score: 100, evidence: ['exact_symbol_name'] };
          // Mã BẮT ĐẦU bằng gốc ký hiệu ("plusButton") hơn mã chỉ chứa nó ("MemPlus" — nút M+): phân hạng theo cấu trúc mã, không theo chữ.
          else if (v.idStems && v.idStems.some((stem) => idFlat.startsWith(stem))) entry = { score: 94, evidence: ['symbol_automation_id'] };
          else if (v.idStems && v.idStems.some((stem) => idFlat.includes(stem))) entry = { score: 88, evidence: ['symbol_automation_id'] };
          else if (v.idDigit && ids.split(' ').includes(v.idDigit)) entry = { score: 92, evidence: ['digit_automation_id'] };
          if (entry && (!best || entry.score > best.score)) best = { ...entry, hits: 1, total: 1, complete: true };
          continue;
        }
        const { q, words } = v;
        // Từ trùng tên vai trò UIA của phần tử ("Save button" → button): tên API, không phải chữ giao diện của một ngôn ngữ.
        const hits = words.filter((word) => word === nodeRole || (strictWord(word)
          ? shown.includes(word)
          : tokens.some((token) => token.startsWith(word)) || (word.length >= 4 && combined.includes(word)))).length;
        if (!hits) continue;
        let score = Math.round((hits / words.length) * 50);
        const evidence = [];
        const longQ = q.length > 2;
        if (name === q) { score += 50; evidence.push('exact_name'); }
        else if (longQ && aid === q) { score += 45; evidence.push('exact_automation_id'); }
        else if (longQ && name.startsWith(q)) { score += 35; evidence.push('name_prefix'); }
        else if (words.every((word) => (strictWord(word) ? name.split(' ').includes(word) : name.includes(word)))) { score += 30; evidence.push('all_words_in_name'); }
        else if (hits === words.length) { score += 20; evidence.push('all_words'); }
        if (words.includes(nodeRole)) evidence.push('role_word');
        const entry = { score, hits, total: words.length, complete: hits === words.length, evidence };
        if (!best || entry.score > best.score || (entry.score === best.score && entry.complete && !best.complete)) best = entry;
      }
      if (!best) return null;
      // Khung cửa sổ (nút thu nhỏ / đóng, menu hệ thống) chỉ khi mô tả trùng NGUYÊN VĂN tên hoặc AutomationId của nó ("Close", "Đóng") —
      // không liệt kê từ "close / đóng" của ngôn ngữ nào; "1" / "System" không bao giờ trúng menu hệ thống.
      // Menu hệ thống / thanh tiêu đề thì không bao giờ (bấm vào mở menu Restore / Move / Close của cửa sổ).
      if (node.chrome && (String(node.role || '').toLowerCase() !== 'button'
        || !best.evidence.some((e) => e === 'exact_name' || e === 'exact_automation_id' || e === 'exact_symbol_name'))) return null;
      if (node.source === 'ocr') { best.score -= 5; best.evidence.push('ocr'); }
      if (node.patterns?.length) { best.score += 3; best.evidence.push('actionable_pattern'); }
      // fill vào nhãn chữ / toggle một nút thường không làm được gì mà có thể vẫn "thành công": ưu tiên phần tử làm được thao tác.
      if (compat === true) { best.score += 8; best.evidence.push('fits_action'); }
      else if (compat === false && action !== GuiAction.CLICK) { best.score -= 30; best.evidence.push('wrong_kind'); }
      return { node, ...best, order };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || Number(b.complete) - Number(a.complete) || b.hits - a.hits || a.order - b.order);
}

/**
 * Nhãn nút chốt / phá huỷ (đã bỏ dấu, viết thường). Cổng duyệt trên BE xét câu mô tả, nên khi máy tự chọn phần tử có nhãn kiểu này mà câu
 * mô tả không nói tới (vd "Lưu" khớp tiền tố "Lưu và gửi") thì không bấm thẳng — trả mơ hồ để BE phân giải + xét sàn an toàn trên đúng nút.
 */
const RISKY_LABEL_WORDS = new Set([
  'send', 'submit', 'post', 'publish', 'delete', 'remove', 'erase', 'pay', 'purchase', 'buy', 'order', 'confirm', 'approve', 'transfer', 'logout', 'signout',
  'gui', 'dang', 'xoa', 'go', 'huy', 'mua', 'chuyen', 'duyet',
]);
const RISKY_LABEL_PHRASES = ['sign out', 'log out', 'thanh toan', 'xac nhan', 'dang xuat', 'dat hang', 'chuyen tien', 'go bo'];

export function riskyLabelWords(label) {
  const n = normalizeName(label);
  const words = n.split(' ').filter((w) => RISKY_LABEL_WORDS.has(w));
  return [...words, ...RISKY_LABEL_PHRASES.filter((p) => ` ${n} `.includes(` ${p} `))];
}

/** Phần tử đã chọn mang nhãn chốt / phá huỷ mà câu mô tả không có → không bấm thẳng. */
export function needsServerCheck(query, node) {
  const asked = new Set(riskyLabelWords(query));
  return riskyLabelWords(node?.name || node?.automation_id).some((w) => !asked.has(w));
}

/**
 * gui.do không chắc → trả ứng viên để BE phân giải. BE đọc `role` / `name` / `id` (DeviceGuiService: `${role} "${name}" [${id}]`), bản cũ chỉ
 * có `ref` / `label` nên thông báo cho Planner thành `item "" []` — giữ cả hai kiểu.
 */
function ambiguousResult(found) {
  return {
    ok: false, code: DeviceErrorCode.GUI_AMBIGUOUS_TARGET,
    choices: found.nodes.map((n) => ({
      ref: n.id, id: n.id, role: n.role, name: n.name || n.automation_id || undefined,
      label: [n.name || n.automation_id || n.role, n.role].filter(Boolean).join(' — '),
    })),
    observation: found._raw_observation,
  };
}

/**
 * Khung cửa sổ trong kết quả observe: bỏ thanh tiêu đề / menu hệ thống (thang phân giải ở BE cũng chọn nhầm chúng: "System" của Settings),
 * giữ mỗi loại nút thu nhỏ / phóng to / đóng một cái (ứng dụng Store có hai bộ). Id của các node còn lại không đổi.
 */
/**
 * Đặc điểm giao diện của một lần observe (14/11/2026) — khoá TẤT ĐỊNH để nạp nguyên lý / kỹ năng theo kiểu giao diện (cùng vai trò "khái niệm trang"
 * của AI Browser — AIBrowserPageConceptHelper): tính từ lớp cửa sổ, chất lượng cây, vai trò phần tử, cờ của host — không từ chữ của ngôn ngữ nào.
 * Nguyên lý học ở ứng dụng A (vd "bảng dài: đọc qua danh sách con, đừng cuộn từng trang") chuyển được sang ứng dụng B cùng đặc điểm.
 */
export function uiTraits(res) {
  const traits = new Set();
  const cls = String(res?.window?.class || '');
  if (/^Chrome_WidgetWin/.test(cls)) traits.add('chromium'); // Electron / trình duyệt Chromium: cây trợ năng bật trễ vài giây
  else if (cls === 'ApplicationFrameWindow') traits.add('uwp');
  else if (/^WindowsForms10\./.test(cls)) traits.add('winforms');
  else if (/^HwndWrapper/.test(cls)) traits.add('wpf');
  else if (cls === '#32770') traits.add('win32_dialog');
  else if (cls) traits.add('win32');
  if (res?.tree_quality === 'poor') traits.add('poor_tree');
  if (res?.content_unavailable) traits.add('app_starting');
  if (res?.modal_dialog_of) traits.add('modal_dialog');
  if (res?.truncated_by === 'long_list') traits.add('long_list');
  const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
  if (nodes.some((n) => /^(table|datagrid)$/.test(String(n.role || '')))) traits.add('data_grid');
  if (nodes.some((n) => n.source === 'ocr')) traits.add('ocr_text');
  if (nodes.some((n) => n.password)) traits.add('password_field');
  if (nodes.some((n) => /^(menu|list)$/.test(String(n.role || '')) && n.expanded === 'expanded')) traits.add('open_menu');
  return [...traits];
}

export function withoutChromeNoise(nodes) {
  const seenCaption = new Set();
  return nodes.filter((n) => {
    if (!n.chrome) return true;
    if (n.role !== 'button') return false;
    const key = n.automation_id || n.name;
    if (seenCaption.has(key)) return false;
    seenCaption.add(key);
    return true;
  });
}

/**
 * Nhiều ô nhập cùng tên: MSAA đặt tên ô theo nhãn chữ đứng trước nó, nên ô không có nhãn ngay sau cũng mang tên nhãn trên (gui-bench
 * 13/11/2026: phiếu thu WinForms có hai ô "Số tiền"). Lấy ô nằm cùng hàng, bên phải nhãn chữ đúng tên đó; không phân định được → null.
 */
export function pickByLabelRow(candidates, nodes, query) {
  const editable = candidates.filter((n) => n.rect && compatibleWith(n, GuiAction.SET_VALUE) === true);
  if (editable.length < 2) return null;
  const want = normalizeName(query);
  const labels = nodes.filter((n) => n.rect && n.source !== 'ocr' && String(n.role || '').toLowerCase() === 'text' && normalizeName(n.name) === want);
  const sameRow = editable.filter((e) => labels.some((l) => {
    const cy = e.rect.y + e.rect.h / 2;
    return cy >= l.rect.y - 4 && cy <= l.rect.y + l.rect.h + 4 && e.rect.x >= l.rect.x + l.rect.w - 4;
  }));
  return sameRow.length === 1 ? sameRow[0] : null;
}

const CLICK_GROUND_ROLES = new Set(['button', 'splitbutton', 'menuitem', 'hyperlink', 'listitem', 'tabitem', 'treeitem', 'checkbox', 'radiobutton', 'dataitem']);

/**
 * Chữ đọc trên ảnh nằm gọn trong một phần tử thật làm được thao tác (nút hiện "C" là "Clear", nút biểu tượng có chữ khác tên trợ năng) →
 * thao tác trên phần tử đó: chạy bằng pattern dưới nền, có bằng chứng đọc lại, thay vì bấm toạ độ bằng chuột thật. Phần tử chứa phải ôm sát
 * chữ (không lấy cả khung / vùng cuộn chứa mọi chữ). Không có → giữ node chữ.
 */
export function groundOcrNode(ocrNode, nodes, action) {
  if (ocrNode?.source !== 'ocr' || !ocrNode.rect) return ocrNode;
  const r = ocrNode.rect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const textArea = Math.max(1, r.w * r.h);
  let best = null;
  for (const n of nodes) {
    if (n.source === 'ocr' || n.chrome || n.disabled || n.offscreen || !n.rect) continue;
    const b = n.rect;
    if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
    const area = b.w * b.h;
    if (area > Math.max(60 * textArea, 6000) || area > 160_000) continue;
    const role = String(n.role || '').toLowerCase();
    const fits = action === GuiAction.CLICK || action === GuiAction.DOUBLE_CLICK || action === GuiAction.RIGHT_CLICK
      ? CLICK_GROUND_ROLES.has(role) || (n.patterns || []).includes('invoke')
      : compatibleWith(n, action) === true;
    if (fits && (!best || area < best.rect.w * best.rect.h)) best = n;
  }
  return best || ocrNode;
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

/**
 * Mở qua explorer.exe. KHÔNG `windowsHide` (13/11/2026, gui-bench): cờ đó đặt SW_HIDE trong STARTUPINFO và Explorer / ứng dụng mở tệp làm
 * theo — thư mục, Notepad lần đầu mở ra cửa sổ ẨN: người dùng không thấy, gui.windows không liệt kê, open_app chờ hết 10 s rồi báo không có
 * cửa sổ. explorer.exe không có cửa sổ console nên không cần giấu gì; cửa sổ mới vẫn được đưa xuống nền ở settleNewWindow.
 */
/** Lệnh liên kết tệp là "Open with AIVIN Office Suite" (`"…\Aivin.exe" --open "%1"`). */
export function isAivinOpenCommand(command, executable) {
  const exe = path.win32.basename(String(executable || '')).toLowerCase();
  const cmd = String(command || '');
  return (exe === 'aivin.exe' || /\baivin\.exe\b/i.test(cmd)) && /(^|\s)--open\b/i.test(cmd);
}

function launchShell(target) {
  spawn('explorer.exe', [target], { windowsHide: false, detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

function runPowerShellJson(script, signal) {
  return new Promise((resolve, reject) => {
    // Đầu ra UTF-8: tên cửa sổ / ứng dụng tiếng Việt không thành `?` (PowerShell không console ghi theo bảng mã OEM).
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${PS_UTF8_PREFIX}${script}`], { windowsHide: true });
    const chunks = [];
    c.stdout.on('data', (d) => { chunks.push(d); });
    const onAbort = () => { try { c.kill(); } catch { /* đã thoát */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    c.on('error', (e) => reject(e));
    c.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      const out = Buffer.concat(chunks).toString('utf8');
      try { const v = JSON.parse(out || 'null'); resolve(Array.isArray(v) ? v : v ? [v] : []); } catch (e) { reject(e); }
    });
  });
}

/**
 * Bộ điều khiển GUI của máy. `env.fullAccess` quyết định có cho điều khiển terminal không. `host` truyền vào được (test dùng host giả).
 */
export function createGuiController({
  fullAccess = false, host = createWindowsHost(), notify = showOSNotification, say = () => {}, background = true, defaultWindow = () => null, realInputIdleMs = REAL_INPUT_IDLE_MS, realInputWaitMs = REAL_INPUT_WAIT_MS, fetchApps = (signal) => runPowerShellJson('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress', signal),
} = {}) {
  let appsCache = null;
  let appsInflight = null;
  let lastNotifyAt = 0;
  /** Cửa sổ của từng lần observe — để kiểm ứng dụng bị chặn ở thao tác theo node_id. */
  const snapshotWindows = new Map();

  /**
   * Thao tác chạy dưới nền thì đi thẳng. Host chỉ báo GUI_PERSON_PRESENT ngay trước lần đầu đụng chuột / phím thật, lúc chưa làm gì, nên thử lại
   * là an toàn: chờ người dùng ngừng tay. Họ bận suốt → GUI_USER_ACTIVE, không có hộp hỏi nào.
   */
  async function whenPersonPauses(ctx, run) {
    const deadline = Date.now() + Math.min(realInputWaitMs, (ctx?.timeoutMs || Infinity) / 2);
    for (;;) {
      try {
        return await run(realInputIdleMs);
      } catch (e) {
        if (e?.code !== GUI_PERSON_PRESENT) throw e;
        if (ctx?.signal?.aborted) throw ctx.signal.reason;
        if (Date.now() + REAL_INPUT_POLL_MS >= deadline) throw new DeviceToolError(DeviceErrorCode.GUI_USER_ACTIVE, 'The person at this computer kept using it and this step needs the real mouse/keyboard — nothing was done. Tell them in the chat so they can do this step themselves or pause for a few seconds');
        await new Promise((r) => setTimeout(r, REAL_INPUT_POLL_MS));
      }
    }
  }

  const announce = (windowInfo) => {
    const now = Date.now();
    if (now - lastNotifyAt < NOTIFY_EVERY_MS) return;
    lastNotifyAt = now;
    say(`🖱  AI đang điều khiển ${windowInfo?.process || 'màn hình'} — di chuột hoặc gõ phím để AI dừng lại.`);
    notify({ title: 'Aivin đang điều khiển máy này', body: `AI đang thao tác trên ${windowInfo?.title || windowInfo?.process || 'màn hình'}. Di chuột hoặc gõ phím để AI dừng và hỏi bạn.` });
  };

  async function windows(args, ctx) {
    const list = await host.call('windows', { all: !!args.include_dialogs }, ctx);
    return { windows: list.map((w) => ({ ...w, blocked: BLOCKED_PROCESSES.has(normalizeProcess(w.process)) || (!fullAccess && SHELL_PROCESSES.has(normalizeProcess(w.process))) || isProtectedPromptWindow(w.title) || isWindowsSecurityPrompt(w) || undefined })) };
  }

  /**
   * Không nói cửa sổ = cửa sổ đang focus; nhưng chủ máy vừa gõ vào ô hỏi của linh vật thì focus là chính linh vật → host đổi sang cửa sổ họ
   * đang dùng ngay trước đó (`defaultWindow()` = `{ avoid_pid, fallback }`).
   */
  const target = (args) => (args.window ? { window: args.window } : { ...defaultWindow() });
  const windowInfoOf = (args, ctx) => host.call('window_info', target(args), ctx);
  /**
   * Thao tác có thay đổi mà không nêu cửa sổ (02/11/2026): không lấy cửa sổ đang focus — người dùng có thể vừa chuyển sang cửa sổ khác. Chỉ
   * cho khi hỏi từ linh vật (có cửa sổ chủ máy dùng ngay trước đó); host kiểm lại đúng lúc thao tác (linh vật có đang được focus không).
   */
  const assertWindowNamed = (windowArg) => {
    if (windowArg || defaultWindow()?.fallback) return;
    throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Name the window for this action (window / within: a handle 0x… or a title/process from gui.windows) — input is never sent to whatever window happens to be focused');
  };

  async function observe(args, ctx) {
    const res = await host.call('observe', {
      ...target(args),
      max_nodes: Math.min(Number(args.max_nodes) || OBSERVE_MAX_NODES, 1500),
      include_image: !!args.include_image,
      image_when_poor: args.image_when_poor !== false,
      ocr: typeof args.ocr === 'boolean' ? args.ocr : undefined,
      image_max_width: Number(args.image_max_width) || 1366,
      image_quality: Number(args.image_quality) || 70,
      budget_ms: Number(args.budget_ms) || undefined,
    }, ctx);
    assertWindowAllowed(res.window, { fullAccess });
    if (Array.isArray(res.nodes)) res.nodes = withoutChromeNoise(res.nodes);
    res.traits = uiTraits(res);
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
    if (!queryVariants(args.query).length) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give query (words of the element to find)');
    const res = await observe({ ...args, max_nodes: 1500, budget_ms: 10_000 }, ctx);
    return rankObservation(res, args);
  }

  /** Lọc / xếp hạng một lần observe theo mô tả (dùng chung cho gui.find và cho gui.do sau khi thêm chữ OCR vào cùng snapshot). */
  function rankObservation(res, args) {
    const role = String(args.role || '').toLowerCase();
    const max = Math.max(1, Math.min(Number(args.max) || FIND_DEFAULT, FIND_MAX));
    // gui.do chọn phần tử để BẤM: không tính nội dung ô — chữ trên màn hình (thư, trang web) không được lái việc chọn nút (02/11/2026).
    let scored = rankGuiNodes(res.nodes, args.query, role, { matchValue: args.match_value !== false, action: args.action });
    // Không có phần tử đang hiện nào khớp đủ: xét cả phần tử khuất trong vùng cuộn (mục cuối trang Settings, danh sách dài) — host cuộn tới
    // hoặc gọi pattern khi thao tác. Phần tử đang hiện luôn được ưu tiên, menu ẩn không lấn được nút đang thấy.
    if (!scored.some((x) => x.complete)) {
      const hidden = rankGuiNodes(res.nodes, args.query, role, { matchValue: args.match_value !== false, action: args.action, includeOffscreen: true });
      if (hidden.some((x) => x.complete)) scored = hidden;
    }
    const all = scored.filter((x) => x.complete);
    const cover = (x) => x.hits / x.total;
    const pool = all.length ? all : scored.filter((x) => cover(x) === cover(scored[0]));
    const picked = pool.slice(0, max);
    const margin = picked.length > 1 ? picked[0].score - picked[1].score : picked.length ? picked[0].score : 0;
    const out = { ...res, nodes: picked.map((x) => x.node), query: String(args.query), matched: all.length || scored.length, exact: all.length > 0, confidence: !picked.length ? 'none' : margin >= 15 || picked.length === 1 ? 'high' : margin >= 5 ? 'medium' : 'low', ambiguous: picked.length > 1 && margin < 5 || undefined };
    Object.defineProperty(out, '_raw_observation', { value: res, enumerable: false });
    return out;
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
    assertWindowNamed(args.within || args.window);

    if ((command === 'key' || command === 'scroll') && !args.target) {
      const result = await act({
        action, window: args.within || args.window, keys: command === 'key' ? args.value : undefined,
        direction: command === 'scroll' ? args.value : undefined,
      }, ctx);
      return { ok: true, action: command, method: result.method, effect: result.window_title_changed || result.focused_element || command };
    }

    const query = String(args.target || '').trim();
    if (!query) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give target');
    const findArgs = { query, role: args.role, window: args.within || args.window, max: SEMANTIC_CHOICES, match_value: false, action };
    let found = await find(findArgs, ctx);
    if ((!found.nodes.length || !found.exact) && !found.ocr && found.tree_quality !== 'poor') {
      // Đọc chữ trên ảnh của CHÍNH lần observe vừa rồi (cùng snapshot, id nối tiếp) — không đi lại cây trợ năng lần hai.
      const raw = found._raw_observation;
      const extra = await host.call('ocr', { snapshot: raw.snapshot }, ctx).catch(() => null);
      if (extra?.nodes?.length) {
        const viaOcr = rankObservation({ ...raw, nodes: [...raw.nodes, ...extra.nodes], ocr: extra.ocr }, findArgs);
        if (viaOcr.nodes.length && (viaOcr.exact || !found.nodes.length)) found = viaOcr;
      }
    }
    if (!found.nodes.length) throw new DeviceToolError(DeviceErrorCode.GUI_TARGET_NOT_FOUND, `No enabled visible target matched "${query}"`);
    let picked = found.ambiguous ? null : found.nodes[0];
    if (found.ambiguous && found.exact && action === GuiAction.SET_VALUE) picked = pickByLabelRow(found.nodes, found._raw_observation?.nodes || [], query);
    // Khớp một phần (không phần tử nào có đủ mọi từ) cũng là không chắc: chỉ trả ứng viên để BE phân giải, không bấm thẳng.
    if (!picked || !found.exact) return ambiguousResult(found);

    const node = groundOcrNode(picked, found._raw_observation?.nodes || [], action);
    if (command !== 'fill' && needsServerCheck(query, node)) return ambiguousResult(found);
    if (command === 'fill' && node.password) {
      throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'AI may not fill password or secret fields — ask the user to enter it');
    }
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
      ...(result.screen_point ? { screen_point: result.screen_point } : {}),
      ...(result.app_busy ? { app_busy: true } : {}),
      method: result.method,
      window_class: result.window_class,
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
    const windowInfo = await windowInfoOf(args, ctx);
    assertWindowAllowed(windowInfo, { fullAccess });
    return whenPersonPauses(ctx, (grace) => host.call('focus', { ...target(args), check_user_input: true, user_input_grace_ms: grace }, ctx));
  }

  async function act(args, ctx) {
    const action = String(args.action || GuiAction.CLICK);
    if (!Object.values(GuiAction).includes(action)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Unknown action: ${action}`);
    const snap = args.node_id ? String(args.node_id).split('.')[0] : null;
    // node_id đã chỉ đúng phần tử của một lần observe (kèm cửa sổ của nó) — chỉ thao tác không node_id mới phải nêu cửa sổ.
    if (!snap) assertWindowNamed(args.window);
    const windowInfo = snap ? snapshotWindows.get(snap) : await windowInfoOf(args, ctx);
    if (snap && !windowInfo) throw new DeviceToolError(DeviceErrorCode.GUI_STALE_NODE, `Node ${args.node_id} is from an old observation — observe again`);
    assertWindowAllowed(windowInfo, { fullAccess });
    announce(windowInfo);
    return whenPersonPauses(ctx, (grace) => host.call('act', {
      action, node_id: args.node_id, ...(args.node_id ? {} : target(args)), method: args.method, text: args.text, keys: args.keys,
      option: args.option, state: args.state, direction: args.direction, amount: args.amount, point: args.point, to: args.to,
      image_scale: args.image_scale, settle_ms: args.settle_ms,
      // Planner chỉ được xin chờ lâu hơn, không được rút ngắn: rút ngắn là tự cho phép lấy chuột của người đang dùng máy.
      check_user_input: true, user_input_grace_ms: Math.max(grace, Number(args.user_input_grace_ms) || 0),
    }, ctx));
  }

  /** Đọc cả bảng dưới nền: host tự cuộn, gộp các dòng rồi cuộn về chỗ cũ. */
  async function readTable(args, ctx) {
    const snap = args.node_id ? String(args.node_id).split('.')[0] : null;
    if (!snap || String(args.node_id).includes('.t')) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give node_id of the table (from gui.observe or gui.find)');
    const windowInfo = snapshotWindows.get(snap);
    if (!windowInfo) throw new DeviceToolError(DeviceErrorCode.GUI_STALE_NODE, `Node ${args.node_id} is from an old observation — observe again`);
    assertWindowAllowed(windowInfo, { fullAccess });
    return host.call('read_table', { node_id: args.node_id, max_rows: Math.max(1, Math.min(Number(args.max_rows) || 300, 2000)) }, ctx);
  }

  async function listApps(signal) {
    if (appsCache && Date.now() - appsCache.at < APPS_CACHE_MS) return appsCache.apps;
    if (appsInflight && !signal) return appsInflight;
    const task = Promise.resolve().then(() => fetchApps(signal)).catch(() => []).then((rows) => {
      const apps = (rows || []).filter((r) => r?.Name && r?.AppID).map((r) => ({ name: String(r.Name), app_id: String(r.AppID) }));
      if (apps.length) appsCache = { at: Date.now(), apps };
      return apps.length ? apps : (appsCache?.apps || []);
    }).finally(() => { if (appsInflight === task) appsInflight = null; });
    if (!signal) appsInflight = task;
    return task;
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

  /**
   * Cửa sổ đang hiện tệp vừa mở: tiêu đề chứa tên tệp, là cửa sổ mới HOẶC cửa sổ có sẵn vừa đổi tiêu đề. gui-bench 13/11/2026: Notepad / Excel /
   * Explorer đang chạy thì mở tệp thành tab trong cửa sổ cũ và đóng cửa sổ tạm — trước đây trả về cửa sổ tạm (đã chết, GUI_WINDOW_GONE ở bước
   * sau) hoặc chờ đủ 10 s "cửa sổ mới" không bao giờ tới. Ứng dụng không ghi tên tệp lên tiêu đề → lấy cửa sổ mới đầu tiên còn sống.
   */
  async function waitFileWindow(before, base, ctx) {
    const want = normalizeName(base);
    const titleOf = new Map(before.map((w) => [w.window, w.title]));
    const started = Date.now();
    const deadline = started + OPEN_FILE_WAIT_MS;
    let firstFresh = null;
    let freshSince = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const now = await host.call('windows', {}, ctx);
      const showing = now.filter((w) => normalizeName(w.title).includes(want));
      const hit = showing.find((w) => titleOf.get(w.window) !== w.title)
        // Tệp đã mở sẵn ở tab đang hiện: tiêu đề không đổi — nhận sau một nhịp (không thì vừa mở là trả ngay cửa sổ cũ trước khi tab mới kịp hiện).
        || (Date.now() - started > 1500 ? showing[0] : undefined);
      if (hit) return hit;
      const fresh = now.find((w) => !titleOf.has(w.window));
      if (fresh && !firstFresh) { firstFresh = fresh; freshSince = Date.now(); }
      if (firstFresh && !now.some((w) => w.window === firstFresh.window)) firstFresh = null;
      // Cửa sổ mới đã đứng yên một lúc mà tiêu đề không có tên tệp: ứng dụng đó không ghi tên tệp lên tiêu đề.
      if (firstFresh && Date.now() - freshSince > 2500) return now.find((w) => w.window === firstFresh.window);
    }
    return firstFresh;
  }

  /** Cửa sổ đang ở trên cùng trước khi mở ứng dụng, kể cả loại không có trong gui.windows (hộp hệ thống, cửa sổ công cụ). */
  const currentForeground = (ctx) => host.call('window_info', {}, ctx).then((w) => w?.window).catch(() => undefined);

  /**
   * Cửa sổ AI vừa mở được Windows đưa lên trước → đẩy xuống dưới, trả focus cho cửa sổ người dùng đang dùng (chạy nền). Ứng dụng thường tự
   * kích hoạt lại ngay sau khi cửa sổ hiện ra, nên làm thêm vài lượt ngắn; host chỉ trả focus khi nó vẫn đang ở ứng dụng vừa mở.
   */
  async function sendToBack(win, userWindow, ctx) {
    if (!win || background === false) return;
    for (const [i, wait] of [0, 350, 600].entries()) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (ctx.signal?.aborted) return;
      await host.call('to_back', { window: win.window, restore_to: userWindow, wait_content: i === 0 }, ctx).catch(() => undefined);
    }
  }

  /** Đưa cửa sổ mới xuống nền; cửa sổ đầu tiên đôi khi chỉ là màn hình chờ đã đóng (Sticky Notes) → trả cửa sổ thật thay vì handle đã chết. */
  async function settleNewWindow(win, before, userWindow, hint, ctx) {
    if (!win) return win;
    await sendToBack(win, userWindow, ctx);
    const alive = await host.call('window_info', { window: win.window }, ctx).then(() => true).catch(() => false);
    if (alive) return win;
    const next = await waitNewWindow(before, ctx, hint);
    await sendToBack(next, userWindow, ctx);
    return next;
  }

  /**
   * Chặn mở tệp khi ứng dụng Windows sẽ dùng là "Open with AIVIN Office Suite" (`Aivin.exe --open`) — 13/11/2026, gui-bench: `.csv` trong HKCU
   * trỏ tới ProgID không tồn tại nên Windows rơi về verb AIVIN, tệp bị đem TẢI LÊN Drive thay vì mở trong Excel. AI mở tệp trên máy không được
   * kéo theo việc tải tệp lên mạng. Host không trả lời được thì cho qua (không chặn nhầm vì lỗi tra cứu).
   */
  async function assertNotAivinOpen(abs, ctx) {
    const ext = path.extname(abs);
    if (!ext) return;
    const assoc = await host.call('assoc', { ext }, ctx).catch(() => null);
    if (!assoc || !isAivinOpenCommand(assoc.command, assoc.executable)) return;
    throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP,
      `Windows opens ${ext} files on this computer with "AIVIN Office Suite", which uploads the file to Drive — not opened. Open the app by name (e.g. gui.open_app name="Excel") and open the file from there, or ask the user`);
  }

  /** Mở ứng dụng theo tên trong danh sách Start, hoặc mở một tệp trong vùng được phép bằng ứng dụng mặc định. Không chạy lệnh tuỳ ý. */
  async function openApp(args, ctx, env) {
    const before = await host.call('windows', {}, ctx);
    const userWindow = await currentForeground(ctx);
    if (args.file) {
      const abs = resolveInRoots(env.roots, String(args.file));
      if (EXECUTABLE_EXT.test(abs)) throw new DeviceToolError(DeviceErrorCode.GUI_BLOCKED_APP, 'Opening programs or scripts is not allowed — use an app name, or shell.exec');
      if (!fs.existsSync(abs)) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `File not found: ${args.file}`);
      await assertNotAivinOpen(abs, ctx);
      launchShell(abs);
      const base = path.basename(abs, path.extname(abs));
      const shown = await waitFileWindow(before, base, ctx);
      const win = shown && before.some((w) => w.window === shown.window)
        ? (await sendToBack(shown, userWindow, ctx), shown)
        : await settleNewWindow(shown, before, userWindow, base, ctx);
      return { opened: path.basename(abs), window: win, hint: win ? undefined : 'No window shows this file yet — Windows may have no working default app for this file type; check gui.windows, or open the app by name' };
    }
    const name = String(args.name || '').trim();
    if (!name) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give name (an installed app) or file');
    const matches = matchApps(await listApps(ctx.signal), name);
    if (!matches.length) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No installed app named "${name}"`);
    if (matches.length > 1 && !args.first) return { ambiguous: true, candidates: matches.slice(0, 10).map((m) => m.name), hint: 'Call again with the exact name' };
    const app = matches[0];
    assertAppAllowed(app.name, { fullAccess });
    launchShell(`shell:AppsFolder\\${app.app_id}`);
    const win = await settleNewWindow(await waitNewWindow(before, ctx, app.name), before, userWindow, app.name, ctx);
    if (win) assertWindowAllowed(win, { fullAccess });
    return { opened: app.name, window: win, hint: win ? undefined : 'App started but no new window yet — call gui.windows in a moment' };
  }

  return { windows, observe, find, waitFor, focus, act, readTable, semanticDo, openApp, prewarm: () => listApps(), close: () => host.close() };
}

/** Công cụ GUI cho danh mục của Planner. */
export function buildGuiTools(gui) {
  const target = {
    node_id: str('target element id from the latest gui.observe (preferred)'),
    window: str('window handle (0x…) or a title/process to match; reading defaults to the focused window, but an action without node_id must name it (asked from the mascot: the window the person was using)'),
  };
  return [
    { name: 'gui.do', group: ToolGroup.GUI, handler: (a, c, e) => gui.semanticDo(a, c, e),
      description: 'Fast semantic desktop action. State the intent briefly; the device finds one enabled visible target, refuses ambiguity, acts, and verifies simple value/state changes. Use precise gui.find/gui.act only after an ambiguous result.',
      input_schema: schema({
        do: str('click | fill | select | toggle | key | scroll | open'), target: str('short visible label or app name'),
        value: str('text, option, on/off, key chord, or scroll direction'), within: str('window title/process to act in (required, except when asked from the mascot)'),
        role: str('optional role such as button or edit'), file: str('document path for open'),
      }, ['do']) },
    { name: 'gui.windows', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.windows(a, c),
      description: 'List open desktop windows: title, app process, handle, position, which is focused/minimized. blocked = the AI may not control it.',
      input_schema: schema({ include_dialogs: bool('also list owned dialogs') }) },
    { name: 'gui.observe', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.observe(a, c),
      description: 'Read a window as an accessibility tree: each element has an id (node_id), role, name, value, state and supported actions. tree_quality "poor" = the app draws its own UI; a screenshot is then attached and the text on it is read on the device (OCR): each text run becomes a node with role "text", source "ocr" and an id like "4.t2" that gui.act can click / type at. Ids are only valid until the next observe of that window. truncated_by = why the list is partial: time / long_list (a very long table or list; scroll it, or use gui.find) / node_limit. In a long table scrolled far down, the rows on screen come back with role "row", source "accessible" and an id like "4.t2" that gui.act can click. content_unavailable = a Store app shows only its frame because it is still starting or suspended — gui.focus it, then observe again. traits = kind of UI (chromium, uwp, winforms, wpf, win32_dialog, poor_tree, modal_dialog, long_list, data_grid, ocr_text, password_field, open_menu) — modal_dialog: the window is blocked by its own dialog and the result shows that dialog; data_grid / long_list: prefer gui.read_table or select by value over scrolling. image_error = no screenshot this time (the app can only be captured from the screen and the window is behind/covered — gui.focus it first if a screenshot is needed).',
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
    { name: 'gui.read_table', group: ToolGroup.GUI, read_only: true, handler: (a, c) => gui.readTable(a, c),
      description: 'Read a whole long table as data, in the background: scrolls it, joins the rows, scrolls back. Prefer this to observing and scrolling screen by screen. node_id = the table, from gui.observe or gui.find. Returns columns, rows (each one line of cells), complete, reason when incomplete, gaps = rows may be missing between pages.',
      input_schema: schema({ node_id: target.node_id, max_rows: num('default 300, at most 2000') }, ['node_id']) },
    { name: 'gui.focus', group: ToolGroup.GUI, handler: (a, c) => gui.focus(a, c),
      description: 'Bring a window to the front (restores it if minimized). This takes the screen from the person using the computer: most actions work on windows behind others, so only use it when an action really needs the window in front.',
      input_schema: schema({ window: target.window }, ['window']) },
    { name: 'gui.act', group: ToolGroup.GUI, handler: (a, c) => gui.act(a, c),
      description: 'Runs behind the person\'s windows whenever the app allows it. Result method: invoke/value/select/toggle/scroll/background/posted = done without the real mouse; accessible = the control selected the item but no click event fired, so check the app reacted (observe) before relying on it. The real mouse/keyboard is only borrowed when the person pauses for a moment, then given back; GUI_USER_ACTIVE = they kept using the computer, nothing was done, so tell them in the chat. Do one action on an element (node_id) or at a point of the last screenshot: click, double_click, right_click, set_value (replace a field\'s text), type (keystrokes into the focused element), key (shortcut like "ctrl+s", "alt+f4", "enter"), scroll, select (option of a list/combo), toggle, expand, collapse, drag. Uses accessibility actions first (works even when the window is behind), real mouse/keyboard otherwise. Returns evidence: the element\'s new value/state, window title change, focused element; app_busy = the action ran but the app is still working, so no evidence yet — gui.wait_for or observe later. OCR text nodes ("4.t2") take click / double_click / right_click, or set_value / type (clicks there, then types). Without node_id give window. Stops with GUI_USER_ACTIVE if the person is using the mouse/keyboard, and with GUI_FOCUS_LOST (nothing clicked / the rest not typed) if real mouse/keyboard input could not reach the window — it could not come to the front, or another window covers the point.',
      // method trong kết quả: posted = gửi thẳng vào cửa sổ; accessible = control tự chọn mục, không phát sự kiện bấm.
      input_schema: schema({
        action: str(Object.values(GuiAction).join(' | ')), ...target, text: str('text for set_value / type'), keys: str('for key: e.g. "ctrl+s", several separated by spaces'),
        option: str('for select: the option name'), state: str('for toggle: on | off'), direction: str('for scroll: up | down | left | right'), amount: num('scroll steps, default 3'),
        point: { type: 'object', description: '{x,y} on the last screenshot when no node_id', properties: { x: num('x'), y: num('y') } },
        to: { type: 'object', description: 'drag destination {x,y} on the last screenshot', properties: { x: num('x'), y: num('y') } },
        image_scale: num('scale of the screenshot the point was taken from'), method: str('auto | pattern | mouse | background (default auto; background = never touch the real mouse/keyboard, fail with GUI_NEEDS_REAL_INPUT instead)'),
      }, ['action']) },
    { name: 'gui.open_app', group: ToolGroup.GUI, handler: (a, c, e) => gui.openApp(a, c, e),
      description: 'Open an installed app by name (from the Start menu list), or open a document file with its default app. Returns the new window. Does not run programs or scripts by path.',
      input_schema: schema({ name: str('app name, e.g. "Excel", "Calculator"'), file: str('a document path inside the allowed folders'), first: bool('take the first match when several apps share the name') }) },
  ];
}
