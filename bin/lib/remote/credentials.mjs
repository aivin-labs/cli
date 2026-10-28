import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { DEVICE_API_PREFIX, DEVICE_CREDENTIALS_FILE, DEVICE_ID_FILE, REMOTE_CONFIG_DIR } from './constants.mjs';
import { parseApiKeyClient } from '../auth.mjs';

/** Mã máy ổn định (~/.aivin/device-id.json), giữ qua các lần chạy. */
export function getOrCreateDeviceId() {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
    if (data?.deviceId) return data.deviceId;
  } catch { /* chưa có → sinh mới */ }
  const deviceId = `dev-${randomUUID()}`;
  fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId, hostname: os.hostname(), createdAt: new Date().toISOString() }, null, 2) + '\n');
  return deviceId;
}

/** Sinh mã máy mới (máy nhân bản từ ảnh đĩa…) — đồng thời bỏ token cũ. */
export function resetDeviceId() {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  const deviceId = `dev-${randomUUID()}`;
  fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId, hostname: os.hostname(), createdAt: new Date().toISOString() }, null, 2) + '\n');
  clearDeviceCredentials();
  return deviceId;
}

export function loadDeviceCredentials() {
  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_CREDENTIALS_FILE, 'utf8'));
    return data?.device_token ? data : null;
  } catch {
    return null;
  }
}

export function saveDeviceCredentials(creds) {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(DEVICE_CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(DEVICE_CREDENTIALS_FILE, 0o600); } catch { /* Windows: quyền theo ACL hồ sơ người dùng */ }
}

/**
 * Xoá token đã lưu. `onlyToken`: chỉ xoá khi tệp còn đúng token đó — daemon cũ (token vừa hết hiệu lực vì máy được ghép lại, vd chạy
 * lại bộ cài trong lúc bản cũ còn nhận việc) không được xoá token MỚI mà daemon mới vừa ghi (chạy thật 26/10/2026: lần khởi động sau mất
 * kết nối).
 */
export function clearDeviceCredentials(onlyToken) {
  if (onlyToken && loadDeviceCredentials()?.device_token !== onlyToken) return false;
  try { fs.unlinkSync(DEVICE_CREDENTIALS_FILE); } catch { /* không có thì thôi */ }
  return true;
}

/**
 * Máy tính tổ chức: BE cấp token thiết bị lúc tạo container và đặt vào env (`AIVIN_DEVICE_TOKEN` / `AIVIN_DEVICE_ID` / `AIVIN_SERVER`) — không
 * ghép máy, không ghi tệp token. Thiếu biến → `null`.
 */
export function credentialsFromEnv(env = process.env) {
  const token = String(env.AIVIN_DEVICE_TOKEN || '').trim();
  const deviceId = String(env.AIVIN_DEVICE_ID || '').trim();
  const serverUrl = String(env.AIVIN_SERVER || '').trim().replace(/\/+$/, '');
  if (!token || !deviceId || !serverUrl) return null;
  return { device_token: token, device_id: deviceId, name: String(env.AIVIN_DEVICE_NAME || deviceId), server_url: serverUrl };
}

/** Tenant trong token thiết bị `<client>-dk-<bí mật>`. */
export function deviceTokenClient(token) {
  const at = String(token || '').lastIndexOf('-dk-');
  return at > 0 ? String(token).slice(0, at) : undefined;
}

export function apiHeaders(apiKey) {
  const client = (apiKey ? parseApiKeyClient(apiKey) : undefined) || deviceTokenClient(loadDeviceCredentials()?.device_token);
  return { headers: { Authorization: `Bearer ${apiKey}`, ...(client ? { 'x-client-slug': client } : {}) } };
}

function errorText(error) {
  return error.response?.data?.message || error.response?.data?.i18n || error.message || error.code || 'Unknown error';
}

/**
 * Ghép máy với tài khoản đang đăng nhập (API key): BE cấp token THIẾT BỊ riêng, chỉ lưu băm. Ghép lại = token cũ hết hiệu lực.
 */
export async function pairDevice({ serverUrl, apiKey, roots, name, profile }) {
  if (!apiKey) throw new Error('Chưa đăng nhập. Tạo mã kết nối trên Aivin (ô chat → Trình duyệt ▾ → Thêm máy tính này) rồi chạy `aivin remote start --code <mã>`, hoặc `aivin login` trước.');
  const deviceId = getOrCreateDeviceId();
  let res;
  try {
    res = await axios.post(`${serverUrl}${DEVICE_API_PREFIX}/devices/pair`, {
      device_id: deviceId,
      name: name || os.hostname(),
      profile,
    }, apiHeaders(apiKey));
  } catch (error) {
    throw new Error(`Không ghép được máy với ${serverUrl}: ${errorText(error)}`, { cause: error });
  }
  return savePairResult(res, { serverUrl, deviceId, roots, name });
}

/**
 * Ghép máy bằng mã kết nối tạo trên giao diện Aivin (nút "Thêm máy tính này") — không cần `aivin login`: mã mang sẵn tài khoản, dùng
 * một lần, có hạn. Gõ thường / thiếu gạch đều được (BE chuẩn hoá).
 */
export async function pairDeviceWithCode({ serverUrl, code, roots, name, profile }) {
  const deviceId = getOrCreateDeviceId();
  let res;
  try {
    res = await axios.post(`${serverUrl}${DEVICE_API_PREFIX}/devices/pair-with-code`, {
      code: String(code).trim(),
      device_id: deviceId,
      name: name || os.hostname(),
      profile,
    });
  } catch (error) {
    throw new Error(`Không ghép được máy bằng mã ${code}: ${errorText(error)}`, { cause: error });
  }
  return savePairResult(res, { serverUrl, deviceId, roots, name });
}

function savePairResult(res, { serverUrl, deviceId, roots, name }) {
  const data = res.data?.data ?? res.data;
  if (!data?.device_token) throw new Error('Máy chủ không trả token thiết bị.');
  const creds = {
    server_url: serverUrl,
    device_id: deviceId,
    device_token: data.device_token,
    name: data.device?.name || name || os.hostname(),
    roots: roots.map((r) => path.resolve(r)),
    paired_at: new Date().toISOString(),
  };
  saveDeviceCredentials(creds);
  return creds;
}

export async function listDevices({ serverUrl, apiKey }) {
  try {
    const res = await axios.get(`${serverUrl}${DEVICE_API_PREFIX}/devices`, apiHeaders(apiKey));
    return (res.data?.data ?? res.data)?.devices || [];
  } catch (error) {
    throw new Error(`Không lấy được danh sách máy: ${errorText(error)}`, { cause: error });
  }
}

export async function unpairDevice({ serverUrl, apiKey, deviceId }) {
  try {
    await axios.delete(`${serverUrl}${DEVICE_API_PREFIX}/devices/${encodeURIComponent(deviceId)}`, apiHeaders(apiKey));
  } catch (error) {
    if (error.response?.status !== 404) throw new Error(`Không thu hồi được máy: ${errorText(error)}`, { cause: error });
  }
  const creds = loadDeviceCredentials();
  if (creds?.device_id === deviceId) clearDeviceCredentials();
}
