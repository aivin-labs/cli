import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR, ToolGroup } from './constants.mjs';
import { DeviceToolError, resolveInRoots, scrubEnv } from './sandbox.mjs';

/**
 * Giao việc cho agent lập trình trên máy (30/10/2026) — Claude Code trước, Codex / Gemini / Aider… sau — bằng chế độ không giao diện của
 * chính agent (`claude -p --output-format stream-json`…) thay vì gõ vào panel trong VS Code qua GUI (webview, cây trợ năng trống, giòn).
 *
 * Một bộ công cụ chung `agent.run / status / stop / sessions` + một ADAPTER mỏng mỗi agent. Adapter chỉ khai cái riêng của agent đó:
 * tìm binary, dựng tham số (chế độ quyền, nói tiếp phiên, model), đọc một dòng sự kiện ra chữ / công cụ / kết quả. Phần chung viết một lần:
 * chạy nền, chờ, đọc tiếp theo con trỏ, dừng, nhớ phiên theo thư mục, đẩy chữ lên Aivin (`ctx.onOutput`). Thêm agent = thêm adapter đã
 * kiểm cờ dòng lệnh THẬT trên máy (không đoán).
 *
 * An toàn: đề bài đi qua stdin (không lộ trong danh sách tiến trình, không dính trích dẫn của shell); chế độ quyền chỉ `plan` (chỉ đọc) /
 * `manual` (mặc định: việc cần quyền bị từ chối — chế độ không giao diện không ai trả lời hộp hỏi) / `accept_edits` (sửa tệp trong thư
 * mục) — không bao giờ chế độ bỏ qua quyền. BE xét `agent.run` như `shell.exec` (buộc hỏi người ở máy không toàn quyền): agent tự chạy lệnh.
 */

const SESSIONS_FILE = path.join(REMOTE_CONFIG_DIR, 'agent-sessions.json');
const MAX_SESSIONS = 50;
const MAX_JOBS = 4;
const DEFAULT_WAIT_MS = 90_000;
const MAX_WAIT_MS = 10 * 60_000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_ANSWER_CHARS = 12_000;
const MAX_TEXTS = 400;
const KEEP_DONE_MS = 30 * 60_000;
/** Đã chạy đủ MAX_JOBS việc cùng lúc. */
const AGENT_BUSY = 'AGENT_BUSY';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{0,60}$/i;

/** Chế độ quyền chung — mỗi adapter đổi sang cờ của agent mình; agent không có chế độ tương đương thì từ chối. */
export const AgentMode = Object.freeze({ PLAN: 'plan', MANUAL: 'manual', ACCEPT_EDITS: 'accept_edits' });

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

/** `<dir>/<exe>` của mọi thư mục trong PATH. */
function onPath(exe, env) {
  return String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe));
}

