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
  assert.deepEqual(hotkeyCandidates('shift+alt+space').map((h) => h.label), DEFAULT_HOTKEYS);
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

test('danh sách cho cửa sổ: voice = tổ hợp chủ máy đặt rồi mặc định, chat = mặc định; off → rỗng; mặc định không có Ctrl+Alt+<chữ> (AltGr)', async () => {
  const { hostHotkeys, DEFAULT_CHAT_HOTKEYS } = await import('../bin/lib/remote/mascot/hotkey.mjs');
  const def = hostHotkeys();
  assert.deepEqual(def.voice.map((h) => h.n), DEFAULT_HOTKEYS);
  assert.deepEqual(def.chat.map((h) => h.n), DEFAULT_CHAT_HOTKEYS);
  assert.ok(def.voice.every((h) => (h.m & MOD_NOREPEAT) === MOD_NOREPEAT));
  assert.deepEqual(hostHotkeys('ctrl+shift+f9').voice[0], { n: 'Ctrl+Shift+F9', m: 0x6 | MOD_NOREPEAT, v: 0x78 });
  assert.deepEqual(hostHotkeys('alt+space').chat.map((h) => h.n), ['Win+Alt+C'], 'chat không trùng tổ hợp đã dùng cho voice');
  assert.deepEqual(hostHotkeys(null, 'ctrl+shift+f9').chat.map((h) => h.n), ['Ctrl+Shift+F9', ...DEFAULT_CHAT_HOTKEYS]);
  assert.deepEqual(hostHotkeys(null, 'alt+shift+space').voice[0].n, 'Win+Alt+Space', 'tổ hợp đặt cho chat không còn trong voice');
  assert.equal(hostHotkeys(null, 'alt+shift+space').chat[0].n, 'Alt+Shift+Space');
  assert.deepEqual(hostHotkeys(null, 'off').chat, []);
  assert.equal(hostHotkeys(null, 'off').voice[0].n, DEFAULT_HOTKEYS[0]);
  assert.deepEqual(hostHotkeys('off', 'ctrl+shift+f9'), { voice: [], chat: [] });
  assert.deepEqual(hostHotkeys('off'), { voice: [], chat: [] });
  for (const label of [...DEFAULT_HOTKEYS, ...DEFAULT_CHAT_HOTKEYS]) {
    const h = parseHotkey(label);
    const altGr = (h.mods & 0x3) === 0x3;
    assert.ok(!(altGr && /^[A-Z0-9]$/.test(label.split('+').at(-1))), `${label}: Ctrl+Alt+<chữ> = AltGr trên bàn phím quốc tế`);
  }
});
