import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';

/**
 * Nhận tệp người xem kéo thả / dán vào màn hình máy (Desktop Scenecast), đi peer-to-peer qua kênh WebRTC `aivin-desktop-files`.
 * Không phải "thả vào ứng dụng" thật (trình duyệt không giả lập được thao tác thả OLE): tệp lưu vào thư mục Tải về, Explorer mở chọn sẵn tệp cuối.
 * Chỉ nhận lúc được thao tác (`checkAllowed` — chủ máy chưa tạm dừng, AI không đang bấm). Không ghi đè tệp có sẵn; gắn Mark-of-the-Web để
 * Windows cảnh báo như tệp tải từ Internet khi mở. Giới hạn bộ nhớ nằm ở phía gửi: chỉ gửi tiếp khi máy đã báo ghi xong (`ack`).
 *
 * Người xem → máy: `begin {id, name, size}` · khúc nhị phân · `end {id, reveal}` · `cancel {id}`.
 * Máy → người xem: `accepted {id}` · `ack {id, bytes}` · `saved {id, name, path}` · `rejected {id, reason}` · `failed {id, reason}`.
 */

export const FileDropReason = Object.freeze({
  PAUSED: 'paused',
  AI_ACTIVE: 'ai_active',
  INVALID: 'invalid',
  TOO_LARGE: 'too_large',
  NO_SPACE: 'no_space',
  TIMEOUT: 'timeout',
  WRITE_FAILED: 'write_failed',
});

export const MAX_DROP_BYTES = 8 * 1024 ** 3;
const DEFAULT_DIR = path.join(os.homedir(), 'Downloads');
const ACK_EVERY_BYTES = 256 * 1024;
const IDLE_TIMEOUT_MS = 60_000;
/** Chừa lại khi kiểm chỗ trống: ổ đầy sát nút làm Windows và ứng dụng khác lỗi theo. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 ** 2;
const MAX_NAME_CHARS = 200;
const MAX_ID_CHARS = 64;
const PART_PREFIX = '.aivin-drop-';
const STALE_PART_MS = 24 * 60 * 60 * 1000;
const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n';

/** Tên tệp an toàn trên Windows: bỏ đường dẫn, ký tự cấm, ký tự đảo chiều (giả đuôi `gpj.exe`), tên thiết bị. */
export function safeDropName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[‪-‮⁦-⁩]/g, '').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  if (name.length > MAX_NAME_CHARS) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return name;
}

