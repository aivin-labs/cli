import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { DeviceErrorCode, IGNORED_DIRS, MemoryKind, ToolGroup } from './constants.mjs';
import { DeviceToolError, assertCommandAllowed, displayPath, resolveInRoots, scrubEnv } from './sandbox.mjs';
import { deleteMemoryItems, getMemoryItem, listMemoryItems, putMemoryItems, searchMemory } from './deviceMemory.mjs';

/**
 * Công cụ trên máy, chia gói theo năng lực phát hiện được (git chỉ có khi máy cài git, tìm nội dung dùng ripgrep nếu có…). Mỗi công cụ
 * tự khai: schema tham số, chỉ đọc / có tác dụng phụ / không hoàn tác, nhóm song song, khoá đường dẫn khi ghi. Công cụ `internal` chỉ BE
 * gọi trực tiếp (tra ngữ cảnh, lưu ghi nhớ) — không đưa vào danh mục của Planner.
 *
 * `env` = { roots, binaries, fileIndex, projects }. `ctx` = { signal, onOutput, timeoutMs }.
 */

const DEFAULT_READ_LINES = 1000;
const MAX_READ_LINES = 5000;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 2000;

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

async function fsList(args, ctx, env) {
  const abs = resolveInRoots(env.roots, args.path || '');
  const maxDepth = args.recursive ? Math.min(Number(args.maxDepth) || 3, 8) : 0;
  const limit = Math.min(Number(args.maxEntries) || 500, MAX_LIST_ENTRIES);
  const out = [];
  const queue = [[abs, 0]];
  while (queue.length && out.length < limit) {
    throwIfAborted(ctx.signal);
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { if (dir === abs) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, e.message); continue; }
    for (const e of entries) {
      if (out.length >= limit) break;
      const full = path.join(dir, e.name);
      const isDir = e.isDirectory();
      out.push({ path: displayPath(env.roots, full), dir: isDir || undefined });
      if (isDir && depth < maxDepth && !IGNORED_DIRS.has(e.name) && !e.isSymbolicLink()) queue.push([full, depth + 1]);
    }
  }
  return { base: displayPath(env.roots, abs), total: out.length, truncated: out.length >= limit || undefined, entries: out };
}

function fsFind(args, _ctx, env) {
  if (!env.fileIndex) throw new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, 'File index not ready');
  return { results: env.fileIndex.search(requireArg(args.query, 'query'), Math.min(Number(args.limit) || 15, 100)), stats: env.fileIndex.stats() };
}

function runProcess(cmd, argv, { cwd, signal, onOutput, env, maxOutput = MAX_EXEC_OUTPUT, shell = false }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, argv, { cwd, env: env || scrubEnv(), windowsHide: true, shell, detached: process.platform !== 'win32' });
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
    const argv = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '5', '--max-filesize', '2M', ...(args.regex ? ['-e', query] : ['-F', query]), ...(args.glob ? ['-g', String(args.glob)] : []), abs];
    const res = await runProcess('rg', argv, { cwd: abs, signal: ctx.signal, maxOutput: 512 * 1024 });
    const matches = res.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults).map((line) => {
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      return m ? { path: displayPath(env.roots, m[1]), line: Number(m[2]), text: m[3].slice(0, 300) } : { text: line.slice(0, 300) };
    });
    return { engine: 'ripgrep', total: matches.length, matches };
  }
  const re = args.regex ? new RegExp(query) : null;
  const matches = [];
  const queue = [abs];
  while (queue.length && matches.length < maxResults) {
    throwIfAborted(ctx.signal);
    const dir = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (matches.length >= maxResults) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name) && !e.isSymbolicLink()) queue.push(full); continue; }
      if (!e.isFile()) continue;
      const stat = await fs.promises.stat(full).catch(() => null);
      if (!stat || stat.size > 2 * 1024 * 1024) continue;
      const text = await fs.promises.readFile(full, 'utf8').catch(() => '');
      if (text.includes('\u0000')) continue;
      text.split(/\r?\n/).some((line, i) => {
        if (re ? re.test(line) : line.includes(query)) matches.push({ path: displayPath(env.roots, full), line: i + 1, text: line.trim().slice(0, 300) });
        return matches.length >= maxResults;
      });
    }
  }
  return { engine: 'builtin', total: matches.length, matches };
}

async function fsInfo(args, _ctx, env) {
  const abs = resolveInRoots(env.roots, args.path || '');
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) return { path: displayPath(env.roots, abs), exists: false };
  return { path: displayPath(env.roots, abs), exists: true, dir: stat.isDirectory(), size: stat.size, modifiedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString() };
}

