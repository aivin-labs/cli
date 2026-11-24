import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { execFile, spawn } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR, ToolGroup } from './constants.mjs';
import { DeviceToolError, resolveInRoots } from './sandbox.mjs';

/**
 * LightCode làm agent thực thi cho hợp đồng lập trình (20/11/2026). Aivin = thầu sơ cấp: lập kế hoạch, phát hành hợp đồng, đo + nghiệm thu;
 * LightCode (ứng dụng desktop độc lập của GOMEE, https://lightcode.live) = bên thực thi trên máy: chạy song song nhiều agent (Claude, Codex,
 * Gemini, OpenCode, Antigravity), tự chuyển tài khoản dự phòng khi hết hạn mức, giữ ngữ cảnh khi đổi tài khoản.
 *
 * Nối qua CỬA CỤC BỘ của LightCode (server/src/aivin/connector.ts bên repo LightCode): `~/.lightcode/connector.json` { port, key, pid } —
 * `POST /connector/v1/jobs` = một lượt, trả NDJSON (init · text · tool · status · result) tới khi lượt xong; đóng kết nối = LightCode dừng
 * lượt (daemon cắt theo thời hạn hợp đồng / agent.stop vẫn hiệu lực). Không có tiến trình con thật: adapter tự dựng một "tiến trình" giả
 * (stdout / stdin / kill / close) nên runner (codingAgents.mjs) dùng nguyên vẹn — worktree, luật cấm, đo bằng chứng, nhắc ghi lại
 * REPORT.md, vòng sửa (nói tiếp phiên bằng session_id LightCode trả về).
 *
 * Quyền: LightCode chạy job KHÔNG người trông (headless) — hỏi quyền giữa chừng được trả lời theo `allowedTools` + luật cấm của hợp đồng,
 * không chờ ai bấm. Luật cấm còn được đưa thẳng cho Claude Code (`--settings`); agent khác của LightCode chỉ bị bắt ở bước đo (diff_in_scope).
 */

export const LIGHTCODE_CONNECTOR_FILE = path.join(os.homedir(), '.lightcode', 'connector.json');
/**
 * Container Cloud Computer: LightCode chạy headless dưới tài khoản daemon `aivin-lc`; connector.json nằm ở thư mục nhà của daemon.
 * entrypoint.sh đặt biến này; CLI đọc để nối vào cửa loopback mà không cần exe LightCode trên Windows.
 */
export const LIGHTCODE_HEADLESS_CONNECTOR_FILE = '/var/lib/aivin-lc/.lightcode/connector.json';
/**
 * Cờ bật LightCode làm agent chạy việc của THÀNH VIÊN trong Cloud Computer (mặc định TẮT). Daemon `aivin-lc` không đọc được thư mục nhà 0700
 * của thành viên và LightCode chưa có runAs → khi cờ tắt: không khởi động daemon, không quảng bá agent, org dùng đường Claude Code / Codex.
 */
export const LIGHTCODE_ORG_JOBS_ENV = 'AIVIN_LIGHTCODE_ORG_JOBS';
export const lightcodeOrgJobsEnabled = (env = process.env) => String(env?.[LIGHTCODE_ORG_JOBS_ENV] ?? '').trim() === '1';
export const LIGHTCODE_RELEASES_URL = 'https://lightcode.live/releases';
export const LIGHTCODE_SITE = 'https://lightcode.live';
const DOWNLOAD_DIR = path.join(REMOTE_CONFIG_DIR, 'downloads');
/** Chờ LightCode mở xong cửa cục bộ sau khi bật ứng dụng. */
const START_WAIT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;
/** Cờ duy nhất của adapter: toàn bộ tuỳ chọn của lượt nằm trong một JSON (không qua shell, không có tiến trình thật). */
const JOB_FLAG = '--job';
/** Bản giao thức cửa cục bộ mà adapter này nói (LightCode `GET /info` báo `protocol`); thấp hơn thì chạy kiểu cũ, không detach. */
export const CLIENT_PROTOCOL = 2;
/** Job tách khỏi kết nối: LightCode tự dừng nếu không ai theo dõi quá chừng này (daemon khởi động lại / sập). */
const ORPHAN_MS = 5 * 60_000;
const RECONNECT_MAX = 40;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_CAP_MS = 10_000;
const STOP_TIMEOUT_MS = 4000;
const SIG_CHECK_TIMEOUT_MS = 15_000;

const invalid = (msg) => new DeviceToolError(DeviceErrorCode.INVALID_ARGS, msg);
const notFound = (msg) => new DeviceToolError(DeviceErrorCode.NOT_FOUND, msg);

/** Nơi bộ cài NSIS (một người dùng, mặc định của electron-builder) đặt LightCode, theo thứ tự hay gặp. */
export function lightcodeExeCandidates({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const out = [];
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'LightCode', 'LightCode.exe'));
  for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) out.push(path.join(pf, 'LightCode', 'LightCode.exe'));
  return out;
}

export function findLightcodeExe(opts = {}) {
  const exists = opts.exists || fs.existsSync;
  return lightcodeExeCandidates(opts).find((p) => exists(p)) || null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** Cửa cục bộ của LightCode đang mở (ứng dụng đang chạy) → { port, key, app_version }, không thì null. */
export function readConnector({ file = LIGHTCODE_CONNECTOR_FILE, alive = pidAlive } = {}) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info?.app !== 'LightCode' || !Number.isInteger(info.port) || typeof info.key !== 'string' || !info.key) return null;
    if (!alive(info.pid)) return null;
    return info;
  } catch { return null; }
}

/**
 * Headless connector (Cloud Computer): LightCode daemon chạy dưới `aivin-lc`; connector.json ở /var/lib/aivin-lc/.lightcode/connector.json.
 * Không kiểm pid (daemon chạy dưới uid khác, root không cần kill 0 — chỉ kiểm cổng mở là đủ).
 * env.LIGHTCODE_HEADLESS_CONNECTOR_FILE cho phép test/deploy override đường dẫn.
 */
export function readHeadlessConnector({ file, env = process.env } = {}) {
  const f = file || env.LIGHTCODE_HEADLESS_CONNECTOR_FILE || LIGHTCODE_HEADLESS_CONNECTOR_FILE;
  try {
    const info = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (info?.app !== 'LightCode' || !Number.isInteger(info.port) || typeof info.key !== 'string' || !info.key) return null;
    return info;
  } catch { return null; }
}

const GATEWAY_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/**
 * `aiGateway` {baseUrl, apiKey, model, expiresAt} từ BE (quota model mặc định AIVIN) → dạng nội bộ, hoặc undefined khi không có / đã hết hạn.
 * Sai dạng → ném lỗi (không nuốt im lặng). Không bao giờ log / ghi đĩa; khoá chỉ nằm trong bộ nhớ của job.
 */
export function normalizeAiGateway(gw, now = Date.now()) {
  if (gw === undefined || gw === null) return undefined;
  const bad = (m) => new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `aiGateway: ${m}`);
  if (typeof gw !== 'object' || Array.isArray(gw)) throw bad('must be an object');
  const baseUrl = typeof gw.baseUrl === 'string' ? gw.baseUrl.trim() : '';
  const apiKey = typeof gw.apiKey === 'string' ? gw.apiKey.trim() : '';
  const model = typeof gw.model === 'string' ? gw.model.trim() : '';
  let url = null;
  try { url = new URL(baseUrl); } catch { /* báo ở dưới */ }
  if (!url || !/^https?:$/.test(url.protocol)) throw bad('baseUrl must be an http(s) URL');
  if (!apiKey || apiKey.length > 512 || /\s/.test(apiKey)) throw bad('bad apiKey');
  if (!GATEWAY_MODEL_RE.test(model)) throw bad('bad model');
  const exp = typeof gw.expiresAt === 'number' ? gw.expiresAt : Date.parse(String(gw.expiresAt ?? ''));
  if (!Number.isFinite(exp)) throw bad('bad expiresAt');
  if (exp <= now) return undefined; // hết hạn → bỏ, không gửi khoá chết
  return { baseUrl: url.toString().replace(/\/+$/, ''), apiKey, model, expiresAt: new Date(exp).toISOString() };
}

/**
 * Tài khoản Linux của thành viên ({uid,gid,home}) mà LightCode chạy CLI của job dưới đó (`run_as`). Chỉ nhận dạng đúng: uid / gid là số nguyên > 0,
 * home là đường dẫn tuyệt đối sạch (không "..", không "//", không dấu "/" cuối). LightCode còn kiểm lại dải uid, chủ sở hữu thư mục, daemon uid.
 */
export function normalizeRunAs(runAs) {
  const bad = (m) => new DeviceToolError(DeviceErrorCode.INVALID_ARGS, `runAs: ${m}`);
  if (!runAs || typeof runAs !== 'object' || Array.isArray(runAs)) throw bad('must be an object { uid, gid, home }');
  for (const k of ['uid', 'gid']) if (!Number.isInteger(runAs[k]) || runAs[k] <= 0) throw bad(`${k} must be a positive integer`);
  const home = runAs.home;
  const clean = typeof home === 'string' && home.length > 1 && home.length <= 4096 && home.startsWith('/') && !home.endsWith('/') && !/[\u0000-\u0020]/.test(home)
    && !home.includes('//') && !home.split('/').some((seg) => seg === '..' || seg === '.');
  if (!clean) throw bad('home must be a clean absolute path');
  return { uid: runAs.uid, gid: runAs.gid, home };
}

/** Cổng AI của job ở dạng LightCode nhận (snake_case); hết hạn giữa chừng (vd. nối lại sau lâu) hoặc hỏng → không có. */
function gatewayFor(job) {
  let gw;
  try { gw = normalizeAiGateway(job?.aiGateway); } catch { return null; }
  return gw ? { base_url: gw.baseUrl, api_key: gw.apiKey, model: gw.model, expires_at: gw.expiresAt } : null;
}

/** Tình trạng LightCode trên máy (không gọi mạng). */
export function lightcodeLocalStatus(opts = {}) {
  const connector = readConnector(opts);
  const exe = findLightcodeExe(opts);
  const platform = opts.platform || process.platform;
  return {
    supported: platform === 'win32',
    installed: !!(connector || exe),
    running: !!connector,
    ...(connector?.app_version ? { version: connector.app_version } : {}),
    ...(connector?.protocol ? { protocol: connector.protocol } : {}),
    ...(exe ? { exe } : {}),
  };
}

/** Bật LightCode (nếu chưa chạy) và chờ cửa cục bộ mở. */
export async function ensureLightcodeRunning({ wait = START_WAIT_MS, spawnImpl = spawn, ...opts } = {}) {
  const ready = readConnector(opts);
  if (ready) return ready;
  const exe = findLightcodeExe(opts);
  if (!exe) throw notFound('LightCode is not installed on this computer — install it with lightcode.install (after the person agrees)');
  const child = spawnImpl(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on?.('error', () => undefined);
  child.unref?.();
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const info = readConnector(opts);
    if (info) return info;
  }
  throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `LightCode did not open its local connector within ${Math.round(wait / 1000)} s — open LightCode once by hand and try again`);
}

