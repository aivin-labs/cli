import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import inquirer from 'inquirer';
import { spawn, execFileSync } from 'child_process';
import os from 'os';
import { createHash, randomBytes } from 'crypto';
import { io } from 'socket.io-client';
import { primaryManifestEntry, createPluginProject, createHandler } from './scaffold.mjs';
import { withSpinner } from './util.mjs';
import { DEPLOY_EXCLUDE_DIRS, isEnvFile } from './deploy.mjs';

/**
 * Static (not AI-generated) entry-point wrapper `aivin init` writes to src/main.ts - deterministic
 * every time, so the only AI-generated file is src/service.ts (the actual business logic). Keeps
 * protocol concerns (PluginResponse/PluginStatus/error_code) out of the business logic entirely -
 * `execute()` just returns plain data or throws a plain Error.
 */
export function buildInitMainWrapper() {
  return `// This file is a thin, static wrapper - the real business logic lives in src/service.ts
// (regenerate it with \`aivin plugin make "<new description>"\`, targeting src/service.ts).
import { execute } from './service.ts';
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> {
  try {
    const data = await execute(input, ctx);
    return { status: PluginStatus.SUCCESS, data, message: 'Success' };
  } catch (error: any) {
    console.error('Plugin error:', error);
    return {
      status: PluginStatus.ERROR,
      message: error.message,
      error_code: PluginErrorCode.EXECUTION_FAILED,
    };
  }
}
`;
}

/**
 * `aivin init`'s code generation - targets src/service.ts (a plain business-logic module, per
 * CodeGenerationHelper's generic "utility file" branch on the backend) instead of src/main.ts (the
 * "MAIN ENTRY POINT, must return PluginResponse" branch `plugin make` targets). Keeps the
 * AI-generated file free of protocol boilerplate - src/main.ts (buildInitMainWrapper, above) is the
 * only place that needs to know about PluginResponse/PluginStatus at all.
 */
