import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { Readable } from 'stream';

const require = createRequire(import.meta.url);

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { createMascotChat, ChatRole, AskCommand } = await import('../bin/lib/remote/mascot/ask.mjs');
const { columnWeights, diagramSourceOf, imageUrlsOf, normalizeBlocks, withImageFiles } = await import('../bin/lib/remote/mascot/blocks.mjs');
const { chartLayout, niceTicks } = await import('../bin/lib/remote/mascot/chartLayout.mjs');
const { findBrowser, openWebview, renderDiagram, webviewPage } = await import('../bin/lib/remote/mascot/diagramRender.mjs');
const { safeLinkUrl } = await import('../bin/lib/remote/mascot/safeUrl.mjs');
const { fetchMascotImage, imageExtension, isPrivateHost } = await import('../bin/lib/remote/mascot/images.mjs');
const { mascotText } = await import('../bin/lib/remote/mascot/strings.mjs');
const { hostScript } = await import('../bin/lib/remote/mascot/index.mjs');
const { lucidePath, LUCIDE_ICON_NAMES } = await import('../bin/lib/remote/mascot/lucideIcons.mjs');

const t = (key, vars) => mascotText('vi', key, vars);
const ctx = { t, lang: 'vi', sessionId: 's1', webUrl: 'https://beta.aivin.vn/?session_id=s1' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const tick = () => new Promise((r) => setImmediate(r));

function setup(fetchImage = async () => null) {
  const sent = [];
  const alerts = [];
  const emitted = [];
  const socket = { connected: true, timeout() { return this; }, async emitWithAck(event, payload) { emitted.push({ event, payload }); return { ok: true }; } };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onAlert: (a) => alerts.push(a), onPending: () => {}, fetchImage, serverUrl: 'https://beta-api.aivin.vn' });
  return { chat, sent, emitted, alerts };
}
const assistantRows = (sent) => sent.filter((c) => c.t === AskCommand.CHAT && c.role === ChatRole.ASSISTANT);

test('host.ps1 có mã vẽ khối, vẫn toàn ASCII', () => {
  const ps = hostScript();
  for (const name of ['function BlockTable', 'function BlockCards', 'function BlockImage', 'function ChatBlocks', 'public static class Emoji']) assert.ok(ps.includes(name), name);
  assert.ok([...ps].every((c) => c.charCodeAt(0) < 128), 'host.ps1 phải ASCII');
});

test('icon Lucide: nhận mọi cách viết tên + tên cũ, tên lạ → null; thẻ tên lạ về icon dự phòng như web', () => {
  assert.ok(LUCIDE_ICON_NAMES.length > 1000, 'đủ bộ, không phải vài chục icon chọn tay');
  assert.equal(lucidePath('FileText'), lucidePath('file-text'));
  assert.equal(lucidePath('BarChart3'), lucidePath('ChartColumn'), 'tên cũ trỏ về icon mới');
  assert.equal(lucidePath('Xyzzy'), null);
  assert.equal(lucidePath(undefined), null);
  const [cards] = normalizeBlocks([{ type: 'cards', cards: [{ title: 'A', icon: 'KanbanSquare' }, { title: 'B', icon: 'Xyzzy' }] }], ctx);
  assert.equal(cards.cards[0].icon_path, lucidePath('KanbanSquare'));
  assert.equal(cards.cards[1].icon_path, lucidePath('sparkles'));
});

test('bảng: làm sạch ô, tính độ rộng cột, ghi chú phần cắt bớt; màu lạ và căn lề lạ bị bỏ', () => {
  const [table] = normalizeBlocks([{
    type: 'table', title: 'Doanh thu', header: true, cols: 2, more_rows: 3, more_cols: 1,
    rows: [[{ text: 'Quý', bold: true }, { text: 'Doanh thu' }], [{ text: 'Q1', bg: '#FFEEEE', color: 'url(evil)', align: 'middle' }, { text: '100', align: 'right' }]],
  }], ctx);
  assert.equal(table.title, 'Doanh thu');
  assert.equal(table.cols, 2);
  assert.deepEqual(table.rows[1][0], { text: 'Q1', bg: '#FFEEEE' });
  assert.equal(table.rows[1][1].align, 'right');
  assert.equal(table.note, 'còn 3 hàng, còn 1 cột');
  assert.equal(table.weights.length, 2);
});

