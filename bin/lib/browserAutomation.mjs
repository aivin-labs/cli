import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import axios from 'axios';
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import WSClient from 'ws';
import { missionServerUrl, missionAuthHeaders, resolveWorkspace, resolveAgentInteractive, createAgent, pullAgentIntoWorkspace } from './workspace.mjs';
import { parseApiKeyClient } from './auth.mjs';
import { guessStartUrl, BROWSER_MISSION_PREFIX } from './missionStream.mjs';
import { watchBrowserMission } from './browserTui.mjs';

// ── `aivin browser` default mode: drive the user's OWN local, already-running browser ──────────
//
// Real cookies/logins, real fingerprint - much better bot-detection resistance than the server-
// side pooled browser `--remote` uses. Architecture: a raw WebSocket relay on the backend
// (BrowserTunnelRelay) pairs this CLI's connection to the user's local Chrome CDP endpoint with
// AIBrowserService's own `BrowserIO.connect(...)` call server-side - the EXISTING agentic loop
// (causality, bot-guard, semantic matching, HIL) drives that real browser unmodified, this file
// only ever pipes opaque frames, never inspects them.

export const BROWSER_CLI_AGENT_CACHE_PATH = path.join(os.homedir(), '.aivin', 'browser-cli-agents.json');

// A separate Chrome/Edge profile dedicated to `aivin browser`, NOT the user's real daily-driver
// profile. Reasoning (confirmed the hard way): `--remote-debugging-port` can only be set at process
// launch, never toggled on an already-running instance, AND Chromium's single-instance-per-profile
// lock means launching a second process against the SAME profile the user is already using just
// silently forwards to the existing (non-debuggable) instance instead of actually starting a new,
// debuggable one - so reusing the daily-driver profile meant demanding the user close every window
// first, every single time. A dedicated profile sidesteps all of that: it can launch/stay running
// fully independently of whatever the user's main browser is doing, at the cost of a one-time login
// (Facebook etc.) the first time it's used - after that, cookies persist here just like any profile.
export const AIVIN_BROWSER_PROFILE_DIR = path.join(os.homedir(), '.aivin', 'browser-profile');

// 9222 is Chrome/Edge's conventional remote-debugging port, but it's not reserved to them - anything
// can be listening there (found the hard way: this project's own local docker-compose stack publishes
// its headless Lightpanda container on host port 9222 too, for the unrelated `--remote` server-side
// browser pool). `probeLocalChromeDebugger` below verifies the `Browser` field before trusting a hit
// here, and `--debug-port` lets a real conflict just be sidestepped instead of fought.
export const CHROME_DEBUG_PORT = 9222;