export async function generateServiceAndWrapper(pluginDir, description, options = {}) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const servicePath = path.join(pluginDir, 'src', 'service.ts');
  const mainPath = path.join(pluginDir, 'src', 'main.ts');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  const logic = `Write the core business logic for an Aivin plugin, as a single exported function:
  export async function execute(input: PluginInput, ctx: PluginContext): Promise<any>
Rules:
- This is PURE business logic - do NOT return a PluginResponse/{status, data, message} envelope, do NOT import or reference PluginStatus/PluginErrorCode. Just return the actual result data, or throw a plain Error on failure - the caller (src/main.ts) handles wrapping it into the plugin's response format.
- "input" fields come from the manifest's "input" description below. Validate required fields are present at the start and throw a clear Error if not.
- Preferred: import only the namespace(s) you need directly, e.g. import { ai, vector, task, store, redis, mongo } from '@aivin-labs/sdk'; then call ai.prompt(...), vector.search(...), etc. Only fall back to import { call } from '@aivin-labs/sdk'; call(namespace, params) if no sugar method fits.
- Import types from '@aivin-labs/sdk' if needed: import type { PluginInput, PluginContext } from '@aivin-labs/sdk';

Business requirement:
${description}`;

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/code/generate`,
      {
        // No `workspace_files` - see makePluginFromDescription's comment on why that would trip
        // the backend's surgical-edit/diff mode.
        logic,
        // code_id = the entry id, the stable identity of this code workspace on the server -
        // it keys the Redis draft, the RAG index over previously generated files, and the live
        // socket room. func = which export of src/main.ts this generation targets.
        code_id: primaryManifestEntry(manifest).id,
        func: primaryManifestEntry(manifest).func || 'main',
        target_file: 'src/service.ts',
        model: options.model,
        provider: options.provider,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey || 'dev-token'}`,
        },
      },
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Code generation failed: ${message}`, { cause: error });
  }

  const result = response.data ?? {};
  if (!result.code) {
    throw new Error('Aivin server did not return generated code.');
  }
  const looksLikeDiffBlob = /^\s*\{\s*"mode"\s*:\s*"(diff|full)"/.test(result.code);
  if (looksLikeDiffBlob) {
    throw new Error(
      'Aivin server returned an internal patch format instead of plain code - this is a server-side bug, not something to write to src/service.ts. Please report it.',
    );
  }

  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.writeFileSync(servicePath, result.code);
  fs.writeFileSync(mainPath, buildInitMainWrapper());

  applyGeneratedManifestFields(manifestPath, manifest, result);
}

/**
 * `aivin init [name]` - the guided, one-command replacement for `aivin create` + `aivin plugin
 * make`: asks just what's needed (name, business description), scaffolds the project, and
 * generates real working code from the description - split into src/service.ts (business logic,
 * AI-generated) + src/main.ts (protocol wrapper, static/deterministic) instead of one file mixing
 * both concerns, per the same architecture as `plugin make` targeting a non-main.ts file.
 */
export async function initInteractive(options) {
  console.log(chalk.blue('🚀 Aivin Plugin Init\n'));

  const nameGivenUpfront = !!options.name;
  if (nameGivenUpfront && !/^[a-z0-9-]+$/.test(options.name)) {
    throw new Error('Plugin name must contain only lowercase letters, numbers, and hyphens');
  }
  const pluginDir = nameGivenUpfront ? path.join(process.cwd(), options.name) : process.cwd();
  if (nameGivenUpfront && fs.existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`);
  }

  let pluginName = options.name || (nameGivenUpfront ? undefined : path.basename(process.cwd()));

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
      message: 'What should this plugin do? (be specific - this is what generates your code)',
      validate: (input) => (input.trim() ? true : 'A description is required to generate working code'),
    },
  ]);

  pluginName = answers.name || pluginName;
  const description = answers.description;

  // Same as `aivin create`'s createInteractive: scaffolding into the current directory (no name
  // given upfront) can land on top of an already-populated package.json - read it so
  // createPackageJson merges into it instead of clobbering existing scripts/deps/name.
  let currentPackageJson = null;
  if (!nameGivenUpfront) {
    const packageJsonPath = path.join(pluginDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      currentPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    }
  }

  console.log(chalk.gray(`\n📁 Scaffolding ${pluginName}...`));
  // input/output start EMPTY (not the generic {data: "..."} placeholder `aivin create` writes) so
  // generateServiceAndWrapper's applyGeneratedManifestFields (which only fills a field that's
  // currently empty) actually applies the schema the AI infers from the description, instead of
  // silently no-op'ing against an already-non-empty placeholder.
  await createPluginProject(pluginDir, pluginName, description, { input: {}, output: {} }, currentPackageJson, {
    skipHandler: true,
  });

  try {
    await withSpinner('🤖 Generating business logic (src/service.ts)', () => generateServiceAndWrapper(pluginDir, description, options));
    console.log(chalk.green('✅ src/service.ts + src/main.ts generated'));
  } catch (error) {
    // Don't leave a half-scaffolded project on generation failure - fall back to the plain
    // placeholder handler (same one `aivin create` writes), so `aivin init` still leaves a working,
    // deployable plugin the developer can fill in by hand or retry with `aivin plugin make`. Also
    // restores the generic input/output placeholder - the empty {} above only makes sense once
    // generation has actually filled it in.
    console.error(chalk.yellow(`⚠️  Code generation failed (${error.message}) - falling back to a placeholder handler.`));
    await createHandler(pluginDir, null);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = primaryManifestEntry(manifest);
    if (Object.keys(entry.input || {}).length === 0) entry.input = { data: 'object - Input data for processing' };
    if (Object.keys(entry.output || {}).length === 0) entry.output = { data: 'object - Processed data result' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  console.log(chalk.green(`\n✅ Plugin initialized!`));
  console.log(`📁 Directory: ${pluginDir}`);
  console.log(chalk.cyan(`\n🔧 Next steps:`));
  if (nameGivenUpfront) {
    console.log(`   cd ${pluginName}  # Enter the new project directory`);
  }
  console.log(`   npm install     # Install dependencies`);
  console.log(`   npm start       # Start plugin locally (gRPC server + HTTP test shim on :4001)`);
}

/** Single call to POST /code/generate - used directly for surgical per-file fixes in
 *  generateProjectWithSelfCorrection. Throws on network/API failure or if the server ever returns
 *  its internal diff-patch blob instead of plain source. */
export async function requestCodeGeneration(serverUrl, apiKey, payload) {
  let response;
  try {
    response = await axios.post(`${serverUrl}/code/generate`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || 'dev-token'}`,
      },
    });
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Code generation failed: ${message}`, { cause: error });
  }
  const result = response.data ?? {};
  if (!result.code) {
    throw new Error('Aivin server did not return generated code.');
  }
  const looksLikeDiffBlob = /^\s*\{\s*"mode"\s*:\s*"(diff|full)"/.test(result.code);
  if (looksLikeDiffBlob) {
    throw new Error(
      'Aivin server returned an internal patch format instead of plain code - this is a server-side bug, not something to write to src/main.ts. Please report it.',
    );
  }
  return result;
}

// How many times to send tsc's own compiler errors back to the AI and ask it to fix them, on top
// of the first-pass generation. Bounded so a stubborn error (e.g. a package that genuinely isn't
// available in the plugin sandbox) doesn't loop forever burning generation calls.
export const CODEGEN_MAX_FIX_ATTEMPTS = 2;

/** Type-checks the freshly generated handler with the scaffolded project's own `typescript`
 *  devDependency - skipped (not failed) when `node_modules` isn't installed yet, e.g. running
 *  `plugin make`/`convert` straight after `aivin create` and before `npm install`. This is what
 *  gives the self-correction loop something concrete to react to: exact `file(line,col)` compiler
 *  errors, not a guess at what might be wrong. */
/**
 * Runs asynchronously (spawn, not execSync) on purpose: this is also called as the `run_typecheck`
 * tool during `plugin convert`, where the process must keep servicing its socket connection (ping/
 * pong, other tool calls) while tsc runs - a synchronous execSync call blocks the whole event loop
 * for as long as tsc takes, which on a real project can be many seconds and risks the server-side
 * ping timeout disconnecting the socket mid-typecheck.
 */
export function typeCheckHandler(currentDir) {
  return new Promise((resolve) => {
    const tscBin = path.join(currentDir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tscBin)) return resolve({ skipped: true, errors: [] });
    const tsconfigPath = path.join(currentDir, 'tsconfig.json');
    // --incremental caches type-check state in a .tsbuildinfo file (outside the project, keyed by
    // a hash of its path - never written into the user's own directory, nothing to .gitignore).
    // On a large `plugin convert` project, the fix loop can call this 2-3 times in one run; without
    // this, every single call is a full cold recompile of every file, not just the 1-2 that changed
    // since the last attempt.
    const buildInfoDir = path.join(os.tmpdir(), 'aivin-tsc-cache');
    const buildInfoPath = path.join(buildInfoDir, `${createHash('md5').update(currentDir).digest('hex')}.tsbuildinfo`);
    fs.mkdirSync(buildInfoDir, { recursive: true });
    const args = fs.existsSync(tsconfigPath)
      ? ['--noEmit', '--incremental', '--tsBuildInfoFile', buildInfoPath, '-p', tsconfigPath]
      : ['--noEmit', '--incremental', '--tsBuildInfoFile', buildInfoPath, '--skipLibCheck', 'src/main.ts'];
    let output = '';
    const child = spawn(process.execPath, [tscBin, ...args], { cwd: currentDir, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ skipped: false, errors: [error.message] }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ skipped: false, errors: [] });
      // tsc's real per-error lines all match this ("file(line,col): error TSxxxx: message") - filter
      // out the trailing "Found N errors" summary line so only actionable lines go back to the AI.
      const errorLines = output.split('\n').filter((line) => /error TS\d+/.test(line));
      resolve({ skipped: false, errors: errorLines.length > 0 ? errorLines : [output.trim()].filter(Boolean) });
    });
  });
}

