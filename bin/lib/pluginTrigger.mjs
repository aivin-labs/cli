import { io } from 'socket.io-client';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { flattenManifestFile } from '@aivin-labs/sdk';
import readline from 'readline';
import { requireArg } from './util.mjs';

/**
 * Resolves which manifest entry `plugin trigger` should invoke: the `--func` match if given, the
 * one-and-only entry for a single-function/single-entry plugin, or a clear error listing the
 * choices for a multi-function plugin with no `--func` given.
 */
export function resolveTriggerEntry(manifest, funcOption) {
  const entries = Array.isArray(manifest) ? manifest : [manifest];
  if (funcOption) {
    const entry = entries.find((m) => m.func === funcOption || m.name === funcOption || m.id === funcOption);
    if (!entry) {
      const known = entries.map((m) => `${m.name}${m.func ? ` [${m.func}]` : ''}`).join(', ');
      throw new Error(`No entry matches "${funcOption}". Known: ${known}`);
    }
    return entry;
  }
  if (entries.length === 1) return entries[0];
  const known = entries.map((m) => `${m.name} [${m.func}]`).join(', ');
  throw new Error(`This is a multi-function plugin - pass --func <name> to pick one. Known: ${known}`);
}

/**
 * Subscribes to a deployed plugin's live console output over the same Socket.IO channel
 * `aivin plugin logs` uses (`subscribe-plugin-logs` / `plugin-log`), but returns as soon as
 * subscribing settles (success OR denial) instead of running until Ctrl+C - meant to be opened
 * right before a single `trigger` call and stopped right after, not to own the process lifetime.
 *
 * Subscribing is permission-scoped server-side to plugins you can see the container logs for
 * (your own/org's deployments) - triggering a plugin from the public store that some other org
 * owns will very likely have this come back `subscribed: false`. That's expected, not an error:
 * the caller falls back to the REST result only, same as before `--watch-logs` existed.
 */
export async function watchPluginLogLines(pluginId, { serverUrl, apiKey, onLine }) {
  // Explicit connect timeout (not just socket.io-client's own ~20s default) so `trigger
  // --watch-logs` fails fast into "no live output" instead of leaving the whole command feeling
  // stuck for a while first.
  const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true, timeout: 8000 });
  let subscribed = false;
  let denyReason;

  await new Promise((resolve) => {
    const giveUp = setTimeout(() => {
      denyReason = 'timed out connecting';
      resolve();
    }, 8000);
    socket.on('connect_error', (error) => {
      clearTimeout(giveUp);
      denyReason = error.message;
      resolve();
    });
    socket.on('connect', () => {
      socket.emit('subscribe-plugin-logs', { plugin_id: pluginId }, (ack) => {
        clearTimeout(giveUp);
        if (ack?.success) subscribed = true;
        else denyReason = ack?.error || 'no permission to view this plugin\'s logs';
        resolve();
      });
    });
  });

  if (subscribed) socket.on('plugin-log', onLine);
  return { subscribed, denyReason, stop: () => socket.disconnect() };
}

/**
 * `aivin plugin trigger` - invokes an already-deployed plugin for real via the same
 * `POST /plugins/execute` the platform's own Playground uses (PluginExecutionService.executePlugin
 * on the backend), and prints the result. Two modes:
 * - Direct: `<mission>` + `<input>` (a JSON string) sent as `purpose`/`arguments` as-is.
 * - Auto (`-a/--auto <prompt>`): sends the prompt as `raw_text` instead - the backend's own
 *   `mapDataToSchema` maps it onto `manifest.input` for you (same mechanism the Playground's "Thử
 *   nghiệm" tab uses), same as pasting a free-text request into the platform's chat-style tester.
 *   `<input>` can still be given alongside `-a` for fields you want to force rather than let the AI
 *   infer - explicit `arguments` win over auto-mapped ones per field.
 *
 * By default this only surfaces what `/plugins/execute`'s response itself carries: `processing_log`
 * (the mapping/execution stage messages, all at once, not the plugin's own internal console output)
 * and `mapped_arguments` (only present when `-a` was used). Pass `--watch-logs` to also stream the
 * plugin's own console.log/console.error output inline (subscribes right before the call, same feed
 * `aivin plugin logs` tails) instead of needing a second terminal - see `watchPluginLogLines` for
 * why this silently does nothing for a plugin you don't have log-view permission on.
 *
 * `--id <pluginId>` skips the local manifest.json lookup - required for plugins with no scaffolded
 * project directory, e.g. proxy plugins built by `aivin mcp <url>`, which deploy straight from an
 * in-memory scan and never write a manifest.json anywhere.
 *
 * `--save` writes this run's result to `.test/trigger/<timestamp>.json`; `--compare <file>` diffs
 * the current run against a previously saved one - a lightweight way to turn ad-hoc "thử nghiệm"
 * calls (your own plugin mid-development, or someone else's from the store) into a regression check,
 * without needing the full `aivin test` deploy+smoke-test flow.
 */
