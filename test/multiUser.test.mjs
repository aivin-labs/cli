import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Thư mục cấu hình riêng cho test — phải đặt TRƯỚC khi nạp mô-đun (hằng số tính lúc import).
process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-multi-'));
const { isValidUserScope, isMultiUserMode, scopedMemory, accountEnv, withProcessCap, memberMaxProcs, createDiskQuota } = await import('../bin/lib/remote/multiUser.mjs');
const { createMemberFsPool, runsInMemberWorker } = await import('../bin/lib/remote/memberFsPool.mjs');
const { scrubEnv } = await import('../bin/lib/remote/sandbox.mjs');
const { credentialsFromEnv } = await import('../bin/lib/remote/credentials.mjs');
const { buildTools } = await import('../bin/lib/remote/toolHandlers.mjs');

test('vùng người dùng: đúng dạng u + 12 hex mới nhận', () => {
  assert.equal(isValidUserScope('u0123456789ab'), true);
  assert.equal(isValidUserScope('u0123456789aB'), false);
  assert.equal(isValidUserScope('../etc'), false);
  assert.equal(isValidUserScope(undefined), false);
});

test('bật chế độ nhiều người dùng bằng cờ hoặc env', () => {
  assert.equal(isMultiUserMode({ multiUser: true }, {}), true);
  assert.equal(isMultiUserMode({}, { AIVIN_MULTI_USER: '1' }), true);
  assert.equal(isMultiUserMode({}, {}), false);
});

test('token máy tính tổ chức đọc từ env, thiếu biến thì không có', () => {
  const env = { AIVIN_DEVICE_TOKEN: 'acme-dk-x', AIVIN_DEVICE_ID: 'orgpc-1', AIVIN_SERVER: 'http://host.docker.internal:3001/', AIVIN_DEVICE_NAME: 'Org PC' };
  assert.deepEqual(credentialsFromEnv(env), { device_token: 'acme-dk-x', device_id: 'orgpc-1', name: 'Org PC', server_url: 'http://host.docker.internal:3001' });
  assert.equal(credentialsFromEnv({ ...env, AIVIN_DEVICE_TOKEN: '' }), null);
});

test('bộ nhớ theo vùng: thành viên không thấy mục của người khác', () => {
  const a = scopedMemory('uaaaaaaaaaaaa');
  const b = scopedMemory('ubbbbbbbbbbbb');
  a.put([{ kind: 'fact', key: 'printer', text: 'Máy in phòng kế toán tên HP-401' }]);
  b.put([{ kind: 'fact', key: 'printer', text: 'Máy in tầng 3 tên Canon-2' }]);
  const hitsA = a.search({ query: 'máy in', limit: 5 });
  assert.equal(hitsA.length, 1);
  assert.equal(hitsA[0].key, 'printer');
  assert.match(hitsA[0].text, /HP-401/);
  assert.match(b.get({ kind: 'fact', key: 'printer' }).text, /Canon-2/);
  const idOfB = b.list({}).items[0].id;
  assert.equal(a.get({ id: idOfB }), null, 'đọc theo id của người khác bị chặn');
  a.delete({ ids: [idOfB] });
  assert.equal(b.list({}).total, 1, 'xoá theo id của người khác không có tác dụng');
  assert.equal(a.list({}).total, 1);
});

test('lệnh của thành viên mang HOME / USER của tài khoản đó', () => {
  const env = accountEnv({ home: '/home/uaaaaaaaaaaaa', name: 'uaaaaaaaaaaaa' }, { PATH: '/usr/bin' });
  assert.equal(env.HOME, '/home/uaaaaaaaaaaaa');
  assert.equal(env.USER, 'uaaaaaaaaaaaa');
  assert.equal(env.PATH, '/home/uaaaaaaaaaaaa/.local/bin:/usr/bin');
});

