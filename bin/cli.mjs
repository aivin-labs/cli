#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { spawn } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';
// Same flatten logic PluginServer.ts uses for local/production runtime resolution - re-exported
// from the installed @aivin-labs/sdk (not vendored here) so deploy and runtime agree on exactly
// the same rules for what manifest.json's { ...commonFields, plugins: [...] } authoring shape
// expands into.
import { flattenManifestFile } from '@aivin-labs/sdk';

// Side-effect only import - installs the global Ctrl+C → abort-in-flight-requests wiring
// (`bin/lib/cancellation.mjs`) once, before any command runs. Must load before any lib file below
// makes its first axios call so the interceptor is already in place.
import './lib/cancellation.mjs';

import { DEFAULT_AIVIN_BASE_URL, GLOBAL_CREDENTIALS_PATH, fetchWebUrl, loadActiveContext, clearActiveContext } from './lib/context.mjs';
import { requireArg } from './lib/util.mjs';
import { readStdin, createFromJSON, createInteractive, validatePluginConfig, validateMcpProxyConfig } from './lib/scaffold.mjs';
import { buildDeploymentPayload, deployPlugin, incrementVersion } from './lib/deploy.mjs';
import { initInteractive, makePluginFromDescription, convertExistingProject } from './lib/codegen.mjs';
import { searchPlugins, showPluginInfo, askPlugin, streamPluginLogs, triggerPlugin, deletePluginCmd } from './lib/pluginTrigger.mjs';
import { connectorAuthHeaders, connectorBaseUrl, listConnectors, registerConnector, searchConnectors, buildRegisterConnectorDto } from './lib/connectors.mjs';
import { attachStore, createStore, deleteStore, detachStore, listStores, removeNode, setStoreEnabled } from './lib/store.mjs';
import { buildMcpManifest, parseMcpArgs, guessConnectorQueryFromEnvVarName, createMcpProxyPlugin, scanAndPublishMcp, registerMcpWatch, unwatchMcp, listMcpWatches, setFieldConnector } from './lib/mcpProxy.mjs';
import {
  saveGlobalApiKey,
  browserLogin,
  basicLogin,
  requireSavedApiKey,
  logAccountIdentity,
  listRemoteApiKeys,
  generateApiKey,
  revokeApiKeyByName,
  tryFetchWhoami,
  parseApiKeyClient,
} from './lib/auth.mjs';
import {
  missionAuthHeaders,
  missionServerUrl,
  resolveWorkspace,
  searchAgents,
  pullAgentIntoWorkspace,
  createAgent,
  publishAgent,
  installAgentInteractive,
  listAgentsCmd,
} from './lib/workspace.mjs';
import { runMission, runBrowserMission } from './lib/mission.mjs';
import { DeviceAccess } from './lib/remote/constants.mjs';
import { configureProxy } from './lib/remote/netProxy.mjs';
import { DAEMON_RUNNING } from './lib/remote/daemonLock.mjs';
import { runPolicyCommand } from './lib/remote/policyCommand.mjs';
import { loadMascotSettings, saveMascotSettings } from './lib/remote/mascot/index.mjs';
import { MascotText, mascotLang, mascotText } from './lib/remote/mascot/strings.mjs';
import { UiResult, showMascotDemo, showMascotUi } from './lib/remote/mascot/ui.mjs';
import { desktopAppStatus, installDesktopApp, uninstallDesktopApp } from './lib/remote/autoStart.mjs';
import { createMeetingManager, requestMeeting } from './lib/remote/meeting/index.mjs';
import { DEFAULT_HOTKEYS, hotkeyCandidates, parseHotkey, probeHotkey } from './lib/remote/mascot/hotkey.mjs';
import { RESTART_EXIT_CODE, UPDATE_ROLLED_BACK, UpdateStatus, cleanupRetired, downloadRoot, installUpdate, isStandaloneBinary, saveUpdateSettings } from './lib/selfUpdate.mjs';
import {
  createAutomationJob,
  listTasks,
  listMyTasks,
  getTaskById,
  updateTaskById,
  deleteTaskById,
  createTask,
  buildCreateTaskPayload,
  pickWorkspaceAndProject,
  createProjectCmd,
  updateProjectCmd,
  deleteProjectCmd,
  listProjectsCmd,
} from './lib/tasks.mjs';
import {
  startRemoteClient,
  testRemoteConnection,
  enableAutoStart,
  disableAutoStart,
  getAutoStartStatus,
  buildDeviceProfile,
  buildTools,
  buildCatalog,
  getOrCreateDeviceId,
  resetDeviceId,
  loadDeviceCredentials,
  pairDevice,
  pairWithCodeOnly,
  listDevices,
  unpairDevice,
  isRemotePaused,
  setRemotePaused,
  getRecentLogs,
  clearLogs,
  memoryStats,
  listMemoryItems,
  searchMemory,
  putMemoryItems,
  deleteMemoryItems,
  clearDeviceMemory,
  createFileIndex,
  loadIndexFolders,
  saveIndexFolders,
  resolveInRoots,
  indexRootsFor,
  runRemoteMission,
  MemoryKind,
} from './lib/remoteControl.mjs';

// Load env vars: the current project's `.env` first (any deliberate per-project override), THEN
// fill in AIVIN_BASE_URL/API_KEY/SDK_ENDPOINT from the machine's active context if the project
// didn't set them. `dotenv.config()` never overrides a variable that's already set, so a project's
// own `.env` (or a real shell env var) always wins over the global context, exactly like before -
// but nothing requires a project to have a `.env` at all anymore for the common single-context case.
// `quiet: true` - otherwise dotenv prints an "injected env" tip line to stdout on every run, which
// would corrupt `--json-output` mode (meant for clean, parseable JSON on stdout).
dotenv.config({ quiet: true });

{
  const activeContext = loadActiveContext();
  if (activeContext) {
    if (!process.env.AIVIN_BASE_URL) process.env.AIVIN_BASE_URL = activeContext.base_url;
    if (!process.env.API_KEY) process.env.API_KEY = activeContext.api_key;
    if (!process.env.SDK_ENDPOINT && activeContext.sdk_endpoint) process.env.SDK_ENDPOINT = activeContext.sdk_endpoint;
  }
}

const __filename = fileURLToPath(import.meta.url);

const __dirname = dirname(__filename);

// This CLI's own version (`aivin --version`) - distinct from whatever @aivin-labs/sdk version a
// given plugin project has installed. See lib/scaffold.mjs for how a fresh scaffold's `@aivin-labs/
// sdk` dependency pin is resolved (from the actually-installed sdk, not from here).
// Bản tệp chạy đóng gói (scripts/build-binary.mjs) không có package.json trên đĩa — phiên bản được ghi sẵn lúc build.
const CLI_PACKAGE_JSON = process.env.AIVIN_CLI_BINARY
  ? { version: process.env.AIVIN_CLI_BINARY, engines: {} }
  : JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const CLI_VERSION = CLI_PACKAGE_JSON.version;

/**
 * `aivin start` spawns the plugin project's own installed `@aivin-labs/sdk`'s `bin/server.mjs`,
 * which loads `src/main.ts` directly via Node's native TS execution (no separate compile step) -
 * the same mechanism this CLI's own `engines.node` field (">=22.0.0") documents as required for
 * itself. Node <22 doesn't strip TS types at all, so that failure doesn't surface as anything about
 * Node versions - it's a raw loader error ("Unknown file extension \".ts\"") thrown from deep inside
 * `server.mjs`, giving no hint that the fix is just "use a newer Node". Check the constraint up
 * front instead, once, with a message that says exactly what's wrong and how to fix it.
 */
function checkNodeVersion() {
  const required = CLI_PACKAGE_JSON.engines?.node;
  const requiredMajor = required && parseInt(required.match(/(\d+)/)?.[1], 10);
  const currentMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (requiredMajor && currentMajor < requiredMajor) {
    console.error(
      chalk.red(`❌ Node ${process.version} detected - aivin requires Node ${required} (native TypeScript execution).`),
    );
    console.error(chalk.gray(`   Switch versions (e.g. \`nvm use ${requiredMajor}\`) and try again.`));
    process.exit(1);
  }
}

/**
 * Resolves `bin/server.mjs` from the CURRENT PROJECT's own installed `@aivin-labs/sdk` (not this
 * CLI's install location - after the cli/sdk package split those are two different places, and
 * `aivin start`/`aivin test` must run whatever sdk version the plugin project actually depends on,
 * the same one its own `npm install` resolved). Resolves `@aivin-labs/sdk/package.json` (an
 * explicit "./package.json" export, see the sdk's package.json) via Node's normal module resolution
 * rooted at the current directory, then derives `bin/server.mjs` from its location by plain path
 * math - deliberately not a second module-specifier resolution, since `bin/server.mjs` itself isn't
 * (and doesn't need to be) part of the sdk's public `exports` map.
 */
function resolveLocalSdkServerPath(currentDir = process.cwd()) {
  const localRequire = createRequire(pathToFileURL(path.join(currentDir, 'noop.cjs')).href);
  let sdkPackageJsonPath;
  try {
    sdkPackageJsonPath = localRequire.resolve('@aivin-labs/sdk/package.json');
  } catch (error) {
    throw new Error(
      `Could not find @aivin-labs/sdk installed in ${currentDir} - run \`npm install\` first.`,
      { cause: error },
    );
  }
  return path.join(path.dirname(sdkPackageJsonPath), 'bin', 'server.mjs');
}

const program = new Command();

program.name('aivin').description('aivin CLI - scaffold, run, and deploy Aivin plugins').version(CLI_VERSION);

