/**
 * Chốt "chỉ người thật bấm được" cho các hộp xác nhận của Aivin trên Windows (hộp xác nhận tại máy, hộp đồng ý chia sẻ màn hình) — 09/11/2026.
 *
 * Hộp là cửa sổ WPF thường: AI bấm được nút "Cho phép" bằng `gui.do` / `gui.act` (lệnh Invoke của UI Automation — không sinh thao tác nào),
 * bằng script `SendInput` / UIAutomation chạy qua `shell.exec`, hay một tiến trình nền đã cài sẵn. Chốt này cài hook chuột / phím mức thấp
 * (WH_MOUSE_LL / WH_KEYBOARD_LL) trong tiến trình của hộp và chỉ nhận "Cho phép" khi vừa có thao tác THẬT trên chính hộp:
 * - phím / chuột phần cứng (không mang cờ `INJECTED`), bấm trong hộp (chuột) hoặc lúc hộp đang ở trước (phím);
 * - hoặc thao tác do tiến trình xem + điều khiển màn hình của Aivin bơm vào mang đúng `tag` bí mật của phiên (`dwExtraInfo`), để chủ máy đang
 *   điều khiển từ xa vẫn duyệt được hộp xác nhận (hộp đồng ý chia sẻ màn hình thì không nhận tag: chỉ người thật ở máy).
 * Lệnh Invoke qua UI Automation không có thao tác nào đi kèm → bị bỏ. "Từ chối" không cần chốt.
 *
 * Không cài được hook (máy không biên dịch được C#) → hộp hoạt động như trước (không chặn ai) — kẻ tấn công không tự gây ra được tình huống này.
 * Giới hạn: mã độc cùng tài khoản đọc được bộ nhớ tiến trình (lấy `tag`) vẫn lách được — cách ly thật cần tài khoản hệ điều hành riêng.
 */

import { randomInt } from 'crypto';

/** Tiêu đề cửa sổ các hộp chỉ người ở máy trả lời — công cụ GUI của AI không thao tác lên chúng (gui/index.mjs). */
export const CONFIRM_WINDOW_TITLE = 'Aivin — xác nhận trên máy này';
export const CAST_CONSENT_WINDOW_TITLE = 'Aivin — Xác nhận chia sẻ màn hình';
const PROTECTED_TITLES = new Set([CONFIRM_WINDOW_TITLE, CAST_CONSENT_WINDOW_TITLE].map((t) => t.toLowerCase()));

export function isProtectedPromptWindow(title) {
  return PROTECTED_TITLES.has(String(title ?? '').trim().toLowerCase());
}

/** C# 5 (Add-Type của PowerShell 5.1). Cờ: LLMHF_INJECTED 0x1 | LLMHF_LOWER_IL_INJECTED 0x2; LLKHF_INJECTED 0x10 | LLKHF_LOWER_IL_INJECTED 0x2. */
export const HUMAN_GUARD_CSHARP = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class AivinHumanGuard {
  public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPhysicalPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBLL { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
  static HookProc mouseProc;
  static HookProc keyProc;
  static IntPtr mouseHook = IntPtr.Zero;
  static IntPtr keyHook = IntPtr.Zero;
  static readonly Stopwatch clock = Stopwatch.StartNew();
  static long lastTrusted = -1;
  static IntPtr window = IntPtr.Zero;
  static long tag = 0;
  static bool Trusted(bool injected, IntPtr extra) { return !injected || (tag != 0 && (extra.ToInt64() & 0xFFFFFFFFL) == tag); }
  static IntPtr OnMouse(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      int m = w.ToInt32();
      if (m == 0x0201 || m == 0x0204 || m == 0x0207) {
        MSLL s = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
        if (Trusted((s.flags & 0x3) != 0, s.extra) && window != IntPtr.Zero && GetAncestor(WindowFromPhysicalPoint(s.pt), 2) == window) lastTrusted = clock.ElapsedMilliseconds;
      }
    }
    return CallNextHookEx(mouseHook, code, w, l);
  }
  static IntPtr OnKey(int code, IntPtr w, IntPtr l) {
    if (code >= 0) {
      int m = w.ToInt32();
      if (m == 0x0100 || m == 0x0104) {
        KBLL s = (KBLL)Marshal.PtrToStructure(l, typeof(KBLL));
        if (Trusted((s.flags & 0x12) != 0, s.extra) && window != IntPtr.Zero && GetForegroundWindow() == window) lastTrusted = clock.ElapsedMilliseconds;
      }
    }
    return CallNextHookEx(keyHook, code, w, l);
  }
  public static bool Install(IntPtr hwnd, long trustedTag) {
    window = hwnd;
    tag = trustedTag;
    mouseProc = OnMouse;
    keyProc = OnKey;
    IntPtr mod = GetModuleHandle(null);
    mouseHook = SetWindowsHookEx(14, mouseProc, mod, 0);
    keyHook = SetWindowsHookEx(13, keyProc, mod, 0);
    return mouseHook != IntPtr.Zero && keyHook != IntPtr.Zero;
  }
  public static bool Recent(int ms) { return lastTrusted >= 0 && clock.ElapsedMilliseconds - lastTrusted <= ms; }
}
`;

/**
 * `tag` cho một phiên điều khiển màn hình: số 31 bit ngẫu nhiên khác 0. Windows chỉ chuyển 32 bit thấp của `dwExtraInfo` tới hook mức thấp (đo
 * 09/11/2026: tag 48 bit tới nơi bị cắt còn 32 bit) — nên tag không vượt 32 bit, so đúng 32 bit thấp.
 */
export function newInputTag() {
  return randomInt(0x1000_0000, 0x7fff_ffff);
}

/** Bấm "Cho phép" được tính khi thao tác thật cuối cùng trên hộp cách đó không quá bấy nhiêu ms (nhấn giữ chuột lâu vẫn qua). */
export const HUMAN_RECENT_MS = 4000;

/** Biến môi trường của hộp: mã C# + `tag` tin cậy (chuỗi rỗng = chỉ phím / chuột phần cứng). */
export function humanGuardEnv(trustTag = null) {
  return {
    AIVIN_GUARD_CS: Buffer.from(HUMAN_GUARD_CSHARP, 'utf8').toString('base64'),
    AIVIN_GUARD_TAG: trustTag ? String(trustTag) : '',
    AIVIN_GUARD_HINT: Buffer.from('Chỉ nhận bấm bằng chuột / bàn phím thật trên máy này', 'utf8').toString('base64'),
  };
}

/**
 * Dòng PowerShell dùng chung (cần hàm `D` giải base64 của script hộp): nạp chốt, `Install-Guard $w` sau khi cửa sổ hiện, `Test-Human` trong
 * nút "Cho phép", `Guard-Hint` → chữ nhắc khi bị bỏ.
 */
export const HUMAN_GUARD_PS = [
  '$script:guard = $false',
  "try { Add-Type -TypeDefinition (D 'AIVIN_GUARD_CS') -ErrorAction Stop; $script:guard = $true } catch { }",
  'function Install-Guard($win) { if (-not $script:guard) { return }; try { $h = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle; $tg = [long]0; [void][long]::TryParse([string]$env:AIVIN_GUARD_TAG, [ref]$tg); if (-not [AivinHumanGuard]::Install($h, $tg)) { $script:guard = $false } } catch { $script:guard = $false } }',
  `function Test-Human { if (-not $script:guard) { return $true }; return [AivinHumanGuard]::Recent(${HUMAN_RECENT_MS}) }`,
  "$script:hintLeft = 0; $script:hint = D 'AIVIN_GUARD_HINT'",
];
