import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { DEVICE_API_PREFIX, DEVICE_CREDENTIALS_FILE, DEVICE_ID_FILE, REMOTE_CONFIG_DIR } from './constants.mjs';
import { parseApiKeyClient } from '../auth.mjs';
import { TokenStoreKind, forgetToken, openToken, preferredTokenStore, sealToken } from './tokenStore.mjs';
import { writeFileAtomic } from './atomicFile.mjs';
import { DEFAULT_SERVER_URL, readActiveServer, resolveServerUrl, serverKey, setActiveServer } from '../servers.mjs';

/** Mã máy ổn định (~/.aivin/device-id.json), giữ qua các lần chạy. */
export function getOrCreateDeviceId() {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
    if (data?.deviceId) return data.deviceId;
  } catch { /* chưa có → sinh mới */ }
  const deviceId = `dev-${randomUUID()}`;
  fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId, hostname: os.hostname(), createdAt: new Date().toISOString() }, null, 2) + '\n');
  return deviceId;
}

/** Sinh mã máy mới (máy nhân bản từ ảnh đĩa…) — đồng thời bỏ token cũ. */
export function resetDeviceId() {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  const deviceId = `dev-${randomUUID()}`;
  fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId, hostname: os.hostname(), createdAt: new Date().toISOString() }, null, 2) + '\n');
  clearAllDeviceCredentials();
  return deviceId;
}

/**
 * Token đã giải theo nội dung tệp — giải DPAPI / Keychain tốn một tiến trình con (~0,5 s) mà tệp được đọc ở nhiều chỗ (mỗi lời gọi REST
 * lấy tenant từ token). Tệp đổi (ghép lại / xoay token / tiến trình khác ghi) → giải lại.
 */
const opened = new Map();

function readStore() {
  try { const raw = fs.readFileSync(DEVICE_CREDENTIALS_FILE, 'utf8'); return { raw, data: JSON.parse(raw) }; }
  catch { return null; }
}
const isLegacyServerAlias = (source, target) => String(source || '').trim().replace(/\/+$/, '') !== target;
function resolveCredentialServer(serverUrl) {
  if (serverUrl) return resolveServerUrl(serverUrl);
  const configured = process.env.AIVIN_BASE_URL || process.env.AIVIN_SERVER || readActiveServer();
  if (configured) return resolveServerUrl(configured);
  const store = readStore()?.data;
  if (store?.device_id) return resolveServerUrl(store.server_url || DEFAULT_SERVER_URL);
  const entries = Object.values(store?.servers || {});
  if (entries.length === 1 && entries[0]?.server_url) return resolveServerUrl(entries[0].server_url);
  return DEFAULT_SERVER_URL;
}
function readRecord(serverUrl) {
  const url = resolveCredentialServer(serverUrl); const file = readStore();
  if (!file?.data) return null;
  if (file.data.servers && typeof file.data.servers === 'object') {
    const key = serverKey(url);
    const data = file.data.servers[key];
    if (data) return { raw: file.raw, data, store: file.data, serverUrl: url };
    // A pre-migration beta record is eligible once. loadDeviceCredentials moves it to
    // legacy_servers before trying it at production, so a rejected token won't loop.
    const alias = Object.entries(file.data.servers).find(([, record]) => {
      if (!record?.server_url) return false;
      try { return resolveServerUrl(record.server_url) === url && isLegacyServerAlias(record.server_url, url); } catch { return false; }
    });
    if (alias) return { raw: file.raw, data: alias[1], store: file.data, serverUrl: url, legacyAlias: true, sourceKey: alias[0] };
    return null;
  }
  if (file.data.device_id && resolveServerUrl(file.data.server_url || DEFAULT_SERVER_URL) === url)
    return {
      raw: file.raw, data: file.data, store: file.data, legacy: true, serverUrl: url,
      ...(isLegacyServerAlias(file.data.server_url || DEFAULT_SERVER_URL, url) ? { legacyAlias: true, sourceKey: `legacy:${file.data.server_url || DEFAULT_SERVER_URL}` } : {}),
    };
  return null;
}
function writeRecord(record, serverUrl, currentOverride) {
  const url = resolveCredentialServer(serverUrl || record.server_url); const current = currentOverride || readStore()?.data;
  let store;
  if (current?.servers && typeof current.servers === 'object') store = { ...current, servers: { ...current.servers } };
  else {
    store = { version: 2, servers: {} };
    if (current?.device_id) { const oldUrl = resolveServerUrl(current.server_url || DEFAULT_SERVER_URL); store.servers[serverKey(oldUrl)] = current; }
  }
  store.version = 2; store.servers[serverKey(url)] = record;
  const raw = JSON.stringify(store, null, 2) + '\n';
  writeFileAtomic(DEVICE_CREDENTIALS_FILE, raw);
  try { fs.chmodSync(DEVICE_CREDENTIALS_FILE, 0o600); } catch { /* Windows ACL follows the user profile */ }
  return raw;
}
const DISK_OWNED_FIELDS = ['previous_sealed', 'policy_sealed_at'];
const SEAL_RETRY_MS = 24 * 3600_000;
const tokenAccount = (deviceId, url) => `${deviceId}:${serverKey(url)}`;
function sealPrevious(token, deviceId, url) {
  const account = `${tokenAccount(deviceId, url)}:previous`;
  const { fallback_reason: _why, ...sealed } = sealToken(token, { account });
  return { ...sealed, account };
}
const openPrevious = (rec) => (rec && typeof rec === 'object' ? openToken({ ...rec, device_id: rec.account, token_account: rec.account }) : null);
const forgetPrevious = (rec) => { if (rec && typeof rec === 'object') forgetToken({ ...rec, device_id: rec.account, token_account: rec.account }); };
const clearOpened = (url) => opened.delete(serverKey(url));

