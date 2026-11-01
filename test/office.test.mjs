import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { buildOfficeTools, detectOfficeApps } = await import('../bin/lib/remote/office/index.mjs');
const { buildTools } = await import('../bin/lib/remote/toolHandlers.mjs');

function fakeHost() {
  const calls = [];
  return { calls, call: async (op, args) => { calls.push({ op, args }); return { ok: true }; } };
}

test('dò Office: chỉ Windows, không máy tính tổ chức, theo ProgID có trong registry', () => {
  const query = (key) => key.includes('Excel') || key.includes('Outlook');
  assert.deepEqual(detectOfficeApps({ platform: 'win32', query }), ['excel', 'outlook']);
  assert.deepEqual(detectOfficeApps({ platform: 'darwin', query }), []);
  assert.deepEqual(detectOfficeApps({ platform: 'win32', multiUser: true, query }), []);
});

test('chỉ khai công cụ của ứng dụng máy có; danh mục chung có office.* khi env.office', () => {
  const names = buildOfficeTools(fakeHost(), ['word']).map((t) => t.name);
  assert.deepEqual(names, ['office.word.read', 'office.word.edit']);
  const base = { roots: [os.tmpdir()], binaries: [], projects: [] };
  assert.equal(buildTools(base).some((t) => t.name.startsWith('office.')), false);
  const all = buildTools({ ...base, office: { host: fakeHost(), apps: ['excel', 'word', 'outlook'] } });
  assert.ok(all.find((t) => t.name === 'office.outlook.send' && !t.read_only));
  assert.ok(all.find((t) => t.name === 'office.excel.read' && t.read_only));
});

test('đường dẫn ngoài vùng / sai loại tệp / quá nhiều đính kèm bị chặn trước khi gọi Office', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'office-root-')));
  const host = fakeHost();
  const tools = Object.fromEntries(buildOfficeTools(host, ['excel', 'word', 'outlook']).map((t) => [t.name, t]));
  const env = { roots: [root] };
  await assert.rejects(tools['office.excel.read'].handler({ path: '../x.xlsx' }, {}, env), (e) => e.code === 'ROOT_DENIED');
  await assert.rejects(tools['office.excel.read'].handler({ path: 'notes.txt' }, {}, env), (e) => e.code === 'INVALID_ARGS');
  await assert.rejects(tools['office.word.edit'].handler({ path: 'a.xlsx', append: 'x' }, {}, env), (e) => e.code === 'INVALID_ARGS');
  await assert.rejects(tools['office.outlook.draft'].handler({ to: 'a@b.c', subject: 's', attachments: ['../../etc/passwd'] }, {}, env), (e) => e.code === 'ROOT_DENIED');
  await assert.rejects(tools['office.outlook.send'].handler({ to: 'a@b.c', subject: 's', attachments: Array(11).fill('a.txt') }, {}, env), (e) => e.code === 'INVALID_ARGS');
  assert.equal(host.calls.length, 0);
  await tools['office.excel.write'].handler({ path: 'r.xlsx', cells: { A1: 1 } }, {}, env);
  assert.equal(host.calls[0].args.op, 'excel.write');
  assert.equal(host.calls[0].args.path, path.join(root, 'r.xlsx'));
  // 02/11/2026: không nêu save → host quyết theo ai mở tệp (tệp người dùng đang mở thì không lưu) — trước đây luôn gửi save=true.
  assert.equal(host.calls[0].args.save, undefined);
  assert.equal(host.calls[0].args.formula, false);
});

test('excel.write / word.edit: save chỉ chuyển khi nêu rõ, công thức chỉ khi formula=true; mô tả công cụ nói rõ (02/11/2026)', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'office-root-')));
  const host = fakeHost();
  const tools = Object.fromEntries(buildOfficeTools(host, ['excel', 'word']).map((t) => [t.name, t]));
  const env = { roots: [root] };
  await tools['office.excel.write'].handler({ path: 'r.xlsx', cells: { A1: '=1+1' }, save: true, formula: true }, {}, env);
  await tools['office.excel.write'].handler({ path: 'r.xlsx', cells: { A1: 'x' }, save: false, formula: 'yes' }, {}, env);
  await tools['office.word.edit'].handler({ path: 'd.docx', append: 'x' }, {}, env);
  await tools['office.word.edit'].handler({ path: 'd.docx', append: 'x', save: true }, {}, env);
  assert.deepEqual(host.calls.map((c) => [c.args.save, c.args.formula]), [[true, true], [false, false], [undefined, undefined], [true, undefined]]);
  const write = tools['office.excel.write'];
  assert.ok(write.input_schema.properties.formula);
  assert.match(write.description, /NOT saved unless save is true/);
  assert.match(write.description, /plain text unless formula is true/);
  assert.match(tools['office.word.edit'].description, /NOT saved unless save is true/);
});

