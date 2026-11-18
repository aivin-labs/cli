import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile, execFileSync, spawn } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR, ToolGroup } from './constants.mjs';
import { DeviceToolError, agentEnv, resolveInRoots } from './sandbox.mjs';
import { accountEnv, withProcessCap } from './multiUser.mjs';
import { parseContract, parseReport, parseTestCheck, reportTemplate, sha256 } from './agentContract.mjs';

/** Thời gian tối đa cho lượt nhắc agent ghi lại REPORT.md sai khuôn (cùng phiên). */
const REPORT_REPAIR_MS = 5 * 60_000;
import { commitJobWork, gitRead, gitWrite, globToRegExp, listWorktrees, measureEvidence, resolveCommit, runVerifyCommand, worktreeState } from './agentEvidence.mjs';
import { PREVIEW_MAX_SHOTS, capturePreview } from './agentPreview.mjs';

const MAX_SCOPE_RULES = 400;
/** Mẫu kiểu gitignore → mẫu luật quyền của Claude Code, neo ở mọi tầng (`package.json` → `**\/package.json`). */
const anyDepth = (p) => {
  const q = String(p).replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return q.startsWith('**/') ? q : `**/${q}`;
};

/**
 * Phạm vi của hợp đồng thành luật CẤM của agent (11/11 → 16/11/2026: trước đây chỉ phát hiện sau khi đo). `deny_paths`: cấm sửa / ghi theo
 * đúng mẫu. `protected_paths`: không được sửa / xoá tệp ĐANG CÓ, thêm tệp mới thì được — mẫu có ký tự đại diện ở tên tệp (`**\/*.test.*`)
 * nên chỉ cấm từng tệp đang có khớp mẫu; mẫu chỉ đích danh (`package.json`, `.github/**`) cấm thẳng. Bước đo vẫn kiểm lại.
 */
export async function scopeDenyRules(contract, cwd, { gitOpts } = {}) {
  const rules = [];
  const add = (pattern) => { for (const t of ['Edit', 'Write']) rules.push(`${t}(${pattern})`); };
  for (const p of contract.scope?.deny_paths || []) add(anyDepth(p));
  // Ký tự đại diện ở TÊN TỆP (`*.test.*`) → chỉ tệp đang có; cả thư mục (`.github/**`) → cấm luôn tệp mới (CI chạy mọi tệp trong đó).
  const wildcardName = (p) => { const last = String(p).replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''; return last !== '**' && /[*?[]/.test(last); };
  const direct = (contract.scope?.protected_paths || []).filter((p) => !wildcardName(p));
  const globbed = (contract.scope?.protected_paths || []).filter(wildcardName);
  for (const p of direct) add(anyDepth(p));
  if (globbed.length) {
    let tracked = [];
    try { tracked = (await gitRead(cwd, ['ls-files', '-z'], gitOpts)).toString('utf8').split('\0').filter(Boolean); } catch { /* không phải kho */ }
    const res = globbed.map((g) => globToRegExp(g));
    for (const f of tracked) if (res.some((re) => re.test(f))) add(anyDepth(f));
  }
  return [...new Set(rules)].slice(0, MAX_SCOPE_RULES);
}

/** Tệp của thư mục job mà BE được đọc (agent.job_file) — để đưa bằng chứng, diff, log lên kho file của Aivin. */
const JOB_FILE_RE = /^(CONTRACT\.md|TEST_CHECK\.md|REPORT\.md|evidence\.json|diff\.patch|logs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.log)$/;
const MAX_JOB_FILE_CHUNK = 1024 * 1024;
const MAX_LINK_SCAN = 200_000;

/** Thư mục có liên kết (symlink / junction) bên trong không — xoá cưỡng bức đi theo liên kết là xoá cả dữ liệu thật ở nơi khác. */
function hasLinks(dir) {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > MAX_LINK_SCAN) return true;
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return false;
}

/** Cắt `buf` ở biên ký tự UTF-8 (không tách đôi một ký tự nhiều byte); trả số byte giữ lại. */
function utf8Boundary(buf, eof) {
  if (eof) return buf.length;
  let end = buf.length;
  for (let back = 0; back < 4 && end > 0 && (buf[end - 1] & 0xc0) === 0x80; back++) end--;
  if (end > 0 && buf[end - 1] >= 0xc0) end--;
  return end;
}

/**
 * Giao việc cho agent lập trình trên máy (30/10/2026) — Claude Code trước, Codex / Gemini / Aider… sau — bằng chế độ không giao diện của
 * chính agent (`claude -p --output-format stream-json`…) thay vì gõ vào panel trong VS Code qua GUI (webview, cây trợ năng trống, giòn).
 *
 * Một bộ công cụ chung `agent.run / status / stop / sessions` + một ADAPTER mỏng mỗi agent. Adapter chỉ khai cái riêng của agent đó:
 * tìm binary, dựng tham số (chế độ quyền, nói tiếp phiên, model), đọc một dòng sự kiện ra chữ / công cụ / kết quả. Phần chung viết một lần:
 * chạy nền, chờ, đọc tiếp theo con trỏ, dừng, nhớ phiên theo thư mục, đẩy chữ lên Aivin (`ctx.onOutput`). Thêm agent = thêm adapter đã
 * kiểm cờ dòng lệnh THẬT trên máy (không đoán — cờ tuỳ chọn chỉ thêm khi `--help` của bản đã cài có cờ đó).
 *
 * An toàn: đề bài đi qua stdin (không lộ trong danh sách tiến trình, không dính trích dẫn của shell); chế độ quyền chỉ `plan` (chỉ đọc) /
 * `manual` (mặc định: việc cần quyền bị từ chối — chế độ không giao diện không ai trả lời hộp hỏi) / `accept_edits` (sửa tệp trong thư
 * mục) — không bao giờ chế độ bỏ qua quyền. BE xét `agent.run` như `shell.exec` (buộc hỏi người ở máy không toàn quyền): agent tự chạy lệnh.
 *
 * Job có HỢP ĐỒNG (11/11/2026, thiết kế "Hợp đồng công việc và bằng chứng nghiệm thu"): Agentic gửi `CONTRACT.md` (+ `TEST_CHECK.md`) kèm mã
 * băm; daemon kiểm khuôn, dựng `~/.aivin/jobs/<job>/`, giao cho agent trong worktree riêng với ngân sách / quyền / thời hạn của hợp đồng,
 * KHÔNG nạp hook, quyền, MCP của repo (thư mục của khách là thư mục lạ). Agent xong thì daemon tự đo (agentEvidence.mjs) và trả
 * `evidence` + `REPORT.md` — Agentic nghiệm thu bằng số đo, không bằng lời tự khai. Mọi job có hồ sơ trên đĩa: daemon khởi động lại vẫn trả
 * lời được `agent.status` (job đang chạy lúc tắt → `interrupted`, kèm mã phiên để nói tiếp).
 */