export function loadDeviceCredentials(serverUrl) {
  const url = resolveCredentialServer(serverUrl); const key = serverKey(url); const rec = readRecord(url);
  if (!rec?.data) return null;
  const { data, raw } = rec; const cached = opened.get(key);
  if (cached?.raw === raw && cached.token) return { ...data, server_url: url, device_token: cached.token };
  const token = openToken({ ...data, token_account: data.token_account || data.device_id });
  if (!token) return null;
  if (rec.legacyAlias) {
    const store = rec.store.servers
      ? { ...rec.store, servers: { ...rec.store.servers }, legacy_servers: { ...(rec.store.legacy_servers || {}) } }
      : { version: 2, servers: {}, legacy_servers: {} };
    const oldRecord = rec.store.servers ? store.servers[rec.sourceKey] : rec.store;
    if (rec.store.servers) delete store.servers[rec.sourceKey];
    if (oldRecord) {
      const { server_url: oldUrl, ...backup } = oldRecord;
      store.legacy_servers[rec.sourceKey] = { ...backup, legacy_server_url: oldUrl || rec.data.server_url || DEFAULT_SERVER_URL };
    }
    const { previous_sealed: _previous, policy_sealed_at: _policy, ...migrated } = data;
    saveDeviceCredentials({ ...migrated, server_url: url, device_token: token }, { storeOverride: store });
    return { ...readRecord(url)?.data, server_url: url, device_token: token };
  }
  opened.set(key, { raw, token });
  const retrySeal = !data.seal_failed || Date.now() - Number(data.seal_failed.at || 0) > SEAL_RETRY_MS;
  if (data.device_token && preferredTokenStore() !== TokenStoreKind.FILE && retrySeal) {
    saveDeviceCredentials({ ...data, server_url: url, device_token: token });
    return { ...readRecord(url)?.data, server_url: url, device_token: token };
  }
  return { ...data, server_url: url, device_token: token };
}