async function fsWrite(args, _ctx, env) {
  const abs = resolveInRoots(env.roots, requireArg(args.path, 'path'));
  const exists = fs.existsSync(abs);
  if (exists && args.overwrite === false && !args.append) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `File exists and overwrite is false: ${args.path}`);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const data = args.encoding === 'base64' ? Buffer.from(String(args.content ?? ''), 'base64') : String(args.content ?? '');
  if (args.append) await fs.promises.appendFile(abs, data);
  else await fs.promises.writeFile(abs, data);
  return { path: displayPath(env.roots, abs), bytes: Buffer.byteLength(data), created: !exists, appended: !!args.append || undefined };
}

async function fsEdit(args, _ctx, env) {
  const abs = resolveInRoots(env.roots, requireArg(args.path, 'path'));
  const oldText = String(requireArg(args.oldText, 'oldText'));
  const newText = String(args.newText ?? '');
  const content = await fs.promises.readFile(abs, 'utf8').catch(() => { throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `File not found: ${args.path}`); });
  const count = content.split(oldText).length - 1;
  if (!count) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'oldText not found in file');
  if (count > 1 && !args.replaceAll) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `oldText occurs ${count} times — give more context or set replaceAll`);
  await fs.promises.writeFile(abs, args.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText));
  return { path: displayPath(env.roots, abs), replaced: args.replaceAll ? count : 1 };
}

async function fsMove(args, _ctx, env) {
  const src = resolveInRoots(env.roots, requireArg(args.sourcePath, 'sourcePath'));
  const dst = resolveInRoots(env.roots, requireArg(args.destinationPath, 'destinationPath'));
  if (!fs.existsSync(src)) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Source not found: ${args.sourcePath}`);
  if (fs.existsSync(dst) && args.overwrite !== true) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Destination exists: ${args.destinationPath} (set overwrite to replace)`);
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.rename(src, dst);
  return { from: displayPath(env.roots, src), to: displayPath(env.roots, dst) };
}

async function fsDelete(args, _ctx, env) {
  const abs = resolveInRoots(env.roots, requireArg(args.path, 'path'));
  if (env.roots.some((r) => path.resolve(r) === abs)) throw new DeviceToolError(DeviceErrorCode.ROOT_DENIED, 'Refusing to delete an allowed root folder');
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) return { path: displayPath(env.roots, abs), deleted: false };
  await fs.promises.rm(abs, { recursive: stat.isDirectory(), force: true });
  return { path: displayPath(env.roots, abs), deleted: true, dir: stat.isDirectory() || undefined };
}

// ── shell / system / git ────────────────────────────────────────────────────────────────────────

async function shellExec(args, ctx, env) {
  const command = String(requireArg(args.command, 'command'));
  assertCommandAllowed(command);
  const cwd = resolveInRoots(env.roots, args.cwd || '');
  const isWin = process.platform === 'win32';
  const [cmd, argv] = isWin
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]]
    : [process.env.SHELL || '/bin/bash', ['-c', command]];
  const result = await runProcess(cmd, argv, { cwd, signal: ctx.signal, onOutput: ctx.onOutput });
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
  const res = await runProcess('git', ['-C', cwd, ...argv], { cwd, signal: ctx.signal, maxOutput: 512 * 1024 });
  return { cwd: displayPath(env.roots, cwd), ...res };
}

// ── memory (bộ nhớ trên máy) ────────────────────────────────────────────────────────────────────

