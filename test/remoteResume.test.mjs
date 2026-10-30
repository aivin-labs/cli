import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createCallLedger, CallState } = await import('../bin/lib/remote/callLedger.mjs');
const { createIdempotentRunner } = await import('../bin/lib/remote/idempotency.mjs');
const { parseScutilProxy, parseWindowsInternetSettings, parseWindowsProxyServer, resolveProxy, shouldBypass } = await import('../bin/lib/remote/netProxy.mjs');
const { windowsTaskXml, windowsWatchdogScript } = await import('../bin/lib/remote/autoStart.mjs');
const { createKeepAwake, keepAwakeCommand } = await import('../bin/lib/remote/keepAwake.mjs');

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-resume-')), name);

test('sổ lời gọi: trùng call_id không chạy lại, kết quả chưa gửi giữ trên đĩa và nạp lại sau khi daemon khởi động lại', () => {
  const file = tmpFile('outbox.json');
  const ledger = createCallLedger({ file });
  assert.equal(ledger.admit({ call_id: 'a' }), null);
  assert.equal(ledger.admit({ call_id: 'a' }).state, CallState.RUNNING);
  assert.deepEqual(ledger.heldIds(), ['a']);

  ledger.finish('a', { call_id: 'a', ok: true, result: { n: 1 } }, { persistNow: true });
  assert.ok(fs.existsSync(file));
  const reloaded = createCallLedger({ file });
  assert.deepEqual(reloaded.unsent(), [{ call_id: 'a', ok: true, result: { n: 1 } }]);
  assert.deepEqual(reloaded.heldIds(), ['a']);
  assert.equal(reloaded.admit({ call_id: 'a' }).state, CallState.DONE);

  reloaded.markSent('a');
  assert.equal(fs.existsSync(file), false, 'gửi xong thì bỏ khỏi đĩa');
  assert.deepEqual(reloaded.heldIds(), []);
  assert.deepEqual(reloaded.reopen('a'), { call_id: 'a', ok: true, result: { n: 1 } }, 'BE gửi lại lời gọi đã xong → trả lại kết quả cũ');
});

test('sổ lời gọi: BE báo không còn ai chờ → bỏ kết quả; quá hạn giữ thì tự dọn', () => {
  let t = 1_000_000;
  const file = tmpFile('outbox.json');
  const ledger = createCallLedger({ file, now: () => t });
  ledger.admit({ call_id: 'x' });
  ledger.finish('x', { call_id: 'x', ok: false, error: 'Cancelled' }, { persistNow: true });
  ledger.drop(['x']);
  assert.deepEqual(ledger.unsent(), []);
  assert.equal(fs.existsSync(file), false);

  ledger.admit({ call_id: 'y' });
  ledger.finish('y', { call_id: 'y', ok: true }, { persistNow: true });
  t += 16 * 60_000;
  ledger.prune();
  assert.deepEqual(ledger.unsent(), []);
});

test('chống làm trùng bền qua lần khởi động lại: bước xong trả kết quả cũ, bước đang chạy lúc daemon chết → INTERRUPTED, bước hỏng được chạy lại', async () => {
  const file = tmpFile('idem.jsonl');
  let runs = 0;
  const run = async (call) => { runs++; return { tool: { name: call.tool }, outcome: call.args?.fail ? { ok: false, error: 'x' } : { ok: true, result: { wrote: call.args.path } } }; };
  const first = createIdempotentRunner(run, () => false, { file });
  await first({ call_id: '1', tool: 'fs.write', idem_key: 'done', args: { path: 'a.txt' } });
  await first({ call_id: '2', tool: 'fs.write', idem_key: 'bad', args: { fail: true } });
  fs.appendFileSync(file, JSON.stringify({ k: 'cut', s: 'start', at: Date.now() }) + '\n');
  assert.equal(runs, 2);

  const second = createIdempotentRunner(run, () => false, { file });
  const done = await second({ call_id: '3', tool: 'fs.write', idem_key: 'done', args: { path: 'a.txt' } });
  assert.deepEqual(done.outcome.result, { wrote: 'a.txt', deduplicated: true });
  const cut = await second({ call_id: '4', tool: 'fs.write', idem_key: 'cut', args: {} });
  assert.equal(cut.outcome.error_code, 'INTERRUPTED');
  await second({ call_id: '5', tool: 'fs.write', idem_key: 'bad', args: { path: 'b.txt' } });
  assert.equal(runs, 3, 'chỉ bước hỏng lần trước được chạy lại');
});

