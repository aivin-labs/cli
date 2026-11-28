import axios from 'axios';
import chalk from 'chalk';
import { missionAuthHeaders, missionServerUrl } from './workspace.mjs';

export const LIGHTCODE_STORE_SOURCE = 'lightcode';
export const LIGHTCODE_STORE_PREFIX = 'lightcode/';
const MAX_KEY_LEN = 120;
const MAX_VALUE_CHARS = 8_000;
const STORE_TIMEOUT_MS = 30_000;

/**
 * Chuẩn hoá khóa về dạng an toàn dưới tiền tố `lightcode/`:
 * - Chặn `..`, ký tự lạ; chỉ nhận chữ thường, chữ số, `/`, `-`, `_`, `.`.
 * - `allowPrefixRoot = true`: cho phép chính `'lightcode/'` làm tiền tố gốc cho `list`/`search`.
 */
export function normalizeProjectStoreKey(raw, { allowPrefixRoot = false } = {}) {
  const trimmed = typeof raw === 'string' ? raw.trim().slice(0, 400) : '';
  if (!trimmed) {
    if (allowPrefixRoot) return LIGHTCODE_STORE_PREFIX;
    throw new Error('"--key" is required (letters, digits, "/", "-", "_", "." only).');
  }
  const rawParts = trimmed.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter(Boolean);
  if (rawParts.some((p) => p === '..' || p === '.')) {
    throw new Error(`Invalid store key "${trimmed}" — path traversal is not allowed.`);
  }
  const cleaned = rawParts
    .map((p) => p.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, ''))
    .filter(Boolean);
  if (!cleaned.length) {
    if (allowPrefixRoot) return LIGHTCODE_STORE_PREFIX;
    throw new Error(`Invalid store key "${trimmed}".`);
  }
  const joined = cleaned.join('/');
  if (joined === 'lightcode') {
    if (allowPrefixRoot) return LIGHTCODE_STORE_PREFIX;
    throw new Error('"--key" must name a key under "lightcode/".');
  }
  const full = joined.startsWith(LIGHTCODE_STORE_PREFIX) ? joined : `${LIGHTCODE_STORE_PREFIX}${joined}`;
  if (full.length > MAX_KEY_LEN) {
    throw new Error(`"--key" is longer than ${MAX_KEY_LEN} characters.`);
  }
  return full;
}

export function requireProjectAndAuth(options, serverUrl) {
  if (!process.env.API_KEY) {
    throw new Error(`Not logged in to ${serverUrl} — run \`aivin login\` first.`);
  }
  const projectId = typeof options?.project === 'string' ? options.project.trim() : '';
  if (!projectId) {
    throw new Error('"--project=<id>" is required.');
  }
  return projectId;
}

function storeFailureText(action, error, serverUrl) {
  const status = error.response?.status;
  if (status === 401) {
    return `Not logged in to ${serverUrl} (HTTP 401) — run \`aivin login\` first.`;
  }
  const reason = error.response?.data?.message || error.response?.data?.i18n || error.message || error.code || 'Unknown error';
  return `Failed to ${action} project store note on ${serverUrl}: ${reason}`;
}

export async function projectStoreGetCmd(options = {}) {
  const serverUrl = missionServerUrl();
  const projectId = requireProjectAndAuth(options, serverUrl);
  const key = normalizeProjectStoreKey(options.key);
  const authHeaders = missionAuthHeaders();

  let res;
  try {
    res = await axios.get(`${serverUrl}/datastore/store/get`, {
      ...authHeaders,
      timeout: STORE_TIMEOUT_MS,
      params: {
        project_id: projectId,
        key,
        ...(options.workspace ? { workspace_id: String(options.workspace).trim() } : {}),
      },
    });
  } catch (error) {
    throw new Error(storeFailureText('read', error, serverUrl), { cause: error });
  }

  const body = res.data?.data ?? res.data ?? {};
  const out = {
    key: body.key || key,
    found: body.found === true,
    value: body.value ?? null,
    source: body.source || LIGHTCODE_STORE_SOURCE,
    project_id: body.project_id || projectId,
    ...(body.updated_at ? { updated_at: body.updated_at } : {}),
  };
  if (options.json) {
    console.log(JSON.stringify(out));
    return out;
  }
  if (!out.found) {
    console.log(chalk.yellow(`(not found) ${out.key}`));
    return out;
  }
  console.log(`${chalk.bold(out.key)}: ${out.value}`);
  return out;
}

