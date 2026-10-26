import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Thư mục cấu hình riêng cho test — phải đặt TRƯỚC khi nạp mô-đun (hằng số tính lúc import).
process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const remote = await import('../bin/lib/remoteControl.mjs');
const { tokenize, createTextIndex, int8Cosine, decodeInt8 } = await import('../bin/lib/remote/textIndex.mjs');
const { ToolGroup } = await import('../bin/lib/remote/constants.mjs');

const sandboxDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-root-'));
const q8 = (vec) => {
  const norm = Math.hypot(...vec) || 1;
  return Buffer.from(Int8Array.from(vec.map((v) => Math.round((v / norm) * 127))).buffer).toString('base64');
};

test('resolveInRoots chặn đi ra ngoài gốc, kể cả qua symlink/junction', () => {
  const root = sandboxDir();
  const outside = sandboxDir();
  assert.equal(remote.resolveInRoots([root], 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.throws(() => remote.resolveInRoots([root], '../x'), /outside/);
  assert.throws(() => remote.resolveInRoots([root], outside), /outside/);
  const link = path.join(root, 'escape');
  try { fs.symlinkSync(outside, link, 'junction'); } catch { return; } // hệ thống không cho tạo liên kết → bỏ phần này
  assert.throws(() => remote.resolveInRoots([root], 'escape/secret.txt'), /outside/);
});

test('scrubEnv bỏ biến bí mật, giữ PATH', () => {
  const env = remote.scrubEnv({ PATH: '/bin', API_KEY: 'x', GITHUB_TOKEN: 't', DB_PASSWORD: 'p', AIVIN_BASE_URL: 'u', HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('lưới an toàn chỉ chặn lệnh thảm hoạ', () => {
  assert.throws(() => remote.assertCommandAllowed('rm -rf /'), /safety floor/);
  assert.throws(() => remote.assertCommandAllowed('format c:'), /safety floor/);
  assert.doesNotThrow(() => remote.assertCommandAllowed('rm -rf ./dist && npm test'));
});

test('thư mục cấu hình Aivin không bao giờ truy cập từ xa — kể cả khi gốc được phép bao trọn nó', async () => {
  const { isProtectedPath, resolveInRoots, assertCommandAllowed } = await import('../bin/lib/remote/sandbox.mjs');
  const home = process.env.AIVIN_REMOTE_HOME;
  const parent = path.dirname(home);
  assert.throws(() => resolveInRoots([parent], path.join(home, 'device-credentials.json')), /credentials/);
  assert.throws(() => resolveInRoots([home], ''), /credentials/);
  assert.ok(isProtectedPath(path.join(os.homedir(), '.aivin', 'credentials')));
  assert.ok(!isProtectedPath(path.join(parent, 'my.aivin-project')));
  for (const cmd of [
    'type %USERPROFILE%\\.aivin\\credentials', 'cat ~/.aivin/device-credentials.json', 'Get-ChildItem $HOME/.aivin',
    'cd .aivin', `type "${home}\\device-id.json"`,
  ]) assert.throws(() => assertCommandAllowed(cmd), /credentials folder/, cmd);
  assert.doesNotThrow(() => assertCommandAllowed('npm run build && cat my.aivin-notes.txt'));
});

test('khoá một tiến trình nhận việc: cửa sổ thứ hai bị từ chối, ghép lại bằng mã thì lấy được, khoá cũ chết thì lấy lại', async () => {
  const { acquireDaemonLock, lockHolder } = await import('../bin/lib/remote/daemonLock.mjs');
  const lockFile = path.join(sandboxDir(), 'remote-daemon.lock');
  // Tiến trình cha (đang sống, khác tiến trình này) giữ khoá.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
  assert.equal(lockHolder(lockFile), process.ppid);
  assert.throws(() => acquireDaemonLock({ lockFile }), new RegExp(`PID ${process.ppid}`));
  const release = acquireDaemonLock({ lockFile, takeOver: true });
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lockFile), false);
  // Khoá của tiến trình đã chết → lấy lại; nhả khoá không xoá khoá đã sang tay tiến trình khác.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646 }));
  const release2 = acquireDaemonLock({ lockFile });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
  release2();
  assert.equal(fs.existsSync(lockFile), true);
});

test('daemon cũ chỉ xoá token của chính nó — không xoá token mới vừa ghép bởi cửa sổ khác', async () => {
  const { saveDeviceCredentials, loadDeviceCredentials, clearDeviceCredentials } = await import('../bin/lib/remote/credentials.mjs');
  saveDeviceCredentials({ server_url: 'http://x', device_id: 'dev-test-1', device_token: 'wes-dk-new', roots: [] });
  assert.equal(clearDeviceCredentials('wes-dk-old'), false);
  assert.equal(loadDeviceCredentials()?.device_token, 'wes-dk-new');
  assert.equal(clearDeviceCredentials('wes-dk-new'), true);
  assert.equal(loadDeviceCredentials(), null);
});

test('chọn máy chủ: --server > mã kết nối (mặc định) > máy đã ghép > đăng nhập CLI > mặc định', () => {
  const saved = { server_url: 'https://saved.example' };
  const env = { AIVIN_BASE_URL: 'https://login.example', API_KEY: 'k' };
  assert.equal(remote.resolveServerUrl({ server: 'https://x.example/', code: 'A' }, saved, env), 'https://x.example');
  assert.equal(remote.resolveServerUrl({ code: 'ABCD-EFGH' }, saved, env), 'https://api.aivin.cloud');
  // Máy ghép bằng mã với máy chủ A, CLI đang đăng nhập máy chủ B → vẫn nối A, không lặng lẽ ghép lại sang B.
  assert.equal(remote.resolveServerUrl({}, saved, env), 'https://saved.example');
  assert.equal(remote.resolveServerUrl({ repair: true }, saved, env), 'https://login.example');
  assert.equal(remote.resolveServerUrl({}, null, env), 'https://login.example');
  assert.equal(remote.resolveServerUrl({}, null, {}), 'https://api.aivin.cloud');
});

test('tách từ đa ngôn ngữ: bỏ dấu, camelCase, chữ Hán thành cặp', () => {
  assert.deepEqual(tokenize('Đăng nhập userLogin'), ['dang', 'nhap', 'user', 'login']);
  assert.ok(tokenize('東京都庁').includes('東京'));
  const idx = createTextIndex();
  idx.add('a', 'cấu hình máy chủ authentication service');
  idx.add('b', 'hướng dẫn nấu ăn');
  assert.equal(idx.search('cau hinh')[0].id, 'a');
  assert.equal(idx.search('authent')[0].id, 'a'); // khớp tiền tố
  idx.remove('a');
  assert.equal(idx.search('cau hinh').length, 0);
});

test('cosine int8 xấp xỉ đúng', () => {
  assert.ok(int8Cosine(decodeInt8(q8([1, 2, 3])), decodeInt8(q8([1, 2, 3.1]))) > 0.98);
  assert.ok(int8Cosine(decodeInt8(q8([1, 0, 0])), decodeInt8(q8([0, 1, 0]))) < 0.05);
});

test('bộ nhớ trên máy: YAML + vector, tìm kết hợp, phân trang, quên', () => {
  remote.clearDeviceMemory();
  remote.putMemoryItems([
    { kind: 'project', key: 'be', text: 'Backend NestJS ở H:/Project/be, chạy test bằng yarn test:batches', vector: q8([1, 0, 0]) },
    { kind: 'fact', key: 'shell', text: 'Máy dùng PowerShell 5.1', vector: q8([0, 1, 0]) },
    { kind: 'procedure', key: 'build-be', text: 'build backend', data: { steps: [{ id: 'p1', tool: 'shell.exec', args: { command: 'yarn build' } }] }, vector: q8([0.9, 0.1, 0]) },
  ]);
  const file = path.join(remote.DEVICE_MEMORY_DIR, 'project.yaml');
  assert.ok(fs.readFileSync(file, 'utf8').includes('NestJS')); // người dùng đọc được
  const byWords = remote.searchMemory({ query: 'chay test', limit: 5 });
  assert.equal(byWords[0].key, 'be');
  const byVector = remote.searchMemory({ vector: q8([1, 0.05, 0]), kinds: ['procedure'], limit: 1 });
  assert.equal(byVector[0].key, 'build-be');
  assert.ok(byVector[0].score > 0.9);
  const page = remote.listMemoryItems({ limit: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.next_cursor, 2);
  assert.equal(remote.deleteMemoryItems({ kind: 'fact', key: 'shell' }).deleted, 1);
  assert.equal(remote.memoryStats().total, 2);
});

test('scheduler: giới hạn song song theo nhóm, khoá theo đường dẫn, huỷ, hết giờ', async () => {
  const sched = remote.createScheduler();
  let active = 0;
  let peak = 0;
  const slow = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return 1; };
  await Promise.all(Array.from({ length: 8 }, (_, i) => sched.run({ call_id: `e${i}`, timeout_ms: 5000 }, { group: ToolGroup.EXEC }, slow)));
  assert.equal(peak, 3); // nhóm exec mặc định 3

  const order = [];
  const write = (tag) => async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, 20)); order.push(`${tag}-`); };
  await Promise.all([
    sched.run({ call_id: 'w1', timeout_ms: 5000 }, { group: ToolGroup.FS_WRITE, lockKeys: () => ['/f'] }, write('a')),
    sched.run({ call_id: 'w2', timeout_ms: 5000 }, { group: ToolGroup.FS_WRITE, lockKeys: () => ['/f'] }, write('b')),
  ]);
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-']);

  const waitAbort = (_a, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
  const pending = sched.run({ call_id: 'c1', timeout_ms: 5000 }, { group: ToolGroup.SYSTEM }, waitAbort);
  setTimeout(() => sched.cancel(['c1']), 20);
  assert.equal((await pending).error_code, 'CANCELLED');
  const timed = await sched.run({ call_id: 't1', timeout_ms: 1000 }, { group: ToolGroup.SYSTEM }, waitAbort);
  assert.equal(timed.error_code, 'CALL_TIMEOUT');
});

test('công cụ: đọc theo dòng, sửa, ghi ngoài gốc bị chặn, chạy lệnh, tìm trong chỉ mục', async () => {
  const root = sandboxDir();
  fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'AuthService.ts'), 'export class AuthService { login() {} }');
  const fileIndex = remote.createFileIndex([root]);
  await fileIndex.build();
  const env = { roots: [root], binaries: [], projects: [], fileIndex };
  const tools = new Map(remote.buildTools(env).map((t) => [t.name, t]));
  const ctx = { signal: new AbortController().signal };

  const read = await tools.get('fs.read').handler({ path: 'big.txt', startLine: 2000, endLine: 2002 }, ctx, env);
  assert.equal(read.content, 'line 2000\nline 2001\nline 2002');

  await tools.get('fs.write').handler({ path: 'notes/a.md', content: 'hello world' }, ctx, env);
  await tools.get('fs.edit').handler({ path: 'notes/a.md', oldText: 'world', newText: 'aivin' }, ctx, env);
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'a.md'), 'utf8'), 'hello aivin');
  await assert.rejects(tools.get('fs.write').handler({ path: '../escape.txt', content: 'x' }, ctx, env), /outside/);

  const exec = await tools.get('shell.exec').handler({ command: 'echo device-ok' }, ctx, env);
  assert.equal(exec.exitCode, 0);
  assert.match(exec.stdout, /device-ok/);

  const found = tools.get('fs.find').handler({ query: 'auth service login' }, ctx, env);
  assert.ok(found.results[0].path.includes('AuthService.ts'));
  fileIndex.close();
});

test('danh mục: bỏ công cụ nội bộ, dấu vân tay ổn định, gói git theo máy', () => {
  const env = { roots: [sandboxDir()], binaries: [], projects: [] };
  const a = remote.buildCatalog(remote.buildTools(env));
  const b = remote.buildCatalog(remote.buildTools(env));
  assert.equal(a.hash, b.hash);
  assert.ok(!a.catalog.some((t) => t.name === 'context.recall' || t.name === 'memory.put'));
  assert.ok(!a.catalog.some((t) => t.name.startsWith('git.')));
  const withGit = remote.buildCatalog(remote.buildTools({ ...env, binaries: ['git'] }));
  assert.ok(withGit.catalog.some((t) => t.name === 'git.status'));
  assert.notEqual(withGit.hash, a.hash);
  assert.equal(a.catalog.find((t) => t.name === 'fs.delete').destructive, true);
});
