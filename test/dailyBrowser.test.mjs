import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createCdpMux, findDailyBrowser, parseDevToolsActivePort } = await import('../bin/lib/remote/dailyBrowser.mjs');
const { createBrowserTunnels } = await import('../bin/lib/remote/browserTunnel.mjs');

const DL = path.join(os.tmpdir(), 'aivin-dl-test');
const until = async (fn, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

/**
 * Chrome giả: mỗi kết nối được ghi lại; `Target.attachToBrowserTarget` → phiên B<n>; `Target.setAutoAttach` trên phiên B → gắn tab của người dùng
 * (T-user); `Target.createTarget` → báo gắn tab mới TRƯỚC rồi mới trả kết quả (như Chrome thật); lệnh khác trả `{ ok: method }`.
 */
async function fakeChrome({ answerVersion = true, tabModel = false } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const seen = { connections: 0, messages: [] };
  let browserSessions = 0;
  let created = 0;
  wss.on('connection', (ws) => {
    seen.connections++;
    const send = (m) => ws.send(JSON.stringify(m));
    seen.push = send;
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      seen.messages.push(msg);
      if (msg.method === 'Browser.getVersion') { if (answerVersion) send({ id: msg.id, result: { product: 'Chrome/156' } }); return; }
      if (msg.method === 'Target.attachToBrowserTarget') { send({ id: msg.id, result: { sessionId: `B${++browserSessions}` } }); return; }
      if (msg.method === 'Target.setAutoAttach' && /^B/.test(msg.sessionId)) {
        send({ method: 'Target.attachedToTarget', sessionId: msg.sessionId, params: { sessionId: `S-user-${msg.sessionId}`, targetInfo: { targetId: 'T-user', type: 'page' } } });
      }
      if (msg.method === 'Target.createTarget') {
        const targetId = `T-new-${++created}`;
        // Puppeteer ≥ 23: trình duyệt gắn đích `tab` (mã khác) trước, trang nằm bên trong phiên tab.
        if (tabModel) send({ method: 'Target.attachedToTarget', sessionId: msg.sessionId, params: { sessionId: `S-TAB-${created}`, targetInfo: { targetId: `TAB-${created}`, type: 'tab' } } });
        else send({ method: 'Target.attachedToTarget', sessionId: msg.sessionId, params: { sessionId: `S-${targetId}`, targetInfo: { targetId, type: 'page' } } });
        send({ id: msg.id, sessionId: msg.sessionId, result: { targetId } });
        return;
      }
      if (tabModel && msg.method === 'Target.setAutoAttach' && /^S-TAB-/.test(msg.sessionId)) {
        const n = msg.sessionId.slice('S-TAB-'.length);
        send({ method: 'Target.attachedToTarget', sessionId: msg.sessionId, params: { sessionId: `S-T-new-${n}`, targetInfo: { targetId: `T-new-${n}`, type: 'page' } } });
      }
      if (msg.id !== undefined) send({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result: { ok: msg.method } });
    });
  });
  return { url: `ws://127.0.0.1:${wss.address().port}/devtools/browser/abc`, seen, close: () => new Promise((r) => wss.close(r)) };
}

/** Đường hầm giả phía BE: gửi lệnh, nhận trả lời theo id. */
function fakeClient(mux) {
  const got = [];
  let nextId = 1;
  const ready = mux.attach((text) => got.push(JSON.parse(text)));
  return {
    got,
    ready,
    async call(method, params = {}, sessionId) {
      const c = await ready;
      const id = nextId++;
      c.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      await until(() => got.some((m) => m.id === id && m.sessionId === sessionId));
      return got.find((m) => m.id === id && m.sessionId === sessionId);
    },
  };
}

test('DevToolsActivePort: dòng 1 cổng, dòng 2 đường dẫn — sai định dạng thì bỏ', () => {
  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/0b3e-41f2\n'), { port: 9222, path: '/devtools/browser/0b3e-41f2' });
  assert.deepEqual(parseDevToolsActivePort('9333\r\n/devtools/browser/abc'), { port: 9333, path: '/devtools/browser/abc' });
  assert.equal(parseDevToolsActivePort(''), null);
  assert.equal(parseDevToolsActivePort('abc\n/devtools/browser/x'), null);
  assert.equal(parseDevToolsActivePort('9222\n/json/version'), null);
});