export async function projectStoreSetCmd(options = {}) {
  const serverUrl = missionServerUrl();
  const projectId = requireProjectAndAuth(options, serverUrl);
  const key = normalizeProjectStoreKey(options.key);
  const value = typeof options.value === 'string' ? options.value.trim() : '';
  if (!value) {
    throw new Error('"--value" is required.');
  }
  if (value.length > MAX_VALUE_CHARS) {
    throw new Error(`"--value" is longer than ${MAX_VALUE_CHARS} characters.`);
  }
  const authHeaders = missionAuthHeaders();

  let res;
  try {
    res = await axios.post(
      `${serverUrl}/datastore/store/set`,
      {
        project_id: projectId,
        key,
        value,
        ...(options.workspace ? { workspace_id: String(options.workspace).trim() } : {}),
      },
      { ...authHeaders, timeout: STORE_TIMEOUT_MS },
    );
  } catch (error) {
    throw new Error(storeFailureText('save', error, serverUrl), { cause: error });
  }

  const body = res.data?.data ?? res.data ?? {};
  const out = {
    key: body.key || key,
    value: body.value ?? value,
    source: body.source || LIGHTCODE_STORE_SOURCE,
    project_id: body.project_id || projectId,
    ...(body.updated_at ? { updated_at: body.updated_at } : {}),
  };
  if (options.json) {
    console.log(JSON.stringify(out));
    return out;
  }
  console.log(chalk.green(`✅ Saved ${out.key}`));
  return out;
}

export async function projectStoreListCmd(options = {}) {
  const serverUrl = missionServerUrl();
  const projectId = requireProjectAndAuth(options, serverUrl);
  const prefix = normalizeProjectStoreKey(options.prefix || LIGHTCODE_STORE_PREFIX, { allowPrefixRoot: true });
  const since = typeof options.since === 'string' ? options.since.trim() : '';
  if (options.since !== undefined && Number.isNaN(Date.parse(since))) {
    throw new Error('"--since" must be an ISO date, e.g. 2026-11-27T08:00:00.000Z.');
  }
  const authHeaders = missionAuthHeaders();

  let res;
  try {
    res = await axios.get(`${serverUrl}/datastore/store/list`, {
      ...authHeaders,
      timeout: STORE_TIMEOUT_MS,
      params: {
        project_id: projectId,
        prefix,
        ...(options.workspace ? { workspace_id: String(options.workspace).trim() } : {}),
        ...(options.limit ? { limit: Number(options.limit) } : {}),
        ...(since ? { since } : {}),
      },
    });
  } catch (error) {
    throw new Error(storeFailureText('list', error, serverUrl), { cause: error });
  }

  const body = res.data?.data ?? res.data ?? {};
  const items = Array.isArray(body.items) ? body.items : [];
  // Máy chủ cũ bỏ qua `since` (trả mới nhất trước, không có `has_more`): báo lỗi thay vì để client lật trang sai.
  if (since && typeof body.has_more !== 'boolean') {
    throw new Error(`${serverUrl} does not support "--since" yet — update the server, or list without it.`);
  }
  const out = {
    ...(since ? { has_more: body.has_more } : {}),
    prefix: body.prefix || prefix,
    items,
    count: typeof body.count === 'number' ? body.count : items.length,
    source: body.source || LIGHTCODE_STORE_SOURCE,
    project_id: body.project_id || projectId,
  };
  if (options.json) {
    console.log(JSON.stringify(out));
    return out;
  }
  if (!items.length) {
    console.log(chalk.yellow(`No notes under ${out.prefix}`));
    return out;
  }
  for (const item of items) {
    console.log(`${chalk.bold(item.key)}: ${item.value}`);
  }
  return out;
}

export async function projectStoreSearchCmd(options = {}) {
  const serverUrl = missionServerUrl();
  const projectId = requireProjectAndAuth(options, serverUrl);
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  if (!query) {
    throw new Error('"--query" is required.');
  }
  const prefix = normalizeProjectStoreKey(options.prefix || LIGHTCODE_STORE_PREFIX, { allowPrefixRoot: true });
  const authHeaders = missionAuthHeaders();

  let res;
  try {
    res = await axios.get(`${serverUrl}/datastore/store/search`, {
      ...authHeaders,
      timeout: STORE_TIMEOUT_MS,
      params: {
        project_id: projectId,
        query,
        prefix,
        ...(options.workspace ? { workspace_id: String(options.workspace).trim() } : {}),
        ...(options.limit ? { limit: Number(options.limit) } : {}),
      },
    });
  } catch (error) {
    throw new Error(storeFailureText('search', error, serverUrl), { cause: error });
  }

  const body = res.data?.data ?? res.data ?? {};
  const items = Array.isArray(body.items) ? body.items : [];
  const out = {
    query: body.query || query,
    prefix: body.prefix || prefix,
    items,
    count: typeof body.count === 'number' ? body.count : items.length,
    source: body.source || LIGHTCODE_STORE_SOURCE,
    project_id: body.project_id || projectId,
  };
  if (options.json) {
    console.log(JSON.stringify(out));
    return out;
  }
  if (!items.length) {
    console.log(chalk.yellow(`No matching notes for "${out.query}" under ${out.prefix}`));
    return out;
  }
  for (const item of items) {
    console.log(`${chalk.bold(item.key)}: ${item.value}`);
  }
  return out;
}
