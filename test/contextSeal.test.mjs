import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Chạy context.mjs trong tiến trình con với thư mục nhà tạm: KHÔNG bao giờ đụng ~/.aivin thật
// (13/11/2026: bộ test chạy mã nguồn từng tự chuyển dạng tệp credentials thật).
const contextUrl = pathToFileURL(path.resolve('bin/lib/context.mjs')).href;

function run(home, script, env = {}) {
  const code = `const c = await import(${JSON.stringify(contextUrl)}); ${script}`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home, AIVIN_REMOTE_HOME: path.join(home, '.aivin'), AIVIN_CLI_BINARY: '', ...env },
  }).trim();
}

function tempHome(credentials) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-ctx-'));
  fs.mkdirSync(path.join(home, '.aivin'), { recursive: true });
  if (credentials) fs.writeFileSync(path.join(home, '.aivin', 'credentials'), JSON.stringify(credentials));
  return home;
}

const legacy = { base_url: 'https://api.example.test', api_key: 'wes-ak-legacy0000000000000000000000', sdk_endpoint: null };
const credFile = (home) => fs.readFileSync(path.join(home, '.aivin', 'credentials'), 'utf8');
const onWindows = process.platform === 'win32';

test('chạy từ mã nguồn: đọc được tệp chữ thường cũ nhưng KHÔNG tự chuyển dạng (bản cài cũ trên cùng máy vẫn đọc được)', () => {
  const home = tempHome(legacy);
  const before = credFile(home);
  assert.equal(run(home, "console.log(c.loadActiveContext('https://api.example.test')?.api_key)"), legacy.api_key);
  assert.equal(credFile(home), before);
});

test('chế độ tệp thường (máy không có kho bí mật): đăng nhập mới vẫn lưu chữ thường', () => {
  const home = tempHome();
  run(home, "c.saveActiveContext('https://api.example.test', 'wes-ak-plainfile11111111111111111', {});", { AIVIN_TOKEN_STORE: 'file' });
  assert.match(credFile(home), /plainfile1111/);
  assert.equal(run(home, "console.log(c.loadActiveContext('https://api.example.test')?.api_key)", { AIVIN_TOKEN_STORE: 'file' }), 'wes-ak-plainfile11111111111111111');
});

test('Windows: đăng nhập mới cất khoá vào DPAPI, tệp không còn chữ thường; bản phát hành tự chuyển tệp cũ; đăng xuất xoá', { skip: !onWindows }, () => {
  const home = tempHome();
  run(home, "c.saveActiveContext('https://api2.example.test', 'wes-ak-sealed22222222222222222222', {});");
  assert.doesNotMatch(credFile(home), /sealed2222/);
  assert.match(credFile(home), /api_key_sealed/);
  assert.equal(run(home, "console.log(c.loadActiveContext('https://api2.example.test')?.api_key)"), 'wes-ak-sealed22222222222222222222');

  const old = tempHome(legacy);
  assert.equal(run(old, "console.log(c.loadActiveContext('https://api.example.test')?.api_key)", { AIVIN_CLI_BINARY: '9.9.9' }), legacy.api_key);
  assert.doesNotMatch(credFile(old), /legacy0000/);
  assert.equal(run(old, "console.log(c.loadActiveContext('https://api.example.test')?.api_key)"), legacy.api_key);

  assert.equal(run(home, "console.log(c.clearActiveContext('https://api2.example.test'), c.loadActiveContext('https://api2.example.test'))"), 'true null');
});

test('tệp chép từ máy khác (bản mã không giải được) → coi như chưa đăng nhập, không lỗi', { skip: !onWindows }, () => {
  const home = tempHome({ version: 2, contexts: { x: { base_url: 'https://api3.example.test', api_key_sealed: { token_store: 'dpapi', token_enc: 'AAAA', token_account: 'api-key:x' } } } });
  assert.equal(run(home, "console.log(String(c.loadActiveContext('https://api3.example.test')))"), 'null');
});
