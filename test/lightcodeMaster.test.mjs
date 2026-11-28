// Aivin giao việc cho phiên Master của LightCode (26/11/2026): `orchestrate` / `rationale` / `verify` phải tới `POST /connector/v1/jobs`,
// và daemon phải khai `features` của LightCode để Aivin biết máy chạy được kiểu giao này.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { LIGHTCODE_ADAPTER, lightcodeAnnounceState, spawnLightcodeTurn } = await import('../bin/lib/remote/lightcodeAgent.mjs');
const { createAgentRunner, masterOpt } = await import('../bin/lib/remote/codingAgents.mjs');
const { masterBrief, sha256 } = await import('../bin/lib/remote/agentContract.mjs');
const { CONTRACT, TEST_CHECK, report } = await import('./agentFixtures.mjs');

const SID = '7b1f2c3d-1111-4222-8333-944455556666';
const INFO = { app: 'LightCode', app_version: '2.0.0', port: 4555, key: 'k_secret', pid: 1234, protocol: 2 };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const jobOf = (argv) => JSON.parse(argv[argv.indexOf('--job') + 1]);
const waitFor = async (cond) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'timed out waiting'); };

/** Gửi một lượt tới cửa cục bộ giả, trả thân JSON của `POST /jobs`. */
async function postedBody(job, info = INFO) {
  let body;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/connector/v1/jobs')) body = JSON.parse(init.body);
    const line = new TextEncoder().encode(`${JSON.stringify({ seq: 1, type: 'result', ok: true, answer: 'ok' })}\n`);
    return { ok: true, status: 200, body: (async function* gen() { yield line; })() };
  };
  const child = spawnLightcodeTurn(['--job', JSON.stringify(job)], { cwd: os.tmpdir() }, { ensure: async () => info, peek: () => info, fetchImpl, sleep: async () => undefined });
  child.stdout.resume();
  const closed = new Promise((r) => child.on('close', r));
  child.stdin.end('do it');
  await closed;
  return body;
}

test('tham số job: orchestrate + rationale (chỉ 4 trường LightCode nhận); không bật thì không có trường nào', () => {
  const on = jobOf(LIGHTCODE_ADAPTER.args({ mode: 'manual', orchestrate: true, rationale: { insight: 'Đơn hàng lệch ngày', extra: 'bỏ', measure_by: ' 2026-12-01 ' } }));
  assert.equal(on.orchestrate, true);
  assert.deepEqual(on.rationale, { insight: 'Đơn hàng lệch ngày', measure_by: '2026-12-01' });
  for (const off of [undefined, false, 'true', 1]) {
    const job = jobOf(LIGHTCODE_ADAPTER.args({ mode: 'manual', orchestrate: off, rationale: { insight: 'x' } }));
    assert.equal('orchestrate' in job, false, `giá trị ${off}`);
    assert.equal('rationale' in job, false);
  }
});

test('POST /connector/v1/jobs mang orchestrate / rationale / verify; LightCode giao thức 1 thì không gửi', async () => {
  const job = { mode: 'manual', orchestrate: true, rationale: { insight: 'x' }, verify: ['npm test'] };
  const body = await postedBody(job);
  assert.equal(body.orchestrate, true);
  assert.deepEqual(body.rationale, { insight: 'x' });
  assert.deepEqual(body.verify, ['npm test']);
  const plain = await postedBody({ mode: 'manual' });
  assert.equal('orchestrate' in plain, false);
  assert.equal('rationale' in plain, false);
  const old = await postedBody(job, { ...INFO, protocol: 1 });
  assert.equal('orchestrate' in old, false);
});

test('masterBrief: lệnh kiểm chứng thành dòng lệnh; lý do lấy từ "## Vì sao", chữ thay chỗ thì bỏ', () => {
  const contract = { verify: [{ id: 'unit', argv: ['npm', 'test'] }, { id: 'e2e', argv: ['C:/Program Files/node.exe', 'run e2e'] }] };
  const body = '# Việc\n\n## Mục tiêu\nA\n\n## Vì sao\nKhách bị tính sai ngày.\nẢnh hưởng doanh thu.\n\n## Tiêu chí đánh giá\n- a: b\n';
  assert.deepEqual(masterBrief(body, contract), {
    verify: ['npm test', '"C:/Program Files/node.exe" "run e2e"'],
    rationale: { insight: 'Khách bị tính sai ngày.\nẢnh hưởng doanh thu.' },
  });
  assert.deepEqual(masterBrief('# Việc\n\n## Vì sao\n(chưa ghi)\n', { verify: [] }), { verify: [] });
  assert.deepEqual(masterBrief('', undefined), { verify: [] });
});

test('masterOpt: chỉ agent lightcode và đúng orchestrate === true; rationale truyền thẳng được ưu tiên', () => {
  const lc = { id: 'lightcode' };
  const brief = { verify: ['npm test'], rationale: { insight: 'từ hợp đồng' } };
  assert.deepEqual(masterOpt({ orchestrate: true }, lc, brief), { orchestrate: true, verify: ['npm test'], rationale: { insight: 'từ hợp đồng' } });
  assert.deepEqual(masterOpt({ orchestrate: true, rationale: { insight: 'PO' } }, lc, brief).rationale, { insight: 'PO' });
  assert.deepEqual(masterOpt({ orchestrate: true }, lc), { orchestrate: true });
  assert.deepEqual(masterOpt({ orchestrate: true }, { id: 'claude' }, brief), {});
  assert.deepEqual(masterOpt({ orchestrate: 'true' }, lc, brief), {});
  assert.deepEqual(masterOpt({}, lc, brief), {});
});

