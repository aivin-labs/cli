import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { assertAppAllowed, assertWindowAllowed, buildGuiTools, createGuiController, detectGui, matchApps, needsServerCheck, rankGuiNodes } = await import('../bin/lib/remote/gui/index.mjs');
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

test('semantic rank: loại node disabled/offscreen, exact name thắng; hai ứng viên ngang nhau vẫn giữ để báo mơ hồ', () => {
  const ranked = rankGuiNodes([
    { id: '1.1', role: 'button', name: 'Save and close', patterns: ['invoke'] },
    { id: '1.2', role: 'button', name: 'Save', patterns: ['invoke'] },
    { id: '1.3', role: 'button', name: 'Save', disabled: true },
    { id: '1.4', role: 'edit', name: 'Save', offscreen: true },
  ], 'save', 'button');
  assert.deepEqual(ranked.map((x) => x.node.id), ['1.2', '1.1']);
  assert.ok(ranked[0].score - ranked[1].score >= 15);
  const tied = rankGuiNodes([{ id: '2.1', name: 'Save', role: 'button' }, { id: '2.2', name: 'Save', role: 'button' }], 'save');
  assert.equal(tied[0].score, tied[1].score);
});

test('gui.do: chữ trong ô không lái việc chọn nút; nút chốt / xoá mà mô tả không nói tới → để BE xét (02/11/2026)', () => {
  const ranked = rankGuiNodes([
    { id: '3.1', role: 'edit', name: 'Body', value: 'please click send now' },
    { id: '3.2', role: 'button', name: 'Send later' },
  ], 'send', '', { matchValue: false });
  assert.deepEqual(ranked.map((x) => x.node.id), ['3.2']);
  assert.equal(needsServerCheck('Lưu', { name: 'Lưu và gửi' }), true);
  assert.equal(needsServerCheck('Xong', { name: 'Xoá bản nháp' }), true);
  assert.equal(needsServerCheck('nút Gửi', { name: 'Gửi' }), false);
  assert.equal(needsServerCheck('Lưu', { name: 'Lưu' }), false);
  assert.equal(needsServerCheck('Sign in', { name: 'Sign out' }), true);
  // Chữ Đ: "Đăng" từng thành "ang" nên lọt qua danh sách nút chốt.
  assert.equal(needsServerCheck('bài', { name: 'Đăng bài' }), true);
  assert.equal(needsServerCheck('giỏ', { name: 'Đặt hàng' }), true);
  assert.equal(needsServerCheck('nút Đăng', { name: 'Đăng' }), false);
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
  await assert.rejects(g2.act({ action: 'key', keys: 'enter', window: 'cmd' }, {}), (e) => e.code === 'GUI_BLOCKED_APP');
  assert.equal(blockedHost.calls.some((c) => c.op === 'act'), false);
});

