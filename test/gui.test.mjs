import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { assertWindowAllowed, buildGuiTools, createGuiController, detectGui, matchApps } = await import('../bin/lib/remote/gui/index.mjs');
const { buildTools } = await import('../bin/lib/remote/toolHandlers.mjs');
const { buildCatalog } = await import('../bin/lib/remote/deviceProfile.mjs');
const { DEFAULT_GROUP_LIMITS, ToolGroup } = await import('../bin/lib/remote/constants.mjs');

/** Host giả: ghi lại lời gọi, trả theo bảng. */
function fakeHost(responses) {
  const calls = [];
  return {
    calls,
    call: async (op, args) => {
      calls.push({ op, args });
      const r = responses[op];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(args) : r;
    },
    close: () => {},
  };
}

const NOTEPAD = { window: '0x10', title: 'a.txt - Notepad', process: 'Notepad', pid: 1 };

test('detectGui: chỉ Windows, không máy tính tổ chức, tắt được bằng --no-gui', () => {
  assert.equal(detectGui({ platform: 'linux' }), null);
  assert.equal(detectGui({ platform: 'darwin' }), null);
  assert.equal(detectGui({ platform: 'win32', multiUser: true }), null);
  assert.equal(detectGui({ platform: 'win32', disabled: true }), null);
  assert.equal(detectGui({ platform: 'win32' })?.backend, 'uia');
});

test('sàn ứng dụng: chặn quản lý mật khẩu / hộp nâng quyền luôn; terminal chỉ cho máy toàn quyền', () => {
  assert.throws(() => assertWindowAllowed({ process: 'KeePassXC' }, { fullAccess: true }), /not allowed/);
  assert.throws(() => assertWindowAllowed({ process: 'consent.exe' }, { fullAccess: true }), /not allowed/);
  assert.throws(() => assertWindowAllowed({ process: 'WindowsTerminal' }, { fullAccess: false }), /full device access/);
  assert.doesNotThrow(() => assertWindowAllowed({ process: 'WindowsTerminal' }, { fullAccess: true }));
  assert.doesNotThrow(() => assertWindowAllowed({ process: 'EXCEL' }, { fullAccess: false }));
});

test('matchApps: trùng hẳn > bắt đầu bằng > chứa, bỏ dấu; ngang nhau trả nhiều ứng viên', () => {
  const apps = [{ name: 'Excel' }, { name: 'Excel Viewer' }, { name: 'Máy tính' }, { name: 'Zalo' }, { name: 'Zalo Beta' }];
  assert.deepEqual(matchApps(apps, 'excel').map((a) => a.name), ['Excel']);
  assert.deepEqual(matchApps(apps, 'may tinh').map((a) => a.name), ['Máy tính']);
  assert.deepEqual(matchApps(apps, 'zal').map((a) => a.name), ['Zalo', 'Zalo Beta']);
  assert.deepEqual(matchApps(apps, 'photoshop'), []);
});

test('act theo node_id: snapshot lạ → GUI_STALE_NODE; ứng dụng bị chặn → không gửi xuống host', async () => {
  const host = fakeHost({
    observe: { snapshot: 7, window: NOTEPAD, nodes: [], tree_quality: 'good' },
    act: (a) => ({ action: a.action, method: 'value' }),
  });
  const gui = createGuiController({ host, notify: () => {} });
  await assert.rejects(gui.act({ action: 'click', node_id: '3.1' }, {}), (e) => e.code === 'GUI_STALE_NODE');
  await gui.observe({}, {});
  const res = await gui.act({ action: 'set_value', node_id: '7.4', text: 'x' }, {});
  assert.equal(res.method, 'value');
  const sent = host.calls.find((c) => c.op === 'act').args;
  assert.equal(sent.check_user_input, true);
  assert.equal(sent.window, undefined);

  const blockedHost = fakeHost({ observe: { snapshot: 1, window: { ...NOTEPAD, process: 'cmd' } }, window_info: { ...NOTEPAD, process: 'cmd' }, act: {} });
  const g2 = createGuiController({ host: blockedHost, notify: () => {} });
  await assert.rejects(g2.observe({}, {}), (e) => e.code === 'GUI_BLOCKED_APP');
  await assert.rejects(g2.act({ action: 'key', keys: 'enter' }, {}), (e) => e.code === 'GUI_BLOCKED_APP');
  assert.equal(blockedHost.calls.some((c) => c.op === 'act'), false);
});