/** Giữ chỗ tên còn trống bằng tạo tệp độc quyền (`wx`) rồi mới đổi tên đè lên — không có khoảng hở để ghi đè tệp của người khác. */
async function reserveName(dir, name) {
  const { name: stem, ext } = path.parse(name);
  for (let n = 0; n < 1000; n++) {
    const dest = path.join(dir, n ? `${stem} (${n})${ext}` : name);
    try {
      await (await fs.promises.open(dest, 'wx')).close();
      return dest;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('No free file name');
}

async function removeStaleParts(dir, now) {
  const names = await fs.promises.readdir(dir).catch(() => []);
  await Promise.all(names.filter((n) => n.startsWith(PART_PREFIX) && n.endsWith('.part')).map(async (n) => {
    const file = path.join(dir, n);
    const st = await fs.promises.stat(file).catch(() => null);
    if (st && now() - st.mtimeMs > STALE_PART_MS) await fs.promises.rm(file, { force: true }).catch(() => undefined);
  }));
}

/** Mở Explorer chọn sẵn tệp vừa nhận: người xem thấy trên màn hình và kéo tiếp vào ứng dụng đích. Không chạy tệp. */
export function revealInExplorer(file, spawnImpl = spawn) {
  try {
    // Explorer tự tách `/select,"…"`, không theo cách Node đặt ngoặc kép cho cả tham số.
    const child = spawnImpl('explorer.exe', [`/select,"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.on?.('error', () => {});
    child.unref?.();
  } catch { /* không mở được thì tệp vẫn đã lưu, FE báo đường dẫn */ }
}

/**
 * Thả nhiều tệp là một thao tác: gom theo lô của từng người xem, tệp cuối tới thì trả cả lô. Lô mới thay lô dở (một tệp giữa chừng bị hỏng).
 */
export function createDropBatches({ maxFiles = 200 } = {}) {
  const open = new Map();
  return {
    add({ viewerId, batch, path: file, last }) {
      const current = open.get(viewerId);
      const paths = current?.batch === batch ? current.paths : [];
      if (paths.length < maxFiles) paths.push(file);
      if (last) {
        open.delete(viewerId);
        return paths;
      }
      open.set(viewerId, { batch, paths });
      return null;
    },
  };
}

export function createCastFileDrop({
  dir = DEFAULT_DIR, reply = () => {}, checkAllowed = () => null, onSaved = () => {},
  maxBytes = MAX_DROP_BYTES, idleMs = IDLE_TIMEOUT_MS, statfs = fs.promises.statfs, now = Date.now,
} = {}) {
  /** Mỗi người xem một lần gửi; mọi bước đi tuần tự theo `queue` — khúc tới trong lúc đang ghi / đang mở tệp phải chờ. */
  const viewers = new Map();
  const stateOf = (viewerId) => {
    if (!viewers.has(viewerId)) viewers.set(viewerId, { queue: Promise.resolve(), active: null });
    return viewers.get(viewerId);
  };
  const enqueue = (viewerId, step) => {
    const state = stateOf(viewerId);
    state.queue = state.queue.then(() => step(state)).catch(() => undefined);
    return state.queue;
  };

  async function discard(state) {
    const active = state.active;
    if (!active) return;
    state.active = null;
    clearTimeout(active.timer);
    await active.handle.close().catch(() => undefined);
    await fs.promises.rm(active.part, { force: true }).catch(() => undefined);
  }

  async function fail(viewerId, state, reason) {
    const id = state.active?.id;
    await discard(state);
    if (id) reply(viewerId, { t: 'failed', id, reason });
  }

  function touch(viewerId, state) {
    const active = state.active;
    clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      void enqueue(viewerId, (s) => (s.active === active ? fail(viewerId, s, FileDropReason.TIMEOUT) : undefined));
    }, idleMs);
    active.timer.unref?.();
  }

  async function hasRoom(size) {
    try {
      const st = await statfs(dir);
      return Number(st.bavail) * Number(st.bsize) >= size + FREE_SPACE_MARGIN_BYTES;
    } catch {
      return true; // Không đo được (Bun bản cũ, ổ lạ): cứ ghi, đầy thì lỗi ghi báo sau.
    }
  }

  async function begin(viewerId, state, msg) {
    const id = typeof msg.id === 'string' && msg.id && msg.id.length <= MAX_ID_CHARS ? msg.id : null;
    if (!id) return;
    const rejected = (reason) => reply(viewerId, { t: 'rejected', id, reason });
    // Lần gửi trước chưa xong mà người xem đã gửi mới: họ vừa nối lại, không còn ai chờ tệp dở kia.
    await discard(state);
    const size = Number(msg.size);
    if (!Number.isSafeInteger(size) || size < 0 || typeof msg.name !== 'string') return rejected(FileDropReason.INVALID);
    if (size > maxBytes) return rejected(FileDropReason.TOO_LARGE);
    const blocked = checkAllowed();
    if (blocked) return rejected(blocked);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      if (!await hasRoom(size)) return rejected(FileDropReason.NO_SPACE);
      await removeStaleParts(dir, now);
      const part = path.join(dir, `${PART_PREFIX}${randomBytes(8).toString('hex')}.part`);
      const handle = await fs.promises.open(part, 'wx');
      state.active = { id, name: safeDropName(msg.name), size, part, handle, written: 0, ackedAt: 0, timer: null };
    } catch {
      return rejected(FileDropReason.WRITE_FAILED);
    }
    touch(viewerId, state);
    reply(viewerId, { t: 'accepted', id });
  }

  async function writeChunk(viewerId, state, chunk) {
    const active = state.active;
    if (!active) return; // Khúc còn trên đường của lần đã huỷ.
    const blocked = checkAllowed();
    if (blocked) return fail(viewerId, state, blocked);
    if (active.written + chunk.length > active.size) return fail(viewerId, state, FileDropReason.INVALID);
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await active.handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
    } catch (e) {
      return fail(viewerId, state, e?.code === 'ENOSPC' ? FileDropReason.NO_SPACE : FileDropReason.WRITE_FAILED);
    }
    active.written += chunk.length;
    touch(viewerId, state);
    if (active.written - active.ackedAt >= ACK_EVERY_BYTES) {
      active.ackedAt = active.written;
      reply(viewerId, { t: 'ack', id: active.id, bytes: active.written });
    }
  }

  async function end(viewerId, state, msg) {
    const active = state.active;
    if (!active || msg.id !== active.id) return;
    if (active.written !== active.size) return fail(viewerId, state, FileDropReason.INVALID);
    state.active = null;
    clearTimeout(active.timer);
    let dest = null;
    try {
      await active.handle.close();
      dest = await reserveName(dir, active.name);
      await fs.promises.rename(active.part, dest);
    } catch {
      await active.handle.close().catch(() => undefined);
      await fs.promises.rm(active.part, { force: true }).catch(() => undefined);
      if (dest) await fs.promises.rm(dest, { force: true }).catch(() => undefined);
      return reply(viewerId, { t: 'failed', id: active.id, reason: FileDropReason.WRITE_FAILED });
    }
    // Ổ không phải NTFS không có luồng phụ: bỏ qua, tệp vẫn nhận xong.
    if (process.platform === 'win32') await fs.promises.writeFile(`${dest}:Zone.Identifier`, ZONE_IDENTIFIER).catch(() => undefined);
    reply(viewerId, { t: 'saved', id: active.id, name: path.basename(dest), path: dest });
    onSaved({
      viewerId,
      path: dest,
      name: path.basename(dest),
      bytes: active.size,
      reveal: msg.reveal === true && !msg.paste,
      paste: msg.paste === true,
      image: msg.image === true,
      drop: msg.drop === true,
      batch: typeof msg.batch === 'string' ? msg.batch.slice(0, MAX_ID_CHARS) : '',
      last: msg.last === true,
      x: msg.x,
      y: msg.y,
      rx: msg.rx,
      ry: msg.ry,
    });
  }

  function message(viewerId, msg) {
    if (msg?.t === 'begin') return enqueue(viewerId, (s) => begin(viewerId, s, msg));
    if (msg?.t === 'end') return enqueue(viewerId, (s) => end(viewerId, s, msg));
    if (msg?.t === 'cancel') return enqueue(viewerId, (s) => (s.active?.id === msg.id ? discard(s) : undefined));
    return undefined;
  }

  const chunk = (viewerId, data) => enqueue(viewerId, (s) => writeChunk(viewerId, s, data));

  /** Người xem rời: bỏ tệp dở. Không còn ai nhận tin nên không báo. */
  function close(viewerId) {
    if (!viewers.has(viewerId)) return Promise.resolve();
    const done = enqueue(viewerId, (s) => discard(s));
    viewers.delete(viewerId);
    return done;
  }

  const closeAll = () => Promise.all([...viewers.keys()].map(close));

  return { message, chunk, close, closeAll };
}
