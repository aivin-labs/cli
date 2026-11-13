#!/usr/bin/env node
/**
 * Bộ đo computer use trên máy Windows thật (tầng gui.* — bin/lib/remote/gui). Chạy:
 *   node scripts/gui-bench/run.mjs                 # mọi tác vụ, 1 lượt
 *   node scripts/gui-bench/run.mjs calc ledger -r 3 # tác vụ có id bắt đầu bằng "calc" / "ledger", 3 lượt mỗi tác vụ
 *   node scripts/gui-bench/run.mjs --out report.json --work D:\tmp\bench
 * Mở ứng dụng thật (Máy tính, Notepad, Explorer, Settings, Clock, Paint, Excel) và một ứng dụng mẫu WinForms tự biên dịch; đóng lại sau
 * mỗi tác vụ. Paint cần chuột thật: máy chờ bạn ngừng tay ~2,5 s rồi mượn. Dữ liệu tạo trong thư mục làm việc tạm, xoá khi xong.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { createGuiController } from '../../bin/lib/remote/gui/index.mjs';
import { createWindowsHost } from '../../bin/lib/remote/gui/windowsHost.mjs';
import { createTaskContext, sleep } from './harness.mjs';
import { TASKS } from './tasks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const repeat = Math.max(1, Number(opt('-r', opt('--repeat', 1))) || 1);
const outFile = opt('--out', '');
const work = path.resolve(opt('--work', path.join(os.tmpdir(), `aivin-gui-bench-${Date.now()}`)));
const keepWork = argv.includes('--keep') && (argv.splice(argv.indexOf('--keep'), 1), true);
const filters = argv.filter((a) => !a.startsWith('-'));
const selected = TASKS.filter((t) => !filters.length || filters.some((f) => t.id.startsWith(f)));

if (process.platform !== 'win32') { console.error('gui-bench chỉ chạy trên Windows'); process.exit(2); }
fs.mkdirSync(work, { recursive: true });

function buildFixture() {
  const src = path.join(here, 'fixtures', 'BenchApp.cs');
  const hash = createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const exe = path.join(os.tmpdir(), `AivinBenchApp-${hash}.exe`);
  if (!fs.existsSync(exe)) {
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(csc, ['/nologo', '/target:winexe', `/out:${exe}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', src], { stdio: 'inherit', windowsHide: true });
  }
  return exe;
}

async function startFixture(mode, gui, ctxLog) {
  const exe = buildFixture();
  const state = path.join(work, `fixture-${mode}-${Date.now()}.json`);
  const child = spawn(exe, [state, mode], { detached: false, stdio: 'ignore', windowsHide: false });
  const title = mode === 'drawn' ? 'Aivin Bench - Canvas' : 'Aivin Bench - Phiếu thu';
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (!fs.existsSync(state)) continue;
    const ws = await gui.windows({}, {});
    const w = ws.windows.find((x) => x.title === title);
    if (w) return { child, state, window: w };
  }
  child.kill();
  throw new Error(`Ứng dụng mẫu ${mode} không hiện cửa sổ`);
}

const log = (s) => console.log(s);
const host = createWindowsHost();
const gui = createGuiController({ host, notify: () => {}, say: () => {} });
const env = { roots: [work] };
const results = [];

console.log(`gui-bench: ${selected.length} tác vụ × ${repeat} lượt — thư mục làm việc ${work}`);
await host.call('ping', {}, {});

for (const task of selected) {
  for (let round = 1; round <= repeat; round++) {
    const runWork = path.join(work, `${task.id}-${round}`);
    fs.mkdirSync(runWork, { recursive: true });
    env.roots = [runWork, work];
    const cleanups = [];
    const t = createTaskContext({ gui, host, env, task, log });
    const c = { work: runWork, cleanup: (fn) => cleanups.push(fn) };
    console.log(`\n▶ ${task.id} (${round}/${repeat}) — ${task.title}`);
    const started = Date.now();
    let crash;
    try {
      task.setup?.(runWork);
      if (task.fixture) {
        const fx = await startFixture(task.fixture, gui, log);
        c.fixtureWindow = fx.window.window;
        c.fixtureState = fx.state;
        t.remember(fx.window);
        cleanups.push(() => { try { fx.child.kill(); } catch { /* đã thoát */ } });
        // Ứng dụng mẫu vừa mở chiếm trước mặt: đưa người dùng về cửa sổ của họ trước khi đo (như ứng dụng đã mở sẵn từ trước).
        await host.call('to_back', { window: fx.window.window }, {}).catch(() => undefined);
        await sleep(300);
      }
      await t.begin();
      await task.run(t, c);
    } catch (e) {
      crash = `${e.code || 'ERROR'}: ${String(e.message || e).slice(0, 300)}`;
      console.log(`   💥 ${crash}`);
    }
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* dọn tiếp */ } }
    const s = t.summary();
    s.round = round;
    s.wall_ms = Date.now() - started;
    s.crash = crash;
    s.success = !crash && !s.skipped && s.checks.length > 0 && s.checks.every((x) => x.ok);
    results.push(s);
    console.log(`   ${s.skipped ? 'BỎ QUA' : s.success ? 'ĐẠT' : 'TRƯỢT'} · ${s.turns} lượt · máy ${s.device_ms} ms · ~${s.tokens_est} token · chuột/phím thật ${s.real_input} · giành focus ${s.focus_steals}`);
    await sleep(800);
  }
}

gui.close();

const byTask = new Map();
for (const r of results) { if (!byTask.has(r.id)) byTask.set(r.id, []); byTask.get(r.id).push(r); }
const avg = (a, k) => Math.round(a.reduce((s, x) => s + x[k], 0) / a.length);
console.log('\n══ Tổng hợp ══');
console.log('tác vụ'.padEnd(22), 'đạt'.padEnd(6), 'lượt'.padEnd(5), 'máy ms'.padEnd(8), 'token'.padEnd(7), 'thật'.padEnd(5), 'focus'.padEnd(6), 'lỗi');
for (const [id, rs] of byTask) {
  const pass = rs.filter((r) => r.success).length;
  if (rs.every((r) => r.skipped)) { console.log(id.padEnd(22), 'bỏ qua', rs[0].skipped.slice(0, 90)); continue; }
  const errs = [...new Set(rs.flatMap((r) => r.errors).concat(rs.map((r) => r.crash).filter(Boolean)))].join(' ');
  console.log(id.padEnd(22), `${pass}/${rs.length}`.padEnd(6), String(avg(rs, 'turns')).padEnd(5), String(avg(rs, 'device_ms')).padEnd(8), String(avg(rs, 'tokens_est')).padEnd(7), String(avg(rs, 'real_input')).padEnd(5), String(avg(rs, 'focus_steals')).padEnd(6), errs.slice(0, 80));
}
const counted = results.filter((r) => !r.skipped);
const passed = counted.filter((r) => r.success).length;
console.log(`\nĐạt ${passed}/${counted.length} (${Math.round((passed / Math.max(1, counted.length)) * 100)}%)${results.length > counted.length ? ` · bỏ qua ${results.length - counted.length}` : ''} · trung bình ${avg(results, 'turns')} lượt / tác vụ · ${avg(results, 'device_ms')} ms trên máy`);
if (outFile) fs.writeFileSync(path.resolve(outFile), JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), results }, null, 2));
if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
process.exit(passed === counted.length ? 0 : 1);
