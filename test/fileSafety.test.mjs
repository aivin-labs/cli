import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { buildTools, toolMap } = await import('../bin/lib/remote/toolHandlers.mjs');
const { createUndoStore } = await import('../bin/lib/remote/undoStore.mjs');
const { looksSecret } = await import('../bin/lib/remote/fileIndexer.mjs');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-safety-'));
  const undo = createUndoStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'undo-')) });
  const env = { roots: [root], binaries: [], projects: [], undo };
  const tools = toolMap(buildTools(env));
  const call = (name, args = {}) => tools.get(name).handler(args, {}, env);
  const p = (rel) => path.join(root, rel);
  return { root, env, call, p, undo };
}

test('ghi đè / sửa giữ bản cũ; xoá vào thùng rác; tạo mới — hoàn tác cả nhóm trả đúng như trước', async () => {
  const { call, p } = setup();
  fs.writeFileSync(p('a.txt'), 'gốc');
  fs.mkdirSync(p('dir'));
  fs.writeFileSync(p('dir/b.txt'), 'b');
  const g = { undo_group: 'task1' };
  const w = await call('fs.write', { path: 'a.txt', content: 'mới', ...g });
  assert.equal(w.previous_version_kept, true);
  await call('fs.edit', { path: 'a.txt', oldText: 'mới', newText: 'mới nữa', ...g });
  await call('fs.write', { path: 'new.txt', content: 'x', ...g });
  const d = await call('fs.delete', { path: 'dir', ...g });
  assert.equal(d.recoverable, true);
  assert.equal(fs.existsSync(p('dir')), false);

  const hist = await call('fs.history');
  assert.equal(hist.groups[0].group, 'task1');
  const res = await call('fs.undo', {});
  assert.equal(res.group, 'task1');
  assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'gốc');
  assert.equal(fs.readFileSync(p('dir/b.txt'), 'utf8'), 'b');
  assert.equal(fs.existsSync(p('new.txt')), false);
  await assert.rejects(call('fs.undo', { group: 'task1' }), /already undone/);
});

test('hoàn tác không đè thứ người dùng tạo sau ở cùng chỗ', async () => {
  const { call, p } = setup();
  fs.writeFileSync(p('x.txt'), '1');
  await call('fs.delete', { path: 'x.txt', undo_group: 'g2' });
  fs.writeFileSync(p('x.txt'), 'của người dùng');
  const res = await call('fs.undo', { group: 'g2' });
  assert.equal(res.skipped.length, 1);
  assert.equal(fs.readFileSync(p('x.txt'), 'utf8'), 'của người dùng');
});

test('move_many: dry_run chỉ kiểm, không đổi; chạy thật một lô + hoàn tác cả lô; mục lỗi không chặn mục khác', async () => {
  const { call, p } = setup();
  for (const n of ['a.pdf', 'b.pdf', 'c.jpg']) fs.writeFileSync(p(n), n);
  const moves = [{ from: 'a.pdf', to: 'PDF/a.pdf' }, { from: 'b.pdf', to: 'PDF/b.pdf' }, { from: 'c.jpg', to: 'Ảnh/c.jpg' }, { from: 'missing.txt', to: 'X/missing.txt' }];
  const plan = await call('fs.move_many', { moves, dry_run: true });
  assert.equal(plan.would_move, 3);
  assert.equal(plan.problems.length, 1);
  assert.equal(fs.existsSync(p('a.pdf')), true);
  const res = await call('fs.move_many', { moves, undo_group: 'org' });
  assert.equal(res.moved, 3);
  assert.equal(res.failed.length, 1);
  assert.equal(fs.existsSync(p('PDF/b.pdf')), true);
  fs.writeFileSync(p('Ảnh/của-người-dùng.png'), 'x');
  await call('fs.undo', { group: 'org' });
  for (const n of ['a.pdf', 'b.pdf', 'c.jpg']) assert.equal(fs.existsSync(p(n)), true, n);
  // Thư mục AI tạo: rỗng → bỏ; người dùng đã bỏ tệp vào → giữ.
  assert.equal(fs.existsSync(p('PDF')), false);
  assert.equal(fs.existsSync(p('Ảnh/của-người-dùng.png')), true);
});

