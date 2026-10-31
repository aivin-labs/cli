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
/** Khoá một tiến trình nhận việc cho mỗi thư mục cấu hình (PID) — xem daemonLock.mjs. */
export const DAEMON_LOCK_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-daemon.lock');
/** Kết quả làm xong mà chưa gửi được lên BE (mất mạng / daemon khởi động lại) — xem callLedger.mjs. */
export const REMOTE_OUTBOX_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-outbox.json');
/** Sổ chống làm trùng theo `idem_key` (mỗi dòng một sự kiện bắt đầu / xong) — xem idempotency.mjs. */
export const REMOTE_IDEM_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-idem.jsonl');

/** Namespace socket.io phía BE (DeviceGateway). */
export const DEVICE_NAMESPACE = '/device';
/**
 * 2 (29/10/2026): máy chống làm trùng theo `call_id`, báo lời gọi đang giữ khi chào (`inflight`) → BE gửi lại lô chưa xác nhận khi máy nối
 * lại và bảo máy huỷ việc không còn ai chờ.
 */
export const PROTOCOL_VERSION = 2;
/** Đường REST của Device Agent — mọi official plugin nằm dưới tiền tố `/plugins`. */
export const DEVICE_API_PREFIX = '/plugins/device-agent';
export const DEVICE_AGENT_PLUGIN_ID = 'official.device_agent';

/** Phạm vi chủ máy cho AI: toàn máy (`--full-access`) hoặc chỉ các thư mục được phép. Gửi BE trong hồ sơ máy (`profile.access`). */
export const DeviceAccess = Object.freeze({ FULL: 'full', FOLDERS: 'folders' });

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
  /** Một tiến trình KHÁC vừa nối bằng cùng token máy (`{ by_instance }`) — tiến trình này dừng hẳn, không nối lại tranh chỗ. */
  REPLACED: 'device:replaced',
  /** CLI → BE: tính vector bge-m3 cho các đoạn mô tả tệp (`{ texts }` → ack `{ ok, vectors }`, int8 base64). */
  EMBED: 'device:embed',
  /** CLI → BE: sự kiện của một theo dõi (tệp mới / dòng log khớp) → BE chạy Automation Job gắn với nó. */
  EVENT: 'device:event',
  /** CLI → BE (29/10/2026): lời gọi đang chờ người bấm xác nhận trên máy — `{ call_id, extra_ms }`, BE lùi hạn chờ kết quả bấy nhiêu. */
  HOLD: 'device:hold',
  /** CLI → BE: đã lưu token mới BE cấp trong ack của HELLO (`rotate_token`) — BE bỏ token cũ. */
  ROTATED: 'device:rotated',
  /** CLI → BE (vừa nối): xin danh sách theo dõi của máy (ack `{ watches }`). */
  WATCHES: 'device:watches',
  /** CLI → BE (29/10/2026): sắp thoát để chuyển sang bản CLI vừa tự cập nhật — `{ reason, version, expect_back_ms }`; máy sẽ nối lại ngay. */
  RESTARTING: 'device:restarting',
  /** CLI → BE (29/10/2026): chủ máy hỏi / giao việc qua linh vật — `{ text, request_id }`, ack `{ ok, request_id, session_id, error? }`. */
  CHAT: 'device:chat',
  /** BE → CLI: tiến trình / câu trả lời của lượt chat — `{ request_id, kind: progress | answer | timeout | error, text }`. */
  CHAT_EVENT: 'device:chat_event',
  /** CLI → BE: giọng nói (WAV) → chữ, ack `{ ok, text, error? }` (biên bản họp). */
  STT: 'device:stt',
  /** CLI → BE (29/10/2026): mở phiên nói chuyện realtime với linh vật — ack `{ ok, session_id, error? }`, rồi `device:voice_event`. */
  VOICE_START: 'device:voice_start',
  /** CLI → BE: một đoạn mic `{ audio }` (base64 PCM16 mono, tần số `input_sample_rate` của sự kiện `ready`). */
  VOICE_AUDIO: 'device:voice_audio',
  /** CLI → BE: ngắt lời bot đang nói. */
  VOICE_INTERRUPT: 'device:voice_interrupt',
  /** CLI → BE: kết thúc phiên nói chuyện. */
  VOICE_STOP: 'device:voice_stop',
  /** BE → CLI: `{ kind: ready | user_transcript | assistant_transcript | audio | audio_done | speech_started | error | closed, … }`. */
  VOICE_EVENT: 'device:voice_event',
  /**
   * BE → CLI (29/10/2026): linh vật báo chủ động — việc của chủ máy (giao trên web, chạy nền, automation…) xong / lỗi / cần trả lời:
   * `{ id, kind: done | failed | needs_you, title, text, session_id?, question? }`.
   */
  NOTIFY: 'device:notify',
  /** CLI → BE (30/10/2026): báo chủ động chưa nhận (offline / rớt mạng lúc gửi) — ack `{ ok, notices }`; gọi sau HELLO. */
  INBOX: 'device:inbox',
  /** CLI → BE: đã nhận các báo `{ ids }` (từ `notify`, `inbox`, hay `notice_id` của `chat_event`) — BE bỏ khỏi hộp. */
  NOTIFY_ACK: 'device:notify_ack',
  /** CLI → BE: câu hỏi còn ghim đã đóng chưa `{ items: [{ session_id, reply_id }] }` — ack `{ ok, closed: reply_id[] }`. */
  QUESTIONS: 'device:questions',
  /** CLI → BE: dừng lượt chat đang chạy `{ request_id }` — lượt kết thúc bằng `error` mã `cancelled`. */
  CHAT_CANCEL: 'device:chat_cancel',
  /** CLI → BE (30/10/2026): mở phiên chat mới cho linh vật — câu hỏi kế đi vào phiên mới (phiên cũ vẫn trên Aivin). Ack `{ ok, error? }`. */
  CHAT_NEW: 'device:chat_new',
});