// Command: create plugin
program
  .command('create [name]')
  .description('Create new plugin')
  .option('--json <config>', 'JSON config (AI mode)')
  .option('--stdin', 'Read from stdin')
  .option('--name <name>', 'Plugin name (if not specified, will prompt)')
  .option('--silent', 'Silent mode')
  .option('--json-output', 'JSON output')
  .action(async (name, options) => {
    if (name) options.name = name;
    try {
      let result;

      if (options.stdin) {
        const stdinData = await readStdin();
        result = await createFromJSON(stdinData, options);
      } else if (options.json) {
        result = await createFromJSON(options.json, options);
      } else {
        result = await createInteractive(options);
      }

      if (options.jsonOutput && result) {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      if (options.jsonOutput) {
        console.log(
          JSON.stringify(
            {
              success: false,
              error: error.message,
              code: error.code || 'ERROR',
            },
            null,
            2,
          ),
        );
      } else if (!options.silent) {
        console.error(chalk.red('❌'), error.message);
      }
      process.exit(1);
    }
  });

// Command: init plugin - guided one-step replacement for `create` + `plugin make`
program
  .command('init [name]')
  .description('Set up a new plugin step by step: asks what it should do, then generates real working code from that description')
  .option('--name <name>', 'Plugin name (if not specified, will prompt)')
  .option('--model <model>', 'LLM model to use for generation')
  .option('--provider <provider>', 'LLM provider to use for generation')
  .action(async (name, options) => {
    if (name) options.name = name;
    try {
      await initInteractive(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// Command: Validate plugin config
program
  .command('validate')
  .description('Validate manifest.json in the current directory (or --json/--stdin for scripted use)')
  .option('--json <config>', 'JSON config, instead of reading manifest.json from the current directory')
  .option('--stdin', 'Read JSON config from stdin, instead of reading manifest.json')
  .option('--json-output', 'JSON output')
  .action(async (options) => {
    try {
      let configData;

      if (options.stdin) {
        configData = await readStdin();
      } else if (options.json) {
        configData = options.json;
      } else {
        // Simple, no-flags default: validate manifest.json in the current directory - the case
        // you actually want most of the time (`aivin validate` from inside your plugin project).
        // --json/--stdin remain for scripted/CI use where the config isn't a file on disk yet.
        const manifestPath = path.join(process.cwd(), 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
          throw new Error('No manifest.json found in the current directory. Pass --json <config> or --stdin instead.');
        }
        configData = fs.readFileSync(manifestPath, 'utf8');
      }

      // Expand the default { ...commonFields, plugins: [...] } shape and validate every entry -
      // flattenManifestFile itself throws on structural problems (empty plugins[], missing
      // id/name/func, bare top-level array).
      const config = flattenManifestFile(JSON.parse(configData));
      const entries = Array.isArray(config) ? config : [config];
      const errors = entries.flatMap((entry, i) =>
        validatePluginConfig(entry).errors.map((e) =>
          entries.length > 1 ? `plugins[${i}] (${entry.name || 'unnamed'}): ${e}` : e,
        ),
      );
      const result = { valid: errors.length === 0, errors };

      if (options.jsonOutput) {
        console.log(
          JSON.stringify(
            {
              valid: result.valid,
              errors: result.errors,
            },
            null,
            2,
          ),
        );
      } else {
        if (result.valid) {
          console.log(chalk.green('✅ Valid'));
        } else {
          console.log(chalk.red('❌ Invalid:'));
          result.errors.forEach((error) => console.log(`  • ${error}`));
        }
      }

      if (!result.valid) process.exit(1);
    } catch (error) {
      if (options.jsonOutput) {
        console.log(JSON.stringify({ valid: false, error: error.message }, null, 2));
      } else {
        console.error(chalk.red('❌'), error.message);
      }
      process.exit(1);
    }
  });

// Command: start plugin server
program
  .command('start')
  .description('Start plugin server')
  .option('--debug', 'Log every sdk.* call live as it happens (human-readable), not just the final trace summary')
  .option('--debug-json', 'Same live per-call logging as --debug, but one JSON object per line on stdout - for a script/coding agent to parse instead of a human')
  .option('--no-watch', 'Disable hot-reload - restart manually (Ctrl+C + `aivin start` again) after editing src/ instead')
  .action((options) => {
    checkNodeVersion();
    let serverPath;
    try {
      serverPath = resolveLocalSdkServerPath();
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
    const debugEnv = options.debugJson ? { SDK_DEBUG: 'json' } : options.debug ? { SDK_DEBUG: 'true' } : {};
    const watchEnv = options.watch === false ? { AIVIN_START_WATCH: 'false' } : {};
    const child = spawn('node', [serverPath], {
      stdio: 'inherit',
      env: { ...process.env, ...debugEnv, ...watchEnv },
    });

    child.on('error', (error) => {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        process.exit(code);
      }
    });
  });

// Command: deploy plugin to server (always private to your org - see buildDeploymentPayload's
// doc comment above for why there's no public/store-submission scope here)
program
  .command('deploy')
  .description('Deploy plugin to your org on the Aivin server')
  .action(async () => {
    try {
      await deployPlugin({
        endpointPath: '/plugins/deploy',
        label: 'Deploying plugin',
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// Command: deploy to a throwaway test instance (backend rejects this in production)
program
  .command('test')
  .description(
    'Deploy to a non-production test instance, then smoke-test it with generated input and save a report to .test/',
  )
  .option('--workspace <id>', 'Workspace id to run the smoke test against (default: auto-picks your first one)')
  .option('--no-smoke-test', 'Only deploy - skip the generated-input invoke test and report')
  .option('--verify-proxy', 'Also invoke MCP proxy entries for real (empty input) instead of skipping them - only use if you know the underlying tool(s) have no meaningful side effects')
  .action(async (options) => {
    try {
      await deployPlugin({
        endpointPath: '/plugins/test/deploy',
        label: 'Deploying to test instance',
        smokeTest: options.smokeTest !== false,
        workspaceOverride: options.workspace,
        verifyProxy: options.verifyProxy,
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const pluginCommand = program.command('plugin').description('AI-assisted plugin authoring');

pluginCommand
  .command('search [query]')
  .description("Search the platform's plugin ecosystem for something to reuse instead of writing it yourself")
  .option('--workspace <id>', 'Restrict to plugins visible in this workspace (default: your whole org)')
  .option('--mcp <server_id>', 'List every tool/resource/prompt plugin generated from one MCP server (the id printed by `aivin mcp`/`aivin plugin search`, e.g. "modelcontextprotocol-servers-src-everything") instead of doing a text search')
  .option('--store <store_id>', 'Restrict to plugins hosted on one self-hosted plugin store (the id printed by `aivin pluginstore ls`) - combines with the text query/--mcp, not a replacement for them')
  .option('--limit <n>', 'Max results to show')
  .option('--plain', 'Print a flat list instead of the interactive browser (for scripts/CI)')
  .action(async (query, options) => {
    try {
      // --mcp is an exact-id lookup, not a text search - the query string is optional in that mode.
      if (!options.mcp) {
        query = await requireArg(query, { prompt: 'What are you looking for?', usage: 'Usage: aivin plugin search "<query>"' });
      }
      await searchPlugins(query, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('info <id>')
  .description("Show one plugin's detail (input/output schema, setup needs) directly by id, no search query needed")
  .option('--workspace <id>', 'Restrict to plugins visible in this workspace (default: your whole org)')
  .option('--plain', 'Print flat instead of the interactive browser, if falling back to closest-match results')
  .action(async (id, options) => {
    try {
      await showPluginInfo(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('ask [mission]')
  .description('One-shot: search for the best-matching plugin for a plain-language mission and trigger it right away, like an agent would')
  .option('--top <n>', 'How many candidates to consider/print as runner-up context (default 5) - only the top match is ever run')
  .option('-i, --input <json>', 'Input fields as a JSON string - skips the interactive field-by-field prompt')
  .option('--workspace <id>', 'Workspace id to search/run against (default: auto-picks your first one)')
  .option('--agent <id>', 'Agent id to run as, if the plugin needs one for HIL/confirm behavior to be accurate')
  .option('--watch-logs', "Also stream the chosen plugin's own live console output inline")
  .option('--no-auth-prompt', "Don't offer to connect/configure a missing connector interactively when the run comes back needing one - just print the result and exit")
  .option('--save', 'Write this run\'s result to .test/trigger/<timestamp>.json for later --compare')
  .option('--compare <file>', 'Diff this run\'s result against a previously --save\'d .test/trigger/*.json file')
  .action(async (mission, options) => {
    try {
      await askPlugin(mission, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('make [description]')
  .description('Generate src/main.ts from a natural-language business description')
  .option('--model <model>', 'LLM model to use for generation')
  .option('--provider <provider>', 'LLM provider to use for generation')
  .action(async (description, options) => {
    try {
      description = await requireArg(description, { prompt: 'What should this plugin do?', usage: 'Usage: aivin plugin make "<description>"' });
      await makePluginFromDescription(description, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('convert [hint]')
  .description('Turn an existing project in the current directory into an Aivin plugin')
  .option('--model <model>', 'LLM model to use for generation')
  .option('--provider <provider>', 'LLM provider to use for generation')
  .option('--force', 'Re-run conversion even if src/main.ts already exists (e.g. redo a previous bad/stale result)')
  .action(async (hint, options) => {
    try {
      await convertExistingProject(hint, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('trigger [mission] [input]')
  .description('Invoke this deployed plugin for real and print the result - like the platform\'s Playground')
  .option('--id <pluginId>', 'Plugin id to trigger directly - skips the local manifest.json lookup (e.g. for `aivin mcp` plugins, which have no local project directory)')
  .option('--func <name>', 'Which function to trigger, for a multi-function plugin (matches name/func/id) - ignored when --id is given')
  .option('--workspace <id>', 'Workspace id to run against (default: auto-picks your first one)')
  .option('--agent <id>', 'Agent id to run as, if the plugin needs one for HIL/confirm behavior to be accurate')
  .option('--watch-logs', 'Also stream the plugin\'s own live console output inline (same feed as `aivin plugin logs`) instead of needing a second terminal - requires permission to view that plugin\'s logs (your own/org\'s deployments; most store plugins from other orgs will just skip this and fall back to the REST result only)')
  .option('--no-auth-prompt', "Don't offer to connect/configure a missing connector interactively when the run comes back needing one - just print the result and exit")
  .option('--save', 'Write this run\'s result to .test/trigger/<timestamp>.json for later --compare')
  .option('--compare <file>', 'Diff this run\'s result against a previously --save\'d .test/trigger/*.json file')
  .action(async (mission, input, options) => {
    try {
      await triggerPlugin(mission, input, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('logs [pluginId]')
  .description('Tail a deployed plugin\'s own console output live (defaults to the current directory\'s manifest.json id)')
  .option('--func <name>', 'Which function\'s id to resolve, for a multi-function plugin (only used when pluginId is omitted)')
  .action(async (pluginId, options) => {
    try {
      await streamPluginLogs(pluginId, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('delete [id]')
  .description("Delete a plugin you own, or every plugin from one batch deploy at once with --group <groupId> (e.g. everything `aivin mcp <url>` generated in one run - see the group_id it prints after deploying)")
  .option('--group <groupId>', 'Delete every plugin sharing this group_id instead of a single plugin by id')
  .option('-y, --yes', 'Skip the confirmation prompt (for scripts/CI)')
  .action(async (id, options) => {
    try {
      await deletePluginCmd(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const connectorCommand = program.command('connector').description('Register and discover reusable connectors (OAuth apps / credential-form namespaces)');

connectorCommand
  .command('register')
  .description('Register a new connector namespace, interactively')
  .action(async () => {
    try {
      await registerConnector();
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

connectorCommand
  .command('search [query]')
  .description("Search connectors for something to reuse instead of registering a new one")
  .option('--limit <n>', 'Max results to show')
  .option('--plain', 'Print a flat list instead of the interactive browser (for scripts/CI)')
  .action(async (query, options) => {
    try {
      query = await requireArg(query, { prompt: 'What are you looking for?', usage: 'Usage: aivin connector search "<query>"' });
      await searchConnectors(query, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

connectorCommand
  .command('list')
  .description('List connectors visible to your org')
  .option('--page <n>', 'Page number')
  .option('--limit <n>', 'Items per page')
  .option('--include-deprecated', "Also show your org's deprecated connectors (hidden by default)")
  .option('--plain', 'Print a flat list instead of the interactive browser (for scripts/CI)')
  .action(async (options) => {
    try {
      await listConnectors(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

connectorCommand
  .command('deprecate [id]')
  .description("Hide a connector you own from search/list without breaking plugins already using it")
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Connector id to deprecate:', usage: 'Usage: aivin connector deprecate <id>' });
      await axios.post(`${connectorBaseUrl()}/connectors/${encodeURIComponent(id)}/deprecate`, {}, connectorAuthHeaders());
      console.log(chalk.green(`✅ "${id}" is now deprecated - still usable, hidden from new search/list.`));
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      console.error(chalk.red('❌'), message);
      process.exit(1);
    }
  });

connectorCommand
  .command('undeprecate [id]')
  .description('Make a previously-deprecated connector you own discoverable again')
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Connector id to un-deprecate:', usage: 'Usage: aivin connector undeprecate <id>' });
      await axios.post(`${connectorBaseUrl()}/connectors/${encodeURIComponent(id)}/undeprecate`, {}, connectorAuthHeaders());
      console.log(chalk.green(`✅ "${id}" is discoverable again.`));
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      console.error(chalk.red('❌'), message);
      process.exit(1);
    }
  });

const pluginStoreCommand = program
  .command('pluginstore')
  .description('Self-hosted aivin-service worker (Docker) - attach it to your org as a plugin store. See docs/GETTING_STARTED.md.');

pluginStoreCommand
  .command('create [store_id]')
  .description('Create a new plugin store + attach this machine as its first node')
  .option('--label <label>', 'Display label for the store (defaults to store_id)')
  .option('--node-label <label>', 'Display label for this node/instance')
  .option('--data-dir <path>', 'Where to write worker-identity.json (default: ~/.aivin/service-data)')
  .action(async (storeId, options) => {
    try {
      await createStore(storeId, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginStoreCommand
  .command('attach [store_id]')
  .description('Attach this machine as another node of an existing plugin store')
  .option('--node-label <label>', 'Display label for this node/instance')
  .option('--data-dir <path>', 'Where to write worker-identity.json (default: ~/.aivin/service-data)')
  .action(async (storeId, options) => {
    try {
      await attachStore(storeId, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginStoreCommand
  .command('ls')
  .description('List plugin stores visible to your org, with online/offline status per node')
  .action(async (options) => {
    try {
      await listStores(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginStoreCommand
  .command('enable [store_id]')
  .description('Enable a store for your org (org admin only)')
  .action(async (storeId) => {
    try {
      storeId = await requireArg(storeId, { prompt: 'Store id to enable:', usage: 'Usage: aivin pluginstore enable <store_id>' });
      await setStoreEnabled(storeId, true);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginStoreCommand
  .command('disable [store_id]')
  .description('Disable a store for your org without deleting it (org admin only)')
  .action(async (storeId) => {
    try {
      storeId = await requireArg(storeId, { prompt: 'Store id to disable:', usage: 'Usage: aivin pluginstore disable <store_id>' });
      await setStoreEnabled(storeId, false);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginStoreCommand
  .command('rm [store_id]')
  .description('Delete a store - revokes EVERY node attached to it, not just this machine (org admin only)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (storeId, options) => {
    try {
      storeId = await requireArg(storeId, { prompt: 'Store id to delete:', usage: 'Usage: aivin pluginstore rm <store_id>' });
      await deleteStore(storeId, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginStoreCommand
  .command('rm-node [store_id] [node_id]')
  .description('Remove one node from a store (e.g. one that never came online) without touching its other nodes - org admin not required')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (storeId, nodeId, options) => {
    try {
      await removeNode(storeId, nodeId, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginStoreCommand
  .command('detach')
  .description("Remove THIS machine's pairing only (local file only, no BE call) - the running aivin-service picks it up automatically")
  .option('--data-dir <path>', 'Where worker-identity.json lives (default: ~/.aivin/service-data)')
  .action((options) => {
    try {
      detachStore(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const mcpCommand = program
  .command('mcp')
  .description('MCP proxy plugins - wrap an external MCP server tool/resource/prompt, no code required');

mcpCommand
  .argument('[url]', 'GitHub/GitLab/npm/Smithery URL, or a live MCP server URL, to scan and convert')
  .option('--publish', 'Deploy to your org, then submit for community store review (needs admin approval)')
  .option('--private', 'Deploy to your org only - default')
  .option('--org', 'Alias of --private - there is no narrower per-workspace scope today')
  .option('--quiet', 'Skip live progress output while scanning (on by default otherwise)')
  .option('--auth', 'Đánh dấu MCP này cần credential -> BE sinh connection_id, CLI hỏi gắn connector (OAuth HOẶC credential_form tuỳ chọn lúc đó). Dùng cho MCP cần API key/token mà scan không tự nhận ra')
  .option('--oauth', 'Bí danh cũ của --auth (giữ để không phá lệnh đã dùng)')
  .option('--test-token <token>', 'Access token dùng THỬ để đọc tool của remote MCP cần OAuth (Notion/Slack/Linear/Figma...). Chỉ dùng lúc quét, KHÔNG lưu lại - xem test_token trong plugin-store.proto')
  .option('-y, --yes', 'Skip the deploy confirmation prompt (required in non-TTY/CI contexts, which otherwise now refuse to deploy at all - see scanAndPublishMcp)')
  .action(async (url, options) => {
    try {
      url = await requireArg(url, {
        prompt: 'GitHub/GitLab/npm/Smithery URL, or a live MCP server URL:',
        usage: 'Usage: aivin mcp <url> [--publish|--private|--org]',
      });
      await scanAndPublishMcp(url, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

mcpCommand
  .command('create [name]')
  .description('Scaffold a manifest-only plugin that proxies to an external MCP server')
  .option('--transport <transport>', 'stdio | sse')
  .option('--command <command>', 'Command to launch the MCP server (stdio transport)')
  .option('--args <args>', 'Space-separated args for --command (stdio transport)')
  .option('--url <url>', 'Remote MCP server URL (sse transport)')
  .option('--kind <kind>', 'tool | resource | prompt (default: tool)')
  .option('--tool-name <name>', 'MCP tool name (kind=tool)')
  .option('--resource-uri <uri>', 'MCP resource URI (kind=resource)')
  .option('--resource-mime-type <mime>', 'MIME type of the resource (kind=resource)')
  .option('--prompt-name <name>', 'MCP prompt name (kind=prompt)')
  .option('--description <description>', 'Plugin description')
  .option(
    '--auth-secret-key <key>',
    'Name of the workspace secret to use as the token/credential, if the MCP server needs auth',
  )
  .option('--auth-type <type>', 'auth_type value to send (default: "bearer" when --auth-secret-key is set) - check your backend for which values it supports')
  .option('--connector <id>', "Existing connector id for this plugin's connection_id (readiness/\"needs login\" display only - does NOT inject anything into the running MCP server; run with no flags for the interactive per-variable auth setup that actually does)")
  .action(async (name, options) => {
    try {
      name = await requireArg(name, { prompt: 'Plugin name (lowercase letters, numbers, hyphens):', usage: 'Usage: aivin mcp create <name>' });
      await createMcpProxyPlugin(name, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

mcpCommand
  .command('watch [url]')
  .description('Watch a GitHub repo/branch and auto-rescan+resync its plugins when the branch updates (checked server-side every ~5 min, no CLI process needs to stay running)')
  .option('--branch <name>', "Branch to watch (default: the repo's default branch)")
  .option('--list', 'List your watched repos instead of registering a new one')
  .action(async (url, options) => {
    try {
      if (options.list) {
        await listMcpWatches();
        return;
      }
      url = await requireArg(url, {
        prompt: 'GitHub repo URL to watch:',
        usage: 'Usage: aivin mcp watch <url> [--branch <name>] | aivin mcp watch --list',
      });
      await registerMcpWatch(url, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

mcpCommand
  .command('unwatch <url>')
  .description('Stop auto-resyncing a previously watched repo')
  .option('--branch <name>', 'Branch to unwatch (default: all watched branches for this repo)')
  .action(async (url, options) => {
    try {
      await unwatchMcp(url, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

program
  .command('login')
  .argument('[baseUrl]', 'Server to log into (REST API base) - defaults to production (api.aivin.cloud). Pass a staging/self-hosted host to switch the machine\'s active context to it, e.g. `aivin login beta-api.aivin.vn`.')
  .description('Log in and save an API key for plugin deployment (opens your browser by default)')
  .option('-k, --api-key <key>', 'Set API key directly (skip login entirely)')
  .option('--basic', 'Log in with email/password directly in the terminal instead of a browser')
  .option('--google', 'Alias of the default browser flow - pick Google once the page opens')
  .option('--client <client>', 'Client/org id to use with --basic (default: "aivin.cloud")')
  .action(async (baseUrl, options) => {
    try {
      // Bare hostname (no scheme) is the common case for a quick `aivin login beta-api.aivin.vn` -
      // assume https, same as every other *.aivin.* endpoint in this file.
      const resolvedBaseUrl = baseUrl ? (/^https?:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`) : DEFAULT_AIVIN_BASE_URL;
      process.env.AIVIN_BASE_URL = resolvedBaseUrl;

      if (options.apiKey) {
        console.log(chalk.blue('🔑 Setting API key...'));
        // Best-effort - `aivin whoami` reads straight from the saved file with no server calls of
        // its own, so whatever identity is resolvable here is all it will ever have to show.
        const identity = await tryFetchWhoami(resolvedBaseUrl, options.apiKey);
        const sdkEndpoint = saveGlobalApiKey(options.apiKey, resolvedBaseUrl, identity);
        console.log(chalk.green('✅ API key set successfully!'));
        console.log(chalk.gray(`   Active context: ${resolvedBaseUrl}${sdkEndpoint ? ` (SDK_ENDPOINT: ${sdkEndpoint})` : ''}`));
        console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine now targets this server.`));
        return;
      }

      // Only the browser flow needs a web app URL - fetch it from the backend itself (not needed/
      // fetched for --basic, which never touches AIVIN_WEB_URL at all). Same override precedence
      // as everywhere else: a caller-set AIVIN_WEB_URL (project .env/shell) always wins.
      if (!options.basic && !process.env.AIVIN_WEB_URL) {
        const webUrl = await fetchWebUrl(resolvedBaseUrl);
        if (webUrl) {
          process.env.AIVIN_WEB_URL = webUrl;
        } else {
          // fetchWebUrl swallows its own errors (bad host, typo'd domain, TLS/DNS failure) and
          // returns null - warn instead of silently opening the PRODUCTION web app's login page,
          // which would mint a key for the wrong server without any indication why.
          console.log(chalk.yellow(`⚠️  Couldn't reach ${resolvedBaseUrl} to resolve its web app URL - check the host is correct.`));
          console.log(chalk.yellow(`   Falling back to the production web app (https://brain.aivin.cloud) - the key it mints will still be saved against ${resolvedBaseUrl}, likely NOT what you want.`));
        }
      }

      const apiKey = options.basic ? await basicLogin(options) : await browserLogin();

      console.log(chalk.green('✅ Login successful!'));
      const identity = await tryFetchWhoami(resolvedBaseUrl, apiKey);
      const sdkEndpoint = saveGlobalApiKey(apiKey, resolvedBaseUrl, identity);
      console.log(chalk.gray(`   Active context: ${resolvedBaseUrl}${sdkEndpoint ? ` (SDK_ENDPOINT: ${sdkEndpoint})` : ''}`));
      console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine now targets this server.`));
    } catch (error) {
      console.log(chalk.red('❌ Login failed:'), error.message);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Clear the saved API key on this machine (~/.aivin/credentials) - run `aivin login` again to log back in')
  .action(() => {
    try {
      // Captured BEFORE clearing so we can tell whether the currently-effective API_KEY (already
      // loaded into process.env at startup - see the dotenv/loadActiveContext precedence block at
      // the top of this file) came from this file or from a project's own .env, which logout never
      // touches.
      const savedContext = loadActiveContext();
      const cleared = clearActiveContext();
      if (cleared) {
        console.log(chalk.green(`✅ Logged out - removed ${GLOBAL_CREDENTIALS_PATH}`));
      } else {
        console.log(chalk.gray('Already logged out - no saved credentials found.'));
      }
      if (process.env.API_KEY && process.env.API_KEY !== savedContext?.api_key) {
        console.log(chalk.gray("   Note: this directory still has its own API_KEY set (from a project .env or shell env) - unset that too if you want it fully logged out here."));
      }
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

program
  .command('whoami')
  .description('Show which account is currently logged in on this machine (reads ~/.aivin/credentials - no server call)')
  .action(() => {
    try {
      const apiKey = requireSavedApiKey();
      const serverUrl = process.env.AIVIN_BASE_URL || DEFAULT_AIVIN_BASE_URL;
      const localClient = parseApiKeyClient(apiKey);

      // The effective API_KEY may come from a project's own .env instead of `~/.aivin/credentials`
      // (see the dotenv precedence near the top of this file) - identity/login time only exist in
      // the latter, so a project .env override has nothing to show beyond the key's own client id.
      const savedContext = loadActiveContext();
      const fromSavedContext = savedContext?.api_key === apiKey;
      const identity = fromSavedContext ? savedContext : {};

      console.log(chalk.green('✅ Logged in'));
      console.log(chalk.gray('   Email:  ') + (identity.email || chalk.gray('unknown')));
      console.log(chalk.gray('   Name:   ') + (identity.name || chalk.gray('unknown')));
      console.log(chalk.gray('   Org:    ') + (identity.org_name || identity.client || localClient || chalk.gray('unknown')));
      if (identity.org_domain) console.log(chalk.gray('   Domain: ') + identity.org_domain);
      console.log(chalk.gray('   Server: ') + serverUrl);
      if (fromSavedContext && savedContext.logged_in_at) {
        console.log(chalk.gray('   Logged in at: ') + new Date(savedContext.logged_in_at).toLocaleString());
      } else if (!fromSavedContext) {
        console.log(chalk.gray("   (API_KEY is from this project's .env, not `aivin login` - no recorded identity/login time)"));
      } else if (!identity.email) {
        console.log(chalk.gray('   (Account info wasn\'t resolvable at login time - run `aivin login` again to refresh it)'));
      }
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const keyCommand = program.command('key').description('Manage named API keys for your account');

keyCommand
  .command('gen [name]')
  .description('Create (or replace) a named API key for your account - shown only once')
  .option('--save', 'Also save this key as this machine\'s default (~/.aivin/credentials), like `aivin login -k`')
  .action(async (name, options) => {
    try {
      name = await requireArg(name, { prompt: 'Name for this API key:', usage: 'Usage: aivin key gen <name>' });
      console.log(chalk.blue(`🔑 Creating API key "${name}"...`));
      const plainKey = await generateApiKey(name);
      console.log(chalk.green('✅ API key created!'));
      console.log(chalk.yellow('🔑 Key:'), chalk.cyan(plainKey));
      console.log(chalk.gray('   This is shown only once - store it somewhere safe.'));
      if (options.save) {
        const serverUrl = process.env.AIVIN_BASE_URL || DEFAULT_AIVIN_BASE_URL;
        const identity = await tryFetchWhoami(serverUrl, plainKey);
        saveGlobalApiKey(plainKey, serverUrl, identity);
        console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine can use it now.`));
      }
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

keyCommand
  .command('revoke [name]')
  .description('Revoke a named API key for your account')
  .action(async (name) => {
    try {
      name = await requireArg(name, { prompt: 'Name of the API key to revoke:', usage: 'Usage: aivin key revoke <name>' });
      console.log(chalk.blue(`🔑 Revoking API key "${name}"...`));
      await revokeApiKeyByName(name);
      console.log(chalk.green(`✅ API key "${name}" revoked.`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

keyCommand
  .command('list')
  .description('List API keys on your account')
  .action(async () => {
    try {
      const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
      const apiKey = requireSavedApiKey();
      await logAccountIdentity(serverUrl, apiKey);
      const items = await listRemoteApiKeys(serverUrl, apiKey);
      if (items.length === 0) {
        console.log(chalk.gray('No API keys found.'));
        return;
      }
      items.forEach((k) => {
        const created = k.created_at ? new Date(k.created_at).toISOString() : 'unknown';
        console.log(`  ${chalk.cyan(k.name)}  ${chalk.gray(`(created ${created})`)}`);
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

program
  .command('browser [mission]')
  .description("Run an AI Browser mission - by default in your everyday Chrome/Edge if you've switched on remote debugging in it (chrome://inspect/#remote-debugging), otherwise in a local browser window dedicated to AI Browser (own profile - log in once, the AI's tabs grouped together); --remote uses a server-side browser instead")
  .option('--remote', 'Use a server-side pooled browser instead of your own local one (no local browser needed, no cookies/logins carried over)')
  .option('--debug-port <port>', 'Local mode only: port to launch the AI Browser window\'s remote debugging on (default: 9222, auto-tries a few nearby ports if that one is taken by something else) - pass this to pin an exact port instead')
  .option('--browser <edge|chrome|brave|chromium>', "Local mode only: which browser to drive - default: auto-detects your OS's actual default browser, falling back to whichever of Edge/Chrome/Brave/Chromium is installed if that can't be determined")
  .option('--separate-browser', 'Local mode only: always use the dedicated AI Browser window, never your everyday browser (even if remote debugging is switched on in it)')
  .option('--url <url>', "Local mode only: open this URL before the mission starts, instead of a blank page - skips a wasted first analysis step and avoids the AI having to search the web to find the target site itself (auto-guessed for a few well-known sites mentioned by name in the mission if omitted)")
  .option('--workspace <id>', 'Workspace id to run in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace (--remote only)')
  .option('--agent <id>', "Agent id to run as (default: an auto-created/cached agent for local mode, or the workspace's default agent for --remote) - AI Browser is triggered as a tool this agent uses, real HIL suspend/resume requires an agent context")
  .option('--no-watch', 'Fire the mission and return immediately - skip streaming live progress and auto-opening the viewer')
  .option('--view', 'Just (re)open the fullscreen interactive viewer for whatever HIL session is already active - no mission is started')
  .action(async (mission, options) => {
    try {
      if (!options.view) {
        mission = await requireArg(mission, {
          prompt: 'What should the AI Browser do?',
          usage: 'Usage: aivin browser "<mission detail>"  (or: aivin browser --view to just reopen the interactive viewer)',
        });
      }
      await runBrowserMission(mission, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

program
  .command('ui')
  .description('Show the Aivin mascot on this computer with its ask box (Windows) - starts the background listener if it is not running')
  .option('--demo', 'Preview every mascot animation state without pairing or starting the listener')
  .action(async (options) => {
    const lang = mascotLang();
    const say = (key, color = chalk.green) => console.log(color(mascotText(lang, key)));
    if (options.demo) {
      const result = showMascotDemo();
      if (result === UiResult.UNSUPPORTED) return say(MascotText.CMD_UNSUPPORTED, chalk.yellow);
      if (result === UiResult.START_FAILED) { console.error(chalk.red('Không thể mở bản demo linh vật.')); process.exitCode = 1; return; }
      console.log(chalk.green('✓ Demo linh vật đang chạy qua 8 trạng thái — đóng cửa sổ hoặc nhấn Ctrl+C để dừng.'));
      return;
    }
    const result = await showMascotUi({ onStarting: () => say(MascotText.UI_STARTING, chalk.gray) });
    if (result === UiResult.UNSUPPORTED) return say(MascotText.CMD_UNSUPPORTED, chalk.yellow);
    if (result === UiResult.SHOWN) return say(MascotText.UI_SHOWN);
    if (result === UiResult.STARTED) return say(MascotText.UI_STARTED);
    if (result === UiResult.NOT_PAIRED) return say(MascotText.UI_NOT_PAIRED, chalk.yellow);
    say(MascotText.UI_START_FAILED, chalk.red);
    process.exitCode = 1;
  });

program
  .command('desktop [action]')
  .description('Aivin as a desktop app: install (Windows: system tray + Start menu; macOS: menu bar + Aivin.app; Linux: app menu + tray) and start it with the computer | uninstall | status (default)')
  .option('--no-autostart', "install: don't start Aivin with the computer (turn it on later from Aivin's menu or the system's startup settings)")
  .option('--no-launch', "install: don't open Aivin now")
  .action((action = 'status', options) => {
    // Chỗ bật / tắt khởi động cùng máy của từng hệ điều hành — cùng chỗ menu Aivin và `aivin remote enable|disable` đổi.
    const startupWhere = { win32: 'Task Manager → Startup apps', darwin: 'System Settings → General → Login Items', linux: 'Startup Applications / Autostart' }[process.platform] || '';
    const where = { win32: 'khay hệ thống, tìm "Aivin" trong Start', darwin: 'thanh menu, tìm "Aivin" bằng Spotlight', linux: 'khay hệ thống, tìm "Aivin" trong menu ứng dụng' }[process.platform] || '';
    try {
      if (action === 'install') {
        const res = installDesktopApp({ autostart: options.autostart !== false, launch: options.launch !== false });
        console.log(chalk.green(`✅ Đã cài Aivin vào máy: ${where}.`));
        console.log(chalk.gray(`   Ứng dụng: ${res.exe}`));
        console.log(chalk.gray(`   Khởi động cùng máy: ${res.autostart ? 'bật' : 'tắt'} (đổi ở menu Aivin hoặc ${startupWhere})`));
        if (process.platform === 'linux' && !desktopAppStatus().tray) {
          console.log(chalk.yellow('   ⚠️  Máy chưa có AppIndicator cho python3 nên không có biểu tượng khay — Aivin vẫn chạy nền. Cài: sudo apt install gir1.2-ayatanaappindicator3-0.1 (Ubuntu / Debian)'));
        }
        return;
      }
      if (action === 'uninstall') {
        const res = uninstallDesktopApp();
        console.log(chalk.green('✅ Đã gỡ ứng dụng Aivin trên màn hình và mục khởi động cùng máy (lệnh `aivin` vẫn còn).'));
        if (!res.removed) console.log(chalk.yellow('   ⚠️  Ứng dụng còn đang chạy nên chưa xoá hết được tệp — chạy lại lệnh này sau ít giây.'));
        return;
      }
      if (action !== 'status') throw new Error('Dùng: aivin desktop install [--no-autostart] [--no-launch] | uninstall | status');
      const st = desktopAppStatus();
      if (st.supported === false) return console.log(chalk.gray(`Chưa có ứng dụng Aivin trên màn hình cho ${process.platform} — dùng \`aivin remote enable\`.`));
      console.log(chalk.blue('🖥️  Aivin trên máy này:'));
      console.log(chalk.gray(`   Ứng dụng:           ${st.installed ? st.app : 'chưa cài — aivin desktop install'}`));
      if (st.installed) console.log(chalk.gray(`   Tìm bằng:           ${st.search || 'không'}`));
      console.log(chalk.gray(`   Khởi động cùng máy: ${st.startup.registered ? (st.startup.enabled ? 'bật' : `tắt (${startupWhere})`) : 'không'}`));
      if (process.platform === 'linux') console.log(chalk.gray(`   Biểu tượng khay:    ${st.tray ? 'có' : 'không (thiếu python3 + AppIndicator) — vẫn chạy nền'}`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Update aivin to the latest release (installs from get.aivin.vn; checks the release signature, the SHA256 and that the new build starts)')
  .option('--check', 'Only check whether a newer release exists')
  .option('--to <version>', 'Install this release instead of the latest, e.g. v1.0.9 (also allows going back)')
  .option('--auto <on|off>', 'Turn background updates of `aivin remote start` on or off for this computer')
  .option('--proxy <url>', 'HTTP proxy to download through (default: HTTPS_PROXY, else the system proxy setting; "none" = connect directly)')
  .action(async (options) => {
    try {
      if (options.auto !== undefined) {
        const value = String(options.auto).toLowerCase();
        if (!['on', 'off'].includes(value)) throw new Error('Dùng: aivin update --auto on|off');
        saveUpdateSettings({ auto: value === 'on' });
        console.log(chalk.green(value === 'on' ? '✅ Đã bật tự cập nhật nền.' : '✅ Đã tắt tự cập nhật nền — cập nhật bằng `aivin update` khi cần.'));
        return;
      }
      configureProxy({ explicit: options.proxy });
      if (isStandaloneBinary()) cleanupRetired();
      const root = downloadRoot();
      const res = await installUpdate({ version: options.to, root, check: !!options.check, force: !!options.to });
      if (res.status === UpdateStatus.UP_TO_DATE) return console.log(chalk.green(`✅ aivin ${res.current} là bản mới nhất.`));
      if (res.status === UpdateStatus.NOT_BINARY) {
        return console.log(chalk.yellow(`⬆  Có aivin ${res.latest} (máy này ${res.current}). Bản cài qua npm: npm i -g @aivin-labs/cli@latest`));
      }
      if (res.status === UpdateStatus.AVAILABLE) return console.log(chalk.yellow(`⬆  Có aivin ${res.latest} (máy này ${res.current}) — chạy \`aivin update\` để cài.`));
      if (res.status === UpdateStatus.SKIPPED) {
        return console.log(chalk.yellow(`⚠️  Máy này đã tự lùi khỏi aivin ${res.latest} (khởi động hỏng). Vẫn muốn cài: aivin update --to ${res.latest}`));
      }
      if (res.status === UpdateStatus.BUSY) return console.log(chalk.yellow('⏳ Đang có một lần cập nhật khác chạy trên máy này — thử lại sau ít phút.'));
      console.log(chalk.green(`✅ Đã cài aivin ${res.latest} (trước đó ${res.current}).`));
      console.log(chalk.gray('   `aivin remote start` chạy nền (tự khởi động cùng máy) tự chuyển sang bản mới khi máy rảnh; cửa sổ đang mở thì đóng và chạy lại.'));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const remoteCommand = program
  .command('remote')
  .description('Let your Aivin agents work on this computer (Device Agent) - pair, run the listener, manage memory and safety')
  // Proxy công ty cho mọi lệnh remote gọi máy chủ (ghép máy, remote do, test…) — `start` tự cấu hình kèm --proxy của nó.
  .hook('preAction', (_cmd, action) => { if (action.name() !== 'start') configureProxy({ explicit: action.opts().proxy }); });

const remoteFail = (error) => {
  console.error(chalk.red('❌'), error.message);
  process.exit(1);
};

remoteCommand
  .command('start')
  .description('Pair this computer (first time) and listen for work from your agents in the foreground')
  .option('--dir <path>', 'Folder the agent may work in (default: the folder saved at pairing, else the current folder)')
  .option('--name <name>', 'Name shown for this computer (default: hostname)')
  .option('--repair', 'Pair again (new device token; the old one stops working)')
  .option('--full-access', 'Let the agent work anywhere on this computer (all drives; relative paths start at your home folder). Kept across restarts; --dir switches back to one folder')
  .option('--code <code>', 'Pair with a one-time code from Aivin (chat box → Browser ▾ → Add this computer) - no `aivin login` needed')
  .option('--server <url>', 'Aivin server the code belongs to (Aivin prints it in the command when needed)')
  .option('--no-browser', "Don't let AI Browser use a browser window on this computer (web tasks then run in Aivin's server-side browser)")
  .option('--no-gui', "Don't let the agent control app windows on this computer with the mouse/keyboard (Windows)")
  .option('--no-meetings', "Don't let the agent take notes of meetings (record the computer's sound + microphone) or take screenshots on this computer (Windows)")
  .option('--separate-browser', "Always use Aivin's own browser window, never your everyday Chrome/Edge (even if remote debugging is enabled at chrome://inspect/#remote-debugging)")
  .option('--quiet', 'No interactive logs')
  .option('--proxy <url>', 'HTTP proxy to reach Aivin through (default: HTTPS_PROXY, else the system proxy setting; "none" = connect directly)')
  .option('--no-keep-awake', "Don't keep this computer from sleeping while the agent is working on it")
  .option('--no-auto-update', "Don't download new aivin releases in the background this run (to turn it off for good: aivin update --auto off)")
  .option('--no-mascot', "Don't show the Aivin mascot on screen this run (to turn it off for good: aivin remote mascot off)")
  .option('--multi-user', "Organization cloud computer (Linux container provisioned by Aivin): token from AIVIN_DEVICE_TOKEN/AIVIN_DEVICE_ID/AIVIN_SERVER, every org member works in their own Linux account + home folder")
  .action(async (options) => {
    try {
      await startRemoteClient(options);
    } catch (error) {
      // Tự khởi động (--quiet) mà đã có cửa sổ khác nhận việc: không phải lỗi — thoát 0 để trình giữ chạy không chạy lại mãi.
      if (error?.code === DAEMON_RUNNING && options.quiet) {
        console.error(chalk.gray(error.message));
        process.exit(0);
      }
      // Vừa tự lùi bản: có trình giữ chạy → mã 75, được mở lại ngay bằng bản cũ.
      if (error?.code === UPDATE_ROLLED_BACK) {
        console.error(chalk.yellow(`↩  ${error.message}`));
        process.exit(error.restart ? RESTART_EXIT_CODE : 1);
      }
      remoteFail(error);
    }
  });

remoteCommand
  .command('pair')
  .description('Pair (or re-pair) this computer with your account without starting the listener')
  .option('--dir <path>', 'Folder the agent may work in (default: current folder)')
  .option('--name <name>', 'Name shown for this computer (default: hostname)')
  .option('--code <code>', 'Pair with a one-time code from Aivin (chat box → Browser ▾ → Add this computer) - no `aivin login` needed')
  .option('--server <url>', 'Aivin server the code belongs to')
  .option('--full-access', 'Let the agent work anywhere on this computer (with --code)')
  .action(async (options) => {
    try {
      if (options.code) {
        // Bộ cài (đã có khay): chỉ ghép — khay mở listener ngay khi thấy máy đã ghép.
        const { creds, stopped } = await pairWithCodeOnly(options);
        console.log(chalk.green(`✅ Đã kết nối máy "${creds.name}" với tài khoản Aivin của bạn — quay lại Aivin để chọn máy này.`));
        if (stopped) console.log(chalk.gray('   Đã dừng phiên nhận việc cũ — Aivin mở lại bằng kết nối mới.'));
        return;
      }
      const roots = [path.resolve(options.dir || process.cwd())];
      const creds = await pairDevice({ serverUrl: missionServerUrl(), apiKey: process.env.API_KEY, roots, name: options.name, profile: buildDeviceProfile(roots) });
      console.log(chalk.green(`✅ Đã ghép máy "${creds.name}" (${creds.device_id})`));
      console.log(chalk.gray(`   Thư mục được phép: ${creds.roots.join(' | ')}`));
      console.log(chalk.gray('   Chạy `aivin remote start` để bắt đầu nhận việc.'));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('devices')
  .description('List computers paired with your account and whether they are online')
  .action(async () => {
    try {
      const devices = await listDevices({ serverUrl: missionServerUrl(), apiKey: process.env.API_KEY });
      const mine = loadDeviceCredentials()?.device_id;
      if (!devices.length) return console.log(chalk.gray('Chưa có máy nào được ghép. Chạy `aivin remote start` trên máy cần dùng.'));
      for (const d of devices) {
        const state = d.online ? chalk.green('● online') : chalk.gray('○ offline');
        console.log(`${state}  ${chalk.bold(d.name)}${d.device_id === mine ? chalk.cyan(' (máy này)') : ''}  ${chalk.gray(`${d.platform || ''} · ${d.tools_count} công cụ · ${d.device_id}`)}`);
      }
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('unpair [deviceId]')
  .description('Revoke a paired computer (default: this one) - its token stops working immediately')
  .action(async (deviceId) => {
    try {
      const target = deviceId || loadDeviceCredentials()?.device_id;
      if (!target) throw new Error('Máy này chưa được ghép.');
      await unpairDevice({ serverUrl: missionServerUrl(), apiKey: process.env.API_KEY, deviceId: target });
      console.log(chalk.green(`✅ Đã thu hồi máy ${target}.`));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('pause')
  .description('Kill switch: refuse every remote call on this computer until `aivin remote resume`')
  .action(() => {
    setRemotePaused(true);
    console.log(chalk.yellow('⏸  Đã tạm dừng — máy này từ chối mọi việc từ xa.'));
  });

remoteCommand
  .command('mascot [action] [combo]')
  .description('The Aivin mascot floating on screen while the listener runs (Windows): on | off — no argument shows the current setting; hotkey [combo|off|default] — the key combination that calls the mascot (default Win+Alt+Space)')
  .action((action, combo) => {
    const lang = mascotLang();
    if (action === 'hotkey') {
      try {
        const setting = loadMascotSettings().hotkey;
        if (!combo) {
          const active = hotkeyCandidates(setting);
          if (!active.length) return console.log('Phím tắt gọi linh vật: tắt (bật lại: aivin remote mascot hotkey default)');
          return console.log(`Phím tắt gọi linh vật: ${active[0].label}${setting ? '' : ' (mặc định)'} — không đăng ký được thì thử lần lượt: ${active.slice(1).map((h) => h.label).join(', ')}`);
        }
        if (combo === 'off') { saveMascotSettings({ hotkey: 'off' }); return console.log(chalk.green('✅ Đã tắt phím tắt gọi linh vật.')); }
        if (combo === 'default') { saveMascotSettings({ hotkey: null }); return console.log(chalk.green(`✅ Dùng phím tắt mặc định ${DEFAULT_HOTKEYS[0]}.`)); }
        const hotkey = parseHotkey(combo);
        const free = probeHotkey(hotkey);
        if (free === false) {
          console.log(chalk.yellow(`⚠️  ${hotkey.label} đang bị một ứng dụng khác (hoặc chính linh vật đang chạy) giữ — nếu không phải linh vật thì chọn tổ hợp khác.`));
        }
        saveMascotSettings({ hotkey: hotkey.label });
        return console.log(chalk.green(`✅ Phím tắt gọi linh vật: ${hotkey.label} — có hiệu lực khi linh vật khởi động lại (aivin remote start).`));
      } catch (error) {
        return remoteFail(error);
      }
    }
    if (action && !['on', 'off'].includes(action)) remoteFail(new Error(mascotText(lang, MascotText.CMD_USAGE)));
    if (process.platform !== 'win32') console.log(chalk.gray(mascotText(lang, MascotText.CMD_UNSUPPORTED)));
    if (!action) return console.log(mascotText(lang, loadMascotSettings().enabled ? MascotText.CMD_STATUS_ON : MascotText.CMD_STATUS_OFF));
    saveMascotSettings({ enabled: action === 'on' });
    console.log(chalk.green(`✅ ${mascotText(lang, action === 'on' ? MascotText.CMD_ON : MascotText.CMD_OFF)}`));
  });

remoteCommand
  .command('meeting [action] [title...]')
  .description('Meeting notes on this computer (Windows, needs `aivin remote start` running): start [title] | stop | status | list | show [id] — records the computer\'s sound (the others) + your microphone, transcribes it when the meeting ends')
  .option('--then <instruction>', 'start: what Aivin should do with the transcript afterwards, e.g. "summarize and draft an email to my manager"')
  .option('--lang <vi|en>', 'start: language spoken in the meeting')
  .option('--no-screens', "start: don't save screenshots when the screen changes")
  .action(async (action = 'status', titleWords = [], options) => {
    try {
      const fmt = (s) => { const m = Math.floor((s || 0) / 60); return `${m} phút ${String((s || 0) % 60).padStart(2, '0')} giây`; };
      if (action === 'start') {
        const res = await requestMeeting('start', { title: titleWords.join(' '), then: options.then, lang: options.lang, screens: options.screens });
        console.log(chalk.green(`🎙️  Đang ghi "${res.title}" (id ${res.id})${res.sources && !res.sources.mic ? ' — không mở được micro' : ''}${res.sources && !res.sources.system ? ' — không mở được âm thanh máy' : ''}.`));
        console.log(chalk.yellow('   Hãy báo cho mọi người trong cuộc họp biết họ đang được ghi âm.'));
        console.log(chalk.gray('   Tự dừng khi cửa sổ họp đóng / im lặng lâu; dừng tay: aivin remote meeting stop'));
        return;
      }
      if (action === 'stop') {
        const res = await requestMeeting('stop', { id: titleWords[0] });
        console.log(chalk.green(`⏹  Đã dừng ghi "${res.title}" (${fmt(res.duration_s)}) — đang làm biên bản, xem: aivin remote meeting status`));
        return;
      }
      const meetings = createMeetingManager({ media: null });
      if (action === 'list' || action === 'status') {
        const list = meetings.list({ limit: action === 'list' ? 20 : 5 });
        if (!list.length) return console.log(chalk.gray('Chưa ghi cuộc họp nào trên máy này. Bắt đầu: aivin remote meeting start "Tên cuộc họp"'));
        for (const m of list) {
          const when = new Date(m.started_at).toLocaleString('vi-VN');
          console.log(`${m.status === 'recording' ? '🔴' : m.status === 'done' ? '✅' : m.status === 'failed' ? '❌' : '⏳'} ${m.title}  ${chalk.gray(`${when} · ${fmt(m.duration_s)} · ${m.status}${m.follow_up ? ` · việc sau họp: ${m.follow_up}` : ''} · ${m.id}`)}`);
        }
        return;
      }
      if (action === 'show') {
        const t = meetings.transcript({ id: titleWords[0], max_chars: 100_000 });
        console.log(t.text || chalk.gray(t.note));
        return;
      }
      remoteFail(new Error('Usage: aivin remote meeting start [title] [--then "..."] | stop | status | list | show [id]'));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('policy [action] [value]')
  .description('Rules enforced on this computer itself (Aivin cannot change them): which steps need a click on this computer, tools turned off, extra blocked commands')
  .action(async (action, value) => {
    try {
      await runPolicyCommand(action, value);
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('resume')
  .description('Turn the kill switch off')
  .action(() => {
    setRemotePaused(false);
    console.log(chalk.green('▶  Máy này nhận việc từ xa trở lại.'));
  });

remoteCommand
  .command('enable')
  .description('Start the listener automatically when this computer starts (Windows: the Aivin tray app, listed in Task Manager → Startup apps)')
  .option('--dir <path>', 'Folder the agent may work in (default: current folder)')
  .option('--proxy <url>', 'HTTP proxy the auto-started listener should use (default: detect at every start)')
  .action((options) => {
    try {
      const res = enableAutoStart(options);
      console.log(chalk.green('✅ Đã bật tự khởi động cùng máy.'));
      console.log(chalk.gray(`   Thư mục: ${res.rootDir}`));
      console.log(chalk.gray(`   Tệp khởi động: ${res.filePath}`));
      if (res.warning) console.log(chalk.yellow(`   ⚠️  ${res.warning}`));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('disable')
  .description('Stop starting the listener with this computer')
  .action(() => {
    try {
      disableAutoStart();
      console.log(chalk.green('✅ Đã tắt tự khởi động cùng máy.'));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('status')
  .description('Show pairing, allowed folders, kill switch, auto-start, tools and memory of this computer')
  .action(() => {
    try {
      const creds = loadDeviceCredentials();
      const roots = creds?.roots?.length ? creds.roots : [process.cwd()];
      const profile = buildDeviceProfile(roots);
      const { catalog, hash } = buildCatalog(buildTools({ roots, binaries: profile.binaries, projects: profile.projects }));
      const stats = memoryStats();
      console.log(chalk.blue('💻 Máy này:'));
      console.log(chalk.gray(`   Mã máy:        ${getOrCreateDeviceId()}`));
      console.log(chalk.gray(`   Đã ghép:       ${creds ? chalk.green(`có — ${creds.name} @ ${creds.server_url}`) : chalk.yellow('chưa')}`));
      console.log(chalk.gray(`   Thư mục:       ${roots.join(' | ')}`));
      console.log(chalk.gray(`   Công tắc ngắt: ${isRemotePaused() ? chalk.yellow('ĐANG TẠM DỪNG') : 'tắt'}`));
      console.log(chalk.gray(`   Tự khởi động:  ${getAutoStartStatus().enabled ? 'bật' : 'tắt'}`));
      console.log(chalk.gray(`   Chương trình:  ${profile.binaries.join(', ') || '-'}`));
      console.log(chalk.gray(`   Dự án:         ${profile.projects.map((p) => `${p.name} (${p.kind})`).join(', ') || '-'}`));
      console.log(chalk.gray(`   Ghi nhớ:       ${stats.total} mục (${stats.with_vector} có vector) — ${stats.dir}`));
      console.log(chalk.blue(`\n🛠️  ${catalog.length} công cụ (dấu vân tay ${hash.slice(0, 12)}):`));
      for (const t of catalog) console.log(`   - ${chalk.cyan(t.name)}${t.read_only ? chalk.gray(' [chỉ đọc]') : t.destructive ? chalk.red(' [không hoàn tác]') : chalk.yellow(' [ghi]')}`);
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('test')
  .description('Check the server connection and whether the server sees this computer online')
  .action(async () => {
    try {
      const r = await testRemoteConnection();
      console.log(chalk.gray(`   Máy chủ:   ${r.serverUrl} — ${r.httpOk ? chalk.green(`thông (${r.latencyMs} ms)`) : chalk.red('không kết nối được')}`));
      console.log(chalk.gray(`   Đã ghép:   ${r.paired ? `có (${r.deviceId})` : chalk.yellow('chưa — chạy aivin remote start')}`));
      if (r.online !== null) console.log(chalk.gray(`   Online:    ${r.online ? chalk.green('có') : chalk.yellow(r.registered === false ? 'máy chủ không có máy này (đã thu hồi?)' : 'không — chạy aivin remote start')}`));
      if (r.error) console.log(chalk.yellow(`   ⚠️  ${r.error}`));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('logs')
  .description('Recent remote activity on this computer')
  .option('--limit <n>', 'Entries to show (default 30)', '30')
  .option('--clear', 'Clear the activity log')
  .action((options) => {
    if (options.clear) {
      clearLogs();
      return console.log(chalk.green('✅ Đã xoá nhật ký.'));
    }
    const logs = getRecentLogs(options.limit);
    if (!logs.length) return console.log(chalk.gray('Chưa có hoạt động nào.'));
    for (const log of logs) {
      const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
      if (log.type === 'tool_call') console.log(`  [${time}] ${log.success ? chalk.green('✓') : chalk.red('✗')} ${chalk.cyan(log.tool)}${log.ms !== undefined ? chalk.gray(` ${log.ms} ms`) : ''} ${log.error ? chalk.red(log.error) : ''}`);
      else console.log(`  [${time}] ${chalk.gray(log.type)} ${chalk.gray(log.reason || log.serverUrl || '')}`);
    }
  });

remoteCommand
  .command('memory [action] [value...]')
  .description('On-device memory (~/.aivin/memory/*.yaml): list [kind] | search <words> | add <text> | forget <id> | clear [kind]')
  .option('--kind <kind>', `Kind: ${Object.values(MemoryKind).join(', ')}`)
  .option('--key <key>', 'Stable key for add (default: derived from the text)')
  .action((action = 'list', valueParts = [], options) => {
    try {
      const value = valueParts.join(' ').trim();
      if (action === 'search') {
        if (!value) throw new Error('Dùng: aivin remote memory search <từ khoá>');
        const hits = searchMemory({ query: value, kinds: options.kind ? [options.kind] : undefined, limit: 20 });
        if (!hits.length) return console.log(chalk.gray('Không có mục nào khớp.'));
        hits.forEach((h) => console.log(`  ${chalk.gray(h.id)} [${h.kind}] ${chalk.bold(h.key)}: ${h.text}`));
        return;
      }
      if (action === 'add') {
        if (!value) throw new Error('Dùng: aivin remote memory add "<nội dung>" --kind fact --key <khoá>');
        const kind = options.kind || MemoryKind.FACT;
        const key = options.key || value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60);
        putMemoryItems([{ kind, key, text: value }]);
        return console.log(chalk.green(`✅ Đã nhớ [${kind}] ${key}`));
      }
      if (action === 'forget') {
        if (!value) throw new Error('Dùng: aivin remote memory forget <id> (xem id bằng memory list / search)');
        const res = deleteMemoryItems({ ids: value.split(/[\s,]+/) });
        return console.log(chalk.green(`✅ Đã quên ${res.deleted} mục.`));
      }
      if (action === 'clear') {
        clearDeviceMemory(value || options.kind || undefined);
        return console.log(chalk.green('✅ Đã xoá bộ nhớ.'));
      }
      const page = listMemoryItems({ kind: value || options.kind, limit: 100 });
      const stats = memoryStats();
      console.log(chalk.blue(`🧠 Bộ nhớ trên máy: ${stats.total} mục — ${stats.dir} (sửa tay các tệp .yaml được)`));
      page.items.forEach((i) => console.log(`  ${chalk.gray(i.id)} [${i.kind}] ${chalk.bold(i.key)}: ${String(i.text).slice(0, 160)}`));
      if (page.next_cursor !== null) console.log(chalk.gray(`  … còn ${page.total - page.items.length} mục`));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('reindex')
  .description('Rebuild the file index of the allowed folders now')
  .action(async () => {
    try {
      const creds = loadDeviceCredentials();
      const index = createFileIndex(indexRootsFor(creds?.roots || [process.cwd()], creds?.access === DeviceAccess.FULL));
      const stats = await index.build();
      index.close();
      console.log(chalk.green(`✅ Chỉ mục: ${stats.files} tệp (${stats.updated} cập nhật, ${stats.removed} bỏ) trong ${stats.ms} ms`));
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('index [action] [folder]')
  .description('Working folders indexed fully (code too) so agents find everything in them instantly: list (default) | add <folder> | remove <folder>. Agents add one themselves when you tell them in chat where you work')
  .action((action = 'list', folder) => {
    try {
      const creds = loadDeviceCredentials();
      if (action === 'list') {
        const folders = loadIndexFolders();
        if (!folders.length) return console.log(chalk.gray('Chưa có thư mục làm việc nào. Thêm: aivin remote index add <thư mục>'));
        return folders.forEach((f) => console.log(`📁 ${f}`));
      }
      if (!['add', 'remove'].includes(action) || !folder) throw new Error('Dùng: aivin remote index [list | add <thư mục> | remove <thư mục>]');
      // Chỉ trong thư mục máy cho phép — chỉ mục ngoài đó trả về tệp mà agent không mở được.
      const abs = creds?.roots?.length ? resolveInRoots(creds.roots, folder) : path.resolve(folder);
      if (action === 'add') {
        if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Không phải thư mục: ${abs}`);
        saveIndexFolders([...loadIndexFolders(), abs]);
        console.log(chalk.green(`✅ Đã thêm thư mục làm việc ${abs} — listener đang chạy sẽ lập chỉ mục trong vài giây.`));
      } else {
        saveIndexFolders(loadIndexFolders().filter((f) => f !== abs));
        console.log(chalk.green(`✅ Đã bỏ thư mục làm việc ${abs}`));
      }
    } catch (error) {
      remoteFail(error);
    }
  });

remoteCommand
  .command('reset-id')
  .description('Give this computer a new device id (cloned machines) - you must pair again')
  .action(() => {
    const id = resetDeviceId();
    console.log(chalk.green(`✅ Mã máy mới: ${id} — chạy \`aivin remote start\` để ghép lại.`));
  });

remoteCommand
  .command('do [objective]')
  .description('Give a job to the Device Agent on your computer (the listener must be running there)')
  .option('--device <name>', 'Which paired computer (default: your online one)')
  .option('--cwd <path>', 'Folder the job is about')
  .option('--file <id...>', 'Aivin workspace file id(s) the job may save onto the computer')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--agent <id>', 'Agent to act as (default: the workspace default agent)')
  .option('--no-watch', 'Do not stream progress')
  .action(async (objective, options) => {
    try {
      objective = await requireArg(objective, { prompt: 'What should the agent do on your computer?', usage: 'Usage: aivin remote do "<job>"' });
      await runRemoteMission(objective, options);
    } catch (error) {
      remoteFail(error);
    }
  });

const doCommand = program
  .command('do [agentNickname] [mission]')
  .description("Have <agentNickname> work toward a goal in the background - not a specific deployed plugin")
  .option('--workspace <id>', 'Workspace id to run in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace')
  .option('--no-watch', 'Fire the mission and return immediately - skip streaming live progress')
  .action(async (agentNickname, mission, options) => {
    try {
      mission = await requireArg(mission, {
        prompt: 'What should the agent do?',
        usage: 'Usage: aivin do <agent_nickname> "<mission detail>"  (or: aivin do job "<automation job description>")',
      });
      await runMission(agentNickname, mission, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

doCommand
  .command('job [description]')
  .description('Create a new automation job from a plain-language description')
  .option('--workspace <id>', 'Workspace id to create the job in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace')
  .option('--agent <id>', "Agent id the job runs as (default: the workspace's default agent)")
  .option('--schedule <condition>', 'Natural-language schedule, e.g. "every Monday at 9am" (default: let the platform infer one)')
  .action(async (description, options) => {
    try {
      description = await requireArg(description, { prompt: 'What should this automation job do?', usage: 'Usage: aivin do job "<automation job description>"' });
      await createAutomationJob(description, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const taskCommand = program
  .command('task [description]')
  .description('Create a new task from a plain-language description')
  .option('--workspace <id>', 'Workspace id to create the task in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace')
  .option('--assignee <userId>', 'User id to assign the task to (default: unassigned)')
  .action(async (description, options) => {
    try {
      description = await requireArg(description, {
        prompt: 'What is this task?',
        usage: 'Usage: aivin task "<description>"  (or: aivin task list/mine/get/update/delete)',
      });
      await createTask(description, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('list')
  .description('List tasks in a project')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--project <id>', "Project id (default: the workspace's first project)")
  .option('--status <status>', 'Filter by status (todo/doing/done/backlog/cancel)')
  .option('--assignee <userId>', 'Filter by assignee user id')
  .option('--search <text>', 'Filter by search text')
  .action(async (options) => {
    try {
      await listTasks(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('mine')
  .description('List tasks assigned to you in a project')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--project <id>', "Project id (default: the workspace's first project)")
  .action(async (options) => {
    try {
      await listMyTasks(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('get [id]')
  .description('Get a task by id')
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Task id:', usage: 'Usage: aivin task get <id>' });
      await getTaskById(id);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('update [id]')
  .description('Update a task')
  .option('--status <status>', 'todo|doing|done|backlog|cancel')
  .option('--title <title>', 'New title')
  .option('--description <text>', 'New content/description')
  .option('--assignee <userId>', 'Reassign to this user id')
  .option('--priority <priority>', 'low|medium|high|urgent')
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Task id:', usage: 'Usage: aivin task update <id>' });
      await updateTaskById(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('delete [id]')
  .description('Delete a task')
  .option('-y, --yes', 'Skip the confirmation prompt (for scripts/CI)')
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Task id to delete:', usage: 'Usage: aivin task delete <id>' });
      await deleteTaskById(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

program
  .command('workspace')
  .description('Browse your workspaces and projects, and pick one to use with --workspace/--project')
  .option('--plain', 'Print a flat list instead of the interactive picker (for scripts/CI)')
  .action(async (options) => {
    try {
      await pickWorkspaceAndProject(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const agentCommand = program.command('agent').description('List, search, install, create, and publish AI Staff agents');

agentCommand
  .command('list')
  .description('Browse agents already installed in a workspace (↑/↓ to move, space/enter for details, q to quit)')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--plain', 'Print a flat list instead of the interactive browser (for scripts/CI)')
  .action(async (options) => {
    try {
      await listAgentsCmd(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

agentCommand
  .command('search [query]')
  .description('Search the AI Staff marketplace for an agent')
  .option('--workspace <id>', 'Workspace id for context (default: your personal workspace)')
  .option('--limit <n>', 'Max results to show')
  .action(async (query, options) => {
    try {
      query = await requireArg(query, { prompt: 'What are you looking for?', usage: 'Usage: aivin agent search "<query>"' });
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
      const results = await searchAgents(serverUrl, authHeaders, {
        query,
        workspaceId: workspace.id || workspace._id,
        limit: options.limit,
      });
      if (results.length === 0) {
        console.log(chalk.yellow(`No agents found matching "${query}".`));
        return;
      }
      console.log(chalk.blue(`Found ${results.length} agent(s) matching "${query}":\n`));
      results.forEach((a) => {
        console.log(chalk.bold(a.nickname || a.name) + chalk.gray(`  (${a.id})`));
        if (a.bio) console.log(`  ${a.bio}`);
        console.log();
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

agentCommand
  .command('install [query]')
  .description('Search the marketplace and install an agent into a workspace')
  .option('--workspace <id>', 'Workspace id to install into (default: your personal workspace)')
  .action(async (query, options) => {
    try {
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
      const workspaceId = workspace.id || workspace._id;

      let picked;
      if (query) {
        const results = await searchAgents(serverUrl, authHeaders, { query, workspaceId, limit: 10 });
        if (results.length === 0) throw new Error(`No marketplace agents found matching "${query}".`);
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          picked = results[0];
        } else {
          const { pickedAgent } = await inquirer.prompt([
            {
              type: 'select',
              name: 'pickedAgent',
              message: 'Install which agent?',
              choices: results.map((a) => ({ name: `${a.nickname || a.name}${a.bio ? chalk.gray(`  - ${a.bio}`) : ''}`, value: a })),
            },
          ]);
          picked = pickedAgent;
        }
      } else {
        picked = await installAgentInteractive(serverUrl, authHeaders, workspaceId);
        console.log(chalk.gray(`Installed into ${workspace.name || workspaceId}.`));
        return;
      }

      await pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId: picked.id, workspaceId });
      console.log(chalk.green(`✅ Installed "${picked.nickname || picked.name}" into ${workspace.name || workspaceId}.`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

agentCommand
  .command('make')
  .description('Create a brand new AI Staff agent')
  .option('--name <name>', 'Agent name')
  .option('--nickname <nickname>', 'Agent nickname (used to @-mention/target it)')
  .option('--email <email>', 'Agent email')
  .option('--bio <bio>', 'Short bio')
  .option('--workspace <id>', 'Workspace to install the new agent into (default: your personal workspace)')
  .action(async (options) => {
    try {
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

      const canPrompt = process.stdout.isTTY && process.stdin.isTTY;
      const answers = { name: options.name, nickname: options.nickname, email: options.email, bio: options.bio };
      if ((!answers.name || !answers.nickname || !answers.email) && canPrompt) {
        const prompted = await inquirer.prompt(
          [
            !answers.name && { type: 'input', name: 'name', message: 'Agent name:', validate: (v) => v.trim().length > 0 || 'Required' },
            !answers.nickname && {
              type: 'input',
              name: 'nickname',
              message: 'Agent nickname (used to @-mention/target it):',
              validate: (v) => v.trim().length > 0 || 'Required',
            },
            !answers.email && { type: 'input', name: 'email', message: 'Agent email:', validate: (v) => v.trim().length > 0 || 'Required' },
            !answers.bio && { type: 'input', name: 'bio', message: 'Short bio (optional):' },
          ].filter(Boolean),
        );
        Object.assign(answers, prompted);
      }
      if (!answers.name || !answers.nickname || !answers.email) {
        throw new Error('Usage: aivin agent make --name <name> --nickname <nickname> --email <email> [--bio <bio>]');
      }

      const agent = await createAgent(serverUrl, authHeaders, { ...answers, workspaceId: workspace.id || workspace._id });
      console.log(chalk.green(`✅ Created agent "${agent.nickname || agent.name}"!`));
      if (agent.id) console.log(chalk.gray(`   ID: ${agent.id}`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

agentCommand
  .command('publish [agentId]')
  .description('Publish an agent you own to the marketplace')
  .option('--workspace <id>', 'Workspace the agent lives in (default: your personal workspace)')
  .action(async (agentId, options) => {
    try {
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

      if (!agentId) {
        const agents = workspace.agents || [];
        if (agents.length === 0) throw new Error(`Workspace "${workspace.name}" has no agents to publish.`);
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          throw new Error('Usage: aivin agent publish <agentId>');
        }
        const { pickedAgentId } = await inquirer.prompt([
          {
            type: 'select',
            name: 'pickedAgentId',
            message: 'Publish which agent?',
            choices: agents.map((a) => ({ name: a.nickname || a.name || a.id, value: a.id || a.agent_id })),
          },
        ]);
        agentId = pickedAgentId;
      }

      await publishAgent(serverUrl, authHeaders, { agentId, workspaceId: workspace.id || workspace._id });
      console.log(chalk.green(`✅ Published agent ${agentId} to the marketplace.`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const projectCommand = program.command('project').description('List, create, update, and delete projects within a workspace');

projectCommand
  .command('list')
  .description('List projects in a workspace')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .action(async (options) => {
    try {
      await listProjectsCmd(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

projectCommand
  .command('create [name]')
  .description('Create a new project in a workspace')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .action(async (name, options) => {
    try {
      name = await requireArg(name, { prompt: 'Project name:', usage: 'Usage: aivin project create <name>' });
      await createProjectCmd(name, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

projectCommand
  .command('update [id]')
  .description('Update a project (currently: rename)')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--name <name>', 'New name')
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Project id:', usage: 'Usage: aivin project update <id> --name <new name>' });
      await updateProjectCmd(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

projectCommand
  .command('delete [id]')
  .description('Delete a project')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('-y, --yes', 'Skip the confirmation prompt (for scripts/CI)')
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Project id to delete:', usage: 'Usage: aivin project delete <id>' });
      await deleteProjectCmd(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

export {
  validatePluginConfig,
  incrementVersion,
  validateMcpProxyConfig,
  buildDeploymentPayload,
  buildMcpManifest,
  parseMcpArgs,
  guessConnectorQueryFromEnvVarName,
  setFieldConnector,
  buildRegisterConnectorDto,
  buildCreateTaskPayload,
  buildDeviceProfile,
  buildTools,
  buildCatalog,
  enableAutoStart,
  disableAutoStart,
  getAutoStartStatus,
  resetDeviceId,
  getRecentLogs,
  clearLogs,
  testRemoteConnection,
  runRemoteMission,
};

// Only parse argv when run directly (`aivin ...` / `node bin/cli.mjs ...`),
// not when this module is imported (e.g. by tests) - otherwise Commander
// would parse the importing process's argv and could call process.exit().
//
// `import.meta.url` is always the module's real (symlink-resolved) path, but `process.argv[1]` is
// whatever literal path launched it - through `npm link`'s global shim that's a symlink
// (~/AppData/Roaming/npm/node_modules/@aivin-labs/sdk/bin/cli.mjs -> this repo), which would never
// string-equal the resolved URL and silently skip program.parse() entirely (global `aivin` would
// do nothing at all). Resolve argv[1] through the same symlink before comparing.
function resolveIsMain() {
  // Tệp chạy đóng gói: chính nó là chương trình, không có chuyện bị import.
  if (process.env.AIVIN_CLI_BINARY) return true;
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (resolveIsMain()) {
  program.parse(process.argv);
}