test('độ rộng cột: đủ chỗ cho từ dài nhất (không bẻ số / từ), phần thừa theo độ dài chữ, hàng gộp ô không tính', () => {
  const rows = [
    [{ text: 'Thành phần' }, { text: 'Công nghệ' }, { text: 'Trạng thái' }, { text: 'Chi phí' }],
    [{ text: 'Frontend (UI)' }, { text: 'React.js, Tailwind CSS, Axios, Socket.io-client' }, { text: 'Hoàn thành' }, { text: '12.500.000' }],
    [{ text: 'banner rất rất rất rất rất rất rất rất rất rất dài', span: 4 }],
  ];
  const [name, tech, state, cost] = columnWeights(rows, 4);
  const needs = (chars) => Math.floor(16 + 6.9 * chars);
  assert.ok(name >= needs('Frontend'.length), 'không bẻ "Frontend"');
  assert.ok(cost >= needs('12.500.000'.length), 'không bẻ số');
  assert.ok(tech > name && tech > state, 'cột chữ dài được nhiều chỗ hơn');
  assert.ok(Math.abs(name + tech + state + cost - 286) <= 2, 'vừa bề rộng bảng');
});

test('độ rộng cột: quá nhiều cột thì chia theo tỉ lệ phần tối thiểu, không ra số âm', () => {
  const row = (s) => Array.from({ length: 5 }, () => ({ text: s }));
  const weights = columnWeights([row('Internationalization'), row('x')], 5);
  assert.equal(weights.length, 5);
  assert.ok(weights.every((w) => w > 0));
  assert.equal(new Set(weights).size, 1);
});

test('độ rộng cột: chữ ngắn hết thì chia đều phần thừa', () => {
  const weights = columnWeights([[{ text: 'a' }, { text: 'b' }]], 2);
  assert.equal(weights[0], weights[1]);
  assert.ok(Math.abs(weights[0] + weights[1] - 286) <= 2);
});

test('lựa chọn: tên Lucide thành hình, emoji giữ nguyên, tên lạ không có icon', async () => {
  const { chat, sent } = setup();
  chat.onNotify({ id: 'n9', kind: 'needs_you', title: 'Chọn', text: 'Chọn', session_id: 's9', question: {
    reply_id: 'm9', kind: 'choice', question: 'Chọn', options: [{ id: 'a', text: 'A', icon: 'Send' }, { id: 'b', text: 'B', icon: '🎉' }, { id: 'c', text: 'C', icon: 'Xyzzy' }],
  } });
  const options = sent.filter((c) => c.t === AskCommand.CHOICES).at(-1).options;
  assert.deepEqual(options, [{ id: 'a', text: 'A', icon_path: lucidePath('Send') }, { id: 'b', text: 'B', icon: '🎉' }, { id: 'c', text: 'C' }]);
});

test('khối lạ / rỗng bị bỏ; không còn gì → null; URL không phải http(s) không đi tiếp', () => {
  assert.equal(normalizeBlocks('x', ctx), null);
  assert.equal(normalizeBlocks([{ type: 'lạ' }, { type: 'chart' }, { type: 'table', rows: [] }, { type: 'image', url: 'file:///c:/x.png' }, { type: '__proto__' }], ctx), null);
  const [cards] = normalizeBlocks([{ type: 'cards', cards: [{ title: 'A', image: 'file:///c:/x.png' }, { text: 'không tên' }] }], ctx);
  assert.deepEqual(cards.cards, [{ title: 'A', icon_path: lucidePath('sparkles') }]);
});