/** Loại báo chủ động (`device:notify`). */
export const NotifyKind = Object.freeze({ DONE: 'done', FAILED: 'failed', NEEDS_YOU: 'needs_you' });

/** Loại sự kiện của phiên nói chuyện (`device:voice_event`). */
export const VoiceEventKind = Object.freeze({
  READY: 'ready', USER_TRANSCRIPT: 'user_transcript', ASSISTANT_TRANSCRIPT: 'assistant_transcript', AUDIO: 'audio', AUDIO_DONE: 'audio_done',
  SPEECH_STARTED: 'speech_started', ERROR: 'error', CLOSED: 'closed',
  /** Dòng tiến trình của việc agent đang làm trong lúc nói chuyện. */
  PROGRESS: 'progress',
});

/** Loại sự kiện của lượt chat từ linh vật (`device:chat_event`). */
/** `delta`: câu trả lời đang viết — `text` = cả câu tới lúc đó; chỉ tới khi máy xin (`stream: true` trong `device:chat`). */
export const ChatEventKind = Object.freeze({ PROGRESS: 'progress', ANSWER: 'answer', TIMEOUT: 'timeout', ERROR: 'error', NEEDS_INPUT: 'needs_input', DELTA: 'delta' });

/** Năng lực BE báo trong ack của `device:hello` (`features`). */
/** Pha của `device:hold`: `waiting` = chờ người bấm xác nhận trên máy, `started` = đã qua hộp, bước bắt đầu chạy (BE phân biệt chưa chạy / chạy dở). */
export const HoldPhase = Object.freeze({ WAITING: 'waiting', STARTED: 'started' });

export const ServerFeature = Object.freeze({
  EMBED: 'embed',
  WATCH: 'watch',
  /** BE gửi lại lời gọi khi máy nối lại + xác nhận từng kết quả (ack của `device:result`) — máy giữ kết quả tới khi BE nhận. */
  RESUME: 'resume',
  /** Nói chuyện realtime với linh vật (`device:voice_*`). */
  VOICE: 'voice',
  /** Hộp báo chủ động (`device:inbox` / `device:notify_ack`) + `device:questions`. */
  INBOX: 'inbox',
  /** Dừng lượt chat từ linh vật (`device:chat_cancel`). */
  CHAT_CANCEL: 'chat_cancel',
  /** Mở phiên chat mới cho linh vật (`device:chat_new`). */
  CHAT_NEW: 'chat_new',
});

/** Nhóm giới hạn song song trên máy — mỗi công cụ thuộc một nhóm. */
export const ToolGroup = Object.freeze({
  FS_READ: 'fs_read',
  FS_WRITE: 'fs_write',
  EXEC: 'exec',
  SYSTEM: 'system',
  MEMORY: 'memory',
  GIT: 'git',
  /** Đường hầm trình duyệt cho AI Browser (mỗi nhiệm vụ / việc con một đường hầm). */
  BROWSER: 'browser',
  /** Điều khiển giao diện (chuột / bàn phím / cây trợ năng) — một màn hình chỉ một luồng thao tác. */
  GUI: 'gui',
  /** Đầu nối Office qua COM (Excel / Word / Outlook) — chung tiến trình host với GUI, chạy lần lượt. */
  OFFICE: 'office',
  /** Tiến trình nền (proc.*) — proc.wait_for giữ chỗ lâu nên trần rộng hơn nhóm chạy lệnh. */
  PROC: 'proc',
  /** Ghi chú cuộc họp (meeting.*) + chụp màn hình (screen.capture). */
  MEDIA: 'media',
});

/** Số lời gọi chạy cùng lúc tối đa mỗi nhóm (chỉnh qua biến môi trường AIVIN_REMOTE_LIMIT_<NHÓM>). */
export const DEFAULT_GROUP_LIMITS = Object.freeze({
  [ToolGroup.FS_READ]: 16,
  [ToolGroup.FS_WRITE]: 4,
  [ToolGroup.EXEC]: 3,
  [ToolGroup.SYSTEM]: 4,
  [ToolGroup.MEMORY]: 8,
  [ToolGroup.GIT]: 4,
  [ToolGroup.BROWSER]: 8,
  [ToolGroup.GUI]: 1,
  [ToolGroup.OFFICE]: 1,
  [ToolGroup.PROC]: 16,
  [ToolGroup.MEDIA]: 4,
});

