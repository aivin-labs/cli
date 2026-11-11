import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { parseContract, parseTestCheck, sha256 } from '../bin/lib/remote/agentContract.mjs';
import {
  diffSince, globToRegExp, mainCheckoutChanged, matchesAny, measureEvidence, parseJUnit, resolveCommit, verifySpawnArgs, worktreeState,
} from '../bin/lib/remote/agentEvidence.mjs';
import { CONTRACT, TEST_CHECK, report } from './agentFixtures.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** Kho thật: một mã nguồn, một tệp test có 2 ca, package.json, và một script viết JUnit theo biến môi trường. */
function makeRepo() {
  const repo = tmp('ev-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'src', 'order.js'), 'export const day = (d) => d;\n');
  write(path.join(repo, 'test', 'order.test.js'), "test('CK-031 order at 23:30 keeps its day', () => {});\ntest('old case', () => {});\n");
  write(path.join(repo, 'package.json'), '{"name":"x"}\n');
  // Ghi junit.xml: CK-031 đạt, một ca hỏng tuỳ theo tệp `fail.flag`.
  write(path.join(repo, 'scripts', 'junit.js'), `const fs = require('fs');
const fail = fs.existsSync('fail.flag');
fs.writeFileSync('junit.xml', '<testsuites><testsuite name="s"><testcase classname="order" name="CK-031 order at 23:30 keeps its day"/>' +
  (fail ? '<testcase name="old case"><failure message="boom">x</failure></testcase>' : '<testcase name="old case"></testcase>') + '</testsuite></testsuites>');
console.log('ran');
process.exit(fail ? 1 : 0);
`);
  write(path.join(repo, '.gitignore'), 'junit.xml\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

function contractFor({ flows = ['checkout'] } = {}) {
  const text = CONTRACT
    .replace('argv: [npm, test]', `argv: ['${process.execPath.replace(/'/g, "''")}', scripts/junit.js]`)
    .replace('test_check: { file_id: "f_1", sha256: "", flows: [checkout] }', `test_check: { file_id: "f_1", flows: [${flows.join(', ')}] }`);
  const parsed = parseContract(text);
  assert.deepEqual(parsed.errors, []);
  return { text, contract: parsed.contract };
}

function jobDirWith(contractText, reportText) {
  const dir = tmp('ev-job-');
  write(path.join(dir, 'CONTRACT.md'), contractText);
  if (reportText) write(path.join(dir, 'REPORT.md'), reportText);
  return dir;
}

test('mẫu đường dẫn kiểu gitignore', () => {
  assert.ok(matchesAny('config/.env.local', ['**/.env*']));
  assert.ok(matchesAny('.env', ['**/.env*']));
  assert.ok(matchesAny('package.json', ['package.json']));
  assert.ok(matchesAny('apps/web/package.json', ['package.json']), 'mẫu không có / khớp ở mọi tầng');
  assert.ok(!matchesAny('apps/web/package.json', ['/package.json']), 'mẫu bắt đầu bằng / chỉ ở gốc');
  assert.ok(matchesAny('src/a/order.test.ts', ['**/*.test.*']));
  assert.ok(matchesAny('.github/workflows/ci.yml', ['.github/**']));
  assert.ok(matchesAny('.github/workflows/ci.yml', ['.github']), 'thư mục khớp mọi thứ bên trong');
  assert.ok(!matchesAny('src/github.js', ['.github/**']));
  assert.ok(matchesAny('src\\keys\\a.pem', ['*.pem']));
  assert.equal(globToRegExp('src/*.js').test('src/a/b.js'), false);
});

test('JUnit: đếm đạt / hỏng / lỗi / bỏ qua, tên ca giải mã thực thể XML', () => {
  const j = parseJUnit(`<testsuite><testcase name="CK-1 a &amp; b"/><testcase name='CK-2'><failure/></testcase>
    <testcase name="x"><error message="e"/></testcase><testcase name="y"><skipped/></testcase><testcase name="z" classname="CK-9"></testcase></testsuite>`);
  assert.deepEqual([j.tests, j.failures, j.errors, j.skipped], [5, 1, 1, 1]);
  assert.equal(j.cases[0].name, 'CK-1 a & b');
  assert.equal(j.cases[4].classname, 'CK-9');
});

test('lệnh verify trên Windows: .cmd đi qua cmd.exe chỉ khi tham số không có ký tự đặc biệt; .exe chạy thẳng', () => {
  const bin = tmp('ev-bin-');
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\n');
  fs.writeFileSync(path.join(bin, 'tool.exe'), '');
  const env = { PATH: bin, PATHEXT: '.EXE;.CMD', ComSpec: 'cmd.exe' };
  const [file, args, opts] = verifySpawnArgs(['npm', 'test', '--', 'a b'], { platform: 'win32', env });
  assert.equal(file, 'cmd.exe');
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(args[3], /npm\.cmd" ?|npm\.cmd test -- "a b"/);
  assert.equal(opts.windowsVerbatimArguments, true);
  assert.throws(() => verifySpawnArgs(['npm', 'test', '&', 'calc'], { platform: 'win32', env }), /cmd\.exe would interpret/);
  assert.throws(() => verifySpawnArgs(['npm', 'run', '%PATH%'], { platform: 'win32', env }), /cmd\.exe would interpret/);
  assert.equal(verifySpawnArgs(['tool', '&'], { platform: 'win32', env })[0], path.join(bin, 'tool.exe'));
  assert.deepEqual(verifySpawnArgs(['npm', 'test'], { platform: 'linux', env }), ['npm', ['test'], {}]);
});

test('diff từ commit gốc: tệp sửa / xoá / mới chưa theo dõi; dòng thêm / bớt chỉ lấy ở tệp test', async () => {
  const repo = makeRepo();
  const base = await resolveCommit(repo, 'HEAD');
  assert.match(base, /^[0-9a-f]{40}$/);
  assert.equal(await resolveCommit(repo, '--output=x'), null);
  write(path.join(repo, 'src', 'order.js'), 'export const day = (d) => d + 1;\n');
  fs.rmSync(path.join(repo, 'package.json'));
  write(path.join(repo, 'test', 'new.test.js'), "test.skip('CK-032 later', () => {});\n");
  git(repo, 'add', 'src/order.js');
  git(repo, 'commit', '-qm', 'agent commit');
  const d = await diffSince(repo, base);
  assert.deepEqual(d.files.map((f) => `${f.status} ${f.path}`).sort(), ['A test/new.test.js', 'D package.json', 'M src/order.js']);
  assert.deepEqual(d.added.map((l) => l.path), ['test/new.test.js'], 'dòng của mã nguồn không cần lấy');
});

test('đo một job: 7 bộ kiểm + tiêu chí + đối chiếu lời tự khai; số đo ghi ra evidence.json', async () => {
  const repo = makeRepo();
  const base = await resolveCommit(repo, 'HEAD');
  const wt = path.join(repo, '.claude', 'worktrees', 'claude-0000aaaa');
  git(repo, 'worktree', 'add', '-q', wt, 'HEAD');
  const mainBefore = await worktreeState(repo);
  // Agent: sửa mã, sửa package.json (được bảo vệ), xoá một ca test cũ, thêm ca .only, để một ca hỏng.
  write(path.join(wt, 'src', 'order.js'), 'export const day = (d) => d + 1;\n');
  write(path.join(wt, 'package.json'), '{"name":"y"}\n');
  write(path.join(wt, 'test', 'order.test.js'), "test('CK-031 order at 23:30 keeps its day', () => {});\n");
  write(path.join(wt, 'test', 'extra.test.js'), "test.only('focus', () => {});\n");
  write(path.join(wt, 'fail.flag'), '1');
  const { text, contract } = contractFor();
  const tc = TEST_CHECK.replace('- trạng thái: pass\n- job: job_id\n- commit: a1b2c3d\n- bằng chứng: evidence_file_id\n', '')
    + '\n#### CK-033 Đơn hoàn tiền\n- nhóm: error\n- ưu tiên: p1\n- cách kiểm: manual\n- tình huống: Hoàn tiền.\n- mong đợi: Hoá đơn âm.\n';
  const jobDir = jobDirWith(text, report({ results: '  CK-031: fail' }));
  const ev = await measureEvidence({
    job: { id: 'claude-0000aaaa', contractSha: sha256(text), worktree: wt, cwd: repo, baseCommit: base, mainStateBefore: mainBefore },
    contract, testCheck: parseTestCheck(tc), jobDir,
  });
  const by = Object.fromEntries(ev.checks.map((c) => [c.check, c]));
  assert.equal(by.command_passed.status, 'fail');
  assert.match(by.command_passed.problems.join(' '), /exit code 1/);
  assert.equal(ev.commands[0].junit.failures, 1);
  assert.equal(by.diff_in_scope.status, 'pass', 'thư mục worktree trong kho không bị tính là sửa bản checkout chính');
  assert.equal(by.protected_untouched.status, 'fail');
  assert.ok(by.protected_untouched.touched.includes('M package.json'));
  assert.ok(!by.protected_untouched.touched.some((t) => t.includes('extra.test.js')), 'thêm test mới thì được');
  assert.equal(by.tests_not_reduced.status, 'pass', '1 ca bớt, 1 ca thêm');
  assert.equal(by.no_new_skips.status, 'fail');
  assert.match(by.no_new_skips.lines[0], /test\.only/);
  assert.equal(by.check_file_covered.status, 'fail');
  assert.match(by.check_file_covered.problems.join(' '), /CK-033 \(manual\) has no result in REPORT\.md/);
  assert.deepEqual(by.check_file_covered.mismatches, ['CK-031: reported fail, measured pass']);
  assert.equal(by.outputs_complete.status, 'pass');
  assert.deepEqual(ev.acceptance.map((a) => [a.key, a.status]), [['tests_pass', 'fail'], ['diff_in_scope', 'pass'], ['correct_timezone', 'needs_verifier']]);
  assert.equal(ev.report.valid, true);
  assert.equal(ev.mode, 'shadow');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobDir, 'evidence.json'), 'utf8')).checks, ev.checks);
  assert.ok(fs.readFileSync(path.join(jobDir, 'logs', 'test.log'), 'utf8').includes('ran'));

  // Agent sửa thẳng vào bản checkout chính → diff_in_scope trượt.
  write(path.join(repo, 'src', 'order.js'), 'export const day = () => 0;\n');
  const ev2 = await measureEvidence({
    job: { id: 'claude-0000aaaa', contractSha: sha256(text), worktree: wt, cwd: repo, baseCommit: base, mainStateBefore: mainBefore },
    contract, testCheck: parseTestCheck(tc), jobDir,
  });
  assert.match(ev2.checks.find((c) => c.check === 'diff_in_scope').reason, /main checkout changed/);
});

