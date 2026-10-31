import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Tệp "chỉ có trên mây" (OneDrive / Dropbox / Google Drive / iCloud trên Windows, Files On-Demand): mở để đọc là Windows TẢI VỀ — một lần
 * quét lập chỉ mục có thể kéo về hàng GB. Đọc thuộc tính thì không tải: OFFLINE (0x1000) / RECALL_ON_OPEN (0x40000) /
 * RECALL_ON_DATA_ACCESS (0x400000) → chỉ lập chỉ mục tên. macOS: tệp iCloud chưa tải là tệp ẩn `.x.icloud` (đã bị bỏ như tệp ẩn).
 */

const CLOUD_DIR_RE = /^(OneDrive|Dropbox|Google Drive|iCloudDrive|iCloud Drive|Box)( - .*| \(.*\))?$/i;
const CLOUD_ONLY_MASK = 0x1000 | 0x40000 | 0x400000;
const CHECK_TIMEOUT_MS = 60_000;

/** Đường dẫn nằm trong thư mục đồng bộ đám mây (chỉ Windows mới có tệp giữ chỗ cần lo). */
export function inCloudFolder(abs, platform = process.platform) {
  return platform === 'win32' && abs.split(path.sep).some((seg) => CLOUD_DIR_RE.test(seg));
}

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
foreach ($p in [IO.File]::ReadAllLines($env:AIVIN_CLOUD_LIST, [Text.Encoding]::UTF8)) {
  try { if (([int][IO.File]::GetAttributes($p)) -band ${CLOUD_ONLY_MASK}) { [Console]::Out.WriteLine($p) } } catch { }
}
`;

function runPowerShell(listFile) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      env: { ...process.env, AIVIN_CLOUD_LIST: listFile }, windowsHide: true, timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Trong `paths`, tệp nào chỉ có trên mây — hỏi một lần cho cả lô. Không hỏi được (PowerShell bị chặn…) → coi CẢ LÔ là trên mây: thà mất
 * đoạn chữ đầu còn hơn tải về cả thư mục.
 */
export async function cloudOnlyFiles(paths, { platform = process.platform, run = runPowerShell } = {}) {
  if (platform !== 'win32' || !paths.length) return new Set();
  const listFile = path.join(os.tmpdir(), `aivin-cloud-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(listFile, paths.join('\n'), 'utf8');
    const out = await run(listFile);
    return new Set(String(out).split(/\r?\n/).filter(Boolean));
  } catch {
    return new Set(paths);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}
