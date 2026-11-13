import chalk from 'chalk';
import { execFile } from 'child_process';
import http from 'http';
import os from 'os';
import { randomBytes } from 'crypto';
import inquirer from 'inquirer';
import axios from 'axios';
import { DEFAULT_AIVIN_BASE_URL, saveActiveContext } from './context.mjs';
import {
  LoginApp, LoginOutcome, buildLoginUrl, createPkcePair, normalizeLoginApp, parseCallback, resultLang, resultPageHtml,
} from './loginHandoff.mjs';

export { LoginApp };

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

/**
 * Lệnh mở trình duyệt, không qua shell: URL có thể do máy chủ trả về nên không được ghép vào chuỗi lệnh. Chỉ http(s); sai thì null.
 */
export function browserCommand(url, platform = process.platform, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  let href;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    href = parsed.href;
  } catch {
    return null;
  }
  if (platform === 'win32') return { file: `${systemRoot}\\System32\\rundll32.exe`, args: ['url.dll,FileProtocolHandler', href] };
  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [href] };
}

export function openBrowser(url) {
  const showManually = () => {
    console.log(chalk.yellow('Could not open a browser automatically - open this URL manually:'));
    console.log(chalk.cyan(`   ${url}`));
  };
  // `AIVIN_NO_BROWSER=1`: máy không có trình duyệt / test — chỉ in URL.
  const command = process.env.AIVIN_NO_BROWSER === '1' ? null : browserCommand(url);
  if (!command) return showManually();
  execFile(command.file, command.args, (error) => { if (error) showManually(); });
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_PATH = '/apikey/cli-login/exchange';
const CODE_PATH = '/apikey/cli-login/code';
/** Gợi ý quyền truy cập khi máy chưa ghép (chưa có tệp ghép máy). */
const ACCESS_NOT_PAIRED = 'none';

/** Mã máy (để máy chủ thay đúng khoá cũ của máy này khi đăng nhập lại) + chính sách hiện tại trên máy (chỉ để màn cấp quyền nói đúng). */
async function machineLoginContext(serverUrl) {
  const [{ getOrCreateDeviceId, pairedAccess }, { loadLocalPolicy }] = await Promise.all([
    import('./remote/credentials.mjs'),
    import('./remote/localPolicy.mjs'),
  ]);
  let deviceId;
  try { deviceId = getOrCreateDeviceId(); } catch { /* không ghi được ~/.aivin: vẫn đăng nhập, chỉ không thay được khoá cũ */ }
  let hints = {};
  try {
    const policy = loadLocalPolicy();
    hints = { access: pairedAccess(serverUrl) || ACCESS_NOT_PAIRED, confirm: policy.confirm, cast: policy.cast_consent };
  } catch { /* thiếu gợi ý thì web nói chung chung */ }
  return { deviceId, hints };
}

/** Đổi mã một lần + verifier lấy khoá qua máy chủ. */
async function exchangeLoginCode({ serverUrl, code, verifier, deviceId }) {
  try {
    const body = { code, code_verifier: verifier, ...(deviceId ? { device_id: deviceId } : {}) };
    const res = await axios.post(`${serverUrl}${EXCHANGE_PATH}`, body, { timeout: 30_000 });
    const data = res.data?.data ?? res.data;
    if (!data?.api_key) throw new Error('Server did not return an API key');
    return data.api_key;
  } catch (error) {
    const message = error.response?.data?.message || error.response?.data?.i18n || error.message;
    throw new Error(`Could not finish login: ${message}`, { cause: error });
  }
}

/**
 * Trình duyệt quay về `/callback`: trả trang kết quả đúng ngôn ngữ / đúng app và báo kết quả cho `browserLogin`. Lời gọi sai `state` chỉ
 * nhận trang báo lỗi, KHÔNG huỷ lần đăng nhập đang chờ.
 */
function createCallbackHandler({ state, app, serverUrl, verifier, deviceId, settle }) {
  let finished = false;
  return async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const lang = resultLang(url.searchParams.get('lang'));
    const reply = (outcome, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(resultPageHtml({ outcome, app, lang }));
    };
    const parsed = parseCallback(url.searchParams, state);
    if (parsed.kind === LoginOutcome.BAD_REQUEST || finished) return reply(LoginOutcome.BAD_REQUEST, 400);
    finished = true;
    if (parsed.kind === LoginOutcome.CANCELLED) {
      reply(LoginOutcome.CANCELLED);
      return settle(new Error('Login was cancelled in the browser'));
    }
    if (parsed.kind === 'key') {
      reply(LoginOutcome.OK);
      return settle(null, parsed.key);
    }
    if (parsed.kind !== 'code') {
      reply(LoginOutcome.FAILED);
      return settle(new Error('Login callback carried no code'));
    }
    try {
      const key = await exchangeLoginCode({ serverUrl, code: parsed.code, verifier, deviceId });
      reply(LoginOutcome.OK);
      settle(null, key);
    } catch (error) {
      reply(LoginOutcome.FAILED);
      settle(error);
    }
  };
}

