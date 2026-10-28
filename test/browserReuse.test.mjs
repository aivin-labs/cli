import { test } from 'node:test';
import assert from 'node:assert/strict';

const { debugPortFromCommandLine, browserPortFromProcesses } = await import('../bin/lib/remote/dailyBrowser.mjs');

const dir = 'C:\\Users\\a\\.aivin\\browser-profile';

test('cổng gỡ lỗi lấy từ dòng lệnh chỉ khi đúng thư mục hồ sơ Aivin', () => {
  assert.equal(debugPortFromCommandLine(`"C:\\Edge\\msedge.exe" --remote-debugging-port=9223 --user-data-dir=${dir} --no-first-run`, dir), 9223);
  assert.equal(debugPortFromCommandLine(`msedge.exe --user-data-dir="${dir}\\" --remote-debugging-port=9224`, dir), 9224);
  assert.equal(debugPortFromCommandLine(`msedge.exe --remote-debugging-port=9222 --user-data-dir=C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\User Data`, dir), null);
  assert.equal(debugPortFromCommandLine(`msedge.exe --remote-debugging-port=0 --user-data-dir=${dir}`, dir), null);
  assert.equal(debugPortFromCommandLine('msedge.exe --type=renderer', dir), null);
});

test('dùng lại cửa sổ Aivin đang mở khi không có DevToolsActivePort — bỏ cổng không còn nghe', async () => {
  const list = async () => [
    `msedge.exe --remote-debugging-port=9222 --user-data-dir=${dir}`,
    `msedge.exe --remote-debugging-port=9223 --user-data-dir=${dir}`,
    'chrome.exe --remote-debugging-port=9225 --user-data-dir=C:\\daily',
  ];
  assert.equal(await browserPortFromProcesses(dir, { list, isOpen: async (p) => p === 9223 }), 9223);
  assert.equal(await browserPortFromProcesses(dir, { list, isOpen: async () => false }), null);
});
