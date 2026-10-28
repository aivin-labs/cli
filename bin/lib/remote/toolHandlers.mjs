import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { DeviceErrorCode, IGNORED_DIRS, MemoryKind, ToolGroup } from './constants.mjs';
import {
  DeviceToolError, assertCommandAllowed, containsProtectedPath, displayPath, isProtectedPath, isRootPath, protectedDirNamesUnder,
  resolveEntryInRoots, resolveInRoots, scrubEnv,
} from './sandbox.mjs';
import { deleteMemoryItems, getMemoryItem, listMemoryItems, putMemoryItems, searchMemory } from './deviceMemory.mjs';
import { extractDocText, isDocFile } from './docText.mjs';
import { showOSNotification } from './notify.mjs';
import { accountEnv, withProcessCap } from './multiUser.mjs';
import { buildGuiTools } from './gui/index.mjs';
import { buildOfficeTools } from './office/index.mjs';
import { measurePath } from './undoStore.mjs';
import { buildProcessTools, shellCommand } from './processes.mjs';
import { buildScheduleTools } from './schedule.mjs';
import { buildWatchTools } from './deviceWatches.mjs';

/**
 * Công cụ trên máy, chia gói theo năng lực phát hiện được (git chỉ có khi máy cài git, tìm nội dung dùng ripgrep nếu có…). Mỗi công cụ
 * tự khai: schema tham số, chỉ đọc / có tác dụng phụ / không hoàn tác, nhóm song song, khoá đường dẫn khi ghi. Công cụ `internal` chỉ BE
 * gọi trực tiếp (tra ngữ cảnh, lưu ghi nhớ) — không đưa vào danh mục của Planner.
 *
 * `env` = { roots, binaries, fileIndex, projects, runAs?, memory?, browserTunnels?, gui?, office?, undo? }. `undo` (kho hoàn tác, undoStore.mjs)
 * vắng (máy tính tổ chức — công cụ tệp chạy dưới tài khoản thành viên) thì ghi / xoá như cũ, không lấy lại được. `ctx` = { signal, onOutput, timeoutMs }. Máy tính tổ chức
 * (`--multi-user`): mỗi lời gọi một `env` riêng của thành viên — `runAs` (tài khoản Linux chạy lệnh), `memory` (bộ nhớ của vùng), xem
 * multiUser.mjs.
 */

const DEFAULT_MEMORY = { search: searchMemory, get: getMemoryItem, list: listMemoryItems, delete: deleteMemoryItems, put: putMemoryItems };
const memoryOf = (env) => env?.memory || DEFAULT_MEMORY;

const DEFAULT_READ_LINES = 1000;
const MAX_READ_LINES = 5000;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 2000;
/** Trần một lần thao tác hàng loạt (fs.move_many / fs.delete_many). */
const MAX_BATCH_ITEMS = 1000;
const BATCH_CONCURRENCY = 8;
const GREP_CONCURRENCY = 16;

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

function requireArg(value, name) {
  if (value === undefined || value === null || value === '') throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Missing argument: ${name}`);
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled');
}

// ── fs ──────────────────────────────────────────────────────────────────────────────────────────

async function looksBinary(abs) {
  const handle = await fs.promises.open(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Đọc theo khoảng dòng bằng luồng — tệp lớn không phải nạp cả vào RAM. */
async function readLines(abs, startLine, endLine, signal) {
  const stream = fs.createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let n = 0;
  let bytes = 0;
  let truncatedByBytes = false;
  try {
    for await (const line of rl) {
      n++;
      if (n < startLine) continue;
      if (n > endLine) break;
      bytes += line.length + 1;
      if (bytes > MAX_READ_BYTES) { truncatedByBytes = true; break; }
      lines.push(line);
      if (signal?.aborted) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  throwIfAborted(signal);
  return { lines, lastLine: startLine + lines.length - 1, truncatedByBytes };
}

async function fsRead(args, ctx, env) {
  const abs = resolveInRoots(env.roots, requireArg(args.path, 'path'));
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `File not found: ${args.path}`);
  if (stat.isDirectory()) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Is a directory: ${args.path} (use fs.list)`);
  if (args.byteOffset !== undefined || args.byteLength !== undefined || args.encoding === 'base64') {
    const offset = Math.max(0, Number(args.byteOffset) || 0);
    const length = Math.min(Math.max(0, Number(args.byteLength) || 64 * 1024), MAX_READ_BYTES, Math.max(0, stat.size - offset));
    const handle = await fs.promises.open(abs, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return { path: displayPath(env.roots, abs), size: stat.size, byteOffset: offset, byteLength: bytesRead, encoding: args.encoding === 'base64' ? 'base64' : 'utf8', content: buf.subarray(0, bytesRead).toString(args.encoding === 'base64' ? 'base64' : 'utf8'), eof: offset + bytesRead >= stat.size };
    } finally {
      await handle.close();
    }
  }
  if (await looksBinary(abs)) {
    return { path: displayPath(env.roots, abs), size: stat.size, binary: true, hint: 'Binary file — read ranges with byteOffset/byteLength and encoding "base64".' };
  }
  const startLine = Math.max(1, Number(args.startLine) || 1);
  const endLine = Math.min(Number(args.endLine) || startLine + DEFAULT_READ_LINES - 1, startLine + MAX_READ_LINES - 1);
  const { lines, lastLine, truncatedByBytes } = await readLines(abs, startLine, endLine, ctx.signal);
  const hasMore = truncatedByBytes || lines.length === endLine - startLine + 1;
  return {
    path: displayPath(env.roots, abs), size: stat.size, startLine, endLine: lastLine, content: lines.join('\n'),
    ...(hasMore ? { hint: `More may follow — continue with startLine: ${lastLine + 1}` } : {}),
  };
}

