import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createHash, generateKeyPairSync, sign } from 'crypto';
import { gzipSync } from 'zlib';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const {
  BootAction, UpdateStatus, assertSafeUrl, checkBootAfterUpdate, checksumFor, cleanupRetired, clearStaleInstalledMarker, compareVersions, confirmUpdate,
  downloadRoot, installUpdate, installedNewerThanRunning, loadUpdateSettings, noteCleanExit, releaseAsset, releaseKeyId, replaceBinary, rolloutBucket,
  saveUpdateSettings, signedMessage, verifyEnv, verifyReleaseSignature,
} = await import('../bin/lib/selfUpdate.mjs');
const { createAutoUpdater } = await import('../bin/lib/remote/autoUpdate.mjs');
const { detectSupervisor, windowsWatchdogScript } = await import('../bin/lib/remote/autoStart.mjs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-update-test-'));

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, entry: { id: releaseKeyId(publicKey), key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') } };
}
const KEY = makeKey();
const OTHER_KEY = makeKey();

const sigFor = (version, sums, key = KEY) => JSON.stringify({ alg: 'ed25519', key_id: key.entry.id, version, sig: sign(null, signedMessage(version, sums), key.privateKey).toString('base64') });

/** Trang tải giả: `files` = { '/latest.txt': 'v1.0.9\n', ... } (giá trị hàm = tự xử lý). */
async function serve(files) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const body = files[req.url];
    if (typeof body === 'function') return body(req, res);
    if (body === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { root: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

function release(version, content, { badSum = false, sigKey = KEY, noSig = false, sigVersion = version } = {}) {
  const asset = releaseAsset();
  const gz = gzipSync(Buffer.from(content));
  const sum = badSum ? '0'.repeat(64) : createHash('sha256').update(gz).digest('hex');
  const sums = `${'f'.repeat(64)}  other-asset.gz\n${sum}  ${asset}.gz\n`;
  return {
    '/latest.txt': `${version}\n`,
    [`/${version}/${asset}.gz`]: gz,
    [`/${version}/SHA256SUMS`]: sums,
    ...(noSig ? {} : { [`/${version}/SHA256SUMS.sig`]: sigFor(sigVersion, sums, sigKey) }),
  };
}

function sandbox() {
  const dir = tmpDir();
  const target = path.join(dir, process.platform === 'win32' ? 'aivin.exe' : 'aivin');
  fs.writeFileSync(target, 'OLD BUILD');
  const files = { markerFile: path.join(dir, 'installed.json'), stateFile: path.join(dir, 'state.json'), lockFile: path.join(dir, 'update.lock'), settingsFile: path.join(dir, 'update.json') };
  return { dir, target, files, opts: { binary: true, target, current: '1.0.7', keys: [KEY.entry], verify: async () => {}, ...files } };
}

test('so sánh phiên bản: có / không có v, bản thử nghiệm nhỏ hơn bản chính, chuỗi hỏng nhỏ nhất', () => {
  assert.ok(compareVersions('v1.0.9', '1.0.8') > 0);
  assert.equal(compareVersions('1.0.8', 'v1.0.8'), 0);
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
  assert.ok(compareVersions('1.1.0-beta', '1.1.0') < 0);
  assert.ok(compareVersions('rác', '0.0.1') < 0);
});

test('tên bản build khớp scripts/build-binary.mjs', () => {
  assert.equal(releaseAsset({ platform: 'win32', arch: 'x64' }), 'aivin-windows-x64.exe');
  assert.equal(releaseAsset({ platform: 'win32', arch: 'arm64' }), 'aivin-windows-arm64.exe');
  assert.equal(releaseAsset({ platform: 'linux', arch: 'x64', musl: true }), 'aivin-linux-x64-musl');
  assert.equal(releaseAsset({ platform: 'linux', arch: 'arm64', musl: false }), 'aivin-linux-arm64');
  assert.equal(releaseAsset({ platform: 'darwin', arch: 'x64', rosetta: true }), 'aivin-darwin-arm64');
  assert.equal(releaseAsset({ platform: 'darwin', arch: 'x64', rosetta: false }), 'aivin-darwin-x64');
});

test('đọc SHA256SUMS: đúng tệp, nhận cả dấu * chế độ nhị phân', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const text = `${a}  aivin-linux-x64.gz\n${b} *aivin-windows-x64.exe.gz\r\n`;
  assert.equal(checksumFor(text, 'aivin-linux-x64.gz'), a);
  assert.equal(checksumFor(text, 'aivin-windows-x64.exe.gz'), b.toLowerCase());
  assert.equal(checksumFor(text, 'aivin-darwin-x64.gz'), null);
});

test('chữ ký: đúng khoá + đúng phiên bản mới qua; khoá lạ, sửa 1 byte, dùng lại chữ ký của bản khác, danh sách khoá rỗng → từ chối', () => {
  const sums = Buffer.from(`${'a'.repeat(64)}  aivin-linux-x64.gz\n`);
  verifyReleaseSignature({ version: 'v1.0.9', sums, sigText: sigFor('v1.0.9', sums), keys: [KEY.entry] });
  assert.throws(() => verifyReleaseSignature({ version: 'v1.0.9', sums, sigText: sigFor('v1.0.9', sums, OTHER_KEY), keys: [KEY.entry] }), /không ký bằng khoá/);
  const tampered = Buffer.from(sums);
  tampered[0] ^= 1;
  assert.throws(() => verifyReleaseSignature({ version: 'v1.0.9', sums: tampered, sigText: sigFor('v1.0.9', sums), keys: [KEY.entry] }), /không hợp lệ/);
  const old = JSON.parse(sigFor('v1.0.8', sums));
  delete old.version;
  assert.throws(() => verifyReleaseSignature({ version: 'v1.0.9', sums, sigText: JSON.stringify(old), keys: [KEY.entry] }), /không hợp lệ/);
  assert.throws(() => verifyReleaseSignature({ version: 'v1.0.9', sums, sigText: sigFor('v1.0.9', sums), keys: [] }), /không ký bằng khoá/);
  assert.throws(() => verifyReleaseSignature({ version: 'v1.0.9', sums, sigText: 'rác', keys: [KEY.entry] }), /hỏng/);
});

test('nguồn tải: chỉ https (http chỉ cho máy này); không đọc nguồn từ ~/.aivin/update.json', () => {
  assert.equal(downloadRoot({ env: {} }), 'https://get.aivin.vn');
  assert.equal(downloadRoot({ env: { AIVIN_DOWNLOAD_ROOT: 'https://mirror.corp/aivin/' } }), 'https://mirror.corp/aivin');
  assert.throws(() => downloadRoot({ env: { AIVIN_DOWNLOAD_ROOT: 'http://mirror.corp' } }), /https/);
  assertSafeUrl('http://127.0.0.1:9/x');
  assert.throws(() => assertSafeUrl('file:///etc/passwd'), /https/);
  const file = path.join(tmpDir(), 'update.json');
  fs.writeFileSync(file, JSON.stringify({ auto: true, root: 'https://evil.example' }));
  assert.equal(loadUpdateSettings(file).root, undefined);
});

test('cài bản mới: kiểm chữ ký trước khi tải bản build, thay tệp, giữ bản cũ ở .prev, ghi trạng thái chờ xác nhận', async () => {
  const site = await serve(release('v1.0.9', 'NEW BUILD'));
  const { target, files, opts } = sandbox();
  const verified = [];
  try {
    const res = await installUpdate({ ...opts, root: site.root, verify: async (file, v) => verified.push([fs.readFileSync(file, 'utf8'), v]) });
    assert.equal(res.status, UpdateStatus.INSTALLED);
    assert.deepEqual(verified, [['NEW BUILD', 'v1.0.9']]);
    assert.equal(fs.readFileSync(target, 'utf8'), 'NEW BUILD');
    assert.equal(fs.readFileSync(`${target}.prev`, 'utf8'), 'OLD BUILD');
    assert.equal(installedNewerThanRunning({ target, current: '1.0.7', file: files.markerFile, settingsFile: files.settingsFile }), 'v1.0.9');
    assert.equal(JSON.parse(fs.readFileSync(files.stateFile, 'utf8')).version, 'v1.0.9');
    const sigAt = site.hits.findIndex((u) => u.endsWith('SHA256SUMS.sig'));
    const gzAt = site.hits.findIndex((u) => u.endsWith('.gz'));
    assert.ok(sigAt >= 0 && sigAt < gzAt, 'chữ ký kiểm trước khi tải bản build');
  } finally {
    await site.close();
  }
});

test('trang tải bị chiếm: không chữ ký / ký bằng khoá lạ / mã băm lệch / bản không chạy → KHÔNG đụng tệp đang dùng, không tải bản build khi chữ ký sai', async () => {
  const cases = [
    [release('v1.0.9', 'EVIL', { noSig: true }), /không có chữ ký/],
    [release('v1.0.9', 'EVIL', { sigKey: OTHER_KEY }), /không ký bằng khoá/],
    [release('v1.0.9', 'EVIL', { badSum: true }), /không khớp mã kiểm tra/],
  ];
  for (const [files, expected] of cases) {
    const site = await serve(files);
    const { target, files: f, opts } = sandbox();
    try {
      await assert.rejects(installUpdate({ ...opts, root: site.root }), expected);
      assert.equal(fs.readFileSync(target, 'utf8'), 'OLD BUILD');
      assert.equal(fs.existsSync(f.markerFile), false);
      if (!/mã kiểm tra/.test(String(expected))) assert.ok(!site.hits.some((u) => u.endsWith('.gz')), 'không tải bản build khi chữ ký hỏng');
    } finally {
      await site.close();
    }
  }
  const site = await serve(release('v1.0.9', 'BROKEN'));
  const { target, opts } = sandbox();
  try {
    await assert.rejects(installUpdate({ ...opts, root: site.root, verify: async () => { throw new Error('không chạy được'); } }), /không chạy được/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'OLD BUILD');
  } finally {
    await site.close();
  }
});

test('chuyển hướng sang http (không phải máy này) bị chặn', async () => {
  const site = await serve({ '/latest.txt': (req, res) => { res.writeHead(302, { Location: 'http://evil.invalid/latest.txt' }); res.end(); } });
  try {
    await assert.rejects(installUpdate({ ...sandbox().opts, root: site.root }), /https/);
  } finally {
    await site.close();
  }
});

test('trần dung lượng: latest.txt khổng lồ bị cắt, không đọc hết vào bộ nhớ', async () => {
  const site = await serve({ '/latest.txt': Buffer.alloc(200 * 1024, 'v') });
  try {
    await assert.rejects(installUpdate({ ...sandbox().opts, root: site.root }), /maxContentLength|exceeded/i);
  } finally {
    await site.close();
  }
});

test('đã mới nhất / bản npm / chỉ kiểm / bản đã tự lùi / đang có lần cập nhật khác: không tải gì', async () => {
  const site = await serve({ '/latest.txt': 'v1.0.9\n' });
  const { files, opts } = sandbox();
  try {
    assert.equal((await installUpdate({ ...opts, root: site.root, current: '1.0.9' })).status, UpdateStatus.UP_TO_DATE);
    assert.equal((await installUpdate({ ...opts, root: site.root, binary: false })).status, UpdateStatus.NOT_BINARY);
    assert.equal((await installUpdate({ ...opts, root: site.root, check: true })).status, UpdateStatus.AVAILABLE);
    saveUpdateSettings({ skip: ['v1.0.9'] }, files.settingsFile);
    assert.equal((await installUpdate({ ...opts, root: site.root })).status, UpdateStatus.SKIPPED);
    saveUpdateSettings({ skip: [] }, files.settingsFile);
    fs.writeFileSync(files.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.equal((await installUpdate({ ...opts, root: site.root })).status, UpdateStatus.BUSY);
  } finally {
    await site.close();
  }
});

test('phát hành theo đợt: máy ngoài đợt hoãn; máy chủ đòi bản tối thiểu / cài tay thì không theo đợt', async () => {
  const deviceId = 'dev-1';
  const bucket = rolloutBucket(deviceId, 'v1.0.9');
  const site = await serve({ ...release('v1.0.9', 'NEW'), '/rollout.json': JSON.stringify({ version: 'v1.0.9', percent: bucket }) });
  try {
    assert.equal((await installUpdate({ ...sandbox().opts, root: site.root, deviceId })).status, UpdateStatus.DEFERRED);
    assert.equal((await installUpdate({ ...sandbox().opts, root: site.root, deviceId, urgent: true })).status, UpdateStatus.INSTALLED);
    assert.equal((await installUpdate({ ...sandbox().opts, root: site.root })).status, UpdateStatus.INSTALLED);
  } finally {
    await site.close();
  }
  assert.equal(rolloutBucket('dev-1', 'v1.0.9'), bucket, 'cố định theo máy + phiên bản');
});

test('tự lùi bản: sập 3 lần trước khi xác nhận → trả bản cũ, bỏ qua bản lỗi, xoá dấu (không vòng lặp chuyển bản); dừng gọn không tính', async () => {
  const site = await serve(release('v1.0.9', 'NEW BUILD'));
  const { target, files, opts } = sandbox();
  try {
    await installUpdate({ ...opts, root: site.root });
  } finally {
    await site.close();
  }
  const boot = (extra = {}) => checkBootAfterUpdate({ current: '1.0.9', target, stateFile: files.stateFile, settingsFile: files.settingsFile, markerFile: files.markerFile, ...extra });
  assert.equal(boot().action, BootAction.PENDING);
  noteCleanExit({ current: '1.0.9', target, stateFile: files.stateFile });
  assert.equal(boot().boots, 1, 'Ctrl+C không tính là sập');
  assert.equal(boot().action, BootAction.PENDING);
  assert.equal(boot().action, BootAction.PENDING);
  const res = boot();
  assert.equal(res.action, BootAction.ROLLED_BACK);
  assert.equal(res.previous, 'v1.0.7');
  assert.equal(fs.readFileSync(target, 'utf8'), 'OLD BUILD');
  assert.deepEqual(loadUpdateSettings(files.settingsFile).skip, ['v1.0.9']);
  assert.equal(installedNewerThanRunning({ target, current: '1.0.7', file: files.markerFile, settingsFile: files.settingsFile }), null);
  assert.equal(boot({ current: '1.0.7' }).action, BootAction.NONE);
});

test('xác nhận bản mới chạy ổn → bỏ bản cũ .prev; dấu cài đặt cũ được xoá khi tiến trình mới khởi động', async () => {
  const site = await serve(release('v1.0.9', 'NEW BUILD'));
  const { target, files, opts } = sandbox();
  try {
    await installUpdate({ ...opts, root: site.root });
  } finally {
    await site.close();
  }
  assert.equal(confirmUpdate({ current: '1.0.9', target, stateFile: files.stateFile }), true);
  assert.equal(fs.existsSync(`${target}.prev`), false);
  assert.equal(checkBootAfterUpdate({ current: '1.0.9', target, stateFile: files.stateFile }).action, BootAction.NONE);
  clearStaleInstalledMarker({ target, file: files.markerFile });
  assert.equal(fs.existsSync(files.markerFile), false);
});

test('thay tệp Windows: chép hỏng thì trả bản cũ về chỗ cũ; .prev cũ còn bị khoá thì đổi tên đi, dọn *.trash lần sau', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'aivin.exe');
  fs.writeFileSync(target, 'OLD');
  assert.throws(() => replaceBinary({ newFile: path.join(dir, 'khong-co'), target, platform: 'win32' }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'OLD');
  fs.writeFileSync(`${target}-1.trash`, 'x');
  fs.writeFileSync(`${target}.old`, 'x');
  cleanupRetired(target);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['aivin.exe']);
});

