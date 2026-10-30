import fs from 'fs';
import path from 'path';
import { REMOTE_CONFIG_DIR } from './deviceProfile.mjs';

export const REMOTE_ACTIVITY_LOG_FILE = path.join(REMOTE_CONFIG_DIR, 'remote-activity.log');
const MAX_LOG_LINES = 500;

/**
 * Ghi lại một hoạt động điều khiển từ xa vào nhật ký máy tính.
 */
export function logActivity(entry) {
  try {
    fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    }) + '\n';

    fs.appendFileSync(REMOTE_ACTIVITY_LOG_FILE, line, 'utf8');

    // Cắt tỉa nếu tập tin nhật ký vượt quá giới hạn
    const content = fs.readFileSync(REMOTE_ACTIVITY_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      const trimmed = lines.slice(-MAX_LOG_LINES).join('\n') + '\n';
      fs.writeFileSync(REMOTE_ACTIVITY_LOG_FILE, trimmed, 'utf8');
    }
  } catch {
    // Tránh để lỗi ghi nhật ký làm gián đoạn luồng chính
  }
}

/**
 * Lấy danh sách các hoạt động gần đây nhất.
 */
export function getRecentLogs(limit = 50) {
  try {
    if (!fs.existsSync(REMOTE_ACTIVITY_LOG_FILE)) return [];
    const content = fs.readFileSync(REMOTE_ACTIVITY_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .slice(-Number(limit))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { message: line };
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Xóa toàn bộ lịch sử hoạt động.
 */
export function clearLogs() {
  try {
    if (fs.existsSync(REMOTE_ACTIVITY_LOG_FILE)) {
      fs.unlinkSync(REMOTE_ACTIVITY_LOG_FILE);
    }
    return { success: true };
  } catch (err) {
    throw new Error(`Không thể xóa nhật ký hoạt động: ${err.message}`, { cause: err });
  }
}
