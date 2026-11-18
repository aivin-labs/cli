import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { capturePreview, findPreviewBrowser, normalizePreviewArgs } from '../bin/lib/remote/agentPreview.mjs';

test('normalizePreviewArgs: chỉ địa chỉ trên máy này, đường dẫn bắt đầu bằng /, khổ theo thiết bị', () => {
  const p = normalizePreviewArgs({ argv: ['npm', 'run', 'dev'], url: 'http://localhost:5173', shots: [{ id: 'SCREEN-01', path: '/login', device: 'mobile' }, { id: 'SCREEN-02', path: '/' }] });
  assert.equal(p.shots[0].url, 'http://localhost:5173/login');
  assert.deepEqual([p.shots[0].width, p.shots[0].height], [390, 844]);
  assert.equal(p.shots[1].width, 1280);
  assert.throws(() => normalizePreviewArgs({ argv: ['x'], url: 'http://example.com', shots: [{ path: '/' }] }), /localhost/);
  assert.throws(() => normalizePreviewArgs({ argv: ['x'], url: 'http://localhost:1', shots: [{ path: 'login' }] }), /start with \//);
  assert.throws(() => normalizePreviewArgs({ argv: [], url: 'http://localhost:1', shots: [{ path: '/' }] }), /argv/);
  assert.throws(() => normalizePreviewArgs({ argv: ['x'], url: 'http://localhost:1', shots: [] }), /shots/);
});

test('capturePreview: địa chỉ đã có app khác trả lời → từ chối, không chạy lệnh', async () => {
  let spawned = false;
  const r = await capturePreview({ argv: ['node', 'x.js'], url: 'http://localhost:4999', shots: [{ path: '/' }] }, {
    cwd: os.tmpdir(), browser: 'chrome', responds: async () => true, spawnApp: () => { spawned = true; throw new Error('x'); },
  });
  assert.match(r.error, /already answers/);
  assert.equal(spawned, false);
});

test('capturePreview: app thoát trước khi lên → báo lỗi kèm mã thoát', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
  const r = await capturePreview({ argv: [process.execPath, '-e', 'process.exit(3)'], url: 'http://127.0.0.1:4998', ready_timeout_ms: 5000, shots: [{ path: '/' }] }, {
    cwd, browser: 'chrome', responds: async () => false,
  });
  assert.match(r.error, /exited \(code 3\)/);
});

const browser = findPreviewBrowser();
test('capturePreview: chạy app thật trong thư mục job, chụp bằng trình duyệt thật, tắt app', { skip: !browser && 'no Chrome / Edge' }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-app-'));
  const port = await new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(cwd, 'app.js'), `require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end('<h1>Đặt bàn</h1><button>Gửi</button>' + q.url); }).listen(${port}, '127.0.0.1');`);
  const r = await capturePreview({ argv: [process.execPath, 'app.js'], url: `http://127.0.0.1:${port}`, ready_timeout_ms: 20000, shots: [{ id: 'SCREEN-01', path: '/dat-ban' }] }, { cwd, browser });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.shots.length, 1);
  const png = Buffer.from(r.shots[0].png_base64, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  // App đã bị tắt.
  await new Promise((res) => setTimeout(res, 500));
  const still = await new Promise((resolve) => { const q = http.get(`http://127.0.0.1:${port}/`, () => resolve(true)); q.on('error', () => resolve(false)); });
  assert.equal(still, false);
});
