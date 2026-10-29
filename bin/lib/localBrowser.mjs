import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import axios from 'axios';
import { execSync, spawn } from 'child_process';

// ── Finding, picking and launching the local Chromium browser AI Browser drives ─────────────────
//
// Shared by `aivin browser` (browserAutomation.mjs) and `aivin remote`'s browser tunnels
// (remote/browserTunnel.mjs, remote/dailyBrowser.mjs) - kept free of imports from either so neither
// side ends up in an import cycle with the other.

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
export const DEBUG_PORTS = [CHROME_DEBUG_PORT, 9223, 9224, 9225];

/** Chrome 137+ ignores `--load-extension`; this flag is what lets the CLI load its own small tab-groups
 *  extension over CDP (`Extensions.loadUnpacked`, remote/tabGroups.mjs) - Edge accepts it too. Only ever
 *  passed for the dedicated Aivin profile, and the server can't use it: cdpPolicy.mjs blocks the whole
 *  `Extensions.*` domain on every tunnel. */
export const EXTENSION_DEBUGGING_FLAG = '--enable-unsafe-extension-debugging';

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
    // Real Chrome/Edge both report a `Browser` field like "Chrome/123.0..." / "Edg/123.0..." (Brave
    // and Chromium report themselves as "Chrome/..." too).
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
// `%LOCALAPPDATA%` is expanded at lookup time (per-user installs - Chrome offers one without admin
// rights); Linux entries are executable names looked up on PATH.
export const LOCAL_BROWSERS = [
  {
    id: 'edge',
    name: 'Microsoft Edge',
    win32: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
    profileDirWin32: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'Microsoft Edge'],
    profileDirLinux: ['.config', 'microsoft-edge'],
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: ['google-chrome', 'google-chrome-stable'],
    profileDirWin32: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'Google', 'Chrome'],
    profileDirLinux: ['.config', 'google-chrome'],
  },
  {
    id: 'brave',
    name: 'Brave',
    win32: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
    darwin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    linux: ['brave-browser', 'brave'],
    profileDirWin32: ['AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
    profileDirLinux: ['.config', 'BraveSoftware', 'Brave-Browser'],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    win32: ['%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe'],
    darwin: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    linux: ['chromium', 'chromium-browser'],
    profileDirWin32: ['AppData', 'Local', 'Chromium', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'Chromium'],
    profileDirLinux: ['.config', 'chromium'],
  },
];

export const LOCAL_BROWSER_IDS = LOCAL_BROWSERS.map((b) => b.id);

/** First of `names` found as an executable file on PATH - full path, or null. */
export function findOnPath(names, { envPath = process.env.PATH || '', exists = fs.existsSync } = {}) {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

export function resolveBrowserInstall(browser) {
  const home = os.homedir();
  let exe;
  let profileSegments;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    exe = browser.win32.map((p) => p.replace('%LOCALAPPDATA%', localAppData)).find((p) => fs.existsSync(p)) || null;
    profileSegments = browser.profileDirWin32;
  } else if (process.platform === 'darwin') {
    exe = fs.existsSync(browser.darwin) ? browser.darwin : null;
    profileSegments = browser.profileDirDarwin;
  } else {
    // Used to be assumed on PATH unconditionally - every Linux box then "had" both Edge and Chrome
    // installed, and launching the missing one crashed the CLI with an unhandled spawn ENOENT.
    exe = findOnPath(browser.linux);
    profileSegments = browser.profileDirLinux;
  }
  if (!exe) return null;
  return { id: browser.id, name: browser.name, exe, profileDir: path.join(home, ...profileSegments) };
}

/** Maps a ProgId / bundle id / .desktop name (anything naming the browser) to a LOCAL_BROWSERS id, or
 *  null for a non-Chromium browser (Firefox/Safari - no CDP to tunnel into). Chromium before Chrome:
 *  "ChromiumHTM" contains "chrome" too. */
export function browserIdFromName(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('edge')) return 'edge';
  if (s.includes('brave')) return 'brave';
  if (s.includes('chromium')) return 'chromium';
  if (s.includes('chrome')) return 'chrome';
  return null;
}

/** `reg query ...\UrlAssociations\http /s` output → the user's chosen browser id. Newer Windows 11
 *  builds keep the live choice under `UserChoiceLatest`, older ones under `UserChoice` - Latest wins
 *  when both exist. */
export function browserIdFromRegQuery(output) {
  let current = '';
  const progIds = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) current = line.trim();
    const m = /^\s*ProgId\s+REG_SZ\s+(\S+)/i.exec(line);
    if (m) progIds.push({ key: current, progId: m[1] });
  }
  const pick = progIds.find((p) => /UserChoiceLatest/i.test(p.key)) || progIds.find((p) => /UserChoice/i.test(p.key));
  return pick ? browserIdFromName(pick.progId) : null;
}

/** Best-effort read of the OS's actual "default browser" setting, mapped to one of LOCAL_BROWSERS'
 *  `id`s - or null if it can't be determined (unsupported platform, unknown browser, command
 *  missing/failed) or if the default is a non-Chromium browser (Firefox/Safari - no CDP support, so
 *  there's nothing to tunnel into). Never throws - this is a "nice to have" signal, `findLocalBrowser`
 *  falls back to install-order when it's unavailable. */
