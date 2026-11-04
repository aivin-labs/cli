import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createHash, randomBytes } from 'crypto';
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

const RAW_HEADER_BYTES = 12;
const MAX_RAW_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Tách luồng khung thô từ named pipe: mỗi khung = [rộng, cao, độ dài] int32 LE + dữ liệu I420. Trả hàm nhận từng khúc dữ liệu.
 * Độ dài vô lý → `onCorrupt` (đóng pipe, không cố đồng bộ lại).
 */
export function createRawFrameReader(onFrame, onCorrupt = () => {}) {
  const header = Buffer.alloc(RAW_HEADER_BYTES);
  let headerFilled = 0;
  let frame = null;
  let filled = 0;
  return (chunk) => {
    let pos = 0;
    while (pos < chunk.length) {
      if (!frame) {
        const n = chunk.copy(header, headerFilled, pos, pos + RAW_HEADER_BYTES - headerFilled);
        headerFilled += n;
        pos += n;
        if (headerFilled < RAW_HEADER_BYTES) return;
        headerFilled = 0;
        const width = header.readInt32LE(0);
        const height = header.readInt32LE(4);
        const length = header.readInt32LE(8);
        if (width <= 0 || height <= 0 || length !== width * height * 1.5 || length > MAX_RAW_FRAME_BYTES) {
          onCorrupt();
          return;
        }
        // Vùng nhớ riêng cho từng khung (bộ mã hoá giữ tham chiếu), chép thẳng từng khúc: khúc pipe 64 KB, ghép dần cả khung ăn luồng chính ~9 ms.
        frame = { width, height, data: new Uint8ClampedArray(length) };
        filled = 0;
      }
      const piece = chunk.subarray(pos, pos + frame.data.length - filled);
      frame.data.set(piece, filled);
      filled += piece.length;
      pos += piece.length;
      if (filled === frame.data.length) {
        const done = frame;
        frame = null;
        onFrame(done);
      }
    }
  };
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
    onMeta,
    onCursor,
    onCursorShape,
    onCapture,
    rawPipe = false,
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
    // Có nơi nhận khung thô (nguồn video WebRTC ở tiến trình con webrtcWorker.mjs) → tiến trình quay mở named pipe gửi I420; không thì chỉ JPEG.
    const pipeName = rawPipe ? `aivin-cast-${process.pid}-${randomBytes(6).toString('hex')}` : '';
    const argsJson = JSON.stringify({
      max_fps: maxFps,
      max_width: maxWidth,
      quality,
      monitor,
      ...(pipeName ? { pipe: pipeName } : {}),
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
          sessionId: session.sessionId,
          image: msg.image,
          width: msg.width,
          height: msg.height,
          screenWidth: msg.screenWidth,
          screenHeight: msg.screenHeight,
          screenX: msg.screenX,
          screenY: msg.screenY,
          monitor: msg.monitor,
          screens: msg.screens,
          ts: msg.ts,
          stats: msg.stats,
        });
      } else if (msg.t === 'meta') {
        onMeta?.({
          sessionId: session.sessionId,
          width: msg.width,
          height: msg.height,
          screenWidth: msg.screenWidth,
          screenHeight: msg.screenHeight,
          screenX: msg.screenX,
          screenY: msg.screenY,
          monitor: msg.monitor,
          screens: msg.screens,
          ts: msg.ts,
          stats: msg.stats,
        });
      } else if (msg.t === 'cursor') {
        onCursor?.({ x: msg.x, y: msg.y, visible: msg.visible, shape: msg.shape });
      } else if (msg.t === 'cursor_shape') {
        onCursorShape?.({ id: msg.id, png: msg.png, hotX: msg.hotX, hotY: msg.hotY });
      } else if (msg.t === 'capture') {
        onCapture?.({ mode: msg.mode, reason: msg.reason });
      } else if (msg.t === 'error') {
        onError?.(new Error(msg.error || 'Desktop cast error'));
      }
    });

    child.on('error', (err) => {
      onError?.(err);
      if (activeSession === session) activeSession = null;
    });

    child.on('close', () => {
      if (activeSession === session) activeSession = null;
      onStop?.();
    });

    function sendInput(inputCmd) {
      if (!child.stdin || child.stdin.destroyed) return;
      try {
        const payload = JSON.stringify({ ...inputCmd, op: 'input' });
        child.stdin.write(payload + '\n');
      } catch {
        // bỏ qua lỗi ghi stdin nếu tiến trình đang đóng
      }
    }

    function config(configCmd) {
      if (!child.stdin || child.stdin.destroyed) return;
      try {
        const payload = JSON.stringify({ ...configCmd, op: 'config' });
        child.stdin.write(payload + '\n');
      } catch {
        // bỏ qua
      }
    }

    /** Bật / tắt nén JPEG (chỉ cần khi còn người xem chưa có video WebRTC). */
    let jpegOn = true;
    function setJpeg(on) {
      if (!pipeName || jpegOn === on) return;
      jpegOn = on;
      config({ jpeg: on });
    }

    /** Con trỏ lồng vào khung hình (mặc định) hay gửi riêng để FE tự vẽ. */
    let cursorInFrame = true;
    function setCursorInFrame(on) {
      if (cursorInFrame === on) return;
      cursorInFrame = on;
      config({ cursor: on });
    }

    /** Gửi ngay một khung (người xem mới nối, màn hình đang đứng yên). */
    function refresh() {
      if (!child.stdin || child.stdin.destroyed) return;
      try { child.stdin.write(JSON.stringify({ op: 'refresh' }) + '\n'); } catch { /* đang đóng */ }
    }

    function stop() {
      if (activeSession === session) activeSession = null;
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

    const session = {
      sessionId,
      child,
      sendInput,
      config,
      setJpeg,
      setCursorInFrame,
      refresh,
      stop,
      pipeName,
    };
    activeSession = session;

    return activeSession;
  }

  function setSessionId(sessionId) {
    if (activeSession && sessionId) {
      activeSession.sessionId = sessionId;
    }
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

  function setJpeg(on) {
    activeSession?.setJpeg(on);
  }

  function setCursorInFrame(on) {
    activeSession?.setCursorInFrame(on);
  }

  function refresh() {
    activeSession?.refresh();
  }

  /** Tên named pipe khung thô của phiên đang phát (rỗng khi không bật `rawPipe`). */
  function pipeName() {
    return activeSession?.pipeName || '';
  }

  function isActive() {
    return activeSession !== null;
  }

  /** Mã phiên đang phát (BE đặt) — lệnh / thao tác mang mã khác bị bỏ. */
  function sessionId() {
    return activeSession?.sessionId || null;
  }

  return {
    start,
    setSessionId,
    sessionId,
    sendInput,
    config,
    setJpeg,
    setCursorInFrame,
    refresh,
    pipeName,
    stop,
    isActive,
  };
}