/** Once production accepts the migrated token, discard its sealed beta backup. */
export function confirmServerCredentialMigration(serverUrl) {
  const url = resolveServerUrl(serverUrl);
  const file = readStore();
  if (!file?.data) return false;
  const servers = { ...(file.data.servers || {}) };
  const legacy = { ...(file.data.legacy_servers || {}) };
  let removed = false;
  for (const records of [servers, legacy]) {
    for (const [key, record] of Object.entries(records)) {
      try {
        const sourceUrl = record?.legacy_server_url || record?.server_url;
        if (sourceUrl && resolveServerUrl(sourceUrl) === url && isLegacyServerAlias(sourceUrl, url)) {
          forgetToken({ ...record, token_account: record.token_account || record.device_id });
          forgetPrevious(record.previous_sealed);
          delete records[key];
          removed = true;
        }
      } catch { /* leave malformed legacy entries for manual recovery */ }
    }
  }
  if (!removed) return false;
  const store = { ...file.data, servers, legacy_servers: legacy };
  writeFileAtomic(DEVICE_CREDENTIALS_FILE, `${JSON.stringify(store, null, 2)}\n`);
  try { fs.chmodSync(DEVICE_CREDENTIALS_FILE, 0o600); } catch { /* Windows ACL follows the user profile */ }
  return true;
}
export function saveDeviceCredentials(creds, { previousToken, storeOverride } = {}) {
  const url = resolveCredentialServer(creds.server_url); const key = serverKey(url); const account = tokenAccount(creds.device_id, url);
  const { device_token: token, token_store: _s, token_enc: _e, seal_failed: _f, ...rest } = creds;
  for (const f of DISK_OWNED_FIELDS) delete rest[f]; delete rest.token_account;
  const disk = readRecord(url)?.data || {}; const kept = {};
  if (disk.device_id === creds.device_id && disk.previous_sealed) kept.previous_sealed = disk.previous_sealed;
  if (disk.device_id === creds.device_id && disk.policy_sealed_at) kept.policy_sealed_at = disk.policy_sealed_at;
  if (previousToken !== undefined) {
    if (kept.previous_sealed) forgetPrevious(kept.previous_sealed);
    delete kept.previous_sealed;
    if (previousToken) kept.previous_sealed = sealPrevious(previousToken, creds.device_id, url);
  }
  const sealed = sealToken(token, { account }); const { fallback_reason: reason, ...stored } = sealed;
  const record = { ...rest, server_url: url, token_account: account, ...stored, ...kept, ...(reason ? { seal_failed: { at: Date.now(), reason } } : {}) };
  const raw = writeRecord(record, url, storeOverride);
  opened.set(key, { raw, token }); return reason || null;
}
export function pendingPreviousToken(serverUrl) { return openPrevious(readRecord(serverUrl)?.data?.previous_sealed); }
export function confirmTokenRotation(currentToken, serverUrl) {
  if (!readRecord(serverUrl)?.data?.previous_sealed) return false;
  const creds = loadDeviceCredentials(serverUrl);
  if (!creds || (currentToken && creds.device_token !== currentToken)) return false;
  saveDeviceCredentials(creds, { previousToken: null }); return true;
}
export function revertTokenRotation(failedToken, serverUrl) {
  const creds = loadDeviceCredentials(serverUrl);
  if (!creds || (failedToken && creds.device_token !== failedToken)) return null;
  const previous = pendingPreviousToken(serverUrl);
  if (!previous || previous === creds.device_token) return null;
  saveDeviceCredentials({ ...creds, device_token: previous }, { previousToken: null });
  return readStoredTokenFresh(serverUrl) === previous ? previous : null;
}
export function notePolicySealed(serverUrl) {
  const url = resolveCredentialServer(serverUrl); const rec = readRecord(url);
  if (!rec?.data || rec.data.policy_sealed_at) return;
  try {
    const raw = writeRecord({ ...rec.data, policy_sealed_at: new Date().toISOString() }, url);
    const cached = opened.get(serverKey(url)); if (cached?.raw === rec.raw) opened.set(serverKey(url), { raw, token: cached.token });
  } catch { /* daemon still remembers it in memory */ }
}
export function policySealedNoted(serverUrl) { return !!readRecord(serverUrl)?.data?.policy_sealed_at; }
export function readStoredTokenFresh(serverUrl) {
  const data = readRecord(serverUrl)?.data;
  return data ? openToken({ ...data, token_account: data.token_account || data.device_id }) : null;
}
export function clearDeviceCredentials(onlyToken, serverUrl) {
  const url = resolveCredentialServer(serverUrl); const rec = readRecord(url);
  if (onlyToken && loadDeviceCredentials(url)?.device_token !== onlyToken) return false;
  if (rec?.data) {
    forgetToken({ ...rec.data, token_account: rec.data.token_account || rec.data.device_id }); forgetPrevious(rec.data.previous_sealed);
    const store = rec.store?.servers ? { ...rec.store, servers: { ...rec.store.servers } } : { version: 2, servers: {} };
    delete store.servers[serverKey(url)];
    if (Object.keys(store.servers).length || Object.keys(store.legacy_servers || {}).length) {
      const raw = JSON.stringify(store, null, 2) + '\n'; writeFileAtomic(DEVICE_CREDENTIALS_FILE, raw);
      try { fs.chmodSync(DEVICE_CREDENTIALS_FILE, 0o600); } catch { /* Windows ACL follows the user profile */ }
    } else { try { fs.unlinkSync(DEVICE_CREDENTIALS_FILE); } catch { /* already clear */ } }
  }
  clearOpened(url); return true;
}
export function clearAllDeviceCredentials() {
  const store = readStore()?.data;
  const records = store?.servers
    ? [...Object.values(store.servers), ...Object.values(store.legacy_servers || {})]
    : store?.device_id ? [store] : [];
  for (const rec of records) { forgetToken({ ...rec, token_account: rec.token_account || rec.device_id }); forgetPrevious(rec.previous_sealed); }
  try { fs.unlinkSync(DEVICE_CREDENTIALS_FILE); } catch { /* already clear */ }
  opened.clear(); return true;
}
/**
 * Máy tính tổ chức: BE cấp token thiết bị lúc tạo container và đặt vào env (`AIVIN_DEVICE_TOKEN` / `AIVIN_DEVICE_ID` / `AIVIN_SERVER`) — không
 * ghép máy, không ghi tệp token. Thiếu biến → `null`.
 */
