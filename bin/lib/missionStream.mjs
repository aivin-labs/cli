import chalk from 'chalk';
import { io } from 'socket.io-client';
import path from 'path';
import http from 'http';
import os from 'os';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { openBrowser } from './auth.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.join(dirname(__filename), '..');

// Every mission/job/task run logs its progress over the same clientLog() Socket.IO channel the
// web app's chat/automation/task panels already listen on - the event name depends on which
// `execution_channel` the run is on, so we just listen on all of them and filter by thread_id.
export const MISSION_LOG_EVENTS = ['chat-log', 'agent-log', 'automation-log', 'task-agent-log'];

// The only two event_keys FlowService emits for a *whole* run finishing (not just one stage) -
// see docs/sdk/automation.md's caveats section for why there's no generic "job succeeded" signal
// beyond this on the wire.
export const MISSION_DONE_EVENT_KEYS = new Set(['flow.completed', 'flow.error', 'runner.start_failed']);

/**
 * Streams realtime progress for a running mission/job/task, for a nicer `aivin do` experience than
 * a bare HTTP response - connects to the same Socket.IO channel `aivin plugin logs` already uses
 * (see streamPluginLogs above), no explicit subscribe call needed since clientLog() emits to the
 * caller's own user room automatically. Resolves on a recognized terminal event_key, on idle
 * timeout, or on Ctrl+C - whichever comes first. Never throws: a log-streaming hiccup shouldn't
 * fail a command whose HTTP call already succeeded.
 */
export function streamMissionLog(serverUrl, apiKey, threadId, { idleTimeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const socket = io(serverUrl, {
      auth: { token: apiKey || 'dev-token' },
      transports: ['websocket'],
      reconnection: true,
    });

    let idleTimer;
    let settled = false;
    const statusIcon = (status) =>
      status === 'error'
        ? chalk.red('✗')
        : status === 'success'
          ? chalk.green('✓')
          : status === 'warning'
            ? chalk.yellow('!')
            : chalk.gray('·');

    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      socket.disconnect();
      process.off('SIGINT', stop);
      resolve();
    };

    const bumpIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(
          chalk.gray(
            `\n(no activity for ${Math.round(idleTimeoutMs / 1000)}s - stopped watching; the run may still be going in the background)`,
          ),
        );
        stop();
      }, idleTimeoutMs);
    };

    process.on('SIGINT', stop);

    socket.on('connect_error', (error) => {
      console.log(chalk.yellow(`⚠️  Couldn't watch live progress (${error.message}) - the run continues regardless.`));
      stop();
    });

    for (const eventName of MISSION_LOG_EVENTS) {
      socket.on(eventName, (payload) => {
        if (!payload || payload.thread_id !== threadId) return;
        bumpIdleTimer();
        const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
        const label = payload.event_key || eventName;
        console.log(
          `${chalk.gray(`[${time}]`)} ${statusIcon(payload.status)} ${chalk.gray(label)} ${payload.message || ''}`.trimEnd(),
        );
        if (MISSION_DONE_EVENT_KEYS.has(payload.event_key)) stop();
      });
    }

    console.log(chalk.gray(`📡 Watching live progress for ${threadId}... (Ctrl+C to stop watching - the run keeps going either way)\n`));
    bumpIdleTimer();
  });
}

// ── `aivin browser` - dedicated AI Browser trigger with a real interactive viewer for HIL ──────
//
// Unlike `sdk.browser.run()`/`runStream()` (code-plugin escape hatch, deliberately refuses to
// suspend on HIL - see docs/sdk/browser.md), this goes through the SAME `/agent/start-work` path
// `aivin do` uses, because that's the only trigger path wired to the real BullMQ suspend/resume
// plumbing (`PluginBridge.trigger()`) - `/plugins/execute` (what `aivin plugin trigger` calls)
// does NOT catch HilSuspendSignal at all and would just 500 on a mission that needs a human.
// The mission prompt is prefixed to bias the agent's own NLU tool-selection toward AI Browser
// specifically (not a hard guarantee - there's no "force this exact tool" param exposed on
// start-work today - but reliable in practice for an unambiguous browser-shaped mission).
export const BROWSER_MISSION_PREFIX =
  'Use the AI Browser tool (official.ai_browser) to accomplish the following mission directly - do not just describe how, actually browse: ';

