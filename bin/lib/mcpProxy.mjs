import { randomBytes } from 'crypto';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import axios from 'axios';
import { validatePluginConfig } from './scaffold.mjs';
import { withSpinner } from './util.mjs';
import { connectorBaseUrl, connectorAuthHeaders, registerConnector } from './connectors.mjs';
import { triggerPlugin } from './pluginTrigger.mjs';

const CONNECTOR_SEARCH_TIMEOUT_MS = 15000;

// Light, transparent naming guess ONLY - a starting point for the search box below, never a
// decision. Deliberately not a port of the backend's own McpAwesomeListHelper.resolveConnectionId
// (suffix list + overrides table maintained there): duplicating that logic client-side would drift
// out of sync over time and silently give wrong suggestions. This just strips the handful of
// suffixes common enough to be obvious (GITHUB_TOKEN -> "github", SLACK_BOT_TOKEN -> "slack") and
// takes the first remaining word - wrong guesses cost nothing since it's an editable default, not
// an auto-pick.
export function guessConnectorQueryFromEnvVarName(envVarName) {
  const suffixes = ['_PERSONAL_ACCESS_TOKEN', '_ACCESS_TOKEN', '_AUTH_TOKEN', '_BOT_TOKEN', '_API_KEY', '_SECRET_KEY', '_TOKEN', '_SECRET', '_KEY', '_PAT'];
  const upper = (envVarName || '').toUpperCase();
  const suffix = suffixes.find((s) => upper.endsWith(s));
  const stripped = suffix ? upper.slice(0, -suffix.length) : upper;
  return stripped.split('_')[0]?.toLowerCase() || '';
}

/**
 * Interactive "pick a connector" step shared by `mcp create` and `mcp <url>` - lets the developer
 * attach an existing connector (OAuth login / credential form) to an MCP proxy's `connection_id`
 * instead of typing a raw workspace secret name, or register a brand new one on the spot without
 * leaving this flow. Returns the chosen connector's id, or `undefined` if the developer backs out.
 * `defaultQuery` pre-fills the search box (editable/clearable) - see guessConnectorQueryFromEnvVarName.
 */
async function selectConnectorInteractive(defaultQuery = '') {
  const { query } = await inquirer.prompt([
    { type: 'input', name: 'query', message: 'Search connectors (blank to list your org\'s):', default: defaultQuery || undefined },
  ]);

  let results;
  try {
    const res = await withSpinner('🔎 Searching connectors', () =>
      axios.get(`${connectorBaseUrl()}/connectors/${query ? 'search' : 'list'}`, {
        ...connectorAuthHeaders(),
        params: query ? { query } : {},
        timeout: CONNECTOR_SEARCH_TIMEOUT_MS,
      }),
    );
    results = Array.isArray(res.data) ? res.data : res.data?.items || [];
  } catch (error) {
    console.log(chalk.yellow(`Couldn't search connectors (${error.response?.data?.message || error.message}) - falling back to typing a raw secret key.`));
    return undefined;
  }

  if (results.length === 0) {
    console.log(chalk.yellow('No connectors found.'));
    const { registerNow } = await inquirer.prompt([{ type: 'confirm', name: 'registerNow', message: 'Register a new one now?', default: true }]);
    if (!registerNow) return undefined;
    const connector = await registerConnector();
    return connector?.id;
  }

  const { picked } = await inquirer.prompt([
    {
      type: 'select',
      name: 'picked',
      message: 'Which connector?',
      choices: [
        ...results.map((c) => ({ name: `${c.name || c.id} ${chalk.gray(`(${c.id}, ${c.type})`)}`, value: c.id })),
        { name: chalk.gray('(none of these - register a new connector)'), value: '__new__' },
      ],
    },
  ]);
  if (picked === '__new__') {
    const connector = await registerConnector();
    return connector?.id;
  }
  return picked;
}