/** Mã job + tiêu đề hợp đồng từ đề bài của job có hợp đồng (đề bài trỏ tới `<jobs>/<job>/CONTRACT.md`). */
/** `verdict` của LightCode (done | partial | blocked | needs_input + từng tiêu chí / ràng buộc / lệnh kiểm tra / tệp bàn giao), rút gọn cho an toàn kích thước. */
export function slimVerdict(v) {
  const list = (a, f) => (Array.isArray(a) ? a.slice(0, 40).filter((x) => x && typeof x === 'object').map(f) : []);
  const t = (x, n = 300) => String(x ?? '').slice(0, n);
  const deliverables = list(v.deliverables, (d) => ({
    path: t(d.path, 300),
    ok: d.ok === true,
    exists: d.exists === true,
    ...(typeof d.size === 'number' ? { size: d.size } : {}),
    ...(d.sha256 ? { sha256: t(d.sha256, 80) } : {}),
    ...(d.format ? { format: t(d.format, 24) } : {}),
    ...(d.problem ? { problem: t(d.problem, 200) } : {}),
  }));
  return {
    status: ['done', 'partial', 'blocked', 'needs_input'].includes(v.status) ? v.status : 'partial',
    report: ['complete', 'partial', 'none', 'not_applicable'].includes(v.report) ? v.report : 'complete',
    criteria: list(v.criteria, (c) => ({ text: t(c.text), met: c.met === true, ...(c.reported === false ? { reported: false } : {}), ...(c.evidence ? { evidence: t(c.evidence) } : {}) })),
    constraints: list(v.constraints, (c) => ({ text: t(c.text), kept: c.kept === true, ...(c.reported === false ? { reported: false } : {}), ...(c.evidence ? { evidence: t(c.evidence) } : {}) })),
    checks: list(v.checks, (c) => ({ cmd: t(c.cmd, 200), ok: c.ok === true, ...(c.skipped ? { skipped: t(c.skipped, 20) } : {}) })),
    ...(deliverables.length ? { deliverables } : {}),
    issues: Array.isArray(v.issues) ? v.issues.slice(0, 40).map((x) => t(x)) : [],
    summary: t(v.summary, 1500),
    ...(typeof v.cost_usd === 'number' ? { cost_usd: v.cost_usd } : {}),
  };
}

function slimRisk(r) {
  if (!r || typeof r !== 'object') return undefined;
  const level = ['low', 'medium', 'high'].includes(r.level) ? r.level : 'medium';
  return {
    level,
    auto_merge_ok: r.auto_merge_ok === true,
    reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 12).map((x) => String(x ?? '').slice(0, 200)) : [],
  };
}

function slimGoal(g) {
  if (!g || typeof g !== 'object' || !g.id) return undefined;
  return {
    id: String(g.id).slice(0, 60),
    spent_usd: Number(g.spent_usd) || 0,
    ...(typeof g.budget_usd === 'number' ? { budget_usd: g.budget_usd } : {}),
  };
}

function slimGit(g) {
  if (!g || typeof g !== 'object') return undefined;
  const out = {
    ...(typeof g.branch === 'string' && g.branch ? { branch: g.branch.slice(0, 120) } : {}),
    ...(typeof g.head === 'string' && g.head ? { head: g.head.slice(0, 64) } : {}),
    ...(typeof g.dirty === 'boolean' ? { dirty: g.dirty } : {}),
    ...(typeof g.diff_stat === 'string' && g.diff_stat ? { diff_stat: g.diff_stat.slice(0, 800) } : {}),
    ...(Array.isArray(g.commits) && g.commits.length ? { commits: g.commits.slice(0, 10).map((c) => String(c ?? '').slice(0, 200)) } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function normalizeDeliverablesArg(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim().slice(0, 500));
    else if (item && typeof item === 'object' && typeof item.path === 'string' && item.path.trim()) {
      const min = Number(item.min_bytes);
      out.push({ path: item.path.trim().slice(0, 500), ...(Number.isFinite(min) && min > 0 ? { min_bytes: Math.floor(min) } : {}) });
    }
    if (out.length >= 40) break;
  }
  return out;
}

export function contractInfoFromPrompt(prompt) {
  const m = /([A-Za-z]:)?[^\s"']*?[\\/]([a-z0-9]+-[0-9a-f]{8})[\\/]CONTRACT\.md/.exec(String(prompt || ''));
  if (!m) return {};
  const file = m[0];
  const out = { job_id: m[2] };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const id = /^contract_id:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text);
    if (id) out.contract_id = id[1].trim();
    const title = /^# (.+)$/m.exec(text.replace(/^---[\s\S]*?\n---\s*\n/, ''));
    if (title) out.title = title[1].trim().slice(0, 120);
  } catch { /* không đọc được — chỉ thiếu nhãn */ }
  return out;
}

/**
 * Đọc một luồng NDJSON của LightCode, lọc trùng theo `seq`, chuyển nguyên văn sang `child.stdout`.
 * Trả hàm `consume(stream)` cập nhật trạng thái `{ sessionId, lastSeq, finished }`.
 */
function createNdjsonConsumer(child, state, signal) {
  const decoder = new TextDecoder();
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg = null;
    try { msg = JSON.parse(trimmed); } catch { /* dòng hỏng — chuyển nguyên */ }
    if (msg && Number.isInteger(msg.seq)) {
      if (msg.seq <= state.lastSeq) return;
      state.lastSeq = msg.seq;
    }
    if (msg?.type === 'init' && msg.session_id) state.sessionId = msg.session_id;
    if (msg?.type === 'result') state.finished = true;
    child.stdout.write(`${trimmed}\n`);
  };
  return async (stream) => {
    let buf = '';
    for await (const chunk of stream.body) {
      if (signal.aborted) return;
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    if (buf.trim()) handleLine(buf);
  };
}

/**
 * Dựng "tiến trình" giả của LightCode + vòng nối lại khi đứt kết nối (dùng chung cho lượt mới và nối lại sau khi CLI khởi động lại).
 */
function createTurnShell({ fetchImpl, peek, sleep, initialSessionId = null, initialLastSeq = -1, initialTarget = null }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = undefined;
  const abort = new AbortController();
  const state = { sessionId: initialSessionId, lastSeq: initialLastSeq, finished: false, target: initialTarget };
  let closed = false;
  const close = (code) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    // Runner đọc dữ liệu trên 'data' — để luồng xả hết trước 'close'.
    setImmediate(() => child.emit('close', code));
  };
  const failLine = (answer, stopReason) => {
    child.stdout.write(`${JSON.stringify({ type: 'result', ok: false, answer: String(answer).slice(0, 2000), stop_reason: stopReason })}\n`);
  };
  child.kill = () => {
    if (closed) return true;
    // Job tách khỏi kết nối vẫn chạy khi đóng kết nối → dừng thật bằng lệnh riêng (không chờ kết quả).
    if (state.sessionId && state.target) {
      const t = AbortSignal.timeout ? AbortSignal.timeout(STOP_TIMEOUT_MS) : undefined;
      void Promise.resolve(fetchImpl(`http://127.0.0.1:${state.target.port}/connector/v1/sessions/${state.sessionId}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${state.target.key}` }, signal: t })).catch(() => undefined);
    }
    abort.abort();
    close(null);
    return true;
  };
  const consume = createNdjsonConsumer(child, state, abort.signal);
  /** Vòng nối lại vào `/sessions/:id/events?from=<lastSeq+1>` cho đến khi nhận được `result` hoặc mất hẳn lượt. */
  const followUntilDone = async ({ detach, immediate = false }) => {
    let attempts = 0;
    while (!state.finished && !abort.signal.aborted) {
      if (!detach) { failLine('The connection to LightCode closed before the job finished', 'connection_lost'); close(1); return; }
      if (!state.sessionId) { failLine('The connection to LightCode closed before the job started', 'connection_lost'); close(1); return; }
      if (++attempts > RECONNECT_MAX) { failLine('Lost the connection to LightCode and could not get it back', 'connection_lost'); close(1); return; }
      if (!immediate || attempts > 1) await sleep(Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * attempts));
      if (abort.signal.aborted) return;
      const now = peek();
      if (!now) continue; // LightCode đang tắt / bật lại — thử tiếp
      state.target = now;
      try {
        const again = await fetchImpl(`http://127.0.0.1:${now.port}/connector/v1/sessions/${state.sessionId}/events?from=${Math.max(0, state.lastSeq + 1)}`, {
          headers: { Authorization: `Bearer ${now.key}` }, signal: abort.signal,
        });
        if (again.status === 404) {
          // LightCode v2.3+: khởi động lại vẫn lưu kết quả cuối cùng ở GET /sessions/:id → phục hồi thay vì báo mất lượt.
          const snap = await Promise.resolve(fetchImpl(`http://127.0.0.1:${now.port}/connector/v1/sessions/${state.sessionId}`, {
            headers: { Authorization: `Bearer ${now.key}` }, signal: abort.signal,
          })).then((r) => (r?.ok ? r.json() : null)).catch(() => null);
          if (snap?.restarted && snap.last_result && typeof snap.last_result === 'object') {
            const lr = snap.last_result;
            child.stdout.write(`${JSON.stringify({
              type: 'result',
              ok: lr.status === 'done',
              answer: String(lr.summary || 'Recovered final result after LightCode restarted').slice(0, 12_000),
              ...(lr.stop_reason ? { stop_reason: lr.stop_reason } : {}),
              ...(Array.isArray(lr.questions) && lr.questions.length ? { questions: lr.questions.map((q) => (typeof q === 'string' ? { question: q } : q)) } : {}),
              ...(lr.risk ? { risk: { level: lr.risk, auto_merge_ok: lr.auto_merge_ok === true, reasons: [] } } : {}),
              ...(typeof lr.fix_rounds === 'number' ? { fix_rounds: lr.fix_rounds } : {}),
              ...(typeof lr.cost_usd === 'number' ? { usage: { cost_usd: lr.cost_usd } } : {}),
              ...(typeof lr.duration_ms === 'number' ? { duration_ms: lr.duration_ms } : {}),
              restarted: true,
            })}\n`);
            state.finished = true;
            break;
          }
          failLine('LightCode lost this job (it was restarted) — the work in the folder is kept', 'turn_lost');
          close(1);
          return;
        }
        if (!again.ok) continue;
        await consume(again).catch(() => undefined);
      } catch { /* thử lại */ }
    }
    if (abort.signal.aborted) return;
    close(state.finished ? 0 : 1);
  };
  return { child, abort, state, close, failLine, consume, followUntilDone };
}

/**
 * "Tiến trình" của một lượt LightCode: stdin nhận đề bài, stdout là NDJSON của LightCode, kill = dừng lượt (gọi `/sessions/:id/stop`),
 * `close` khi lượt xong / bị dừng. Lỗi trước khi LightCode nhận việc → một dòng `result` lỗi để runner có câu trả lời rõ ràng.
 *
 * Giao thức 2: job tách khỏi kết nối (`detach`) — rớt mạng / daemon khởi động lại không giết agent đang làm dở; mỗi sự kiện có `seq`,
 * nối lại bằng `GET /sessions/:id/events?from=<seq kế>` không mất dòng nào. LightCode bản cũ (không báo protocol ≥ 2) → như trước:
 * đóng kết nối = dừng lượt, không nối lại.
 */
