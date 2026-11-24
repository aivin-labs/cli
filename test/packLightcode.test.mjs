import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

const { buildTarInvocation, parseArgs } = await import('../deploy/org-computer/lightcode/pack-lightcode.mjs');
const LIGHTCODE_DIR = path.dirname(fileURLToPath(new URL('../deploy/org-computer/lightcode/pack-lightcode.mjs', import.meta.url)));

test('pack-lightcode: --out mặc định = thư mục lightcode/ (Dockerfile COPY thư mục này), không phải dist/', () => {
  const a = parseArgs(['--src', '/x']);
  assert.equal(a.out, LIGHTCODE_DIR);
  assert.notEqual(path.basename(a.out), 'dist');
  assert.equal(parseArgs(['--src', '/x', '--out', '/tmp/o']).out, '/tmp/o');
  assert.throws(() => parseArgs([]), /--src/);
});

test('pack-lightcode: đối số tar — tên tệp đích tương đối (không có ổ đĩa) để GNU tar không coi là máy từ xa', () => {
  const t = buildTarInvocation({ outDir: 'H:\Project AIVIN\cli\deploy\org-computer\lightcode', tarballName: 'lightcode-server-0.1.0.tar.gz', stageDir: 'C:\Temp\lc-pack-1' });
  const f = t.args[t.args.indexOf('-czf') + 1];
  assert.equal(f, 'lightcode-server-0.1.0.tar.gz');
  assert.ok(!/[:\/]/.test(f), 'tên tệp -f không chứa ":" / dấu gạch');
  assert.deepEqual(t.args.slice(-3), ['-C', 'C:\Temp\lc-pack-1', '.']);
  assert.equal(t.cwd, path.resolve('H:\Project AIVIN\cli\deploy\org-computer\lightcode'), 'chạy trong thư mục đích');
  assert.ok(!t.args.includes('--force-local'), 'bsdtar (tar của Windows) không có --force-local');
});