async function fsReadMany(args, ctx, env) {
  const paths = (Array.isArray(args.paths) ? args.paths : []).slice(0, 20);
  if (!paths.length) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Missing argument: paths');
  const lines = Math.min(Number(args.maxLines) || 400, MAX_READ_LINES);
  const files = await Promise.all(paths.map(async (p) => {
    try { return { ok: true, ...(await fsRead({ path: p, startLine: 1, endLine: lines }, ctx, env)) }; } catch (e) { return { ok: false, path: p, error: e.message }; }
  }));
  return { files };
}

const DAY_MS = 86_400_000;

/** Mốc thời gian lọc: ngày ISO ("2026-10-01") hoặc số ngày trước ("30" = 30 ngày trước). */
function timeBound(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(String(value))) return Date.now() - Number(value) * DAY_MS;
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Bad date: ${value}`);
  return t;
}

/** Mẫu tên kiểu *.pdf / bao-cao* → RegExp (không phân biệt hoa thường). */
function nameMatcher(pattern) {
  if (!pattern) return null;
  const re = String(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Liệt kê thư mục; có lọc (đuôi, mẫu tên, ngày sửa, dung lượng, chỉ tệp) và sắp xếp (tên / ngày sửa / dung lượng) → "PDF trong Downloads cũ
 * hơn 30 ngày, lớn nhất trước" trong MỘT lời gọi, không phải đọc hết danh sách rồi tự lọc.
 */
async function fsList(args, ctx, env) {
  const abs = resolveInRoots(env.roots, args.path || '');
  const maxDepth = args.recursive ? Math.min(Number(args.maxDepth) || 3, 8) : 0;
  const limit = Math.min(Number(args.maxEntries) || 500, MAX_LIST_ENTRIES);
  const exts = (Array.isArray(args.ext) ? args.ext : String(args.ext || '').split(',')).map((x) => String(x).trim().toLowerCase().replace(/^\.?/, '.')).filter((x) => x.length > 1);
  const name = nameMatcher(args.name);
  const after = timeBound(args.modifiedAfter);
  const before = timeBound(args.modifiedBefore);
  const minSize = Number(args.minSize) || 0;
  const maxSize = Number(args.maxSize) || Infinity;
  const filtered = !!(exts.length || name || after || before || minSize || maxSize !== Infinity || args.filesOnly);
  const needStat = filtered || ['modified', 'size'].includes(args.sort);
  // Lọc / sắp xếp cần xét nhiều hơn số trả về — quét tối đa 20 lần trần.
  const scanLimit = filtered || args.sort ? limit * 20 : limit;
  const out = [];
  let scanned = 0;
  const queue = [[abs, 0]];
  while (queue.length && scanned < scanLimit) {
    throwIfAborted(ctx.signal);
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { if (dir === abs) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, e.message); continue; }
    for (const e of entries) {
      if (scanned >= scanLimit) break;
      const full = path.join(dir, e.name);
      // Thư mục cấu hình Aivin (token) nằm dưới gốc được phép (vd `--dir ~`) → không liệt kê, không đi vào.
      if (isProtectedPath(full)) continue;
      scanned++;
      const isDir = e.isDirectory();
      if (isDir && depth < maxDepth && !IGNORED_DIRS.has(e.name) && !e.isSymbolicLink()) queue.push([full, depth + 1]);
      if (args.filesOnly && isDir) continue;
      if (exts.length && (isDir || !exts.includes(path.extname(e.name).toLowerCase()))) continue;
      if (name && !name.test(e.name)) continue;
      const item = { path: displayPath(env.roots, full), dir: isDir || undefined };
      if (needStat) {
        const st = await fs.promises.lstat(full).catch(() => null);
        if (!st) continue;
        if ((after && st.mtimeMs < after) || (before && st.mtimeMs > before)) continue;
        if (!isDir && (st.size < minSize || st.size > maxSize)) continue;
        if (isDir && (minSize || maxSize !== Infinity)) continue;
        item.size = isDir ? undefined : st.size;
        item.modified = st.mtime.toISOString().slice(0, 10);
        item._mtime = st.mtimeMs;
      }
      out.push(item);
    }
  }
  const dirn = args.order === 'asc' ? 1 : args.order === 'desc' ? -1 : (args.sort === 'name' ? 1 : -1);
  if (args.sort === 'modified') out.sort((a, b) => dirn * ((a._mtime || 0) - (b._mtime || 0)));
  else if (args.sort === 'size') out.sort((a, b) => dirn * ((a.size || 0) - (b.size || 0)));
  else if (args.sort === 'name') out.sort((a, b) => dirn * a.path.localeCompare(b.path));
  const entries = out.slice(0, limit).map((e) => { const item = { ...e }; delete item._mtime; return item; });
  return {
    base: displayPath(env.roots, abs), total: entries.length, matched: out.length,
    truncated: out.length > limit || scanned >= scanLimit || undefined, entries,
  };
}

function fsFind(args, _ctx, env) {
  if (!env.fileIndex) throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, 'File index not ready');
  // `vector`: BE tự gắn vector bge-m3 của câu hỏi (Planner chỉ viết query) → gộp xếp hạng ngữ nghĩa.
  return { results: env.fileIndex.search(requireArg(args.query, 'query'), Math.min(Number(args.limit) || 15, 100), args.vector), stats: env.fileIndex.stats() };
}

const PREVIEW_MAX_PATHS = 10;
const PREVIEW_CHARS = 800;

/** Xem trước nhiều tệp một lần: dung lượng, ngày sửa, đoạn chữ đầu (đọc cả docx/xlsx/pptx) — để chọn đúng tệp giữa các ứng viên. */
async function fsPreview(args, ctx, env) {
  const paths = (Array.isArray(args.paths) ? args.paths : []).slice(0, PREVIEW_MAX_PATHS);
  if (!paths.length) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Missing argument: paths');
  const chars = Math.min(Number(args.maxChars) || PREVIEW_CHARS, 4000);
  const files = await Promise.all(paths.map(async (p) => {
    try {
      const abs = resolveInRoots(env.roots, p);
      const stat = await fs.promises.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) return { path: p, exists: !!stat, dir: stat?.isDirectory() || undefined };
      const base = { path: displayPath(env.roots, abs), exists: true, size: stat.size, modified: stat.mtime.toISOString().slice(0, 10) };
      if (isDocFile(abs)) return { ...base, preview: await extractDocText(abs, stat.size, chars) };
      if (await looksBinary(abs)) return { ...base, binary: true };
      const { lines } = await readLines(abs, 1, 40, ctx.signal);
      const text = lines.join('\n');
      return { ...base, preview: text.length > chars ? `${text.slice(0, chars)}…` : text };
    } catch (e) {
      return { path: p, error: e.message };
    }
  }));
  return { files };
}

function runProcess(cmd, argv, { cwd, signal, onOutput, env, maxOutput = MAX_EXEC_OUTPUT, shell = false, runAs }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const baseEnv = env || scrubEnv();
    const account = runAs ? { uid: runAs.uid, gid: runAs.gid } : {};
    // Thành viên máy tính tổ chức: trần số tiến trình theo uid (prlimit) — một người không fork bomb được cả container.
    if (runAs) [cmd, argv] = withProcessCap(cmd, argv);
    const child = spawn(cmd, argv, { cwd, env: runAs ? accountEnv(runAs, baseEnv) : baseEnv, windowsHide: true, shell, detached: process.platform !== 'win32', ...account });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const killTree = () => {
      if (killed || child.exitCode !== null) return;
      killed = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const onAbort = () => killTree();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { const t = chunk.toString(); if (stdout.length < maxOutput) stdout += t; onOutput?.('stdout', t); });
    child.stderr.on('data', (chunk) => { const t = chunk.toString(); if (stderr.length < maxOutput) stderr += t; onOutput?.('stderr', t); });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `Cannot start process: ${e.message}`)); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason || new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled'));
      resolve({ exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - startedAt, ...(stdout.length >= maxOutput || stderr.length >= maxOutput ? { outputTruncated: true } : {}) });
    });
  });
}

async function fsGrep(args, ctx, env) {
  const query = String(requireArg(args.query, 'query'));
  const abs = resolveInRoots(env.roots, args.path || '');
  const maxResults = Math.min(Number(args.maxResults) || 50, 500);
  if (env.binaries?.includes('rg')) {
    // Loại thư mục cấu hình Aivin kể cả khi bật tìm tệp ẩn; lọc lại kết quả phía dưới phòng khi glob của người gọi lách được.
    const exclude = protectedDirNamesUnder(abs).flatMap((name) => ['-g', `!${name}`]);
    // Chuỗi tìm do AI gửi luôn đi sau `-e` (không bao giờ thành cờ của ripgrep — `--pre=<chương trình>` từng chạy được chương trình ngoài
    // từ một công cụ chỉ đọc, rà 28/10/2026), đường dẫn sau `--`.
    const argv = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '5', '--max-filesize', '2M', ...(args.regex ? [] : ['-F']), '-e', query, ...(args.glob ? ['-g', String(args.glob)] : []), ...exclude, '--', abs];
    const res = await runProcess('rg', argv, { cwd: abs, signal: ctx.signal, maxOutput: 512 * 1024, runAs: env.runAs });
    const matches = res.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      if (m && isProtectedPath(path.resolve(abs, m[1]))) return null;
      return m ? { path: displayPath(env.roots, m[1]), line: Number(m[2]), text: m[3].slice(0, 300) } : { text: line.slice(0, 300) };
    }).filter(Boolean).slice(0, maxResults);
    return { engine: 'ripgrep', total: matches.length, matches };
  }
  // Không có ripgrep (đa số máy Windows): đọc SONG SONG theo từng thư mục (trước đây đọc tuần tự từng tệp — chậm trên cây lớn).
  const re = args.regex ? new RegExp(query) : null;
  const glob = nameMatcher(args.glob);
  const matches = [];
  const scanFile = async (full) => {
    if (matches.length >= maxResults) return;
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat || stat.size > 2 * 1024 * 1024) return;
    const text = await fs.promises.readFile(full, 'utf8').catch(() => '');
    if (text.includes('\u0000')) return;
    text.split(/\r?\n/).some((line, i) => {
      if (re ? re.test(line) : line.includes(query)) matches.push({ path: displayPath(env.roots, full), line: i + 1, text: line.trim().slice(0, 300) });
      return matches.length >= maxResults;
    });
  };
  const queue = [abs];
  while (queue.length && matches.length < maxResults) {
    throwIfAborted(ctx.signal);
    const dir = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (isProtectedPath(full)) continue;
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name) && !e.isSymbolicLink()) queue.push(full); continue; }
      if (e.isFile() && (!glob || glob.test(e.name))) files.push(full);
    }
    for (let i = 0; i < files.length && matches.length < maxResults; i += GREP_CONCURRENCY) {
      await Promise.all(files.slice(i, i + GREP_CONCURRENCY).map(scanFile));
    }
  }
  return { engine: 'builtin', total: Math.min(matches.length, maxResults), matches: matches.slice(0, maxResults) };
}

async function fsInfo(args, _ctx, env) {
  const abs = resolveInRoots(env.roots, args.path || '');
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) return { path: displayPath(env.roots, abs), exists: false };
  return { path: displayPath(env.roots, abs), exists: true, dir: stat.isDirectory(), size: stat.size, modifiedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString() };
}

/** Ghi lại thao tác vào kho hoàn tác của lời gọi (BE gắn `undo_group` = nhiệm vụ). Không có kho → null (ghi / xoá như cũ). */
const undoOf = (args, env, op) => (env.undo ? env.undo.begin(args.undo_group, op) : null);

async function fsWrite(args, _ctx, env) {
  const abs = resolveInRoots(env.roots, requireArg(args.path, 'path'));
  const exists = fs.existsSync(abs);
  if (exists && args.overwrite === false && !args.append) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `File exists and overwrite is false: ${args.path}`);
  const data = args.encoding === 'base64' ? Buffer.from(String(args.content ?? ''), 'base64') : String(args.content ?? '');
  // Ghi đè / nối thêm vào tệp có sẵn → lưu bản cũ trước (hoàn tác được); tệp mới → ghi lại để hoàn tác thì bỏ đi.
  const undo = undoOf(args, env, 'write');
  if (undo) await undo.ensureDir(path.dirname(abs));
  else await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const backup = exists ? await undo?.backupFile(abs) : undefined;
  if (args.append) await fs.promises.appendFile(abs, data);
  else await fs.promises.writeFile(abs, data);
  if (!exists) undo?.created(abs);
  undo?.commit();
  return {
    path: displayPath(env.roots, abs), bytes: Buffer.byteLength(data), created: !exists, appended: !!args.append || undefined,
    ...(exists && undo ? { previous_version_kept: !!backup } : {}),
  };
}

async function fsEdit(args, _ctx, env) {
  const abs = resolveInRoots(env.roots, requireArg(args.path, 'path'));
  const oldText = String(requireArg(args.oldText, 'oldText'));
  const newText = String(args.newText ?? '');
  const content = await fs.promises.readFile(abs, 'utf8').catch(() => { throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `File not found: ${args.path}`); });
  const count = content.split(oldText).length - 1;
  if (!count) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'oldText not found in file');
  if (count > 1 && !args.replaceAll) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `oldText occurs ${count} times — give more context or set replaceAll`);
  const undo = undoOf(args, env, 'edit');
  await undo?.backupFile(abs);
  await fs.promises.writeFile(abs, args.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText));
  undo?.commit();
  return { path: displayPath(env.roots, abs), replaced: args.replaceAll ? count : 1 };
}

/** Kiểm + chuyển một mục (dùng chung cho fs.move và fs.move_many). Đích có sẵn mà được phép đè → đích cũ vào thùng rác của kho trước. */
async function moveOne(env, undo, sourcePath, destinationPath, overwrite) {
  // Không theo symlink ở thành phần cuối: chuyển một liên kết là chuyển chính liên kết đó.
  const src = resolveEntryInRoots(env.roots, requireArg(sourcePath, 'sourcePath'));
  const dst = resolveEntryInRoots(env.roots, requireArg(destinationPath, 'destinationPath'));
  // Nguồn "" / "." là chính thư mục gốc — đổi tên gốc là mất cả vùng được phép.
  if (isRootPath(env.roots, src) || isRootPath(env.roots, dst)) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, 'Refusing to move or replace an allowed root folder');
  if (containsProtectedPath(src) || containsProtectedPath(dst)) throw new DeviceToolError(DeviceErrorCode.PROTECTED_PATH, 'Folder holds Aivin credentials and cannot be moved remotely');
  if (!fs.lstatSync(src, { throwIfNoEntry: false })) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Source not found: ${sourcePath}`);
  const dstExists = !!fs.lstatSync(dst, { throwIfNoEntry: false });
  if (dstExists && overwrite !== true) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Destination exists: ${destinationPath} (set overwrite to replace)`);
  if (undo) await undo.ensureDir(path.dirname(dst));
  else await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  if (dstExists) {
    if (undo) await undo.trash(dst);
    else await fs.promises.rm(dst, { recursive: true, force: true });
  }
  try {
    await fs.promises.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Khác ổ đĩa: chép rồi xoá bản gốc.
    await fs.promises.cp(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.promises.rm(src, { recursive: true, force: true });
  }
  undo?.moved(src, dst);
  return { from: displayPath(env.roots, src), to: displayPath(env.roots, dst), replaced: dstExists || undefined };
}

async function fsMove(args, _ctx, env) {
  const undo = undoOf(args, env, 'move');
  try { return await moveOne(env, undo, args.sourcePath, args.destinationPath, args.overwrite); } finally { undo?.commit(); }
}

/** Kiểm + xoá một mục: có kho → thùng rác của kho (hoàn tác được); không có / `permanent` → xoá hẳn. */
async function deleteOne(env, undo, target, permanent) {
  // Không theo symlink ở thành phần cuối: xoá liên kết là xoá chính liên kết, không xoá thư mục nó trỏ tới.
  const abs = resolveEntryInRoots(env.roots, requireArg(target, 'path'));
  if (isRootPath(env.roots, abs)) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, 'Refusing to delete an allowed root folder');
  if (containsProtectedPath(abs)) throw new DeviceToolError(DeviceErrorCode.PROTECTED_PATH, 'Folder holds Aivin credentials and cannot be deleted remotely');
  const stat = await fs.promises.lstat(abs).catch(() => null);
  if (!stat) return { path: displayPath(env.roots, abs), deleted: false };
  if (undo && !permanent) await undo.trash(abs);
  else await fs.promises.rm(abs, { recursive: stat.isDirectory(), force: true });
  return { path: displayPath(env.roots, abs), deleted: true, dir: stat.isDirectory() || undefined, recoverable: !!undo && !permanent };
}

async function fsDelete(args, _ctx, env) {
  const undo = undoOf(args, env, 'delete');
  try { return await deleteOne(env, undo, args.path, args.permanent === true); } finally { undo?.commit(); }
}

function batchItems(list, name) {
  if (!Array.isArray(list) || !list.length) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Missing argument: ${name}`);
  if (list.length > MAX_BATCH_ITEMS) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `At most ${MAX_BATCH_ITEMS} items per call — split the list`);
  return list;
}

