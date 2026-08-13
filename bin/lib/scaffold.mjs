import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { randomBytes } from 'crypto';
import { createRequire } from 'module';

// The @aivin-labs/sdk version THIS CLI itself depends on (declared in this package's own
// package.json, resolved via its "./package.json" export) - not this CLI's own version, which is
// versioned independently since the cli/sdk package split. This is what a fresh `aivin create`/
// `aivin init` scaffold pins its own `@aivin-labs/sdk` dependency to.
const SDK_VERSION = JSON.parse(
  fs.readFileSync(createRequire(import.meta.url).resolve('@aivin-labs/sdk/package.json'), 'utf8'),
).version;

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

// AI-friendly JSON mode
export async function createFromJSON(jsonConfig, options) {
  try {
    let config;

    if (typeof jsonConfig === 'string') {
      try {
        config = JSON.parse(jsonConfig);
      } catch (parseError) {
        if (fs.existsSync(jsonConfig)) {
          config = JSON.parse(fs.readFileSync(jsonConfig, 'utf8'));
        } else {
          throw new Error('Invalid JSON: ' + parseError.message, { cause: parseError });
        }
      }
    } else {
      config = jsonConfig;
    }

    const validationResult = validatePluginConfig(config);
    if (!validationResult.valid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    const pluginDir = path.join(process.cwd(), options.outputDir || '', config.name);

    if (fs.existsSync(pluginDir) && !config.overwrite) {
      throw new Error(`Directory exists: ${pluginDir}`);
    }

    if (!options.silent) {
      console.log(chalk.blue('🤖 Creating plugin:'), config.name);
    }

    await createPluginProject(pluginDir, config.name, config.description || 'AI plugin', config);

    if (!options.silent) {
      console.log(chalk.green('✅ Created:'), pluginDir);
      console.log(chalk.cyan('\n🔧 Next steps:'));
      console.log(`   cd ${path.relative(process.cwd(), pluginDir)}  # Enter the new project directory`);
      console.log(`   npm install     # Install dependencies`);
      console.log(`   npm start       # Start plugin (local gRPC server + HTTP test shim)`);
    }

    return {
      success: true,
      pluginDir,
      name: config.name,
      description: config.description,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    if (!options.silent) {
      console.error(chalk.red('❌'), error.message);
    }
    throw error;
  }
}

// Config validation
export function validatePluginConfig(config) {
  const errors = [];

  if (!config.name) {
    errors.push('Missing name');
  } else if (!/^[a-z0-9-]+$/.test(config.name)) {
    errors.push('Invalid name format');
  }

  if (!config.description) {
    errors.push('Missing description');
  }

  if (config.proxy_config?.type === 'mcp') {
    errors.push(...validateMcpProxyConfig(config.proxy_config).map((e) => `proxy_config.${e}`));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Matches the backend's McpProxyConfig (src/plugins/dto/proxy/McpProxyConfig.ts): which fields
 * are required depends on `mcp_transport` (stdio needs a command, sse needs a url) and on
 * `mcp_kind` (tool/resource/prompt each point at a different identifying field).
 */
export function validateMcpProxyConfig(proxyConfig) {
  const errors = [];

  if (proxyConfig.mcp_transport === 'stdio') {
    if (!proxyConfig.mcp_command) errors.push('mcp_command is required for stdio transport');
  } else if (proxyConfig.mcp_transport === 'sse') {
    if (!proxyConfig.mcp_url) errors.push('mcp_url is required for sse transport');
  } else {
    errors.push('mcp_transport must be "stdio" or "sse"');
  }

  const kind = proxyConfig.mcp_kind || 'tool';
  if (kind === 'tool' && !proxyConfig.mcp_tool_name) {
    errors.push('mcp_tool_name is required when mcp_kind is "tool"');
  } else if (kind === 'resource' && !proxyConfig.mcp_resource_uri) {
    errors.push('mcp_resource_uri is required when mcp_kind is "resource"');
  } else if (kind === 'prompt' && !proxyConfig.mcp_prompt_name) {
    errors.push('mcp_prompt_name is required when mcp_kind is "prompt"');
  }

  return errors;
}

// Interactive mode
export async function createInteractive(options) {
  console.log(chalk.blue('🚀 Aivin Plugin Creator\n'));

  // A name given upfront (positional arg or --name) means "scaffold a new project folder for me" -
  // matching `aivin mcp create <name>` and the --json/--stdin path below, both of which already
  // nest into a subdirectory named after the plugin. Without one, `aivin create` scaffolds into the
  // current directory - you've already mkdir'd/cd'd into your target folder yourself.
  const nameGivenUpfront = !!options.name;
  if (nameGivenUpfront && !/^[a-z0-9-]+$/.test(options.name)) {
    throw new Error('Plugin name must contain only lowercase letters, numbers, and hyphens');
  }
  const pluginDir = nameGivenUpfront ? path.join(process.cwd(), options.name) : process.cwd();

  if (nameGivenUpfront && fs.existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`);
  }

  let pluginName = options.name;

  let currentPackageJson = null;
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  if (!nameGivenUpfront && fs.existsSync(packageJsonPath)) {
    currentPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    pluginName =
      pluginName ||
      currentPackageJson.name?.replace('@aivin/plugin-', '') ||
      path.basename(process.cwd());
  } else if (!nameGivenUpfront) {
    pluginName = pluginName || path.basename(process.cwd());
  }

  // A name given upfront (positional arg or --name) is used as-is, no re-prompt - the whole point
  // of providing it was to skip that question.
  const nameQuestion = nameGivenUpfront
    ? []
    : [
        {
          type: 'input',
          name: 'name',
          message: 'Plugin name:',
          default: pluginName,
          validate: (input) => {
            if (!input.trim()) return 'Plugin name cannot be empty';
            if (!/^[a-z0-9-]+$/.test(input))
              return 'Plugin name must contain only lowercase letters, numbers, and hyphens';
            return true;
          },
        },
      ];

  const answers = await inquirer.prompt([
    ...nameQuestion,
    {
      type: 'input',
      name: 'description',
      message: 'Plugin description:',
      default: currentPackageJson?.description || 'New Aivin plugin',
    },
  ]);

  pluginName = answers.name || pluginName;

  await createPluginProject(pluginDir, pluginName, answers.description, null, currentPackageJson);
  console.log(chalk.green(`\n✅ Plugin files created successfully!`));
  console.log(`📁 Directory: ${pluginDir}`);
  console.log(chalk.cyan(`\n🔧 Next steps:`));
  if (nameGivenUpfront) {
    console.log(`   cd ${pluginName}  # Enter the new project directory`);
  }
  console.log(`   npm install     # Install dependencies`);
  console.log(`   npm start       # Start plugin locally (gRPC server + HTTP test shim on :4001)`);
}

export async function createPluginProject(
  pluginDir,
  name,
  description,
  aiConfig = null,
  currentPackageJson = null,
  { skipHandler = false } = {},
) {
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  const tasks = [
    createManifest(pluginDir, name, description, aiConfig),
    createPackageJson(pluginDir, name, description, currentPackageJson),
    createTsConfig(pluginDir),
    createEnv(pluginDir),
    createGitignore(pluginDir),
    // `skipHandler` is only ever true for `aivin init`'s flow (see below) - the AGENTS.md content
    // differs depending on whether this project will end up with the src/service.ts split or one
    // plain src/main.ts, so it doubles as that signal here.
    createAgentsGuide(pluginDir, { usesServiceSplit: skipHandler }),
    createTestFile(pluginDir, { usesServiceSplit: skipHandler }),
  ];
  // `aivin init` writes its own src/main.ts (static wrapper) + src/service.ts (AI-generated business
  // logic) right after this returns - skip the generic placeholder handler so it isn't written and
  // immediately overwritten.
  if (!skipHandler) tasks.push(createHandler(pluginDir, aiConfig));
  await Promise.all(tasks);
}

/**
 * AGENTS.md - the emerging cross-tool convention (Claude Code, Cursor, and others all read this
 * file automatically on open, unlike docs/AI-Plugin-Guide.md in the *SDK's own* repo, which a
 * coding agent working inside a freshly-scaffolded plugin project - a completely different
 * directory - has no way to discover on its own). Kept short on purpose: this is a primer to get
 * an agent oriented fast, not a full reference - it points to the installed package's own README
 * for depth instead of duplicating it.
 */
export async function createAgentsGuide(pluginDir, { usesServiceSplit = false } = {}) {
  const agentsPath = path.join(pluginDir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) return;

  const filesSection = usesServiceSplit
    ? `## The files that matter

- **\`manifest.json\`** - shared fields (version/author) + a \`plugins: []\` array, one entry per exported function (the scaffold has one entry whose \`func\` points at \`main\`). Each entry's \`input\`/\`output\` field descriptions are used for auto-mapping natural-language prompts onto real args. Full reference: \`node_modules/@aivin-labs/sdk/docs/MANIFEST.md\`.
- **\`src/service.ts\`** - the actual business logic. Edit this. A single exported \`execute(input, ctx)\` that returns plain result data, or throws a plain \`Error\` on failure - no \`PluginResponse\`/\`PluginStatus\` to think about here.
- **\`src/main.ts\`** - a thin, static wrapper. Do NOT edit this or add logic to it - it just calls \`execute()\` and packages the result into the \`PluginResponse\` the platform expects. Its filename is fixed (the runtime always loads exactly this file), unlike \`service.ts\` which is just this project's convention.`
    : `## The two files that matter

- **\`manifest.json\`** - shared fields (version/author) + a \`plugins: []\` array, one entry per exported function (the scaffold has one entry whose \`func\` points at \`main\`). Each entry's \`input\`/\`output\` field descriptions are used for auto-mapping natural-language prompts onto real args. Full reference: \`node_modules/@aivin-labs/sdk/docs/MANIFEST.md\`.
- **\`src/main.ts\`** - exports exactly one \`main(mission, input, ctx)\` entry point, returning a \`PluginResponse\` (\`{ status: PluginStatus.SUCCESS | ERROR | FAIL, data?, message?, error_code? }\`).`;

  const regenerateCommand = usesServiceSplit
    ? `\`aivin plugin make "<description>"\` - regenerate \`src/service.ts\` from a plain-language description (detected automatically; \`src/main.ts\` is left untouched).`
    : `\`aivin plugin make "<description>"\` - regenerate \`src/main.ts\` from a plain-language description.`;

  const testFileName = usesServiceSplit ? 'test/service.test.ts' : 'test/main.test.ts';
  const testTargetName = usesServiceSplit ? 'execute()' : 'main()';

  const content = `# AGENTS.md

This is an Aivin plugin project (\`@aivin-labs/sdk\`). Quick orientation for a coding agent working in this directory.

${filesSection}

## Calling the platform - import what you need from \`@aivin-labs/sdk\`

**Always use this style** in any code you write or generate here:

\`\`\`typescript
import { ai } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> {
  const summary = await ai.prompt(\`Summarize: \${input.text}\`);
  return { status: PluginStatus.SUCCESS, data: summary };
}
\`\`\`

\`ctx.sdk.*\` is the legacy mechanism - it still works (same client under the hood) but is NOT recommended; don't generate new code with it. Its one remaining niche: calling the platform from somewhere that isn't guaranteed to be inside a running \`main()\` invocation, where the top-level import's \`AsyncLocalStorage\` scoping doesn't reach.

Namespaces available: \`ai\`, \`knowledge\`, \`vector\`, \`datasource\`, \`causality\`, \`attachment\`, \`workspace\`, \`agent\`, \`browser\`, \`project\`, \`table\`, \`code\`, \`task\`, \`message\`, \`notification\`, \`realtime\`, \`queue\`, \`usage\`, \`automation\`, \`resource\`, \`session\`, \`file\`, \`setting\`, \`store\`, \`redis\`, \`mongo\`. Full per-namespace reference: \`node_modules/@aivin-labs/sdk/docs/sdk/*.md\`.

## Reusing another plugin instead of writing new logic

Before implementing something from scratch, check if a plugin already does it:

\`\`\`bash
aivin plugin search "what you're trying to do"
\`\`\`

Call one from your own \`main()\` with \`import { call } from '@aivin-labs/sdk'\` then \`await call('<plugin_id>.<purpose>', params)\`.

## Commands you'll actually use

- \`aivin start\` - run this plugin locally (gRPC server + HTTP test shim on :4001).
- \`aivin start --debug\` - same, plus logs every \`sdk.*\` call live as it happens (human-readable one-liner per call). \`--debug-json\` prints the same events as one JSON object per line instead - prefer this when *you* (the coding agent) are the one reading the output, so you can parse it instead of pattern-matching free text.
- \`npm test\` - runs \`${testFileName}\` (Node's built-in test runner + native TS execution, no extra tooling). Mocks the SDK with \`createMockSDK\`/\`withMockSDK\` from \`@aivin-labs/sdk\` - no real backend, no gRPC round trip. **Keep this file in sync whenever you change what \`${testTargetName}\` calls or returns** - update the mocked \`handlers\` and assertions together with the logic, don't let it go stale.
- \`aivin test\` - deploy to a *real* test instance and smoke-test it with generated input (unlike \`npm test\`, this hits the actual backend) - writes a JSON report to \`.test/\`, read that file for structured pass/fail instead of parsing the console output.
- \`aivin plugin trigger "<mission>" '<input JSON>'\` - invoke an already-deployed plugin for real.
- \`aivin plugin logs\` - tail this plugin's own console output live, once deployed.
- ${regenerateCommand}

## Debugging a failure

1. Reproduce locally first: \`aivin start --debug-json\`, then \`curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' -d '{"input":{...}}'\` in another terminal (or read the JSON lines this process prints as it runs, if you're driving it directly).
2. Each \`sdk.*\` call's own error message is usually the fastest signal - namespaces validated with zod (\`automation.*\`, \`resource.*\`, \`store.*\`, \`table.*\`) throw \`[namespace.method] invalid params - field: reason\` immediately on a bad shape, before any network call.
3. If a call's *shape* is right but the *result* is wrong, check the relevant \`node_modules/@aivin-labs/sdk/docs/sdk/*.md\` page - several namespaces have "Notes & caveats" documenting real field names/behavior that differ from what you'd guess (e.g. \`automation.createJob\` takes \`mission\`/\`schedule_condition\`, not \`name\`/\`schedule\`).

Full docs: \`node_modules/@aivin-labs/sdk/README.md\` and \`node_modules/@aivin-labs/sdk/docs/\`.
`;
  fs.writeFileSync(agentsPath, content);
}

/**
 * A real, runnable example test using createMockSDK/withMockSDK/createMockContext - not just
 * documentation. Deliberately written to still PASS against the literal placeholder handler
 * `createHandler` writes (which calls no SDK method at all) - the mocked `ai.prompt` handler is
 * simply never invoked in that case, and the assertions on `status`/`data.processed` hold either
 * way. Once real logic replaces the placeholder (by hand or via `aivin plugin make`), this file is
 * a starting point to adapt, exactly like `src/main.ts`/`src/service.ts` themselves are.
 */
export async function createTestFile(pluginDir, { usesServiceSplit = false } = {}) {
  const testDir = path.join(pluginDir, 'test');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  const testPath = path.join(testDir, usesServiceSplit ? 'service.test.ts' : 'main.test.ts');
  if (fs.existsSync(testPath)) return;

  const content = usesServiceSplit
    ? `// Tests the real business logic in src/service.ts directly - src/main.ts is a thin, static
// wrapper (see AGENTS.md) not worth testing on its own. Adapt the mocked handlers/assertions
// below once execute() calls something other than what's here now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSDK, withMockSDK } from '@aivin-labs/sdk';
import { execute } from '../src/service.ts';

test('execute() returns a result', async () => {
  const { client, calls } = createMockSDK({
    handlers: {
      // Add one entry per namespace.method execute() actually calls - see the error message
      // a missing handler throws for the exact string to use, or docs/sdk/*.md in
      // node_modules/@aivin-labs/sdk.
      'ai.prompt': async ({ quest }) => \`Echo: \${quest}\`,
    },
  });

  const result = await withMockSDK(client, () => execute({ text: 'hello' } as any, {} as any));

  assert.ok(result !== undefined);
  // Uncomment once execute() actually calls something:
  // assert.equal(calls[0]?.namespace, 'ai.prompt');
  void calls;
});
`
    : `// Adapt the mocked handlers/assertions below once main() calls something other than what's
// here now (the placeholder calls no SDK method at all, so this passes as-is against a fresh
// \`aivin create\`/\`aivin init\` scaffold).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSDK, withMockSDK, createMockContext } from '@aivin-labs/sdk';
import { main } from '../src/main.ts';

test('main() returns a success response', async () => {
  const { client, calls } = createMockSDK({
    handlers: {
      // Add one entry per namespace.method main() actually calls - see the error message
      // a missing handler throws for the exact string to use, or docs/sdk/*.md in
      // node_modules/@aivin-labs/sdk.
      'ai.prompt': async ({ quest }) => \`Echo: \${quest}\`,
    },
  });
  const ctx = createMockContext(client);

  const result = await withMockSDK(client, () => main('test mission', { text: 'hello' }, ctx));

  assert.equal(result.status, 'success');
  // Uncomment once main() actually calls something:
  // assert.equal(calls[0]?.namespace, 'ai.prompt');
  void calls;
});
`;

  fs.writeFileSync(testPath, content);
}

export async function createGitignore(pluginDir) {
  const gitignorePath = path.join(pluginDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) return;

  const content = ['node_modules/', 'dist/', '.env', '.env.*', '*.log', '.test/', ''].join('\n');
  fs.writeFileSync(gitignorePath, content);
}

// Fields that belong once at the top level of the default { ...commonFields, plugins: [...] }
// manifest shape, shared by every entry - everything else is entry-specific.
export const SHARED_MANIFEST_FIELDS = ['version', 'author', 'email', 'license', 'connection_id'];

// CLI-only config keys that may arrive via `aivin create --json` but have no business being
// persisted into manifest.json.
export const NON_MANIFEST_CONFIG_KEYS = ['handlerCode', 'overwrite'];

export async function createManifest(pluginDir, name, description, aiConfig) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  let currentManifest = null;
  if (fs.existsSync(manifestPath)) {
    currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  const overrides = { ...(currentManifest || {}), ...(aiConfig || {}) };
  for (const key of NON_MANIFEST_CONFIG_KEYS) delete overrides[key];

  // Proxy plugins keep the flat single-object shape: they have no src/main.ts export to name in a
  // plugins[] entry's required `func` field.
  if (overrides.proxy_config) {
    const flatManifest = {
      id: randomBytes(16).toString('hex'),
      name,
      description,
      version: '1.0.0',
      author: '',
      email: '',
      initial: {},
      ...overrides,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(flatManifest, null, 2));
    return;
  }

  // An existing plugins[] manifest is already in the default shape - keep it, only filling in
  // missing shared fields.
  if (Array.isArray(overrides.plugins)) {
    const newManifest = { version: '1.0.0', author: '', email: '', ...overrides };
    fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));
    return;
  }

  const shared = {};
  const entryOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (SHARED_MANIFEST_FIELDS.includes(key)) shared[key] = value;
    else entryOverrides[key] = value;
  }

  // The default manifest shape: shared fields once at the top level + a plugins[] array, here with
  // a single entry backed by src/main.ts's `main` export. Matches what deploy/runtime already
  // understand for multi-function plugins (see docs/MANIFEST.md) - adding a second function later
  // is just appending another entry. `id` is a local placeholder until the plugin is first
  // deployed, at which point the server assigns (and this CLI writes back) the real one.
  const newManifest = {
    version: '1.0.0',
    author: '',
    email: '',
    ...shared,
    plugins: [
      {
        id: randomBytes(16).toString('hex'),
        name,
        description,
        func: 'main',
        input: {
          data: 'object - Input data for processing',
        },
        output: {
          data: 'object - Processed data result',
        },
        trigger_type: ['manual', 'api', 'chat'],
        initial: {},
        ...entryOverrides,
      },
    ],
  };

  fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));
}

