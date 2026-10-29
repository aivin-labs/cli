import fs from 'fs';
import os from 'os';
import path from 'path';
import { RELEASE_PUBLIC_KEYS } from './releaseKeys.mjs';
import {
  UPDATE_INSTALLED_FILE, UPDATE_LOCK_FILE, UPDATE_PENDING_FILE, UPDATE_SETTINGS_FILE, UPDATE_STATE_FILE, UpdateStatus,
} from './update/constants.mjs';
import { replaceBinary } from './update/binarySwap.mjs';
import { downloadRelease, downloadRoot, fetchLatestVersion, fetchRollout, verifyStarts } from './update/download.mjs';
import { loadUpdateSettings, recordInstalled, withUpdateLock } from './update/state.mjs';
import { compareVersions, currentCliVersion, isStandaloneBinary, parseVersion, releaseAsset, rolloutBucket, tagOf, versionList } from './update/versions.mjs';

/**
 * Tự cập nhật CLI (29/10/2026) — chỉ bản tệp chạy đóng gói (bộ cài install.ps1 / install.sh); bản npm cập nhật bằng npm. Tệp này điều phối
 * một lần cập nhật + gom lại API của `update/` (giữ nguyên chỗ import cũ):
 * - `update/versions.mjs`   phiên bản, tên bản build, đợt phát hành
 * - `update/signature.mjs`  chữ ký Ed25519 của bản phát hành (khoá công khai trong releaseKeys.mjs)
 * - `update/download.mjs`   nguồn tải (chỉ https, chỉ từ biến môi trường), tải stream có trần, chạy thử
 * - `update/binarySwap.mjs` thay / trả tệp chạy, giữ `.prev`
 * - `update/state.mjs`      cài đặt, khoá, bản chờ xác nhận, tự lùi bản, tình trạng gửi máy chủ
 * Mô hình đe doạ: docs/official/device-agent/cli-self-update.md (repo be) mục 4.3.
 */

export * from './update/constants.mjs';
export * from './update/versions.mjs';
export * from './update/signature.mjs';
export * from './update/download.mjs';
export * from './update/binarySwap.mjs';
export * from './update/state.mjs';

/**
 * Kiểm + cài bản mới nhất (hoặc `version` chỉ định — được lùi bản, bỏ qua danh sách bỏ qua, bản bị hoãn và đợt phát hành). `check` = chỉ báo
 * có bản mới. `deviceId` (daemon) → tôn trọng `rollout.json` trừ khi `urgent` (máy chủ đòi bản tối thiểu). `holdVersions` (máy chủ báo, chỉ
 * hoãn được, không cài được) → không cài các bản đó. Trả `{ status, current, latest }`. `binary` / `target` / `verify` / `keys` / các tệp: cho test.
 */
export async function installUpdate({
  version, root = downloadRoot(), check = false, force = false, urgent = false, deviceId, holdVersions = [], signal,
  binary = isStandaloneBinary(), target = process.execPath, current = currentCliVersion(), verify = verifyStarts, keys = RELEASE_PUBLIC_KEYS,
  markerFile = UPDATE_INSTALLED_FILE, stateFile = UPDATE_STATE_FILE, lockFile = UPDATE_LOCK_FILE, settingsFile = UPDATE_SETTINGS_FILE,
  pendingFile = UPDATE_PENDING_FILE,
} = {}) {
  const latest = version ? tagOf(version) : await fetchLatestVersion({ root, signal });
  if (!parseVersion(latest)) throw new Error(`Phiên bản không hợp lệ: ${version}`);
  const result = { current: tagOf(current), latest };
  if (!force && compareVersions(latest, current) <= 0) return { ...result, status: UpdateStatus.UP_TO_DATE };
  if (!binary) return { ...result, status: UpdateStatus.NOT_BINARY };
  if (!version && loadUpdateSettings(settingsFile).skip.includes(latest)) return { ...result, status: UpdateStatus.SKIPPED };
  if (!version && versionList(holdVersions).includes(latest)) return { ...result, status: UpdateStatus.HELD };
  if (check) return { ...result, status: UpdateStatus.AVAILABLE };
  if (deviceId && !urgent && !version) {
    const rollout = await fetchRollout({ root, signal });
    if (rollout && rollout.version === latest && rolloutBucket(deviceId, latest) >= rollout.percent) return { ...result, status: UpdateStatus.DEFERRED };
  }
  return withUpdateLock(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-update-'));
    try {
      const file = await downloadRelease({ root, version: latest, asset: releaseAsset(), destDir: tmp, signal, keys });
      await verify(file, latest);
      let backup;
      try {
        backup = replaceBinary({ newFile: file, target });
      } catch (e) {
        throw new Error(`Không thay được ${target} (${e?.code || e?.message}) — cài lại bằng bộ cài: https://get.aivin.vn`, { cause: e });
      }
      recordInstalled({ version: latest, current, target, backup, stateFile, markerFile, pendingFile });
      return { ...result, status: UpdateStatus.INSTALLED };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, lockFile);
}