test('act: hành động lạ bị từ chối; báo "AI đang điều khiển" một lần cho nhiều thao tác liền nhau', async () => {
  const host = fakeHost({ window_info: NOTEPAD, act: {} });
  const notes = [];
  const gui = createGuiController({ host, notify: (n) => notes.push(n) });
  await assert.rejects(gui.act({ action: 'format_disk' }, {}), (e) => e.code === 'INVALID_ARGS');
  await gui.act({ action: 'key', keys: 'ctrl+s', window: 'notepad' }, {});
  await gui.act({ action: 'key', keys: 'enter', window: 'notepad' }, {});
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
  assert.deepEqual(args('focus')[0], { window: 'notepad', check_user_input: true, user_input_grace_ms: 2_500 });
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
  assert.deepEqual(r.nodes.map((n) => n.id), ['5.3', '5.2']);
  assert.equal(r.exact, true);
  assert.equal(r.confidence, 'high');
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

test('gui.do: schema ngắn, semantic match nội bộ, từ chối mơ hồ và xác minh fill', async () => {
  const observations = [
    { snapshot: 11, window: NOTEPAD, tree_quality: 'good', nodes: [
      { id: '11.1', role: 'edit', name: 'Customer name', patterns: ['value'] },
      { id: '11.2', role: 'button', name: 'Save' },
    ] },
    { snapshot: 12, window: NOTEPAD, tree_quality: 'good', nodes: [
      { id: '12.1', role: 'button', name: 'Save' }, { id: '12.2', role: 'button', name: 'Save' },
    ] },
  ];
  const host = fakeHost({
    observe: () => observations.shift(),
    act: (a) => ({ action: a.action, method: 'value', target: { exists: true, value: a.text } }),
  });
  const gui = createGuiController({ host, notify: () => {} });
  const filled = await gui.semanticDo({ do: 'fill', target: 'Customer name', value: 'An', role: 'edit', within: 'notepad' }, {}, {});
  assert.deepEqual({ ok: filled.ok, action: filled.action, verified: filled.verified }, { ok: true, action: 'fill', verified: true });
  assert.equal(host.calls.find((c) => c.op === 'act').args.node_id, '11.1');
  const ambiguous = await gui.semanticDo({ do: 'click', target: 'Save', role: 'button', within: 'notepad' }, {}, {});
  assert.equal(ambiguous.code, 'GUI_AMBIGUOUS_TARGET');
  assert.equal(ambiguous.choices.length, 2);
  assert.equal(host.calls.filter((c) => c.op === 'act').length, 1, 'mơ hồ không được click');

  const tool = buildGuiTools(gui).find((t) => t.name === 'gui.do');
  assert.deepEqual(tool.input_schema.required, ['do']);
  assert.deepEqual(Object.keys(tool.input_schema.properties), ['do', 'target', 'value', 'within', 'role', 'file']);
});

test('gui.do: hậu điều kiện fill sai → GUI_NO_EFFECT', async () => {
  const host = fakeHost({
    observe: { snapshot: 20, window: NOTEPAD, tree_quality: 'good', nodes: [{ id: '20.1', role: 'edit', name: 'Amount' }] },
    act: { action: 'set_value', method: 'value', target: { exists: true, value: 'old' } },
  });
  const gui = createGuiController({ host, notify: () => {} });
  await assert.rejects(gui.semanticDo({ do: 'fill', target: 'Amount', value: '100', within: 'notepad' }, {}, {}), (e) => e.code === 'GUI_NO_EFFECT');
});

test('gui.do: không bao giờ điền trường mật khẩu', async () => {
  const host = fakeHost({
    observe: { snapshot: 21, window: NOTEPAD, tree_quality: 'good', nodes: [{ id: '21.1', role: 'edit', name: 'Password', password: true }] },
    act: { action: 'set_value', method: 'value', target: { exists: true } },
  });
  const gui = createGuiController({ host, notify: () => {} });
  await assert.rejects(gui.semanticDo({ do: 'fill', target: 'Password', value: 'secret', within: 'notepad' }, {}, {}), (e) => e.code === 'INVALID_ARGS');
  assert.equal(host.calls.some((c) => c.op === 'act'), false);
});

test('trình soạn code / ứng dụng agent (VS Code, Cursor, Claude…) chỉ điều khiển / mở được khi máy toàn quyền', async () => {
  for (const proc of ['Code', 'Cursor', 'claude', 'devenv', 'idea64']) {
    assert.throws(() => assertWindowAllowed({ process: proc }, { fullAccess: false }), /full device access/, proc);
    assert.doesNotThrow(() => assertWindowAllowed({ process: proc }, { fullAccess: true }), proc);
  }
  assert.doesNotThrow(() => assertWindowAllowed({ process: 'EXCEL' }, { fullAccess: false }));
  for (const name of ['Visual Studio Code', 'Cursor', 'Claude', 'Windows Terminal', 'Command Prompt', 'Git Bash']) {
    assert.throws(() => assertAppAllowed(name, { fullAccess: false }), /full device access/, name);
    assert.doesNotThrow(() => assertAppAllowed(name, { fullAccess: true }), name);
  }
  for (const name of ['Excel', 'Notepad', 'MISA SME', 'Zalo']) assert.doesNotThrow(() => assertAppAllowed(name, { fullAccess: false }), name);
  assert.throws(() => assertAppAllowed('KeePassXC', { fullAccess: true }), /not allowed/);
});

test('windowsHost: huỷ wait_for gửi { cancel: id } qua stdin mà không giết tiến trình host', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const { createWindowsHost } = await import('../bin/lib/remote/gui/windowsHost.mjs');
  const written = [];
  let killed = false;
  const host = createWindowsHost({
    spawnImpl: (cmd) => {
      if (cmd === 'taskkill') { killed = true; return new EventEmitter(); }
      const proc = new EventEmitter();
      proc.pid = 9999;
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
          written.push(JSON.parse(line));
        }
      });
      setImmediate(() => proc.stdout.write(`${JSON.stringify({ ready: true })}\n`));
      return proc;
    },
  });
  const ac = new AbortController();
  const pending = host.call('wait_for', { name: 'Save' }, { signal: ac.signal });
  // Chờ request tới host rồi mới huỷ: huỷ lúc host chưa sẵn sàng thì request chưa gửi, đúng là không có gì để `cancel` (máy CI chậm hơn 20 ms).
  for (let i = 0; i < 400 && !written.some((m) => m.op === 'wait_for'); i++) await new Promise((r) => setTimeout(r, 5));
  ac.abort(new Error('aborted_wait'));
  await assert.rejects(pending, /aborted_wait/);
  assert.equal(killed, false, 'không taskkill host khi chỉ huỷ wait_for');
  assert.equal(host.running(), true);
  // PassThrough giao dữ liệu bất đồng bộ: chờ tới khi `{ cancel }` tới, không giả định kịp ngay (từng flaky trên CI Ubuntu).
  for (let i = 0; i < 200 && !written.some((m) => m.cancel); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(written.at(-1), { cancel: '1' });
});