/**
 * The one entry of a default (single-entry plugins[]) manifest, or the manifest itself for the
 * flat single-object shape - for CLI paths that need to read/patch entry-level fields
 * (`id`, `input`, `description`, ...) without caring which shape is on disk. Mutating the returned
 * object mutates the manifest it came from.
 */
export function primaryManifestEntry(manifest) {
  if (manifest && Array.isArray(manifest.plugins) && manifest.plugins.length > 0) {
    return manifest.plugins[0];
  }
  return manifest;
}

export async function createHandler(pluginDir, aiConfig) {
  const header =
    '// Import just the namespace(s) you need - see docs/SDK.md for the full list\n' +
    '// (ai, vector, knowledge, task, store, redis, mongo, workspace, agent, realtime, queue, ...).\n' +
    "import { ai } from '@aivin-labs/sdk';\n" +
    "import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';\n" +
    "import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';";

  let handlerContent;

  if (aiConfig && aiConfig.handlerCode) {
    handlerContent = `${header}\n\n${aiConfig.handlerCode}\n`;
  } else {
    // One entry point to start with - the scaffolded manifest.json's plugins[0] points at this
    // `main` export via its `func` field. To add more functions, export more named functions here
    // and append one plugins[] entry per function - see docs/MANIFEST.md#multi-function-plugins.
    handlerContent = `${header}

export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> {
  try {
    console.log('Plugin main called:', { mission, input });

    // Example: const summary = await ai.prompt(\`Summarize: \${JSON.stringify(input)}\`);

    return {
      status: PluginStatus.SUCCESS,
      data: {
        processed: input,
        timestamp: new Date().toISOString()
      },
      message: 'Plugin executed successfully!'
    };
  } catch (error: any) {
    console.error('Plugin error:', error);
    return {
      status: PluginStatus.ERROR,
      message: error.message,
      error_code: PluginErrorCode.EXECUTION_FAILED
    };
  }
}
`;
  }

  const srcDir = path.join(pluginDir, 'src');
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }
  fs.writeFileSync(path.join(srcDir, 'main.ts'), handlerContent);
}