test('gắn tệp ảnh: khối ảnh có `done`, tải hỏng thì không có `file`; thẻ tải hỏng về icon', () => {
  const blocks = normalizeBlocks([
    { type: 'image', url: 'https://x.vn/a.png', caption: 'Ảnh A' },
    { type: 'image', url: 'https://x.vn/b.png' },
    { type: 'cards', cards: [{ title: 'C', icon: 'Bot', image: 'https://x.vn/c.png' }, { title: 'D', image: 'https://x.vn/a.png' }] },
  ], ctx);
  assert.deepEqual(imageUrlsOf(blocks), ['https://x.vn/a.png', 'https://x.vn/b.png', 'https://x.vn/c.png']);
  const out = withImageFiles(blocks, new Map([['https://x.vn/a.png', 'C:/a.png'], ['https://x.vn/b.png', null], ['https://x.vn/c.png', null]]));
  assert.equal(out[0].file, 'C:/a.png');
  assert.equal(out[0].done, true);
  assert.equal(out[1].file, undefined);
  assert.equal(out[1].open_text, 'Mở ảnh');
  assert.deepEqual(out[2].cards[0], { title: 'C', icon_path: lucidePath('Bot') });
  assert.deepEqual(out[2].cards[1], { title: 'D', icon_path: lucidePath('sparkles'), file: 'C:/a.png' });
});

test('lượt chat: xin blocks; dòng hiện ngay + mở ô hỏi; ảnh tải xong gửi lại đúng dòng, không bật ô lần nữa', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { chat, sent, emitted } = setup(async () => { await gate; return 'C:/img.png'; });
  await chat.ask('Vẽ đi');
  assert.equal(emitted[0].payload.blocks, true);
  chat.onChatEvent({ request_id: emitted[0].payload.request_id, kind: 'answer', text: 'Đây bạn', session_id: 's1', blocks: [{ type: 'image', url: 'https://x.vn/a.png' }] });
  const first = assistantRows(sent).at(-1);
  assert.equal(first.peek, true);
  assert.equal(first.blocks[0].file, undefined);
  release();
  await tick(); await tick();
  const second = assistantRows(sent).at(-1);
  assert.notEqual(second, first);
  assert.equal(second.id, first.id);
  assert.equal(second.peek, undefined);
  assert.equal(second.blocks[0].file, 'C:/img.png');
});

test('câu trả lời chỉ có khối: vẫn có dòng chữ để báo xong', async () => {
  const { chat, sent, emitted, alerts } = setup();
  await chat.ask('Bảng');
  chat.onChatEvent({ request_id: emitted[0].payload.request_id, kind: 'answer', text: '', session_id: 's1', blocks: [{ type: 'table', cols: 1, rows: [[{ text: 'A' }]] }] });
  assert.equal(assistantRows(sent).at(-1).text, 'Kết quả đây:');
  assert.equal(alerts.at(-1).text, 'Kết quả đây:');
});

test('báo chủ động có khối: có khối, không tự bật ô hỏi', () => {
  const sent = [];
  const chat = createMascotChat({ socket: () => null, send: (c) => sent.push(c), lang: 'vi', notifyFreq: 2, fetchImage: async () => null });
  chat.onNotify({ id: 'n1', kind: 'done', title: 'Xong', text: 'Báo cáo', session_id: 's2', blocks: [{ type: 'table', cols: 1, rows: [[{ text: 'A' }]] }] });
  const last = assistantRows(sent).at(-1);
  assert.equal(last.blocks[0].type, 'table');
  assert.equal(last.peek, undefined);
});

test('câu hỏi có khối: dòng câu hỏi kèm khối, ảnh tải xong cập nhật dòng đó', async () => {
  const { chat, sent, emitted } = setup(async () => 'C:/q.png');
  await chat.ask('Chọn');
  chat.onChatEvent({
    request_id: emitted[0].payload.request_id, kind: 'needs_input', text: 'Chọn một', session_id: 's1',
    question: { reply_id: 'm1', kind: 'choice', question: 'Chọn một', options: [{ id: 'a', text: 'A' }] },
    blocks: [{ type: 'image', url: 'https://x.vn/q.png' }],
  });
  const first = assistantRows(sent).find((r) => r.id === 'q-m1');
  assert.ok(first.blocks);
  await tick(); await tick();
  const updated = assistantRows(sent).filter((r) => r.id === 'q-m1').at(-1);
  assert.equal(updated.blocks[0].file, 'C:/q.png');
});

