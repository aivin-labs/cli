import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lightcodeAccountSync, bodyFor, buildAccountSyncTools, ACCOUNT_SYNC_TOOL } from '../bin/lib/remote/lightcodeAccountSync.mjs';
import { createCallLedger } from '../bin/lib/remote/callLedger.mjs';

const connector = { port: 4611, key: 'main-key' };
const answer = (status, body, seen) => async (url, init) => {
  seen?.push({ url, init, body: JSON.parse(init.body) });
  return { ok: status < 400, status, json: async () => body };
};
const memberEnv = { runAs: { uid: 10001, gid: 10000, home: '/home/u1', name: 'u1' } };

test('máy cá nhân: gọi đúng đường dẫn, khoá chính, không có run_as', async () => {
  const seen = [];
  const res = await lightcodeAccountSync({ op: 'list' }, {}, { connector, fetchImpl: answer(200, { accounts: [] }, seen) });
  assert.deepEqual(res, { ok: true, data: { accounts: [] } });
  assert.equal(seen[0].url, 'http://127.0.0.1:4611/connector/v1/aivin/accounts/list');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer main-key');
  assert.equal('run_as' in seen[0].body, false);
});

test('Cloud Computer: run_as chỉ gồm uid/gid/home của vùng, không lấy từ args', async () => {
  const seen = [];
  const headless = () => connector;
  await lightcodeAccountSync({ op: 'export', provider: 'claude', recipient_key: { key_id: 'a' }, run_as: { uid: 1, gid: 1, home: '/root' } }, memberEnv, { headless, fetchImpl: answer(200, { sealed: {} }, seen) });
  assert.deepEqual(seen[0].body.run_as, { uid: 10001, gid: 10000, home: '/home/u1' });
  assert.deepEqual(seen[0].body, { provider: 'claude', recipient_key: { key_id: 'a' }, run_as: { uid: 10001, gid: 10000, home: '/home/u1' } });
});

test('Cloud Computer: thiếu daemon LightCode → not_running; run_as hỏng → run_as_required', async () => {
  assert.equal((await lightcodeAccountSync({ op: 'list' }, memberEnv, { headless: () => null })).reason, 'not_running');
  assert.equal((await lightcodeAccountSync({ op: 'list' }, { runAs: { uid: 0, gid: 0, home: '/root' } }, { connector })).reason, 'run_as_required');
});

test('từ chối trả mã lý do, không ném, không kèm nội dung gửi', async () => {
  const reason = async (status, body) => lightcodeAccountSync({ op: 'import', sealed: { data: 'SECRET' } }, {}, { connector, fetchImpl: answer(status, body) });
  assert.deepEqual(await reason(409, { code: 'not_synced', error: 'x' }), { ok: false, reason: 'not_synced', status: 409 });
  assert.equal((await reason(404, {})).reason, 'outdated');
  assert.equal((await reason(410, { code: 'key_expired' })).reason, 'key_expired');
  assert.equal((await reason(500, { code: 'weird' })).reason, 'failed');
  assert.equal(JSON.stringify(await reason(400, { code: 'bad_payload' })).includes('SECRET'), false);
  assert.equal((await lightcodeAccountSync({ op: 'nope' }, {}, { connector })).reason, 'bad_op');
  assert.equal((await lightcodeAccountSync({ op: 'list' }, {}, { connector, fetchImpl: async () => { throw new Error('down'); } })).reason, 'not_running');
});

test('bodyFor chỉ cho đi các trường đã định', () => {
  assert.deepEqual(bodyFor('list', { account_id: 'x' }), {});
  assert.deepEqual(bodyFor('export', { account_id: 'a', provider: 'codex', recipient_key: 'k', evil: 1 }), { account_id: 'a', provider: 'codex', recipient_key: 'k' });
  assert.deepEqual(bodyFor('import', { sealed: { v: 1 }, replace: 'yes', evil: 1 }), { sealed: { v: 1 } });
  assert.deepEqual(bodyFor('import', { sealed: { v: 1 }, replace: true }), { sealed: { v: 1 }, replace: true });
});

test('công cụ nội bộ + sensitive (không vào danh mục, không ghi đĩa)', () => {
  const [tool] = buildAccountSyncTools();
  assert.equal(tool.name, ACCOUNT_SYNC_TOOL);
  assert.equal(tool.internal, true);
  assert.equal(tool.sensitive, true);
});

test('sổ lời gọi: kết quả volatile không bao giờ xuống đĩa, giao xong thì bỏ nội dung', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'outbox.json');
  const ledger = createCallLedger({ file, debounceMs: 0 });
  ledger.admit({ call_id: 'v1' });
  ledger.finish('v1', { call_id: 'v1', ok: true, result: { data: { sealed: 'SECRET' } }, duration_ms: 5 }, { persistNow: true, volatile: true });
  ledger.persist({ sync: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal(ledger.unsent().length, 1, 'vẫn giữ trong bộ nhớ để gửi lại khi nối lại');
  ledger.markSent('v1');
  assert.equal(JSON.stringify(ledger.reopen('v1')).includes('SECRET'), false);
});
