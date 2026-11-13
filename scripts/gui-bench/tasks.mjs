import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { norm, sleep, closeWindow } from './harness.mjs';

/**
 * Tác vụ đo. Mỗi tác vụ: `setup(work)` (tạo dữ liệu), `run(t, ctx)` (Planner giả lập gọi công cụ), kiểm bằng nguồn độc lập. Nhãn trong
 * `visible` là chữ một model nhìn ảnh sẽ nói (vd "×", "7"), `pick` là phần tử Planner thật sự muốn khi đã thấy danh sách.
 */

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const running = (image) => {
  try { return execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).toLowerCase().includes(image.toLowerCase()); } catch { return false; }
};
const killImage = (image) => { try { execFileSync('taskkill', ['/IM', image, '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* không chạy */ } };

/** Chờ cửa sổ có tiêu đề chứa chữ — dùng khi tệp mở vào cửa sổ đã có (Notepad tab) nên open_app không thấy cửa sổ mới. */
async function windowByTitle(t, text) {
  const r = await t.call('wait_for', { title_contains: text, timeout_ms: 15000 }, { allowError: true, why: 'chờ cửa sổ của tệp' });
  const w = await t.call('windows', {}, { why: 'tìm handle cửa sổ' });
  const hit = w.windows.find((x) => norm(x.title).includes(norm(text)));
  if (hit) t.remember(hit);
  return hit?.window || r?.match?.window;
}

async function openFileWindow(t, file, titleHint) {
  const o = await t.call('open_app', { file });
  if (o.window?.window && norm(o.window.title).includes(norm(titleHint))) return o.window.window;
  return windowByTitle(t, titleHint);
}

/** Nút số của Máy tính: model nhìn ảnh nói "7", cây trợ năng gọi "Seven". */
const DIGIT = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

export const TASKS = [
  {
    id: 'calc.arith', app: 'Calculator', title: 'Bấm 123 × 45 = bằng nút, đọc kết quả',
    async run(t, c) {
      const o = await t.call('open_app', { name: 'Calculator' });
      const win = o.window.window;
      c.cleanup(() => closeWindow(win));
      await t.press({ visible: 'C', pick: 'Clear', within: win });
      for (const ch of '123×45=') {
        const pick = /\d/.test(ch) ? DIGIT[+ch] : ch === '×' ? 'Multiply by' : 'Equals';
        await t.press({ visible: ch, pick, within: win });
      }
      const r = await t.call('find', { query: 'Display is', window: win }, { why: 'đọc kết quả' });
      const shown = r.nodes?.[0]?.name || '';
      t.check('màn hình hiện 5,535', /5[.,]?535/.test(shown), shown);
    },
  },
  {
    id: 'calc.keys', app: 'Calculator', title: 'Gõ phím 99*99= chạy nền, đọc kết quả',
    async run(t, c) {
      const o = await t.call('open_app', { name: 'Calculator' });
      const win = o.window.window;
      c.cleanup(() => closeWindow(win));
      await t.call('do', { do: 'key', value: 'escape 9 9 shift+8 9 9 enter', within: win });
      const r = await t.call('find', { query: 'Display is', window: win }, { why: 'đọc kết quả' });
      const shown = r.nodes?.[0]?.name || '';
      t.check('màn hình hiện 9,801', /9[.,]?801/.test(shown), shown);
    },
  },
  {
    id: 'calc.mode', app: 'Calculator', title: 'Đổi sang chế độ Scientific rồi trả về Standard',
    async run(t, c) {
      const o = await t.call('open_app', { name: 'Calculator' });
      const win = o.window.window;
      c.cleanup(() => closeWindow(win));
      await t.press({ visible: 'menu', pick: 'Open Navigation', within: win });
      await t.call('wait_for', { window: win, name: 'Scientific', timeout_ms: 5000 }, { allowError: true, why: 'chờ menu mở' });
      t.forget(win);
      await t.press({ visible: 'Scientific', within: win });
      const r = await t.call('find', { query: 'Calculator mode', window: win }, { why: 'đọc tiêu đề chế độ' });
      t.check('đã sang Scientific', /scientific/i.test(r.nodes?.[0]?.name || ''), r.nodes?.[0]?.name);
      t.forget(win);
      await t.press({ visible: 'menu', pick: 'Open Navigation', within: win });
      await t.call('wait_for', { window: win, name: 'Standard', role: 'listitem', timeout_ms: 5000 }, { allowError: true, why: 'chờ menu mở' });
      t.forget(win);
      await t.press({ visible: 'Standard', within: win });
      const back = await t.call('find', { query: 'Calculator mode', window: win }, { why: 'đọc tiêu đề chế độ' });
      t.check('đã về Standard', /standard/i.test(back.nodes?.[0]?.name || ''), back.nodes?.[0]?.name);
    },
  },
  {
    id: 'notepad.edit_save', app: 'Notepad', title: 'Mở tệp, thay nội dung tiếng Việt, Ctrl+S, kiểm trên đĩa',
    setup(work) { fs.writeFileSync(path.join(work, 'ghi-chu-bench.txt'), 'nội dung cũ\r\n', 'utf8'); },
    async run(t, c) {
      const file = path.join(c.work, 'ghi-chu-bench.txt');
      const win = await openFileWindow(t, file, 'ghi-chu-bench');
      t.check('thấy cửa sổ Notepad của tệp', !!win);
      if (!win) return;
      c.cleanup(() => closeWindow(win));
      const text = 'Phiếu thu số 042 — khách hàng Nguyễn Thị Ánh, số tiền 1.250.000 ₫';
      await t.press({ do: 'fill', visible: 'text area', pick: 'Text editor', within: win, value: text });
      await t.call('do', { do: 'key', value: 'ctrl+s', within: win });
      await sleep(600);
      const disk = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      t.check('tệp trên đĩa đúng nội dung', disk.trim() === text, JSON.stringify(disk));
      await t.call('do', { do: 'key', value: 'ctrl+w', within: win }, { allowError: true, why: 'đóng tab' });
    },
  },
  {
    id: 'notepad.replace', app: 'Notepad', title: 'Ctrl+H, thay mọi "ACME" bằng "Aivin", lưu',
    setup(work) { fs.writeFileSync(path.join(work, 'thay-the-bench.txt'), 'ACME báo giá\r\nGửi ACME\r\nACME cảm ơn\r\n', 'utf8'); },
    async run(t, c) {
      const file = path.join(c.work, 'thay-the-bench.txt');
      const win = await openFileWindow(t, file, 'thay-the-bench');
      t.check('thấy cửa sổ Notepad của tệp', !!win);
      if (!win) return;
      c.cleanup(() => closeWindow(win));
      await t.call('do', { do: 'key', value: 'ctrl+h', within: win });
      await t.call('wait_for', { window: win, name: 'Replace all', timeout_ms: 5000 }, { allowError: true, why: 'chờ hộp thay thế' });
      await t.press({ do: 'fill', visible: 'Find', within: win, value: 'ACME', pick: (n) => n.role === 'edit' && /find/i.test(n.name || '') });
      await t.press({ do: 'fill', visible: 'Replace', within: win, value: 'Aivin', pick: (n) => n.role === 'edit' && /replace/i.test(n.name || '') });
      await t.press({ visible: 'Replace all', within: win });
      await t.call('do', { do: 'key', value: 'ctrl+s', within: win });
      await sleep(600);
      const disk = fs.readFileSync(file, 'utf8');
      t.check('không còn ACME, có 3 Aivin', !disk.includes('ACME') && (disk.match(/Aivin/g) || []).length === 3, JSON.stringify(disk));
      await t.call('do', { do: 'key', value: 'escape', within: win }, { allowError: true });
      await t.call('do', { do: 'key', value: 'ctrl+w', within: win }, { allowError: true, why: 'đóng tab' });
    },
  },
  {
    id: 'notepad.save_as', app: 'Notepad', title: 'Tab mới, gõ chữ, Lưu thành (hộp thoại hệ thống), kiểm trên đĩa',
    setup(work) { fs.writeFileSync(path.join(work, 'mo-dau-bench.txt'), 'x', 'utf8'); },
    async run(t, c) {
      const win = await openFileWindow(t, path.join(c.work, 'mo-dau-bench.txt'), 'mo-dau-bench');
      if (!t.check('thấy cửa sổ Notepad', !!win)) return;
      c.cleanup(() => closeWindow(win));
      await t.call('do', { do: 'key', value: 'ctrl+n', within: win });
      await sleep(400);
      t.forget(win);
      const text = 'Biên bản họp ngày 13/11 — đã chốt ngân sách';
      await t.press({ do: 'fill', visible: 'text area', pick: 'Text editor', within: win, value: text });
      await t.call('do', { do: 'key', value: 'ctrl+shift+s', within: win });
      const dlg = await t.call('wait_for', { title_contains: 'Save as', timeout_ms: 8000 }, { allowError: true, why: 'chờ hộp Lưu thành' });
      const ws = await t.call('windows', { include_dialogs: true }, { why: 'tìm hộp thoại' });
      const d = ws.windows.find((w) => /save as/i.test(w.title || ''));
      if (!t.check('hộp Lưu thành hiện ra', !!d, JSON.stringify(dlg).slice(0, 200))) return;
      t.remember(d);
      const target = path.join(c.work, 'bien-ban-bench.txt');
      await t.press({ do: 'fill', visible: 'File name', within: d.window, value: target, pick: (n) => n.role === 'edit' && /file name/i.test(n.name || '') });
      await t.press({ visible: 'Save', within: d.window, pick: (n) => n.role === 'button' && /^save$/i.test(n.name || '') });
      await t.call('wait_for', { until: 'gone', title_contains: 'Save as', timeout_ms: 8000 }, { allowError: true, why: 'chờ hộp đóng' });
      await sleep(500);
      const ok = fs.existsSync(target) && fs.readFileSync(target, 'utf8').replace(/^﻿/, '').trim() === text;
      t.check('tệp mới trên đĩa đúng nội dung', ok, fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : 'không có tệp');
      await t.call('do', { do: 'key', value: 'ctrl+w', within: win }, { allowError: true, why: 'đóng tab' });
      await t.call('do', { do: 'key', value: 'ctrl+w', within: win }, { allowError: true, why: 'đóng tab' });
    },
  },
  {
    id: 'explorer.newfolder', app: 'File Explorer', title: 'Trong thư mục: tạo thư mục mới tên tiếng Việt',
    setup(work) { fs.mkdirSync(path.join(work, 'kho'), { recursive: true }); fs.writeFileSync(path.join(work, 'kho', 'a.txt'), 'a'); },
    async run(t, c) {
      const dir = path.join(c.work, 'kho');
      const o = await t.call('open_app', { file: dir });
      const win = o.window?.window || await windowByTitle(t, 'kho');
      if (!t.check('mở được cửa sổ thư mục', !!win)) return;
      c.cleanup(() => closeWindow(win));
      await t.call('do', { do: 'key', value: 'ctrl+shift+n', within: win });
      await sleep(700);
      t.forget(win);
      const name = 'Hồ sơ tháng 11';
      // Ô đổi tên đang được focus: Planner gõ thẳng (type vào phần tử đang focus).
      await t.call('act', { action: 'key', keys: 'ctrl+a', window: win });
      await t.call('act', { action: 'type', text: name, window: win });
      await t.call('act', { action: 'key', keys: 'enter', window: win });
      await sleep(700);
      t.check('thư mục mới có trên đĩa', fs.existsSync(path.join(dir, name)), fs.readdirSync(dir).join(', '));
    },
  },
  {
    id: 'explorer.rename', app: 'File Explorer', title: 'Chọn tệp, F2, đổi tên',
    setup(work) { fs.mkdirSync(path.join(work, 'doiten'), { recursive: true }); fs.writeFileSync(path.join(work, 'doiten', 'bao-cao-cu.txt'), 'x'); fs.writeFileSync(path.join(work, 'doiten', 'khac.txt'), 'y'); },
    async run(t, c) {
      const dir = path.join(c.work, 'doiten');
      const o = await t.call('open_app', { file: dir });
      const win = o.window?.window || await windowByTitle(t, 'doiten');
      if (!t.check('mở được cửa sổ thư mục', !!win)) return;
      c.cleanup(() => closeWindow(win));
      await sleep(800);
      await t.press({ visible: 'bao-cao-cu.txt', pick: (n) => n.role === 'listitem' && /bao-cao-cu/.test(n.name || ''), within: win });
      // F2 trên đúng mục (node_id): chọn bằng pattern không chuyển tiêu điểm bàn phím tới mục đó.
      const item = await t.call('find', { query: 'bao-cao-cu', window: win, role: 'listitem' }, { why: 'id của mục để bấm F2 trên nó' });
      await t.call('act', item.nodes?.[0] ? { action: 'key', keys: 'f2', node_id: item.nodes[0].id } : { action: 'key', keys: 'f2', window: win });
      await sleep(400);
      await t.call('act', { action: 'type', text: 'bao-cao-moi', window: win });
      await t.call('act', { action: 'key', keys: 'enter', window: win });
      await sleep(700);
      t.check('đã đổi tên trên đĩa', fs.existsSync(path.join(dir, 'bao-cao-moi.txt')), fs.readdirSync(dir).join(', '));
    },
  },
  {
    id: 'explorer.bigfolder', app: 'File Explorer', title: 'Thư mục 1500 tệp: tìm và chọn file_1234.txt (ngoài màn hình)',
    setup(work) {
      const d = path.join(work, 'nhieu');
      fs.mkdirSync(d, { recursive: true });
      for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(d, `file_${String(i).padStart(4, '0')}.txt`), '');
    },
    async run(t, c) {
      const dir = path.join(c.work, 'nhieu');
      const o = await t.call('open_app', { file: dir });
      const win = o.window?.window || await windowByTitle(t, 'nhieu');
      if (!t.check('mở được cửa sổ thư mục', !!win)) return;
      c.cleanup(() => closeWindow(win));
      await sleep(1200);
      const f = await t.call('find', { query: 'file_1234.txt', window: win }, { allowError: true, why: 'tìm tệp ngoài màn hình' });
      let node = f.nodes?.find((n) => /file_1234/.test(n.name || ''));
      if (!node) {
        t.note('find không thấy tệp ngoài màn hình → Planner dùng ô tìm kiếm của Explorer');
        await t.press({ do: 'fill', visible: 'Search', within: win, value: 'file_1234', pick: (n) => n.role === 'edit' && /search/i.test(n.name || '') });
        await t.call('do', { do: 'key', value: 'enter', within: win });
        await t.call('wait_for', { window: win, name: 'file_1234', role: 'listitem', timeout_ms: 15000 }, { allowError: true, why: 'chờ kết quả tìm' });
        const f2 = await t.call('find', { query: 'file_1234', window: win, role: 'listitem' });
        node = f2.nodes?.find((n) => /file_1234/.test(n.name || ''));
      }
      if (!t.check('thấy file_1234.txt', !!node)) return;
      const r = await t.call('act', { action: 'click', node_id: node.id });
      t.check('đã chọn tệp', r.target?.selected === true || /file_1234/.test(r.focused_element?.name || ''), JSON.stringify(r.target || r.focused_element));
    },
  },
  {
    id: 'settings.about', app: 'Settings', title: 'Settings → System → About, đọc tên máy',
    async run(t, c) {
      const o = await t.call('open_app', { name: 'Settings' });
      const win = o.window.window;
      c.cleanup(() => closeWindow(win));
      await t.press({ visible: 'System', within: win, pick: (n) => n.role === 'listitem' && n.name === 'System' });
      await t.call('wait_for', { window: win, name: 'About', timeout_ms: 6000 }, { allowError: true, why: 'chờ trang System' });
      t.forget(win);
      await t.press({ visible: 'About', within: win, pick: (n) => /^about/i.test(n.name || '') && n.role !== 'text' });
      await t.call('wait_for', { window: win, name: 'Device name', timeout_ms: 6000 }, { allowError: true, why: 'chờ trang About' });
      const r = await t.call('find', { query: os.hostname(), window: win }, { why: 'đọc tên máy' });
      t.check('thấy tên máy trên trang About', r.nodes?.some((n) => norm(n.name).includes(norm(os.hostname()))), r.nodes?.map((n) => n.name).join(' / '));
    },
  },
  {
    id: 'clock.stopwatch', app: 'Clock', title: 'Đồng hồ bấm giờ: Start, chờ, Pause, đọc, Reset',
    async run(t, c) {
      const o = await t.call('open_app', { name: 'Clock' });
      const win = o.window.window;
      c.cleanup(() => closeWindow(win));
      await t.press({ visible: 'Stopwatch', within: win });
      await t.call('wait_for', { window: win, name: 'Start', timeout_ms: 6000 }, { allowError: true, why: 'chờ trang bấm giờ' });
      t.forget(win);
      await t.press({ visible: 'Start', within: win, pick: (n) => n.role === 'button' && /^start$/i.test(n.name || '') });
      await sleep(1600);
      t.forget(win);
      await t.press({ visible: 'Pause', within: win, pick: (n) => n.role === 'button' && /^pause$/i.test(n.name || '') });
      const r = await t.call('observe', { window: win }, { why: 'đọc thời gian' });
      // Nhãn trợ năng: "0 hours 0 minutes 1 seconds 62 centiseconds".
      const time = r.nodes.find((n) => /seconds?/i.test(n.name || ''));
      const label = time?.name || '';
      if (!time) t.note(`nhãn có số: ${r.nodes.filter((n) => /\d/.test(n.name || '')).map((n) => n.name).join(' | ').slice(0, 300)}`);
      const secs = Number((label.match(/(\d+)\s*seconds?/i) || [])[1] || 0) + 60 * Number((label.match(/(\d+)\s*minutes?/i) || [])[1] || 0);
      t.check('thời gian đã chạy (≥ 1 giây)', secs >= 1, label);
      await t.press({ visible: 'Reset', within: win, pick: (n) => n.role === 'button' && /^reset$/i.test(n.name || '') });
    },
  },
  {
    id: 'ledger.form', app: 'BenchApp', title: 'Phiếu thu WinForms: điền họ tên, số tiền, chọn hình thức, tích duyệt, Ghi sổ',
    fixture: 'ledger',
    async run(t, c) {
      const win = c.fixtureWindow;
      await t.press({ do: 'fill', visible: 'Họ tên', within: win, value: 'Nguyễn Văn Ánh' });
      await t.press({ do: 'fill', visible: 'Số tiền', within: win, value: '1.250.000' });
      await t.press({ do: 'select', visible: 'Hình thức', within: win, value: 'Chuyển khoản' });
      await t.press({ do: 'toggle', visible: 'Đã duyệt', within: win, value: 'on' });
      await t.press({ visible: 'Ghi sổ', within: win });
      await sleep(300);
      const s = readJson(c.fixtureState);
      t.check('đã ghi sổ', s?.last === 'save', JSON.stringify(s));
      t.check('họ tên đúng', s?.name === 'Nguyễn Văn Ánh', s?.name);
      t.check('số tiền đúng', s?.amount === '1.250.000', s?.amount);
      t.check('hình thức = Chuyển khoản', s?.kind === 'Chuyển khoản', s?.kind);
      t.check('đã tích duyệt', s?.approved === true, s?.approved);
    },
  },
  {
    id: 'ledger.grid_row', app: 'BenchApp', title: 'Bảng 800 dòng: chọn dòng SP0650 (ngoài màn hình)',
    fixture: 'ledger',
    async run(t, c) {
      const win = c.fixtureWindow;
      const r = await t.call('do', { do: 'click', target: 'SP0650', within: win }, { allowError: true, why: 'bấm dòng (đang khuất)' });
      if (!r.ok) {
        t.note('gui.do không thấy dòng đang khuất → Planner chọn dòng theo giá trị trên bảng');
        const obs = await t.call('observe', { window: win });
        const table = obs.nodes.find((n) => /table|datagrid/.test(n.role));
        if (!t.check('thấy bảng', !!table)) return;
        await t.call('act', { action: 'select', node_id: table.id, option: 'SP0650' });
      }
      await sleep(300);
      const s = readJson(c.fixtureState);
      t.check('ứng dụng đã chọn đúng dòng', s?.row === 'SP0650', JSON.stringify(s));
    },
  },
  {
    id: 'ledger.read_table', app: 'BenchApp', title: 'Đọc cả bảng 800 dòng thành dữ liệu',
    fixture: 'ledger',
    async run(t, c) {
      const win = c.fixtureWindow;
      const obs = await t.call('observe', { window: win });
      const table = obs.nodes.find((n) => /table|datagrid/.test(n.role));
      if (!t.check('thấy bảng', !!table, obs.nodes.map((n) => n.role).filter((r, i, a) => a.indexOf(r) === i).join(','))) return;
      const r = await t.call('read_table', { node_id: table.id, max_rows: 1000 });
      const rows = r.rows || [];
      const r650 = rows.find((x) => String(x).includes('SP0650') || (Array.isArray(x) && x.includes('SP0650')));
      t.check('đủ 800 dòng', rows.length === 800, `${rows.length} dòng, complete=${r.complete} reason=${r.reason || ''}`);
      t.check('dòng SP0650 đúng số lượng', r650 && String(r650).includes(String((650 * 37) % 97)), JSON.stringify(r650));
      t.check('có tên cột', JSON.stringify(r.columns || '').includes('Tên hàng'), JSON.stringify(r.columns));
    },
  },
  {
    id: 'ledger.drawn_button', app: 'BenchApp', title: 'Bấm nút vẽ tay "Xuất hoá đơn" (chỉ có trên ảnh, cần OCR)',
    fixture: 'ledger',
    async run(t, c) {
      const win = c.fixtureWindow;
      await t.press({ visible: 'Xuất hoá đơn', within: win, pick: (n) => n.source === 'ocr' && /xu.t/i.test(norm(n.name)) });
      await sleep(300);
      const s = readJson(c.fixtureState);
      t.check('ứng dụng nhận bấm "Xuất hoá đơn"', s?.drawn === 'Xuất hoá đơn', JSON.stringify(s));
    },
  },
  {
    id: 'ledger.modal_confirm', app: 'BenchApp', title: 'Bấm "Xoá phiếu" → hộp xác nhận modal → chọn "No"',
    fixture: 'ledger',
    async run(t, c) {
      const win = c.fixtureWindow;
      await t.call('do', { do: 'click', target: 'Xoá phiếu', within: win });
      await t.call('wait_for', { title_contains: 'Xác nhận xoá', timeout_ms: 5000 }, { allowError: true, why: 'chờ hộp xác nhận' });
      // Planner vẫn nói cửa sổ chính — hộp thoại đang khoá nó.
      await t.press({ visible: 'No', within: win, pick: (n) => n.role === 'button' && /^(no|không)$/i.test(n.name || '') });
      await sleep(400);
      const s = readJson(c.fixtureState);
      t.check('đã huỷ xoá (chọn No)', s?.last === 'delete_cancelled', JSON.stringify(s));
    },
  },
  {
    id: 'ledger.risky_guard', app: 'BenchApp', title: 'An toàn: "bấm phiếu" khớp nút "Xoá phiếu" — không tự bấm, trả về để BE xét',
    fixture: 'ledger',
    async run(t, c) {
      const win = c.fixtureWindow;
      // Mô tả không nói "xoá" nhưng phần tử khớp lại là nút xoá → máy không tự bấm (câu mô tả đã qua cổng duyệt BE không nói tới xoá).
      const r = await t.call('do', { do: 'click', target: 'phiếu', within: win }, { allowError: true });
      await sleep(300);
      const s = readJson(c.fixtureState);
      t.check('không tự bấm Xoá phiếu', !/delete/.test(s?.last || ''), JSON.stringify(s));
      t.check('trả mơ hồ / cần xét', r.code === 'GUI_AMBIGUOUS_TARGET', r.code);
    },
  },
  {
    id: 'canvas.drawn', app: 'BenchApp', title: 'Cửa sổ vẽ tay hoàn toàn: bấm "Confirm order", bấm ô "Customer code" rồi gõ KH-042',
    fixture: 'drawn',
    async run(t, c) {
      const win = c.fixtureWindow;
      await t.press({ visible: 'Confirm order', within: win, pick: (n) => n.source === 'ocr' && /confirm/i.test(n.name || '') });
      await sleep(300);
      let s = readJson(c.fixtureState);
      t.check('nhận bấm Confirm order', s?.clicked === 'Confirm order', JSON.stringify(s));
      await t.press({ do: 'fill', visible: 'Customer code', within: win, value: 'KH-042', pick: (n) => n.source === 'ocr' && /customer/i.test(n.name || '') });
      await sleep(300);
      s = readJson(c.fixtureState);
      t.check('đã gõ KH-042 vào ô vẽ tay', s?.typed === 'KH-042', JSON.stringify(s));
    },
  },
  {
    id: 'paint.draw', app: 'Paint', title: 'Paint: chọn hình chữ nhật, kéo vẽ trên canvas (cần chuột thật)',
    async run(t, c) {
      const wasRunning = running('mspaint.exe');
      const o = await t.call('open_app', { name: 'Paint' });
      const win = o.window.window;
      c.cleanup(() => { if (!wasRunning) killImage('mspaint.exe'); else closeWindow(win); });
      await t.press({ visible: 'Rectangle', within: win, pick: (n) => n.role === 'button' && n.name === 'Rectangle' });
      const obs = await t.call('observe', { window: win, include_image: true }, { why: 'lấy ảnh để chọn điểm kéo' });
      const canvas = obs.nodes.find((n) => /canvas/i.test(n.name || '') && n.rect);
      if (!t.check('thấy canvas', !!canvas)) return;
      const scale = obs.image_scale || 1;
      const p = (fx, fy) => ({ x: Math.round((canvas.rect.x + canvas.rect.w * fx) * scale), y: Math.round((canvas.rect.y + canvas.rect.h * fy) * scale) });
      await t.call('act', { action: 'drag', window: win, point: p(0.3, 0.3), to: p(0.6, 0.6), image_scale: scale });
      await sleep(400);
      const undo = await t.call('find', { query: 'Undo', window: win, role: 'button' });
      const ws = await t.call('windows', {});
      const title = ws.windows.find((w) => w.window === win)?.title || '';
      t.check('ảnh đã thay đổi (tiêu đề có * hoặc Undo bật)', title.startsWith('*') || undo.nodes?.length > 0, title);
    },
  },
  {
    id: 'excel.edit_cell', app: 'Excel', title: 'Excel: mở CSV, đi tới D5 bằng Name Box, nhập số, lưu, kiểm trên đĩa',
    setup(work) {
      const rows = ['Ma,Ten,SoLuong,DonGia'];
      for (let i = 1; i <= 300; i++) rows.push(`SP${String(i).padStart(4, '0')},San pham ${i},${i % 17},${1000 + i}`);
      fs.writeFileSync(path.join(work, 'bang-gia-bench.csv'), `${rows.join('\r\n')}\r\n`, 'utf8');
    },
    async run(t, c) {
      const wasRunning = running('EXCEL.EXE');
      const file = path.join(c.work, 'bang-gia-bench.csv');
      const probe = await t.call('open_app', { file }, { allowError: true, why: 'mở bằng ứng dụng mặc định' });
      if (probe.code === 'GUI_BLOCKED_APP') return t.skip(`máy chặn mở .csv: ${String(probe.error).slice(0, 120)}`);
      const win = probe.window?.window && norm(probe.window.title).includes('bang gia bench') ? probe.window.window : await windowByTitle(t, 'bang-gia-bench');
      c.cleanup(() => { if (!wasRunning) killImage('EXCEL.EXE'); else if (win) closeWindow(win); });
      if (!t.check('mở được tệp', !!win)) return;
      const info = (await t.call('windows', {}, { why: 'xem ứng dụng nào mở tệp' })).windows.find((w) => w.window === win);
      if (!/excel/i.test(info?.process || '')) return t.skip(`.csv mở bằng ${info?.process} ("${info?.title}"), không phải Excel trên máy này`);
      await t.call('wait_for', { window: win, name: 'Name Box', timeout_ms: 20000 }, { allowError: true, why: 'chờ Excel sẵn sàng' });
      await t.press({ do: 'fill', visible: 'Name Box', within: win, value: 'D5', pick: (n) => /name box/i.test(n.name || '') && /edit|combobox/.test(n.role) });
      await t.call('do', { do: 'key', value: 'enter', within: win });
      await t.call('act', { action: 'type', text: '98765', window: win });
      await t.call('act', { action: 'key', keys: 'enter', window: win });
      await t.call('do', { do: 'key', value: 'ctrl+s', within: win });
      await sleep(1500);
      const dlg = await t.call('windows', { include_dialogs: true }, { why: 'xem có hộp hỏi định dạng không' });
      const keep = dlg.windows.find((w) => w.process?.toLowerCase() === 'excel' && w.window !== win);
      if (keep) {
        t.note(`hộp thoại sau Ctrl+S: ${keep.title}`);
        await t.press({ visible: 'Keep Current Format', within: keep.window, pick: /keep|yes/i });
        await sleep(1000);
      }
      const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)[4] || '';
      t.check('ô D5 trên đĩa = 98765', line.split(',')[3] === '98765', line);
    },
  },
];