/**
 * Interactive "declare the env vars this MCP server needs" loop for `mcp create`'s stdio path -
 * Enter on a blank name stops, same pattern `aivin connector register`'s credential_form field
 * loop uses. Each declared name either gets left for each workspace to fill in on its own later
 * (no CLI-side value at all - the platform's own "configure this plugin" UI collects it per
 * workspace) or bound to a connector for automatic per-user/per-workspace OAuth resolution.
 * Deliberately TTY-only, no non-interactive/scripted equivalent - same call as
 * `aivin connector register` makes for the same reason: this isn't something to script blindly.
 */
async function collectMcpEnvFieldsInteractive() {
  const fields = [];
  console.log(chalk.gray('Declare each environment variable this MCP server needs (leave the name blank to stop):'));
  for (;;) {
    const { name } = await inquirer.prompt([{ type: 'input', name: 'name', message: `Variable ${fields.length + 1} name (e.g. GITHUB_TOKEN):` }]);
    if (!name) break;

    const { source } = await inquirer.prompt([
      {
        type: 'select',
        name: 'source',
        message: `Where should "${name}" come from?`,
        choices: [
          { name: 'Each workspace configures it themselves later (no OAuth)', value: 'workspace' },
          { name: 'A connector (OAuth login / credential form) - existing or new', value: 'connector' },
        ],
      },
    ]);

    if (source === 'connector') {
      const connectorId = await selectConnectorInteractive(guessConnectorQueryFromEnvVarName(name));
      fields.push({ name, connectorId });
    } else {
      fields.push({ name });
    }
  }
  return fields;
}

/**
 * Quote-aware split for `--args` - a plain `.split(' ')` breaks on any quoted value that itself
 * contains a space (e.g. a Windows path: `--args '"C:\Program Files\mcp\server.js"'`), silently
 * turning it into multiple wrong argv entries. Only single/double quoting is supported - enough for
 * how this flag is actually documented/used, not a full shell-parsing implementation.
 */
export function parseMcpArgs(argsString) {
  const args = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];
    if (quote) {
      // `\"`/`\\` inside a quoted value - lets an arg carry a literal quote character (e.g. a
      // JSON-ish CLI arg) instead of that quote being misread as the closing delimiter.
      if (ch === '\\' && (argsString[i + 1] === quote || argsString[i + 1] === '\\')) {
        current += argsString[i + 1];
        i++;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote) {
    throw new Error(`Unterminated ${quote} quote in --args: ${argsString}`);
  }
  if (current) args.push(current);
  return args;
}

// No per-request AIVIN_TRIGGER_TIMEOUT_MS-style override here - these are one-shot setup calls,
// not something run in a tight loop, so a fixed bound is enough to turn "server never responds"
// into a clear error instead of `mcp <url>` hanging forever with just a spinner and no way out
// short of Ctrl+C (the exact failure mode `plugin trigger` already guards against - see its
// EXECUTE_TIMEOUT_MS). Scanning gets more headroom since it may have to handshake a live remote
// MCP server, not just hit this platform's own backend.
const MCP_SCAN_TIMEOUT_MS = 60000;
const MCP_BUILD_TIMEOUT_MS = 30000;
const MCP_DEPLOY_TIMEOUT_MS = 60000;
const MCP_SUBMIT_TIMEOUT_MS = 30000;

// ── MCP proxy plugins - wrap an external MCP server tool/resource/prompt, no code required ────

/**
 * Builds a manifest-only plugin (`proxy_config.type === 'mcp'`) - the host calls straight through
 * to the external MCP server, so unlike `aivin create` this writes no src/main.ts/package.json/
 * tsconfig - there is no code to run. Matches the backend's McpProxyConfig field-for-field
 * (src/plugins/dto/proxy/McpProxyConfig.ts).
 */
