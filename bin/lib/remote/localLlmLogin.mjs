// Đăng nhập agent cho thành viên máy tính tổ chức, KHÔNG cần màn hình (17/11/2026). Máy không có trình duyệt / màn hình: CLI chạy lệnh đăng
// nhập của agent dưới tài khoản Linux của thành viên, đọc link (và mã) agent in ra, BE đưa cho người dùng mở trên máy / điện thoại của họ.
// Tệp đăng nhập agent ghi nằm trong HOME của thành viên — chỉ họ dùng.
//
// Đã đo trên container Linux sạch (node:22-bookworm-slim):
// - Claude Code 2.1.326 `claude auth login --claudeai`: in "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…" rồi
//   chờ "Paste code here if prompted >" trên stdin → người dùng đăng nhập, trang đích hiện mã, dán mã vào Aivin, CLI ghi mã vào stdin.
// - Codex 0.169.0 `codex login --device-auth`: in link https://auth.openai.com/codex/device + mã một lần (hết hạn 15 phút), tự chờ người
//   dùng xác nhận rồi thoát — không cần nhập gì thêm.
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { DeviceErrorCode, ToolGroup } from './constants.mjs';
import { DeviceToolError } from './sandbox.mjs';
import { memberSpawnArgs } from './localLlmMembers.mjs';

