import fs from 'fs';
import { createHash } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { trayStrings } from './strings.mjs';

/**
 * "Mở bằng AIVIN Bot" trên Windows (04/11/2026): tệp tài liệu trên máy mở thẳng trong Drive của Aivin. Chỉ ghi HKCU\Software\Classes (không
 * cần admin):
 * - ProgID `Aivin.OpenFile` → `"Aivin.exe" --open "%1"` (Aivin.exe là ứng dụng không console, chuyển cho `aivin open`, traySource.mjs);
 * - mỗi đuôi: OpenWithProgids → Aivin hiện trong "Open with", SystemFileAssociations\.<đuôi>\shell → mục chuột phải;
 * - Capabilities + RegisteredApplications → Aivin có trang riêng trong Settings → Default apps (`aivin desktop defaults` mở thẳng trang đó).
 * Windows 10+ không cho phần mềm tự đặt làm ứng dụng MẶC ĐỊNH (UserChoice có mã băm chống ghi) — người dùng tự chọn "Always" một lần.
 */

export const OPEN_WITH_PROGID = 'Aivin.OpenFile';
const VERB = 'AivinOpen';
const HKCU_SOFTWARE = 'HKCU\\Software';
const CAPABILITIES_PATH = 'AivinLabs\\AIVIN Bot\\Capabilities';
const REGISTERED_APP_NAME = 'AIVIN Office Suite';
const LEGACY_REGISTERED_APP_NAME = 'AIVIN Bot';

/** Đuôi Drive nhận và mở được bằng trình soạn / trình xem (OfficeUploadExtensionHelper.ts phía be). */
export const OPEN_WITH_EXTENSIONS = Object.freeze([
  'docx', 'doc', 'odt', 'rtf',
  'xlsx', 'xls', 'xlsm', 'ods', 'csv',
  'pptx', 'ppt', 'odp',
  'pdf', 'md', 'txt',
]);

