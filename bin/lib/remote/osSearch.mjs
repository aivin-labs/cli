import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isProtectedPath } from './sandbox.mjs';

/**
 * Tìm tệp qua bộ tìm của hệ điều hành — cho những gì chỉ mục của Aivin cố ý bỏ (thư mục gộp, kho code, ổ khác ngoài thư mục nhà…): Windows
 * Search (SystemIndex), macOS Spotlight (`mdfind`), Linux `plocate` / `locate`. Không dựng gì thêm trên máy; hệ điều hành không có / tắt bộ
 * tìm → trả rỗng. Kết quả luôn lọc lại theo gốc được phép + vùng cấm (bộ tìm của hệ điều hành không biết sàn của Aivin).
 */

const MAX_WORDS = 6;
const DEFAULT_TIMEOUT_MS = 4000;

const wordsOf = (query) => [...new Set(String(query || '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, MAX_WORDS);

function run(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (_err, stdout) => resolve(String(stdout || '')));
  });
}

/** Câu SQL cho Windows Search: mọi từ đều phải khớp tên tệp hoặc nội dung đã được Windows lập chỉ mục; chỉ trong các gốc. */
export function windowsSearchSql(words, roots, limit) {
  const scope = roots.map((r) => `SCOPE='file:${r.replace(/\\/g, '/').replace(/'/g, "''")}'`).join(' OR ');
  const cond = words.map((w) => `(System.FileName LIKE '%${w}%' OR CONTAINS(*, '"${w}*"'))`).join(' AND ');
  return `SELECT TOP ${limit} System.ItemPathDisplay, System.Size, System.DateModified FROM SystemIndex WHERE (${scope}) AND ${cond} ORDER BY System.Search.Rank DESC`;
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$rs = New-Object -ComObject ADODB.Recordset
$rs.Open($env:AIVIN_OS_SQL, $c)
while (-not $rs.EOF) {
  $m = $rs.Fields.Item('System.DateModified').Value
  $d = if ($m -is [datetime]) { $m.ToString('yyyy-MM-dd') } else { '' }
  [Console]::Out.WriteLine([string]$rs.Fields.Item('System.ItemPathDisplay').Value + [char]9 + [string]$rs.Fields.Item('System.Size').Value + [char]9 + $d)
  $rs.MoveNext()
}
`;

async function searchWindows(words, roots, limit, timeoutMs, exec) {
  const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT], {
    env: { AIVIN_OS_SQL: windowsSearchSql(words, roots, limit) }, timeoutMs,
  });
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [abs, size, modified] = line.split('\t');
    return { abs, size: size ? Number(size) : undefined, modified: modified || undefined };
  });
}

async function searchMac(words, roots, limit, timeoutMs, exec) {
  const lists = await Promise.all(roots.map((r) => exec('mdfind', ['-onlyin', r, words.join(' ')], { timeoutMs })));
  return lists.flatMap((o) => o.split('\n')).filter(Boolean).slice(0, limit * 3).map((abs) => ({ abs }));
}

async function searchLinux(words, limit, timeoutMs, exec) {
  for (const cmd of ['plocate', 'locate']) {
    const out = await exec(cmd, ['-i', '-l', String(limit * 20), words[0]], { timeoutMs });
    if (out) return out.split('\n').filter(Boolean).map((abs) => ({ abs }));
  }
  return [];
}

const inRoots = (abs, roots) => roots.some((r) => {
  const rel = path.relative(r, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
});

/**
 * Tìm `query` qua bộ tìm của hệ điều hành trong `roots` → `[{ abs, size?, modified? }]` (tối đa `limit`). Lỗi / hết giờ / không có bộ tìm →
 * mảng rỗng (không bao giờ ném lỗi).
 */
export async function osFileSearch(query, { roots, limit = 10, timeoutMs = DEFAULT_TIMEOUT_MS, platform = process.platform, exec = run } = {}) {
  const words = wordsOf(query);
  if (!words.length || !roots?.length) return [];
  const resolved = roots.map((r) => path.resolve(r));
  let found;
  try {
    if (platform === 'win32') found = await searchWindows(words, resolved, limit * 2, timeoutMs, exec);
    else if (platform === 'darwin') found = await searchMac(words, resolved, limit, timeoutMs, exec);
    else found = await searchLinux(words, limit, timeoutMs, exec);
  } catch {
    return [];
  }
  const lower = words.map((w) => w.toLowerCase());
  const out = [];
  for (const hit of found) {
    if (out.length >= limit) break;
    if (!hit.abs || !path.isAbsolute(hit.abs) || !inRoots(hit.abs, resolved) || isProtectedPath(hit.abs)) continue;
    // locate chỉ lọc được theo một từ — các từ còn lại khớp trên đường dẫn.
    if (platform === 'linux' && !lower.every((w) => hit.abs.toLowerCase().includes(w))) continue;
    if (hit.size === undefined) {
      try {
        const st = fs.statSync(hit.abs);
        hit.size = st.isFile() ? st.size : undefined;
        hit.modified = new Date(st.mtimeMs).toISOString().slice(0, 10);
      } catch { continue; }
    }
    out.push(hit);
  }
  return out;
}
