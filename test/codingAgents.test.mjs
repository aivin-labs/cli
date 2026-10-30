import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { AgentMode, CLAUDE_ADAPTER, agentArgs, buildAgentTools, createAgentRunner, findAgentBinary } = await import('../bin/lib/remote/codingAgents.mjs');
const { buildTools } = await import('../bin/lib/remote/toolHandlers.mjs');

const SID = '60554582-1111-4222-8333-944455556666';
/** Dòng `stream-json` như Claude Code 2.1 thật in ra (rút gọn). */
const CLAUDE_EVENTS = [
  { type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5' },
  { type: 'assistant', session_id: SID, message: { content: [{ type: 'thinking', thinking: '…' }] } },
  { type: 'assistant', session_id: SID, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.ts' } }] } },
  { type: 'assistant', session_id: SID, message: { content: [{ type: 'text', text: 'Đã đọc app.ts: có 3 route.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Có 3 route: /, /login, /api.', total_cost_usd: 0.33892, num_turns: 2, duration_ms: 4100, session_id: SID },
];

/** Tiến trình agent giả: ghi lại argv + stdin, phát sự kiện khi được bảo. */
function fakeSpawn() {
  const calls = [];
  const spawnImpl = (bin, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = '';
    child.stdin = { end: (s) => { stdin = s; } };
    child.kill = () => child.emit('close', null);
    const call = { bin, argv, opts, child, stdin: () => stdin };
    call.emitAll = async (events = CLAUDE_EVENTS, code = 0) => {
      for (const e of events) child.stdout.write(`${JSON.stringify(e)}\n`);
      await new Promise((r) => setImmediate(r));
      child.emit('close', code);
    };
    calls.push(call);
    return child;
  };
  return { calls, spawnImpl };
}

const tick = () => new Promise((r) => setImmediate(r));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-root-'));
const env = { roots: [root] };
const claudeOnly = (spawnImpl) => createAgentRunner({ find: () => ({ bin: 'claude', version: '2.1.312' }), spawnImpl });

test('tham số Claude: đề bài KHÔNG trên dòng lệnh; chỉ plan / manual / accept_edits; mã phiên / model phải hợp lệ', () => {
  assert.deepEqual(agentArgs(CLAUDE_ADAPTER), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'manual']);
  assert.ok(agentArgs(CLAUDE_ADAPTER, { mode: AgentMode.ACCEPT_EDITS }).includes('acceptEdits'));
  assert.deepEqual(agentArgs(CLAUDE_ADAPTER, { resume: SID }).slice(-2), ['--resume', SID]);
  for (const mode of ['bypassPermissions', 'dontAsk', 'auto']) assert.throws(() => agentArgs(CLAUDE_ADAPTER, { mode }), /mode must be/);
  assert.throws(() => agentArgs(CLAUDE_ADAPTER, { resume: '--dangerously-skip-permissions' }), /session/);
  assert.throws(() => agentArgs(CLAUDE_ADAPTER, { model: 'x; rm -rf /' }), /model/);
});

test('tìm Claude: PATH, ~/.local/bin, bản kèm extension VS Code — lấy bản mới nhất', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const local = path.join(home, '.local', 'bin', exe);
  const ext = path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.312-win32-x64', 'resources', 'native-binary', exe);
  for (const f of [local, ext]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
  const versions = { [local]: [2, 1, 179], [ext]: [2, 1, 312] };
  assert.deepEqual(findAgentBinary(CLAUDE_ADAPTER, { env: { PATH: '' }, home, versionOf: (b) => versions[b] }), { bin: ext, version: '2.1.312' });
  assert.equal(findAgentBinary(CLAUDE_ADAPTER, { env: { PATH: '' }, home: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-none-')), versionOf: () => [1, 0, 0] }), null);
});

test('chạy: đề bài qua stdin, chữ + công cụ đẩy dần qua onOutput, kết quả có chi phí; "continue" = phiên gần nhất của thư mục', async () => {
  const { calls, spawnImpl } = fakeSpawn();
  const runner = claudeOnly(spawnImpl);
  const out = [];
  const pending = runner.run({ prompt: 'Có bao nhiêu route?', wait_ms: 5000 }, { onOutput: (s) => out.push(s.trim()) }, env);
  await tick();
  assert.equal(calls[0].stdin(), 'Có bao nhiêu route?');
  assert.ok(!calls[0].argv.some((a) => a.includes('route')), 'đề bài không ở dòng lệnh');
  assert.equal(calls[0].opts.cwd, root);
  await calls[0].emitAll();
  const res = await pending;
  assert.equal(res.status, 'done');
  assert.equal(res.agent, 'claude');
  assert.equal(res.session_id, SID);
  assert.deepEqual(res.result, { ok: true, answer: 'Có 3 route: /, /login, /api.', cost_usd: 0.3389, turns: 2, duration_ms: 4100 });
  assert.deepEqual(out, ['🔧 Read src/app.ts', 'Đã đọc app.ts: có 3 route.']);
  assert.equal(runner.sessions({}, {}, env).sessions[0].session_id, SID);

  const next = runner.run({ prompt: 'Thêm route /health', session: 'continue', mode: 'accept_edits', wait_ms: 5000 }, {}, env);
  await tick();
  assert.deepEqual(calls[1].argv.slice(-2), ['--resume', SID]);
  assert.ok(calls[1].argv.includes('acceptEdits'));
  await calls[1].emitAll();
  await next;
});

test('việc dài: hết wait_ms trả job đang chạy; status đọc tiếp theo con trỏ; stop dừng; lỗi giữ dòng stderr cuối', async () => {
  const { calls, spawnImpl } = fakeSpawn();
  const runner = claudeOnly(spawnImpl);
  const first = await runner.run({ prompt: 'refactor', wait_ms: 10 }, {}, env);
  assert.equal(first.status, 'running');
  assert.match(first.hint, /agent\.status/);
  calls[0].child.stdout.write(`${JSON.stringify(CLAUDE_EVENTS[2])}\n${JSON.stringify(CLAUDE_EVENTS[3])}\n`);
  await tick();
  const mid = await runner.status({ job: first.job });
  assert.equal(mid.new_text, 'Đã đọc app.ts: có 3 route.');
  assert.equal((await runner.status({ job: first.job, next_text: mid.next_text, next_tool: mid.next_tool })).new_text, undefined);
  assert.equal(runner.stop({ job: first.job }).status, 'stopped');
  await assert.rejects(runner.status({ job: 'nope' }), (e) => e.code === 'NOT_FOUND');

  const bad = runner.run({ prompt: 'x', wait_ms: 5000 }, {}, env);
  await tick();
  calls[1].child.stderr.write('Invalid API key · Please run /login\n');
  await tick();
  calls[1].child.emit('close', 1);
  const failed = await bad;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /run \/login/);
});

test('thêm agent = thêm adapter: phần chung (chờ, phiên, onOutput) không đổi; chọn agent theo tên; agent chưa cài → báo danh sách có', async () => {
  const echo = {
    id: 'echo', label: 'Echo Agent', candidates: () => [],
    args: ({ mode }) => ['--mode', mode],
    parse(job, msg) {
      if (msg.sid) job.session_id = msg.sid;
      if (msg.say) { job.texts.push(msg.say); return msg.say; }
      if (msg.done) job.result = { ok: true, answer: msg.done };
      return '';
    },
  };
  const { calls, spawnImpl } = fakeSpawn();
  const runner = createAgentRunner({ adapters: [CLAUDE_ADAPTER, echo], find: (a) => (a.id === 'echo' ? { bin: 'echo-agent', version: '0.1.0' } : null), spawnImpl });
  assert.deepEqual(runner.installed().map((a) => a.id), ['echo'], 'chỉ agent đã cài');
  await assert.rejects(runner.run({ prompt: 'x', agent: 'claude' }, {}, env), /not installed here — available: echo/);
  const out = [];
  const p = runner.run({ prompt: 'hi', mode: 'plan', wait_ms: 5000 }, { onOutput: (s) => out.push(s.trim()) }, env);
  await tick();
  assert.equal(calls[0].bin, 'echo-agent');
  assert.deepEqual(calls[0].argv, ['--mode', 'plan']);
  await calls[0].emitAll([{ sid: SID }, { say: 'xin chào' }, { done: 'ok' }]);
  const r = await p;
  assert.deepEqual([r.agent, r.status, r.result.answer, out[0]], ['echo', 'done', 'ok', 'xin chào']);
  assert.equal(runner.sessions({ agent: 'echo' }, {}, env).sessions[0].session_id, SID);
  const tool = buildAgentTools(runner).find((t) => t.name === 'agent.run');
  assert.match(tool.description, /installed: echo \(Echo Agent 0\.1\.0\)/);
});

test('đầu vào sai + danh mục: không đề bài, thư mục ngoài vùng, "continue" khi chưa có phiên; agent.* chỉ ở máy cá nhân có agent', async () => {
  const runner = claudeOnly(fakeSpawn().spawnImpl);
  await assert.rejects(runner.run({ prompt: ' ' }, {}, env), (e) => e.code === 'INVALID_ARGS');
  await assert.rejects(runner.run({ prompt: 'x', cwd: os.homedir() }, {}, { roots: [root] }));
  const fresh = fs.mkdtempSync(path.join(root, 'fresh-'));
  await assert.rejects(runner.run({ prompt: 'x', cwd: fresh, session: 'continue' }, {}, env), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(createAgentRunner({ find: () => null }).run({ prompt: 'x' }, {}, env), /No coding agent is installed/);

  assert.deepEqual(buildAgentTools(runner).map((t) => [t.name, !!t.read_only]),
    [['agent.run', false], ['agent.status', true], ['agent.stop', false], ['agent.sessions', true]]);
  const base = { roots: [root], binaries: [], projects: [], processes: { start() {} } };
  assert.equal(buildTools({ ...base, schedules: {}, runAs: { uid: 1 }, codingAgents: runner }).some((t) => t.name.startsWith('agent.')), false, 'máy tính tổ chức: không');
  assert.ok(buildTools({ ...base, schedules: {}, codingAgents: runner }).some((t) => t.name === 'agent.run'), 'máy cá nhân có agent: có');
});
