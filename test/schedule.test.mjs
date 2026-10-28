import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { cronExpression, normalizeSpec, withoutCronEntry } = await import('../bin/lib/remote/schedule.mjs');
const { createUndoStore } = await import('../bin/lib/remote/undoStore.mjs');

test('chuẩn hoá lịch: tên, chu kỳ, giờ, thứ; chặn lệnh đụng .aivin', () => {
  assert.deepEqual(normalizeSpec({ name: 'backup', every: 'day', at: '2:30', command: 'echo hi' }), { name: 'backup', every: 'day', interval: 1, at: '2:30', weekday: 'mon', command: 'echo hi' });
  assert.throws(() => normalizeSpec({ name: 'bad name!', every: 'day', command: 'x' }), /name/);
  assert.throws(() => normalizeSpec({ name: 'a', every: 'year', command: 'x' }), /every/);
  assert.throws(() => normalizeSpec({ name: 'a', every: 'day', at: '25:00', command: 'x' }), /HH:MM/);
  assert.throws(() => normalizeSpec({ name: 'a', every: 'day', command: 'cat ~/.aivin/device-credentials.json' }), (e) => e.code === 'PROTECTED_PATH');
});

test('biểu thức cron theo chu kỳ', () => {
  const base = { name: 'x', command: 'c', interval: 1, at: '07:05', weekday: 'fri' };
  assert.equal(cronExpression({ ...base, every: 'minute', interval: 15 }), '*/15 * * * *');
  assert.equal(cronExpression({ ...base, every: 'hour', interval: 2 }), '0 */2 * * *');
  assert.equal(cronExpression({ ...base, every: 'day' }), '5 7 * * *');
  assert.equal(cronExpression({ ...base, every: 'week' }), '5 7 * * 5');
});

test('crontab: chỉ bỏ đúng mục của Aivin, giữ dòng của người dùng', () => {
  const text = '0 1 * * * /usr/bin/user-job\n# aivin:backup\n5 7 * * * /bin/sh "/h/.aivin/schedules/backup.sh"\n# aivin:other\n* * * * * x\n';
  const out = withoutCronEntry(text, 'backup');
  assert.equal(out, '0 1 * * * /usr/bin/user-job\n# aivin:other\n* * * * * x\n');
});

test('kho hoàn tác gọi trình xử lý tuỳ chỉnh (lịch) khi hoàn tác', async () => {
  const undo = createUndoStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'undo-')) });
  const calls = [];
  undo.registerHandler('schedule', async (item) => { calls.push(item); return { schedule_restored: item.name }; });
  undo.begin('g1', 'schedule').custom('schedule', { name: 'backup', previous: null });
  const res = await undo.undo('g1', [os.tmpdir()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'backup');
  assert.equal(res.undone, 1);
});