test('act: hành động lạ bị từ chối; báo "AI đang điều khiển" một lần cho nhiều thao tác liền nhau', async () => {
  const host = fakeHost({ window_info: NOTEPAD, act: {} });
  const notes = [];
  const gui = createGuiController({ host, notify: (n) => notes.push(n) });
  await assert.rejects(gui.act({ action: 'format_disk' }, {}), (e) => e.code === 'INVALID_ARGS');
  await gui.act({ action: 'key', keys: 'ctrl+s' }, {});
  await gui.act({ action: 'key', keys: 'enter' }, {});
  assert.equal(notes.length, 1);
});

test('open_app: không mở tệp chạy được; tên trùng nhiều → trả ứng viên', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-root-'));
  fs.writeFileSync(path.join(root, 'evil.bat'), 'echo');
  const host = fakeHost({ windows: [] });
  const gui = createGuiController({ host, notify: () => {} });
  await assert.rejects(gui.openApp({ file: 'evil.bat' }, {}, { roots: [root] }), (e) => e.code === 'GUI_BLOCKED_APP');
  await assert.rejects(gui.openApp({}, {}, { roots: [root] }), (e) => e.code === 'INVALID_ARGS');
});

test('danh mục: công cụ GUI chỉ có khi env.gui, nhóm GUI chạy một luồng', () => {
  const gui = createGuiController({ host: fakeHost({}), notify: () => {} });
  const base = { roots: [os.tmpdir()], binaries: [], projects: [] };
  assert.equal(buildTools(base).some((t) => t.name.startsWith('gui.')), false);
  const tools = buildTools({ ...base, gui });
  const names = buildGuiTools(gui).map((t) => t.name);
  for (const n of names) assert.ok(tools.find((t) => t.name === n), n);
  const { catalog } = buildCatalog(tools);
  assert.equal(catalog.find((t) => t.name === 'gui.observe').read_only, true);
  assert.equal(catalog.find((t) => t.name === 'gui.act').side_effect, true);
  assert.equal(DEFAULT_GROUP_LIMITS[ToolGroup.GUI], 1);
});

test('mã C# của host GUI biên dịch được (Windows có .NET Framework)', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = await import('child_process');
  const { WINDOWS_HOST_CSHARP } = await import('../bin/lib/remote/gui/windowsHostSource.mjs');
  const fw = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const csc = path.join(fw, 'csc.exe');
  if (!fs.existsSync(csc)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-csc-'));
  const src = path.join(dir, 'host.cs');
  fs.writeFileSync(src, WINDOWS_HOST_CSHARP);
  const wpf = path.join(fw, 'WPF');
  const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map((r) => `-r:${path.join(wpf, r)}`);
  const out = (() => {
    try { return execFileSync(csc, ['-nologo', '-codepage:65001', '-target:library', `-out:${path.join(dir, 'host.dll')}`, ...refs, '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', '-r:System.Web.Extensions.dll', src], { encoding: 'utf8' }); } catch (e) { return String(e.stdout || e.message); }
  })();
  assert.doesNotMatch(out, /error CS\d+/, out);
});

test('không nói cửa sổ: host được báo tiến trình linh vật + cửa sổ chủ máy đang dùng khi hỏi; nói cửa sổ thì không', async () => {
  const host = fakeHost({ observe: { snapshot: 1, window: NOTEPAD, nodes: [], tree_quality: 'good' }, window_info: NOTEPAD, focus: {}, act: {} });
  const gui = createGuiController({ host, notify: () => {}, defaultWindow: () => ({ avoid_pid: 42, fallback: '0x10' }) });
  await gui.observe({}, {});
  await gui.act({ action: 'key', keys: 'ctrl+s' }, {});
  await gui.focus({ window: 'notepad' }, {});
  const args = (op) => host.calls.filter((c) => c.op === op).map((c) => c.args);
  assert.equal(args('observe')[0].avoid_pid, 42);
  assert.equal(args('observe')[0].fallback, '0x10');
  assert.equal(args('act')[0].fallback, '0x10');
  assert.deepEqual(args('window_info').at(-1), { window: 'notepad' });
  assert.deepEqual(args('focus')[0], { window: 'notepad' });
});

