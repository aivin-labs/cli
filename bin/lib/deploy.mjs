import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { execSync } from 'child_process';
import axios from 'axios';
import { flattenManifestFile } from '@aivin-labs/sdk';

// ── Shared deploy helpers ────────────────────────────────────────────────

export const DEPLOY_EXCLUDE_DIRS = ['node_modules', '.git', '.tmp', 'dist', 'build', '.test'];

// `package-lock.json` is NOT excluded - the backend's generated Dockerfile runs `npm ci`, which
// requires a lockfile to exist in the build context; see ensureLockfile() below.
export const DEPLOY_EXCLUDE_FILES = ['.gitignore', 'yarn.lock'];

// Matches '.env' and every variant (.env.local, .env.production, ...) - these can carry real
// secrets and must never end up in the uploaded `files` payload.
export const isEnvFile = (name) => name === '.env' || name.startsWith('.env.');

// ✅ FIX: readDirectoryRecursive used to read EVERY file with `fs.readFileSync(fullPath, 'utf8')`
// unconditionally - any binary asset (image, font, .wasm, a zip fixture used by a test) gets
// decoded as UTF-8 text and silently mangled before upload, with no warning anywhere. The backend's
// PluginDeployRequestDto only ever accepts `files` as plain UTF-8 string content (no base64/binary
// path exists there), so there is currently no way to deploy a binary asset correctly through this
// command - skipping with a clear warning is strictly better than corrupting it and finding out only
// when the deployed plugin is actually exercised. Same extension list `plugin convert` already uses.
const DEPLOY_BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|zip|tar|gz|pdf|mp4|mp3|wasm|node)$/i;

export function readDirectoryRecursive(dir, basePath = '') {
  const files = {};
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    // Backend keys are always forward-slash, matching how it's later written back with
    // `path.resolve(communityPluginDir, filename)` - on Windows, `path.join` here would produce
    // backslash-separated keys (e.g. "src\\main.ts") that the backend's POSIX filesystem treats as
    // one literal filename containing a backslash, not a nested path - breaking every deploy.
    const relativePath = basePath ? `${basePath}/${item}` : item;
    // lstat (not stat) so a symlink is never followed and treated as a real directory/file to
    // upload - same reasoning as codegen.mjs's buildProjectTree.
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;

    if (stat.isDirectory()) {
      if (!DEPLOY_EXCLUDE_DIRS.includes(item)) {
        Object.assign(files, readDirectoryRecursive(fullPath, relativePath));
      }
    } else if (!DEPLOY_EXCLUDE_FILES.includes(item) && !isEnvFile(item)) {
      if (DEPLOY_BINARY_EXT.test(item)) {
        console.log(chalk.yellow(`⚠️  Skipping "${relativePath}" - binary files aren't supported by \`aivin deploy\` (would be corrupted if uploaded as text).`));
        continue;
      }
      files[relativePath] = fs.readFileSync(fullPath, 'utf8');
    }
  }

  return files;
}

export function incrementVersion(version) {
  const parts = (version || '1.0.0').split('.');
  const patch = parseInt(parts[2] || '0') + 1;
  return `${parts[0] || '1'}.${parts[1] || '0'}.${patch}`;
}

/**
 * Matches the backend's real PluginDeployRequestDto (src/plugins/dto/PluginDTO.ts):
 * { id, manifest, stacks?, files, client?, user_id? }. There's no visibility/scope flag to set here
 * - a plugin deployed through this CLI is always private to your org. The platform's only real
 * "submit to the public store" path is `publish_scope: 'community'` through the browser
 * CodeEditor's `/code/publish` (a different runtime entirely - sandboxed LITE plugins, not this
 * SDK's Docker/gRPC ones); there's currently no CLI-reachable equivalent for that.
 *
 * `files` must be omitted entirely (not sent as `{}`) for a proxy/MCP manifest - the backend's
 * PluginDeploymentService only takes its "manifest-only" branch when `body.files` is falsy
 * (see the `if (body.files) {...} else if (parsedManifest?.proxy_config) {...}` check there); an
 * empty object would still be truthy and misroute a codeless proxy plugin into the code-deploy path.
 *
 * `manifest` here is already flattened (see `flattenManifestFile()`) - a multi-function plugin
 * authored as `{ ...commonFields, plugins: [...] }` on disk arrives here as a flat array of entries.
 * The backend's `deployUnified` checks `Array.isArray(parsedManifest)` BEFORE it even looks at
 * `body.id`, so no top-level `id` is sent for that shape. If every entry declares `proxy_config`
 * there's no code at all (same reasoning as the single-manifest case); otherwise `files` is
 * included, since a multi-function plugin's entries all share one `src/main.ts`/container - see
 * docs/MANIFEST.md#multi-function-plugins.
 */
