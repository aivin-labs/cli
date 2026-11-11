import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { CheckKind, parseReport, sha256 } from './agentContract.mjs';
import { safeGitArgv, safeGitEnv } from './gitSafe.mjs';
import { agentEnv, scrubEnv } from './sandbox.mjs';
import { killWindowsTree } from './winTree.mjs';

/**
 * Daemon tự đo kết quả của một job có hợp đồng (11/11/2026) — không LLM, không tin lời tự khai trong `REPORT.md`. Sau khi agent xong:
 * chạy lại từng lệnh `verify` của hợp đồng trong worktree, đọc JUnit, đo diff so với commit gốc, rồi chấm 7 bộ kiểm và ghi `evidence.json`.
 * Daemon chỉ ĐO; kết luận đạt / trượt là việc của Agentic (chế độ shadow trước, enforce sau).
 *
 * Lệnh `verify` chạy theo argv, KHÔNG qua shell (không dính trích dẫn, không nối lệnh). Windows: `.cmd` / `.bat` (npm, yarn…) bắt buộc đi qua
 * cmd.exe — chỉ nhận khi không tham số nào có ký tự đặc biệt của cmd. Lệnh verify vẫn chạy mã của repo (test là mã) — đó là chủ ý của
 * hợp đồng; vì vậy `filter.<x>.clean` của repo khi git đọc cây làm việc không mở thêm đường chạy mã nào so với chính lệnh test.
 */