test('wait_for: chờ phần tử cần cửa sổ được phép + chuyển đủ tham số; chờ tiêu đề không nói cửa sổ thì không hỏi window_info', async () => {
  const host = fakeHost({ window_info: NOTEPAD, wait_for: (a) => ({ met: true, until: a.until || 'appears', waited_ms: 5 }) });
  const gui = createGuiController({ host, notify: () => {} });
  const res = await gui.waitFor({ window: 'notepad', name: 'Save', role: 'button', until: 'gone', timeout_ms: 999_999 }, {});
  assert.equal(res.met, true);
  const sent = host.calls.find((c) => c.op === 'wait_for').args;
  assert.deepEqual({ window: sent.window, name: sent.name, role: sent.role, until: sent.until, timeout_ms: sent.timeout_ms },
    { window: 'notepad', name: 'Save', role: 'button', until: 'gone', timeout_ms: 60_000 });

  host.calls.length = 0;
  await gui.waitFor({ title_contains: 'Save As' }, {});
  assert.equal(host.calls.some((c) => c.op === 'window_info'), false);
  assert.equal(host.calls[0].args.window, undefined);

  const blocked = fakeHost({ window_info: { ...NOTEPAD, process: 'KeePass' }, wait_for: { met: true } });
  const g2 = createGuiController({ host: blocked, notify: () => {} });
  await assert.rejects(g2.waitFor({ name: 'Unlock' }, {}), (e) => e.code === 'GUI_BLOCKED_APP');
  assert.equal(blocked.calls.some((c) => c.op === 'wait_for'), false);
});

test('node chữ OCR ("<snap>.t<k>"): act kiểm ứng dụng theo cửa sổ của lần observe đó; ocr chỉ gửi khi nói rõ', async () => {
  const host = fakeHost({
    observe: { snapshot: 9, window: NOTEPAD, nodes: [{ id: '9.t0', role: 'text', name: 'Lưu', source: 'ocr' }], tree_quality: 'poor' },
    act: (a) => ({ action: a.action, method: 'mouse' }),
  });
  const gui = createGuiController({ host, notify: () => {} });
  await gui.observe({}, {});
  assert.equal(host.calls[0].args.ocr, undefined);
  await gui.observe({ ocr: true }, {});
  assert.equal(host.calls[1].args.ocr, true);
  const res = await gui.act({ action: 'click', node_id: '9.t0' }, {});
  assert.equal(res.method, 'mouse');
  await assert.rejects(gui.act({ action: 'click', node_id: '8.t0' }, {}), (e) => e.code === 'GUI_STALE_NODE');
});

test('find: chỉ phần tử khớp mọi từ (bỏ dấu, cả AutomationId / giá trị), lọc vai trò, có trần; không đủ hết từ → gần nhất; id giữ nguyên để act', async () => {
  const nodes = [
    { id: '5.0', role: 'window', name: 'Phiếu chi - MISA' },
    { id: '5.1', role: 'edit', name: 'Số tiền', automation_id: 'txtAmount' },
    { id: '5.2', role: 'button', name: 'Lưu và đóng' },
    { id: '5.3', role: 'button', name: 'Lưu' },
    { id: '5.4', role: 'edit', name: 'Diễn giải', value: 'Tiền điện tháng 10' },
  ];
  const host = fakeHost({ observe: { snapshot: 5, window: NOTEPAD, nodes, tree_quality: 'good', node_count: nodes.length }, act: (a) => ({ action: a.action, method: 'invoke' }) });
  const gui = createGuiController({ host, notify: () => {} });
  const r = await gui.find({ query: 'luu', role: 'button' }, {});
  assert.deepEqual(r.nodes.map((n) => n.id), ['5.2', '5.3']);
  assert.equal(r.exact, true);
  assert.equal(host.calls[0].args.max_nodes, 1500, 'đi cả cây rồi lọc');
  assert.deepEqual((await gui.find({ query: 'amount' }, {})).nodes.map((n) => n.id), ['5.1']);
  assert.deepEqual((await gui.find({ query: 'tien dien' }, {})).nodes.map((n) => n.id), ['5.4']);
  const near = await gui.find({ query: 'luu ban nhap' }, {});
  assert.equal(near.exact, false);
  assert.ok(near.nodes.length >= 2 && near.nodes.every((n) => n.name.startsWith('Lưu')));
  assert.equal((await gui.find({ query: 'luu', max: 1 }, {})).nodes.length, 1);
  await assert.rejects(gui.find({ query: '  ' }, {}), (e) => e.code === 'INVALID_ARGS');
  assert.equal((await gui.act({ action: 'click', node_id: '5.3' }, {})).method, 'invoke', 'id của find dùng ngay cho act');
});