// Off-default ports so this doesn't collide with a real `aivin start` (4001/50051) the developer
// might already have running for the same or another plugin while `plugin convert` is going.
export const SMOKE_TEST_HTTP_PORT = 47401;

export const SMOKE_TEST_GRPC_BIND = '0.0.0.0:47451';

export const SMOKE_TEST_READY_TIMEOUT_MS = 15_000;

/**
 * Runs `aivin plugin convert`'s `run_smoke_test` tool call: spawns the exact same runtime
 * `aivin start` uses (the target project's own installed `@aivin-labs/sdk`'s `bin/server.mjs` -
 * not anything bundled with this CLI package) against the just-generated project, waits for its
 * local HTTP test shim to come up, POSTs the AI-generated sample input to it, and reports back
 * whether the plugin actually ran successfully - not just whether it type-checks. Always kills the
 * spawned process afterward, success or failure.
 */
export async function runSmokeTestHandler(currentDir, args) {
  const sdkPkgPath = path.join(currentDir, 'node_modules', '@aivin-labs', 'sdk');
  if (!fs.existsSync(sdkPkgPath)) return { skipped: true };

  const serverPath = path.join(sdkPkgPath, 'bin', 'server.mjs');
  let stderrOutput = '';
  const child = spawn(process.execPath, [serverPath], {
    cwd: currentDir,
    env: {
      ...process.env,
      LOCAL_TEST_PORT: String(SMOKE_TEST_HTTP_PORT),
      SDK_GRPC_SERVER_BIND: SMOKE_TEST_GRPC_BIND,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderrOutput += chunk.toString().slice(0, 500); });
  child.on('error', () => {}); // reported via the readiness poll failing below, not here

  try {
    const deadline = Date.now() + SMOKE_TEST_READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await axios.get(`http://localhost:${SMOKE_TEST_HTTP_PORT}/health`, { timeout: 1000 });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!ready) {
      return { skipped: false, success: false, error: `Local runtime didn't become ready within ${SMOKE_TEST_READY_TIMEOUT_MS / 1000}s${stderrOutput ? `: ${stderrOutput}` : ''}` };
    }

    let response;
    try {
      response = await axios.post(
        `http://localhost:${SMOKE_TEST_HTTP_PORT}/invoke`,
        { mission: args.mission || 'smoke-test', input: args.input || {} },
        { timeout: 30_000, validateStatus: () => true },
      );
    } catch (error) {
      return { skipped: false, success: false, error: error.message };
    }

    if (!response.data?.success) {
      return { skipped: false, success: false, error: response.data?.error || `HTTP ${response.status}` };
    }
    const result = response.data.result;
    if (result && typeof result === 'object' && 'status' in result && result.status !== 'success') {
      return { skipped: false, success: false, error: result.message || `Plugin returned status: ${result.status}` };
    }
    return { skipped: false, success: true };
  } finally {
    child.kill('SIGTERM');
  }
}

