import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';
import { DESKTOP_CAST_CSHARP, DESKTOP_CAST_PS1 } from './desktopCastSource.mjs';

const CAST_DIR = path.join(REMOTE_CONFIG_DIR, 'desktop-cast');

function hostFiles(dir = CAST_DIR) {
  const hash = createHash('sha256').update(DESKTOP_CAST_CSHARP).update(DESKTOP_CAST_PS1).digest('hex').slice(0, 16);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `cast-${hash}.cs`);
  const ps1 = path.join(dir, `cast-${hash}.ps1`);
  if (!fs.existsSync(src)) fs.writeFileSync(src, DESKTOP_CAST_CSHARP);
  if (!fs.existsSync(ps1)) fs.writeFileSync(ps1, DESKTOP_CAST_PS1);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('cast-') && !name.startsWith(`cast-${hash}`)) fs.rmSync(path.join(dir, name), { force: true });
  }
  return { src, ps1, dll: path.join(dir, `cast-${hash}.dll`) };
}

export function isDesktopCastSupported(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Quản lý phiên phát hình ảnh và điều khiển máy tính từ xa.
 */
export function createDesktopCastManager({ dir = CAST_DIR, spawnImpl = spawn } = {}) {
  let activeSession = null;

  function start({
    sessionId,
    maxFps = 15,
    maxWidth = 1366,
    quality = 65,
    monitor = -1,
    onFrame,
    onReady,
    onError,
    onStop,
  } = {}) {
    if (activeSession) {
      stop();
    }

    if (!isDesktopCastSupported()) {
      onError?.(new Error('Desktop cast is currently supported on Windows only'));
      return null;
    }

    const files = hostFiles(dir);
    const argsJson = JSON.stringify({
      max_fps: maxFps,
      max_width: maxWidth,
      quality,
      monitor,
    });

    const child = spawnImpl('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      files.ps1,
    ], {
      env: {
        ...process.env,
        AIVIN_CAST_SRC: files.src,
        AIVIN_CAST_DLL: files.dll,
        AIVIN_CAST_ARGS: argsJson,
      },
      windowsHide: true,
    });

    let rl = readline.createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (msg.t === 'ready') {
        onReady?.(msg);
      } else if (msg.t === 'frame') {
        onFrame?.({
          sessionId,
          image: msg.image,
          width: msg.width,
          height: msg.height,
          screenWidth: msg.screenWidth,
          screenHeight: msg.screenHeight,
          monitor: msg.monitor,
          screens: msg.screens,
          ts: msg.ts,
        });
      } else if (msg.t === 'error') {
        onError?.(new Error(msg.error || 'Desktop cast error'));
      }
    });

    child.on('error', (err) => {
      onError?.(err);
      activeSession = null;
    });

    child.on('close', () => {
      activeSession = null;
      onStop?.();
    });

    function sendInput(inputCmd) {
      if (!child.stdin || child.stdin.destroyed) return;
      try {
        const payload = JSON.stringify({ op: 'input', ...inputCmd });
        child.stdin.write(payload + '\n');
      } catch {
        // bỏ qua lỗi ghi stdin nếu tiến trình đang đóng
      }
    }

    function config(configCmd) {
      if (!child.stdin || child.stdin.destroyed) return;
      try {
        const payload = JSON.stringify({ op: 'config', ...configCmd });
        child.stdin.write(payload + '\n');
      } catch {
        // bỏ qua
      }
    }

    function stop() {
      if (!activeSession) return;
      activeSession = null;
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write('stop\n');
        }
      } catch {
        // bỏ qua
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // bỏ qua
        }
      }, 500);
    }

    activeSession = {
      sessionId,
      child,
      sendInput,
      config,
      stop,
    };

    return activeSession;
  }

  function sendInput(inputCmd) {
    if (activeSession) {
      activeSession.sendInput(inputCmd);
    }
  }

  function config(configCmd) {
    if (activeSession) {
      activeSession.config(configCmd);
    }
  }

  function stop() {
    if (activeSession) {
      activeSession.stop();
      activeSession = null;
    }
  }

  function isActive() {
    return activeSession !== null;
  }

  return {
    start,
    sendInput,
    config,
    stop,
    isActive,
  };
}