/**
 * Self-contained viewer page: connects to the SAME Socket.IO channel the web app's HIL screencast
 * panel uses (AIBrowserGateway/AIBrowserScreencastService), renders the live CDP frame stream
 * fullscreen on a <canvas>, and relays mouse/keyboard back as `browser:click`/`type`/`scroll`/...
 * - the exact same wire protocol, just a purpose-built fullscreen client instead of the chat UI's
 * embedded panel. `token`/`client` are injected server-side (this file is generated fresh per
 * `aivin browser` run, never written to disk) - not exposed via query string, which would leak
 * into shell history/proxy logs/browser history.
 */
export function browserViewerHtml({ serverUrl, apiKey, tenantClient }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>aivin browser - live session</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #111; overflow: hidden; }
  #status { position: fixed; top: 0; left: 0; right: 0; padding: 8px 14px; background: rgba(0,0,0,.7);
            color: #eee; font: 13px/1.4 -apple-system, Segoe UI, sans-serif; z-index: 10; display: flex;
            justify-content: space-between; align-items: center; }
  #status button { background: #2563eb; color: #fff; border: none; padding: 6px 14px; border-radius: 6px;
                    font-size: 13px; cursor: pointer; }
  #status button:hover { background: #1d4ed8; }
  #stage { position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex;
           align-items: center; justify-content: center; }
  canvas { cursor: default; box-shadow: 0 0 40px rgba(0,0,0,.6); }
  #waiting { color: #888; font: 15px -apple-system, Segoe UI, sans-serif; text-align: center; }
</style>
</head>
<body>
<div id="status">
  <span id="statusText">Đang kết nối...</span>
  <button id="doneBtn" style="display:none">✅ Xong - tiếp tục mission</button>