test('proxy: thứ tự --proxy → HTTPS_PROXY → hệ thống, "none" đi thẳng; bỏ qua localhost / NO_PROXY / <local>', () => {
  const sys = () => ({ server: 'http://sys:8080', bypass: '<local>;*.corp.vn', pac: '' });
  assert.equal(resolveProxy({ explicit: 'proxy.corp:3128', env: {}, readSystem: sys }).url, 'http://proxy.corp:3128');
  assert.equal(resolveProxy({ explicit: 'none', env: { HTTPS_PROXY: 'http://e:1' }, readSystem: sys }).url, '');
  assert.equal(resolveProxy({ env: { HTTPS_PROXY: 'http://e:1' }, readSystem: sys }).url, 'http://e:1');
  const fromSys = resolveProxy({ env: {}, readSystem: sys });
  assert.equal(fromSys.url, 'http://sys:8080');
  assert.equal(fromSys.source, 'system');

  assert.ok(shouldBypass('http://localhost:3001/device', ''));
  assert.ok(shouldBypass('https://intranet/device', '<local>'));
  assert.ok(shouldBypass('https://api.corp.vn/x', '*.corp.vn'));
  assert.ok(shouldBypass('https://10.1.2.3/x', '10.*'));
  assert.equal(shouldBypass('https://brain.aivin.cloud/device', '<local>;*.corp.vn;10.*'), false);
});

test('proxy hệ thống: đọc Internet Settings của Windows và scutil của macOS', () => {
  assert.equal(parseWindowsProxyServer('http=p1:80;https=p2:8443'), 'http://p2:8443');
  assert.equal(parseWindowsProxyServer('p3:3128'), 'http://p3:3128');
  const win = parseWindowsInternetSettings([
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    proxy.corp:8080',
    '    ProxyOverride    REG_SZ    *.corp.vn;<local>',
  ].join('\r\n'));
  assert.deepEqual({ enabled: win.enabled, server: win.server, override: win.override }, { enabled: true, server: 'http://proxy.corp:8080', override: '*.corp.vn;<local>' });
  assert.equal(parseWindowsInternetSettings('    ProxyEnable    REG_DWORD    0x0').enabled, false);
  const mac = parseScutilProxy('<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n  HTTPSEnable : 1\n  HTTPSPort : 8443\n  HTTPSProxy : mp.corp\n}');
  assert.deepEqual(mac, { server: 'http://mp.corp:8443', override: '*.local', pac: '' });
});

test('tự khởi động Windows: VBS giữ chạy dừng khi mã thoát 0, tác vụ chạy lúc đăng nhập trong phiên tương tác, không dừng khi chạy pin', () => {
  const vbs = windowsWatchdogScript(['C:\\Users\\Thắng\\aivin.exe', 'remote', 'start', '--quiet', '--dir', 'C:\\a b']);
  assert.match(vbs, /sh\.Run\("""C:\\Users\\Thắng\\aivin\.exe"" ""remote"" ""start"" ""--quiet"" ""--dir"" ""C:\\a b""", 0, True\)/);
  assert.match(vbs, /If rc = 0 Then Exit Do/);
  const xml = windowsTaskXml({ userId: 'CORP\\a&b', watchdogFile: 'C:\\Users\\x\\.aivin\\aivin-remote.vbs' });
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<UserId>CORP\\a&amp;b<\/UserId>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});

test('giữ máy thức: chỉ bật khi bận đủ lâu, thả sau khi rảnh, mỗi hệ điều hành một lệnh', async () => {
  assert.equal(keepAwakeCommand('win32').cmd, 'powershell.exe');
  assert.deepEqual(keepAwakeCommand('darwin', { pid: 42 }).args, ['-i', '-w', '42']);
  assert.equal(keepAwakeCommand('linux', { linuxInhibit: () => false }), null);
  assert.equal(keepAwakeCommand('linux', { linuxInhibit: () => true }).cmd, 'systemd-inhibit');

  const spawned = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = { end: () => { child.ended = true; } };
    child.kill = () => { child.killed = true; child.emit('exit'); };
    spawned.push(child);
    return child;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const awake = createKeepAwake({ platform: 'darwin', spawnImpl, startDelayMs: 20, idleMs: 20 });
  awake.hold();
  awake.release();
  await wait(40);
  assert.equal(spawned.length, 0, 'bận ngắn không bật');
  awake.hold();
  awake.hold();
  await wait(40);
  assert.equal(spawned.length, 1);
  assert.ok(awake.active());
  awake.release();
  await wait(40);
  assert.ok(awake.active(), 'còn một việc đang chạy');
  awake.release();
  await wait(40);
  assert.equal(awake.active(), false);
  assert.ok(spawned[0].killed);
  awake.close();
});
