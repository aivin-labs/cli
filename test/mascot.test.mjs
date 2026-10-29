import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascot, loadMascotSettings, HostCommand, HostEvent, MascotState, LogStatus } = await import('../bin/lib/remote/mascot/index.mjs');
const { describeStep, argsPreview, targetOf } = await import('../bin/lib/remote/mascot/labels.mjs');
const { MascotText, SUPPORTED_LANGS, mascotLang, mascotText } = await import('../bin/lib/remote/mascot/strings.mjs');
const { MASCOT_PS1, MASCOT_XAML } = await import('../bin/lib/remote/mascot/hostSource.mjs');
const { MASCOT_DEMO_STATES, UiResult, showMascotDemo } = await import('../bin/lib/remote/mascot/ui.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-mascot-'));
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tiến trình cửa sổ giả: ghi lại mọi lệnh daemon gửi; `emit(evt)` = cửa sổ gửi sự kiện về. */
function fakeHost() {
  const spawned = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.sent = [];
    child.stdin = { write: (s) => { child.sent.push(...String(s).trim().split('\n').map((l) => JSON.parse(l))); }, end: () => {}, on: () => {} };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 0);
    child.emit = child.emit.bind(child);
    child.send = (evt) => child.stdout.write(`${JSON.stringify(evt)}\n`);
    spawned.push(child);
    return child;
  };
  return { spawned, spawnImpl };
}

function makeMascot(extra = {}) {
  const dir = tmp();
  const host = fakeHost();
  const calls = { pause: 0, resume: 0 };
  const m = createMascot({
    platform: 'win32', env: { AIVIN_LANG: 'vi' }, spawnImpl: host.spawnImpl, dir: path.join(dir, 'host'), settingsFile: path.join(dir, 'mascot.json'),
    onPause: () => calls.pause++, onResume: () => calls.resume++, thinkMs: 30, resultMs: 30, mainThrottleMs: 0, restartDelaysMs: [10], ...extra,
  });
  return { m, host, calls, dir, settingsFile: path.join(dir, 'mascot.json') };
}

const readTool = { name: 'fs.read', group: 'fs_read' };
const guiTool = { name: 'gui.act', group: 'gui' };

test('nhãn bước: mục đích của Planner thắng; bước chỉ đọc → động từ + tên tệp; nội dung ghi tệp không lộ ra nhật ký', () => {
  const withPurpose = describeStep({ call: { tool: 'fs.write', purpose: 'Lưu bản tóm tắt cuộc họp', args: { path: 'D:/a/b/tom-tat.md', content: 'bí mật '.repeat(50) } }, tool: { group: 'fs_write' }, lang: 'vi' });
  assert.equal(withPurpose.title, 'Lưu bản tóm tắt cuộc họp');
  assert.ok(!withPurpose.detail.includes('bí mật'));
  assert.match(withPurpose.detail, /"content":"‹350›"/);
  assert.equal(describeStep({ call: { tool: 'fs.read', args: { path: 'C:\\Users\\a\\Bao cao Q3.xlsx' } }, tool: readTool, lang: 'vi' }).title, 'Đọc Bao cao Q3.xlsx');
  assert.equal(describeStep({ call: { tool: 'shell.exec', args: { command: 'npm test' } }, tool: { group: 'exec' }, lang: 'en' }).title, 'Run command npm test');
  assert.equal(describeStep({ call: { tool: 'office.excel.write_range', args: {} }, tool: { group: 'office' }, lang: 'vi' }).title, 'Làm trên Excel');
  assert.equal(targetOf({ query: 'hợp đồng thuê' }), '"hợp đồng thuê"');
  assert.equal(argsPreview({}), '');
});

test('ngôn ngữ: AIVIN_LANG → LANG → Intl, không có bản dịch thì tiếng Anh; mọi khoá có đủ ở mọi ngôn ngữ', () => {
  assert.equal(mascotLang({ AIVIN_LANG: 'vi' }), 'vi');
  assert.equal(mascotLang({ AIVIN_LANG: 'xx', LANG: 'vi_VN.UTF-8' }, 'linux'), 'vi');
  assert.equal(mascotLang({ LANG: 'vi_VN.UTF-8' }, 'win32'), mascotLang({}, 'win32'), 'Windows bỏ qua LANG của Git Bash');
  assert.ok(SUPPORTED_LANGS.includes(mascotLang({ AIVIN_LANG: 'zz', LANG: 'zz' })));
  for (const lang of SUPPORTED_LANGS) for (const key of Object.values(MascotText)) assert.notEqual(mascotText(lang, key), key, `${lang}.${key}`);
  assert.equal(mascotText('vi', MascotText.DONE_MANY, { count: 3 }), 'Xong 3 bước');
});

test('mã PowerShell giữ toàn ASCII (PowerShell 5 đọc .ps1 không BOM bằng bảng mã cũ); XAML không còn chỗ chưa điền', () => {
  assert.ok([...MASCOT_PS1].every((c) => c.charCodeAt(0) < 128), 'host.ps1 phải ASCII');
  assert.ok(!MASCOT_XAML.includes('${') && !MASCOT_XAML.includes('undefined'));
});

