import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { execFileSync } from 'child_process';
import { readActiveServer, resolveServerUrl, serverKey, setActiveServer, webUrlForServer } from './servers.mjs';

export const GLOBAL_CREDENTIALS_PATH = path.join(os.homedir(), '.aivin', 'credentials');
export const DEFAULT_AIVIN_BASE_URL = 'https://api.aivin.cloud';

export function deriveSdkEndpoint(baseUrl) {
  try {
    const host = new URL(resolveServerUrl(baseUrl)).hostname;
    if (!/(^|-)api\./.test(host)) return null;
    return host.replace(/(^|-)api\./, '$1sdk.');
  } catch { return null; }
}

export async function fetchWebUrl(baseUrl) {
  try {
    const res = await axios.get(`${resolveServerUrl(baseUrl)}/setting/lang/default`, { timeout: 5000 });
    return typeof res.data?.app_url === 'string' && res.data.app_url ? webUrlForServer(baseUrl, res.data.app_url) : null;
  } catch { return null; }
}

function readCredentialStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GLOBAL_CREDENTIALS_PATH, 'utf8'));
    if (parsed?.contexts && typeof parsed.contexts === 'object') return parsed;
    if (!parsed?.api_key) return null;
    const base_url = resolveServerUrl(parsed.base_url || DEFAULT_AIVIN_BASE_URL);
    return { version: 2, contexts: { [serverKey(base_url)]: { ...parsed, base_url } } };
  } catch { return null; }
}

function writeCredentialStore(store) {
  fs.mkdirSync(path.dirname(GLOBAL_CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(GLOBAL_CREDENTIALS_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  restrictToOwner(GLOBAL_CREDENTIALS_PATH);
}

export function loadActiveContext(baseUrl) {
  const target = resolveServerUrl(baseUrl || process.env.AIVIN_BASE_URL || readActiveServer() || DEFAULT_AIVIN_BASE_URL);
  const ctx = readCredentialStore()?.contexts?.[serverKey(target)];
  if (!ctx?.api_key) return null;
  return {
    base_url: target,
    api_key: ctx.api_key,
    sdk_endpoint: ctx.sdk_endpoint || deriveSdkEndpoint(target),
    logged_in_at: ctx.logged_in_at || null,
    email: ctx.email || null,
    name: ctx.name || null,
    client: ctx.client || null,
    org_name: ctx.org_name || null,
    org_domain: ctx.org_domain || null,
  };
}

function restrictToOwner(filePath) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], {
      stdio: 'ignore',
    });
  } catch { /* best-effort only */ }
}

export function clearActiveContext(baseUrl) {
  const target = resolveServerUrl(baseUrl || process.env.AIVIN_BASE_URL || readActiveServer() || DEFAULT_AIVIN_BASE_URL);
  const store = readCredentialStore();
  if (!store?.contexts?.[serverKey(target)]) return false;
  delete store.contexts[serverKey(target)];
  if (!Object.keys(store.contexts).length) fs.rmSync(GLOBAL_CREDENTIALS_PATH, { force: true });
  else writeCredentialStore(store);
  return true;
}

export function saveActiveContext(baseUrl, apiKey, identity = {}) {
  const normalized = resolveServerUrl(baseUrl || readActiveServer() || DEFAULT_AIVIN_BASE_URL);
  const store = readCredentialStore() || { version: 2, contexts: {} };
  store.version = 2;
  store.contexts ||= {};
  store.contexts[serverKey(normalized)] = {
    base_url: normalized,
    api_key: apiKey,
    sdk_endpoint: deriveSdkEndpoint(normalized),
    logged_in_at: new Date().toISOString(),
    email: identity.email || null,
    name: identity.name || null,
    client: identity.client || null,
    org_name: identity.org?.name || null,
    org_domain: identity.org?.domain || null,
  };
  writeCredentialStore(store);
  setActiveServer(normalized);
  return store.contexts[serverKey(normalized)].sdk_endpoint;
}
