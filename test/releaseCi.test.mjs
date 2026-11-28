import test from 'node:test';
import assert from 'node:assert/strict';
import { NPM_JOB, ciJobState, rerunCiJob, runTool, summarizeFailedLog, waitForCiBuild, waitForCiJob, waitForNpmTrustedPublisher } from '../scripts/release-ci.mjs';

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

/** gh giả cho job CI: `runs` = kết quả `run list` lần lượt, `jobs` = danh sách job lần lượt (Error = gh lỗi). */
function jobHarness({ runs = [{ databaseId: 9, status: 'completed' }], jobs = [] } = {}) {
  let t = 0;
  const runQueue = [...runs];
  const jobQueue = [...jobs];
  const pick = (q) => (q.length > 1 ? q.shift() : q[0]);
  return {
    repo: 'o/r',
    now: () => t,
    sleep: async (ms) => { t += ms; },
    log: () => {},
    gh: (...args) => {
      if (args[1] === 'list') {
        const run = pick(runQueue);
        if (run instanceof Error) throw run;
        return JSON.stringify(run ? [run] : []);
      }
      const list = pick(jobQueue);
      if (list instanceof Error) throw list;
      return JSON.stringify({ jobs: list || [] });
    },
  };
}
const npmJob = (status, conclusion = '') => [{ name: 'release', status: 'completed', conclusion: 'success' }, { name: NPM_JOB, status, conclusion }];

test('job npm CI: xanh / đỏ / bị bỏ qua / đang chạy / chưa có lần chạy / workflow cũ không có job', () => {
  assert.equal(ciJobState('v1', NPM_JOB, jobHarness({ jobs: [npmJob('completed', 'success')] })), 'success');
  assert.equal(ciJobState('v1', NPM_JOB, jobHarness({ jobs: [npmJob('completed', 'failure')] })), 'failed');
  assert.equal(ciJobState('v1', NPM_JOB, jobHarness({ jobs: [npmJob('completed', 'skipped')] })), 'failed');
  assert.equal(ciJobState('v1', NPM_JOB, jobHarness({ jobs: [npmJob('in_progress')] })), 'pending');
  assert.equal(ciJobState('v1', NPM_JOB, jobHarness({ runs: [null] })), 'missing');
  assert.equal(ciJobState('v1', NPM_JOB, jobHarness({ jobs: [[{ name: 'release', status: 'completed', conclusion: 'success' }]] })), 'missing');
  assert.equal(ciJobState('v1', NPM_JOB, jobHarness({ runs: [{ databaseId: 9, status: 'in_progress' }], jobs: [[]] })), 'pending');
});

test('chờ job npm CI: đang chạy rồi xanh; quá hạn thì pending; gh lỗi liên tục thì unknown', async () => {
  assert.equal(await waitForCiJob('v1', NPM_JOB, jobHarness({ jobs: [npmJob('queued'), npmJob('in_progress'), npmJob('completed', 'success')] })), 'success');
  assert.equal(await waitForCiJob('v1', NPM_JOB, { ...jobHarness({ jobs: [npmJob('in_progress')] }), timeoutMs: 60_000 }), 'pending');
  assert.equal(await waitForCiJob('v1', NPM_JOB, jobHarness({ runs: [new Error('gh: not logged in')] })), 'unknown');
});

/** CI giả cho chạy lại job: `views` = danh sách job npm-publish trả lần lượt cho mỗi `gh run view` (phần tử cuối lặp lại). */
function rerunHarness(views) {
  let t = 0;
  const reruns = [];
  const queue = [...views];
  return {
    reruns,
    repo: 'o/r',
    now: () => t,
    sleep: async (ms) => { t += ms; },
    log: () => {},
    gh: (...args) => {
      if (args[1] === 'list') return JSON.stringify([{ databaseId: 7, status: 'completed' }]);
      if (args[1] === 'rerun') { reruns.push(args); return ''; }
      const j = queue.length > 1 ? queue.shift() : queue[0];
      return JSON.stringify({ jobs: [{ name: 'release', status: 'completed', conclusion: 'success', databaseId: 1 }, { name: NPM_JOB, ...j }] });
    },
  };
}

test('chạy lại job CI: bỏ qua kết quả cũ còn đọng, chờ lần chạy mới xong', async () => {
  const h = rerunHarness([
    { databaseId: 10, status: 'completed', conclusion: 'failure' }, // trước khi rerun
    { databaseId: 10, status: 'completed', conclusion: 'failure' }, // gh còn trả job cũ
    { databaseId: 11, status: 'queued', conclusion: '' },
    { databaseId: 11, status: 'completed', conclusion: 'success' },
  ]);
  assert.equal(await rerunCiJob('v1', NPM_JOB, h), 'success');
  assert.deepEqual(h.reruns, [['run', 'rerun', '7', '--repo', 'o/r', '--job', '10']]);
});

test('chạy lại job CI: job mới không xuất hiện thì coi như đỏ', async () => {
  const h = rerunHarness([{ databaseId: 10, status: 'completed', conclusion: 'failure' }]);
  assert.equal(await rerunCiJob('v1', NPM_JOB, { ...h, settleMs: 30_000 }), 'failed');
});

test('chờ khai Trusted publisher: mở trình duyệt 1 lần, chạy lại job tới khi xanh', async () => {
  const opened = [];
  let n = 0;
  const h = rerunHarness([{ databaseId: 10, status: 'completed', conclusion: 'failure' }]);
  const gh = (...args) => {
    if (args[1] === 'rerun') n++;
    if (args[1] === 'view' && n >= 2) return JSON.stringify({ jobs: [{ name: NPM_JOB, databaseId: 10 + n, status: 'completed', conclusion: 'success' }] });
    if (args[1] === 'view' && n === 1) return JSON.stringify({ jobs: [{ name: NPM_JOB, databaseId: 20, status: 'completed', conclusion: 'failure' }] });
    return h.gh(...args);
  };
  const state = await waitForNpmTrustedPublisher('v1', NPM_JOB, { ...h, gh, openUrl: (u) => opened.push(u), settingsUrl: 'https://npm/x' });
  assert.equal(state, 'success');
  assert.deepEqual(opened, ['https://npm/x']);
  assert.equal(n, 2);
});

test('chờ khai Trusted publisher: hết hạn thì trả trạng thái đỏ, không treo', async () => {
  const h = rerunHarness([{ databaseId: 10, status: 'completed', conclusion: 'failure' }]);
  const state = await waitForNpmTrustedPublisher('v1', NPM_JOB, { ...h, openUrl: () => {}, settingsUrl: 'u', waitMs: 5 * 60_000, rerunOpts: { settleMs: 10_000 } });
  assert.equal(state, 'failed');
});
