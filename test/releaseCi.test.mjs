import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, summarizeFailedLog, waitForCiBuild } from '../scripts/release-ci.mjs';

const logLine = (text) => `test (ubuntu-latest)\tRun npm test\t2026-11-05T05:23:09.5843649Z ${text}`;

const TAP_LOG = [
  logLine('ok 190 - qua'),
  logLine('not ok 191 - "Gửi cho AIVIN Bot": thứ tự'),
  logLine('  ---'),
  logLine('  duration_ms: 3.012587'),
  logLine("  type: 'test'"),
  logLine("  location: '/home/runner/work/cli/cli/test/mascot.test.mjs:135:1'"),
  logLine("  failureType: 'testCodeFailure'"),
  logLine('  error: |-'),
  logLine('    Expected values to be strictly deep-equal:'),
  logLine("    -   '/x/a.docx',"),
  logLine("  code: 'ERR_ASSERTION'"),
  logLine('  stack: |-'),
  logLine('    TestContext.<anonymous> (file:///x.mjs:143:10)'),
  logLine('  ...'),
  logLine('ok 192 - qua tiếp'),
  logLine('# fail 1'),
].join('\n');

/** Kịch bản: mỗi lần hỏi `run list` lấy phần tử kế tiếp (Error = gh lỗi); thời gian chạy theo `sleep`. */
function harness(script, { failedLog = TAP_LOG } = {}) {
  let t = 0;
  const logs = [];
  const calls = [];
  const queue = [...script];
  return {
    logs,
    calls,
    opts: {
      repo: 'o/r',
      now: () => t,
      sleep: async (ms) => { t += ms; },
      log: (m) => logs.push(m),
      gh: (...args) => {
        calls.push(args);
        if (args[0] === 'run' && args[1] === 'view') {
          if (failedLog instanceof Error) throw failedLog;
          return failedLog;
        }
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return JSON.stringify(next ? [next] : []);
      },
    },
  };
}

const RUNNING = { databaseId: 7, status: 'in_progress', conclusion: '', url: 'http://run' };
const GREEN = { databaseId: 7, status: 'completed', conclusion: 'success', url: 'http://run' };
const RED = { databaseId: 7, status: 'completed', conclusion: 'failure', url: 'http://run' };

test('tóm tắt log TAP: nêu tên test, job, nơi hỏng, lỗi; bỏ số đo và stack', () => {
  const out = summarizeFailedLog(TAP_LOG);
  assert.match(out, /✖ "Gửi cho AIVIN Bot": thứ tự \[test \(ubuntu-latest\)\]/);
  assert.match(out, /mascot\.test\.mjs:135:1/);
  assert.match(out, /Expected values to be strictly deep-equal/);
  assert.match(out, /a\.docx/);
  assert.doesNotMatch(out, /duration_ms|failureType|TestContext|ERR_ASSERTION|ok 192/);
});

test('tóm tắt log: quá nhiều test hỏng thì cắt và nói còn bao nhiêu; dạng spec và lỗi build vẫn có nội dung', () => {
  const many = Array.from({ length: 7 }, (_, i) => logLine(`not ok ${i} - t${i}`)).join('\n');
  const out = summarizeFailedLog(many);
  assert.match(out, /t4/);
  assert.doesNotMatch(out, /t5/);
  assert.match(out, /và 2 test hỏng nữa/);
  assert.match(summarizeFailedLog(`${logLine('\u001b[31m✖ failing tests:\u001b[0m')}\n${logLine('✖ test A')}`), /^ {2}✖ failing tests:\n {2}✖ test A$/);
  const build = summarizeFailedLog(Array.from({ length: 50 }, (_, i) => logLine(`dòng ${i}`)).join('\n'));
  assert.match(build, /dòng 49/);
  assert.doesNotMatch(build, /dòng 19\b/);
  assert.equal(build.split('\n').length, 30);
});

test('chờ CI: báo trạng thái đều đặn thay vì im lặng, xanh thì xong', async () => {
  const h = harness([...Array(8).fill(RUNNING), GREEN]);
  await waitForCiBuild('v1', { ...h.opts, pollMs: 15_000, reportEveryMs: 30_000 });
  const reports = h.logs.filter((l) => l.includes('in_progress'));
  assert.ok(reports.length >= 3 && reports.length <= 5, `số dòng báo: ${reports.length}`);
  assert.match(reports[1], /\(30s\)|\(45s\)/);
  assert.match(h.logs.at(-1), /CI v1: xong sau 2m00s/);
});

test('chờ CI: đỏ thì lỗi kèm tên test hỏng và link', async () => {
  const h = harness([RED]);
  await assert.rejects(waitForCiBuild('v1', h.opts), (e) => {
    assert.match(e.message, /CI cua v1 that bai \(failure\)/);
    assert.match(e.message, /Gửi cho AIVIN Bot/);
    assert.match(e.message, /http:\/\/run/);
    return true;
  });
  assert.deepEqual(h.calls.at(-1), ['run', 'view', '7', '--repo', 'o/r', '--log-failed']);
});

test('chờ CI: không lấy được log thì vẫn báo đỏ, nêu lý do và link', async () => {
  const h = harness([RED], { failedLog: new Error('HTTP 403') });
  await assert.rejects(waitForCiBuild('v1', h.opts), /that bai[\s\S]*khong lay duoc log: HTTP 403[\s\S]*http:\/\/run/);
});

test('chờ CI: gh lỗi liên tục thì dừng sớm với lý do thật, không chờ đủ 20 phút', async () => {
  const h = harness([new Error('gh run: HTTP 401 Bad credentials')]);
  await assert.rejects(waitForCiBuild('v1', { ...h.opts, maxGhFailures: 3 }), /sau 3 lan: gh run: HTTP 401 Bad credentials[\s\S]*gh auth status/);
  assert.equal(h.calls.length, 3);
  assert.ok(h.logs.some((l) => l.includes('lan 1/3') && l.includes('Bad credentials')), 'lỗi phải hiện ngay, không chờ tới lúc dừng');
});

test('chờ CI: mạng chập chờn vài nhịp rồi hồi thì đếm lại từ đầu', async () => {
  const fail = new Error('timeout');
  const h = harness([fail, fail, RUNNING, fail, fail, GREEN]);
  await waitForCiBuild('v1', { ...h.opts, maxGhFailures: 3 });
  assert.match(h.logs.at(-1), /xong/);
});

test('chờ CI: chưa thấy lần chạy nào thì nói rõ; quá hạn thì báo lỗi', async () => {
  const h = harness([null]);
  await assert.rejects(waitForCiBuild('v1', { ...h.opts, timeoutMs: 60_000 }), /Qua 1 phut CI chua xong v1/);
  assert.ok(h.logs.some((l) => l.includes('chua thay lan chay nao')));
});

test('runTool: lỗi lấy từ stderr của lệnh, không có stderr thì dùng thông báo gốc', () => {
  const fail = (stderr, message = 'Command failed') => () => { throw Object.assign(new Error(message), { stderr }); };
  assert.throws(() => runTool('git', ['push'], { exec: fail('fatal: rejected\n') }), /^Error: git push: fatal: rejected$/);
  assert.throws(() => runTool('gh', ['run'], { exec: fail('', 'spawn gh ENOENT') }), /gh run: spawn gh ENOENT/);
  assert.equal(runTool('git', ['x'], { exec: () => ' ok\n' }), 'ok');
});
