import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from '../atomicFile.mjs';
import { CastState, REMOTE_CONFIG_DIR } from '../constants.mjs';
import { openToken, sealToken } from '../tokenStore.mjs';

/**
 * Thiết bị người ở máy đã bấm "Luôn cho phép" (09/11/2026): lần sau vào xem không phải hỏi lại.
 *
 * Trình duyệt giữ khoá riêng không xuất ra được, máy chỉ lưu khoá công khai và mỗi lần vào bắt ký một chuỗi ngẫu nhiên do chính máy sinh —
 * máy chủ chuyển tin nhưng không tự chứng minh thay được, nghe lén một lần cũng không dùng lại được. Danh sách có chữ ký bằng khoá cất trong
 * kho bí mật của hệ điều hành: AI hay script trên máy ghi thêm vào tệp thì chữ ký sai, cả danh sách coi như rỗng (lại hỏi người ở máy).
 * Giới hạn như `humanInput.mjs`: mã độc cùng tài khoản hệ điều hành gọi được kho bí mật thì vẫn lách được.
 */
export const CAST_TRUST_FILE = path.join(REMOTE_CONFIG_DIR, 'cast-trusted-devices.json');
export const CAST_TRUST_KEY_FILE = path.join(REMOTE_CONFIG_DIR, 'cast-trusted-devices.key');
/** Không dùng quá ngần này thì thiết bị hết được tin. */
export const CAST_TRUST_TTL_MS = 30 * 86_400_000;

const MAX_DEVICES = 20;
const KEY_ACCOUNT = 'cast-trusted-devices';
const PROOF_PREFIX = 'aivin-cast-device-proof';
const MAX_KEY_CHARS = 300;
const MAX_NAME_CHARS = 60;
const PROOF_TIMEOUT_MS = 8000;