/**
 * Calls the real AI code generator (POST /code/generate - CodeHandler.generateCode on the
 * frontend, same endpoint the browser CodeEditor uses). That endpoint's default output already
 * targets `main(mission, input, ctx)` + `ctx.sdk.*` + `PluginResponse` - the same conventions this
 * Docker-runtime SDK uses - so the prompt below is reinforcement, not an override.
 */
/** Groups tsc error lines ("file(line,col): error TSxxxx: ...") by the file path they were
 *  reported against - used by generateProjectWithSelfCorrection to know which of a multi-file
 *  project's files to send back for a surgical fix. */
export function groupCompilerErrorsByFile(errors, knownPaths) {
  const byFile = new Map();
  for (const line of errors) {
    const match = line.match(/^([^(]+)\(\d+,\d+\)/);
    const filePath = match && knownPaths.has(match[1]) ? match[1] : undefined;
    if (!filePath) continue;
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath).push(line);
  }
  return byFile;
}

/**
 * Writes every file from `/code/generate-project`'s response, then runs a bounded self-correction
 * loop generalized to N files: `typeCheckHandler` already type-checks the whole project (via
 * tsconfig.json) regardless of file count, so this just needs to attribute errors back to the
 * right file (groupCompilerErrorsByFile) and fix each one via a surgical `/code/generate` call
 * (existingContent + target_file triggers the backend's surgical-edit path - the same mechanism
 * `plugin convert`'s action="update" files use).
 */
export async function generateProjectWithSelfCorrection(serverUrl, apiKey, currentDir, files, options) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(currentDir, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  const knownPaths = new Set(Object.keys(files));
  for (let attempt = 0; attempt <= CODEGEN_MAX_FIX_ATTEMPTS; attempt++) {
    const check = await withSpinner(attempt === 0 ? '🔎 Type-checking' : `🔧 Re-checking (attempt ${attempt}/${CODEGEN_MAX_FIX_ATTEMPTS})`, () => typeCheckHandler(currentDir));
    if (check.skipped) {
      console.log(chalk.gray('   (skipped type-check - run `npm install` first for the self-correction loop to catch compiler errors)'));
      return files;
    }
    if (check.errors.length === 0) {
      if (attempt > 0) console.log(chalk.green(`✅ Fixed - clean type-check after ${attempt} attempt(s)`));
      return files;
    }

    const byFile = groupCompilerErrorsByFile(check.errors, knownPaths);
    if (attempt === CODEGEN_MAX_FIX_ATTEMPTS || byFile.size === 0) {
      console.log(chalk.yellow(`⚠️  ${check.errors.length} compiler error(s) remain${attempt > 0 ? ` after ${attempt} fix attempt(s)` : ''} - review manually:`));
      check.errors.forEach((line) => console.log(chalk.gray(`   ${line}`)));
      return files;
    }

    console.log(chalk.yellow(`⚠️  ${check.errors.length} compiler error(s) across ${byFile.size} file(s) - asking the AI to fix...`));
    for (const [relPath, errors] of byFile) {
      const fullPath = path.join(currentDir, ...relPath.split('/'));
      const result = await withSpinner(`   fixing ${relPath}`, () =>
        requestCodeGeneration(serverUrl, apiKey, {
          logic: `Fix these compiler errors:\n${errors.join('\n')}`,
          target_file: relPath,
          workspace_files: { [relPath]: files[relPath] },
          model: options.model,
          provider: options.provider,
        }),
      );
      files[relPath] = result.code;
      fs.writeFileSync(fullPath, result.code);
    }
  }
  return files;
}

