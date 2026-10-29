import { createHash, createPublicKey, verify as verifySignature } from 'crypto';
import { RELEASE_PUBLIC_KEYS } from '../releaseKeys.mjs';
import { compareVersions, tagOf } from './versions.mjs';

/**
 * Chữ ký bản phát hành (Ed25519): ký trên số phiên bản + nguyên văn `SHA256SUMS`; khoá công khai nhúng trong CLI (releaseKeys.mjs), khoá bí
 * mật không nằm trên trang tải → chiếm được get.aivin.vn cũng không đẩy được tệp chạy lạ. Mã băm cùng trang tải chỉ bắt tệp tải hỏng.
 */

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Dòng `<sha256>  <tệp>` (dấu `*` chế độ nhị phân tuỳ ý) → mã của đúng tệp. */
export function checksumFor(sumsText, file) {
  for (const line of String(sumsText).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return null;
}

/** Nội dung được ký: số phiên bản + nguyên văn SHA256SUMS — chữ ký của bản này không dùng lại được cho bản khác. */
export const signedMessage = (version, sums) => Buffer.concat([Buffer.from(`aivin-release ${tagOf(version)}\n`), Buffer.from(sums)]);

const publicKeyOf = (raw) => createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });

/** Mã khoá = 16 ký tự hex đầu SHA-256 của khoá công khai thô (32 byte). */
export function releaseKeyId(key) {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(pub.export({ format: 'der', type: 'spki' }).subarray(-32)).digest('hex').slice(0, 16);
}

/** `SHA256SUMS.sig` = `{ alg: 'ed25519', key_id, version, sig }`. Khoá không có trong danh sách / chữ ký sai / lệch phiên bản → ném. */
export function verifyReleaseSignature({ version, sums, sigText, keys = RELEASE_PUBLIC_KEYS }) {
  let sig;
  try { sig = JSON.parse(String(sigText)); } catch { throw new Error(`Chữ ký của ${tagOf(version)} hỏng — dừng cập nhật để an toàn`); }
  const key = keys.find((k) => k.id === sig?.key_id);
  if (sig?.alg !== 'ed25519' || !key) throw new Error(`Bản ${tagOf(version)} không ký bằng khoá máy này tin (${sig?.key_id || 'không rõ khoá'}) — dừng cập nhật`);
  if (sig.version !== undefined && compareVersions(sig.version, version) !== 0) throw new Error(`Chữ ký dành cho ${sig.version}, không phải ${tagOf(version)} — dừng cập nhật`);
  let ok;
  try { ok = verifySignature(null, signedMessage(version, sums), publicKeyOf(key.key), Buffer.from(String(sig.sig || ''), 'base64')); } catch { ok = false; }
  if (!ok) throw new Error(`Chữ ký của ${tagOf(version)} không hợp lệ — dừng cập nhật để an toàn`);
}