/** Chạy từng mục với giới hạn song song; mục lỗi không chặn mục khác. */
async function runBatch(items, ctx, fn) {
  const done = [];
  const failed = [];
  for (let i = 0; i < items.length; i += BATCH_CONCURRENCY) {
    throwIfAborted(ctx.signal);
    const results = await Promise.all(items.slice(i, i + BATCH_CONCURRENCY).map(async (item) => {
      try { return { ok: true, value: await fn(item) }; } catch (e) { return { ok: false, item, error: e.message, code: e.code }; }
    }));
    for (const r of results) (r.ok ? done : failed).push(r.ok ? r.value : { item: r.item, error: r.error, code: r.code });
  }
  return { done, failed };
}

/**
 * Chuyển / đổi tên nhiều mục một lần (sắp xếp thư mục): một lời gọi, một lần duyệt, hoàn tác được cả lô. `dry_run` → chỉ kiểm (nguồn có,
 * đích trùng…) và trả kế hoạch, không đổi gì.
 */
async function fsMoveMany(args, ctx, env) {
  const moves = batchItems(args.moves, 'moves');
  if (args.dry_run) {
    const { done, failed } = await runBatch(moves, ctx, async (m) => {
      const src = resolveEntryInRoots(env.roots, requireArg(m?.from, 'from'));
      const dst = resolveEntryInRoots(env.roots, requireArg(m?.to, 'to'));
      if (!fs.lstatSync(src, { throwIfNoEntry: false })) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Source not found: ${m.from}`);
      if (fs.lstatSync(dst, { throwIfNoEntry: false }) && args.overwrite !== true) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Destination exists: ${m.to}`);
      return { from: displayPath(env.roots, src), to: displayPath(env.roots, dst) };
    });
    const folders = [...new Set(done.map((d) => path.dirname(d.to)))];
    return { dry_run: true, would_move: done.length, problems: failed, target_folders: folders.slice(0, 50), sample: done.slice(0, 20) };
  }
  const undo = undoOf(args, env, 'move_many');
  try {
    const { done, failed } = await runBatch(moves, ctx, (m) => moveOne(env, undo, m?.from, m?.to, args.overwrite));
    return { moved: done.length, failed, sample: done.slice(0, 20), recoverable: !!undo };
  } finally { undo?.commit(); }
}

