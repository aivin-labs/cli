import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_CAST_CSHARP } from '../bin/lib/remote/desktop/desktopCastSource.mjs';

const body = (name) => {
  const start = DESKTOP_CAST_CSHARP.indexOf(name);
  assert.ok(start >= 0, name);
  return DESKTOP_CAST_CSHARP.slice(start, DESKTOP_CAST_CSHARP.indexOf('\n    }\n', start));
};

test('mũi tên, Home, End, PageUp, PageDown, Insert, Delete đều là phím mở rộng', () => {
  assert.match(body('static bool IsExtendedKey'), /vk >= 0x21 && vk <= 0x28/);
  assert.match(body('static bool IsExtendedKey'), /vk == 0x2D \|\| vk == 0x2E/);
});

test('phím đơn, tổ hợp, phím bổ trợ đi qua SendKey có cờ mở rộng', () => {
  for (const name of ['static void HandleSpecialKey', 'static void PressModifiers', 'static void ReleaseModifiers']) {
    assert.match(body(name), /SendKey\(/, name);
    assert.doesNotMatch(body(name), /keybd_event/, name);
  }
  const hotkey = DESKTOP_CAST_CSHARP.slice(DESKTOP_CAST_CSHARP.indexOf('action == "hotkey"'), DESKTOP_CAST_CSHARP.indexOf('static void TypeText') > 0 ? DESKTOP_CAST_CSHARP.indexOf('static void TypeText') : undefined);
  assert.match(hotkey, /SendKey\(vks\[i\], false\)/);
  assert.match(hotkey, /SendKey\(vks\[i\], true\)/);
  assert.match(body('static void SendKey'), /KEYEVENTF_EXTENDEDKEY/);
});

test('danh sách màn hình không gửi ở mọi khung', () => {
  assert.match(DESKTOP_CAST_CSHARP, /if \(nowMs - lastScreensMs >= SCREENS_REFRESH_MS\) \{/);
});

test('thu nhỏ hình chạy song song trên nhiều nhân, không qua GDI+', () => {
  assert.match(body('public static Bitmap Scale'), /ScaleBilinear\(src, scaleBuffer\)/);
  assert.doesNotMatch(body('public static Bitmap Scale'), /DrawImage/);
});