test('không phải Windows → no-op; đã tắt → không mở cửa sổ (ngủ, chờ `aivin ui` đánh thức)', () => {
  const host = fakeHost();
  const off = createMascot({ platform: 'linux', spawnImpl: host.spawnImpl });
  off.callStarted({ call_id: 'x', tool: 'fs.read' }, readTool);
  assert.equal(off.enabled, false);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ enabled: false }));
  const sleeping = createMascot({ platform: 'win32', spawnImpl: host.spawnImpl, settingsFile: path.join(dir, 'm.json'), dir, showFile: path.join(dir, 'show') });
  sleeping.callStarted({ call_id: 'x', tool: 'fs.read' }, readTool);
  sleeping.close();
  assert.equal(host.spawned.length, 0);
});

test('ui --demo: không cần ghép máy, chạy đủ 8 trạng thái theo vòng và dọn timer khi đóng', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.sent = [];
  child.stdin = { write: (line) => child.sent.push(JSON.parse(String(line))), end: () => {} };
  let intervalFn = null; let cleared = false;
  const result = showMascotDemo({ platform: 'win32', deps: {
    writeHostFiles: () => 'C:\\preview', loadMascotSettings: () => ({ enabled: true }), spawn: () => child,
    setInterval: (fn) => { intervalFn = fn; return 7; }, clearInterval: (id) => { if (id === 7) cleared = true; },
  } });
  assert.equal(result, UiResult.DEMO);
  child.stdout.write(`${JSON.stringify({ t: HostEvent.READY })}\n`);
  await tick();
  assert.deepEqual(child.sent.filter((m) => m.t === HostCommand.STATE).map((m) => m.state), [MASCOT_DEMO_STATES[0]]);
  for (let i = 1; i < MASCOT_DEMO_STATES.length; i++) intervalFn();
  assert.deepEqual(child.sent.filter((m) => m.t === HostCommand.STATE).map((m) => m.state), MASCOT_DEMO_STATES);
  child.emit('close', 0);
  assert.equal(cleared, true);
  assert.equal(showMascotDemo({ platform: 'linux' }), UiResult.UNSUPPORTED);
});

test('lệnh chờ tới khi cửa sổ sẵn sàng; bước chạy → đang làm + bong bóng + nhật ký; xong → đang nghĩ → xong → chờ việc (không giữ kết quả cũ)', async () => {
  const { m, host } = makeMascot();
  const child = host.spawned[0];
  m.connected();
  m.callStarted({ call_id: 'c1', tool: 'fs.read', args: { path: 'D:/x/report.xlsx' } }, readTool);
  assert.equal(child.sent.length, 0, 'chưa sẵn sàng thì chưa gửi');
  child.send({ t: HostEvent.READY });
  await tick();
  assert.deepEqual(child.sent.filter((c) => c.t === HostCommand.STATE).at(-1), { t: 'state', state: MascotState.WORKING });
  assert.ok(child.sent.some((c) => c.t === HostCommand.LOG && c.id === 'c1' && c.status === LogStatus.RUN && c.title === 'Đọc report.xlsx'));
  child.sent.length = 0;
  m.callFinished({ call_id: 'c1' }, readTool, { ok: true, duration_ms: 42 });
  assert.ok(child.sent.some((c) => c.t === HostCommand.LOG && c.id === 'c1' && c.status === LogStatus.OK && /42 ms/.test(c.sub)));
  assert.ok(child.sent.some((c) => c.t === HostCommand.STATE && c.state === MascotState.THINKING));
  await sleep(45);
  assert.ok(child.sent.some((c) => c.t === HostCommand.STATE && c.state === MascotState.DONE));
  await sleep(45);
  assert.deepEqual(child.sent.filter((c) => c.t === HostCommand.STATE).at(-1).state, MascotState.IDLE);
  assert.deepEqual(child.sent.at(-1), { t: 'main', text: 'Sẵn sàng nhận việc', quiet: true });
  m.close();
});

test('lô kế tới trong lúc "đang nghĩ" → không báo xong giữa chừng; bước hỏng → trạng thái lỗi kèm tên bước', async () => {
  const { m, host } = makeMascot({ thinkMs: 40 });
  const child = host.spawned[0];
  child.send({ t: HostEvent.READY });
  await tick();
  m.callStarted({ call_id: 'a', tool: 'fs.read', args: { path: 'a.txt' } }, readTool);
  m.callFinished({ call_id: 'a' }, readTool, { ok: true });
  await sleep(15);
  m.callStarted({ call_id: 'b', tool: 'shell.exec', args: { command: 'npm test' } }, { group: 'exec' });
  m.callFinished({ call_id: 'b' }, { group: 'exec' }, { ok: false, error: 'exit 1' });
  await sleep(60);
  const states = child.sent.filter((c) => c.t === HostCommand.STATE).map((c) => c.state);
  assert.ok(!states.slice(0, states.indexOf(MascotState.ERROR)).includes(MascotState.DONE), states.join(','));
  assert.ok(states.includes(MascotState.ERROR));
  assert.ok(child.sent.some((c) => c.t === HostCommand.MAIN && c.text === 'Lỗi: Chạy lệnh npm test'));
  m.close();
});

