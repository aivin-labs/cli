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
        url: req.url,
        pathname: urlObj.pathname,
        query: Object.fromEntries(urlObj.searchParams.entries()),
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      };
      calls.push(call);
      const reply = typeof handler === 'function' ? handler(call) : handler;
      const { status = 200, body: out } = reply || {};
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

function runCli(serverUrl, { apiKey, args } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-ctx-test-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AIVIN_REMOTE_HOME: path.join(home, '.aivin'),
    AIVIN_TOKEN_STORE: 'file',
    AIVIN_BASE_URL: serverUrl,
    FORCE_COLOR: '0',
  };
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

const RAW_TASK = {
  id: '680000000000000000000001',
  title: 'Tích hợp VNPay',
  status: 'processing',
  priority: 'high',
  assign_id: 'u1',
  to_date: '2026-12-01T00:00:00.000Z',
  parent_id: '680000000000000000000000',
  depends_on: ['680000000000000000000002'],
  step: 'Thực hiện',
  description: 'Xử lý callback và lưu lịch sử.',
  workspace_id: 'ws1',
  handler_history: [{ member_id: 'u1', member_name: 'LightCode · Lan' }],
  comments: [
    { id: 'c1', user_name: 'Lan', content: 'Ưu tiên mobile-first nhé', created_at: '2026-11-26T04:00:00.000Z' },
  ],
  attachments: [
    { id: 'att1', file_id: 'f1', name: 'spec.md', size: 1280, mime_type: 'text/markdown' },
    { id: 'att2', name: 'mockup.png', size: 40960, mime_type: 'image/png', type: 'image' },
  ],
};

test('aivin task get <id> --json: in một object JSON đủ trường cho aivin_context', async () => {
  await withServer({ body: RAW_TASK }, async (url, calls) => {
    const out = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['task', 'get', '680000000000000000000001', '--json'],
    });
    assert.equal(out.code, 0, out.stderr);
    const parsed = JSON.parse(out.stdout.trim());
    assert.equal(parsed.title, 'Tích hợp VNPay');
    assert.equal(parsed.status, 'processing');
    assert.equal(parsed.priority, 'high');
    assert.equal(parsed.assignee_name, 'LightCode · Lan');
    assert.equal(parsed.assignee, 'LightCode · Lan');
    assert.equal(parsed.due_at, '2026-12-01T00:00:00.000Z');
    assert.equal(parsed.parent_id, '680000000000000000000000');
    assert.equal(parsed.workflow_step, 'Thực hiện');
    assert.equal(parsed.description, 'Xử lý callback và lưu lịch sử.');
    assert.deepEqual(parsed.comments[0], {
      ...RAW_TASK.comments[0],
      id: 'c1',
      author: 'Lan',
      body: 'Ưu tiên mobile-first nhé',
      at: '2026-11-26T04:00:00.000Z',
    });
    assert.equal(parsed.attachments[0].id, 'att1');
    assert.equal(parsed.attachments[0].name, 'spec.md');
    assert.equal(parsed.attachments[0].size, 1280);
    assert.equal(parsed.attachments[0].mime, 'text/markdown');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/task/680000000000000000000001');
  });
});

test('aivin task attachment <id> --attachment=... --max-bytes=...: in nội dung chữ và báo rõ khi tệp nhị phân', async () => {
  await withServer((call) => {
    if (call.pathname.endsWith('/attachment')) {
      if (call.query.attachment === 'mockup.png') {
        return {
          body: {
            id: 'att2',
            name: 'mockup.png',
            mime: 'image/png',
            binary: true,
            text: '',
            message: 'Tệp "mockup.png" là tệp nhị phân (image/png), không đọc được dạng chữ.',
          },
        };
      }
      return {
        body: {
          id: 'att1',
          name: 'spec.md',
          mime: 'text/markdown',
          binary: false,
          text: '# Đặc tả thanh toán VNPay\nCallback trả 200 OK.',
        },
      };
    }
    return { status: 404 };
  }, async (url) => {
    const textOut = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['task', 'attachment', '680000000000000000000001', '--attachment=spec.md', '--max-bytes=12000'],
    });
    assert.equal(textOut.code, 0, textOut.stderr);
    assert.match(textOut.stdout, /Đặc tả thanh toán VNPay/);

    const binOut = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['task', 'attachment', '680000000000000000000001', '--attachment=mockup.png', '--max-bytes=12000'],
    });
    assert.equal(binOut.code, 0, binOut.stderr);
    assert.match(binOut.stdout, /tệp nhị phân.*không đọc được dạng chữ/i);
  });
});