/**
 * `aivin plugin make` - complexity-adaptive since the backend now classifies the task first
 * (see CodeEditorService.genFreshProject/CodeGenerationHelper.planFreshProject): a simple/moderate
 * requirement still costs exactly one generation call and writes exactly src/main.ts, same as
 * always; a genuinely complex one gets planned into a small multi-file project and a matching
 * multi-entry manifest, instead of everything being crammed into one flat main().
 */
export async function makePluginFromDescription(description, options = {}) {
  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found. Run `aivin create` first.');
  }

  // A project created by `aivin init` has src/service.ts (business logic) + a static src/main.ts
  // wrapper - regenerating here should target service.ts too, or it'd overwrite that clean split
  // with a single self-contained main.ts, silently undoing it.
  if (fs.existsSync(path.join(currentDir, 'src', 'service.ts'))) {
    console.log(chalk.gray('src/service.ts found - regenerating business logic there (main.ts wrapper unchanged).'));
    await withSpinner('🤖 Generating business logic (src/service.ts)', () => generateServiceAndWrapper(currentDir, description, options));
    console.log(chalk.green('✅ src/service.ts regenerated'));
    console.log(chalk.cyan('\n🔧 Next steps:'));
    console.log('   aivin start   # test locally');
    console.log('   aivin test    # deploy to a test instance');
    return;
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = primaryManifestEntry(manifest);

  let response;
  try {
    response = await withSpinner('🤖 Generating plugin', () =>
      axios.post(
        `${serverUrl}/code/generate-project`,
        { logic: description, code_id: entry.id, model: options.model, provider: options.provider },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'dev-token'}` } },
      ),
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Code generation failed: ${message}`, { cause: error });
  }

  const { files, manifest: manifestFragment, plan } = response.data ?? {};
  if (!files || Object.keys(files).length === 0) {
    throw new Error('Aivin server did not return any generated files.');
  }
  if (plan?.multi_entry) {
    console.log(chalk.blue(`🔎 ${plan.reasoning || 'Multiple independent capabilities detected'}`));
  }

  const finalFiles = await generateProjectWithSelfCorrection(serverUrl, apiKey, currentDir, files, options);
  const fileList = Object.keys(finalFiles);
  console.log(chalk.green(`✅ ${fileList.length} file(s) generated`), fileList.length > 1 ? chalk.gray(`(${fileList.join(', ')})`) : '');

  if (manifestFragment?.plugins?.length) {
    // multi_entry: backend planned 2+ independent capabilities - replace plugins[] with them.
    // Fresh ids assigned locally - the server never allocates plugin ids, only `aivin deploy` does.
    manifest.plugins = manifestFragment.plugins.map((p) => ({ id: randomBytes(16).toString('hex'), input: {}, initial: {}, ...p }));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green(`✅ manifest.json split into ${manifest.plugins.length} plugin entries`));
  } else if (manifestFragment) {
    applyGeneratedManifestFields(manifestPath, manifest, manifestFragment);
  }

  console.log(chalk.cyan('\n🔧 Next steps:'));
  console.log('   aivin start   # test locally');
  console.log('   aivin test    # deploy to a test instance');
}

/** Shared by `plugin make`/`plugin convert` - fills in whatever manifest fields the AI inferred
 *  alongside the code, but only ones you haven't already set yourself. Entry-level fields are
 *  patched on the primary plugins[] entry for the default manifest shape (see
 *  `primaryManifestEntry`), flat fields for the legacy single-object shape. */
export function applyGeneratedManifestFields(manifestPath, manifest, result) {
  const entry = primaryManifestEntry(manifest);
  let manifestChanged = false;
  if (result.description && !entry.description) {
    entry.description = result.description;
    manifestChanged = true;
  }
  const instructions = result.instructions || result.instruction;
  if (instructions && !entry.instructions) {
    entry.instructions = instructions;
    manifestChanged = true;
  }
  const inputSchema = result.input || result.input_schema;
  if (inputSchema && (!entry.input || Object.keys(entry.input).length === 0)) {
    entry.input = inputSchema;
    manifestChanged = true;
  }
  if (manifestChanged) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green('✅ manifest.json enriched from generated result'));
  }
}

