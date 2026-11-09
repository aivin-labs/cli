import test from 'node:test';
import assert from 'node:assert/strict';
import { createCastTouchViewers, isTouchViewerDevice, shouldDrawCursorInFrame } from '../bin/lib/remote/desktop/castTouchViewers.mjs';

test('nhận đúng nhãn thiết bị cảm ứng FE khai', () => {
  for (const device of ['iPhone', 'iPad', 'Android']) assert.equal(isTouchViewerDevice(device), true);
  for (const device of ['Windows', 'Mac', 'Web', '', undefined, null]) assert.equal(isTouchViewerDevice(device), false);
});

test('chưa có người xem thì không coi là toàn cảm ứng', () => {
  assert.equal(createCastTouchViewers().allTouch(), false);
});

test('có một máy dùng chuột thì chưa phải toàn cảm ứng, máy đó rời đi thì có', () => {
  const viewers = createCastTouchViewers();
  viewers.add('phone', 'iPhone');
  assert.equal(viewers.allTouch(), true);
  viewers.add('laptop', 'Windows');
  assert.equal(viewers.allTouch(), false);
  viewers.remove('laptop');
  assert.equal(viewers.allTouch(), true);
  viewers.clear();
  assert.equal(viewers.allTouch(), false);
});

test('JPEG: điện thoại không thấy con trỏ trong ảnh, còn máy dùng chuột thì vẫn thấy', () => {
  assert.equal(shouldDrawCursorInFrame({ jpeg: true, localCursor: false, allTouch: true }), false);
  assert.equal(shouldDrawCursorInFrame({ jpeg: true, localCursor: true, allTouch: false }), true);
});

test('video: giữ nguyên theo báo tự vẽ của người xem, kể cả điện thoại đang ghi hình', () => {
  assert.equal(shouldDrawCursorInFrame({ jpeg: false, localCursor: true, allTouch: true }), false);
  assert.equal(shouldDrawCursorInFrame({ jpeg: false, localCursor: false, allTouch: true }), true);
});
