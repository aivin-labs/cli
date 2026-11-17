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
