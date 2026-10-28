import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR } from '../constants.mjs';
import { DeviceToolError } from '../sandbox.mjs';
import { WINDOWS_HOST_CSHARP, WINDOWS_HOST_PS1 } from './windowsHostSource.mjs';

/**
 * Một tiến trình PowerShell sống suốt phiên làm cầu UI Automation (xem windowsHostSource.mjs). Lần đầu dịch mã C# (~vài giây) rồi lưu DLL
 * theo dấu vân tay mã vào `~/.aivin/gui/`, các lần sau nạp DLL (~0,6 s). Lời gọi tuần tự theo `id`; một lời gọi treo (ứng dụng đích treo
 * thì UI Automation chờ mãi) → huỷ = giết tiến trình, lời gọi sau tự dựng lại.
 */

const GUI_DIR = path.join(REMOTE_CONFIG_DIR, 'gui');
const READY_TIMEOUT_MS = 60_000;

function hostFiles() {
  const hash = createHash('sha256').update(WINDOWS_HOST_CSHARP).update(WINDOWS_HOST_PS1).digest('hex').slice(0, 16);
  fs.mkdirSync(GUI_DIR, { recursive: true });
  const src = path.join(GUI_DIR, `host-${hash}.cs`);
  const ps1 = path.join(GUI_DIR, `host-${hash}.ps1`);
  if (!fs.existsSync(src)) fs.writeFileSync(src, WINDOWS_HOST_CSHARP);
  if (!fs.existsSync(ps1)) fs.writeFileSync(ps1, WINDOWS_HOST_PS1);
  // Bản cũ của các phiên bản CLI trước — dọn để thư mục không phình.
  for (const name of fs.readdirSync(GUI_DIR)) {
    if (name.startsWith('host-') && !name.startsWith(`host-${hash}`)) fs.rmSync(path.join(GUI_DIR, name), { force: true });
  }
  return { src, ps1, dll: path.join(GUI_DIR, `host-${hash}.dll`) };
}

export function createWindowsHost({ spawnImpl = spawn } = {}) {
  let child = null;
  let starting = null;
  let seq = 0;
  const waiters = new Map();

  const failAll = (error) => {
    for (const w of waiters.values()) w.reject(error);
    waiters.clear();
  };

  const kill = () => {
    const c = child;
    child = null;
    starting = null;
    if (!c) return;
    try { spawnImpl('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }); } catch { /* đã chết */ }
  };

  function start() {
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const files = hostFiles();
      const c = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', files.ps1], {
        env: { ...process.env, AIVIN_GUI_SRC: files.src, AIVIN_GUI_DLL: files.dll },
        windowsHide: true,
      });
      child = c;
      let stderr = '';
      let ready = false;
      const timer = setTimeout(() => { if (!ready) { kill(); reject(new DeviceToolError(DeviceErrorCode.GUI_UNAVAILABLE, 'GUI helper did not start in time')); } }, READY_TIMEOUT_MS);
      c.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
      readline.createInterface({ input: c.stdout }).on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { ready = true; clearTimeout(timer); resolve(); return; }
        const w = waiters.get(msg.id);
        if (!w) return;
        waiters.delete(msg.id);
        if (msg.ok) w.resolve(msg.result);
        else w.reject(new DeviceToolError(msg.code || DeviceErrorCode.EXECUTION_FAILED, msg.error || 'GUI call failed'));
      });
      c.on('error', (e) => { clearTimeout(timer); if (child === c) kill(); reject(new DeviceToolError(DeviceErrorCode.GUI_UNAVAILABLE, `Cannot start GUI helper: ${e.message}`)); });
      c.on('close', () => {
        clearTimeout(timer);
        if (child === c) { child = null; starting = null; }
        const reason = new DeviceToolError(DeviceErrorCode.GUI_UNAVAILABLE, `GUI helper exited${stderr ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(' ')}` : ''}`);
        if (!ready) reject(reason);
        failAll(reason);
      });
    });
    return starting;
  }

  /** Một lời gọi tới host. Huỷ (`signal`) giữa chừng → giết host (không có cách ngắt một lời gọi UI Automation đang chờ). */
  async function call(op, args = {}, { signal } = {}) {
    if (signal?.aborted) throw signal.reason;
    await start();
    if (signal?.aborted) throw signal.reason;
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const onAbort = () => { waiters.delete(id); reject(signal.reason); kill(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.set(id, {
        resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
      });
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  return {
    call,
    close: () => { failAll(new DeviceToolError(DeviceErrorCode.CANCELLED, 'GUI helper closed')); try { child?.stdin.end(); } catch { /* đã đóng */ } kill(); },
    running: () => !!child,
  };
}
