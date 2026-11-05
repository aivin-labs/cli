import { execFileSync } from 'child_process';

/** Phần chờ CI của `release-publish.mjs`, tách riêng để test được không cần phát hành thật. */

export const CI_TIMEOUT_MS = 20 * 60_000;
export const CI_POLL_MS = 15_000;
const CI_REPORT_EVERY_MS = 30_000;
/** `gh` lỗi liền chừng này lần (~2 phút) thì dừng, báo lý do thật: hết phiên đăng nhập, sai repo... chờ tiếp cũng vô ích. */
const CI_MAX_GH_FAILURES = 8;
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
  log(`Dang cho CI build ${tag} (thuong ~3 phut)...`);
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