export function buildMcpManifest(name, description, opts) {
  const proxyConfig = {
    type: 'mcp',
    mcp_transport: opts.transport,
    mcp_command: opts.transport === 'stdio' ? opts.command : undefined,
    mcp_args: opts.transport === 'stdio' && opts.args ? parseMcpArgs(opts.args) : undefined,
    mcp_url: opts.transport === 'sse' ? opts.url : undefined,
    mcp_kind: opts.kind || 'tool',
    mcp_tool_name: (opts.kind || 'tool') === 'tool' ? opts.toolName : undefined,
    mcp_resource_uri: opts.kind === 'resource' ? opts.resourceUri : undefined,
    // `|| undefined` (not a bare pass-through) so a resource prompt left blank strips the field
    // entirely instead of writing a literal `""` into the manifest - matches how every other
    // optional field here behaves when unset.
    mcp_resource_mime_type: opts.kind === 'resource' ? opts.resourceMimeType || undefined : undefined,
    mcp_prompt_name: opts.kind === 'prompt' ? opts.promptName : undefined,
    // Defaults to 'bearer' (the only scheme this had ever set) when a secret key is given but no
    // explicit --auth-type is - forwarded as-is otherwise, since this CLI doesn't know the full set
    // of auth_type values the backend's McpProxyConfig accepts.
    auth_type: opts.authSecretKey ? opts.authType || 'bearer' : undefined,
    auth_secret_key: opts.authSecretKey,
  };

  // `opts.envFields` (from the interactive per-variable loop below) is the actual runtime path for
  // "this MCP server needs env var X, resolved per-workspace/per-user" - PluginProxyService.
  // resolveMcpEnv only ever reads `manifest.initable`/`manifest.initial[field].connection_id`, NEVER
  // a plugin-level `connection_id` (confirmed by reading PluginProxyService.ts on the backend: the
  // OAuth auto-fill step iterates `manifest.initial`, full stop). A bare top-level `connection_id`
  // only feeds the "requires logging in" readiness badge - it does not get injected into the spawned
  // MCP process. So this field is DERIVED from whichever connector(s) the declared env vars actually
  // use (first one, sorted, if more than one - same tie-break PluginProvisioningService's own MCP
  // sync path uses), not something to set independently of them.
  const initable = [];
  const initial = {};
  const connectorIdsUsed = new Set();
  for (const field of opts.envFields || []) {
    initable.push(field.name);
    initial[field.name] = field.connectorId ? { source: 'static', connection_id: field.connectorId } : { source: 'static' };
    if (field.connectorId) connectorIdsUsed.add(field.connectorId);
  }
  const connectionId = opts.connectorId || (connectorIdsUsed.size > 0 ? [...connectorIdsUsed].sort()[0] : undefined);

  return {
    id: randomBytes(16).toString('hex'),
    name,
    description,
    version: '1.0.0',
    input: { data: 'object - parameters forwarded to the MCP tool/resource/prompt as-is' },
    output: { data: 'object - the MCP server response content, unwrapped' },
    proxy_config: proxyConfig,
    ...(initable.length > 0 ? { initable } : {}),
    ...(Object.keys(initial).length > 0 ? { initial } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  };
}

export async function createMcpProxyPlugin(name, options) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error('Plugin name must contain only lowercase letters, numbers, and hyphens');
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  let opts = {
    transport: options.transport,
    command: options.command,
    args: options.args,
    url: options.url,
    kind: options.kind,
    toolName: options.toolName,
    resourceUri: options.resourceUri,
    resourceMimeType: options.resourceMimeType,
    promptName: options.promptName,
    authSecretKey: options.authSecretKey,
    authType: options.authType,
    connectorId: options.connector,
  };
  let description = options.description;

  // `--transport` is inferable from whichever of `--command`/`--url` you actually pass - no need
  // to spell out what's already implied.
  if (!opts.transport) {
    if (opts.command) opts.transport = 'stdio';
    else if (opts.url) opts.transport = 'sse';
  }
  // `--tool-name`/`--resource-uri`/`--prompt-name` each only make sense for one `--kind` - if more
  // than one was passed with no explicit `--kind` to disambiguate, say so instead of silently
  // picking one and leaving the other to look like it was ignored for no reason.
  if (!opts.kind) {
    const given = [opts.toolName && 'tool', opts.resourceUri && 'resource', opts.promptName && 'prompt'].filter(Boolean);
    if (given.length > 1) {
      console.log(
        chalk.yellow(`⚠ Multiple kind-identifying flags given (${given.join(', ')}) - pass --kind explicitly to disambiguate. Defaulting to "${given[0]}".`),
      );
    }
    if (opts.toolName) opts.kind = 'tool';
    else if (opts.resourceUri) opts.kind = 'resource';
    else if (opts.promptName) opts.kind = 'prompt';
  }
  if (!description) description = `Proxy for the "${name}" MCP tool`;

  // Fills in only whatever wasn't already given on the command line - unlike before, a partially
  // flagged call (e.g. `--transport stdio` with no `--command`) still gets prompted for exactly
  // what's missing instead of skipping every prompt and only finding out from a validation error
  // at the very end.
  if (interactive) {
    console.log(chalk.blue('🔌 New MCP proxy plugin\n'));

    if (!options.description) {
      description = (await inquirer.prompt([{ type: 'input', name: 'v', message: 'Plugin description:', default: description }])).v;
    }

    if (!opts.transport) {
      opts.transport = (
        await inquirer.prompt([
          {
            type: 'select',
            name: 'v',
            message: 'MCP transport:',
            choices: [
              { name: 'stdio (launch a local command)', value: 'stdio' },
              { name: 'sse (remote Streamable HTTP server)', value: 'sse' },
            ],
          },
        ])
      ).v;
    }

    if (opts.transport === 'stdio' && !opts.command) {
      const stdioAnswers = await inquirer.prompt([
        { type: 'input', name: 'command', message: 'Command to launch the MCP server:' },
        { type: 'input', name: 'args', message: 'Arguments (space-separated, optional):', when: () => !opts.args },
      ]);
      opts.command = stdioAnswers.command;
      if (stdioAnswers.args !== undefined) opts.args = stdioAnswers.args;
    } else if (opts.transport === 'sse' && !opts.url) {
      opts.url = (await inquirer.prompt([{ type: 'input', name: 'v', message: 'Remote MCP server URL:' }])).v;
    }

    if (!opts.kind) {
      opts.kind = (
        await inquirer.prompt([
          {
            type: 'select',
            name: 'v',
            message: 'What does this plugin expose?',
            choices: [
              { name: 'tool (tools/call)', value: 'tool' },
              { name: 'resource (resources/read)', value: 'resource' },
              { name: 'prompt (prompts/get)', value: 'prompt' },
            ],
            default: 'tool',
          },
        ])
      ).v;
    }

    if (opts.kind === 'tool' && !opts.toolName) {
      opts.toolName = (await inquirer.prompt([{ type: 'input', name: 'v', message: 'MCP tool name:' }])).v;
    } else if (opts.kind === 'resource' && !opts.resourceUri) {
      const resAnswers = await inquirer.prompt([
        { type: 'input', name: 'resourceUri', message: 'Resource URI:' },
        { type: 'input', name: 'resourceMimeType', message: 'Resource MIME type (optional):', when: () => !opts.resourceMimeType },
      ]);
      opts.resourceUri = resAnswers.resourceUri;
      if (resAnswers.resourceMimeType !== undefined) opts.resourceMimeType = resAnswers.resourceMimeType;
    } else if (opts.kind === 'prompt' && !opts.promptName) {
      opts.promptName = (await inquirer.prompt([{ type: 'input', name: 'v', message: 'MCP prompt name:' }])).v;
    }

    if (!opts.authSecretKey && !opts.envFields) {
      const { authMode } = await inquirer.prompt([
        {
          type: 'select',
          name: 'authMode',
          message: 'Does this MCP server need auth?',
          choices: [
            { name: 'No auth needed', value: 'none' },
            { name: 'One shared token for everyone (bearer - typical for a remote/sse server)', value: 'shared_secret' },
            { name: 'One or more environment variables (typical for a local/stdio server)', value: 'env_vars' },
          ],
          default: 'none',
        },
      ]);
      if (authMode === 'shared_secret') {
        console.log(chalk.yellow('   ⚠ This credential is shared by everyone in your org - if you later `--publish` this plugin, it will be blocked (another org calling it would use YOUR credential). Fine for a private/org-only plugin; use a connector-bound env var instead if you plan to publish.'));
        const { authSecretKey } = await inquirer.prompt([
          { type: 'input', name: 'authSecretKey', message: 'Workspace secret key (sent as a bearer token):' },
        ]);
        opts.authSecretKey = authSecretKey || undefined;
      } else if (authMode === 'env_vars') {
        opts.envFields = await collectMcpEnvFieldsInteractive();
      }
    }
  }

  // Whatever's still missing at this point (either non-interactive, or interactive but the
  // prompts above had nothing left to fill) fails fast with exactly what's needed, rather than
  // deferring to validatePluginConfig's more generic `proxy_config.*` error below.
  const missing = [];
  if (!opts.transport) missing.push('--transport <stdio|sse> (or --command/--url to infer it)');
  else if (opts.transport === 'stdio' && !opts.command) missing.push('--command <command>');
  else if (opts.transport === 'sse' && !opts.url) missing.push('--url <url>');
  if (!opts.kind) opts.kind = 'tool';
  if (opts.kind === 'tool' && !opts.toolName) missing.push('--tool-name <name>');
  else if (opts.kind === 'resource' && !opts.resourceUri) missing.push('--resource-uri <uri>');
  else if (opts.kind === 'prompt' && !opts.promptName) missing.push('--prompt-name <name>');
  if (missing.length > 0) {
    throw new Error(`Missing required field(s): ${missing.join(', ')}`);
  }

  const manifest = buildMcpManifest(name, description, opts);
  const validation = validatePluginConfig(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid MCP proxy config: ${validation.errors.join(', ')}`);
  }

  const pluginDir = path.join(process.cwd(), name);
  if (fs.existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`);
  }
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(chalk.green(`✅ Created ${path.join(name, 'manifest.json')}`));
  console.log(
    chalk.gray('   No src/main.ts/package.json needed - the host calls the MCP server directly.'),
  );
  console.log(chalk.cyan('\n🔧 Next steps:'));
  console.log(`   cd ${name}`);
  console.log('   aivin login   # once, if you haven\'t already');
  // `aivin test`'s automated smoke test explicitly skips proxy plugins (no generic sample input
  // makes sense for a schema an external MCP server defines) - it only deploys, it does NOT verify
  // the connection. Saying otherwise here would send people looking for a pass/fail report that
  // never gets written; `plugin trigger` is the actual way to know it works.
  console.log('   aivin test    # deploy to a test instance (no automated verify for proxy plugins)');
  console.log('   aivin plugin trigger -a "..."  # the real way to verify it works (reads manifest.json here)');
  console.log('   aivin deploy  # ship it');
}

