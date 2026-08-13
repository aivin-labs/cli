import chalk from 'chalk';
import { exec } from 'child_process';
import http from 'http';
import os from 'os';
import { randomBytes } from 'crypto';
import inquirer from 'inquirer';
import axios from 'axios';
import { DEFAULT_AIVIN_BASE_URL, saveActiveContext } from './context.mjs';

// ── Login - get an API key saved once, machine-wide ─────────────────────────

/**
 * Writes to `~/.aivin/credentials`, not the current project's `.env` - a login is a per-machine
 * context, not a per-project one, so `aivin login` only needs to happen once regardless of how many
 * plugin projects you work in on this machine, and switching targets is just logging in again with
 * a different `baseUrl`. A project's own `.env` can still set `AIVIN_BASE_URL`/`API_KEY` directly to
 * pin itself to something other than the machine's current context - see the dotenv.config()
 * precedence at the top of this file.
 */
export function saveGlobalApiKey(apiKey, baseUrl = process.env.AIVIN_BASE_URL || DEFAULT_AIVIN_BASE_URL, identity) {
  return saveActiveContext(baseUrl, apiKey, identity);
}

export function openBrowser(url) {
  const platform = process.platform;
  const command =
    platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, (error) => {
    if (error) {
      console.log(chalk.yellow('Could not open a browser automatically - open this URL manually:'));
      console.log(chalk.cyan(`   ${url}`));
    }
  });
}

/**
 * Default `aivin login` flow: opens the platform's actual web app (not the API) so the user logs
 * in exactly the way they normally would - custom-domain org, password, Google, OTP, whatever
 * applies to their account - none of that multi-tenant login logic is reimplemented here. A tiny
 * local HTTP server waits for the browser to hand back a freshly-minted API key. The web app side
 * of this handoff lives in ApiKeysTab.jsx (mint + redirect) and ProfileHook.jsx (auto-open the tab) -
 * see docs/CLI.md#aivin-login.
 */
export async function browserLogin() {
  // Defaults to the production web app - override with AIVIN_WEB_URL only if you're pointing at a
  // local/dev/staging frontend instead.
  const webBaseUrl = process.env.AIVIN_WEB_URL || 'https://brain.aivin.cloud';

  const state = randomBytes(16).toString('hex');
  let resolveKey, rejectKey;
  const keyPromise = new Promise((resolve, reject) => {
    resolveKey = resolve;
    rejectKey = reject;
  });
  // If `server.listen()` itself errors below, this promise gets rejected via rejectKey() but the
  // function throws from the port-await first (before `return keyPromise` is ever reached) - leaving
  // it as an unobserved rejection. This passive handler only silences that warning; it doesn't
  // consume keyPromise's rejection for the normal caller, who awaits the promise returned below.
  keyPromise.catch(() => {});

  let timeout;
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const key = url.searchParams.get('key');
    const receivedState = url.searchParams.get('state');
    const ok = !!key && receivedState === state;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">' +
        (ok
          ? '<h2>Login successful</h2><p>You can close this window and return to your terminal.</p>'
          : '<h2>Login failed</h2><p>Close this window and retry <code>aivin login</code>.</p>') +
        // Only works on tabs opened via script (window.open), not a typed/clicked URL - harmless
        // no-op otherwise, hence the fallback "you can close this" text above regardless.
        '<script>window.close();</script>' +
        '</body></html>',
    );

    clearTimeout(timeout);
    server.close();
    if (ok) resolveKey(key);
    else rejectKey(new Error('Login callback was missing a key or had a state mismatch'));
  });
  server.on('error', (err) => rejectKey(err));

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const authUrl = new URL('/', webBaseUrl);
  authUrl.searchParams.set('cli_redirect', `http://127.0.0.1:${port}/callback`);
  authUrl.searchParams.set('cli_state', state);
  authUrl.searchParams.set('cli_name', os.hostname());

  console.log(chalk.blue('🌐 Opening your browser to log in...'));
  console.log(chalk.gray(`   ${authUrl.toString()}`));
  console.log(chalk.gray('   Not opened automatically? Paste that URL into your browser.'));
  console.log(chalk.gray('   Waiting for you to confirm in the browser (5 min timeout)...'));
  openBrowser(authUrl.toString());

  timeout = setTimeout(() => {
    server.close();
    rejectKey(new Error('Timed out waiting for browser login (5 minutes)'));
  }, 5 * 60 * 1000);

  return keyPromise;
}

