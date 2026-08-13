import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { execFileSync } from 'child_process';

// `~/.aivin/credentials` - written once by `aivin login [baseUrl]`, read by every plugin project
// on this machine. One ACTIVE context at a time (base_url + api_key together, like `kubectl config
// use-context`) - not a per-project setting, and not a multi-server map either. Logging into a
// different server (`aivin login beta-api.aivin.vn`) simply replaces the active context outright;
// every project on the machine picks up wherever you last logged in, with zero `.env` needed for
// the common case. A project's own `.env` can still set AIVIN_BASE_URL/API_KEY directly to pin
// itself to something other than the machine's current context (e.g. CI using a fixed scoped key)
// - dotenv.config() never overrides a variable that's already set, so that always wins.
//
// Old files from before this existed were flat `API_KEY=...` (implicitly production) - still loads
// fine, just with no recorded base_url (falls back to the production default below).
export const GLOBAL_CREDENTIALS_PATH = path.join(os.homedir(), '.aivin', 'credentials');

export const DEFAULT_AIVIN_BASE_URL = 'https://api.aivin.cloud';

/**
 * The REST API and the gRPC SDK channel are two different hostnames behind the same login (e.g.
 * `api.aivin.cloud` / `sdk.aivin.cloud` in production, `beta-api.aivin.vn` / `beta-sdk.aivin.vn` in
 * staging - proven consistent across both real environments this SDK talks to). Derived once at
 * login time by swapping the leading `api.` label for `sdk.`, so `SDK_ENDPOINT` never needs its own
 * separate manual config for the common case - same context, same command.
 */
export function deriveSdkEndpoint(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    // Match "api." as its own label, whether at the very start ("api.aivin.cloud") or after a
    // prefix like "beta-" ("beta-api.aivin.vn" -> "beta-sdk.aivin.vn") - a plain `^api\.` anchor
    // only caught the production case and silently produced no SDK_ENDPOINT for staging.
    if (!/(^|-)api\./.test(host)) return null;
    return host.replace(/(^|-)api\./, '$1sdk.');
  } catch {
    return null;
  }
}

/**
 * No guessing/hardcoded map - the backend already knows its own web app URL (`config/app.json`'s
 * `app_url`, admin-tunable via ConfigIO, same value every branded page/asset link on that instance
 * already uses) and serves it through `GET /setting/lang/default`, a public route (no auth) meant
 * for exactly this: reading branding/config before a session exists. Each real backend (production,
 * staging, self-hosted) already has this correct for itself - a hardcoded CLI-side map would just
 * be a second, driftable copy of the same fact.
 */
export async function fetchWebUrl(baseUrl) {
  try {
    const res = await axios.get(`${baseUrl}/setting/lang/default`, { timeout: 5000 });
    const appUrl = res.data?.app_url;
    return typeof appUrl === 'string' && appUrl ? appUrl : null;
  } catch {
    return null;
  }
}

/**
 * JSON-only, no legacy flat `API_KEY=...` dotenv-format fallback - a hard cutover, by request.
 * Anyone with an old-format credentials file just needs to `aivin login` again; this stays simple
 * instead of carrying a permanent "read either shape" branch for a one-time migration.
 */
export function loadActiveContext() {
  if (!fs.existsSync(GLOBAL_CREDENTIALS_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(GLOBAL_CREDENTIALS_PATH, 'utf8'));
    if (!parsed?.api_key) return null;
    const base_url = parsed.base_url || DEFAULT_AIVIN_BASE_URL;
    return {
      base_url,
      api_key: parsed.api_key,
      sdk_endpoint: parsed.sdk_endpoint || deriveSdkEndpoint(base_url),
      // Absent on credentials files written before these fields existed - `aivin whoami` just
      // falls back to a live `/apikey/whoami` lookup in that case rather than showing stale/blank
      // identity.
      logged_in_at: parsed.logged_in_at || null,
      email: parsed.email || null,
      name: parsed.name || null,
      client: parsed.client || null,
      org_name: parsed.org_name || null,
      org_domain: parsed.org_domain || null,
    };
  } catch {
    return null;
  }
}

/**
 * `{ mode: 0o600 }` on writeFileSync is a POSIX permission bit - Node has no Windows-ACL
 * equivalent for it, so on Windows the file otherwise just inherits whatever access the parent
 * directory/profile already grants (every other local account with access to that tree, not just
 * the owner). Best-effort hardening: explicitly strip inherited permissions and grant only the
 * current user. Never blocks login over this failing (e.g. no `icacls` on a stripped-down PATH).
 */
function restrictToOwner(filePath) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], {
      stdio: 'ignore',
    });
  } catch {
    // best-effort only
  }
}

/**
 * `aivin logout` - removes `~/.aivin/credentials` entirely. A project's own `.env` (AIVIN_BASE_URL/
 * API_KEY, see the dotenv precedence note at the top of cli.mjs) is untouched, so a directory that
 * pins its own key stays "logged in" for itself even after this.
 */
export function clearActiveContext() {
  if (!fs.existsSync(GLOBAL_CREDENTIALS_PATH)) return false;
  fs.unlinkSync(GLOBAL_CREDENTIALS_PATH);
  return true;
}

/**
 * `identity` ({ email, name, client, org: { name, domain } }) is best-effort and optional -
 * callers that can't reach `/apikey/whoami` at login time (e.g. `-k` direct key set, offline)
 * still get a working login, just with `aivin whoami` showing less than the full picture since
 * nothing here is ever fetched again after login - see GLOBAL_CREDENTIALS_PATH's comment above.
 */
export function saveActiveContext(baseUrl, apiKey, identity = {}) {
  fs.mkdirSync(path.dirname(GLOBAL_CREDENTIALS_PATH), { recursive: true });
  const sdkEndpoint = deriveSdkEndpoint(baseUrl);
  fs.writeFileSync(
    GLOBAL_CREDENTIALS_PATH,
    JSON.stringify(
      {
        base_url: baseUrl,
        api_key: apiKey,
        sdk_endpoint: sdkEndpoint,
        logged_in_at: new Date().toISOString(),
        email: identity.email || null,
        name: identity.name || null,
        client: identity.client || null,
        org_name: identity.org?.name || null,
        org_domain: identity.org?.domain || null,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  restrictToOwner(GLOBAL_CREDENTIALS_PATH);
  return sdkEndpoint;
}
