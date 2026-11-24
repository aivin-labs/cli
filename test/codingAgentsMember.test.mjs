import test from 'node:test';
import assert from 'node:assert/strict';
import { memberSpawner, createAgentRunner } from '../bin/lib/remote/codingAgents.mjs';

const account = { name: 'an', uid: 1001, gid: 1001, home: '/home/an' };

test('máy tổ chức: tiến trình con của job chạy dưới tài khoản thành viên — uid/gid, HOME/USER của họ, không mang khoá / thư mục cấu hình của root', () => {
  const calls = [];
  const spawn = memberSpawner(account, (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return {}; });
  spawn('git', ['status'], { cwd: '/home/an/sen', env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/root/.claude', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'k', LANG: 'C.UTF-8' } });
  const { opts } = calls[0];
  assert.equal(opts.uid, 1001);
  assert.equal(opts.gid, 1001);
  assert.equal(opts.cwd, '/home/an/sen');
  assert.equal(opts.env.HOME, '/home/an');
  assert.equal(opts.env.USER, 'an');
  for (const k of ['CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(opts.env[k], undefined, k);
  assert.ok(opts.env.PATH.startsWith('/home/an/.local/bin:'));
  // Linux có prlimit → bọc trần tiến trình; nơi khác giữ nguyên lệnh.
  if (process.platform !== 'linux') assert.deepEqual([calls[0].cmd, calls[0].argv], ['git', ['status']]);
});

test('máy tổ chức: không dùng hồ sơ tài khoản agent của máy — mỗi thành viên đăng nhập bằng tài khoản của chính họ', async () => {
  const runner = createAgentRunner({ runAs: account, find: () => ({ bin: 'claude', version: '2.1.312' }), spawnImpl: () => { throw new Error('không được spawn'); }, probeFlags: () => null });
  await assert.rejects(() => runner.run({ prompt: 'đọc dự án', account: 'work' }, {}, { roots: ['/home/an'] }), /account profiles are not used on an organisation computer/);
});

// ── Vòng 4 (24/11/2026): adapter tự chạy dưới tài khoản thành viên (LightCode run_as) ─────────────────────────────────────────────────
test('máy tổ chức: adapter memberAware tự dựng tiến trình và nhận {uid,gid,home} của thành viên (không có name); adapter thường vẫn qua memberSpawner', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const { PassThrough } = await import('stream');
  const { EventEmitter } = await import('events');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'member-root-')));
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-jobs-'));
  const fakeChild = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = { end() {} };
    child.kill = () => child.emit('close', null);
    setImmediate(() => { child.stdout.write(`${JSON.stringify({ done: 'ok' })}\n`); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
  const adapterSpawn = [];
  const base = {
    candidates: () => [], parse(job, msg) { if (msg.done) job.result = { ok: true, answer: msg.done }; return ''; },
  };
  const own = { ...base, id: 'own', label: 'Own', memberAware: true, args: (o) => ['--job', JSON.stringify(o.runAs ?? null)], spawn: (bin, argv, opts) => { adapterSpawn.push({ bin, argv, opts }); return fakeChild(); } };
  const plain = { ...base, id: 'plain', label: 'Plain', args: (o) => ['--runas', String(o.runAs)], spawn: () => { throw new Error('adapter thường không được dùng spawn riêng khi có runAs'); } };
  const memberCalls = [];
  const spawnImpl = (cmd, argv, opts) => { memberCalls.push({ cmd, argv, opts }); return fakeChild(); };
  const member = { name: 'u0123456789ab', uid: 10001, gid: 10000, home: '/home/u0123456789ab' };
  const runner = createAgentRunner({ adapters: [own, plain], find: (a) => ({ bin: a.id, version: '1.0.0' }), spawnImpl, jobsDir, runAs: member, probeFlags: () => null });

  const r1 = await runner.run({ prompt: 'x', agent: 'own', cwd: root, wait_ms: 5000 }, {}, { roots: [root] });
  assert.equal(r1.status, 'done');
  assert.equal(adapterSpawn.length, 1);
  assert.deepEqual(JSON.parse(adapterSpawn[0].argv[1]), { uid: 10001, gid: 10000, home: '/home/u0123456789ab' }, 'LightCode nhận đúng tài khoản, không có name');
  assert.equal(memberCalls.length, 0, 'adapter memberAware không bị bọc bằng memberSpawner');

  const r2 = await runner.run({ prompt: 'y', agent: 'plain', cwd: root, wait_ms: 5000 }, {}, { roots: [root] });
  assert.equal(r2.status, 'done');
  assert.equal(memberCalls.length, 1, 'adapter thường chạy qua memberSpawner');
  assert.equal(memberCalls[0].opts.uid, 10001);
  assert.deepEqual(memberCalls[0].argv, ['--runas', 'undefined'], 'adapter không memberAware không nhận runAs');
});