export function spawnLightcodeTurn(argv, opts = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const ensure = deps.ensure || ensureLightcodeRunning;
  const peek = deps.peek || (() => readConnector(deps));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { child, abort, state, close, failLine, consume, followUntilDone } = createTurnShell({ fetchImpl, peek, sleep });

  let job = {};
  const i = argv.indexOf(JOB_FLAG);
  try { job = i >= 0 ? JSON.parse(argv[i + 1]) : {}; } catch { job = {}; }
  let prompt = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (d) => { prompt += d; });
  child.stdin.on('end', () => {
    void (async () => {
      try {
        const info = await ensure();
        state.target = info;
        if (abort.signal.aborted) return;
        if (Number(info.min_client_protocol) > CLIENT_PROTOCOL) {
          failLine(`LightCode on this computer requires bridge protocol ${info.min_client_protocol}, but Aivin CLI speaks protocol ${CLIENT_PROTOCOL} — update Aivin CLI`, 'protocol_mismatch');
          close(1);
          return;
        }
        const detach = Number(info.protocol ?? 1) >= 2;
        const source = { name: 'AIVIN', ...contractInfoFromPrompt(prompt) };
        const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.key}` },
          body: JSON.stringify({
            cwd: opts.cwd, prompt, mode: job.mode, ...(job.model ? { model: job.model } : {}), ...(job.effort ? { effort: job.effort } : {}),
            ...(job.provider ? { provider: job.provider } : {}),
            ...(job.resume ? { resume: job.resume } : {}), add_dirs: job.addDirs || [], allowed_tools: job.allowedTools || [],
            deny_rules: job.deny || [], source, headless: true,
            // Cổng AI tạm theo từng job (chỉ trong body loopback — không env / đĩa / log); kiểm hạn lại lúc gửi, hết hạn thì bỏ.
            ...(gatewayFor(job) ? { ai_gateway: gatewayFor(job) } : {}),
            // Tài khoản Linux của thành viên: LightCode chạy CLI của job dưới uid này (không rơi về daemon).
            ...(job.runAs ? { run_as: job.runAs } : {}),
            ...(detach && job.acceptance?.length ? { acceptance: job.acceptance } : {}),
            ...(detach && job.constraints?.length ? { constraints: job.constraints } : {}),
            ...(detach && job.verify?.length ? { verify: job.verify } : {}),
            ...(detach && job.clientJobId ? { client_job_id: job.clientJobId } : {}),
            ...(detach && job.goalId ? { goal_id: job.goalId } : {}),
            ...(detach && job.dependsOn?.length ? { depends_on: job.dependsOn } : {}),
            ...(detach && Number.isInteger(job.maxFixRounds) && job.maxFixRounds > 0 ? { max_fix_rounds: job.maxFixRounds } : {}),
            ...(detach && job.deliverables?.length ? { deliverables: job.deliverables } : {}),
            ...(detach ? {
              detach: true, orphan_ms: ORPHAN_MS, on_question: job.clarify ? 'stop' : 'assume',
              ...(job.maxCost > 0 ? { max_cost_usd: job.maxCost } : {}),
            } : {}),
          }),
          signal: abort.signal,
        });
        if (!res.ok) {
          let err = `LightCode answered ${res.status}`;
          let code = 'error';
          try { const b = await res.json(); err = b.error || err; code = b.code || code; } catch { /* không phải JSON */ }
          failLine(err, code);
          close(1);
          return;
        }
        await consume(res).catch(() => undefined);
        await followUntilDone({ detach });
      } catch (e) {
        if (abort.signal.aborted) { close(null); return; }
        failLine(e?.message || String(e), e?.code === DeviceErrorCode.NOT_FOUND ? 'not_installed' : 'error');
        close(1);
      }
    })();
  });
  return child;
}

/**
 * Nối lại vào một lượt LightCode đang chạy (hoặc vừa chạy xong) sau khi tiến trình AIVIN CLI khởi động lại.
 * Cửa cục bộ LightCode không mở hoặc là bản giao thức cũ (< 2) → trả null để runner đánh dấu `interrupted` như trước.
 */
export function reattachLightcodeTurn({ sessionId, lastSeq = -1 } = {}, deps = {}) {
  const peek = deps.peek || (() => readConnector(deps));
  const initial = peek();
  if (!sessionId || !initial || Number(initial.protocol ?? 1) < 2) return null;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { child, abort, close, failLine, followUntilDone } = createTurnShell({
    fetchImpl, peek, sleep, initialSessionId: sessionId, initialLastSeq: Number.isInteger(lastSeq) ? lastSeq : -1, initialTarget: initial,
  });
  setImmediate(() => {
    void followUntilDone({ detach: true, immediate: true }).catch((e) => {
      if (abort.signal.aborted) { close(null); return; }
      failLine(e?.message || String(e), 'connection_lost');
      close(1);
    });
  });
  return child;
}

/** Tài khoản AI LightCode đã dùng — chỉ gửi dấu băm lên Aivin (như `local_llm.accounts`), không gửi email. */
export const accountTag = (account) => `acc_${createHash('sha256').update(String(account).trim().toLowerCase()).digest('hex').slice(0, 16)}`;

export const LIGHTCODE_ADAPTER = Object.freeze({
  id: 'lightcode',
  label: 'LightCode',
  /** Daemon dựng worktree (`.aivin-worktrees/<job>`); LightCode chạy phiên trong thư mục đó và nhận nó là một phần của dự án. */
  selfWorktree: false,
  /** session_id do LightCode cấp (UUID) — vòng sửa nói tiếp đúng phiên, trên tài khoản nào còn hạn mức. */
  resumable: true,
  /** Không có tài khoản riêng theo hồ sơ — LightCode tự quản nhiều tài khoản + chuyển dự phòng. */
  profileEnv: null,
  /**
   * Cloud Computer (nhiều thành viên): chỉ khi bật cờ AIVIN_LIGHTCODE_ORG_JOBS=1 (mặc định TẮT — xem LIGHTCODE_ORG_JOBS_ENV).
   * Tắt → runAs lọc LightCode ra, org dùng đường Claude Code / Codex cũ.
   * Bật → job LUÔN phải kèm runAs của thành viên (args() từ chối nếu thiếu) — không bao giờ chạy dưới tài khoản daemon.
   */
  get multiUser() { return lightcodeOrgJobsEnabled(); },
  /** LightCode tự chạy CLI dưới tài khoản thành viên (`run_as`): runner theo thành viên dùng spawn của adapter, không bọc bằng memberSpawner. */
  memberAware: true,
  candidates: () => [],
  /**
   * Có LightCode (đang chạy, hoặc đã cài — bật lên lúc giao việc) → coi như agent đã cài; cờ cố định của adapter.
   * Headless container: kiểm connector của daemon trước; không cần exe LightCode và không giới hạn platform Windows.
   */
  locate(opts = {}) {
    // Headless daemon trong container: chỉ khi cờ bật (mặc định tắt) — kiểm connector của aivin-lc trước
    const headless = lightcodeOrgJobsEnabled(opts.env || process.env) ? readHeadlessConnector(opts) : null;
    if (headless) return { bin: 'lightcode', version: headless.app_version || '0.0.0', flags: [JOB_FLAG], headless: true };
    // Desktop Windows (thành viên dùng LightCode cá nhân): giữ nguyên hành vi cũ
    if ((opts.platform || process.platform) !== 'win32' && !readConnector(opts)) return null;
    const st = lightcodeLocalStatus(opts);
    if (!st.installed) return null;
    return { bin: 'lightcode', version: st.version || '0.0.0', flags: [JOB_FLAG] };
  },
  args({
    mode, resume, model, effort, addDirs = [], allowedTools = [], settings, budgetUsd, clarify, provider, acceptance, constraints,
    verify, clientJobId, goalId, dependsOn, maxFixRounds, deliverables, aiGateway, runAs,
  }) {
    const deny = settings?.permissions?.deny || [];
    // `provider` = agent bên trong LightCode (claude | codex | gemini…); LightCode tự kiểm — sai tên thì để LightCode chọn.
    const inner = provider && /^[a-z]{3,20}$/.test(String(provider)) ? String(provider) : undefined;
    const fixRounds = Number.isInteger(Number(maxFixRounds)) ? Math.min(3, Math.max(0, Number(maxFixRounds))) : 0;
    const normDeliverables = normalizeDeliverablesArg(deliverables);
    const gateway = normalizeAiGateway(aiGateway);
    // Cloud Computer (cờ bật): thiếu runAs → từ chối, không chạy dưới daemon. Ngoài chế độ đó runAs (nếu có) vẫn được chuyển đi.
    if (lightcodeOrgJobsEnabled() && (runAs === undefined || runAs === null)) {
      throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, "LightCode on an organisation computer needs the member's account (runAs) — refusing to run under the daemon account");
    }
    const member = runAs === undefined || runAs === null ? undefined : normalizeRunAs(runAs);
    const deps = Array.isArray(dependsOn) ? dependsOn.map((d) => String(d ?? '').trim()).filter(Boolean).slice(0, 20) : [];
    return [JOB_FLAG, JSON.stringify({
      mode, ...(resume ? { resume } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), addDirs, allowedTools, deny,
      ...(Number(budgetUsd) > 0 ? { maxCost: Number(budgetUsd) } : {}), ...(clarify ? { clarify: true } : {}), ...(inner ? { provider: inner } : {}),
      // Hợp đồng (bàn giao khoán): LightCode tự đối chiếu và trả `verdict` — daemon vẫn là bên đo cuối cùng.
      ...(Array.isArray(acceptance) && acceptance.length ? { acceptance: acceptance.map(String).slice(0, 40) } : {}),
      ...(Array.isArray(constraints) && constraints.length ? { constraints: constraints.map(String).slice(0, 40) } : {}),
      ...(Array.isArray(verify) && verify.length ? { verify: verify.map(String).slice(0, 12) } : {}),
      ...(clientJobId ? { clientJobId: String(clientJobId).trim().slice(0, 120) } : {}),
      ...(goalId ? { goalId: String(goalId).trim().slice(0, 60) } : {}),
      ...(deps.length ? { dependsOn: deps } : {}),
      ...(fixRounds > 0 ? { maxFixRounds: fixRounds } : {}),
      ...(normDeliverables.length ? { deliverables: normDeliverables } : {}),
      ...(gateway ? { aiGateway: gateway } : {}),
      ...(member ? { runAs: member } : {}),
    })];
  },
  spawn: (bin, argv, opts) => {
    // Headless container: dung readHeadlessConnector lam peek/ensure de khong can exe LightCode tren Linux.
    if (lightcodeOrgJobsEnabled()) {
      // Chặn lần cuối: argv không có runAs hợp lệ thì không chạm tới daemon (args() đã kiểm; đây là lưới an toàn cho đường gọi trực tiếp).
      let job = {};
      try { job = JSON.parse(argv[argv.indexOf(JOB_FLAG) + 1]); } catch { /* thiếu → từ chối ở dưới */ }
      normalizeRunAs(job?.runAs);
      return spawnLightcodeTurn(argv, opts, {
        peek: () => readHeadlessConnector(),
        ensure: () => {
          const c = readHeadlessConnector();
          if (c) return Promise.resolve(c);
          return Promise.reject(new DeviceToolError(DeviceErrorCode.NOT_FOUND, 'LightCode headless daemon is not running in this container'));
        },
      });
    }
    return spawnLightcodeTurn(argv, opts);
  },
  reattach: (job, deps) => reattachLightcodeTurn({ sessionId: job?.session_id, lastSeq: Number.isInteger(job?.last_seq) ? job.last_seq : -1 }, deps),
  /** Một dòng NDJSON của LightCode → cập nhật việc; trả đoạn chữ đáng đẩy lên Aivin. */
  parse(job, msg) {
    if (Number.isInteger(msg.seq) && (job.last_seq === undefined || msg.seq > job.last_seq)) job.last_seq = msg.seq;
    if (msg.type === 'init') {
      if (msg.session_id && !job.session_id) job.session_id = msg.session_id;
      job.lightcode = { thread_id: msg.thread_id, project_id: msg.project_id, version: msg.app_version, protocol: msg.protocol };
      return '';
    }
    if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) { job.texts.push(msg.text); return msg.text; }
    if (msg.type === 'tool' && typeof msg.text === 'string') { job.tools.push(msg.text.slice(0, 200)); return msg.text; }
    if (msg.type === 'status' && typeof msg.text === 'string') return `⏳ ${msg.text}`;
    if (msg.type === 'progress' && msg.progress && typeof msg.progress === 'object') {
      const p = msg.progress;
      job.progress = {
        files_changed: p.files_changed, files: Array.isArray(p.files) ? p.files.slice(0, 30) : [], insertions: p.insertions, deletions: p.deletions,
        tool_calls: p.tool_calls, tests_run: p.tests_run, elapsed_ms: p.elapsed_ms, ...(p.violations?.length ? { violations: p.violations.slice(0, 20) } : {}),
      };
      return `📊 ${p.files_changed ?? 0} file(s) changed (+${p.insertions ?? 0}/-${p.deletions ?? 0}), ${p.tests_run ?? 0} test run(s)`;
    }
    if (msg.type === 'question' && Array.isArray(msg.questions)) {
      job.questions = [...(job.questions || []), ...msg.questions].slice(0, 12);
      return `❓ ${msg.questions.map((q) => q.question).join(' / ').slice(0, 300)}`;
    }
    if (msg.type === 'intervention') {
      job.intervened = true;
      return `👤 A person took part in LightCode: ${String(msg.text || '').slice(0, 160)}`;
    }
    if (msg.type === 'result') {
      job.result = {
        ok: msg.ok === true, answer: String(msg.answer ?? '').slice(0, 12_000),
        ...(msg.provider ? { provider: msg.provider } : {}), ...(msg.account ? { account: accountTag(msg.account) } : {}),
        ...(msg.agent ? { inner_agent: msg.agent } : {}),
        ...(typeof msg.duration_ms === 'number' ? { duration_ms: msg.duration_ms } : {}),
        ...(msg.stop_reason ? { stop_reason: msg.stop_reason } : {}),
        ...(msg.usage && typeof msg.usage.cost_usd === 'number' ? { cost_usd: msg.usage.cost_usd, usage: { cost_usd: msg.usage.cost_usd, tokens: msg.usage.tokens, ...(msg.usage.approx ? { approx: true } : {}) } } : {}),
        ...(Array.isArray(msg.quota) && msg.quota.length ? {
          quota: msg.quota.slice(0, 6).filter((q) => q && typeof q === 'object').map((q) => ({
            provider: String(q.provider || ''),
            ...(typeof q.five_hour_used_pct === 'number' ? { five_hour_used_pct: q.five_hour_used_pct } : {}),
            ...(typeof q.weekly_used_pct === 'number' ? { weekly_used_pct: q.weekly_used_pct } : {}),
            ...(typeof q.resets_at === 'string' ? { resets_at: q.resets_at } : {}),
            ...(q.account ? { account: accountTag(q.account) } : {}),
          })),
        } : {}),
        ...(Array.isArray(msg.questions) && msg.questions.length ? { questions: msg.questions.slice(0, 12) } : job.questions?.length ? { questions: job.questions } : {}),
        ...(Array.isArray(msg.violations) && msg.violations.length ? { violations: msg.violations.slice(0, 20) } : {}),
        ...(msg.intervened || job.intervened ? { intervened: true } : {}),
        ...(msg.restarted ? { restarted: true } : {}),
        ...(msg.verdict && typeof msg.verdict === 'object' ? { verdict: slimVerdict(msg.verdict) } : {}),
        ...(slimRisk(msg.risk) ? { risk: slimRisk(msg.risk) } : {}),
        ...(slimGoal(msg.goal) ? { goal: slimGoal(msg.goal) } : {}),
        ...(slimGit(msg.git) ? { git: slimGit(msg.git) } : {}),
        ...(typeof msg.fix_rounds === 'number' && msg.fix_rounds > 0 ? { fix_rounds: msg.fix_rounds } : {}),
        ...(Array.isArray(msg.permission_denials) && msg.permission_denials.length ? { permission_denials: msg.permission_denials.slice(0, 20) } : {}),
      };
      if (msg.progress) job.progress = job.progress ? { ...job.progress, ...msg.progress } : msg.progress;
      if (msg.provider) job.model = msg.model ? `${msg.provider}:${msg.model}` : msg.provider;
    }
    return '';
  },
});

// --- Cài đặt -------------------------------------------------------------------------------------------------------------------------

/** `latest.yml` của electron-builder → { version, file, sha512, size }. */
export function parseLatestYml(text) {
  const get = (k) => new RegExp(`^${k}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'm').exec(String(text || ''))?.[1]?.trim();
  const version = get('version');
  const file = get('path');
  const sha512 = get('sha512');
  const size = Number(/^\s+size:\s*(\d+)/m.exec(String(text || ''))?.[1]) || undefined;
  if (!version || !file || !sha512 || !/^[\w.-]+\.exe$/i.test(file)) return null;
  return { version, file, sha512, ...(size ? { size } : {}) };
}

async function downloadVerified(url, dest, sha512, { fetchImpl = globalThis.fetch, onProgress, signal } = {}) {
  const res = await fetchImpl(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new DeviceToolError(DeviceErrorCode.NOT_FOUND, `Download failed (${res.status}) ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const hash = createHash('sha512');
  let got = 0;
  let shown = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > MAX_INSTALLER_BYTES) throw invalid('The LightCode installer is larger than expected — stopped');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress && got - shown > 10 * 1024 * 1024) { shown = got; onProgress(got); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    try { fs.rmSync(tmp, { force: true }); } catch { /* bỏ qua */ }
    throw e;
  }
  if (hash.digest('base64') !== sha512) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* bỏ qua */ }
    throw invalid('The downloaded LightCode installer does not match its published checksum — not installed');
  }
  fs.renameSync(tmp, dest);
  return got;
}

/**
 * Kiểm tra chữ ký Authenticode của bộ cài Windows qua PowerShell (truyền đường dẫn qua biến môi trường, không nội suy chuỗi).
 * Chữ ký bị hỏng / không tin cậy (`HashMismatch`, `NotTrusted`…) luôn bị chặn; tệp chưa ký (`NotSigned`) chỉ chặn khi yêu cầu bắt buộc chữ ký
 * hoặc có cấu hình tên nhà phát hành kỳ vọng.
 */
export function verifyInstallerSignature(filePath, { execFileImpl = execFile, requireSignature = false, expectedPublisher = '' } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = "$s = Get-AuthenticodeSignature -LiteralPath $env:AIVIN_SIG_FILE; [pscustomobject]@{ status = [string]$s.Status; subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { '' }; thumbprint = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Thumbprint } else { '' } } | ConvertTo-Json -Compress";
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8', timeout: SIG_CHECK_TIMEOUT_MS, windowsHide: true, env: { ...process.env, AIVIN_SIG_FILE: filePath },
    }, (err, stdout) => {
      if (err) {
        if (requireSignature || expectedPublisher) return reject(invalid(`Could not verify the LightCode installer signature: ${err.message}`));
        return resolve({ status: 'CheckUnavailable' });
      }
      let sig;
      try { sig = JSON.parse(String(stdout || '').trim()); } catch { sig = null; }
      const status = String(sig?.status || 'Unknown');
      const subject = String(sig?.subject || '');
      const thumbprint = String(sig?.thumbprint || '');
      if (status === 'Valid') {
        if (expectedPublisher && !subject.toLowerCase().includes(String(expectedPublisher).toLowerCase())) {
          return reject(invalid(`The LightCode installer signature belongs to "${subject || 'unknown'}", not "${expectedPublisher}" — not installed`));
        }
        return resolve({ status, ...(subject ? { subject } : {}), ...(thumbprint ? { thumbprint } : {}) });
      }
      if (status === 'NotSigned') {
        if (requireSignature || expectedPublisher) {
          return reject(invalid('The downloaded LightCode installer is not digitally signed — not installed'));
        }
        return resolve({ status });
      }
      return reject(invalid(`The LightCode installer has an invalid signature (${status}) — not installed`));
    });
  });
}

/**
 * Cài LightCode bằng bộ cài chính thức (NSIS, một người dùng, chạy im lặng `/S`) từ lightcode.live, kiểm SHA-512 theo `latest.yml` + chữ ký
 * Authenticode trên Windows, rồi bật ứng dụng và chờ cửa cục bộ. Đã cài → chỉ bật. Chỉ Windows (LightCode chưa có bản macOS / Linux).
 */
export async function installLightcode(args = {}, ctx = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') throw invalid('LightCode is only available for Windows for now');
  const say = (t) => { try { ctx.onOutput?.(`${t}\n`); } catch { /* chỉ là tiến trình */ } };
  const before = lightcodeLocalStatus(deps);
  if (before.installed && !args.reinstall) {
    say('LightCode is already installed — starting it.');
    const info = await (deps.ensure || ensureLightcodeRunning)(deps);
    const issue = await lightcodeReadiness({ ...deps, connector: info }).catch(() => null);
    return { installed: true, already: true, running: true, version: info.app_version, protocol: info.protocol ?? 1, agent: LIGHTCODE_ADAPTER.id, ...(issue ? { issue } : {}) };
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const base = (process.env.AIVIN_LIGHTCODE_RELEASES || LIGHTCODE_RELEASES_URL).replace(/\/+$/, '');
  say(`Checking the latest LightCode release (${base}/latest.yml)…`);
  const ymlRes = await fetchImpl(`${base}/latest.yml`, { signal: ctx.signal });
  if (!ymlRes.ok) throw notFound(`Cannot read ${base}/latest.yml (${ymlRes.status})`);
  const latest = parseLatestYml(await ymlRes.text());
  if (!latest) throw invalid('latest.yml of LightCode is not in the expected format');
  const dest = path.join(deps.downloadDir || DOWNLOAD_DIR, latest.file);
  say(`Downloading LightCode ${latest.version}${latest.size ? ` (${Math.round(latest.size / 1024 / 1024)} MB)` : ''}…`);
  await downloadVerified(`${base}/${encodeURIComponent(latest.file)}`, dest, latest.sha512, {
    fetchImpl, signal: ctx.signal, onProgress: (n) => say(`  ${Math.round(n / 1024 / 1024)} MB`),
  });
  const requireSignature = args.require_signature === true || process.env.AIVIN_LIGHTCODE_REQUIRE_SIGNATURE === '1';
  const expectedPublisher = String(args.expected_publisher || process.env.AIVIN_LIGHTCODE_PUBLISHER || '').trim();
  const verifySig = deps.verifySignature || ((p) => verifyInstallerSignature(p, { execFileImpl: deps.execFileImpl, requireSignature, expectedPublisher }));
  let signature;
  try {
    signature = await verifySig(dest);
  } catch (e) {
    try { fs.rmSync(dest, { force: true }); } catch { /* bỏ qua */ }
    throw e;
  }
  say(`Checksum OK (signature: ${signature?.status || 'checked'}) — installing silently…`);
  const spawnImpl = deps.spawnImpl || spawn;
  const code = await new Promise((resolve, reject) => {
    const child = spawnImpl(dest, ['/S'], { windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => { try { child.kill(); } catch { /* đã thoát */ } reject(invalid('The LightCode installer did not finish within 10 minutes')); }, INSTALL_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (c) => { clearTimeout(t); resolve(c); });
  });
  if (code !== 0) throw invalid(`The LightCode installer exited with code ${code}`);
  try { fs.rmSync(dest, { force: true }); } catch { /* để lại cũng được */ }
  say('Installed — starting LightCode…');
  const info = await (deps.ensure || ensureLightcodeRunning)(deps);
  // Cài mới = chưa đăng nhập tài khoản AI nào: báo để BE không giao việc cho nó trước khi người dùng đăng nhập.
  const issue = await lightcodeReadiness({ ...deps, connector: info }).catch(() => null);
  return {
    ...(issue ? { issue } : {}),
    installed: true, running: true, version: info.app_version || latest.version, protocol: info.protocol ?? 1, agent: LIGHTCODE_ADAPTER.id,
    ...(signature ? { signature } : {}),
    note: 'LightCode starts with a free trial. The person signs in to their AI accounts (Claude, Codex, Gemini…) once inside LightCode; Aivin then gives coding jobs to agent "lightcode".',
  };
}

export async function lightcodeStatus(deps = {}) {
  const info = deps.connector || readConnector(deps);
  const st = deps.connector
    ? {
      ...lightcodeLocalStatus(deps),
      installed: true,
      running: true,
      ...(info.app_version ? { version: info.app_version } : {}),
      ...(info.protocol ? { protocol: info.protocol } : {}),
    }
    : lightcodeLocalStatus(deps);
  if (!st.running || !info) return { ...st, client_protocol: CLIENT_PROTOCOL, site: LIGHTCODE_SITE };
  try {
    const res = await (deps.fetchImpl || globalThis.fetch)(`http://127.0.0.1:${info.port}/connector/v1/info`, { headers: { Authorization: `Bearer ${info.key}` } });
    const body = res.ok ? await res.json() : null;
    const protocol = body?.protocol ?? info.protocol ?? 1;
    const minClient = body?.min_client_protocol ?? 1;
    return {
      ...st, site: LIGHTCODE_SITE, client_protocol: CLIENT_PROTOCOL, protocol, min_client_protocol: minClient,
      protocol_ok: CLIENT_PROTOCOL >= minClient,
      ...(body ? {
        can_run: body.can_run, providers: body.providers, accounts: body.accounts, license: body.license,
        ...(Array.isArray(body.features) ? { features: body.features } : {}),
        ...(body.capacity ? { capacity: body.capacity } : {}),
      } : {}),
    };
  } catch { return { ...st, client_protocol: CLIENT_PROTOCOL, site: LIGHTCODE_SITE }; }
}

/**
 * LightCode đã cài + đang chạy nhưng chưa dùng được → lý do (để BE đừng giao việc cho nó rồi thất bại ngay lượt đầu); dùng được / chưa biết → null.
 * `no_account` = chưa đăng nhập tài khoản AI nào trong LightCode · `license_expired` = hết bản dùng thử / chưa có bản quyền · `protocol_mismatch` = CLI cũ quá.
 * Hết hạn mức tạm thời KHÔNG tính: LightCode tự đợi / chuyển tài khoản.
 */
export async function lightcodeReadiness(deps = {}) {
  const st = await lightcodeStatus(deps);
  if (!st.running || st.protocol === undefined) return null;
  if (st.protocol_ok === false) return 'protocol_mismatch';
  if (st.can_run === false) return 'license_expired';
  if (st.accounts === 0) return 'no_account';
  return null;
}

const schema = (properties, required = []) => ({ type: 'object', properties, required });
const DEPLOY_WAIT_DEFAULT_MS = 5_000;
const DEPLOY_WAIT_MAX_MS = 60_000;
const DEPLOY_POLL_MS = 1_500;

function resolveOptionalCwd(rawCwd, roots) {
  const cwd = String(rawCwd || '').trim();
  if (!cwd) return undefined;
  return Array.isArray(roots) && roots.length ? resolveInRoots(roots, cwd) : path.resolve(cwd);
}

/** Đọc fallback `.lcagent/worklog.jsonl` trên đĩa khi LightCode đang tắt nhưng vẫn có thư mục dự án. */
function readWorklogFromDisk(cwd, { since, limit = 20, source } = {}) {
  const file = path.join(cwd, '.lcagent', 'worklog.jsonl');
  if (!fs.existsSync(file)) return [];
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e || typeof e.id !== 'string' || typeof e.at !== 'string') continue;
      if (since && e.at < since) continue;
      if (source && e.source !== source) continue;
      entries.push(e);
    } catch { /* bỏ qua dòng hỏng */ }
  }
  return entries.slice(-limit).reverse();
}

