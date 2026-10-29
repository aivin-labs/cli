import path from 'path';
import { ToolGroup } from '../constants.mjs';
import { MascotVerb, mascotVerb } from './strings.mjs';

/**
 * Nhãn cho từng bước hiện trên linh vật: `title` (bong bóng — "log chính") = mục đích Planner ghi cho bước có thay đổi, bước chỉ đọc không
 * có mục đích → động từ theo công cụ + đích chính ("Đọc baocao.xlsx"); `detail` (bảng nhật ký) = tên công cụ + tham số rút gọn, không chép
 * nội dung ghi tệp (chỉ ghi độ dài).
 */

const TITLE_MAX = 140;
const DETAIL_MAX = 180;
const TARGET_MAX = 60;

/** Tên công cụ đúng → động từ; rồi tiền tố (kết thúc '.'); rồi nhóm công cụ. */
const VERB_BY_NAME = {
  'fs.read': MascotVerb.READ, 'fs.read_many': MascotVerb.READ, 'fs.read_lines': MascotVerb.READ, 'fs.preview': MascotVerb.READ,
  'fs.info': MascotVerb.READ, 'fs.stat': MascotVerb.READ,
  'fs.list': MascotVerb.LIST, 'fs.tree': MascotVerb.LIST,
  'fs.find': MascotVerb.FIND, 'fs.grep': MascotVerb.FIND, 'fs.search': MascotVerb.FIND,
  'fs.move': MascotVerb.MOVE, 'fs.move_many': MascotVerb.MOVE, 'fs.rename': MascotVerb.MOVE,
  'fs.copy': MascotVerb.COPY, 'fs.delete': MascotVerb.DELETE, 'fs.delete_many': MascotVerb.DELETE,
  'fs.undo': MascotVerb.UNDO, 'fs.history': MascotVerb.UNDO, 'fs.measure': MascotVerb.MEASURE,
  'fs.upload': MascotVerb.TRANSFER, 'fs.download': MascotVerb.TRANSFER, 'sys.schedule': MascotVerb.SCHEDULE, 'sys.schedules': MascotVerb.SCHEDULE,
};
const VERB_BY_PREFIX = [
  ['office.excel.', MascotVerb.EXCEL], ['office.word.', MascotVerb.WORD], ['office.outlook.', MascotVerb.OUTLOOK],
  ['shell.', MascotVerb.EXEC], ['proc.', MascotVerb.PROC], ['git.', MascotVerb.GIT], ['sys.', MascotVerb.SYSTEM], ['system.', MascotVerb.SYSTEM],
  ['gui.', MascotVerb.GUI], ['browser.', MascotVerb.BROWSER], ['memory.', MascotVerb.MEMORY], ['context.', MascotVerb.MEMORY],
  ['watch.', MascotVerb.WATCH], ['fs.', MascotVerb.WRITE],
];
const VERB_BY_GROUP = {
  [ToolGroup.FS_READ]: MascotVerb.READ, [ToolGroup.FS_WRITE]: MascotVerb.WRITE, [ToolGroup.EXEC]: MascotVerb.EXEC, [ToolGroup.PROC]: MascotVerb.PROC,
  [ToolGroup.GIT]: MascotVerb.GIT, [ToolGroup.SYSTEM]: MascotVerb.SYSTEM, [ToolGroup.GUI]: MascotVerb.GUI, [ToolGroup.BROWSER]: MascotVerb.BROWSER,
  [ToolGroup.MEMORY]: MascotVerb.MEMORY,
};

/** Tham số mang nội dung (không hiện, chỉ ghi độ dài). */
const CONTENT_KEYS = new Set(['content', 'data', 'text', 'body', 'input', 'value', 'values', 'html', 'chunk']);

export function verbFor(toolName, group) {
  if (VERB_BY_NAME[toolName]) return VERB_BY_NAME[toolName];
  for (const [prefix, verb] of VERB_BY_PREFIX) if (toolName.startsWith(prefix)) return group === ToolGroup.FS_READ && verb === MascotVerb.WRITE ? MascotVerb.READ : verb;
  return VERB_BY_GROUP[group] || MascotVerb.OTHER;
}

const clip = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Đích chính của bước: tên tệp / thư mục (không cả đường dẫn), lệnh, từ khoá tìm, ứng dụng. */
export function targetOf(args = {}) {
  const file = args.path || args.file || args.src || args.from || args.source || (Array.isArray(args.paths) ? args.paths[0] : undefined) || args.dir || args.cwd;
  if (typeof file === 'string' && file) return clip(path.basename(file.replace(/[\\/]+$/, '')) || file, TARGET_MAX);
  const cmd = args.command || args.cmd;
  if (typeof cmd === 'string' && cmd) return clip(cmd, TARGET_MAX);
  const q = args.query || args.pattern || args.name;
  if (typeof q === 'string' && q) return `"${clip(q, TARGET_MAX - 2)}"`;
  const app = args.app || args.window || args.title;
  return typeof app === 'string' ? clip(app, TARGET_MAX) : '';
}

/** Tham số rút gọn cho bảng nhật ký: nội dung dài → độ dài. */
export function argsPreview(args = {}) {
  const shown = Object.fromEntries(Object.entries(args || {}).map(([k, v]) => {
    if (CONTENT_KEYS.has(k) && typeof v === 'string') return [k, `‹${v.length}›`];
    if (CONTENT_KEYS.has(k) && v && typeof v === 'object') return [k, '‹…›'];
    return [k, v];
  }));
  let json;
  try { json = JSON.stringify(shown); } catch { json = ''; }
  return clip(json === '{}' ? '' : json, DETAIL_MAX);
}

export function describeStep({ call, tool, lang }) {
  const name = String(call?.tool || tool?.name || '');
  const purpose = typeof call?.purpose === 'string' ? clip(call.purpose, TITLE_MAX) : '';
  const target = targetOf(call?.args);
  const title = purpose || clip(`${mascotVerb(lang, verbFor(name, tool?.group))}${target ? ` ${target}` : ''}`, TITLE_MAX);
  const preview = argsPreview(call?.args);
  return { title, detail: clip(`${name}${preview ? ` ${preview}` : ''}`, DETAIL_MAX) };
}