test('gui.do: không thấy trong cây UIA thường thì tự thử lại với OCR; khi mơ hồ đính kèm luôn observation cho BE', async () => {
  const obsList = [
    { snapshot: 30, window: NOTEPAD, tree_quality: 'good', nodes: [{ id: '30.1', role: 'button', name: 'Cancel' }] },
    { snapshot: 31, window: NOTEPAD, tree_quality: 'good', ocr: { lang: 'vi', count: 1, ms: 12 }, nodes: [
      { id: '31.1', role: 'button', name: 'Cancel' },
      { id: '31.t0', role: 'text', name: 'Ghi sổ', source: 'ocr' },
    ] },
  ];
  const host = fakeHost({
    observe: () => obsList.shift(),
    act: (a) => ({ action: a.action, method: 'mouse', target: { exists: true } }),
  });
  const gui = createGuiController({ host, notify: () => {} });
  const clicked = await gui.semanticDo({ do: 'click', target: 'Ghi sổ', role: 'button', within: 'notepad' }, {}, {});
  assert.equal(clicked.ok, true);
  assert.equal(host.calls.filter((c) => c.op === 'observe').length, 2);
  assert.equal(host.calls.filter((c) => c.op === 'observe')[1].args.ocr, true);
  assert.equal(host.calls.find((c) => c.op === 'act').args.node_id, '31.t0');
});

test('gui.prewarm: làm ấm trước danh sách ứng dụng, các lời gọi đồng thời dùng chung một lượt quét', async () => {
  let scans = 0;
  const host = fakeHost({ windows: () => [NOTEPAD] });
  const gui = createGuiController({
    host, notify: () => {},
    fetchApps: async () => {
      scans++;
      await new Promise((r) => setTimeout(r, 15));
      return [{ Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }];
    },
  });
  const [a, b] = await Promise.all([gui.prewarm(), gui.prewarm()]);
  assert.equal(scans, 1, 'chỉ chạy một lượt quét song song');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  await gui.prewarm();
  assert.equal(scans, 1, 'dùng lại bộ nhớ đệm đã làm ấm');
});