export async function createPackageJson(pluginDir, name, description, currentPackageJson = null) {
  const newPackageJson = {
    name,
    version: '1.0.0',
    description,
    type: 'module',
    scripts: {
      // `aivin-server` (from @aivin-labs/sdk's own `bin` field) boots the plugin directly - no
      // dependency on @aivin-labs/cli at all. This is what the deployed container's `npm start`
      // actually runs (see DockerHelper.createDockerCompose on the backend), so it must keep
      // working with ONLY @aivin-labs/sdk installed. For local dev, `aivin start` (from
      // @aivin-labs/cli) wraps this same binary with extra flags (--debug, --no-watch, ...).
      start: 'aivin-server',
      // Node's own native TS execution (same mechanism PluginServer.loadPlugin uses to load
      // src/main.ts directly, no separate compile step) - not a new tool/dependency to learn.
      test: 'node --test test/**/*.test.ts',
    },
    dependencies: {
      // Pinned to an exact version, not "latest" - the platform's own AI security scan flags
      // "latest"/range dependency pins as a supply-chain risk (a later, unreviewed version could
      // get pulled in silently) and blocks deployment over it. Reads the version of @aivin-labs/sdk
      // this CLI itself depends on, so it can't drift from what's actually published to npm.
      '@aivin-labs/sdk': SDK_VERSION,
    },
    devDependencies: {
      '@types/node': '^24.0.0',
      typescript: '^5.9.3',
    },
    keywords: ['aivin', 'plugin'],
    engines: { node: '>=22.0.0' },
  };

  if (currentPackageJson) {
    const merged = { ...currentPackageJson, ...newPackageJson };
    merged.scripts = { ...newPackageJson.scripts, ...currentPackageJson.scripts };
    merged.dependencies = { ...currentPackageJson.dependencies, ...newPackageJson.dependencies };
    merged.devDependencies = {
      ...newPackageJson.devDependencies,
      ...currentPackageJson.devDependencies,
    };
    merged.keywords = [
      ...new Set([...(currentPackageJson.keywords || []), ...newPackageJson.keywords]),
    ];

    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(merged, null, 2));
  } else {
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(newPackageJson, null, 2));
  }
}

