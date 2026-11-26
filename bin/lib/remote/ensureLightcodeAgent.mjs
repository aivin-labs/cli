import axios from 'axios';
import { apiHeaders } from './credentials.mjs';

/** Trần chờ máy chủ: LightCode gọi lệnh này lúc đồng bộ, không được treo. */
const ENSURE_TIMEOUT_MS = 30_000;

function failureText(error, serverUrl) {
  const status = error.response?.status;
  const licenseLimit = String(error.response?.data?.i18n || error.response?.data?.message || '').includes('LICENSE_LIMIT');
  if (status === 401 || (status === 403 && !licenseLimit)) {
    return `Đăng nhập tại ${serverUrl} không còn hiệu lực hoặc không đủ quyền (HTTP ${status}). Chạy \`aivin login ${serverUrl}\`.`;
  }
  if (status === 404) return `Máy chủ ${serverUrl} chưa hỗ trợ agent LightCode cá nhân (HTTP 404).`;
  if (status === 503) return `Máy chủ ${serverUrl} chưa bật agent LightCode cá nhân (HTTP 503).`;
  const reason = error.response?.data?.message || error.response?.data?.i18n || error.message || error.code || 'Unknown error';
  return `Không tạo / kiểm tra được agent LightCode từ ${serverUrl}: ${reason}`;
}

/**
 * Bảo đảm user đang đăng nhập có đúng 1 agent "LightCode" cá nhân (`POST /ai-staff/ensure-lightcode`).
 * Idempotent phía máy chủ: gọi lại không tạo thêm (`created: false`). Trả đúng 3 trường LightCode đọc:
 * `{ agent_id, name, created }`.
 */
export async function ensureLightcodeAgent({ serverUrl, apiKey, timeoutMs = ENSURE_TIMEOUT_MS }) {
  if (!apiKey) throw new Error(`Chưa đăng nhập tại ${serverUrl}. Chạy \`aivin login ${serverUrl}\` trước.`);
  let res;
  try {
    res = await axios.post(`${serverUrl}/ai-staff/ensure-lightcode`, {}, { ...apiHeaders(apiKey), timeout: timeoutMs });
  } catch (error) {
    throw new Error(failureText(error, serverUrl), { cause: error });
  }
  const body = res.data?.data ?? res.data;
  if (typeof body?.agent_id !== 'string' || !body.agent_id) throw new Error(`Máy chủ ${serverUrl} không trả agent LightCode.`);
  return { agent_id: body.agent_id, name: String(body.name ?? ''), created: body.created === true };
}

