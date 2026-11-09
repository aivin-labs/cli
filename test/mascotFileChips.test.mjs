import assert from 'node:assert/strict';
import test from 'node:test';
import { FILE_KINDS, fileChip, fileKind, fileName } from '../bin/lib/remote/mascot/fileChips.mjs';
import { lucidePath } from '../bin/lib/remote/mascot/lucideIcons.mjs';

const noDir = { dir: (p) => /[\\/]$/.test(p) };

test('chip tệp: loại theo đuôi tệp (không phân biệt hoa thường), thư mục, không rõ → file', () => {
  const cases = {
    'C:/a/Bao cao.XLSX': 'sheet', 'C:/a/data.csv': 'sheet', 'C:/a/hop-dong.docx': 'doc', 'C:/a/x.pdf': 'pdf', 'C:/a/slide.pptx': 'slides',
    'C:/a/anh.PNG': 'image', 'C:/a/clip.mp4': 'video', 'C:/a/ghi-am.m4a': 'audio', 'C:/a/goi.zip': 'archive', 'C:/a/app.ts': 'code',
    'C:/a/cfg.json': 'data', 'C:/a/note.md': 'text', 'C:/a/Makefile': 'file', 'D:\\Hop dong\\': 'folder', 'D:/Anh/': 'folder',
  };
  for (const [p, kind] of Object.entries(cases)) assert.equal(fileKind(p, noDir), kind, p);
  assert.equal(fileName('D:\\Hop dong\\'), 'Hop dong');
  assert.equal(fileName('D:\\'), 'D:\\');
});

test('chip tệp: mỗi loại có icon Lucide + màu chữ / nền', () => {
  for (const [kind, k] of Object.entries(FILE_KINDS)) {
    assert.ok(lucidePath(k.icon), `${kind}: icon ${k.icon}`);
    assert.match(k.ink, /^#[0-9A-F]{6}$/);
    assert.match(k.bg, /^#[0-9A-F]{6}$/);
  }
  const c = fileChip('C:/a/Bao cao.xlsx', noDir);
  assert.deepEqual({ ...c, icon_path: !!c.icon_path }, { path: 'C:/a/Bao cao.xlsx', name: 'Bao cao.xlsx', kind: 'sheet', icon_path: true, ink: FILE_KINDS.sheet.ink, bg: FILE_KINDS.sheet.bg });
});