/**
 * Máy tính tổ chức (`--multi-user`): trần song song MỖI thành viên trong từng nhóm, cộng với trần chung ở trên — một người không chiếm
 * hết chỗ của cả tổ chức. Chỉnh qua AIVIN_REMOTE_SCOPE_LIMIT_<NHÓM>. Nhóm không có ở đây chỉ chịu trần chung.
 */
export const DEFAULT_SCOPE_LIMITS = Object.freeze({
  [ToolGroup.FS_READ]: 6,
  [ToolGroup.FS_WRITE]: 2,
  [ToolGroup.EXEC]: 2,
  [ToolGroup.GIT]: 2,
  [ToolGroup.MEMORY]: 4,
  [ToolGroup.SYSTEM]: 2,
  [ToolGroup.PROC]: 4,
});

export const DeviceErrorCode = Object.freeze({
  ROOT_DENIED: 'ROOT_DENIED',
  KILL_SWITCH: 'KILL_SWITCH',
  PROTECTED_PATH: 'PROTECTED_PATH',
  BLOCKED_COMMAND: 'BLOCKED_COMMAND',
  /** Chủ máy tắt công cụ / chặn lệnh này trong luật tại máy (`aivin remote policy`). */
  LOCAL_DENIED: 'LOCAL_DENIED',
  /** Người ngồi trước máy bấm "Từ chối" ở hộp xác nhận. */
  LOCAL_REJECTED: 'LOCAL_REJECTED',
  /** Không ai bấm hộp xác nhận trên máy trong thời hạn (người dùng không ngồi trước máy). */
  LOCAL_CONFIRM_TIMEOUT: 'LOCAL_CONFIRM_TIMEOUT',
  /** Máy không hiện được hộp xác nhận (không có màn hình / không có terminal) — việc cần xác nhận bị từ chối. */
  LOCAL_CONFIRM_UNAVAILABLE: 'LOCAL_CONFIRM_UNAVAILABLE',
  CALL_TIMEOUT: 'CALL_TIMEOUT',
  CANCELLED: 'CANCELLED',
  /** Bước có tác dụng đã bắt đầu thì daemon khởi động lại — không biết đã làm tới đâu, không tự làm lại. */
  INTERRUPTED: 'INTERRUPTED',
  TOOL_UNKNOWN: 'TOOL_UNKNOWN',
  INVALID_ARGS: 'INVALID_ARGS',
  NOT_FOUND: 'NOT_FOUND',
  OUTPUT_TOO_LARGE: 'OUTPUT_TOO_LARGE',
  MEMORY_UNAVAILABLE: 'MEMORY_UNAVAILABLE',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  /** Máy không có Chrome / Edge cho AI Browser. */
  BROWSER_NOT_FOUND: 'BROWSER_NOT_FOUND',
  /** Máy tính tổ chức đã dùng hết dung lượng đĩa được cấp — chỉ còn đọc / xoá để dọn chỗ. */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /** Tầng giao diện: máy không hỗ trợ / tiến trình trợ giúp không chạy được. */
  GUI_UNAVAILABLE: 'GUI_UNAVAILABLE',
  /** node_id của lần observe cũ hoặc phần tử đã biến mất — observe lại. */
  GUI_STALE_NODE: 'GUI_STALE_NODE',
  GUI_TARGET_NOT_FOUND: 'GUI_TARGET_NOT_FOUND',
  GUI_AMBIGUOUS_TARGET: 'GUI_AMBIGUOUS_TARGET',
  GUI_NO_EFFECT: 'GUI_NO_EFFECT',
  /** Người dùng đang dùng chuột / bàn phím — AI dừng, hỏi trước khi làm tiếp. */
  GUI_USER_ACTIVE: 'GUI_USER_ACTIVE',
  /** Ứng dụng không được điều khiển (quản lý mật khẩu, hộp nâng quyền, terminal khi không toàn quyền…). */
  GUI_BLOCKED_APP: 'GUI_BLOCKED_APP',
  /** Gõ vào ô mật khẩu — người dùng tự gõ. */
  GUI_PASSWORD_FIELD: 'GUI_PASSWORD_FIELD',
  /** Màn hình đang khoá / hộp bảo mật đang hiện. */
  GUI_LOCKED: 'GUI_LOCKED',
  /** `gui.wait_for` hết giờ mà giao diện chưa tới trạng thái chờ. */
  GUI_WAIT_TIMEOUT: 'GUI_WAIT_TIMEOUT',
  /** OCR của Windows không dùng được (không có gói ngôn ngữ OCR / WinRT lỗi) — observe vẫn trả cây + ảnh. */
  GUI_OCR_UNAVAILABLE: 'GUI_OCR_UNAVAILABLE',
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
