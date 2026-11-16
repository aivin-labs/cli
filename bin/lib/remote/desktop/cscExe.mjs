import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { REMOTE_CONFIG_DIR } from '../constants.mjs';

/**
 * Tệp exe nhỏ biên dịch MỘT lần bằng csc của .NET Framework có sẵn trong Windows (16/11/2026, cùng cách dpapiHelper): chạy ~30 ms thay vì
 * 1–2 s biên dịch Add-Type của PowerShell mỗi lần. Đặt trong `~/.aivin/bin` (thư mục bị chặn với mọi công cụ từ xa), tên mang dấu vân tay mã
 * nguồn nên đổi mã là dựng bản mới. Không dựng được (không phải Windows, máy chặn csc, diệt virus xoá tệp) → `null`, không thử lại trong 24 h.
 */

const BIN_DIR = path.join(REMOTE_CONFIG_DIR, 'bin');
const RETRY_AFTER_FAIL_MS = 24 * 3600_000;
const BUILD_TIMEOUT_MS = 60_000;

export const CscTarget = Object.freeze({ CONSOLE: 'exe', WINDOWS: 'winexe' });

export function runFile(file, args, { timeout, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(String(stdout || ''))));
  });
}

function cscPath(env = process.env) {
  const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  return ['Framework64', 'Framework'].map((d) => path.join(windir, 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p)) || null;
}

/** @param {{ name: string, source: string, refs?: string[], target?: string }} spec */
export function createCscExe({ name, source, refs = [], target = CscTarget.CONSOLE }) {
  const version = createHash('sha256').update(source).update(refs.join(',')).update(target).digest('hex').slice(0, 10);
  const exePath = path.join(BIN_DIR, `${name}-${version}.exe`);
  const failedMark = path.join(BIN_DIR, `${name}-${version}.failed`);
  let building = null;

  const recentlyFailed = () => {
    try { return Date.now() - fs.statSync(failedMark).mtimeMs < RETRY_AFTER_FAIL_MS; } catch { return false; }
  };

  async function build() {
    const csc = cscPath();
    if (!csc) return null;
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const src = path.join(BIN_DIR, `${name}-${version}.cs`);
    const tmp = `${exePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(src, source, 'utf8');
      await runFile(csc, ['-nologo', `-target:${target}`, '-optimize+', ...refs.map((r) => `-r:${r}`), `-out:${tmp}`, src], { timeout: BUILD_TIMEOUT_MS });
      fs.renameSync(tmp, exePath);
      return exePath;
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* không có thì thôi */ }
      try { fs.writeFileSync(failedMark, new Date().toISOString()); } catch { /* chỉ là dấu */ }
      return fs.existsSync(exePath) ? exePath : null;
    } finally {
      try { fs.rmSync(src, { force: true }); } catch { /* không có thì thôi */ }
    }
  }

  /** Đường dẫn exe, dựng lần đầu nếu cần (không chặn vòng sự kiện); `null` khi không dựng được. */
  function prepare({ platform = process.platform } = {}) {
    if (platform !== 'win32') return Promise.resolve(null);
    if (building) return building;
    if (fs.existsSync(exePath)) return (building = Promise.resolve(exePath));
    if (recentlyFailed()) return (building = Promise.resolve(null));
    building = build().catch(() => null);
    return building;
  }

  return { path: exePath, prepare, reset: () => { building = null; } };
}