export function buildDeploymentPayload(manifest, pluginFiles) {
  if (Array.isArray(manifest)) {
    const allProxy = manifest.every((m) => m.proxy_config);
    return allProxy ? { manifest } : { manifest, files: pluginFiles };
  }

  const id = manifest.id || manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (manifest.proxy_config) {
    return { id, manifest };
  }
  return { id, manifest, files: pluginFiles };
}

/**
 * The backend's generated Dockerfile runs `npm ci` (not `npm install`) for reproducible builds -
 * that command hard-requires a lockfile to already exist, but `aivin create`'s scaffold doesn't
 * generate one (only `npm install`, a manual step, does). Rather than make deploy depend on the
 * developer remembering to run that first, generate one automatically (fast - `--package-lock-only`
 * skips downloading/writing node_modules) whenever it's missing.
 */
export function ensureLockfile(currentDir) {
  const lockPath = path.join(currentDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) return;

  console.log(chalk.gray('   No package-lock.json found - generating one (required for the container build)...'));
  try {
    // ✅ FIX: no timeout - a hung npm registry (corporate proxy, network drop mid-request, a
    // private-package auth prompt npm can't actually show under `stdio: 'pipe'`) used to hang
    // `aivin deploy`/`aivin test` indefinitely with no feedback beyond "generating one...".
    execSync('npm install --package-lock-only', { cwd: currentDir, stdio: 'pipe', timeout: 60000 });
  } catch (error) {
    throw new Error(
      `Failed to generate package-lock.json: ${error.stderr?.toString().trim() || error.message}`,
      { cause: error },
    );
  }
}

/**
 * Generates a sample input for `entry.input` (POST /code/generate-sample-data - same AI helper the
 * browser CodeEditor uses) and invokes the freshly deployed plugin with it (POST /plugins/execute),
 * so `aivin test` actually verifies the plugin *runs*, not just that the container built. Returns
 * one result record per entry; never throws - a failure to test is recorded, not fatal to the CLI.
 */
export async function smokeTestEntry(serverUrl, authHeaders, entry, workspaceId) {
  const result = { plugin_id: entry.id, name: entry.name, func: entry.func || undefined };

  let sampleInput = {};
  try {
    const sampleRes = await axios.post(
      `${serverUrl}/code/generate-sample-data`,
      { input_schema: entry.input || {}, logic: entry.description },
      authHeaders,
    );
    sampleInput = sampleRes.data || {};
  } catch (error) {
    result.sample_data_error = error.response?.data?.message || error.message;
  }
  result.input = sampleInput;

  const start = Date.now();
  try {
    const execRes = await axios.post(
      `${serverUrl}/plugins/execute`,
      { plugin_id: entry.id, arguments: sampleInput, workspace_id: workspaceId, purpose: 'aivin test - automated smoke test' },
      authHeaders,
    );
    result.duration_ms = Date.now() - start;
    result.response = execRes.data;
    const status = String(execRes.data?.status || '').toLowerCase();
    // A plugin legitimately blocked on human input/auth is not a *failure* of the plugin itself.
    result.passed = ['success', 'waiting', 'needs_auth', 'hil_timeout'].includes(status) || execRes.data?.status === undefined;
  } catch (error) {
    result.duration_ms = Date.now() - start;
    result.passed = false;
    result.error = error.response?.data?.message || error.message;
  }
  return result;
}

