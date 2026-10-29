import fs from 'fs';
import path from 'path';
import {
  BootAction, LOCK_STALE_MS, MAX_BOOTS_BEFORE_ROLLBACK, RollbackBy, UPDATE_INSTALLED_FILE, UPDATE_LOCK_FILE, UPDATE_PENDING_FILE, UPDATE_ROLLBACK_FILE,
  UPDATE_SETTINGS_FILE, UPDATE_STATE_FILE, UPDATE_STATUS_FILE, UpdateStatus,
} from './constants.mjs';
import { restoreBackup, retire } from './binarySwap.mjs';
import { compareVersions, currentCliVersion, parseVersion, tagOf, versionList } from './versions.mjs';

/** Trạng thái tự cập nhật trên đĩa (`~/.aivin`): cài đặt, khoá, dấu đã cài, bản chờ xác nhận, tự lùi bản, kết quả kiểm gửi máy chủ. */

const MAX_ROLLBACK_HISTORY = 5;
const MAX_ERROR_CHARS = 200;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

export function loadUpdateSettings(file = UPDATE_SETTINGS_FILE) {
  const data = readJson(file) || {};
  return { auto: data.auto !== false, skip: versionList(data.skip) };
}

export function saveUpdateSettings(patch, file = UPDATE_SETTINGS_FILE) {
  const next = { ...loadUpdateSettings(file), ...patch };
  writeJson(file, next);
  return next;
}

const addSkip = (version, file) => saveUpdateSettings({ skip: [...new Set([...loadUpdateSettings(file).skip, tagOf(version)])] }, file);

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** Một lần cập nhật mỗi lúc (daemon tự cập nhật + `aivin update` ở cửa sổ khác cùng thay một tệp). */
export async function withUpdateLock(fn, file = UPDATE_LOCK_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    const held = readJson(file);
    if (held && isAlive(Number(held.pid)) && Date.now() - Number(held.at) < LOCK_STALE_MS) return { status: UpdateStatus.BUSY };
    fs.writeFileSync(file, body);
  }
  try {
    return await fn();
  } finally {
    try { if (Number(readJson(file)?.pid) === process.pid) fs.rmSync(file, { force: true }); } catch { /* đã bị lấy lại */ }
  }
}

/** Sau khi thay tệp: bản chờ xác nhận (JSON cho tệp chạy + dòng chữ cho trình giữ chạy) và dấu "đĩa đã có bản mới". */
export function recordInstalled({ version, current, target, backup, stateFile = UPDATE_STATE_FILE, markerFile = UPDATE_INSTALLED_FILE, pendingFile = UPDATE_PENDING_FILE }) {
  const at = new Date().toISOString();
  writeJson(stateFile, { version: tagOf(version), previous: tagOf(current), target, backup, boots: 0, installed_at: at });
  writeJson(markerFile, { version: tagOf(version), path: target, installed_at: at });
  if (backup) fs.writeFileSync(pendingFile, `${tagOf(version)}\n`);
  else fs.rmSync(pendingFile, { force: true });
}

export function readInstalledMarker(file = UPDATE_INSTALLED_FILE) {
  const data = readJson(file);
  return data && parseVersion(data.version) && typeof data.path === 'string' ? data : null;
}

/** Đĩa đã có bản mới hơn bản đang chạy cho đúng tệp chạy này (cài ở cửa sổ khác / bởi daemon). Bản đã tự lùi khỏi không tính. */
export function installedNewerThanRunning({ target = process.execPath, current = currentCliVersion(), file = UPDATE_INSTALLED_FILE, settingsFile = UPDATE_SETTINGS_FILE } = {}) {
  const marker = readInstalledMarker(file);
  if (!marker || !samePath(marker.path, target) || compareVersions(marker.version, current) <= 0) return null;
  return loadUpdateSettings(settingsFile).skip.includes(tagOf(marker.version)) ? null : tagOf(marker.version);
}