export function loadBrowserCliAgentCache() {
  try {
    return JSON.parse(fs.readFileSync(BROWSER_CLI_AGENT_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveBrowserCliAgentCache(cache) {
  fs.mkdirSync(path.dirname(BROWSER_CLI_AGENT_CACHE_PATH), { recursive: true });
  fs.writeFileSync(BROWSER_CLI_AGENT_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * `aivin browser` shouldn't require the user to know/pick an "agent" - AI Browser is what actually
 * does the work, the agent is just session/HIL identity plumbing the platform's data model requires
 * underneath. Creates one dedicated agent per workspace the first time, with `official.ai_browser`
 * already enabled, and caches its id so every later run is instant. Both API calls below (create,
 * then a second update call with `plugins.plugin_ids`) were verified working directly against the
 * API this session - `workspace_id` must be a query param on the update call (the DTO whitelists
 * it out of the body), and name/nickname/email must be repeated even though only `plugins` changed.
 */
export async function resolveOrCreateBrowserAgent(serverUrl, authHeaders, workspace) {
  const workspaceId = workspace.id || workspace._id;
  const cache = loadBrowserCliAgentCache();
  const cachedId = cache[workspaceId];
  if (cachedId && workspace.agents?.some((a) => (a.id || a.agent_id) === cachedId)) {
    return cachedId;
  }

  console.log(chalk.gray('   (no cached browser agent for this workspace yet - creating one, one-time only)'));
  const identity = {
    name: 'AI Browser (CLI)',
    nickname: 'aivin-browser-cli',
    email: `aivin-browser-cli+${workspaceId}@local.invalid`,
  };

  // `/ai-staff/update` requires name/nickname/email again even though only `plugins` is actually
  // changing (confirmed while testing) - default to the NEW agent's own identity, but when falling
  // back to an EXISTING agent below, this must become THAT agent's real identity instead, or the
  // update call would silently overwrite/rename someone's real agent with the CLI's placeholder
  // name - a real, destructive bug caught in review before ever shipping.
  let agentId;
  let updateIdentity = identity;
  try {
    const created = await createAgent(serverUrl, authHeaders, {
      ...identity,
      bio: 'Auto-created by `aivin browser` - runs AI Browser missions triggered from the CLI.',
      workspaceId,
    });
    agentId = created.id || created.agent_id;
    await pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId, workspaceId });
  } catch (error) {
    // Confirmed hitting this directly while testing: accounts on a plan with a low agent-count
    // limit get a clear "limit reached" error here. Rather than dead-ending, fall back to reusing
    // the workspace's own first existing agent (if any) - enabling official.ai_browser on it is a
    // much better outcome than making the user go figure out --agent <id> themselves after a
    // confusing failure.
    const existing = workspace.agents?.[0];
    if (!existing) throw error; // nothing to fall back to - surface the original error as-is
    const message = error.response?.data?.message || error.message;
    console.log(chalk.yellow(`   ⚠️  Couldn't create a dedicated agent (${message}) - reusing "${existing.nickname || existing.name}" instead.`));
    agentId = existing.id || existing.agent_id;
    updateIdentity = { name: existing.name, nickname: existing.nickname, email: existing.email };
  }

  // Merge, don't replace - an existing agent (the fallback path above) may already have OTHER
  // plugins enabled; sending plugin_ids: ['official.ai_browser'] alone would silently wipe those.
  const existingPluginIds = workspace.agents?.find((a) => (a.id || a.agent_id) === agentId)?.plugins?.plugin_ids || [];
  const mergedPluginIds = existingPluginIds.includes('official.ai_browser') ? existingPluginIds : [...existingPluginIds, 'official.ai_browser'];

  await axios
    .post(
      `${serverUrl}/ai-staff/update?workspace_id=${encodeURIComponent(workspaceId)}`,
      { id: agentId, ...updateIdentity, plugins: { plugin_ids: mergedPluginIds } },
      authHeaders,
    )
    .catch((error) => {
      const message = error.response?.data?.message || error.message;
      console.log(chalk.yellow(`   ⚠️  Could not enable official.ai_browser on the agent automatically: ${message}`));
    });

  cache[workspaceId] = agentId;
  saveBrowserCliAgentCache(cache);
  console.log(chalk.green(`   ✅ Agent ready for AI Browser CLI use (cached for next time).`));
  return agentId;
}

/** Chrome's own remote-debugging discovery endpoint - reachable only if the user already relaunched
 *  Chrome with `--remote-debugging-port`. Returns the CDP WebSocket URL for the whole browser, or
 *  null if nothing's listening there (or something else entirely is - see below). */
export async function probeLocalChromeDebugger(port = CHROME_DEBUG_PORT) {
  try {
    const res = await axios.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 });
    // Something answered - but NOT necessarily Chrome/Edge. Confirmed hitting this for real: this
    // port is also where this project's own local dev stack publishes a headless Lightpanda
    // container (no UI at all), which happily speaks CDP and would otherwise look identical to a
    // real browser here - "mission ran but no window ever appeared" was the resulting symptom.
    // Real Chrome/Edge both report a `Browser` field like "Chrome/123.0..." / "Edg/123.0...".
    const product = String(res.data?.Browser || '');
    if (!/^(Chrome|Edg)\//.test(product)) {
      return { wsUrl: null, conflict: product || 'unknown service', browserId: null };
    }
    const browserId = /^Edg\//.test(product) ? 'edge' : 'chrome';
    return { wsUrl: res.data?.webSocketDebuggerUrl || null, conflict: null, browserId };
  } catch {
    return { wsUrl: null, conflict: null, browserId: null };
  }
}

// Any Chromium-based browser works identically here (same --remote-debugging-port / CDP protocol).
// Order here is only a last-resort tiebreaker (see findLocalBrowser) - actual selection prefers the
// user's real OS default browser via detectDefaultBrowserId(), or an explicit --browser flag.
export const LOCAL_BROWSERS = [
  {
    id: 'edge',
    name: 'Microsoft Edge',
    win32: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    linux: 'microsoft-edge',
    profileDirWin32: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'Microsoft Edge'],
    profileDirLinux: ['.config', 'microsoft-edge'],
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: 'google-chrome',
    profileDirWin32: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'Google', 'Chrome'],
    profileDirLinux: ['.config', 'google-chrome'],
  },
];

