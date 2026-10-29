import fs from 'fs';

/**
 * Biên bản sau buổi ghi (29/10/2026): ghi xong mới xử lý một thể — đọc `system.wav` + `mic.wav` (16 kHz mono 16-bit, cùng mốc thời gian), trộn
 * thành một luồng, cắt đoạn ~30 s tại chỗ im nhất quanh mốc cắt (không cắt giữa câu), bỏ đoạn im lặng, rồi gửi từng đoạn qua `stt(wav)` — chính
 * `device:stt` ô hỏi của linh vật dùng (BE không cần thêm gì). Đoạn BE chê dài (`audio_too_big`) thì chia đôi.
 */

export const SAMPLE_RATE = 16000;
const FRAME = SAMPLE_RATE / 10; // 100 ms
export const CHUNK_SEC = 30;
const CUT_WINDOW_SEC = 3;
const MIN_SPLIT_SEC = 4;
/** RMS (0..1) dưới mức này cả đoạn = im lặng, không gửi. */
const SILENCE_RMS = 0.006;

/** Đầu đọc WAV PCM 16-bit mono: tìm chunk `data`, đọc theo mẫu. Tệp không có → đọc ra toàn 0. */
export function openWav(file) {
  let fd = null;
  let dataOffset = 44;
  let samples = 0;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    let p = 12;
    while (p + 8 <= n) {
      const id = head.toString('ascii', p, p + 4);
      const size = head.readUInt32LE(p + 4);
      if (id === 'data') { dataOffset = p + 8; break; }
      p += 8 + size + (size % 2);
    }
    const bytes = fs.fstatSync(fd).size - dataOffset;
    samples = Math.max(0, Math.floor(bytes / 2));
  } catch {
    if (fd !== null) fs.closeSync(fd);
    fd = null;
  }
  return {
    samples,
    read(start, count) {
      const out = new Int16Array(Math.max(0, count));
      if (fd === null || start >= samples) return out;
      const n = Math.min(count, samples - start);
      const buf = Buffer.alloc(n * 2);
      fs.readSync(fd, buf, 0, buf.length, dataOffset + start * 2);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
      return out;
    },
    close() { if (fd !== null) fs.closeSync(fd); fd = null; },
  };
}