// Same dirs/files `aivin deploy` already ignores, plus lockfiles and binary-ish assets that are
// never worth reading as source. Only used to keep the TREE clean - actual file CONTENT is never
// read here; the backend requests specific paths back on demand (see runProjectToolServer).
export const CONVERT_EXCLUDE_DIRS = [...DEPLOY_EXCLUDE_DIRS, 'coverage', '.next', '.cache', '.vscode', '.idea'];

export const CONVERT_EXCLUDE_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.gitignore'];

export const CONVERT_BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|zip|tar|gz|pdf|mp4|mp3|wasm|node)$/i;

export const CONVERT_MAX_TREE_ENTRIES = 5000; // matches the backend's own cap (assertSafeProjectTree)

/**
 * Builds the directory tree `plugin convert` uploads - paths + byte sizes ONLY, never content.
 * Keeps the initial request cheap regardless of project size (previously this walked the whole
 * project reading every file's content up front - wasteful and doesn't scale to a large/heavy
 * project). The backend's ProjectConversionService scans this tree and asks for specific files
 * back one at a time via `code:tool_call` (see runProjectToolServer below) as its own plan loop
 * decides it actually needs them.
 */
export function buildProjectTree(dir, basePath = '', entries = []) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (entries.length >= CONVERT_MAX_TREE_ENTRIES) break;
    const fullPath = path.join(dir, item);
    const relativePath = path.join(basePath, item).split(path.sep).join('/');
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!CONVERT_EXCLUDE_DIRS.includes(item)) buildProjectTree(fullPath, relativePath, entries);
    } else if (!CONVERT_EXCLUDE_FILES.includes(item) && !isEnvFile(item) && !CONVERT_BINARY_EXT.test(item)) {
      entries.push({ path: relativePath, size: stat.size });
    }
  }
  return entries;
}

/** Resolves a backend-requested relative path against the real project directory, rejecting
 *  anything that would escape it. This is the actual security boundary for the tool-call relay -
 *  the backend validates paths too (assertSafeProjectPath), but this process is the one holding
 *  the real filesystem, so this check is the one that actually matters. */
