import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const {
  CLIENT_PROTOCOL, LIGHTCODE_ADAPTER, LIGHTCODE_HEADLESS_CONNECTOR_FILE, buildLightcodeTools, lightcodeOrgJobsEnabled, contractInfoFromPrompt, installLightcode, lightcodeAnswer, lightcodeAttention,
  lightcodeDeploy, lightcodeDeployHosts, lightcodeDeployInfo, lightcodeDeployReply, lightcodeDeploySetup, lightcodeEvents, lightcodeExeCandidates,
  lightcodeLocalStatus, lightcodeMetrics, lightcodePreview, lightcodeSetStrategy, lightcodeStatus, lightcodeStrategy, lightcodeWebhook,
  lightcodeWorklog, parseLatestYml, readConnector, readHeadlessConnector, reattachLightcodeTurn, spawnLightcodeTurn, startLightcodeEventBridge, verifyInstallerSignature,
} = await import('../bin/lib/remote/lightcodeAgent.mjs');
const { DEFAULT_AGENT_ADAPTERS, createAgentRunner } = await import('../bin/lib/remote/codingAgents.mjs');

const SID = '7b1f2c3d-1111-4222-8333-944455556666';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const connectorFile = (info) => {
  const f = path.join(tmp('lc-conn-'), 'connector.json');
  fs.writeFileSync(f, JSON.stringify(info));
  return f;
};
const INFO = { app: 'LightCode', app_version: '1.9.0', port: 4555, key: 'k_secret', pid: 1234 };

/** Phản hồi fetch giả: body là luồng các đoạn NDJSON. */
function ndjsonResponse(events, { status = 200 } = {}) {
  const chunks = events.map((e) => new TextEncoder().encode(`${JSON.stringify(e)}\n`));
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* gen() { for (const c of chunks) yield c; })(),
    json: async () => events,
  };
}

const collect = (child) => new Promise((resolve) => {
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, lines: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
});

test('LightCode đứng cuối danh sách agent mặc định; một người dùng; tự định vị', () => {
  assert.equal(DEFAULT_AGENT_ADAPTERS.at(-1), LIGHTCODE_ADAPTER);
  assert.equal(LIGHTCODE_ADAPTER.multiUser, false, 'mặc định TẮT (cờ AIVIN_LIGHTCODE_ORG_JOBS)');
  assert.equal(typeof LIGHTCODE_ADAPTER.locate, 'function');
  assert.equal(typeof LIGHTCODE_ADAPTER.spawn, 'function');
});

test('cờ AIVIN_LIGHTCODE_ORG_JOBS: chỉ "1" mới bật multiUser; locate headless chỉ khi bật', () => {
  const prev = process.env.AIVIN_LIGHTCODE_ORG_JOBS;
  try {
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      if (v === undefined) delete process.env.AIVIN_LIGHTCODE_ORG_JOBS; else process.env.AIVIN_LIGHTCODE_ORG_JOBS = v;
      assert.equal(LIGHTCODE_ADAPTER.multiUser, false, `giá trị ${v}`);
    }
    process.env.AIVIN_LIGHTCODE_ORG_JOBS = '1';
    assert.equal(LIGHTCODE_ADAPTER.multiUser, true);
  } finally {
    if (prev === undefined) delete process.env.AIVIN_LIGHTCODE_ORG_JOBS; else process.env.AIVIN_LIGHTCODE_ORG_JOBS = prev;
  }
  assert.equal(lightcodeOrgJobsEnabled({}), false);
  assert.equal(lightcodeOrgJobsEnabled({ AIVIN_LIGHTCODE_ORG_JOBS: '1' }), true);
  const f = connectorFile(INFO);
  const base = { file: f, platform: 'linux', exists: () => false, alive: () => false };
  assert.equal(LIGHTCODE_ADAPTER.locate({ ...base, env: {} }), null, 'cờ tắt → không quảng bá');
  const on = LIGHTCODE_ADAPTER.locate({ ...base, env: { AIVIN_LIGHTCODE_ORG_JOBS: '1' } });
  assert.equal(on?.headless, true);
});

test('cửa cục bộ: chỉ nhận connector.json đúng app, có khoá, tiến trình còn sống', () => {
  assert.deepEqual(readConnector({ file: connectorFile(INFO), alive: () => true }), INFO);
  assert.equal(readConnector({ file: connectorFile(INFO), alive: () => false }), null, 'LightCode đã tắt');
  assert.equal(readConnector({ file: connectorFile({ ...INFO, app: 'Other' }), alive: () => true }), null);
  assert.equal(readConnector({ file: connectorFile({ ...INFO, key: '' }), alive: () => true }), null);
  assert.equal(readConnector({ file: path.join(os.tmpdir(), 'nope', 'connector.json') }), null);
});
test('headless connector: đọc đúng cổng + khoá; bỏ qua khi thiếu trường bắt buộc; không tệp → null', () => {
  const f = connectorFile(INFO);
  assert.deepEqual(readHeadlessConnector({ file: f }), INFO);
  // app sai
  assert.equal(readHeadlessConnector({ file: connectorFile({ ...INFO, app: 'Other' }) }), null);
  // không có key
  assert.equal(readHeadlessConnector({ file: connectorFile({ ...INFO, key: '' }) }), null);
  // port không phải số nguyên
  assert.equal(readHeadlessConnector({ file: connectorFile({ ...INFO, port: '4555' }) }), null);
  // tệp không tồn tại
  assert.equal(readHeadlessConnector({ file: path.join(os.tmpdir(), 'nope', 'connector.json') }), null);
  // không có pid → vẫn ổn (headless không kiểm pid)
  const noPid = { ...INFO }; delete noPid.pid;
  assert.ok(readHeadlessConnector({ file: connectorFile(noPid) }), 'headless không yêu cầu pid');
});

test('headless connector: LIGHTCODE_HEADLESS_CONNECTOR_FILE env override đường dẫn', () => {
  const f = connectorFile(INFO);
  const result = readHeadlessConnector({ env: { LIGHTCODE_HEADLESS_CONNECTOR_FILE: f } });
  assert.deepEqual(result, INFO);
  // env trỏ tệp không tồn tại
  assert.equal(readHeadlessConnector({ env: { LIGHTCODE_HEADLESS_CONNECTOR_FILE: '/no/such/file.json' } }), null);
  // không có env → đường dẫn mặc định (không tồn tại trên máy dev → null, không lỗi)
  assert.equal(readHeadlessConnector({ env: {} }), null);
});

