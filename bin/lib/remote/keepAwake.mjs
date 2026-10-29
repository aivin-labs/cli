import { spawn } from 'child_process';
import fs from 'fs';

/**
 * Giữ máy không ngủ khi agent đang làm việc trên máy (29/10/2026). Trước đây máy tự ngủ giữa lúc chạy lệnh dài / tiến trình nền → mất
 * kết nối, việc dở. Chỉ chặn ngủ do RẢNH (idle sleep): gập máy / bấm Sleep / pin cạn vẫn ngủ như thường.
 *
 * Một tiến trình phụ giữ cờ chặn ngủ của hệ điều hành, chỉ chạy khi bận: Windows `SetThreadExecutionState` (PowerShell), macOS
 * `caffeinate -i`, Linux `systemd-inhibit`. Tiến trình phụ thoát khi stdin đóng / daemon chết → cờ tự gỡ, không kẹt máy thức mãi.
 */

/** Bận ngắn hơn bấy nhiêu thì không bật (đọc tệp 50 ms không đáng mở tiến trình phụ). */
const START_DELAY_MS = 5_000;
/** Rảnh bấy nhiêu lâu rồi mới thả cờ (lô bước kế thường tới ngay sau). */
const IDLE_RELEASE_MS = 60_000;

const WINDOWS_SCRIPT = [
  "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  "$k = Add-Type -MemberDefinition $sig -Name AivinAwake -Namespace Aivin -PassThru",
  // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: chặn ngủ do rảnh, KHÔNG giữ màn hình sáng.
  '[void]$k::SetThreadExecutionState([uint32]2147483649)',
  '[void][Console]::In.ReadToEnd()',
].join('; ');

function hasLinuxInhibit() {
  return ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'].some((p) => fs.existsSync(p));
}

/** Lệnh giữ máy thức theo hệ điều hành — `null` khi không có cách nào. */
export function keepAwakeCommand(platform = process.platform, { pid = process.pid, linuxInhibit = hasLinuxInhibit } = {}) {
  if (platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT] };
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'linux' && linuxInhibit()) {
    return { cmd: 'systemd-inhibit', args: ['--what=idle:sleep', '--who=Aivin', '--why=Aivin agent is working on this computer', '--mode=block', 'cat'] };
  }
  return null;
}

/**
 * `hold(reason)` / `release(reason)` đếm theo lý do (mỗi lời gọi đang chạy một lần, tiến trình nền một lần). Bận liên tục quá
 * `startDelayMs` → bật; hết bận `idleMs` → tắt.
 */
export function createKeepAwake({ enabled = true, platform = process.platform, spawnImpl = spawn, startDelayMs = START_DELAY_MS, idleMs = IDLE_RELEASE_MS, say } = {}) {
  const command = enabled ? keepAwakeCommand(platform) : null;
  let holds = 0;
  let child = null;
  let startTimer = null;
  let stopTimer = null;

  const startChild = () => {
    startTimer = null;
    if (child || holds <= 0 || !command) return;
    try {
      child = spawnImpl(command.cmd, command.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', () => { child = null; });
      child.on('exit', () => { child = null; });
      say?.('☕ Đang có việc — giữ máy không tự ngủ');
    } catch {
      child = null;
    }
  };

  const stopChild = () => {
    stopTimer = null;
    if (!child) return;
    const c = child;
    child = null;
    try { c.stdin?.end(); } catch { /* đã đóng */ }
    try { c.kill(); } catch { /* đã thoát */ }
  };

  return {
    hold() {
      holds++;
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      if (!child && !startTimer && command) {
        startTimer = setTimeout(startChild, startDelayMs);
        startTimer.unref?.();
      }
    },
    release() {
      holds = Math.max(0, holds - 1);
      if (holds > 0) return;
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      if (child && !stopTimer) {
        stopTimer = setTimeout(stopChild, idleMs);
        stopTimer.unref?.();
      }
    },
    close() {
      holds = 0;
      if (startTimer) clearTimeout(startTimer);
      if (stopTimer) clearTimeout(stopTimer);
      startTimer = null;
      stopChild();
    },
    active: () => !!child,
    holds: () => holds,
  };
}