export function resolveProjectPath(currentDir, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath) throw new Error('Invalid path');
  const resolved = path.resolve(currentDir, requestedPath);
  const rootWithSep = currentDir.endsWith(path.sep) ? currentDir : currentDir + path.sep;
  if (resolved !== currentDir && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes project directory: ${requestedPath}`);
  }
  return resolved;
}

/** Best-effort `git status --porcelain -- <path>` for one file - execFileSync (argv array, no
 *  shell) rather than execSync, since `path` came from the backend's AI-generated plan and could
 *  contain characters that would be unsafe to interpolate into a shell string. Returns null (not
 *  an error) when the directory isn't a git repo, `git` isn't installed, or the file is clean -
 *  this is a confirmation hint, never a hard requirement. */
export function describeGitStatus(currentDir, relPath) {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--', relPath], { cwd: currentDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = output.split('\n').find((l) => l.trim());
    if (!line) return null;
    const code = line.slice(0, 2).trim();
    return code === '??' ? 'untracked' : 'has uncommitted changes';
  } catch {
    return null;
  }
}

/** Warns (and, in an interactive terminal, asks to confirm) before a conversion that may overwrite
 *  existing files starts, if the project has uncommitted changes - conversion can pick actual
 *  existing files as action="update" targets, and there's no undo once create_file writes over
 *  one. Never blocks a non-git directory or non-interactive (CI/script) use - just informs. */
export async function warnIfGitDirty(currentDir) {
  let statusOutput;
  try {
    statusOutput = execFileSync('git', ['status', '--porcelain'], { cwd: currentDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return; // not a git repo (or git missing) - nothing to warn about
  }
  const dirtyCount = statusOutput.split('\n').filter((l) => l.trim()).length;
  if (dirtyCount === 0) return;
  console.log(chalk.yellow(`⚠️  ${dirtyCount} uncommitted change(s) in this repo - conversion may update existing files based on what it reads.`));
  if (!process.stdin.isTTY || !process.stdout.isTTY) return; // can't prompt - warning above is all we can do
  const { proceed } = await inquirer.prompt([{ type: 'confirm', name: 'proceed', message: 'Continue anyway?', default: false }]);
  if (!proceed) throw new Error('Cancelled - commit or stash your changes first, then re-run.');
}

/** Executes one `code:tool_call` the backend sent during project conversion, against the real
 *  project directory on disk. See CodeDTO.ts's ProjectTool on the backend for the full contract. */
export async function executeProjectTool(currentDir, tool, args) {
  switch (tool) {
    case 'read_file': {
      const filePath = resolveProjectPath(currentDir, args.path);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        throw new Error(`File not found: ${args.path}`);
      }
      return fs.readFileSync(filePath, 'utf8');
    }
    case 'grep': {
      const regex = new RegExp(args.pattern, 'i');
      const matches = [];
      const walk = (dir, base = '') => {
        for (const item of fs.readdirSync(dir)) {
          if (matches.length >= 20) return;
          const fullPath = path.join(dir, item);
          const rel = path.join(base, item).split(path.sep).join('/');
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            if (!CONVERT_EXCLUDE_DIRS.includes(item)) walk(fullPath, rel);
          } else if (!CONVERT_BINARY_EXT.test(item) && stat.size > 0 && stat.size <= 200_000) {
            if (regex.test(fs.readFileSync(fullPath, 'utf8'))) matches.push(rel);
          }
        }
      };
      walk(currentDir);
      return matches;
    }
    case 'confirm_update': {
      const filePath = resolveProjectPath(currentDir, args.path);
      if (!fs.existsSync(filePath)) return { approved: true }; // nothing there to overwrite
      const gitHint = describeGitStatus(currentDir, args.path);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        // Non-interactive (CI/script) - can't prompt, so proceed but make the decision visible.
        console.log(chalk.yellow(`⚠️  Non-interactive - overwriting existing file ${args.path}${gitHint ? ` (${gitHint})` : ''} without confirmation`));
        return { approved: true };
      }
      const { approved } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'approved',
          message: `Overwrite existing file ${args.path}${gitHint ? ` (${gitHint})` : ''}?`,
          default: false,
        },
      ]);
      return { approved };
    }
    case 'create_file': {
      const filePath = resolveProjectPath(currentDir, args.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content ?? '');
      return { written: true };
    }
    case 'run_typecheck':
      return await typeCheckHandler(currentDir);
    case 'run_smoke_test':
      return await runSmokeTestHandler(currentDir, args);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/** Wires the socket side of the tool-call relay: joins the conversion's room, executes every
 *  `code:tool_call` the backend sends against the real project directory, replies with
 *  `code:tool_result`, and prints every `code:progress` event live so a loop that can take a
 *  while (scan → plan → generate → verify, possibly several files) doesn't look hung. */
export async function connectProjectToolServer(serverUrl, apiKey, codeId, currentDir) {
  const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true });

  try {
    await new Promise((resolve, reject) => {
      socket.on('connect_error', (error) => reject(new Error(`Connection failed: ${error.message}`)));
      socket.on('connect', () => {
        socket.emit('code:join', { code_id: codeId }, (ack) => {
          if (!ack?.success) reject(new Error(`Couldn't join conversion session: ${ack?.error || 'unknown error'}`));
          else resolve();
        });
      });
    });
  } catch (error) {
    // `reconnection: true` means a socket left connected-but-erroring here would keep retrying in
    // the background forever - the caller never gets a `socket` reference back to clean it up since
    // this function is what throws instead of returning one.
    socket.disconnect();
    throw error;
  }

  socket.on('code:tool_call', async (payload) => {
    const { call_id, tool, args } = payload || {};
    try {
      const result = await executeProjectTool(currentDir, tool, args || {});
      socket.emit('code:tool_result', { call_id, code_id: codeId, ok: true, result });
    } catch (error) {
      socket.emit('code:tool_result', { call_id, code_id: codeId, ok: false, error: error.message });
    }
  });

  socket.on('code:progress', (payload) => {
    console.log(chalk.gray(`[${new Date().toLocaleTimeString()}]`), payload?.message || '');
    if (Array.isArray(payload?.errors)) payload.errors.forEach((e) => console.log(chalk.red('   '), e));
  });

  return socket;
}

/**
 * `aivin plugin convert` - hands the existing project in the current directory to the backend's
 * ProjectConversionService instead of generating locally: uploads only the directory tree (paths
 * + sizes, never content), then answers `read_file`/`grep`/`create_file`/`run_typecheck` tool
 * calls against the real project on disk as the backend's own scan → plan → generate → verify
 * loop asks for them. The backend decides single-vs-multi-function and create-vs-update per file
 * (see PLAN_PROJECT_INSTRUCTION on the backend) - this command no longer guesses that locally.
 */
