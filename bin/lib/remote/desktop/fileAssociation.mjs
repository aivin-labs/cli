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
const REGISTERED_APP_NAME = 'AIVIN Bot';

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
  return cmds;
}

export function registerFileAssociations({ exe, lang = 'en', extensions = OPEN_WITH_EXTENSIONS } = {}) {
  if (process.platform !== 'win32') return { registered: false };
  for (const args of associationRegCommands({ exe, lang, extensions })) reg(args);
  return { registered: true, extensions: [...extensions] };
}

export function unregisterFileAssociations({ extensions = OPEN_WITH_EXTENSIONS, root = HKCU_SOFTWARE } = {}) {
  if (process.platform !== 'win32') return;
  const CLASSES = `${root}\\Classes`;
  regDelete([`${root}\\RegisteredApplications`, '/v', REGISTERED_APP_NAME]);
  regDelete([`${root}\\AivinLabs`]);
  for (const ext of extensions) {
    regDelete([`${CLASSES}\\.${ext}\\OpenWithProgids`, '/v', OPEN_WITH_PROGID]);
    regDelete([`${CLASSES}\\SystemFileAssociations\\.${ext}\\shell\\${VERB}`]);
  }
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
