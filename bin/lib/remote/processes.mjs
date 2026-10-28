import { spawn } from 'child_process';
import { DeviceErrorCode, ToolGroup } from './constants.mjs';
import { DeviceToolError, assertCommandAllowed, displayPath, resolveInRoots, scrubEnv } from './sandbox.mjs';
import { accountEnv, withProcessCap } from './multiUser.mjs';
import { hasPwsh } from './deviceProfile.mjs';

/**
 * Tiến trình nền + đọc log thời gian thực (28/10/2026): `proc.start` chạy lệnh dài (dev server, build / test watch, `claude -p …`, tail log)
 * KHÔNG giữ vòng Planner; `proc.wait_for` chờ tới khi một dòng khớp mẫu ("ready", "error", "compiled") hoặc tiến trình thoát; `proc.read`
 * đọc phần log mới theo con trỏ; `proc.stop` dừng cả cây tiến trình. Lệnh đi qua cùng sàn với `shell.exec` (chặn `.aivin`, lọc bí mật
 * khỏi biến môi trường, thư mục trong vùng được phép, máy tính tổ chức chạy dưới tài khoản thành viên).
 */

const MAX_PROCS = 8;
const MAX_LINES = 5000;
const MAX_LINE_CHARS = 2000;
const DEFAULT_READ_LINES = 200;
const MAX_WAIT_MS = 10 * 60_000;
/** Tiến trình đã thoát giữ log bấy nhiêu lâu rồi bỏ. */
const KEEP_EXITED_MS = 30 * 60_000;

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

/**
 * Chương trình + tham số chạy một dòng lệnh trong shell của máy. PowerShell 5.1 trả mã thoát 1 cho mọi lỗi của chương trình ngoài (mất mã
 * thật — `node` thoát 2 thành 1): bọc để trả đúng `$LASTEXITCODE`, lệnh PowerShell lỗi (không có mã) thì 1.
 */
export function shellCommand(command, platform = process.platform) {
  if (platform === 'win32') {
    const wrapped = `& {
${command}
}; if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`;
    return [hasPwsh() ? 'pwsh.exe' : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped]];
  }
  return [process.env.SHELL || '/bin/bash', ['-c', command]];
}

