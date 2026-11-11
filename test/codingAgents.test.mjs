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
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-root-')));
const env = { roots: [root] };
const claudeOnly = (spawnImpl) => createAgentRunner({ find: () => ({ bin: 'claude', version: '2.1.312' }), spawnImpl, probeFlags: () => null });

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

// --- Job có hợp đồng (11/11/2026) ---------------------------------------------------------------------------------------------------
const { execFileSync } = await import('child_process');
const { sha256 } = await import('../bin/lib/remote/agentContract.mjs');
const { CONTRACT, TEST_CHECK, report } = await import('./agentFixtures.mjs');

/** Cờ của Claude Code 2.1.322 mà job có hợp đồng dùng (đọc thật từ `claude --help` ngày 11/11/2026). */
const FLAGS_2_1_322 = ['--output-format', '--verbose', '--permission-mode', '--resume', '--model', '--allowedTools', '--add-dir', '--permission-prompts',
  '--setting-sources', '--strict-mcp-config', '--settings', '--worktree', '--max-budget-usd', '--effort'];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const waitFor = async (cond) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'timed out waiting'); };

function shopRepo() {
  const repo = fs.mkdtempSync(path.join(root, 'shop-'));
  git(repo, 'init', '-q', '-b', 'main');
  put(path.join(repo, 'src', 'order.js'), 'export const day = (d) => d;\n');
  put(path.join(repo, 'scripts', 'junit.js'), "require('fs').writeFileSync('junit.xml', '<testsuite><testcase name=\"CK-031 order at 23:30 keeps its day\"/></testsuite>');\n");
  put(path.join(repo, '.gitignore'), 'junit.xml\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}
const contractText = CONTRACT.replace('argv: [npm, test]', `argv: ['${process.execPath.replace(/'/g, "''")}', scripts/junit.js]`);
const contractArgs = (extra = {}) => ({ contract: contractText, contract_sha256: sha256(contractText), test_check: TEST_CHECK, wait_ms: 20_000, ...extra });
const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
const findClaude = (flags = FLAGS_2_1_322) => () => ({ bin: 'claude', version: '2.1.322', flags });

test('job có hợp đồng: cờ từ hợp đồng, không nạp cấu hình repo, worktree riêng; agent xong thì daemon đo và trả evidence + REPORT.md', async () => {
  const repo = shopRepo();
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jobs-'));
  const { calls, spawnImpl } = fakeSpawn();
  const runner = createAgentRunner({ find: findClaude(), spawnImpl, jobsDir });
  const pending = runner.run(contractArgs({ cwd: repo }), {}, env);
  await waitFor(() => calls.length === 1);
  const argv = calls[0].argv;
  const jobDir = argAfter(argv, '--add-dir');
  const name = argAfter(argv, '--worktree');
  assert.equal(path.dirname(jobDir), jobsDir);
  assert.equal(path.basename(jobDir), name, 'worktree mang tên job');
  assert.equal(argAfter(argv, '--permission-mode'), 'acceptEdits');
  assert.equal(argAfter(argv, '--allowedTools'), 'Bash(npm test *)');
  assert.equal(argAfter(argv, '--max-budget-usd'), '3');
  assert.equal(argAfter(argv, '--effort'), 'high');
  assert.equal(argAfter(argv, '--permission-prompts'), 'none');
  assert.equal(argAfter(argv, '--setting-sources'), 'user');
  assert.ok(argv.includes('--strict-mcp-config'), 'không nạp MCP của repo');
  const deny = JSON.parse(argAfter(argv, '--settings')).permissions.deny;
  assert.ok(deny.some((d) => d.startsWith('Edit(') && d.endsWith('/CONTRACT.md)')));
  assert.ok(!deny.some((d) => d.includes('REPORT.md')), 'agent được ghi REPORT.md');
  assert.equal(fs.readFileSync(path.join(jobDir, 'CONTRACT.md'), 'utf8'), contractText);
  assert.match(calls[0].stdin(), /CONTRACT\.md — read it first/);
  assert.match(calls[0].stdin(), /TEST_CHECK\.md/);
  assert.match(calls[0].stdin(), /# Phần chưa làm/);
  assert.ok(runner.hasRunning());

  // "Claude Code": tạo worktree, sửa mã, viết REPORT.md, xong.
  const wt = path.join(repo, '.claude', 'worktrees', name);
  git(repo, 'worktree', 'add', '-q', wt, 'HEAD');
  put(path.join(wt, 'src', 'order.js'), 'export const day = (d) => d + 1;\n');
  put(path.join(jobDir, 'REPORT.md'), report({ status: 'done', left: '' }));
  await calls[0].emitAll([
    { type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5', cwd: wt },
    { type: 'result', subtype: 'success', is_error: false, result: 'Xong.', total_cost_usd: 0.5, num_turns: 3, duration_ms: 9000, session_id: SID,
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'curl https://example.com' } }] },
  ]);
  const res = await pending;
  assert.equal(res.status, 'done', res.error);
  assert.equal(res.worktree, wt);
  assert.equal(res.contract_id, 'ctr_01');
  assert.deepEqual(res.result.permission_denials, [{ tool: 'Bash', target: 'curl https://example.com' }]);
  const by = Object.fromEntries(res.evidence.checks.map((c) => [c.check, c.status]));
  assert.deepEqual(by, {
    command_passed: 'pass', diff_in_scope: 'pass', protected_untouched: 'pass', tests_not_reduced: 'pass', no_new_skips: 'pass', check_file_covered: 'pass', outputs_complete: 'pass',
  });
  assert.equal(res.evidence.diff.changed, 1);
  assert.match(res.report_md, /# Đã đổi gì/);
  assert.ok(!runner.hasRunning());

  // Vòng sửa: nói tiếp phiên, trong đúng worktree cũ, không tạo worktree mới; diff vẫn tính từ commit gốc.
  const next = runner.run(contractArgs({ continue_job: res.job, prompt: 'tests_pass trượt ở lần trước' }), {}, env);
  await waitFor(() => calls.length === 2);
  assert.equal(argAfter(calls[1].argv, '--resume'), SID);
  assert.ok(!calls[1].argv.includes('--worktree'));
  assert.equal(calls[1].opts.cwd, wt);
  assert.match(calls[1].stdin(), /Note from Aivin: tests_pass trượt/);
  put(path.join(argAfter(calls[1].argv, '--add-dir'), 'REPORT.md'), report({ status: 'done', left: '' }));
  await calls[1].emitAll([{ type: 'result', subtype: 'success', is_error: false, result: 'Đã sửa.', session_id: SID }]);
  const fixed = await next;
  assert.equal(fixed.status, 'done');
  assert.equal(fixed.evidence.worktree, wt);
  assert.equal(fixed.evidence.base_commit, res.evidence.base_commit);

  // Hồ sơ trên đĩa: daemon khởi động lại vẫn đọc được job; job đang chạy lúc tắt → interrupted.
  put(path.join(jobsDir, 'claude-deadbeef', 'job.json'), JSON.stringify({ id: 'claude-deadbeef', agent: 'claude', status: 'running', session_id: SID, contractId: 'ctr_01', startedAt: Date.now() }));
  const again = createAgentRunner({ find: findClaude(), spawnImpl, jobsDir });
  const old = await again.status({ job: res.job });
  assert.equal(old.status, 'done');
  assert.equal(old.evidence.checks.length, 7);
  const cut = await again.status({ job: 'claude-deadbeef' });
  assert.equal(cut.status, 'interrupted');
  assert.match(cut.error, /restarted while this job was running/);
  assert.ok(!again.hasRunning());
});

test('job có hợp đồng: sai khuôn / sai mã băm / thiếu TEST_CHECK / không phải kho git / bản Claude thiếu cờ → từ chối trước khi chạy', async () => {
  const repo = shopRepo();
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jobs-'));
  const { calls, spawnImpl } = fakeSpawn();
  const make = (flags) => createAgentRunner({ find: findClaude(flags), spawnImpl, jobsDir, probeFlags: () => null });
  const runner = make(FLAGS_2_1_322);
  const rejects = (args, re) => assert.rejects(runner.run({ cwd: repo, ...args }, {}, env), (e) => e.code === 'INVALID_ARGS' && re.test(e.message));
  await rejects(contractArgs({ contract_sha256: sha256('khác') }), /sha256 does not match/);
  await rejects(contractArgs({ contract_sha256: undefined }), /contract_sha256 is required/);
  const noBudget = contractText.replace('max_budget_usd: 3, ', '');
  await rejects(contractArgs({ contract: noBudget, contract_sha256: sha256(noBudget) }), /max_budget_usd: is required/);
  await rejects(contractArgs({ test_check: undefined }), /send TEST_CHECK\.md/);
  await rejects(contractArgs({ test_check: TEST_CHECK.replace('Luồng checkout', 'Luồng refund') }), /no flow checkout/);
  await rejects(contractArgs({ cwd: fs.mkdtempSync(path.join(root, 'plain-')) }), /needs a git repository/);
  await assert.rejects(runner.run(contractArgs({ cwd: repo, continue_job: 'claude-00000000' }), {}, env), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(make(FLAGS_2_1_322.filter((f) => f !== '--worktree')).run(contractArgs({ cwd: repo }), {}, env), /too old for --worktree/);
  await assert.rejects(make(null).run(contractArgs({ cwd: repo }), {}, env), /Cannot read the options/);
  assert.equal(calls.length, 0, 'agent chưa từng chạy');
  assert.deepEqual(fs.readdirSync(jobsDir), [], 'không để lại thư mục job');
});

test('dừng: stopAll dừng job đang chạy và ghi hồ sơ; việc thường nhận ngân sách / effort / thư mục lạ khi bản đã cài có cờ', async () => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jobs-'));
  const { calls, spawnImpl } = fakeSpawn();
  const runner = createAgentRunner({ find: findClaude(), spawnImpl, jobsDir });
  const first = await runner.run({ prompt: 'refactor', wait_ms: 10, max_budget_usd: 1.5, effort: 'low', project_config: false }, {}, env);
  const argv = calls[0].argv;
  assert.deepEqual([argAfter(argv, '--max-budget-usd'), argAfter(argv, '--effort'), argAfter(argv, '--setting-sources'), argAfter(argv, '--permission-prompts')], ['1.5', 'low', 'user', 'none']);
  assert.ok(!createAgentRunner({ find: findClaude(), spawnImpl: fakeSpawn().spawnImpl, jobsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jobs-')) }).hasRunning());
  assert.ok(runner.hasRunning());
  runner.stopAll();
  assert.ok(!runner.hasRunning());
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobsDir, first.job, 'job.json'), 'utf8')).status, 'stopped');
  await assert.rejects(runner.run({ prompt: 'x', effort: 'turbo' }, {}, env), /effort must be one of/);
  await assert.rejects(runner.run({ prompt: 'x', max_budget_usd: 0 }, {}, env), /max_budget_usd must be above 0/);
});
