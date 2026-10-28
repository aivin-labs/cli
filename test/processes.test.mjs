import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AIVIN_REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-remote-home-'));
const { buildProcessTools, createProcessManager } = await import('../bin/lib/remote/processes.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-root-'));
const script = path.join(root, 'server.js');
fs.writeFileSync(script, "let i = 0; const t = setInterval(() => { console.log('tick ' + (++i)); if (i === 3) console.log('Server ready on 3000'); if (i === 6) { console.error('boom'); clearInterval(t); process.exit(2); } }, 80);");
const env = { roots: [root] };
const run = process.platform === 'win32' ? `node "${script}"` : `node '${script}'`;

test('chạy nền → chờ dòng khớp mẫu → đọc tiếp theo con trỏ → chờ thoát lấy mã thoát + đuôi log', async () => {
  const pm = createProcessManager();
  const tools = Object.fromEntries(buildProcessTools(pm).map((t) => [t.name, t]));
  const started = await tools['proc.start'].handler({ command: run, name: 'dev' }, {}, env);
  assert.equal(started.status, 'running');
  const ready = await tools['proc.wait_for'].handler({ id: started.id, pattern: 'ready|listening', timeoutMs: 20_000 }, {}, env);
  assert.equal(ready.matched, true);
  assert.match(ready.line, /Server ready/);
  const exited = await tools['proc.wait_for'].handler({ id: started.id, since: ready.next_since, timeoutMs: 20_000 }, {}, env);
  assert.equal(exited.reason, 'exited');
  assert.equal(exited.exitCode, 2);
  const tail = await tools['proc.read'].handler({ id: started.id, since: ready.next_since }, {}, env);
  assert.match(tail.output, /\[err\] boom/);
  assert.doesNotMatch(tail.output, /Server ready/);
});

test('hết giờ chờ → matched false + đuôi log; dừng cả cây; lệnh đụng .aivin bị chặn', async () => {
  const pm = createProcessManager();
  const p = await pm.start({ command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30' }, {}, env);
  const res = await pm.waitFor({ id: p.id, pattern: 'never', timeoutMs: 1000 }, {}, env);
  assert.equal(res.reason, 'timeout');
  pm.stop({ id: p.id }, env);
  const done = await pm.waitFor({ id: p.id, timeoutMs: 15_000 }, {}, env);
  assert.equal(done.status, 'exited');
  await assert.rejects(pm.start({ command: 'cat ~/.aivin/device-credentials.json' }, {}, env), (e) => e.code === 'PROTECTED_PATH');
});

test('máy tính tổ chức: thành viên không thấy / đọc / dừng tiến trình của người khác', async () => {
  const pm = createProcessManager();
  const a = { ...env, runAs: { name: 'alice' } };
  const b = { ...env, runAs: { name: 'bob' } };
  const pa = await pm.start({ command: run }, {}, { ...env, runAs: undefined });
  assert.equal(pm.list(a).processes.length, 0);
  assert.throws(() => pm.read({ id: pa.id }, b), /No background process/);
  assert.equal(pm.list(env).processes.length, 1);
  pm.stopAll();
});

test('nhập tương tác: trả lời câu hỏi của tiến trình, chặn chữ chạm .aivin', async () => {
  const pm = createProcessManager();
  const ask = path.join(root, 'ask.js');
  fs.writeFileSync(ask, "process.stdout.write('Continue? [y/N] '); process.stdin.once('data', (d) => { console.log('answer=' + String(d).trim()); process.exit(0); });");
  const p = await pm.start({ command: process.platform === 'win32' ? `node "${ask}"` : `node '${ask}'`, interactive: true }, {}, env);
  await new Promise((r) => setTimeout(r, 600));
  assert.throws(() => pm.write({ id: p.id, text: 'type ~/.aivin/device-credentials.json' }, env), (e) => e.code === 'PROTECTED_PATH');
  const w = pm.write({ id: p.id, text: 'y' }, env);
  const res = await pm.waitFor({ id: p.id, pattern: 'answer=', since: 0, timeoutMs: 15_000 }, {}, env);
  assert.equal(res.matched, true);
  assert.match(res.line, /answer=y/);
  assert.equal(w.written, 1);
});
