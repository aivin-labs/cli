import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-lock-'));
const { CAST_ACTION_FILE, CAST_PERMISSIONS_FILE, CAST_SESSION_FILE, checkCastAction, isCastLocked, lockCast, requestCastStop, unlockCast } = await import('../bin/lib/remote/desktop/castAuth.mjs');

test('khoá theo cả máy: bấm ngắt thì khoá, đồng ý thì mở', () => {
  assert.equal(isCastLocked(), false);
  lockCast({ viewerDevice: 'a"b' });
  assert.equal(isCastLocked(), true);
  unlockCast();
  assert.equal(isCastLocked(), false);
});

test('tệp chặn từ bản CLI cũ vẫn tính là đang khoá', () => {
  fs.writeFileSync(CAST_PERMISSIONS_FILE, JSON.stringify({ blockedViewers: [{ viewerId: 'x' }] }));
  assert.equal(isCastLocked(), true);
  unlockCast();
});

test('tệp hành động hỏng (khay cũ gặp dấu ngoặc kép trong tên): vẫn ngắt', () => {
  fs.writeFileSync(CAST_ACTION_FILE, '{"action":"stop_and_block","viewer_device":"a"b"}');
  assert.equal(checkCastAction().action, 'stop_and_block');
  assert.equal(fs.existsSync(CAST_ACTION_FILE), false);
  assert.equal(checkCastAction(), null);
});

test('lệnh ngắt: không có phiên thì báo, có phiên thì gửi', () => {
  assert.equal(requestCastStop({ daemonAlive: () => true }), false);
  fs.writeFileSync(CAST_SESSION_FILE, '{}');
  // Tệp phiên sót lại mà daemon không chạy: không có ai để ngắt.
  assert.equal(requestCastStop({ daemonAlive: () => false }), false);
  fs.writeFileSync(CAST_SESSION_FILE, '{}');
  assert.equal(requestCastStop({ daemonAlive: () => true }), true);
  assert.equal(checkCastAction().action, 'stop_and_block');
});