test('findDailyBrowser: chỉ nhận trình duyệt đã bật gỡ lỗi từ xa và đang nghe cổng — trình duyệt mặc định xét trước', async () => {
  const dir = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `daily-${name}-`)); return d; };
  const edgeDir = dir('edge');
  const chromeDir = dir('chrome');
  fs.writeFileSync(path.join(edgeDir, 'DevToolsActivePort'), '9301\n/devtools/browser/edge1');
  fs.writeFileSync(path.join(chromeDir, 'DevToolsActivePort'), '9302\n/devtools/browser/chrome1');
  const browsers = [{ id: 'edge', name: 'Microsoft Edge', dir: edgeDir }, { id: 'chrome', name: 'Google Chrome', dir: chromeDir }];
  const resolve = (b) => ({ id: b.id, name: b.name, profileDir: b.dir });
  const open = new Set([9301, 9302]);
  const isOpen = async (port) => open.has(port);
  assert.equal((await findDailyBrowser('chrome', { browsers, resolve, isOpen })).wsUrl, 'ws://127.0.0.1:9302/devtools/browser/chrome1');
  assert.equal((await findDailyBrowser('edge', { browsers, resolve, isOpen })).id, 'edge');
  open.delete(9302);
  assert.equal((await findDailyBrowser('chrome', { browsers, resolve, isOpen })).id, 'edge', 'Chrome tắt / cổng cũ → trình duyệt còn lại');
  open.delete(9301);
  assert.equal(await findDailyBrowser('chrome', { browsers, resolve, isOpen }), null);
  fs.rmSync(path.join(edgeDir, 'DevToolsActivePort'));
  open.add(9301);
  assert.equal((await findDailyBrowser('edge', { browsers, resolve, isOpen }))?.id, undefined, 'chưa bật gỡ lỗi (không có tệp) → bỏ qua Edge');
});

test('bộ chia: nhiều đường hầm dùng MỘT kết nối (hỏi người dùng một lần), mỗi đường hầm một phiên riêng, id trùng không lẫn', async () => {
  const chrome = await fakeChrome();
  const mux = createCdpMux({ wsUrl: chrome.url, idleCloseMs: 0 });
  const a = fakeClient(mux);
  const b = fakeClient(mux);
  const ra = await a.call('Target.getTargets');
  const rb = await b.call('Target.getTargets');
  assert.equal(chrome.seen.connections, 1);
  assert.deepEqual(ra.result, { ok: 'Target.getTargets' });
  assert.equal(ra.sessionId, undefined, 'phiên trình duyệt riêng của đường hầm bị ẩn — BE thấy như kết nối gốc');
  assert.equal(rb.id, ra.id);
  const sent = chrome.seen.messages.filter((m) => m.method === 'Target.getTargets').map((m) => m.sessionId);
  assert.deepEqual(sent.sort(), ['B1', 'B2']);
  mux.close();
  await chrome.close();
});

