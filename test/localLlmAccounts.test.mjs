import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { accountFingerprint, localLlmAccounts } from '../bin/lib/remote/localLlmAccounts.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-acct-'));
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'a@b.c' } }));
fs.mkdirSync(path.join(home, '.codex'));
fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-9' } }));
fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'installation_id'), 'inst-7\n');

test('băm tài khoản từng agent từ tệp đăng nhập — không lộ id gốc', () => {
  const out = localLlmAccounts(['claude', 'codex', 'antigravity'], { env: {}, home });
  assert.deepEqual(out, {
    claude: accountFingerprint('claude', 'uuid-1'),
    codex: accountFingerprint('codex', 'acct-9'),
    antigravity: accountFingerprint('antigravity', 'install:inst-7'),
  });
  for (const v of Object.values(out)) assert.match(v, /^[a-f0-9]{16}$/);
  assert.ok(!JSON.stringify(out).includes('uuid-1') && !JSON.stringify(out).includes('a@b.c'));
});

test('cùng tài khoản → cùng dấu; khác agent cùng id → khác dấu', () => {
  assert.equal(accountFingerprint('claude', 'x'), accountFingerprint('claude', 'x'));
  assert.notEqual(accountFingerprint('claude', 'x'), accountFingerprint('codex', 'x'));
});

test('CLAUDE_CONFIG_DIR / CODEX_HOME thắng thư mục nhà; đọc không được → bỏ agent; không agent nào → undefined', () => {
  const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-acct-alt-'));
  fs.writeFileSync(path.join(alt, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-2' } }));
  assert.equal(localLlmAccounts(['claude'], { env: { CLAUDE_CONFIG_DIR: alt }, home }).claude, accountFingerprint('claude', 'uuid-2'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-acct-empty-'));
  assert.equal(localLlmAccounts(['claude', 'codex', 'antigravity'], { env: {}, home: empty }), undefined);
  assert.equal(localLlmAccounts(['unknown'], { env: {}, home }), undefined);
});
