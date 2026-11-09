import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCastInput } from '../bin/lib/remote/desktop/castInput.mjs';
import { DESKTOP_CAST_CSHARP } from '../bin/lib/remote/desktop/desktopCastSource.mjs';

test('dán nội dung có định dạng: giữ html và chữ, thiếu html hoặc quá trần thì bỏ', () => {
  assert.deepEqual(sanitizeCastInput({ action: 'paste_html', html: '<b>x</b>', text: 'x', op: 'stop' }), { action: 'paste_html', text: 'x', html: '<b>x</b>' });
  assert.equal(sanitizeCastInput({ action: 'paste_html', text: 'x' }), null);
  assert.equal(sanitizeCastInput({ action: 'paste_html', html: 'x'.repeat(12_000_001) }), null);
  assert.equal(sanitizeCastInput({ action: 'paste_html', html: '<b>x</b>', text: 'y'.repeat(70_000) }, 10).text.length, 65_536);
});

test('ảnh quá trần: bỏ hẳn, không cắt thành ảnh hỏng', () => {
  assert.equal(sanitizeCastInput({ action: 'paste_image', data: 'a'.repeat(25_000_001) }), null);
  assert.equal(sanitizeCastInput({ action: 'paste_image', data: 'aaaa' }).data, 'aaaa');
});

test('không ghi được clipboard thì không bấm Ctrl + V', () => {
  const start = DESKTOP_CAST_CSHARP.indexOf('public static bool Run(');
  const body = DESKTOP_CAST_CSHARP.slice(start, DESKTOP_CAST_CSHARP.indexOf('static void PressPaste', start));
  assert.match(body, /if \(done\) PressPaste\(\);/);
  assert.match(body, /SetDataObject\(build\(\), true, 10, 100\)/);
});

test('dán ảnh không để lại tệp tạm, không kèm dạng tệp', () => {
  assert.equal(DESKTOP_CAST_CSHARP.includes('aivin_paste_'), false);
  const start = DESKTOP_CAST_CSHARP.indexOf('public static System.Windows.Forms.DataObject ImageData');
  const body = DESKTOP_CAST_CSHARP.slice(start, DESKTOP_CAST_CSHARP.indexOf('public static System.Windows.Forms.DataObject FileData'));
  assert.doesNotMatch(body, /SetFileDropList/);
  assert.match(body, /SetData\("PNG"/);
});

test('gom tệp thả theo lô: tệp cuối mới trả, lô mới thay lô dở, mỗi người xem một lô', async () => {
  const { createDropBatches } = await import('../bin/lib/remote/desktop/castFileDrop.mjs');
  const batches = createDropBatches();
  assert.equal(batches.add({ viewerId: 'a', batch: '1', path: 'p1', last: false }), null);
  assert.equal(batches.add({ viewerId: 'b', batch: '9', path: 'q1', last: false }), null);
  assert.deepEqual(batches.add({ viewerId: 'a', batch: '1', path: 'p2', last: true }), ['p1', 'p2']);
  assert.deepEqual(batches.add({ viewerId: 'b', batch: '10', path: 'q2', last: true }), ['q2']);
});

test('thả tệp chỉ gửi nội bộ, không nhận từ mạng; nút chuột luôn được nhả', () => {
  assert.equal(sanitizeCastInput({ action: 'drop_files', paths: ['C:/x'] }), null);
  const start = DESKTOP_CAST_CSHARP.indexOf('static void Drive(');
  const body = DESKTOP_CAST_CSHARP.slice(start, DESKTOP_CAST_CSHARP.indexOf('public static bool Run(IList<string>'));
  assert.match(body, /finally \{\s+Native\.mouse_event\(Native\.MOUSEEVENTF_LEFTUP/);
});