test('gui.do: trả kèm screen_point từ host.act để hiển thị con trỏ AI trên Desktop Cast', async () => {
  const host = fakeHost({
    observe: () => ({
      snapshot: 40,
      window: NOTEPAD,
      tree_quality: 'good',
      nodes: [{ id: '40.1', role: 'button', name: 'Save' }],
    }),
    act: (a) => ({
      action: a.action,
      method: 'invoke',
      target: { exists: true },
      screen_point: { x: 520, y: 340 },
    }),
  });
  const gui = createGuiController({ host, notify: () => {} });
  const res = await gui.semanticDo({ do: 'click', target: 'Save', role: 'button', within: 'notepad' }, {}, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.screen_point, { x: 520, y: 340 });
});

test('thao tác có thay đổi không nêu cửa sổ → INVALID_ARGS, không gửi xuống host; node_id / linh vật / chỉ đọc thì không cần (02/11/2026)', async () => {
  const host = fakeHost({
    window_info: NOTEPAD, act: { action: 'key', method: 'keyboard' },
    observe: { snapshot: 50, window: NOTEPAD, tree_quality: 'good', nodes: [{ id: '50.1', role: 'button', name: 'Save' }] },
  });
  const gui = createGuiController({ host, notify: () => {} });
  for (const action of ['key', 'click', 'type', 'set_value', 'scroll']) {
    await assert.rejects(gui.act({ action, keys: 'ctrl+s', text: 'x', point: { x: 1, y: 1 } }, {}), (e) => e.code === 'INVALID_ARGS' && /Name the window/.test(e.message), action);
  }
  for (const d of ['click', 'fill', 'key', 'toggle', 'select', 'scroll']) {
    await assert.rejects(gui.semanticDo({ do: d, target: 'Save', value: 'x' }, {}, {}), (e) => e.code === 'INVALID_ARGS', d);
  }
  assert.equal(host.calls.some((c) => c.op === 'act' || c.op === 'window_info'), false, 'không hỏi host cửa sổ đang focus');
  await gui.observe({}, {});
  await gui.act({ action: 'click', node_id: '50.1' }, {});
  await gui.act({ action: 'key', keys: 'ctrl+s', window: 'notepad' }, {});
  assert.equal(host.calls.filter((c) => c.op === 'act').length, 2);

  const mascot = fakeHost({ window_info: NOTEPAD, act: {} });
  const g2 = createGuiController({ host: mascot, notify: () => {}, defaultWindow: () => ({ avoid_pid: 42, fallback: '0x10' }) });
  await g2.act({ action: 'key', keys: 'ctrl+s' }, {});
  assert.equal(mascot.calls.find((c) => c.op === 'act').args.fallback, '0x10');
  const noFallback = createGuiController({ host: fakeHost({ window_info: NOTEPAD, act: {} }), notify: () => {}, defaultWindow: () => ({ avoid_pid: 42 }) });
  await assert.rejects(noFallback.act({ action: 'key', keys: 'enter' }, {}), (e) => e.code === 'INVALID_ARGS');
});

test('mô tả công cụ: gui.do within bắt buộc, gui.act nêu GUI_FOCUS_LOST; mã lỗi có trong DeviceErrorCode', async () => {
  const { DeviceErrorCode } = await import('../bin/lib/remote/constants.mjs');
  assert.equal(DeviceErrorCode.GUI_FOCUS_LOST, 'GUI_FOCUS_LOST');
  const tools = buildGuiTools(createGuiController({ host: fakeHost({}), notify: () => {} }));
  assert.match(tools.find((t) => t.name === 'gui.do').input_schema.properties.within.description, /required/);
  assert.match(tools.find((t) => t.name === 'gui.act').description, /GUI_FOCUS_LOST/);
});