test('định vị: đang chạy → có; đã cài (exe) → có; không có gì → null', () => {
  const none = { file: path.join(os.tmpdir(), 'nope.json'), platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, exists: () => false };
  assert.equal(LIGHTCODE_ADAPTER.locate(none), null);
  const exe = lightcodeExeCandidates({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32' })[0];
  const installed = LIGHTCODE_ADAPTER.locate({ ...none, exists: (p) => p === exe });
  assert.deepEqual(installed, { bin: 'lightcode', version: '0.0.0', flags: ['--job'] });
  const running = LIGHTCODE_ADAPTER.locate({ ...none, file: connectorFile(INFO), alive: () => true });
  assert.equal(running.version, '1.9.0');
  assert.deepEqual(lightcodeLocalStatus({ ...none, file: connectorFile(INFO), alive: () => true }), { supported: true, installed: true, running: true, version: '1.9.0' });
  assert.equal(LIGHTCODE_ADAPTER.locate({ ...none, platform: 'linux' }), null, 'chưa có bản Linux');
});

const GW = () => ({ baseUrl: 'https://be.example/ai/v1/', apiKey: 'wes-ak-secret', model: 'aivin-default', expiresAt: new Date(Date.now() + 3600_000).toISOString() });

test('aiGateway: hợp lệ → vào tham số job; hết hạn → bỏ; sai dạng → lỗi; không có → không có trường', () => {
  const parsed = (gw) => JSON.parse(LIGHTCODE_ADAPTER.args({ aiGateway: gw })[1]);
  assert.equal(parsed(undefined).aiGateway, undefined);
  const ok = parsed(GW());
  assert.deepEqual(Object.keys(ok.aiGateway).sort(), ['apiKey', 'baseUrl', 'expiresAt', 'model']);
  assert.equal(ok.aiGateway.baseUrl, 'https://be.example/ai/v1');
  assert.equal(parsed({ ...GW(), expiresAt: new Date(Date.now() - 1000).toISOString() }).aiGateway, undefined, 'hết hạn → bỏ');
  for (const bad of [{ ...GW(), baseUrl: 'ftp://x' }, { ...GW(), apiKey: '' }, { ...GW(), apiKey: 'a b' }, { ...GW(), model: '' }, { ...GW(), expiresAt: 'xx' }, 'str']) {
    assert.throws(() => LIGHTCODE_ADAPTER.args({ aiGateway: bad }), /aiGateway/);
  }
});

test('aiGateway: gửi theo từng job (ai_gateway, snake_case); hết hạn lúc gửi → không gửi; khoá không lọt ra log / dòng lỗi', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return ndjsonResponse([{ type: 'result', ok: true, answer: 'x' }]); };
  const run = (argv) => { const child = spawnLightcodeTurn(argv, {}, { fetchImpl, ensure: async () => INFO }); const done = collect(child); child.stdin.end('x'); return done; };
  const withGw = await run(LIGHTCODE_ADAPTER.args({ aiGateway: GW() }));
  assert.equal(bodies[0].ai_gateway.api_key, 'wes-ak-secret');
  assert.deepEqual(Object.keys(bodies[0].ai_gateway).sort(), ['api_key', 'base_url', 'expires_at', 'model']);
  assert.ok(!JSON.stringify(withGw.lines).includes('wes-ak-secret'), 'khoá không lọt ra luồng kết quả');
  const none = await run(LIGHTCODE_ADAPTER.args({}));
  assert.equal(bodies[1].ai_gateway, undefined);
  assert.equal(none.code, 0);
  // Argv còn hạn lúc dựng nhưng hết hạn lúc gửi (job nối lại sau lâu) → không gửi khoá chết.
  const stale = LIGHTCODE_ADAPTER.args({ aiGateway: { ...GW(), expiresAt: new Date(Date.now() + 50).toISOString() } });
  await new Promise((r) => setTimeout(r, 80));
  await run(stale);
  assert.equal(bodies[2].ai_gateway, undefined);
});

test('tham số: một JSON duy nhất, mang luật cấm của hợp đồng tới LightCode', () => {
  const argv = LIGHTCODE_ADAPTER.args({ mode: 'accept_edits', resume: SID, allowedTools: ['Bash(npm test)'], addDirs: ['D:\\x'], settings: { permissions: { deny: ['Edit(**/.env)'] } } });
  assert.equal(argv[0], '--job');
  assert.deepEqual(JSON.parse(argv[1]), { mode: 'accept_edits', resume: SID, addDirs: ['D:\\x'], allowedTools: ['Bash(npm test)'], deny: ['Edit(**/.env)'] });
});

test('hợp đồng: lấy job_id / contract_id / tiêu đề từ CONTRACT.md mà đề bài trỏ tới', () => {
  const dir = path.join(tmp('lc-jobs-'), 'lightcode-0a1b2c3d');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'CONTRACT.md');
  fs.writeFileSync(file, '---\ncontract_id: "ctr_42"\n---\n# Trang đăng nhập\n\nNội dung');
  assert.deepEqual(contractInfoFromPrompt(`Read ${file} and do it.`), { job_id: 'lightcode-0a1b2c3d', contract_id: 'ctr_42', title: 'Trang đăng nhập' });
  assert.deepEqual(contractInfoFromPrompt('just chat'), {});
});

test('một lượt: gửi job tới cửa cục bộ (Bearer), stream NDJSON nguyên vẹn, đóng mã 0', async () => {
  let req;
  const fetchImpl = async (url, init) => { req = { url, init }; return ndjsonResponse([
    { type: 'init', session_id: SID, thread_id: 't1', project_id: 'p1', app_version: '1.9.0' },
    { type: 'text', text: 'Đang sửa' },
    { type: 'result', ok: true, answer: 'Xong', provider: 'claude', model: 'opus' },
  ]); };
  const argv = LIGHTCODE_ADAPTER.args({ mode: 'accept_edits', allowedTools: ['Read'], settings: { permissions: { deny: ['Bash(rm:*)'] } } });
  const child = spawnLightcodeTurn(argv, { cwd: 'D:\\repo\\.aivin-worktrees\\j1' }, { fetchImpl, ensure: async () => INFO });
  const done = collect(child);
  child.stdin.end('Làm trang đăng nhập');
  const { code, lines } = await done;
  assert.equal(code, 0);
  assert.equal(req.url, 'http://127.0.0.1:4555/connector/v1/jobs');
  assert.equal(req.init.headers.Authorization, 'Bearer k_secret');
  const body = JSON.parse(req.init.body);
  assert.equal(body.prompt, 'Làm trang đăng nhập');
  assert.equal(body.cwd, 'D:\\repo\\.aivin-worktrees\\j1');
  assert.equal(body.headless, true);
  assert.deepEqual(body.deny_rules, ['Bash(rm:*)']);
  assert.deepEqual(body.allowed_tools, ['Read']);
  assert.equal(body.source.name, 'AIVIN');
  assert.deepEqual(lines.map((l) => l.type), ['init', 'text', 'result']);
});

test('LightCode từ chối (hết bản dùng thử) → một dòng result lỗi rõ ràng, mã 1', async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ error: 'trial ended', code: 'license_required' }) });
  const child = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({}), {}, { fetchImpl, ensure: async () => INFO });
  const done = collect(child);
  child.stdin.end('x');
  const { code, lines } = await done;
  assert.equal(code, 1);
  assert.deepEqual(lines, [{ type: 'result', ok: false, answer: 'trial ended', stop_reason: 'license_required' }]);
});

test('chưa cài LightCode → result lỗi not_installed (không treo)', async () => {
  const { DeviceToolError } = await import('../bin/lib/remote/sandbox.mjs');
  const { DeviceErrorCode } = await import('../bin/lib/remote/constants.mjs');
  const child = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({}), {}, { fetchImpl: async () => assert.fail('no fetch'), ensure: async () => { throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, 'not installed'); } });
  const done = collect(child);
  child.stdin.end('x');
  const { code, lines } = await done;
  assert.equal(code, 1);
  assert.equal(lines[0].stop_reason, 'not_installed');
});

test('kill = huỷ kết nối (LightCode dừng lượt), close(null) đúng một lần', async () => {
  let signal;
  const fetchImpl = (url, init) => { signal = init.signal; return new Promise(() => undefined); };
  const child = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({}), {}, { fetchImpl, ensure: async () => INFO });
  let closes = 0;
  const closed = new Promise((r) => child.on('close', (c) => { closes += 1; r(c); }));
  child.stdin.end('x');
  await new Promise((r) => setTimeout(r, 10));
  child.kill();
  child.kill();
  assert.equal(await closed, null);
  assert.equal(signal.aborted, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closes, 1);
});

test('parse: init giữ session_id để vòng sửa nói tiếp; result mang provider / tài khoản đã dùng', () => {
  const job = { texts: [], tools: [] };
  assert.equal(LIGHTCODE_ADAPTER.parse(job, { type: 'init', session_id: SID, thread_id: 't1', project_id: 'p1', app_version: '1.9.0' }), '');
  assert.equal(job.session_id, SID);
  assert.equal(LIGHTCODE_ADAPTER.parse(job, { type: 'text', text: 'Xin chào' }), 'Xin chào');
  assert.equal(LIGHTCODE_ADAPTER.parse(job, { type: 'status', text: 'Chuyển tài khoản dự phòng' }), '⏳ Chuyển tài khoản dự phòng');
  assert.equal(LIGHTCODE_ADAPTER.parse(job, { type: 'ping' }), '');
  LIGHTCODE_ADAPTER.parse(job, { type: 'result', ok: true, answer: 'Xong', provider: 'codex', account: 'b@x', duration_ms: 1200, permission_denials: ['Bash(rm -rf)'] });
  assert.match(job.result.account, /^acc_[0-9a-f]{16}$/, 'không gửi email tài khoản lên Aivin');
  assert.deepEqual({ ...job.result, account: undefined }, { ok: true, answer: 'Xong', provider: 'codex', account: undefined, duration_ms: 1200, permission_denials: ['Bash(rm -rf)'] });
  assert.equal(job.model, 'codex');
});

