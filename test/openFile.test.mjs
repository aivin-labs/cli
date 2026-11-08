import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { appWindowCommand, driveOpenUrl, fileSha256, indexKey, openText, readOpenIndex, writeOpenIndex, OpenFileError, OpenFileFailure } from '../bin/lib/openFile.mjs';
import { DEFAULT_APPS_URI, associationRegCommands, associationStamp, defaultAssociationsXml, ensureUninstallEntry, openCommand, shareCommand, uninstallEntryCommands, unregisterUninstallEntry, workHereCommand, unregisterFileAssociations, OPEN_WITH_PROGID } from '../bin/lib/remote/desktop/fileAssociation.mjs';
import { launcherSource } from '../bin/lib/remote/desktop/index.mjs';

test('driveOpenUrl dùng deep-link open_file của FE, bỏ / thừa ở cuối web url', () => {
  assert.equal(
    driveOpenUrl('https://brain.aivin.cloud/', { fileId: 'f 1', workspaceId: 'w&2' }),
    'https://brain.aivin.cloud/drive?open_file=f+1&workspace_id=w%262',
  );
});

test('indexKey tách theo máy chủ + workspace + nội dung', () => {
  const sha256 = fileSha256(Buffer.from('abc'));
  assert.notEqual(indexKey({ baseUrl: 'a', workspaceId: 'w', sha256 }), indexKey({ baseUrl: 'b', workspaceId: 'w', sha256 }));
  assert.notEqual(indexKey({ baseUrl: 'a', workspaceId: 'w', sha256 }), indexKey({ baseUrl: 'a', workspaceId: 'x', sha256 }));
});