const SESSIONS_FILE = path.join(REMOTE_CONFIG_DIR, 'agent-sessions.json');
export const JOBS_DIR = path.join(REMOTE_CONFIG_DIR, 'jobs');
const MAX_SESSIONS = 50;
const MAX_JOBS = 4;
const DEFAULT_WAIT_MS = 90_000;
const MAX_WAIT_MS = 10 * 60_000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_ANSWER_CHARS = 12_000;
const MAX_REPORT_CHARS = 64 * 1024;
const MAX_TEXTS = 400;
const MAX_DENIALS = 20;
const KEEP_DONE_MS = 30 * 60_000;
/** Hồ sơ job (thư mục job) giữ trên đĩa bao lâu. */
const KEEP_JOB_DIR_MS = 7 * 24 * 3_600_000;
/** Đã chạy đủ MAX_JOBS việc cùng lúc. */
const AGENT_BUSY = 'AGENT_BUSY';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{0,60}$/i;
const JOB_ID_RE = /^[a-z0-9]+-[0-9a-f]{8}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const RUNNING = new Set(['running', 'measuring']);

/** Chế độ quyền chung — mỗi adapter đổi sang cờ của agent mình; agent không có chế độ tương đương thì từ chối. */
export const AgentMode = Object.freeze({ PLAN: 'plan', MANUAL: 'manual', ACCEPT_EDITS: 'accept_edits' });

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });
const invalid = (msg) => new DeviceToolError(DeviceErrorCode.INVALID_ARGS, msg);

/** `<dir>/<exe>` của mọi thư mục trong PATH. */
function onPath(exe, env) {
  return String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe));
}

/** Đường dẫn tuyệt đối theo cú pháp luật quyền của Claude Code (`//` = gốc hệ thống tệp; Windows `C:\a` → `//c/a`). */
export function claudeAbsPath(abs, platform = process.platform) {
  if (platform === 'win32') {
    const m = /^([a-z]):[\\/]?(.*)$/i.exec(abs);
    if (m) return `//${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }
  return `/${abs.replace(/\\/g, '/')}`;
}

/**
 * Claude Code (2.1.x): `-p --output-format stream-json --verbose`, `--permission-mode`, `--resume <id>`, `--model`. Kiểm thật 30/10/2026.
 * Cờ của job có hợp đồng kiểm trên 2.1.322 (11/11/2026): `--worktree`, `--max-budget-usd`, `--effort`, `--allowedTools`, `--add-dir`,
 * `--settings`, `--setting-sources`, `--strict-mcp-config`, `--permission-prompts none`.
 */
/**
 * Hồ sơ tài khoản của agent lập trình (14/11/2026) — mỗi tài khoản một thư mục cấu hình riêng, truyền qua biến môi trường CHÍNH THỨC của agent
 * (`profileEnv` của adapter: Claude Code `CLAUDE_CONFIG_DIR`; adapter Codex sau này `CODEX_HOME`). Chuyển tài khoản = chọn hồ sơ, không sao chép
 * token, không đụng giao diện. Người dùng đăng nhập vào mỗi hồ sơ MỘT lần (máy không đăng nhập hộ). Thư mục: ~/.aivin/agent-profiles/<agent>/<tên>.
 */
export const AGENT_PROFILES_DIR = path.join(REMOTE_CONFIG_DIR, 'agent-profiles');
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** Thư mục hồ sơ `name` của adapter — tên sai / adapter không hỗ trợ / chưa tạo → lỗi kèm cách tạo. */
export function agentProfileDir(adapter, name, { root = AGENT_PROFILES_DIR } = {}) {
  const n = String(name || '').trim();
  if (!adapter.profileEnv) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `${adapter.label} has no account profiles on this device`);
  if (!PROFILE_NAME_RE.test(n)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'account: letters, digits, - or _ (max 40)');
  const dir = path.join(root, adapter.id, n);
  if (!fs.existsSync(dir)) {
    throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No ${adapter.label} account profile "${n}" — the person creates it once: set ${adapter.profileEnv}=${dir}, run ${adapter.id} and sign in`);
  }
  return dir;
}

/** Biến chỉ tiến trình root được mang — không lọt sang tài khoản thành viên (agent đọc đăng nhập trong HOME của chính họ). */
const ROOT_ONLY_AGENT_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'];

/**
 * Máy tính tổ chức (17/11/2026): tiến trình con của job lập trình chạy dưới tài khoản Linux của thành viên — agent, mọi lệnh git (worktree,
 * commit, đo diff) và lệnh kiểm chứng; HOME / USER của họ, có trần số tiến trình theo uid. Root không ghi gì vào kho của thành viên.
 */
export function memberSpawner(account, spawnImpl = spawn) {
  return (cmd, argv, opts = {}) => {
    const [c, a] = withProcessCap(cmd, argv);
    const env = { ...accountEnv(account, agentEnv(opts.env || process.env)), DISABLE_AUTOUPDATER: '1', BROWSER: '/bin/true', NO_COLOR: '1' };
    for (const k of ROOT_ONLY_AGENT_ENV) delete env[k];
    return spawnImpl(c, a, { ...opts, env, uid: account.uid, gid: account.gid });
  };
}

/** Đổi chủ cả cây thư mục (thư mục job cho thành viên). Lỗi từng mục bỏ qua — chỉ chạy được khi daemon là root. */
function chownTree(dir, uid, gid) {
  try { fs.chownSync(dir, uid, gid); } catch { return; }
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) chownTree(p, uid, gid);
    else { try { fs.chownSync(p, uid, gid); } catch { /* bỏ qua */ } }
  }
}