</div>
<div id="stage"><div id="waiting">Đang chờ mission mở phiên tương tác (HIL)...</div></div>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
(function () {
  const serverUrl = ${JSON.stringify(serverUrl)};
  const apiKey = ${JSON.stringify(apiKey)};
  const tenantClient = ${JSON.stringify(tenantClient)};
  const statusText = document.getElementById('statusText');
  const doneBtn = document.getElementById('doneBtn');
  const stage = document.getElementById('stage');

  let sessionKey = null;
  let canvas = null, ctx = null;
  let viewportW = 1280, viewportH = 800;

  const socket = io(serverUrl, { auth: { token: apiKey }, transports: ['websocket'], reconnection: true });

  socket.on('connect_error', (e) => { statusText.textContent = 'Lỗi kết nối: ' + e.message; });
  socket.on('connect', () => { statusText.textContent = 'Đã kết nối - chờ phiên tương tác cho ' + tenantClient + '...'; });

  function ensureCanvas() {
    if (canvas) return;
    stage.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.width = viewportW;
    canvas.height = viewportH;
    fitCanvas();
    stage.appendChild(canvas);
    ctx = canvas.getContext('2d');
    wireInput();
  }

  function fitCanvas() {
    if (!canvas) return;
    const availW = window.innerWidth, availH = window.innerHeight - 40;
    const scale = Math.min(availW / viewportW, availH / viewportH, 1);
    canvas.style.width = Math.round(viewportW * scale) + 'px';
    canvas.style.height = Math.round(viewportH * scale) + 'px';
  }
  window.addEventListener('resize', fitCanvas);

  socket.on('browser:cast-start', (payload) => {
    sessionKey = payload.clientId;
    viewportW = payload.viewportWidth || 1280;
    viewportH = payload.viewportHeight || 800;
    statusText.textContent = 'Phiên tương tác: ' + sessionKey + ' (' + (payload.url || '') + ')';
    doneBtn.style.display = 'inline-block';
    socket.emit('join-room', { name: 'aivin-cli', rooms: ['aibrowser:' + sessionKey] });
    ensureCanvas();
  });

  socket.on('browser:screenshot', (payload) => {
    if (!payload || !payload.screenshot) return;
    ensureCanvas();
    const bytes = payload.screenshot instanceof ArrayBuffer ? new Uint8Array(payload.screenshot) : payload.screenshot;
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); };
    img.src = url;
    if (payload.title) statusText.textContent = payload.title + '  —  ' + (payload.url || '');
  });

  socket.on('browser:cast-error', (payload) => {
    statusText.textContent = '⚠️ ' + (payload.reason || 'Mất kết nối phiên trình duyệt');
  });

  socket.on('browser:resolved', () => {
    statusText.textContent = '✅ Đã gửi tín hiệu hoàn tất - mission đang tiếp tục...';
    doneBtn.style.display = 'none';
  });

  doneBtn.addEventListener('click', () => {
    if (!sessionKey) return;
    socket.emit('browser:resolve', { clientId: sessionKey, option: 'approve' });
  });

  function toPageCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (viewportW / rect.width));
    const y = Math.round((e.clientY - rect.top) * (viewportH / rect.height));
    return { x, y };
  }

  const SPECIAL_KEYS = {
    Enter: '__ENTER__', Backspace: '__BACKSPACE__', Delete: '__DELETE__', Tab: '__TAB__',
    Escape: '__ESCAPE__', ArrowUp: '__ARROW_UP__', ArrowDown: '__ARROW_DOWN__',
    ArrowLeft: '__ARROW_LEFT__', ArrowRight: '__ARROW_RIGHT__', Home: '__HOME__', End: '__END__',
    PageUp: '__PAGE_UP__', PageDown: '__PAGE_DOWN__', F5: '__F5__', F12: '__F12__',
  };

  function wireInput() {
    canvas.addEventListener('click', (e) => {
      if (!sessionKey) return;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:click', { clientId: sessionKey, x, y });
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!sessionKey) return;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:rightclick', { clientId: sessionKey, x, y });
    });
    canvas.addEventListener('dblclick', (e) => {
      if (!sessionKey) return;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:dblclick', { clientId: sessionKey, x, y });
    });
    let lastHover = 0;
    canvas.addEventListener('mousemove', (e) => {
      if (!sessionKey) return;
      const now = Date.now();
      if (now - lastHover < 50) return;
      lastHover = now;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:hover', { clientId: sessionKey, x, y });
    });
    canvas.addEventListener('wheel', (e) => {
      if (!sessionKey) return;
      e.preventDefault();
      socket.emit('browser:scroll', { clientId: sessionKey, deltaY: e.deltaY });
    }, { passive: false });
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', (e) => {
      if (!sessionKey) return;
      if (e.ctrlKey || e.metaKey) return; // let browser-level shortcuts (devtools, refresh...) through
      const special = SPECIAL_KEYS[e.key];
      if (special) {
        e.preventDefault();
        socket.emit('browser:type', { clientId: sessionKey, text: special });
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        socket.emit('browser:type', { clientId: sessionKey, text: e.key });
      }
    });
    canvas.addEventListener('mouseenter', () => canvas.focus());
  }
})();
</script>
</body>
</html>`;
}

/**
 * Serves the viewer page on a random local port (127.0.0.1 only - never exposed beyond this
 * machine) and opens it in the default OS browser. The HTTP server is torn down when the CLI
 * process exits (SIGINT/mission end) - it only needs to live for the duration of `aivin browser`.
 */
export function openBrowserViewer(serverUrl, apiKey, tenantClient) {
  return new Promise((resolve) => {
    const html = browserViewerHtml({ serverUrl, apiKey, tenantClient });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/`;
      console.log(chalk.cyan(`\n🖥️  Mở phiên tương tác trực tiếp: ${url}`));
      openBrowser(url);
      resolve(server);
    });
  });
}

/**
 * Same live-progress watcher as `streamMissionLog`, plus: on the first `ai_browser.hil_required`
 * event (mission hit a step that needs a human - captcha, login, free-text confirmation), opens
 * the fullscreen viewer automatically instead of leaving the user to go find it. Only opens once
 * per run even if HIL fires again later (e.g. a second captcha) - the SAME viewer page keeps
 * working across multiple HIL rounds since it just reacts to whatever `browser:cast-start` fires
 * next on this tenant's room.
 */
