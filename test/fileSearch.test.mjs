import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const remote = await import('../bin/lib/remoteControl.mjs');
const { extractDocText, xmlToText } = await import('../bin/lib/remote/docText.mjs');

const sandboxDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-search-root-'));
const q8 = (vec) => {
  const norm = Math.hypot(...vec) || 1;
  return Buffer.from(Int8Array.from(vec.map((v) => Math.round((v / norm) * 127))).buffer).toString('base64');
};

/** Zip tối giản (deflate) — đủ để dựng docx/pptx giả cho test. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = zlib.deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(text), 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('đọc chữ trong docx / pptx (gói zip XML), tệp chữ thường; pdf chưa đọc nội dung', async () => {
  const dir = sandboxDir();
  const docx = path.join(dir, 'a.docx');
  fs.writeFileSync(docx, zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>HỢP ĐỒNG THUÊ</w:t></w:r></w:p><w:p><w:r><w:t>Bên A &amp; Bên B</w:t></w:r></w:p></w:body></w:document>' }));
  assert.equal(await extractDocText(docx, fs.statSync(docx).size), 'HỢP ĐỒNG THUÊ Bên A & Bên B');
  const pptx = path.join(dir, 'b.pptx');
  fs.writeFileSync(pptx, zip({ 'ppt/slides/slide2.xml': '<a:p><a:t>Hai</a:t></a:p>', 'ppt/slides/slide1.xml': '<a:p><a:t>Một</a:t></a:p>' }));
  assert.equal(await extractDocText(pptx, fs.statSync(pptx).size), 'Một Hai');
  const txt = path.join(dir, 'c.txt');
  fs.writeFileSync(txt, 'x'.repeat(700));
  assert.equal((await extractDocText(txt, 700, 600)).length, 601);
  const pdf = path.join(dir, 'd.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 hop dong');
  assert.equal(await extractDocText(pdf, 17), '');
  assert.equal(xmlToText('<x>a</x><y>b</y>'), 'ab');
});

test('chỉ mục: quét thư mục người dùng, bỏ AppData; tìm theo nội dung tài liệu; vector đổi xếp hạng (tên viết tắt)', async () => {
  const root = sandboxDir();
  fs.mkdirSync(path.join(root, 'Documents', 'hd'), { recursive: true });
  fs.mkdirSync(path.join(root, 'AppData', 'Local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AppData', 'Local', 'hop-dong-cache.txt'), 'hop dong');
  fs.writeFileSync(path.join(root, 'Documents', 'hd', 'HD_thue_VP_2026.docx'), zip({ 'word/document.xml': '<w:p><w:t>Văn phòng tầng 5</w:t></w:p>' }));
  fs.writeFileSync(path.join(root, 'Documents', 'bao-gia-thue-xe.txt'), 'bao gia thue xe du lich');
  const index = remote.createFileIndex([root]);
  const built = await index.build();
  assert.equal(built.files, 2);

  const byContent = index.search('văn phòng tầng 5', 5);
  assert.match(byContent[0].path, /HD_thue_VP_2026\.docx$/);
  assert.equal(byContent[0].preview, 'Văn phòng tầng 5');

  const sent = [];
  index.setEmbedder(async (texts) => {
    sent.push(...texts);
    return texts.map((t) => q8(t.startsWith('HD_thue_VP') ? [1, 0, 0] : [0, 1, 0]));
  });
  const v = await index.vectorize();
  assert.equal(v.embedded, 2);
  assert.ok(sent.some((t) => t.includes('HD_thue_VP_2026.docx | ') && t.includes('Văn phòng tầng 5')));
  assert.equal((await index.vectorize()).embedded, 0); // đã có vector, tệp không đổi → không tính lại

  // Câu hỏi khớp chữ "thue" ở cả hai tệp; vector câu hỏi gần hợp đồng → hợp đồng đứng đầu.
  const hybrid = index.search('hợp đồng thuê', 5, q8([1, 0, 0]));
  assert.match(hybrid[0].path, /HD_thue_VP_2026\.docx$/);
  assert.ok(hybrid[0].similarity > 0.9);
  index.close();
});

test('fs.preview: nhiều tệp một lần, đọc docx, tệp không có báo exists=false', async () => {
  const root = sandboxDir();
  fs.writeFileSync(path.join(root, 'q3.docx'), zip({ 'word/document.xml': '<w:p><w:t>Báo cáo doanh thu quý 3</w:t></w:p>' }));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Ghi chú\ndòng 2');
  const env = { roots: [root], binaries: [], projects: [] };
  const tools = new Map(remote.buildTools(env).map((t) => [t.name, t]));
  const out = await tools.get('fs.preview').handler({ paths: ['q3.docx', 'notes.md', 'missing.pdf'] }, { signal: new AbortController().signal }, env);
  assert.equal(out.files[0].preview, 'Báo cáo doanh thu quý 3');
  assert.match(out.files[0].modified, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(out.files[1].preview, '# Ghi chú dòng 2');
  assert.equal(out.files[2].exists, false);
});

test('vector: bỏ nửa ký tự lẻ trước khi gửi; BE lỗi → tạm nghỉ, không thử lại dồn dập', async () => {
  const { wellFormed } = await import('../bin/lib/remote/docText.mjs');
  const lone = '😀'.slice(0, 1);
  assert.equal(wellFormed(`a${lone}b`), 'a�b');
  assert.equal(wellFormed('ok 😀'), 'ok 😀');

  const root = sandboxDir();
  fs.writeFileSync(path.join(root, `note ${lone}.txt`), 'x');
  const index = remote.createFileIndex([root]);
  await index.build();
  let calls = 0;
  const seen = [];
  index.setEmbedder(async (texts) => { calls++; seen.push(...texts); return null; });
  assert.equal((await index.vectorize()).failed, true);
  assert.ok(!seen.some((t) => /[\uD800-\uDFFF]/.test(t.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))));
  await index.vectorize();
  assert.equal(calls, 1); // đang tạm nghỉ sau lần lỗi
  index.close();
});
