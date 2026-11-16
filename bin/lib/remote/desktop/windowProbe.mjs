import { execFile } from 'child_process';
import { createCscExe, runFile } from './cscExe.mjs';

/**
 * Trình duyệt xem màn hình có đang mở NGAY TRÊN máy này không (16/11/2026) — cách chắc nhất, không phụ thuộc mạng: trang web gắn tạm một mã
 * ngắn vào tiêu đề tab (`AIVIN · #k3f9x2`), máy chủ hỏi máy "có cửa sổ nào mang mã này không". Cửa sổ trình duyệt lấy tiêu đề theo tab đang
 * mở → có cửa sổ đó thì người xem đang ngồi trước chính máy này (mở xem màn hình sẽ thành hình lặp vô tận). Chỉ trả có / không, không lộ tiêu
 * đề cửa sổ nào khác. Trình duyệt nhúng trong app khác (tiêu đề theo app) không bắt được — lưới sau là kiểm địa chỉ WebRTC (desktopWebRtc).
 *
 * Đọc bằng exe nhỏ biên dịch một lần (cscExe.mjs), ~30 ms mỗi lần. Không dựng được → `null` (máy chủ coi như không đo được).
 */

const SOURCE = `using System; using System.Text; using System.Runtime.InteropServices;
class AivinWindowProbe {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int max);
  static int Main(string[] args) {
    if (args.Length != 1 || args[0].Length < 6) return 2;
    string needle = args[0];
    bool found = false;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLengthW(h);
      if (n <= 0) return true;
      var sb = new StringBuilder(n + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(needle, StringComparison.Ordinal) >= 0) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    Console.Out.Write(found ? "1" : "0");
    return 0;
  }
}
`;

const RUN_TIMEOUT_MS = 3_000;
/** Mã trang gắn vào tiêu đề: chữ thường + số, 6–16 ký tự (không để trang đưa chuỗi tuỳ ý vào dòng lệnh). */
export const WINDOW_PROBE_NONCE_RE = /^[a-z0-9]{6,16}$/;

const exe = createCscExe({ name: 'aivin-winprobe', source: SOURCE });

export function windowProbeSupported(platform = process.platform) {
  return platform === 'win32' && process.env.AIVIN_WINDOW_PROBE !== '0';
}

/** Dựng sẵn exe (gọi lúc CLI nối để lần hỏi đầu không phải chờ csc). */
export function prepareWindowProbe({ platform = process.platform } = {}) {
  return windowProbeSupported(platform) ? exe.prepare({ platform }) : Promise.resolve(null);
}

/** Có cửa sổ hiện trên màn hình mang `nonce` trong tiêu đề không — `true` / `false`, hoặc `null` khi không đọc được. */
export async function findWindowTitle(nonce, { platform = process.platform, prepare = prepareWindowProbe, execFileImpl = execFile } = {}) {
  if (!WINDOW_PROBE_NONCE_RE.test(String(nonce || ''))) return null;
  const file = await prepare({ platform });
  if (!file) return null;
  try {
    const out = (await runFile(file, [String(nonce)], { timeout: RUN_TIMEOUT_MS, execFileImpl })).trim();
    return out === '1' ? true : out === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Chỉ cho test: quên trạng thái dựng. */
export function resetWindowProbeForTest() { exe.reset(); }
