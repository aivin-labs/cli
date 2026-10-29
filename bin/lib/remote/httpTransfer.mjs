import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { DEVICE_API_PREFIX, DeviceErrorCode, ToolGroup } from './constants.mjs';
import { DeviceToolError, displayPath, resolveInRoots } from './sandbox.mjs';

/** Header token thiết bị BE đòi ở đường chuyển tệp (be `DEVICE_TOKEN_HEADER`). */
const DEVICE_TOKEN_HEADER = 'x-aivin-device-token';
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const PART_RETRIES = 2;

/**
 * Tệp lớn hơn trần socket đi HTTP thẳng giữa máy và kho Aivin (be DeviceDirectTransferService). Chỉ BE gọi (internal, Planner không thấy):
 * BE cấp VÉ dùng một lần; CLI tự ghép địa chỉ từ máy chủ đang nối + vé — không bao giờ nhận URL từ BE, nên lời gọi không thể đẩy tệp ra
 * nơi khác. Đường dẫn trên máy vẫn kiểm theo thư mục được phép (resolveInRoots, chặn ~/.aivin).
 */
export function buildTransferTools({ serverUrl, deviceToken }) {
  const urlOf = (ticket, part) => {
    if (!TICKET_RE.test(String(ticket || ''))) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Invalid transfer ticket');
    return `${String(serverUrl).replace(/\/+$/, '')}${DEVICE_API_PREFIX}/transfers/${ticket}${part === undefined ? '' : `?part=${part}`}`;
  };
  // `deviceToken` là hàm khi daemon có thể xoay vòng token lúc đang chạy — mỗi yêu cầu lấy token hiện hành.
  const headers = (extra = {}) => ({ [DEVICE_TOKEN_HEADER]: typeof deviceToken === 'function' ? deviceToken() : deviceToken, ...extra });

  async function upload(args, ctx, env) {
    if (env.runAs) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Direct transfer is not available on a shared computer');
    const abs = resolveInRoots(env.roots, args.path || '');
    const size = (await fs.promises.stat(abs)).size;
    const partBytes = Number(args.part_bytes);
    const parts = Number(args.parts);
    if (size !== Number(args.size)) throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `File changed before copying (${size} bytes, expected ${args.size}) — try again`);
    if (!Number.isInteger(parts) || parts < 1 || !(partBytes > 0)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Invalid parts');
    for (let i = 0; i < parts; i++) {
      const start = i * partBytes;
      const length = i < parts - 1 ? partBytes : size - start;
      await withRetries(() => putPart({ url: urlOf(args.ticket, i), abs, start, length, signal: ctx.signal, headers }), ctx.signal);
      ctx.onOutput?.(`uploaded ${Math.min(size, start + length)} / ${size} bytes\n`);
    }
    return { path: displayPath(env.roots, abs), bytes: size, parts };
  }

  async function download(args, ctx, env) {
    if (env.runAs) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Direct transfer is not available on a shared computer');
    const abs = resolveInRoots(env.roots, args.path || '');
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    const res = await axios.get(urlOf(args.ticket), { headers: headers(), signal: ctx.signal, responseType: 'stream', validateStatus: () => true });
    if (res.status !== 200) {
      res.data?.destroy?.();
      throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Download failed (HTTP ${res.status})`);
    }
    await pipeline(res.data, fs.createWriteStream(abs), { signal: ctx.signal });
    const bytes = (await fs.promises.stat(abs)).size;
    return { path: displayPath(env.roots, abs), bytes };
  }

  return [
    { name: 'fs.upload', group: ToolGroup.FS_READ, read_only: true, internal: true, handler: upload,
      description: 'BE-only: send a large file to Aivin in parts over HTTP with a one-time ticket.', input_schema: { type: 'object', properties: {} } },
    { name: 'fs.download', group: ToolGroup.FS_WRITE, internal: true, handler: download,
      description: 'BE-only: download a large Aivin file over HTTP with a one-time ticket into a temporary file.', input_schema: { type: 'object', properties: {} } },
  ];
}

/** Một khúc = một PUT có Content-Length cố định (BE đối chiếu cỡ khúc theo vé; stream từ đĩa, không nạp cả khúc vào RAM). */
async function putPart({ url, abs, start, length, signal, headers }) {
  const body = length ? fs.createReadStream(abs, { start, end: start + length - 1 }) : Buffer.alloc(0);
  const res = await axios.put(url, body, {
    signal, maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true,
    headers: headers({ 'content-type': 'application/octet-stream', 'content-length': String(length) }),
  });
  if (res.status < 200 || res.status >= 300) {
    const err = new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Upload failed (HTTP ${res.status})`);
    // Vé hết hạn / sai máy / sai khúc: thử lại cũng vô ích.
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
}

async function withRetries(fn, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || e?.retryable === false || attempt >= PART_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}
