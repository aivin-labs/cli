/**
 * Mở tệp / thư mục TRÊN MÁY từ nút của linh vật (18/11/2026) — thẻ duyệt việc lập trình: "Mở thư mục" dự án, "TEST_CHECK.md".
 *
 * An toàn: đường dẫn đến từ BE, nên cửa sổ không bao giờ tự mở — nó chỉ gửi lại MÃ nút; daemon tra mã ra đường dẫn đã đăng ký rồi kiểm:
 * tuyệt đối, có thật trên máy, không phải đường mạng (\\máy\chia-sẻ — mở là gửi thông tin đăng nhập Windows ra ngoài). Thư mục → mở bằng trình
 * quản lý tệp; tệp TÀI LIỆU (đuôi trong danh sách) → ứng dụng mặc định; mọi tệp khác (exe, bat, ps1, lnk…) KHÔNG chạy — chỉ hiện trong thư mục
 * chứa nó (Explorer /select).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Đuôi tệp mở thẳng bằng ứng dụng mặc định — tài liệu / ảnh / dữ liệu chỉ đọc; không có gì chạy được mã. */
export const DOCUMENT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'pdf', 'csv', 'tsv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);

export const LocalOpenKind = Object.freeze({ FOLDER: 'folder', DOCUMENT: 'document', REVEAL: 'reveal' });

/**
 * Hàm thuần (stat tiêm vào được): đường dẫn mở được không và mở kiểu gì. `null` = từ chối (không tuyệt đối / đường mạng / không có trên máy).
 */
export function localOpenTarget(p, { stat = fs.statSync, platform = process.platform } = {}) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const raw = p.trim();
  const win = platform === 'win32';
  if (win ? /^[\\/]{2}/.test(raw) : raw.startsWith('//')) return null;
  if (!(win ? path.win32.isAbsolute(raw) && /^[a-z]:[\\/]/i.test(raw) : path.posix.isAbsolute(raw))) return null;
  let st;
  try { st = stat(raw); } catch { return null; }
  if (st.isDirectory()) return { path: raw, kind: LocalOpenKind.FOLDER };
  if (!st.isFile()) return null;
  const ext = path.extname(raw).slice(1).toLowerCase();
  return { path: raw, kind: DOCUMENT_EXTS.has(ext) ? LocalOpenKind.DOCUMENT : LocalOpenKind.REVEAL };
}

/** Lệnh mở theo hệ điều hành — hàm thuần. */
export function localOpenCommand(target, platform = process.platform) {
  if (platform === 'win32') {
    if (target.kind === LocalOpenKind.REVEAL) return { cmd: 'explorer.exe', args: [`/select,"${target.path}"`], verbatim: true };
    return { cmd: 'explorer.exe', args: [`"${target.path}"`], verbatim: true };
  }
  if (platform === 'darwin') return { cmd: 'open', args: target.kind === LocalOpenKind.REVEAL ? ['-R', target.path] : [target.path] };
  return { cmd: 'xdg-open', args: [target.kind === LocalOpenKind.REVEAL ? path.posix.dirname(target.path) : target.path] };
}

/** Mở (đã kiểm). Trả loại đã mở, hoặc null khi bị từ chối. */
export function openLocal(p, { stat, platform = process.platform, spawnImpl = spawn } = {}) {
  const target = localOpenTarget(p, { stat, platform });
  if (!target) return null;
  const { cmd, args, verbatim } = localOpenCommand(target, platform);
  try {
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
    child?.on?.('error', () => undefined);
    child?.unref?.();
  } catch {
    return null;
  }
  return target.kind;
}

/** Mã nút → đường dẫn đã đăng ký (cửa sổ chỉ cầm mã). Giữ tối đa `max` mục gần nhất. */
export function createLocalLinkRegistry(max = 200) {
  const byId = new Map();
  let seq = 0;
  return {
    register(p) {
      const id = `l${++seq}`;
      byId.set(id, p);
      if (byId.size > max) byId.delete(byId.keys().next().value);
      return id;
    },
    pathOf: (id) => byId.get(String(id)) ?? null,
  };
}

/** Tiền tố url của nút mở trên máy trong lệnh gửi cửa sổ: `local:<mã>`. */
export const LOCAL_LINK_PREFIX = 'local:';
