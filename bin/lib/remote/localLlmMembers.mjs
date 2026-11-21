// Mô hình trên máy ở MÁY TÍNH TỔ CHỨC (`--multi-user`, 17/11/2026): mỗi thành viên dùng agent (Claude Code / Codex) bằng TÀI KHOẢN CỦA CHÍNH
// HỌ — agent chạy dưới tài khoản Linux của thành viên (HOME = /home/<vùng>), nên tệp đăng nhập (~/.claude, ~/.codex) và hạn mức gói là của
// người đó, không ai dùng chung tài khoản của ai. Chưa đăng nhập → lời gọi báo `LOCAL_LLM_NOT_SIGNED_IN` ngay (không khởi động agent), BE
// chạy cloud và mời người dùng đăng nhập (localLlmLogin.mjs).
//
// Antigravity không có ở chế độ này: chưa có cách đăng nhập không màn hình, và tệp cài đặt không tách được theo người.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { accountEnv, withProcessCap } from './multiUser.mjs';
import { agentEnv } from './sandbox.mjs';

/**
 * Thư mục làm việc (cwd) của agent khi chạy cho thành viên: rỗng, của root, thành viên chỉ đọc / đi qua được (0755) — agent không thấy tệp
 * dự án nào, thành viên cũng không ghi vào đây được (lớp ghi của container không có hạn mức đĩa). Không đặt trong /home/<vùng>: root không tạo
 * / chown gì trong thư mục do thành viên điều khiển (liên kết tượng trưng).
 */
export const MEMBER_LLM_DIR = '/var/lib/aivin-llm';
export const MEMBER_LLM_AGENTS = Object.freeze(['claude', 'codex', 'gemini']);

/** Biến của agent mà tiến trình root có thể mang — không để lọt sang tài khoản thành viên (agent phải đọc đăng nhập trong HOME của họ). */
const ROOT_ONLY_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/** `env` của agent chạy cho thành viên: HOME / USER của họ, không tự cập nhật (bản cài thuộc root), không mở trình duyệt (máy không màn hình). */
export function memberAgentEnv(account, base = process.env) {
  const env = { ...accountEnv(account, agentEnv(base)), DISABLE_AUTOUPDATER: '1', BROWSER: '/bin/true', NO_COLOR: '1' };
  for (const k of ROOT_ONLY_ENV) delete env[k];
  return env;
}

let dirReady = false;
function ensureMemberDir(dir) {
  if (dirReady && dir === MEMBER_LLM_DIR) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  try { fs.chmodSync(dir, 0o755); } catch { /* không phải chủ (thử nghiệm) */ }
  if (dir === MEMBER_LLM_DIR) dirReady = true;
}

/** `[lệnh, tham số, tuỳ chọn spawn]` để chạy `bin argv` dưới tài khoản thành viên, có trần số tiến trình (prlimit). */
export function memberSpawnArgs(account, bin, argv, { dir = MEMBER_LLM_DIR, base = process.env } = {}) {
  ensureMemberDir(dir);
  const [cmd, args] = withProcessCap(bin, argv);
  return [cmd, args, { cwd: dir, env: memberAgentEnv(account, base), uid: account.uid, gid: account.gid, windowsHide: true }];
}

/** Lệnh hỏi "đã đăng nhập chưa" của từng agent (không gọi mạng, < 1 s). */
export const SIGN_IN_PROBES = Object.freeze({
  claude: {
    argv: ['auth', 'status', '--json'],
    // `{"loggedIn": true, "authMethod": "claude.ai" …}` — mã thoát 1 khi chưa đăng nhập (đo 2.1.326).
    parse: (code, out) => {
      try { return JSON.parse(out)?.loggedIn === true; } catch { return code === 0; }
    },
  },
  // "Not logged in", mã thoát 1 (đo 0.169.0).
  codex: { argv: ['login', 'status'], parse: (code) => code === 0 },
  // Gemini CLI lưu phiên OAuth cá nhân trong ~/.gemini/oauth_creds.json (không cần gọi mạng để kiểm tra).
  gemini: {
    check: (account) => {
      if (!account?.home) return false;
      for (const file of ['oauth_creds.json', 'google_accounts.json']) {
        try {
          const raw = fs.readFileSync(path.join(account.home, '.gemini', file), 'utf8').trim();
          if (raw && raw !== '{}' && raw !== '[]') return true;
        } catch { /* chưa đăng nhập */ }
      }
      return false;
    },
  },
});

function runAs(account, bin, argv, { timeoutMs = 15_000, dir } = {}) {
  const [cmd, args, opts] = memberSpawnArgs(account, bin, argv, { dir });
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve({ code, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

/**
 * "Thành viên đã đăng nhập agent chưa", nhớ ngắn: đã đăng nhập 5 phút, chưa 20 s (vừa đăng nhập xong ở nơi khác thì sớm thấy). Lời gọi bị
 * agent báo lỗi xác thực / đăng nhập, đăng xuất → `forget` để hỏi lại ngay.
 */
export function createSignInChecker({ binOf, run = runAs, now = Date.now, okTtlMs = 5 * 60_000, noTtlMs = 20_000, dir } = {}) {
  const cache = new Map();
  const keyOf = (agentId, account) => `${account.name}|${agentId}`;

  async function status(adapter, account, { fresh = false } = {}) {
    const probe = SIGN_IN_PROBES[adapter.id];
    if (!probe) return false;
    const key = keyOf(adapter.id, account);
    const hit = cache.get(key);
    if (!fresh && hit && now() - hit.at < (hit.ok ? okTtlMs : noTtlMs)) return hit.ok;
    const bin = binOf(adapter)?.bin;
    if (!bin) return false;
    let ok = false;
    if (typeof probe.check === 'function') {
      ok = !!probe.check(account);
    } else {
      const r = await run(account, bin, probe.argv, { dir });
      ok = !!probe.parse(r.code, r.out);
    }
    if (cache.size > 2000) cache.clear();
    cache.set(key, { ok, at: now() });
    return ok;
  }

  return {
    status,
    forget: (agentId, account) => cache.delete(keyOf(agentId, account)),
    run: (account, bin, argv, opts) => run(account, bin, argv, { dir, ...opts }),
  };
}