export async function triggerPlugin(mission, inputJson, options) {
  // Read + validate --compare's file upfront, before spending a real (possibly side-effecting,
  // possibly billable) invocation on a typo'd path.
  let compareAgainst;
  if (options.compare) {
    const comparePath = path.resolve(process.cwd(), options.compare);
    if (!fs.existsSync(comparePath)) {
      throw new Error(`--compare file not found: ${comparePath}`);
    }
    try {
      compareAgainst = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    } catch (error) {
      throw new Error(`--compare file isn't valid JSON (${comparePath}): ${error.message}`, { cause: error });
    }
  }

  // `--id` bypasses the manifest.json lookup entirely - needed for plugins that were never
  // scaffolded into a local directory (e.g. `aivin mcp <url>` deploys straight from a scan, no
  // src/manifest.json on disk to resolve `entry` from). Without this, testing a freshly-converted
  // MCP plugin from the Playground-equivalent flow was impossible outside the web app.
  let entryId = options.id;
  let entryLabel = options.id;
  if (!entryId) {
    const currentDir = process.cwd();
    const manifestPath = path.join(currentDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('manifest.json not found. Run this from your plugin\'s directory, or pass --id <pluginId>.');
    }
    const manifest = flattenManifestFile(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const entry = resolveTriggerEntry(manifest, options.func);
    entryId = entry.id;
    entryLabel = `${entry.name}${entry.func ? ` [${entry.func}]` : ''}`;
  }

  const body = { plugin_id: entryId };
  if (options.auto) {
    body.raw_text = options.auto;
    body.purpose = mission || options.auto;
    if (inputJson) {
      try {
        body.arguments = JSON.parse(inputJson);
      } catch (error) {
        throw new Error(`Invalid JSON for <input>: ${error.message}`, { cause: error });
      }
    }
  } else {
    if (!mission || !inputJson) {
      const usage = 'Usage: aivin plugin trigger "<mission>" \'<input JSON>\'  (or: aivin plugin trigger -a "<prompt>")';
      mission = await requireArg(mission, { prompt: 'Mission (why this run was triggered):', usage });
      inputJson = await requireArg(inputJson, { prompt: 'Input (as a JSON string, e.g. {"text":"hello"}):', usage });
    }
    body.purpose = mission;
    try {
      body.arguments = JSON.parse(inputJson);
    } catch (error) {
      throw new Error(`Invalid JSON for <input>: ${error.message}`, { cause: error });
    }
  }
  if (options.agent) body.agent_id = options.agent;

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };
  // No client-side timeout here before meant a hung backend (or a genuinely stuck plugin - the
  // server side already caps at MAX_DOCKER_TIMEOUT_MS/effectiveTimeout, but that's enforced on the
  // backend, not by this CLI process) could leave `trigger` sitting forever with no feedback short
  // of Ctrl+C. `AIVIN_TRIGGER_TIMEOUT_MS` overrides if 3 minutes isn't enough for a legitimately
  // slow plugin.
  const EXECUTE_TIMEOUT_MS = parseInt(process.env.AIVIN_TRIGGER_TIMEOUT_MS || '180000');
  const WORKSPACE_LOOKUP_TIMEOUT_MS = 15000;

  let workspaceId = options.workspace;
  if (!workspaceId) {
    try {
      const wsRes = await axios.get(`${serverUrl}/workspace/list`, { ...authHeaders, timeout: WORKSPACE_LOOKUP_TIMEOUT_MS });
      const workspaces = Array.isArray(wsRes.data) ? wsRes.data : wsRes.data?.items || [];
      workspaceId = workspaces[0]?.id || workspaces[0]?._id;
    } catch (error) {
      throw new Error(`Couldn't look up a workspace to run against (${error.message}). Pass --workspace <id>.`, { cause: error });
    }
  }
  if (!workspaceId) {
    throw new Error('No workspace found for this account. Pass --workspace <id>.');
  }
  body.workspace_id = workspaceId;

  let logWatcher;
  if (options.watchLogs) {
    logWatcher = await watchPluginLogLines(entryId, {
      serverUrl,
      apiKey,
      onLine: (payload) => {
        const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
        const streamColor = payload.stream === 'stderr' ? chalk.red : payload.stream === 'system' ? chalk.yellow : chalk.gray;
        console.log(chalk.gray(`[${time}]`), streamColor(payload.line));
      },
    });
    if (logWatcher.subscribed) {
      console.log(chalk.blue(`📡 Watching live console output for ${entryLabel || entryId}...`));
    } else {
      console.log(chalk.gray(`(--watch-logs: no live console output - ${logWatcher.denyReason})`));
    }
  }

  console.log(chalk.blue(`🚀 Triggering ${entryLabel || entryId}...`));

  let response;
  try {
    response = await axios.post(`${serverUrl}/plugins/execute`, body, { ...authHeaders, timeout: EXECUTE_TIMEOUT_MS });
  } catch (error) {
    if (logWatcher?.subscribed) {
      // Give trailing log lines from this failed call a moment to arrive before disconnecting.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    logWatcher?.stop();
    const message = error.response?.data?.message || error.message;
    throw new Error(`Trigger failed: ${message}`, { cause: error });
  }

  if (logWatcher?.subscribed) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  logWatcher?.stop();

  const result = response.data ?? {};

  if (Array.isArray(result.processing_log) && result.processing_log.length) {
    console.log(chalk.gray('\n--- Log ---'));
    for (const line of result.processing_log) {
      const icon = line.status === 'error' ? chalk.red('✗') : chalk.gray('·');
      console.log(`${icon} ${line.message}`);
    }
  }

  if (result.mapped_arguments) {
    console.log(chalk.gray('\n--- Auto-mapped input ---'));
    console.log(JSON.stringify(result.mapped_arguments, null, 2));
  }

  const status = String(result.status || '').toLowerCase();
  const ok = ['success', 'waiting', 'needs_auth', 'hil_timeout'].includes(status) || result.status === undefined;
  const resultLabel = `--- Result: ${result.status || 'unknown'} ---`;
  console.log(ok ? chalk.green(`\n${resultLabel}`) : chalk.red(`\n${resultLabel}`));
  if (result.message) console.log(chalk.gray(`Message: ${result.message}`));
  if (result.error_code) console.log(chalk.gray(`Error code: ${result.error_code}`));
  console.log(JSON.stringify(result.data ?? null, null, 2));

  if (compareAgainst) {
    printTriggerDiff(compareAgainst.result ?? {}, result);
  }

  if (options.save) {
    const currentDir = process.cwd();
    const dir = path.join(currentDir, '.test', 'trigger');
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const savePath = path.join(dir, `${timestamp}.json`);
    fs.writeFileSync(
      savePath,
      JSON.stringify({ plugin_id: entryId, mission: body.purpose, arguments: body.arguments, result }, null, 2),
    );
    console.log(chalk.gray(`\nSaved: ${path.relative(currentDir, savePath)} (--compare ${path.relative(currentDir, savePath)} next time)`));
  }

  if (!ok) process.exitCode = 1;
}

/**
 * Prints a before/after summary for `trigger --compare <file>` - status changes are the headline
 * (a plugin that used to succeed now failing, or vice versa, is the actual regression signal most
 * of the time), full data payloads only get dumped when they actually differ so an unchanged
 * comparison stays a two-line "nothing moved" instead of two walls of identical JSON.
 */
export function printTriggerDiff(oldResult, newResult) {
  console.log(chalk.gray('\n--- Compare ---'));

  const oldStatus = oldResult.status ?? 'unknown';
  const newStatus = newResult.status ?? 'unknown';
  if (oldStatus === newStatus) {
    console.log(chalk.gray(`Status: ${newStatus} (unchanged)`));
  } else {
    console.log(chalk.yellow(`Status: ${oldStatus} → ${newStatus} (CHANGED)`));
  }

  const oldData = JSON.stringify(oldResult.data ?? null, null, 2);
  const newData = JSON.stringify(newResult.data ?? null, null, 2);
  if (oldData === newData) {
    console.log(chalk.gray('Data: unchanged'));
  } else {
    console.log(chalk.yellow('Data: CHANGED'));
    console.log(chalk.gray('  --- before ---'));
    console.log(oldData.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log(chalk.gray('  --- after ---'));
    console.log(newData.split('\n').map((l) => `  ${l}`).join('\n'));
  }
}

/**
 * `aivin plugin logs [pluginId]` - tails a deployed plugin's own container stdout/stderr live, over
 * the same Socket.IO channel the platform's own Playground log panel uses (subscribe-plugin-logs /
 * plugin-log, see src/base/SocketIO.ts on the backend). `pluginId` defaults to the current
 * directory's manifest.json id (like `plugin trigger`'s `--func` resolution), so `aivin plugin logs`
 * with no args works from inside a plugin's own project directory.
 */
export async function streamPluginLogs(pluginId, options) {
  let resolvedId = pluginId;
  if (!resolvedId) {
    const manifestPath = path.join(process.cwd(), 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('No pluginId given and manifest.json not found. Pass a pluginId or run from your plugin\'s directory.');
    }
    const manifest = flattenManifestFile(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    resolvedId = resolveTriggerEntry(manifest, options.func).id;
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  console.log(chalk.blue(`📡 Watching live logs for ${resolvedId}... (Ctrl+C to stop)\n`));

  const socket = io(serverUrl, {
    auth: { token: apiKey || 'dev-token' },
    transports: ['websocket'],
    reconnection: true,
  });

  const streamColor = (stream) => (stream === 'stderr' ? chalk.red : stream === 'system' ? chalk.yellow : chalk.gray);

  await new Promise((resolve) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      process.off('SIGINT', stop);
      resolve();
    };
    process.on('SIGINT', stop);

    socket.on('connect', () => {
      socket.emit('subscribe-plugin-logs', { plugin_id: resolvedId }, (ack) => {
        if (!ack?.success) {
          console.error(chalk.red('❌'), `Couldn't subscribe: ${ack?.error || 'unknown error'}`);
          stop();
        }
      });
    });
    socket.on('plugin-log', (payload) => {
      const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
      console.log(chalk.gray(`[${time}]`), streamColor(payload.stream)(payload.line));
    });
    socket.on('connect_error', (error) => {
      console.error(chalk.red('❌'), `Connection failed: ${error.message}`);
      stop();
    });
  });
}

export async function searchPlugins(query, options) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  const params = {};
  if (query) params.query = query;
  if (options.workspace) params.workspace_id = options.workspace;
  if (options.mcp) params.mcp_server_id = options.mcp;
  if (options.limit) params.limit = options.limit;

  let response;
  try {
    response = await axios.get(`${serverUrl}/plugins/search`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Search failed: ${message}`, { cause: error });
  }

  // `?limit`/`?page` given -> { items, total, ... } (paged); otherwise a bare array (the same
  // relevance-ranked lookup the platform's own agent uses to auto-select a plugin for a mission).
  const data = response.data;
  const results = Array.isArray(data) ? data : data?.items || [];
  // --mcp is an exact-id lookup (no free-text query) - describe results by server id instead.
  const describedAs = options.mcp ? `MCP server "${options.mcp}"` : `"${query}"`;

  if (results.length === 0) {
    console.log(chalk.yellow(`No plugins found matching ${describedAs}.`));
    return;
  }

  // Interactive browser needs a real terminal to read raw keypresses - fall back to a flat
  // print for scripts/CI or when the user explicitly asks for it with --plain.
  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(results, `Found ${results.length} plugin(s) matching ${describedAs}:\n`, formatPluginListLine, formatPluginDetail);
    return;
  }

  console.log(chalk.blue(`Found ${results.length} plugin(s) matching ${describedAs}:\n`));
  for (const plugin of results) {
    console.log(chalk.bold(plugin.name || plugin.id) + chalk.gray(`  (${plugin.id})`));
    if (plugin.description) console.log(`  ${plugin.description}`);
    if (plugin.version) console.log(chalk.gray(`  v${plugin.version}`));
    console.log();
  }
  console.log(
    chalk.gray(
      `Call one from your own plugin with: import { call } from '@aivin-labs/sdk'; await call('<plugin_id>', params).`,
    ),
  );
}

export function formatPluginListLine(plugin, isSelected) {
  const marker = isSelected ? chalk.cyan('❯ ') : '  ';
  const label = plugin.name || plugin.id;
  const name = isSelected ? chalk.bold.cyan(label) : label;
  const badge = plugin.is_official ? chalk.green(' ✓') : '';
  return `${marker}${name}${badge}${chalk.gray(`  (${plugin.id})`)}`;
}

export function trustBadge(plugin) {
  if (plugin.is_official) return chalk.green('✓ official');
  if (plugin.verification_status === 'VERIFIED' || plugin.is_verified) return chalk.cyan('✓ verified');
  return chalk.yellow('community (unverified)');
}

export function formatPluginDetail(plugin) {
  const lines = [];
  lines.push(chalk.bold.cyan(plugin.name || plugin.id) + '  ' + trustBadge(plugin));
  lines.push(chalk.gray(plugin.id));
  if (plugin.version) lines.push(`${chalk.gray('version')}      v${plugin.version}`);
  if (plugin.author) lines.push(`${chalk.gray('author')}       ${plugin.author}`);
  if (plugin.type) lines.push(`${chalk.gray('type')}         ${plugin.type}`);
  if (typeof plugin.rating === 'number') lines.push(`${chalk.gray('rating')}       ${plugin.rating.toFixed(1)}/5`);
  if (typeof plugin._similarity === 'number') {
    lines.push(`${chalk.gray('match')}        ${(plugin._similarity * 100).toFixed(0)}%`);
  }
  if (Array.isArray(plugin.capabilities) && plugin.capabilities.length > 0) {
    lines.push(`${chalk.gray('capabilities')} ${plugin.capabilities.join(', ')}`);
  }
  // `initable`: input fields the AI can't fill on its own (API key, token, secret, base_url...)
  // - the user has to configure them once before this plugin can run.
  if (Array.isArray(plugin.initable) && plugin.initable.length > 0) {
    lines.push(chalk.yellow(`⚠ needs setup first: ${plugin.initable.join(', ')}`));
  }
  // `connection_id`: this plugin is bound to a workspace connector (OAuth-based) - the user has
  // to log in to that connector before the plugin can run, separate from `initable`'s plain
  // credential fields.
  if (plugin.connection_id) {
    lines.push(chalk.yellow(`⚠ requires logging in to a connector (${plugin.connection_id}) first`));
  }
  if (plugin.description) lines.push(`\n${plugin.description}`);
  if (plugin.input) lines.push(`\n${chalk.gray('input schema')}\n${JSON.stringify(plugin.input, null, 2)}`);
  if (plugin.output) lines.push(`\n${chalk.gray('output schema')}\n${JSON.stringify(plugin.output, null, 2)}`);
  lines.push(
    chalk.gray(
      `\nCall it with: import { call } from '@aivin-labs/sdk'; await call('${plugin.id}', params).`,
    ),
  );
  return lines.join('\n');
}

// Simple raw-keypress list/detail browser: ↑/↓ to move, space/enter to open an item's detail
// view, esc/backspace to go back to the listing, q/ctrl+c to exit. No extra deps - built on
// node's own readline keypress events since inquirer's prompts don't support this drill-down.
// Generic over what's being browsed (plugins, connectors, ...) via the format callbacks.
export function browseResults(results, headerText, formatLine, formatDetail) {
  return new Promise((resolve) => {
    let index = 0;
    let mode = 'list'; // 'list' | 'detail'

    const render = () => {
      // console.clear() no-ops on some Windows TTY hosts (older PowerShell console, plain
      // cmd.exe) - writing the cursor-reset + clear-down sequence directly is what TUI libs
      // like blessed/ink do and works consistently across terminals.
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      if (mode === 'list') {
        console.log(chalk.blue(headerText));
        for (let i = 0; i < results.length; i++) {
          console.log(formatLine(results[i], i === index));
        }
        console.log(chalk.gray('\n↑/↓ move   space/enter view details   q quit'));
      } else {
        console.log(formatDetail(results[index]));
        console.log(chalk.gray('\nesc/backspace back   q quit'));
      }
    };

    const onKeypress = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }
      if (mode === 'list') {
        if (key.name === 'up') {
          index = (index - 1 + results.length) % results.length;
          render();
        } else if (key.name === 'down') {
          index = (index + 1) % results.length;
          render();
        } else if (key.name === 'return' || key.name === 'space' || str === ' ') {
          mode = 'detail';
          render();
        } else if (key.name === 'q' || key.name === 'escape') {
          cleanup();
          resolve();
        }
      } else {
        if (key.name === 'escape' || key.name === 'backspace') {
          mode = 'list';
          render();
        } else if (key.name === 'q') {
          cleanup();
          resolve();
        }
      }
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKeypress);
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKeypress);
    process.stdin.resume();
    render();
  });
}