test('host Office (C#): sổ người dùng đang mở không lưu mặc định, chữ "=..." không thành công thức, bản ẩn ghi PID + Outlook do host bật thì Quit', async () => {
  const { OFFICE_CSHARP: cs } = await import('../bin/lib/remote/gui/officeHostSource.mjs');
  assert.match(cs, /return o\.Own \? B\(a, "save", true\) : !userDirty && B\(a, "save", false\)/);
  assert.match(cs, /res\["unsaved"\] = true/);
  // Người dùng đang có chỉnh dở (Saved=false, đọc trước khi ghi) → không lưu kể cả save=true (02/11/2026).
  assert.match(cs, /return !Convert\.ToBoolean\(Get\(o\.Doc, "Saved"\)\); \} catch \{ return true; \}/);
  assert.match(cs, /res\["user_had_unsaved_edits"\] = true/);
  assert.equal((cs.match(/bool userDirty = UserHasUnsavedEdits\(o\);/g) || []).length, 2);
  assert.match(cs, /if \(formula && s != null && s\.StartsWith\("="\)\) Set\(r, "Formula", s\)/);
  assert.match(cs, /data\[r, c\] = SafeCellValue\(arr\[c\], formula\)/);
  assert.match(cs, /TrackOwn\("EXCEL", before, own\)/);
  assert.match(cs, /TrackOwn\("WINWORD", before, own\)/);
  assert.match(cs, /QuitOutlookIfOurs\(app, ns, created, false\)/);
  assert.match(cs, /ComCount\(app, "Explorers"\) != 0/);
});

test('host Office (C#) chạy thật phần thuần: chống chèn công thức + dọn mồ côi chỉ đúng EXCEL/WINWORD đúng giờ khởi động', { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = await import('child_process');
  const { WINDOWS_HOST_CSHARP } = await import('../bin/lib/remote/gui/windowsHostSource.mjs');
  const fw = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const csc = path.join(fw, 'csc.exe');
  if (!fs.existsSync(csc)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-csc-'));
  const src = path.join(dir, 'host.cs');
  const dll = path.join(dir, 'host.dll');
  fs.writeFileSync(src, WINDOWS_HOST_CSHARP);
  const wpf = path.join(fw, 'WPF');
  const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map((r) => `-r:${path.join(wpf, r)}`);
  execFileSync(csc, ['-nologo', '-codepage:65001', '-target:library', `-out:${dll}`, ...refs, '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', '-r:System.Web.Extensions.dll', src], { encoding: 'utf8' });
  const orphans = path.join(dir, 'office-orphans.txt');
  // PID của chính tiến trình node (không phải EXCEL) + PID không tồn tại + dòng hỏng: không được giết gì, tệp được dọn.
  fs.writeFileSync(orphans, [`${process.pid}|EXCEL|1`, `${process.pid}|node|1`, '99999999|WINWORD|1', 'garbage'].join('\n'));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Path $env:AIVIN_TEST_DLL',
    "$m = [AivinGui.Office].GetMethod('SafeCellValue', [Reflection.BindingFlags]'NonPublic,Static')",
    "$vals = @('=HYPERLINK(1)', '+1', '-x', '@SUM(A1)', 'hello', '', '-5', '-1500000', '+3.5', '-1,25', '+84 912 345', '-', '-5-1', '+A1', '-.5')",
    '$safe = @($vals | ForEach-Object { $m.Invoke($null, [object[]]@([string]$_, $false)) })',
    "$formula = $m.Invoke($null, @('=1+1', $true))",
    '$killed = [AivinGui.Office]::CleanupOrphans()',
    '@{ safe = $safe; formula = $formula; killed = $killed; left = (Test-Path -LiteralPath $env:AIVIN_GUI_ORPHANS) } | ConvertTo-Json -Compress',
  ].join('\n');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, AIVIN_TEST_DLL: dll, AIVIN_GUI_ORPHANS: orphans }, windowsHide: true,
  });
  const res = JSON.parse(out.trim().split(/\r?\n/).at(-1));
  // Số viết dạng chuỗi giữ nguyên (Excel tự đổi thành số); SĐT có khoảng trắng / "-5-1" / ô tham chiếu vẫn thành chữ.
  assert.deepEqual(res.safe, ["'=HYPERLINK(1)", '+1', "'-x", "'@SUM(A1)", 'hello', '', '-5', '-1500000', '+3.5', '-1,25', "'+84 912 345", "'-", "'-5-1", "'+A1", "'-.5"]);
  assert.equal(res.formula, '=1+1');
  assert.equal(res.killed, 0);
  assert.equal(res.left, false);
});
