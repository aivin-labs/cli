import path from 'path';
import { REMOTE_CONFIG_DIR } from '../remote/constants.mjs';

/** Tự cập nhật CLI — đường dẫn, mã, trạng thái dùng chung giữa các module trong `update/` (xem selfUpdate.mjs). */

export const DEFAULT_DOWNLOAD_ROOT = 'https://get.aivin.vn';
export const UPDATE_SETTINGS_FILE = path.join(REMOTE_CONFIG_DIR, 'update.json');
/** Bản vừa cài xuống đĩa (`aivin update` ở cửa sổ khác hoặc daemon tự cài) — daemon đang chạy bản cũ đọc tệp này để biết cần chạy lại. */
export const UPDATE_INSTALLED_FILE = path.join(REMOTE_CONFIG_DIR, 'update-installed.json');
/** Bản vừa cài chưa được xác nhận chạy ổn (nối được máy chủ / chạy đủ lâu) + số lần đã khởi động. */
export const UPDATE_STATE_FILE = path.join(REMOTE_CONFIG_DIR, 'update-state.json');
export const UPDATE_LOCK_FILE = path.join(REMOTE_CONFIG_DIR, 'update.lock');
/**
 * Dấu chờ xác nhận dạng chữ thường (một dòng: phiên bản) cho TRÌNH GIỮ CHẠY (VBS / kịch bản sh) — tự lùi bản cả khi bản mới sập ngay lúc nạp
 * mã, trước khi đoạn kiểm trong tệp chạy kịp chạy. Trình giữ chạy không đọc JSON được dễ dàng nên tách riêng.
 */
export const UPDATE_PENDING_FILE = path.join(REMOTE_CONFIG_DIR, 'update-pending.txt');
/** Trình giữ chạy đã tự lùi bản (một dòng: phiên bản bị lùi) — tệp chạy (bản cũ) đọc ở lần khởi động sau, đưa bản đó vào danh sách bỏ qua. */
export const UPDATE_ROLLBACK_FILE = path.join(REMOTE_CONFIG_DIR, 'update-rollback.txt');
/** Kết quả lần kiểm gần nhất (giờ, lỗi, bản trang tải báo, bản đã tự lùi) — gửi máy chủ trong hồ sơ máy để biết cả đội máy đang ra sao. */
export const UPDATE_STATUS_FILE = path.join(REMOTE_CONFIG_DIR, 'update-status.json');

/** Mã thoát "chạy lại tôi" (EX_TEMPFAIL): Task Scheduler + VBS / launchd / systemd chạy lại mọi mã khác 0. */
export const RESTART_EXIT_CODE = 75;
export const MAX_BOOTS_BEFORE_ROLLBACK = 3;
/** Bản mới chạy liền chừng này không sập → coi là ổn, bỏ bản cũ. */
export const UPDATE_CONFIRM_AFTER_MS = 10 * 60_000;
/** Mã lỗi `aivin remote start` khi vừa tự lùi bản: trình giữ chạy → thoát 75 (mở lại bằng bản cũ), cửa sổ tay → báo + thoát 1. */
export const UPDATE_ROLLED_BACK = 'UPDATE_ROLLED_BACK';

export const UpdateStatus = Object.freeze({
  UP_TO_DATE: 'up_to_date',
  AVAILABLE: 'available',
  INSTALLED: 'installed',
  NOT_BINARY: 'not_binary',
  /** Bản mới nhất là bản máy này đã tự lùi khỏi (khởi động hỏng) — chỉ cài lại khi người dùng chỉ định `--to`. */
  SKIPPED: 'skipped',
  /** Máy chủ báo bản này đang bị hoãn (nhiều máy tự lùi khỏi nó) — daemon không cài, `aivin update` chạy tay vẫn cài được. */
  HELD: 'held',
  /** Phát hành theo đợt (`rollout.json`): máy này chưa tới lượt. */
  DEFERRED: 'deferred',
  /** Một tiến trình khác đang cập nhật. */
  BUSY: 'busy',
});

export const BootAction = Object.freeze({ NONE: 'none', PENDING: 'pending', ROLLED_BACK: 'rolled_back' });
/** Ai đã tự lùi bản: đoạn kiểm trong tệp chạy, hay trình giữ chạy (bản mới sập trước khi kiểm được). */
export const RollbackBy = Object.freeze({ BINARY: 'binary', SUPERVISOR: 'supervisor' });

export const HTTP_TIMEOUT_MS = 15_000;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
export const MAX_BINARY_BYTES = 512 * 1024 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024;
export const VERIFY_TIMEOUT_MS = 30_000;
export const LOCK_STALE_MS = 15 * 60_000;