/**
 * `aivin mcp <url>` - the one-shot path from "here's an MCP server" to deployed plugin(s):
 * scan (GET the repo/README or handshake a live server) -> let the developer pick which
 * tools/resources/prompts to bring in -> build manifest(s) -> optional interactive edit ->
 * deploy to the caller's own org. Reuses the exact same backend endpoints the FE's MCP-import
 * screen calls (POST /plugins/scan-mcp, /plugins/build-mcp-manifests, /plugins/deploy) - unlike
 * `mcp create`, nothing here is typed by hand (transport/command/tool name all come from the
 * scan), so this is the fast path for "wrap this whole MCP server", not "wrap 1 tool I already
 * know the details of".
 *
 * --publish additionally calls POST /plugins/store/submit per deployed plugin, which re-verifies
 * each one LIVE against the real MCP server (see PluginStoreService.submitPluginForReview on the
 * backend) before it lands in the admin review queue - deploy always happens org-scoped first
 * regardless of --publish, so a rejected/pending submission never blocks your own org from using
 * the plugin.
 */
export async function scanAndPublishMcp(url, options) {
  console.log(chalk.blue('🔌 Converting MCP server into plugin(s)\n'));
  console.log(chalk.gray(`   ${url}\n`));
  // Scanning means the backend connects to (and, for a stdio-transport server, effectively runs)
  // whatever is at this URL to introspect its tools/resources/prompts - only point this at MCP
  // servers you actually trust, same as installing any other dependency from source.
  console.log(chalk.gray('   ⚠ This connects to the server above to introspect it - only scan MCP servers you trust.\n'));

  let scanned;
  try {
    const res = await withSpinner('🔎 Scanning MCP server', () =>
      axios.post(`${connectorBaseUrl()}/plugins/scan-mcp`, { url }, { ...connectorAuthHeaders(), timeout: MCP_SCAN_TIMEOUT_MS }),
    );
    scanned = res.data;
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Scan failed: ${message}`, { cause: error });
  }

  const tools = scanned.tools || [];
  const resources = scanned.resources || [];
  const prompts = scanned.prompts || [];
  if (tools.length + resources.length + prompts.length === 0) {
    throw new Error('No tools/resources/prompts discovered at that URL - nothing to convert.');
  }
  console.log(chalk.green(`✅ Found ${tools.length} tool(s), ${resources.length} resource(s), ${prompts.length} prompt(s)`));

  // Exact check, not a heuristic: `scanned.repo_id` is the SAME deterministic id (derived from the
  // source URL, see McpScannerHelper.deriveRepoId on the backend) that ends up as every generated
  // manifest's `proxy_config.mcp_server_id` - so this is exactly what `plugin search --mcp <id>`
  // already means, not a fuzzy text guess. Still purely informational (never blocks the flow) and
  // silently skipped if the search itself fails, since a lookup failure here shouldn't stop a
  // conversion that has nothing to do with search being up.
  if (scanned.repo_id) {
    try {
      const dupRes = await axios.get(`${connectorBaseUrl()}/plugins/search`, {
        ...connectorAuthHeaders(),
        params: { mcp_server_id: scanned.repo_id, limit: 10 },
        timeout: CONNECTOR_SEARCH_TIMEOUT_MS,
      });
      const dupResults = Array.isArray(dupRes.data) ? dupRes.data : dupRes.data?.items || [];
      if (dupResults.length > 0) {
        console.log(chalk.yellow(`\n⚠ ${dupResults.length} plugin(s) already exist from this exact server (server id "${scanned.repo_id}") - converting again will create duplicates unless you mean to update them:`));
        dupResults.forEach((p) => console.log(`   - ${p.name || p.id} ${chalk.gray(`(${p.id})`)}`));
        console.log();
      }
    } catch {
      // Non-fatal - this is a courtesy check, not a requirement to proceed.
    }
  }

  const choices = [
    ...tools.map((t) => ({ name: `${t.name} ${chalk.gray('(tool)')} - ${t.description || 'no description'}`, value: { kind: 'tools', item: t }, checked: true })),
    ...resources.map((r) => ({ name: `${r.name || r.uri} ${chalk.gray('(resource)')} - ${r.description || 'no description'}`, value: { kind: 'resources', item: r }, checked: true })),
    ...prompts.map((p) => ({ name: `${p.name} ${chalk.gray('(prompt)')} - ${p.description || 'no description'}`, value: { kind: 'prompts', item: p }, checked: true })),
  ];
  const { selected } = await inquirer.prompt([
    { type: 'checkbox', name: 'selected', message: 'Which ones become plugins? (space to toggle, enter to continue)', choices, pageSize: 15 },
  ]);
  if (selected.length === 0) {
    console.log(chalk.yellow('Nothing selected - cancelled.'));
    return;
  }

  const filteredScanned = {
    ...scanned,
    tools: selected.filter((s) => s.kind === 'tools').map((s) => s.item),
    resources: selected.filter((s) => s.kind === 'resources').map((s) => s.item),
    prompts: selected.filter((s) => s.kind === 'prompts').map((s) => s.item),
  };

  let manifests;
  try {
    const res = await withSpinner('🛠  Generating plugin manifest(s)', () =>
      axios.post(`${connectorBaseUrl()}/plugins/build-mcp-manifests`, { scanned: filteredScanned }, { ...connectorAuthHeaders(), timeout: MCP_BUILD_TIMEOUT_MS }),
    );
    manifests = res.data;
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Building manifest(s) failed: ${message}`, { cause: error });
  }

  console.log(chalk.cyan(`\n📦 ${manifests.length} plugin manifest(s) generated:`));
  manifests.forEach((m, i) => console.log(`   ${i + 1}. ${chalk.bold(m.name)} ${chalk.gray(`(${m.id})`)} - ${m.description || 'no description'}`));

  const { shouldEdit } = await inquirer.prompt([
    { type: 'confirm', name: 'shouldEdit', message: '\nEdit any name/description before deploying?', default: false },
  ]);
  if (shouldEdit) {
    for (const manifest of manifests) {
      const { editThis } = await inquirer.prompt([
        { type: 'confirm', name: 'editThis', message: `Edit "${manifest.name}"?`, default: false },
      ]);
      if (!editThis) continue;
      const edited = await inquirer.prompt([
        { type: 'input', name: 'name', message: 'Name:', default: manifest.name },
        { type: 'input', name: 'description', message: 'Description:', default: manifest.description || '' },
      ]);
      manifest.name = edited.name;
      manifest.description = edited.description;
    }
  }

  // Server-generated manifests come back with whatever `auth_secret_key`/`connection_id` the
  // build step inferred (often none) - offer to bind an existing/new connector to all of them here
  // rather than leaving that to be edited by hand after the fact. Skipped in non-TTY contexts, same
  // as every other prompt in this flow.
  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { attachConnector } = await inquirer.prompt([
      { type: 'confirm', name: 'attachConnector', message: '\nAttach a connector for auth to all of these? (optional)', default: false },
    ]);
    if (attachConnector) {
      const connectorId = await selectConnectorInteractive();
      if (connectorId) {
        for (const manifest of manifests) manifest.connection_id = connectorId;
        console.log(chalk.gray(`   Attached connector "${connectorId}" to ${manifests.length} manifest(s).`));
      }
    }
  }

  // This is the point of no return - `aivin` has no `plugin delete`/`undeploy` command, so once
  // this POST succeeds the plugin(s) are live and visible to your whole org (and, with --publish,
  // queued for a community review that also can't be withdrawn from here) until someone removes
  // them from the platform directly. The checkbox above defaults every discovered item to checked,
  // so an unconfirmed "just press enter through it" run could deploy far more than intended -
  // require an explicit yes here rather than only gating on the (default-off, easy to skip) edit
  // prompt above.
  if (process.stdout.isTTY && process.stdin.isTTY) {
    const scopeLabel = options.publish ? 'your org now, and submitted for community review' : 'your org';
    const { confirmDeploy } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmDeploy',
        message: `\nDeploy ${manifests.length} plugin(s) to ${scopeLabel}? This can't be undone from the CLI.`,
        default: false,
      },
    ]);
    if (!confirmDeploy) {
      console.log(chalk.yellow('Cancelled - nothing deployed.'));
      return;
    }
  }

  // Always deploys org-scoped first, regardless of --publish/--private/--org - there is currently
  // no backend concept of a workspace-level sub-scope narrower than "your org" (--org is an alias
  // of --private, not a distinct tier - see PluginModel: plugins are scoped by `client`/org only).
  console.log(chalk.blue(`\n🚀 Deploying ${manifests.length} plugin(s) to your org...`));
  let deployResult;
  try {
    deployResult = await withSpinner('   Registering proxy manifest(s)', () =>
      axios.post(`${connectorBaseUrl()}/plugins/deploy`, { manifest: manifests }, { ...connectorAuthHeaders(), timeout: MCP_DEPLOY_TIMEOUT_MS }),
    );
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Deploy failed: ${message}`, { cause: error });
  }
  console.log(chalk.green(`✅ Deployed: ${manifests.map((m) => m.name).join(', ')}`));
  if (deployResult.data?.group_id) {
    console.log(chalk.gray(`   group_id: ${deployResult.data.group_id}`));
    console.log(chalk.gray(`   (to remove all ${manifests.length} of these later in one shot: aivin plugin delete --group ${deployResult.data.group_id})`));
  }

  if (options.publish) {
    console.log(chalk.blue(`\n📮 Submitting ${manifests.length} plugin(s) for community review...`));
    for (const manifest of manifests) {
      // `auth_secret_key` is an admin-level credential meant to be shared by every user WITHIN the
      // deploying org (see PluginProxyService.resolveMcpEnv's own comment: "dùng chung cho tất cả
      // user"), resolved straight off this same manifest document. Publishing means other orgs can
      // execute this same plugin - and there is currently no confirmed backend step that strips or
      // reissues `auth_secret_key` per installing org, so submitting it as-is would let another
      // org's calls silently resolve to (and spend/exhaust/expose) YOUR org's credential. Blocked
      // here rather than warned, since the failure mode is a real cross-org credential leak, not
      // just a rough edge - use the interactive per-variable connector binding in `mcp create`
      // (or attach a connector via the prompt earlier in this command) instead, which resolves
      // per the CALLING org/user, not off this shared document.
      if (manifest.proxy_config?.auth_secret_key) {
        console.log(
          chalk.red(`   ❌ "${manifest.name}" NOT submitted - it has a shared auth_secret_key, which would leak your org's credential to every other org that calls it.`),
        );
        console.log(chalk.gray('      Rebuild it with a connector-bound env var instead (see `aivin mcp create`\'s interactive auth setup), then re-run --publish.'));
        continue;
      }
      try {
        await withSpinner(`   Submitting "${manifest.name}"`, () =>
          axios.post(`${connectorBaseUrl()}/plugins/store/submit`, { pluginId: manifest.id }, { ...connectorAuthHeaders(), timeout: MCP_SUBMIT_TIMEOUT_MS }),
        );
        console.log(chalk.green(`   ✅ "${manifest.name}" submitted - pending admin review.`));
      } catch (error) {
        const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
        console.log(chalk.red(`   ❌ "${manifest.name}" submit failed: ${message}`));
      }
    }
  } else {
    console.log(chalk.gray('\n   Visibility: private (your org only). Re-run with --publish to also submit to the community store.'));
  }

  // `aivin plugin trigger`/`logs` normally read the project's own manifest.json - these plugins
  // deploy straight from the scan, never scaffolded into a directory, so print the `--id` form
  // (see triggerPlugin's --id option) instead of leaving the developer to dig the plugin id back
  // out of the manifest(s) printed above.
  console.log(chalk.cyan('\n🧪 Test it (Playground-equivalent):'));
  for (const manifest of manifests) {
    console.log(`   aivin plugin trigger --id ${manifest.id} -a "<try it in natural language>"`);
  }
  console.log(chalk.gray('   (or `aivin plugin logs <pluginId>` in another terminal to watch its live console output)'));

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { testNow } = await inquirer.prompt([
      { type: 'confirm', name: 'testNow', message: '\nTest one of them right now?', default: manifests.length === 1 },
    ]);
    if (testNow) {
      let target = manifests[0];
      if (manifests.length > 1) {
        const { picked } = await inquirer.prompt([
          { type: 'select', name: 'picked', message: 'Which one?', choices: manifests.map((m) => ({ name: m.name, value: m })) },
        ]);
        target = picked;
      }
      const { prompt } = await inquirer.prompt([
        { type: 'input', name: 'prompt', message: `Prompt to send to "${target.name}":` },
      ]);
      if (prompt) {
        try {
          await triggerPlugin(undefined, undefined, { id: target.id, auto: prompt });
        } catch (error) {
          console.error(chalk.red('❌'), error.message);
        }
      }
    }
  }
}