export function streamBrowserMissionLog(serverUrl, apiKey, threadId, tenantClient, { idleTimeoutMs = 120_000, openViewerOnHIL = true } = {}) {
  return new Promise((resolve) => {
    const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true });

    let idleTimer;
    let settled = false;
    let viewerOpened = false;
    let viewerServer;
    const statusIcon = (status) =>
      status === 'error' ? chalk.red('✗') : status === 'success' ? chalk.green('✓') : status === 'warning' ? chalk.yellow('!') : chalk.gray('·');

    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      socket.disconnect();
      process.off('SIGINT', stop);
      // The auto-opened HIL viewer keeps a listening HTTP server alive (and with it the whole
      // process) past the point the mission actually finished - close it along with everything else.
      viewerServer?.close();
      resolve();
    };

    const bumpIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(chalk.gray(`\n(no activity for ${Math.round(idleTimeoutMs / 1000)}s - stopped watching; the run may still be going in the background)`));
        stop();
      }, idleTimeoutMs);
    };

    process.on('SIGINT', stop);

    socket.on('connect_error', (error) => {
      console.log(chalk.yellow(`⚠️  Couldn't watch live progress (${error.message}) - the run continues regardless.`));
      stop();
    });

    for (const eventName of MISSION_LOG_EVENTS) {
      socket.on(eventName, (payload) => {
        if (!payload || payload.thread_id !== threadId) return;
        bumpIdleTimer();
        const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
        const label = payload.event_key || eventName;
        console.log(`${chalk.gray(`[${time}]`)} ${statusIcon(payload.status)} ${chalk.gray(label)} ${payload.message || ''}`.trimEnd());

        if (payload.event_key === 'ai_browser.hil_required' && !viewerOpened) {
          viewerOpened = true;
          // Most important moment for a notification: a mission can run for minutes with the
          // terminal/browser out of focus, and this is the one point where it's actually STUCK until
          // the user comes back - not just a progress update they can catch up on later.
          sendOSNotification('AI Browser cần bạn hỗ trợ', payload.message || 'Mission đang chờ bạn tương tác');
          if (openViewerOnHIL) {
            console.log(chalk.magenta('\n👤 Mission cần bạn tương tác trực tiếp (captcha/đăng nhập/xác nhận) - đang mở trình duyệt...'));
            openBrowserViewer(serverUrl, apiKey, tenantClient)
              .then((server) => {
                // `stop()` may already have run by the time this resolves (mission finished right as
                // the viewer was opening) - it can't close a server it never got a reference to, so
                // close it here instead of leaking a listening HTTP server past the watcher's lifetime.
                if (settled) server.close();
                else viewerServer = server;
              })
              .catch((e) =>
                console.log(chalk.yellow(`⚠️  Không mở được viewer tự động: ${e.message} - thử lại bằng \`aivin browser --view ${tenantClient}\`.`)),
              );
          } else {
            // Local mode: no separate viewer needed at all - the message + a "Xong" button are
            // injected directly onto the real tab the user is already looking at (AIBrowserService's
            // showOnPageHILBanner). A screencast-based viewer here would just be a second, redundant,
            // lower-fidelity copy of a page already fully visible natively.
            console.log(chalk.magenta(`\n👤 ${payload.message || 'Mission cần bạn hỗ trợ'} - kiểm tra cửa sổ trình duyệt (có banner xanh ở đầu trang), bấm "Xong" ở đó khi hoàn tất.`));
          }
        }
        // `execute-interactive` calls triggerMission directly (not the multi-step `flow.*` runner
        // aivin do's missions go through), so its real terminal signal is ai_browser.success/failed,
        // not anything in MISSION_DONE_EVENT_KEYS - checked in addition to (not instead of) that set
        // since this function is also reused as a fallback for --remote missions triggered elsewhere.
        if (payload.event_key === 'ai_browser.success' || payload.event_key === 'ai_browser.failed' || MISSION_DONE_EVENT_KEYS.has(payload.event_key)) {
          const ok = payload.event_key !== 'ai_browser.failed' && payload.status !== 'error';
          sendOSNotification(ok ? '✅ AI Browser hoàn tất' : '❌ AI Browser thất bại', payload.message || '');
          stop();
        }
      });
    }

    // 🔍 Step-by-step agentic detail (perceive/plan/execute/audit/recover) - a SEPARATE Socket.IO
    // room-broadcast event from the chat-log-shaped ones above (AIBrowserService.emitAgentStep,
    // room `client:<tenant>`, joined automatically on auth per SocketIO.ts). Was previously never
    // listened to here at all - the terminal only ever showed the bookend start/success/failed lines
    // even though the backend was emitting a full trace the whole time. `detail` (when present)
    // carries the LLM's actual per-action reasoning (AIBrowserActionItem.reason), not just the
    // truncated one-line summary meant for a chat bubble.
    const STEP_ICON = { perceiving: '👁', executing: '▶', blocked: '🛡', recovering: '↺', auditing: '🔎', done: '✅', failed: '❌' };
    socket.on('browser:agent-step', (payload) => {
      if (!payload) return;
      bumpIdleTimer();
      const time = new Date().toLocaleTimeString();
      const icon = STEP_ICON[payload.type] || '·';
      console.log(`${chalk.gray(`[${time}]`)} ${icon} ${chalk.cyan(`step ${payload.step}`)} ${chalk.gray(payload.type)} ${payload.summary || ''}`.trimEnd());
      if (payload.url) console.log(chalk.gray(`         url: ${payload.url}`));
      const detail = payload.detail;
      if (Array.isArray(detail)) {
        // 'executing' - one or more planned actions, each with its own reasoning
        for (const a of detail) {
          console.log(chalk.gray(`         - ${a.type}${a.detail ? ` (${a.detail})` : ''}`));
          if (a.reason) console.log(chalk.dim(`           reason: ${a.reason}`));
        }
      } else if (detail && typeof detail === 'object') {
        // 'recovering' - { reason, revisedActions } from the audit/replan phase
        if (detail.reason) console.log(chalk.dim(`         reason: ${detail.reason}`));
        for (const a of detail.revisedActions || []) {
          console.log(chalk.gray(`         - ${a.type}${a.detail ? ` (${a.detail})` : ''}`));
          if (a.reason) console.log(chalk.dim(`           reason: ${a.reason}`));
        }
      }
    });

    console.log(chalk.gray(`📡 Watching live progress for ${threadId}... (Ctrl+C to stop and request cancellation)\n`));
    bumpIdleTimer();
  });
}