test('chạy thử bản mới chỉ với biến môi trường tối thiểu — không API key / token', () => {
  const env = verifyEnv({ PATH: '/bin', HOME: '/h', API_KEY: 'k', AIVIN_DEVICE_TOKEN: 't', HTTPS_PROXY: 'http://u:p@proxy' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('trình giữ chạy: dấu AIVIN_SUPERVISOR / launchd đúng nhãn / wscript chạy aivin-remote.vbs; --quiet tự chạy tay không tính', () => {
  assert.equal(detectSupervisor({ env: { AIVIN_SUPERVISOR: 'systemd' } }), 'systemd');
  assert.equal(detectSupervisor({ env: {}, quiet: true, platform: 'linux' }), null);
  assert.equal(detectSupervisor({ env: { XPC_SERVICE_NAME: 'com.aivin.remote' }, quiet: true, platform: 'darwin' }), 'launchd');
  assert.equal(detectSupervisor({ env: {}, quiet: true, platform: 'win32', readParent: () => '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\Users\\a\\.aivin\\aivin-remote.vbs"' }), 'wscript');
  assert.equal(detectSupervisor({ env: {}, quiet: true, platform: 'win32', readParent: () => 'C:\\Windows\\System32\\cmd.exe' }), null);
  assert.equal(detectSupervisor({ env: {}, quiet: false, platform: 'win32', readParent: () => { throw new Error('không được gọi'); } }), null);
  const vbs = windowsWatchdogScript(['C:\\aivin.exe', 'remote', 'start', '--quiet']);
  assert.match(vbs, /Environment\("Process"\)\.Item\("AIVIN_SUPERVISOR"\) = "wscript"/);
  assert.match(vbs, /If rc = 75 Then/);
});

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('daemon: chuyển bản chỉ khi yên liền idleGraceMs tính từ lần hoạt động cuối — lời gọi ngắn giữa hai nhịp tick vẫn tính', async () => {
  const clock = fakeClock();
  let lastActivity = clock.now();
  const restarts = [];
  const u = createAutoUpdater({
    supervised: true, tickMs: 1e9, firstCheckMs: 0, idleGraceMs: 10 * 60_000, now: clock.now, current: '1.0.7',
    isIdle: () => true, lastActivityAt: () => lastActivity, onRestart: (v) => restarts.push(v), installedNewer: () => 'v1.0.9',
  });
  try {
    for (let i = 0; i < 30; i++) {
      clock.advance(30_000);
      lastActivity = clock.now() - 10_000;
      await u.tick();
    }
    assert.deepEqual(restarts, [], '15 phút, cứ 30 s có việc → không chuyển');
    clock.advance(9 * 60_000);
    await u.tick();
    assert.deepEqual(restarts, []);
    clock.advance(2 * 60_000);
    await u.tick();
    assert.deepEqual(restarts, ['v1.0.9']);
  } finally {
    u.close();
  }
});

test('không có trình giữ chạy: chỉ nhắc một lần, không tự thoát', async () => {
  const lines = [];
  const restarts = [];
  const u = createAutoUpdater({
    supervised: false, tickMs: 1e9, firstCheckMs: 0, current: '1.0.7', say: (m) => lines.push(m), onRestart: (v) => restarts.push(v),
    installedNewer: () => 'v1.0.9', settings: () => ({ auto: true, skip: [] }), install: async () => { throw new Error('không được gọi'); },
  });
  try {
    await u.tick();
    await u.tick();
    assert.deepEqual(restarts, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /chạy lại/);
  } finally {
    u.close();
  }
});

test('BE đòi bản tối thiểu: kiểm trong khoảng rải ngẫu nhiên, gửi cờ urgent; tự cập nhật tắt thì chỉ nhắc', async () => {
  const clock = fakeClock();
  const calls = [];
  let auto = true;
  const lines = [];
  const u = createAutoUpdater({
    supervised: true, tickMs: 1e9, firstCheckMs: 3_600_000, retryMs: 3_600_000, urgentJitterMs: 60_000, now: clock.now, random: () => 0.5,
    current: '1.0.7', say: (m) => lines.push(m), installedNewer: () => null, settings: () => ({ auto, skip: [] }), deviceId: 'd1',
    install: async (o) => { calls.push(o); return { status: UpdateStatus.UP_TO_DATE }; },
  });
  try {
    u.setMinVersion('1.0.7');
    await u.tick();
    assert.equal(calls.length, 0, 'đã đủ bản → không kiểm');
    u.setMinVersion('1.0.9');
    await u.tick();
    assert.equal(calls.length, 0, 'chưa tới giờ đã rải');
    clock.advance(30_000);
    await u.tick();
    assert.deepEqual(calls, [{ deviceId: 'd1', urgent: true }]);
    clock.advance(11 * 60_000);
    auto = false;
    u.setMinVersion('1.0.9');
    clock.advance(60_000);
    await u.tick();
    assert.equal(calls.length, 1);
    assert.ok(lines.some((l) => /tự cập nhật đang tắt/.test(l)));
  } finally {
    u.close();
  }
});
