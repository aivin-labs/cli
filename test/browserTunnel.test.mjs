import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createBrowserTunnels, matchesDownloadName } = await import('../bin/lib/remote/browserTunnel.mjs');
const { buildTools } = await import('../bin/lib/remote/toolHandlers.mjs');

/** Máy chủ WebSocket giả trên cổng ngẫu nhiên — ghi lại header + tin nhận được. */
async function fakeWsServer() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const seen = { headers: [], messages: [], sockets: [] };
  wss.on('connection', (ws, req) => {
    seen.headers.push(req.headers);
    seen.url = req.url;
    seen.sockets.push(ws);
    ws.on('message', (data) => seen.messages.push(String(data)));
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, seen, close: () => new Promise((r) => wss.close(r)) };
}

const until = async (fn, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

test('tên tệp tải: đúng tên hoặc bản Chrome tự đánh số, không nhận tên khác', () => {
  assert.equal(matchesDownloadName('hoa-don.pdf', 'hoa-don.pdf'), true);
  assert.equal(matchesDownloadName('hoa-don (2).pdf', 'hoa-don.pdf'), true);
  assert.equal(matchesDownloadName('hoa-don (x).pdf', 'hoa-don.pdf'), false);
  assert.equal(matchesDownloadName('hoa-don-cu.pdf', 'hoa-don.pdf'), false);
});

test('mở đường hầm: xác thực bằng token MÁY, chuyển khung hai chiều, BE đóng thì đóng phía trình duyệt', async () => {
  const backend = await fakeWsServer();
  const chrome = await fakeWsServer();
  const tunnels = createBrowserTunnels({
    useDailyBrowser: false,
    serverUrl: backend.url.replace(/^ws/, 'http'), deviceToken: 'wes-dk-secret', browser: { id: 'chrome', name: 'Google Chrome' },
    downloadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-dl-')), ensureBrowser: async () => ({ wsUrl: chrome.url }),
  });
  const out = await tunnels.open({ tunnel_id: 'a1b2c3d4-0000-4000-8000-000000000001' }, {});
  assert.equal(out.browser, 'Google Chrome');
  assert.equal(backend.seen.headers[0].authorization, 'Device wes-dk-secret');
  assert.match(backend.seen.url, /\/browser-tunnel\/external\?tunnel_id=a1b2c3d4-/);
  backend.seen.sockets[0].send('{"id":1,"method":"Target.getTargets"}');
  assert.ok(await until(() => chrome.seen.messages.includes('{"id":1,"method":"Target.getTargets"}')));
  chrome.seen.sockets[0].send('{"id":1,"result":{}}');
  assert.ok(await until(() => backend.seen.messages.includes('{"id":1,"result":{}}')));
  assert.equal(tunnels.liveCount(), 1);
  backend.seen.sockets[0].close();
  assert.ok(await until(() => chrome.seen.sockets[0].readyState === 3));
  assert.ok(await until(() => tunnels.liveCount() === 0));
  await backend.close();
  await chrome.close();
});

test('mở đường hầm: tunnel_id lạ bị từ chối, không mở trình duyệt', async () => {
  let launched = false;
  const tunnels = createBrowserTunnels({ useDailyBrowser: false, serverUrl: 'http://127.0.0.1:1', deviceToken: 't', ensureBrowser: async () => { launched = true; return { wsUrl: '' }; } });
  await assert.rejects(tunnels.open({ tunnel_id: '../x' }, {}), /Invalid tunnel_id/);
  assert.equal(launched, false);
});

test('đọc tệp tải: chỉ trong thư mục tải của Aivin, chọn bản mới nhất, đọc theo khúc', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-dl-'));
  const since = Date.now();
  fs.writeFileSync(path.join(dir, 'bao-cao.csv'), 'cu');
  const old = new Date(since - 60_000);
  fs.utimesSync(path.join(dir, 'bao-cao.csv'), old, old);
  fs.writeFileSync(path.join(dir, 'bao-cao (1).csv'), 'a,b\n1,2\n');
  const tunnels = createBrowserTunnels({ useDailyBrowser: false, serverUrl: 'http://x', deviceToken: 't', downloadsDir: dir });
  const got = await tunnels.readDownload({ name: 'bao-cao.csv', since, offset: 0, length: 4 }, {});
  assert.equal(got.name, 'bao-cao (1).csv');
  assert.equal(got.size, 8);
  assert.equal(Buffer.from(got.content, 'base64').toString(), 'a,b\n');
  assert.equal(got.eof, false);
  await assert.rejects(tunnels.readDownload({ name: '../device-credentials.json', since: 0 }, {}), /Invalid file name/);
});

test('danh mục: công cụ trình duyệt là nội bộ, chỉ có khi máy có trình duyệt', () => {
  const env = { roots: [os.tmpdir()], binaries: [], projects: [] };
  assert.equal(buildTools(env).some((t) => t.name.startsWith('browser.')), false);
  const tools = buildTools({ ...env, browserTunnels: { open: () => ({}), readDownload: () => ({}) } }).filter((t) => t.name.startsWith('browser.'));
  assert.deepEqual(tools.map((t) => t.name), ['browser.open_tunnel', 'browser.read_download']);
  assert.ok(tools.every((t) => t.internal));
});

test('thông báo: chỉ nhận đường dẫn http(s); công cụ notify.show là nội bộ, luôn có', async () => {
  const { safeNotifyUrl } = await import('../bin/lib/remote/notify.mjs');
  assert.equal(safeNotifyUrl('https://wes.aivin.vn/?sid=1'), 'https://wes.aivin.vn/?sid=1');
  assert.equal(safeNotifyUrl('file:///C:/x.exe'), '');
  assert.equal(safeNotifyUrl("javascript:alert(1)"), '');
  const tool = buildTools({ roots: [os.tmpdir()], binaries: [], projects: [] }).find((t) => t.name === 'notify.show');
  assert.ok(tool?.internal);
});
