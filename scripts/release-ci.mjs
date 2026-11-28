import { execFileSync } from 'child_process';

/** Phần chờ CI của `release-publish.mjs`, tách riêng để test được không cần phát hành thật. */

export const CI_TIMEOUT_MS = 20 * 60_000;
export const CI_POLL_MS = 5_000;
const CI_REPORT_EVERY_MS = 30_000;
/** `gh` lỗi liền chừng này lần (~2 phút) thì dừng, báo lý do thật: hết phiên đăng nhập, sai repo... chờ tiếp cũng vô ích. */
const CI_MAX_GH_FAILURES = 24;
const MAX_SUMMARY_FAILURES = 5;
const MAX_LINES_PER_FAILURE = 24;
const TAIL_LINES = 30;
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const NOISE_RESULT = /^(duration_ms|type|location|failureType):/;

/** Chạy lệnh, lấy stdout. Lỗi thì thông báo lấy từ stderr của chính lệnh đó, không chỉ `Command failed`. */
export function runTool(command, args, { exec = execFileSync } = {}) {
  try {
    return exec(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_LOG_BYTES }).trim();
  } catch (e) {
    const detail = String(e?.stderr || '').trim() || e?.message || String(e);
    throw new Error(`${command} ${args[0] || ''}: ${detail}`);
  }
}

/** Bỏ tiền tố `<job>\t<bước>\t<thời gian> ` và mã màu của `gh run view --log-failed`. */
function cleanLogLine(line) {
  const fields = line.replace(/\r$/, '').split('\t');
  const text = fields.length >= 3 ? fields.slice(2).join('\t') : line.replace(/\r$/, '');
  // eslint-disable-next-line no-control-regex
  return { job: fields.length >= 3 ? fields[0] : '', text: text.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '') };
}

