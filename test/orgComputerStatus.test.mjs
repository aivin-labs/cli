import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

/** Máy chủ giả trên loopback; ghi lại mọi lời gọi để chắc lệnh chỉ đọc. */
async function withServer(reply, run) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    const { status = 200, body } = reply;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

/** Chạy CLI thật trong hồ sơ tạm: không đụng đăng nhập / ghép máy của người chạy test. */
function runCli(serverUrl, { apiKey, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-orgpc-test-'));
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AIVIN_REMOTE_HOME: path.join(home, '.aivin'),
    AIVIN_TOKEN_STORE: 'file',
    AIVIN_BASE_URL: serverUrl,
    FORCE_COLOR: '1',
    ...env,
  };
  delete childEnv.API_KEY;
  delete childEnv.AIVIN_SERVER;
  if (apiKey) childEnv.API_KEY = apiKey;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'remote', 'org-computer', '--json'], { cwd: home, env: childEnv, timeout: 30_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

const STATUS = { state: 'online', device_id: 'orgpc-o1', online: true, resources: { cpu: 2, memory_mb: 4096, disk_gb: 20 } };

test('org-computer --json: đúng một object JSON, một lời GET kèm API key + tenant, không bật máy', async () => {
  await withServer({ body: { data: STATUS } }, async (url, calls) => {
    const out = await runCli(url, { apiKey: 'acme-ak-secret' });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, `${JSON.stringify(STATUS)}\n`);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET /plugins/device-agent/org-computer']);
    assert.equal(calls[0].headers.authorization, 'Bearer acme-ak-secret');
    assert.equal(calls[0].headers['x-client-slug'], 'acme');
  });
});

test('org-computer --json: unavailable vẫn thoát 0, state giữ nguyên, nhận cả thân không bọc data', async () => {
  await withServer({ body: { state: 'unavailable', device_id: 'orgpc-o1', online: false } }, async (url) => {
    const out = await runCli(url, { apiKey: 'acme-ak-secret' });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { state: 'unavailable', device_id: 'orgpc-o1', online: false });
  });
});

test('org-computer --json: chưa đăng nhập → thoát khác 0, stdout rỗng, không gọi máy chủ', async () => {
  await withServer({ body: STATUS }, async (url, calls) => {
    const out = await runCli(url);
    assert.notEqual(out.code, 0);
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /Chưa đăng nhập/);
    assert.equal(calls.length, 0);
  });
});

for (const [name, reply, pattern] of [
  ['máy chủ không có endpoint', { status: 404 }, /chưa hỗ trợ Cloud Computer/],
  ['API key hết hiệu lực', { status: 401 }, /không còn hiệu lực/],
  ['máy chủ lỗi', { status: 500, body: { message: 'boom' } }, /boom/],
  ['phản hồi không có state', { body: { ok: true } }, /không trả trạng thái/],
]) {
  test(`org-computer --json: ${name} → lỗi ra stderr`, async () => {
    await withServer(reply, async (url) => {
      const out = await runCli(url, { apiKey: 'acme-ak-secret' });
      assert.notEqual(out.code, 0);
      assert.equal(out.stdout, '');
      assert.match(out.stderr, pattern);
    });
  });
}

test('org-computer --json: không nối được máy chủ → lỗi ra stderr', async () => {
  let closed;
  await withServer({}, async (url) => { closed = url; });
  const out = await runCli(closed, { apiKey: 'acme-ak-secret' });
  assert.notEqual(out.code, 0);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /Không lấy được trạng thái Cloud Computer/);
});