// eslint-disable-next-line no-control-regex -- mã màu ANSI agent in ra
export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const URL_RE = /https:\/\/[^\s'"<>`]+/g;
const LOGIN_TTL_MS = 15 * 60_000;
const START_WAIT_MS = 25_000;
const CODE_WAIT_MS = 60_000;
const MAX_OUTPUT = 16_000;
const CODE_RE = /^[A-Za-z0-9_\-#.~=+/]{6,1024}$/;

export const LoginState = Object.freeze({ PENDING: 'pending', SUCCEEDED: 'succeeded', FAILED: 'failed', EXPIRED: 'expired' });

const invalid = (msg) => new DeviceToolError(DeviceErrorCode.INVALID_ARGS, msg);
const failed = (msg, code = DeviceErrorCode.EXECUTION_FAILED) => new DeviceToolError(code, msg);

/** Link / mã trong chữ agent in ra (đã bỏ mã màu). null = chưa đủ. */
export const LOGIN_FLOWS = Object.freeze({
  claude: {
    argv: ['auth', 'login', '--claudeai'],
    needsCode: true,
    parse(text) {
      const url = (text.match(URL_RE) || []).find((u) => /\/oauth\/authorize\?/.test(u));
      return url ? { url } : null;
    },
    logout: ['auth', 'logout'],
  },
  codex: {
    argv: ['login', '--device-auth'],
    needsCode: false,
    parse(text) {
      const url = (text.match(URL_RE) || []).find((u) => /\/device\b/.test(u));
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/.exec(text)?.[1];
      return url && code ? { url, user_code: code } : null;
    },
    logout: ['logout'],
  },
});

/** Bản ghi một lần đăng nhập trả cho BE — không kèm chữ thô agent in ra (có thể dài / lạ), chỉ lỗi rút gọn. */
const publicOf = (s) => ({
  login_id: s.id, agent: s.agent, state: s.state, url: s.url || null, user_code: s.user_code || null, needs_code: s.needsCode && s.state === LoginState.PENDING,
  expires_at: s.expiresAt, ...(s.error ? { error: s.error } : {}),
});

/**
 * `llm` = bộ mô hình trên máy ở chế độ máy tổ chức (localLlm.mjs, memberMode) — dùng chung danh sách agent đã cài + bộ nhớ "đã đăng nhập".
 * Mỗi (thành viên, agent) tối đa một lần đăng nhập đang chờ; bắt đầu lại thì huỷ lần cũ.
 */
export function createLlmLogin({ llm, spawnImpl = spawn, now = Date.now, ttlMs = LOGIN_TTL_MS, startWaitMs = START_WAIT_MS, codeWaitMs = CODE_WAIT_MS } = {}) {
  const sessions = new Map();

  const accountOf = (ctx) => {
    const account = ctx?.runAs;
    if (!account?.name) throw invalid('Sign-in on this shared computer needs a member');
    return account;
  };
  const adapterOf = (agent) => {
    const flow = LOGIN_FLOWS[agent];
    if (!flow) throw invalid(`Sign-in from Aivin is not available for "${agent}" on this computer`);
    return { adapter: llm.adapterFor(agent), flow };
  };
  const own = (id, account) => {
    const s = sessions.get(String(id || ''));
    if (!s || s.account.name !== account.name) throw failed('This sign-in is not running any more — start again', DeviceErrorCode.NOT_FOUND);
    return s;
  };

  function end(s, state, error) {
    if (s.state !== LoginState.PENDING) return;
    s.state = state;
    if (error) s.error = String(error).replace(ANSI_RE, '').trim().slice(-300);
    clearTimeout(s.timer);
    try { s.child.stdin?.end(); } catch { /* đã đóng */ }
    if (state !== LoginState.SUCCEEDED) try { s.child.kill(); } catch { /* đã thoát */ }
    llm.signIn?.forget(s.agent, s.account);
    for (const fn of s.waiters.splice(0)) fn();
  }

  function sweep() {
    for (const [id, s] of sessions) if (s.state !== LoginState.PENDING && now() - s.endedAt > ttlMs) sessions.delete(id);
  }

  /** Chờ tới khi `test()` đúng, lần đăng nhập kết thúc, hoặc hết `ms`. */
  function waitFor(s, test, ms) {
    if (test() || s.state !== LoginState.PENDING) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); const i = s.waiters.indexOf(check); if (i >= 0) s.waiters.splice(i, 1); resolve(); }
      function check() { if (test() || s.state !== LoginState.PENDING) done(); }
      s.waiters.push(check);
    });
  }

  async function start(args = {}, ctx = {}) {
    const account = accountOf(ctx);
    const agent = String(args.agent || '');
    const { adapter, flow } = adapterOf(agent);
    sweep();
    for (const s of sessions.values()) if (s.account.name === account.name && s.agent === agent) end(s, LoginState.FAILED, 'Replaced by a new sign-in');
    const [cmd, argv, opts] = memberSpawnArgs(account, llm.binOf(adapter).bin, flow.argv, { dir: llm.memberDir });
    const child = spawnImpl(cmd, argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    const s = {
      id: randomUUID(), agent, account, child, needsCode: flow.needsCode, state: LoginState.PENDING, output: '', url: null, user_code: null,
      expiresAt: now() + ttlMs, endedAt: 0, waiters: [], timer: null, codeSent: false,
    };
    sessions.set(s.id, s);
    const onData = (d) => {
      s.output = (s.output + String(d)).slice(-MAX_OUTPUT);
      if (!s.url) {
        const found = flow.parse(s.output.replace(ANSI_RE, ''));
        if (found) Object.assign(s, found);
      }
      for (const fn of [...s.waiters]) fn();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (e) => end(s, LoginState.FAILED, `Could not start ${adapter.label}: ${e.message}`));
    child.once('exit', (code) => {
      s.endedAt = now();
      if (code === 0) end(s, LoginState.SUCCEEDED);
      else end(s, LoginState.FAILED, s.output || `${adapter.label} sign-in exited (${code})`);
    });
    s.timer = setTimeout(() => { s.endedAt = now(); end(s, LoginState.EXPIRED, 'Sign-in expired'); }, ttlMs);
    s.timer.unref?.();
    await waitFor(s, () => !!s.url, startWaitMs);
    if (!s.url && s.state === LoginState.PENDING) end(s, LoginState.FAILED, `${adapter.label} did not print a sign-in link`);
    return publicOf(s);
  }

  /** Claude Code: mã trang đăng nhập hiện ra → ghi vào stdin, chờ agent đổi mã lấy phiên đăng nhập (thoát 0). */
  async function submitCode(args = {}, ctx = {}) {
    const account = accountOf(ctx);
    const s = own(args.login_id, account);
    const code = String(args.code || '').trim();
    if (!s.needsCode) throw invalid('This sign-in does not take a code — finish it in the browser');
    if (!CODE_RE.test(code)) throw invalid('That does not look like a sign-in code — copy the whole code from the sign-in page');
    if (s.state !== LoginState.PENDING) return publicOf(s);
    if (s.codeSent) throw invalid('A code was already sent for this sign-in — start again if it failed');
    s.codeSent = true;
    try { s.child.stdin.write(`${code}\n`); } catch (e) { end(s, LoginState.FAILED, e.message); }
    await waitFor(s, () => false, codeWaitMs);
    return publicOf(s);
  }

  /** Trạng thái lần đăng nhập; `wait_ms` (≤ 25 s): chờ tới khi xong (Codex: người dùng xác nhận mã trên trình duyệt). */
  async function poll(args = {}, ctx = {}) {
    const account = accountOf(ctx);
    const s = own(args.login_id, account);
    const waitMs = Math.min(Math.max(0, Number(args.wait_ms) || 0), 25_000);
    if (waitMs) await waitFor(s, () => false, waitMs);
    return publicOf(s);
  }

  /** Agent đã cài + thành viên đã đăng nhập chưa (hỏi lại thật, không dùng kết quả nhớ). */
  async function status(_args = {}, ctx = {}) {
    const account = accountOf(ctx);
    const agents = await Promise.all(llm.agents().map(async (a) => {
      const signedIn = await llm.signIn.status(llm.adapterFor(a.id), account, { fresh: true }).catch(() => false);
      return { id: a.id, label: a.label, ...(a.version ? { version: a.version } : {}), signed_in: signedIn, can_sign_in: !!LOGIN_FLOWS[a.id] };
    }));
    return { agents };
  }

  async function logout(args = {}, ctx = {}) {
    const account = accountOf(ctx);
    const agent = String(args.agent || '');
    const { adapter, flow } = adapterOf(agent);
    for (const s of sessions.values()) if (s.account.name === account.name && s.agent === agent) end(s, LoginState.FAILED, 'Signed out');
    const r = await llm.signIn.run(account, llm.binOf(adapter).bin, flow.logout, { dir: llm.memberDir, timeoutMs: 20_000 });
    llm.signIn.forget(agent, account);
    const signedIn = await llm.signIn.status(adapter, account, { fresh: true }).catch(() => false);
    return { agent, signed_in: signedIn, ok: !signedIn, ...(r.code !== 0 && signedIn ? { error: (r.err || r.out).trim().slice(-300) } : {}) };
  }

  function closeAll() {
    for (const s of sessions.values()) end(s, LoginState.FAILED, 'Computer is shutting down');
    sessions.clear();
  }

  return { start, submitCode, poll, status, logout, closeAll };
}

