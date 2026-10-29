import { spawnSync } from 'child_process';

/**
 * Phím tắt gọi linh vật (29/10/2026): một tổ hợp toàn hệ thống (`RegisterHotKey`, không móc bàn phím) — bấm → mở ô hỏi + nghe luôn. Mặc định
 * thử lần lượt `DEFAULT_HOTKEYS`, lấy tổ hợp đầu tiên đăng ký được (mỗi máy cài app khác nhau: máy dev 29/10 có Ctrl+Alt+Space,
 * Ctrl+Win+Space, Win+Shift+Space đều đã bị giữ — lỗi 1409). Chủ máy đặt riêng: `aivin remote mascot hotkey <tổ hợp> | off` (mascot.json).
 */

export const HOTKEY_MODS = Object.freeze({ alt: 0x1, ctrl: 0x2, shift: 0x4, win: 0x8 });
export const MOD_NOREPEAT = 0x4000;
export const DEFAULT_HOTKEYS = Object.freeze(['Win+Alt+Space', 'Ctrl+Shift+Alt+Space', 'Ctrl+Shift+Alt+A']);

const MOD_ALIASES = { alt: 'alt', option: 'alt', ctrl: 'ctrl', control: 'ctrl', shift: 'shift', win: 'win', windows: 'win', super: 'win', meta: 'win', cmd: 'win' };
const NAMED_KEYS = { space: 0x20, enter: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, insert: 0x2d, delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, '`': 0xc0, '/': 0xbf, '.': 0xbe, ',': 0xbc, ';': 0xba };
const MOD_ORDER = ['win', 'ctrl', 'shift', 'alt'];

function keyCode(name) {
  const k = name.toLowerCase();
  if (NAMED_KEYS[k] !== undefined) return { vk: NAMED_KEYS[k], label: k.length === 1 ? k : k[0].toUpperCase() + k.slice(1) };
  if (/^[a-z0-9]$/.test(k)) return { vk: k.toUpperCase().charCodeAt(0), label: k.toUpperCase() };
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(k);
  if (f) return { vk: 0x6f + Number(f[1]), label: `F${f[1]}` };
  return null;
}

/** "win+alt+space" → `{ mods, vk, label: 'Win+Alt+Space' }`; sai → ném Error có lý do. Phải có Ctrl / Alt / Win (Shift + phím = gõ chữ hoa). */
export function parseHotkey(text) {
  const parts = String(text || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error(`"${text}" is not a key combination — e.g. Win+Alt+Space`);
  const mods = new Set();
  for (const p of parts.slice(0, -1)) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" — use Ctrl, Alt, Shift, Win`);
    mods.add(m);
  }
  if (!mods.has('ctrl') && !mods.has('alt') && !mods.has('win')) throw new Error('Use at least one of Ctrl, Alt or Win');
  const key = keyCode(parts.at(-1));
  if (!key) throw new Error(`Unknown key "${parts.at(-1)}" — use a letter, digit, F1–F24, Space…`);
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return {
    mods: ordered.reduce((acc, m) => acc | HOTKEY_MODS[m], 0),
    vk: key.vk,
    label: [...ordered.map((m) => m[0].toUpperCase() + m.slice(1)), key.label].join('+'),
  };
}

/** Thứ tự thử: tổ hợp chủ máy đặt (nếu có) rồi mặc định; `off` → không có. */
export function hotkeyCandidates(setting) {
  if (setting === 'off' || setting === false) return [];
  const list = setting ? [setting, ...DEFAULT_HOTKEYS] : [...DEFAULT_HOTKEYS];
  const seen = new Set();
  return list.map((h) => { try { return parseHotkey(h); } catch { return null; } }).filter((h) => h && !seen.has(h.label) && seen.add(h.label));
}

/**
 * Tổ hợp có đăng ký được trên máy này ngay lúc này không (đăng ký thử rồi trả lại). Chỉ Windows; nơi khác → null (không biết).
 * Lúc linh vật đang chạy thì tổ hợp nó đang giữ báo "bị giữ" — chính nó giữ.
 */
export function probeHotkey(hotkey, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return null;
  const script = 'Add-Type -Namespace AivinHk -Name N -MemberDefinition \'[DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr h,int id,uint m,uint vk); [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h,int id);\'; '
    + `$ok = [AivinHk.N]::RegisterHotKey([IntPtr]::Zero, 7, ${hotkey.mods | MOD_NOREPEAT}, ${hotkey.vk}); if ($ok) { [void][AivinHk.N]::UnregisterHotKey([IntPtr]::Zero, 7); 'free' } else { 'taken' }`;
  const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const out = String(res.stdout || '').trim();
  return out === 'free' ? true : out === 'taken' ? false : null;
}