// Without a `start_url`, the mission's first step lands on a totally blank page - confirmed while
// testing this to cost real time (a full perceive+plan cycle wasted on a page with nothing to look
// at) AND to be a correctness risk: with nothing to navigate to, the planner reaches for the `search`
// action to find the target site itself, which does a REAL web search and goes wherever the top
// (reranked) result is - watched it once land on an unrelated w3schools tutorial page instead of
// facebook.com. A `start_url` sidesteps both: the mission opens directly on the real site via a plain
// `page.goto` before the agentic loop even starts, no guessing involved. Best-effort keyword match
// only (not NLU) - covers the common case from a mission mentioning a well-known site by name; falls
// back to no start_url (today's behavior) when nothing matches, and --url always wins outright.
export const KNOWN_SITE_HINTS = [
  { re: /facebook|\bfb\b/i, url: 'https://www.facebook.com' },
  { re: /instagram|\big\b/i, url: 'https://www.instagram.com' },
  { re: /\btiktok\b/i, url: 'https://www.tiktok.com' },
  { re: /\byoutube\b/i, url: 'https://www.youtube.com' },
  { re: /\b(twitter|x\.com)\b/i, url: 'https://x.com' },
  { re: /linkedin/i, url: 'https://www.linkedin.com' },
  { re: /\bzalo\b/i, url: 'https://chat.zalo.me' },
  { re: /\bgmail\b/i, url: 'https://mail.google.com' },
  { re: /\boutlook\b/i, url: 'https://outlook.live.com' },
  // Vietnamese e-commerce/social - the realistic mission targets for this CLI's actual audience,
  // not just the generic global-site list above.
  { re: /\bshopee\b/i, url: 'https://shopee.vn' },
  { re: /\btiki\b/i, url: 'https://tiki.vn' },
  { re: /\blazada\b/i, url: 'https://www.lazada.vn' },
  { re: /\bsendo\b/i, url: 'https://www.sendo.vn' },
  { re: /\bvnexpress\b/i, url: 'https://vnexpress.net' },
  { re: /\bamazon\b/i, url: 'https://www.amazon.com' },
  { re: /\bgithub\b/i, url: 'https://github.com' },
  { re: /\breddit\b/i, url: 'https://www.reddit.com' },
  { re: /\bpinterest\b/i, url: 'https://www.pinterest.com' },
  { re: /\bthreads\b/i, url: 'https://www.threads.net' },
  { re: /\bwhatsapp\b/i, url: 'https://web.whatsapp.com' },
  { re: /\btelegram\b/i, url: 'https://web.telegram.org' },
  { re: /\bdiscord\b/i, url: 'https://discord.com' },
  { re: /\bspotify\b/i, url: 'https://open.spotify.com' },
  { re: /\bnetflix\b/i, url: 'https://www.netflix.com' },
];