test('bộ chia: chặn lệnh hại trình duyệt của người dùng; tab của người dùng chỉ đọc; tab AI mở điều khiển được, mở ở nền', async () => {
  const chrome = await fakeChrome();
  const mux = createCdpMux({ wsUrl: chrome.url, idleCloseMs: 0, downloadsDir: DL });
  const c = fakeClient(mux);
  for (const method of ['Browser.close', 'Storage.clearCookies', 'Network.clearBrowserCookies', 'Browser.grantPermissions', 'Browser.setDownloadBehavior']) {
    assert.ok((await c.call(method)).error, `${method} phải bị chặn`);
  }
  await c.call('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true });
  assert.ok(await until(() => c.got.some((m) => m.method === 'Target.attachedToTarget')));
  const userSession = 'S-user-B1';
  assert.ok((await c.call('Runtime.runIfWaitingForDebugger', {}, userSession)).result, 'khởi động lại tab đang chờ được');
  for (const method of ['Page.enable', 'Network.enable', 'Fetch.enable', 'Debugger.enable', 'Page.navigate', 'Input.dispatchMouseEvent', 'Runtime.evaluate', 'Page.close']) {
    assert.ok((await c.call(method, { url: 'https://evil.example' }, userSession)).error, `${method} trên tab người dùng phải bị chặn`);
  }
  assert.ok((await c.call('Target.closeTarget', { targetId: 'T-user' })).error, 'không đóng tab của người dùng');
  for (const method of ['Target.exposeDevToolsProtocol', 'Target.sendMessageToTarget', 'Target.attachToBrowserTarget', 'Storage.getCookies', 'Browser.setWindowBounds', 'SystemInfo.getInfo']) {
    assert.ok((await c.call(method)).error, `${method} ở phiên trình duyệt phải bị chặn`);
  }
  assert.ok((await c.call('Target.setAutoAttach', { autoAttach: true, flatten: false })).error, 'phiên không phẳng bị chặn');
  assert.ok((await c.call('Target.createTarget', { url: 'file:///C:/Users/x/.aivin/device-credentials.json' })).error, 'không mở file://');

  const created = await c.call('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result.targetId;
  assert.equal(chrome.seen.messages.find((m) => m.method === 'Target.createTarget').params.background, true, 'tab mới mở ở nền');
  const own = `S-${targetId}`;
  assert.ok((await c.call('Page.navigate', { url: 'https://example.com' }, own)).result, 'tab AI mở điều khiển được dù phiên gắn trước khi có kết quả createTarget');
  for (const method of ['Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'DOM.setFileInputFiles']) {
    assert.ok((await c.call(method, {}, own)).error, `${method} trên tab AI vẫn bị chặn (kho cookie / tệp trên đĩa của người dùng)`);
  }
  await c.call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:\Windows\System32' }, own);
  assert.equal(chrome.seen.messages.find((m) => m.method === 'Page.setDownloadBehavior').params.downloadPath, DL, 'thư mục tải luôn ép về thư mục của Aivin');
  assert.ok((await c.call('Target.closeTarget', { targetId })).result, 'đóng được tab của AI');
  mux.close();
  await chrome.close();
});

test('bộ chia (tab → trang, Puppeteer ≥ 23): trang mới sau khi đổi tên miền trong tab của AI vẫn điều khiển được; tab người dùng vẫn chỉ đọc', async () => {
  const chrome = await fakeChrome({ tabModel: true });
  const blocked = [];
  const mux = createCdpMux({ wsUrl: chrome.url, idleCloseMs: 0, onBlocked: (b) => blocked.push(b.method) });
  const c = fakeClient(mux);
  await c.call('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true });
  const { result } = await c.call('Target.createTarget', { url: 'about:blank' });
  assert.equal(result.targetId, 'T-new-1');
  await c.call('Target.setAutoAttach', { autoAttach: true, flatten: true }, 'S-TAB-1');
  assert.ok(await until(() => c.got.some((m) => m.params?.sessionId === 'S-T-new-1')));
  assert.ok((await c.call('Page.navigate', { url: 'https://myaccount.google.com' }, 'S-T-new-1')).result);
  // Chuyển hướng sang accounts.google.com: trình duyệt đổi sang đích trang MỚI trong cùng tab.
  chrome.seen.push({ method: 'Target.attachedToTarget', sessionId: 'S-TAB-1', params: { sessionId: 'S-swap', targetInfo: { targetId: 'T-swap', type: 'page' } } });
  assert.ok(await until(() => c.got.some((m) => m.params?.sessionId === 'S-swap')));
  for (const method of ['Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate', 'Fetch.enable', 'Input.dispatchMouseEvent']) {
    assert.ok((await c.call(method, {}, 'S-swap')).result, `${method} trên trang mới của tab AI phải chạy`);
  }
  assert.ok((await c.call('Target.closeTarget', { targetId: 'T-swap' })).result);
  // Tab của người dùng (gắn ở phiên trình duyệt) vẫn chỉ đọc.
  assert.ok((await c.call('Runtime.evaluate', {}, 'S-user-B1')).error);
  assert.deepEqual(blocked, ['Runtime.evaluate']);
  mux.close();
  await chrome.close();
});

test('bộ chia: người dùng không bấm Cho phép trong hạn → lỗi (nơi gọi dùng cửa sổ Aivin)', async () => {
  const chrome = await fakeChrome({ answerVersion: false });
  const mux = createCdpMux({ wsUrl: chrome.url, consentTimeoutMs: 300, idleCloseMs: 0 });
  await assert.rejects(mux.connect(), /did not allow/);
  assert.equal(mux.isOpen(), false);
  await chrome.close();
});

test('open_tunnel: có trình duyệt hằng ngày → đường hầm qua bộ chia (daily: true); không có → cửa sổ Aivin', async () => {
  const chrome = await fakeChrome();
  const backend = new WebSocketServer({ port: 0 });
  await new Promise((r) => backend.once('listening', r));
  const backendSockets = [];
  backend.on('connection', (ws) => backendSockets.push(ws));
  const serverUrl = `http://127.0.0.1:${backend.address().port}`;
  let ensureCalls = 0;
  const notes = [];
  const tunnels = createBrowserTunnels({
    serverUrl, deviceToken: 'tok', browser: { id: 'chrome', name: 'Google Chrome' }, downloadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')),
    findDaily: async () => ({ id: 'chrome', name: 'Google Chrome', wsUrl: chrome.url }),
    ensureBrowser: async () => { ensureCalls++; return { wsUrl: chrome.url }; },
    notify: (n) => notes.push(n),
  });
  const res = await tunnels.open({ tunnel_id: 'tunnel-0001' }, {});
  assert.equal(res.daily, true);
  assert.equal(ensureCalls, 0);
  assert.equal(notes.length, 1, 'báo người dùng bấm Cho phép lần đầu');
  await until(() => backendSockets.length === 1);
  backendSockets[0].send(JSON.stringify({ id: 7, method: 'Target.getTargets' }));
  const got = [];
  backendSockets[0].on('message', (d) => got.push(JSON.parse(String(d))));
  assert.ok(await until(() => got.some((m) => m.id === 7)));
  assert.equal(got.find((m) => m.id === 7).sessionId, undefined);
  await tunnels.open({ tunnel_id: 'tunnel-0002' }, {});
  assert.equal(chrome.seen.connections, 1, 'đường hầm thứ hai dùng lại kết nối, không hỏi lại');
  assert.equal(notes.length, 1);
  tunnels.closeAll();

  const fallback = createBrowserTunnels({
    serverUrl, deviceToken: 'tok', browser: { id: 'chrome', name: 'Google Chrome' }, downloadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')),
    findDaily: async () => null, ensureBrowser: async () => { ensureCalls++; return { wsUrl: chrome.url }; }, notify: () => {},
  });
  const plain = await fallback.open({ tunnel_id: 'tunnel-0003' }, {});
  assert.equal(plain.daily, undefined);
  assert.equal(ensureCalls, 1);
  fallback.closeAll();
  await new Promise((r) => backend.close(r));
  await chrome.close();
});
