import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { DEVICE_API_PREFIX, DEVICE_CREDENTIALS_FILE, DEVICE_ID_FILE, REMOTE_CONFIG_DIR } from './constants.mjs';
import { parseApiKeyClient } from '../auth.mjs';
import { TokenStoreKind, forgetToken, openToken, preferredTokenStore, sealToken } from './tokenStore.mjs';
import { writeFileAtomic } from './atomicFile.mjs';

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

/**
 * Token đã giải theo nội dung tệp — giải DPAPI / Keychain tốn một tiến trình con (~0,5 s) mà tệp được đọc ở nhiều chỗ (mỗi lời gọi REST
 * lấy tenant từ token). Tệp đổi (ghép lại / xoay token / tiến trình khác ghi) → giải lại.
 */
let opened = { raw: null, token: null };

function readRecord() {
  try {
    const raw = fs.readFileSync(DEVICE_CREDENTIALS_FILE, 'utf8');
    return { raw, data: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/** Ghi nguyên tử (02/11/2026 — trước đây ghi thẳng, máy tắt / daemon bị giết giữa lúc ghi là tệp cụt → mất ghép máy). */
function writeRecord(record) {
  const raw = JSON.stringify(record, null, 2) + '\n';
  writeFileAtomic(DEVICE_CREDENTIALS_FILE, raw);
  try { fs.chmodSync(DEVICE_CREDENTIALS_FILE, 0o600); } catch { /* Windows: quyền theo ACL hồ sơ người dùng */ }
  return raw;
}

/**
 * Trường do TỆP làm chủ (02/11/2026) — bản trong bộ nhớ của người gọi có thể đã cũ (daemon nạp lúc khởi động), nên khi lưu luôn lấy theo
 * tệp trên đĩa, trừ khi đổi tường minh qua tham số:
 * - `previous_sealed`: token CŨ (cất vào kho bí mật như token chính) giữ tới khi máy chủ xác nhận token xoay vòng mới;
 * - `policy_sealed_at`: máy này đã từng có luật tại máy CÓ CHỮ KÝ (localPolicy.mjs) — xoá cả tệp luật lẫn tệp khoá không đưa được luật về
 *   mặc định một cách lặng lẽ.
 */
const DISK_OWNED_FIELDS = ['previous_sealed', 'policy_sealed_at'];
const PREVIOUS_SUFFIX = ':previous';

function sealPrevious(token, deviceId) {
  const account = `${deviceId}${PREVIOUS_SUFFIX}`;
  const { fallback_reason: _why, ...sealed } = sealToken(token, { account });
  return { ...sealed, account };
}

const openPrevious = (rec) => (rec && typeof rec === 'object' ? openToken({ ...rec, device_id: rec.account }) : null);
const forgetPrevious = (rec) => { if (rec && typeof rec === 'object') forgetToken({ ...rec, device_id: rec.account }); };

/** Cất vào kho bí mật hỏng gần đây → không thử lại mỗi lần đọc (mỗi lần thử là một tiến trình PowerShell). */
const SEAL_RETRY_MS = 24 * 3600_000;

/**
 * Thông tin ghép máy kèm `device_token` đã giải (tokenStore.mjs). Tệp cũ còn token chữ thường mà máy có kho bí mật → chuyển sang kho
 * (lần hỏng gần nhất trong `SEAL_RETRY_MS` thì thôi). Không giải được (tệp chép từ máy / tài khoản khác) → `null` = coi như chưa ghép.
 * `seal_failed: { at, reason }` trên kết quả: token đang nằm chữ thường vì kho bí mật hỏng — daemon in cảnh báo.
 */
export function loadDeviceCredentials() {
  const rec = readRecord();
  if (!rec?.data) return null;
  const { data, raw } = rec;
  if (raw === opened.raw && opened.token) return { ...data, device_token: opened.token };
  const token = openToken(data);
  if (!token) return null;
  opened = { raw, token };
  const retrySeal = !data.seal_failed || Date.now() - Number(data.seal_failed.at || 0) > SEAL_RETRY_MS;
  if (data.device_token && preferredTokenStore() !== TokenStoreKind.FILE && retrySeal) {
    saveDeviceCredentials({ ...data, device_token: token });
    return { ...readRecord()?.data, device_token: token };
  }
  return { ...data, device_token: token };
}

/**
 * Ghi token (kho bí mật của hệ điều hành; hỏng → tệp thường kèm `seal_failed` có lý do để báo người dùng, không lặng lẽ). Trả lý do hỏng
 * (`null` khi cất được hoặc máy vốn không có kho).
 */
export function saveDeviceCredentials(creds, { previousToken } = {}) {
  const { device_token: token, token_store: _s, token_enc: _e, seal_failed: _f, ...rest } = creds;
  for (const f of DISK_OWNED_FIELDS) delete rest[f];
  const disk = readRecord()?.data || {};
  // Cùng mã máy → giữ trường của tệp; ghép máy khác thì token cũ không còn nghĩa.
  const kept = {};
  if (disk.device_id === creds.device_id && disk.previous_sealed) kept.previous_sealed = disk.previous_sealed;
  if (disk.policy_sealed_at) kept.policy_sealed_at = disk.policy_sealed_at;
  if (previousToken !== undefined) {
    if (kept.previous_sealed) forgetPrevious(kept.previous_sealed);
    delete kept.previous_sealed;
    if (previousToken) kept.previous_sealed = sealPrevious(previousToken, creds.device_id);
  }
  const sealed = sealToken(token, { account: creds.device_id });
  const { fallback_reason: reason, ...stored } = sealed;
  const raw = writeRecord({ ...rest, ...stored, ...kept, ...(reason ? { seal_failed: { at: Date.now(), reason } } : {}) });
  opened = { raw, token };
  return reason || null;
}

/**
 * Xoay vòng token (02/11/2026): token cũ giữ trong `previous_sealed` tới khi máy chủ xác nhận token mới. Trước đây ack ROTATED lỡ mất mà máy
 * chủ không chốt được token mới → lần nối sau `DEVICE_UNAUTHORIZED` → xoá sạch ghép máy dù token cũ vẫn còn hiệu lực.
 */
export function pendingPreviousToken() {
  return openPrevious(readRecord()?.data?.previous_sealed);
}

/** Máy chủ đã nhận token mới (ack ROTATED đúng / chào thành công bằng token mới) → bỏ token cũ. Trả true khi có bỏ. */
export function confirmTokenRotation(currentToken) {
  if (!readRecord()?.data?.previous_sealed) return false;
  const creds = loadDeviceCredentials();
  if (!creds || (currentToken && creds.device_token !== currentToken)) return false;
  saveDeviceCredentials(creds, { previousToken: null });
  return true;
}

/**
 * Token `failedToken` bị máy chủ từ chối mà còn token cũ chưa bỏ (xoay vòng chưa chốt) → quay về token cũ, trả nó; không có → null (người
 * gọi mới được xoá ghép máy).
 */
export function revertTokenRotation(failedToken) {
  const creds = loadDeviceCredentials();
  if (!creds || (failedToken && creds.device_token !== failedToken)) return null;
  const previous = pendingPreviousToken();
  if (!previous || previous === creds.device_token) return null;
  saveDeviceCredentials({ ...creds, device_token: previous }, { previousToken: null });
  return readStoredTokenFresh() === previous ? previous : null;
}

/** Dấu bền "máy đã từng có luật tại máy có chữ ký" (xem DISK_OWNED_FIELDS) — chỉ ghi khi đã ghép máy (có tệp thông tin ghép). */
export function notePolicySealed() {
  const rec = readRecord();
  if (!rec?.data || rec.data.policy_sealed_at) return;
  try {
    const raw = writeRecord({ ...rec.data, policy_sealed_at: new Date().toISOString() });
    if (opened.raw === rec.raw) opened = { raw, token: opened.token };
  } catch { /* không ghi được: daemon vẫn nhớ trong bộ nhớ */ }
}

export function policySealedNoted() {
  return !!readRecord()?.data?.policy_sealed_at;
}

/** Đọc lại token từ tệp + kho bí mật thật (không qua bộ nhớ đệm) — kiểm sau khi ghi token mới. */
export function readStoredTokenFresh() {
  const data = readRecord()?.data;
  return data ? openToken(data) : null;
}

/**
 * Xoá token đã lưu. `onlyToken`: chỉ xoá khi tệp còn đúng token đó — daemon cũ (token vừa hết hiệu lực vì máy được ghép lại, vd chạy
 * lại bộ cài trong lúc bản cũ còn nhận việc) không được xoá token MỚI mà daemon mới vừa ghi (chạy thật 26/10/2026: lần khởi động sau mất
 * kết nối).
 */
export function clearDeviceCredentials(onlyToken) {
  if (onlyToken && loadDeviceCredentials()?.device_token !== onlyToken) return false;
  forgetToken(readRecord()?.data);
  try { fs.unlinkSync(DEVICE_CREDENTIALS_FILE); } catch { /* không có thì thôi */ }
  opened = { raw: null, token: null };
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
    lang: data.user_lang || data.lang || undefined,
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
