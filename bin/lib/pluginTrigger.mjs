import { io } from 'socket.io-client';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import inquirer from 'inquirer';
import { randomUUID } from 'crypto';
import { flattenManifestFile } from '@aivin-labs/sdk';
import readline from 'readline';
import { requireArg, withProgressSpinner } from './util.mjs';
import { resolveWorkspace } from './workspace.mjs';
import { resolveConnectorAuth } from './pluginAuthResolve.mjs';

const DELETE_TIMEOUT_MS = 30000;

/**
 * Parses one manifest `input` field's declared shape, e.g. `"object - Input data for processing"`
 * or `"number - How many items"`, into `{ type, description }` - `type` drives which inquirer
 * prompt kind `promptInputFields` uses below. Unrecognized/missing type text falls back to a plain
 * string prompt, since that's a safe default for anything free-text.
 */
function parseFieldSpec(spec) {
  if (typeof spec !== 'string') return { type: 'string', description: '' };
  const match = spec.match(/^\s*(\w+)\s*-?\s*(.*)$/);
  if (!match) return { type: 'string', description: spec };
  const type = match[1].toLowerCase();
  return { type: ['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(type) ? type : 'string', description: match[2] || '' };
}

/**
 * Interactive replacement for the old "-a/--auto <prompt>, let the backend's mapDataToSchema guess
 * your input" flow: walks a plugin's manifest `input` schema (`{ fieldName: "type - description" }`)
 * field by field and asks the user directly, instead of asking for one raw JSON blob or an
 * AI-guessed mapping. A blank answer omits that field from the result entirely so optional fields
 * stay optional. Falls back to a single generic `data` field when no schema is available at all
 * (e.g. `--id` given for a plugin whose schema lookup came back empty).
 */
async function promptInputFields(schema) {
  const fields = schema && typeof schema === 'object' ? Object.entries(schema) : [];
  if (fields.length === 0) {
    const { data } = await inquirer.prompt([
      { type: 'input', name: 'data', message: 'Input data (as a JSON string, e.g. {"text":"hello"}), or leave blank for none:' },
    ]);
    if (!data) return {};
    try {
      return JSON.parse(data);
    } catch (error) {
      throw new Error(`Invalid JSON for input: ${error.message}`, { cause: error });
    }
  }

  const result = {};
  for (const [fieldName, spec] of fields) {
    const { type, description } = parseFieldSpec(spec);
    const label = description ? `${fieldName} (${type}) - ${description}:` : `${fieldName} (${type}):`;

    if (type === 'boolean') {
      const { value } = await inquirer.prompt([{ type: 'confirm', name: 'value', message: label, default: false }]);
      result[fieldName] = value;
      continue;
    }

    const { value } = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message: label,
        validate: (input) => {
          if (!input) return true; // blank = skip this field
          if ((type === 'number' || type === 'integer') && Number.isNaN(Number(input))) return 'Enter a number';
          if ((type === 'object' || type === 'array') && !tryParseJson(input)) return 'Enter valid JSON';
          return true;
        },
      },
    ]);
    if (!value) continue; // blank = optional field, leave it out
    if (type === 'number' || type === 'integer') result[fieldName] = Number(value);
    else if (type === 'object' || type === 'array') result[fieldName] = JSON.parse(value);
    else result[fieldName] = value;
  }
  return result;
}

