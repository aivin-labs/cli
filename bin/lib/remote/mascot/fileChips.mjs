/**
 * Chip tệp đính kèm trong ô hỏi của linh vật: tệp / thư mục thả vào bot hiện thành chip (icon + màu theo loại tệp, nút × để bỏ) phía trên
 * dòng nhập — không phải một dòng chat. Daemon phân loại (cửa sổ chỉ vẽ): `fileChip(path)` → `{ path, name, kind, icon_path, ink, bg }`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { lucidePath } from './lucideIcons.mjs';

/** Loại tệp → icon Lucide + màu chữ / icon (`ink`) + nền chip rất nhạt cùng tông (`bg`, viền mảnh cùng tông do cửa sổ vẽ). */
export const FILE_KINDS = Object.freeze({
  folder: { icon: 'folder', ink: '#B45309', bg: '#FFFBEB' },
  image: { icon: 'file-image', ink: '#C026D3', bg: '#FDF4FF' },
  pdf: { icon: 'file-text', ink: '#DC2626', bg: '#FEF2F2' },
  doc: { icon: 'file-text', ink: '#2563EB', bg: '#EFF6FF' },
  sheet: { icon: 'file-spreadsheet', ink: '#059669', bg: '#ECFDF5' },
  slides: { icon: 'presentation', ink: '#EA580C', bg: '#FFF7ED' },
  video: { icon: 'file-video', ink: '#7C3AED', bg: '#F5F3FF' },
  audio: { icon: 'file-audio', ink: '#DB2777', bg: '#FDF2F8' },
  archive: { icon: 'file-archive', ink: '#92400E', bg: '#FBF6F0' },
  code: { icon: 'file-code', ink: '#4F46E5', bg: '#EEF2FF' },
  data: { icon: 'file-json', ink: '#0D9488', bg: '#F0FDFA' },
  text: { icon: 'file-text', ink: '#475569', bg: '#F8FAFC' },
  file: { icon: 'file', ink: '#64748B', bg: '#F8FAFC' },
});

const EXT_KINDS = Object.freeze({
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff', 'avif', 'psd', 'raw'],
  pdf: ['pdf'],
  doc: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf', 'pages'],
  sheet: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'ods', 'csv', 'tsv', 'numbers'],
  slides: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'odp', 'key'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', '3gp', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'oga', 'aac', 'wma', 'opus', 'amr'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'cab'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'dart',
    'html', 'htm', 'css', 'scss', 'vue', 'svelte', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'lua', 'r'],
  data: ['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'db', 'sqlite', 'parquet'],
  text: ['txt', 'md', 'markdown', 'log', 'rst', 'nfo'],
});
const KIND_OF_EXT = new Map(Object.entries(EXT_KINDS).flatMap(([kind, exts]) => exts.map((e) => [e, kind])));

const isDir = (p) => {
  if (/[\\/]$/.test(p)) return true;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

/** Tên hiện trên chip: tên tệp / thư mục (bỏ dấu gạch cuối); ổ đĩa trống tên → cả đường dẫn. win32: tách cả `\` lẫn `/` trên mọi hệ điều hành. */
export const fileName = (p) => path.win32.basename(String(p).replace(/[\\/]+$/, '')) || String(p);

/** Loại của một đường dẫn: thư mục → folder; còn lại theo đuôi tệp (không biết → file). */
export function fileKind(p, { dir = isDir } = {}) {
  if (dir(p)) return 'folder';
  const ext = path.extname(fileName(p)).slice(1).toLowerCase();
  return KIND_OF_EXT.get(ext) || 'file';
}

/** Chip cho cửa sổ vẽ. */
export function fileChip(p, opts) {
  const kind = fileKind(p, opts);
  const { icon, ink, bg } = FILE_KINDS[kind];
  return { path: p, name: fileName(p), kind, icon_path: lucidePath(icon), ink, bg };
}