test('host C#: chuột / phím thật kiểm cửa sổ trên cùng + điểm bấm, gõ dài kiểm từng lô, act không node_id đòi cửa sổ, ảnh màn hình chỉ khi không bị che (02/11/2026)', async () => {
  const { WINDOWS_HOST_CSHARP: cs } = await import('../bin/lib/remote/gui/windowsHostSource.mjs');
  const body = (name) => {
    const start = cs.indexOf(`static ${name}`);
    assert.ok(start >= 0, name);
    return cs.slice(start, cs.indexOf('\n    }\n', start));
  };
  const mouse = body('void MouseAt(');
  assert.ok(mouse.indexOf('RequireForeground(window)') >= 0 && mouse.indexOf('RequireForeground(window)') < mouse.indexOf('PointFor('), 'đưa cửa sổ lên (khôi phục) trước khi tính toạ độ');
  assert.match(mouse, /AssertPointOnWindow\(x, y, window\)/);
  assert.match(body('void FocusTarget('), /RequireForeground\(window\)/);
  assert.match(body('bool ForceForeground('), /return BelongsTo\(Native\.GetForegroundWindow\(\), h\)/);
  assert.match(body('void RequireForeground('), /GUI_FOCUS_LOST/);
  assert.match(body('bool PointOnWindow('), /WindowFromPoint/);
  assert.match(body('bool BelongsTo('), /RootOf/);
  const batch = body('void SendTextBatch(');
  assert.match(batch, /UserTouchedSince/);
  assert.match(batch, /AssertStillForeground\(window, done\)/);
  assert.match(body('void TypeText('), /SendTextBatch\(list, window/);
  assert.match(body('void KeyCombo('), /AssertStillForeground/);
  assert.match(body('object Act('), /ResolveWindow\(a, true\)/);
  const grab = body('Bitmap GrabWindow(');
  assert.ok(grab.indexOf('ScreenCopyBlocker') >= 0 && grab.indexOf('ScreenCopyBlocker') < grab.indexOf('CopyFromScreen'), 'chỉ chụp màn hình sau khi kiểm không bị che');
  assert.match(body('string ScreenCopyBlocker('), /GetForegroundWindow/);
  assert.match(cs, /res\["image_error"\] = imageError/);
  // Thao tác theo pattern (Invoke / Value / chạy nền) không bị buộc lên trên cùng.
  const doAction = body('string DoAction(');
  const setValue = doAction.slice(doAction.indexOf('case "set_value"'), doAction.indexOf('case "type"'));
  assert.ok(setValue.indexOf('vp.SetValue') < setValue.indexOf('FocusTarget'), 'set_value theo pattern chạy trước, không đòi foreground');
});

test('windowsHost: host được báo tệp PID bản Office ẩn để dọn mồ côi', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const { createWindowsHost, OFFICE_ORPHANS_FILE } = await import('../bin/lib/remote/gui/windowsHost.mjs');
  let env = null;
  const host = createWindowsHost({
    spawnImpl: (cmd, args, opts) => {
      const proc = new EventEmitter();
      if (cmd === 'taskkill') return proc;
      env = opts.env;
      proc.pid = 1; proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      setImmediate(() => proc.stdout.write(`${JSON.stringify({ ready: true })}\n`));
      proc.stdin.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) proc.stdout.write(`${JSON.stringify({ id: JSON.parse(line).id, ok: true, result: {} })}\n`);
      });
      return proc;
    },
  });
  await host.call('ping');
  assert.equal(env.AIVIN_GUI_ORPHANS, OFFICE_ORPHANS_FILE);
  assert.match(OFFICE_ORPHANS_FILE, /gui[\\/]office-orphans\.txt$/);
  host.close();
});