/**
 * Invokes a proxy entry with empty input - `--verify-proxy` opt-in only counterpart to
 * `smokeTestEntry`. Unlike code plugins, there's no AI-generated sample input to fall back on (a
 * proxy's `input` schema is the generic `{ data: object }` passthrough - `generate-sample-data`
 * has nothing meaningful to infer from that), so this sends an empty `arguments: {}` instead:
 * enough to prove the MCP server is reachable and the tool/resource/prompt name resolves, without
 * pretending to know what a "realistic" call looks like for an arbitrary external server.
 */
export async function smokeTestProxyEntry(serverUrl, authHeaders, entry, workspaceId) {
  const result = { plugin_id: entry.id, name: entry.name, func: entry.func || undefined };

  const start = Date.now();
  try {
    const execRes = await axios.post(
      `${serverUrl}/plugins/execute`,
      { plugin_id: entry.id, arguments: {}, workspace_id: workspaceId, purpose: 'aivin test --verify-proxy - automated smoke test' },
      authHeaders,
    );
    result.duration_ms = Date.now() - start;
    result.response = execRes.data;
    const status = String(execRes.data?.status || '').toLowerCase();
    result.passed = ['success', 'waiting', 'needs_auth', 'hil_timeout'].includes(status) || execRes.data?.status === undefined;
  } catch (error) {
    result.duration_ms = Date.now() - start;
    result.passed = false;
    result.error = error.response?.data?.message || error.message;
  }
  return result;
}

/**
 * Runs `smokeTestEntry` for every non-proxy entry and writes a JSON report to `.test/` in the
 * current project - one file per `aivin test` run, so you can diff/compare across runs.
 *
 * Proxy entries are skipped by default - calling an arbitrary external MCP server automatically,
 * with no way to know whether that call is safe to repeat (an email-sending tool isn't idempotent
 * the way a read-only one is), isn't something to do without the developer explicitly asking for
 * it. `verifyProxy: true` (`aivin test --verify-proxy`) opts into `smokeTestProxyEntry` for those
 * entries instead of skipping them - only pass it if you know what the underlying tool(s) do.
 */
