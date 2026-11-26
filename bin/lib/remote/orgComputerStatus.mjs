import axios from 'axios';
import { DEVICE_API_PREFIX } from './constants.mjs';
import { apiHeaders } from './credentials.mjs';

/** Trần chờ máy chủ: chương trình khác (menu Environment của LightCode) gọi lệnh này, không được treo. */
const STATUS_TIMEOUT_MS = 15_000;

function failureText(error, serverUrl) {
  const status = error.response?.status;
  if (status === 401 || status === 403) return `Đăng nhập tại ${serverUrl} không còn hiệu lực hoặc không đủ quyền (HTTP ${status}). Chạy \`aivin login ${serverUrl}\`.`;
  if (status === 404) return `Máy chủ ${serverUrl} chưa hỗ trợ Cloud Computer (HTTP 404).`;
  const reason = error.response?.data?.message || error.response?.data?.i18n || error.message || error.code || 'Unknown error';
  return `Không lấy được trạng thái Cloud Computer từ ${serverUrl}: ${reason}`;
}

/**
 * Trạng thái máy tính tổ chức — CHỈ ĐỌC: không `/start`, không `?wait=1` (cả hai đều bật máy / giữ lời gọi).
 * `state` giữ nguyên giá trị máy chủ trả; các trường khác của `OrgComputerStatus` đi kèm.
 */
export async function fetchOrgComputerStatus({ serverUrl, apiKey, timeoutMs = STATUS_TIMEOUT_MS }) {
  if (!apiKey) throw new Error(`Chưa đăng nhập tại ${serverUrl}. Chạy \`aivin login ${serverUrl}\` trước.`);
  let res;
  try {
    res = await axios.get(`${serverUrl}${DEVICE_API_PREFIX}/org-computer`, { ...apiHeaders(apiKey), timeout: timeoutMs });
  } catch (error) {
    throw new Error(failureText(error, serverUrl), { cause: error });
  }
  const status = res.data?.data ?? res.data;
  if (typeof status?.state !== 'string' || !status.state) throw new Error(`Máy chủ ${serverUrl} không trả trạng thái Cloud Computer.`);
  return { ...status, state: status.state, online: status.online === true };
}
