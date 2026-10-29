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
  assert.equal(host.calls[0].args.save, true);
});
