import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createIdempotentRunner } = await import('../bin/lib/remote/idempotency.mjs');

test('bước có tác dụng gửi lại cùng idem_key → chạy một lần, lần sau trả kết quả cũ (kể cả đang chạy dở)', async () => {
  let runs = 0;
  const run = async (call) => { runs++; await new Promise((r) => setTimeout(r, 30)); return { tool: {}, outcome: { ok: true, result: { wrote: call.args.path } } } };
  const dupes = [];
  const once = createIdempotentRunner(run, (name) => name === 'fs.read', { onDuplicate: (c) => dupes.push(c.call_id) });
  const call = (id) => ({ call_id: id, tool: 'fs.write', idem_key: 'k1', args: { path: 'a.txt' } });
  const [a, b] = await Promise.all([once(call('c1')), once(call('c2'))]);
  const c = await once(call('c3'));
  assert.equal(runs, 1);
  assert.equal(a.outcome.result.deduplicated, undefined);
  assert.equal(b.outcome.result.deduplicated, true);
  assert.equal(c.outcome.result.deduplicated, true);
  assert.deepEqual(dupes, ['c2', 'c3']);
});

test('bước hỏng → quên khoá (lần sau chạy lại); bước chỉ đọc / không khoá → luôn chạy', async () => {
  let runs = 0;
  let fail = true;
  const run = async () => { runs++; return { tool: {}, outcome: fail ? { ok: false, error: 'x' } : { ok: true, result: {} } }; };
  const once = createIdempotentRunner(run, (name) => name === 'fs.read');
  await once({ call_id: '1', tool: 'shell.exec', idem_key: 'k' });
  fail = false;
  await once({ call_id: '2', tool: 'shell.exec', idem_key: 'k' });
  assert.equal(runs, 2);
  await once({ call_id: '3', tool: 'fs.read', idem_key: 'r' });
  await once({ call_id: '4', tool: 'fs.read', idem_key: 'r' });
  await once({ call_id: '5', tool: 'shell.exec' });
  assert.equal(runs, 5);
});