test('định dạng ảnh theo byte đầu, không theo đuôi / Content-Type', () => {
  assert.equal(imageExtension(PNG.subarray(0, 12)), 'png');
  assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(imageExtension(Buffer.from('RIFF0000WEBP')), 'webp');
  assert.equal(imageExtension(Buffer.from('<svg xmlns="')), null);
  assert.equal(imageExtension(Buffer.from('MZ')), null);
});

test('địa chỉ nội bộ bị coi là nội bộ, tên miền công khai thì không', () => {
  for (const h of ['localhost', 'router', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '[::1]', 'fd00::1', 'nas.local']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['beta.aivin.vn', '8.8.8.8', '172.32.0.1', 'example.com']) assert.equal(isPrivateHost(h), false, h);
});

/** http giả: `routes[url]` = { status, headers?, body? }. */
const fakeHttp = (routes) => ({
  calls: [],
  async get(url) {
    this.calls.push(url);
    const r = routes[url];
    if (!r) throw new Error('no route');
    return { status: r.status, headers: r.headers || {}, data: Readable.from(r.body ? [r.body] : []) };
  },
});
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-img-'));

test('tải ảnh: lưu tệp đúng đuôi, lần sau dùng lại không tải nữa', async () => {
  const dir = tmpDir();
  const http = fakeHttp({ 'https://x.vn/a': { status: 200, body: PNG } });
  const file = await fetchMascotImage('https://x.vn/a', { dir, http });
  assert.match(file, /\.png$/);
  assert.equal(fs.readFileSync(file).length, PNG.length);
  assert.equal(await fetchMascotImage('https://x.vn/a', { dir, http }), file);
  assert.equal(http.calls.length, 1);
});

test('tải ảnh: từ chối địa chỉ nội bộ, redirect vào nội bộ, tệp không phải ảnh, tệp quá lớn', async () => {
  const dir = tmpDir();
  assert.equal(await fetchMascotImage('http://192.168.1.1/a.png', { dir, http: fakeHttp({}) }), null);
  const redirect = fakeHttp({ 'https://x.vn/r': { status: 302, headers: { location: 'http://127.0.0.1/secret' } } });
  assert.equal(await fetchMascotImage('https://x.vn/r', { dir, http: redirect }), null);
  assert.deepEqual(redirect.calls, ['https://x.vn/r'], 'không đi tới địa chỉ nội bộ');
  assert.equal(await fetchMascotImage('https://x.vn/html', { dir, http: fakeHttp({ 'https://x.vn/html': { status: 200, body: Buffer.from('<html>xin chao</html>') } }) }), null);
  assert.equal(await fetchMascotImage('https://x.vn/big', { dir, http: fakeHttp({ 'https://x.vn/big': { status: 200, body: Buffer.alloc(7 * 1024 * 1024, 0x89) } }) }), null);
  assert.deepEqual(fs.readdirSync(dir), [], 'không để lại tệp');
});

test('tải ảnh: chính máy chủ Aivin trên mạng nội bộ vẫn tải được; redirect tới ảnh công khai đi theo', async () => {
  const dir = tmpDir();
  const local = fakeHttp({ 'http://localhost:3063/res/a.png': { status: 200, body: PNG } });
  assert.match(await fetchMascotImage('http://localhost:3063/res/a.png', { dir, http: local, serverUrl: 'http://localhost:3001' }), /\.png$/);
  const follow = fakeHttp({ 'https://x.vn/r': { status: 301, headers: { location: '/b.png' } }, 'https://x.vn/b.png': { status: 200, body: PNG } });
  assert.match(await fetchMascotImage('https://x.vn/r', { dir, http: follow }), /\.png$/);
});

test('icon Lucide: nét bắt đầu bằng m thường vẫn là toạ độ tuyệt đối sau khi gộp (nét không lệch)', () => {
  assert.ok(lucidePath('Send').includes('M21.854 2.147'), 'nét chéo của icon Gửi');
  assert.ok(lucidePath('CalendarCheck').includes('M9 16l2 2 4-4'), 'dấu tích của icon lịch: cặp số sau vẫn là tương đối');
});

