import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from './atomicFile.mjs';

/**
 * Vé LightCode của Cloud Computer (24/11/2026). BE cấp vé loại managed (Ed25519, hạn tối đa 6 giờ, ràng machine-id của lần bật máy này):
 *  - Lúc tạo container: env AIVIN_LIGHTCODE_LICENSE_KEY — entrypoint.sh ghi vào tệp rồi xoá env (thành viên không đọc được).
 *  - Giữa chừng: sự kiện socket BE → CLI `org_computer.license_renew` { token, expiresAt? } — module này ghi đè tệp nguyên tử.
 *
 * Tệp vé thuộc tài khoản daemon LightCode (không phải root, không phải thành viên), thư mục chứa 0700 → LightCode đọc được, thành viên
 * không. CLI chạy root (có DAC_OVERRIDE/CHOWN) nên ghi + đổi chủ được. Token KHÔNG bao giờ vào log / ack / thông báo lỗi.
 */

export const LICENSE_RENEW_EVENT = 'org_computer.license_renew';
export const LOG_TAG = '[ORG_COMPUTER_LICENSE]';
/** Khớp LCAGENT_LICENSE_FILE mà entrypoint.sh đặt cho daemon LightCode. */
export const DEFAULT_LICENSE_FILE = '/var/lib/aivin-lc/lightcode-license.key';
/** LightCode (server/src/license/license.ts readManagedLicenseKey) chỉ nhận khoá bắt đầu `LCA1.` và dài ≤ 2000 ký tự. */
export const TICKET_PREFIX = 'LCA1.';
export const TICKET_MAX_LENGTH = 2000;
const TICKET_RE = /^LCA1\.[A-Za-z0-9._~+/=-]+$/;

export const RenewReason = Object.freeze({
  BAD_PAYLOAD: 'bad_payload',
  BAD_TOKEN: 'bad_token',
  BAD_EXPIRES: 'bad_expires',
  EXPIRED: 'expired',
  NOT_ENABLED: 'not_enabled',
  WRITE_FAILED: 'write_failed',
});

export function licenseFilePath(env = process.env) {
  return String(env.AIVIN_LIGHTCODE_LICENSE_FILE || '').trim() || DEFAULT_LICENSE_FILE;
}

/** `expiresAt` (ISO hoặc mili-giây) → mili-giây, hoặc null nếu không phải thời điểm hợp lệ. */
function toMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Kiểm tra payload — trả { ok: true, token } hoặc { ok: false, reason }. Không ném lỗi, kết quả lỗi không chứa token. */
export function validateRenewPayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: RenewReason.BAD_PAYLOAD };
  const token = typeof payload.token === 'string' ? payload.token.trim() : '';
  if (!token || token.length > TICKET_MAX_LENGTH || !TICKET_RE.test(token)) return { ok: false, reason: RenewReason.BAD_TOKEN };
  if (payload.expiresAt !== undefined && payload.expiresAt !== null) {
    const exp = toMillis(payload.expiresAt);
    if (exp === null) return { ok: false, reason: RenewReason.BAD_EXPIRES };
    if (exp <= now) return { ok: false, reason: RenewReason.EXPIRED };
  }
  return { ok: true, token };
}

/** Chủ của thư mục chứa vé = tài khoản daemon LightCode; chưa có thư mục này = image không bật LightCode. */
function daemonOwner(dir) {
  try {
    const st = fs.statSync(dir);
    return st.isDirectory() ? { uid: st.uid, gid: st.gid } : null;
  } catch { return null; }
}

/**
 * Ghi vé ra tệp: nguyên tử (tệp tạm cạnh bên + đổi tên đè), 0600, đổi chủ cho tài khoản daemon. Trả { ok } hoặc { ok:false, reason }.
 * Tệp tạm cũng 0600 và nằm trong thư mục 0700 nên không có lúc nào thành viên đọc được. Nếu đổi chủ lỗi, tệp vẫn thuộc root (daemon
 * không đọc được) → báo write_failed để BE thử lại, không im lặng.
 */
export function writeLicenseFile(file, token, { ownerOf = daemonOwner, chown = fs.chownSync, writeAtomic = writeFileAtomic } = {}) {
  const owner = ownerOf(path.dirname(file));
  if (!owner) return { ok: false, reason: RenewReason.NOT_ENABLED };
  try {
    writeAtomic(file, `${token}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') chown(file, owner.uid, owner.gid);
    return { ok: true };
  } catch {
    return { ok: false, reason: RenewReason.WRITE_FAILED };
  }
}

/**
 * Bộ xử lý sự kiện `org_computer.license_renew`: (payload, ack). Luôn ack — `{ ok: true }` hoặc `{ ok: false, reason }` (mã cố định,
 * không có token / đường dẫn).
 */
export function createLicenseRenewHandler({ file = licenseFilePath(), now = () => Date.now(), write = writeLicenseFile, log = () => {} } = {}) {
  return (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const checked = validateRenewPayload(payload, now());
    if (!checked.ok) { log(`${LOG_TAG} từ chối: ${checked.reason}`); reply({ ok: false, reason: checked.reason }); return checked; }
    const res = write(file, checked.token);
    // Chỉ ghi mã lý do cố định — không bao giờ token / đường dẫn.
    log(res.ok ? `${LOG_TAG} đã gia hạn vé LightCode` : `${LOG_TAG} ghi vé thất bại: ${res.reason}`);
    reply(res.ok ? { ok: true } : { ok: false, reason: res.reason });
    return res;
  };
}
