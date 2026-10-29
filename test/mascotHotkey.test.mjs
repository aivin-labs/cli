import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseHotkey, hotkeyCandidates, probeHotkey, DEFAULT_HOTKEYS, MOD_NOREPEAT } = await import('../bin/lib/remote/mascot/hotkey.mjs');

test('phím tắt: đọc tổ hợp không phân biệt hoa thường / thứ tự, chuẩn hoá tên; Shift + phím thôi thì không nhận', () => {
  assert.deepEqual(parseHotkey('alt+WIN+space'), { mods: 0x9, vk: 0x20, label: 'Win+Alt+Space' });
  assert.deepEqual(parseHotkey('Ctrl + Shift + F5'), { mods: 0x6, vk: 0x74, label: 'Ctrl+Shift+F5' });
  assert.equal(parseHotkey('ctrl+alt+k').vk, 0x4b);
  assert.throws(() => parseHotkey('shift+a'), /at least one of Ctrl, Alt or Win/);
  assert.throws(() => parseHotkey('space'), /not a key combination/);
  assert.throws(() => parseHotkey('hyper+a'), /Unknown modifier/);
  assert.throws(() => parseHotkey('ctrl+print'), /Unknown key/);
});

test('thứ tự thử: tổ hợp chủ máy đặt trước, rồi mặc định (bỏ trùng); off → không có', () => {
  assert.deepEqual(hotkeyCandidates().map((h) => h.label), DEFAULT_HOTKEYS);
  assert.deepEqual(hotkeyCandidates('ctrl+alt+k').map((h) => h.label), ['Ctrl+Alt+K', ...DEFAULT_HOTKEYS]);
  assert.deepEqual(hotkeyCandidates('alt+win+space').map((h) => h.label), DEFAULT_HOTKEYS);
  assert.deepEqual(hotkeyCandidates('off'), []);
  assert.deepEqual(hotkeyCandidates('rác').map((h) => h.label), DEFAULT_HOTKEYS);
});

test('kiểm phím còn trống: đăng ký thử với MOD_NOREPEAT; ngoài Windows → không biết', () => {
  let script = '';
  const run = (_cmd, args) => { script = args.at(-1); return { stdout: 'taken\r\n' }; };
  assert.equal(probeHotkey(parseHotkey('Win+Alt+Space'), { platform: 'win32', run }), false);
  assert.match(script, new RegExp(`RegisterHotKey\\(\\[IntPtr\\]::Zero, 7, ${0x9 | MOD_NOREPEAT}, 32\\)`));
  assert.equal(probeHotkey(parseHotkey('Win+Alt+Space'), { platform: 'win32', run: () => ({ stdout: 'free' }) }), true);
  assert.equal(probeHotkey(parseHotkey('Win+Alt+Space'), { platform: 'darwin' }), null);
});