/**
 * Prompts for email/password directly in the terminal (no browser) and exchanges them for a real
 * session JWT via `POST /user/login`. Only supports the platform's default/shared client
 * (`--client`, falls back to the same 'aivin.cloud' default the web app itself falls back to when
 * no custom-domain org is resolved) - accounts under a custom-domain organization need that domain
 * resolved first, which is exactly what the web login page normally does.
 *
 * This JWT is deliberately never persisted anywhere (unlike the final API key `aivin login` saves
 * to `~/.aivin/credentials`) - every command that needs one (`aivin login --basic`, `aivin key
 * gen`/`revoke`) re-prompts and re-exchanges it fresh. That mirrors the backend on purpose: the
 * `/apikey` routes (list/create/delete) require this session JWT and deliberately do NOT accept an
 * existing API key in its place (see AuthGuard.tryApiKeyAuth's doc comment) - a leaked/scoped key
 * must never be able to mint or revoke other keys on its own.
 */
export async function obtainAccessToken(options) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const client = options.client || 'aivin.cloud';

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'email',
      message: 'Email:',
      validate: (input) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) || 'Please enter a valid email address',
    },
    {
      type: 'password',
      name: 'password',
      message: 'Password:',
      mask: '*',
      validate: (input) => input.length > 0 || 'Password is required',
    },
  ]);

  console.log(chalk.yellow('🔄 Logging in...'));
  console.log(
    chalk.gray(
      `   Using client "${client}" - if your account belongs to a custom-domain organization, use ` +
        '`aivin login` (browser flow) instead, which resolves that automatically.',
    ),
  );

  try {
    const loginRes = await axios.post(`${serverUrl}/user/login`, {
      client,
      email: answers.email,
      nickname: answers.email.toLowerCase(),
      password: answers.password,
      auth_type: 'basic',
      auth_provider: 'tenant',
    });
    const accessToken = loginRes.data?.access_token;
    if (!accessToken) throw new Error('Login response did not include an access token');
    return { serverUrl, accessToken };
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Login failed: ${message}`, { cause: error });
  }
}

/**
 * `aivin login --basic`: the login-specific half of the flow above - exchange credentials for a
 * JWT, then mint (replacing any previous same-named key) the one API key that gets saved to
 * `~/.aivin/credentials`.
 */
export async function basicLogin(options) {
  const { serverUrl, accessToken } = await obtainAccessToken(options);
  const authHeaders = { headers: { Authorization: `Bearer ${accessToken}` } };
  const deviceName = os.hostname();

  // Replace (not accumulate) a previous key from this same device - `aivin login` re-run on the
  // same machine used to create yet another "Aivin CLI - <host>" entry every time, cluttering the
  // key list with duplicates. Best-effort: if listing/revoking fails for any reason, still proceed
  // to mint a new key rather than blocking login on it.
  try {
    const listRes = await axios.get(`${serverUrl}/apikey`, authHeaders);
    const existing = (listRes.data?.items || []).find((k) => k.name === deviceName);
    if (existing) {
      await axios.delete(`${serverUrl}/apikey/${existing.id || existing._id}`, authHeaders);
    }
  } catch (error) {
    console.log(chalk.gray(`   (couldn't check for an existing key to replace: ${error.message})`));
  }

  try {
    const keyRes = await axios.post(`${serverUrl}/apikey`, { name: deviceName }, authHeaders);
    if (!keyRes.data?.plainKey) throw new Error('Response did not include an API key');
    return keyRes.data.plainKey;
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to create API key: ${message}`, { cause: error });
  }
}

// ── API key management - named keys for your account, separate from `aivin login`'s one ───────
//
// `aivin login` mints exactly one machine-wide key named after this hostname. These commands
// manage arbitrary named keys on the same account (e.g. one per CI pipeline, one per teammate's
// script) via the same `/apikey` endpoints the web app's Settings > API Keys tab and `aivin
// login`'s device-key replacement already use - authenticated with the API_KEY already saved by
// `aivin login`, not a fresh email/password prompt (see ApiKeyController's `@AllowApiKey()` +
// AuthGuard's `request.apiKeyAuth` fallback on the backend).
//
// `key gen` still prompts for your account password even though it doesn't ask for email - minting
// a new key from an existing one is the one action here that could otherwise let an
// already-compromised key re-provision itself indefinitely after being revoked, so the backend
// requires this step-up proof before creating one. `key list`/`key revoke` never grant anything
// (read metadata / remove access only), so they need no such prompt.

export function requireSavedApiKey() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY not set - run `aivin login` first.');
  }
  return apiKey;
}