/** Khoá công khai P-256 (SPKI, base64) hợp lệ → đối tượng khoá; khác đi → `null`. */
function parseDeviceKey(deviceKey) {
  if (typeof deviceKey !== 'string' || !deviceKey || deviceKey.length > MAX_KEY_CHARS) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(deviceKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

/** Tên do trình duyệt tự khai, chỉ để hiện: bỏ ký tự lạ để khay đọc tệp không vỡ. */
const safeName = (name) => String(name ?? '').replace(/[^\p{L}\p{N} ._·-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS) || 'Thiết bị';

const VIEWER_CODE_CHARS = 6;
/** Chừa chỗ cho " - <mã>" để cắt theo `MAX_NAME_CHARS` khi lưu không làm mất mã. */
const VIEWER_NAME_CHARS = MAX_NAME_CHARS - VIEWER_CODE_CHARS - 3;

/**
 * Tên hiện cho chủ máy: FE khai loại máy + model (chỉ Android có) + trình duyệt, vẫn có thể trùng giữa hai máy nên ghép thêm mã suy ra từ khoá
 * của thiết bị, ví dụ "Android SM-S918B · Chrome - 7F3A9C".
 * Trình duyệt không có khoá (ẩn danh, chặn IndexedDB) thì lấy `viewerKey`: vẫn phân biệt được nhưng đổi mạng là đổi mã.
 * Chỉ để hiện: danh tính thật vẫn là khoá, và loại máy gốc vẫn dùng riêng cho `isTouchViewerDevice` (so khớp đúng chuỗi).
 */
export function castViewerLabel(viewerDevice, deviceKey, viewerKey) {
  const identity = deviceKey || viewerKey;
  if (!identity) return viewerDevice;
  const code = createHash('sha256').update(String(identity)).digest('hex').slice(0, VIEWER_CODE_CHARS).toUpperCase();
  return `${safeName(viewerDevice).slice(0, VIEWER_NAME_CHARS).trim()} - ${code}`;
}

/** `signature`: base64 của chữ ký ECDSA dạng WebCrypto (r || s) trên `aivin-cast-device-proof\n<mã phiên>\n<chuỗi ngẫu nhiên>`. */
export function verifyDeviceProof({ deviceKey, sessionId, nonce, signature }) {
  const key = parseDeviceKey(deviceKey);
  if (!key || typeof signature !== 'string' || !signature) return false;
  try {
    return verify('sha256', Buffer.from(`${PROOF_PREFIX}\n${sessionId}\n${nonce}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function createCastTrust({ file = CAST_TRUST_FILE, keyFile = CAST_TRUST_KEY_FILE, now = Date.now } = {}) {
  /** Giải kho bí mật tốn một tiến trình con: nhớ theo bản mã trong tệp khoá. */
  let cached = null;

  function secret({ create = false } = {}) {
    let record = null;
    try { record = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch { /* chưa có */ }
    const fingerprint = record ? `${record.token_store || ''}:${record.token_enc || record.device_token || ''}` : null;
    if (fingerprint && cached?.fingerprint === fingerprint) return cached.key;
    let key = record ? openToken(record) : null;
    if (!key && create) {
      key = randomBytes(32).toString('hex');
      const { fallback_reason: _why, ...sealed } = sealToken(key, { account: KEY_ACCOUNT });
      writeFileAtomic(keyFile, `${JSON.stringify({ device_id: KEY_ACCOUNT, ...sealed }, null, 2)}\n`);
      cached = { fingerprint: `${sealed.token_store || ''}:${sealed.token_enc || sealed.device_token || ''}`, key };
      return key;
    }
    if (key) cached = { fingerprint, key };
    return key;
  }

  const sign = (devices, key) => createHmac('sha256', key).update(JSON.stringify(devices)).digest('hex');

  function sealMatches(devices, seal, key) {
    if (typeof seal !== 'string' || !key) return false;
    const expected = Buffer.from(sign(devices, key), 'hex');
    const actual = Buffer.from(seal, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Thiết bị còn hạn trong danh sách đúng chữ ký; sai chữ ký / hỏng tệp → rỗng (lại hỏi người ở máy, không bao giờ tự cho vào). */
  function list() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
    const devices = Array.isArray(raw?.devices) ? raw.devices : [];
    if (!devices.length || !sealMatches(devices, raw.seal, secret())) return [];
    return devices.filter((d) => d?.expires_at >= now());
  }

  function save(devices) {
    const key = secret({ create: devices.length > 0 });
    writeFileAtomic(file, `${JSON.stringify({ devices, ...(key ? { seal: sign(devices, key) } : {}) }, null, 2)}\n`);
  }

  return {
    list,
    /** Khoá này đủ điều kiện để lưu (trình duyệt cũ / khoá hỏng thì hộp hỏi không hiện nút "Luôn cho phép"). */
    accepts: (deviceKey) => parseDeviceKey(deviceKey) !== null,
    has: (deviceKey) => list().some((d) => d.key === deviceKey),
    add({ key, name }) {
      if (!parseDeviceKey(key)) return false;
      const t = now();
      const others = list().filter((d) => d.key !== key).sort((a, b) => b.last_used_at - a.last_used_at).slice(0, MAX_DEVICES - 1);
      save([{ key, name: safeName(name), added_at: new Date(t).toISOString(), last_used_at: t, expires_at: t + CAST_TRUST_TTL_MS }, ...others]);
      return true;
    },
    /** Vừa vào bằng quyền tin: tính lại hạn từ lần dùng này. */
    touch(key) {
      const t = now();
      const devices = list();
      if (devices.some((d) => d.key === key)) save(devices.map((d) => (d.key === key ? { ...d, last_used_at: t, expires_at: t + CAST_TRUST_TTL_MS } : d)));
    },
    remove(key) {
      const devices = list();
      const kept = devices.filter((d) => d.key !== key);
      if (kept.length !== devices.length) save(kept);
    },
    removeAll: () => save([]),
  };
}

/**
 * Bắt thiết bị chứng minh có khoá riêng: gửi chuỗi ngẫu nhiên, chờ chữ ký quay lại. `prove` trả `true` / `false` (sai, quá giờ),
 * `null` khi người xem đã rời trong lúc chờ.
 */
export function createDeviceProver({ send, timeoutMs = PROOF_TIMEOUT_MS }) {
  const pending = new Map();

  const settle = (viewerId, result) => {
    const open = pending.get(viewerId);
    if (!open) return;
    pending.delete(viewerId);
    clearTimeout(open.timer);
    open.resolve(result);
  };

  return {
    prove({ sessionId, viewerId, deviceKey }) {
      const viewer = String(viewerId);
      settle(viewer, null);
      const nonce = randomBytes(32).toString('base64');
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(viewer, false), timeoutMs);
        timer.unref?.();
        pending.set(viewer, { sessionId, deviceKey, nonce, resolve, timer });
        try {
          send({ session_id: sessionId, viewer_id: viewer, state: CastState.DEVICE_CHALLENGE, nonce });
        } catch {
          settle(viewer, false);
        }
      });
    },
    /** Chữ ký người xem gửi về (tin `device_proof` trên đường tín hiệu; `sdp` mang chữ ký). */
    answer({ viewer_id: viewerId, session_id: sessionId, sdp: signature }) {
      const viewer = String(viewerId);
      const open = pending.get(viewer);
      if (!open || open.sessionId !== sessionId) return;
      settle(viewer, verifyDeviceProof({ deviceKey: open.deviceKey, sessionId, nonce: open.nonce, signature }));
    },
    /** Không truyền `viewerId` = huỷ tất cả. */
    cancel(viewerId) {
      for (const viewer of viewerId === undefined ? [...pending.keys()] : [String(viewerId)]) settle(viewer, null);
    },
  };
}
