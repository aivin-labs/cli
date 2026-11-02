import net from 'net';
import readline from 'readline';
import { spawn } from 'child_process';
import { createDesktopWebRtc } from './desktopWebRtc.mjs';
import { createRawFrameReader } from './desktopCast.mjs';
import { createWebRtcRuntimeLoader } from './webrtcRuntime.mjs';

/**
 * WebRTC của Desktop Scenecast chạy trong TIẾN TRÌNH CON riêng (`aivin __desktop-webrtc-worker`): thư viện native `@roamhq/wrtc` làm
 * tiến trình sập lúc thoát (Bun: mọi cách thoát; Node: thoát tự nhiên — đo 02/11/2026). Ở tiến trình con thì sập không ảnh hưởng mã
 * thoát của daemon (trình giữ chạy / tự lùi bản dựa vào mã đó), và lỗi native giữa phiên chỉ làm mất WebRTC (lùi JPEG), không mất daemon.
 *
 * Giao thức: mỗi dòng stdin / stdout một JSON.
 * daemon → con: `start {sessionId, viewerId, iceServers}` · `signal {msg}` · `push {frame}` · `pipe {name}` · `close {viewerId}` · `closeAll`
 * con → daemon: `started {viewerId, ok}` · `signal {payload}` · `status {payload}` · `input {raw, viewerId}` · `peerReady {viewerId}` ·
 * `state {needsFallback, needsJpeg, hasVideo, videoLive}` · `log {text}`
 * Khung thô I420 không đi qua daemon: con tự nối named pipe của tiến trình quay.
 */

export const DESKTOP_WEBRTC_WORKER_ARG = '__desktop-webrtc-worker';
const VIDEO_LIVE_MS = 3000;

export async function runDesktopWebRtcWorker({ input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => { try { output.write(JSON.stringify(msg) + '\n'); } catch { /* daemon đã đóng */ } };
  let lastRawAt = 0;
  let lastState = '';
  let rtc;
  const sendState = () => {
    const state = {
      needsFallback: rtc.needsFallback(), needsJpeg: rtc.needsJpeg(), hasVideo: rtc.hasVideo(), videoLive: Date.now() - lastRawAt < VIDEO_LIVE_MS,
    };
    const key = JSON.stringify(state);
    if (key !== lastState) { lastState = key; send({ t: 'state', ...state }); }
  };
  rtc = createDesktopWebRtc({
    emitSignal: (payload) => send({ t: 'signal', payload }),
    emitStatus: (payload) => { send({ t: 'status', payload }); sendState(); },
    onInput: (raw, viewerId) => send({ t: 'input', raw, viewerId }),
    onPeerReady: (viewerId) => { send({ t: 'peerReady', viewerId }); sendState(); },
    loadRuntime: createWebRtcRuntimeLoader({ log: (text) => send({ t: 'log', text }) }),
  });

  let pipeSocket = null;
  let pipeName = '';
  const connectPipe = (name, attempt = 0) => {
    if (attempt === 0 && name === pipeName && pipeSocket) return;
    pipeName = name;
    pipeSocket?.destroy();
    const sock = net.connect(`\\\\.\\pipe\\${name}`);
    const read = createRawFrameReader((frame) => { if (rtc.pushRaw(frame)) lastRawAt = Date.now(); }, () => sock.destroy());
    sock.on('data', read);
    sock.on('error', () => {});
    sock.on('close', () => {
      if (pipeSocket !== sock) return;
      pipeSocket = null;
      if (attempt < 20) setTimeout(() => { if (!pipeSocket) connectPipe(name, attempt + 1); }, Math.min(2000, 100 * 2 ** attempt));
    });
    pipeSocket = sock;
  };
  const stateTimer = setInterval(sendState, 1000);

  const handlers = {
    start: async (m) => {
      const ok = await rtc.start({ sessionId: m.sessionId, viewerId: m.viewerId, iceServers: m.iceServers || [] }).catch(() => false);
      send({ t: 'started', viewerId: m.viewerId, ok });
      sendState();
    },
    signal: (m) => rtc.signal(m.msg).catch(() => false),
    push: (m) => rtc.push(m.frame),
    pipe: (m) => { if (m.name) connectPipe(String(m.name)); },
    close: (m) => { rtc.close(m.viewerId); sendState(); },
    closeAll: () => { rtc.closeAll(); const sock = pipeSocket; pipeSocket = null; pipeName = ''; sock?.destroy(); sendState(); },
  };
  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    void Promise.resolve(handlers[msg?.t]?.(msg)).catch(() => undefined);
  });
  // Daemon thoát / đóng ống → con thoát theo (Windows không tự giết con khi cha chết).
  await new Promise((resolve) => rl.on('close', resolve));
  clearInterval(stateTimer);
  rtc.closeAll();
  process.exit(0);
}