function tryParseJson(input) {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

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
    // ✅ FIX: no 'error' listener anywhere for this socket - a server-side socket.io error (not the
    // connection-level 'connect_error') would crash the whole CLI process instead of just falling
    // back to "no live output" like connect_error does.
    socket.on('error', (error) => {
      clearTimeout(giveUp);
      denyReason = error?.message || String(error);
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
 * Realtime stage/percent progress for a single `trigger` call — mirrors `withScanLog`/
 * `scanAndPublishMcp` (`mcpProxy.mjs`, used for `aivin mcp <url>`'s scan step): join the Socket.IO
 * room BEFORE the caller sends its POST (so no early progress events are missed), then track the
 * latest `plugin-execute-progress` payload for a spinner to poll. Useful for the same reason as
 * `--watch-logs` — a cold-start Docker install can take 60-150s+ with zero feedback otherwise —
 * but this is on by default (no flag needed) since it's cheap and doesn't require log-view
 * permission the way `--watch-logs` does.
 */
async function withExecuteProgress(executeSessionId, { serverUrl, apiKey }) {
  const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true, timeout: 8000 });
  const room = `plugin-execute:${executeSessionId}`;
  let current = { stage: 'starting', percent: 0, message: 'Đang gửi yêu cầu...' };
  await new Promise((resolve) => {
    const giveUp = setTimeout(resolve, 8000);
    socket.on('connect_error', () => { clearTimeout(giveUp); resolve(); });
    // ✅ FIX: same missing 'error' handler class of bug as watchPluginLogLines above - without it a
    // server-side socket.io error crashes the CLI instead of just skipping the live progress bar.
    socket.on('error', () => { clearTimeout(giveUp); resolve(); });
    socket.on('connect', () => {
      socket.emit('join-room', { name: 'plugin-execute', rooms: [room] }, () => { clearTimeout(giveUp); resolve(); });
    });
  });
  socket.on('plugin-execute-progress', (payload) => { current = payload; });
  return { getCurrent: () => current, stop: () => socket.disconnect() };
}

/**
 * `aivin plugin trigger` - invokes an already-deployed plugin for real via the same
 * `POST /plugins/execute` the platform's own Playground uses (PluginExecutionService.executePlugin
 * on the backend), and prints the result. `<mission>` + `<input>` (a JSON string) are sent as
 * `purpose`/`arguments` as-is; if either is missing, this prompts for it interactively - mission as
 * free text, input field-by-field from the plugin's manifest `input` schema (see
 * `promptInputFields`). No more auto-mapping (`-a/--auto`, backend's `mapDataToSchema`) - the user
 * fills in every field themselves instead of the AI guessing at a free-text prompt.
 *
 * By default this only surfaces what `/plugins/execute`'s response itself carries: `processing_log`
 * (the mapping/execution stage messages, all at once, not the plugin's own internal console output).
 * Pass `--watch-logs` to also stream the plugin's own console.log/console.error output inline
 * (subscribes right before the call, same feed `aivin plugin logs` tails) instead of needing a
 * second terminal - see `watchPluginLogLines` for why this silently does nothing for a plugin you
 * don't have log-view permission on.
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
  let inputSchema;
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
    inputSchema = entry.input;
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  const body = { plugin_id: entryId };
  mission = await requireArg(mission, { prompt: 'Mission (why this run was triggered):', usage: 'Usage: aivin plugin trigger "<mission>" \'<input JSON>\'' });
  body.purpose = mission;

  if (inputJson) {
    try {
      body.arguments = JSON.parse(inputJson);
    } catch (error) {
      throw new Error(`Invalid JSON for <input>: ${error.message}`, { cause: error });
    }
  } else {
    // No auto-mapping anymore - ask the user for each input field directly instead of guessing
    // (or asking for one raw JSON blob) on their behalf.
    if (!inputSchema && options.id) {
      try {
        const res = await axios.get(`${serverUrl}/plugins/search`, { ...authHeaders, params: { query: options.id, limit: 10 } });
        const results = Array.isArray(res.data) ? res.data : res.data?.items || [];
        inputSchema = results.find((p) => p.id === options.id)?.input;
      } catch {
        // Best-effort only - falls back to the generic single-field prompt below.
      }
    }
    console.log(chalk.gray(`\nInput for ${entryLabel || entryId}:`));
    body.arguments = await promptInputFields(inputSchema);
  }

  if (options.agent) body.agent_id = options.agent;
  // No client-side timeout here before meant a hung backend (or a genuinely stuck plugin - the
  // server side already caps at MAX_DOCKER_TIMEOUT_MS/effectiveTimeout, but that's enforced on the
  // backend, not by this CLI process) could leave `trigger` sitting forever with no feedback short
  // of Ctrl+C. `AIVIN_TRIGGER_TIMEOUT_MS` overrides if 3 minutes isn't enough for a legitimately
  // slow plugin.
  const EXECUTE_TIMEOUT_MS = parseInt(process.env.AIVIN_TRIGGER_TIMEOUT_MS || '180000');

  // ✅ FIX: this used to only look up/validate a workspace when `--workspace` was OMITTED, and
  // trusted an explicitly-passed `--workspace <id>` as-is with no existence check - every other
  // command taking `--workspace` (aivin do/browser/agent .../task ...) routes through
  // resolveWorkspace(), which validates it and throws a clear "not found or not accessible" error.
  // A typo'd/wrong id here instead sailed straight through to the backend and came back as
  // whatever generic error `/plugins/execute` happens to give for an invalid workspace_id.
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const workspaceId = workspace.id || workspace._id;
  body.workspace_id = workspaceId;

  // A run can come back needing a connector that isn't set up yet (`status: 'needs_auth'`) - rather
  // than just printing that and leaving the user to go set it up and re-run the whole command by
  // hand, offer to resolve it right here (OAuth: open a browser and wait; form: prompt for the
  // fields) and automatically retry the exact same call once. Only in an interactive terminal - a
  // script/CI run with no TTY just gets the needs_auth result printed, same as before this existed.
  // `logWatcher` is re-subscribed each attempt (not hoisted outside the loop) so `--watch-logs`
  // still streams live output on the post-auth retry, not just the first (doomed-to-fail) attempt.
  let result;
  let attempt = 0;
  for (;;) {
    attempt++;

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

    const executeSessionId = randomUUID();
    body.execute_session_id = executeSessionId;
    const progress = await withExecuteProgress(executeSessionId, { serverUrl, apiKey });

    let response;
    try {
      response = await withProgressSpinner(`🚀 Triggering ${entryLabel || entryId}`, progress.getCurrent, () =>
        axios.post(`${serverUrl}/plugins/execute`, body, { ...authHeaders, timeout: EXECUTE_TIMEOUT_MS }),
      );
    } catch (error) {
      if (logWatcher?.subscribed) {
        // Give trailing log lines from this failed call a moment to arrive before disconnecting.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      logWatcher?.stop();
      progress.stop();
      const message = error.response?.data?.message || error.message;
      throw new Error(`Trigger failed: ${message}`, { cause: error });
    }

    if (logWatcher?.subscribed) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    logWatcher?.stop();
    progress.stop();

    result = response.data ?? {};

    // `--no-auth-prompt` -> commander sets options.authPrompt = false (negatable option convention -
    // there is no options.noAuthPrompt). Defaults to true (flag omitted) so this is opt-out, not opt-in.
    const canResolveNow = attempt === 1 && options.authPrompt !== false && process.stdout.isTTY && process.stdin.isTTY;
    if (String(result.status || '').toLowerCase() === 'needs_auth' && canResolveNow) {
      const connected = await resolveConnectorAuth(result.data, { serverUrl, apiKey, workspaceId });
      if (connected) {
        console.log(chalk.gray('\nRetrying...'));
        continue;
      }
    }
    break;
  }

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
    // ✅ FIX: same missing 'error' handler class of bug as above - without it a server-side
    // socket.io error crashes the CLI (`aivin plugin logs`) instead of just ending the tail cleanly.
    socket.on('error', (error) => {
      console.error(chalk.red('❌'), `Log stream error: ${error?.message || error}`);
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
  if (options.store) params.store_id = options.store;
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
  const describedAs = (options.mcp ? `MCP server "${options.mcp}"` : `"${query}"`)
    + (options.store ? ` in store "${options.store}"` : '');

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

/**
 * `aivin plugin info <id>` - detail view for one already-known plugin id, without going through
 * `plugin search`'s free-text ranking first. Useful when debugging a specific plugin (e.g. one
 * seen in `plugin search --mcp <server>`'s listing, or copied from the platform) and you just want
 * its input/output schema and setup requirements again.
 *
 * There's no dedicated GET /plugins/:id on the backend, so this reuses /plugins/search with the id
 * itself as the query and picks the exact `id` match out of the ranked results - the same lookup
 * `plugin search` already does, just narrowed down for you. Falls back to showing the closest
 * matches (with a clear "no exact match" note) if the id typo'd or the plugin isn't visible to you.
 */
export async function showPluginInfo(id, options) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  const params = { query: id, limit: options.limit || 10 };
  if (options.workspace) params.workspace_id = options.workspace;

  let response;
  try {
    response = await axios.get(`${serverUrl}/plugins/search`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Lookup failed: ${message}`, { cause: error });
  }

  const data = response.data;
  const results = Array.isArray(data) ? data : data?.items || [];
  const exact = results.find((p) => p.id === id);

  if (exact) {
    console.log(formatPluginDetail(exact));
    return;
  }

  if (results.length === 0) {
    console.log(chalk.yellow(`No plugin found for id "${id}".`));
    return;
  }

  console.log(chalk.yellow(`No exact match for "${id}" - closest result(s):\n`));
  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(results, `Closest to "${id}":\n`, formatPluginListLine, formatPluginDetail);
    return;
  }
  for (const plugin of results) {
    console.log(chalk.bold(plugin.name || plugin.id) + chalk.gray(`  (${plugin.id})`));
  }
}

/**
 * `aivin plugin ask "<mission>"` - the one-shot "just simulate the agent" mode: given a
 * plain-language mission, it searches the plugin ecosystem the same relevance-ranked way the
 * platform's own agent does to auto-select a plugin, picks the top match, then triggers it -
 * prompting for each input field directly (`plugin trigger` under the hood, no auto-mapping).
 * Where `plugin search` + `plugin trigger --id <id>` is the two-step "pick, then run" flow, `ask`
 * collapses both into one - no manual id copy/paste, but input is still filled in by hand.
 *
 * `--top <n>` (default 5) controls how many candidates are fetched so the runner-up(s) can be
 * printed for context/debugging when the auto-pick looks wrong; only the #1 match is ever run.
 */
export async function askPlugin(mission, options) {
  mission = await requireArg(mission, { prompt: 'What do you want done?', usage: 'Usage: aivin plugin ask "<mission>"' });

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  const params = { query: mission, limit: options.top || 5 };
  if (options.workspace) params.workspace_id = options.workspace;

  let response;
  try {
    response = await axios.get(`${serverUrl}/plugins/search`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Search failed: ${message}`, { cause: error });
  }

  const data = response.data;
  const results = Array.isArray(data) ? data : data?.items || [];
  if (results.length === 0) {
    throw new Error(`No plugin matches "${mission}". Try \`aivin plugin search\` with different wording, or \`aivin plugin make\` to write one.`);
  }

  const chosen = results[0];
  const matchLabel = typeof chosen._similarity === 'number' ? ` (${(chosen._similarity * 100).toFixed(0)}% match)` : '';
  console.log(chalk.blue(`🤖 Auto-selected: ${chalk.bold(chosen.name || chosen.id)}${matchLabel}`) + chalk.gray(`  (${chosen.id})`));
  if (results.length > 1) {
    console.log(chalk.gray(`   runner-up(s): ${results.slice(1).map((p) => p.name || p.id).join(', ')}`));
  }
  console.log();

  await triggerPlugin(mission, options.input, { ...options, id: chosen.id });
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

// Simple raw-keypress list/detail browser: ↑/↓ to move, space/enter/→ to open an item's detail
// view, esc/backspace/← to go back to the listing, q/ctrl+c to exit. No extra deps - built on
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
        console.log(chalk.gray('\n↑/↓ move   →/space/enter view details   q quit'));
      } else {
        console.log(formatDetail(results[index]));
        console.log(chalk.gray('\n←/esc/backspace back   q quit'));
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
        } else if (key.name === 'return' || key.name === 'space' || key.name === 'right' || str === ' ') {
          mode = 'detail';
          render();
        } else if (key.name === 'q' || key.name === 'escape') {
          cleanup();
          resolve();
        }
      } else {
        if (key.name === 'escape' || key.name === 'backspace' || key.name === 'left') {
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

/**
 * `aivin plugin delete <id>` / `aivin plugin delete --group <groupId>` - the CLI-side counterpart
 * that had been missing: everything else in this file (`create`/`trigger`/`deploy`) had no way to
 * undo itself. Two backend endpoints, both ownership-checked server-side (404, not 403, for a
 * plugin/group that isn't yours - avoids leaking which ids exist in other orgs):
 * - `DELETE /plugins/store/:pluginId` - one plugin.
 * - `DELETE /plugins/group/:groupId` - every plugin sharing one `group_id`, i.e. everything a
 *   single batch deploy created in one call - the backend's own controller comment says this
 *   exists specifically "để CLI dùng group_id trả về từ batch deploy để rollback cả lô" (so the
 *   CLI can use the group_id a batch deploy returns to roll back the whole batch), which is
 *   exactly `aivin mcp <url>`'s "N plugin(s) generated from this MCP server" case - it already
 *   prints that group_id after deploy, this is what it's for.
 *
 * Both prompt a confirmation (skippable with `-y`/`--yes` for scripts) since neither can be undone
 * from here - `--group` additionally requires typing the id back, same pattern `pluginstore rm`
 * uses, since it can delete many plugins at once from one typo'd id.
 */
export async function deletePluginCmd(id, options) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  if (options.group) {
    if (!options.yes) {
      const { confirmId } = await inquirer.prompt([
        {
          type: 'input',
          name: 'confirmId',
          message: chalk.red(`This deletes EVERY plugin in group "${options.group}" - can't be undone. Type the group id to confirm:`),
        },
      ]);
      if (confirmId !== options.group) {
        console.log(chalk.gray('Cancelled - group id did not match.'));
        return;
      }
    }
    try {
      const res = await axios.delete(`${serverUrl}/plugins/group/${encodeURIComponent(options.group)}`, { ...authHeaders, timeout: DELETE_TIMEOUT_MS });
      console.log(chalk.green(`✅ Deleted ${res.data?.deleted_count ?? '?'} plugin(s) from group "${options.group}".`));
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      const hint = [401, 403].includes(error.response?.status) ? ' - this may need a `full_access`-scoped API key (see `aivin key gen`), not just a logged-in session' : '';
      throw new Error(`Group delete failed: ${message}${hint}`, { cause: error });
    }
    return;
  }

  id = await requireArg(id, { prompt: 'Plugin id to delete:', usage: 'Usage: aivin plugin delete <id>  (or: aivin plugin delete --group <groupId>)' });

  if (!options.yes) {
    const { confirmDelete } = await inquirer.prompt([
      { type: 'confirm', name: 'confirmDelete', message: `Delete plugin "${id}"? This can't be undone.`, default: false },
    ]);
    if (!confirmDelete) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }
  try {
    await axios.delete(`${serverUrl}/plugins/store/${encodeURIComponent(id)}`, { ...authHeaders, timeout: DELETE_TIMEOUT_MS });
    console.log(chalk.green(`✅ Deleted "${id}".`));
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Delete failed: ${message}`, { cause: error });
  }
}