export function resolveBrowserInstall(browser) {
  const home = os.homedir();
  let exe;
  let profileSegments;
  if (process.platform === 'win32') {
    exe = browser.win32.find((p) => fs.existsSync(p)) || null;
    profileSegments = browser.profileDirWin32;
  } else if (process.platform === 'darwin') {
    exe = fs.existsSync(browser.darwin) ? browser.darwin : null;
    profileSegments = browser.profileDirDarwin;
  } else {
    exe = browser.linux; // assumed on PATH on Linux - no reliable single default install path there
    profileSegments = browser.profileDirLinux;
  }
  if (!exe) return null;
  return { id: browser.id, name: browser.name, exe, profileDir: path.join(home, ...profileSegments) };
}

/** Best-effort read of the OS's actual "default browser" setting, mapped to one of LOCAL_BROWSERS'
 *  `id`s - or null if it can't be determined (unsupported platform, unknown browser, command
 *  missing/failed) or if the default is a non-Chromium browser (Firefox/Safari - no CDP support, so
 *  there's nothing to tunnel into). Never throws - this is a "nice to have" signal, `findLocalBrowser`
 *  falls back to install-order when it's unavailable. */
export function detectDefaultBrowserId() {
  try {
    if (process.platform === 'win32') {
      // The per-user UserChoice hash-protected key (what Settings > Default apps itself writes) is
      // awkward to read reliably across Windows versions and, confirmed while testing this, is often
      // just absent (no explicit override ever made). `Software\Classes\http\shell\open\command` is
      // what Windows actually resolves to at launch time regardless of how it got set - HKCU holds a
      // per-user override if one exists, HKLM is the system-wide fallback otherwise. Reading the
      // command line's exe name directly sidesteps needing to decode a ProgId at all.
      const readCommand = (hive) => {
        try {
          return execSync(`reg query "${hive}\\Software\\Classes\\http\\shell\\open\\command"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
          return '';
        }
      };
      const out = readCommand('HKCU') || readCommand('HKLM');
      if (/msedge\.exe/i.test(out)) return 'edge';
      if (/chrome\.exe/i.test(out)) return 'chrome';
      return null; // Firefox, or something unrecognized
    }
    if (process.platform === 'darwin') {
      // No single stock CLI for this on macOS - LaunchServices' own plist is the source of truth
      // Settings > Desktop & Dock reads from, `plutil` (stock, ships with macOS) can dump it as JSON.
      const plistPath = path.join(
        os.homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices',
        'com.apple.launchservices.secure.plist',
      );
      if (!fs.existsSync(plistPath)) return null;
      const json = execSync(`plutil -convert json -o - "${plistPath}"`, { encoding: 'utf8' });
      const handlers = JSON.parse(json)?.LSHandlers || [];
      const httpHandler = handlers.find((h) => h.LSHandlerURLScheme === 'http');
      const bundleId = String(httpHandler?.LSHandlerRoleAll || '').toLowerCase();
      if (bundleId.includes('edge')) return 'edge';
      if (bundleId.includes('chrome')) return 'chrome';
      return null; // Safari, Firefox, or undetermined
    }
    // Linux: xdg-settings is the freedesktop.org standard way, present on most desktop distros.
    const out = execSync('xdg-settings get default-web-browser', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/edge/i.test(out)) return 'edge';
    if (/chrome/i.test(out)) return 'chrome';
    return null;
  } catch {
    return null; // command missing, key absent, parse failure - all fine to just not know
  }
}

/**
 * Picks which installed browser to drive, in priority order:
 *  1. `preferredId` (from `--browser edge|chrome`) - explicit always wins, errors clearly if that
 *     browser isn't actually installed rather than silently falling through to another one.
 *  2. The OS's actual default browser, IF it's Chromium-based and installed - this is what makes
 *     "drives your own logged-in browser" true; guessing wrong here would tunnel into a browser
 *     profile the user doesn't actually use, with none of the cookies/logins they expect.
 *  3. Whatever's installed from LOCAL_BROWSERS, in list order - last resort when the real default
 *     couldn't be determined or isn't Chromium (Firefox/Safari have no CDP to tunnel into).
 * Always logs which one it picked and why when there was more than one candidate, so step 3 in
 * particular is never a silent surprise.
 */
export function findLocalBrowser(preferredId) {
  const installed = LOCAL_BROWSERS.map(resolveBrowserInstall).filter(Boolean);
  if (installed.length === 0) return null;

  if (preferredId) {
    const match = installed.find((b) => b.id === preferredId);
    if (match) return match;
    throw new Error(`--browser ${preferredId} was requested, but it isn't installed at any of the usual locations. Installed: ${installed.map((b) => b.id).join(', ') || 'none'}.`);
  }

  if (installed.length > 1) {
    const defaultId = detectDefaultBrowserId();
    const byDefault = defaultId && installed.find((b) => b.id === defaultId);
    if (byDefault) return byDefault;
    console.log(chalk.gray(
      `   (multiple browsers installed (${installed.map((b) => b.name).join(', ')}) and couldn't confirm your OS default - ` +
      `using ${installed[0].name}. Pass --browser ${installed.map((b) => b.id).join('|')} to pick.)`,
    ));
  }

  return installed[0];
}

export function launchCommandHint(browser, port = CHROME_DEBUG_PORT) {
  const label = browser ? browser.name : 'Chrome or Edge';
  const exe = browser ? `"${browser.exe}"` : '<your browser>';
  if (process.platform === 'win32') return `& ${exe} --remote-debugging-port=${port}  (${label})`;
  if (process.platform === 'darwin') return `open -a "${label}" --args --remote-debugging-port=${port}`;
  return `${browser ? browser.exe : 'google-chrome'} --remote-debugging-port=${port}`;
}

export function printChromeLaunchHelp(port = CHROME_DEBUG_PORT, preferredId) {
  const browser = findLocalBrowser(preferredId);
  console.log(chalk.yellow('\n⚠️  Could not start a local browser for AI Browser.'));
  console.log(`   ${chalk.cyan(launchCommandHint(browser, port))}\n`);
  console.log(chalk.gray('   ...or pass --remote for a server-side browser instead (no local browser needed).'));
}

/** Launches a browser window dedicated to `aivin browser`, on ITS OWN profile
 *  (AIVIN_BROWSER_PROFILE_DIR) - never the user's real daily-driver one. This is what makes local
 *  mode zero-friction after the first run: because it's a separate profile, it never collides with
 *  whatever the user's main browser is already doing (no "close all your windows first"), and once
 *  running it just stays up - a later mission finds it already listening and reuses it, opening a
 *  new tab in the SAME window rather than launching anything again. The one real cost: the first
 *  time any given site is used (Facebook, etc.), the user logs in once here, same as any fresh
 *  profile - after that it persists exactly like their main browser's cookies do. */
export async function launchLocalChromeWithDebugging(port = CHROME_DEBUG_PORT, preferredId) {
  const browser = findLocalBrowser(preferredId);
  if (!browser) {
    throw new Error(`Could not find a local Chrome/Edge install automatically - relaunch one manually with: ${launchCommandHint(null, port)}`);
  }
  const firstRun = !fs.existsSync(AIVIN_BROWSER_PROFILE_DIR);
  fs.mkdirSync(AIVIN_BROWSER_PROFILE_DIR, { recursive: true });
  // No pre-flight SingletonLock check here on purpose (an earlier version of this had one, copied
  // from the old "don't touch the user's real profile" logic where it made sense): by the time we
  // get here, probeLocalChromeDebugger() has ALREADY confirmed nothing is answering on `port`, so a
  // present lock file can only be stale (left behind by an unclean shutdown/crash) - Chromium itself
  // already detects and clears stale locks on startup (checks whether the owning PID is still
  // alive), more reliably than re-implementing that check here. A pre-check could only ever produce
  // a false positive: a confusing "already open, go close it" error pointing at a window that isn't
  // actually running anywhere.
  if (firstRun) {
    console.log(chalk.gray(`   First run: opening a NEW, separate ${browser.name} window just for AI Browser (your regular ${browser.name} is untouched).`));
    console.log(chalk.gray(`   You'll need to log into any site the mission needs (Facebook, etc.) once in THIS window - it'll stay logged in from then on.`));
  } else {
    console.log(chalk.gray(`   Opening your dedicated AI Browser window...`));
  }
  const child = spawn(browser.exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${AIVIN_BROWSER_PROFILE_DIR}`, '--no-first-run', '--start-maximized'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { wsUrl, conflict } = await probeLocalChromeDebugger(port);
    if (wsUrl) return wsUrl;
    if (conflict) {
      throw new Error(
        `Port ${port} is already in use by something else (reported itself as "${conflict}", not Chrome/Edge) - ` +
        `${browser.name} can't bind its debug port there. Free that port, or rerun with --debug-port <other-port>.`,
      );
    }
  }
  throw new Error(`${browser.name} launched but its debug port never came up in time.`);
}

/**
 * Opens 2 raw WebSocket connections - one to the backend's relay (authenticated by API key), one
 * to the user's own local Chrome's real CDP endpoint - and pipes frames both directions verbatim.
 * `close()` disconnects both sides; the user's actual browser window is never touched beyond this
 * one CDP connection, closing the tunnel just detaches Puppeteer server-side.
 *
 * `onUnexpectedClose(side)` fires when either leg drops WITHOUT `close()` having been called first
 * (side is 'backend' or 'chrome') - lets the caller distinguish "network/tunnel died mid-mission"
 * from "we're done, tearing down deliberately" (Ctrl+C, mission finished) without guessing from
 * timing alone. Never fires after a deliberate `close()`.
 */
export function openLocalTunnel(serverUrl, apiKey, chromeWsUrl, { onUnexpectedClose } = {}) {
  const tunnelId = randomUUID();
  const relayUrl = `${serverUrl.replace(/^http/, 'ws')}/browser-tunnel/external?tunnel_id=${tunnelId}`;

  // API key goes in a header, NOT a `?token=` query param - WS upgrade URLs are exactly the kind
  // of thing that ends up verbatim in reverse-proxy/CDN/access logs, unlike headers.
  const toBackend = new WSClient(relayUrl, { headers: { Authorization: `Bearer ${apiKey || ''}` } });
  const toChrome = new WSClient(chromeWsUrl);

  let deliberateClose = false;

  const relay = (from, to, side) => {
    from.on('message', (data, isBinary) => {
      if (to.readyState === WSClient.OPEN) to.send(data, { binary: isBinary });
    });
    from.on('close', () => {
      if (to.readyState === WSClient.OPEN) to.close();
      if (!deliberateClose) onUnexpectedClose?.(side);
    });
    from.on('error', () => {
      if (to.readyState === WSClient.OPEN) to.close();
      if (!deliberateClose) onUnexpectedClose?.(side);
    });
  };
  relay(toBackend, toChrome, 'backend');
  relay(toChrome, toBackend, 'chrome');

  const ready = Promise.all([
    new Promise((resolve, reject) => {
      toBackend.once('open', resolve);
      toBackend.once('error', reject);
    }),
    new Promise((resolve, reject) => {
      toChrome.once('open', resolve);
      toChrome.once('error', reject);
    }),
  ]);

  const close = () => {
    deliberateClose = true;
    try { toBackend.close(); } catch { /* already closed */ }
    try { toChrome.close(); } catch { /* already closed */ }
  };

  return { tunnelId, ready, close };
}

export async function runBrowserMissionLocal(mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();
  const tenantClient = parseApiKeyClient(apiKey || '') || 'unknown';

  const preferredId = options.browser ? String(options.browser).toLowerCase() : undefined;
  if (preferredId && preferredId !== 'edge' && preferredId !== 'chrome') {
    throw new Error(`--browser must be "edge" or "chrome", got "${options.browser}".`);
  }

  // --debug-port pins an exact port (strict - errors immediately if it's taken by something else).
  // Without it, try the conventional 9222 first, then a few neighbors - confirmed needed for real:
  // this project's OWN local dev stack publishes an unrelated container on 9222 (see
  // probeLocalChromeDebugger's comment), so erroring out on the very first conflict there would make
  // `aivin browser` unusable out of the box for anyone running that stack, every single time.
  const explicitPort = options.debugPort !== undefined;
  const candidatePorts = explicitPort ? [Number(options.debugPort)] : [CHROME_DEBUG_PORT, 9223, 9224, 9225];

  let debugPort;
  let chromeWsUrl;
  const triedConflicts = [];
  for (const port of candidatePorts) {
    const probed = await probeLocalChromeDebugger(port);
    if (probed.wsUrl && preferredId && probed.browserId !== preferredId) {
      // Something's already listening, but it's the OTHER browser than what --browser asked for -
      // using it silently would drive the wrong profile (wrong cookies/logins), so this has to be a
      // hard error rather than a best-effort fallback, even mid auto-retry.
      throw new Error(
        `--browser ${preferredId} was requested, but the browser already listening on port ${port} is ${probed.browserId} instead. ` +
        `Close it and relaunch ${preferredId} with --remote-debugging-port=${port}, or use --debug-port to point at a different port.`,
      );
    }
    if (probed.wsUrl) { debugPort = port; chromeWsUrl = probed.wsUrl; break; }
    if (probed.conflict) { triedConflicts.push(`${port} (${probed.conflict})`); continue; }
    debugPort = port; // free port, nothing answering at all - safe to launch here
    break;
  }
  if (debugPort === undefined) {
    throw new Error(
      `${explicitPort ? 'Requested' : 'All of the usual'} debug port${candidatePorts.length > 1 ? 's are' : ' is'} already in use by something else, not Chrome/Edge: ${triedConflicts.join(', ')}. ` +
      `Free one of them, or pass --debug-port <port> to use a specific one.`,
    );
  }

  if (!chromeWsUrl) {
    // Safe to always auto-launch now (unlike an earlier version of this): this opens AIVIN_BROWSER_
    // PROFILE_DIR, a profile dedicated to `aivin browser` that's never the user's real daily-driver
    // browser, so there's no risk of colliding with (or having to close) whatever they're already
    // running elsewhere.
    try {
      chromeWsUrl = await launchLocalChromeWithDebugging(debugPort, preferredId);
    } catch (error) {
      printChromeLaunchHelp(debugPort, preferredId);
      throw error;
    }
  }

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const agentId = options.agent || (await resolveOrCreateBrowserAgent(serverUrl, authHeaders, workspace));

  console.log(chalk.blue('🌐 AI Browser (local - your own browser):'), mission);
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));

  // Retry the local tunnel on an UNEXPECTED drop (flaky WiFi) - checkpoint-resume already exists
  // server-side (AIBrowserCheckpointService, matches on tenant + exact mission text), so re-firing
  // the SAME mission through a fresh tunnel just continues where it left off instead of restarting.
  // Only worth doing when we're actually watching (options.watch !== false) - without the log
  // stream there's no reliable signal for "did the mission already finish" vs "tunnel just dropped",
  // so a single un-retried attempt (old behavior) is what happens when watch is disabled.
  const MAX_TUNNEL_RETRIES = 3;
  let interrupted = false;
  let terminalReason; // 'success' | 'failed' | undefined (still unresolved / gave up watching)
  let attempt = 0;

  while (!interrupted) {
    attempt++;
    if (attempt > 1) {
      // Chrome's CDP websocket URL can go stale after a drop, and the browser itself may have
      // closed too (user closed the window) - re-probe rather than blindly reusing the old URL.
      const reprobe = await probeLocalChromeDebugger(debugPort);
      if (!reprobe.wsUrl) {
        console.log(chalk.red(`\n❌ Mất kết nối và không tìm lại được ${preferredId || 'Chrome/Edge'} đang chạy ở cổng ${debugPort} - trình duyệt có thể đã bị đóng. Dừng lại đây (mission có thể vẫn đang chạy trên server - kiểm tra lại bằng \`aivin browser --view\` hoặc chạy lại lệnh này).`));
        break;
      }
      chromeWsUrl = reprobe.wsUrl;
      console.log(chalk.yellow(`\n🔄 Tunnel bị rớt kết nối bất ngờ - đang thử lại (lần ${attempt - 1}/${MAX_TUNNEL_RETRIES})...`));
    }

    let unexpectedDrop = false;
    const tunnel = openLocalTunnel(serverUrl, apiKey, chromeWsUrl, {
      onUnexpectedClose: () => { unexpectedDrop = true; },
    });
    try {
      await tunnel.ready;
    } catch (error) {
      tunnel.close();
      if (attempt > MAX_TUNNEL_RETRIES) throw new Error(`Could not open the local browser tunnel: ${error.message}`, { cause: error });
      console.log(chalk.yellow(`\n⚠️  Không mở được tunnel (${error.message}) - đang thử lại (lần ${attempt}/${MAX_TUNNEL_RETRIES})...`));
      continue;
    }

    const sessionId = `browser-cli-${randomUUID()}`;
    console.log(chalk.gray(`   Session: ${sessionId}`));

    // Ctrl+C: request cooperative cancellation (same mechanism sdk.browser.cancel() uses - checked
    // between agentic-loop steps, can't interrupt a step already in flight) AND close the tunnel.
    // Closing the tunnel alone isn't enough to stop a mission stuck in an LLM call that hasn't
    // touched the browser connection yet (confirmed while testing this) - the cancel request is what
    // actually gets it to stop at its next chance to check. The tab this mission was using stays open
    // either way - never force-closed, since local mode is explicitly "your own browser, your tabs".
    const onSigint = () => {
      if (interrupted) return;
      interrupted = true;
      console.log(chalk.yellow('\n\n⏹  Stopping... (requesting cancellation - may take a moment, one agentic step at a time)'));
      requestBrowserCancel(serverUrl, authHeaders).catch((e) =>
        console.log(chalk.red(`   ⚠️  Cancellation request failed to send (${e.message}) - the mission may keep running.`)),
      );
      tunnel.close();
      console.log(chalk.gray('   The tab this mission was using is still open in your browser - close it yourself if you don\'t need it.'));
    };
    process.on('SIGINT', onSigint);

    // Fired concurrently, not sequentially - execute-interactive is a SYNCHRONOUS call (blocks until
    // the mission ends), so the log watcher has to already be listening before/as it fires, not after.
    const missionPromise = axios.post(
      // `/plugins/` prefix: OfficialPluginModules.ts registers every official plugin module (incl.
      // AIBrowserModule) via RouterModule.register({ path: 'plugins', ... }) - easy to miss, confirmed
      // by testing directly against the API (plain /ai-browser/... 404s, /plugins/ai-browser/... works).
      `${serverUrl}/plugins/ai-browser/execute-interactive`,
      {
        mission,
        workspace_id: workspace.id || workspace._id,
        agent_id: agentId,
        session_id: sessionId,
        data: { __local_tunnel_id: tunnel.tunnelId, start_url: options.url || guessStartUrl(mission) },
      },
      authHeaders,
    );
    const watchPromise = options.watch !== false
      ? watchBrowserMission(serverUrl, apiKey, sessionId, tenantClient, { openViewerOnHIL: false })
      : Promise.resolve(undefined);

    try {
      // execute-interactive responds immediately (fire-and-forget - see AIBrowserController.ts's
      // comment on why: a synchronous wait here would hit the same Cloudflare 524 the gRPC
      // browser.run() call did). The REAL outcome is whatever the log stream above already printed
      // (ai_browser.success/failed) - this Promise.all is just making sure both sides are done.
      const [, watchReason] = await Promise.all([missionPromise, watchPromise]);
      terminalReason = watchReason;
    } catch (error) {
      if (!interrupted) {
        const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
        throw new Error(`AI Browser mission failed to start: ${message}`, { cause: error });
      }
    } finally {
      process.off('SIGINT', onSigint);
      tunnel.close();
    }

    if (interrupted) break;
    if (terminalReason === 'success' || terminalReason === 'failed') break; // genuine mission outcome - done
    // options.watch === false (no signal at all) or watch gave up on its own (idle/connect_error,
    // NOT a tunnel drop) - neither is worth blindly retrying; only retry on a confirmed tunnel drop.
    if (!unexpectedDrop) break;
    if (attempt > MAX_TUNNEL_RETRIES) {
      console.log(chalk.red(`\n❌ Đã thử lại ${MAX_TUNNEL_RETRIES} lần nhưng tunnel vẫn liên tục rớt kết nối - dừng theo dõi. Mission có thể vẫn đang chạy trên server.`));
      break;
    }
  }

  if (!interrupted && (terminalReason === 'success' || terminalReason === 'failed')) {
    console.log(chalk.gray('\n   Done - see the log lines above for the outcome, and your own browser for the result.'));
  }
}