export function detectDefaultBrowserId() {
  try {
    if (process.platform === 'win32') {
      const query = (key, extra = '') => {
        try {
          return execSync(`reg query "${key}"${extra}`,{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        } catch {
          return '';
        }
      };
      // What Settings > Default apps writes: the per-user UserChoice ProgId (MSEdgeHTM, ChromeHTML,
      // BraveHTML...). Only WRITING it is hash-protected - reading is a plain registry read. An earlier
      // version read `Classes\http\shell\open\command` instead, which on a stock install only exists
      // under HKLM and keeps pointing at msedge.exe even after the user picks Chrome.
      const choice = browserIdFromRegQuery(query('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http', ' /s'));
      if (choice) return choice;
      const command = query('HKCU\\Software\\Classes\\http\\shell\\open\\command') || query('HKLM\\Software\\Classes\\http\\shell\\open\\command');
      if (/msedge\.exe/i.test(command)) return 'edge';
      if (/brave\.exe/i.test(command)) return 'brave';
      if (/chrome\.exe/i.test(command)) return 'chrome';
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
      return browserIdFromName(httpHandler?.LSHandlerRoleAll); // Safari, Firefox, or undetermined → null
    }
    // Linux: xdg-settings is the freedesktop.org standard way, present on most desktop distros.
    return browserIdFromName(execSync('xdg-settings get default-web-browser', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null; // command missing, key absent, parse failure - all fine to just not know
  }
}

/**
 * Picks which installed browser to drive, in priority order:
 *  1. `preferredId` (from `--browser`) - explicit always wins, errors clearly if that browser isn't
 *     actually installed rather than silently falling through to another one.
 *  2. The OS's actual default browser, IF it's Chromium-based and installed - this is what makes
 *     "drives your own logged-in browser" true; guessing wrong here would tunnel into a browser
 *     profile the user doesn't actually use, with none of the cookies/logins they expect.
 *  3. Whatever's installed from LOCAL_BROWSERS, in list order - last resort when the real default
 *     couldn't be determined or isn't Chromium (Firefox/Safari have no CDP to tunnel into).
 * Logs which one it picked and why when there was more than one candidate (unless `quiet`), so step
 * 3 in particular is never a silent surprise.
 */
export function findLocalBrowser(preferredId, { quiet = false } = {}) {
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
    if (!quiet) {
      console.log(chalk.gray(
        `   (multiple browsers installed (${installed.map((b) => b.name).join(', ')}) and couldn't confirm your OS default - ` +
        `using ${installed[0].name}. Pass --browser ${installed.map((b) => b.id).join('|')} to pick.)`,
      ));
    }
  }

  return installed[0];
}

/** The manual equivalent of launchLocalChromeWithDebugging - on the Aivin profile, since a window on any
 *  other profile is never attached to (only the user's everyday browser, via its own remote-debugging
 *  switch - see remoteDebuggingHint). */
export function launchCommandHint(browser, port = CHROME_DEBUG_PORT) {
  const label = browser ? browser.name : 'Chrome or Edge';
  const exe = browser ? `"${browser.exe}"` : '<your browser>';
  const args = `--remote-debugging-port=${port} --user-data-dir="${AIVIN_BROWSER_PROFILE_DIR}" ${EXTENSION_DEBUGGING_FLAG}`;
  if (process.platform === 'win32') return `& ${exe} ${args}  (${label})`;
  if (process.platform === 'darwin') return `open -na "${label}" --args ${args}`;
  return `${browser ? browser.exe : 'google-chrome'} ${args}`;
}

/** Where the user switches on "Allow remote debugging" for their everyday browser (Chrome 144+ / Edge). */
export function remoteDebuggingHint(browser) {
  return browser?.id === 'edge' ? 'edge://inspect/#remote-debugging' : 'chrome://inspect/#remote-debugging';
}

export function printChromeLaunchHelp(port = CHROME_DEBUG_PORT, preferredId) {
  let browser = null;
  try { browser = findLocalBrowser(preferredId, { quiet: true }); } catch { /* already reported by the caller's own error */ }
  console.log(chalk.yellow('\n⚠️  Could not start the Aivin browser window. To start it yourself:'));
  console.log(`   ${chalk.cyan(launchCommandHint(browser, port))}\n`);
  console.log(chalk.gray(`   ...or use your everyday ${browser?.name || 'browser'}: open ${remoteDebuggingHint(browser)}, turn on "Allow remote debugging", and rerun.`));
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
export async function launchLocalChromeWithDebugging(port = CHROME_DEBUG_PORT, preferredId, { log = (m) => console.log(chalk.gray(m)) } = {}) {
  const browser = findLocalBrowser(preferredId, { quiet: true });
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
    log(`   First run: opening a NEW, separate ${browser.name} window just for AI Browser (your regular ${browser.name} is untouched).`);
    log(`   You'll need to log into any site the mission needs (Facebook, etc.) once in THIS window - it'll stay logged in from then on.`);
  } else {
    log(`   Opening your dedicated AI Browser window...`);
  }
  const child = spawn(
    browser.exe,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${AIVIN_BROWSER_PROFILE_DIR}`, '--no-first-run', '--start-maximized', EXTENSION_DEBUGGING_FLAG],
    { detached: true, stdio: 'ignore' },
  );
  // Without a listener, a failed spawn (exe gone since lookup, no permission) is an unhandled 'error'
  // event - it took the whole CLI down with a stack trace instead of the launch help below.
  let spawnError = null;
  child.once('error', (e) => { spawnError = e; });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (spawnError) {
      throw new Error(spawnError.code === 'ENOENT'
        ? `Could not find ${browser.name} at ${browser.exe}`
        : `Could not start ${browser.name}: ${spawnError.message}`);
    }
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
