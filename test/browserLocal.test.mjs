import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { browserIdFromName, browserIdFromRegQuery, findOnPath } = await import('../bin/lib/localBrowser.mjs');
const { applyDevicePolicy } = await import('../bin/lib/remote/cdpPolicy.mjs');
const { createBrowserTunnels } = await import('../bin/lib/remote/browserTunnel.mjs');
const { createTabGrouper, ensureTabGroupsExtension, groupTitle, TAB_GROUPS_SW_FILE } = await import('../bin/lib/remote/tabGroups.mjs');

async function fakeWsServer(onMessage = () => {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const seen = { headers: [], messages: [], sockets: [] };
  wss.on('connection', (ws, req) => {
    seen.headers.push(req.headers);
    seen.sockets.push(ws);
    ws.on('message', (data) => { seen.messages.push(String(data)); onMessage(ws, JSON.parse(String(data))); });
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, seen, close: () => new Promise((r) => wss.close(r)) };
}

const until = async (fn, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

test('trình duyệt mặc định Windows: đọc ProgId của UserChoice, UserChoiceLatest thắng; Chromium không nhầm Chrome', () => {
  const both = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '    ProgId    REG_SZ    MSEdgeHTM',
    '    Hash    REG_SZ    bf9nSzG2ArE=',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoiceLatest\\ProgId',
    '    ProgId    REG_SZ    ChromeHTML',
  ].join('\r\n');
  assert.equal(browserIdFromRegQuery(both), 'chrome');
  assert.equal(browserIdFromRegQuery(both.split('\r\n').slice(0, 3).join('\r\n')), 'edge');
  assert.equal(browserIdFromRegQuery('HKEY_CURRENT_USER\\...\\http\\UserChoice\r\n    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB'), null);
  assert.equal(browserIdFromRegQuery(''), null);
  assert.equal(browserIdFromName('ChromiumHTM'), 'chromium');
  assert.equal(browserIdFromName('BraveHTML'), 'brave');
  assert.equal(browserIdFromName('com.microsoft.edgemac'), 'edge');
  assert.equal(browserIdFromName('google-chrome.desktop'), 'chrome');
});

test('Linux: chỉ coi là đã cài khi tìm thấy tệp chạy trên PATH', () => {
  const exists = (p) => p === path.join('/opt/bin', 'chromium-browser');
  assert.equal(findOnPath(['chromium', 'chromium-browser'], { envPath: ['/usr/bin', '/opt/bin'].join(path.delimiter), exists }), path.join('/opt/bin', 'chromium-browser'));
  assert.equal(findOnPath(['microsoft-edge'], { envPath: '/usr/bin', exists }), null);
});

test('bộ lọc CDP: chặn cả miền Extensions.* (cửa sổ Aivin mở với cờ gỡ lỗi tiện ích)', () => {
  assert.match(applyDevicePolicy({ id: 1, method: 'Extensions.loadUnpacked', params: { path: 'C:\\x' } }, { downloadsDir: '/d' }).error, /not allowed/);
  assert.match(applyDevicePolicy({ id: 2, method: 'Extensions.getStorageItems', params: {} }, { downloadsDir: '/d' }).error, /not allowed/);
  assert.ok(applyDevicePolicy({ id: 3, method: 'Page.navigate', params: { url: 'https://example.com' } }, { downloadsDir: '/d' }).msg);
});

/** Đường hầm tới cửa sổ Aivin với trình duyệt giả + BE giả; trả lại các mảnh để test. */
async function openAivinTunnel({ label, onClose } = {}) {
  const backend = await fakeWsServer();
  const chrome = await fakeWsServer();
  const grouped = [];
  const tunnels = createBrowserTunnels({
    useDailyBrowser: false,
    serverUrl: backend.url.replace(/^ws/, 'http'), authorization: 'Bearer wes-key', browser: { id: 'edge', name: 'Microsoft Edge' },
    downloadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-dl-')), ensureBrowser: async () => ({ wsUrl: chrome.url }),
    createGrouper: ({ wsUrl }) => ({ add: (targetId, opts) => { grouped.push({ wsUrl, targetId, ...opts }); }, forget: () => {}, close: () => {} }),
  });
  const tunnelId = 'a1b2c3d4-0000-4000-8000-00000000000a';
  await tunnels.open({ tunnel_id: tunnelId, label }, { onClose });
  const be = backend.seen.sockets[0];
  const br = chrome.seen.sockets[0];
  const cleanup = async () => { tunnels.closeAll(); await backend.close(); await chrome.close(); };
  return { backend, chrome, be, br, tunnels, tunnelId, grouped, cleanup };
}

test('aivin browser qua bộ đường hầm chung: header Bearer, vẫn qua bộ lọc CDP (file:// bị chặn)', async () => {
  const t = await openAivinTunnel();
  assert.equal(t.backend.seen.headers[0].authorization, 'Bearer wes-key');
  t.be.send(JSON.stringify({ id: 7, method: 'Page.navigate', sessionId: 'S1', params: { url: 'file:///C:/Users/a/.aivin/credentials' } }));
  assert.ok(await until(() => t.backend.seen.messages.some((m) => m.includes('"id":7') && m.includes('not allowed'))));
  assert.equal(t.chrome.seen.messages.length, 0);
  await t.cleanup();
});

test('đích tiện ích: BE không chạy được lệnh trong phiên chrome-extension://, chỉ khởi động lại / gỡ phiên', async () => {
  const t = await openAivinTunnel();
  t.br.send(JSON.stringify({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'EXT1', targetInfo: { targetId: 'SW1', type: 'service_worker', url: `chrome-extension://abc/${TAB_GROUPS_SW_FILE}` }, waitingForDebugger: true },
  }));
  await until(() => t.backend.seen.messages.some((m) => m.includes('EXT1')));
  t.be.send(JSON.stringify({ id: 10, sessionId: 'EXT1', method: 'Runtime.evaluate', params: { expression: 'chrome.debugger.attach' } }));
  t.be.send(JSON.stringify({ id: 11, sessionId: 'EXT1', method: 'Runtime.runIfWaitingForDebugger' }));
  t.be.send(JSON.stringify({ id: 12, method: 'Target.attachToTarget', params: { targetId: 'SW1', flatten: true } }));
  assert.ok(await until(() => t.chrome.seen.messages.some((m) => m.includes('"id":11'))));
  await until(() => t.backend.seen.messages.some((m) => m.includes('"id":12')));
  assert.ok(t.backend.seen.messages.some((m) => m.includes('"id":10') && m.includes('not allowed on browser extensions')));
  assert.ok(t.backend.seen.messages.some((m) => m.includes('"id":12') && m.includes('extensions is not allowed')));
  assert.ok(!t.chrome.seen.messages.some((m) => m.includes('"id":10') || m.includes('"id":12')));
  // Đích tiện ích biết qua Target.getTargets cũng bị chặn gắn thẳng.
  t.be.send(JSON.stringify({ id: 13, method: 'Target.getTargets' }));
  await until(() => t.chrome.seen.messages.some((m) => m.includes('"id":13')));
  t.br.send(JSON.stringify({ id: 13, result: { targetInfos: [{ targetId: 'BG2', type: 'background_page', url: 'chrome-extension://zzz/bg.html' }] } }));
  await until(() => t.backend.seen.messages.some((m) => m.includes('BG2')));
  t.be.send(JSON.stringify({ id: 14, method: 'Target.attachToTarget', params: { targetId: 'BG2', flatten: true } }));
  assert.ok(await until(() => t.backend.seen.messages.some((m) => m.includes('"id":14') && m.includes('not allowed'))));
  await t.cleanup();
});

test('gom nhóm tab: tab BE mở (createTarget) + tab bật ra từ nó vào nhóm của đường hầm, tên theo nhiệm vụ; tab khác thì không', async () => {
  const t = await openAivinTunnel({ label: 'Tìm 3 bài nổi bật nhất trên Hacker News hôm nay' });
  t.be.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://news.ycombinator.com' } }));
  await until(() => t.chrome.seen.messages.length === 1);
  t.br.send(JSON.stringify({ id: 1, result: { targetId: 'T1' } }));
  t.br.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', openerId: 'T1', url: 'https://x.com' } } }));
  t.br.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'U9', type: 'page', url: 'https://mine.com' } } }));
  t.br.send(JSON.stringify({ id: 2, result: { targetId: 'U8' } })); // trả lời một lệnh không phải createTarget
  assert.ok(await until(() => t.grouped.length === 2));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.grouped.map((g) => g.targetId), ['T1', 'T2']);
  assert.equal(t.grouped[0].key, t.tunnelId);
  assert.equal(t.grouped[0].title, groupTitle('Tìm 3 bài nổi bật nhất trên Hacker News hôm nay'));
  assert.ok(t.grouped[0].title.length <= 28);
  await t.cleanup();
});

