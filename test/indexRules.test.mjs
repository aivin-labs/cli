import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const remote = await import('../bin/lib/remoteControl.mjs');
const { FolderKind, classifyDir, skipFile } = await import('../bin/lib/remote/folderRules.mjs');
const { cloudOnlyFiles, inCloudFolder } = await import('../bin/lib/remote/cloudFiles.mjs');
const { osFileSearch, windowsSearchSql } = await import('../bin/lib/remote/osSearch.mjs');

const sandboxDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-rules-root-'));
const write = (file, content = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const dirent = (name, dir = false) => ({ name, isFile: () => !dir, isDirectory: () => dir });

test('phân loại thư mục: cài đặt / hồ sơ Chromium / venv / .app, kho git, hàng loạt ảnh; nhiều tài liệu thì không gộp', () => {
  assert.equal(classifyDir('MyApp', [dirent('app.exe'), dirent('a.dll'), dirent('b.dll'), dirent('c.dll')]), FolderKind.APP);
  assert.equal(classifyDir('app', [dirent('Local State'), dirent('Cache', true), dirent('GPUCache', true)]), FolderKind.APP);
  assert.equal(classifyDir('venv2', [dirent('pyvenv.cfg'), dirent('Lib', true)]), FolderKind.APP);
  assert.equal(classifyDir('Safari.app', []), FolderKind.APP);
  assert.equal(classifyDir('shop', [dirent('.git', true), dirent('src', true)]), FolderKind.REPO);
  const shots = Array.from({ length: 320 }, (_, i) => dirent(`Screenshot ${i}.png`));
  assert.equal(classifyDir('Screenshots', shots), FolderKind.BULK);
  const invoices = Array.from({ length: 320 }, (_, i) => dirent(`hoa-don-${i}.pdf`));
  assert.equal(classifyDir('Hoa don', invoices), null); // 320 PDF: vẫn lập chỉ mục từng tệp
  assert.equal(classifyDir('Desktop', [dirent('a.exe'), dirent('note.docx')]), null);
  for (const junk of ['report.tmp', 'x.bak', '~$Hop dong.docx', '.DS_Store', 'Thumbs.db', 'setup.exe.crdownload', 'ntuser.dat.LOG1']) assert.ok(skipFile(junk), junk);
  for (const keep of ['Hop dong.docx', 'setup.exe', 'logo.png', 'server.log']) assert.ok(!skipFile(keep), keep);
});

test('chỉ mục: gộp ảnh chụp màn hình / thư mục ứng dụng / kho git thành một mục; tài liệu bên trong vẫn tìm được; bỏ tệp tạm', async () => {
  const root = sandboxDir();
  for (let i = 0; i < 310; i++) write(path.join(root, 'Pictures', 'Screenshots', `Screenshot 2026-10-${i}.png`));
  write(path.join(root, 'Pictures', 'Screenshots', 'bao-cao-quy-3.txt'), 'bao cao doanh thu quy 3');
  for (const f of ['MyApp.exe', 'a.dll', 'b.dll', 'c.dll', 'huong-dan.txt']) write(path.join(root, 'tools', 'MyApp', f));
  write(path.join(root, 'code', 'shop', '.git', 'HEAD'), 'ref: refs/heads/main');
  write(path.join(root, 'code', 'shop', 'README.md'), '# Shop backend\nOrders and payments');
  write(path.join(root, 'code', 'shop', 'src', 'server.ts'), 'export class CheckoutService { pay() {} }');
  write(path.join(root, 'code', 'shop', 'docs', 'spec.md'), 'Đặc tả thanh toán');
  write(path.join(root, 'Documents', 'nhap.tmp'), 'tam');
  write(path.join(root, 'Documents', 'Hop dong thue.txt'), 'hop dong thue van phong');

  const index = remote.createFileIndex([root]);
  const built = await index.build();
  assert.equal(built.folders, 3); // Screenshots + MyApp + shop

  const shots = index.search('screenshots', 5).find((r) => r.type === 'folder');
  assert.equal(shots.kind, FolderKind.BULK);
  assert.equal(shots.items, 311);
  assert.match(shots.note, /311 files \(\.png 310/);
  assert.ok(!index.search('screenshot 2026', 20).some((r) => r.path.endsWith('.png'))); // không lập chỉ mục lẻ từng ảnh
  assert.match(index.search('bao cao doanh thu', 5)[0].path, /bao-cao-quy-3\.txt$/); // tài liệu trong thư mục gộp vẫn có

  assert.equal(index.search('MyApp', 5)[0].kind, FolderKind.APP);
  assert.ok(!index.search('huong dan', 5).some((r) => r.path.endsWith('huong-dan.txt')));

  const repo = index.search('shop backend', 5).find((r) => r.type === 'folder');
  assert.equal(repo.kind, FolderKind.REPO);
  assert.match(repo.note, /README: # Shop backend/);
  assert.equal(index.search('CheckoutService', 5).length, 0); // code: dùng fs.grep
  assert.match(index.search('dac ta thanh toan', 5)[0].path, /spec\.md$/);

  assert.ok(!index.search('nhap', 5).some((r) => r.path.endsWith('.tmp')));
  assert.match(index.search('hop dong thue', 5)[0].path, /Hop dong thue\.txt$/);

  // Thư mục làm việc người dùng chỉ định: lập chỉ mục cả code trong kho git; bỏ thì code ra khỏi chỉ mục.
  const shop = path.join(root, 'code', 'shop');
  const added = await index.addFolder(shop);
  assert.equal(added.done, true);
  assert.deepEqual(index.folders(), [shop]);
  assert.match(index.search('CheckoutService', 5)[0].path, /server\.ts$/);
  assert.deepEqual(remote.loadIndexFolders(), [shop]);
  await index.removeFolder(shop);
  assert.equal(index.search('CheckoutService', 5).length, 0);
  assert.deepEqual(remote.loadIndexFolders(), []);
  index.close();
});

test('bộ theo dõi: ảnh mới trong thư mục gộp không lập chỉ mục lẻ, tài liệu mới thì có', async () => {
  const root = sandboxDir();
  for (let i = 0; i < 305; i++) write(path.join(root, 'Screenshots', `s${i}.png`));
  const index = remote.createFileIndex([root]);
  await index.build();
  index.watch();
  const before = index.stats().files;
  write(path.join(root, 'Screenshots', 'moi.png'));
  write(path.join(root, 'Screenshots', 'bien-ban-hop.txt'), 'bien ban hop thang 10');
  write(path.join(root, 'ghi-chu.tmp'), 'tam');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(index.stats().files, before + 1);
  assert.match(index.search('bien ban hop', 5)[0].path, /bien-ban-hop\.txt$/);
  index.close();
});

test('tệp chỉ có trên mây: chỉ lập chỉ mục tên, không mở tệp (mở = Windows tải về)', async (t) => {
  assert.equal(inCloudFolder(path.join('C:', 'Users', 'a', 'OneDrive - Cong ty', 'x.docx'), 'win32'), true);
  assert.equal(inCloudFolder(path.join('C:', 'Users', 'a', 'Documents', 'x.docx'), 'win32'), false);
  assert.equal(inCloudFolder('/Users/a/OneDrive/x.docx', 'darwin'), false);
  assert.deepEqual([...await cloudOnlyFiles(['a', 'b'], { platform: 'win32', run: async () => 'b\r\n' })], ['b']);
  assert.deepEqual([...await cloudOnlyFiles(['a', 'b'], { platform: 'win32', run: async () => { throw new Error('blocked'); } })], ['a', 'b']);
  assert.equal((await cloudOnlyFiles(['a'], { platform: 'linux' })).size, 0);
  if (process.platform !== 'win32') return t.skip('cần thuộc tính tệp của Windows');

  const root = sandboxDir();
  const local = path.join(root, 'OneDrive', 'bao-gia-may-in.txt');
  const cloud = path.join(root, 'OneDrive', 'hop-dong-thue-xe.txt');
  write(local, 'bao gia may in canon');
  write(cloud, 'noi dung chua tai ve');
  execFileSync('attrib', ['+O', cloud]);
  try {
    const index = remote.createFileIndex([root]);
    await index.build();
    assert.equal(index.search('canon', 5)[0]?.preview, 'bao gia may in canon');
    const hit = index.search('hop dong thue xe', 5)[0];
    assert.match(hit.path, /hop-dong-thue-xe\.txt$/); // tìm được theo tên
    assert.equal(hit.preview, undefined); // không đọc nội dung
    assert.equal(index.search('chua tai ve', 5).length, 0);
    index.close();
  } finally {
    execFileSync('attrib', ['-O', cloud]);
  }
});

test('tìm qua bộ tìm của hệ điều hành: lọc lại theo gốc được phép + vùng cấm; lỗi → rỗng', async () => {
  const root = sandboxDir();
  const inside = path.join(root, 'Design', 'logo-v3.ai');
  write(inside, 'x');
  const outside = path.join(os.tmpdir(), 'logo-v3-outside.ai');
  const protectedFile = path.join(process.env.AIVIN_REMOTE_HOME, 'logo-v3.json');
  const exec = async () => [inside, outside, protectedFile].map((p) => `${p}\t12\t2026-10-30`).join('\r\n');
  const hits = await osFileSearch('logo v3', { roots: [root], limit: 5, platform: 'win32', exec });
  assert.deepEqual(hits.map((h) => h.abs), [inside]);
  assert.equal(hits[0].modified, '2026-10-30');
  assert.deepEqual(await osFileSearch('logo', { roots: [root], platform: 'win32', exec: async () => { throw new Error('no service'); } }), []);
  const linux = await osFileSearch('logo v3', { roots: [root], platform: 'linux', exec: async () => `${inside}\n${path.join(root, 'logo-old.ai')}\n` });
  assert.deepEqual(linux.map((h) => h.abs), [inside]); // mọi từ phải khớp đường dẫn

  const sql = windowsSearchSql(['hop', 'dong'], ["C:\\Users\\O'Neil"], 5);
  assert.match(sql, /SCOPE='file:C:\/Users\/O''Neil'/);
  assert.match(sql, /System\.FileName LIKE '%hop%' OR CONTAINS\(\*, '"hop\*"'\)\) AND \(System\.FileName LIKE '%dong%'/);
});

test('fs.find: thiếu kết quả thì thêm từ bộ tìm hệ điều hành (source: os), không trùng; fs.index_folder chỉ nhận thư mục trong gốc', async () => {
  const root = sandboxDir();
  write(path.join(root, 'notes', 'hop-dong-a.txt'), 'hop dong a');
  const fileIndex = remote.createFileIndex([root]);
  await fileIndex.build();
  const env = { roots: [root], binaries: [], projects: [], fileIndex };
  const tools = new Map(remote.buildTools(env).map((t) => [t.name, t]));
  const ctx = { signal: new AbortController().signal };
  assert.ok(tools.has('fs.index_folder'));

  const found = await tools.get('fs.find').handler({ query: 'zzqqxx-khong-co' }, ctx, { ...env, osSearch: false });
  assert.deepEqual(found.results, []);
  const local = await tools.get('fs.find').handler({ query: 'hop dong', limit: 1 }, ctx, env); // đủ kết quả → không hỏi hệ điều hành
  assert.equal(local.results.length, 1);
  assert.equal(local.results[0].abs, undefined);

  // Kết quả yếu (tốt nhất không chứa đủ các từ): hỏi hệ điều hành, xếp kết quả của nó lên trước.
  const shot = path.join(root, 'Screenshots', 'Screenshot 2026-08-21 104302.png');
  const weak = await tools.get('fs.find').handler({ query: 'hop dong screenshot 2026', limit: 1 }, ctx, { ...env, osSearch: async () => [{ abs: shot, size: 9, modified: '2026-08-21' }] });
  assert.equal(weak.results[0].source, 'os');
  assert.match(weak.results[0].path, /Screenshot 2026-08-21 104302\.png$/);

  await assert.rejects(tools.get('fs.index_folder').handler({ path: '../ngoai-goc' }, ctx, env), /outside|denied/i);
  await assert.rejects(tools.get('fs.index_folder').handler({ path: 'notes/hop-dong-a.txt' }, ctx, env), /Not a folder/);
  const res = await tools.get('fs.index_folder').handler({ path: 'notes' }, ctx, env);
  assert.equal(res.done, true);
  assert.deepEqual(res.working_folders, ['notes']);
  await tools.get('fs.index_folder').handler({ path: 'notes', remove: true }, ctx, env);
  assert.deepEqual(remote.loadIndexFolders(), []);
  fileIndex.close();
});