export async function runSmokeTest({ currentDir, serverUrl, apiKey, entries, isProxyPlugin, workspaceOverride, verifyProxy }) {
  const hasProxyEntries = entries.some((e) => e.proxy_config);

  if (isProxyPlugin && !verifyProxy) {
    console.log(chalk.gray('   Proxy plugin - no generic smoke test to run (calls an external system, not your code). Pass --verify-proxy to invoke it for real instead.'));
    return;
  }

  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  let workspaceId = workspaceOverride;
  if (!workspaceId) {
    try {
      const wsRes = await axios.get(`${serverUrl}/workspace/list`, authHeaders);
      const workspaces = Array.isArray(wsRes.data) ? wsRes.data : wsRes.data?.items || [];
      workspaceId = workspaces[0]?.id || workspaces[0]?._id;
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Couldn't look up a workspace to test against (${error.message}) - skipping smoke test. Pass --workspace <id> to specify one directly.`));
      return;
    }
  }
  if (!workspaceId) {
    console.log(chalk.yellow('⚠️  No workspace found for this account - skipping smoke test. Pass --workspace <id> to specify one directly.'));
    return;
  }

  console.log(chalk.blue('🧪 Running smoke test (generated input, real invoke)...'));
  if (hasProxyEntries && verifyProxy) {
    console.log(chalk.yellow('⚠️  --verify-proxy: invoking the real external MCP server(s) below with empty input - only use this if you know calling them has no meaningful side effects.'));
  }
  // Give the container a moment to finish binding its gRPC server after the build/up completed.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const results = [];
  for (const entry of entries) {
    // A mixed multi-function batch can have some proxy entries and some real-code entries (see
    // buildDeploymentPayload's doc comment) - the batch-level `isProxyPlugin` check above only
    // catches the all-proxy case, so every proxy entry is handled here individually too: they call
    // an external system, not your code, same reasoning as the early-return above.
    if (entry.proxy_config) {
      if (!verifyProxy) {
        console.log(chalk.gray(`   ${entry.name} - proxy plugin, no generic smoke test to run`));
        continue;
      }
      // `request_hil` is set when the MCP server itself declared this tool destructive/non-readonly
      // (see the backend's McpAdapter.annotationsSuggestHil, sourced from the MCP spec's own
      // readOnlyHint/destructiveHint annotations) - a real signal from the tool's own author, not a
      // guess. `--verify-proxy` already only exists for tools the caller has vetted as safe to call
      // automatically; skip the ones the server itself flagged as NOT safe to call blind, even under
      // that flag, rather than trusting the caller to have known this too.
      if (entry.request_hil) {
        console.log(chalk.yellow(`   ${entry.name} - skipped: this tool is flagged destructive/non-readonly by the MCP server itself (request_hil) - verify it manually instead`));
        continue;
      }
      const proxyResult = await smokeTestProxyEntry(serverUrl, authHeaders, entry, workspaceId);
      results.push(proxyResult);
      const proxyIcon = proxyResult.passed ? chalk.green('✅') : chalk.red('❌');
      console.log(`   ${proxyIcon} ${entry.name} (proxy) - ${proxyResult.passed ? `passed (${proxyResult.duration_ms}ms)` : `failed: ${proxyResult.error || 'unexpected status'}`}`);
      continue;
    }
    const result = await smokeTestEntry(serverUrl, authHeaders, entry, workspaceId);
    results.push(result);
    const icon = result.passed ? chalk.green('✅') : chalk.red('❌');
    const label = `${result.name}${result.func ? ` [${result.func}]` : ''}`;
    console.log(`   ${icon} ${label} - ${result.passed ? `passed (${result.duration_ms}ms)` : `failed: ${result.error || 'unexpected status'}`}`);
  }

  // A failure writing the report (permissions, disk full, ...) shouldn't be reported as a failed
  // deploy - the deploy itself already succeeded by the time we get here.
  try {
    const testDir = path.join(currentDir, '.test');
    fs.mkdirSync(testDir, { recursive: true });
    const reportPath = path.join(testDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ timestamp: new Date().toISOString(), workspace_id: workspaceId, passed: results.every((r) => r.passed), results }, null, 2),
    );
    console.log(chalk.gray(`   Report saved: ${path.relative(currentDir, reportPath)}`));
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Smoke test ran, but saving the report failed: ${error.message}`));
  }
}

export async function deployPlugin({ endpointPath, label, smokeTest, workspaceOverride, verifyProxy }) {
  console.log(chalk.blue(`🚀 ${label}...`));

  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found in current directory');
  }

  // `rawManifest` is exactly what's on disk - possibly the ergonomic { ...commonFields, plugins:
  // [...] } multi-function authoring shape (see docs/MANIFEST.md#multi-function-plugins). `manifest`
  // is always either a single object or a flat array, the only two shapes anything downstream of
  // this needs to understand. For the group shape these are DIFFERENT objects (flatten copies
  // fields), so version bump / assigned-id write-back has to target `rawManifest`, not `manifest` -
  // for the other two shapes they're the same object/array, so mutating one mutates both.
  const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const isGroupShape = !!(rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest) && Array.isArray(rawManifest.plugins));

  const manifest = flattenManifestFile(rawManifest);
  const isBatch = Array.isArray(manifest);
  const entries = isBatch ? manifest : [manifest];

  const isProxyPlugin = entries.every((m) => m.proxy_config);
  if (!isProxyPlugin) {
    ensureLockfile(currentDir);
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;

  if (isBatch) {
    console.log(
      `📦 ${entries.length} plugins (batch): ${entries.map((m) => `${m.name}${m.func ? `[${m.func}]` : ''}`).join(', ')}`,
    );
  } else {
    console.log(
      `📦 ${manifest.name} v${manifest.version}` +
        (isProxyPlugin ? ` [proxy: ${manifest.proxy_config.type}]` : ''),
    );
  }
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  const pluginFiles = isProxyPlugin ? undefined : readDirectoryRecursive(currentDir);
  const deploymentData = buildDeploymentPayload(manifest, pluginFiles);

  const loadingChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let loadingIndex = 0;
  const loadingLabel = isProxyPlugin ? 'Registering proxy manifest...' : 'Uploading and scanning code...';
  const loadingInterval = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(loadingChars[loadingIndex])} ${loadingLabel}`);
    loadingIndex = (loadingIndex + 1) % loadingChars.length;
  }, 100);

  try {
    const response = await axios.post(`${serverUrl}${endpointPath}`, deploymentData, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || 'dev-token'}`,
      },
      // ✅ FIX: no timeout at all before - a hung/overloaded backend meant this could sit forever
      // with no way out short of Ctrl+C. 5 minutes (not the usual short default) since this call
      // covers the actual container build/scan, which can legitimately take a while.
      timeout: 300000,
    });

    clearInterval(loadingInterval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    const result = response.data ?? {};
    if (result.success === false) {
      throw new Error(result.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    console.log(chalk.green(`✅ ${label} succeeded!`));
    // deployUnified's array branch returns { group_id, count, plugin_ids } - plugin_ids is in the
    // same order as the entries we sent, so map them back onto each entry's `id`. For the group
    // authoring shape, that means writing into rawManifest.plugins[i] (the flattened `entries` are
    // disposable copies, not what's on disk).
    if (isBatch) {
      if (Array.isArray(result.plugin_ids)) {
        result.plugin_ids.forEach((assignedId, i) => {
          if (!assignedId || !entries[i] || assignedId === entries[i].id) return;
          entries[i].id = assignedId;
          if (isGroupShape && rawManifest.plugins[i]) rawManifest.plugins[i].id = assignedId;
        });
        console.log(chalk.gray(`   Plugin IDs assigned: ${result.plugin_ids.join(', ')}`));
      }
    } else if (result.plugin_id && result.plugin_id !== manifest.id) {
      // The backend's single-plugin deploy path always reassigns the real, persisted id server-side
      // (never equal to what we sent) - `result.plugin_id` is the ONLY place that real id is ever
      // reported back. Without writing it back here, every later `aivin test`/`plugin trigger` call
      // would keep using the id we originally sent, which was never actually saved as this plugin's
      // queryable id, and every /plugins/execute call by id would fail with "plugin not found".
      manifest.id = result.plugin_id;
      console.log(chalk.gray(`   Plugin ID assigned: ${result.plugin_id}`));
    }
    if (result.group_id) {
      console.log(chalk.gray(`   Group ID: ${result.group_id}`));
    }
    if (result.message) {
      console.log(chalk.gray(`   Message: ${result.message}`));
    }

    if (isGroupShape) {
      // One shared `version` field, not one per entry.
      rawManifest.version = incrementVersion(rawManifest.version);
      fs.writeFileSync(manifestPath, JSON.stringify(rawManifest, null, 2));
      console.log(chalk.blue(`🔄 Version auto-incremented to: ${rawManifest.version}`));
    } else {
      entries.forEach((m) => { m.version = incrementVersion(m.version); });
      fs.writeFileSync(manifestPath, JSON.stringify(rawManifest, null, 2));
      console.log(chalk.blue(`🔄 Version auto-incremented to: ${entries.map((m) => m.version).join(', ')}`));
    }

    if (smokeTest) {
      await runSmokeTest({ currentDir, serverUrl, apiKey, entries, isProxyPlugin, workspaceOverride, verifyProxy });
    }
  } catch (error) {
    clearInterval(loadingInterval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    const message = error.response?.data?.message || error.message;
    console.log(chalk.red(`❌ ${label} failed:`), message);

    if (error.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.log(chalk.yellow('🔧 Check if the Aivin server is running and accessible'));
    } else if (error.response?.status === 401 || error.response?.status === 403) {
      console.log(chalk.yellow('🔧 Check your API_KEY environment variable'));
    }

    if (pluginFiles) {
      console.log(
        chalk.gray(`📁 ${Object.keys(pluginFiles).length} files were prepared for deployment`),
      );
    }
    process.exitCode = 1;
  }
}
