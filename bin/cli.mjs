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

import { DEFAULT_AIVIN_BASE_URL, GLOBAL_CREDENTIALS_PATH, fetchWebUrl, loadActiveContext, clearActiveContext } from './lib/context.mjs';
import { requireArg } from './lib/util.mjs';
import { readStdin, createFromJSON, createInteractive, validatePluginConfig, validateMcpProxyConfig } from './lib/scaffold.mjs';
import { buildDeploymentPayload, deployPlugin, incrementVersion } from './lib/deploy.mjs';
import { initInteractive, makePluginFromDescription, convertExistingProject } from './lib/codegen.mjs';
import { searchPlugins, showPluginInfo, askPlugin, streamPluginLogs, triggerPlugin, deletePluginCmd } from './lib/pluginTrigger.mjs';
import { connectorAuthHeaders, connectorBaseUrl, listConnectors, registerConnector, searchConnectors } from './lib/connectors.mjs';
import { attachStore, createStore, deleteStore, detachStore, listStores, removeNode, setStoreEnabled } from './lib/store.mjs';
import { buildMcpManifest, parseMcpArgs, guessConnectorQueryFromEnvVarName, createMcpProxyPlugin, scanAndPublishMcp, registerMcpWatch, unwatchMcp, listMcpWatches } from './lib/mcpProxy.mjs';
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
import {
  createAutomationJob,
  listTasks,
  listMyTasks,
  getTaskById,
  updateTaskById,
  deleteTaskById,
  createTask,
  pickWorkspaceAndProject,
  createProjectCmd,
  updateProjectCmd,
  deleteProjectCmd,
  listProjectsCmd,
} from './lib/tasks.mjs';

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
const CLI_PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

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
  .option('-i, --input <json>', 'Force specific fields (as JSON) alongside the auto-mapped ones - explicit fields win')
  .option('--workspace <id>', 'Workspace id to search/run against (default: auto-picks your first one)')
  .option('--agent <id>', 'Agent id to run as, if the plugin needs one for HIL/confirm behavior to be accurate')
  .option('--watch-logs', "Also stream the chosen plugin's own live console output inline")
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
  .option('-a, --auto <prompt>', 'Natural-language prompt - the platform auto-maps it onto the input schema for you')
  .option('--id <pluginId>', 'Plugin id to trigger directly - skips the local manifest.json lookup (e.g. for `aivin mcp` plugins, which have no local project directory)')
  .option('--func <name>', 'Which function to trigger, for a multi-function plugin (matches name/func/id) - ignored when --id is given')
  .option('--workspace <id>', 'Workspace id to run against (default: auto-picks your first one)')
  .option('--agent <id>', 'Agent id to run as, if the plugin needs one for HIL/confirm behavior to be accurate')
  .option('--watch-logs', 'Also stream the plugin\'s own live console output inline (same feed as `aivin plugin logs`) instead of needing a second terminal - requires permission to view that plugin\'s logs (your own/org\'s deployments; most store plugins from other orgs will just skip this and fall back to the REST result only)')
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
  .description("Run an AI Browser mission - by default opens/reuses a local browser window dedicated to AI Browser (own profile, own cookies - log in once, watch missions run live from then on); --remote uses a server-side browser instead")
  .option('--remote', 'Use a server-side pooled browser instead of your own local one (no local browser needed, no cookies/logins carried over)')
  .option('--debug-port <port>', 'Local mode only: port to look for/launch your browser\'s remote debugging on (default: 9222, auto-tries a few nearby ports if that one is taken by something else) - pass this to pin an exact port instead')
  .option('--browser <edge|chrome>', "Local mode only: which browser to drive - default: auto-detects your OS's actual default browser, falling back to whichever of Edge/Chrome is installed if that can't be determined")
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
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Task id to delete:', usage: 'Usage: aivin task delete <id>' });
      await deleteTaskById(id);
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
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Project id to delete:', usage: 'Usage: aivin project delete <id>' });
      await deleteProjectCmd(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

export { validatePluginConfig, incrementVersion, validateMcpProxyConfig, buildDeploymentPayload, buildMcpManifest, parseMcpArgs, guessConnectorQueryFromEnvVarName };

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
