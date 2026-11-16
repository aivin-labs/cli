import { execFile } from 'child_process';
import { createCscExe, runFile } from './cscExe.mjs';

/**
 * Máy rảnh tay bao lâu (16/11/2026): số ms từ lần chuột / phím cuối cùng trên màn hình của máy (Windows `GetLastInputInfo`).
 *
 * Dùng để máy chủ phân biệt "trình duyệt đang mở ngay trên máy này" với "máy khác cùng mạng": hai PC chung một mạng có cùng IP công cộng,
 * nên trùng IP không chứng minh được gì. Người dùng vừa bấm trong trình duyệt cách đây X ms; nếu trình duyệt chạy trên máy này thì cú bấm
 * đó cũng là thao tác trên máy này → máy không thể rảnh lâu hơn X. Rảnh lâu hơn hẳn ⇒ chắc chắn là máy khác. Menu chọn máy trên web cũng
 * dùng con số này để ghi "đang có người dùng" / "rảnh 2 giờ".
 *
 * Đọc bằng exe nhỏ biên dịch một lần (cscExe.mjs), ~30 ms mỗi lần. Không dựng được → `null` (máy chủ coi như không đo được, không chặn).
 */

const SOURCE = `using System; using System.Runtime.InteropServices;
class AivinIdle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  static int Main() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 1;
    Console.Out.Write(unchecked(GetTickCount() - info.dwTime));
    return 0;
  }
}
`;

const RUN_TIMEOUT_MS = 3_000;
const exe = createCscExe({ name: 'aivin-idle', source: SOURCE });
export const HUMAN_IDLE_HELPER_PATH = exe.path;

/** Máy này đọc được thời gian rảnh tay không (chỉ Windows — Desktop Scenecast cũng chỉ có trên Windows). */
export function humanIdleSupported(platform = process.platform) {
  return platform === 'win32' && process.env.AIVIN_HUMAN_IDLE !== '0';
}

/** Dựng sẵn exe (gọi sớm lúc CLI nối để lần hỏi đầu không phải chờ csc). */
export function prepareHumanIdle({ platform = process.platform } = {}) {
  return humanIdleSupported(platform) ? exe.prepare({ platform }) : Promise.resolve(null);
}

/** Số ms rảnh tay, hoặc `null` khi không đọc được (không phải Windows, chưa dựng được exe, exe lỗi / quá hạn). */
export async function readHumanIdleMs({ platform = process.platform, prepare = prepareHumanIdle, execFileImpl = execFile } = {}) {
  const file = await prepare({ platform });
  if (!file) return null;
  try {
    const out = (await runFile(file, [], { timeout: RUN_TIMEOUT_MS, execFileImpl })).trim();
    const ms = Number(out);
    return /^\d+$/.test(out) && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Chỉ cho test: quên trạng thái dựng. */
export function resetHumanIdleForTest() { exe.reset(); }