const CATEGORY_SERIES = [{ label: 'Doanh thu', data: [120, 340, 90, 410] }, { label: 'Chi phí', data: [80, 150, 60, 220] }];
const LABELS = ['Q1', 'Q2', 'Q3', 'Q4'];

test('biểu đồ: đủ 12 kiểu đều ra hình trong khung, đường path đọc được', () => {
  const sets = {
    bar: CATEGORY_SERIES, horizontalBar: CATEGORY_SERIES, stackedBar: CATEGORY_SERIES, stackedHorizontalBar: CATEGORY_SERIES, line: CATEGORY_SERIES, radar: CATEGORY_SERIES,
    combo: [{ label: 'Doanh thu', data: [120, 340, 90, 410], type: 'bar' }, { label: 'Tăng trưởng %', data: [5, 12, -3, 8], type: 'line', axis: 'right' }],
    pie: [{ data: [40, 30, 20, 10] }], doughnut: [{ data: [40, 30, 20, 10] }], polarArea: [{ data: [40, 30, 20, 10] }],
    scatter: [{ label: 'A', data: [{ x: 1, y: 2 }, { x: 3, y: 5 }] }], bubble: [{ label: 'A', data: [{ x: 1, y: 2, r: 4 }, { x: 3, y: 5, r: 9 }] }],
  };
  assert.equal(Object.keys(sets).length, 12);
  for (const [kind, series] of Object.entries(sets)) {
    const out = chartLayout({ kind, labels: kind === 'scatter' || kind === 'bubble' ? [] : LABELS, series }, 'vi');
    assert.ok(out?.shapes.length > 3, kind);
    assert.equal(out.w, 288, kind);
    for (const s of out.shapes) {
      if (s.k === 'r') { assert.ok(s.x >= 0 && s.x + s.w <= out.w + 0.5, `${kind} rect x ${s.x} ${s.w}`); assert.ok(s.y >= 0 && s.y + s.h <= out.h + 0.5, `${kind} rect y ${s.y} ${s.h}`); }
      if (s.k === 'p') assert.match(s.d, /^M/, kind);
    }
    assert.ok(!JSON.stringify(out).includes('NaN'), `${kind} không có NaN`);
  }
});

test('biểu đồ: chú giải theo dãy; tròn thì theo lát kèm %; một dãy không tên thì không chú giải; không có số thì null', () => {
  assert.deepEqual(chartLayout({ kind: 'bar', labels: LABELS, series: CATEGORY_SERIES }).legend.map((l) => l.label), ['Doanh thu', 'Chi phí']);
  assert.deepEqual(chartLayout({ kind: 'pie', labels: ['A', 'B'], series: [{ data: [75, 25] }] }).legend.map((l) => l.label), ['A 75%', 'B 25%']);
  assert.deepEqual(chartLayout({ kind: 'bar', labels: LABELS, series: [{ data: [1, 2, 3, 4] }] }).legend, []);
  assert.equal(chartLayout({ kind: 'pie', labels: ['A'], series: [{ data: [0] }] }), null);
  assert.equal(chartLayout({ kind: 'bar', labels: [], series: [{ data: [null] }] }), null);
  assert.equal(chartLayout({ kind: 'lạ', labels: [], series: [{ data: [1] }] }), null);
  assert.equal(chartLayout({ kind: 'bar', labels: [], series: [] }), null);
});

test('biểu đồ: một dãy có cả âm lẫn dương thì tăng xanh, giảm đỏ; trục có mốc tròn số gồm 0', () => {
  const out = chartLayout({ kind: 'bar', labels: ['a', 'b'], series: [{ data: [10, -5] }] });
  assert.deepEqual(out.shapes.filter((s) => s.k === 'r').map((s) => s.f), ['#34D399', '#F87171']);
  const { ticks, min, max } = niceTicks(0, 37);
  assert.ok(ticks.includes(0) && min === 0 && max >= 37);
  assert.deepEqual(niceTicks(5, 5).ticks.length > 1, true, 'dãy phẳng vẫn có trục');
});

