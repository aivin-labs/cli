// Dấu vân tay tài khoản của từng agent làm mô hình trên máy (17/11/2026) — BE tính hạn mức theo TÀI KHOẢN (hai máy cùng một tài khoản
// Claude Code / Codex dùng chung hạn mức; xem BE DeviceLocalQuotaHelper). Chỉ gửi băm (không gửi email / mã tài khoản), đọc từ tệp đăng nhập
// sẵn có của agent; đọc không được → bỏ agent đó (BE tính theo máy như trước).
//
// - Claude Code: `<CLAUDE_CONFIG_DIR | ~>/.claude.json` → `oauthAccount.accountUuid` (thiếu thì `emailAddress`).
// - Codex: `<CODEX_HOME | ~/.codex>/auth.json` → `tokens.account_id`.
// - Antigravity: không lộ tài khoản (kể cả qua ACP) → `installation_id` của bản cài (`~/.gemini/antigravity-cli` hoặc `~/.gemini/antigravity`).
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
};

export const ACCOUNT_READERS = Object.freeze({
  claude: ({ env, home }) => {
    const dirs = [env.CLAUDE_CONFIG_DIR, home].filter(Boolean);
    for (const dir of dirs) {
      const acct = readJson(path.join(dir, '.claude.json'))?.oauthAccount;
      const id = acct?.accountUuid || acct?.emailAddress;
      if (id) return String(id);
    }
    return null;
  },
  codex: ({ env, home }) => {
    const id = readJson(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'))?.tokens?.account_id;
    return id ? String(id) : null;
  },
  antigravity: ({ home }) => {
    for (const sub of ['antigravity-cli', 'antigravity']) {
      const id = readText(path.join(home, '.gemini', sub, 'installation_id'));
      if (id) return `install:${id}`;
    }
    return null;
  },
});

/** Băm ổn định, không đảo ngược được: 16 ký tự hex của sha256("aivin-local-llm:<agent>:<id>"). */
export function accountFingerprint(agent, id) {
  return createHash('sha256').update(`aivin-local-llm:${agent}:${id}`).digest('hex').slice(0, 16);
}

/** `{ claude: '<16 hex>', … }` cho các agent đọc được tài khoản; rỗng → undefined. */
export function localLlmAccounts(agents, { env = process.env, home = os.homedir(), readers = ACCOUNT_READERS } = {}) {
  const out = {};
  for (const agent of agents || []) {
    let id = null;
    try { id = readers[agent]?.({ env, home }) || null; } catch { id = null; }
    if (id) out[agent] = accountFingerprint(agent, id);
  }
  return Object.keys(out).length ? out : undefined;
}