/** Đọc fallback `.lcagent/workflow.json` trên đĩa khi LightCode đang tắt. */
function readDeployInfoFromDisk(cwd) {
  const file = path.join(cwd, '.lcagent', 'workflow.json');
  if (!fs.existsSync(file)) return { configured: false, parts: [], environments: [], recent_runs: [], pending_requests: [] };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const envs = Array.isArray(raw?.environments) ? raw.environments : [];
  const ext = process.platform === 'win32' ? '.ps1' : '.sh';
  return {
    configured: true,
    parts: Array.isArray(raw?.parts) ? raw.parts : [],
    environments: envs.map((e) => ({
      id: e.id, name: e.name, tier: e.tier, ...(e.url ? { url: e.url } : {}), approval: !!e.approval,
      ...(e.owner ? { owner: e.owner } : {}), ...(e.ownerRole ? { owner_role: e.ownerRole } : {}),
      has_recipe: fs.existsSync(path.join(cwd, '.lcagent', 'deploy', `${e.id}.md`)),
      has_script: fs.existsSync(path.join(cwd, '.lcagent', 'deploy', `${e.id}${ext}`)),
      running: false,
      targets: Array.isArray(e.targets) ? e.targets : [],
    })),
    recent_runs: [],
    pending_requests: [],
  };
}