/**
 * The client id a key was minted under is baked right into it (`${client}-ak-<...>`, see
 * ApiKeyService.createApiKey/parseApiKeyBearer on the backend) - parse it out locally so `client`
 * is always shown even if the `/apikey/whoami` network call below fails.
 */
export function parseApiKeyClient(apiKey) {
  const anchorIndex = apiKey.lastIndexOf('-ak-');
  return anchorIndex === -1 ? undefined : apiKey.substring(0, anchorIndex);
}

/** `{ email, client, name }` for the account the given API key belongs to - see `GET /apikey/whoami`. */
export async function fetchWhoami(serverUrl, apiKey) {
  const res = await axios.get(`${serverUrl}/apikey/whoami`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return res.data || {};
}

/**
 * Best-effort variant for call sites where identity is a nice-to-have saved alongside credentials
 * (so `aivin whoami` can later read it straight from the file) rather than the point of the call -
 * a lookup failure here shouldn't block login/key creation itself.
 */
export async function tryFetchWhoami(serverUrl, apiKey) {
  try {
    return await fetchWhoami(serverUrl, apiKey);
  } catch {
    return {};
  }
}

/**
 * Prints which account/client the saved API_KEY resolves to, so a gen/revoke/list failure (wrong
 * account, wrong client) is obvious up front instead of a confusing 401/403 further down. Never
 * fatal - a lookup failure here shouldn't block the actual command, just fall back to what's
 * derivable locally from the key string itself.
 */
export async function logAccountIdentity(serverUrl, apiKey) {
  const localClient = parseApiKeyClient(apiKey);
  try {
    const { email, client, org } = await fetchWhoami(serverUrl, apiKey);
    const orgLabel = org?.name || client || localClient || 'unknown';
    console.log(chalk.gray(`   Account: ${email || 'unknown'}  (org: ${orgLabel})`));
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    console.log(chalk.gray(`   Client: ${localClient || 'unknown'}  (couldn't resolve account email: ${message})`));
  }
}

export async function listRemoteApiKeys(serverUrl, apiKey) {
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey}` } };
  // 100 is the backend's own max page size (ApiKeyController.listApiKeys clamps `limit` there) -
  // plenty for the "find my one named key" lookups these commands do, and for `key list` itself.
  const res = await axios.get(`${serverUrl}/apikey`, { ...authHeaders, params: { limit: 100 } });
  return res.data?.items || [];
}

export async function findApiKeyByName(serverUrl, apiKey, name) {
  const items = await listRemoteApiKeys(serverUrl, apiKey);
  return items.find((k) => k.name === name);
}

export async function generateApiKey(name) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = requireSavedApiKey();
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey}` } };
  await logAccountIdentity(serverUrl, apiKey);

  const { password } = await inquirer.prompt([
    {
      type: 'password',
      name: 'password',
      message: 'Account password:',
      mask: '*',
      validate: (input) => input.length > 0 || 'Password is required',
    },
  ]);

  try {
    // Replace, not accumulate - same behavior `aivin login` already relies on for its own device
    // key, so re-running `aivin key gen "ci"` doesn't pile up duplicate "ci" entries.
    const existing = await findApiKeyByName(serverUrl, apiKey, name);
    if (existing) {
      await axios.delete(`${serverUrl}/apikey/${existing.id || existing._id}`, authHeaders);
    }

    const keyRes = await axios.post(`${serverUrl}/apikey`, { name, password }, authHeaders);
    if (!keyRes.data?.plainKey) throw new Error('Response did not include an API key');
    return keyRes.data.plainKey;
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to create API key: ${message}`, { cause: error });
  }
}

export async function revokeApiKeyByName(name) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = requireSavedApiKey();
  await logAccountIdentity(serverUrl, apiKey);

  let existing;
  try {
    existing = await findApiKeyByName(serverUrl, apiKey, name);
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to look up API keys: ${message}`, { cause: error });
  }
  if (!existing) {
    throw new Error(`No API key named "${name}" found on your account.`);
  }

  try {
    const authHeaders = { headers: { Authorization: `Bearer ${apiKey}` } };
    await axios.delete(`${serverUrl}/apikey/${existing.id || existing._id}`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to revoke API key: ${message}`, { cause: error });
  }
}
