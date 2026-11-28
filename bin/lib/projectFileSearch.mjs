import axios from 'axios';
import chalk from 'chalk';
import { requireProjectAndAuth } from './projectStore.mjs';
import { missionAuthHeaders, missionServerUrl } from './workspace.mjs';

// Lần tìm đầu có thể phải tạo embedding và xếp hạng lại — lâu hơn đọc kho ghi chú.
const FILE_SEARCH_TIMEOUT_MS = 60_000;
const MAX_QUERY_CHARS = 2_000;
// Cùng khoảng giá trị với máy chủ (ProjectFileSearchDTO) — ngoài khoảng thì kẹp lại thay vì bị từ chối 400.
const LIMIT_RANGE = { min: 1, max: 20 };
const MAX_CHARS_RANGE = { min: 200, max: 20_000 };

function numberOption(raw, flag, { min, max }) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`"${flag}" must be a positive whole number.`);
  }
  return Math.min(max, Math.max(min, value));
}

function fileSearchFailureText(error, serverUrl) {
  const status = error.response?.status;
  if (status === 401) {
    return `Not logged in to ${serverUrl} (HTTP 401) — run \`aivin login\` first.`;
  }
  const reason = error.response?.data?.message || error.response?.data?.i18n || error.message || error.code || 'Unknown error';
  return `Failed to search project files on ${serverUrl}: ${reason}`;
}

export async function projectFileSearchCmd(options = {}) {
  const serverUrl = missionServerUrl();
  const projectId = requireProjectAndAuth(options, serverUrl);
  const query = typeof options.query === 'string' ? options.query.trim().slice(0, MAX_QUERY_CHARS) : '';
  if (!query) {
    throw new Error('"--query" is required.');
  }
  const limit = numberOption(options.limit, '--limit', LIMIT_RANGE);
  const maxChars = numberOption(options.maxChars, '--max-chars', MAX_CHARS_RANGE);

  let res;
  try {
    res = await axios.post(
      `${serverUrl}/fileshare/project-search`,
      {
        project_id: projectId,
        query,
        ...(options.workspace ? { workspace_id: String(options.workspace).trim() } : {}),
        ...(limit ? { limit } : {}),
        ...(maxChars ? { max_chars: maxChars } : {}),
      },
      { ...missionAuthHeaders(), timeout: FILE_SEARCH_TIMEOUT_MS },
    );
  } catch (error) {
    throw new Error(fileSearchFailureText(error, serverUrl), { cause: error });
  }

  const body = res.data?.data ?? res.data ?? {};
  const items = Array.isArray(body.items) ? body.items : [];
  const out = {
    query: body.query || query,
    project_id: body.project_id || projectId,
    items,
    count: typeof body.count === 'number' ? body.count : items.length,
  };
  if (options.json) {
    console.log(JSON.stringify(out));
    return out;
  }
  if (!items.length) {
    console.log(chalk.yellow(`No passages found for "${out.query}" in this project's files`));
    return out;
  }
  for (const item of items) {
    console.log(`${chalk.bold(item.file_name)} #${item.chunk_index} (${item.score})\n${item.text}\n`);
  }
  return out;
}
