import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { CLAUDE_LLM, CODEX_LLM, ANTIGRAVITY_LLM, NOT_SIGNED_IN_ERROR, QUOTA_ERROR, agentErrorCode, buildLocalLlmTools, createLocalLlm } from '../bin/lib/remote/localLlm.mjs';
import { SIGN_IN_PROBES, createSignInChecker, memberAgentEnv, memberSpawnArgs } from '../bin/lib/remote/localLlmMembers.mjs';
import { ANSI_RE, LOGIN_FLOWS, LoginState, buildLlmLoginTools, createLlmLogin } from '../bin/lib/remote/localLlmLogin.mjs';

const memberDir = path.join(os.tmpdir(), 'aivin-llm-member-test');
const alice = { uid: 10001, gid: 10000, home: '/home/u0000000000a1', name: 'u0000000000a1' };
const bob = { uid: 10002, gid: 10000, home: '/home/u0000000000b2', name: 'u0000000000b2' };
const tick = () => new Promise((r) => setImmediate(r));

function fakeSpawn(onInput = () => {}) {
  const spawned = [];
  const spawnImpl = (bin, argv, opts) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, bin, argv, opts, input: '' });
    child.out = (obj) => setImmediate(() => child.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`));
    child.kill = () => { if (child.killed) return; child.killed = true; setImmediate(() => child.emit('exit', null)); };
    child.stdin.on('data', (d) => { child.input += d; onInput(child, String(d)); });
    child.stdin.on('finish', () => onInput(child, null));
    spawned.push(child);
    return child;
  };
  return { spawnImpl, spawned };
}

const adapter = (base) => ({ ...base, find: () => ({ bin: `/usr/local/bin/${base.id}`, version: '1.0.0' }), ...(base.probe ? { probe: async () => ({ disable: [] }) } : {}) });
const ev = (event) => ({ type: 'stream_event', event });
function claudeReply(child, text) {
  child.out(ev({ type: 'message_start', message: { model: 'claude-sonnet-x' } }));
  child.out(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }));
  child.out(ev({ type: 'message_stop' }));
}

/** Bộ kiểm đăng nhập giả: `signedIn` = tập `<vùng>|<agent>` đã đăng nhập. */
function fakeSignIn(signedIn = new Set()) {
  const calls = [];
  return {
    calls,
    signedIn,
    status: async (a, account) => { calls.push(`${account.name}|${a.id}`); return signedIn.has(`${account.name}|${a.id}`); },
    forget: () => {},
    run: async () => ({ code: 0, out: '', err: '' }),
  };
}

const makeMember = (signIn, onInput) => {
  const f = fakeSpawn(onInput);
  const llm = createLocalLlm({ adapters: [adapter(CLAUDE_LLM), adapter(CODEX_LLM), adapter(ANTIGRAVITY_LLM)], spawnImpl: f.spawnImpl, memberMode: true, memberDir, signIn, version: async () => '1.0.0', warmPerKey: 1 });
  return { ...f, llm };
};

test('agentErrorCode: đăng nhập hết hạn / chưa đăng nhập → NOT_SIGNED_IN; hết hạn mức → QUOTA; còn lại không mã', () => {
  for (const m of ['Invalid API key · Please run /login', 'Not logged in · Please run /login', 'OAuth token has expired', '401 Unauthorized', 'Your refresh token was already used']) {
    assert.equal(agentErrorCode(m), NOT_SIGNED_IN_ERROR, m);
  }
  assert.equal(agentErrorCode('Claude AI usage limit reached|1763500000'), QUOTA_ERROR);
  assert.equal(agentErrorCode('something broke'), undefined);
});

test('memberAgentEnv: HOME / USER của thành viên, không mang đăng nhập / cấu hình agent của root, không tự cập nhật', () => {
  const env = memberAgentEnv(alice, { PATH: '/usr/bin', HOME: '/root', CLAUDE_CONFIG_DIR: '/root/.claude', CODEX_HOME: '/root/.codex', ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  assert.equal(env.HOME, alice.home);
  assert.equal(env.USER, alice.name);
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(env[k], undefined, k);
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  const [, , opts] = memberSpawnArgs(alice, '/usr/local/bin/claude', ['-p'], { dir: memberDir, base: { PATH: '/usr/bin' } });
  assert.deepEqual([opts.uid, opts.gid, opts.cwd], [alice.uid, alice.gid, memberDir]);
});

test('máy tổ chức: chỉ Claude Code + Codex; lời gọi không mang thành viên bị từ chối (không chạy bằng root)', async () => {
  const { llm, spawned } = makeMember(fakeSignIn(new Set([`${alice.name}|claude`])));
  assert.deepEqual(llm.agents().map((a) => a.id), ['claude', 'codex']);
  await assert.rejects(llm.complete({ prompt: 'hi', agent: 'claude' }, {}), (e) => e.code === 'INVALID_ARGS');
  assert.equal(spawned.length, 0);
});

test('máy tổ chức: thành viên chưa đăng nhập → NOT_SIGNED_IN ngay, không khởi động agent', async () => {
  const signIn = fakeSignIn(new Set([`${alice.name}|claude`]));
  const { llm, spawned } = makeMember(signIn);
  await assert.rejects(llm.complete({ prompt: 'hi', agent: 'claude' }, { runAs: bob }), (e) => e.code === NOT_SIGNED_IN_ERROR);
  await assert.rejects(llm.complete({ prompt: 'hi', agent: 'codex' }, { runAs: alice }), (e) => e.code === NOT_SIGNED_IN_ERROR);
  assert.equal(spawned.length, 0);
  assert.deepEqual(await llm.prewarm({ agent: 'claude' }, { runAs: bob }), { warm: [], signed_in: false });
  assert.equal(spawned.length, 0);
});

test('máy tổ chức: agent chạy dưới tài khoản thành viên; tiến trình giữ sẵn của người này không phục vụ người kia', async () => {
  const signIn = fakeSignIn(new Set([`${alice.name}|claude`, `${bob.name}|claude`]));
  const { llm, spawned } = makeMember(signIn, (child, d) => { if (d) claudeReply(child, `hi ${child.opts.env.USER}`); });
  const a1 = await llm.complete({ prompt: 'x', agent: 'claude', model: 'sonnet' }, { runAs: alice });
  assert.equal(a1.text, `hi ${alice.name}`);
  assert.deepEqual([spawned[0].opts.uid, spawned[0].opts.env.HOME, spawned[0].opts.cwd], [alice.uid, alice.home, memberDir]);
  await tick(); await tick();
  // Alice có một tiến trình giữ sẵn; Bob gọi cùng agent / model → tiến trình mới của Bob, không lấy của Alice.
  const warmAlice = spawned.at(-1);
  assert.equal(warmAlice.opts.uid, alice.uid);
  const b1 = await llm.complete({ prompt: 'x', agent: 'claude', model: 'sonnet' }, { runAs: bob });
  assert.equal(b1.text, `hi ${bob.name}`);
  assert.equal(b1.warm_start, false);
  assert.equal(warmAlice.input, '', 'tiến trình của Alice không nhận lời gọi của Bob');
  llm.stopAll();
});

test('máy tổ chức: agent báo phiên đăng nhập hết hạn → NOT_SIGNED_IN và quên trạng thái đăng nhập', async () => {
  const signIn = fakeSignIn(new Set([`${alice.name}|claude`]));
  let forgot = 0;
  signIn.forget = () => { forgot++; };
  const { llm } = makeMember(signIn, (child, d) => { if (d) child.out({ type: 'result', is_error: true, result: 'OAuth token has expired. Please run /login' }); });
  await assert.rejects(llm.complete({ prompt: 'x', agent: 'claude' }, { runAs: alice }), (e) => e.code === NOT_SIGNED_IN_ERROR);
  assert.equal(forgot, 1);
  llm.stopAll();
});

test('máy tổ chức: công cụ llm.complete chuyển tài khoản của lời gọi (env.runAs) xuống agent', async () => {
  const signIn = fakeSignIn(new Set([`${alice.name}|claude`]));
  const { llm, spawned } = makeMember(signIn, (child, d) => { if (d) claudeReply(child, 'ok'); });
  const tool = buildLocalLlmTools(llm).find((t) => t.name === 'llm.complete');
  const out = await tool.handler({ prompt: 'x', agent: 'claude' }, {}, { runAs: alice });
  assert.equal(out.text, 'ok');
  assert.equal(spawned[0].opts.uid, alice.uid);
  llm.stopAll();
});

test('createSignInChecker: hỏi agent dưới tài khoản thành viên, nhớ theo (thành viên, agent), fresh bỏ qua nhớ', async () => {
  const runs = [];
  let t = 0;
  const checker = createSignInChecker({
    binOf: (a) => ({ bin: `/usr/local/bin/${a.id}` }), now: () => t, dir: memberDir,
    run: async (account, bin, argv) => { runs.push([account.name, bin, argv.join(' ')]); return account === alice ? { code: 0, out: '{"loggedIn": true}' } : { code: 1, out: '{"loggedIn": false}' }; },
  });
  assert.equal(await checker.status(CLAUDE_LLM, alice), true);
  assert.equal(await checker.status(CLAUDE_LLM, bob), false);
  assert.equal(await checker.status(CLAUDE_LLM, alice), true);
  assert.equal(runs.length, 2, 'lần hỏi thứ ba dùng kết quả nhớ');
  assert.deepEqual(runs[0], [alice.name, '/usr/local/bin/claude', 'auth status --json']);
  t += 21_000;
  await checker.status(CLAUDE_LLM, bob);
  assert.equal(runs.length, 3, '"chưa đăng nhập" chỉ nhớ 20 s');
  await checker.status(CLAUDE_LLM, alice, { fresh: true });
  assert.equal(runs.length, 4);
  assert.equal(SIGN_IN_PROBES.codex.parse(0, 'Logged in using ChatGPT'), true);
  assert.equal(SIGN_IN_PROBES.codex.parse(1, 'Not logged in'), false);
  assert.equal(await checker.status(ANTIGRAVITY_LLM, alice), false, 'agent không có cách hỏi → coi như chưa đăng nhập');
});

// --- Đăng nhập không màn hình ------------------------------------------------------------------------------------------------------------

const CLAUDE_LOGIN_OUT = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\nPaste code here if prompted > ";
const CODEX_LOGIN_OUT = '\x1b[90mWelcome\x1b[0m\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mMZ01-M041L\x1b[0m\n';

function makeLogin({ onSpawn = () => {}, signedIn = new Set() } = {}) {
  const signIn = fakeSignIn(signedIn);
  const f = fakeSpawn();
  const spawnImpl = (bin, argv, opts) => { const c = f.spawnImpl(bin, argv, opts); setImmediate(() => onSpawn(c)); return c; };
  const llm = createLocalLlm({ adapters: [adapter(CLAUDE_LLM), adapter(CODEX_LLM)], spawnImpl: f.spawnImpl, memberMode: true, memberDir, signIn, version: async () => '1.0.0' });
  return { ...f, signIn, llm, login: createLlmLogin({ llm, spawnImpl, startWaitMs: 500, codeWaitMs: 500 }) };
}

test('LOGIN_FLOWS: đọc link Claude Code, link + mã Codex (bỏ mã màu)', () => {
  assert.equal(LOGIN_FLOWS.claude.parse(CLAUDE_LOGIN_OUT).url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz');
  assert.equal(LOGIN_FLOWS.claude.parse('Opening browser to sign in…'), null);
  assert.deepEqual(LOGIN_FLOWS.codex.parse(CODEX_LOGIN_OUT.replace(ANSI_RE, '')), { url: 'https://auth.openai.com/codex/device', user_code: 'MZ01-M041L' });
});

test('Claude Code: bắt đầu → link; dán mã → ghi vào stdin, agent thoát 0 → đăng nhập xong', async () => {
  const { login, spawned } = makeLogin({ onSpawn: (c) => c.stdout.write(CLAUDE_LOGIN_OUT) });
  const started = await login.start({ agent: 'claude' }, { runAs: alice });
  assert.equal(started.state, LoginState.PENDING);
  assert.equal(started.needs_code, true);
  assert.match(started.url, /oauth\/authorize/);
  // Linux bọc lệnh bằng `prlimit --nproc=… -- <agent>` (giới hạn tiến trình của thành viên) — chỉ kiểm phần lệnh của agent (CI ubuntu 17/11 trượt).
  assert.deepEqual(spawned[0].argv.slice(-3), ['auth', 'login', '--claudeai']);
  assert.deepEqual([spawned[0].opts.uid, spawned[0].opts.env.HOME], [alice.uid, alice.home]);
  // Người khác không dùng được lần đăng nhập của Alice.
  await assert.rejects(login.submitCode({ login_id: started.login_id, code: 'abcdef#123456' }, { runAs: bob }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(login.submitCode({ login_id: started.login_id, code: 'bad code with spaces' }, { runAs: alice }), (e) => e.code === 'INVALID_ARGS');
  spawned[0].stdin.on('data', () => setImmediate(() => spawned[0].emit('exit', 0)));
  const done = await login.submitCode({ login_id: started.login_id, code: 'abcdef#123456' }, { runAs: alice });
  assert.equal(spawned[0].input, 'abcdef#123456\n');
  assert.equal(done.state, LoginState.SUCCEEDED);
  assert.equal(done.needs_code, false);
});

test('Codex: link + mã thiết bị; xác nhận trên trình duyệt → agent thoát 0, poll thấy xong', async () => {
  const { login, spawned } = makeLogin({ onSpawn: (c) => c.stdout.write(CODEX_LOGIN_OUT) });
  const started = await login.start({ agent: 'codex' }, { runAs: bob });
  assert.deepEqual([started.url, started.user_code, started.needs_code], ['https://auth.openai.com/codex/device', 'MZ01-M041L', false]);
  assert.deepEqual(spawned[0].argv.slice(-2), ['login', '--device-auth']);
  setTimeout(() => spawned[0].emit('exit', 0), 30);
  const polled = await login.poll({ login_id: started.login_id, wait_ms: 2000 }, { runAs: bob });
  assert.equal(polled.state, LoginState.SUCCEEDED);
});

test('đăng nhập: agent không in link → FAILED; bắt đầu lại huỷ lần cũ; agent lạ bị từ chối', async () => {
  const { login, spawned } = makeLogin({ onSpawn: () => {} });
  const r = await login.start({ agent: 'claude' }, { runAs: alice });
  assert.equal(r.state, LoginState.FAILED);
  assert.ok(spawned[0].killed);
  await assert.rejects(login.start({ agent: 'antigravity' }, { runAs: alice }), (e) => e.code === 'INVALID_ARGS');
  await assert.rejects(login.start({ agent: 'claude' }, {}), (e) => e.code === 'INVALID_ARGS');

  const two = makeLogin({ onSpawn: (c) => c.stdout.write(CLAUDE_LOGIN_OUT) });
  const first = await two.login.start({ agent: 'claude' }, { runAs: alice });
  const second = await two.login.start({ agent: 'claude' }, { runAs: alice });
  assert.notEqual(first.login_id, second.login_id);
  assert.ok(two.spawned[0].killed, 'lần đăng nhập cũ bị huỷ');
  assert.equal((await two.login.poll({ login_id: first.login_id }, { runAs: alice })).state, LoginState.FAILED);
  two.login.closeAll();
});

test('llm.status: agent đã cài + đã đăng nhập chưa của đúng thành viên; công cụ là BE-only', async () => {
  const { login } = makeLogin({ signedIn: new Set([`${alice.name}|codex`]) });
  const tools = buildLlmLoginTools(login);
  assert.deepEqual(tools.map((t) => t.name), ['llm.status', 'llm.login_start', 'llm.login_code', 'llm.login_poll', 'llm.logout']);
  assert.ok(tools.every((t) => t.internal && t.read_only));
  const st = await tools[0].handler({}, {}, { runAs: alice });
  assert.deepEqual(st.agents.map((a) => [a.id, a.signed_in, a.can_sign_in]), [['claude', false, true], ['codex', true, true]]);
});