/** Thêm một mẫu vào `info/exclude` của kho (không đụng .gitignore của dự án) — thư mục worktree của job không làm bẩn `git status`. */
async function excludeFromRepo(cwd, pattern, gitOpts, owner = null) {
  try {
    const file = path.resolve(cwd, (await gitRead(cwd, ['rev-parse', '--git-path', 'info/exclude'], gitOpts)).toString().trim());
    const existed = fs.existsSync(file);
    const text = existed ? fs.readFileSync(file, 'utf8') : '';
    if (!text.split(/\r?\n/).includes(pattern)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`);
      // Máy tổ chức: tệp mới trong .git của thành viên phải thuộc về họ (daemon là root).
      if (!existed && owner) { try { fs.chownSync(file, owner.uid, owner.gid); } catch { /* bỏ qua */ } }
    }
  } catch { /* không ghi được — worktree vẫn chạy, chỉ hiện trong git status */ }
}

/** Hồ sơ đã có của từng adapter (tên thư mục). */
export function listAgentProfiles(adapters, { root = AGENT_PROFILES_DIR } = {}) {
  const out = {};
  for (const a of adapters) {
    if (!a.profileEnv) continue;
    const dir = path.join(root, a.id);
    out[a.id] = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && PROFILE_NAME_RE.test(d.name)).map((d) => d.name) : [];
  }
  return out;
}

export const CLAUDE_ADAPTER = Object.freeze({
  id: 'claude',
  label: 'Claude Code',
  profileEnv: 'CLAUDE_CONFIG_DIR',
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
  /**
   * `flags`: tập cờ bản đã cài có (từ `--help`), null = không biết → chỉ dùng cờ gốc. Cờ nhận nhiều giá trị (`--allowedTools`, `--add-dir`)
   * đặt TRƯỚC một cờ thường để không nuốt tham số sau.
   */
  args({ mode, resume, model, budgetUsd, effort, allowedTools = [], addDirs = [], worktree, projectConfig = true, settings }, flags = null) {
    const flag = { [AgentMode.PLAN]: 'plan', [AgentMode.MANUAL]: 'manual', [AgentMode.ACCEPT_EDITS]: 'acceptEdits' }[mode];
    const has = (f) => !!flags?.has(f);
    const argv = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (allowedTools.length) argv.push('--allowedTools', ...allowedTools);
    if (addDirs.length) argv.push('--add-dir', ...addDirs);
    argv.push('--permission-mode', flag);
    // Chế độ không giao diện: không ai trả lời hộp hỏi quyền — nói rõ để việc cần quyền bị từ chối ngay, không treo.
    if (has('--permission-prompts')) argv.push('--permission-prompts', 'none');
    if (!projectConfig) argv.push('--setting-sources', 'user', '--strict-mcp-config');
    if (settings) argv.push('--settings', JSON.stringify(settings));
    if (worktree) argv.push('--worktree', worktree);
    if (budgetUsd) argv.push('--max-budget-usd', String(budgetUsd));
    if (effort) argv.push('--effort', effort);
    if (resume) argv.push('--resume', resume);
    if (model) argv.push('--model', model);
    return argv;
  },
  /** Một dòng `stream-json` → cập nhật việc; trả đoạn chữ đáng đẩy lên Aivin (chữ agent viết / công cụ nó dùng), hoặc ''. */
  parse(job, msg) {
    if (msg.session_id && !job.session_id) job.session_id = msg.session_id;
    if (msg.type === 'system' && msg.subtype === 'init') {
      job.model = msg.model;
      if (typeof msg.cwd === 'string') job.session_cwd = msg.cwd;
      return '';
    }
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
      if (msg.subtype && msg.subtype !== 'success') job.result.stop_reason = msg.subtype;
      // Việc agent muốn làm mà bị từ chối (thiếu luật cho phép) — Agentic cần biết để sửa hợp đồng, không phải để agent tự vượt.
      const denials = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
      if (denials.length) {
        job.result.permission_denials = denials.slice(0, MAX_DENIALS).map((d) => {
          const target = d.tool_input?.command || d.tool_input?.file_path || d.tool_input?.path || d.tool_input?.url || '';
          return { tool: String(d.tool_name || ''), ...(target ? { target: String(target).slice(0, 200) } : {}) };
        });
      }
    }
    return '';
  },
});

/** Thư mục cài Codex đi kèm extension VS Code (openai.chatgpt-*), theo nền tảng. */
function codexExtensionBins(home, exe) {
  const sub = process.platform === 'win32' ? 'windows-x86_64' : `${process.platform}-${os.arch()}`;
  const root = path.join(home, '.vscode', 'extensions');
  try {
    return fs.readdirSync(root).filter((d) => d.startsWith('openai.chatgpt-')).sort().reverse().map((d) => path.join(root, d, 'bin', sub, exe));
  } catch { return []; }
}

/**
 * Codex CLI (17/11/2026) — `codex exec --json`, đề bài qua stdin. Đã đo trên bản 0.169 (Windows): `-s workspace-write` một mình bị chặn mọi
 * lệnh ("blocked by policy"), `--approve-for-me` (sandbox workspace-write + duyệt tự động) chạy được; chỉ đọc = `-s read-only`. Không có cờ
 * ngân sách (thời hạn hợp đồng vẫn do daemon cắt), không quản worktree theo tên → daemon tự dựng worktree (`selfWorktree: false`).
 * `exec resume` không nhận cờ sandbox / duyệt → vòng sửa mở phiên MỚI trong worktree cũ (`resumable: false`; hợp đồng + lời nhắc đủ ngữ cảnh).
 */
export const CODEX_ADAPTER = Object.freeze({
  id: 'codex',
  label: 'Codex',
  profileEnv: 'CODEX_HOME',
  selfWorktree: false,
  resumable: false,
  helpArgs: ['exec', '--help'],
  candidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
    const exe = platform === 'win32' ? 'codex.exe' : 'codex';
    return [...onPath(exe, env), path.join(home, '.local', 'bin', exe), ...codexExtensionBins(home, exe)];
  },
  args({ mode, model, effort, addDirs = [] }) {
    const argv = ['exec', '--json', '--ignore-user-config', '--ignore-rules'];
    // Chế độ quyền chung → sandbox của Codex. "manual" (việc cần quyền bị từ chối) không có tương đương an toàn → chỉ đọc.
    if (mode === AgentMode.ACCEPT_EDITS) argv.push('--approve-for-me');
    else argv.push('-s', 'read-only');
    for (const d of addDirs) argv.push('--add-dir', d);
    if (model) argv.push('-m', model);
    if (effort) argv.push('-c', `model_reasoning_effort="${effort === 'xhigh' || effort === 'max' ? 'high' : effort}"`);
    argv.push('-');
    return argv;
  },
  /** Một dòng JSONL của `codex exec --json` → cập nhật việc; trả đoạn chữ đáng đẩy lên Aivin. */
  parse(job, msg) {
    if (msg.type === 'thread.started' && typeof msg.thread_id === 'string' && !job.session_id) { job.session_id = msg.thread_id; return ''; }
    const item = msg.item;
    if (msg.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
      job.texts.push(item.text);
      return item.text;
    }
    if (msg.type === 'item.started' && item && item.type !== 'agent_message' && item.type !== 'reasoning') {
      const target = item.command || (Array.isArray(item.changes) ? item.changes.map((c) => c.path).join(', ') : '') || '';
      const line = `🔧 ${item.type}${target ? ` ${String(target).slice(0, 160)}` : ''}`;
      job.tools.push(line);
      return line;
    }
    if (msg.type === 'turn.completed') {
      job.result = {
        ok: true, answer: String(job.texts[job.texts.length - 1] || '').slice(0, MAX_ANSWER_CHARS),
        usage: { input_tokens: msg.usage?.input_tokens, output_tokens: msg.usage?.output_tokens },
      };
    }
    if (msg.type === 'turn.failed' || msg.type === 'error') {
      job.result = { ok: false, answer: String(msg.error?.message || msg.message || 'Codex error').slice(0, MAX_ANSWER_CHARS), stop_reason: 'error' };
    }
    return '';
  },
});

export const DEFAULT_AGENT_ADAPTERS = Object.freeze([CLAUDE_ADAPTER, CODEX_ADAPTER]);

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? m.slice(1).map(Number) : null;
  } catch { return null; }
}
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

/** Các cờ `--xxx` mà `--help` của binary liệt kê, hoặc null khi không đọc được. Bất đồng bộ — không chặn daemon. */
export function helpFlags(bin, helpArgs = ['--help']) {
  return new Promise((resolve) => {
    execFile(bin, helpArgs, { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      resolve(err ? null : new Set(String(out).match(/--[a-z][a-z-]+/gi) || []));
    });
  });
}

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

/** Tham số của một lần chạy — kiểm chung (chế độ, mã phiên, model, ngân sách) rồi adapter dựng cờ riêng. Đề bài KHÔNG ở đây. */
export function agentArgs(adapter, { mode = AgentMode.MANUAL, resume, model, budgetUsd, effort, ...rest } = {}, flags = null) {
  if (!Object.values(AgentMode).includes(mode)) throw invalid(`mode must be one of: ${Object.values(AgentMode).join(', ')}`);
  if (resume && !UUID_RE.test(resume)) throw invalid('session must be "new", "continue" or a session id');
  if (model && !MODEL_RE.test(model)) throw invalid('Bad model name');
  if (budgetUsd !== undefined && !(Number(budgetUsd) > 0 && Number(budgetUsd) <= 200)) throw invalid('max_budget_usd must be above 0 and at most 200');
  if (effort !== undefined && !EFFORTS.includes(effort)) throw invalid(`effort must be one of: ${EFFORTS.join(', ')}`);
  const argv = adapter.args({ mode, resume, model, budgetUsd: budgetUsd === undefined ? undefined : Number(budgetUsd), effort, ...rest }, flags);
  // Bản đã cài không có cờ cần thiết → từ chối thay vì để agent báo lỗi lạ (hoặc bỏ qua giới hạn).
  const missing = flags ? argv.filter((a) => a.startsWith('--') && !flags.has(a)) : [];
  if (missing.length) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `${adapter.label} on this computer is too old for ${missing.join(', ')} — update it`);
  return argv;
}

function loadSessions() {
  try { const v = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveSessions(list) {
  try { fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true }); fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list.slice(0, MAX_SESSIONS), null, 1)); } catch { /* chỉ để tiện nói tiếp */ }
}

/** Đề bài của job có hợp đồng: trỏ tới các file, khuôn REPORT.md, quy tắc đặt tên test. Phần "what / why" nằm trong CONTRACT.md. */
function contractPrompt({ jobId, jobDir, contract, hasTestCheck, note }) {
  const report = path.join(jobDir, 'REPORT.md');
  return [
    `You are doing one job for Aivin. The job contract is ${path.join(jobDir, 'CONTRACT.md')} — read it first. It says what to do, why, the limits and how the work will be judged. How to do it is up to you.`,
    hasTestCheck ? `The project's test checks are in ${path.join(jobDir, 'TEST_CHECK.md')}. Cover every check of the flows named in the contract (test_check.flows), following each business rule and the 8 groups of cases.` : '',
    'Rules:',
    '- Do not edit CONTRACT.md or TEST_CHECK.md. If the scope must change, stop and say so in REPORT.md (needs_scope_change: true).',
    '- Stay inside the current folder for code changes. Do not touch paths the contract denies or protects (you may add new files).',
    '- Name every automated test you write or run for a check so its name contains the check id (for example "CK-031 order at 23:30 keeps its day"). The device re-runs the tests and matches results by that id.',
    '- Do not skip, disable or delete existing tests to make things pass.',
    '- If you propose a new check under "Ca kiểm mới" with id NEW-n and method auto, write its test too and put NEW-n in the test name — the device measures it like the others.',
    contract.setup?.length ? `- Before running tests, run the setup commands of the contract (setup) in the current folder: ${contract.setup.map((s) => s.argv.join(' ')).join(' ; ')}.` : '',
    `When you finish (or stop), write ${report} exactly in this format — frontmatter holds short values only, sentences go in the sections; keep EVERY section heading even when it has nothing (an empty "# Phần chưa làm" or "# Ca kiểm mới" is fine), and delete only the example check under "Ca kiểm mới" if you propose none:`,
    '',
    reportTemplate({ jobId, contractId: contract.contract_id }),
    note ? `\nNote from Aivin: ${note}` : '',
  ].filter((l) => l !== '').join('\n');
}

export function createAgentRunner({
  adapters = DEFAULT_AGENT_ADAPTERS, find = findAgentBinary, spawnImpl = spawn, now = Date.now, jobsDir = JOBS_DIR, measure = measureEvidence, probeFlags = helpFlags,
  profilesRoot = AGENT_PROFILES_DIR,
  /** Máy tính tổ chức: tài khoản Linux của thành viên ({ name, uid, gid, home }) — mọi tiến trình con chạy dưới tài khoản này. */
  runAs = null,
} = {}) {
  const childSpawn = runAs ? memberSpawner(runAs, spawnImpl) : spawnImpl;
  /** Lệnh git của job: dưới tài khoản thành viên khi có (tệp trong .git của họ không thuộc root). */
  const gitOpts = runAs ? { spawnImpl: childSpawn } : undefined;
  const found = new Map();
  const flagCache = new Map();
  const jobs = new Map();
  const binaryOf = (adapter) => {
    if (!found.has(adapter.id)) found.set(adapter.id, find(adapter));
    return found.get(adapter.id);
  };
  const flagsOf = async (adapter) => {
    const b = binaryOf(adapter);
    if (b?.flags) return new Set(b.flags);
    if (!flagCache.has(adapter.id)) flagCache.set(adapter.id, b ? Promise.resolve(probeFlags(b.bin, adapter.helpArgs)).catch(() => null) : null);
    return flagCache.get(adapter.id);
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

  // --- Hồ sơ job trên đĩa: `<jobsDir>/<job>/job.json` (+ CONTRACT.md, TEST_CHECK.md, REPORT.md, evidence.json, logs/ của job có hợp đồng).
  const dirOf = (id) => path.join(jobsDir, id);
  const RECORD_KEYS = ['id', 'agent', 'status', 'cwd', 'cwdShown', 'mode', 'model', 'session_id', 'worktree', 'baseCommit', 'contractId', 'contractSha', 'continuedFrom', 'delivery', 'worktreeRemoved', 'reportRepaired', 'startedAt', 'endedAt', 'result', 'error'];
  function persist(j) {
    try {
      fs.mkdirSync(dirOf(j.id), { recursive: true });
      fs.writeFileSync(path.join(dirOf(j.id), 'job.json'), JSON.stringify({ ...Object.fromEntries(RECORD_KEYS.map((k) => [k, j[k]])), prompt: j.prompt.slice(0, 200) }, null, 1));
    } catch { /* hồ sơ chỉ để trả lời sau khi khởi động lại */ }
  }
  /** Lần đầu dựng runner: nạp job cũ còn hồ sơ; job đang chạy lúc daemon tắt → `interrupted`. Dọn hồ sơ quá hạn. */
  function restore() {
    let names;
    try { names = fs.readdirSync(jobsDir); } catch { return; }
    for (const name of names) {
      if (!JOB_ID_RE.test(name)) continue;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(dirOf(name), 'job.json'), 'utf8')); } catch { continue; }
      if (rec.id !== name) continue;
      if (now() - (rec.endedAt || rec.startedAt || 0) > KEEP_JOB_DIR_MS) {
        try { fs.rmSync(dirOf(name), { recursive: true, force: true }); } catch { /* lần sau */ }
        continue;
      }
      const j = { ...rec, prompt: rec.prompt || '', texts: [], tools: [], waiters: new Set(), child: null, restored: true };
      if (RUNNING.has(j.status)) {
        j.status = 'interrupted';
        j.error = 'The Aivin agent on this device restarted while this job was running — continue it with session set to its session_id';
        j.endedAt = now();
        persist(j);
      }
      jobs.set(j.id, j);
    }
  }
  restore();

  const prune = () => {
    for (const [id, j] of jobs) if (!RUNNING.has(j.status) && now() - j.endedAt > KEEP_DONE_MS && !j.contractId) jobs.delete(id);
  };
  const readJobFile = (j, name, max) => {
    try { const s = fs.readFileSync(path.join(dirOf(j.id), name), 'utf8'); return s.length > max ? `${s.slice(0, max)}\n…` : s; } catch { return undefined; }
  };
  const view = (j, sinceText = 0, sinceTool = 0) => {
    const out = {
      job: j.id, agent: j.agent, status: j.status, session_id: j.session_id, cwd: j.cwdShown, mode: j.mode, model: j.model,
      new_text: j.texts.slice(sinceText).join('\n\n').slice(-MAX_ANSWER_CHARS) || undefined,
      tools_used: j.tools.slice(sinceTool).slice(-40),
      ...(j.result ? { result: j.result } : {}),
      ...(j.error ? { error: j.error } : {}),
      next_text: j.texts.length, next_tool: j.tools.length,
    };
    if (j.contractId) {
      Object.assign(out, {
        contract_id: j.contractId, contract_sha256: j.contractSha, job_dir: dirOf(j.id), worktree: j.worktree || undefined,
        ...(j.delivery ? { delivery: j.delivery } : {}), ...(j.worktreeRemoved ? { worktree_removed: true } : {}), ...(j.reportRepaired ? { report_repaired: true } : {}),
      });
      if (!RUNNING.has(j.status)) {
        const evidence = readJobFile(j, 'evidence.json', 4 * 1024 * 1024);
        try { if (evidence) out.evidence = JSON.parse(evidence); } catch { /* hỏng → không gửi */ }
        out.report_md = readJobFile(j, 'REPORT.md', MAX_REPORT_CHARS);
      }
    }
    return out;
  };

  function remember(j) {
    if (!j.session_id) return;
    const list = loadSessions().filter((s) => !(s.agent === j.agent && s.session_id === j.session_id));
    list.unshift({ agent: j.agent, session_id: j.session_id, cwd: j.cwd, prompt: j.prompt.slice(0, 200), at: new Date(now()).toISOString(), ok: j.result?.ok, ...(j.account ? { account: j.account } : {}) });
    saveSessions(list);
  }

  function waitDone(j, ms, signal) {
    if (!RUNNING.has(j.status)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); j.waiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      j.waiters.add(done);
    });
  }
  const wake = (j) => { for (const w of [...j.waiters]) w(); };

  /**
   * Job có hợp đồng: kiểm khuôn + mã băm, dựng thư mục job, tính cờ của agent từ hợp đồng. Trả phần riêng của job (gộp vào `j`) + tham số
   * cho adapter. Mọi lỗi ở đây xảy ra TRƯỚC khi agent chạy (không có gì thay đổi).
   */
  async function prepareContract(args, env, jobId, prev, adapter) {
    const text = String(args.contract);
    if (!args.contract_sha256) throw invalid('contract_sha256 is required with contract (the sha256 of CONTRACT.md Aivin issued)');
    const parsed = parseContract(text, { expectedSha: String(args.contract_sha256) });
    if (!parsed.ok) throw invalid(`CONTRACT.md is not valid: ${parsed.errors.slice(0, 12).join('; ')}`);
    const { contract } = parsed;
    let testCheckText = null;
    if (contract.test_check) {
      if (typeof args.test_check !== 'string' || !args.test_check.trim()) throw invalid('the contract names test_check — send TEST_CHECK.md as test_check');
      testCheckText = args.test_check;
      if (contract.test_check.sha256 && sha256(testCheckText) !== contract.test_check.sha256) throw invalid('TEST_CHECK.md does not match test_check.sha256 in the contract');
      const tc = parseTestCheck(testCheckText);
      if (!tc.ok) throw invalid(`TEST_CHECK.md is not valid: ${tc.errors.slice(0, 12).join('; ')}`);
      const missingFlows = contract.test_check.flows.filter((f) => !tc.flows.some((x) => x.id === f));
      if (missingFlows.length) throw invalid(`TEST_CHECK.md has no flow ${missingFlows.join(', ')}`);
    }
    // Vòng sửa (`continue_job`): làm tiếp trong worktree của job trước, diff vẫn tính từ commit gốc của lần đầu.
    const cwd = prev ? prev.cwd : resolveInRoots(env.roots || [], String(args.cwd || contract.workspace.cwd || (env.roots || [])[0] || '.'));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Folder not found: ${args.cwd || contract.workspace.cwd}`);
    if (prev?.worktree && !fs.existsSync(prev.worktree)) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `The worktree of ${prev.id} is gone: ${prev.worktree}`);
    const isolate = prev ? !!prev.worktree : contract.workspace.isolation === 'worktree';
    const baseCommit = prev ? prev.baseCommit : await resolveCommit(cwd, contract.workspace.base_ref, gitOpts);
    if (isolate && !baseCommit) throw invalid(`worktree isolation needs a git repository with ${contract.workspace.base_ref} in ${args.cwd || cwd}`);
    // Daemon tự dựng worktree (17/11/2026) khi agent không tự quản worktree theo tên (Codex) hoặc hợp đồng đi từ commit khác HEAD (việc nối
    // tiếp việc trước) — agent tự dựng thì luôn từ HEAD. Nhánh `aivin/<job>`, thư mục `<repo>/.aivin-worktrees/<job>` (loại khỏi git status).
    let ownWorktree = null;
    // Máy tổ chức: daemon luôn tự dựng worktree (dưới tài khoản thành viên) — không để agent dựng bằng đường dẫn root không biết trước.
    if (!prev && isolate && (runAs || adapter.selfWorktree === false || (baseCommit !== (await resolveCommit(cwd, 'HEAD', gitOpts))))) {
      ownWorktree = path.join(cwd, '.aivin-worktrees', jobId);
      await excludeFromRepo(cwd, '/.aivin-worktrees/', gitOpts, runAs);
      await gitWrite(cwd, ['worktree', 'add', '-q', '-b', `aivin/${jobId}`, ownWorktree, baseCommit], gitOpts);
    }

    const jobDir = dirOf(jobId);
    fs.mkdirSync(path.join(jobDir, 'logs'), { recursive: true });
    const writeLocked = (name, body) => { const f = path.join(jobDir, name); fs.writeFileSync(f, body); try { fs.chmodSync(f, 0o444); } catch { /* chỉ là lớp phụ — mã băm mới là lớp chặn */ } };
    writeLocked('CONTRACT.md', text);
    if (testCheckText !== null) writeLocked('TEST_CHECK.md', testCheckText);
    // Thư mục job thuộc về thành viên: agent của họ đọc hợp đồng + ghi REPORT.md (sửa CONTRACT.md thì mã băm bắt).
    if (runAs) chownTree(jobDir, runAs.uid, runAs.gid);
    // Agent chỉ được ghi REPORT.md trong thư mục job; hợp đồng, bộ check và bằng chứng là của Aivin / daemon.
    const deny = [
      ...['CONTRACT.md', 'TEST_CHECK.md', 'evidence.json', 'job.json', 'logs/**'].flatMap((n) => ['Edit', 'Write'].map((t) => `${t}(${claudeAbsPath(path.join(jobDir, n))})`)),
      // Phạm vi chặn TRƯỚC (không chỉ phát hiện sau): `npm test` được phép + sửa được package.json = chạy được mọi lệnh.
      ...(await scopeDenyRules(contract, cwd, { gitOpts })),
    ];
    return {
      job: {
        contract, contractId: contract.contract_id, contractSha: parsed.sha256, hasTestCheck: testCheckText !== null, testCheckText,
        baseCommit, mainStateBefore: isolate ? await worktreeState(cwd, gitOpts) : null, isolate,
        ...(prev ? { worktree: prev.worktree, fixedWorktree: !!prev.worktree, continuedFrom: prev.id } : {}),
        ...(ownWorktree ? { worktree: ownWorktree, fixedWorktree: true } : {}),
      },
      cwd,
      spawnCwd: prev?.worktree || ownWorktree || cwd,
      agentOpts: {
        mode: contract.permissions.mode, budgetUsd: contract.limits.max_budget_usd, effort: contract.limits.effort,
        allowedTools: contract.permissions.allowed_tools, addDirs: [jobDir], worktree: isolate && !prev && !ownWorktree ? jobId : undefined, projectConfig: false,
        settings: { permissions: { deny } },
      },
      wallMs: contract.limits.max_wall_ms,
    };
  }

  /** Worktree agent đã tạo cho job: thư mục phiên (sự kiện init) nếu đúng là một worktree của kho; không thì tìm theo tên job. */
  async function findJobWorktree(j) {
    const trees = await listWorktrees(j.cwd, gitOpts);
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    if (j.session_cwd && !same(j.session_cwd, j.cwd) && trees.some((t) => same(t, j.session_cwd))) return path.resolve(j.session_cwd);
    return trees.find((t) => !same(t, j.cwd) && path.basename(t) === j.id) || null;
  }

  /** Agent xong → daemon đo. Lỗi đo không làm mất kết quả của agent. */
  /**
   * REPORT.md sai khuôn (hoặc chưa ghi) → nhắc agent ghi lại MỘT lần trong cùng phiên, trước khi đo (thiết kế: "sai thì yêu cầu ghi lại trong
   * cùng phiên, vẫn sai thì coi là chưa giao đủ"). Rẻ hơn cả một vòng sửa (đo lại + agent đọc lại hợp đồng) chỉ vì thiếu một tiêu đề mục.
   */
  async function repairReport(j) {
    if (!j.respawn || j.abort.signal.aborted) return;
    const fresh = j.respawn.adapter.resumable === false;
    if (!fresh && !j.session_id) return;
    const file = path.join(dirOf(j.id), 'REPORT.md');
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* chưa ghi */ }
    const parsed = text === null ? { ok: false, errors: ['REPORT.md was not written'] } : parseReport(text, { contractId: j.contractId });
    if (parsed.ok) return;
    const { adapter, opts, flags, env, bin } = j.respawn;
    let argv;
    try { argv = agentArgs(adapter, { ...opts, worktree: undefined, resume: fresh ? undefined : j.session_id }, flags); } catch { return; }
    // Agent không nói tiếp phiên được (Codex): phiên mới không thấy khuôn lúc đầu → gửi kèm khuôn mẫu.
    const format = fresh ? `\n\nThe agreed format:\n${reportTemplate({ jobId: j.id, contractId: j.contractId })}` : '';
    const prompt = `${file} is not in the agreed format: ${parsed.errors.slice(0, 8).join('; ')}. Rewrite only REPORT.md, exactly in the ${fresh ? 'format below' : 'format given at the start'} (keep every section heading, even when empty). Do not change any other file.${format}`;
    await new Promise((resolve) => {
      let child;
      try { child = childSpawn(bin, argv, { cwd: j.worktree || j.respawn.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch { resolve(); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* đã thoát */ } }, REPORT_REPAIR_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      child.stdout?.on?.('data', () => undefined);
      child.stderr?.on?.('data', () => undefined);
      child.stdin?.on?.('error', () => undefined);
      child.on('close', done);
      child.on('error', done);
      child.stdin.end(prompt);
    });
    j.reportRepaired = true;
  }

  async function finishContractJob(j) {
    if (j.isolate && !j.fixedWorktree) j.worktree = await findJobWorktree(j).catch(() => null);
    // Sau khi biết worktree: phiên của agent nằm ở đó, nói tiếp phải đúng thư mục ấy.
    await repairReport(j).catch(() => undefined);
    // Đầu ra `git_branch`: commit thay đổi của worktree lên nhánh của job TRƯỚC khi đo — bằng chứng gắn đúng một commit.
    if (j.worktree && j.contract?.outputs?.some((o) => o.kind === 'git_branch')) {
      try {
        j.delivery = await commitJobWork(j.worktree, `aivin: ${j.contractId} v${j.contract.version} (job ${j.id})`, { jobId: j.id, ...(gitOpts || {}) });
      } catch (e) { j.delivery = { error: e.message.slice(0, 300) }; }
    }
    persist(j);
    try {
      const evidence = await measure({
        job: { id: j.id, contractSha: j.contractSha, worktree: j.worktree, cwd: j.cwd, baseCommit: j.baseCommit, mainStateBefore: j.mainStateBefore, delivery: j.delivery },
        contract: j.contract, testCheck: j.hasTestCheck ? parseTestCheck(j.testCheckText) : null, jobDir: dirOf(j.id), signal: j.abort.signal,
        ...(runAs ? { gitOpts, runCommand: (cmd, o) => runVerifyCommand(cmd, { ...o, spawnImpl: childSpawn }) } : {}),
      });
      if (j.isolate && !j.worktree) {
        evidence.worktree_missing = true;
        try { fs.writeFileSync(path.join(dirOf(j.id), 'evidence.json'), JSON.stringify(evidence, null, 1)); } catch { /* đã trả qua status */ }
      }
      if (evidence.contract_tampered) j.error = 'contract_tampered: CONTRACT.md changed during the job';
    } catch (e) {
      j.error = `Measuring failed: ${e.message}`;
    }
  }

  async function run(args, ctx = {}, env = {}) {
    prune();
    const withContract = args.contract !== undefined && args.contract !== null && args.contract !== '';
    const prompt = String(args.prompt || '').trim();
    if (!prompt && !withContract) throw invalid('Give prompt (the task for the coding agent) or contract (CONTRACT.md)');
    if (prompt.length > MAX_PROMPT_CHARS) throw invalid(`prompt is longer than ${MAX_PROMPT_CHARS} characters`);
    if ([...jobs.values()].filter((j) => RUNNING.has(j.status)).length >= MAX_JOBS) throw new DeviceToolError(AGENT_BUSY, `${MAX_JOBS} agent tasks are already running — wait or agent.stop one`);
    const adapter = adapterFor(args.agent ? String(args.agent) : undefined);
    const account = args.account ? String(args.account).trim() : '';
    if (runAs && account) throw invalid('account profiles are not used on an organisation computer — each member signs in to the agent with their own account');
    const accountDir = account ? agentProfileDir(adapter, account, { root: profilesRoot }) : null;
    const jobId = `${adapter.id}-${randomUUID().slice(0, 8)}`;

    let cwd;
    let spawnCwd;
    let extra = {};
    let agentOpts;
    let wallMs = 0;
    let prev = null;
    if (args.continue_job) {
      prev = jobs.get(String(args.continue_job));
      if (!prev?.contractId || !prev.session_id) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No contract job ${args.continue_job} with a session to continue`);
      if (RUNNING.has(prev.status)) throw invalid(`${prev.id} is still running`);
      if (!withContract) throw invalid('continue_job needs the contract (the same or a new version)');
    }
    if (withContract) {
      const prep = await prepareContract(args, env, jobId, prev, adapter);
      ({ cwd, spawnCwd, agentOpts, wallMs } = prep);
      extra = prep.job;
    } else {
      cwd = resolveInRoots(env.roots || [], String(args.cwd || (env.roots || [])[0] || '.'));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Folder not found: ${args.cwd}`);
      agentOpts = {
        mode: String(args.mode || AgentMode.MANUAL), budgetUsd: args.max_budget_usd ?? undefined, effort: args.effort ? String(args.effort) : undefined,
        projectConfig: args.project_config !== false,
      };
    }
    const session = prev ? (adapter.resumable === false ? 'new' : prev.session_id) : String(args.session || 'new');
    const resume = session === 'new' ? undefined
      : session === 'continue' ? loadSessions().find((s) => s.agent === adapter.id && s.cwd === cwd && (s.account || '') === account)?.session_id
      : session;
    if (session === 'continue' && !resume) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No earlier ${adapter.label} session in this folder — use session "new"`);
    // Nói tiếp một phiên: agent đã có worktree từ lần đầu — không tạo thêm.
    if (resume && agentOpts.worktree) agentOpts = { ...agentOpts, worktree: undefined };
    let argv;
    try {
      const flags = await flagsOf(adapter);
      // Job có hợp đồng mà không đọc được cờ của bản đã cài → không chắc giới hạn (ngân sách, worktree…) được áp — từ chối.
      if (withContract && !flags) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Cannot read the options of ${adapter.label} on this computer — contract jobs need them`);
      argv = agentArgs(adapter, { ...agentOpts, resume, model: args.model ? String(args.model) : undefined }, flags);
    } catch (e) {
      if (withContract) fs.rmSync(dirOf(jobId), { recursive: true, force: true });
      throw e;
    }
    const fullPrompt = withContract
      ? contractPrompt({ jobId, jobDir: dirOf(jobId), contract: extra.contract, hasTestCheck: extra.hasTestCheck, note: prompt })
      : prompt;

    const j = {
      id: jobId, agent: adapter.id, status: 'running', prompt: prompt || `contract ${extra.contractId}`, cwd, cwdShown: args.cwd || cwd, mode: agentOpts.mode,
      session_id: resume, model: undefined, texts: [], tools: [], result: null, error: null, startedAt: now(), endedAt: 0, waiters: new Set(), child: null,
      abort: new AbortController(), ...extra, ...(account ? { account } : {}),
    };
    // Hồ sơ tài khoản: thư mục cấu hình riêng qua biến môi trường chính thức của agent — phiên / đăng nhập / hạn mức của tài khoản đó.
    const childEnv = accountDir ? { ...agentEnv(process.env), [adapter.profileEnv]: accountDir } : agentEnv(process.env);
    const child = childSpawn(binaryOf(adapter).bin, argv, { cwd: spawnCwd || cwd, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    j.child = child;
    // Gọi lại cùng phiên (nhắc ghi lại REPORT.md) cần đúng tệp chạy, cờ, môi trường của lần này.
    if (withContract) j.respawn = { adapter, bin: binaryOf(adapter).bin, opts: { ...agentOpts, model: args.model ? String(args.model) : undefined }, flags: await flagsOf(adapter), env: childEnv, cwd: spawnCwd || cwd };
    jobs.set(j.id, j);
    persist(j);
    const wall = wallMs ? setTimeout(() => {
      if (j.status !== 'running') return;
      j.error = `Stopped at the contract time limit (${Math.round(wallMs / 60_000)} min)`;
      try { j.child?.kill(); } catch { /* đã thoát */ }
    }, wallMs) : null;
    wall?.unref?.();
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
    child.stdin.on?.('error', () => undefined);
    const finish = async (code) => {
      if (j.status !== 'running') return;
      clearTimeout(wall);
      const agentOk = !!j.result?.ok;
      if (!j.result && !j.error) j.error = (stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `${adapter.id} exited with code ${code}`).slice(0, 500);
      if (j.contractId) {
        j.status = 'measuring';
        persist(j);
        await finishContractJob(j);
        if (j.status !== 'measuring') return; // bị dừng giữa lúc đo
      }
      j.status = agentOk && !j.error?.startsWith('contract_tampered') ? 'done' : 'failed';
      j.endedAt = now();
      remember(j);
      persist(j);
      wake(j);
    };
    child.on('error', (e) => { j.error = e.message; void finish(-1); });
    child.on('close', (code) => { void finish(code); });
    child.stdin.end(fullPrompt);

    await waitDone(j, Math.min(Number(args.wait_ms) || DEFAULT_WAIT_MS, MAX_WAIT_MS), ctx.signal);
    return { ...view(j), hint: RUNNING.has(j.status) ? 'Still working — call agent.status with this job (and next_text / next_tool) to read on' : undefined };
  }

  async function status(args, ctx = {}) {
    const j = jobs.get(String(args.job || ''));
    if (!j) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No agent task ${args.job} (finished more than 30 minutes ago, or never started)`);
    await waitDone(j, Math.min(Number(args.wait_ms) || 0, MAX_WAIT_MS), ctx.signal);
    return view(j, Number(args.next_text) || 0, Number(args.next_tool) || 0);
  }

  function halt(j, reason) {
    if (!RUNNING.has(j.status)) return;
    try { j.child?.kill(); } catch { /* đã thoát */ }
    j.abort?.abort();
    j.status = 'stopped';
    if (reason) j.error = reason;
    j.endedAt = now();
    persist(j);
    wake(j);
  }

  function stop(args) {
    const j = jobs.get(String(args.job || ''));
    if (!j) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No agent task ${args.job}`);
    halt(j);
    return view(j);
  }

  const contractJob = (args) => {
    const j = jobs.get(String(args.job || ''));
    if (!j?.contractId) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `No contract job ${args.job}`);
    return j;
  };

  /** Đọc một tệp của thư mục job theo khúc (BE đưa lên kho file). */
  function jobFile(args) {
    const j = contractJob(args);
    const name = String(args.name || '').replace(/\\/g, '/');
    if (!JOB_FILE_RE.test(name)) throw invalid('name must be CONTRACT.md, TEST_CHECK.md, REPORT.md, evidence.json, diff.patch or logs/<command>.log');
    const file = path.join(dirOf(j.id), name);
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `${name} is not in job ${j.id}`); }
    try {
      const size = fs.fstatSync(fd).size;
      const offset = Math.max(0, Math.min(size, Math.trunc(Number(args.offset) || 0)));
      const want = Math.max(1, Math.min(MAX_JOB_FILE_CHUNK, Math.trunc(Number(args.max_bytes) || 256 * 1024)));
      const buf = Buffer.alloc(Math.min(want, size - offset));
      const read = buf.length ? fs.readSync(fd, buf, 0, buf.length, offset) : 0;
      const keep = utf8Boundary(buf.subarray(0, read), offset + read >= size);
      return { job: j.id, name, size, offset, bytes: keep, next_offset: offset + keep, eof: offset + keep >= size, text: buf.subarray(0, keep).toString('utf8') };
    } finally { fs.closeSync(fd); }
  }

  /**
   * Gỡ worktree của job sau khi Aivin đã nhận kết quả (nhánh giao kết quả vẫn giữ). Worktree có liên kết bên trong → từ chối, để người dọn
   * tay (xoá cưỡng bức đi theo junction là xoá dữ liệu thật ở nơi khác).
   */
  async function cleanup(args) {
    const j = contractJob(args);
    if (RUNNING.has(j.status)) throw invalid(`${j.id} is still running`);
    if (!j.worktree || j.worktreeRemoved) return { job: j.id, removed: false, reason: 'no worktree to remove' };
    const wt = j.worktree;
    const known = (await listWorktrees(j.cwd, gitOpts)).some((t) => path.resolve(t).toLowerCase() === path.resolve(wt).toLowerCase());
    if (!known) throw invalid(`${wt} is not a worktree of ${j.cwdShown}`);
    if (hasLinks(wt)) throw invalid(`${wt} contains links (symlink / junction) — remove it by hand so nothing outside it is deleted`);
    await gitWrite(j.cwd, ['worktree', 'unlock', wt], gitOpts).catch(() => undefined);
    await gitWrite(j.cwd, ['worktree', 'remove', '--force', wt], gitOpts);
    j.worktreeRemoved = true;
    persist(j);
    return { job: j.id, removed: true, worktree: wt, ...(j.delivery?.branch ? { branch_kept: j.delivery.branch } : {}) };
  }

  /**
   * Cổng khớp wireframe (18/11/2026): chạy app của job trong worktree của nó, chụp các đường dẫn BE nêu, tắt app (agentPreview.mjs). Chỉ khi job
   * đã đo xong và worktree còn. Máy tổ chức: lệnh mở app chạy dưới tài khoản thành viên như lệnh verify.
   */
  async function preview(args, ctx) {
    const j = contractJob(args);
    if (RUNNING.has(j.status)) throw invalid(`${j.id} is still running`);
    if (!j.worktree || j.worktreeRemoved) throw invalid(`${j.id} has no worktree any more — preview runs before cleanup`);
    try {
      return { job: j.id, ...(await capturePreview(args, { cwd: j.worktree, spawnApp: childSpawn, signal: ctx?.signal })) };
    } catch (e) {
      throw invalid(e.message);
    }
  }

  function sessions(args, _ctx, env = {}) {
    const cwd = args.cwd ? resolveInRoots(env.roots || [], String(args.cwd)) : null;
    return { sessions: loadSessions().filter((s) => (!cwd || s.cwd === cwd) && (!args.agent || s.agent === args.agent)).slice(0, 20) };
  }

  return {
    run, status, stop, sessions, jobFile, cleanup, preview,
    profiles: () => ({ profiles: listAgentProfiles(installed(), { root: profilesRoot }) }),
    installed: () => installed().map((a) => ({ id: a.id, label: a.label, version: binaryOf(a).version })),
    /** Còn job đang chạy / đang đo — daemon không tự khởi động lại để cập nhật lúc này. */
    hasRunning: () => [...jobs.values()].some((j) => RUNNING.has(j.status)),
    stopAll: (reason = 'The Aivin agent on this device stopped') => { for (const j of jobs.values()) halt(j, reason); },
  };
}

/** Công cụ agent lập trình cho danh mục của Planner — `agent` liệt kê đúng các agent đã cài trên máy này. */
export function buildAgentTools(runner) {
  const agents = runner.installed();
  const list = agents.map((a) => `${a.id} (${a.label} ${a.version})`).join(', ');
  return [
    { name: 'agent.run', group: ToolGroup.PROC, handler: (a, c, e) => runner.run(a, c, e),
      description: `Give a task to a coding agent installed on this computer, in a project folder, headless — installed: ${list}. Returns its answer, the tools it used, cost and a session id to continue later. Use this instead of typing into an agent's panel in VS Code through gui.*. session: "new" (default), "continue" (the latest session of that agent in that folder) or a session id. mode: manual (default; anything needing permission is refused), plan (read-only, it only proposes), accept_edits (may edit files in the folder). Waits up to wait_ms, then returns the job still running — read on with agent.status. With contract (CONTRACT.md + contract_sha256, and test_check when the contract names one) the job runs by the contract — its own worktree, budget, permissions and time limit, no project hooks or MCP — and when it ends the device measures it and returns evidence and report_md.`,
      input_schema: schema({
        prompt: str('the task, in plain words (with contract: an optional extra note)'), agent: str(`which agent (default ${agents[0]?.id}): ${agents.map((a) => a.id).join(' | ')}`),
        cwd: str('project folder (default the first allowed folder, or workspace.cwd of the contract)'), session: str('new | continue | <session id>'),
        mode: str('manual | plan | accept_edits (with contract: from permissions.mode)'), model: str('optional model alias of that agent'),
        max_budget_usd: num('stop the agent once it has spent this much (without contract)'), effort: str('low | medium | high | xhigh | max (without contract)'),
        project_config: bool('load the folder\'s own agent settings, hooks and MCP servers (default true; false for a folder you do not trust; always false with contract)'),
        contract: str('CONTRACT.md text issued by Aivin'), contract_sha256: str('sha256 of that CONTRACT.md'), test_check: str('TEST_CHECK.md text, when the contract names test_check'),
        continue_job: str('fix round: an earlier contract job — continue its session in its worktree (send the contract again)'),
        account: str('run as this account profile of the agent (from agent.profiles) — its own sign-in, sessions and usage limits; default: the usual account of the agent'),
        wait_ms: num(`wait for the answer up to this long (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS})`),
      }) },
    { name: 'agent.status', group: ToolGroup.PROC, read_only: true, handler: (a, c) => runner.status(a, c),
      description: 'Read a running / finished coding-agent task: new text and tools since next_text / next_tool, the result when done (with a contract also evidence and report_md). wait_ms waits for it to finish first.',
      input_schema: schema({ job: str('job from agent.run'), next_text: num('cursor from the previous call'), next_tool: num('cursor from the previous call'), wait_ms: num('max 600000') }, ['job']) },
    { name: 'agent.stop', group: ToolGroup.PROC, handler: (a) => runner.stop(a),
      description: 'Stop a running coding-agent task.',
      input_schema: schema({ job: str('job from agent.run') }, ['job']) },
    { name: 'agent.job_file', group: ToolGroup.PROC, read_only: true, internal: true, handler: (a) => runner.jobFile(a),
      description: 'BE-only: read a file of a contract job (REPORT.md, evidence.json, diff.patch, logs/<command>.log…) in chunks from offset.',
      input_schema: schema({ job: str('contract job'), name: str('file name'), offset: num('byte offset'), max_bytes: num('chunk size, max 1048576') }, ['job', 'name']) },
    { name: 'agent.cleanup', group: ToolGroup.PROC, internal: true, handler: (a) => runner.cleanup(a),
      description: "BE-only: remove a finished contract job's worktree (the delivery branch is kept).",
      input_schema: schema({ job: str('contract job') }, ['job']) },
    { name: 'agent.preview', group: ToolGroup.PROC, internal: true, handler: (a, c) => runner.preview(a, c),
      description: "BE-only: start the app of a finished contract job inside its worktree (argv), wait for url to answer, screenshot each shot path headless, stop the app. Returns PNGs (base64) to compare with the wireframe.",
      input_schema: schema({
        job: str('contract job'), argv: { type: 'array', items: { type: 'string' }, description: 'command that starts the app, as words' },
        url: str('base address on this computer, e.g. http://localhost:5173'), ready_timeout_ms: num('wait this long for the app to answer (max 600000)'),
        shots: { type: 'array', items: { type: 'object', properties: { id: str('screen id'), path: str('path starting with /'), device: str('desktop | tablet | mobile') } }, description: `at most ${PREVIEW_MAX_SHOTS} screens` },
      }, ['job', 'argv', 'url', 'shots']) },
    { name: 'agent.profiles', group: ToolGroup.PROC, read_only: true, handler: () => runner.profiles(),
      description: 'Account profiles of each installed coding agent on this computer (each has its own sign-in and usage limits). Pass one as account to agent.run to switch account without any UI. The person creates a profile once by signing in to it.',
      input_schema: schema({}) },
    { name: 'agent.sessions', group: ToolGroup.PROC, read_only: true, handler: (a, c, e) => runner.sessions(a, c, e),
      description: 'Recent coding-agent sessions started from Aivin on this computer (agent, folder, first words of the task, when, ok) — to continue one.',
      input_schema: schema({ cwd: str('only sessions of this folder'), agent: str('only this agent') }) },
  ];
}