test('delete_many + permanent; đè đích khi move giữ đích cũ để hoàn tác; quá 1000 mục bị từ chối', async () => {
  const { call, p } = setup();
  fs.writeFileSync(p('1.log'), '1');
  fs.writeFileSync(p('2.log'), '2');
  const r = await call('fs.delete_many', { paths: ['1.log', '2.log', 'nope.log'], undo_group: 'd' });
  assert.equal(r.deleted, 2);
  assert.equal(r.missing.length, 1);
  fs.writeFileSync(p('src.txt'), 'mới');
  fs.writeFileSync(p('dst.txt'), 'cũ');
  await call('fs.move', { sourcePath: 'src.txt', destinationPath: 'dst.txt', overwrite: true, undo_group: 'm' });
  await call('fs.undo', { group: 'm' });
  assert.equal(fs.readFileSync(p('dst.txt'), 'utf8'), 'cũ');
  assert.equal(fs.readFileSync(p('src.txt'), 'utf8'), 'mới');
  fs.writeFileSync(p('gone.txt'), 'x');
  const perm = await call('fs.delete', { path: 'gone.txt', permanent: true });
  assert.equal(perm.recoverable, false);
  await assert.rejects(call('fs.delete_many', { paths: Array(1001).fill('a') }), /At most 1000/);
  await assert.rejects(call('fs.move_many', { moves: [{ from: '../x', to: 'y' }] }).then((x) => { if (x.failed.length) throw new Error(x.failed[0].code); }), /ROOT_DENIED/);
});

test('không có kho hoàn tác (máy tính tổ chức) → xoá như cũ, fs.undo báo không có', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-noundo-'));
  const env = { roots: [root], binaries: [], projects: [] };
  const tools = toolMap(buildTools(env));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const r = await tools.get('fs.delete').handler({ path: 'a.txt' }, {}, env);
  assert.equal(r.recoverable, false);
  assert.throws(() => tools.get('fs.undo').handler({}, {}, env), /not kept/);
});

test('fs.list: lọc đuôi / tên / ngày / dung lượng, sắp xếp; fs.measure đếm quy mô', async () => {
  const { call, p } = setup();
  fs.writeFileSync(p('old.pdf'), 'x'.repeat(5000));
  fs.writeFileSync(p('new.pdf'), 'x'.repeat(100));
  fs.writeFileSync(p('invoice-1.docx'), 'x');
  const old = Date.now() / 1000 - 40 * 86400;
  fs.utimesSync(p('old.pdf'), old, old);
  const pdfOld = await call('fs.list', { ext: 'pdf', modifiedBefore: '30' });
  assert.deepEqual(pdfOld.entries.map((e) => e.path), ['old.pdf']);
  const bySize = await call('fs.list', { ext: '.pdf', sort: 'size' });
  assert.deepEqual(bySize.entries.map((e) => e.path), ['old.pdf', 'new.pdf']);
  const named = await call('fs.list', { name: 'invoice*' });
  assert.deepEqual(named.entries.map((e) => e.path), ['invoice-1.docx']);
  const big = await call('fs.list', { minSize: 1000, filesOnly: true });
  assert.deepEqual(big.entries.map((e) => e.path), ['old.pdf']);
  const m = await call('fs.measure', { paths: ['old.pdf', 'new.pdf', 'none'] });
  assert.equal(m.files, 2);
  assert.equal(m.bytes, 5100);
  assert.equal(m.missing, 1);
});

test('chỉ mục: tệp như chứa bí mật chỉ giữ tên', () => {
  assert.equal(looksSecret('C:/a/mat-khau-ngan-hang.txt'), true);
  assert.equal(looksSecret('C:/a/report.docx', 'api_key = abcd1234efgh'), true);
  assert.equal(looksSecret('C:/a/tokenizer.ts'), false);
  assert.equal(looksSecret('C:/a/ke-hoach.docx', 'kế hoạch quý 4'), false);
});

test('fs.write append: tệp chưa kết thúc bằng xuống dòng thì chèn một xuống dòng theo kiểu của tệp', async () => {
  const { call, p } = setup();
  fs.writeFileSync(p('lf.log'), 'dòng 1');
  const r = await call('fs.write', { path: 'lf.log', content: 'dòng 2', append: true });
  assert.equal(fs.readFileSync(p('lf.log'), 'utf8'), 'dòng 1\ndòng 2');
  assert.equal(r.line_break_added, true);
  fs.writeFileSync(p('crlf.log'), 'a\r\nb');
  await call('fs.write', { path: 'crlf.log', content: 'c', append: true });
  assert.equal(fs.readFileSync(p('crlf.log'), 'utf8'), 'a\r\nb\r\nc');
  fs.writeFileSync(p('ok.log'), 'x\n');
  const ok = await call('fs.write', { path: 'ok.log', content: 'y', append: true });
  assert.equal(fs.readFileSync(p('ok.log'), 'utf8'), 'x\ny');
  assert.equal(ok.line_break_added, undefined);
  await call('fs.write', { path: 'new.log', content: 'z', append: true });
  assert.equal(fs.readFileSync(p('new.log'), 'utf8'), 'z');
});
