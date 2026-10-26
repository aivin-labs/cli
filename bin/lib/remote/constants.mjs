import path from 'path';
import os from 'os';

/** `AIVIN_REMOTE_HOME` đổi được thư mục cấu hình (test, nhiều hồ sơ trên một máy). */
export const REMOTE_CONFIG_DIR = process.env.AIVIN_REMOTE_HOME || path.join(os.homedir(), '.aivin');
export const DEVICE_ID_FILE = path.join(REMOTE_CONFIG_DIR, 'device-id.json');
/** Token THIẾT BỊ (không phải API key tài khoản) — chỉ nằm trên máy này, BE chỉ giữ băm. */
export const DEVICE_CREDENTIALS_FILE = path.join(REMOTE_CONFIG_DIR, 'device-credentials.json');
/** Bộ nhớ + chỉ mục tệp trên máy (SQLite). */
export const DEVICE_DB_FILE = path.join(REMOTE_CONFIG_DIR, 'device-memory.db');
/** Công tắc ngắt: tệp này tồn tại → máy từ chối mọi lời gọi từ xa (`aivin remote pause`). */
export const KILL_SWITCH_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-paused');

/** Namespace socket.io phía BE (DeviceGateway). */
export const DEVICE_NAMESPACE = '/device';
export const PROTOCOL_VERSION = 1;
/** Đường REST của Device Agent — mọi official plugin nằm dưới tiền tố `/plugins`. */
export const DEVICE_API_PREFIX = '/plugins/device-agent';
export const DEVICE_AGENT_PLUGIN_ID = 'official.device_agent';

export const DeviceEvent = Object.freeze({
  HELLO: 'device:hello',
  CATALOG: 'device:catalog',
  HEARTBEAT: 'device:heartbeat',
  CALLS: 'device:calls',
  CANCEL: 'device:cancel',
  ACK: 'device:ack',
  STREAM: 'device:stream',
  RESULT: 'device:result',
  REVOKED: 'device:revoked',
});

/** Nhóm giới hạn song song trên máy — mỗi công cụ thuộc một nhóm. */
export const ToolGroup = Object.freeze({
  FS_READ: 'fs_read',
  FS_WRITE: 'fs_write',
  EXEC: 'exec',
  SYSTEM: 'system',
  MEMORY: 'memory',
  GIT: 'git',
});

/** Số lời gọi chạy cùng lúc tối đa mỗi nhóm (chỉnh qua biến môi trường AIVIN_REMOTE_LIMIT_<NHÓM>). */
export const DEFAULT_GROUP_LIMITS = Object.freeze({
  [ToolGroup.FS_READ]: 16,
  [ToolGroup.FS_WRITE]: 4,
  [ToolGroup.EXEC]: 3,
  [ToolGroup.SYSTEM]: 4,
  [ToolGroup.MEMORY]: 8,
  [ToolGroup.GIT]: 4,
});

export const DeviceErrorCode = Object.freeze({
  ROOT_DENIED: 'ROOT_DENIED',
  KILL_SWITCH: 'KILL_SWITCH',
  PROTECTED_PATH: 'PROTECTED_PATH',
  BLOCKED_COMMAND: 'BLOCKED_COMMAND',
  CALL_TIMEOUT: 'CALL_TIMEOUT',
  CANCELLED: 'CANCELLED',
  TOOL_UNKNOWN: 'TOOL_UNKNOWN',
  INVALID_ARGS: 'INVALID_ARGS',
  NOT_FOUND: 'NOT_FOUND',
  OUTPUT_TOO_LARGE: 'OUTPUT_TOO_LARGE',
  MEMORY_UNAVAILABLE: 'MEMORY_UNAVAILABLE',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
});

export const MemoryKind = Object.freeze({
  PROCEDURE: 'procedure',
  LESSON: 'lesson',
  FACT: 'fact',
  PROJECT: 'project',
  RULE: 'rule',
});

/** Thư mục bỏ qua khi duyệt / lập chỉ mục. */
export const IGNORED_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache',
  'coverage', '.output', 'out', 'vendor', 'tmp', 'temp', '__pycache__', '.venv', 'venv', 'target', '.idea', '.gradle',
]);

/** Trần kích thước một kết quả gửi lên (JSON). Lớn hơn → báo lỗi, gợi ý đọc theo đoạn. */
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