async function fsDeleteMany(args, ctx, env) {
  const paths = batchItems(args.paths, 'paths');
  const undo = undoOf(args, env, 'delete_many');
  try {
    const { done, failed } = await runBatch(paths, ctx, (p) => deleteOne(env, undo, p, args.permanent === true));
    return { deleted: done.filter((d) => d.deleted).length, missing: done.filter((d) => !d.deleted).map((d) => d.path).slice(0, 50), failed, recoverable: !!undo && args.permanent !== true };
  } finally { undo?.commit(); }
}

/** Quy mô của các đường sắp xoá (số tệp, thư mục, dung lượng, vài tên) — BE đưa lên thẻ duyệt. */
async function fsMeasure(args, _ctx, env) {
  const paths = (Array.isArray(args.paths) ? args.paths : [args.path]).filter(Boolean).slice(0, MAX_BATCH_ITEMS);
  const total = { files: 0, dirs: 0, bytes: 0, truncated: false, missing: 0 };
  for (const p of paths) {
    let abs;
    try { abs = resolveEntryInRoots(env.roots, p); } catch { total.missing++; continue; }
    if (!fs.lstatSync(abs, { throwIfNoEntry: false })) { total.missing++; continue; }
    const m = await measurePath(abs);
    total.files += m.files; total.dirs += m.dirs; total.bytes += m.bytes; total.truncated ||= m.truncated;
  }
  return { ...total, items: paths.length, samples: paths.slice(0, 5) };
}

