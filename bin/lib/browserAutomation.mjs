import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { missionServerUrl, missionAuthHeaders, resolveWorkspace, resolveAgentInteractive, createAgent, pullAgentIntoWorkspace } from './workspace.mjs';
import { parseApiKeyClient } from './auth.mjs';
import { guessStartUrl, BROWSER_MISSION_PREFIX } from './missionStream.mjs';
import { watchBrowserMission } from './browserTui.mjs';
import { DEBUG_PORTS, LOCAL_BROWSER_IDS, findLocalBrowser, printChromeLaunchHelp } from './localBrowser.mjs';
import { isBlockedUrl } from './remote/cdpPolicy.mjs';
import { createBrowserTunnels, ensureAivinBrowser } from './remote/browserTunnel.mjs';

// Moved to localBrowser.mjs (shared with `aivin remote`) - re-exported so existing imports keep working.
export {
  AIVIN_BROWSER_PROFILE_DIR, CHROME_DEBUG_PORT, LOCAL_BROWSERS, detectDefaultBrowserId, findLocalBrowser, launchCommandHint,
  launchLocalChromeWithDebugging, printChromeLaunchHelp, probeLocalChromeDebugger, resolveBrowserInstall,
} from './localBrowser.mjs';

// ── `aivin browser` default mode: drive the user's OWN local browser ────────────────────────────
//
// Real cookies/logins, real fingerprint - much better bot-detection resistance than the server-
// side pooled browser `--remote` uses. Architecture: a raw WebSocket relay on the backend
// (BrowserTunnelRelay) pairs this CLI's connection to the user's local Chrome CDP endpoint with
// AIBrowserService's own `BrowserIO.connect(...)` call server-side - the EXISTING agentic loop
// (causality, bot-guard, semantic matching, HIL) drives that real browser unmodified.
//
// The tunnel itself is `aivin remote`'s (remote/browserTunnel.mjs), authenticated with the API key
// instead of a device token. An earlier version had its own raw pipe here that forwarded every frame
// unfiltered (the server could open file:// URLs, redirect downloads anywhere, upload local files) and
// attached to ANY Chrome/Edge answering on 9222-9225 - including the user's real daily browser if it
// happened to have a debug port open. Sharing the tunnel gets the CDP policy filter (cdpPolicy.mjs),
// "only the Aivin-profile window" check, the guarded daily-browser mode and tab grouping in one place.

export const BROWSER_CLI_AGENT_CACHE_PATH = path.join(os.homedir(), '.aivin', 'browser-cli-agents.json');

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

/** English wording for the shared tunnel's status events - its own `say` text is Vietnamese, written for
 *  `aivin remote`'s daemon log. */
function sayTunnelEvent(_text, event = {}) {
  switch (event.type) {
    case 'consent':
      console.log(chalk.yellow(`   🔐 ${event.browser} is asking whether Aivin may use it - click "Allow" in ${event.browser}.`));
      break;
    case 'daily-declined':
      console.log(chalk.gray(`   ↩️  ${event.browser} didn't allow the connection (${event.reason}) - using the separate Aivin window instead.`));
      break;
    case 'using':
      console.log(chalk.gray(event.daily
        ? `   Using your everyday ${event.browser} - new tabs open in the background, your own tabs stay read-only to the AI.`
        : `   Using the Aivin browser window${event.browser ? ` (${event.browser})` : ''}.`));
      break;
    case 'blocked':
      console.log(chalk.gray(`   🛡️  Blocked ${event.method} on your ${event.browser} - ${event.reason}`));
      break;
    case 'groups-unavailable':
      console.log(chalk.gray('   (Tab grouping is off for this window - close the Aivin browser window and rerun to turn it on.)'));
      break;
    default:
      break; // 'released' - nothing worth printing for a one-shot command
  }
}