/** REST twin of `sdk.browser.cancel()` - the CLI has no gRPC client, only axios. See
 *  AIBrowserController.cancel's comment for the exact semantics (cooperative, own-tenant-only). */
export async function requestBrowserCancel(serverUrl, authHeaders) {
  await axios.post(`${serverUrl}/plugins/ai-browser/cancel`, {}, authHeaders);
}

export async function runBrowserMissionRemote(mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();
  const tenantClient = parseApiKeyClient(apiKey || '') || 'unknown';

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  // Same interactive resolver `aivin do` uses (not the throw-if-missing resolveAgentId) - a fresh
  // workspace commonly has zero agents installed yet, and this offers to search/install/create one
  // instead of just failing. AI Browser itself is always used as the TOOL; the agent is only the
  // identity/session context the mission (and HIL suspend/resume) runs under.
  const agent = await resolveAgentInteractive(serverUrl, authHeaders, workspace, options.agent);
  const agentId = agent.id || agent.agent_id;

  console.log(chalk.blue('🌐 AI Browser (remote - server-side browser):'), mission);
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}   Agent: ${agent.nickname || agent.name || agentId}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/agent/start-work`,
      {
        prompt: BROWSER_MISSION_PREFIX + mission,
        mission: BROWSER_MISSION_PREFIX + mission,
        workspace_id: workspace.id || workspace._id,
        agent_id: agentId,
        project_id: options.project,
      },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to start AI Browser mission: ${message}`, { cause: error });
  }

  const result = response.data ?? {};
  if (result.success === false) {
    throw new Error(result.message || 'Failed to start AI Browser mission');
  }
  const threadId = result.data?.thread_id;
  console.log(chalk.gray(`   Thread: ${threadId || 'unknown'}`));

  // Same cooperative-cancel wiring as the local-mode path above (requestBrowserCancel is
  // tenant-scoped, not session/thread-scoped, so it applies here unchanged) - without this, Ctrl+C
  // only stopped streamBrowserMissionLog's own SIGINT handler, which just disconnects the log
  // socket and returns; the mission itself kept running server-side with nothing telling it to stop.
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    console.log(chalk.yellow('\n\n⏹  Stopping... (requesting cancellation - may take a moment, one agentic step at a time)'));
    requestBrowserCancel(serverUrl, authHeaders).catch((e) =>
      console.log(chalk.red(`   ⚠️  Cancellation request failed to send (${e.message}) - the mission may keep running.`)),
    );
  };
  process.on('SIGINT', onSigint);

  try {
    if (options.watch !== false && threadId) {
      await watchBrowserMission(serverUrl, apiKey, threadId, tenantClient);
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}
