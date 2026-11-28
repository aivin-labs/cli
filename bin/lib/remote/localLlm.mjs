import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR, ToolGroup } from './constants.mjs';
import { DeviceToolError, agentEnv } from './sandbox.mjs';
import { CLAUDE_ADAPTER, findAgentBinary } from './codingAgents.mjs';
import { readConnector } from './lightcodeAgent.mjs';
import { MEMBER_LLM_AGENTS, MEMBER_LLM_DIR, createSignInChecker, memberSpawnArgs } from './localLlmMembers.mjs';

/**
 * Mô hình trên máy cho BE (16/11/2026, bản thử) — BE gọi `llm.complete` như gọi một LLM: chỉ dẫn + lịch sử → chữ trả lời. Chạy bằng agent
 * lập trình người dùng đã đăng nhập sẵn trên máy (gói của chính họ): Claude Code, Codex, Antigravity (`agy`). Không phải agent: không công
 * cụ, không cài đặt / hook / MCP / tệp ngữ cảnh của dự án (thư mục rỗng riêng), không lưu phiên khi agent cho phép.
 *
 * Mỗi agent một ADAPTER, đã kiểm thật trên máy (16/11/2026):
 * - Claude Code 2.1.325: `-p --input-format stream-json` + `--tools ""` (không có công cụ nào), stream từng token.
 * - Codex 0.169: `exec --json --ephemeral --sandbox read-only` + tắt các tính năng công cụ (`--disable code_mode_host`… → công cụ báo lỗi,
 *   không đọc được tệp); chỉ trả cả câu một lần ở cuối.
 * - Antigravity `agy` 1.5.9: ACP (`agy acp`). Chế độ print tự chạy lệnh shell / ghi tệp kể cả với `--mode plan` / `--sandbox` / luật
 *   `permissions.deny` — ACP thì lệnh phải xin quyền (máy luôn từ chối), nhưng đọc tệp / tìm web không cần xin.
 * Lưới an toàn chung: agent gọi BẤT KỲ công cụ nào → dừng ngay, bỏ câu trả lời, báo `LOCAL_LLM_TOOL_USE` (BE chuyển sang cloud) — chữ có thể
 * mang nội dung tệp trên máy không bao giờ lên BE.
 *
 * Nhanh: giữ sẵn một tiến trình đã khởi động (ACP: đã mở phiên + chọn model) cho mỗi (agent, model, effort); một tiến trình phục vụ ĐÚNG
 * MỘT lời gọi rồi đóng (không dính ngữ cảnh lời gọi trước), một tiến trình mới được giữ sẵn thay chỗ.
 */

export const LLM_DIR = path.join(REMOTE_CONFIG_DIR, 'llm');
const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{0,60}$/i;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_INPUT_CHARS = 400_000;
const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const WARM_IDLE_MS = 10 * 60_000;
const MAX_WARM_KEYS = 4;
/** Tiến trình giữ sẵn cho MỖI (agent, model, effort): lượt chat gọi song song vài lời gọi cùng loại — một tiến trình thì lời gọi thứ hai khởi động
 * nguội (~1 s). Tổng có trần (`MAX_WARM_PROCS`, mỗi tiến trình Claude Code ~200 MB). Đổi bằng `AIVIN_LLM_WARM_PER_KEY`. */
const WARM_PER_KEY = Math.min(4, Math.max(1, Number(process.env.AIVIN_LLM_WARM_PER_KEY) || 2));
const MAX_WARM_PROCS = 6;
/** Antigravity (ACP): tiến trình phục vụ xong một lời gọi thì mở phiên mới trên CHÍNH nó và quay lại pool — lời gọi sau khỏi khởi động agy
 *  (initialize + session/new + set_model, 2–4 s). Mỗi tiến trình vẫn một lời gọi một lúc; đủ số lượt này thì thay tiến trình mới (agy giữ
 *  các phiên đã mở trong bộ nhớ). */
const ACP_MAX_USES = 40;
/** Mã lỗi riêng: agent định dùng công cụ — câu trả lời bị bỏ. */
export const TOOL_USE_ERROR = 'LOCAL_LLM_TOOL_USE';
export const QUOTA_ERROR = 'LOCAL_LLM_QUOTA';
/** LightCode giữ phần hạn mức còn lại cho phiên code của chủ máy (`reason: "reserved"`) → chuyển cloud, không gọi thẳng agent khác trên cùng máy. */
export const QUOTA_RESERVED_ERROR = 'LOCAL_LLM_QUOTA_RESERVED';
/** Chủ máy đã tắt `complete` trong LightCode (`code: "disabled"` / HTTP 403) → bỏ qua lightcode, dùng đường cũ. */
export const LIGHTCODE_DISABLED_ERROR = 'LOCAL_LLM_DISABLED';
/** LightCode quá số lời gọi đồng thời (`code: "busy"` / HTTP 503) → thử dự phòng, không khoá hạn mức. */
export const LIGHTCODE_BUSY_ERROR = 'LOCAL_LLM_BUSY';
/** Model không tạo được JSON khớp `json_schema` kể cả sau lượt tự sửa (`code: "invalid_json"` / HTTP 502) → thử dự phòng/cloud, không khoá hạn mức. */
export const INVALID_JSON_ERROR = 'LOCAL_LLM_INVALID_JSON';
/** Agent chưa đăng nhập / phiên đăng nhập hết hạn (máy tính tổ chức: thành viên chưa đăng nhập agent của mình). BE chạy cloud. */
export const NOT_SIGNED_IN_ERROR = 'LOCAL_LLM_NOT_SIGNED_IN';
const AUTH_ERROR_RE = /please run \/login|not (?:logged|signed) in|invalid api key|oauth token (?:has )?expired|token (?:has )?(?:expired|been revoked)|authentication_error|401 unauthorized|refresh token/i;