test('latest.yml của electron-builder: chỉ nhận .exe có sha512', () => {
  const yml = "version: 1.9.0\nfiles:\n  - url: LightCode-Setup-1.9.0.exe\n    sha512: AAA==\n    size: 123456\npath: LightCode-Setup-1.9.0.exe\nsha512: AAA==\nreleaseDate: '2026-11-19'\n";
  assert.deepEqual(parseLatestYml(yml), { version: '1.9.0', file: 'LightCode-Setup-1.9.0.exe', sha512: 'AAA==', size: 123456 });
  assert.equal(parseLatestYml(yml.replace(/\.exe/g, '.sh')), null);
  assert.equal(parseLatestYml('version: 1'), null);
});

test('cài: tải bộ cài, kiểm SHA-512, chạy /S, bật LightCode; sai checksum → không chạy bộ cài', async () => {
  const bytes = Buffer.from('fake installer bytes');
  const good = createHash('sha512').update(bytes).digest('base64');
  const make = (sha) => {
    const calls = { spawned: [] };
    const fetchImpl = async (url) => (url.endsWith('latest.yml')
      ? { ok: true, status: 200, text: async () => `version: 1.9.0\npath: LightCode-Setup-1.9.0.exe\nsha512: ${sha}\n` }
      : { ok: true, status: 200, body: (async function* gen() { yield bytes; })() });
    const spawnImpl = (bin, args) => {
      calls.spawned.push({ bin, args });
      const c = new EventEmitter();
      c.kill = () => true;
      setImmediate(() => c.emit('close', 0));
      return c;
    };
    const deps = { platform: 'win32', fetchImpl, spawnImpl, verifySignature: async () => ({ status: 'Valid', subject: 'CN=GOMEE' }), downloadDir: tmp('lc-dl-'), ensure: async () => INFO, file: path.join(os.tmpdir(), 'nope.json'), env: {}, exists: () => false };
    return { calls, deps };
  };
  const ok = make(good);
  const out = [];
  const res = await installLightcode({}, { onOutput: (t) => out.push(t) }, ok.deps);
  assert.equal(res.installed, true);
  assert.equal(res.agent, 'lightcode');
  assert.deepEqual(ok.calls.spawned.map((s) => s.args), [['/S']]);
  assert.ok(out.join('').includes('Checksum OK'));

  const bad = make('WRONG==');
  await assert.rejects(installLightcode({}, {}, bad.deps), /checksum/);
  assert.equal(bad.calls.spawned.length, 0, 'không chạy bộ cài lạ');

  await assert.rejects(installLightcode({}, {}, { ...ok.deps, platform: 'darwin' }), /only available for Windows/);
});

test('đã cài → install chỉ bật, không tải', async () => {
  const res = await installLightcode({}, {}, {
    platform: 'win32', fetchImpl: async () => assert.fail('no download'), ensure: async () => INFO,
    file: connectorFile(INFO), alive: () => true,
  });
  assert.equal(res.already, true);
});

test('công cụ: đọc là read_only; lightcode.install & lightcode.deploy luôn rủi ro cần người đồng ý', () => {
  const tools = buildLightcodeTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(tools.map((t) => t.name), [
    'lightcode.status', 'lightcode.install', 'lightcode.worklog', 'lightcode.deploy_hosts', 'lightcode.deploy_info',
    'lightcode.deploy_setup', 'lightcode.deploy', 'lightcode.deploy_reply', 'lightcode.attention', 'lightcode.strategy',
    'lightcode.set_strategy', 'lightcode.metrics', 'lightcode.events', 'lightcode.answer', 'lightcode.preview',
  ]);
  for (const name of ['lightcode.status', 'lightcode.worklog', 'lightcode.deploy_hosts', 'lightcode.deploy_info', 'lightcode.attention', 'lightcode.strategy', 'lightcode.metrics', 'lightcode.events']) {
    assert.equal(byName[name].read_only, true, `${name} phải là read_only`);
  }
  for (const name of ['lightcode.install', 'lightcode.deploy_setup', 'lightcode.deploy', 'lightcode.deploy_reply', 'lightcode.set_strategy', 'lightcode.answer', 'lightcode.preview']) {
    assert.notEqual(byName[name].read_only, true, `${name} không phải read_only`);
  }
  assert.match(byName['lightcode.install'].description, /ONLY after the person agreed/);
  const src = fs.readFileSync(new URL('../bin/lib/remote/localPolicy.mjs', import.meta.url), 'utf8');
  assert.match(src, /ALWAYS_RISKY_TOOLS = new Set\([^)]*'lightcode\.install'/);
  assert.match(src, /ALWAYS_RISKY_TOOLS = new Set\([^)]*'lightcode\.deploy'/);
});

test('giao thức 2: detach, tự nối lại khi rớt mạng (bỏ trùng seq), và dừng thật qua /sessions/:id/stop', async () => {
  const INFO_V2 = { ...INFO, protocol: 2 };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/jobs')) {
      return ndjsonResponse([
        { seq: 0, type: 'init', session_id: SID, thread_id: 't1', project_id: 'p1', app_version: '1.9.0', protocol: 2 },
        { seq: 1, type: 'text', text: 'Bước 1' },
      ]); // ngắt kết nối trước result
    }
    if (url.includes(`/sessions/${SID}/events?from=2`)) {
      return ndjsonResponse([
        { seq: 1, type: 'text', text: 'Bước 1 trùng' }, // phải bỏ qua vì seq <= 1
        { seq: 2, type: 'progress', progress: { files_changed: 2, insertions: 10, deletions: 3, tool_calls: 4, tests_run: 1, elapsed_ms: 500 } },
        { seq: 3, type: 'result', ok: true, answer: 'Hoàn tất', provider: 'claude', agent: 'claude', usage: { cost_usd: 0.42, tokens: { input: 100, output: 50 } } },
      ]);
    }
    assert.fail(`unexpected url: ${url}`);
  };
  const argv = LIGHTCODE_ADAPTER.args({ mode: 'accept_edits', budgetUsd: 2.5, clarify: true, provider: 'claude' });
  const child = spawnLightcodeTurn(argv, { cwd: 'D:\\repo' }, { fetchImpl, ensure: async () => INFO_V2, peek: () => INFO_V2, sleep: async () => undefined });
  const done = collect(child);
  child.stdin.end('Làm tính năng X');
  const { code, lines } = await done;
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.detach, true);
  assert.equal(calls[0].body.on_question, 'stop');
  assert.equal(calls[0].body.max_cost_usd, 2.5);
  assert.equal(calls[0].body.provider, 'claude');
  assert.deepEqual(lines.map((l) => l.seq), [0, 1, 2, 3], 'không lặp sự kiện cũ khi nối lại');

  // kill trên job tách khỏi kết nối gọi /sessions/:id/stop
  const stopCalls = [];
  let hold;
  const fetchHold = (url, init) => {
    if (url.endsWith('/stop')) { stopCalls.push({ url, method: init.method }); return Promise.resolve({ ok: true }); }
    return Promise.resolve({
      ok: true, status: 200,
      body: (async function* gen() {
        yield new TextEncoder().encode(`${JSON.stringify({ seq: 0, type: 'init', session_id: SID, thread_id: 't1', project_id: 'p1', protocol: 2 })}\n`);
        await new Promise((r) => { hold = r; });
      })(),
    });
  };
  const c2 = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({}), {}, { fetchImpl: fetchHold, ensure: async () => INFO_V2, peek: () => INFO_V2 });
  const closed = new Promise((r) => c2.on('close', r));
  c2.stdin.end('x');
  await new Promise((r) => setTimeout(r, 20));
  c2.kill();
  hold?.();
  assert.equal(await closed, null);
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].url, `http://127.0.0.1:4555/connector/v1/sessions/${SID}/stop`);
});