/** Đọc báo cáo kết quả công việc của các trợ lý AI trên LightCode (cả phiên đã xong lẫn đang chạy). */
export async function lightcodeWorklog(args = {}, deps = {}) {
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  const projectId = args.project_id ? String(args.project_id).trim() : undefined;
  const since = args.since ? String(args.since).trim() : undefined;
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const source = args.source === 'user' || args.source === 'aivin' ? args.source : undefined;
  const info = deps.connector || readConnector(deps);
  if (!info) {
    if (cwd) return { running: false, fallback: 'disk', cwd, entries: readWorklogFromDisk(cwd, { since, limit, source }), active_sessions: [] };
    return { running: false, entries: [], active_sessions: [], note: 'LightCode is not running — pass cwd of a project folder to read .lcagent/worklog.jsonl directly, or open LightCode.' };
  }
  const q = new URLSearchParams();
  if (cwd) q.set('cwd', cwd);
  if (projectId) q.set('project_id', projectId);
  if (since) q.set('since', since);
  q.set('limit', String(limit));
  if (source) q.set('source', source);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/worklog?${q.toString()}`, {
    headers: { Authorization: `Bearer ${info.key}` },
  });
  if (!res.ok) {
    let err = `LightCode answered ${res.status}`;
    try { const b = await res.json(); err = b.error || err; } catch { /* bỏ qua */ }
    if (res.status === 404 && cwd) return { running: true, fallback: 'disk', cwd, entries: readWorklogFromDisk(cwd, { since, limit, source }), active_sessions: [] };
    throw new DeviceToolError(res.status === 404 ? DeviceErrorCode.NOT_FOUND : DeviceErrorCode.INVALID_ARGS, err);
  }
  const body = await res.json();
  return { running: true, ...body };
}

/** Xem cấu hình quy trình phát hành, lịch sử phát hành của dự án, hoặc tiến độ một phiên phát hành cụ thể (`thread_id`). */
export async function lightcodeDeployInfo(args = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const info = deps.connector || readConnector(deps);
  const threadId = args.thread_id ? String(args.thread_id).trim() : '';
  if (threadId) {
    if (!info) throw notFound('LightCode is not running — cannot read deploy session status');
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/deploy/runs/${encodeURIComponent(threadId)}`, {
      headers: { Authorization: `Bearer ${info.key}` },
    });
    if (!res.ok) {
      let err = `LightCode answered ${res.status}`;
      try { const b = await res.json(); err = b.error || err; } catch { /* bỏ qua */ }
      throw new DeviceToolError(res.status === 404 ? DeviceErrorCode.NOT_FOUND : DeviceErrorCode.INVALID_ARGS, err);
    }
    return { running: true, ...(await res.json()) };
  }
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  const projectId = args.project_id ? String(args.project_id).trim() : undefined;
  if (!cwd && !projectId) throw invalid('Give cwd (project folder) or project_id (or thread_id to check a running deploy)');
  if (!info) {
    if (cwd) return { running: false, fallback: 'disk', cwd, ...readDeployInfoFromDisk(cwd) };
    throw notFound('LightCode is not running — pass cwd of the project folder or open LightCode');
  }
  const q = new URLSearchParams();
  if (cwd) q.set('cwd', cwd);
  if (projectId) q.set('project_id', projectId);
  const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/deploy/info?${q.toString()}`, {
    headers: { Authorization: `Bearer ${info.key}` },
  });
  if (!res.ok) {
    let err = `LightCode answered ${res.status}`;
    try { const b = await res.json(); err = b.error || err; } catch { /* bỏ qua */ }
    if (res.status === 404 && cwd) return { running: true, fallback: 'disk', cwd, ...readDeployInfoFromDisk(cwd) };
    throw new DeviceToolError(res.status === 404 ? DeviceErrorCode.NOT_FOUND : DeviceErrorCode.INVALID_ARGS, err);
  }
  return { running: true, ...(await res.json()) };
}

/** Đọc danh sách SSH host đã lưu trên LightCode, alias trong ~/.ssh/config và các nền tảng deploy được hỗ trợ (không bao giờ trả bí mật). */
export async function lightcodeDeployHosts(deps = {}) {
  const info = deps.connector || readConnector(deps);
  if (!info) return { running: false, hosts: [], ssh_config: [], adapters: [], note: 'LightCode is not running — open LightCode to list saved deploy hosts.' };
  const body = await connectorJson(info, '/connector/v1/deploy/hosts', {}, deps);
  return { running: true, ...body };
}

/**
 * Tạo hoặc cập nhật quy trình deploy `.lcagent/workflow.json` trên LightCode cho dự án (kể cả dự án mới chưa từng cấu hình).
 * KHÔNG chạy deploy thật — chỉ lưu cấu hình và để LightCode chuẩn bị sẵn kịch bản; sau đó gọi `lightcode.deploy` khi người dùng xác nhận.
 */
export async function lightcodeDeploySetup(args = {}, ctx = {}, deps = {}) {
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  const projectId = args.project_id ? String(args.project_id).trim() : undefined;
  if (!cwd && !projectId) throw invalid('Give cwd (project folder) or project_id');
  const info = deps.connector || await (deps.ensure || ensureLightcodeRunning)(deps);
  let environments = Array.isArray(args.environments) ? args.environments : undefined;
  // Lối tắt cho 1 môi trường: truyền trực tiếp env_name / where / host_id / adapter / url / notes.
  if (!environments && (args.env_name || args.env_id || args.where || args.host_id || args.host || args.adapter || args.url)) {
    const tier = ['test', 'staging', 'live'].includes(String(args.tier || '')) ? String(args.tier) : 'live';
    const name = String(args.env_name || (tier === 'live' ? 'Production' : tier === 'staging' ? 'Staging' : 'Test')).trim();
    const target = {
      ...(args.where ? { where: String(args.where) } : {}),
      ...(args.host_id ? { host_id: String(args.host_id) } : {}),
      ...(args.host ? { host: String(args.host) } : {}),
      ...(args.adapter ? { adapter: String(args.adapter) } : {}),
    };
    environments = [{
      ...(args.env_id ? { id: String(args.env_id) } : {}),
      name,
      tier,
      targets: Object.keys(target).length ? [target] : [],
      ...(args.url ? { url: String(args.url) } : {}),
      ...(args.owner ? { owner: String(args.owner) } : {}),
      ...(args.notes ? { notes: String(args.notes) } : {}),
      ...(typeof args.approval === 'boolean' ? { approval: args.approval } : {}),
    }];
  }
  const payload = {
    ...(cwd ? { cwd } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(Array.isArray(args.parts) ? { parts: args.parts } : {}),
    ...(environments ? { environments } : {}),
    ...(args.auto === true ? { auto: true } : {}),
    ...(typeof args.merge === 'boolean' ? { merge: args.merge } : {}),
    ...(args.lang ? { lang: String(args.lang) } : {}),
  };
  const body = await connectorJson(info, '/connector/v1/deploy/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctx.signal,
  }, deps);
  return { running: true, ...body };
}

/** Kích hoạt phát hành theo đúng quy trình LightCode đã thiết lập cho dự án (cần người dùng xác nhận trước). */
export async function lightcodeDeploy(args = {}, ctx = {}, deps = {}) {
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  const projectId = args.project_id ? String(args.project_id).trim() : undefined;
  if (!cwd && !projectId) throw invalid('Give cwd (project folder) or project_id');
  const envIds = Array.isArray(args.envs) ? args.envs.map(String)
    : Array.isArray(args.env_ids) ? args.env_ids.map(String)
    : args.env ? [String(args.env)]
    : args.env_id ? [String(args.env_id)]
    : [];
  if (!envIds.length) throw invalid('Specify which environment to deploy (env or envs) — check lightcode.deploy_info first');
  const info = deps.connector || await (deps.ensure || ensureLightcodeRunning)(deps);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.key}` },
    body: JSON.stringify({
      ...(cwd ? { cwd } : {}), ...(projectId ? { project_id: projectId } : {}),
      env_ids: envIds,
      ...(Array.isArray(args.parts) && args.parts.length ? { parts: args.parts.map(String) } : {}),
      ...(args.note ? { note: String(args.note).slice(0, 1000) } : {}),
    }),
    signal: ctx.signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const avail = Array.isArray(body?.available_envs) ? ` (available: ${body.available_envs.map((e) => `${e.id} [${e.name}]`).join(', ')})` : '';
    throw new DeviceToolError(res.status === 404 ? DeviceErrorCode.NOT_FOUND : DeviceErrorCode.INVALID_ARGS, `${body?.error || `LightCode answered ${res.status}`}${avail}`);
  }
  const runs = Array.isArray(body?.runs) ? body.runs : [];
  const waitMs = Math.min(DEPLOY_WAIT_MAX_MS, Math.max(0, Number(args.wait_ms ?? DEPLOY_WAIT_DEFAULT_MS)));
  const deadline = Date.now() + waitMs;
  let statuses = runs.map((r) => ({ ...r, running: r.status === 'running' }));
  while (runs.length && Date.now() < deadline && !ctx.signal?.aborted) {
    await sleep(Math.min(DEPLOY_POLL_MS, Math.max(100, deadline - Date.now())));
    if (ctx.signal?.aborted) break;
    statuses = await Promise.all(runs.map(async (r) => {
      try {
        const s = await lightcodeDeployInfo({ thread_id: r.thread_id }, { ...deps, connector: info, fetchImpl });
        return {
          ...r,
          status: s.status,
          running: s.running,
          ok: s.ok,
          ...(s.needs_input ? { needs_input: true } : {}),
          ...(s.support_request ? { support_request: s.support_request } : {}),
          ...(s.report ? { report: s.report } : {}),
        };
      } catch {
        return { ...r, running: true };
      }
    }));
    if (statuses.every((s) => !s.running)) break;
  }
  const needsSupport = statuses.some((s) => s.needs_input || s.status === 'needs_input');
  const stillRunning = statuses.some((s) => s.running);
  return {
    project_id: body.project_id,
    project_name: body.project_name,
    runs: statuses,
    ...(needsSupport ? {
      needs_user_support: true,
      hint: 'LightCode deploy needs user support — forward support_request to the user, then call lightcode.deploy_reply with thread_id and their reply to continue.',
    } : stillRunning ? {
      hint: 'Deploy is still running — call lightcode.deploy_info with thread_id to check its progress or any user support request.',
    } : {}),
  };
}