/** Claude Code (2.1.x): `-p --output-format stream-json --verbose`, `--permission-mode`, `--resume <id>`, `--model`. Kiểm thật 30/10/2026. */
export const CLAUDE_ADAPTER = Object.freeze({
  id: 'claude',
  label: 'Claude Code',
  candidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
    const exe = platform === 'win32' ? 'claude.exe' : 'claude';
    const out = [...onPath(exe, env), path.join(home, '.local', 'bin', exe), path.join(home, '.claude', 'local', exe)];
    // Bản kèm extension VS Code (người dùng chỉ cài extension, không cài CLI).
    const extRoot = path.join(home, '.vscode', 'extensions');
    try {
      for (const d of fs.readdirSync(extRoot)) if (d.startsWith('anthropic.claude-code-')) out.push(path.join(extRoot, d, 'resources', 'native-binary', exe));
    } catch { /* không có VS Code */ }
    return out;
  },
  args({ mode, resume, model }) {
    const flag = { [AgentMode.PLAN]: 'plan', [AgentMode.MANUAL]: 'manual', [AgentMode.ACCEPT_EDITS]: 'acceptEdits' }[mode];
    const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', flag];
    if (resume) argv.push('--resume', resume);
    if (model) argv.push('--model', model);
    return argv;
  },
  /** Một dòng `stream-json` → cập nhật việc; trả đoạn chữ đáng đẩy lên Aivin (chữ agent viết / công cụ nó dùng), hoặc ''. */
  parse(job, msg) {
    if (msg.session_id && !job.session_id) job.session_id = msg.session_id;
    if (msg.type === 'system' && msg.subtype === 'init') { job.model = msg.model; return ''; }
    if (msg.type === 'assistant') {
      const parts = [];
      for (const c of msg.message?.content || []) {
        if (c.type === 'text' && c.text?.trim()) { job.texts.push(c.text); parts.push(c.text); }
        if (c.type === 'tool_use') {
          const target = c.input?.file_path || c.input?.path || c.input?.command || c.input?.pattern || c.input?.url || '';
          const line = `🔧 ${c.name}${target ? ` ${String(target).slice(0, 160)}` : ''}`;
          job.tools.push(line);
          parts.push(line);
        }
      }
      return parts.join('\n');
    }
    if (msg.type === 'result') {
      job.result = {
        ok: !msg.is_error && msg.subtype === 'success', answer: String(msg.result ?? '').slice(0, MAX_ANSWER_CHARS),
        cost_usd: typeof msg.total_cost_usd === 'number' ? Math.round(msg.total_cost_usd * 10_000) / 10_000 : undefined,
        turns: msg.num_turns, duration_ms: msg.duration_ms,
      };
    }
    return '';
  },
});

export const DEFAULT_AGENT_ADAPTERS = Object.freeze([CLAUDE_ADAPTER]);

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? m.slice(1).map(Number) : null;
  } catch { return null; }
}
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

/** Bản mới nhất chạy được của một agent trên máy, hoặc null. */
export function findAgentBinary(adapter, opts = {}) {
  let best = null;
  for (const bin of [...new Set(adapter.candidates(opts))]) {
    if (!fs.existsSync(bin)) continue;
    const v = (opts.versionOf || versionOf)(bin);
    if (v && (!best || newer(v, best.version))) best = { bin, version: v };
  }
  return best ? { bin: best.bin, version: best.version.join('.') } : null;
}

/** Tham số của một lần chạy — kiểm chung (chế độ, mã phiên, model) rồi adapter dựng cờ riêng. Đề bài KHÔNG ở đây. */
export function agentArgs(adapter, { mode = AgentMode.MANUAL, resume, model } = {}) {
  if (!Object.values(AgentMode).includes(mode)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `mode must be one of: ${Object.values(AgentMode).join(', ')}`);
  if (resume && !UUID_RE.test(resume)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'session must be "new", "continue" or a session id');
  if (model && !MODEL_RE.test(model)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Bad model name');
  return adapter.args({ mode, resume, model });
}

function loadSessions() {
  try { const v = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveSessions(list) {
  try { fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true }); fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list.slice(0, MAX_SESSIONS), null, 1)); } catch { /* chỉ để tiện nói tiếp */ }
}