test('rank: khớp theo đầu từ, từ ngắn không khớp giữa AutomationId; chữ OCR trên nút đã tắt không được chọn (10/11/2026)', () => {
  const nodes = [{ id: '1.1', role: 'button', name: 'Open Navigation', automation_id: 'TogglePaneButton' }];
  assert.equal(rankGuiNodes(nodes, 'tồn').length, 0);
  assert.equal(rankGuiNodes(nodes, 'navi').length, 1);
  assert.equal(rankGuiNodes(nodes, 'paneb').length, 1);
  const ocr = [
    { id: '2.1', role: 'button', name: 'Khoá sổ', disabled: true, rect: { x: 100, y: 200, w: 100, h: 30 } },
    { id: '2.t1', role: 'text', name: 'Khoá sổ', source: 'ocr', rect: { x: 120, y: 205, w: 60, h: 20 } },
    { id: '2.t2', role: 'text', name: 'Khoá sổ', source: 'ocr', rect: { x: 500, y: 205, w: 60, h: 20 } },
  ];
  assert.deepEqual(rankGuiNodes(ocr, 'khoá sổ').map((x) => x.node.id), ['2.t2']);
});

test('gui.do: khớp một phần không bấm thẳng — trả ứng viên, không gọi act (10/11/2026)', async () => {
  const host = fakeHost({
    window_info: NOTEPAD,
    observe: { snapshot: 7, window: NOTEPAD, tree_quality: 'good', nodes: [{ id: '7.1', role: 'button', name: 'Seven', patterns: ['invoke'] }] },
  });
  const gui = createGuiController({ host, notify: () => {}, say: () => {} });
  const res = await gui.semanticDo({ do: 'click', target: 'Seven Hundred', within: 'Notepad' }, {}, {});
  assert.equal(res.ok, false);
  assert.equal(res.code, 'GUI_AMBIGUOUS_TARGET');
  assert.deepEqual(res.choices.map((c) => c.ref), ['7.1']);
  assert.equal(host.calls.some((c) => c.op === 'act'), false);
});

test('sàn ứng dụng: hộp xác thực Windows bị chặn, hộp chọn tệp của PickerHost thì không (10/11/2026)', () => {
  for (const title of ['Windows Security', 'Bảo mật Windows']) {
    assert.throws(() => assertWindowAllowed({ process: 'PickerHost', title }, { fullAccess: true }), /Windows Security prompt/);
  }
  assert.throws(() => assertWindowAllowed({ process: 'CredentialUIBroker.exe', title: 'x' }, { fullAccess: true }), /not allowed/);
  assert.doesNotThrow(() => assertWindowAllowed({ process: 'PickerHost', title: 'Open' }, { fullAccess: false }));
});

test('host C#: observe và wait_for có trần thời gian; tìm được hộp thoại con; ứng dụng bận không làm kẹt act (10/11/2026)', async () => {
  const { WINDOWS_HOST_CSHARP: cs } = await import('../bin/lib/remote/gui/windowsHostSource.mjs');
  assert.match(cs, /TreeScope = TreeScope\.Element;/);
  assert.doesNotMatch(cs, /FindAll\(TreeScope\.Descendants, cond\)/);
  assert.match(cs, /sw\.ElapsedMilliseconds >= budgetMs/);
  assert.match(cs, /truncated_by/);
  assert.match(cs, /foreach \(bool withDialogs in new\[\] \{ false, true \}\)/);
  assert.match(cs, /match == null && !incomplete/);
  assert.match(cs, /res\["app_busy"\] = true/);
  assert.match(cs, /Shell_SystemDim/);
  assert.match(cs, /content_unavailable/);
});

const personPresent = () => Object.assign(new Error('person'), { code: 'GUI_PERSON_PRESENT' });

test('chuột thật khi có người: Planner không rút ngắn được thời gian chờ (10/11/2026)', async () => {
  const host = fakeHost({ window_info: NOTEPAD, act: () => ({ method: 'invoke' }) });
  const gui = createGuiController({ host, notify: () => {}, realInputIdleMs: 180_000 });
  await gui.act({ action: 'click', window: 'Notepad', user_input_grace_ms: 1 }, {});
  await gui.act({ action: 'click', window: 'Notepad', user_input_grace_ms: 600_000 }, {});
  const graces = host.calls.filter((c) => c.op === 'act').map((c) => c.args.user_input_grace_ms);
  assert.deepEqual(graces, [180_000, 600_000]);
});