/** Chuyển tiếp câu trả lời / xác nhận đã hỗ trợ của người dùng quay lại đúng phiên deploy/setup đang chờ trên LightCode. */
export async function lightcodeDeployReply(args = {}, ctx = {}, deps = {}) {
  const threadId = String(args.thread_id || '').trim();
  if (!threadId) throw invalid('thread_id is required');
  const info = deps.connector || await (deps.ensure || ensureLightcodeRunning)(deps);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const payload = {
    ...(args.message !== undefined ? { message: String(args.message) } : {}),
    ...(args.answer !== undefined ? { answer: String(args.answer) } : {}),
    ...(args.answers && typeof args.answers === 'object' ? { answers: args.answers } : {}),
    ...(args.hil_id ? { hil_id: String(args.hil_id) } : {}),
    ...(args.decision ? { decision: String(args.decision) } : {}),
  };
  const body = await connectorJson(info, `/connector/v1/deploy/runs/${encodeURIComponent(threadId)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctx.signal,
  }, { ...deps, fetchImpl });

  const waitMs = Math.min(DEPLOY_WAIT_MAX_MS, Math.max(0, Number(args.wait_ms ?? DEPLOY_WAIT_DEFAULT_MS)));
  let latest = body;
  const deadline = Date.now() + waitMs;
  while (latest.running && Date.now() < deadline && !ctx.signal?.aborted) {
    await sleep(Math.min(DEPLOY_POLL_MS, Math.max(100, deadline - Date.now())));
    if (ctx.signal?.aborted) break;
    try {
      const s = await lightcodeDeployInfo({ thread_id: threadId }, { ...deps, connector: info, fetchImpl });
      latest = { ...latest, ...s };
      if (!s.running) break;
    } catch { break; }
  }
  const needsSupport = latest.needs_input === true || latest.status === 'needs_input';
  return {
    ...latest,
    ...(needsSupport ? {
      needs_user_support: true,
      hint: 'LightCode still needs user support — forward support_request to the user and call lightcode.deploy_reply again.',
    } : latest.running ? {
      hint: 'Deploy/setup session is still running — call lightcode.deploy_info with thread_id to check its progress.',
    } : {}),
  };
}

// --- Cầu nối v2.3: answer / attention / strategy / metrics / events / webhook / preview ---------------------------------------------

function readStrategyFromDisk(cwd) {
  const readJson = (f, fallback) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
  };
  const strategy = readJson(path.join(cwd, '.lcagent', 'strategy.json'), { goals: [], non_goals: [], principles: [] });
  const rawLessons = readJson(path.join(cwd, '.lcagent', 'lessons.json'), []);
  const lessons = Array.isArray(rawLessons) ? rawLessons.slice(0, 20) : [];
  return {
    goals: Array.isArray(strategy?.goals) ? strategy.goals : [],
    non_goals: Array.isArray(strategy?.non_goals) ? strategy.non_goals : [],
    principles: Array.isArray(strategy?.principles) ? strategy.principles : [],
    lessons,
    proposed_rules: lessons.filter((l) => Number(l?.count) >= 3).map((l) => l.text).filter(Boolean).slice(0, 10),
  };
}

async function connectorJson(info, urlPath, init = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const headers = { Authorization: `Bearer ${info.key}`, ...(init.headers || {}) };
  const res = await fetchImpl(`http://127.0.0.1:${info.port}${urlPath}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = res.status === 404 ? DeviceErrorCode.NOT_FOUND : DeviceErrorCode.INVALID_ARGS;
    throw new DeviceToolError(code, body?.error || `LightCode answered ${res.status}`);
  }
  return body;
}

/** Đọc mọi việc đang chờ người chú ý (câu hỏi mở, job chặn/lỗi, kết quả rủi ro cao, yêu cầu gộp nhánh). */
export async function lightcodeAttention(args = {}, deps = {}) {
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  const info = deps.connector || readConnector(deps);
  if (!info) return { running: false, items: [], note: 'LightCode is not running — open LightCode to inspect attention items.' };
  const q = new URLSearchParams();
  if (cwd) q.set('cwd', cwd);
  const qs = q.toString();
  const body = await connectorJson(info, `/connector/v1/attention${qs ? `?${qs}` : ''}`, {}, deps);
  return { running: true, ...body };
}

/** Đọc mục tiêu, ngân sách, nguyên tắc dự án (`.lcagent/strategy.json`) và bài học từ các lỗi lặp lại. */
export async function lightcodeStrategy(args = {}, deps = {}) {
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  if (!cwd) throw invalid('cwd (project folder) is required');
  const info = deps.connector || readConnector(deps);
  if (!info) return { running: false, fallback: 'disk', cwd, ...readStrategyFromDisk(cwd) };
  const q = new URLSearchParams({ cwd });
  const body = await connectorJson(info, `/connector/v1/strategy?${q.toString()}`, {}, deps);
  return { running: true, cwd, ...body };
}