const reg = (args) => execFileSync('reg', args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const regDelete = (args) => { try { reg(['delete', ...args, '/f']); } catch { /* chưa có */ } };

export function openCommand(exe) {
  return `"${exe}" --open "%1"`;
}

/**
 * "Gửi cho AIVIN Bot": mục chuột phải trên MỌI tệp (`*`) và thư mục → đính vào ô hỏi của linh vật (mascot/index.mjs, MASCOT_ATTACH_DIR).
 * MultiSelectModel=Player: vẫn hiện khi chọn hơn 15 mục (mặc định Explorer ẩn); Explorer chạy một lần cho mỗi mục, Aivin.exe gom lại.
 */
const SHARE_VERB = 'AivinShare';
const SHARE_TARGETS = Object.freeze(['*', 'Directory']);

export function shareCommand(exe) {
  return `"${exe}" --share "%1"`;
}

/**
 * "Làm việc ở đây với AIVIN Bot": chuột phải vào chỗ trống trong thư mục (`Directory\Background`) hoặc lên chính thư mục → đặt thư mục làm việc
 * của ô hỏi (mascot/ask.mjs). `%V` = thư mục đang mở (nền không có `%1`).
 */
const WORK_HERE_VERB = 'AivinWorkHere';
const WORK_HERE_TARGETS = Object.freeze(['Directory\\Background', 'Directory']);

export function workHereCommand(exe) {
  return `"${exe}" --workdir "%V"`;
}

/** Đuôi nên đề xuất làm mặc định: lưu lại không mất định dạng. Office để người dùng / IT tự chọn thêm (bản xuất dựng từ HTML). */
export const SAFE_DEFAULT_EXTENSIONS = Object.freeze(['md', 'txt', 'csv']);

export const DEFAULT_APPS_URI = `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(REGISTERED_APP_NAME)}`;

/**
 * Danh sách lệnh `reg add` — tách riêng để kiểm thử. `root` đổi được để thử trên khoá riêng (mặc định HKCU\Software);
 * giá trị RegisteredApplications là đường dẫn tương đối theo HKCU, Windows đọc đúng chỗ này.
 */
export function associationRegCommands({ exe, lang = 'en', extensions = OPEN_WITH_EXTENSIONS, root = HKCU_SOFTWARE }) {
  const s = trayStrings(lang);
  const CLASSES = `${root}\\Classes`;
  const capabilities = `${root}\\${CAPABILITIES_PATH}`;
  const progId = `${CLASSES}\\${OPEN_WITH_PROGID}`;
  const cmds = [
    ['add', progId, '/ve', '/d', s.fileType, '/f'],
    ['add', progId, '/v', 'FriendlyTypeName', '/d', s.fileType, '/f'],
    ['add', `${progId}\\DefaultIcon`, '/ve', '/d', `"${exe}",0`, '/f'],
    ['add', `${progId}\\shell\\open`, '/v', 'FriendlyAppName', '/d', s.openWith, '/f'],
    ['add', `${progId}\\shell\\open\\command`, '/ve', '/d', openCommand(exe), '/f'],
    ['add', capabilities, '/v', 'ApplicationName', '/d', REGISTERED_APP_NAME, '/f'],
    ['add', capabilities, '/v', 'ApplicationDescription', '/d', s.shortcut, '/f'],
    ['add', `${root}\\RegisteredApplications`, '/v', REGISTERED_APP_NAME, '/d', `Software\\${CAPABILITIES_PATH}`, '/f'],
  ];
  for (const ext of extensions) {
    const verb = `${CLASSES}\\SystemFileAssociations\\.${ext}\\shell\\${VERB}`;
    cmds.push(
      ['add', `${CLASSES}\\.${ext}\\OpenWithProgids`, '/v', OPEN_WITH_PROGID, '/t', 'REG_NONE', '/f'],
      ['add', verb, '/ve', '/d', s.openWith, '/f'],
      ['add', verb, '/v', 'Icon', '/d', `"${exe}",0`, '/f'],
      ['add', `${verb}\\command`, '/ve', '/d', openCommand(exe), '/f'],
      ['add', `${capabilities}\\FileAssociations`, '/v', `.${ext}`, '/d', OPEN_WITH_PROGID, '/f'],
    );
  }
  for (const target of SHARE_TARGETS) {
    const verb = `${CLASSES}\\${target}\\shell\\${SHARE_VERB}`;
    cmds.push(
      ['add', verb, '/v', 'MUIVerb', '/d', s.share, '/f'],
      ['add', verb, '/v', 'Icon', '/d', `"${exe}",0`, '/f'],
      ['add', verb, '/v', 'MultiSelectModel', '/d', 'Player', '/f'],
      ['add', `${verb}\\command`, '/ve', '/d', shareCommand(exe), '/f'],
    );
  }
  for (const target of WORK_HERE_TARGETS) {
    const verb = `${CLASSES}\\${target}\\shell\\${WORK_HERE_VERB}`;
    cmds.push(
      ['add', verb, '/v', 'MUIVerb', '/d', s.workHere, '/f'],
      ['add', verb, '/v', 'Icon', '/d', `"${exe}",0`, '/f'],
      ['add', `${verb}\\command`, '/ve', '/d', workHereCommand(exe), '/f'],
    );
  }
  return cmds;
}

/** Mục trong Programs & Features / Settings → Apps: chỉ HKCU, không cần admin. Gỡ = `Aivin.exe --uninstall` (hỏi chủ máy rồi gọi `aivin uninstall`). */
export const UNINSTALL_ENTRY = 'AivinBot';

export function uninstallEntryCommands({ exe, version = '', location = '', root = HKCU_SOFTWARE }) {
  const key = `${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_ENTRY}`;
  return [
    ['add', key, '/v', 'DisplayName', '/d', REGISTERED_APP_NAME, '/f'],
    ['add', key, '/v', 'Publisher', '/d', 'Aivin Labs', '/f'],
    ['add', key, '/v', 'DisplayVersion', '/d', version, '/f'],
    ['add', key, '/v', 'DisplayIcon', '/d', `"${exe}",0`, '/f'],
    ['add', key, '/v', 'InstallLocation', '/d', location, '/f'],
    ['add', key, '/v', 'UninstallString', '/d', `"${exe}" --uninstall`, '/f'],
    ['add', key, '/v', 'NoModify', '/t', 'REG_DWORD', '/d', '1', '/f'],
    ['add', key, '/v', 'NoRepair', '/t', 'REG_DWORD', '/d', '1', '/f'],
  ];
}

export function registerUninstallEntry(options) {
  if (process.platform !== 'win32') return;
  for (const args of uninstallEntryCommands(options)) reg(args);
}

/** Ghi lại khi phiên bản / chỗ Aivin.exe đổi, hoặc mục bị xoá. Trả true khi vừa ghi. */
export function ensureUninstallEntry({ stampFile, root = HKCU_SOFTWARE, ...options }) {
  if (process.platform !== 'win32') return false;
  const stamp = createHash('sha256').update(JSON.stringify(uninstallEntryCommands({ ...options, root }))).digest('hex');
  let saved = null;
  try { saved = fs.readFileSync(stampFile, 'utf8').trim(); } catch { /* chưa ghi lần nào */ }
  let present = true;
  try { reg(['query', `${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_ENTRY}`, '/v', 'UninstallString']); } catch { present = false; }
  if (saved === stamp && present) return false;
  for (const args of uninstallEntryCommands({ ...options, root })) reg(args);
  fs.writeFileSync(stampFile, stamp);
  return true;
}

export function unregisterUninstallEntry({ root = HKCU_SOFTWARE } = {}) {
  if (process.platform !== 'win32') return;
  regDelete([`${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_ENTRY}`]);
}

/** Dấu của bộ khoá đang ghi — đổi (thêm đuôi / mục mới, đổi ngôn ngữ, đổi chỗ Aivin.exe) thì daemon ghi lại (ensureFileAssociations). */
export function associationStamp({ exe, lang = 'en', extensions = OPEN_WITH_EXTENSIONS }) {
  return createHash('sha256').update(JSON.stringify(associationRegCommands({ exe, lang, extensions }))).digest('hex');
}

export function registerFileAssociations({ exe, lang = 'en', extensions = OPEN_WITH_EXTENSIONS } = {}) {
  if (process.platform !== 'win32') return { registered: false };
  for (const args of associationRegCommands({ exe, lang, extensions })) reg(args);
  regDelete([`${HKCU_SOFTWARE}\\RegisteredApplications`, '/v', LEGACY_REGISTERED_APP_NAME]);
  return { registered: true, extensions: [...extensions] };
}

/**
 * Máy cài Aivin trước khi có mục chuột phải (hoặc trước khi thêm mục mới) và chỉ tự cập nhật — không ai chạy lại `aivin desktop install`:
 * daemon gọi hàm này lúc khởi động, ghi lại khi dấu khác hoặc khoá bị xoá. Trả true khi vừa ghi.
 */
export function ensureFileAssociations({ exe, lang = 'en', stampFile }) {
  if (process.platform !== 'win32') return false;
  const stamp = associationStamp({ exe, lang });
  let saved = null;
  try { saved = fs.readFileSync(stampFile, 'utf8').trim(); } catch { /* chưa ghi lần nào */ }
  if (saved === stamp && fileAssociationsRegistered()) return false;
  registerFileAssociations({ exe, lang });
  fs.writeFileSync(stampFile, stamp);
  return true;
}

export function unregisterFileAssociations({ extensions = OPEN_WITH_EXTENSIONS, root = HKCU_SOFTWARE } = {}) {
  if (process.platform !== 'win32') return;
  const CLASSES = `${root}\\Classes`;
  regDelete([`${root}\\RegisteredApplications`, '/v', REGISTERED_APP_NAME]);
  regDelete([`${root}\\RegisteredApplications`, '/v', LEGACY_REGISTERED_APP_NAME]);
  regDelete([`${root}\\AivinLabs`]);
  for (const ext of extensions) {
    regDelete([`${CLASSES}\\.${ext}\\OpenWithProgids`, '/v', OPEN_WITH_PROGID]);
    regDelete([`${CLASSES}\\SystemFileAssociations\\.${ext}\\shell\\${VERB}`]);
  }
  for (const target of SHARE_TARGETS) regDelete([`${CLASSES}\\${target}\\shell\\${SHARE_VERB}`]);
  for (const target of WORK_HERE_TARGETS) regDelete([`${CLASSES}\\${target}\\shell\\${WORK_HERE_VERB}`]);
  regDelete([`${CLASSES}\\${OPEN_WITH_PROGID}`]);
}

export function fileAssociationsRegistered() {
  if (process.platform !== 'win32') return false;
  try {
    reg(['query', `${HKCU_SOFTWARE}\\Classes\\${OPEN_WITH_PROGID}\\shell\\open\\command`, '/ve']);
    return true;
  } catch {
    return false;
  }
}

/** Mở trang Default apps của Aivin (Windows cũ không biết tham số thì mở trang Default apps chung). */
export function openDefaultAppsSettings() {
  spawn('explorer.exe', [DEFAULT_APPS_URI], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref();
}

/** Tệp cho IT đẩy mặc định toàn công ty: Group Policy "Set a default associations configuration file" / Intune / DISM. */
export function defaultAssociationsXml(extensions = SAFE_DEFAULT_EXTENSIONS) {
  const lines = extensions.map((ext) => `  <Association Identifier=".${ext}" ProgId="${OPEN_WITH_PROGID}" ApplicationName="${REGISTERED_APP_NAME}" />`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<DefaultAssociations>', ...lines, '</DefaultAssociations>', ''].join('\r\n');
}
