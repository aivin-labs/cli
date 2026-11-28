import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

async function withServer(handler, run) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const call = {
        method: req.method,
        pathname: urlObj.pathname,
        query: Object.fromEntries(urlObj.searchParams.entries()),
        body: body ? JSON.parse(body) : null,
      };
      calls.push(call);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(call)));
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

function runCli(serverUrl, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-store-test-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AIVIN_REMOTE_HOME: path.join(home, '.aivin'),
    AIVIN_TOKEN_STORE: 'file',
    AIVIN_BASE_URL: serverUrl,
    FORCE_COLOR: '0',
    API_KEY: 'test-key',
  };
  delete env.AIVIN_SERVER;
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

const ITEM = { key: 'lightcode/mem/0123456789abcdef', value: '{"v":1}', updated_at: '2026-11-27T08:00:00.000Z' };
const SINCE = '2026-11-26T00:00:00.000Z';

test('store list --since gửi mốc lên máy chủ và in has_more', async () => {
  await withServer(() => ({ prefix: 'lightcode/', items: [ITEM], count: 1, has_more: true }), async (url, calls) => {
    const run = await runCli(url, ['store', 'list', '--project=p1', `--since=${SINCE}`, '--limit=100', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(calls[0].pathname, '/datastore/store/list');
    assert.equal(calls[0].query.since, SINCE);
    const out = JSON.parse(run.stdout);
    assert.equal(out.has_more, true);
    assert.equal(out.items[0].updated_at, ITEM.updated_at);
  });
});

test('store list không --since giữ nguyên đầu ra cũ', async () => {
  await withServer(() => ({ prefix: 'lightcode/', items: [ITEM], count: 1 }), async (url, calls) => {
    const run = await runCli(url, ['store', 'list', '--project=p1', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(calls[0].query.since, undefined);
    assert.equal('has_more' in JSON.parse(run.stdout), false);
  });
});

test('store list --since báo lỗi khi máy chủ chưa hỗ trợ, và khi mốc không phải ngày', async () => {
  await withServer(() => ({ prefix: 'lightcode/', items: [ITEM], count: 1 }), async (url, calls) => {
    const old = await runCli(url, ['store', 'list', '--project=p1', `--since=${SINCE}`, '--json']);
    assert.equal(old.code, 1);
    assert.match(old.stderr, /does not support "--since"/);

    const bad = await runCli(url, ['store', 'list', '--project=p1', '--since=hom-qua', '--json']);
    assert.equal(bad.code, 1);
    assert.equal(calls.length, 1);
  });
});

test('file search gửi đúng body (limit bị kẹp về 20) và in một đối tượng JSON', async () => {
  const hit = { file_id: 'f1', file_name: 'dac-ta.md', chunk_index: 2, text: 'JWT', score: 0.7 };
  await withServer(() => ({ query: 'đăng nhập', project_id: 'p1', items: [hit], count: 1 }), async (url, calls) => {
    const run = await runCli(url, ['file', 'search', '--project=p1', '--query=đăng nhập', '--limit=50', '--max-chars=2000', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].pathname, '/fileshare/project-search');
    assert.deepEqual(calls[0].body, { project_id: 'p1', query: 'đăng nhập', limit: 20, max_chars: 2000 });
    assert.deepEqual(JSON.parse(run.stdout), { query: 'đăng nhập', project_id: 'p1', items: [hit], count: 1 });
  });
});

test('file search thiếu --query thì không gọi máy chủ', async () => {
  await withServer(() => ({}), async (url, calls) => {
    const run = await runCli(url, ['file', 'search', '--project=p1', '--json']);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /--query/);
    assert.equal(calls.length, 0);
  });
});