test('giao thức 2: 404 khi nối lại → turn_lost; giao thức lệch (min_client_protocol > CLIENT_PROTOCOL) → protocol_mismatch', async () => {
  const INFO_V2 = { ...INFO, protocol: 2 };
  const fetchLost = async (url) => (url.endsWith('/jobs')
    ? ndjsonResponse([{ seq: 0, type: 'init', session_id: SID, protocol: 2 }])
    : { ok: false, status: 404, json: async () => ({ error: 'turn_lost' }) });
  const c1 = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({}), {}, { fetchImpl: fetchLost, ensure: async () => INFO_V2, peek: () => INFO_V2, sleep: async () => undefined });
  const d1 = collect(c1);
  c1.stdin.end('x');
  const r1 = await d1;
  assert.equal(r1.code, 1);
  assert.equal(r1.lines.at(-1).stop_reason, 'turn_lost');

  const c2 = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({}), {}, {
    fetchImpl: async () => assert.fail('must not POST on protocol mismatch'),
    ensure: async () => ({ ...INFO, protocol: 9, min_client_protocol: CLIENT_PROTOCOL + 1 }),
  });
  const d2 = collect(c2);
  c2.stdin.end('x');
  const r2 = await d2;
  assert.equal(r2.code, 1);
  assert.equal(r2.lines[0].stop_reason, 'protocol_mismatch');
});

test('parse v2: progress, question, intervention, usage/cost, quota, violations, inner_agent', () => {
  const job = { texts: [], tools: [] };
  LIGHTCODE_ADAPTER.parse(job, { type: 'init', session_id: SID, thread_id: 't1', project_id: 'p1', app_version: '2.0.0', protocol: 2 });
  assert.equal(job.lightcode.protocol, 2);
  const pLine = LIGHTCODE_ADAPTER.parse(job, { type: 'progress', progress: { files_changed: 3, files: [{ path: 'a.ts', status: 'M' }], insertions: 20, deletions: 4, tool_calls: 7, tests_run: 2, elapsed_ms: 1500 } });
  assert.match(pLine, /3 file\(s\) changed \(\+20\/-4\), 2 test run\(s\)/);
  assert.equal(job.progress.tests_run, 2);
  const qLine = LIGHTCODE_ADAPTER.parse(job, { type: 'question', questions: [{ question: 'Dùng Redis hay bộ nhớ?', options: ['Redis', 'Memory'] }] });
  assert.match(qLine, /Dùng Redis/);
  assert.equal(job.questions.length, 1);
  const iLine = LIGHTCODE_ADAPTER.parse(job, { type: 'intervention', text: 'Để tôi sửa chỗ này' });
  assert.match(iLine, /took part in LightCode/);
  assert.equal(job.intervened, true);
  LIGHTCODE_ADAPTER.parse(job, {
    seq: 5, type: 'result', ok: false, answer: 'Cần xác nhận', provider: 'claude', agent: 'claude', stop_reason: 'needs_clarification',
    usage: { cost_usd: 0.35, tokens: 620 },
    quota: [{ provider: 'claude', five_hour_used_pct: 40, weekly_used_pct: 12, resets_at: '2026-11-20T12:00:00Z', account: 'a@b' }],
    violations: ['package.json'],
  });
  assert.equal(job.last_seq, 5);
  assert.equal(job.result.cost_usd, 0.35);
  assert.equal(job.result.usage.tokens, 620);
  assert.equal(job.result.inner_agent, 'claude');
  assert.equal(job.result.stop_reason, 'needs_clarification');
  assert.equal(job.result.questions.length, 1);
  assert.deepEqual(job.result.violations, ['package.json']);
  assert.equal(job.result.intervened, true);
  assert.equal(job.result.quota.length, 1);
  assert.equal(job.result.quota[0].five_hour_used_pct, 40);
  assert.equal(job.result.quota[0].weekly_used_pct, 12);
  assert.match(job.result.quota[0].account, /^acc_[0-9a-f]{16}$/, 'không rò rỉ email trong quota');
});

test('kiểm chữ ký bộ cài Authenticode: chặn chữ ký hỏng / sai nhà phát hành; NotSigned chỉ chặn khi bật bắt buộc', async () => {
  const fakeExec = (payload) => (_bin, _args, _opts, cb) => cb(null, JSON.stringify(payload));
  assert.deepEqual(await verifyInstallerSignature('C:\\x.exe', { execFileImpl: fakeExec({ status: 'Valid', subject: 'CN=GOMEE JSC', thumbprint: 'ABC' }), expectedPublisher: 'GOMEE' }), { status: 'Valid', subject: 'CN=GOMEE JSC', thumbprint: 'ABC' });
  await assert.rejects(verifyInstallerSignature('C:\\x.exe', { execFileImpl: fakeExec({ status: 'Valid', subject: 'CN=Evil Corp' }), expectedPublisher: 'GOMEE' }), /not "GOMEE"/);
  await assert.rejects(verifyInstallerSignature('C:\\x.exe', { execFileImpl: fakeExec({ status: 'HashMismatch' }) }), /invalid signature/);
  assert.deepEqual(await verifyInstallerSignature('C:\\x.exe', { execFileImpl: fakeExec({ status: 'NotSigned' }) }), { status: 'NotSigned' });
  await assert.rejects(verifyInstallerSignature('C:\\x.exe', { execFileImpl: fakeExec({ status: 'NotSigned' }), requireSignature: true }), /not digitally signed/);
});

test('lightcodeStatus báo protocol, min_client_protocol, features và capacity', async () => {
  const file = connectorFile({ ...INFO, protocol: 2 });
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ protocol: 2, min_client_protocol: 1, features: ['detach', 'questions'], can_run: true, providers: ['claude'], accounts: 2, capacity: { max_parallel: 2, running: 0, queued: 0 } }),
  });
  const st = await lightcodeStatus({ file, alive: () => true, platform: 'win32', env: {}, exists: () => false, fetchImpl });
  assert.equal(st.protocol, 2);
  assert.equal(st.client_protocol, CLIENT_PROTOCOL);
  assert.equal(st.protocol_ok, true);
  assert.deepEqual(st.features, ['detach', 'questions']);
  assert.equal(st.capacity.max_parallel, 2);
});

test('reattach sau khi CLI khởi động lại: nối tiếp từ last_seq khi LightCode v2 còn chạy; không mở thì trả null', async () => {
  const INFO_V2 = { ...INFO, protocol: 2 };
  assert.equal(reattachLightcodeTurn({ sessionId: SID, lastSeq: 1 }, { peek: () => null }), null);
  assert.equal(reattachLightcodeTurn({ sessionId: SID, lastSeq: 1 }, { peek: () => ({ ...INFO, protocol: 1 }) }), null);

  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return ndjsonResponse([
      { seq: 1, type: 'text', text: 'trùng phải bỏ' },
      { seq: 2, type: 'text', text: 'tiếp tục xong' },
      { seq: 3, type: 'result', ok: true, answer: 'Xong sau restart', provider: 'claude', usage: { cost_usd: 0.25, tokens: 300 } },
    ]);
  };
  const child = reattachLightcodeTurn({ sessionId: SID, lastSeq: 1 }, { peek: () => INFO_V2, fetchImpl, sleep: async () => undefined });
  assert.ok(child);
  const { code, lines } = await collect(child);
  assert.equal(code, 0);
  assert.equal(requested[0], `http://127.0.0.1:4555/connector/v1/sessions/${SID}/events?from=2`);
  assert.deepEqual(lines.map((l) => l.seq), [2, 3]);

  // createAgentRunner.restore(): tự nối lại job đang chạy trên đĩa khi LightCode v2 còn mở; tắt LightCode → interrupted.
  const jobsDir = tmp('lc-reattach-');
  const jobId = 'lightcode-deadbeef';
  fs.mkdirSync(path.join(jobsDir, jobId), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, jobId, 'job.json'), JSON.stringify({
    id: jobId, agent: 'lightcode', status: 'running', cwd: jobsDir, cwdShown: jobsDir, mode: 'accept_edits',
    session_id: SID, last_seq: 1, startedAt: Date.now() - 5000, endedAt: 0, prompt: 'test',
  }));
  const adapterLive = { ...LIGHTCODE_ADAPTER, reattach: (j) => reattachLightcodeTurn({ sessionId: j.session_id, lastSeq: j.last_seq }, { peek: () => INFO_V2, fetchImpl, sleep: async () => undefined }) };
  const runner1 = createAgentRunner({ adapters: [adapterLive], find: () => ({ bin: 'lightcode', version: '2.0.0', flags: ['--job'] }), jobsDir });
  const st1 = await runner1.status({ job: jobId, wait_ms: 5000 });
  assert.equal(st1.status, 'done');
  assert.equal(st1.result.answer, 'Xong sau restart');
  assert.equal(st1.result.cost_usd, 0.25);

  const jobsDir2 = tmp('lc-reattach-off-');
  fs.mkdirSync(path.join(jobsDir2, jobId), { recursive: true });
  fs.writeFileSync(path.join(jobsDir2, jobId, 'job.json'), JSON.stringify({
    id: jobId, agent: 'lightcode', status: 'running', cwd: jobsDir2, cwdShown: jobsDir2, mode: 'accept_edits',
    session_id: SID, last_seq: 1, startedAt: Date.now() - 5000, endedAt: 0, prompt: 'test',
  }));
  const adapterOff = { ...LIGHTCODE_ADAPTER, reattach: (j) => reattachLightcodeTurn({ sessionId: j.session_id, lastSeq: j.last_seq }, { peek: () => null }) };
  const runner2 = createAgentRunner({ adapters: [adapterOff], find: () => ({ bin: 'lightcode', version: '2.0.0', flags: ['--job'] }), jobsDir: jobsDir2 });
  const st2 = await runner2.status({ job: jobId });
  assert.equal(st2.status, 'interrupted');
});