test('đo: hợp đồng bị sửa trong lúc chạy → dừng, không chạy lệnh nào; thiếu REPORT.md → đầu ra chưa đủ; xoá ca test → trượt', async () => {
  const repo = makeRepo();
  const base = await resolveCommit(repo, 'HEAD');
  const { text, contract } = contractFor();
  const tampered = jobDirWith(`${text}\n- thêm tiêu chí`, null);
  let ran = 0;
  const ev = await measureEvidence({
    job: { id: 'j', contractSha: sha256(text), cwd: repo, baseCommit: base }, contract, testCheck: null, jobDir: tampered, runCommand: async () => { ran++; return {}; },
  });
  assert.equal(ev.contract_tampered, true);
  assert.equal(ran, 0);

  fs.rmSync(path.join(repo, 'test', 'order.test.js'));
  const jobDir = jobDirWith(text, null);
  const ev2 = await measureEvidence({ job: { id: 'j', contractSha: sha256(text), cwd: repo, baseCommit: base }, contract, testCheck: parseTestCheck(TEST_CHECK), jobDir });
  const by = Object.fromEntries(ev2.checks.map((c) => [c.check, c]));
  assert.equal(by.tests_not_reduced.status, 'fail');
  assert.deepEqual(by.tests_not_reduced.deleted_test_files, ['test/order.test.js']);
  assert.equal(by.outputs_complete.status, 'fail');
  assert.match(by.outputs_complete.missing.join(' '), /REPORT\.md is missing/);
  assert.equal(ev2.report.present, false);
});

test('so bản checkout chính: bỏ qua thư mục worktree của job, bắt mọi thay đổi khác', () => {
  const before = ['?? notes.txt'];
  assert.equal(mainCheckoutChanged(before, ['?? .claude/', '?? notes.txt'], { cwd: '/r', worktree: '/r/.claude/worktrees/j' }), false);
  assert.equal(mainCheckoutChanged(before, ['?? .claude/worktrees/j/', '?? notes.txt'], { cwd: '/r', worktree: '/r/.claude/worktrees/j' }), false);
  assert.equal(mainCheckoutChanged(before, [' M src/a.js', '?? notes.txt'], { cwd: '/r', worktree: '/r/.claude/worktrees/j' }), true);
  assert.equal(mainCheckoutChanged(null, [' M x'], { cwd: '/r' }), false, 'không chụp được trước đó → không kết luận');
});