// Fallback for a site NOT in the (necessarily always-incomplete) list above: if the mission text
// itself contains something that looks like an actual domain (e.g. "đăng nhập vào crm.mycompany.vn"),
// use that directly rather than leaving start_url unset - a hand-picked static list can never cover
// every real target, especially a mission naming an internal/niche/foreign site nobody thought to
// hardcode. Deliberately conservative: requires a real-looking TLD, not just any two words with a
// dot between them (avoids matching version numbers, decimals, "v1.2" etc.).
export const DOMAIN_IN_TEXT_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|vn|dev|app|shop|store|biz|info|edu|gov|xyz)(?:\.[a-z]{2,3})?)\b/i;

export function guessStartUrl(mission) {
  const known = KNOWN_SITE_HINTS.find((h) => h.re.test(mission))?.url;
  if (known) return known;
  const domainMatch = DOMAIN_IN_TEXT_RE.exec(mission);
  return domainMatch ? `https://${domainMatch[1]}` : undefined;
}

// ── Windows toast identity: shows "AI Browser" + the real aivin icon instead of a bare, borrowed
// "File Explorer" notification ────────────────────────────────────────────────────────────────
//
// Confirmed by hand while building this: a plain AppUserModelId registry entry (DisplayName +
// IconUri, no shortcut) gets the NAME right but Windows silently ignores the IconUri for an
// unpackaged (non-MSIX) app - a known platform gap, not a bug in this setup. The icon only actually
// shows once a Start Menu shortcut exists whose System.AppUserModel.ID property (via IPropertyStore)
// matches the AUMID used in CreateToastNotifier - that requires COM interop (IShellLinkW +
// IPropertyStore), which plain PowerShell cmdlets don't expose, hence the embedded C# below compiled
// on demand via Add-Type. This whole block only ever runs ONCE per machine (skipped immediately if
// the shortcut already exists) - the compile is real but not a per-notification cost.
export const AIVIN_NOTIF_AUMID = 'AivinBrowser.CLI';

export const AIVIN_ICON_SOURCE_PNG = path.join(__dirname, 'assets', 'aivin-icon.png');

export const AIVIN_ICON_ICO = path.join(os.homedir(), '.aivin', 'notification-icon.ico');

export function windowsNotificationShortcutPath() {
  // %APPDATA%\Microsoft\Windows\Start Menu\Programs - same folder Start Menu search indexes,
  // matches what a real installer would use (this entry never needs to be launched by the user,
  // it exists purely to carry the AUMID + icon association).
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AI Browser.lnk');
}

/** One-time (per machine), best-effort setup - PNG→ICO conversion + registry DisplayName + a Start
 *  Menu shortcut carrying the AUMID via COM IPropertyStore. Every step independently best-effort:
 *  a failure partway (e.g. propsys.dll COM call blocked by policy) just means the toast falls back
 *  to a plain/unbranded appearance later, never something worth failing a mission over. Synchronous
 *  (blocks briefly on first-ever notification only) - acceptable since it's a one-time cost in the
 *  context of a multi-minute mission, and notifications aren't on any latency-sensitive path. */