test('trần số tiến trình mỗi thành viên: bọc prlimit trên Linux, nơi khác giữ nguyên lệnh', () => {
  const linux = { platform: 'linux', exists: () => true, limit: 128, hard: Infinity };
  assert.deepEqual(withProcessCap('/bin/bash', ['-c', 'ls'], linux), ['/usr/bin/prlimit', ['--nproc=128:128', '--', '/bin/bash', '-c', 'ls']]);
  // Không đặt cao hơn trần cứng đang có (người thường không nâng được trần cứng → prlimit sẽ lỗi).
  assert.deepEqual(withProcessCap('git', ['status'], { ...linux, hard: 64 })[1].slice(0, 1), ['--nproc=64:64']);
  assert.deepEqual(withProcessCap('git', ['status'], { ...linux, exists: () => false }), ['git', ['status']]);
  assert.deepEqual(withProcessCap('git', ['status'], { ...linux, platform: 'win32' }), ['git', ['status']]);
  assert.equal(memberMaxProcs({ AIVIN_MEMBER_MAX_PROCS: '32' }), 32);
  assert.equal(memberMaxProcs({ AIVIN_MEMBER_MAX_PROCS: 'abc' }), 128);
});

test('hạn mức đĩa: đầy thì chặn ghi / chạy lệnh, vẫn cho đọc / xoá; không có hạn mức thì không chặn', async () => {
  let used = 5 * 1024 ** 3;
  const quota = createDiskQuota({ dirs: ['/x'], quotaGb: 10, measure: async () => used });
  await quota.refresh();
  assert.doesNotThrow(() => quota.assertAllowed('fs.write'));
  used = 10 * 1024 ** 3;
  await quota.refresh();
  for (const tool of ['fs.write', 'fs.edit', 'fs.move', 'shell.exec']) {
    assert.throws(() => quota.assertAllowed(tool), (e) => e.code === 'QUOTA_EXCEEDED', tool);
  }
  for (const tool of ['fs.read', 'fs.list', 'fs.delete', 'memory.search']) assert.doesNotThrow(() => quota.assertAllowed(tool), tool);
  // Đo lỗi → giữ số cũ; không cấu hình hạn mức → không bao giờ chặn.
  const flaky = createDiskQuota({ quotaGb: 1, measure: async () => { throw new Error('du failed'); } });
  await flaky.refresh();
  assert.doesNotThrow(() => flaky.assertAllowed('fs.write'));
  const none = createDiskQuota({ quotaGb: NaN, measure: async () => 1e15 });
  await none.refresh();
  assert.doesNotThrow(() => none.assertAllowed('fs.write'));
});

test('đo dung lượng bằng du (Linux)', { skip: process.platform !== 'linux' }, async () => {
  const { measureDiskUsage } = await import('../bin/lib/remote/multiUser.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-du-'));
  fs.writeFileSync(path.join(dir, 'f'), Buffer.alloc(200 * 1024));
  assert.ok(await measureDiskUsage([dir]) >= 200 * 1024);
});

const testPool = (opts = {}) => createMemberFsPool({
  envOf: () => ({ ...scrubEnv(), AIVIN_REMOTE_HOME: process.env.AIVIN_REMOTE_HOME }),
  rootsOf: (account) => [account.home],
  ...opts,
});

test('công cụ tệp nhiều người dùng chạy trong tiến trình con riêng của vùng, dùng lại giữa các lời gọi', async () => {
  assert.equal(runsInMemberWorker('fs.write'), true);
  assert.equal(runsInMemberWorker('memory.search'), false);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-member-'));
  const pool = testPool();
  const account = { name: 'ueeeeeeeeeeee', home };
  try {
    await pool.call(account, 'fs.write', { path: 'docs/a.txt', content: 'xin chào' }, {});
    const pid = pool.pidOf(account.name);
    assert.ok(pid && pid !== process.pid, 'chạy ở tiến trình khác daemon');
    const read = await pool.call(account, 'fs.read', { path: 'docs/a.txt' }, {});
    assert.equal(read.content, 'xin chào');
    assert.equal(pool.pidOf(account.name), pid, 'dùng lại tiến trình của vùng');
    await assert.rejects(pool.call(account, 'fs.read', { path: '../outside.txt' }, {}), (e) => e.code === 'ROOT_DENIED');
    await assert.rejects(pool.call(account, 'shell.exec', { command: 'echo hi' }, {}), (e) => e.code === 'TOOL_UNKNOWN');
    // Tiến trình con chết → lời gọi sau dựng lại.
    process.kill(pid);
    await new Promise((r) => setTimeout(r, 300));
    const again = await pool.call(account, 'fs.info', { path: 'docs/a.txt' }, {});
    assert.equal(again.exists, true);
    assert.notEqual(pool.pidOf(account.name), pid);
  } finally {
    pool.closeAll();
  }
});

