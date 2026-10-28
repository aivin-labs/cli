import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { applyDevicePolicy, isBlockedUrl } = await import('../bin/lib/remote/cdpPolicy.mjs');
const { isNetworkPath, resolveInRoots } = await import('../bin/lib/remote/sandbox.mjs');
const { acquireDaemonLock, lockHolder, LOCK_STALE_MS } = await import('../bin/lib/remote/daemonLock.mjs');
const { createScheduler } = await import('../bin/lib/remote/scheduler.mjs');

const DL = path.join(os.tmpdir(), 'Aivin-downloads');

test('bộ lọc CDP: không mở file:// / trang nội bộ, không chọn tệp trên đĩa, không mở kênh CDP ngoài tầm lọc; thư mục tải ép về thư mục Aivin', () => {
  for (const url of ['file:///C:/Users/a/.aivin/device-credentials.json', 'FILE:///etc/passwd', 'chrome://settings', 'edge://settings/passwords',
    'view-source:https://x', 'about:settings', 'javascript:alert(1)', 'chrome-extension://abc/x.html']) {
    assert.ok(isBlockedUrl(url), url);
    assert.ok(applyDevicePolicy({ id: 1, method: 'Page.navigate', params: { url } }, { downloadsDir: DL }).error, url);
    assert.ok(applyDevicePolicy({ id: 1, method: 'Target.createTarget', params: { url } }, { downloadsDir: DL }).error, url);
  }
  for (const url of ['https://mail.google.com', 'about:blank', 'http://example.com/file:x']) assert.equal(isBlockedUrl(url), false, url);
  for (const method of ['Target.exposeDevToolsProtocol', 'Target.sendMessageToTarget', 'Network.loadNetworkResource', 'DOM.setFileInputFiles', 'Browser.close']) {
    assert.ok(applyDevicePolicy({ id: 2, method, params: {} }, { downloadsDir: DL }).error, method);
  }
  assert.ok(applyDevicePolicy({ id: 3, method: 'Target.setAutoAttach', params: { flatten: false } }, { downloadsDir: DL }).error);
  const dl = applyDevicePolicy({ id: 4, method: 'Page.setDownloadBehavior', params: { behavior: 'allow', downloadPath: 'C:\\Windows\\Startup' } }, { downloadsDir: DL });
  assert.equal(dl.msg.params.downloadPath, DL);
  const ok = { id: 5, method: 'Runtime.evaluate', params: { expression: '1' } };
  assert.equal(applyDevicePolicy(ok, { downloadsDir: DL }).msg, ok);
});

test('đường dẫn mạng / thiết bị bị từ chối theo chuỗi, trước mọi lời gọi fs (Windows tự gửi NTLM ra máy ngoài)', () => {
  for (const p of ['\\\\attacker\\share\\x', '//attacker/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', ' \\\\h\\s']) assert.ok(isNetworkPath(p), p);
  for (const p of ['C:\\Users\\a', '/home/a', 'docs/x.md', '.\\x']) assert.equal(isNetworkPath(p), false, p);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  assert.throws(() => resolveInRoots([root], '\\\\attacker\\share\\x'), /Network/);
  assert.throws(() => resolveInRoots([root], '//attacker/share'), /Network/);
});

test('khoá daemon: tạo nguyên tử, tiến trình khác còn sống + khoá còn mới thì từ chối; khoá không được làm mới quá lâu thì lấy lại', () => {
  const lockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'daemon.lock');
  // Một tiến trình khác (PID của tiến trình cha, còn sống) đang giữ khoá, vừa làm mới.
  const other = process.ppid;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: other, started_at: new Date().toISOString(), beat_at: new Date().toISOString() }));
  assert.equal(lockHolder(lockFile), other);
  assert.throws(() => acquireDaemonLock({ lockFile }), /PID/);
  // PID còn sống nhưng khoá đứng yên quá lâu (PID bị Windows cấp lại cho tiến trình khác sau khi tắt máy đột ngột) → coi là khoá cũ.
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: other, started_at: old, beat_at: old }));
  assert.equal(lockHolder(lockFile), null);
  const release = acquireDaemonLock({ lockFile });
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lockFile), false);
});

test('cancelAll: huỷ mọi lời gọi đang chạy (tạm dừng / dừng / thu hồi) và chờ chúng kết thúc', async () => {
  const scheduler = createScheduler();
  const runs = [1, 2].map((i) => scheduler.run({ call_id: `c${i}`, timeout_ms: 60_000 }, { group: 'exec' },
    (_args, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(scheduler.inflightCount(), 2);
  await scheduler.cancelAll('paused');
  const results = await Promise.all(runs);
  assert.equal(scheduler.inflightCount(), 0);
  assert.ok(results.every((r) => !r.ok && r.error_code === 'CANCELLED'));
});