/** Cộng hai luồng (cắt đỉnh). */
export function mix(a, b) {
  const out = new Int16Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) {
    const v = (a[i] || 0) + (b[i] || 0);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

export function rms(samples, from = 0, to = samples.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += samples[i] * samples[i];
  return to > from ? Math.sqrt(s / (to - from)) / 32768 : 0;
}

/** Điểm cắt: khung 100 ms im nhất trong [lo, hi) (chỉ số mẫu tương đối trong `samples`). */
export function quietestCut(samples, lo, hi) {
  let best = hi;
  let bestRms = Infinity;
  for (let p = lo; p + FRAME <= hi; p += FRAME) {
    const r = rms(samples, p, p + FRAME);
    if (r < bestRms) { bestRms = r; best = p + FRAME / 2; }
  }
  return Math.min(best, samples.length);
}

export function wavBuffer(samples) {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24); buf.writeUInt32LE(SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

/** Khung 100 ms: bên nào đang nói (chỉ số nguồn) — `null` = im. Micro thường lọt tiếng loa (không đeo tai nghe) nên phải lớn hơn hẳn mới tính
 *  là chủ máy nói. */
const FRAME_SPEECH_RMS = 0.008;
function frameSides(parts, frames) {
  const sides = new Array(frames).fill(null);
  for (let f = 0; f < frames; f++) {
    const e = parts.map((p) => rms(p, f * FRAME, (f + 1) * FRAME));
    if (Math.max(...e) < FRAME_SPEECH_RMS) continue;
    sides[f] = e[1] > e[0] * 2 ? 1 : 0;
  }
  return sides;
}

const MIN_TURN_FRAMES = 40; // đoạn ít nhất 4 s trước khi cắt theo người nói
const TURN_CONFIRM_FRAMES = 15; // bên mới phải nói ≥ 1,5 s (12/15 khung) mới tính là đổi lượt

/** Khung đầu tiên (≥ MIN_TURN_FRAMES) mà bên kia bắt đầu một lượt nói thật — lùi về khung im gần nhất cho đường cắt sạch. */
function turnChange(sides, limit) {
  let current = null;
  for (let f = 0; f < limit; f++) {
    const s = sides[f];
    if (s === null) continue;
    if (current === null) { current = s; continue; }
    if (s === current) continue;
    let same = 0;
    for (let g = f; g < Math.min(f + TURN_CONFIRM_FRAMES, sides.length); g++) if (sides[g] === s) same++;
    if (same < TURN_CONFIRM_FRAMES * 0.8) continue;
    if (f < MIN_TURN_FRAMES) { current = s; continue; }
    for (let b = f - 1; b > f - 10 && b > 0; b--) if (sides[b] === null) return b + 1;
    return f;
  }
  return null;
}

/** Bên nói chính của đoạn: một bên chiếm ≥ 70 % khung có tiếng, không thì `null` (cả hai cùng nói / xen kẽ nhanh). */
function majoritySide(sides, from, to) {
  const count = [0, 0];
  for (let f = from; f < to; f++) if (sides[f] !== null) count[sides[f]]++;
  const total = count[0] + count[1];
  if (!total) return null;
  if (count[0] / total >= 0.7) return 0;
  if (count[1] / total >= 0.7) return 1;
  return null;
}

/**
 * Các đoạn cần chuyển chữ của bản ghi — `[{ start, end, silent?, speaker? }]` (giây). Đọc dần (không nạp cả tệp hàng trăm MB).
 * Hai nguồn + `labels` (`[âm thanh máy, micro]`): cắt thêm ở chỗ đổi lượt nói giữa hai bên và gắn `speaker` = nhãn của bên nói chính.
 */
export function planChunks({ sources, chunkSec = CHUNK_SEC, labels = null }) {
  const total = Math.max(...sources.map((s) => s.samples), 0);
  const chunk = chunkSec * SAMPLE_RATE;
  const win = CUT_WINDOW_SEC * SAMPLE_RATE;
  const bySpeaker = !!labels && sources.length === 2;
  const chunks = [];
  let pos = 0;
  while (pos < total) {
    const want = Math.min(chunk + win, total - pos);
    const parts = sources.map((s) => s.read(pos, want));
    const mixed = parts.reduce((acc, p) => mix(acc, p), new Int16Array(want));
    let cut = pos + want >= total ? want : quietestCut(mixed, Math.max(FRAME, chunk - win), want);
    let speaker;
    if (bySpeaker) {
      const sides = frameSides(parts, Math.floor(want / FRAME));
      const turn = turnChange(sides, Math.floor(cut / FRAME));
      if (turn !== null) cut = turn * FRAME;
      const side = majoritySide(sides, 0, Math.floor(cut / FRAME));
      speaker = side === null ? null : labels[side];
    }
    const silent = rms(mixed, 0, cut) < SILENCE_RMS;
    chunks.push({ start: pos / SAMPLE_RATE, end: (pos + cut) / SAMPLE_RATE, silent, ...(bySpeaker && !silent ? { speaker } : {}) });
    pos += Math.max(cut, FRAME);
  }
  return chunks;
}

const readMixed = (sources, start, end) => {
  const from = Math.round(start * SAMPLE_RATE);
  const count = Math.round((end - start) * SAMPLE_RATE);
  return sources.reduce((acc, s) => mix(acc, s.read(from, count)), new Int16Array(count));
};

/**
 * Chuyển chữ cả bản ghi. `stt(wavBuffer) → { ok, text?, error? }` (lỗi mạng thì ném). `onProgress({ done, total })`. Trả các đoạn có chữ
 * `[{ start, end, text }]` và đoạn hỏng `failed: [{ start, end, error }]`. `signal` huỷ giữa chừng (giữ phần đã xong).
 */
export async function transcribeRecording({ files, stt, onProgress = () => {}, signal, retries = 2, chunkSec = CHUNK_SEC, labels = null }) {
  const sources = files.map(openWav);
  try {
    const plan = planChunks({ sources, chunkSec, labels });
    const speech = plan.filter((c) => !c.silent);
    const segments = [];
    const failed = [];
    let done = 0;
    const run = async (start, end, speaker) => {
      let lastError = 'failed';
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal?.aborted) return;
        let res;
        try {
          res = await stt(wavBuffer(readMixed(sources, start, end)));
        } catch (e) {
          lastError = e?.message || String(e);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        if (res?.ok) {
          const text = String(res.text || '').trim();
          if (text) segments.push({ start, end, text, ...(speaker ? { speaker } : {}) });
          return;
        }
        lastError = res?.error || 'failed';
        if (lastError === 'audio_too_big' && end - start > MIN_SPLIT_SEC * 2) {
          const mid = (start + end) / 2;
          await run(start, mid, speaker);
          await run(mid, end, speaker);
          return;
        }
        if (lastError === 'not_understood' || lastError === 'empty') return; // đoạn không có lời nói
      }
      failed.push({ start, end, error: lastError });
    };
    for (const c of speech) {
      if (signal?.aborted) break;
      await run(c.start, c.end, c.speaker);
      done++;
      onProgress({ done, total: speech.length });
    }
    segments.sort((a, b) => a.start - b.start);
    return { segments, failed, chunks: speech.length, seconds: Math.max(...sources.map((s) => s.samples), 0) / SAMPLE_RATE };
  } finally {
    for (const s of sources) s.close();
  }
}

export function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Nhãn người nói trong biên bản: `me` = chủ máy (micro), `others` = người khác (âm thanh máy). */
export const Speaker = Object.freeze({ ME: 'me', OTHERS: 'others' });
const speakerName = (key, vi) => (key === Speaker.ME ? (vi ? 'Chủ máy' : 'Me') : vi ? 'Người khác' : 'Others');

/** Biên bản Markdown: mốc thời gian + lời nói, ảnh màn hình chen đúng chỗ, đoạn không chuyển được ghi rõ. */
export function formatTranscript({ title, startedAt, seconds, segments, failed = [], screens = [], lang = 'vi' }) {
  const vi = lang !== 'en';
  const rows = [
    ...segments.map((s) => ({ at: s.start, line: `**[${clock(s.start)}]** ${s.speaker ? `**${speakerName(s.speaker, vi)}:** ` : ''}${s.text}` })),
    ...screens.map((f) => ({ at: f.secs, line: `**[${clock(f.secs)}]** _(${vi ? 'ảnh màn hình' : 'screenshot'}: screens/${f.file})_` })),
    ...failed.map((f) => ({ at: f.start, line: `**[${clock(f.start)}–${clock(f.end)}]** _(${vi ? 'không chuyển được đoạn này thành chữ' : 'this part could not be transcribed'}: ${f.error})_` })),
  ].sort((a, b) => a.at - b.at);
  const when = startedAt ? new Date(startedAt) : null;
  const head = [
    `# ${title || (vi ? 'Cuộc họp' : 'Meeting')}`,
    '',
    `- ${vi ? 'Bắt đầu' : 'Started'}: ${when ? when.toLocaleString(vi ? 'vi-VN' : 'en-US') : '?'}`,
    `- ${vi ? 'Thời lượng' : 'Duration'}: ${clock(seconds)}`,
    `- ${vi ? 'Nguồn' : 'Source'}: ${vi ? 'âm thanh máy (người khác) + micro (chủ máy), chuyển chữ tự động — có thể sai tên riêng / số; nhãn người nói theo micro / loa, không tách từng người khác nhau' : "computer sound (others) + microphone (owner), automatic transcription — names / numbers may be wrong; speaker labels come from mic vs. speaker, the others are not told apart"}`,
    '',
    '---',
    '',
  ];
  return `${head.join('\n')}${rows.length ? rows.map((r) => r.line).join('\n\n') : vi ? '_(Không có lời nói nào được ghi lại.)_' : '_(No speech was recorded.)_'}\n`;
}