/** Mã lỗi theo câu báo của agent: chưa đăng nhập / hết hạn mức / lỗi thường (undefined). */
export function agentErrorCode(message) {
  const text = String(message || '');
  if (AUTH_ERROR_RE.test(text)) return NOT_SIGNED_IN_ERROR;
  if (/limit|quota/i.test(text)) return QUOTA_ERROR;
  return undefined;
}
const BASE_SYSTEM = 'You are a language model answering requests from the Aivin server through an API. You have no tools and must not call any. Follow the instructions inside each request exactly; when it asks for JSON, reply with that JSON only, no prose and no code fence.';

const invalid = (msg) => new DeviceToolError(DeviceErrorCode.INVALID_ARGS, msg);
const failed = (msg, code = DeviceErrorCode.EXECUTION_FAILED) => new DeviceToolError(code, msg);
const str = (description) => ({ type: 'string', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

/**
 * Một lời gọi → nội dung tin nhắn gửi agent. Chỉ dẫn hệ thống của BE nằm trong tin nhắn (cờ hệ thống cố định lúc giữ sẵn), lịch sử thành bản
 * ghi hội thoại, schema thành yêu cầu trả JSON. `withBase`: agent không nhận được chỉ dẫn hệ thống riêng (Codex, agy) → đặt lời dặn chung lên đầu.
 */
export function renderRequest({ system, messages = [], prompt, json_schema: jsonSchema }, { withBase = false } = {}) {
  const parts = [];
  if (withBase) parts.push(`<rules>\n${BASE_SYSTEM}\n</rules>`);
  if (system) parts.push(`<instructions>\n${system}\n</instructions>`);
  const turns = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m.content === 'string' && m.content.trim());
  const last = prompt ? null : turns.at(-1)?.role === 'user' ? turns.pop() : null;
  if (turns.length) {
    parts.push(`<conversation>\n${turns.map((m) => `<${m.role === 'assistant' ? 'assistant' : 'user'}>\n${m.content}\n</${m.role === 'assistant' ? 'assistant' : 'user'}>`).join('\n')}\n</conversation>`);
  }
  const ask = prompt || last?.content;
  if (!ask) throw invalid('prompt or a last user message is required');
  parts.push(turns.length || withBase ? `<request>\n${ask}\n</request>` : ask);
  if (jsonSchema) {
    const text = typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema);
    parts.push(`Reply with one JSON value that matches this JSON Schema, and nothing else:\n${text}`);
  }
  return parts.join('\n\n');
}

/** Lấy JSON từ câu trả lời (mô hình có khi vẫn bọc ```json). Không đọc được → null. */
export function extractJson(text) {
  const t = String(text || '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? fenced[1] : t;
  try { return JSON.parse(body); } catch { /* thử cắt từ dấu mở đầu tiên */ }
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function onPath(exe, env = process.env) {
  return String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe));
}

/** Bản mới nhất trong các thư mục kiểu `<root>/<prefix>-<version>-…/<rel>` (extension VS Code). */
function extensionBins(root, prefix, rel) {
  try {
    return fs.readdirSync(root).filter((d) => d.startsWith(prefix)).sort().reverse().map((d) => path.join(root, d, rel));
  } catch { return []; }
}

function firstExisting(list) {
  return [...new Set(list)].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function versionOf(bin, args = ['--version']) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (err, out) => {
      const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(String(out || ''));
      resolve(err && !m ? null : m?.[1] || null);
    });
  });
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// Adapter. `kind`: 'stream' (dòng JSON vào stdin, giữ stdin mở), 'stdin' (ghi đề rồi đóng stdin), 'acp' (Agent Client Protocol, JSON-RPC).
// `parse(msg, st)` gọi st.delta(text) / st.final(text) / st.done() / st.fail(err) / st.tool(name) / st.meta({ model, usage }).
// ------------------------------------------------------------------------------------------------------------------------------------------

const exe = (name, platform = process.platform) => (platform === 'win32' ? `${name}.exe` : name);

export const CLAUDE_LLM = Object.freeze({
  id: 'claude',
  label: 'Claude Code',
  kind: 'stream',
  find: () => findAgentBinary(CLAUDE_ADAPTER),
  args({ model, effort }) {
    const argv = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
      '--system-prompt', BASE_SYSTEM,
    ];
    if (model) argv.push('--model', model);
    if (effort) argv.push('--effort', effort);
    return argv;
  },
  encode: (content) => `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`,
  parse(m, st) {
    if (m.type === 'stream_event') {
      const ev = m.event || {};
      if (ev.type === 'message_start') st.meta({ model: ev.message?.model });
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') return st.tool(ev.content_block.name);
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) st.delta(ev.delta.text);
      if (ev.type === 'message_delta') {
        st.meta({ stop_reason: ev.delta?.stop_reason });
        if (ev.usage) st.meta({ usage: { input_tokens: ev.usage.input_tokens, output_tokens: ev.usage.output_tokens } });
      }
      // Chốt khi mô hình dừng — dòng `result` đến sau một lượt tóm tắt (~0,8 s).
      if (ev.type === 'message_stop') st.done();
      return;
    }
    if (m.type === 'result') {
      if (m.is_error) return st.fail(failed(String(m.result || m.subtype || 'Model error').slice(0, 500), agentErrorCode(m.result)));
      if (typeof m.result === 'string') st.final(m.result);
      st.done();
    }
  },
});