export function ensureWindowsNotificationIdentity() {
  const shortcutPath = windowsNotificationShortcutPath();
  if (fs.existsSync(shortcutPath)) return; // already set up on this machine
  try {
    fs.mkdirSync(path.dirname(AIVIN_ICON_ICO), { recursive: true });
    const csharpSource = `
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class AivinShortcutAumid {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] internal class ShellLink { }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    internal interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl); void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cchMaxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cchMaxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cchMaxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey); void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd); void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cchIconPath, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }
    [StructLayout(LayoutKind.Sequential)] internal struct PROPERTYKEY { public Guid fmtid; public int pid; }
    [StructLayout(LayoutKind.Sequential)] internal struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore {
        void GetCount(out uint cProps); void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv); void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }
    [DllImport("propsys.dll")] static extern int PSPropertyKeyFromString([MarshalAs(UnmanagedType.LPWStr)] string s, out PROPERTYKEY pkey);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);
    public static void CreateWithAumid(string shortcutPath, string targetPath, string iconPath, string aumid) {
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(targetPath);
        link.SetIconLocation(iconPath, 0);
        link.SetShowCmd(7);
        PROPERTYKEY pkey;
        if (PSPropertyKeyFromString("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3} 5", out pkey) != 0) throw new Exception("PSPropertyKeyFromString failed");
        var pv = new PROPVARIANT();
        pv.vt = 31; // VT_LPWSTR
        pv.p = Marshal.StringToCoTaskMemUni(aumid);
        ((IPropertyStore)link).SetValue(ref pkey, ref pv);
        ((IPropertyStore)link).Commit();
        PropVariantClear(ref pv);
        ((IPersistFile)link).Save(shortcutPath, true);
    }
}`;
    const setupScript = [
      'Add-Type -AssemblyName System.Drawing',
      `if (-not (Test-Path $env:AIVIN_ICO_PATH)) {`,
      '  $png = [System.Drawing.Image]::FromFile($env:AIVIN_PNG_PATH)',
      '  $bmp = New-Object System.Drawing.Bitmap($png, 256, 256)',
      '  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())',
      '  $fs = New-Object System.IO.FileStream($env:AIVIN_ICO_PATH, [System.IO.FileMode]::Create)',
      '  $ico.Save($fs); $fs.Close(); $png.Dispose()',
      '}',
      `New-Item -Path "HKCU:\\Software\\Classes\\AppUserModelId\\${AIVIN_NOTIF_AUMID}" -Force | Out-Null`,
      `Set-ItemProperty -Path "HKCU:\\Software\\Classes\\AppUserModelId\\${AIVIN_NOTIF_AUMID}" -Name DisplayName -Value "AI Browser"`,
      `Add-Type -TypeDefinition @'\n${csharpSource}\n'@ -Language CSharp`,
      `[AivinShortcutAumid]::CreateWithAumid($env:AIVIN_SHORTCUT_PATH, "$env:WINDIR\\System32\\cmd.exe", $env:AIVIN_ICO_PATH, "${AIVIN_NOTIF_AUMID}")`,
    ].join('\n');
    execSync(`powershell.exe -NoProfile -NonInteractive -Command -`, {
      input: setupScript,
      env: {
        ...process.env,
        AIVIN_PNG_PATH: AIVIN_ICON_SOURCE_PNG,
        AIVIN_ICO_PATH: AIVIN_ICON_ICO,
        AIVIN_SHORTCUT_PATH: shortcutPath,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 15_000,
    });
  } catch {
    // best-effort only - toast still works via the Explorer-borrowed AppID fallback below,
    // just without aivin's own name/icon.
  }
}

/** Best-effort native OS notification - `aivin browser` (local mode) can run for minutes at a time
 *  with the user's attention elsewhere, and a HIL request in particular needs them to actually come
 *  back and look. Native per-OS command, no extra npm dependency (matches this file's existing
 *  pattern - registry reads, plutil, xdg-settings are all done the same way). Title/message passed
 *  via env vars (not string-interpolated into the script) specifically to avoid any shell/PowerShell/
 *  AppleScript quoting/injection concern - mission text and error messages both end up here and
 *  neither is trusted input. Never throws, never blocks - a failed notification is not worth
 *  interrupting a mission over. */
export function sendOSNotification(title, message) {
  try {
    if (process.platform === 'win32') {
      ensureWindowsNotificationIdentity();
      // Windows 10/11 toast via the WinRT API directly - no extra module (BurntToast etc.) needed.
      // Uses the dedicated AUMID set up above once a shortcut backs it (falls back to Explorer's
      // borrowed identity harmlessly if that setup didn't succeed - CreateToastNotifier doesn't
      // validate the AUMID actually resolves to anything, it just shows less polished either way).
      const script = [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
        "$t = [System.Security.SecurityElement]::Escape($env:AIVIN_NOTIF_TITLE)",
        "$m = [System.Security.SecurityElement]::Escape($env:AIVIN_NOTIF_MSG)",
        "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
        "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$m</text></binding></visual></toast>\")",
        "$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)",
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AIVIN_NOTIF_AUMID}').Show($toast)`,
      ].join('; ');
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, AIVIN_NOTIF_TITLE: title, AIVIN_NOTIF_MSG: message },
        stdio: 'ignore', detached: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      // `system attribute` reads the env var directly in AppleScript - sidesteps needing to escape
      // title/message into the script string at all.
      spawn('osascript', ['-e', 'display notification (system attribute "AIVIN_NOTIF_MSG") with title (system attribute "AIVIN_NOTIF_TITLE")'], {
        env: { ...process.env, AIVIN_NOTIF_TITLE: title, AIVIN_NOTIF_MSG: message },
        stdio: 'ignore', detached: true,
      }).unref();
    } else {
      // notify-send (freedesktop.org standard, most desktop distros ship it) - args array, not a
      // shell string, so no quoting concern here either.
      spawn('notify-send', [title, message], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // best-effort only
  }
}