test('onClose: đóng chủ động → deliberate, BE tự rớt → không', async () => {
  const closes = [];
  const t = await openAivinTunnel({ onClose: (e) => closes.push(e) });
  t.tunnels.close(t.tunnelId);
  assert.ok(await until(() => closes.length === 1));
  assert.deepEqual(closes[0], { deliberate: true });
  await t.cleanup();

  const drops = [];
  const t2 = await openAivinTunnel({ onClose: (e) => drops.push(e) });
  t2.be.close();
  assert.ok(await until(() => drops.length === 1));
  assert.deepEqual(drops[0], { deliberate: false });
  await t2.cleanup();
});

test('tiện ích gom nhóm: ghi tệp một lần, manifest chỉ xin tabGroups + debugger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-ext-'));
  ensureTabGroupsExtension(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['tabGroups', 'debugger']);
  assert.equal(manifest.background.service_worker, TAB_GROUPS_SW_FILE);
  assert.match(fs.readFileSync(path.join(dir, TAB_GROUPS_SW_FILE), 'utf8'), /self\.aivinGroup/);
  const mtime = fs.statSync(path.join(dir, 'manifest.json')).mtimeMs;
  ensureTabGroupsExtension(dir);
  assert.equal(fs.statSync(path.join(dir, 'manifest.json')).mtimeMs, mtime);
  assert.equal(groupTitle(''), 'Aivin');
  assert.equal(groupTitle('  ngắn  '), 'ngắn');
});

