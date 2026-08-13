import { randomBytes } from 'crypto';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import axios from 'axios';
import { validatePluginConfig } from './scaffold.mjs';
import { withSpinner } from './util.mjs';
import { connectorBaseUrl, connectorAuthHeaders } from './connectors.mjs';
import { triggerPlugin } from './pluginTrigger.mjs';

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
  for (const ch of argsString) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
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
    mcp_resource_mime_type: opts.kind === 'resource' ? opts.resourceMimeType : undefined,
    mcp_prompt_name: opts.kind === 'prompt' ? opts.promptName : undefined,
    auth_type: opts.authSecretKey ? 'bearer' : undefined,
    auth_secret_key: opts.authSecretKey,
  };

  return {
    id: randomBytes(16).toString('hex'),
    name,
    description,
    version: '1.0.0',
    input: { data: 'object - parameters forwarded to the MCP tool/resource/prompt as-is' },
    output: { data: 'object - the MCP server response content, unwrapped' },
    proxy_config: proxyConfig,
  };
}

export async function createMcpProxyPlugin(name, options) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error('Plugin name must contain only lowercase letters, numbers, and hyphens');
  }

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
  };
  let description = options.description;

  // `--transport`/`--kind` are inferable from whichever flags you actually pass - no need to
  // spell out what's already implied. `--command` only makes sense for stdio, `--url` only for
  // sse; `--tool-name`/`--resource-uri`/`--prompt-name` each only make sense for one `--kind`.
  if (!opts.transport) {
    if (opts.command) opts.transport = 'stdio';
    else if (opts.url) opts.transport = 'sse';
  }
  if (!opts.kind) {
    if (opts.resourceUri) opts.kind = 'resource';
    else if (opts.promptName) opts.kind = 'prompt';
    else if (opts.toolName) opts.kind = 'tool';
  }
  // Same default the interactive prompt below offers - applied unconditionally so a fully-flagged
  // non-interactive call (transport inferred, no --description given) doesn't skip straight past
  // needing one and fail validation later with no explanation of what default it could have had.
  if (!description) description = `Proxy for the "${name}" MCP tool`;

  // Non-interactive (scripted/AI) mode once transport is known (explicit or inferred); otherwise prompt.
  if (!opts.transport) {
    console.log(chalk.blue('🔌 New MCP proxy plugin\n'));

    const base = await inquirer.prompt([
      {
        type: 'input',
        name: 'description',
        message: 'Plugin description:',
        default: description || `Proxy for the "${name}" MCP tool`,
      },
      {
        type: 'select',
        name: 'transport',
        message: 'MCP transport:',
        choices: [
          { name: 'stdio (launch a local command)', value: 'stdio' },
          { name: 'sse (remote Streamable HTTP server)', value: 'sse' },
        ],
      },
    ]);
    description = base.description;
    opts.transport = base.transport;

    if (opts.transport === 'stdio') {
      const stdioAnswers = await inquirer.prompt([
        { type: 'input', name: 'command', message: 'Command to launch the MCP server:' },
        { type: 'input', name: 'args', message: 'Arguments (space-separated, optional):' },
      ]);
      opts.command = stdioAnswers.command;
      opts.args = stdioAnswers.args;
    } else {
      const sseAnswers = await inquirer.prompt([
        { type: 'input', name: 'url', message: 'Remote MCP server URL:' },
      ]);
      opts.url = sseAnswers.url;
    }

    const kindAnswers = await inquirer.prompt([
      {
        type: 'select',
        name: 'kind',
        message: 'What does this plugin expose?',
        choices: [
          { name: 'tool (tools/call)', value: 'tool' },
          { name: 'resource (resources/read)', value: 'resource' },
          { name: 'prompt (prompts/get)', value: 'prompt' },
        ],
        default: 'tool',
      },
    ]);
    opts.kind = kindAnswers.kind;

    if (opts.kind === 'tool') {
      opts.toolName = (
        await inquirer.prompt([{ type: 'input', name: 'v', message: 'MCP tool name:' }])
      ).v;
    } else if (opts.kind === 'resource') {
      const resAnswers = await inquirer.prompt([
        { type: 'input', name: 'resourceUri', message: 'Resource URI:' },
        { type: 'input', name: 'resourceMimeType', message: 'Resource MIME type (optional):' },
      ]);
      opts.resourceUri = resAnswers.resourceUri;
      opts.resourceMimeType = resAnswers.resourceMimeType;
    } else {
      opts.promptName = (
        await inquirer.prompt([{ type: 'input', name: 'v', message: 'MCP prompt name:' }])
      ).v;
    }

    const authAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'authSecretKey',
        message:
          'Workspace secret key for auth, if the MCP server needs a Bearer token (optional, leave blank for none):',
      },
    ]);
    opts.authSecretKey = authAnswers.authSecretKey || undefined;
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
  console.log('   aivin test    # deploy to a test instance and verify the connection');
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

  let scanned;
  try {
    const res = await withSpinner('🔎 Scanning MCP server', () =>
      axios.post(`${connectorBaseUrl()}/plugins/scan-mcp`, { url }, connectorAuthHeaders()),
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
      axios.post(`${connectorBaseUrl()}/plugins/build-mcp-manifests`, { scanned: filteredScanned }, connectorAuthHeaders()),
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

  // Always deploys org-scoped first, regardless of --publish/--private/--org - there is currently
  // no backend concept of a workspace-level sub-scope narrower than "your org" (--org is an alias
  // of --private, not a distinct tier - see PluginModel: plugins are scoped by `client`/org only).
  console.log(chalk.blue(`\n🚀 Deploying ${manifests.length} plugin(s) to your org...`));
  let deployResult;
  try {
    deployResult = await withSpinner('   Registering proxy manifest(s)', () =>
      axios.post(`${connectorBaseUrl()}/plugins/deploy`, { manifest: manifests }, connectorAuthHeaders()),
    );
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Deploy failed: ${message}`, { cause: error });
  }
  console.log(chalk.green(`✅ Deployed: ${manifests.map((m) => m.name).join(', ')}`));
  if (deployResult.data?.group_id) {
    console.log(chalk.gray(`   group_id: ${deployResult.data.group_id}`));
  }

  if (options.publish) {
    console.log(chalk.blue(`\n📮 Submitting ${manifests.length} plugin(s) for community review...`));
    for (const manifest of manifests) {
      try {
        await withSpinner(`   Submitting "${manifest.name}"`, () =>
          axios.post(`${connectorBaseUrl()}/plugins/store/submit`, { pluginId: manifest.id }, connectorAuthHeaders()),
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