test('AI thao tác cửa sổ → linh vật tránh đường (ẩn) tới khi xong; ẩn tới khi có việc → hiện lại ở việc kế', async () => {
  const { m, host } = makeMascot();
  const child = host.spawned[0];
  child.send({ t: HostEvent.READY });
  await tick();
  m.callStarted({ call_id: 'g1', tool: 'gui.act', args: {} }, guiTool);
  m.callStarted({ call_id: 'g2', tool: 'gui.act', args: {} }, guiTool);
  m.callFinished({ call_id: 'g1' }, guiTool, { ok: true });
  assert.deepEqual(child.sent.filter((c) => c.t === HostCommand.GUI), [{ t: 'gui', active: true }]);
  m.callFinished({ call_id: 'g2' }, guiTool, { ok: true });
  assert.deepEqual(child.sent.filter((c) => c.t === HostCommand.GUI).at(-1), { t: 'gui', active: false });
  child.send({ t: HostEvent.HIDE });
  await tick();
  m.callStarted({ call_id: 'r', tool: 'fs.read', args: {} }, readTool);
  assert.ok(child.sent.some((c) => c.t === HostCommand.SHOW));
  m.close();
});

test('nút trên bảng: tạm dừng / làm tiếp gọi công tắc ngắt; kéo đi → nhớ vị trí; tắt linh vật → lưu tắt + đóng cửa sổ', async () => {
  const { m, host, calls, settingsFile } = makeMascot();
  const child = host.spawned[0];
  child.send({ t: HostEvent.READY });
  child.send({ t: HostEvent.PAUSE });
  child.send({ t: HostEvent.RESUME });
  child.send({ t: HostEvent.POS, x: 640, y: 756 });
  await tick();
  assert.deepEqual(calls, { pause: 1, resume: 1 });
  assert.deepEqual(loadMascotSettings(settingsFile), { enabled: true, x: 640, y: 756 });
  m.paused(true);
  assert.ok(child.sent.some((c) => c.t === HostCommand.STATE && c.state === MascotState.PAUSED));
  child.send({ t: HostEvent.OFF });
  await tick();
  assert.equal(loadMascotSettings(settingsFile).enabled, false);
  assert.ok(child.sent.some((c) => c.t === HostCommand.QUIT));
});

test('cửa sổ chết (không có màn hình…) → dựng lại theo nhịp, gửi lại trạng thái mới nhất; hết lượt thì thôi, daemon không sao', async () => {
  const said = [];
  const { m, host } = makeMascot({ restartDelaysMs: [5], say: (s) => said.push(s) });
  m.callStarted({ call_id: 'c', tool: 'fs.read', args: { path: 'x.txt' } }, readTool);
  host.spawned[0].emit('close', 1);
  await sleep(20);
  assert.equal(host.spawned.length, 2);
  const second = host.spawned[1];
  second.send({ t: HostEvent.READY });
  await tick();
  assert.ok(second.sent.some((c) => c.t === HostCommand.STATE && c.state === MascotState.WORKING), 'gửi lại trạng thái');
  assert.ok(second.sent.some((c) => c.t === HostCommand.MAIN && c.quiet), 'gửi lại việc chính, không bật bong bóng');
  // Đã lên được thì chết lần sau được dựng lại từ đầu; không lên nổi lần nào nữa → thôi, báo một dòng.
  second.emit('close', 1);
  await sleep(20);
  assert.equal(host.spawned.length, 3);
  host.spawned[2].emit('close', 1);
  await sleep(20);
  assert.equal(host.spawned.length, 3);
  assert.equal(said.length, 1);
  m.close();
});

test('ô hỏi: cửa sổ chủ máy đang dùng (từ cửa sổ linh vật) tới onAsk / voice_start, dữ liệu lạ bị bỏ; pid() của cửa sổ', async () => {
  const asked = [];
  const voice = [];
  const { m, host } = makeMascot({ onAsk: (text, window) => asked.push({ text, window }), onVoice: (msg) => voice.push(msg) });
  m.connected();
  await tick();
  const child = host.spawned[0];
  child.pid = 4321;
  assert.equal(m.pid(), 4321);
  child.send({ t: 'ready' });
  child.send({ t: 'ask', text: 'cái này là gì', window: { window: '0xabc', title: 'Excel', process: 'EXCEL', extra: 1 } });
  child.send({ t: 'ask', text: 'hai', window: { window: 'calc.exe' } });
  child.send({ t: 'voice_start', window: { window: '0x1f', title: 't'.repeat(300) } });
  await sleep(20);
  assert.deepEqual(asked[0], { text: 'cái này là gì', window: { window: '0xabc', title: 'Excel', process: 'EXCEL' } });
  assert.equal(asked[1].window, null);
  assert.equal(voice[0].t, 'voice_start');
  assert.equal(voice[0].window.title.length, 200);
  m.close();
});
