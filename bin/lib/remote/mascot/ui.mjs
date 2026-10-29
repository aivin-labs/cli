import path from 'path';
import readline from 'readline';
import { execFileSync, spawn } from 'child_process';
import { WINDOWS_TASK_NAME, cliLaunchCommand } from '../autoStart.mjs';
import { isDesktopInstalled, launchTray } from '../desktop/index.mjs';
import { loadDeviceCredentials } from '../credentials.mjs';
import { lockHolder } from '../daemonLock.mjs';
import { HostCommand, HostEvent, MASCOT_DIR, MascotState, loadMascotSettings, requestMascotShow, saveMascotSettings, writeHostFiles } from './index.mjs';
import { mascotLang } from './strings.mjs';

/**
 * `aivin ui` (29/10/2026): hiện linh vật Aivin + mở ô hỏi ngay. Linh vật sống trong daemon `aivin remote start` (cần socket của máy để
 * chat), nên: bật lại nếu đã tắt, ghi yêu cầu hiện cho daemon; daemon chưa chạy → khởi động nó chạy nền (tác vụ Task Scheduler nếu đã
 * `aivin remote enable` — có trình giữ chạy; không thì tiến trình tách rời) rồi chờ nó nhận việc.
 */

export const UiResult = Object.freeze({
  SHOWN: 'shown', STARTED: 'started', DEMO: 'demo', NOT_PAIRED: 'not_paired', START_FAILED: 'start_failed', UNSUPPORTED: 'unsupported',
});

export const MASCOT_DEMO_STATES = Object.freeze([
  MascotState.IDLE, MascotState.WORKING, MascotState.THINKING, MascotState.WAITING,
  MascotState.DONE, MascotState.ERROR, MascotState.PAUSED, MascotState.OFFLINE,
]);

const START_WAIT_MS = 20_000;
const POLL_MS = 500;

function windowsTaskExists() {
  try {
    execFileSync('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Daemon chạy nền: ứng dụng khay Aivin.exe / tác vụ tự khởi động cũ (có trình giữ chạy), không thì tiến trình tách rời, không cửa sổ. */
function startDaemon() {
  if (isDesktopInstalled()) {
    launchTray();
    return;
  }
  if (windowsTaskExists()) {
    execFileSync('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    return;
  }
  const [cmd, ...args] = cliLaunchCommand();
  spawn(cmd, [...args, 'remote', 'start', '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export async function showMascotUi({ platform = process.platform, onStarting = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), deps = {} } = {}) {
  const d = { lockHolder, loadDeviceCredentials, requestMascotShow, saveMascotSettings, startDaemon, ...deps };
  if (platform !== 'win32') return UiResult.UNSUPPORTED;
  d.saveMascotSettings({ enabled: true });
  d.requestMascotShow();
  if (d.lockHolder()) return UiResult.SHOWN;
  if (!d.loadDeviceCredentials()) return UiResult.NOT_PAIRED;
  onStarting();
  try {
    d.startDaemon();
  } catch {
    return UiResult.START_FAILED;
  }
  for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    if (d.lockHolder()) return UiResult.STARTED;
  }
  return UiResult.START_FAILED;
}

/** Preview all visual states without pairing or starting the remote listener. The child + interval keep Node alive until the window closes or Ctrl+C. */
export function showMascotDemo({ platform = process.platform, env = process.env, stateMs = 2600, deps = {} } = {}) {
  if (platform !== 'win32') return UiResult.UNSUPPORTED;
  const d = { spawn, writeHostFiles, loadMascotSettings, setInterval, clearInterval, ...deps };
  let home;
  try {
    home = d.writeHostFiles({ dir: MASCOT_DIR, lang: mascotLang(env), settings: d.loadMascotSettings() });
    const child = d.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(home, 'host.ps1')], {
      env: { ...env, AIVIN_MASCOT_DIR: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timer = null;
    let index = 0;
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* preview window closed */ }
    };
    const showState = () => {
      const state = MASCOT_DEMO_STATES[index++ % MASCOT_DEMO_STATES.length];
      send({ t: HostCommand.STATE, state });
      send({ t: HostCommand.MAIN, text: `Demo: ${state}`, quiet: false });
    };
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.t === HostEvent.READY && !timer) { showState(); timer = d.setInterval(showState, stateMs); }
      if (event.t === HostEvent.OFF) { send({ t: HostCommand.QUIT }); child.stdin.end(); }
    });
    child.on('close', () => { if (timer) d.clearInterval(timer); });
    child.on('error', () => { if (timer) d.clearInterval(timer); });
    return UiResult.DEMO;
  } catch {
    return UiResult.START_FAILED;
  }
}