function undoUnavailable() {
  return new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, 'Undo history is not kept on this computer');
}

// ── shell / system / git ────────────────────────────────────────────────────────────────────────

async function shellExec(args, ctx, env) {
  const command = String(requireArg(args.command, 'command'));
  assertCommandAllowed(command);
  const cwd = resolveInRoots(env.roots, args.cwd || '');
  const [cmd, argv] = shellCommand(command);
  const result = await runProcess(cmd, argv, { cwd, signal: ctx.signal, onOutput: ctx.onOutput, runAs: env.runAs });
  return { command, cwd: displayPath(env.roots, cwd), ...result };
}

async function systemInfo(_args, _ctx, env) {
  const cpus = os.cpus();
  let disk;
  try {
    const s = fs.statfsSync(env.roots[0]);
    disk = { totalGB: +(s.bsize * s.blocks / 1024 ** 3).toFixed(1), freeGB: +(s.bsize * s.bavail / 1024 ** 3).toFixed(1) };
  } catch { /* không đọc được dung lượng */ }
  return {
    platform: process.platform, release: os.release(), arch: os.arch(), hostname: os.hostname(),
    cpu: cpus[0]?.model, cores: cpus.length, loadavg: os.loadavg(),
    memoryMB: { total: Math.round(os.totalmem() / 1024 ** 2), free: Math.round(os.freemem() / 1024 ** 2) },
    uptimeSec: Math.round(os.uptime()), disk, node: process.version, roots: env.roots, programs: env.binaries, projects: env.projects,
  };
}