/** Trình duyệt CDP giả cho bộ gom nhóm: tiện ích chưa nạp → loadUnpacked → service worker xuất hiện. */
function fakeBrowserHandler({ loadFails = false } = {}) {
  const state = { loaded: false, evaluations: [] };
  const handler = (ws, msg) => {
    const reply = (result) => ws.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result }));
    if (msg.method === 'Target.getTargets') {
      reply({ targetInfos: state.loaded ? [{ targetId: 'SW', type: 'service_worker', url: `chrome-extension://abc/${TAB_GROUPS_SW_FILE}` }] : [] });
    } else if (msg.method === 'Extensions.loadUnpacked') {
      if (loadFails) ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Method not available.' } }));
      else { state.loaded = true; reply({ id: 'abc' }); }
    } else if (msg.method === 'Target.attachToTarget') {
      reply({ sessionId: 'SWS' });
    } else if (msg.method === 'Runtime.evaluate') {
      state.evaluations.push(JSON.parse(/aivinGroup\((.*)\)$/.exec(msg.params.expression)[1]));
      reply({ result: { type: 'number', value: 42 } });
    } else {
      reply({});
    }
  };
  return { state, handler };
}

test('bộ gom nhóm: nạp tiện ích khi chưa có, tab sau của cùng nhiệm vụ vào lại nhóm cũ, nhiệm vụ khác màu khác', async () => {
  const fake = fakeBrowserHandler();
  const browser = await fakeWsServer(fake.handler);
  const g = createTabGrouper({ wsUrl: browser.url, extensionDir: '/tmp/ext' });
  await g.add('T1', { key: 'm1', title: 'Nhiệm vụ 1' });
  await g.add('T2', { key: 'm1', title: 'Nhiệm vụ 1' });
  await g.add('T3', { key: 'm2', title: 'Nhiệm vụ 2' });
  assert.ok(browser.seen.messages.some((m) => m.includes('Extensions.loadUnpacked') && m.includes('/tmp/ext')));
  assert.deepEqual(fake.state.evaluations.map((e) => [e.targetIds[0], e.groupId]), [['T1', null], ['T2', 42], ['T3', null]]);
  assert.notEqual(fake.state.evaluations[0].color, fake.state.evaluations[2].color);
  assert.equal(fake.state.evaluations[0].title, 'Nhiệm vụ 1');
  g.close();
  await browser.close();
});

test('bộ gom nhóm: trình duyệt không cho nạp tiện ích (mở bởi bản CLI cũ) → báo một lần rồi tắt, không ném lỗi', async () => {
  const fake = fakeBrowserHandler({ loadFails: true });
  const browser = await fakeWsServer(fake.handler);
  const reasons = [];
  const g = createTabGrouper({ wsUrl: browser.url, extensionDir: '/tmp/ext', onUnavailable: (e) => reasons.push(e.message) });
  await g.add('T1', { key: 'm1' });
  await g.add('T2', { key: 'm1' });
  assert.deepEqual(reasons, ['Method not available.']);
  assert.equal(g.isDisabled(), true);
  assert.equal(fake.state.evaluations.length, 0);
  g.close();
  await browser.close();
});