function contextRecall(args, _ctx, env) {
  const query = String(args.query || '');
  const limit = Math.min(Number(args.limit) || 8, 30);
  const memoryKinds = Object.values(MemoryKind).filter((k) => k !== MemoryKind.PROCEDURE);
  return {
    memory: searchMemory({ query, vector: args.vector, kinds: memoryKinds, limit }),
    procedures: searchMemory({ query, vector: args.vector, kinds: [MemoryKind.PROCEDURE], limit: 3 }),
    files: env.fileIndex ? env.fileIndex.search(query, 10) : [],
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
      description: 'List a folder; recursive up to maxDepth (default 3), skipping node_modules/.git/build folders.',
      input_schema: schema({ path: str('folder, default the root'), recursive: bool('walk subfolders'), maxDepth: num('max depth when recursive'), maxEntries: num('max entries, default 500') }) },
    { name: 'fs.find', group: ToolGroup.FS_READ, read_only: true, handler: fsFind,
      description: 'Instant search over the on-device file index by file name, path words and identifiers near the top of files (functions, classes, keys). Use to locate files before reading.',
      input_schema: schema({ query: str('words to look for'), limit: num('max results, default 15') }, ['query']) },
    { name: 'fs.grep', group: ToolGroup.FS_READ, read_only: true, handler: fsGrep,
      description: 'Search file contents for a text (or regex) under a folder; uses ripgrep when installed.',
      input_schema: schema({ query: str('text or regex'), path: str('folder, default the root'), regex: bool('treat query as a regex'), glob: str('file glob filter, e.g. *.ts'), maxResults: num('default 50') }, ['query']) },
    { name: 'fs.info', group: ToolGroup.FS_READ, read_only: true, handler: fsInfo,
      description: 'Existence, size and dates of a file or folder.',
      input_schema: schema({ path: str('path') }, ['path']) },
    { name: 'fs.write', group: ToolGroup.FS_WRITE, handler: fsWrite, lockKeys: writeLock('path'),
      description: 'Create or overwrite a file (creates folders). append adds to the end. encoding base64 for binary content.',
      input_schema: schema({ path: str('file path'), content: str('full content'), append: bool('append instead of replace'), overwrite: bool('false = fail if the file exists'), encoding: str('utf8 | base64') }, ['path', 'content']) },
    { name: 'fs.edit', group: ToolGroup.FS_WRITE, handler: fsEdit, lockKeys: writeLock('path'),
      description: 'Replace an exact text in a file (must be unique unless replaceAll).',
      input_schema: schema({ path: str('file path'), oldText: str('exact text to replace'), newText: str('replacement'), replaceAll: bool('replace every occurrence') }, ['path', 'oldText', 'newText']) },
    { name: 'fs.move', group: ToolGroup.FS_WRITE, handler: fsMove, lockKeys: (a, e) => [...writeLock('sourcePath')(a, e), ...writeLock('destinationPath')(a, e)],
      description: 'Move or rename a file or folder.',
      input_schema: schema({ sourcePath: str('from'), destinationPath: str('to'), overwrite: bool('replace an existing destination') }, ['sourcePath', 'destinationPath']) },
    { name: 'fs.delete', group: ToolGroup.FS_WRITE, destructive: true, handler: fsDelete, lockKeys: writeLock('path'),
      description: 'Delete a file or folder (recursive). Cannot be undone.',
      input_schema: schema({ path: str('path to delete') }, ['path']) },
    { name: 'shell.exec', group: ToolGroup.EXEC, handler: shellExec,
      description: `Run a command in ${process.platform === 'win32' ? 'PowerShell' : 'the login shell'} inside an allowed folder; returns exitCode/stdout/stderr. Secrets are removed from the environment. Set timeoutMs for long builds (default 60000).`,
      input_schema: schema({ command: str('command line'), cwd: str('working folder, default the root'), timeoutMs: num('time limit in ms (max 600000)') }, ['command']) },
    { name: 'system.info', group: ToolGroup.SYSTEM, read_only: true, handler: systemInfo,
      description: 'OS, CPU, memory, disk free space, installed programs and detected projects.',
      input_schema: schema({}) },
    { name: 'memory.search', group: ToolGroup.MEMORY, read_only: true, handler: (a) => ({ items: searchMemory({ query: a.query, kinds: a.kinds, limit: Math.min(Number(a.limit) || 10, 50) }) }),
      description: "Search this device's long-term memory (facts, projects, rules, lessons, procedures) by words.",
      input_schema: schema({ query: str('words'), kinds: { type: 'array', items: { type: 'string' }, description: 'fact | project | rule | lesson | procedure' }, limit: num('default 10') }, ['query']) },
    { name: 'memory.get', group: ToolGroup.MEMORY, read_only: true, handler: (a) => getMemoryItem(a) || { found: false },
      description: 'Get one memory item by id, or by kind + key.',
      input_schema: schema({ id: str('item id'), kind: str('kind'), key: str('key') }) },
    { name: 'memory.list', group: ToolGroup.MEMORY, read_only: true, handler: (a) => listMemoryItems(a),
      description: 'Page through memory items (newest first); pass next_cursor to continue.',
      input_schema: schema({ kind: str('optional kind filter'), cursor: num('from next_cursor'), limit: num('default 50') }) },
    { name: 'memory.delete', group: ToolGroup.MEMORY, handler: (a) => deleteMemoryItems(a),
      description: 'Forget memory items by id (or kind + key).',
      input_schema: schema({ ids: { type: 'array', items: { type: 'string' }, description: 'item ids' }, kind: str('kind'), key: str('key') }) },
    { name: 'context.recall', group: ToolGroup.MEMORY, read_only: true, internal: true, handler: contextRecall,
      description: 'BE-only: hybrid recall of memory, procedures and files for an objective.', input_schema: schema({}) },
    { name: 'memory.put', group: ToolGroup.MEMORY, internal: true, handler: (a) => putMemoryItems(a.items),
      description: 'BE-only: upsert memory items with vectors.', input_schema: schema({}) },
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
  return tools;
}

/** Bảng tra theo tên cho bộ điều phối. */
export function toolMap(tools) {
  return new Map(tools.map((t) => [t.name, t]));
}