export const EVIDENCE_FILE = 'evidence.json';
const MAX_LOG_BYTES = 20 * 1024 ** 2;
const LOG_TAIL_CHARS = 4000;
const MAX_DIFF_BYTES = 16 * 1024 ** 2;
const MAX_UNTRACKED_READ = 1024 ** 2;
const MAX_LISTED = 200;
const GIT_TIMEOUT_MS = 120_000;
const CMD_META_RE = /[&|<>^%!"\r\n()]/;

/** Tệp test theo quy ước phổ biến (JS/TS, Python, Go, Java, Rust…). */
const TEST_FILE_RE = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(java|kt|cs)$/i;
/** Một dòng khai báo ca test. */
const TEST_DECL_RE = /^\s*(it|test)(\.\w+)*\s*\(|^\s*(async\s+)?def\s+test_\w*|@(Test|ParameterizedTest)\b|^\s*func\s+Test[A-Z_]\w*\s*\(|#\[test\]|\[(Fact|Theory|Test)\]/;
/** Một dòng tắt / bỏ qua / chỉ chạy riêng ca test. */
const SKIP_RE = /\b(it|test|describe|context)\.(skip|only|todo)\b|\bx(it|test|describe)\s*\(|\bf(it|describe)\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.skip|@(Ignore|Disabled)\b|\bt\.Skip(Now|f)?\s*\(|#\[ignore\]|\[(Fact|Theory)\s*\(\s*Skip\s*=/;

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Mẫu đường dẫn kiểu gitignore → RegExp. `*` không qua `/`, `**` qua mọi tầng, mẫu không có `/` khớp tên tệp ở mọi tầng (`package.json`,
 * `*.pem`), mẫu là thư mục khớp mọi thứ bên trong (`.github`, `.github/**`).
 */
export function globToRegExp(pattern) {
  let p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  const anchored = p.startsWith('/') || p.replace(/\/+$/, '').includes('/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      const slashAfter = p[i + 2] === '/';
      re += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`, caseInsensitive ? 'i' : '');
}

export const matchesAny = (rel, patterns) => patterns.some((p) => globToRegExp(p).test(String(rel).replace(/\\/g, '/')));

const xmlText = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attrOf = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag); return m ? xmlText(m[2] ?? m[3]) : undefined; };

/** JUnit XML (jest-junit, pytest --junitxml, surefire, go-junit-report…) → tổng + từng ca `{ name, classname, status }`. */
export function parseJUnit(xml) {
  const cases = [];
  const src = String(xml);
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(src))) {
    const inner = m[3] || '';
    const status = /<(failure|error)\b/.test(inner) ? (/<error\b/.test(inner) ? 'error' : 'fail') : /<skipped\b/.test(inner) ? 'skipped' : 'pass';
    cases.push({ name: attrOf(m[1], 'name') || '', classname: attrOf(m[1], 'classname') || '', status });
  }
  const count = (s) => cases.filter((c) => c.status === s).length;
  return { tests: cases.length, failures: count('fail'), errors: count('error'), skipped: count('skipped'), cases };
}

/** Windows: tìm tệp chạy theo PATH + PATHEXT (spawn không shell không tự thêm `.cmd`). */
function resolveWindowsCommand(cmd, env) {
  if (/[\\/]/.test(cmd) || path.extname(cmd)) return cmd;
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext.toLowerCase());
      if (fs.existsSync(full)) return full;
    }
  }
  return cmd;
}

/** argv của hợp đồng → [tệp chạy, tham số, tuỳ chọn spawn]. Ném lỗi khi không chạy an toàn được. */
export function verifySpawnArgs(argv, { platform = process.platform, env = process.env } = {}) {
  const [cmd, ...rest] = argv;
  if (platform !== 'win32') return [cmd, rest, {}];
  const exe = resolveWindowsCommand(cmd, env);
  if (!/\.(cmd|bat)$/i.test(exe)) return [exe, rest, {}];
  const bad = argv.find((a) => CMD_META_RE.test(a));
  if (bad !== undefined) throw new Error(`"${bad}" has a character cmd.exe would interpret — a .cmd command cannot take it safely`);
  const quoted = [exe, ...rest].map((a) => (/[\s]/.test(a) || !a ? `"${a}"` : a)).join(' ');
  return [env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], { windowsVerbatimArguments: true }];
}

/** Chạy một lệnh `verify`: log đầy đủ ra tệp (có trần), hết giờ → giết cả cây. Không ném lỗi. */
export function runVerifyCommand(cmd, { cwd, logFile, signal, spawnImpl = spawn, env: baseEnv = process.env } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const env = { ...agentEnv(baseEnv), CI: 'true' };
    let spawnArgs;
    try { spawnArgs = verifySpawnArgs(cmd.argv, { env }); } catch (e) { resolve({ exit_code: null, error: e.message, duration_ms: 0 }); return; }
    const [file, args, extra] = spawnArgs;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.createWriteStream(logFile);
    let written = 0;
    let tail = '';
    let timedOut = false;
    let settled = false;
    const decoder = new StringDecoder('utf8');
    let child;
    try {
      child = spawnImpl(file, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
    } catch (e) {
      log.end();
      resolve({ exit_code: null, error: `Cannot start: ${e.message}`, duration_ms: 0 });
      return;
    }
    const kill = () => {
      if (process.platform === 'win32') killWindowsTree(child, startedAt);
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* đã thoát */ } } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, cmd.timeout_ms);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const onData = (chunk) => {
      if (written < MAX_LOG_BYTES) { log.write(chunk); written += chunk.length; }
      tail = (tail + decoder.write(chunk)).slice(-LOG_TAIL_CHARS);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const done = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      log.end();
      resolve({
        exit_code: code, timed_out: timedOut || undefined, cancelled: signal?.aborted || undefined, error,
        duration_ms: Date.now() - startedAt, log_tail: tail.trim() || undefined, log_truncated: written >= MAX_LOG_BYTES || undefined,
      });
    };
    child.on('error', (e) => done(null, `Cannot start: ${e.message}`));
    child.on('close', (code) => done(code));
  });
}

/** `git` chỉ đọc, đã khoá cấu hình của kho (gitSafe). Trả stdout (Buffer), hoặc ném lỗi có stderr. */
export function gitRead(cwd, sub, { maxBytes = MAX_DIFF_BYTES, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('git', safeGitArgv(cwd, sub), { cwd, env: safeGitEnv(scrubEnv()), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on('data', (c) => { size += c.length; if (size <= maxBytes) out.push(c); else child.kill(); });
    child.stderr.on('data', (c) => { err = (err + c).slice(-1000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (size > maxBytes) reject(new Error(`git ${sub[0]} output is larger than ${maxBytes} bytes`));
      else if (code !== 0) reject(new Error(`git ${sub[0]} failed: ${err.trim() || `exit ${code}`}`));
      else resolve(Buffer.concat(out));
    });
  });
}

/** Commit của một ref (đã kiểm là commit), hoặc null. */
export async function resolveCommit(cwd, ref = 'HEAD', opts) {
  if (!ref || String(ref).startsWith('-')) return null;
  try { return (await gitRead(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], opts)).toString().trim() || null; } catch { return null; }
}

const MAX_STATE_ENTRIES = 20_000;
/**
 * Trạng thái thô của cây làm việc — từng mục `git status` (để biết agent có sửa thẳng vào bản checkout chính thay vì worktree). Kho quá
 * bẩn (> 20.000 mục) hoặc không phải kho → null (bỏ qua phép so).
 */
export async function worktreeState(cwd, opts) {
  try {
    const entries = (await gitRead(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], opts)).toString('utf8').split('\0').filter(Boolean);
    return entries.length > MAX_STATE_ENTRIES ? null : entries.sort();
  } catch { return null; }
}

/** Bản checkout chính có đổi giữa hai lần chụp không — bỏ qua thư mục của worktree job (nằm trong kho thì hiện ra là thư mục chưa theo dõi). */
export function mainCheckoutChanged(before, after, { cwd, worktree }) {
  if (!before || !after) return false;
  const rel = worktree ? path.relative(cwd, worktree).replace(/\\/g, '/') : '';
  const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const keep = (e) => {
    if (!inside) return true;
    const p = e.slice(3).replace(/\/+$/, '');
    return !(p === rel || p.startsWith(`${rel}/`) || rel.startsWith(`${p}/`));
  };
  const a = before.filter(keep);
  const b = after.filter(keep);
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

/** Đường dẫn của mọi worktree thuộc kho chứa `cwd`. */
export async function listWorktrees(cwd, opts) {
  try {
    return (await gitRead(cwd, ['worktree', 'list', '--porcelain'], opts)).toString('utf8').split('\n')
      .filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9).trim()));
  } catch { return []; }
}

/**
 * Diff giữa commit gốc và cây làm việc hiện tại (gồm cả commit mới và phần chưa commit) + tệp mới chưa theo dõi. Trả
 * `{ files: [{ path, status }], added: [{ path, text }], removed: [{ path, text }] }` — dòng thêm / bớt chỉ lấy ở tệp test (đủ cho các bộ kiểm).
 */
export async function diffSince(cwd, base, opts) {
  const nameStatus = (await gitRead(cwd, ['diff', '--name-status', '--no-renames', '-z', base, '--'], opts)).toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < nameStatus.length; i += 2) files.push({ path: nameStatus[i + 1], status: nameStatus[i][0] });
  const untracked = (await gitRead(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], opts)).toString('utf8').split('\0').filter(Boolean);
  for (const p of untracked) files.push({ path: p, status: 'A' });

  const added = [];
  const removed = [];
  const testFiles = files.filter((f) => TEST_FILE_RE.test(f.path));
  const tracked = testFiles.filter((f) => !untracked.includes(f.path)).map((f) => f.path);
  if (tracked.length) {
    const patch = (await gitRead(cwd, ['diff', '-U0', '--no-renames', '--no-color', base, '--', ...tracked], opts)).toString('utf8');
    // Tiêu đề của mỗi tệp nằm giữa `diff --git` và `@@` đầu tiên — dòng nội dung bắt đầu bằng `+++` / `---` không bị đọc nhầm là tiêu đề.
    let file = null;
    let header = false;
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) { header = true; file = null; continue; }
      if (header) {
        if (line.startsWith('@@')) header = false;
        else if (line.startsWith('--- a/')) file = line.slice(6);
        else if (line.startsWith('+++ b/')) file = line.slice(6);
        continue;
      }
      if (!file) continue;
      if (line.startsWith('+')) added.push({ path: file, text: line.slice(1) });
      else if (line.startsWith('-')) removed.push({ path: file, text: line.slice(1) });
    }
  }
  for (const f of testFiles.filter((x) => untracked.includes(x.path))) {
    try {
      const abs = path.join(cwd, f.path);
      if (fs.statSync(abs).size > MAX_UNTRACKED_READ) continue;
      for (const text of fs.readFileSync(abs, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/)) added.push({ path: f.path, text });
    } catch { /* tệp vừa bị xoá */ }
  }
  return { files, added, removed };
}

const listed = (items) => (items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `… ${items.length - MAX_LISTED} more`] : items);
const check = (kind, status, detail = {}) => ({ check: kind, status, ...detail });
const mentions = (c, id) => new RegExp(`(^|[^A-Za-z0-9])${id}($|[^0-9])`).test(`${c.classname} ${c.name}`);

/** Một bộ kiểm cho `check_file_covered`: mọi ca của các luồng trong hợp đồng có kết quả; ca `auto` phải chạy thật trong JUnit. */
function coverage({ contract, testCheck, report, junitCases }) {
  const flows = contract.test_check?.flows || [];
  if (!contract.test_check) return { result: check(CheckKind.CHECK_FILE_COVERED, 'not_applicable', { reason: 'contract has no test_check' }), tests: [] };
  if (!testCheck) return { result: check(CheckKind.CHECK_FILE_COVERED, 'fail', { reason: 'TEST_CHECK.md was not delivered with the job' }), tests: [] };
  const problems = [];
  if (!testCheck.ok) problems.push(...testCheck.errors.map((e) => `TEST_CHECK.md ${e}`));
  const tests = [];
  for (const flowId of flows) {
    const flow = testCheck.flows.find((f) => f.id === flowId);
    if (!flow) { problems.push(`flow ${flowId} is not in TEST_CHECK.md`); continue; }
    for (const rule of flow.rules) {
      if (!rule.cases.length) problems.push(`${rule.id} has no check`);
      for (const c of rule.cases) {
        const claimed = report?.report?.results?.[c.id];
        const entry = { check_id: c.id, flow_id: flowId, rule_id: rule.id, method: c.method, reported: claimed };
        if (c.method === 'auto') {
          const runs = junitCases.filter((j) => mentions(j, c.id));
          entry.measured = !runs.length ? 'missing' : runs.some((j) => j.status === 'fail' || j.status === 'error') ? 'fail' : runs.every((j) => j.status === 'skipped') ? 'skipped' : 'pass';
          if (entry.measured === 'missing') problems.push(`${c.id} (auto) did not run — no test name contains it`);
          if (claimed && entry.measured !== 'missing' && claimed !== entry.measured) entry.mismatch = true;
        } else {
          entry.measured = 'not_measured';
          if (!claimed) problems.push(`${c.id} (${c.method}) has no result in REPORT.md`);
        }
        tests.push(entry);
      }
    }
  }
  const mismatches = tests.filter((t) => t.mismatch).map((t) => `${t.check_id}: reported ${t.reported}, measured ${t.measured}`);
  return { result: check(CheckKind.CHECK_FILE_COVERED, problems.length ? 'fail' : 'pass', { problems: listed(problems), ...(mismatches.length ? { mismatches: listed(mismatches) } : {}) }), tests };
}

/**
 * Đo một job có hợp đồng; ghi `<jobDir>/evidence.json` và trả object bằng chứng. Không ném lỗi (lỗi đo → bộ kiểm `error`).
 * `job`: { id, contractSha, worktree, cwd, baseCommit, mainStateBefore }; `contract`: kết quả parseContract().contract;
 * `testCheck`: parseTestCheck() hoặc null; đọc `REPORT.md` + `CONTRACT.md` ngay trong `jobDir`.
 */
export async function measureEvidence({ job, contract, testCheck, jobDir, signal, gitOpts, runCommand = runVerifyCommand }) {
  const evidence = {
    job_id: job.id, contract_id: contract.contract_id, contract_version: contract.version, contract_sha256: job.contractSha,
    feature_group: contract.feature_group, mode: 'shadow', measured_at: new Date().toISOString(),
    base_commit: job.baseCommit || null, head_commit: null, worktree: job.worktree || null,
    commands: [], diff: null, checks: [], acceptance: [], tests: [], report: null,
  };
  const write = () => {
    try { fs.writeFileSync(path.join(jobDir, EVIDENCE_FILE), JSON.stringify(evidence, null, 1)); } catch { /* vẫn trả về qua agent.status */ }
    return evidence;
  };

  // Hợp đồng bị sửa trong lúc chạy → dừng, không đo gì nữa.
  let contractNow = '';
  try { contractNow = fs.readFileSync(path.join(jobDir, 'CONTRACT.md'), 'utf8'); } catch { /* bị xoá */ }
  if (sha256(contractNow) !== job.contractSha) {
    evidence.contract_tampered = true;
    evidence.checks.push(check('contract_intact', 'fail', { reason: 'CONTRACT.md changed during the job — nothing else was measured' }));
    return write();
  }

  let reportText = null;
  try { reportText = fs.readFileSync(path.join(jobDir, 'REPORT.md'), 'utf8'); } catch { /* agent chưa ghi */ }
  const report = reportText === null ? null : parseReport(reportText, { contractId: contract.contract_id });
  evidence.report = reportText === null ? { present: false } : { present: true, valid: report.ok, errors: listed(report.errors), status: report.report?.status, needs_scope_change: report.report?.needs_scope_change, new_checks: report.new_checks?.length || 0 };

  const tree = job.worktree || job.cwd;
  const base = job.baseCommit;
  let diff = null;
  if (base) {
    try {
      diff = await diffSince(tree, base, gitOpts);
      evidence.head_commit = await resolveCommit(tree, 'HEAD', gitOpts);
      evidence.diff = { files: listed(diff.files.map((f) => `${f.status} ${f.path}`)), changed: diff.files.length };
    } catch (e) {
      evidence.diff = { error: e.message };
    }
  } else evidence.diff = { error: 'not a git repository (or no base commit) — diff checks cannot run' };

  // Lệnh kiểm chứng, lần lượt, trong cây của job.
  const junitCases = [];
  for (const cmd of contract.verify) {
    if (signal?.aborted) break;
    const res = await runCommand(cmd, { cwd: tree, logFile: path.join(jobDir, 'logs', `${cmd.id}.log`), signal });
    const entry = { id: cmd.id, argv: cmd.argv, ...res, log: `logs/${cmd.id}.log` };
    if (cmd.report) {
      try {
        const j = parseJUnit(fs.readFileSync(path.join(tree, cmd.report), 'utf8'));
        entry.junit = { tests: j.tests, failures: j.failures, errors: j.errors, skipped: j.skipped };
        junitCases.push(...j.cases);
      } catch { entry.junit = { missing: true }; }
    }
    evidence.commands.push(entry);
    const problems = [];
    if (res.error) problems.push(res.error);
    if (res.timed_out) problems.push(`timed out after ${cmd.timeout_ms} ms`);
    if (res.exit_code !== 0 && !res.error) problems.push(`exit code ${res.exit_code}`);
    if (entry.junit?.missing) problems.push(`${cmd.report} was not written`);
    else if (entry.junit && (entry.junit.failures || entry.junit.errors)) problems.push(`${entry.junit.failures + entry.junit.errors} failing tests`);
    else if (entry.junit && !entry.junit.tests) problems.push(`${cmd.report} has no test cases`);
    evidence.checks.push(check(CheckKind.COMMAND_PASSED, problems.length ? 'fail' : 'pass', { command_id: cmd.id, ...(problems.length ? { problems } : {}) }));
  }

  if (diff) {
    const changed = diff.files.map((f) => f.path);
    const denied = changed.filter((p) => matchesAny(p, contract.scope.deny_paths));
    const outside = !!job.worktree && mainCheckoutChanged(job.mainStateBefore, await worktreeState(job.cwd, gitOpts), { cwd: job.cwd, worktree: job.worktree });
    evidence.checks.push(check(CheckKind.DIFF_IN_SCOPE, denied.length || outside ? 'fail' : 'pass', {
      ...(denied.length ? { denied: listed(denied) } : {}), ...(outside ? { reason: 'the main checkout changed — work must stay in the job worktree' } : {}),
    }));
    // Tệp được bảo vệ: không sửa / xoá bản đã có; thêm tệp mới (ví dụ test mới) thì được.
    const touched = diff.files.filter((f) => f.status !== 'A' && matchesAny(f.path, contract.scope.protected_paths)).map((f) => `${f.status} ${f.path}`);
    evidence.checks.push(check(CheckKind.PROTECTED_UNTOUCHED, touched.length ? 'fail' : 'pass', touched.length ? { touched: listed(touched) } : {}));
    const declsAdded = diff.added.filter((l) => TEST_DECL_RE.test(l.text)).length;
    const declsRemoved = diff.removed.filter((l) => TEST_DECL_RE.test(l.text));
    const deletedTests = diff.files.filter((f) => f.status === 'D' && TEST_FILE_RE.test(f.path)).map((f) => f.path);
    evidence.checks.push(check(CheckKind.TESTS_NOT_REDUCED, declsRemoved.length > declsAdded ? 'fail' : 'pass', {
      added: declsAdded, removed: declsRemoved.length, ...(deletedTests.length ? { deleted_test_files: listed(deletedTests) } : {}),
      ...(declsRemoved.length > declsAdded ? { removed_lines: listed(declsRemoved.map((l) => `${l.path}: ${l.text.trim().slice(0, 160)}`)) } : {}),
    }));
    const skips = diff.added.filter((l) => SKIP_RE.test(l.text)).map((l) => `${l.path}: ${l.text.trim().slice(0, 160)}`);
    evidence.checks.push(check(CheckKind.NO_NEW_SKIPS, skips.length ? 'fail' : 'pass', skips.length ? { lines: listed(skips) } : {}));
  } else {
    for (const kind of [CheckKind.DIFF_IN_SCOPE, CheckKind.PROTECTED_UNTOUCHED, CheckKind.TESTS_NOT_REDUCED, CheckKind.NO_NEW_SKIPS]) {
      evidence.checks.push(check(kind, 'error', { reason: evidence.diff?.error }));
    }
  }

  const cov = coverage({ contract, testCheck, report, junitCases });
  evidence.tests = cov.tests;
  evidence.checks.push(cov.result);

  const missing = [];
  for (const o of contract.outputs.filter((x) => x.required)) {
    if (o.kind === 'report_md' && !report?.ok) missing.push(`${o.id}: REPORT.md is ${report ? 'not in the agreed format' : 'missing'}`);
    if (o.kind === 'git_branch' && !diff?.files.length) missing.push(`${o.id}: no code change in the job worktree`);
  }
  evidence.checks.push(check(CheckKind.OUTPUTS_COMPLETE, missing.length ? 'fail' : 'pass', missing.length ? { missing } : {}));

  // Tiêu chí của hợp đồng → bộ kiểm đã đo; tiêu chí cần giám khảo (llm_rubric, người) để Agentic chấm.
  for (const a of contract.acceptance) {
    if (!a.check) { evidence.acceptance.push({ key: a.key, required: a.required, status: 'needs_verifier', verifier: a.verifier }); continue; }
    const hit = evidence.checks.find((c) => c.check === a.check && (a.check !== CheckKind.COMMAND_PASSED || c.command_id === a.command_id));
    evidence.acceptance.push({ key: a.key, required: a.required, check: a.check, status: hit ? hit.status : 'error' });
  }
  return write();
}