test('khối biểu đồ, sơ đồ, công cụ, phiên trình duyệt, tệp, nguồn', () => {
  const blocks = normalizeBlocks([
    { type: 'chart', kind: 'bar', title: 'Doanh thu', labels: LABELS, series: CATEGORY_SERIES, more: 2 },
    { type: 'diagram', source: 'flowchart TD\nA-->B' },
    { type: 'webview', message_id: 'm1', index: 1, title: 'Máy tính ROI' },
    { type: 'screencast', title: 'GitHub', url: 'https://github.com/search' },
    { type: 'link_card', kind: 'video', title: 'Demo', url: 'https://x.vn/a.mp4', text: 'Quý 3', label: 'Xem' },
    { type: 'sources', items: [{ name: 'Báo A', url: 'https://a.vn/x' }, { name: 'Tài liệu nội bộ' }, { name: 'Lạ', url: 'file:///c:/x' }] },
  ], ctx);
  assert.deepEqual(blocks.map((b) => b.type), ['chart', 'diagram', 'webview', 'link_card', 'link_card', 'sources']);
  assert.equal(blocks[0].note, 'còn 2 điểm dữ liệu');
  assert.equal(blocks[1].url, ctx.webUrl);
  assert.deepEqual([blocks[2].session_id, blocks[2].message_id, blocks[2].index, blocks[2].title], ['s1', 'm1', 1, 'Máy tính ROI']);
  assert.equal(blocks[3].text, 'github.com');
  assert.equal(blocks[3].url, ctx.webUrl, 'phiên trình duyệt xem trên web');
  assert.equal(blocks[4].icon_path, lucidePath('play'));
  assert.deepEqual(blocks[5].items, [{ name: 'Báo A', url: 'https://a.vn/x' }, { name: 'Tài liệu nội bộ' }, { name: 'Lạ' }]);
  const key = imageUrlsOf(blocks)[0];
  assert.equal(diagramSourceOf(key), 'flowchart TD\nA-->B');
  const done = withImageFiles(blocks, new Map([[key, 'C:/d.png']]));
  assert.equal(done[1].file, 'C:/d.png');
  assert.equal(done[1].source, undefined, 'cửa sổ không cần mã nguồn');
  const failed = withImageFiles(blocks, new Map([[key, null]]));
  assert.equal(failed[1].done, true);
  assert.equal(failed[1].file, undefined);
});

test('lượt chat: sơ đồ dựng xong gửi lại đúng dòng; nút chỉ làm được trên web mở phiên; tel / mailto có icon riêng', async () => {
  const sent = [];
  const emitted = [];
  const socket = { connected: true, timeout() { return this; }, async emitWithAck(event, payload) { emitted.push({ event, payload }); return { ok: true }; } };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onAlert: () => {}, onPending: () => {}, serverUrl: 'https://beta-api.aivin.vn', renderDiagramImage: async () => 'C:/d.png' });
  await chat.ask('Vẽ');
  chat.onChatEvent({
    request_id: emitted[0].payload.request_id, kind: 'answer', text: 'Đây', session_id: 's1', blocks: [{ type: 'diagram', source: 'flowchart TD' }],
    links: [{ text: 'Gọi', url: 'tel:1900 1234' }, { text: 'Mail', url: 'mailto:a@x.vn?attach=C:/x' }, { text: 'Kết nối', web: true }, { text: 'Chạy', url: 'C:/x.exe' }],
  });
  const first = assistantRows(sent).at(-1);
  assert.equal(first.blocks[0].file, undefined);
  assert.deepEqual(first.links.map((l) => [l.text, l.url]), [['Gọi', 'tel:1900 1234'], ['Mail', 'mailto:a@x.vn'], ['Kết nối', 'https://app.aivin.vn/?session_id=s1']]);
  assert.equal(first.links[0].icon_path, lucidePath('phone'));
  assert.equal(first.links[1].icon_path, lucidePath('mail'));
  await tick(); await tick();
  assert.equal(assistantRows(sent).at(-1).blocks[0].file, 'C:/d.png');
});