/** Cập nhật bản đồ mục tiêu, ngân sách và nguyên tắc dự án trên LightCode (giữ nguyên spent_usd đã đo). */
export async function lightcodeSetStrategy(args = {}, deps = {}) {
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  if (!cwd) throw invalid('cwd (project folder) is required');
  const info = deps.connector || await (deps.ensure || ensureLightcodeRunning)(deps);
  const payload = {
    cwd,
    ...(Array.isArray(args.goals) ? { goals: args.goals } : {}),
    ...(Array.isArray(args.non_goals) ? { non_goals: args.non_goals } : {}),
    ...(Array.isArray(args.principles) ? { principles: args.principles } : {}),
  };
  const body = await connectorJson(info, '/connector/v1/strategy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, deps);
  return { running: true, cwd, ...body };
}

/** Đọc chỉ số kết quả chạy thực tế của các job LightCode (tỷ lệ đạt, chi phí, thời gian, vòng sửa). */
export async function lightcodeMetrics(args = {}, deps = {}) {
  const cwd = resolveOptionalCwd(args.cwd, deps.roots);
  const since = args.since ? String(args.since).trim() : undefined;
  const info = deps.connector || readConnector(deps);
  if (!info) return { running: false, note: 'LightCode is not running — open LightCode to read metrics.' };
  const q = new URLSearchParams();
  if (cwd) q.set('cwd', cwd);
  if (since) q.set('since', since);
  const qs = q.toString();
  const body = await connectorJson(info, `/connector/v1/metrics${qs ? `?${qs}` : ''}`, {}, deps);
  return { running: true, ...body };
}

/** Đọc dòng sự kiện bền vững (`job.finished`, `job.attention`) từ LightCode và tùy chọn xác nhận đã đọc (`ack_seq` / `auto_ack`). */
export async function lightcodeEvents(args = {}, deps = {}) {
  const info = deps.connector || readConnector(deps);
  if (!info) return { running: false, events: [], note: 'LightCode is not running.' };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (args.ack_seq !== undefined && args.ack_seq !== null) {
    const seq = Number(args.ack_seq);
    if (!Number.isInteger(seq) || seq < 0) throw invalid('ack_seq must be a non-negative integer');
    const acked = await connectorJson(info, '/connector/v1/events/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq }),
    }, deps);
    if (args.only_ack) return { running: true, ...acked };
  }
  const q = new URLSearchParams();
  if (args.from !== undefined && args.from !== null && Number.isInteger(Number(args.from)) && Number(args.from) >= 0) {
    q.set('from', String(Number(args.from)));
  }
  const qs = q.toString();
  const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/events${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${info.key}` },
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new DeviceToolError(res.status === 404 ? DeviceErrorCode.NOT_FOUND : DeviceErrorCode.INVALID_ARGS, b?.error || `LightCode answered ${res.status}`);
  }
  const text = await res.text();
  const events = [];
  let lastSeq;
  let acked;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj?.type === 'end') {
        lastSeq = obj.last_seq;
        acked = obj.acked;
      } else if (obj?.type !== 'ping') {
        events.push(obj);
      }
    } catch { /* bỏ dòng hỏng */ }
  }
  const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
  const slice = events.slice(0, limit);
  if (args.auto_ack === true && slice.length) {
    const maxSeq = slice.reduce((m, e) => (Number.isInteger(e?.seq) && e.seq > m ? e.seq : m), -1);
    if (maxSeq >= 0) {
      const a = await connectorJson(info, '/connector/v1/events/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seq: maxSeq }),
      }, deps).catch(() => null);
      if (a) acked = a.acked;
    }
  }
  return { running: true, events: slice, total: events.length, ...(lastSeq !== undefined ? { last_seq: lastSeq } : {}), ...(acked !== undefined ? { acked } : {}) };
}

/** Xem hoặc đặt URL webhook cục bộ (chỉ localhost / 127.0.0.1) để LightCode đẩy sự kiện trực tiếp. */
export async function lightcodeWebhook(args = {}, deps = {}) {
  const info = deps.connector || readConnector(deps);
  if (!info) throw notFound('LightCode is not running');
  if (args.url === undefined) {
    const body = await connectorJson(info, '/connector/v1/webhook', {}, deps);
    return { running: true, ...body };
  }
  const body = await connectorJson(info, '/connector/v1/webhook', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: args.url }),
  }, deps);
  return { running: true, ...body };
}

/**
 * Luồng nền nghe sự kiện đẩy từ LightCode (`GET /connector/v1/events?follow=1`), chuyển từng sự kiện cho `onEvent(ev)` rồi xác nhận
 * (`POST /connector/v1/events/ack`). Tự nối lại khi LightCode tắt/bật lại; gọi `stop()` để đóng sạch khi daemon dừng.
 */
export function startLightcodeEventBridge({ onEvent, peek, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), idleMs = 5_000, maxBackoffMs = 30_000 } = {}) {
  const getConnector = peek || (() => readConnector());
  let stopped = false;
  let activeAbort = null;

  const loop = async () => {
    let attempts = 0;
    while (!stopped) {
      const info = getConnector();
      if (!info || Number(info.protocol ?? 1) < 2) {
        await sleep(idleMs);
        continue;
      }
      const abort = new AbortController();
      activeAbort = abort;
      try {
        const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/events?follow=1`, {
          headers: { Authorization: `Bearer ${info.key}` },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          attempts += 1;
          await sleep(Math.min(maxBackoffMs, 1500 * attempts));
          continue;
        }
        attempts = 0;
        const decoder = new TextDecoder();
        let buf = '';
        const handleLine = async (line) => {
          const s = line.trim();
          if (!s) return;
          let ev;
          try { ev = JSON.parse(s); } catch { return; }
          if (!ev || ev.type === 'ping' || ev.type === 'end') return;
          try { await onEvent?.(ev); } catch { /* callback lỗi không làm rớt vòng nghe */ }
          if (Number.isInteger(ev.seq)) {
            await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/events/ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.key}` },
              body: JSON.stringify({ seq: ev.seq }),
              signal: abort.signal,
            }).catch(() => undefined);
          }
        };
        for await (const chunk of res.body) {
          if (stopped) break;
          buf += decoder.decode(chunk, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) await handleLine(line);
        }
        if (!stopped && buf.trim()) await handleLine(buf);
      } catch {
        if (stopped) break;
        attempts += 1;
        await sleep(Math.min(maxBackoffMs, 1500 * attempts));
      } finally {
        if (activeAbort === abort) activeAbort = null;
      }
    }
  };
  void loop();
  return {
    stop() {
      stopped = true;
      try { activeAbort?.abort(); } catch { /* đã đóng */ }
    },
  };
}

/** Trả lời câu hỏi đang mở của một phiên LightCode (`POST /sessions/:id/answer`) và tiếp tục đúng phiên đó dưới cùng hợp đồng. */
export async function lightcodeAnswer(args = {}, ctx = {}, deps = {}) {
  const sessionId = String(args.session_id || '').trim();
  if (!sessionId) throw invalid('session_id is required');
  const hasAnswers = Array.isArray(args.answers) && args.answers.length > 0;
  const single = String(args.answer ?? '').trim();
  if (!hasAnswers && !single) throw invalid('Give answer (string) or answers ([{question?, answer}])');
  const info = deps.connector || await (deps.ensure || ensureLightcodeRunning)(deps);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const payload = {
    ...(hasAnswers ? { answers: args.answers } : { answer: single }),
    detach: true,
    orphan_ms: ORPHAN_MS,
    ...(args.on_question === 'stop' || args.on_question === 'assume' ? { on_question: args.on_question } : {}),
    ...(Number(args.max_cost_usd) > 0 ? { max_cost_usd: Number(args.max_cost_usd) } : {}),
    ...(Number.isInteger(Number(args.max_fix_rounds)) && Number(args.max_fix_rounds) > 0 ? { max_fix_rounds: Math.min(3, Number(args.max_fix_rounds)) } : {}),
  };
  const res = await fetchImpl(`http://127.0.0.1:${info.port}/connector/v1/sessions/${encodeURIComponent(sessionId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.key}` },
    body: JSON.stringify(payload),
    signal: ctx.signal,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new DeviceToolError(res.status === 404 ? DeviceErrorCode.NOT_FOUND : DeviceErrorCode.INVALID_ARGS, b?.error || `LightCode answered ${res.status}`);
  }
  const job = { texts: [], tools: [] };
  const decoder = new TextDecoder();
  let buf = '';
  const handle = (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    const shown = LIGHTCODE_ADAPTER.parse(job, msg);
    if (shown && typeof ctx.onOutput === 'function') {
      try { ctx.onOutput(`${shown}\n`); } catch { /* chỉ là tiến trình */ }
    }
  };
  if (res.body) {
    for await (const chunk of res.body) {
      if (ctx.signal?.aborted) break;
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) handle(line);
    }
    if (buf.trim()) handle(buf);
  }
  return {
    session_id: job.session_id || sessionId,
    ...(job.lightcode ? { lightcode: job.lightcode } : {}),
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.result ? { result: job.result } : { result: { ok: false, answer: 'Stream ended before result' } }),
  };
}

/** Quản lý bản xem trước giao diện (start / list / capture / smoke / stop) gắn với phiên LightCode. */
export async function lightcodePreview(args = {}, ctx = {}, deps = {}) {
  const action = String(args.action || 'list').trim().toLowerCase();
  const info = deps.connector || (action === 'list' ? readConnector(deps) : await (deps.ensure || ensureLightcodeRunning)(deps));
  if (!info) return { running: false, previews: [], note: 'LightCode is not running.' };
  if (action === 'list') {
    const q = new URLSearchParams();
    if (args.session_id) q.set('session_id', String(args.session_id).trim());
    const qs = q.toString();
    const body = await connectorJson(info, `/connector/v1/previews${qs ? `?${qs}` : ''}`, { signal: ctx.signal }, deps);
    return { running: true, ...body };
  }
  if (action === 'start') {
    const sessionId = String(args.session_id || '').trim();
    if (!sessionId) throw invalid('session_id is required to start a preview');
    const body = await connectorJson(info, '/connector/v1/previews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        ...(args.command ? { command: String(args.command) } : {}),
        ...(args.wait_for ? { wait_for: String(args.wait_for) } : {}),
        ...(Number(args.wait_seconds) > 0 ? { wait_seconds: Number(args.wait_seconds) } : {}),
        ...(args.url ? { url: String(args.url) } : {}),
        ...(Number(args.ttl_minutes) > 0 ? { ttl_minutes: Number(args.ttl_minutes) } : {}),
      }),
      signal: ctx.signal,
    }, deps);
    return { running: true, ...body };
  }
  const previewId = String(args.preview_id || args.id || '').trim();
  if (!previewId) throw invalid(`preview_id is required for preview action "${action}"`);
  if (action === 'capture') {
    const body = await connectorJson(info, `/connector/v1/previews/${encodeURIComponent(previewId)}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(args.path ? { path: String(args.path) } : {}),
        ...(args.full_page === true ? { full_page: true } : {}),
        ...(args.inline === true ? { inline: true } : {}),
      }),
      signal: ctx.signal,
    }, deps);
    return { running: true, ...body };
  }
  if (action === 'smoke') {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length) throw invalid('steps ([{open, expect_text?, no_console_errors?}]) is required for smoke');
    const body = await connectorJson(info, `/connector/v1/previews/${encodeURIComponent(previewId)}/smoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps }),
      signal: ctx.signal,
    }, deps);
    return { running: true, ...body };
  }
  if (action === 'stop') {
    const body = await connectorJson(info, `/connector/v1/previews/${encodeURIComponent(previewId)}`, {
      method: 'DELETE',
      signal: ctx.signal,
    }, deps);
    return { running: true, ...body };
  }
  throw invalid(`Unknown preview action "${action}" — use list, start, capture, smoke, or stop`);
}

