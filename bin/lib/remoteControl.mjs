/**
 * Điều khiển máy từ xa (Device Agent phía máy) — các mô-đun trong ./remote/:
 *  - client.mjs        : daemon `aivin remote start` — nối namespace /device bằng token thiết bị, nhận lô lời gọi, trả kết quả/luồng.
 *  - credentials.mjs   : mã máy, ghép máy (token thiết bị riêng), danh sách / thu hồi máy.
 *  - deviceProfile.mjs : tự phát hiện năng lực máy (chương trình trên PATH, dự án) + danh mục công cụ có dấu vân tay.
 *  - toolHandlers.mjs  : các gói công cụ (fs, shell, system, git, memory).
 *  - scheduler.mjs     : song song theo nhóm công cụ, khoá theo đường dẫn khi ghi, huỷ / hết giờ.
 *  - sandbox.mjs       : sàn cứng — thư mục gốc (realpath), lọc biến môi trường, chặn lệnh thảm hoạ, công tắc ngắt.
 *  - deviceMemory.mjs  : bộ nhớ trên máy (YAML người đọc/sửa được + vector), tìm kết hợp BM25 + cosine.
 *  - fileIndexer.mjs   : chỉ mục tệp (SQLite trên đĩa, FTS5 + vector), quét tăng dần + theo dõi thay đổi.
 *  - mission.mjs       : `aivin remote do` — giao thẳng việc cho Device Agent.
 *  - activityLog.mjs / autoStart.mjs : nhật ký hoạt động, tự khởi động cùng máy.
 */

export * from './remote/deviceProfile.mjs';
export * from './remote/toolHandlers.mjs';
export * from './remote/deviceMemory.mjs';
export * from './remote/activityLog.mjs';
export * from './remote/autoStart.mjs';
export * from './remote/client.mjs';
export * from './remote/fileIndexer.mjs';
export * from './remote/credentials.mjs';
export * from './remote/scheduler.mjs';
export * from './remote/sandbox.mjs';
export * from './remote/mission.mjs';
export { DEVICE_AGENT_PLUGIN_ID, DeviceEvent, DeviceErrorCode, MemoryKind } from './remote/constants.mjs';
