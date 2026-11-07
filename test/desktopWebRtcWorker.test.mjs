import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { gzipSync } from 'zlib';
import { createWebRtcRuntimeLoader, extractNpmTarball, installRuntime, integrityOk, runtimeDir, runtimePackages } from '../bin/lib/remote/desktop/webrtcRuntime.mjs';
import { createDesktopWebRtcWorker, DESKTOP_WEBRTC_WORKER_ARG } from '../bin/lib/remote/desktop/webrtcWorker.mjs';

function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header[156] = 48;
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, pad]);
}
const tar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);

test('extractNpmTarball: bỏ tiền tố package/, không ghi ra ngoài thư mục đích', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-tar-'));
  const dest = path.join(dir, 'pkg');
  extractNpmTarball(tar(tarEntry('package/lib/a.js', Buffer.from('ok')), tarEntry('package/../../evil.js', Buffer.from('x'))), dest);
  assert.equal(fs.readFileSync(path.join(dest, 'lib', 'a.js'), 'utf8'), 'ok');
  assert.equal(fs.existsSync(path.join(dir, 'evil.js')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('integrityOk: sha512 base64 khớp / lệch', () => {
  const buf = Buffer.from('abc');
  const good = `sha512-${createHash('sha512').update(buf).digest('base64')}`;
  assert.equal(integrityOk(buf, good), true);
  assert.equal(integrityOk(Buffer.from('abd'), good), false);
  assert.equal(integrityOk(buf, 'sha1-xx'), false);
});

test('installRuntime: sai mã băm thì không để lại thư mục runtime', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-rt-'));
  const fake = gzipSync(tar(tarEntry('package/index.js', Buffer.from('1'))));
  await assert.rejects(installRuntime({ home, triple: 'win32-x64', get: async () => ({ data: fake }) }), /sai mã băm/);
  assert.equal(fs.existsSync(runtimeDir(home)), false);
  assert.equal(runtimePackages('linux-riscv64'), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runtime loader: chưa có thì tải nền đúng một lần, lần này trả null', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-rt-'));
  let installs = 0;
  const load = createWebRtcRuntimeLoader({ home, importNpm: async () => { throw new Error('none'); }, install: async () => { installs++; return false; } });
  const prev = process.env.AIVIN_NO_WRTC_DOWNLOAD;
  delete process.env.AIVIN_NO_WRTC_DOWNLOAD;
  try {
    assert.equal(await load(), null);
    assert.equal(await load(), null);
    if (runtimePackages()) assert.equal(installs, 1);
  } finally {
    if (prev !== undefined) process.env.AIVIN_NO_WRTC_DOWNLOAD = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function fakeSpawn() {
  const calls = [];
  const spawnImpl = (exe, args) => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.kill = () => proc.emit('exit', 1);
    proc.sent = [];
    proc.stdin.on('data', (d) => { for (const line of String(d).split('\n').filter(Boolean)) proc.sent.push(JSON.parse(line)); });
    proc.reply = (msg) => proc.stdout.write(JSON.stringify(msg) + '\n');
    calls.push({ exe, args, proc });
    return proc;
  };
  return { calls, spawnImpl };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('worker client: dựng tiến trình con bằng lệnh của CLI + cờ ẩn, chuyển tín hiệu / thao tác / trạng thái', async () => {
  const { calls, spawnImpl } = fakeSpawn();
  const got = { signals: [], inputs: [], ready: [] };
  const rtc = createDesktopWebRtcWorker({
    command: ['node', 'cli.mjs'], spawnImpl,
    emitSignal: (p) => got.signals.push(p), onInput: (raw, v) => got.inputs.push([raw, v]), onPeerReady: (v) => got.ready.push(v),
  });
  assert.equal(rtc.needsFallback(), true);
  const started = rtc.start({ sessionId: 's', viewerId: 'v1', iceServers: [] });
  await tick();
  assert.deepEqual(calls[0].args, ['cli.mjs', DESKTOP_WEBRTC_WORKER_ARG]);
  const proc = calls[0].proc;
  assert.equal(proc.sent[0].t, 'start');
  proc.reply({ t: 'started', viewerId: 'v1', ok: true });
  assert.equal(await started, true);
  proc.reply({ t: 'signal', payload: { type: 'offer' } });
  proc.reply({ t: 'input', raw: { action: 'move' }, viewerId: 'v1' });
  proc.reply({ t: 'peerReady', viewerId: 'v1' });
  proc.reply({ t: 'state', needsFallback: false, needsJpeg: false, hasVideo: true, videoLive: true, needsAudio: true, hasAudio: true });
  await tick();
  assert.deepEqual(got.signals, [{ type: 'offer' }]);
  assert.deepEqual(got.inputs, [[{ action: 'move' }, 'v1']]);
  assert.deepEqual(got.ready, ['v1']);
  assert.equal(rtc.videoLive(), true);
  assert.equal(rtc.needsAudio(), true);
  assert.equal(rtc.hasAudio(), true);
  rtc.setAudio(false);
  await tick();
  assert.deepEqual(proc.sent.at(-1), { t: 'audio', enabled: false });
  rtc.attachPipe('aivin-cast-1');
  await tick();
  assert.deepEqual(proc.sent.at(-1), { t: 'pipe', name: 'aivin-cast-1' });
});

test('worker client: tiến trình con chết giữa phiên → lùi JPEG, lời gọi đang chờ trả false', async () => {
  const { calls, spawnImpl } = fakeSpawn();
  const rtc = createDesktopWebRtcWorker({ command: ['aivin.exe'], spawnImpl });
  const started = rtc.start({ sessionId: 's', viewerId: 'v1' });
  await tick();
  calls[0].proc.reply({ t: 'state', needsFallback: false, needsJpeg: false, hasVideo: true, videoLive: true });
  await tick();
  calls[0].proc.emit('exit', 3221225477);
  assert.equal(await started, false);
  assert.equal(rtc.needsFallback(), true);
  assert.equal(rtc.videoLive(), false);
  rtc.start({ sessionId: 's', viewerId: 'v2' });
  assert.equal(calls.length, 2, 'phiên sau dựng lại tiến trình con');
});

test('runtime loader: module npm rỗng (Bun gói JS thiếu native) không được coi là đã có runtime', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-rt-'));
  const prev = process.env.AIVIN_NO_WRTC_DOWNLOAD;
  process.env.AIVIN_NO_WRTC_DOWNLOAD = '1';
  try {
    const load = createWebRtcRuntimeLoader({ home, importNpm: async () => ({ default: {} }) });
    assert.equal(await load(), null);
    const ok = createWebRtcRuntimeLoader({ home, importNpm: async () => ({ default: { RTCPeerConnection: class {} } }) });
    assert.equal(typeof (await ok()).RTCPeerConnection, 'function');
  } finally {
    if (prev === undefined) delete process.env.AIVIN_NO_WRTC_DOWNLOAD; else process.env.AIVIN_NO_WRTC_DOWNLOAD = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
