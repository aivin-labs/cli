import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { appWindowCommand, driveOpenUrl, fileSha256, indexKey, openText, readOpenIndex, writeOpenIndex, OpenFileError, OpenFileFailure } from '../bin/lib/openFile.mjs';
import { DEFAULT_APPS_URI, associationRegCommands, defaultAssociationsXml, openCommand, unregisterFileAssociations, OPEN_WITH_PROGID } from '../bin/lib/remote/desktop/fileAssociation.mjs';
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
  assert.ok(flat.some((l) => l.includes('SystemFileAssociations\\.docx\\shell\\AivinOpen') && l.includes('Mở bằng AIVIN Bot')));
  assert.ok(cmds.every((c) => c[1].startsWith('HKCU\\')), 'chỉ ghi HKCU, không cần admin');
});

test('Aivin.exe nhận --open trước khi giữ mutex khay', () => {
  const src = launcherSource('C:\\h');
  assert.ok(src.indexOf('"--open"') > 0 && src.indexOf('"--open"') < src.indexOf('new Mutex'));
  assert.match(src, /AIVIN_OPEN_UI/);
});

test('cửa sổ riêng chỉ dùng trình duyệt mặc định Chromium; Firefox / chưa rõ → null để mở tab thường', () => {
  const resolve = (b) => ({ id: b.id, exe: `C:\\${b.id}.exe` });
  assert.deepEqual(appWindowCommand('https://a/drive?x=1', { defaultId: 'chrome', resolve }), { exe: 'C:\\chrome.exe', args: ['--app=https://a/drive?x=1'] });
  assert.equal(appWindowCommand('https://a', { defaultId: null, resolve }), null);
  assert.equal(appWindowCommand('https://a', { defaultId: 'edge', resolve: () => null }), null);
});

test('Default apps: có Capabilities + RegisteredApplications, link Settings, XML mặc định chỉ md/txt/csv', () => {
  const flat = associationRegCommands({ exe: 'C:\\A.exe', extensions: ['md'] }).map((c) => c.join(' '));
  assert.ok(flat.some((l) => l.includes('RegisteredApplications') && l.includes('Software\\AivinLabs\\AIVIN Bot\\Capabilities')));
  assert.ok(flat.some((l) => l.includes('Capabilities\\FileAssociations') && l.includes('.md') && l.includes(OPEN_WITH_PROGID)));
  assert.equal(DEFAULT_APPS_URI, 'ms-settings:defaultapps?registeredAppUser=AIVIN%20Bot');
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
    unregisterFileAssociations({ extensions: ['md'], root });
    assert.throws(() => query(`${root}\\Classes\\${OPEN_WITH_PROGID}`));
    assert.throws(() => query(`${root}\\AivinLabs`));
  } finally {
    try { execFileSync('reg', ['delete', root, '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* đã xoá */ }
  }
});
