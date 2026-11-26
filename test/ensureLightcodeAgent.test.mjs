import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

/** Máy chủ giả trên loopback; ghi lại mọi lời gọi (kể cả thân) để kiểm chứng đúng một POST không tham số thừa. */
async function withServer(reply, run) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const { status = 200, body: out } = reply;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

/** Chạy CLI thật trong hồ sơ tạm: không đụng đăng nhập của người chạy test. */
function runCli(serverUrl, { apiKey, args = ['agent', 'ensure-lightcode', '--json'] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-lcagent-test-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIVIN_REMOTE_HOME: path.join(home, '.aivin'), AIVIN_TOKEN_STORE: 'file', AIVIN_BASE_URL: serverUrl, FORCE_COLOR: '0' };
  delete env.API_KEY;
  delete env.AIVIN_SERVER;
  if (apiKey) env.API_KEY = apiKey;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env, timeout: 30_000 });
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

const RESULT = { agent_id: 'a1', name: 'LightCode · Lan', created: true, nickname: 'lightcode_u1', workspace_id: 'ws1', edit_url: '/agent/lightcode_u1' };

test('ensure-lightcode --json: đúng một object 3 trường, một POST kèm API key + tenant', async () => {
  await withServer({ body: RESULT }, async (url, calls) => {
    const out = await runCli(url, { apiKey: 'acme-ak-secret' });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, `${JSON.stringify({ agent_id: 'a1', name: 'LightCode · Lan', created: true })}\n`);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /ai-staff/ensure-lightcode']);
    assert.equal(calls[0].headers.authorization, 'Bearer acme-ak-secret');
    assert.equal(calls[0].headers['x-client-slug'], 'acme');
  });
});

test('ensure-lightcode --json: nhận cả thân bọc data; gọi lại → created=false', async () => {
  await withServer({ body: { data: { ...RESULT, created: false } } }, async (url) => {
    const out = await runCli(url, { apiKey: 'acme-ak-secret' });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { agent_id: 'a1', name: 'LightCode · Lan', created: false });
  });
});

test('ensure-lightcode (không --json): in câu dễ đọc, không phải JSON', async () => {
  await withServer({ body: RESULT }, async (url) => {
    const out = await runCli(url, { apiKey: 'acme-ak-secret', args: ['agent', 'ensure-lightcode'] });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Created your LightCode agent/);
  });
});

test('ensure-lightcode: chưa đăng nhập → thoát khác 0, stdout rỗng, không gọi máy chủ', async () => {
  await withServer({ body: RESULT }, async (url, calls) => {
    const out = await runCli(url);
    assert.notEqual(out.code, 0);
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /Chưa đăng nhập/);
    assert.equal(calls.length, 0);
  });
});

for (const [name, reply, pattern] of [
  ['máy chủ chưa có endpoint', { status: 404 }, /chưa hỗ trợ agent LightCode/],
  ['máy chủ chưa bật tính năng', { status: 503 }, /chưa bật agent LightCode/],
  ['API key hết hiệu lực', { status: 401 }, /không còn hiệu lực/],
  ['chạm trần giấy phép', { status: 403, body: { message: 'Đã chạm trần agent', i18n: 'INFRA.LICENSE_LIMIT_REACHED' } }, /Đã chạm trần agent/],
  ['máy chủ lỗi', { status: 500, body: { message: 'boom' } }, /boom/],
  ['phản hồi không có agent_id', { body: { ok: true } }, /không trả agent LightCode/],
]) {
  test(`ensure-lightcode: ${name} → lỗi ra stderr, stdout rỗng`, async () => {
    await withServer(reply, async (url) => {
      const out = await runCli(url, { apiKey: 'acme-ak-secret' });
      assert.notEqual(out.code, 0);
      assert.equal(out.stdout, '');
      assert.match(out.stderr, pattern);
    });
  });
}

test('ensure-lightcode: không nối được máy chủ → lỗi ra stderr', async () => {
  let closed;
  await withServer({}, async (url) => { closed = url; });
  const out = await runCli(closed, { apiKey: 'acme-ak-secret' });
  assert.notEqual(out.code, 0);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /Không tạo \/ kiểm tra được agent LightCode/);
});