test('tiến trình tệp của vùng: huỷ lời gọi, tự tắt khi rảnh', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-member-'));
  fs.mkdirSync(path.join(home, 'many'));
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(home, 'many', `f${i}.txt`), 'nothing here\n'.repeat(200));
  const pool = testPool({ idleMs: 200 });
  const account = { name: 'uffffffffffff', home };
  try {
    const controller = new AbortController();
    const pending = pool.call(account, 'fs.grep', { query: 'never-matches' }, { signal: controller.signal });
    controller.abort(Object.assign(new Error('Cancelled by server'), { code: 'CANCELLED' }));
    await assert.rejects(pending, (e) => e.code === 'CANCELLED');
    await pool.call(account, 'fs.list', {}, {});
    assert.equal(pool.size(), 1);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(pool.size(), 0, 'rảnh quá idleMs thì tắt');
  } finally {
    pool.closeAll();
  }
});

test('tiến trình tệp chạy bằng uid của thành viên (Linux, cần root)', { skip: process.platform === 'win32' || process.getuid?.() !== 0 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-member-'));
  const uid = 10999;
  fs.chownSync(home, uid, uid);
  fs.chmodSync(home, 0o700);
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-root-only-'));
  fs.chmodSync(secret, 0o700);
  fs.writeFileSync(path.join(secret, 'token'), 'root-secret');
  // Thành viên tráo một thư mục trong nhà mình thành symlink trỏ vào chỗ của root — tệp đọc / ghi bằng uid của họ nên nhân chặn.
  fs.symlinkSync(secret, path.join(home, 'swap'));
  const pool = createMemberFsPool({ envOf: () => ({ PATH: process.env.PATH, HOME: home, AIVIN_REMOTE_HOME: process.env.AIVIN_REMOTE_HOME }), rootsOf: () => [home, os.tmpdir()] });
  const account = { name: 'u999999999999', home, uid, gid: uid };
  try {
    const written = await pool.call(account, 'fs.write', { path: 'mine.txt', content: 'x' }, {});
    assert.equal(written.created, true);
    assert.equal(fs.statSync(path.join(home, 'mine.txt')).uid, uid, 'tệp mới thuộc về thành viên, không cần chown');
    await assert.rejects(pool.call(account, 'fs.read', { path: path.join(secret, 'token') }, {}), /EACCES|permission|not found/i);
    await assert.rejects(pool.call(account, 'fs.write', { path: path.join(secret, 'evil'), content: 'x' }, {}), /EACCES|permission/i);
    assert.equal(fs.existsSync(path.join(secret, 'evil')), false);
  } finally {
    pool.closeAll();
  }
});

test('không có chỉ mục tệp thì không đưa fs.find cho Planner', () => {
  const names = (env) => buildTools(env).map((t) => t.name);
  assert.equal(names({ roots: [os.tmpdir()], binaries: [], fileIndex: null }).includes('fs.find'), false);
  assert.equal(names({ roots: [os.tmpdir()], binaries: [], fileIndex: { search: () => [] } }).includes('fs.find'), true);
});

test('công cụ bộ nhớ dùng bộ nhớ của vùng trong env lời gọi', async () => {
  const env = { roots: [os.tmpdir()], binaries: [], fileIndex: null, memory: scopedMemory('ucccccccccccc') };
  const tools = Object.fromEntries(buildTools(env).map((t) => [t.name, t]));
  await tools['memory.put'].handler({ items: [{ kind: 'rule', key: 'tone', text: 'Luôn viết email ngắn gọn' }] }, {}, env);
  const found = await tools['memory.search'].handler({ query: 'email' }, {}, env);
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].key, 'tone');
  const other = await tools['memory.search'].handler({ query: 'email' }, {}, { ...env, memory: scopedMemory('udddddddddddd') });
  assert.equal(other.items.length, 0);
});