/** Tiến trình vừa khởi động chính là tệp đang nằm trên đĩa → dấu "đã cài bản mới" cho tệp này đã cũ (cài lại bằng bộ cài, đã lùi bản…). */
export function clearStaleInstalledMarker({ target = process.execPath, file = UPDATE_INSTALLED_FILE } = {}) {
  const marker = readInstalledMarker(file);
  if (marker && samePath(marker.path, target)) fs.rmSync(file, { force: true });
}

export function readUpdateStatus(file = UPDATE_STATUS_FILE) {
  const data = readJson(file) || {};
  return {
    last_check_at: typeof data.last_check_at === 'string' ? data.last_check_at : null,
    last_error: typeof data.last_error === 'string' ? data.last_error : null,
    site_latest: parseVersion(data.site_latest) ? tagOf(data.site_latest) : null,
    site_behind: data.site_behind === true,
    rolled_back: Array.isArray(data.rolled_back) ? data.rolled_back.filter((r) => parseVersion(r?.version)).slice(-MAX_ROLLBACK_HISTORY) : [],
  };
}

/** Ghi kết quả một lần kiểm (thành công: xoá lỗi cũ). Không ghi được thì thôi — chỉ để báo máy chủ. */
export function recordCheck({ siteLatest, error, siteBehind, file = UPDATE_STATUS_FILE } = {}) {
  try {
    const prev = readUpdateStatus(file);
    writeJson(file, {
      ...prev,
      last_check_at: new Date().toISOString(),
      last_error: error ? String(error).slice(0, MAX_ERROR_CHARS) : null,
      ...(siteLatest ? { site_latest: tagOf(siteLatest) } : {}),
      ...(siteBehind !== undefined ? { site_behind: !!siteBehind } : {}),
    });
  } catch { /* chỉ để báo */ }
}

function recordRollback({ version, by, file = UPDATE_STATUS_FILE }) {
  try {
    const prev = readUpdateStatus(file);
    writeJson(file, { ...prev, rolled_back: [...prev.rolled_back, { version: tagOf(version), by, at: new Date().toISOString() }].slice(-MAX_ROLLBACK_HISTORY) });
  } catch { /* chỉ để báo */ }
}

/**
 * Trình giữ chạy đã tự lùi bản (bản mới sập trước khi tệp chạy kịp kiểm): đưa bản đó vào danh sách bỏ qua, ghi lịch sử, dọn trạng thái chờ.
 * Gọi khi khởi động, trước checkBootAfterUpdate. Trả phiên bản đã bị lùi (null nếu không có).
 */
export function ingestSupervisorRollback({
  rollbackFile = UPDATE_ROLLBACK_FILE, settingsFile = UPDATE_SETTINGS_FILE, statusFile = UPDATE_STATUS_FILE, stateFile = UPDATE_STATE_FILE,
  markerFile = UPDATE_INSTALLED_FILE, pendingFile = UPDATE_PENDING_FILE,
} = {}) {
  let line;
  try { line = fs.readFileSync(rollbackFile, 'utf8').trim().split(/\r?\n/)[0]; } catch { return null; }
  fs.rmSync(rollbackFile, { force: true });
  if (!parseVersion(line)) return null;
  addSkip(line, settingsFile);
  recordRollback({ version: line, by: RollbackBy.SUPERVISOR, file: statusFile });
  for (const f of [stateFile, markerFile, pendingFile]) fs.rmSync(f, { force: true });
  return tagOf(line);
}

/**
 * Gọi ĐẦU TIÊN khi `aivin remote start` khởi động. Đang chạy đúng bản vừa cài mà chưa được xác nhận: đếm lần khởi động; quá
 * MAX_BOOTS_BEFORE_ROLLBACK lần (mỗi lần sập trình giữ chạy mở lại) → trả bản cũ, ghi bản này vào danh sách bỏ qua.
 */