const str = (description) => ({ type: 'string', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required });

/** Công cụ BE-only của máy tổ chức: trạng thái đăng nhập + đăng nhập / đăng xuất agent cho thành viên của lời gọi. */
export function buildLlmLoginTools(login) {
  const call = (fn) => (a, c, e) => fn(a, { ...c, runAs: e?.runAs });
  const base = { group: ToolGroup.PROC, read_only: true, internal: true };
  return [
    { ...base, name: 'llm.status', handler: call(login.status),
      description: 'BE-only: coding agents on this shared computer and whether this member is signed in to each.', input_schema: schema({}) },
    { ...base, name: 'llm.login_start', handler: call(login.start),
      description: "BE-only: start signing this member in to an agent. Returns a link (and a one-time code for codex) to open on the member's own device.",
      input_schema: schema({ agent: str('claude | codex') }, ['agent']) },
    { ...base, name: 'llm.login_code', handler: call(login.submitCode),
      description: 'BE-only: give the code shown after signing in (claude) to the running sign-in, wait for it to finish.',
      input_schema: schema({ login_id: str('from llm.login_start'), code: str('code from the sign-in page') }, ['login_id', 'code']) },
    { ...base, name: 'llm.login_poll', handler: call(login.poll),
      description: 'BE-only: state of a running sign-in (pending | succeeded | failed | expired); wait_ms waits for it to finish.',
      input_schema: schema({ login_id: str('from llm.login_start'), wait_ms: { type: 'number', description: 'max 25000' } }, ['login_id']) },
    { ...base, name: 'llm.logout', handler: call(login.logout),
      description: 'BE-only: sign this member out of an agent on this shared computer.', input_schema: schema({ agent: str('claude | codex') }, ['agent']) },
  ];
}
