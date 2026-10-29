import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR } from '../constants.mjs';
import { DeviceToolError } from '../sandbox.mjs';
import { MEDIA_HOST_CSHARP, MEDIA_HOST_PS1 } from './recorderSource.mjs';

/**
 * Chạy tiến trình ghi / chụp của recorderSource.mjs. Lần đầu PowerShell dịch C# (~vài giây) rồi lưu DLL theo dấu vân tay mã vào
 * `~/.aivin/media/`, các lần sau nạp DLL. `record()` — một tiến trình sống suốt buổi ghi; `snap()` — một tiến trình ngắn mỗi ảnh.
 */

const MEDIA_DIR = path.join(REMOTE_CONFIG_DIR, 'media');
const READY_TIMEOUT_MS = 60_000;
const SNAP_TIMEOUT_MS = 30_000;

function hostFiles(dir = MEDIA_DIR) {
  const hash = createHash('sha256').update(MEDIA_HOST_CSHARP).update(MEDIA_HOST_PS1).digest('hex').slice(0, 16);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `media-${hash}.cs`);
  const ps1 = path.join(dir, `media-${hash}.ps1`);
  if (!fs.existsSync(src)) fs.writeFileSync(src, MEDIA_HOST_CSHARP);
  if (!fs.existsSync(ps1)) fs.writeFileSync(ps1, MEDIA_HOST_PS1);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('media-') && !name.startsWith(`media-${hash}`)) fs.rmSync(path.join(dir, name), { force: true });
  }
  return { src, ps1, dll: path.join(dir, `media-${hash}.dll`) };
}

export function mediaSupported(platform = process.platform) {
  return platform === 'win32';
}

export function createMediaHost({ spawnImpl = spawn, dir = MEDIA_DIR } = {}) {
  const launch = (mode, args) => {
    const files = hostFiles(dir);
    return spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', files.ps1], {
      env: { ...process.env, AIVIN_MEDIA_SRC: files.src, AIVIN_MEDIA_DLL: files.dll, AIVIN_MEDIA_MODE: mode, AIVIN_MEDIA_ARGS: JSON.stringify(args) },
      windowsHide: true,
    });
  };

  /** Một ảnh màn hình (`monitor` -1 = tất cả màn hình ghép lại). */
  function snap(args = {}, signal) {
    return new Promise((resolve, reject) => {
      const child = launch('snap', { monitor: Number.isInteger(args.monitor) ? args.monitor : -1, max_width: args.max_width || 1600, quality: args.quality || 70 });
      let stderr = '';
      let result = null;
      const timer = setTimeout(() => { child.kill(); reject(new DeviceToolError(DeviceErrorCode.CALL_TIMEOUT, 'Screen capture timed out')); }, SNAP_TIMEOUT_MS);
      const onAbort = () => { child.kill(); reject(new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        try { const msg = JSON.parse(line); if (msg.t === 'snap' || msg.t === 'error') result = msg; } catch { /* dòng rác của PowerShell */ }
      });
      child.on('error', (e) => { clearTimeout(timer); reject(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Cannot start the capture helper: ${e.message}`)); });
      child.on('close', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (result?.t === 'snap') resolve({ image: result.image, monitors: result.monitors });
        else reject(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, result?.error || stderr.trim().split(/\r?\n/).slice(-2).join(' ') || 'Screen capture failed'));
      });
    });
  }

  /**
   * Bắt đầu ghi vào `dir` → `{ ready, done, stop(), on(type, fn) }`. `ready` xong khi đã mở được ít nhất một luồng âm thanh
   * (`{ system, mic }` cho biết luồng nào); `done` → `{ secs, system, mic, screens }`. Sự kiện: level / windows / screen / warn.
   */
  function record({ dir: outDir, screens = true, screensEverySec = 15, maxScreens = 300 }) {
    const listeners = new Map();
    const emit = (type, msg) => { for (const fn of listeners.get(type) || []) { try { fn(msg); } catch { /* người nghe lỗi không làm hỏng buổi ghi */ } } };
    const child = launch('record', { dir: outDir, screens, screens_every_sec: screensEverySec, max_screens: maxScreens });
    let stderr = '';
    let finished = null;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    const readyTimer = setTimeout(() => { rejectReady(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, 'The recorder did not start in time')); child.kill(); }, READY_TIMEOUT_MS);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.t === 'ready') { clearTimeout(readyTimer); resolveReady({ system: !!msg.system, mic: !!msg.mic }); return; }
      if (msg.t === 'done') { finished = msg; return; }
      if (msg.t === 'error') { clearTimeout(readyTimer); rejectReady(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, msg.error || 'Recording failed')); }
      emit(msg.t, msg);
    });
    const done = new Promise((resolve) => {
      child.on('error', (e) => { clearTimeout(readyTimer); rejectReady(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Cannot start the recorder: ${e.message}`)); resolve(null); });
      child.on('close', () => {
        clearTimeout(readyTimer);
        rejectReady(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `The recorder exited${stderr ? `: ${stderr.trim().split(/\r?\n/).slice(-2).join(' ')}` : ''}`));
        resolve(finished);
      });
    });
    return {
      ready,
      done,
      stop() { try { child.stdin.write('stop\n'); child.stdin.end(); } catch { /* đã thoát */ } },
      kill() { try { child.kill(); } catch { /* đã thoát */ } },
      on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    };
  }

  return { snap, record };
}
