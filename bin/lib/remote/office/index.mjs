import path from 'path';
import { spawnSync } from 'child_process';
import { DeviceErrorCode, ToolGroup } from '../constants.mjs';
import { DeviceToolError, resolveInRoots } from '../sandbox.mjs';

/**
 * Đầu nối Office (28/10/2026): máy Windows có Excel / Word / Outlook thì tự bật công cụ `office.*` — người dùng không cài, không cấu hình
 * gì. Làm việc qua API của ứng dụng (COM, trong tiến trình host của gui/) thay vì bấm giao diện: nhanh, chính xác, chạy nền (tệp chưa mở thì
 * mở bằng bản Excel / Word ẩn). Đường dẫn tệp và tệp đính kèm luôn trong vùng được phép của máy.
 */

const PROG_IDS = { excel: 'Excel.Application', word: 'Word.Application', outlook: 'Outlook.Application' };
const EXCEL_EXT = /\.(xlsx|xlsm|xlsb|xls|csv)$/i;
const WORD_EXT = /\.(docx|docm|doc|rtf)$/i;
const MAX_ATTACHMENTS = 10;

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

/** Ứng dụng Office có trên máy (ProgID COM đăng ký trong registry). Không phải Windows / máy tính tổ chức → không có. */
export function detectOfficeApps({ multiUser = false, platform = process.platform, query = regHasKey } = {}) {
  if (multiUser || platform !== 'win32') return [];
  return Object.entries(PROG_IDS).filter(([, progId]) => query(`HKCR\\${progId}\\CLSID`)).map(([app]) => app);
}

function regHasKey(key) {
  try { return spawnSync('reg', ['query', key], { windowsHide: true, timeout: 5000 }).status === 0; } catch { return false; }
}

function officePath(env, value, ext, kind) {
  if (!value) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Missing argument: path');
  const abs = resolveInRoots(env.roots, String(value));
  if (!ext.test(abs)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Not a ${kind} file: ${path.basename(abs)}`);
  return abs;
}

function attachments(env, list) {
  const files = Array.isArray(list) ? list.slice(0, MAX_ATTACHMENTS + 1) : [];
  if (files.length > MAX_ATTACHMENTS) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `At most ${MAX_ATTACHMENTS} attachments`);
  return files.map((f) => resolveInRoots(env.roots, String(f)));
}

/** Công cụ Office cho danh mục của Planner — chỉ các ứng dụng máy có. */
export function buildOfficeTools(host, apps) {
  const call = (op, args, ctx) => host.call('office', { ...args, op }, ctx);
  const tools = [];
  if (apps.includes('excel')) {
    tools.push(
      { name: 'office.excel.read', group: ToolGroup.OFFICE, read_only: true,
        handler: async (a, c, e) => call('excel.read', { path: officePath(e, a.path, EXCEL_EXT, 'Excel'), sheet: a.sheet, range: a.range, formulas: !!a.formulas }, c),
        description: 'Read cells of an Excel workbook through Excel itself (exact values, every sheet name; works on a workbook the user has open). Default: the used range of the active sheet.',
        input_schema: schema({ path: str('workbook path'), sheet: str('sheet name, default the active sheet'), range: str('e.g. "A1:D20", default the used range'), formulas: bool('also return formulas') }, ['path']) },
      { name: 'office.excel.write', group: ToolGroup.OFFICE,
        handler: async (a, c, e) => call('excel.write', { path: officePath(e, a.path, EXCEL_EXT, 'Excel'), sheet: a.sheet, cells: a.cells, range: a.range, values: a.values, create: !!a.create, save: a.save !== false }, c),
        description: 'Write cells through Excel: cells {"B2": value or "=formula"} and/or range (top-left cell) + values (rows). Keeps formatting and recalculates formulas; saves by default. Returns the displayed text of written cells. A workbook the user has open is edited in place.',
        input_schema: schema({ path: str('workbook path'), sheet: str('sheet name'), cells: { type: 'object', description: '{"A1": value, "C3": "=SUM(A1:A2)"}' }, range: str('top-left cell for values, e.g. "A2"'), values: { type: 'array', description: 'rows of values', items: { type: 'array' } }, create: bool('create the workbook if missing'), save: bool('save after writing (default true)') }, ['path']) },
    );
  }
  if (apps.includes('word')) {
    tools.push(
      { name: 'office.word.read', group: ToolGroup.OFFICE, read_only: true,
        handler: async (a, c, e) => call('word.read', { path: officePath(e, a.path, WORD_EXT, 'Word'), max_chars: a.max_chars }, c),
        description: 'Read the full text of a Word document through Word (also .doc/.rtf; works on a document the user has open).',
        input_schema: schema({ path: str('document path'), max_chars: num('default 20000') }, ['path']) },
      { name: 'office.word.edit', group: ToolGroup.OFFICE,
        handler: async (a, c, e) => call('word.edit', { path: officePath(e, a.path, WORD_EXT, 'Word'), find: a.find, replace: a.replace, append: a.append, create: !!a.create, save: a.save !== false }, c),
        description: 'Edit a Word document through Word, keeping its formatting: replace every occurrence of find with replace, and/or append a paragraph at the end. Saves by default; returns how many were replaced.',
        input_schema: schema({ path: str('document path'), find: str('exact text to replace'), replace: str('replacement text'), append: str('paragraph to add at the end'), create: bool('create the document if missing'), save: bool('default true') }, ['path']) },
    );
  }
  if (apps.includes('outlook')) {
    tools.push(
      { name: 'office.outlook.list', group: ToolGroup.OFFICE, read_only: true,
        handler: async (a, c) => call('outlook.list', { folder: a.folder, limit: a.limit, unread_only: !!a.unread_only, preview_chars: a.preview_chars }, c),
        description: "Newest emails in the user's Outlook (inbox or sent): subject, sender, time, unread, start of the body.",
        input_schema: schema({ folder: str('inbox | sent (default inbox)'), limit: num('default 20, max 100'), unread_only: bool('only unread'), preview_chars: num('body preview length, default 300') }) },
      { name: 'office.outlook.draft', group: ToolGroup.OFFICE,
        handler: async (a, c, e) => call('outlook.compose', { to: a.to, cc: a.cc, subject: a.subject, body: a.body, attachments: attachments(e, a.attachments), send: false }, c),
        description: "Create an email in Outlook's Drafts (not sent) with optional attachments from this computer.",
        input_schema: schema({ to: str('recipients, ; separated'), cc: str('cc'), subject: str('subject'), body: str('plain text body'), attachments: { type: 'array', items: { type: 'string' }, description: 'file paths' } }, ['to', 'subject']) },
      { name: 'office.outlook.send', group: ToolGroup.OFFICE,
        handler: async (a, c, e) => call('outlook.compose', { to: a.to, cc: a.cc, subject: a.subject, body: a.body, attachments: attachments(e, a.attachments), send: true }, c),
        description: 'Send an email from the user\'s Outlook now. Use only when the user asked to send; otherwise office.outlook.draft.',
        input_schema: schema({ to: str('recipients, ; separated'), cc: str('cc'), subject: str('subject'), body: str('plain text body'), attachments: { type: 'array', items: { type: 'string' }, description: 'file paths' } }, ['to', 'subject']) },
    );
  }
  return tools;
}