export function createAgentRunner({ adapters = DEFAULT_AGENT_ADAPTERS, find = findAgentBinary, spawnImpl = spawn, now = Date.now } = {}) {
  const found = new Map();
  const jobs = new Map();
  const binaryOf = (adapter) => {
    if (!found.has(adapter.id)) found.set(adapter.id, find(adapter));
    return found.get(adapter.id);
  };
  /** Agent đã cài trên máy (theo thứ tự ưu tiên của danh sách adapter). */
  const installed = () => adapters.filter((a) => binaryOf(a));
  const adapterFor = (id) => {
    const list = installed();
    if (!list.length) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No coding agent is installed on this computer (looked for: ${adapters.map((a) => a.label).join(', ')})`);
    if (!id) return list[0];
    const a = list.find((x) => x.id === id);
    if (!a) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `${id} is not installed here — available: ${list.map((x) => x.id).join(', ')}`);
    return a;
  };

  const prune = () => {
    for (const [id, j] of jobs) if (j.status !== 'running' && now() - j.endedAt > KEEP_DONE_MS) jobs.delete(id);
  };
  const view = (j, sinceText = 0, sinceTool = 0) => ({
    job: j.id, agent: j.agent, status: j.status, session_id: j.session_id, cwd: j.cwdShown, mode: j.mode, model: j.model,
    new_text: j.texts.slice(sinceText).join('\n\n').slice(-MAX_ANSWER_CHARS) || undefined,
    tools_used: j.tools.slice(sinceTool).slice(-40),
    ...(j.result ? { result: j.result } : {}),
    ...(j.error ? { error: j.error } : {}),
    next_text: j.texts.length, next_tool: j.tools.length,
  });

  function remember(j) {
    if (!j.session_id) return;
    const list = loadSessions().filter((s) => !(s.agent === j.agent && s.session_id === j.session_id));
    list.unshift({ agent: j.agent, session_id: j.session_id, cwd: j.cwd, prompt: j.prompt.slice(0, 200), at: new Date(now()).toISOString(), ok: j.result?.ok });
    saveSessions(list);
  }

  function waitDone(j, ms, signal) {
    if (j.status !== 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); j.waiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      j.waiters.add(done);
    });
  }

  async function run(args, ctx = {}, env = {}) {
    prune();
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'Give prompt (the task for the coding agent)');
    if (prompt.length > MAX_PROMPT_CHARS) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `prompt is longer than ${MAX_PROMPT_CHARS} characters`);
    if ([...jobs.values()].filter((j) => j.status === 'running').length >= MAX_JOBS) throw new DeviceToolError(AGENT_BUSY, `${MAX_JOBS} agent tasks are already running — wait or agent.stop one`);
    const adapter = adapterFor(args.agent ? String(args.agent) : undefined);
    const cwd = resolveInRoots(env.roots || [], String(args.cwd || (env.roots || [])[0] || '.'));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Folder not found: ${args.cwd}`);
    const session = String(args.session || 'new');
    const resume = session === 'new' ? undefined
      : session === 'continue' ? loadSessions().find((s) => s.agent === adapter.id && s.cwd === cwd)?.session_id
      : session;
    if (session === 'continue' && !resume) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No earlier ${adapter.label} session in this folder — use session "new"`);
    const mode = String(args.mode || AgentMode.MANUAL);
    const argv = agentArgs(adapter, { mode, resume, model: args.model ? String(args.model) : undefined });

    const j = {
      id: `${adapter.id}-${randomUUID().slice(0, 8)}`, agent: adapter.id, status: 'running', prompt, cwd, cwdShown: args.cwd || cwd, mode,
      session_id: resume, model: undefined, texts: [], tools: [], result: null, error: null, endedAt: 0, waiters: new Set(), child: null,
    };
    const child = spawnImpl(binaryOf(adapter).bin, argv, { cwd, env: scrubEnv(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    j.child = child;
    jobs.set(j.id, j);
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || typeof msg !== 'object') continue;
        const shown = adapter.parse(j, msg);
        if (j.texts.length > MAX_TEXTS) j.texts.splice(0, j.texts.length - MAX_TEXTS);
        if (shown && typeof ctx.onOutput === 'function') { try { ctx.onOutput(`${shown}\n`); } catch { /* chỉ là tiến trình */ } }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    const finish = (code) => {
      if (j.status !== 'running') return;
      j.status = j.result?.ok ? 'done' : 'failed';
      if (!j.result) j.error = (stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `${adapter.id} exited with code ${code}`).slice(0, 500);
      j.endedAt = now();
      remember(j);
      for (const w of [...j.waiters]) w();
    };
    child.on('error', (e) => { j.error = e.message; finish(-1); });
    child.on('close', (code) => finish(code));
    child.stdin.end(prompt);

    await waitDone(j, Math.min(Number(args.wait_ms) || DEFAULT_WAIT_MS, MAX_WAIT_MS), ctx.signal);
    return { ...view(j), hint: j.status === 'running' ? 'Still working — call agent.status with this job (and next_text / next_tool) to read on' : undefined };
  }

  async function status(args, ctx = {}) {
    const j = jobs.get(String(args.job || ''));
    if (!j) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No agent task ${args.job} (finished more than 30 minutes ago, or never started)`);
    await waitDone(j, Math.min(Number(args.wait_ms) || 0, MAX_WAIT_MS), ctx.signal);
    return view(j, Number(args.next_text) || 0, Number(args.next_tool) || 0);
  }

  function stop(args) {
    const j = jobs.get(String(args.job || ''));
    if (!j) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No agent task ${args.job}`);
    if (j.status === 'running') {
      try { j.child?.kill(); } catch { /* đã thoát */ }
      j.status = 'stopped'; j.endedAt = now();
      for (const w of [...j.waiters]) w();
    }
    return view(j);
  }

  function sessions(args, _ctx, env = {}) {
    const cwd = args.cwd ? resolveInRoots(env.roots || [], String(args.cwd)) : null;
    return { sessions: loadSessions().filter((s) => (!cwd || s.cwd === cwd) && (!args.agent || s.agent === args.agent)).slice(0, 20) };
  }

  return {
    run, status, stop, sessions,
    installed: () => installed().map((a) => ({ id: a.id, label: a.label, version: binaryOf(a).version })),
    stopAll: () => { for (const j of jobs.values()) if (j.status === 'running') { try { j.child?.kill(); } catch { /* đã thoát */ } } },
  };
}

/** Công cụ agent lập trình cho danh mục của Planner — `agent` liệt kê đúng các agent đã cài trên máy này. */
export function buildAgentTools(runner) {
  const agents = runner.installed();
  const list = agents.map((a) => `${a.id} (${a.label} ${a.version})`).join(', ');
  return [
    { name: 'agent.run', group: ToolGroup.PROC, handler: (a, c, e) => runner.run(a, c, e),
      description: `Give a task to a coding agent installed on this computer, in a project folder, headless — installed: ${list}. Returns its answer, the tools it used, cost and a session id to continue later. Use this instead of typing into an agent's panel in VS Code through gui.*. session: "new" (default), "continue" (the latest session of that agent in that folder) or a session id. mode: manual (default; anything needing permission is refused), plan (read-only, it only proposes), accept_edits (may edit files in the folder). Waits up to wait_ms, then returns the job still running — read on with agent.status.`,
      input_schema: schema({
        prompt: str('the task, in plain words'), agent: str(`which agent (default ${agents[0]?.id}): ${agents.map((a) => a.id).join(' | ')}`),
        cwd: str('project folder (default the first allowed folder)'), session: str('new | continue | <session id>'),
        mode: str('manual | plan | accept_edits'), model: str('optional model alias of that agent'),
        wait_ms: num(`wait for the answer up to this long (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS})`),
      }, ['prompt']) },
    { name: 'agent.status', group: ToolGroup.PROC, read_only: true, handler: (a, c) => runner.status(a, c),
      description: 'Read a running / finished coding-agent task: new text and tools since next_text / next_tool, the result when done. wait_ms waits for it to finish first.',
      input_schema: schema({ job: str('job from agent.run'), next_text: num('cursor from the previous call'), next_tool: num('cursor from the previous call'), wait_ms: num('max 600000') }, ['job']) },
    { name: 'agent.stop', group: ToolGroup.PROC, handler: (a) => runner.stop(a),
      description: 'Stop a running coding-agent task.',
      input_schema: schema({ job: str('job from agent.run') }, ['job']) },
    { name: 'agent.sessions', group: ToolGroup.PROC, read_only: true, handler: (a, c, e) => runner.sessions(a, c, e),
      description: 'Recent coding-agent sessions started from Aivin on this computer (agent, folder, first words of the task, when, ok) — to continue one.',
      input_schema: schema({ cwd: str('only sessions of this folder'), agent: str('only this agent') }) },
  ];
}