export function credentialsFromEnv(env = process.env) {
  const token = String(env.AIVIN_DEVICE_TOKEN || '').trim();
  const deviceId = String(env.AIVIN_DEVICE_ID || '').trim();
  const serverUrl = String(env.AIVIN_SERVER || '').trim() ? resolveServerUrl(String(env.AIVIN_SERVER).trim()) : '';
  if (!token || !deviceId || !serverUrl) return null;
  return { device_token: token, device_id: deviceId, name: String(env.AIVIN_DEVICE_NAME || deviceId), server_url: serverUrl };
}

/** Tenant trong token thiết bị `<client>-dk-<bí mật>`. */
export function deviceTokenClient(token) {
  const at = String(token || '').lastIndexOf('-dk-');
  return at > 0 ? String(token).slice(0, at) : undefined;
}

export function apiHeaders(apiKey) {
  const client = (apiKey ? parseApiKeyClient(apiKey) : undefined) || deviceTokenClient(loadDeviceCredentials()?.device_token);
  return { headers: { Authorization: `Bearer ${apiKey}`, ...(client ? { 'x-client-slug': client } : {}) } };
}

function errorText(error) {
  return error.response?.data?.message || error.response?.data?.i18n || error.message || error.code || 'Unknown error';
}

/**
 * Ghép máy với tài khoản đang đăng nhập (API key): BE cấp token THIẾT BỊ riêng, chỉ lưu băm. Ghép lại = token cũ hết hiệu lực.
 */
export async function pairDevice({ serverUrl, apiKey, roots, name, profile }) {
  if (!apiKey) throw new Error('Chưa đăng nhập. Tạo mã kết nối trên Aivin (ô chat → Trình duyệt ▾ → Thêm máy tính này) rồi chạy `aivin remote start --code <mã>`, hoặc `aivin login` trước.');
  const deviceId = getOrCreateDeviceId();
  let res;
  try {
    res = await axios.post(`${serverUrl}${DEVICE_API_PREFIX}/devices/pair`, {
      device_id: deviceId,
      name: name || os.hostname(),
      profile,
    }, apiHeaders(apiKey));
  } catch (error) {
    throw new Error(`Không ghép được máy với ${serverUrl}: ${errorText(error)}`, { cause: error });
  }
  return savePairResult(res, { serverUrl, deviceId, roots, name });
}

/**
 * Ghép máy bằng mã kết nối tạo trên giao diện Aivin (nút "Thêm máy tính này") — không cần `aivin login`: mã mang sẵn tài khoản, dùng
 * một lần, có hạn. Gõ thường / thiếu gạch đều được (BE chuẩn hoá).
 */
export async function pairDeviceWithCode({ serverUrl, code, roots, name, profile }) {
  const deviceId = getOrCreateDeviceId();
  let res;
  try {
    res = await axios.post(`${serverUrl}${DEVICE_API_PREFIX}/devices/pair-with-code`, {
      code: String(code).trim(),
      device_id: deviceId,
      name: name || os.hostname(),
      profile,
    });
  } catch (error) {
    throw new Error(`Không ghép được máy bằng mã ${code}: ${errorText(error)}`, { cause: error });
  }
  return savePairResult(res, { serverUrl, deviceId, roots, name });
}

function savePairResult(res, { serverUrl, deviceId, roots, name }) {
  const data = res.data?.data ?? res.data;
  if (!data?.device_token) throw new Error('Máy chủ không trả token thiết bị.');
  const creds = {
    server_url: serverUrl,
    device_id: deviceId,
    device_token: data.device_token,
    name: data.device?.name || name || os.hostname(),
    roots: roots.map((r) => path.resolve(r)),
    paired_at: new Date().toISOString(),
    account: data.account || undefined,
    lang: data.user_lang || data.lang || undefined,
  };
  saveDeviceCredentials(creds);
  setActiveServer(serverUrl);
  return creds;
}

export async function listDevices({ serverUrl, apiKey }) {
  try {
    const res = await axios.get(`${serverUrl}${DEVICE_API_PREFIX}/devices`, apiHeaders(apiKey));
    return (res.data?.data ?? res.data)?.devices || [];
  } catch (error) {
    throw new Error(`Không lấy được danh sách máy: ${errorText(error)}`, { cause: error });
  }
}

export async function unpairDevice({ serverUrl, apiKey, deviceId }) {
  try {
    await axios.delete(`${serverUrl}${DEVICE_API_PREFIX}/devices/${encodeURIComponent(deviceId)}`, apiHeaders(apiKey));
  } catch (error) {
    if (error.response?.status !== 404) throw new Error(`Không thu hồi được máy: ${errorText(error)}`, { cause: error });
  }
  const creds = loadDeviceCredentials();
  if (creds?.device_id === deviceId) clearDeviceCredentials();
}
