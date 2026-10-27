import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/**
 * Đoạn chữ đầu của một tệp để lập chỉ mục / xem trước: tệp chữ đọc thẳng; docx/xlsx/pptx/odt/ods/odp là tệp zip chứa XML — đọc bằng bộ
 * giải zip nhỏ (thư mục trung tâm + inflateRaw của Node), không cần thư viện ngoài. PDF chưa đọc nội dung (chỉ tên + đường dẫn).
 */

export const DOC_EXTENSIONS = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.odt', '.ods', '.odp', '.rtf', '.txt', '.md', '.csv',
]);
const PLAIN_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.rtf']);
const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 16 * 1024;

/** Phần trong gói Office chứa chữ chính, theo thứ tự đọc. */
function officeParts(ext, names) {
  if (ext === '.docx') return ['word/document.xml'];
  if (ext === '.xlsx') return ['xl/sharedStrings.xml'];
  if (ext === '.pptx') {
    const slide = (n) => Number(/slide(\d+)\.xml$/.exec(n)?.[1] || 0);
    return names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slide(a) - slide(b)).slice(0, 5);
  }
  if (['.odt', '.ods', '.odp'].includes(ext)) return ['content.xml'];
  return [];
}

/** Đọc thư mục trung tâm của zip → { tên: { offset, method, compressedSize } }. */
function zipEntries(buf) {
  const minEocd = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return {};
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count && at + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    out[buf.toString('utf8', at + 46, at + 46 + nameLen)] = { offset, method, compressedSize };
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function zipRead(buf, entry) {
  const at = entry.offset;
  if (buf.readUInt32LE(at) !== 0x04034b50) return '';
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method !== 8) return '';
  return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
}

/** XML Office → chữ: đoạn / ô / dòng thành khoảng trắng, bỏ thẻ, giải thực thể cơ bản. */
export function xmlToText(xml) {
  return String(xml || '')
    .replace(/<\/(w:p|a:p|text:p|text:h|si|row|table:table-row)>/g, ' \n')
    .replace(/<(w:tab|w:br|text:tab|text:line-break)\b[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function officeText(buf, ext) {
  const entries = zipEntries(buf);
  return officeParts(ext, Object.keys(entries))
    .filter((name) => entries[name])
    .map((name) => xmlToText(zipRead(buf, entries[name])))
    .filter(Boolean)
    .join('\n');
}

/** Chữ đầu tệp (tối đa `maxChars`). Lỗi / định dạng chưa đọc được → chuỗi rỗng. */
export async function extractDocText(abs, size, maxChars = 600) {
  const ext = path.extname(abs).toLowerCase();
  try {
    if (PLAIN_EXTENSIONS.has(ext)) {
      const handle = await fs.promises.open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        return clean(buf.subarray(0, bytesRead).toString('utf8'), maxChars);
      } finally {
        await handle.close();
      }
    }
    if (!officeParts(ext, ['ppt/slides/slide1.xml']).length || size > MAX_ZIP_BYTES) return '';
    return clean(officeText(await fs.promises.readFile(abs), ext), maxChars);
  } catch {
    return '';
  }
}

function clean(text, maxChars) {
  const t = String(text || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  return wellFormed(t.length > maxChars ? `${t.slice(0, maxChars)}…` : t);
}

/** Bỏ nửa ký tự lẻ (cắt ngang giữa emoji / ký tự ghép): dịch vụ vector của BE từ chối cả lô có chuỗi như vậy (chạy thật 27/10/2026). */
export function wellFormed(text) {
  return String(text).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

export function isDocFile(abs) {
  return DOC_EXTENSIONS.has(path.extname(abs).toLowerCase());
}