test('mở công cụ: xin HTML qua socket rồi mở cửa sổ; lỗi thì báo, không mở gì', async () => {
  const sent = [];
  const opened = [];
  let reply = { ok: true, html: '<b>x</b>' };
  const emitted = [];
  const socket = { connected: true, timeout() { return this; }, async emitWithAck(event, payload) { emitted.push({ event, payload }); return reply; } };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onAlert: () => {}, onPending: () => {}, openToolWindow: (html, title) => { opened.push([html, title]); return true; } });
  await chat.openTool({ session_id: 's1', message_id: 'm1', index: 2, title: 'ROI' });
  assert.deepEqual(emitted[0], { event: 'device:webview', payload: { session_id: 's1', message_id: 'm1', index: 2 } });
  assert.deepEqual(opened, [['<b>x</b>', 'ROI']]);
  reply = { ok: false };
  await chat.openTool({ session_id: 's1', message_id: 'm1', index: 0 });
  assert.equal(opened.length, 1);
  assert.ok(sent.some((c) => c.t === AskCommand.STATUS && /Không mở được/.test(c.text)));
  await chat.openTool({ message_id: 'm1' });
  assert.equal(emitted.length, 2, 'thiếu phiên thì không gọi BE');
});

test('trang công cụ: HTML của AI chỉ nằm trong iframe sandbox, không thoát được ra trang bọc', () => {
  const page = webviewPage('<script>alert(1)</script><iframe>"\'', 'Tiêu đề <x>');
  assert.match(page, /<iframe sandbox="allow-scripts allow-modals"/);
  assert.ok(!page.includes('<script>'), 'không có thẻ script thật trong trang bọc');
  assert.ok(page.includes('&lt;script&gt;alert(1)'));
  assert.ok(page.includes('Tiêu đề &lt;x&gt;'));
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups/.test(page));
});

