import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createWatchManager, WatchKind } = await import('../bin/lib/remote/deviceWatches.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('tệp mới trong thư mục (lọc mẫu tên) → gom thành MỘT sự kiện; tệp sai mẫu bỏ qua', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  fs.mkdirSync(path.join(root, 'HoaDon'));
  const events = [];
  const m = createWatchManager({ roots: [root], emit: (e) => events.push(e), coalesceMs: 400, settleMs: 150 });
  const r = m.set([{ id: 'w1', kind: WatchKind.FILE_CREATED, path: 'HoaDon', pattern: '*.pdf' }]);
  assert.deepEqual(r.errors, []);
  await sleep(200);
  fs.writeFileSync(path.join(root, 'HoaDon', 'a.pdf'), 'x');
  fs.writeFileSync(path.join(root, 'HoaDon', 'b.pdf'), 'y');
  fs.writeFileSync(path.join(root, 'HoaDon', 'note.txt'), 'z');
  await sleep(1500);
  m.closeAll();
  assert.equal(events.length, 1);
  assert.equal(events[0].watch_id, 'w1');
  assert.deepEqual(events[0].items.map((i) => path.basename(i.path)).sort(), ['a.pdf', 'b.pdf']);
});

test('dòng log MỚI khớp mẫu → sự kiện kèm dòng; dòng cũ có sẵn không tính', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlog-'));
  const log = path.join(root, 'app.log');
  fs.writeFileSync(log, 'ERROR old line\n');
  const events = [];
  const m = createWatchManager({ roots: [root], emit: (e) => events.push(e), coalesceMs: 300 });
  m.set([{ id: 'w2', kind: WatchKind.LOG_MATCH, path: 'app.log', pattern: 'error|fatal' }]);
  await sleep(200);
  fs.appendFileSync(log, 'info ok\nFATAL disk full\n');
  await sleep(1200);
  m.closeAll();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].items.map((i) => i.line), ['FATAL disk full']);
});

test('đặt lại danh sách: bỏ theo dõi không còn; đường ngoài vùng / không tồn tại báo lỗi, không làm hỏng cái khác', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchset-'));
  fs.mkdirSync(path.join(root, 'A'));
  const m = createWatchManager({ roots: [root], emit: () => {} });
  const r1 = m.set([{ id: 'a', kind: 'file_created', path: 'A' }, { id: 'out', kind: 'file_created', path: '../..' }, { id: 'none', kind: 'file_created', path: 'missing' }]);
  assert.deepEqual(r1.active, ['a']);
  assert.deepEqual(r1.errors.map((e) => e.id).sort(), ['none', 'out']);
  const r2 = m.set([]);
  assert.deepEqual(r2.active, []);
  m.closeAll();
});
