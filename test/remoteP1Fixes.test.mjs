import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

// Đợt sửa P1 02/11/2026 — mỗi khối một mục (xem docs/official/device-agent ở repo be).
process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
process.env.AIVIN_TOKEN_STORE = 'file';
const { ConfirmMode, autostartTarget, createPolicyGuard, evaluateLocalPolicy, riskReason, saveLocalPolicy } = await import('../bin/lib/remote/localPolicy.mjs');
const { buildTransferTools, MAX_DOWNLOAD_BYTES } = await import('../bin/lib/remote/httpTransfer.mjs');
const { createUndoStore } = await import('../bin/lib/remote/undoStore.mjs');
const { safeGitArgv, safeGitEnv } = await import('../bin/lib/remote/gitSafe.mjs');
const { buildTools } = await import('../bin/lib/remote/toolHandlers.mjs');
const { createCallLedger } = await import('../bin/lib/remote/callLedger.mjs');
const credentials = await import('../bin/lib/remote/credentials.mjs');
const { fallBackToPreviousToken, settleRotation } = await import('../bin/lib/remote/tokenRotation.mjs');
const { createWatchBatcher } = await import('../bin/lib/remote/watchBatcher.mjs');
const { writeFileAtomic } = await import('../bin/lib/remote/atomicFile.mjs');
const { DAEMON_RUNNING, LOCK_UNREADABLE_GRACE_MS, acquireDaemonLock, lockHolder } = await import('../bin/lib/remote/daemonLock.mjs');
const { QUOTA_GUARDED_TOOLS } = await import('../bin/lib/remote/multiUser.mjs');