test('verdict của LightCode: args mang tiêu chí đi, result mang verdict về (rút gọn, trạng thái lạ → partial)', async () => {
  const { LIGHTCODE_ADAPTER, slimVerdict } = await import('../bin/lib/remote/lightcodeAgent.mjs');
  const argv = LIGHTCODE_ADAPTER.args({ mode: 'manual', acceptance: ['api_ok', 'ui_ok'], constraints: ['no new deps'] });
  const job = JSON.parse(argv[1]);
  assert.deepEqual(job.acceptance, ['api_ok', 'ui_ok']);
  assert.deepEqual(job.constraints, ['no new deps']);
  assert.equal('acceptance' in JSON.parse(LIGHTCODE_ADAPTER.args({ mode: 'manual' })[1]), false);

  const j = {};
  LIGHTCODE_ADAPTER.parse(j, { type: 'result', ok: true, answer: 'xong', verdict: { status: 'done', criteria: [{ text: 'api_ok', met: true, evidence: 'a.ts' }], constraints: [], checks: [], issues: [], summary: 'ok', cost_usd: 0.4 } });
  assert.equal(j.result.verdict.status, 'done');
  assert.equal(j.result.verdict.criteria[0].met, true);
  assert.equal(slimVerdict({ status: 'weird' }).status, 'partial');
});

test('khoán việc: tiêu chí đi kèm câu chữ + quy tắc nghiệp vụ lấy từ thân hợp đồng; tiêu chí máy đo / người duyệt không đưa cho agent', async () => {
  const { contractBrief } = await import('../bin/lib/remote/agentContract.mjs');
  const { slimVerdict } = await import('../bin/lib/remote/lightcodeAgent.mjs');
  const body = [
    '# Đăng nhập', '', '## Mục tiêu', 'Làm đăng nhập.', '',
    '## Nghiệp vụ liên quan', '- Khóa tài khoản sau 5 lần sai', '- Không lưu mật khẩu dạng rõ', '',
    '## Tiêu chí đánh giá',
    '- gate_unit_passes: Lệnh kiểm chứng "unit" chạy đạt trên máy.',
    '- api_ok: POST /login trả 200 và token khi đúng mật khẩu.',
    '- ui_ok: Form báo lỗi tiếng Việt khi sai.',
    '- human_review: Người của dự án duyệt kết quả.', '',
  ].join('\n');
  const contract = { acceptance: [
    { key: 'gate_unit_passes', check: 'command_passed' },
    { key: 'api_ok', verifier: 'llm_rubric' },
    { key: 'ui_ok', verifier: 'llm_rubric' },
    { key: 'no_text', verifier: 'llm_rubric' },
    { key: 'human_review', verifier: 'human' },
  ] };
  const b = contractBrief(body, contract);
  assert.deepEqual(b.acceptance, ['api_ok: POST /login trả 200 và token khi đúng mật khẩu.', 'ui_ok: Form báo lỗi tiếng Việt khi sai.', 'no_text']);
  assert.deepEqual(b.constraints, ['Khóa tài khoản sau 5 lần sai', 'Không lưu mật khẩu dạng rõ']);
  assert.deepEqual(contractBrief('', { acceptance: [] }), { acceptance: [], constraints: [] });

  const v = slimVerdict({ status: 'partial', report: 'none', criteria: [{ text: 'a', met: false, reported: false }], issues: ['The agent did not report on the contract'] });
  assert.equal(v.report, 'none');
  assert.equal(v.criteria[0].reported, false);
});

test('lightcodeReadiness: chưa đăng nhập tài khoản AI / hết bản quyền / giao tiếp lệch → lý do; dùng được hoặc chưa chạy → null', async () => {
  const { lightcodeReadiness } = await import('../bin/lib/remote/lightcodeAgent.mjs');
  const file = connectorFile({ ...INFO, protocol: 2 });
  const ask = (body) => lightcodeReadiness({ file, alive: () => true, platform: 'win32', env: {}, exists: () => false, fetchImpl: async () => ({ ok: true, json: async () => ({ protocol: 2, min_client_protocol: 1, can_run: true, accounts: 1, ...body }) }) });
  assert.equal(await ask({}), null);
  assert.equal(await ask({ accounts: 0 }), 'no_account');
  assert.equal(await ask({ can_run: false }), 'license_expired');
  assert.equal(await ask({ min_client_protocol: 99 }), 'protocol_mismatch');
  // Đã cài nhưng chưa chạy: chưa biết → không chặn (job sẽ bật LightCode lên).
  assert.equal(await lightcodeReadiness({ file: path.join(os.tmpdir(), 'nope-connector.json'), alive: () => false, platform: 'win32', env: {}, exists: () => true }), null);
});

test('installLightcode: cài mới xong nhưng chưa đăng nhập tài khoản AI → trả issue no_account', async () => {
  const bytes = Buffer.from('fake installer bytes v2');
  const good = createHash('sha512').update(bytes).digest('base64');
  const fetchImpl = async (url) => {
    if (url.endsWith('latest.yml')) return { ok: true, status: 200, text: async () => `version: 2.0.0\npath: LightCode-Setup-2.0.0.exe\nsha512: ${good}\n` };
    if (url.endsWith('/connector/v1/info')) return { ok: true, status: 200, json: async () => ({ protocol: 2, min_client_protocol: 1, can_run: true, accounts: 0 }) };
    return { ok: true, status: 200, body: (async function* gen() { yield bytes; })() };
  };
  const spawnImpl = () => {
    const c = new EventEmitter();
    c.kill = () => true;
    setImmediate(() => c.emit('close', 0));
    return c;
  };
  const res = await installLightcode({}, {}, {
    platform: 'win32', fetchImpl, spawnImpl, verifySignature: async () => ({ status: 'Valid' }),
    downloadDir: tmp('lc-dl-noacc-'), ensure: async () => ({ ...INFO, protocol: 2 }),
    file: path.join(os.tmpdir(), 'nope-noacc.json'), env: {}, exists: () => false,
  });
  assert.equal(res.installed, true);
  assert.equal(res.issue, 'no_account');
});