/** Tính năng công cụ của Codex tắt cho chế độ mô hình (chỉ tắt những cái bản đã cài có — cờ lạ làm Codex báo lỗi). */
const CODEX_TOOL_FEATURES = ['code_mode_host', 'shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'skill_search', 'tool_suggest', 'sleep_tool'];
/** Mục Codex không phải công cụ. */
const CODEX_TEXT_ITEMS = new Set(['agent_message', 'reasoning', 'error', 'todo_list']);

export const CODEX_LLM = Object.freeze({
  id: 'codex',
  label: 'Codex',
  kind: 'stdin',
  find({ env = process.env, home = os.homedir() } = {}) {
    const bin = firstExisting([
      ...onPath(exe('codex'), env),
      path.join(home, '.local', 'bin', exe('codex')),
      ...extensionBins(path.join(home, '.vscode', 'extensions'), 'openai.chatgpt-', path.join('bin', process.platform === 'win32' ? 'windows-x86_64' : `${process.platform}-${os.arch()}`, exe('codex'))),
    ]);
    return bin ? { bin } : null;
  },
  async probe(bin) {
    const out = await new Promise((resolve) => execFile(bin, ['features', 'list'], { encoding: 'utf8', timeout: 20_000, windowsHide: true }, (e, o) => resolve(e ? '' : String(o))));
    const known = new Set(out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
    return { disable: CODEX_TOOL_FEATURES.filter((f) => known.has(f)) };
  },
  args({ model, effort, cwd, probe }) {
    const argv = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--ignore-user-config', '-s', 'read-only', '-C', cwd, '-c', 'web_search="disabled"'];
    for (const f of probe?.disable || []) argv.push('--disable', f);
    if (model) argv.push('-m', model);
    if (effort) argv.push('-c', `model_reasoning_effort="${effort}"`);
    argv.push('-');
    return argv;
  },
  encode: (content) => content,
  parse(m, st) {
    const item = m.item;
    if ((m.type === 'item.started' || m.type === 'item.completed') && item && !CODEX_TEXT_ITEMS.has(item.type)) return st.tool(item.type);
    // Codex chỉ trả cả câu; có khi nói vài câu "đang làm…" trước — câu CUỐI là câu trả lời.
    if (m.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') st.final(item.text);
    if (m.type === 'turn.completed') {
      st.meta({ usage: { input_tokens: m.usage?.input_tokens, output_tokens: m.usage?.output_tokens } });
      st.done();
    }
    if (m.type === 'turn.failed' || m.type === 'error') {
      const msg = String(m.error?.message || m.message || 'Codex error');
      st.fail(failed(msg.slice(0, 500), agentErrorCode(msg)));
    }
  },
});

/** `gemini-3.8-flash` + effort → id model của agy (`gemini-3.8-flash-low`); không có đúng effort → effort gần nhất. */
export function pickAgyModel(available, model, effort) {
  const ids = (available || []).map((m) => (typeof m === 'string' ? m : m?.modelId)).filter(Boolean);
  if (!ids.length) return null;
  if (model && ids.includes(model)) return model;
  const order = ['low', 'medium', 'high', 'xhigh'];
  const family = model ? ids.filter((id) => id.startsWith(`${model}-`) && order.includes(id.slice(model.length + 1))) : [];
  if (!family.length) return model ? null : ids[0];
  const want = order.indexOf(effort === 'max' ? 'xhigh' : effort || 'medium');
  return family.sort((a, b) => Math.abs(order.indexOf(a.slice(model.length + 1)) - want) - Math.abs(order.indexOf(b.slice(model.length + 1)) - want))[0];
}

export const ANTIGRAVITY_LLM = Object.freeze({
  id: 'antigravity',
  label: 'Antigravity',
  kind: 'acp',
  find({ env = process.env, home = os.homedir() } = {}) {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const bin = firstExisting([...onPath(exe('agy'), env), path.join(local, 'agy', 'bin', exe('agy')), path.join(home, '.local', 'bin', exe('agy'))]);
    return bin ? { bin } : null;
  },
  args: () => ['acp', '--disable-telemetry'],
});

export const LIGHTCODE_LLM = Object.freeze({
  id: 'lightcode',
  label: 'LightCode',
  kind: 'http',
  dynamic: true,
  find() {
    const conn = readConnector();
    return conn ? { bin: `http://127.0.0.1:${conn.port}`, version: conn.app_version || null, connector: conn } : null;
  },
});

export const DEFAULT_LLM_ADAPTERS = Object.freeze([CLAUDE_LLM, CODEX_LLM, ANTIGRAVITY_LLM, LIGHTCODE_LLM]);

/** Câu báo hết hạn mức agy gửi như một đoạn trả lời bình thường. */
const AGY_QUOTA_RE = /^\s*⚠?\s*(individual )?quota reached/i;

// ------------------------------------------------------------------------------------------------------------------------------------------

export function createLocalLlm({
  adapters = DEFAULT_LLM_ADAPTERS, spawnImpl = spawn, fetchImpl = globalThis.fetch, dir = LLM_DIR, now = Date.now, idleMs = WARM_IDLE_MS, version = versionOf,
  warmPerKey = WARM_PER_KEY, maxWarmProcs = MAX_WARM_PROCS,
  // Máy tính tổ chức: lời gọi nào cũng phải mang tài khoản thành viên (`ctx.runAs`) — agent chạy dưới tài khoản đó, không bao giờ bằng root.
  memberMode = false, memberDir = MEMBER_LLM_DIR, signIn: signInOverride,
} = {}) {
  if (memberMode) adapters = adapters.filter((a) => MEMBER_LLM_AGENTS.includes(a.id));
  const found = new Map();
  const probes = new Map();
  const versions = new Map();
  const binOf = (a) => {
    if (a.dynamic) {
      try {
        const hit = a.find() || null;
        found.set(a.id, hit);
        if (hit?.version) versions.set(a.id, hit.version);
        return hit;
      } catch {
        found.set(a.id, null);
        return null;
      }
    }
    if (!found.has(a.id)) { try { found.set(a.id, a.find() || null); } catch { found.set(a.id, null); } }
    return found.get(a.id);
  };
  const installed = () => adapters.filter((a) => binOf(a));
  const adapterFor = (id) => {
    const list = installed();
    if (!list.length) throw failed('No coding agent that can serve as a model is installed on this computer', DeviceErrorCode.NOT_FOUND);
    if (!id) return list[0];
    const a = list.find((x) => x.id === id);
    if (!a) throw failed(`${id} is not installed here — available: ${list.map((x) => x.id).join(', ')}`, DeviceErrorCode.NOT_FOUND);
    return a;
  };
  const probeOf = (a) => {
    if (!a.probe) return Promise.resolve(null);
    if (!probes.has(a.id)) probes.set(a.id, Promise.resolve(a.probe(binOf(a).bin)).catch(() => null));
    return probes.get(a.id);
  };
  for (const a of installed()) {
    Promise.resolve(binOf(a).version || version(binOf(a).bin)).then((v) => versions.set(a.id, v || null)).catch(() => {});
  }
  const signIn = memberMode ? (signInOverride || createSignInChecker({ binOf, dir: memberDir })) : null;
  /** Tài khoản thành viên của lời gọi; chế độ máy tổ chức mà thiếu → từ chối (không chạy agent bằng root). */
  const accountOf = (ctx) => {
    const account = ctx?.runAs || null;
    if (memberMode && !account) throw invalid('This shared computer runs models only for a member — the call has no member');
    return memberMode ? account : null;
  };
  /** Máy tổ chức: thành viên chưa đăng nhập agent → lỗi ngay, không khởi động agent. */
  async function assertSignedIn(adapter, account) {
    if (!account || !signIn) return;
    if (!(await signIn.status(adapter, account))) {
      throw failed(`${adapter.label} is not signed in for this member on this shared computer — sign in from Aivin first`, NOT_SIGNED_IN_ERROR);
    }
  }

  /** key → { procs: Promise<proc>[], lastUsed } — các tiến trình đã khởi động, chưa nhận lời gọi nào. */
  const warm = new Map();
  const warmCount = () => [...warm.values()].reduce((n, w) => n + w.procs.length, 0);
  let sweeper = null;

  // --- Một tiến trình. stream / stdin: chỉ là child. acp: child + phiên đã mở + model đã chọn (`ready`).
  function startProc(adapter, { model, effort, account = null }) {
    if (!account) fs.mkdirSync(dir, { recursive: true });
    const bin = binOf(adapter).bin;
    const proc = { adapter, model, effort, account, child: null, ready: null, rpc: null, exited: false };
    const cwd = account ? memberDir : dir;
    const launch = (argv) => {
      // Thành viên máy tổ chức: chạy dưới tài khoản Linux của họ (HOME riêng → đăng nhập agent của chính họ), có trần số tiến trình.
      const [cmd, args, opts] = account
        ? memberSpawnArgs(account, bin, argv, { dir: memberDir })
        : [bin, argv, { cwd: dir, env: agentEnv(process.env), windowsHide: true }];
      const child = spawnImpl(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', () => { proc.exited = true; });
      child.once('exit', () => { proc.exited = true; });
      child.stderr?.on('data', (d) => { proc.stderr = ((proc.stderr || '') + d).slice(-4000); });
      return child;
    };
    if (adapter.kind === 'acp') {
      proc.child = launch(adapter.args());
      proc.rpc = acpClient(proc.child);
      proc.initialized = proc.rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      proc.initialized.catch(() => {});
      openAcpSession(proc);
      return Promise.resolve(proc);
    }
    return probeOf(adapter).then((probe) => {
      proc.child = launch(adapter.args({ model, effort, cwd, probe }));
      return proc;
    });
  }

  /** Mở một phiên ACP mới (đã initialize một lần cho cả tiến trình) với đúng model / effort của tiến trình → `proc.ready`. */
  function openAcpSession(proc) {
    const { adapter, model, effort } = proc;
    proc.sessionId = null;
    proc.modelId = null;
    proc.ready = (async () => {
      await proc.initialized;
      const sess = await proc.rpc.call('session/new', { cwd: proc.account ? memberDir : dir, mcpServers: [] });
      const modelId = pickAgyModel(sess?.models?.availableModels, model, effort);
      if (model && !modelId) throw failed(`${adapter.label} has no model "${model}" here`, DeviceErrorCode.NOT_FOUND);
      if (modelId && modelId !== sess?.models?.currentModelId) await proc.rpc.call('session/set_model', { sessionId: sess.sessionId, modelId });
      return { sessionId: sess.sessionId, modelId: modelId || sess?.models?.currentModelId };
    })();
    proc.ready.catch(() => {});
  }

  function closeProc(proc) {
    if (!proc) return;
    try { proc.child?.stdin?.end(); } catch { /* đã đóng */ }
    try { proc.child?.kill(); } catch { /* đã thoát */ }
  }

  // Máy tổ chức: tiến trình giữ sẵn của thành viên nào chỉ phục vụ thành viên đó (đã đăng nhập bằng tài khoản của họ).
  const keyOf = (adapter, opts) => `${opts.account?.name ? `${opts.account.name}|` : ''}${adapter.id}|${opts.model || ''}|${opts.effort || ''}`;

  function entryFor(key) {
    let entry = warm.get(key);
    if (!entry) {
      while (warm.size >= MAX_WARM_KEYS) {
        const [oldest] = [...warm.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        closeWarm(oldest);
      }
      entry = { procs: [], lastUsed: now() };
      warm.set(key, entry);
    }
    entry.lastUsed = now();
    return entry;
  }

  /** ACP xong một lời gọi thành công → phiên mới trên chính tiến trình đó, đưa lên đầu pool (nóng hơn tiến trình mới dựng). */
  function recycleAcp(proc) {
    proc.uses = (proc.uses || 0) + 1;
    const entry = entryFor(keyOf(proc.adapter, proc));
    if (proc.exited || proc.uses >= ACP_MAX_USES || entry.procs.length >= warmPerKey || warmCount() >= maxWarmProcs) return closeProc(proc);
    proc.rpc.onNotify = null;
    proc.rpc.onRequest = null;
    openAcpSession(proc);
    entry.procs.unshift(Promise.resolve(proc));
  }

  function keepWarm(adapter, opts) {
    const key = keyOf(adapter, opts);
    const entry = entryFor(key);
    // Đủ số cho loại này, tổng còn chỗ thì mới dựng thêm; loại khác ít dùng nhất nhường chỗ khi tổng đầy.
    while (entry.procs.length < warmPerKey) {
      if (warmCount() >= maxWarmProcs) {
        const victim = [...warm.entries()].filter(([k, w]) => k !== key && w.procs.length).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!victim) break;
        victim[1].procs.pop()?.then(closeProc, () => {});
      }
      const p = startProc(adapter, opts);
      entry.procs.push(p);
      p.catch(() => { const i = entry.procs.indexOf(p); if (i >= 0) entry.procs.splice(i, 1); });
    }
    if (!sweeper) {
      sweeper = setInterval(() => { for (const [k, w] of warm) if (now() - w.lastUsed > idleMs) closeWarm(k); if (!warm.size) { clearInterval(sweeper); sweeper = null; } }, 60_000);
      sweeper.unref?.();
    }
  }

  function closeWarm(key) {
    const w = warm.get(key);
    warm.delete(key);
    for (const p of w?.procs || []) p.then(closeProc, () => {});
  }

  async function take(adapter, opts) {
    const key = keyOf(adapter, opts);
    const w = warm.get(key);
    const pending = w?.procs.shift();
    let proc = pending ? await pending.catch(() => null) : null;
    const warmStart = !!proc && !proc.exited;
    if (!warmStart) { closeProc(proc); proc = await startProc(adapter, opts); }
    // ACP: tiến trình này quay lại pool khi xong (recycleAcp) — bù chỗ lúc đó, không dựng thêm ngay (đầy pool thì nó không quay lại được).
    if (adapter.kind !== 'acp') setImmediate(() => keepWarm(adapter, opts));
    return { proc, warmStart };
  }

  function cleanLocalImages(raw) {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw invalid('images must be an array of local file paths');
    if (raw.length > 4) throw invalid('images supports at most 4 files');
    const out = raw.map((item) => {
      if (typeof item !== 'string') throw invalid('each image must be a local file path string');
      const p = item.trim();
      if (!p || p.length > 1000 || /^(https?:|data:|blob:)/i.test(p)) {
        throw invalid('each image must be a non-empty local file path');
      }
      return p;
    });
    return out.length ? out : undefined;
  }

  function validate(args) {
    const adapter = adapterFor(args.agent ? String(args.agent) : '');
    const model = args.model ? String(args.model) : '';
    if (model && !MODEL_RE.test(model)) throw invalid('Bad model name');
    const effort = args.effort ? String(args.effort) : '';
    if (effort && !EFFORTS.includes(effort)) throw invalid(`effort must be one of: ${EFFORTS.join(', ')}`);
    const images = cleanLocalImages(args.images);
    if (images?.length && adapter.kind !== 'http') {
      throw invalid('images are only supported via LightCode');
    }
    return { adapter, model, effort, images };
  }

  function throwLightcodeError(body, status) {
    const code = body?.code;
    const resetNote = body?.reset_at ? ` (resets at ${body.reset_at})` : '';
    if (code === 'disabled' || status === 403) {
      throw failed(body?.error || 'LightCode completion is disabled', LIGHTCODE_DISABLED_ERROR);
    }
    if (code === 'busy' || status === 503) {
      throw failed(body?.error || 'LightCode is busy', LIGHTCODE_BUSY_ERROR);
    }
    if (code === 'invalid_json') {
      throw failed(body?.error || 'LightCode did not return valid JSON matching json_schema', INVALID_JSON_ERROR);
    }
    if (code === 'quota_exceeded' || status === 429) {
      const errCode = body?.reason === 'reserved' ? QUOTA_RESERVED_ERROR : QUOTA_ERROR;
      throw failed(`${body?.error || 'All LightCode accounts are out of quota'}${resetNote}`, errCode);
    }
    throw failed(body?.error || (status ? `LightCode answered ${status}` : 'LightCode completion failed'));
  }

  async function completeViaLightcodeHttp(adapter, args, ctx) {
    const info = binOf(adapter);
    const conn = info?.connector;
    if (!conn?.port || !conn?.key) throw failed('LightCode is not running on this computer', DeviceErrorCode.NOT_FOUND);
    const startedAt = now();
    const timeoutMs = Math.min(Number(args.timeout_ms) || ctx.timeoutMs || DEFAULT_TIMEOUT_MS, 10 * 60_000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    ctx.signal?.addEventListener?.('abort', onOuterAbort, { once: true });
    try {
      const res = await fetchImpl(`http://127.0.0.1:${conn.port}/connector/v1/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.key}` },
        body: JSON.stringify({
          ...(args.prompt ? { prompt: String(args.prompt) } : {}),
          ...(args.system ? { system: String(args.system) } : {}),
          ...(Array.isArray(args.messages) ? { messages: args.messages } : {}),
          ...(args.json_schema ? { json_schema: args.json_schema } : {}),
          ...(Array.isArray(args.images) && args.images.length ? { images: args.images } : {}),
          ...(args.tier ? { tier: String(args.tier) } : {}),
          ...(args.provider && args.provider !== 'auto' ? { provider: String(args.provider) } : {}),
          ...(args.effort ? { effort: String(args.effort) } : {}),
          timeout_ms: timeoutMs,
          stream: true,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throwLightcodeError(errBody, res.status);
      }
      const decoder = new TextDecoder();
      let buf = '';
      let accText = '';
      let finalMsg = null;
      let ttft = null;
      const handleLine = (line) => {
        const s = line.trim();
        if (!s) return;
        let msg;
        try { msg = JSON.parse(s); } catch { return; }
        if (msg?.type === 'delta' && typeof msg.text === 'string') {
          if (ttft === null) ttft = now() - startedAt;
          accText += msg.text;
          if (typeof ctx.onOutput === 'function') { try { ctx.onOutput('stdout', msg.text); } catch { /* bỏ qua */ } }
        } else if (msg?.type === 'result') {
          finalMsg = msg;
        }
      };
      if (res.body) {
        for await (const chunk of res.body) {
          if (ctrl.signal.aborted) break;
          buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) handleLine(line);
        }
        if (buf.trim()) handleLine(buf);
      } else {
        finalMsg = await res.json().catch(() => null);
      }
      if (finalMsg && !finalMsg.ok) throwLightcodeError(finalMsg);
      const text = typeof finalMsg?.text === 'string' ? finalMsg.text : accText;
      if (!text && finalMsg?.json === undefined) throw failed('LightCode returned an empty answer');
      return {
        text,
        ...(finalMsg?.json !== undefined ? { json: finalMsg.json } : {}),
        agent: 'lightcode',
        model: finalMsg?.model || 'auto',
        ...(finalMsg?.provider ? { provider: finalMsg.provider } : {}),
        ...(finalMsg?.account ? { account: finalMsg.account } : {}),
        ...(finalMsg?.tier ? { tier: finalMsg.tier } : {}),
        ...(finalMsg?.profile ? { profile: finalMsg.profile } : {}),
        ...(finalMsg?.usage ? { usage: finalMsg.usage } : {}),
        duration_ms: now() - startedAt,
        ...(ttft !== null ? { ttft_ms: ttft } : {}),
      };
    } catch (e) {
      if (e instanceof DeviceToolError) throw e;
      if (ctx.signal?.aborted) throw failed('Cancelled', DeviceErrorCode.CANCELLED);
      if (ctrl.signal.aborted) throw failed(`LightCode timed out after ${timeoutMs} ms`, DeviceErrorCode.CALL_TIMEOUT);
      throw failed(`LightCode: ${e?.message || e}`);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener?.('abort', onOuterAbort);
    }
  }

  async function complete(args = {}, ctx = {}) {
    const { adapter, model, effort, images } = validate(args);
    if (adapter.kind === 'http') return completeViaLightcodeHttp(adapter, { ...args, model, effort, ...(images?.length ? { images } : {}) }, ctx);
    const account = accountOf(ctx);
    await assertSignedIn(adapter, account);
    const content = renderRequest(args, { withBase: adapter.kind !== 'stream' });
    if (content.length > MAX_INPUT_CHARS) throw invalid(`Request is too long (${content.length} chars, max ${MAX_INPUT_CHARS})`);
    const startedAt = now();
    const timeoutMs = Math.min(Number(args.timeout_ms) || ctx.timeoutMs || DEFAULT_TIMEOUT_MS, 10 * 60_000);
    if (ctx.signal?.aborted) throw failed('Cancelled', DeviceErrorCode.CANCELLED);
    const { proc, warmStart } = await take(adapter, { model, effort, account });

    return new Promise((resolve, reject) => {
      let text = '';
      let finalText = null;
      let settled = false;
      let ttft = null;
      const meta = {};
      let onChildError = null;
      let onChildExit = null;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener?.('abort', onAbort);
        if (onChildError) proc.child.off?.('error', onChildError);
        if (onChildExit) proc.child.off?.('exit', onChildExit);
        // ACP thành công → dùng lại tiến trình (phiên mới); lỗi / huỷ / hết giờ / định dùng công cụ → đóng (phiên có thể đang dở).
        if (!err && adapter.kind === 'acp') recycleAcp(proc); else closeProc(proc);
        if (adapter.kind === 'acp') setImmediate(() => keepWarm(adapter, { model, effort, account }));
        // Agent báo chưa đăng nhập / hết phiên → lần sau hỏi lại trạng thái đăng nhập ngay (không tin kết quả nhớ).
        if (err?.code === NOT_SIGNED_IN_ERROR && account) signIn?.forget(adapter.id, account);
        if (err) reject(err); else resolve(value);
      };
      const st = {
        delta: (t) => {
          if (!t) return;
          if (ttft === null) ttft = now() - startedAt;
          if (text.length < MAX_OUTPUT_CHARS) text += t;
          try { ctx.onOutput?.('stdout', t); } catch { /* chỉ là tiến trình */ }
        },
        final: (t) => { finalText = t; },
        meta: (m) => { for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== null) meta[k] = v; },
        tool: (name) => finish(failed(`${adapter.label} tried to use a tool (${name}) — answer discarded`, TOOL_USE_ERROR)),
        fail: (err) => finish(err),
        done: () => {
          // Agent chỉ trả cả câu (Codex): đẩy một lần lúc xong.
          if (!text && finalText) st.delta(finalText);
          const answer = (text || finalText || '').slice(0, MAX_OUTPUT_CHARS);
          if (adapter.kind === 'acp' && AGY_QUOTA_RE.test(answer)) return finish(failed(answer.trim().slice(0, 300), QUOTA_ERROR));
          const out = { text: answer.replace(/\s+$/, ''), agent: adapter.id, model: meta.model || proc.modelId || model || null, stop_reason: meta.stop_reason || null, usage: meta.usage || {}, ttft_ms: ttft, duration_ms: now() - startedAt, warm_start: warmStart };
          if (args.json_schema) out.json = extractJson(out.text);
          finish(null, out);
        },
      };
      const onAbort = () => { if (proc.rpc && proc.sessionId) proc.rpc.notify('session/cancel', { sessionId: proc.sessionId }); finish(failed('Cancelled', DeviceErrorCode.CANCELLED)); };
      const timer = setTimeout(() => finish(failed(`Model did not finish in ${timeoutMs} ms`, DeviceErrorCode.CALL_TIMEOUT)), timeoutMs);
      ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
      onChildError = (e) => finish(failed(`Could not start ${adapter.label}: ${e.message}`));
      onChildExit = (code) => finish(failed(`${adapter.label} exited (${code}) before answering${proc.stderr ? `: ${proc.stderr.trim().slice(-400)}` : ''}`, agentErrorCode(proc.stderr)));
      proc.child.once('error', onChildError);
      proc.child.once('exit', onChildExit);

      if (adapter.kind === 'acp') {
        proc.rpc.onNotify = (method, params) => {
          if (method !== 'session/update') return;
          // Tiến trình dùng lại: thông báo trễ của phiên trước không được lẫn vào lời gọi này.
          if (params?.sessionId && proc.sessionId && params.sessionId !== proc.sessionId) return;
          const u = params?.update || {};
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') st.delta(u.content.text);
          if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') st.tool(u.name || u.title || u.kind || 'tool');
        };
        // Agent xin quyền (lệnh, ghi tệp…) → luôn từ chối, và coi như đã định dùng công cụ.
        proc.rpc.onRequest = (method, params) => {
          if (method === 'session/request_permission') {
            const reject = (params?.options || []).find((o) => /reject/.test(String(o.kind)));
            setImmediate(() => st.tool(params?.toolCall?.name || 'permission'));
            return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
          }
          throw Object.assign(new Error('not supported'), { code: -32601 });
        };
        proc.ready.then(async ({ sessionId, modelId }) => {
          proc.sessionId = sessionId;
          proc.modelId = modelId;
          const r = await proc.rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: content }] });
          if (r?.usage) st.meta({ usage: { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens } });
          st.meta({ stop_reason: r?.stopReason });
          st.done();
        }).catch((e) => finish(e instanceof DeviceToolError ? e : failed(`${adapter.label}: ${e?.message || e}`, agentErrorCode(e?.message))));
        return;
      }

      let buf = '';
      proc.child.stdout.setEncoding('utf8');
      proc.child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          try { adapter.parse(m, st); } catch (e) { finish(failed(`Bad ${adapter.label} output: ${e.message}`)); }
        }
      });
      const input = adapter.encode(content);
      proc.child.stdin.write(input);
      if (adapter.kind === 'stdin') proc.child.stdin.end();
    });
  }

  return {
    available: () => installed().length > 0,
    agents: () => installed().map((a) => ({ id: a.id, label: a.label, ...(versions.get(a.id) ? { version: versions.get(a.id) } : {}) })),
    info: () => ({ agents: installed().map((a) => ({ id: a.id, ...(versions.get(a.id) ? { version: versions.get(a.id) } : {}) })), warm: [...warm.keys()], warm_procs: warmCount() }),
    complete,
    /** BE báo trước agent / model sắp dùng (người dùng vừa chọn máy này) → khởi động sẵn. Máy tổ chức: chỉ khi thành viên đã đăng nhập. */
    prewarm: (args = {}, ctx = {}) => {
      const { adapter, model, effort } = validate(args);
      if (adapter.kind === 'http') return Promise.resolve({ warm: [] });
      const account = accountOf(ctx);
      const warmNow = () => {
        keepWarm(adapter, { model, effort, account });
        const own = [...warm.keys()].filter((k) => !account || k.startsWith(`${account.name}|`));
        return { warm: account ? own.map((k) => k.slice(account.name.length + 1)) : own };
      };
      if (!account) return warmNow();
      return signIn.status(adapter, account).then((ok) => (ok ? warmNow() : { warm: [], signed_in: false }));
    },
    memberMode,
    memberDir,
    signIn,
    binOf,
    adapterFor,
    stopAll: () => { for (const k of [...warm.keys()]) closeWarm(k); if (sweeper) { clearInterval(sweeper); sweeper = null; } },
  };
}

