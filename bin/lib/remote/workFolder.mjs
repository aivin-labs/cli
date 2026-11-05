import fs from 'fs';
import path from 'path';
import { lockHolder } from './daemonLock.mjs';
import { loadDeviceCredentials, saveDeviceCredentials } from './credentials.mjs';
import { isNetworkPath, resolveInRoots } from './sandbox.mjs';
import { DeviceErrorCode } from './constants.mjs';
import { MASCOT_ATTACH_DIR, MASCOT_SETTINGS_FILE, loadMascotSettings, saveMascotSettings } from './mascot/index.mjs';

/**
 * Thư mục làm việc của ô hỏi (05/11/2026, "Làm việc ở đây với AIVIN Bot"). Yêu cầu tới từ một tệp trong thư mục cấu hình nên không đủ để mở
 * quyền: thư mục nằm ngoài các thư mục được phép thì phải có người bấm đồng ý trên máy, kể cả khi yêu cầu do agent tự ghi qua lệnh shell.
 * Thư mục đã đồng ý nằm ở `extra_roots` của device-credentials.json — `--dir` trong launch.cfg không ghi đè, `aivin remote forget-folder` thu lại.
 */

export const WorkFolderStatus = Object.freeze({ OK: 'ok', NEEDS_ROOT: 'needs_root', DENIED: 'denied' });
export const WORK_FOLDER_CONFIRM_SEC = 120;

const CONFIRM_TEXT = Object.freeze({
  vi: {
    reason: 'Thư mục này nằm ngoài các thư mục Aivin được phép. Chỉ đồng ý nếu chính bạn vừa chọn nó.',
    detail: 'Cho Aivin đọc, ghi và chạy lệnh trong thư mục: {path}',
  },
  en: {
    reason: 'This folder is outside the folders Aivin may use. Only allow it if you just picked it yourself.',
    detail: 'Let Aivin read, write and run commands in this folder: {path}',
  },
});

export function workFolderConfirmText(folder, lang = 'en') {
  const text = CONFIRM_TEXT[lang] || CONFIRM_TEXT.en;
  return { reason: text.reason, detail: text.detail.replace('{path}', folder) };
}

/** Danh sách thư mục khi chạy: thư mục gốc + các thư mục chủ máy đã đồng ý thêm, không trùng. */
export function withExtraRoots(base, extra) {
  const list = [...base];
  for (const dir of Array.isArray(extra) ? extra : []) {
    if (typeof dir !== 'string' || !dir) continue;
    if (!list.some((r) => path.resolve(r) === path.resolve(dir))) list.push(path.resolve(dir));
  }
  return list;
}

const isFolder = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

/** Thư mục còn tồn tại, trong quyền và không phải vùng cấm. */
export function isAllowedWorkFolder(dir, roots) {
  if (!isFolder(dir)) return false;
  try { resolveInRoots(roots, dir); return true; } catch { return false; }
}

/**
 * `confirm(path)` → có đồng ý mở thêm không; chỉ hỏi khi lý do từ chối đúng là "ngoài quyền". Ổ mạng và thư mục chứa khoá của Aivin thì đồng ý
 * cũng không dùng được (resolveInRoots chặn cứng), nên từ chối luôn. Trả `{ status, path }`; NEEDS_ROOT = đã đồng ý, nơi gọi thêm vào danh sách.
 */
export async function resolveWorkFolder(dir, { roots, confirm }) {
  const abs = path.resolve(String(dir));
  if (isNetworkPath(String(dir)) || !isFolder(abs)) return { status: WorkFolderStatus.DENIED, path: abs };
  try {
    resolveInRoots(roots, abs);
    return { status: WorkFolderStatus.OK, path: abs };
  } catch (e) {
    if (e?.code !== DeviceErrorCode.ROOT_DENIED) return { status: WorkFolderStatus.DENIED, path: abs };
  }
  try { resolveInRoots([abs], abs); } catch { return { status: WorkFolderStatus.DENIED, path: abs }; }
  return { status: (await confirm(abs)) ? WorkFolderStatus.NEEDS_ROOT : WorkFolderStatus.DENIED, path: abs };
}

/**
 * `aivin desktop uninstall`: bỏ hết những gì các mục chuột phải để lại — yêu cầu còn chờ, thư mục làm việc đã lưu, quyền thư mục đã đồng ý. Thư mục
 * cấu hình giữ nguyên (lệnh `aivin` và việc ghép máy vẫn còn), nên không dọn thì cài lại là quyền cũ tự có hiệu lực mà không ai hỏi lại.
 */
export function clearWorkFolderState({ attachDir = MASCOT_ATTACH_DIR, settingsFile = MASCOT_SETTINGS_FILE } = {}) {
  fs.rmSync(attachDir, { recursive: true, force: true });
  if (loadMascotSettings(settingsFile).work_dir) {
    try { saveMascotSettings({ work_dir: null }, settingsFile); } catch { /* mascot.json hỏng: lần khởi động vẫn kiểm lại quyền trước khi khôi phục */ }
  }
  const creds = loadDeviceCredentials();
  if (!creds?.extra_roots) return;
  const granted = creds.extra_roots.map((p) => path.resolve(p));
  delete creds.extra_roots;
  creds.roots = (creds.roots || []).filter((p) => !granted.includes(path.resolve(p)));
  saveDeviceCredentials(creds);
  const running = lockHolder();
  if (running) try { process.kill(running); } catch { /* vừa tự thoát */ }
}

/** `aivin remote forget-folder`: thu lại thư mục đã đồng ý, dừng daemon để khay mở lại với danh sách mới. Trả `{ removed, stopped }`. */
export function forgetWorkFolder(dir) {
  const creds = loadDeviceCredentials();
  const abs = path.resolve(String(dir));
  const same = (p) => path.resolve(p) === abs;
  if (!creds?.extra_roots?.some(same)) return { removed: false, stopped: null };
  creds.extra_roots = creds.extra_roots.filter((p) => !same(p));
  creds.roots = (creds.roots || []).filter((p) => !same(p));
  saveDeviceCredentials(creds);
  const stopped = lockHolder();
  if (stopped) try { process.kill(stopped); } catch { /* vừa tự thoát */ }
  return { removed: true, stopped };
}