test('aivin store get|set|list|search --project=<id> --json: khóa luôn dưới lightcode/, không có lệnh xóa', async () => {
  await withServer((call) => {
    if (call.pathname === '/datastore/store/set') {
      return {
        body: {
          key: call.body.key,
          value: call.body.value,
          source: 'lightcode',
          project_id: call.body.project_id,
        },
      };
    }
    if (call.pathname === '/datastore/store/get') {
      return {
        body: {
          key: call.query.key,
          found: true,
          value: '-- تصمیم: dùng VNPay SDK v2',
          source: 'lightcode',
          project_id: call.query.project_id,
        },
      };
    }
    if (call.pathname === '/datastore/store/list') {
      return {
        body: {
          prefix: call.query.prefix,
          items: [{ key: 'lightcode/decisions/auth', value: 'JWT + refresh token' }],
          count: 1,
          source: 'lightcode',
          project_id: call.query.project_id,
        },
      };
    }
    if (call.pathname === '/datastore/store/search') {
      return {
        body: {
          query: call.query.query,
          prefix: call.query.prefix,
          items: [{ key: 'lightcode/decisions/auth', value: 'JWT + refresh token' }],
          count: 1,
          source: 'lightcode',
          project_id: call.query.project_id,
        },
      };
    }
    return { status: 404 };
  }, async (url, calls) => {
    // 1. set (giá trị bắt đầu bằng -- truyền qua --value=...)
    const setOut = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['store', 'set', '--key=decisions/auth', '--value=-- dùng VNPay SDK v2', '--project=proj1', '--json'],
    });
    assert.equal(setOut.code, 0, setOut.stderr);
    assert.deepEqual(JSON.parse(setOut.stdout), {
      key: 'lightcode/decisions/auth',
      value: '-- dùng VNPay SDK v2',
      source: 'lightcode',
      project_id: 'proj1',
    });
    assert.equal(calls[0].body.key, 'lightcode/decisions/auth');

    // 2. get
    const getOut = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['store', 'get', '--key=lightcode/decisions/auth', '--project=proj1', '--json'],
    });
    assert.equal(getOut.code, 0, getOut.stderr);
    assert.equal(JSON.parse(getOut.stdout).found, true);

    // 3. list
    const listOut = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['store', 'list', '--prefix=lightcode/', '--project=proj1', '--json'],
    });
    assert.equal(listOut.code, 0, listOut.stderr);
    assert.equal(JSON.parse(listOut.stdout).count, 1);

    // 4. search
    const searchOut = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['store', 'search', '--query=JWT', '--prefix=lightcode/', '--project=proj1', '--json'],
    });
    assert.equal(searchOut.code, 0, searchOut.stderr);
    assert.equal(JSON.parse(searchOut.stdout).items[0].key, 'lightcode/decisions/auth');

    // 5. không có lệnh xóa
    const delOut = await runCli(url, {
      apiKey: 'acme-ak-secret',
      args: ['store', 'delete', '--key=lightcode/decisions/auth', '--project=proj1'],
    });
    assert.notEqual(delOut.code, 0);

    // 6. chưa đăng nhập -> báo Not logged in / aivin login
    const noAuth = await runCli(url, {
      args: ['store', 'get', '--key=decisions/auth', '--project=proj1', '--json'],
    });
    assert.notEqual(noAuth.code, 0);
    assert.match(noAuth.stderr, /not logged in|aivin login/i);
  });
});