test('lightcodeWorklog & lightcodeDeployInfo: gọi cửa cục bộ khi LightCode chạy, và fallback đọc đĩa khi LightCode tắt', async () => {
  const repo = tmp('lc-ops-repo-');
  fs.mkdirSync(path.join(repo, '.lcagent', 'deploy'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.lcagent', 'worklog.jsonl'),
    `${JSON.stringify({ id: 't1:m1', at: '2026-11-20T10:00:00Z', threadId: 't1', title: 'Sửa API', ask: 'Sửa', outcome: 'Xong API', files: ['a.ts'], source: 'user' })}\n`,
  );
  fs.writeFileSync(
    path.join(repo, '.lcagent', 'workflow.json'),
    JSON.stringify({ version: 2, parts: [], environments: [{ id: 'staging', name: 'Staging', tier: 'staging', targets: [{ where: 'VPS' }], approval: false }] }),
  );
  fs.writeFileSync(path.join(repo, '.lcagent', 'deploy', 'staging.md'), '# recipe\n');

  // LightCode đang tắt → đọc fallback trên đĩa
  const offlineDeps = { file: path.join(os.tmpdir(), 'nope-ops.json'), alive: () => false, roots: [repo] };
  const wlOff = await lightcodeWorklog({ cwd: repo }, offlineDeps);
  assert.equal(wlOff.running, false);
  assert.equal(wlOff.fallback, 'disk');
  assert.equal(wlOff.entries.length, 1);
  assert.equal(wlOff.entries[0].title, 'Sửa API');

  const depOff = await lightcodeDeployInfo({ cwd: repo }, offlineDeps);
  assert.equal(depOff.running, false);
  assert.equal(depOff.configured, true);
  assert.equal(depOff.environments[0].has_recipe, true);

  // LightCode đang chạy → gọi /connector/v1/worklog và /connector/v1/deploy
  const seenUrls = [];
  const fetchImpl = async (url, init) => {
    seenUrls.push({ method: init?.method || 'GET', url });
    if (url.includes('/connector/v1/worklog')) {
      return { ok: true, status: 200, json: async () => ({ entries: [{ id: 't1:m1', title: 'Sửa API' }], active_sessions: [{ thread_id: 'thr_1' }] }) };
    }
    if (url.endsWith('/connector/v1/deploy')) {
      return { ok: true, status: 201, json: async () => ({ project_id: 'p1', project_name: 'Repo', runs: [{ id: 'dep1', env_id: 'staging', env_name: 'Staging', thread_id: 'thr_dep', mode: 'script', status: 'running' }] }) };
    }
    if (url.includes('/connector/v1/deploy/runs/thr_dep')) {
      return { ok: true, status: 200, json: async () => ({ thread_id: 'thr_dep', status: 'done', running: false, ok: true, report: '✅ Deployed Staging' }) };
    }
    assert.fail(`unexpected url: ${url}`);
  };
  const onlineDeps = { connector: INFO, fetchImpl, roots: [repo], sleep: async () => undefined };
  const wlOn = await lightcodeWorklog({ cwd: repo, source: 'user', limit: 5 }, onlineDeps);
  assert.equal(wlOn.running, true);
  assert.equal(wlOn.active_sessions.length, 1);

  const depRes = await lightcodeDeploy({ cwd: repo, env: 'staging', note: 'release test', wait_ms: 1000 }, {}, onlineDeps);
  assert.equal(depRes.runs[0].status, 'done');
  assert.equal(depRes.runs[0].ok, true);
  assert.match(depRes.runs[0].report, /Deployed Staging/);
  assert.ok(seenUrls.some((u) => u.method === 'POST' && u.url.endsWith('/connector/v1/deploy')));
});

test('cầu nối v2.3: truyền client_job_id/goal_id/depends_on/max_fix_rounds/deliverables/verify và đọc risk/goal/git/fix_rounds/deliverables', async () => {
  const INFO_V2 = { ...INFO, protocol: 2 };
  let postedBody = null;
  const fetchImpl = async (url, init) => {
    postedBody = JSON.parse(init.body);
    return ndjsonResponse([
      { seq: 0, type: 'init', session_id: SID, thread_id: 't1', project_id: 'p1', protocol: 2 },
      {
        seq: 1, type: 'result', ok: true, answer: 'Xong toàn bộ', provider: 'claude',
        risk: { level: 'low', auto_merge_ok: true, reasons: ['tests passed'] },
        goal: { id: 'g1', spent_usd: 1.25, budget_usd: 10 },
        git: { branch: 'aivin/j1', head: 'abc1234', dirty: false, diff_stat: '2 files changed' },
        fix_rounds: 2,
        verdict: {
          status: 'done', criteria: [], constraints: [], checks: [{ cmd: 'npm test', ok: true }],
          deliverables: [{ path: 'out/report.pdf', ok: true, exists: true, size: 2048, format: 'pdf' }],
          issues: [], summary: 'ok',
        },
      },
    ]);
  };
  const argv = LIGHTCODE_ADAPTER.args({
    mode: 'accept_edits', clientJobId: 'job-001', goalId: 'g1', dependsOn: ['sess-prev'], maxFixRounds: 2,
    verify: ['npm test'], deliverables: ['out/report.pdf', { path: 'out/chart.png', min_bytes: 512 }],
  });
  const child = spawnLightcodeTurn(argv, { cwd: 'D:\\repo' }, { fetchImpl, ensure: async () => INFO_V2, peek: () => INFO_V2 });
  const { code, lines } = await (async () => {
    const done = collect(child);
    child.stdin.end('Tạo báo cáo');
    return done;
  })();
  assert.equal(code, 0);
  assert.equal(postedBody.client_job_id, 'job-001');
  assert.equal(postedBody.goal_id, 'g1');
  assert.deepEqual(postedBody.depends_on, ['sess-prev']);
  assert.equal(postedBody.max_fix_rounds, 2);
  assert.deepEqual(postedBody.verify, ['npm test']);
  assert.deepEqual(postedBody.deliverables, ['out/report.pdf', { path: 'out/chart.png', min_bytes: 512 }]);

  const job = { texts: [], tools: [] };
  for (const line of lines) LIGHTCODE_ADAPTER.parse(job, line);
  assert.deepEqual(job.result.risk, { level: 'low', auto_merge_ok: true, reasons: ['tests passed'] });
  assert.deepEqual(job.result.goal, { id: 'g1', spent_usd: 1.25, budget_usd: 10 });
  assert.equal(job.result.git.branch, 'aivin/j1');
  assert.equal(job.result.fix_rounds, 2);
  assert.equal(job.result.verdict.deliverables[0].path, 'out/report.pdf');
  assert.equal(job.result.verdict.deliverables[0].ok, true);
});

test('cầu nối v2.3: phục hồi last_result từ GET /sessions/:id khi LightCode khởi động lại giữa chừng', async () => {
  const INFO_V2 = { ...INFO, protocol: 2 };
  const fetchImpl = async (url) => {
    if (url.endsWith('/jobs')) return ndjsonResponse([{ seq: 0, type: 'init', session_id: SID, protocol: 2 }]);
    if (url.includes(`/sessions/${SID}/events`)) return { ok: false, status: 404, json: async () => ({ code: 'turn_lost' }) };
    if (url.endsWith(`/sessions/${SID}`)) {
      return {
        ok: true, status: 200,
        json: async () => ({
          running: false, restarted: true, last_seq: -1, listeners: 0,
          last_result: { status: 'done', summary: 'Đã hoàn tất trước khi restart', risk: 'low', auto_merge_ok: true, cost_usd: 0.5, fix_rounds: 1 },
        }),
      };
    }
    assert.fail(`unexpected url: ${url}`);
  };
  const child = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({ mode: 'accept_edits' }), { cwd: 'D:\\repo' }, { fetchImpl, ensure: async () => INFO_V2, peek: () => INFO_V2, sleep: async () => undefined });
  const done = collect(child);
  child.stdin.end('x');
  const { code, lines } = await done;
  assert.equal(code, 0);
  const res = lines.at(-1);
  assert.equal(res.type, 'result');
  assert.equal(res.ok, true);
  assert.equal(res.restarted, true);
  assert.match(res.answer, /trước khi restart/);
  assert.equal(res.risk.level, 'low');
});