export async function createTsConfig(pluginDir) {
  const tsConfigPath = path.join(pluginDir, 'tsconfig.json');
  if (fs.existsSync(tsConfigPath)) return;

  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022'],
      module: 'ESNext',
      moduleResolution: 'node',
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      strict: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      noImplicitAny: false,
      noImplicitReturns: false,
      noImplicitThis: false,
      noUnusedLocals: false,
      noUnusedParameters: false,
      useUnknownInCatchVariables: false,
    },
    include: ['src/**/*'],
    exclude: ['node_modules', '**/*.test.ts', '**/*.spec.ts'],
  };

  fs.writeFileSync(tsConfigPath, JSON.stringify(tsConfig, null, 2));
}

export async function createEnv(pluginDir) {
  const envPath = path.join(pluginDir, '.env');
  if (fs.existsSync(envPath)) return;

  const envContent = [
    '# Local development only. In production the container gets these injected automatically',
    '# by the Aivin host (see DockerHelper.createDockerCompose on the backend) - you do not set',
    '# them yourself when deploying.',
    '',
    'NODE_ENV=development',
    '',
    '# SDK calls default to the production backend (api.aivin.cloud) if this is left unset -',
    '# uncomment to point `npm start` / the local test HTTP shim at a local/dev backend instead.',
    '# SDK_GRPC_ENDPOINT=localhost:50051',
    '# SDK_GRPC_SECRET=',
    '',
  ];

  fs.writeFileSync(envPath, envContent.join('\n'));
}
