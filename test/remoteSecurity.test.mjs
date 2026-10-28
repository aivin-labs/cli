import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Gốc thử = thư mục chứa luôn thư mục cấu hình Aivin (như `--dir ~` trên máy thật) — phải đặt TRƯỚC khi nạp mô-đun.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-sec-'));
const configDir = path.join(base, 'aivin-config');
fs.mkdirSync(configDir);
fs.writeFileSync(path.join(configDir, 'device-credentials.json'), '{"device_token":"needle-dk-secret"}');
process.env.AIVIN_REMOTE_HOME = configDir;

const { buildTools } = await import('../bin/lib/remote/toolHandlers.mjs');
const { scrubEnv, resolveInRoots, protectedDirNamesUnder } = await import('../bin/lib/remote/sandbox.mjs');
const { isValidDeviceCall } = await import('../bin/lib/remote/client.mjs');
const { createScheduler } = await import('../bin/lib/remote/scheduler.mjs');
const { DEFAULT_SCOPE_LIMITS, ToolGroup } = await import('../bin/lib/remote/constants.mjs');

const ctx = { signal: new AbortController().signal };
const toolsFor = (env) => new Map(buildTools(env).map((t) => [t.name, t]));
const sandboxDir = () => fs.mkdtempSync(path.join(base, 'root-'));

test('fs.list đệ quy và fs.grep (không ripgrep) không đi vào thư mục cấu hình Aivin', async () => {
  fs.writeFileSync(path.join(base, 'notes.txt'), 'needle in a normal file');
  const env = { roots: [base], binaries: [], projects: [], fileIndex: null };
  const tools = toolsFor(env);
  const listed = await tools.get('fs.list').handler({ recursive: true, maxDepth: 4 }, ctx, env);
  assert.ok(listed.entries.some((e) => e.path === 'notes.txt'));
  assert.ok(!listed.entries.some((e) => e.path.includes('aivin-config')), 'thư mục token không được liệt kê');
  const grep = await tools.get('fs.grep').handler({ query: 'needle' }, ctx, env);
  assert.equal(grep.engine, 'builtin');
  assert.ok(grep.matches.some((m) => m.path === 'notes.txt'));
  assert.ok(!grep.matches.some((m) => /aivin-config|needle-dk/.test(`${m.path} ${m.text}`)), 'không lộ token qua tìm nội dung');
});

test('ripgrep: loại .aivin và tên thư mục AIVIN_REMOTE_HOME khi nó nằm trong vùng tìm', () => {
  assert.deepEqual(protectedDirNamesUnder(base).sort(), ['.aivin', 'aivin-config']);
  assert.deepEqual(protectedDirNamesUnder(sandboxDir()), ['.aivin']);
});

test('fs.move: không đổi tên / ghi đè thư mục gốc; xoá / chuyển thư mục chứa token bị chặn', async () => {
  const root = sandboxDir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const env = { roots: [root], binaries: [], projects: [], fileIndex: null };
  const tools = toolsFor(env);
  await assert.rejects(tools.get('fs.move').handler({ sourcePath: '', destinationPath: 'moved' }, ctx, env), /Missing|root folder/);
  await assert.rejects(tools.get('fs.move').handler({ sourcePath: root, destinationPath: 'moved' }, ctx, env), /root folder/);
  await assert.rejects(tools.get('fs.move').handler({ sourcePath: '.', destinationPath: 'moved' }, ctx, env), /root folder/);
  await assert.rejects(tools.get('fs.move').handler({ sourcePath: 'a.txt', destinationPath: root, overwrite: true }, ctx, env), /root folder/);
  const moved = await tools.get('fs.move').handler({ sourcePath: 'a.txt', destinationPath: 'b/a.txt' }, ctx, env);
  assert.equal(moved.to, path.join('b', 'a.txt'));
  const wide = { roots: [base], binaries: [], projects: [], fileIndex: null };
  const wideTools = toolsFor(wide);
  await assert.rejects(wideTools.get('fs.delete').handler({ path: base }, ctx, wide), /root folder/);
  // Thư mục cha của thư mục cấu hình nằm trong gốc rộng hơn → xoá cha là xoá token.
  const outer = { roots: [path.dirname(base)], binaries: [], projects: [], fileIndex: null };
  await assert.rejects(toolsFor(outer).get('fs.delete').handler({ path: base }, ctx, outer), /credentials/);
  await assert.rejects(toolsFor(outer).get('fs.move').handler({ sourcePath: base, destinationPath: path.join(path.dirname(base), 'stolen') }, ctx, outer), /credentials/);
  assert.ok(fs.existsSync(path.join(configDir, 'device-credentials.json')));
});