export function createProcessManager() {
  const procs = new Map();
  let seq = 0;

  const prune = () => {
    for (const [id, p] of procs) if (p.status !== 'running' && Date.now() - p.endedAt > KEEP_EXITED_MS) procs.delete(id);
  };

  function killTree(p) {
    if (p.status !== 'running') return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { try { p.child.kill('SIGTERM'); } catch { /* đã thoát */ } } }
  }

  /** Ghi log theo dòng vào bộ đệm vòng (giữ MAX_LINES dòng cuối); `cursor` tăng mãi để đọc tiếp không sót / không lặp. */
  function pushOutput(p, stream, chunk) {
    const text = p.partial[stream] + chunk.toString();
    const parts = text.split(/\r?\n/);
    p.partial[stream] = parts.pop();
    for (const line of parts) addLine(p, stream, line);
  }

  function addLine(p, stream, line) {
    p.lines.push({ n: p.cursor++, s: stream === 'stderr' ? 'e' : 'o', t: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line });
    if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES);
    for (const w of [...p.waiters]) w(p.lines[p.lines.length - 1]);
  }

  /** Máy tính tổ chức: mỗi tiến trình thuộc một thành viên (`env.runAs`) — người khác không thấy / đọc / dừng được. */
  const ownerOf = (env) => env?.runAs?.name || '';

  function get(id, env) {
    const p = procs.get(String(id || ''));
    if (!p || p.owner !== ownerOf(env)) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No background process ${id} (see proc.list)`);
    return p;
  }

  const view = (p) => ({
    id: p.id, name: p.name, command: p.command.slice(0, 300), cwd: p.cwdDisplay, status: p.status, exitCode: p.exitCode,
    pid: p.child.pid, started_at: new Date(p.startedAt).toISOString(), lines: p.cursor,
  });

  async function start(args, _ctx, env) {
    prune();
    if ([...procs.values()].filter((p) => p.status === 'running' && p.owner === ownerOf(env)).length >= MAX_PROCS) {
      throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `At most ${MAX_PROCS} background processes — stop one first (proc.list)`);
    }
    const command = String(args.command || '').trim();
    if (!command) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Missing argument: command');
    assertCommandAllowed(command);
    const cwd = resolveInRoots(env.roots, args.cwd || '');
    // Cần gõ vào (trả lời câu hỏi): PowerShell không chuyển stdin sang chương trình con → Windows chạy qua cmd.exe (chương trình con dùng
    // chung stdin, mã thoát giữ nguyên); nơi khác shell vốn đã chuyển.
    const interactive = !!args.interactive && process.platform === 'win32';
    let [cmd, argv] = interactive ? ['cmd.exe', ['/d', '/s', '/c', `"${command}"`]] : shellCommand(command);
    const runAs = env.runAs;
    if (runAs) [cmd, argv] = withProcessCap(cmd, argv);
    const baseEnv = scrubEnv();
    const child = spawn(cmd, argv, {
      cwd, env: runAs ? accountEnv(runAs, baseEnv) : baseEnv, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: interactive, ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
    });
    const id = `p${++seq}`;
    const p = {
      id, owner: ownerOf(env), name: String(args.name || '').slice(0, 60) || undefined, command, cwdDisplay: displayPath(env.roots, cwd), child, status: 'running', exitCode: null,
      startedAt: Date.now(), endedAt: 0, lines: [], cursor: 0, partial: { stdout: '', stderr: '' }, waiters: new Set(), exitWaiters: new Set(),
    };
    procs.set(id, p);
    child.stdout.on('data', (c) => pushOutput(p, 'stdout', c));
    child.stderr.on('data', (c) => pushOutput(p, 'stderr', c));
    const finish = (code) => {
      if (p.status !== 'running') return;
      for (const s of ['stdout', 'stderr']) if (p.partial[s]) { addLine(p, s, p.partial[s]); p.partial[s] = ''; }
      p.status = 'exited';
      p.exitCode = code ?? -1;
      p.endedAt = Date.now();
      for (const w of [...p.exitWaiters]) w();
    };
    child.on('error', (e) => { addLine(p, 'stderr', `Cannot start: ${e.message}`); finish(-1); });
    child.on('close', (code) => finish(code));
    return view(p);
  }

  function read(args, env) {
    const p = get(args.id, env);
    const since = Number.isFinite(Number(args.since)) ? Number(args.since) : null;
    const max = Math.min(Number(args.lines) || DEFAULT_READ_LINES, 1000);
    let lines = since === null ? p.lines.slice(-max) : p.lines.filter((l) => l.n >= since).slice(0, max);
    const filter = args.filter ? new RegExp(String(args.filter), 'i') : null;
    if (filter) lines = lines.filter((l) => filter.test(l.t));
    const last = lines[lines.length - 1];
    return {
      ...view(p), output: lines.map((l) => (l.s === 'e' ? `[err] ${l.t}` : l.t)).join('\n'),
      next_since: last ? last.n + 1 : (since ?? p.cursor), dropped_before: p.lines[0]?.n || 0,
    };
  }

  /**
   * Chờ tới khi một dòng log MỚI (từ `since`, mặc định từ đầu bộ đệm) khớp `pattern` (regex, không phân biệt hoa thường), hoặc tiến trình
   * thoát, hoặc hết `timeoutMs`. Trả dòng khớp + vài dòng trước nó làm ngữ cảnh.
   */
  function waitFor(args, ctx, env) {
    const p = get(args.id, env);
    const pattern = args.pattern ? new RegExp(String(args.pattern), 'i') : null;
    const since = Number.isFinite(Number(args.since)) ? Number(args.since) : 0;
    const timeoutMs = Math.min(Math.max(1000, Number(args.timeoutMs) || 60_000), MAX_WAIT_MS);
    const contextOf = (n) => p.lines.filter((l) => l.n < n && l.n >= n - 10).map((l) => l.t).join('\n');
    const already = pattern && p.lines.find((l) => l.n >= since && pattern.test(l.t));
    if (already) return Promise.resolve({ ...view(p), matched: true, line: already.t, context: contextOf(already.n), next_since: already.n + 1 });
    if (p.status !== 'running') return Promise.resolve({ ...view(p), matched: false, reason: 'exited', tail: p.lines.slice(-30).map((l) => l.t).join('\n'), next_since: p.cursor });
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); p.waiters.delete(onLine); p.exitWaiters.delete(onExit); ctx?.signal?.removeEventListener('abort', onAbort); };
      const onLine = (l) => { if (pattern?.test(l.t)) { cleanup(); resolve({ ...view(p), matched: true, line: l.t, context: contextOf(l.n), next_since: l.n + 1 }); } };
      const onExit = () => { cleanup(); resolve({ ...view(p), matched: false, reason: 'exited', tail: p.lines.slice(-30).map((l) => l.t).join('\n'), next_since: p.cursor }); };
      const onAbort = () => { cleanup(); reject(ctx.signal.reason); };
      const timer = setTimeout(() => { cleanup(); resolve({ ...view(p), matched: false, reason: 'timeout', tail: p.lines.slice(-20).map((l) => l.t).join('\n'), next_since: p.cursor }); }, timeoutMs);
      p.waiters.add(onLine);
      p.exitWaiters.add(onExit);
      ctx?.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Gõ vào tiến trình đang chạy (trả lời câu hỏi "Continue? [y/N]", nhập lựa chọn của trình cài, lệnh cho REPL). Chữ gõ vào xét như một
   * lệnh: chạm `.aivin` bị chặn ở đây; BE xét cùng cổng duyệt / sàn nội dung như shell.exec. `close` = đóng stdin (báo hết dữ liệu).
   */
  function write(args, env) {
    const p = get(args.id, env);
    if (p.status !== 'running') throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `Process ${p.id} has exited`);
    const text = String(args.text ?? '');
    assertCommandAllowed(text);
    if (text) p.child.stdin.write(args.newline === false ? text : `${text}
`);
    if (args.close) p.child.stdin.end();
    return { ...view(p), written: text.length, closed_input: !!args.close || undefined, next_since: p.cursor };
  }

  function stop(args, env) {
    const p = get(args.id, env);
    killTree(p);
    return { ...view(p), stopping: p.status === 'running' };
  }

  return {
    start, read, waitFor, write, stop,
    list: (env) => { prune(); return { processes: [...procs.values()].filter((p) => p.owner === ownerOf(env)).map(view) }; },
    stopAll: () => { for (const p of procs.values()) killTree(p); },
  };
}

/** Công cụ tiến trình nền cho danh mục của Planner. */
export function buildProcessTools(pm) {
  return [
    { name: 'proc.start', group: ToolGroup.PROC, handler: (a, c, e) => pm.start(a, c, e),
      description: `Start a long-running command in the background (dev server, build/test watcher, long script, \`claude -p "…"\`, tail -f) in ${process.platform === 'win32' ? 'PowerShell' : 'the login shell'}; returns an id at once. Then use proc.wait_for / proc.read; stop it with proc.stop. Prefer shell.exec for short commands.`,
      input_schema: schema({
        command: str('command line'), cwd: str('working folder, default the root'), name: str('short label'),
        interactive: { type: 'boolean', description: `the program will ask for input you answer with proc.write${process.platform === 'win32' ? ' (runs through cmd.exe: plain program + arguments, not PowerShell syntax)' : ''}` },
      }, ['command']) },
    { name: 'proc.wait_for', group: ToolGroup.PROC, read_only: true, handler: (a, c, e) => pm.waitFor(a, c, e),
      description: 'Wait until a NEW output line of a background process matches pattern (case-insensitive regex, e.g. "ready|listening", "error|failed"), or it exits, or timeoutMs passes. Returns the matched line with context and next_since for the next call.',
      input_schema: schema({ id: str('process id'), pattern: str('regex to wait for; omit to wait for exit'), since: num('line cursor from a previous call'), timeoutMs: num('max 600000, default 60000') }, ['id']) },
    { name: 'proc.read', group: ToolGroup.PROC, read_only: true, handler: (a, _c, e) => pm.read(a, e),
      description: 'Read output of a background process: the last lines, or new lines since a cursor; filter keeps matching lines only.',
      input_schema: schema({ id: str('process id'), since: num('line cursor (next_since)'), lines: num('max lines, default 200'), filter: str('regex filter') }, ['id']) },
    { name: 'proc.write', group: ToolGroup.PROC, handler: (a, _c, e) => pm.write(a, e),
      description: 'Type into a running background process (answer a prompt like "Continue? [y/N]", an installer choice, a line for a REPL). Adds Enter unless newline is false; close ends the input. Then proc.wait_for from the returned next_since.',
      input_schema: schema({ id: str('process id'), text: str('what to type'), newline: { type: 'boolean', description: 'press Enter after the text (default true)' }, close: { type: 'boolean', description: 'close the input after writing' } }, ['id']) },
    { name: 'proc.stop', group: ToolGroup.PROC, handler: (a, _c, e) => pm.stop(a, e),
      description: 'Stop a background process and all its children.',
      input_schema: schema({ id: str('process id') }, ['id']) },
    { name: 'proc.list', group: ToolGroup.PROC, read_only: true, handler: (_a, _c, e) => pm.list(e),
      description: 'Background processes started by the AI on this computer: status, exit code, command.',
      input_schema: schema({}) },
  ];
}
