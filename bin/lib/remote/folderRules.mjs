import fs from 'fs';
import path from 'path';
import { IGNORED_DIRS } from './constants.mjs';
import { isDocFile } from './docText.mjs';

/**
 * Quy tắc lập chỉ mục: bỏ gì, gộp gì (31/10/2026). Đo trên máy thật: 88% tệp trong thư mục ẩn, rồi 87% phần còn lại là ảnh chụp màn hình
 * tự sinh — lập chỉ mục từng tệp chỉ làm chậm và kết quả nhiễu. Những thứ bị bỏ / gộp vẫn mở được bằng fs.list / fs.grep, và tìm được qua
 * bộ tìm tệp của hệ điều hành (osSearch.mjs).
 */

/** Gộp thư mục thành MỘT mục (không lập chỉ mục từng tệp bên trong). */
export const FolderKind = Object.freeze({
  /** Thư mục cài ứng dụng / dữ liệu ứng dụng (hồ sơ Chromium/Electron, môi trường Python, gói .app). */
  APP: 'app',
  /** Hàng trăm tệp không phải tài liệu (ảnh chụp màn hình, ảnh máy ảnh, log, xuất dữ liệu) — tài liệu bên trong vẫn lập chỉ mục. */
  BULK: 'bulk',
  /** Kho git: code tìm bằng fs.grep; chỉ lập chỉ mục README + tài liệu bên trong (trừ thư mục làm việc người dùng chỉ định). */
  REPO: 'repo',
});

/** Dữ liệu ứng dụng, hệ điều hành, thùng rác, kho gói — không bao giờ lập chỉ mục. */
const INDEX_SKIP_DIRS = new Set([
  'AppData', 'Application Data', 'Local Settings', '$Recycle.Bin', 'System Volume Information', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', 'Library', 'miniconda3', 'anaconda3', 'snap', 'site-packages', 'Pods', 'DerivedData',
]);

/** Tệp tạm / sao lưu / sinh ra khi biên dịch / tải dở — không ai tìm. */
const SKIP_FILE_EXT = new Set([
  '.tmp', '.temp', '.old', '.bak', '.swp', '.swo', '.crdownload', '.part', '.partial', '.download', '.lock', '.pyc', '.pyo', '.class',
  '.o', '.obj', '.pdb', '.dll', '.sys', '.cache', '.dmp', '.etl', '.blf', '.regtrans-ms',
]);
const SKIP_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini', 'ntuser.dat', 'ntuser.ini']);

/** Thư mục ẩn (`.claude`, `.gemini`, `.git`…) + rác build + dữ liệu hệ thống. */
export const skipDir = (name) => name.startsWith('.') || IGNORED_DIRS.has(name) || INDEX_SKIP_DIRS.has(name);

export function skipFile(name) {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || lower.startsWith('~$') || lower.endsWith('~') || SKIP_FILE_NAMES.has(lower)
    || SKIP_FILE_EXT.has(path.extname(lower)) || lower.startsWith('ntuser.dat');
}

export const BULK_MIN_FILES = 300;
/** Tài liệu chiếm từ chừng này trở lên → không coi là thư mục hàng loạt (thư mục 500 hoá đơn PDF vẫn lập chỉ mục từng tệp). */
const BULK_DOC_SHARE = 0.2;
const APP_MIN_DLLS = 3;

/** Phân loại thư mục theo những gì ngay bên trong (một lần readdir, không đọc tệp). null = thư mục thường. */
export function classifyDir(name, entries) {
  if (/\.app$/i.test(name)) return FolderKind.APP;
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  if (names.has('.git')) return FolderKind.REPO;
  if (names.has('pyvenv.cfg') || names.has('conda-meta') || names.has('local state') || (names.has('preferences') && names.has('local storage'))) {
    return FolderKind.APP;
  }
  const files = entries.filter((e) => e.isFile());
  const exe = files.some((f) => /\.exe$/i.test(f.name));
  if (exe && files.filter((f) => /\.dll$/i.test(f.name)).length >= APP_MIN_DLLS) return FolderKind.APP;
  if (files.length >= BULK_MIN_FILES && files.filter((f) => isDocFile(f.name)).length < files.length * BULK_DOC_SHARE) return FolderKind.BULK;
  return null;
}

const CATEGORIES = [
  { words: 'images photos pictures screenshots anh hinh chup man hinh', ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp', '.tif', '.tiff', '.raw', '.cr2', '.nef', '.arw', '.dng'] },
  { words: 'videos video clips recordings', ext: ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv'] },
  { words: 'audio music sound recordings am thanh nhac', ext: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'] },
  { words: 'logs log nhat ky', ext: ['.log'] },
  { words: 'data export du lieu', ext: ['.json', '.csv', '.xml', '.ndjson', '.parquet'] },
];

const README_RE = /^readme(\.(md|txt|rst))?$/i;
const README_CHARS = 300;

function readmeOf(dir, entries) {
  const file = entries.find((e) => e.isFile() && README_RE.test(e.name));
  if (!file) return '';
  try {
    const fd = fs.openSync(path.join(dir, file.name), 'r');
    try {
      const buf = Buffer.alloc(2048);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, README_CHARS);
    } finally { fs.closeSync(fd); }
  } catch {
    return '';
  }
}

/**
 * Mục đại diện cho thư mục gộp: `note` hiện trong kết quả tìm (agent biết mở bằng fs.list), `words` đưa vào chỉ mục từ khoá ("ảnh chụp màn
 * hình" tìm ra Pictures\Screenshots), `count` = số mục ngay bên trong.
 */
export function folderSummary(kind, dir, entries) {
  const files = entries.filter((e) => e.isFile());
  if (kind === FolderKind.APP) {
    return { count: entries.length, words: 'application app program software data ung dung phan mem', note: 'Application / app data folder — not indexed file by file; open it with fs.list.' };
  }
  if (kind === FolderKind.REPO) {
    const readme = readmeOf(dir, entries);
    return {
      count: entries.length, words: `project code repository source git du an ma nguon ${readme}`,
      note: `Code project (git) — code is not indexed (use fs.grep inside it; fs.index_folder indexes it fully).${readme ? ` README: ${readme}` : ''}`,
    };
  }
  const byExt = new Map();
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase() || '(none)';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  const top = [...byExt].sort((a, b) => b[1] - a[1]);
  const words = CATEGORIES.filter((c) => c.ext.some((e) => byExt.has(e))).map((c) => c.words).join(' ');
  return {
    count: files.length, words: `${words} ${top.map(([e]) => e.slice(1)).join(' ')}`,
    note: `Folder with ${files.length} files (${top.slice(0, 3).map(([e, n]) => `${e} ${n}`).join(', ')}) — not indexed one by one (documents in it are); list it with fs.list sorted by modified.`,
  };
}