/**
 * Default `aivin login` flow: opens the platform's actual web app (not the API) so the user logs in exactly the way they normally would
 * (custom-domain org, password, Google, OTP…). A tiny local HTTP server waits for the browser to come back with a ONE-TIME CODE, which
 * this process exchanges (with a PKCE verifier only it holds) for the API key — the key itself never travels through the browser, so it
 * never lands in browser history. Web side: fe ProfileHook.jsx + CliAuthPrompt.jsx; server side: be CliLoginService.
 * `app`: which app is asking (shown on the consent screen). `serverUrl`: the API host the code is exchanged at.
 */
export async function browserLogin({ app = LoginApp.CLI, serverUrl = process.env.AIVIN_BASE_URL || DEFAULT_AIVIN_BASE_URL } = {}) {
  // Defaults to the production web app - override with AIVIN_WEB_URL only if you're pointing at a local/dev/staging frontend instead.
  const webBaseUrl = process.env.AIVIN_WEB_URL || 'https://app.aivin.cloud';
  const loginApp = normalizeLoginApp(app);
  const state = randomBytes(16).toString('hex');
  const { verifier, challenge } = createPkcePair();
  const { deviceId, hints } = await machineLoginContext(serverUrl);

  let timeout;
  let settle;
  const keyPromise = new Promise((resolve, reject) => {
    settle = (error, key) => {
      clearTimeout(timeout);
      server.close();
      if (error) reject(error); else resolve(key);
    };
  });
  // If `server.listen()` itself errors below, keyPromise is rejected but this function throws from the port-await first — this passive
  // handler only silences the unobserved-rejection warning; the normal caller still awaits keyPromise below.
  keyPromise.catch(() => {});
  const server = http.createServer(createCallbackHandler({ state, app: loginApp, serverUrl, verifier, deviceId, settle: (e, k) => settle(e, k) }));
  server.on('error', (err) => settle(err));

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const authUrl = buildLoginUrl({ webBaseUrl, port, state, name: os.hostname(), app: loginApp, challenge, hints });

  console.log(chalk.blue('🌐 Opening your browser to log in...'));
  console.log(chalk.gray(`   ${authUrl.toString()}`));
  console.log(chalk.gray('   Not opened automatically? Paste that URL into your browser.'));
  console.log(chalk.gray('   Waiting for you to confirm in the browser (5 min timeout)...'));
  openBrowser(authUrl.toString());

  timeout = setTimeout(() => settle(new Error('Timed out waiting for browser login (5 minutes)')), LOGIN_TIMEOUT_MS);
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
 * `aivin login --basic`: exchange credentials for a session JWT, then go through the same one-time code + PKCE issuance as the browser
 * flow (be CliLoginService) — the key is bound to this machine's device id, expires when unused, and replaces ONLY this machine's
 * previous login key. (Before: listed the whole organization's keys and revoked whichever one had this hostname as its name.)
 */
export async function basicLogin(options) {
  const { serverUrl, accessToken } = await obtainAccessToken(options);
  const authHeaders = { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30_000 };
  const { verifier, challenge } = createPkcePair();
  const { deviceId } = await machineLoginContext(serverUrl);
  let code;
  try {
    const res = await axios.post(`${serverUrl}${CODE_PATH}`, { name: os.hostname(), code_challenge: challenge, app: LoginApp.CLI }, authHeaders);
    code = (res.data?.data ?? res.data)?.code;
    if (!code) throw new Error('Response did not include a login code');
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to create API key: ${message}`, { cause: error });
  }
  return exchangeLoginCode({ serverUrl, code, verifier, deviceId });
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
