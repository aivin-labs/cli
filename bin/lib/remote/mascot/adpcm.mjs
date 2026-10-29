/**
 * IMA ADPCM cho âm thanh nói chuyện giữa máy và Aivin (30/10/2026): PCM16 mono → 4 bit / mẫu (nhỏ đi 4 lần; gửi nhị phân thay base64 thêm
 * ~1/3) — không cần thư viện native như Opus. Mỗi đoạn tự giải được (đầu đoạn mang trạng thái bộ mã hoá), mất một đoạn không làm hỏng đoạn
 * sau. Cùng thuật toán với BE (`device-agent/helper/AdpcmHelper.ts`).
 *
 * Một đoạn: [int16 LE dự đoán][uint8 chỉ số bước][uint8 cờ: bit 0 = số mẫu lẻ] + 2 mẫu / byte (nửa thấp trước).
 */
export const VOICE_CODEC = 'ima-adpcm';

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
  190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const HEADER = 4;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Bộ mã hoá giữ trạng thái giữa các đoạn của một luồng (âm thanh liền mạch). */
export function createAdpcmEncoder() {
  let pred = 0;
  let index = 0;
  return (pcm) => {
    const n = Math.floor(pcm.length / 2);
    const out = Buffer.alloc(HEADER + Math.ceil(n / 2));
    out.writeInt16LE(pred, 0);
    out[2] = index;
    out[3] = n % 2;
    for (let i = 0; i < n; i++) {
      let step = STEP_TABLE[index];
      let diff = pcm.readInt16LE(i * 2) - pred;
      let nib = 0;
      if (diff < 0) { nib = 8; diff = -diff; }
      let delta = step >> 3;
      if (diff >= step) { nib |= 4; diff -= step; delta += step; }
      step >>= 1;
      if (diff >= step) { nib |= 2; diff -= step; delta += step; }
      step >>= 1;
      if (diff >= step) { nib |= 1; delta += step; }
      pred = clamp(nib & 8 ? pred - delta : pred + delta, -32768, 32767);
      index = clamp(index + INDEX_TABLE[nib], 0, 88);
      out[HEADER + (i >> 1)] |= i & 1 ? nib << 4 : nib;
    }
    return out;
  };
}

/** Giải một đoạn → PCM16 mono. Đoạn hỏng / rỗng → Buffer rỗng. */
export function decodeAdpcm(data) {
  const buf = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!buf || buf.length < HEADER) return Buffer.alloc(0);
  let pred = buf.readInt16LE(0);
  let index = clamp(buf[2], 0, 88);
  const n = (buf.length - HEADER) * 2 - (buf[3] & 1);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const byte = buf[HEADER + (i >> 1)];
    const nib = i & 1 ? byte >> 4 : byte & 15;
    const step = STEP_TABLE[index];
    let delta = step >> 3;
    if (nib & 4) delta += step;
    if (nib & 2) delta += step >> 1;
    if (nib & 1) delta += step >> 2;
    pred = clamp(nib & 8 ? pred - delta : pred + delta, -32768, 32767);
    index = clamp(index + INDEX_TABLE[nib], 0, 88);
    out.writeInt16LE(pred, i * 2);
  }
  return out;
}