/** JSON-RPC 2.0 theo dòng trên stdin/stdout của tiến trình ACP. */
export function acpClient(child) {
  let id = 0;
  let buf = '';
  const pending = new Map();
  const client = {
    onNotify: null,
    onRequest: null,
    call(method, params) {
      return new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`); } catch (e) { pending.delete(i); reject(e); }
      });
    },
    notify(method, params) {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* đã đóng */ }
    },
  };
  const reply = (msgId, body) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msgId, ...body })}\n`); } catch { /* đã đóng */ } };
  child.stdout.setEncoding?.('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && !m.method) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (p) m.error ? p.reject(Object.assign(new Error(m.error.message || 'ACP error'), { code: m.error.code })) : p.resolve(m.result);
      } else if (m.method && m.id !== undefined) {
        try { reply(m.id, { result: client.onRequest ? client.onRequest(m.method, m.params) : null }); } catch (e) { reply(m.id, { error: { code: e.code || -32603, message: e.message } }); }
      } else if (m.method) {
        try { client.onNotify?.(m.method, m.params); } catch { /* bỏ qua */ }
      }
    }
  });
  child.once?.('exit', () => { for (const p of pending.values()) p.reject(new Error('ACP process exited')); pending.clear(); });
  return client;
}

/** Công cụ nội bộ (BE gọi thẳng, không vào danh mục của Planner). */
export function buildLocalLlmTools(llm) {
  const list = llm.agents().map((a) => `${a.id}${a.version ? ` ${a.version}` : ''}`).join(', ');
  return [
    { name: 'llm.complete', group: ToolGroup.PROC, read_only: true, internal: true, handler: (a, c, e) => llm.complete(a, { ...c, runAs: e?.runAs }),
      description: `BE-only: answer one LLM request with a coding agent the person is signed in to on this computer, as a plain model — no tools, no files, no project settings. Installed: ${list}. Text streams on stdout; the result has text, json (when json_schema was given), agent, model, usage and timing. Error ${TOOL_USE_ERROR}: the agent tried to use a tool and its answer was discarded.`,
      input_schema: schema({
        agent: str(`which agent: ${llm.agents().map((a) => a.id).join(' | ')} (default the first)`),
        system: str('instructions (system prompt) for this request'), prompt: str('the request; or give messages'),
        messages: { type: 'array', description: 'history: [{role: user|assistant, content}] — the last user message is the request when prompt is empty' },
        json_schema: { type: 'object', description: 'JSON Schema the answer must match' },
        images: { type: 'array', items: { type: 'string' }, description: 'optional local image file paths (max 4, .png/.jpg/.webp/.gif, <=10 MB each; LightCode only)' },
        model: str('model of that agent (claude: opus | sonnet | haiku…; codex: gpt-…; antigravity: gemini-…, effort picks the variant)'),
        tier: str('nano | light | medium | code | hard | xhard (used when routing via LightCode)'),
        effort: str(EFFORTS.join(' | ')),
        timeout_ms: { type: 'number', description: 'default 180000, max 600000' },
      }) },
    { name: 'llm.prewarm', group: ToolGroup.PROC, read_only: true, internal: true, handler: (a, c, e) => llm.prewarm(a, { ...c, runAs: e?.runAs }),
      description: 'BE-only: start a model process ahead of the next llm.complete with this agent / model / effort.',
      input_schema: schema({ agent: str('agent id'), model: str('model'), effort: str('effort') }) },
  ];
}