/**
 * Phía daemon: cùng API với createDesktopWebRtc (start / signal / push / needsFallback / needsJpeg / hasVideo / close / closeAll) + `attachPipe`
 * và `videoLive`. Tiến trình con dựng khi phiên đầu cần, tắt khi `closeAll`; con chết giữa phiên → coi như không ai có WebRTC (lùi JPEG).
 */
export function createDesktopWebRtcWorker({
  command, emitSignal = () => {}, emitStatus = () => {}, onInput = () => {}, onPeerReady = () => {}, log = () => {}, spawnImpl = spawn,
} = {}) {
  let child = null;
  let state = { needsFallback: true, needsJpeg: true, hasVideo: false, videoLive: false };
  const waiting = new Map();
  const peers = new Set();

  const ensure = () => {
    if (child) return child;
    const [exe, ...args] = command;
    const proc = spawnImpl(exe, [...args, DESKTOP_WEBRTC_WORKER_ARG], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === 'signal') emitSignal(m.payload);
      else if (m.t === 'status') emitStatus(m.payload);
      else if (m.t === 'input') onInput(m.raw, m.viewerId);
      else if (m.t === 'peerReady') onPeerReady(m.viewerId);
      else if (m.t === 'state') state = { needsFallback: !!m.needsFallback, needsJpeg: !!m.needsJpeg, hasVideo: !!m.hasVideo, videoLive: !!m.videoLive };
      else if (m.t === 'log') log(String(m.text || ''));
      else if (m.t === 'started') { waiting.get(m.viewerId)?.(!!m.ok); waiting.delete(m.viewerId); }
    });
    const gone = () => {
      if (child !== proc) return;
      child = null;
      state = { needsFallback: true, needsJpeg: true, hasVideo: false, videoLive: false };
      for (const done of waiting.values()) done(false);
      waiting.clear();
      peers.clear();
    };
    proc.on('exit', gone);
    proc.on('error', gone);
    proc.stdin.on('error', () => {});
    return proc;
  };
  const send = (msg) => {
    if (!child?.stdin?.writable) return;
    try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* con vừa chết */ }
  };

  function start({ sessionId, viewerId, iceServers = [] }) {
    ensure();
    peers.add(viewerId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(viewerId); resolve(false); }, 30_000);
      timer.unref?.();
      waiting.set(viewerId, (ok) => { clearTimeout(timer); resolve(ok); });
      send({ t: 'start', sessionId, viewerId, iceServers });
    });
  }

  function closeAll() {
    peers.clear();
    if (!child) return;
    const proc = child;
    send({ t: 'closeAll' });
    try { proc.stdin.end(); } catch { /* đã đóng */ }
    // Con tự thoát khi stdin đóng; kẹt thì giết.
    setTimeout(() => { try { proc.kill(); } catch { /* đã thoát */ } }, 3000).unref?.();
    child = null;
    state = { needsFallback: true, needsJpeg: true, hasVideo: false, videoLive: false };
  }

  return {
    start,
    signal: async (msg) => { send({ t: 'signal', msg }); return true; },
    push: (frame) => { if (child && peers.size) send({ t: 'push', frame }); },
    attachPipe: (name) => { if (name) send({ t: 'pipe', name }); },
    close: (viewerId) => { peers.delete(viewerId); send({ t: 'close', viewerId }); },
    closeAll,
    needsFallback: () => state.needsFallback,
    needsJpeg: () => state.needsJpeg,
    hasVideo: () => state.hasVideo,
    videoLive: () => state.videoLive,
  };
}
