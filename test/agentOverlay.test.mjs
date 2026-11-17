import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { agentOverlaySupported, createAgentOverlay, overlayAppName, overlayText } from '../bin/lib/remote/desktop/agentOverlay.mjs';

const fromB64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeSpawn() {
  const children = [];
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.lines = [];
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      write: (s) => { child.lines.push(...String(s).split('\n').filter(Boolean)); return true; },
      end: () => { child.stdinEnded = true; },
    });
    child.kill = () => { child.killed = true; };
    children.push({ file, args, opts, child });
    return child;
  };
  return { children, impl };
}

const make = (over = {}) => {
  const sp = fakeSpawn();
  const overlay = createAgentOverlay({
    platform: 'win32', env: {}, prepare: async () => 'C:\\fake\\aivin-agent-overlay.exe', spawnImpl: sp.impl,
    idleMs: 30, showDelayMs: 10, lang: () => 'vi', ...over,
  });
  return { ...sp, overlay };
};
const shows = (child) => child.lines.filter((l) => l.startsWith('show\t')).map((l) => fromB64(l.split('\t')[1]));

test('agent overlay: chỉ Windows, tắt bằng AIVIN_AGENT_OVERLAY=0', () => {
  assert.equal(agentOverlaySupported('win32', {}), true);
  assert.equal(agentOverlaySupported('darwin', {}), false);
  assert.equal(agentOverlaySupported('win32', { AIVIN_AGENT_OVERLAY: '0' }), false);
});

test('agent overlay: nhãn một dòng, bỏ handle 0x… và .exe', () => {
  assert.equal(overlayText({ kind: 'click', app: 'EXCEL.EXE' }, 'vi'), 'AIVIN đang bấm · EXCEL');
  assert.equal(overlayText({ kind: 'type', app: '0x1a2b' }, 'vi'), 'AIVIN đang gõ');
  assert.equal(overlayText({ kind: 'nope' }, 'en'), 'AIVIN is looking at the screen');
  assert.equal(overlayText({ kind: 'open', app: 'Zalo' }, 'fr'), 'AIVIN is opening an app · Zalo');
  assert.equal(overlayAppName('x'.repeat(80)).length, 48);
  assert.ok(!overlayText({ kind: 'click', app: 'Notepad' }, 'vi').includes('\n'));
});

test('agent overlay: hiện khi bắt đầu, giữ sáng khi còn việc, hết việc thì ẩn; exe chỉ mở một lần', async () => {
  const { children, overlay } = make();
  const end1 = overlay.begin({ kind: 'click', app: 'Excel' });
  const end2 = overlay.begin({ kind: 'type', app: 'Excel' });
  await tick(25);
  assert.equal(children.length, 1);
  const { child, opts } = children[0];
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'ignore']);
  assert.deepEqual(shows(child), ['AIVIN đang bấm · Excel', 'AIVIN đang gõ · Excel']);
  end1();
  await tick(50);
  assert.equal(child.lines.includes('hide'), false, 'còn một việc thì chưa ẩn');
  end2();
  await tick(60);
  assert.equal(child.lines.at(-1), 'hide');
  overlay.close();
  assert.equal(child.stdinEnded, true);
});

test('agent overlay: thao tác hỏng ngay (trước khi kịp hiện) thì không nháy viền; xong nhanh mà thành công thì vẫn hiện', async () => {
  const { children, overlay } = make({ showDelayMs: 1_000 });
  overlay.begin({ kind: 'click', app: 'cmd' })(false);
  await tick(20);
  assert.equal(children.length, 0);
  overlay.begin({ kind: 'key', app: 'Notepad' })(true);
  await tick(20);
  assert.deepEqual(shows(children[0].child), ['AIVIN đang nhấn phím · Notepad']);
  overlay.close();
});

test('agent overlay: máy không loại được lớp phủ khỏi ảnh chụp (exe thoát mã 3) → tắt hẳn, không mở lại', async () => {
  const { children, overlay } = make();
  overlay.begin({ kind: 'look' })();
  await tick(20);
  children[0].child.emit('exit', 3);
  assert.equal(overlay.disabled, true);
  overlay.begin({ kind: 'look' })();
  await tick(20);
  assert.equal(children.length, 1);
});

test('agent overlay: exe chết sớm hai lần → thôi cả phiên; không dựng được exe → không mở gì', async () => {
  const { children, overlay } = make();
  for (let i = 0; i < 2; i++) {
    overlay.begin({ kind: 'look' })();
    await tick(20);
    children.at(-1).child.emit('exit', 1);
  }
  assert.equal(overlay.disabled, true);
  const none = make({ prepare: async () => null });
  none.overlay.begin({ kind: 'look' })();
  await tick(20);
  assert.equal(none.children.length, 0);
});

test('agent overlay: không phải Windows → begin không làm gì', async () => {
  const { children, overlay } = make({ platform: 'linux' });
  overlay.begin({ kind: 'click' })();
  await tick(20);
  assert.equal(children.length, 0);
});