export async function convertExistingProject(hint, options = {}) {
  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');
  const handlerPath = path.join(currentDir, 'src', 'main.ts');

  await warnIfGitDirty(currentDir);

  // --force re-runs the full scan/plan/generate/verify loop even if a previous `plugin convert`
  // already wrote src/main.ts - for when that result turned out wrong, stale, or the project
  // changed since. src/main.ts isn't special-cased out of the tree, so the backend's plan is free
  // to mark it action="update"; the usual confirm_update prompt still gates actually overwriting it.
  if (fs.existsSync(handlerPath) && !options.force) {
    throw new Error(
      'src/main.ts already exists - `plugin convert` is for a project that isn\'t an Aivin plugin yet. ' +
        'Pass --force to re-run conversion anyway (e.g. the previous result was wrong or the project changed).',
    );
  }

  let manifest;
  let codeId;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    codeId = primaryManifestEntry(manifest)?.id || randomBytes(16).toString('hex');
  } else {
    // No `aivin create` needed first - infer a starting manifest from package.json (or the
    // directory name) so there's less setup between "I have a project" and "it's a plugin".
    let pkg = null;
    const pkgPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* not JSON we can use */ }
    }
    const name = (pkg?.name || path.basename(currentDir)).replace('@aivin/plugin-', '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    codeId = randomBytes(16).toString('hex');
    // Same default plugins[] shape `aivin create`/`aivin init` scaffold - see createManifest.
    manifest = {
      version: '1.0.0',
      author: '',
      email: '',
      plugins: [{ id: codeId, name, description: pkg?.description || '', func: 'main', input: {}, initial: {} }],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green('✅ manifest.json created'), chalk.gray(`(name: ${name})`));
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  console.log(chalk.blue('📂 Scanning project tree...'));
  const tree = buildProjectTree(currentDir);
  if (tree.length === 0) {
    throw new Error('No source files found in the current directory.');
  }
  console.log(chalk.gray(`   ${tree.length} file(s) in tree (content read on demand by the server, never uploaded up front)`));

  const socket = await connectProjectToolServer(serverUrl, apiKey, codeId, currentDir);

  console.log(chalk.blue('🤖 Converting - this loops (scan → plan → generate → verify), watch for progress below...\n'));
  let response;
  try {
    response = await axios.post(
      `${serverUrl}/code/convert-project`,
      {
        logic: hint || 'Convert the project in the current directory into an Aivin plugin.',
        code_id: codeId,
        hint,
        tree,
        model: options.model,
        provider: options.provider,
      },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'dev-token'}` },
        timeout: 600_000, // a real multi-file scan/plan/generate/verify loop can take several minutes
      },
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Project conversion failed: ${message}`, { cause: error });
  } finally {
    socket.disconnect();
  }

  const { plan, manifest: manifestFragment, verification } = response.data ?? {};

  if (manifestFragment?.plugins?.length) {
    // Backend planned 2+ independent capabilities (multi_entry) - replace plugins[] with them.
    // Fresh ids assigned locally - the server never allocates plugin ids, only `aivin deploy` does.
    manifest.plugins = manifestFragment.plugins.map((p) => ({ id: randomBytes(16).toString('hex'), input: {}, initial: {}, ...p }));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green(`✅ manifest.json split into ${manifest.plugins.length} plugin entries`));
  }

  const isJsTsSource = !plan?.source_language || /^(type|java)script$/i.test(plan.source_language);
  const languageNote = isJsTsSource ? '' : `, ported from ${plan.source_language}`;
  console.log(chalk.green(`\n✅ Conversion done`), chalk.gray(`(${plan?.project_kind || 'generic'}${languageNote}, ${plan?.files?.length ?? 0} file(s))`));
  if (!isJsTsSource) {
    console.log(chalk.yellow(`⚠️  Source was ${plan.source_language}, not TypeScript - this is a translated port, not a mechanical conversion. Review generated logic especially carefully, and check for "limitation" comments left where no direct npm equivalent existed.`));
  }
  if (verification && !verification.success) {
    console.log(chalk.yellow(`⚠️  ${verification.ran ? 'Type-check still finds issues after auto-fix attempts' : 'Verification was skipped'} - review before deploying.`));
  }
  console.log(chalk.yellow('\n⚠️  Review the generated code before relying on it - it\'s a strong starting point, not a guarantee.'));
  console.log(chalk.cyan('\n🔧 Next steps:'));
  console.log('   aivin start   # test locally');
  console.log('   aivin test    # deploy to a test instance');
}