/** LightCode giả: ghi lại argv, cho test tự đẩy sự kiện rồi đóng. */
function fakeLightcode() {
  const calls = [];
  const spawn = (bin, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    calls.push({
      argv,
      finish: (events) => {
        for (const e of events) child.stdout.write(`${JSON.stringify(e)}\n`);
        child.stdout.end();
        setImmediate(() => child.emit('close', 0));
      },
    });
    return child;
  };
  const runner = createAgentRunner({ adapters: [{ ...LIGHTCODE_ADAPTER, spawn }], find: () => ({ bin: 'lightcode', version: '2.0.0', flags: ['--job'] }), jobsDir: tmp('lc-master-jobs-') });
  return { calls, runner };
}

test('agent.run thường: orchestrate tới LightCode; agent.status trả thread_id phiên Master', async () => {
  const cwd = tmp('lc-master-cwd-');
  const { calls, runner } = fakeLightcode();
  const pending = runner.run({ prompt: 'làm đi', cwd, agent: 'lightcode', orchestrate: true, rationale: { insight: 'x' }, wait_ms: 20_000 }, {}, { roots: [cwd] });
  await waitFor(() => calls.length === 1);
  assert.equal(jobOf(calls[0].argv).orchestrate, true);
  assert.deepEqual(jobOf(calls[0].argv).rationale, { insight: 'x' });
  calls[0].finish([
    { seq: 1, type: 'init', session_id: SID, thread_id: 'thr_master', project_id: 'prj_1', app_version: '2.0.0', protocol: 2 },
    { seq: 2, type: 'result', ok: true, answer: 'xong' },
  ]);
  const res = await pending;
  assert.equal(res.status, 'done', res.error);
  assert.equal(res.lightcode.thread_id, 'thr_master');
});

test('job có hợp đồng + orchestrate: gửi verify + lý do; lượt nhắc viết lại REPORT.md không bật lại phiên Master', async () => {
  const repo = tmp('lc-master-repo-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'order.js'), 'export const day = (d) => d;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'junit.xml\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const contract = CONTRACT.replace('argv: [npm, test]', `argv: ['${process.execPath.replace(/'/g, "''")}', -e, '0']`);
  const { calls, runner } = fakeLightcode();
  const pending = runner.run({ cwd: repo, agent: 'lightcode', contract, contract_sha256: sha256(contract), test_check: TEST_CHECK, orchestrate: true, wait_ms: 30_000 }, {}, { roots: [repo] });
  await waitFor(() => calls.length === 1);
  const first = jobOf(calls[0].argv);
  assert.equal(first.orchestrate, true);
  assert.equal(first.verify.length, 1);
  assert.match(first.verify[0], /-e 0$/);

  // Không ghi REPORT.md → daemon nhắc viết lại một lần trong cùng phiên.
  calls[0].finish([
    { seq: 1, type: 'init', session_id: SID, thread_id: 'thr_master', project_id: 'prj_1', protocol: 2 },
    { seq: 2, type: 'result', ok: true, answer: 'xong' },
  ]);
  await waitFor(() => calls.length === 2);
  const repair = jobOf(calls[1].argv);
  assert.equal(repair.resume, SID);
  for (const key of ['orchestrate', 'rationale', 'verify', 'acceptance', 'constraints']) assert.equal(key in repair, false, key);
  fs.writeFileSync(path.join(first.addDirs[0], 'REPORT.md'), report({ status: 'done', left: '' }));
  calls[1].finish([{ seq: 3, type: 'result', ok: true, answer: 'đã ghi' }]);
  const res = await pending;
  assert.equal(res.status, 'done', res.error);
  assert.equal(res.report_repaired, true);
});

test('lightcodeAnnounceState: khai features của LightCode đang chạy; tắt / bản cũ → không có features', async () => {
  const file = path.join(tmp('lc-conn-'), 'connector.json');
  fs.writeFileSync(file, JSON.stringify(INFO));
  const ask = (body, extra = {}) => lightcodeAnnounceState({
    file, alive: () => true, platform: 'win32', env: {}, exists: () => false,
    fetchImpl: async () => ({ ok: true, json: async () => ({ protocol: 2, min_client_protocol: 1, can_run: true, accounts: 1, ...body }) }), ...extra,
  });
  assert.deepEqual(await ask({ features: ['masters', 'master_orchestrate', 7, ''] }), { issue: null, features: ['masters', 'master_orchestrate'] });
  assert.deepEqual(await ask({ features: ['complete_tier', 'complete_images'], complete: { enabled: true, tiers: ['hard'], images: true } }), {
    issue: null,
    features: ['complete_tier', 'complete_images'],
    complete: { enabled: true, tiers: ['hard'], images: true },
  });
  assert.deepEqual(await ask({ features: ['masters'], accounts: 0 }), { issue: 'no_account', features: ['masters'] });
  assert.deepEqual(await ask({}), { issue: null });
  assert.deepEqual(await ask({ features: ['masters'] }, { alive: () => false }), { issue: null });
});