test('resolveInRoots trả đường đã giải; xoá symlink chỉ xoá liên kết, không xoá thư mục nó trỏ tới', async () => {
  const root = sandboxDir();
  const target = path.join(root, 'real');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  const link = path.join(root, 'link');
  try { fs.symlinkSync(target, link, 'junction'); } catch { return; } // không tạo được liên kết → bỏ
  assert.equal(resolveInRoots([root], 'link/keep.txt'), path.join(fs.realpathSync.native(target), 'keep.txt'));
  const env = { roots: [root], binaries: [], projects: [], fileIndex: null };
  const res = await toolsFor(env).get('fs.delete').handler({ path: 'link' }, ctx, env);
  assert.equal(res.deleted, true);
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
});

test('scrubEnv: bỏ bí mật theo đoạn tên, giữ biến hệ thống vô hại', () => {
  const kept = [
    'PATH', 'PATHEXT', 'PWD', 'OLDPWD', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'LANG',
    'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'KEYBOARD_LAYOUT', 'SESSIONNAME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'NODE_ENV',
    'GIT_AUTHOR_NAME', 'NUMBER_OF_PROCESSORS', 'HOMEPATH', 'DATABASE_HOST', 'REDIS_PORT', 'MONKEYPATCH',
  ];
  const dropped = [
    'DB_PASS', 'DATABASE_PASS', 'DB_PWD', 'STRIPE_KEY', 'GEMINI_KEY', 'GH_PAT', 'JWT_SIGNING_KEY', 'SSH_AUTH_SOCK', 'SENTRY_DSN',
    'MONGO_CONNECTION_STRING', 'AZURE_STORAGE_CONNECTIONSTRING', 'DATABASE_URL', 'API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN',
    'AIVIN_BASE_URL', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'SESSION_SECRET', 'GIT_ASKPASS', 'APP_PRIVATE_PEM', 'MY_CREDS', 'AUTH_COOKIE',
  ];
  const env = Object.fromEntries([...kept, ...dropped].map((k) => [k, 'v']));
  env.MONGO_URI = 'mongodb://admin:hunter2@db:27017/app';
  env.PUBLIC_SITE_URI = 'https://example.com/path';
  const out = scrubEnv(env);
  for (const k of kept) assert.ok(k in out, `giữ ${k}`);
  for (const k of dropped) assert.ok(!(k in out), `bỏ ${k}`);
  assert.ok(!('MONGO_URI' in out), 'URL kèm mật khẩu bị bỏ');
  assert.ok('PUBLIC_SITE_URI' in out, 'URL không mật khẩu giữ nguyên');
});

test('lời gọi hỏng từ BE bị loại trước khi ACK / chạy', () => {
  assert.equal(isValidDeviceCall({ call_id: 'c1', tool: 'fs.read', args: { path: 'a' }, timeout_ms: 1000 }), true);
  assert.equal(isValidDeviceCall({ call_id: 'c1', tool: 'fs.read' }), true);
  for (const bad of [
    null, undefined, 'x', [], { tool: 'fs.read' }, { call_id: 1, tool: 'fs.read' }, { call_id: 'x'.repeat(65), tool: 'fs.read' },
    { call_id: 'c', tool: 5 }, { call_id: 'c', tool: 'fs.read', args: [1] }, { call_id: 'c', tool: 'fs.read', args: 'a' },
    { call_id: 'c', tool: 'fs.read', timeout_ms: 'soon' }, { call_id: 'c', tool: 'fs.read', user_scope: {} },
  ]) assert.equal(isValidDeviceCall(bad), false, JSON.stringify(bad));
});

test('scheduler nhiều người dùng: mỗi thành viên có trần riêng, người khác vẫn chạy được', async () => {
  const sched = createScheduler({ scopeLimits: DEFAULT_SCOPE_LIMITS });
  const active = new Map();
  const peak = new Map();
  const job = (scope) => async () => {
    active.set(scope, (active.get(scope) || 0) + 1);
    peak.set(scope, Math.max(peak.get(scope) || 0, active.get(scope)));
    await new Promise((r) => setTimeout(r, 30));
    active.set(scope, active.get(scope) - 1);
  };
  const runs = [
    ...Array.from({ length: 6 }, (_, i) => sched.run({ call_id: `a${i}`, user_scope: 'uaaaaaaaaaaaa', timeout_ms: 5000 }, { group: ToolGroup.EXEC }, job('a'))),
    sched.run({ call_id: 'b0', user_scope: 'ubbbbbbbbbbbb', timeout_ms: 5000 }, { group: ToolGroup.EXEC }, job('b')),
  ];
  await Promise.all(runs);
  assert.equal(peak.get('a'), DEFAULT_SCOPE_LIMITS[ToolGroup.EXEC]);
  assert.equal(peak.get('b'), 1);
  // Máy một người: không có trần theo vùng, như cũ (trần chung exec = 3).
  const single = createScheduler();
  let now = 0;
  let top = 0;
  const slow = async () => { now++; top = Math.max(top, now); await new Promise((r) => setTimeout(r, 20)); now--; };
  await Promise.all(Array.from({ length: 6 }, (_, i) => single.run({ call_id: `s${i}`, user_scope: 'uaaaaaaaaaaaa', timeout_ms: 5000 }, { group: ToolGroup.EXEC }, slow)));
  assert.equal(top, 3);
});