test('chỉ mục: đọc tệp hỏng ra rỗng, ghi giữ 500 mục mới nhất', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-open-'));
  const file = path.join(dir, 'idx.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readOpenIndex(file), {});
  const index = {};
  for (let i = 0; i < 520; i++) index[`k${i}`] = { file_id: `f${i}`, opened_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() };
  writeOpenIndex(index, file);
  const back = readOpenIndex(file);
  assert.equal(Object.keys(back).length, 500);
  assert.ok(back.k519 && !back.k0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lỗi có mã + chữ theo ngôn ngữ', () => {
  const e = new OpenFileFailure(OpenFileError.UPLOAD_FAILED, { name: 'a.docx', reason: 'x' });
  assert.equal(e.code, OpenFileError.UPLOAD_FAILED);
  assert.match(openText(OpenFileError.UPLOAD_FAILED, { name: 'a.docx', reason: 'x' }, 'vi'), /Tải "a\.docx" lên Drive không được: x/);
  assert.match(openText('opening', { name: 'b.pdf' }, 'en'), /Opening "b\.pdf"/);
});

test('registry: ProgID trỏ Aivin.exe --open "%1", mỗi đuôi có Open with + chuột phải', () => {
  const exe = 'C:\\Users\\u\\AppData\\Local\\Aivin\\Aivin.exe';
  const cmds = associationRegCommands({ exe, lang: 'vi', extensions: ['docx'] });
  const flat = cmds.map((c) => c.join(' '));
  assert.equal(openCommand(exe), `"${exe}" --open "%1"`);
  assert.ok(flat.some((l) => l.includes(`${OPEN_WITH_PROGID}\\shell\\open\\command`) && l.includes(openCommand(exe))));
  assert.ok(flat.some((l) => l.includes('.docx\\OpenWithProgids') && l.includes('REG_NONE')));
  assert.ok(flat.some((l) => l.includes(`${OPEN_WITH_PROGID}\\shell\\open`) && l.includes('FriendlyAppName') && l.includes('AIVIN Office Suite')));
  assert.ok(flat.some((l) => l.includes('SystemFileAssociations\\.docx\\shell\\AivinOpen') && l.includes('Mở bằng AIVIN Office Suite')));
  assert.ok(cmds.every((c) => c[1].startsWith('HKCU\\')), 'chỉ ghi HKCU, không cần admin');
});

test('Aivin.exe nhận --open trước khi giữ mutex khay', () => {
  const src = launcherSource('C:\\h');
  assert.ok(src.indexOf('"--open"') > 0 && src.indexOf('"--open"') < src.indexOf('new Mutex'));
  assert.match(src, /AIVIN_OPEN_UI/);
});

test('"Gửi cho AIVIN Bot": chuột phải trên mọi tệp + thư mục, chọn nhiều vẫn hiện, Aivin.exe nhận --share trước mutex (05/11/2026)', () => {
  const exe = 'C:\\A\\Aivin.exe';
  const flat = associationRegCommands({ exe, lang: 'vi', extensions: [] }).map((c) => c.join(' '));
  assert.equal(shareCommand(exe), `"${exe}" --share "%1"`);
  for (const target of ['*', 'Directory']) {
    const verb = `Classes\\${target}\\shell\\AivinShare`;
    assert.ok(flat.some((l) => l.includes(verb) && l.includes('MUIVerb') && l.includes('Gửi cho AIVIN Bot')), target);
    assert.ok(flat.some((l) => l.includes(verb) && l.includes('MultiSelectModel') && l.includes('Player')), target);
    assert.ok(flat.some((l) => l.includes(`${verb}\\command`) && l.includes(shareCommand(exe))), target);
  }
  const src = launcherSource('C:\\h');
  assert.ok(src.indexOf('"--share"') > 0 && src.indexOf('"--share"') < src.indexOf('new Mutex'));
  assert.match(src, /"mascot-attach"/);
});

test('"Làm việc ở đây với AIVIN Bot": có trong menu nền thư mục và trên thư mục, dùng %V, xử lý gốc ổ (05/11/2026)', () => {
  const exe = 'C:\\A\\Aivin.exe';
  const flat = associationRegCommands({ exe, lang: 'vi', extensions: [] }).map((c) => c.join(' '));
  assert.equal(workHereCommand(exe), `"${exe}" --workdir "%V"`);
  for (const target of ['Directory\\Background', 'Directory']) {
    const verb = `Classes\\${target}\\shell\\AivinWorkHere`;
    assert.ok(flat.some((l) => l.includes(verb) && l.includes('Làm việc ở đây với AIVIN Bot')), target);
    assert.ok(flat.some((l) => l.includes(`${verb}\\command`) && l.includes(workHereCommand(exe))), target);
  }
  const src = launcherSource('C:\\h');
  assert.ok(src.indexOf('"--workdir"') > 0 && src.indexOf('"--workdir"') < src.indexOf('new Mutex'));
  assert.match(src, /p\[1\] == ':'/);
});

test('Programs & Features: mục HKCU trỏ Aivin.exe --uninstall, Aivin.exe nhận cờ trước mutex (05/11/2026)', () => {
  const cmds = uninstallEntryCommands({ exe: 'C:\\A\\Aivin.exe', version: '1.0.25', location: 'C:\\A' });
  const flat = cmds.map((c) => c.join(' '));
  assert.ok(cmds.every((c) => c[1] === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AivinBot'));
  assert.ok(flat.some((l) => l.includes('DisplayName') && l.includes('AIVIN Office Suite')));
  assert.ok(flat.some((l) => l.includes('UninstallString') && l.includes('"C:\\A\\Aivin.exe" --uninstall')));
  const src = launcherSource('C:\\h');
  assert.ok(src.indexOf('"--uninstall"') > 0 && src.indexOf('"--uninstall"') < src.indexOf('new Mutex'));
  assert.match(src, /uninstall --yes/);
  assert.match(src, /MessageBoxDefaultButton\.Button2/, 'mặc định không xoá dữ liệu');
});

test('Programs & Features trên khoá thử: ghi khi thiếu / đổi bản, không ghi lại khi không đổi, xoá sạch', { skip: process.platform !== 'win32' }, () => {
  const root = `HKCU\\Software\\AivinUninstallTest${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-uninst-'));
  const stampFile = path.join(dir, 'u.sha');
  const opts = { exe: 'C:\\Tên Có Dấu\\Aivin.exe', location: 'C:\\Tên Có Dấu', stampFile, root };
  const key = `${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AivinBot`;
  const query = () => execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    assert.equal(ensureUninstallEntry({ ...opts, version: '1.0.25' }), true);
    assert.match(query(), /--uninstall/);
    assert.match(query(), /NoRepair\s+REG_DWORD\s+0x1/);
    assert.equal(ensureUninstallEntry({ ...opts, version: '1.0.25' }), false);
    assert.equal(ensureUninstallEntry({ ...opts, version: '1.0.26' }), true);
    assert.match(query(), /1\.0\.26/);
    unregisterUninstallEntry({ root });
    assert.throws(query);
    assert.equal(ensureUninstallEntry({ ...opts, version: '1.0.26' }), true, 'bị xoá thì ghi lại');
  } finally {
    try { execFileSync('reg', ['delete', root, '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* đã xoá */ }
  }
});

test('dấu bộ khoá đổi khi đổi ngôn ngữ / chỗ Aivin.exe → daemon biết phải ghi lại', () => {
  const a = associationStamp({ exe: 'C:\\A.exe', lang: 'vi' });
  assert.equal(a, associationStamp({ exe: 'C:\\A.exe', lang: 'vi' }));
  assert.notEqual(a, associationStamp({ exe: 'C:\\A.exe', lang: 'en' }));
  assert.notEqual(a, associationStamp({ exe: 'C:\\B.exe', lang: 'vi' }));
});

test('cửa sổ riêng chỉ dùng trình duyệt mặc định Chromium; Firefox / chưa rõ → null để mở tab thường', () => {
  const resolve = (b) => ({ id: b.id, exe: `C:\\${b.id}.exe` });
  assert.deepEqual(appWindowCommand('https://a/drive?x=1', { defaultId: 'chrome', resolve }), { exe: 'C:\\chrome.exe', args: ['--start-maximized', '--app=https://a/drive?x=1'] });
  assert.equal(appWindowCommand('https://a', { defaultId: null, resolve }), null);
  assert.equal(appWindowCommand('https://a', { defaultId: 'edge', resolve: () => null }), null);
});

test('Default apps: có Capabilities + RegisteredApplications, link Settings, XML mặc định chỉ md/txt/csv', () => {
  const flat = associationRegCommands({ exe: 'C:\\A.exe', extensions: ['md'] }).map((c) => c.join(' '));
  assert.ok(flat.some((l) => l.includes('RegisteredApplications') && l.includes('Software\\AivinLabs\\AIVIN Bot\\Capabilities')));
  assert.ok(flat.some((l) => l.includes('Capabilities\\FileAssociations') && l.includes('.md') && l.includes(OPEN_WITH_PROGID)));
  assert.equal(DEFAULT_APPS_URI, 'ms-settings:defaultapps?registeredAppUser=AIVIN%20Office%20Suite');
  const xml = defaultAssociationsXml();
  assert.match(xml, /Identifier="\.md" ProgId="Aivin\.OpenFile"/);
  assert.doesNotMatch(xml, /\.docx/);
});

test('registry thật trên khoá thử: lệnh đọc ra đúng nguyên văn dấu ngoặc và %1', { skip: process.platform !== 'win32' }, () => {
  const root = `HKCU\\Software\\AivinOpenWithTest${process.pid}`;
  const exe = 'C:\\Users\\Tên Có Dấu\\Aivin.exe';
  const query = (key, ...a) => execFileSync('reg', ['query', key, ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    for (const args of associationRegCommands({ exe, lang: 'vi', extensions: ['md'], root })) execFileSync('reg', args, { stdio: 'ignore', windowsHide: true });
    assert.ok(query(`${root}\\Classes\\${OPEN_WITH_PROGID}\\shell\\open\\command`, '/ve').includes('--open "%1"'));
    assert.ok(query(`${root}\\Classes\\.md\\OpenWithProgids`).includes(OPEN_WITH_PROGID));
    assert.ok(query(`${root}\\Classes\\*\\shell\\AivinShare\\command`, '/ve').includes('--share "%1"'));
    unregisterFileAssociations({ extensions: ['md'], root });
    assert.throws(() => query(`${root}\\Classes\\*\\shell\\AivinShare`));
    assert.throws(() => query(`${root}\\Classes\\${OPEN_WITH_PROGID}`));
    assert.throws(() => query(`${root}\\AivinLabs`));
  } finally {
    try { execFileSync('reg', ['delete', root, '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* đã xoá */ }
  }
});