export async function runBrowserMissionLocal(mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();
  const tenantClient = parseApiKeyClient(apiKey || '') || 'unknown';

  const preferredId = options.browser ? String(options.browser).toLowerCase() : undefined;
  if (preferredId && !LOCAL_BROWSER_IDS.includes(preferredId)) {
    throw new Error(`--browser must be one of ${LOCAL_BROWSER_IDS.join(', ')}, got "${options.browser}".`);
  }
  if (options.url && isBlockedUrl(options.url)) {
    throw new Error(`--url must be a web page - ${String(options.url).split(':')[0]}: URLs can't be opened by AI Browser.`);
  }

  // --debug-port pins an exact port (strict - errors if it's taken by something else). Without it,
  // try the conventional 9222 first, then a few neighbors - confirmed needed for real: this
  // project's OWN local dev stack publishes an unrelated container on 9222 (see
  // probeLocalChromeDebugger's comment). Only used when the Aivin window has to be launched - an
  // already-running one is found through its profile folder, whatever port it's on.
  const explicitPort = options.debugPort !== undefined;
  const ports = explicitPort ? [Number(options.debugPort)] : DEBUG_PORTS;
  if (explicitPort && !(Number.isInteger(ports[0]) && ports[0] > 0 && ports[0] < 65536)) {
    throw new Error(`--debug-port must be a port number, got "${options.debugPort}".`);
  }

  const browser = findLocalBrowser(preferredId);
  if (!browser) {
    printChromeLaunchHelp(ports[0], preferredId);
    throw new Error('No Chrome, Edge, Brave or Chromium install found on this computer.');
  }

  // Only ever the window running on the dedicated Aivin profile - never "whatever Chromium answers on
  // the port" (see the header comment). The user's everyday browser is reached separately, only after
  // they've switched on remote debugging in it themselves (dailyBrowser.mjs, consent-gated).
  let launchAllowed = true;
  const ensureBrowser = async () => {
    let found;
    try {
      found = await ensureAivinBrowser(preferredId || browser.id, { ports, launch: launchAllowed, log: (m) => console.log(chalk.gray(m)) });
    } catch (error) {
      if (launchAllowed) printChromeLaunchHelp(ports[0], preferredId);
      error.browserSetup = true;
      throw error;
    }
    // Brave/Chromium report themselves as Chrome over CDP - only Edge vs. the rest is tellable here.
    const family = (id) => (id === 'edge' ? 'edge' : 'chromium');
    if (preferredId && found.browserId && family(found.browserId) !== family(preferredId)) {
      const error = new Error(
        `--browser ${preferredId} was requested, but the Aivin browser window that's already open is ${found.browserId}. ` +
        'Close that window and rerun, or drop --browser.',
      );
      error.browserSetup = true;
      throw error;
    }
    return found;
  };

  const tunnels = createBrowserTunnels({
    serverUrl,
    authorization: `Bearer ${apiKey || ''}`,
    browser: { id: browser.id, name: browser.name },
    useDailyBrowser: options.separateBrowser !== true,
    ensureBrowser,
    say: sayTunnelEvent,
  });

  try {
    const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
    const agentId = options.agent || (await resolveOrCreateBrowserAgent(serverUrl, authHeaders, workspace));

    console.log(chalk.blue('🌐 AI Browser (local - your own browser):'), mission);
    console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));

    // Retry the local tunnel on an UNEXPECTED drop (flaky WiFi) - checkpoint-resume already exists
    // server-side (AIBrowserCheckpointService, matches on tenant + exact mission text), so re-firing
    // the SAME mission through a fresh tunnel just continues where it left off instead of restarting.
    // Only worth doing when we're actually watching (options.watch !== false) - without the log
    // stream there's no reliable signal for "did the mission already finish" vs "tunnel just dropped",
    // so a single un-retried attempt is what happens when watch is disabled.
    const MAX_TUNNEL_RETRIES = 3;
    let interrupted = false;
    let terminalReason; // 'success' | 'failed' | undefined (still unresolved / gave up watching)
    let attempt = 0;

    while (!interrupted) {
      attempt++;
      if (attempt > 1) {
        // A closed window mid-mission is the user's call - reconnect to it if it's still there, but
        // never pop a fresh one open on a retry.
        launchAllowed = false;
        console.log(chalk.yellow(`\n🔄 The browser tunnel dropped unexpectedly - retrying (${attempt - 1}/${MAX_TUNNEL_RETRIES})...`));
      }

      const tunnelId = randomUUID();
      let unexpectedDrop = false;
      try {
        await tunnels.open({ tunnel_id: tunnelId, label: mission }, { onClose: ({ deliberate }) => { if (!deliberate) unexpectedDrop = true; } });
      } catch (error) {
        if (error.browserSetup && attempt > 1) {
          console.log(chalk.red(
            '\n❌ Lost the connection and the browser is gone - it may have been closed. Stopping here (the mission may still be running on the server - ' +
            'check with `aivin browser --view`, or rerun this command).',
          ));
          break;
        }
        if (error.browserSetup || attempt > MAX_TUNNEL_RETRIES) throw new Error(`Could not open the local browser tunnel: ${error.message}`, { cause: error });
        console.log(chalk.yellow(`\n⚠️  Couldn't open the browser tunnel (${error.message}) - retrying (${attempt}/${MAX_TUNNEL_RETRIES})...`));
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
        requestBrowserCancel(serverUrl, authHeaders, { sessionId }).catch((e) =>
          console.log(chalk.red(`   ⚠️  Cancellation request failed to send (${e.message}) - the mission may keep running.`)),
        );
        tunnels.close(tunnelId);
        console.log(chalk.gray('   The tab this mission was using is still open in your browser - close it yourself if you don\'t need it.'));
      };
      process.on('SIGINT', onSigint);

      // Fired concurrently, not sequentially - the log watcher has to already be listening before/as
      // the mission starts, not after.
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
          data: { __local_tunnel_id: tunnelId, start_url: options.url || guessStartUrl(mission) },
        },
        authHeaders,
      );
      const watchPromise = options.watch !== false
        ? watchBrowserMission(serverUrl, apiKey, sessionId, tenantClient, { openViewerOnHIL: false, sessionId })
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
        tunnels.close(tunnelId);
      }

      if (interrupted) break;
      if (terminalReason === 'success' || terminalReason === 'failed') break; // genuine mission outcome - done
      // options.watch === false (no signal at all) or watch gave up on its own (idle/connect_error,
      // NOT a tunnel drop) - neither is worth blindly retrying; only retry on a confirmed tunnel drop.
      if (!unexpectedDrop) break;
      if (attempt > MAX_TUNNEL_RETRIES) {
        console.log(chalk.red(`\n❌ Retried ${MAX_TUNNEL_RETRIES} times but the tunnel keeps dropping - stopped watching. The mission may still be running on the server.`));
        break;
      }
    }

    if (!interrupted && (terminalReason === 'success' || terminalReason === 'failed')) {
      console.log(chalk.gray('\n   Done - see the log lines above for the outcome, and your own browser for the result.'));
    }
  } finally {
    // Also drops the shared daily-browser connection and the tab-grouping one - both would otherwise
    // keep the process alive after the mission is over.
    tunnels.closeAll();
  }
}

/** REST twin of `sdk.browser.cancel()` - the CLI has no gRPC client, only axios. See
 *  AIBrowserController.cancel's comment for the exact semantics (cooperative, own-tenant-only). */
export async function requestBrowserCancel(serverUrl, authHeaders, { sessionId, threadId } = {}) {
  await axios.post(
    `${serverUrl}/plugins/ai-browser/cancel`,
    {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
    },
    authHeaders,
  );
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
    requestBrowserCancel(serverUrl, authHeaders, { threadId }).catch((e) =>
      console.log(chalk.red(`   ⚠️  Cancellation request failed to send (${e.message}) - the mission may keep running.`)),
    );
  };
  process.on('SIGINT', onSigint);

  try {
    if (options.watch !== false && threadId) {
      await watchBrowserMission(serverUrl, apiKey, threadId, tenantClient, { threadId });
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}