test('cầu nối v2.3: attention, strategy (online + disk fallback), metrics, events/ack, webhook, answer và preview', async () => {
  const repo = tmp('lc-v23-repo-');
  fs.mkdirSync(path.join(repo, '.lcagent'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.lcagent', 'strategy.json'), JSON.stringify({ goals: [{ id: 'g1', title: 'MVP', budget_usd: 20, spent_usd: 3 }], non_goals: ['mobile'], principles: ['keep simple'] }));
  fs.writeFileSync(path.join(repo, '.lcagent', 'lessons.json'), JSON.stringify([{ text: 'Run typecheck first', count: 4 }]));

  // Offline fallback cho strategy
  const stratOff = await lightcodeStrategy({ cwd: repo }, { file: path.join(os.tmpdir(), 'nope-v23.json'), alive: () => false, roots: [repo] });
  assert.equal(stratOff.running, false);
  assert.equal(stratOff.fallback, 'disk');
  assert.equal(stratOff.goals[0].id, 'g1');
  assert.deepEqual(stratOff.proposed_rules, ['Run typecheck first']);

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (url.includes('/connector/v1/attention')) return { ok: true, status: 200, json: async () => ({ items: [{ kind: 'question', session_id: SID }] }) };
    if (url.includes('/connector/v1/strategy') && method === 'GET') return { ok: true, status: 200, json: async () => ({ goals: [{ id: 'g1', spent_usd: 3 }], lessons: [], proposed_rules: [] }) };
    if (url.includes('/connector/v1/strategy') && method === 'PUT') return { ok: true, status: 200, json: async () => ({ goals: body.goals, non_goals: body.non_goals || [], principles: body.principles || [] }) };
    if (url.includes('/connector/v1/metrics')) return { ok: true, status: 200, json: async () => ({ total: 5, passed: 4, total_cost_usd: 2.1 }) };
    if (url.includes('/connector/v1/events/ack')) return { ok: true, status: 200, json: async () => ({ acked: body.seq, last_seq: 12 }) };
    if (url.includes('/connector/v1/events')) {
      return {
        ok: true, status: 200,
        text: async () => [
          JSON.stringify({ seq: 11, type: 'job.finished', session_id: SID }),
          JSON.stringify({ type: 'ping' }),
          JSON.stringify({ seq: 12, type: 'job.attention', session_id: SID }),
          JSON.stringify({ type: 'end', last_seq: 12, acked: 10 }),
        ].join('\n'),
      };
    }
    if (url.includes('/connector/v1/webhook')) return { ok: true, status: 200, json: async () => ({ url: method === 'PUT' ? body.url : 'http://127.0.0.1:9999/hook' }) };
    if (url.includes(`/sessions/${SID}/answer`)) {
      return ndjsonResponse([
        { seq: 0, type: 'init', session_id: SID, protocol: 2 },
        { seq: 1, type: 'result', ok: true, answer: 'Đã làm theo Redis', risk: { level: 'low', auto_merge_ok: true, reasons: [] } },
      ]);
    }
    if (url.endsWith('/connector/v1/previews') && method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'pv_1', session_id: SID, url: 'http://127.0.0.1:5173', running: true }) };
    if (url.includes('/connector/v1/previews') && method === 'GET') return { ok: true, status: 200, json: async () => ({ previews: [{ id: 'pv_1', running: true }] }) };
    if (url.endsWith('/previews/pv_1/capture')) return { ok: true, status: 200, json: async () => ({ ok: true, screenshot_path: 'a.png', console: '', failed_requests: '' }) };
    if (url.endsWith('/previews/pv_1/smoke')) return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ step: 'open /', ok: true }] }) };
    if (url.endsWith('/previews/pv_1') && method === 'DELETE') return { ok: true, status: 200, json: async () => ({ stopped: true }) };
    assert.fail(`unexpected ${method} ${url}`);
  };
  const deps = { connector: INFO, fetchImpl, roots: [repo] };

  const att = await lightcodeAttention({ cwd: repo }, deps);
  assert.equal(att.items.length, 1);

  const stratOn = await lightcodeStrategy({ cwd: repo }, deps);
  assert.equal(stratOn.running, true);
  const stratSet = await lightcodeSetStrategy({ cwd: repo, goals: [{ id: 'g2', title: 'Beta', budget_usd: 15 }] }, deps);
  assert.equal(stratSet.goals[0].id, 'g2');

  const met = await lightcodeMetrics({ cwd: repo, since: '2026-11-20T00:00:00Z' }, deps);
  assert.equal(met.passed, 4);

  const ev = await lightcodeEvents({ from: 11, auto_ack: true }, deps);
  assert.equal(ev.events.length, 2);
  assert.equal(ev.acked, 12);

  const whGet = await lightcodeWebhook({}, deps);
  assert.equal(whGet.url, 'http://127.0.0.1:9999/hook');
  const whPut = await lightcodeWebhook({ url: 'http://127.0.0.1:8888/ev' }, deps);
  assert.equal(whPut.url, 'http://127.0.0.1:8888/ev');

  const ans = await lightcodeAnswer({ session_id: SID, answer: 'Dùng Redis' }, {}, deps);
  assert.equal(ans.result.ok, true);
  assert.equal(ans.result.risk.level, 'low');

  const pvStart = await lightcodePreview({ action: 'start', session_id: SID, command: 'npm run dev' }, {}, deps);
  assert.equal(pvStart.id, 'pv_1');
  const pvList = await lightcodePreview({ action: 'list', session_id: SID }, {}, deps);
  assert.equal(pvList.previews.length, 1);
  const pvCap = await lightcodePreview({ action: 'capture', preview_id: 'pv_1', path: '/login' }, {}, deps);
  assert.equal(pvCap.ok, true);
  const pvSmoke = await lightcodePreview({ action: 'smoke', preview_id: 'pv_1', steps: [{ open: '/', expect_text: 'Home' }] }, {}, deps);
  assert.equal(pvSmoke.ok, true);
  const pvStop = await lightcodePreview({ action: 'stop', preview_id: 'pv_1' }, {}, deps);
  assert.equal(pvStop.stopped, true);
});

test('lightcodeDeployHosts & lightcodeDeploySetup: xem host sẵn có và tạo cấu hình deploy cho dự án mới', async () => {
  const repo = tmp('lc-setup-repo-');
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method, url, body });
    if (url.endsWith('/connector/v1/deploy/hosts')) {
      return { ok: true, status: 200, json: async () => ({ hosts: [{ id: 'host_1', name: 'VPS', host: '1.2.3.4', port: 22, username: 'root' }], ssh_config: [], adapters: [{ id: 'vps-ssh', label: 'Server / VPS', category: 'server' }] }) };
    }
    if (url.endsWith('/connector/v1/deploy/setup')) {
      if (body.auto) return { ok: true, status: 202, json: async () => ({ mode: 'ai_setup', thread_id: 'thr_setup', status: 'running' }) };
      return { ok: true, status: 200, json: async () => ({ mode: 'saved', configured: true, environments: body.environments }) };
    }
    assert.fail(`unexpected ${method} ${url}`);
  };
  const deps = { connector: INFO, fetchImpl, roots: [repo] };

  const hosts = await lightcodeDeployHosts(deps);
  assert.equal(hosts.running, true);
  assert.equal(hosts.hosts[0].id, 'host_1');

  // Lối tắt 1 môi trường
  const s1 = await lightcodeDeploySetup({
    cwd: repo, env_id: 'production', env_name: 'Production', tier: 'live', host_id: 'host_1',
    where: 'VPS Nginx /var/www/site', url: 'https://site.example.com', notes: 'Sync dist/',
  }, {}, deps);
  assert.equal(s1.mode, 'saved');
  assert.equal(s1.configured, true);
  assert.equal(seen[1].body.environments[0].targets[0].host_id, 'host_1');
  assert.equal(seen[1].body.environments[0].url, 'https://site.example.com');

  // Chế độ AI tự quét repo
  const s2 = await lightcodeDeploySetup({ cwd: repo, auto: true }, {}, deps);
  assert.equal(s2.mode, 'ai_setup');
  assert.equal(s2.thread_id, 'thr_setup');
});

