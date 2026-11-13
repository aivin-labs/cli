import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { execFileSync } from 'child_process';
import { readActiveServer, resolveServerUrl, serverKey, setActiveServer, webUrlForServer } from './servers.mjs';
import { TokenStoreKind, forgetToken, openToken, preferredTokenStore, sealToken } from './remote/tokenStore.mjs';
import { isStandaloneBinary } from './update/versions.mjs';

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

/**
 * Khoá API cất trong kho bí mật của hệ điều hành (13/11/2026), như token thiết bị: tệp chỉ giữ `api_key_sealed` (bản mã DPAPI / dấu
 * Keychain, libsecret). Trước đây `api_key` nằm dạng chữ thường — chép thư mục `.aivin` (sao lưu, đồng bộ đám mây) là mang theo được khoá
 * toàn quyền tài khoản. Máy không có kho (`TokenStoreKind.FILE`) hoặc kho lỗi → giữ chữ thường như cũ.
 * Không chống được mã độc chạy dưới chính tài khoản người dùng (gọi được cùng API) — xem tokenStore.mjs.
 */
const apiKeyAccount = (url) => `api-key:${serverKey(url)}`;

function sealApiKey(apiKey, url) {
  if (preferredTokenStore() === TokenStoreKind.FILE) return { api_key: apiKey };
  const account = apiKeyAccount(url);
  const { fallback_reason: _why, device_token: plain, ...sealed } = sealToken(apiKey, { account });
  return plain ? { api_key: plain } : { api_key_sealed: { ...sealed, token_account: account } };
}

/** Khoá của một ngữ cảnh; bản mã không giải được (tệp chép từ máy khác) → `null` = coi như chưa đăng nhập. */
function openApiKey(ctx) {
  if (ctx?.api_key_sealed) return openToken({ ...ctx.api_key_sealed, device_id: ctx.api_key_sealed.token_account });
  return ctx?.api_key || null;
}

function forgetApiKey(ctx) {
  if (ctx?.api_key_sealed) forgetToken({ ...ctx.api_key_sealed, device_id: ctx.api_key_sealed.token_account });
}

const hasKey = (ctx) => Boolean(ctx?.api_key || ctx?.api_key_sealed);

/**
 * Ngữ cảnh còn khoá chữ thường (tệp cũ) → cất lại vào kho. Lỗi thì thôi: lần sau thử lại, vẫn dùng được khoá.
 * CHỈ bản phát hành đã cài (`AIVIN_CLI_BINARY`) mới tự chuyển: chạy từ mã nguồn / trong test trên cùng máy với một bản cài đời cũ thì bản
 * cũ không đọc được `api_key_sealed` và coi như chưa đăng nhập (gặp thật 13/11/2026: bộ test chạy mã nguồn đã chuyển tệp thật).
 * Đăng nhập mới (`saveActiveContext`) thì luôn cất vào kho.
 */
function migratePlainKey(store, key, apiKey) {
  const ctx = store.contexts[key];
  if (!ctx?.api_key || !isStandaloneBinary() || preferredTokenStore() === TokenStoreKind.FILE) return;
  try {
    const { api_key: _plain, ...rest } = ctx;
    const sealed = sealApiKey(apiKey, ctx.base_url);
    if (!sealed.api_key_sealed) return;
    store.contexts[key] = { ...rest, ...sealed };
    writeCredentialStore(store);
  } catch { /* để lần sau */ }
}

function readCredentialStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GLOBAL_CREDENTIALS_PATH, 'utf8'));
    if (parsed?.contexts && typeof parsed.contexts === 'object') return parsed;
    if (!hasKey(parsed)) return null;
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
  const store = readCredentialStore();
  const key = serverKey(target);
  const ctx = store?.contexts?.[key];
  if (!hasKey(ctx)) return null;
  const apiKey = openApiKey(ctx);
  if (!apiKey) return null;
  if (ctx.api_key) migratePlainKey(store, key, apiKey);
  return {
    base_url: target,
    api_key: apiKey,
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
  forgetApiKey(store.contexts[serverKey(target)]);
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
    ...sealApiKey(apiKey, normalized),
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