/** Công cụ LightCode cho danh mục của Planner (máy Windows của một người). */
export function buildLightcodeTools({ onInstalled, roots } = {}) {
  const install = async (a, c) => {
    const res = await installLightcode(a, c);
    // Báo BE danh sách agent mới (profile.coding_agents có "lightcode") — Planner giao hợp đồng cho LightCode ngay lượt sau.
    try { await onInstalled?.(); } catch { /* lần nối lại sau vẫn báo */ }
    return res;
  };
  return [
    { name: 'lightcode.status', group: ToolGroup.PROC, read_only: true, handler: () => lightcodeStatus(),
      description: 'Is LightCode on this computer (installed / running / version, signed-in AI accounts, can it run jobs)? LightCode is the local execution app Aivin hands coding contracts to (agent "lightcode" of agent.run).',
      input_schema: schema({}) },
    { name: 'lightcode.install', group: ToolGroup.PROC, handler: install,
      description: 'Install LightCode (https://lightcode.live, Windows) from its official installer (SHA-512 checked) and start it. LightCode executes coding work on this computer: several AI agents in parallel (Claude, Codex, Gemini, OpenCode, Antigravity), automatic switch to a backup account when one runs out of quota, context kept across accounts — while Aivin keeps the plan, the contracts and the quality check. ONLY after the person agreed: first explain in one or two sentences what LightCode is and why (faster, no stalls when an account runs out, they can watch every job in LightCode; free trial, lifetime licence USD 2.99) and ask. Already installed → just starts it.',
      input_schema: schema({ reinstall: { type: 'boolean', description: 'download and run the installer even when LightCode is already installed (update / repair)' } }) },
    { name: 'lightcode.worklog', group: ToolGroup.PROC, read_only: true, handler: (a) => lightcodeWorklog(a, { roots }),
      description: 'Read reports of what coding agents in LightCode have done (.lcagent/worklog.jsonl: request, final report, touched files, source user|aivin) plus currently running sessions. Omit cwd to see recent work across all local LightCode projects.',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path (optional; omit to aggregate across all local projects)' },
        project_id: { type: 'string', description: 'LightCode project id (optional)' },
        since: { type: 'string', description: 'ISO timestamp — only entries at or after this time (optional)' },
        limit: { type: 'number', description: 'max entries to return (default 20, max 100)' },
        source: { type: 'string', enum: ['user', 'aivin'], description: 'filter by who started the work: user (direct in LightCode) or aivin' },
      }) },
    { name: 'lightcode.deploy_hosts', group: ToolGroup.PROC, read_only: true, handler: () => lightcodeDeployHosts(),
      description: 'List deploy destinations already available on this machine: SSH hosts configured in LightCode (id, name, host, user — never passwords/keys), ~/.ssh/config aliases, and supported deploy adapters (vps-ssh, vercel, netlify, cloudflare, ftp, docker…). Check this before setting up deploy for a new project.',
      input_schema: schema({}) },
    { name: 'lightcode.deploy_info', group: ToolGroup.PROC, read_only: true, handler: (a) => lightcodeDeployInfo(a, { roots }),
      description: 'Read a project deploy workflow configured in LightCode (environments/stages, targets, approval owners, whether a recipe or direct script exists, recent deploy runs and pending approval requests), OR check the progress/result of a running deploy session by thread_id. If configured is false, call lightcode.deploy_hosts and lightcode.deploy_setup first.',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path' },
        project_id: { type: 'string', description: 'LightCode project id (alternative to cwd)' },
        thread_id: { type: 'string', description: 'check status and final report of a specific deploy session' },
      }) },
    { name: 'lightcode.deploy_setup', group: ToolGroup.PROC, handler: (a, c) => lightcodeDeploySetup(a, c, { roots }),
      description: 'Create or update a project deploy workflow (.lcagent/workflow.json) in LightCode — works for newly created projects too (auto-registers cwd) and triggers script/recipe preparation WITHOUT running a real deploy. Never pass raw passwords or private keys; reference a saved host_id from lightcode.deploy_hosts or SSH key config. After setup, ask the person to confirm and call lightcode.deploy.',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path' },
        project_id: { type: 'string', description: 'LightCode project id (alternative to cwd)' },
        auto: { type: 'boolean', description: 'true = let LightCode AI scan the repo and author workflow.json automatically' },
        merge: { type: 'boolean', description: 'keep existing environments not listed here (default true)' },
        parts: { type: 'array', items: { type: 'object' }, description: 'optional project parts [{ id, name }]' },
        environments: { type: 'array', items: { type: 'object' }, description: 'full list of stages [{ id?, name, tier, targets: [{ part?, where, host_id?, host?, adapter? }], url?, owner?, notes?, approval? }]' },
        env_id: { type: 'string', description: 'shortcut for 1 stage: stage id (e.g. production, staging)' },
        env_name: { type: 'string', description: 'shortcut for 1 stage: stage display name (default Production)' },
        tier: { type: 'string', enum: ['test', 'staging', 'live'], description: 'shortcut for 1 stage: color/safety tier (default live)' },
        where: { type: 'string', description: 'shortcut for 1 stage: destination description (e.g. "VPS Nginx /var/www/site", "Vercel")' },
        host_id: { type: 'string', description: 'shortcut for 1 stage: SSH host id from lightcode.deploy_hosts' },
        host: { type: 'string', description: 'shortcut for 1 stage: saved host name, IP/hostname, or user@host' },
        adapter: { type: 'string', description: 'shortcut for 1 stage: adapter id (vps-ssh | vercel | netlify | cloudflare | ftp | docker | custom)' },
        url: { type: 'string', description: 'shortcut for 1 stage: public URL to health-check after deploy' },
        owner: { type: 'string', description: 'shortcut for 1 stage: person/email to notify' },
        notes: { type: 'string', description: 'shortcut for 1 stage: deploy instructions (build dir, target path, restart command — no secrets)' },
        approval: { type: 'boolean', description: 'shortcut for 1 stage: require confirmation before deploy (default true for live)' },
        lang: { type: 'string', description: 'optional language tag for LightCode preparation prompts (e.g. vi)' },
      }) },
    { name: 'lightcode.deploy', group: ToolGroup.PROC, handler: (a, c) => lightcodeDeploy(a, c, { roots }),
      description: 'Run a configured deploy environment in LightCode (runs the direct script with zero tokens when available, otherwise LightCode AI deploy session). ALWAYS inspect lightcode.deploy_info first (and use lightcode.deploy_setup if not configured yet), and only run after the person confirms. If it returns needs_user_support / status "needs_input", forward support_request to the user and pass their reply back with lightcode.deploy_reply.',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path' },
        project_id: { type: 'string', description: 'LightCode project id (alternative to cwd)' },
        env: { type: 'string', description: 'environment id or name from lightcode.deploy_info (e.g. staging, production)' },
        envs: { type: 'array', items: { type: 'string' }, description: 'multiple environment ids/names to deploy together' },
        parts: { type: 'array', items: { type: 'string' }, description: 'optional subset of project part ids to deploy' },
        note: { type: 'string', description: 'short release note or instruction for this deploy' },
        wait_ms: { type: 'number', description: 'wait up to this long in ms for initial completion (default 5000, max 60000)' },
      }) },
    { name: 'lightcode.deploy_reply', group: ToolGroup.PROC, handler: (a, c) => lightcodeDeployReply(a, c),
      description: 'Forward the user reply or approval back into a paused LightCode deploy / deploy-setup session (when lightcode.deploy, lightcode.deploy_setup, or lightcode.deploy_info returned status "needs_input" with support_request) so LightCode continues setting up or deploying.',
      input_schema: schema({
        thread_id: { type: 'string', description: 'deploy or deploy-setup thread_id from lightcode.deploy / deploy_setup / deploy_info' },
        message: { type: 'string', description: 'the user answer or confirmation (e.g. target path, domain, "logged in, continue")' },
        answers: { type: 'object', description: 'optional map of question text -> answer when replying to a structured HIL question' },
        hil_id: { type: 'string', description: 'optional hil_id from support_request' },
        decision: { type: 'string', enum: ['allow', 'deny', 'approve_plan'], description: 'optional decision when support_request is a permission or plan check' },
        wait_ms: { type: 'number', description: 'wait up to this long in ms for progress/completion after replying (default 5000, max 60000)' },
      }, ['thread_id']) },
    { name: 'lightcode.attention', group: ToolGroup.PROC, read_only: true, handler: (a) => lightcodeAttention(a, { roots }),
      description: 'List everything waiting for a person in LightCode: open clarification questions, blocked/partial jobs, high-risk results, and pending merge requests. Pass cwd to scope to one project.',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path (optional)' },
      }) },
    { name: 'lightcode.strategy', group: ToolGroup.PROC, read_only: true, handler: (a) => lightcodeStrategy(a, { roots }),
      description: 'Read a project strategy map in LightCode (.lcagent/strategy.json: goals with measured spend/budget, non-goals, principles) plus lessons learned and proposed rules from repeated failures.',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path' },
      }, ['cwd']) },
    { name: 'lightcode.set_strategy', group: ToolGroup.PROC, handler: (a) => lightcodeSetStrategy(a, { roots }),
      description: 'Update a project strategy map in LightCode (.lcagent/strategy.json: goals with budgets, non-goals, principles). Existing measured spent_usd per goal is preserved by LightCode.',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path' },
        goals: { type: 'array', items: { type: 'object' }, description: 'list of goals ({ id, title, status?, budget_usd?, notes? })' },
        non_goals: { type: 'array', items: { type: 'string' }, description: 'things explicitly out of scope' },
        principles: { type: 'array', items: { type: 'string' }, description: 'guiding engineering principles' },
      }, ['cwd']) },
    { name: 'lightcode.metrics', group: ToolGroup.PROC, read_only: true, handler: (a) => lightcodeMetrics(a, { roots }),
      description: 'Read outcome metrics of finished LightCode jobs (pass rate, cost, duration, fix rounds, risk breakdown).',
      input_schema: schema({
        cwd: { type: 'string', description: 'project folder path (optional)' },
        since: { type: 'string', description: 'ISO timestamp to filter from (optional)' },
      }) },
    { name: 'lightcode.events', group: ToolGroup.PROC, read_only: true, handler: (a) => lightcodeEvents(a, { roots }),
      description: 'Read durable job events emitted by LightCode (job.finished, job.attention) since the last ack or from a sequence number, and optionally acknowledge processed events.',
      input_schema: schema({
        from: { type: 'number', description: 'start sequence number (optional; default acked + 1)' },
        limit: { type: 'number', description: 'max events to return (default 50, max 200)' },
        ack_seq: { type: 'number', description: 'acknowledge events up to this sequence number' },
        auto_ack: { type: 'boolean', description: 'automatically acknowledge the highest returned event sequence' },
        only_ack: { type: 'boolean', description: 'only acknowledge ack_seq without fetching new events' },
      }) },
    { name: 'lightcode.answer', group: ToolGroup.PROC, handler: (a, c) => lightcodeAnswer(a, c),
      description: 'Answer open clarification question(s) from a paused LightCode session (POST /sessions/:id/answer) and continue the same session under its saved contract and deliverables.',
      input_schema: schema({
        session_id: { type: 'string', description: 'LightCode session_id that stopped with needs_clarification' },
        answer: { type: 'string', description: 'plain answer text (use this or answers[])' },
        answers: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } } }, description: 'structured list of { question?, answer }' },
        on_question: { type: 'string', enum: ['assume', 'stop'], description: 'what to do if the agent asks again' },
        max_cost_usd: { type: 'number', description: 'optional budget cap override (USD)' },
        max_fix_rounds: { type: 'number', description: 'optional internal fix rounds (0-3)' },
      }, ['session_id']) },
    { name: 'lightcode.preview', group: ToolGroup.PROC, handler: (a, c) => lightcodePreview(a, c),
      description: 'Start, list, capture (screenshot + console errors + failed requests), smoke-test, or stop a live dev-server preview for a LightCode session in its own worktree.',
      input_schema: schema({
        action: { type: 'string', enum: ['list', 'start', 'capture', 'smoke', 'stop'], description: 'preview operation (default list)' },
        session_id: { type: 'string', description: 'LightCode session_id (required for start, optional filter for list)' },
        preview_id: { type: 'string', description: 'preview id returned by start/list (required for capture, smoke, stop)' },
        command: { type: 'string', description: 'dev-server command (for start; optional if .lcagent/preview.json exists)' },
        wait_for: { type: 'string', description: 'ready regex/text to wait for (for start)' },
        wait_seconds: { type: 'number', description: 'max seconds to wait for startup (for start)' },
        url: { type: 'string', description: 'preview base URL if not printed by the command (for start)' },
        ttl_minutes: { type: 'number', description: 'auto-stop TTL in minutes (for start)' },
        path: { type: 'string', description: 'relative route to open (for capture)' },
        full_page: { type: 'boolean', description: 'capture full-page screenshot (for capture)' },
        inline: { type: 'boolean', description: 'return screenshot_base64 inline (for capture)' },
        steps: { type: 'array', items: { type: 'object', properties: { open: { type: 'string' }, expect_text: { type: 'string' }, no_console_errors: { type: 'boolean' } } }, description: 'smoke test steps (for smoke)' },
      }) },
  ];
}