test('lightcodeDeploy & lightcodeDeployReply: chuyển tiếp yêu cầu hỗ trợ (needs_input) từ LightCode lên AIVIN và gửi câu trả lời quay lại', async () => {
  const repo = tmp('lc-dep-reply-');
  let replied = false;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/connector/v1/deploy')) {
      return { ok: true, status: 201, json: async () => ({ project_id: 'p1', project_name: 'Site', runs: [{ id: 'd1', env_id: 'production', env_name: 'Production', thread_id: 'thr_d1', mode: 'ai', status: 'running' }] }) };
    }
    if (url.endsWith('/connector/v1/deploy/runs/thr_d1/reply')) {
      replied = true;
      const body = JSON.parse(init.body);
      assert.match(body.message, /\/var\/www\/site/);
      return { ok: true, status: 200, json: async () => ({ thread_id: 'thr_d1', mode: 'message', sent: true, status: 'running', running: true, ok: false, needs_input: false }) };
    }
    if (url.endsWith('/connector/v1/deploy/runs/thr_d1')) {
      if (!replied) {
        return {
          ok: true, status: 200,
          json: async () => ({
            thread_id: 'thr_d1', status: 'needs_input', running: false, ok: false, needs_input: true,
            support_request: { kind: 'message', summary: 'Cần xác nhận thư mục deploy trên VPS' },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ thread_id: 'thr_d1', status: 'done', running: false, ok: true, needs_input: false, report: '✅ Deployed to https://site.example.com' }) };
    }
    assert.fail(`unexpected url: ${url}`);
  };
  const deps = { connector: INFO, fetchImpl, roots: [repo], sleep: async () => undefined };

  const dep = await lightcodeDeploy({ cwd: repo, env: 'production', wait_ms: 1000 }, {}, deps);
  assert.equal(dep.needs_user_support, true);
  assert.equal(dep.runs[0].status, 'needs_input');
  assert.match(dep.runs[0].support_request.summary, /thư mục deploy/);

  const rep = await lightcodeDeployReply({ thread_id: 'thr_d1', message: 'Dùng /var/www/site nhé', wait_ms: 1000 }, {}, deps);
  assert.equal(rep.status, 'done');
  assert.equal(rep.ok, true);
  assert.match(rep.report, /Deployed/);
});

test('startLightcodeEventBridge: nhận sự kiện đẩy (bỏ ping), chuyển cho callback và tự ack', async () => {
  const INFO_V2 = { ...INFO, protocol: 2 };
  const acked = [];
  const got = [];
  let served = false;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/events/ack')) {
      acked.push(JSON.parse(init.body).seq);
      return { ok: true, status: 200, json: async () => ({ acked: acked.at(-1) }) };
    }
    if (url.includes('/events?follow=1')) {
      if (served) return new Promise(() => undefined);
      served = true;
      return ndjsonResponse([
        { type: 'ping' },
        { seq: 7, type: 'job.finished', session_id: SID, data: { ok: true } },
        { seq: 8, type: 'job.attention', session_id: SID, data: { kind: 'question', summary: 'Cần xác nhận' } },
      ]);
    }
    assert.fail(`unexpected url: ${url}`);
  };
  const bridge = startLightcodeEventBridge({
    peek: () => INFO_V2,
    fetchImpl,
    sleep: async () => undefined,
    onEvent: (ev) => got.push(ev),
  });
  for (let i = 0; i < 30 && acked.length < 2; i++) await new Promise((r) => setTimeout(r, 15));
  bridge.stop();
  assert.deepEqual(got.map((e) => e.seq), [7, 8]);
  assert.deepEqual(acked, [7, 8]);
});

// ── Vòng 4 (24/11/2026): runAs của thành viên ───────────────────────────────────────────────────────────────────────────────────────
const MEMBER = { uid: 10001, gid: 10000, home: '/home/u0123456789ab' };
const withOrgJobs = async (value, fn) => {
  const prev = process.env.AIVIN_LIGHTCODE_ORG_JOBS;
  if (value === undefined) delete process.env.AIVIN_LIGHTCODE_ORG_JOBS; else process.env.AIVIN_LIGHTCODE_ORG_JOBS = value;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AIVIN_LIGHTCODE_ORG_JOBS; else process.env.AIVIN_LIGHTCODE_ORG_JOBS = prev; }
};

test('runAs: hợp lệ → vào tham số job (chỉ uid/gid/home); sai dạng → INVALID_ARGS', () => {
  const parsed = JSON.parse(LIGHTCODE_ADAPTER.args({ runAs: { ...MEMBER, name: 'u0123456789ab', extra: 1 } })[1]);
  assert.deepEqual(parsed.runAs, MEMBER, 'không mang name / trường lạ sang LightCode');
  assert.equal(JSON.parse(LIGHTCODE_ADAPTER.args({})[1]).runAs, undefined, 'cờ tắt + không runAs → không có trường');
  const bads = [{ ...MEMBER, uid: 0 }, { ...MEMBER, gid: 0 }, { ...MEMBER, uid: '1001' }, { ...MEMBER, gid: 1.5 }, { ...MEMBER, home: 'home/x' },
    { ...MEMBER, home: '/home/../root' }, { ...MEMBER, home: '/home//x' }, { ...MEMBER, home: '/home/x/' }, { ...MEMBER, home: '/home/a b' }, { uid: 1, gid: 1 }, 'str', []];
  for (const bad of bads) assert.throws(() => LIGHTCODE_ADAPTER.args({ runAs: bad }), (e) => e.code === 'INVALID_ARGS' && /runAs/.test(e.message), JSON.stringify(bad));
  assert.equal(LIGHTCODE_ADAPTER.memberAware, true);
});

test('runAs: tới LightCode dưới dạng run_as {uid,gid,home} trong thân yêu cầu loopback', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return ndjsonResponse([{ type: 'result', ok: true, answer: 'x' }]); };
  const child = spawnLightcodeTurn(LIGHTCODE_ADAPTER.args({ runAs: MEMBER }), {}, { fetchImpl, ensure: async () => INFO });
  const done = collect(child); child.stdin.end('x');
  assert.equal((await done).code, 0);
  assert.deepEqual(bodies[0].run_as, MEMBER);
  assert.equal(bodies[0].runAs, undefined, 'chỉ một tên trường');
});

test('cờ bật (Cloud Computer): thiếu runAs → args() từ chối, spawn() cũng từ chối — không bao giờ chạy dưới tài khoản daemon', async () => {
  await withOrgJobs('1', async () => {
    assert.equal(LIGHTCODE_ADAPTER.multiUser, true);
    for (const missing of [{}, { runAs: null }]) {
      assert.throws(() => LIGHTCODE_ADAPTER.args(missing), (e) => e.code === 'INVALID_ARGS' && /runAs/.test(e.message));
    }
    assert.throws(() => LIGHTCODE_ADAPTER.args({ runAs: { uid: 0, gid: 0, home: '/root' } }), /runAs/);
    const ok = LIGHTCODE_ADAPTER.args({ runAs: MEMBER });
    assert.deepEqual(JSON.parse(ok[1]).runAs, MEMBER);
    // Lưới an toàn: argv dựng tay không có runAs (hoặc JSON hỏng) không chạm tới daemon.
    const noRunAs = ['--lightcode-job', JSON.stringify({ mode: 'plan' })];
    assert.throws(() => LIGHTCODE_ADAPTER.spawn('lightcode', noRunAs, {}), (e) => e.code === 'INVALID_ARGS' && /runAs/.test(e.message));
    assert.throws(() => LIGHTCODE_ADAPTER.spawn('lightcode', ['--lightcode-job', '{hỏng'], {}), /runAs/);
  });
});

test('cờ tắt: LightCode không được quảng bá ở Cloud Computer — runner của thành viên bỏ qua; cờ bật + có connector headless thì mới có', async () => {
  const { createAgentRunner: mk } = await import('../bin/lib/remote/codingAgents.mjs');
  const f = connectorFile(INFO);
  const find = (a) => a.locate({ env: process.env, file: f, platform: 'linux' });
  await withOrgJobs(undefined, () => {
    const runner = mk({ adapters: [LIGHTCODE_ADAPTER], find, runAs: { name: 'an', ...MEMBER }, probeFlags: () => null });
    assert.deepEqual(runner.installed().map((a) => a.id), [], 'tắt → org không thấy LightCode');
  });
  await withOrgJobs('1', () => {
    const runner = mk({ adapters: [LIGHTCODE_ADAPTER], find, runAs: { name: 'an', ...MEMBER }, probeFlags: () => null });
    assert.deepEqual(runner.installed().map((a) => a.id), ['lightcode']);
  });
});