test('mở công cụ: không có trình duyệt thì báo không mở được; có thì mở cửa sổ ứng dụng trỏ tới tệp bọc', () => {
  const dir = tmpDir();
  assert.equal(openWebview('<b>x</b>', 'T', { dir, browser: null }), false);
  const calls = [];
  const spawnImpl = (cmd, args) => { calls.push([cmd, args]); return { on() {}, unref() {} }; };
  assert.equal(openWebview('<b>x</b>', 'T', { dir, browser: 'edge.exe', spawnImpl }), true);
  assert.equal(calls[0][0], 'edge.exe');
  assert.match(calls[0][1][0], /^--app=file:\/\/\//);
});

test('tìm trình duyệt: Edge trước, rồi Chrome; không có thì null', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\L' };
  assert.equal(findBrowser(env, (f) => f.includes('Edge')), 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(findBrowser(env, (f) => f.includes('Chrome')), 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(findBrowser(env, () => false), null);
});

test('dựng sơ đồ: chặn mạng, đo cỡ rồi chụp; đo không ra / lỗi thì null, không ném; có sẵn thì dùng lại', async () => {
  const dir = tmpDir();
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push(args);
    const child = new (require('events').EventEmitter)();
    child.stdout = new (require('events').EventEmitter)();
    child.kill = () => {};
    setImmediate(() => {
      if (args.includes('--dump-dom')) child.stdout.emit('data', '<html><head><title>OK 300 200</title></head></html>');
      const shot = args.find((a) => a.startsWith('--screenshot='));
      if (shot) fs.writeFileSync(shot.slice('--screenshot='.length), 'png');
      child.emit('close', 0);
    });
    return child;
  };
  const file = await renderDiagram('flowchart TD\nA-->B', { dir, browser: 'edge.exe', spawnImpl });
  assert.match(file, /\.png$/);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--host-resolver-rules=MAP * ~NOTFOUND'), 'chặn mạng');
  assert.ok(calls[1].includes('--window-size=316,216'));
  assert.equal(await renderDiagram('flowchart TD\nA-->B', { dir, browser: 'edge.exe', spawnImpl }), file);
  assert.equal(calls.length, 2, 'đã có ảnh thì không chạy lại');
  assert.equal(await renderDiagram('x', { dir, browser: null }), null);
  const noSize = () => {
    const child = new (require('events').EventEmitter)();
    child.stdout = new (require('events').EventEmitter)();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', '<title>FAIL</title>'); child.emit('close', 0); });
    return child;
  };
  assert.equal(await renderDiagram('sai cú pháp', { dir, browser: 'edge.exe', spawnImpl: noSize }), null);
  const broken = () => { throw new Error('no'); };
  assert.equal(await renderDiagram('khác', { dir, browser: 'edge.exe', spawnImpl: broken }), null);
});

test('link của nút: nhận http(s), gọi, mail, tin nhắn; bỏ tệp đính kèm của mailto; từ chối đường dẫn chạy được', () => {
  assert.equal(safeLinkUrl('https://x.vn/a'), 'https://x.vn/a');
  assert.equal(safeLinkUrl('tel:+84 912 345 678'), 'tel:+84 912 345 678');
  assert.equal(safeLinkUrl('sms:1900'), 'sms:1900');
  assert.equal(safeLinkUrl('mailto:a@x.vn?subject=Hi&attachment=C:/x'), 'mailto:a@x.vn?subject=Hi');
  for (const bad of ['file:///c:/x.exe', 'C:/x.exe', 'tel:abc', 'ms-settings:', 'javascript:alert(1)', 'mailto:a b', undefined]) assert.equal(safeLinkUrl(bad), null, String(bad));
});

test('biểu mẫu: có/không thành nút; giá trị điền sẵn thành nút giữ, vẫn gõ được giá trị khác; tự gõ ngoài lựa chọn khi cho phép', async () => {
  const sent = [];
  const emitted = [];
  const socket = { connected: true, timeout() { return this; }, async emitWithAck(event, payload) { emitted.push({ event, payload }); return { ok: true }; } };
  const chat = createMascotChat({ socket: () => socket, send: (c) => sent.push(c), lang: 'vi', onAlert: () => {}, onPending: () => {} });
  chat.onNotify({ id: 'f1', kind: 'needs_you', title: 'Điền', text: 'Điền', session_id: 's1', question: {
    reply_id: 'm1', kind: 'form', question: 'Điền', fields: [
      { name: 'ok', label: 'Đồng ý', type: 'boolean', required: true },
      { name: 'n', label: 'Số lượng', type: 'number', required: true, default_value: '2', placeholder: 'vd 3' },
      { name: 'g', label: 'Gói', type: 'enum', required: true, allow_custom: true, options: [{ id: 'a', text: 'A' }] },
    ],
  } });
  const lastChoices = () => sent.filter((c) => c.t === AskCommand.CHOICES).at(-1).options.map((o) => [o.id, o.text]);
  assert.deepEqual(lastChoices(), [['true', 'Có'], ['false', 'Không']]);
  await chat.choose('false');
  assert.deepEqual(lastChoices(), [['2', 'Giữ: 2']]);
  assert.ok(assistantRows(sent).some((r) => /\(vd 3\)/.test(r.text)), 'hiện gợi ý');
  await chat.reply('7');
  assert.deepEqual(lastChoices(), [['a', 'A']]);
  await chat.reply('gói riêng');
  assert.deepEqual(emitted.at(-1).payload.fields, { ok: 'false', n: '7', g: 'gói riêng' });
});

test('link phiên trên web: đúng tên miền web của máy chủ đang ghép', async () => {
  const { webUrlForSession } = await import('../bin/lib/remote/mascot/ask.mjs');
  assert.equal(webUrlForSession('s1', 'https://beta-api.aivin.vn'), 'https://app.aivin.vn/?session_id=s1');
  assert.equal(webUrlForSession('s1', 'https://api.aivin.cloud'), 'https://aivin.cloud/?session_id=s1');
  assert.equal(webUrlForSession('s 1', 'wss://demo-api.aivin.vn:8443'), 'https://demo.aivin.vn:8443/?session_id=s%201');
});