const tmp = (p = 'aivin-p1-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const policy = (p = {}) => ({ confirm: ConfirmMode.RISKY, deny_tools: [], blocked_commands: [], confirm_timeout_sec: 120, ...p });
const TICKET = 'A'.repeat(43);

test('mục 1: công cụ nội bộ vẫn bị deny_tools chặn; chỉ được miễn hỏi — trừ fs.download xét như fs.write', () => {
  const notify = { name: 'notify.show', internal: true };
  const tunnel = { name: 'browser.open_tunnel', internal: true };
  const download = { name: 'fs.download', internal: true };
  for (const tool of [notify, tunnel, download]) {
    assert.throws(() => evaluateLocalPolicy(policy({ deny_tools: [tool.name] }), tool, {}), /turned off/, tool.name);
  }
  assert.equal(evaluateLocalPolicy(policy({ confirm: ConfirmMode.ALWAYS }), notify, {}).action, 'allow', 'nội bộ thường: không hỏi');
  assert.equal(evaluateLocalPolicy(policy({ confirm: ConfirmMode.ALWAYS }), download, { path: 'a.bin' }).action, 'confirm', 'fs.download: hỏi như fs.write');
  assert.equal(evaluateLocalPolicy(policy(), download, { path: 'Videos/a.mp4.aivin-part' }).action, 'allow');
  assert.equal(evaluateLocalPolicy(policy(), download, { path: 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.exe' }).action, 'confirm');
});

test('mục 6: ghi vào chỗ tự chạy (Startup, rc shell, LaunchAgents, autostart, .git/hooks, .vscode/tasks.json) buộc hỏi tại máy', () => {
  const write = { name: 'fs.write' };
  const risky = [
    'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.bat',
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\run.vbs',
    '.bashrc', '/home/u/.zshrc', '~/.profile', '/Users/u/.bash_profile', '/home/u/.zshenv',
    '/Users/u/Library/LaunchAgents/com.x.plist', '/home/u/.config/autostart/x.desktop', '/home/u/.config/systemd/user/x.service',
    'D:/work/shop/.git/hooks/pre-commit', 'D:\\work\\shop\\.vscode\\tasks.json', 'Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1',
  ];
  for (const p of risky) {
    assert.ok(riskReason(write, { path: p }), p);
    assert.equal(evaluateLocalPolicy(policy(), write, { path: p, content: 'x' }).action, 'confirm', p);
  }
  for (const p of ['D:/work/shop/src/index.ts', 'notes/bashrc-tips.md', '.vscode/settings.json', 'D:/work/.github/hooks.md']) {
    assert.equal(riskReason(write, { path: p }), null, p);
  }
  assert.ok(autostartTarget('fs.copy', { sourcePath: 'a.sh', destinationPath: '/home/u/.bashrc' }));
  assert.ok(autostartTarget('fs.move', { sourcePath: 'a', destinationPath: 'repo/.git/hooks/post-checkout' }));
  assert.ok(autostartTarget('fs.edit', { path: '/home/u/.zshrc' }));
  assert.ok(autostartTarget('fs.move_many', { moves: [{ from: 'a', to: 'b' }, { from: 'c', to: '/Users/u/Library/LaunchAgents/x.plist' }] }));
  assert.equal(autostartTarget('fs.read', { path: '/home/u/.bashrc' }), null, 'chỉ đọc không tính');
  assert.equal(evaluateLocalPolicy(policy({ confirm: ConfirmMode.NEVER }), write, { path: '.bashrc' }).action, 'allow', 'chủ máy tắt hỏi → không hỏi');
});

/** Máy chủ tải giả: `body` trả trọn, `cut` gửi một nửa rồi cắt kết nối. */
function serveDownload({ body, cut = false, length = body.length }) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, length === null ? {} : { 'content-length': String(length) });
    if (!cut) return res.end(body);
    res.write(body.subarray(0, Math.floor(body.length / 2)));
    setTimeout(() => req.socket.destroy(), 20);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('mục 2: fs.download ghi ra .part rồi mới thay đích (bản cũ vào kho hoàn tác); đứt giữa chừng / quá trần → tệp gốc nguyên vẹn', async () => {
  const root = tmp();
  const undo = createUndoStore({ dir: path.join(tmp(), 'undo') });
  const env = { roots: [root], undo };
  const target = path.join(root, 'report.pdf');
  fs.writeFileSync(target, 'ORIGINAL');
  const data = Buffer.alloc(4000, 7);

  const ok = await serveDownload({ body: data });
  try {
    const [, download] = buildTransferTools({ serverUrl: ok.url, deviceToken: 't' });
    const out = await download.handler({ path: 'report.pdf', ticket: TICKET, undo_group: 'g1' }, {}, env);
    assert.equal(out.bytes, data.length);
    assert.equal(out.previous_version_kept, true);
    assert.deepEqual(fs.readFileSync(target), data);
    assert.equal(fs.existsSync(`${target}.part`), false);
    assert.ok((await undo.undo('g1', [root])).undone >= 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'hoàn tác trả bản cũ');

    await assert.rejects(download.handler({ path: 'report.pdf', ticket: TICKET, max_bytes: 1000 }, {}, env), (e) => e.code === 'OUTPUT_TOO_LARGE');
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
    assert.equal(fs.existsSync(`${target}.part`), false);
    await assert.rejects(download.handler({ path: 'report.pdf', ticket: TICKET, size: 10 }, {}, env), (e) => e.code === 'OUTPUT_TOO_LARGE' || /incomplete|limit/.test(e.message));
  } finally {
    ok.server.close();
  }

  // Máy chủ không khai Content-Length (chunked) mà gửi nhiều hơn trần → cắt khi đếm byte.
  const liar = await serveDownload({ body: data, length: null });
  try {
    const [, download] = buildTransferTools({ serverUrl: liar.url, deviceToken: 't' });
    await assert.rejects(download.handler({ path: 'report.pdf', ticket: TICKET, max_bytes: 3000 }, {}, env), (e) => e.code === 'OUTPUT_TOO_LARGE');
    assert.equal(fs.existsSync(`${target}.part`), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  } finally {
    liar.server.close();
  }

  const broken = await serveDownload({ body: data, cut: true });
  try {
    const [, download] = buildTransferTools({ serverUrl: broken.url, deviceToken: 't' });
    await assert.rejects(download.handler({ path: 'report.pdf', ticket: TICKET }, {}, env));
    assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'đứt giữa chừng không cắt cụt tệp gốc');
    assert.equal(fs.existsSync(`${target}.part`), false);
  } finally {
    broken.server.close();
  }
  assert.ok(MAX_DOWNLOAD_BYTES >= 1024 ** 3);
});

test('mục 4: xoá cả tệp luật lẫn tệp khoá khi daemon đang chạy → vẫn giữ luật đã ký, báo bị can thiệp; dấu bền làm daemon mới không tin "trống"', () => {
  const dir = tmp();
  const file = path.join(dir, 'remote-policy.json');
  const keyFile = path.join(dir, 'remote-policy.key.json');
  let marked = false;
  const sealedMarker = { seen: () => marked, note: () => { marked = true; } };
  saveLocalPolicy({ confirm: 'always', deny_tools: ['shell.exec'] }, file, { keyFile });
  const tampered = [];
  const guard = createPolicyGuard({ file, keyFile, sealedMarker, onTamper: (p) => tampered.push(p) });
  assert.deepEqual(guard.read().deny_tools, ['shell.exec']);
  assert.equal(marked, true, 'thấy luật có chữ ký → ghi dấu bền');
  fs.rmSync(file);
  fs.rmSync(keyFile);
  const after = guard.read();
  assert.deepEqual(after.deny_tools, ['shell.exec'], 'không về mặc định');
  assert.equal(after.confirm, 'always');
  assert.equal(tampered.length, 1);
  // Daemon khởi động lại sau khi bị xoá: không còn bản đúng để khôi phục, nhưng không coi là "tin cậy" (báo can thiệp).
  const restartedTamper = [];
  const restarted = createPolicyGuard({ file, keyFile, sealedMarker, onTamper: (p) => restartedTamper.push(p) });
  restarted.read();
  assert.equal(restartedTamper.length, 1);
  // Máy chưa từng có luật → trống là bình thường, không báo.
  const freshTamper = [];
  const fresh = createPolicyGuard({ file: path.join(dir, 'none.json'), keyFile: path.join(dir, 'none.key.json'), sealedMarker: { seen: () => false, note: () => {} }, onTamper: (p) => freshTamper.push(p) });
  fresh.read();
  assert.equal(freshTamper.length, 0);
});

test('mục 4: dấu "đã có luật có chữ ký" nằm trong tệp ghép máy và sống qua các lần lưu token', () => {
  credentials.saveDeviceCredentials({ device_id: 'dev-p1', device_token: 'tok-a', server_url: 'https://x', roots: [] });
  assert.equal(credentials.policySealedNoted(), false);
  credentials.notePolicySealed();
  assert.equal(credentials.policySealedNoted(), true);
  credentials.saveDeviceCredentials({ ...credentials.loadDeviceCredentials(), device_token: 'tok-b' });
  assert.equal(credentials.policySealedNoted(), true);
  assert.equal(credentials.loadDeviceCredentials().device_token, 'tok-b');
});

test('mục 5: git chỉ đọc tắt fsmonitor / hook / diff ngoài / textconv, bỏ biến GIT_*', () => {
  const argv = safeGitArgv('/repo', ['diff', '--stat']);
  assert.deepEqual(argv.slice(0, 5), ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', argv[4]]);
  assert.match(argv[4], /^core\.hooksPath=(NUL|\/dev\/null)$/);
  assert.deepEqual(argv.slice(5, 7), ['-c', 'log.showSignature=false']);
  assert.match(argv.slice(7, 9).join(' '), /^-c gpg\.program=(NUL|\/dev\/null)$/);
  assert.deepEqual(argv.slice(9), ['-C', '/repo', 'diff', '--no-ext-diff', '--no-textconv', '--stat']);
  assert.deepEqual(safeGitArgv('/r', ['status', '--porcelain=v1']).slice(-2), ['status', '--porcelain=v1']);
  assert.ok(safeGitArgv('/r', ['log', '-5']).includes('--no-textconv'));
  const env = safeGitEnv({ PATH: '/bin', GIT_EXTERNAL_DIFF: 'evil', GIT_SSH_COMMAND: 'evil', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', git_dir: '/x', HOME: '/h' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  for (const k of ['GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'git_dir']) assert.equal(env[k], undefined, k);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

test('mục 5 (chạy thật): kho đặt core.fsmonitor / diff.external chạy lệnh → git.status / git.diff của Aivin không chạy', { skip: !hasGit && 'máy không có git' }, async () => {
  const repo = tmp('aivin-p1-git-');
  const run = (...a) => spawnSync('git', ['-C', repo, ...a], { windowsHide: true, encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'a@b.c');
  run('config', 'user.name', 'a');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  run('add', 'a.txt');
  run('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const marker = path.join(repo, 'PWNED');
  const script = path.join(repo, 'pwn.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho x > '${marker.replace(/\\/g, '/')}'\n`, { mode: 0o755 });
  const cmd = `sh '${script.replace(/\\/g, '/')}'`;
  run('config', 'core.fsmonitor', cmd);
  run('config', 'diff.external', cmd);
  // Đối chứng: git thường có chạy lệnh của kho không (không thì máy này không tái hiện được, vẫn kiểm phía Aivin).
  run('diff');
  const reproduced = fs.existsSync(marker);
  fs.rmSync(marker, { force: true });
  const tools = buildTools({ roots: [repo], binaries: ['git'] });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const env = { roots: [repo], binaries: ['git'] };
  const st = await byName.get('git.status').handler({}, {}, env);
  const df = await byName.get('git.diff').handler({}, {}, env);
  await byName.get('git.log').handler({ limit: 2 }, {}, env);
  assert.equal(st.exitCode, 0, st.stderr);
  assert.match(df.stdout, /-one\s+\+two/);
  assert.equal(fs.existsSync(marker), false, `lệnh của kho đã chạy (đối chứng tái hiện: ${reproduced})`);
  if (process.env.AIVIN_TEST_VERBOSE) console.log(`git đối chứng chạy lệnh của kho: ${reproduced}`);
});

test('mục 7: kết quả đã gửi mà lỡ ack → gửi lại có giãn nhịp khi vẫn nối; mục đã ack không gửi lại', () => {
  let t = 1_000_000;
  const ledger = createCallLedger({ file: path.join(tmp(), 'outbox.json'), now: () => t, debounceMs: 0 });
  ledger.admit({ call_id: 'c1' });
  ledger.finish('c1', { call_id: 'c1', ok: true });
  ledger.admit({ call_id: 'c2' });
  ledger.finish('c2', { call_id: 'c2', ok: true });
  assert.deepEqual(ledger.dueForResend(), [], 'chưa gửi lần nào → đường gửi thường lo');
  ledger.markAttempt('c1');
  ledger.markAttempt('c2');
  ledger.markSent('c2');
  t += 29_000;
  assert.deepEqual(ledger.dueForResend(), []);
  t += 2_000;
  assert.deepEqual(ledger.dueForResend().map((p) => p.call_id), ['c1']);
  ledger.markAttempt('c1');
  t += 31_000;
  assert.deepEqual(ledger.dueForResend(), [], 'lần 2: chờ gấp đôi');
  t += 30_000;
  assert.deepEqual(ledger.dueForResend().map((p) => p.call_id), ['c1']);
  for (let i = 0; i < 10; i++) ledger.markAttempt('c1');
  t += 4 * 60_000;
  assert.deepEqual(ledger.dueForResend().map((p) => p.call_id), ['c1'], 'trần giãn nhịp 4 phút');
});

test('mục 8: xoay token — giữ token cũ tới khi chốt; bị từ chối token mới thì quay về token cũ thay vì xoá ghép máy', () => {
  credentials.saveDeviceCredentials({ device_id: 'dev-rot', device_token: 'tok-old', server_url: 'https://x', roots: [] }, { previousToken: null });
  credentials.saveDeviceCredentials({ ...credentials.loadDeviceCredentials(), device_token: 'tok-new' }, { previousToken: 'tok-old' });
  assert.equal(credentials.pendingPreviousToken(), 'tok-old');
  // Lưu thường (đổi ngôn ngữ…) từ bản trong bộ nhớ không làm mất token cũ đang giữ.
  credentials.saveDeviceCredentials({ ...credentials.loadDeviceCredentials(), lang: 'en' });
  assert.equal(credentials.pendingPreviousToken(), 'tok-old');

  const socket = { auth: { device_token: 'tok-new' }, active: false, connects: 0, connect() { this.connects++; } };
  const creds = { device_token: 'tok-new' };
  assert.equal(fallBackToPreviousToken({ creds, socket, delayMs: 0 }), true);
  assert.equal(creds.device_token, 'tok-old');
  assert.equal(socket.auth.device_token, 'tok-old');
  assert.equal(credentials.loadDeviceCredentials().device_token, 'tok-old');
  assert.equal(credentials.pendingPreviousToken(), null);
  assert.equal(fallBackToPreviousToken({ creds, socket, delayMs: 0 }), false, 'hết token cũ → người gọi mới xoá ghép máy');

  // Chốt: chào được bằng token mới → bỏ token cũ.
  credentials.saveDeviceCredentials({ ...credentials.loadDeviceCredentials(), device_token: 'tok-3' }, { previousToken: 'tok-old' });
  assert.equal(settleRotation('tok-other'), false, 'token không khớp → không bỏ');
  assert.equal(settleRotation('tok-3'), true);
  assert.equal(credentials.pendingPreviousToken(), null);
  assert.equal(credentials.loadDeviceCredentials().device_token, 'tok-3');
});

test('mục 9: bộ gom sự kiện theo dõi tệp có trần chờ (sự kiện liên tục vẫn chạy lô) và trần cỡ tập chờ (quá → quét lại)', async () => {
  const batches = [];
  let overflows = 0;
  const b = createWatchBatcher({ debounceMs: 60, maxWaitMs: 150, maxPending: 10, onBatch: (paths) => batches.push(paths), onOverflow: () => { overflows++; } });
  const started = Date.now();
  while (Date.now() - started < 500) {
    b.add('/r/app.log');
    await new Promise((r) => setTimeout(r, 20));
  }
  b.close();
  assert.ok(batches.length >= 2, `sự kiện mỗi 20 ms suốt 500 ms vẫn phải chạy lô (đã chạy ${batches.length})`);
  for (let i = 0; i < 11; i++) b.add(`/r/f${i}`);
  assert.equal(b.size(), 0);
  assert.equal(b.overflowed(), true);
  await b.flushNow();
  assert.equal(overflows, 1);
  assert.equal(b.overflowed(), false);
});

test('mục 10: ghi tệp nguyên tử không để lại tệp tạm; khoá daemon đọc không ra JSON mà còn mới → coi là đang giữ', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.json');
  writeFileAtomic(file, '{"a":1}');
  writeFileAtomic(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);

  const lockFile = path.join(dir, 'daemon.lock');
  fs.writeFileSync(lockFile, '{"pid":');
  assert.equal(lockHolder(lockFile), null, 'lockHolder không trả PID giả (người gọi có process.kill)');
  assert.throws(() => acquireDaemonLock({ lockFile }), (e) => e.code === DAEMON_RUNNING);
  const old = new Date(Date.now() - LOCK_UNREADABLE_GRACE_MS - 5_000);
  fs.utimesSync(lockFile, old, old);
  const release = acquireDaemonLock({ lockFile });
  try {
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  } finally {
    release();
  }
  assert.equal(fs.existsSync(lockFile), false);
  // Tạo mới (chưa có khoá) nguyên tử, có nội dung ngay.
  const again = acquireDaemonLock({ lockFile });
  try {
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
  } finally {
    again();
  }
});

test('mục 11: hết dung lượng máy tổ chức chặn cả fs.copy, fs.download, proc.write', () => {
  for (const t of ['fs.copy', 'fs.download', 'proc.write', 'fs.write', 'shell.exec']) assert.ok(QUOTA_GUARDED_TOOLS.has(t), t);
  assert.equal(QUOTA_GUARDED_TOOLS.has('fs.delete'), false);
});