test('chuột thật khi có người: không hỏi gì, chờ họ ngừng tay rồi làm (10/11/2026)', async () => {
  let tries = 0;
  const host = fakeHost({ window_info: NOTEPAD, act: () => { if (++tries < 3) throw personPresent(); return { method: 'mouse' }; } });
  const gui = createGuiController({ host, notify: () => {}, realInputWaitMs: 5_000 });
  assert.equal((await gui.act({ action: 'right_click', window: 'Notepad' }, {})).method, 'mouse');
  assert.equal(tries, 3);
});

test('chuột thật khi có người: họ bận suốt thì không làm, báo GUI_USER_ACTIVE (10/11/2026)', async () => {
  const host = fakeHost({ window_info: NOTEPAD, focus: () => { throw personPresent(); }, act: () => { throw personPresent(); } });
  const gui = createGuiController({ host, notify: () => {}, realInputWaitMs: 300 });
  await assert.rejects(gui.act({ action: 'right_click', window: 'Notepad' }, {}), (e) => e.code === 'GUI_USER_ACTIVE');
  await assert.rejects(gui.focus({ window: 'Notepad' }, {}), (e) => e.code === 'GUI_USER_ACTIVE');
});

test('gui.read_table: cần node của bảng, node cũ bị từ chối, ứng dụng bị chặn không đọc được (10/11/2026)', async () => {
  const host = fakeHost({ observe: { snapshot: 4, window: NOTEPAD, nodes: [], tree_quality: 'good' }, read_table: { rows: ['a'], complete: true } });
  const gui = createGuiController({ host, notify: () => {} });
  await assert.rejects(gui.readTable({}, {}), (e) => e.code === 'INVALID_ARGS');
  await assert.rejects(gui.readTable({ node_id: '9.1' }, {}), (e) => e.code === 'GUI_STALE_NODE');
  await gui.observe({}, {});
  assert.deepEqual((await gui.readTable({ node_id: '4.1', max_rows: 9999 }, {})).rows, ['a']);
  assert.equal(host.calls.at(-1).args.max_rows, 2000);
});

test('host C#: thử chạy nền trước chuột thật; chỉ gửi thông điệp cho ứng dụng truyền thống; bảng đã cuộn vẫn thấy dòng đang hiện (10/11/2026)', async () => {
  const { WINDOWS_HOST_CSHARP: cs } = await import('../bin/lib/remote/gui/windowsHostSource.mjs');
  assert.ok(cs.indexOf('TryBackgroundClick(el, window, a, 1)') < cs.indexOf('MouseAt(el, window, a, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1)'));
  assert.ok(cs.indexOf('TryBackgroundScroll(el, window, a, dir, amount)') < cs.indexOf('Send(new[] { inp })'));
  assert.match(cs, /throw new GuiError\("GUI_PERSON_PRESENT"/);
  assert.match(cs, /if \(backgroundOnly\) throw new GuiError\("GUI_NEEDS_REAL_INPUT"/);
  assert.match(cs, /c\.StartsWith\("WindowsForms10\."\)/);
  assert.doesNotMatch(cs, /ClassicClasses = [^;]*Chrome_/);
  assert.match(cs, /if \(passedView\) break;/);
  assert.match(cs, /AddVisibleRows\(list, snap, nodes, wr, sw, budgetMs\)/);
  assert.match(cs, /GiveBackRealInput\(action, window, fgBefore, haveCursor, cursorBefore\)/);
  assert.match(cs, /stale >= READ_TABLE_STALL_NOTCHES/);
  assert.match(cs, /FindMenuCommand\(Native\.GetMenu\(window\), chord, 0, out id\)/);
});
