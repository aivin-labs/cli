import test from 'node:test';
import assert from 'node:assert/strict';
import { projectEnvEntries } from '../bin/lib/projectEnv.mjs';
import { browserCommand } from '../bin/lib/auth.mjs';
import { CAST_INPUT_ACTIONS } from '../bin/lib/remote/desktop/castInput.mjs';
import { AGENT_CALL_ENV, assertCommandAllowed, assertHumanCommand } from '../bin/lib/remote/sandbox.mjs';
import { DESKTOP_CAST_CSHARP } from '../bin/lib/remote/desktop/desktopCastSource.mjs';

const evil = { AIVIN_BASE_URL: 'https://evil', API_KEY: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '0', HTTPS_PROXY: 'http://evil', AIVIN_TOKEN_STORE: 'file', AIVIN_AUTO_UPDATE: '0', DB_URL: 'db' };

test('.env của thư mục hiện tại: lệnh nhạy cảm không đọc', () => {
  for (const command of ['remote', 'login', 'logout', 'open', 'update', 'server', 'desktop', 'do', 'share', 'whoami', 'key', 'uninstall']) {
    assert.deepEqual(projectEnvEntries([command], evil), {}, command);
  }
  assert.deepEqual(projectEnvEntries([], evil), {});
});

test('.env của dự án plugin: giữ biến dự án, bỏ biến đổi cách CLI tin cậy mạng', () => {
  assert.deepEqual(projectEnvEntries(['deploy'], evil), { AIVIN_BASE_URL: 'https://evil', API_KEY: 'x', DB_URL: 'db' });
});

test('openBrowser: URL không đi qua shell, chỉ http(s)', () => {
  const payload = 'https://a.vn/"&calc&"';
  const win = browserCommand(payload, 'win32', 'C:\\Windows');
  assert.equal(win.file, 'C:\\Windows\\System32\\rundll32.exe');
  assert.equal(win.args.length, 2);
  assert.equal(win.args[0], 'url.dll,FileProtocolHandler');
  assert.deepEqual(browserCommand('https://a.vn/$(id)', 'linux').args.length, 1);
  assert.equal(browserCommand('file:///c:/windows/system32/calc.exe', 'win32'), null);
  assert.equal(browserCommand('javascript:alert(1)', 'darwin'), null);
  assert.equal(browserCommand('không phải url', 'linux'), null);
});

test('paste_file không nhận từ mạng', () => {
  assert.equal(CAST_INPUT_ACTIONS.includes('paste_file'), false);
});

test('agent không được đổi luật, máy chủ, phiên bản CLI', () => {
  const agent = { [AGENT_CALL_ENV]: '1' };
  assert.throws(() => assertHumanCommand('remote', 'policy', agent), /người ngồi trước máy/);
  assert.throws(() => assertHumanCommand('aivin', 'server', agent));
  assert.throws(() => assertHumanCommand('aivin', 'update', agent));
  assert.doesNotThrow(() => assertHumanCommand('aivin', 'server', {}));
  assert.throws(() => assertCommandAllowed('aivin remote policy confirm never'));
  assert.throws(() => assertCommandAllowed('aivin server https://evil --force'));
  assert.throws(() => assertCommandAllowed('dir & C:\\tools\\aivin.exe update --to 1.0.1'));
  assert.doesNotThrow(() => assertCommandAllowed('git commit -m "aivin update docs"'));
  assert.doesNotThrow(() => assertCommandAllowed('echo aivin server'));
});

test('pipe khung thô chỉ cho tài khoản đang chạy', () => {
  assert.match(DESKTOP_CAST_CSHARP, /8 \* 1024 \* 1024, OwnerOnly\(\)\)/);
  assert.match(DESKTOP_CAST_CSHARP, /WellKnownSidType\.NetworkSid/);
});

test('agent không được ngắt người xem thay chủ máy', () => {
  assert.throws(() => assertHumanCommand('remote', 'disconnect', { [AGENT_CALL_ENV]: '1' }));
  assert.throws(() => assertCommandAllowed('aivin remote disconnect'));
});

test('mắt sóng có đủ phần tử trong hình linh vật và bộ điều khiển', async () => {
  const { BOT_XAML, BOT_EYES } = await import('../bin/lib/remote/mascot/bot.mjs');
  const { RIG_CS } = await import('../bin/lib/remote/mascot/rigSource.mjs');
  assert.ok(BOT_EYES.includes('wave'));
  for (const name of ['WaveL', 'WaveR', 'Eyes_wave_L', 'Eyes_wave_R']) assert.ok(BOT_XAML.includes(`x:Name="${name}"`), name);
  assert.match(RIG_CS, /public void RemoteWave\(bool on\)/);
});

test('tệp chạy không tự nạp .env, bunfig.toml của thư mục hiện tại', async () => {
  const { readFileSync } = await import('node:fs');
  const script = readFileSync(new URL('../scripts/build-binary.mjs', import.meta.url), 'utf8');
  assert.match(script, /autoloadDotenv: false/);
  assert.match(script, /autoloadBunfig: false/);
});
