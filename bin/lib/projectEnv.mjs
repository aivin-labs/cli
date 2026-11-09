import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

/** Chỉ lệnh làm việc trên một dự án plugin mới đọc `.env` của thư mục hiện tại. Tệp này có thể đến từ repo vừa tải về hay tệp zip vừa giải nén. */
const PROJECT_COMMANDS = new Set(['create', 'init', 'validate', 'start', 'deploy', 'test', 'plugin', 'connector', 'pluginstore', 'mcp']);
/** Biến đổi cách CLI tin cậy mạng, chỗ lưu khoá, nguồn cập nhật: chỉ nhận từ môi trường thật, không nhận từ tệp trong dự án. */
const NEVER_FROM_PROJECT = /^(NODE_|AIVIN_(?!BASE_URL$|CLI_SDK_VERSION$|TRIGGER_TIMEOUT_MS$)|(HTTP|HTTPS|ALL|NO)_PROXY$)/i;

export function projectEnvEntries(argv, parsed) {
  const command = argv.find((arg) => !arg.startsWith('-'));
  if (!PROJECT_COMMANDS.has(command)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => !NEVER_FROM_PROJECT.test(key)));
}

/** Không đè biến đã có sẵn trong môi trường thật. */
export function loadProjectEnv({ argv = process.argv.slice(2), env = process.env, file = path.resolve('.env') } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(projectEnvEntries(argv, dotenv.parse(text)))) {
    if (env[key] === undefined) env[key] = value;
  }
}