export function checkBootAfterUpdate({
  current = currentCliVersion(), target = process.execPath, maxBoots = MAX_BOOTS_BEFORE_ROLLBACK, platform = process.platform,
  stateFile = UPDATE_STATE_FILE, settingsFile = UPDATE_SETTINGS_FILE, markerFile = UPDATE_INSTALLED_FILE, pendingFile = UPDATE_PENDING_FILE,
  statusFile = UPDATE_STATUS_FILE,
} = {}) {
  const state = readJson(stateFile);
  if (!state || !parseVersion(state.version) || !samePath(state.target, target)) return { action: BootAction.NONE };
  if (compareVersions(state.version, current) !== 0) {
    // Đang chạy bản khác bản vừa cài (người dùng đã lùi / cài đè) — trạng thái chờ hết nghĩa.
    for (const f of [stateFile, pendingFile]) fs.rmSync(f, { force: true });
    return { action: BootAction.NONE };
  }
  // Lần trước dừng gọn (Ctrl+C, chuyển bản, thu hồi…) → không phải sập, không tính.
  const boots = (Number(state.boots) || 0) + (state.clean_exit ? 0 : 1);
  if (boots <= maxBoots || !state.backup || !fs.existsSync(state.backup)) {
    writeJson(stateFile, { ...state, boots, clean_exit: false });
    return { action: BootAction.PENDING, boots };
  }
  restoreBackup({ target, backup: state.backup, platform });
  addSkip(state.version, settingsFile);
  recordRollback({ version: state.version, by: RollbackBy.BINARY, file: statusFile });
  for (const f of [stateFile, markerFile, pendingFile]) fs.rmSync(f, { force: true });
  return { action: BootAction.ROLLED_BACK, version: tagOf(state.version), previous: state.previous ? tagOf(state.previous) : null };
}

/** Daemon dừng gọn khi bản mới còn chờ xác nhận → lần khởi động sau không bị tính là sập. */
export function noteCleanExit({ current = currentCliVersion(), target = process.execPath, stateFile = UPDATE_STATE_FILE } = {}) {
  const state = readJson(stateFile);
  if (!state || !samePath(state.target, target) || compareVersions(state.version, current) !== 0) return;
  try { writeJson(stateFile, { ...state, clean_exit: true }); } catch { /* không ghi được → lần sau tính là sập, chậm lắm là lùi oan một bản */ }
}

/** Bản đang chạy ổn (chạy đủ lâu không sập) → bỏ bản cũ, hết theo dõi khởi động (cả ở trình giữ chạy). */
export function confirmUpdate({ current = currentCliVersion(), target = process.execPath, stateFile = UPDATE_STATE_FILE, pendingFile = UPDATE_PENDING_FILE } = {}) {
  const state = readJson(stateFile);
  if (!state || !samePath(state.target, target) || compareVersions(state.version, current) !== 0) return false;
  if (state.backup && fs.existsSync(state.backup)) {
    try { retire(state.backup); } catch { /* lần sau */ }
  }
  for (const f of [stateFile, pendingFile]) fs.rmSync(f, { force: true });
  return true;
}

/** Tình trạng tự cập nhật gửi máy chủ trong hồ sơ máy (`profile.update`) — máy chủ gom lại để thấy cả đội máy, tự hoãn bản lỗi. */
export function updateProfile({
  enabled = true, current = currentCliVersion(), target = process.execPath, settingsFile = UPDATE_SETTINGS_FILE, statusFile = UPDATE_STATUS_FILE,
  stateFile = UPDATE_STATE_FILE,
} = {}) {
  const settings = loadUpdateSettings(settingsFile);
  const status = readUpdateStatus(statusFile);
  const state = readJson(stateFile);
  const pending = state && samePath(state.target, target) && compareVersions(state.version, current) === 0 ? tagOf(state.version) : null;
  return {
    auto: enabled && settings.auto,
    pending,
    last_check_at: status.last_check_at,
    last_error: status.last_error,
    site_latest: status.site_latest,
    site_behind: status.site_behind,
    rolled_back: status.rolled_back.map((r) => r.version),
  };
}
