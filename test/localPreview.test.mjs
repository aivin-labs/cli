import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PreviewKind, convertOfficeOnCloud, hasOfficeConsent, isTrustedRequest, parseCsv, previewKind, previewPageHtml, renderInlineContent, renderMarkdown, saveOfficeConsent, startPreviewServer,
} from '../bin/lib/localPreview.mjs';
import { contentKey, prunePreviewCache, readCachedPdf, writeCachedPdf } from '../bin/lib/previewCache.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-preview-'));

test('phân loại đuôi tệp, đuôi lạ không đi qua cloud', () => {
  assert.equal(previewKind('a.PDF'), PreviewKind.PDF);
  assert.equal(previewKind('a.docx'), PreviewKind.OFFICE);
  assert.equal(previewKind('a.pptx'), PreviewKind.OFFICE);
  assert.equal(previewKind('a.csv'), PreviewKind.CSV);
  assert.equal(previewKind('a.fods'), PreviewKind.UNSUPPORTED);
  assert.equal(previewKind('noext'), PreviewKind.UNSUPPORTED);
});

test('markdown: nội dung tệp không thành HTML, liên kết chỉ http(s)', () => {
  const html = renderMarkdown('# T\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](https://a.vn)\n\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /href="https:\/\/a\.vn"/);
  assert.match(renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |'), /<th>A<\/th>.*<td>2<\/td>/s);
  assert.match(renderMarkdown('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});

test('csv: ngoặc kép, dấu chấm phẩy, xuống dòng trong ô; ô không thành HTML', () => {
  assert.deepEqual(parseCsv('a;b\n"x;y";"dòng 1\ndòng 2"\n"q""r";\n'), [['a', 'b'], ['x;y', 'dòng 1\ndòng 2'], ['q"r', '']]);
  const { html } = renderInlineContent(PreviewKind.CSV, Buffer.from('a,b\n<b>x</b>,2\n'));
  assert.match(html, /&lt;b&gt;x/);
  assert.doesNotMatch(html, /<b>/);
});

test('tên tệp không đóng được thẻ script / chèn được vào trang', () => {
  const html = previewPageHtml({ name: '</script><script>alert(1)</script>.md', kind: PreviewKind.MARKDOWN, inline: { html: '', truncated: false }, consented: false, base: '/t/', nonce: 'n', lang: 'vi' });
  assert.doesNotMatch(html, /<script>alert/);
});

test('chỉ nhận đúng Host, POST phải cùng nguồn', () => {
  const port = 5000;
  assert.equal(isTrustedRequest({ method: 'GET', host: '127.0.0.1:5000', port }), true);
  assert.equal(isTrustedRequest({ method: 'GET', host: 'evil.com', port }), false);
  assert.equal(isTrustedRequest({ method: 'POST', host: '127.0.0.1:5000', origin: 'https://evil.com', port }), false);
  assert.equal(isTrustedRequest({ method: 'POST', host: '127.0.0.1:5000', port }), false);
  assert.equal(isTrustedRequest({ method: 'POST', host: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000', port }), true);
});

test('đồng ý gửi tệp Office được nhớ riêng theo máy', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x', 'settings.json');
  assert.equal(hasOfficeConsent(file), false);
  saveOfficeConsent(file);
  assert.equal(hasOfficeConsent(file), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('máy chủ bận: tự thử lại; lỗi khác: báo đúng thông điệp, không thử lại', async () => {
  const busy = { response: { data: Buffer.from(JSON.stringify({ code: 'FILESHARE.ANON_PREVIEW_BUSY', message: 'bận' })) } };
  let calls = 0;
  const pdf = await convertOfficeOnCloud({ serverUrl: 'http://x', name: 'a.docx', buffer: Buffer.from('a'), wait: async () => {}, post: async () => { if (++calls < 3) throw busy; return { data: Buffer.from('%PDF') }; } });
  assert.equal(calls, 3);
  assert.equal(pdf.toString(), '%PDF');

  calls = 0;
  const bad = { response: { data: Buffer.from(JSON.stringify({ code: 'FILESHARE.ANON_PREVIEW_CANNOT_CONVERT', message: 'hỏng' })) } };
  await assert.rejects(convertOfficeOnCloud({ serverUrl: 'http://x', name: 'a.docx', buffer: Buffer.from('a'), wait: async () => {}, post: async () => { calls++; throw bad; } }), /hỏng/);
  assert.equal(calls, 1);
});

test('máy chủ cục bộ: thiếu mã trong đường dẫn → 404; không có nhịp ping → tự đóng; PDF trả nguyên tệp', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.pdf');
  fs.writeFileSync(file, '%PDF-1.4 thử');
  let closed = 0;
  const { url, close } = await startPreviewServer({ filePath: file, serverUrl: 'http://x', onLogin: async () => 'u', onClosed: () => { closed++; }, settingsFile: path.join(dir, 's.json') });
  const origin = new URL(url).origin;
  assert.equal((await fetch(origin + '/')).status, 404);
  assert.equal((await fetch(origin + '/wrong/file')).status, 404);
  assert.equal((await fetch(url)).status, 200);
  assert.equal(await (await fetch(url + 'file')).text(), '%PDF-1.4 thử');
  assert.equal((await fetch(url + 'login', { method: 'POST' })).status, 404, 'POST không có Origin bị từ chối');
  close();
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(closed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Office chưa đổi: không có tệp để tải, trang hiện hỏi đồng ý, chưa gửi gì', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.docx');
  fs.writeFileSync(file, 'x');
  const { url, close } = await startPreviewServer({ filePath: file, serverUrl: 'http://127.0.0.1:1', onLogin: async () => 'u', settingsFile: path.join(dir, 's.json'), lang: 'vi' });
  assert.equal((await fetch(url + 'file')).status, 404);
  assert.match(await (await fetch(url)).text(), /id="consent"/);
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache PDF: khoá theo nội dung, PDF hỏng bị bỏ, dọn theo hạn + trần dung lượng (cũ nhất trước)', () => {
  const dir = tmpDir();
  const k1 = contentKey(Buffer.from('a'));
  assert.notEqual(k1, contentKey(Buffer.from('b')));
  assert.equal(readCachedPdf(k1, { dir }), null);
  writeCachedPdf(k1, Buffer.from('%PDF-1 a'), { dir });
  assert.equal(readCachedPdf(k1, { dir }).toString(), '%PDF-1 a');
  fs.writeFileSync(path.join(dir, `${contentKey(Buffer.from('x'))}.pdf`), 'not a pdf');
  assert.equal(readCachedPdf(contentKey(Buffer.from('x')), { dir }), null);

  const now = Date.now();
  const put = (name, size, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.alloc(size)); const t = new Date(now - ageMs); fs.utimesSync(f, t, t); };
  put('old.pdf', 10, 40 * 86400000);
  put('lru.pdf', 60, 2000);
  put('new.pdf', 60, 1000);
  put('.orphan.tmp', 5, 2 * 3600000);
  prunePreviewCache({ dir, maxTotalBytes: 100, now });
  const left = fs.readdirSync(dir);
  assert.ok(!left.includes('old.pdf') && !left.includes('.orphan.tmp'), 'quá hạn + tệp tạm mồ côi bị xoá');
  assert.ok(!left.includes('lru.pdf') && left.includes('new.pdf'), 'vượt trần: xoá tệp lâu không dùng nhất');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Office đã có trong cache: trang hiện PDF ngay, không hỏi đồng ý, không gọi máy chủ', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.docx');
  fs.writeFileSync(file, 'nội dung docx');
  const cacheDir = path.join(dir, 'cache');
  writeCachedPdf(contentKey(fs.readFileSync(file)), Buffer.from('%PDF-1 cached'), { dir: cacheDir });
  const { url, close, fromCache } = await startPreviewServer({ filePath: file, serverUrl: 'http://127.0.0.1:1', onLogin: async () => 'u', settingsFile: path.join(dir, 's.json'), cacheDir, lang: 'vi' });
  assert.equal(fromCache, true);
  const page = await (await fetch(url)).text();
  assert.doesNotMatch(page, /id="consent"/);
  assert.match(page, /"ready":true/);
  assert.equal(await (await fetch(url + 'file')).text(), '%PDF-1 cached');
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});