/** Khối YAML kèm `not ok` (báo cáo TAP): giữ nơi hỏng + nội dung lỗi, bỏ số đo và stack. */
function tapFailure(lines, start) {
  const out = [];
  for (let i = start + 1; i < lines.length && out.length < MAX_LINES_PER_FAILURE; i++) {
    const trimmed = lines[i].text.trim();
    if (trimmed === '...' || /^(not )?ok \d+/.test(trimmed) || /^# Subtest/.test(trimmed)) break;
    if (/^(code|name|expected|actual|operator|stack):/.test(trimmed)) break;
    if (trimmed === '---' || trimmed === 'error: |-' || !trimmed || NOISE_RESULT.test(trimmed) && !trimmed.startsWith('location:')) continue;
    out.push(`    ${trimmed}`);
  }
  return out;
}

/**
 * Tóm tắt log CI đỏ cho người đọc trong cửa sổ phát hành: test nào hỏng, ở đâu, lỗi gì. Không nhận ra dạng test (lỗi build, cài đặt...) thì lấy
 * những dòng cuối, không bao giờ trả rỗng khi log có nội dung.
 */
export function summarizeFailedLog(raw) {
  const lines = String(raw || '').split('\n').map(cleanLogLine);
  const failures = lines.flatMap((line, i) => (/^not ok \d+ - /.test(line.text) ? [i] : []));
  if (failures.length) {
    const out = [];
    for (const i of failures.slice(0, MAX_SUMMARY_FAILURES)) {
      const job = lines[i].job ? ` [${lines[i].job}]` : '';
      out.push(`  ✖ ${lines[i].text.replace(/^not ok \d+ - /, '')}${job}`, ...tapFailure(lines, i));
    }
    if (failures.length > MAX_SUMMARY_FAILURES) out.push(`  ... và ${failures.length - MAX_SUMMARY_FAILURES} test hỏng nữa`);
    return out.join('\n');
  }
  const spec = lines.findIndex((line) => /✖ failing tests:/.test(line.text));
  const picked = spec >= 0 ? lines.slice(spec, spec + TAIL_LINES * 2) : lines.filter((line) => line.text.trim()).slice(-TAIL_LINES);
  return picked.map((line) => `  ${line.text}`).join('\n');
}

const formatElapsed = (ms) => {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
};

function failureReport(tag, run, { repo, gh, log }) {
  let detail;
  log(`CI cua ${tag} do - dang lay log loi...`);
  try {
    detail = summarizeFailedLog(gh('run', 'view', String(run.databaseId), '--repo', repo, '--log-failed'));
  } catch (e) {
    detail = `  (khong lay duoc log: ${e?.message || e})`;
  }
  return `CI cua ${tag} that bai (${run.conclusion}):\n${detail}\n\nLog day du: ${run.url}\nSua xong commit roi chay lai publish.bat.`;
}

/**
 * Chờ CI của tag xong, báo trạng thái đều đặn. CI đỏ → lỗi kèm tóm tắt log. `gh` lỗi liên tục → dừng sớm với lý do thật; mạng chập chờn vài
 * nhịp thì thử lại, nhưng vẫn báo để cửa sổ không im lặng.
 */
export async function waitForCiBuild(tag, {
  repo, gh, sleep, log = console.log, now = Date.now, timeoutMs = CI_TIMEOUT_MS, pollMs = CI_POLL_MS, reportEveryMs = CI_REPORT_EVERY_MS, maxGhFailures = CI_MAX_GH_FAILURES,
}) {
  const startedAt = now();
  let ghFailures = 0;
  let lastLine = '';
  let lastReportAt = -Infinity;
  log(`Dang cho CI build ${tag} (thuong ~2 phut)...`);
  while (now() - startedAt < timeoutMs) {
    let run = null;
    let line;
    try {
      [run] = JSON.parse(gh('run', 'list', '--repo', repo, '--branch', tag, '--limit', '1', '--json', 'databaseId,status,conclusion,url'));
      ghFailures = 0;
      line = run ? run.status : 'chua thay lan chay nao';
    } catch (e) {
      if (++ghFailures >= maxGhFailures) throw new Error(`Khong hoi duoc trang thai CI cua ${tag} sau ${ghFailures} lan: ${e?.message || e}\nKiem tra \`gh auth status\`, roi chay lai publish.bat.`);
      line = `chua hoi duoc (lan ${ghFailures}/${maxGhFailures}): ${e?.message || e}`;
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(failureReport(tag, run, { repo, gh, log }));
      log(`CI ${tag}: xong sau ${formatElapsed(now() - startedAt)}.`);
      return;
    }
    if (line !== lastLine || now() - lastReportAt >= reportEveryMs) {
      log(`CI ${tag}: ${line} (${formatElapsed(now() - startedAt)})`);
      lastLine = line;
      lastReportAt = now();
    }
    await sleep(pollMs);
  }
  throw new Error(`Qua ${Math.round(timeoutMs / 60_000)} phut CI chua xong ${tag} - xem \`gh run list --repo ${repo}\`, roi chay lai publish.bat.`);
}

/** Job CI publish npm bằng trusted publishing (OIDC, không token, không OTP) - tên job trong `.github/workflows/release.yml`. */
export const NPM_JOB = 'npm-publish';
export const CI_JOB_TIMEOUT_MS = 10 * 60_000;
const CI_JOB_MAX_GH_FAILURES = 6;

/**
 * Trạng thái 1 job trong lần chạy CI mới nhất của tag: `success` | `failed` (đỏ / bị bỏ qua / huỷ) | `pending` | `missing` (chưa có lần
 * chạy, hoặc chạy xong mà không có job này - workflow cũ trước khi có job).
 */
export function ciJobState(tag, job, { repo, gh }) {
  const [run] = JSON.parse(gh('run', 'list', '--repo', repo, '--branch', tag, '--limit', '1', '--json', 'databaseId,status'));
  if (!run) return 'missing';
  const { jobs = [] } = JSON.parse(gh('run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs'));
  const found = jobs.find((j) => j.name === job);
  if (!found) return run.status === 'completed' ? 'missing' : 'pending';
  if (found.status !== 'completed') return 'pending';
  return found.conclusion === 'success' ? 'success' : 'failed';
}

/** Chờ job xong (tối đa `timeoutMs`). Hết hạn → `pending`; `gh` lỗi liên tục → `unknown` (nơi gọi tự quyết đường lui). */
export async function waitForCiJob(tag, job, {
  repo, gh, sleep, log = console.log, now = Date.now, timeoutMs = CI_JOB_TIMEOUT_MS, pollMs = CI_POLL_MS, maxGhFailures = CI_JOB_MAX_GH_FAILURES,
}) {
  const startedAt = now();
  let ghFailures = 0;
  let reported = false;
  for (;;) {
    let state;
    try {
      state = ciJobState(tag, job, { repo, gh });
      ghFailures = 0;
    } catch (e) {
      if (++ghFailures >= maxGhFailures) {
        log(`Khong hoi duoc job ${job} cua ${tag}: ${e?.message || e}`);
        return 'unknown';
      }
      state = 'pending';
    }
    if (state !== 'pending') return state;
    if (now() - startedAt >= timeoutMs) return 'pending';
    if (!reported) { log(`Dang cho job ${job} cua ${tag}...`); reported = true; }
    await sleep(pollMs);
  }
}

/** Run + job id của job trong lần chạy CI mới nhất của tag (null nếu chưa có). */
function ciJobRef(tag, job, { repo, gh }) {
  const [run] = JSON.parse(gh('run', 'list', '--repo', repo, '--branch', tag, '--limit', '1', '--json', 'databaseId,status'));
  if (!run) return null;
  const { jobs = [] } = JSON.parse(gh('run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs'));
  const found = jobs.find((j) => j.name === job);
  return found ? { runId: run.databaseId, jobId: found.databaseId, status: found.status } : null;
}

const RERUN_SETTLE_MS = 90_000;

/**
 * Chạy lại 1 job đã xong (đỏ) của lần chạy CI mới nhất của tag rồi chờ kết quả. Ngay sau `gh run rerun`, `gh run view` có thể vẫn trả
 * job cũ (đã xong, đỏ) → chờ tới khi job mang id mới / chưa xong rồi mới đọc kết quả, tránh đọc nhầm kết quả lần trước.
 */
export async function rerunCiJob(tag, job, {
  repo, gh, sleep, log = console.log, now = Date.now, pollMs = CI_POLL_MS, settleMs = RERUN_SETTLE_MS, timeoutMs = CI_JOB_TIMEOUT_MS,
}) {
  const before = ciJobRef(tag, job, { repo, gh });
  if (!before) return 'missing';
  gh('run', 'rerun', String(before.runId), '--repo', repo, '--job', String(before.jobId));
  const startedAt = now();
  for (;;) {
    let cur = null;
    try { cur = ciJobRef(tag, job, { repo, gh }); } catch { /* gh chập chờn: thử lại */ }
    if (cur && (cur.jobId !== before.jobId || cur.status !== 'completed')) break;
    if (now() - startedAt >= settleMs) return 'failed';
    await sleep(pollMs);
  }
  return waitForCiJob(tag, job, { repo, gh, sleep, log, now, pollMs, timeoutMs });
}

export const NPM_SETUP_WAIT_MS = 20 * 60_000;
export const NPM_SETUP_RETRY_MS = 2 * 60_000;

/**
 * Chế độ không người trực (Deploy của LightCode, không có terminal để hỏi OTP): job npm-publish đỏ thường do chưa khai Trusted publisher
 * trên npmjs.com. Mở trình duyệt tới trang cài đặt gói để người dùng khai, rồi cứ `retryMs` chạy lại job tới khi xanh (tối đa `waitMs`).
 * Trả về trạng thái cuối của job (`success` = npm đã nhận).
 */
export async function waitForNpmTrustedPublisher(tag, job, {
  repo, gh, sleep, openUrl, settingsUrl, log = console.log, now = Date.now, waitMs = NPM_SETUP_WAIT_MS, retryMs = NPM_SETUP_RETRY_MS, rerunOpts = {},
}) {
  log(`Mo trinh duyet: ${settingsUrl}`);
  log('  -> Dang nhap npm (tai khoan to chuc aivin-labs), Settings -> Trusted publishing -> GitHub Actions:');
  log(`     owner/repo = ${repo}, workflow = release.yml, environment de trong, TICK "npm publish", bam Save.`);
  log(`  Script tu chay lai job ${job} moi ${Math.round(retryMs / 60_000)} phut, toi da ${Math.round(waitMs / 60_000)} phut.`);
  try { openUrl(settingsUrl); } catch (e) { log(`Khong mo duoc trinh duyet (${e?.message || e}) - tu mo link tren.`); }
  const startedAt = now();
  let state = 'failed';
  for (let attempt = 1; ; attempt++) {
    await sleep(retryMs);
    log(`Chay lai job ${job} cua ${tag} (lan ${attempt})...`);
    try { state = await rerunCiJob(tag, job, { repo, gh, sleep, log, now, ...rerunOpts }); } catch (e) { log(`Chay lai job loi: ${e?.message || e}`); state = 'unknown'; }
    if (state === 'success') return state;
    if (now() - startedAt >= waitMs) return state;
    log(`Job ${job}: ${state} - cho them...`);
  }
}