async function git(argv, args, ctx, env) {
  const cwd = resolveInRoots(env.roots, args.path || '');
  const res = await runProcess('git', ['-C', cwd, ...argv], { cwd, signal: ctx.signal, maxOutput: 512 * 1024, runAs: env.runAs });
  return { cwd: displayPath(env.roots, cwd), ...res };
}

// ── memory (bộ nhớ trên máy) ────────────────────────────────────────────────────────────────────

function contextRecall(args, _ctx, env) {
  const query = String(args.query || '');
  const limit = Math.min(Number(args.limit) || 8, 30);
  const memoryKinds = Object.values(MemoryKind).filter((k) => k !== MemoryKind.PROCEDURE);
  const memory = memoryOf(env);
  return {
    memory: memory.search({ query, vector: args.vector, kinds: memoryKinds, limit }),
    procedures: memory.search({ query, vector: args.vector, kinds: [MemoryKind.PROCEDURE], limit: 3 }),
    files: env.fileIndex ? env.fileIndex.search(query, 10, args.vector) : [],
    projects: env.projects || [],
  };
}

const writeLock = (key) => (args, env) => [resolveInRoots(env.roots, args[key] || '')];

/** Toàn bộ công cụ cho máy này — gói chỉ bật khi máy đủ điều kiện (`available`). */
export function buildTools(env) {
  const hasGit = env.binaries?.includes('git');
  const tools = [
    { name: 'fs.read', group: ToolGroup.FS_READ, read_only: true, handler: fsRead,
      description: 'Read a text file by line range (streamed, works on huge files) or a byte range (base64 for binary). Default: first 1000 lines.',
      input_schema: schema({ path: str('file path, relative to the device root'), startLine: num('1-based first line'), endLine: num('last line (max 5000 lines per call)'), byteOffset: num('byte offset for range reads'), byteLength: num('bytes to read (max 1 MB)'), encoding: str('utf8 | base64') }, ['path']) },
    { name: 'fs.read_many', group: ToolGroup.FS_READ, read_only: true, handler: fsReadMany,
      description: 'Read the start of up to 20 files at once (parallel).',
      input_schema: schema({ paths: { type: 'array', items: { type: 'string' }, description: 'file paths' }, maxLines: num('lines per file, default 400') }, ['paths']) },
    { name: 'fs.list', group: ToolGroup.FS_READ, read_only: true, handler: fsList,
      description: 'List a folder; recursive up to maxDepth (default 3), skipping node_modules/.git/build folders. Filter by extension, name pattern, modified date, size; sort by name / modified / size — e.g. PDFs in Downloads older than 30 days, biggest first, in one call.',
      input_schema: schema({
        path: str('folder, default the root'), recursive: bool('walk subfolders'), maxDepth: num('max depth when recursive'), maxEntries: num('max entries, default 500'),
        ext: str('extensions, comma separated, e.g. "pdf,docx"'), name: str('name pattern with *, e.g. "invoice*"'), modifiedAfter: str('ISO date or number of days ago'),
        modifiedBefore: str('ISO date or number of days ago (e.g. "30" = older than 30 days)'), minSize: num('bytes'), maxSize: num('bytes'), filesOnly: bool('skip folders'),
        sort: str('name | modified | size'), order: str('asc | desc'),
      }) },
    { name: 'fs.find', group: ToolGroup.FS_READ, read_only: true, handler: fsFind,
      description: 'Instant search over the on-device file index: file names, path words, identifiers near the top of files and the opening text of documents (docx/xlsx/pptx/txt), ranked by words AND meaning. Describe the file in natural words ("office lease contract 2026"); results include size, modified date and a preview. Use to locate files before reading.',
      input_schema: schema({ query: str('what the file is about, in natural words'), limit: num('max results, default 15') }, ['query']) },
    { name: 'fs.preview', group: ToolGroup.FS_READ, read_only: true, handler: fsPreview,
      description: 'Preview up to 10 files at once: size, modified date and their opening text (also inside docx/xlsx/pptx). Use to tell close candidates apart before choosing one.',
      input_schema: schema({ paths: { type: 'array', items: { type: 'string' }, description: 'file paths' }, maxChars: num('preview length per file, default 800') }, ['paths']) },
    { name: 'fs.grep', group: ToolGroup.FS_READ, read_only: true, handler: fsGrep,
      description: 'Search file contents for a text (or regex) under a folder; uses ripgrep when installed.',
      input_schema: schema({ query: str('text or regex'), path: str('folder, default the root'), regex: bool('treat query as a regex'), glob: str('file glob filter, e.g. *.ts'), maxResults: num('default 50') }, ['query']) },
    { name: 'fs.info', group: ToolGroup.FS_READ, read_only: true, handler: fsInfo,
      description: 'Existence, size and dates of a file or folder.',
      input_schema: schema({ path: str('path') }, ['path']) },
    { name: 'fs.write', group: ToolGroup.FS_WRITE, handler: fsWrite, lockKeys: writeLock('path'),
      description: 'Create or overwrite a file (creates folders). append adds to the end. encoding base64 for binary content. The previous version is kept (fs.undo restores it).',
      input_schema: schema({ path: str('file path'), content: str('full content'), append: bool('append instead of replace'), overwrite: bool('false = fail if the file exists'), encoding: str('utf8 | base64') }, ['path', 'content']) },
    { name: 'fs.edit', group: ToolGroup.FS_WRITE, handler: fsEdit, lockKeys: writeLock('path'),
      description: 'Replace an exact text in a file (must be unique unless replaceAll).',
      input_schema: schema({ path: str('file path'), oldText: str('exact text to replace'), newText: str('replacement'), replaceAll: bool('replace every occurrence') }, ['path', 'oldText', 'newText']) },
    { name: 'fs.move', group: ToolGroup.FS_WRITE, handler: fsMove, lockKeys: (a, e) => [...writeLock('sourcePath')(a, e), ...writeLock('destinationPath')(a, e)],
      description: 'Move or rename one file or folder (several: fs.move_many). Undoable.',
      input_schema: schema({ sourcePath: str('from'), destinationPath: str('to'), overwrite: bool('replace an existing destination (the replaced one is kept for undo)') }, ['sourcePath', 'destinationPath']) },
    { name: 'fs.move_many', group: ToolGroup.FS_WRITE, handler: fsMoveMany,
      lockKeys: (a, e) => (Array.isArray(a.moves) ? a.moves.slice(0, MAX_BATCH_ITEMS) : []).flatMap((m) => { try { return [resolveInRoots(e.roots, m?.from || ''), resolveInRoots(e.roots, m?.to || '')]; } catch { return []; } }),
      description: `Move / rename up to ${MAX_BATCH_ITEMS} files or folders in one call (organizing a folder): moves [{from, to}], folders are created. dry_run first checks every item and returns the plan without changing anything. Items that fail do not stop the others. The whole batch is undoable.`,
      input_schema: schema({ moves: { type: 'array', items: { type: 'object', properties: { from: str('source'), to: str('destination path') } }, description: '[{from, to}]' }, overwrite: bool('replace existing destinations'), dry_run: bool('only check and show the plan') }, ['moves']) },
    { name: 'fs.delete', group: ToolGroup.FS_WRITE, destructive: true, handler: fsDelete, lockKeys: writeLock('path'),
      description: 'Delete a file or folder (recursive). It goes to the recycle area and fs.undo brings it back; permanent: true deletes for good (only when the user asked for that).',
      input_schema: schema({ path: str('path to delete'), permanent: bool('delete for good, not recoverable') }, ['path']) },
    { name: 'fs.delete_many', group: ToolGroup.FS_WRITE, destructive: true, handler: fsDeleteMany,
      lockKeys: (a, e) => (Array.isArray(a.paths) ? a.paths.slice(0, MAX_BATCH_ITEMS) : []).flatMap((p) => { try { return [resolveInRoots(e.roots, p || '')]; } catch { return []; } }),
      description: `Delete up to ${MAX_BATCH_ITEMS} files or folders in one call (recoverable with fs.undo unless permanent). One approval covers the batch.`,
      input_schema: schema({ paths: { type: 'array', items: { type: 'string' }, description: 'paths to delete' }, permanent: bool('delete for good, not recoverable') }, ['paths']) },
    { name: 'fs.history', group: ToolGroup.FS_READ, read_only: true,
      handler: (a, _c, e) => { if (!e.undo) throw undoUnavailable(); return { groups: e.undo.history(Math.min(Number(a.limit) || 10, 50)) }; },
      description: 'Recent groups of file changes the AI made on this computer (one group per task): what changed, when, whether undone.',
      input_schema: schema({ limit: num('default 10') }) },
    { name: 'fs.undo', group: ToolGroup.FS_WRITE,
      handler: (a, _c, e) => { if (!e.undo) throw undoUnavailable(); return e.undo.undo(a.group, e.roots); },
      description: 'Undo every file change of one group (default: the most recent group not yet undone): restores deleted and overwritten files, moves files back, removes files the AI created. Nothing the user changed since is overwritten.',
      input_schema: schema({ group: str('group id from fs.history; default the latest') }) },
    { name: 'fs.measure', group: ToolGroup.FS_READ, read_only: true, internal: true, handler: fsMeasure,
      description: 'BE-only: file count and size of paths about to be deleted (shown on the approval card).', input_schema: schema({}) },
    { name: 'shell.exec', group: ToolGroup.EXEC, handler: shellExec,
      description: `Run a command in ${process.platform === 'win32' ? 'PowerShell' : 'the login shell'} inside an allowed folder; returns exitCode/stdout/stderr. Secrets are removed from the environment. Set timeoutMs for long builds (default 60000).`,
      input_schema: schema({ command: str('command line'), cwd: str('working folder, default the root'), timeoutMs: num('time limit in ms (max 600000)') }, ['command']) },
    { name: 'system.info', group: ToolGroup.SYSTEM, read_only: true, handler: systemInfo,
      description: 'OS, CPU, memory, disk free space, installed programs and detected projects.',
      input_schema: schema({}) },
    { name: 'memory.search', group: ToolGroup.MEMORY, read_only: true, handler: (a, _c, e) => ({ items: memoryOf(e).search({ query: a.query, kinds: a.kinds, limit: Math.min(Number(a.limit) || 10, 50) }) }),
      description: "Search this device's long-term memory (facts, projects, rules, lessons, procedures) by words.",
      input_schema: schema({ query: str('words'), kinds: { type: 'array', items: { type: 'string' }, description: 'fact | project | rule | lesson | procedure' }, limit: num('default 10') }, ['query']) },
    { name: 'memory.get', group: ToolGroup.MEMORY, read_only: true, handler: (a, _c, e) => memoryOf(e).get(a) || { found: false },
      description: 'Get one memory item by id, or by kind + key.',
      input_schema: schema({ id: str('item id'), kind: str('kind'), key: str('key') }) },
    { name: 'memory.list', group: ToolGroup.MEMORY, read_only: true, handler: (a, _c, e) => memoryOf(e).list(a),
      description: 'Page through memory items (newest first); pass next_cursor to continue.',
      input_schema: schema({ kind: str('optional kind filter'), cursor: num('from next_cursor'), limit: num('default 50') }) },
    { name: 'memory.delete', group: ToolGroup.MEMORY, handler: (a, _c, e) => memoryOf(e).delete(a),
      description: 'Forget memory items by id (or kind + key).',
      input_schema: schema({ ids: { type: 'array', items: { type: 'string' }, description: 'item ids' }, kind: str('kind'), key: str('key') }) },
    { name: 'context.recall', group: ToolGroup.MEMORY, read_only: true, internal: true, handler: contextRecall,
      description: 'BE-only: hybrid recall of memory, procedures and files for an objective.', input_schema: schema({}) },
    { name: 'memory.put', group: ToolGroup.MEMORY, internal: true, handler: (a, _c, e) => memoryOf(e).put(a.items),
      description: 'BE-only: upsert memory items with vectors.', input_schema: schema({}) },
    { name: 'notify.show', group: ToolGroup.SYSTEM, internal: true, handler: (a) => showOSNotification(a),
      description: 'BE-only: OS notification when the AI needs the user (title, body, url opened on click).', input_schema: schema({}) },
  ];
  if (hasGit) {
    tools.push(
      { name: 'git.status', group: ToolGroup.GIT, read_only: true, handler: (a, c, e) => git(['status', '--porcelain=v1', '--branch'], a, c, e),
        description: 'Branch and changed files of a git repository.', input_schema: schema({ path: str('repository folder, default the root') }) },
      { name: 'git.diff', group: ToolGroup.GIT, read_only: true, handler: (a, c, e) => git(['diff', ...(a.staged ? ['--staged'] : []), '--stat', '--patch', '--no-color', ...(a.file ? ['--', String(a.file)] : [])], a, c, e),
        description: 'Uncommitted changes (patch) of a repository or one file.', input_schema: schema({ path: str('repository folder'), file: str('limit to one file'), staged: bool('show staged changes') }) },
      { name: 'git.log', group: ToolGroup.GIT, read_only: true, handler: (a, c, e) => git(['log', `-${Math.min(Number(a.limit) || 20, 200)}`, '--pretty=format:%h %ad %an %s', '--date=short'], a, c, e),
        description: 'Recent commits of a repository.', input_schema: schema({ path: str('repository folder'), limit: num('default 20') }) },
    );
  }
  // Trình duyệt cho AI Browser (máy có Chrome / Edge) — BE gọi thẳng, không vào danh mục của Planner.
  if (env.browserTunnels) {
    tools.push(
      { name: 'browser.open_tunnel', group: ToolGroup.BROWSER, internal: true, handler: (a, c) => env.browserTunnels.open(a, c),
        description: "BE-only: open (or reuse) Aivin's own browser window on this device and connect a CDP tunnel for one AI Browser task.", input_schema: schema({}) },
      { name: 'browser.read_download', group: ToolGroup.BROWSER, read_only: true, internal: true, handler: (a, c) => env.browserTunnels.readDownload(a, c),
        description: "BE-only: read a byte range of a file the AI downloaded in that window (only inside Aivin's downloads folder).", input_schema: schema({}) },
    );
  }
  // Điều khiển giao diện (Windows, CLI ≥ 1.0.9) — chỉ khi máy có màn hình tương tác và không tắt bằng --no-gui.
  if (env.gui) tools.push(...buildGuiTools(env.gui));
  // Excel / Word / Outlook có trên máy → làm qua API của ứng dụng (tự phát hiện, không cấu hình).
  if (env.office?.apps?.length) tools.push(...buildOfficeTools(env.office.host, env.office.apps));
  // Tiến trình nền + đọc log thời gian thực (dev server, build watch, claude -p, tail log).
  if (env.processes) tools.push(...buildProcessTools(env.processes));
  // Lịch chạy định kỳ (Task Scheduler / crontab) — máy cá nhân; máy tính tổ chức không đặt lịch cho thành viên.
  if (env.schedules) tools.push(...buildScheduleTools(env.schedules));
  // Theo dõi trên máy kích hoạt việc của Aivin (tệp mới, dòng log) — BE đặt danh sách.
  if (env.watches) tools.push(...buildWatchTools(env.watches));
  // Máy tính tổ chức không lập chỉ mục tệp (nhiều người chung một máy) — Planner tìm bằng fs.list / fs.grep trong thư mục của mình.
  return env.fileIndex ? tools : tools.filter((t) => t.name !== 'fs.find');
}

/** Bảng tra theo tên cho bộ điều phối. */
export function toolMap(tools) {
  return new Map(tools.map((t) => [t.name, t]));
}
