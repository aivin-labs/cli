/**
 * Môi giới biến xác thực ngắn hạn cho lệnh trên Cloud Computer (21/11/2026).
 *
 * Bảo mật:
 *  - Chỉ nhận đúng tập tên biến đã duyệt (`ALLOWED_AUTH_ENV_KEYS`), bỏ qua mọi tên biến hệ thống (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`…).
 *  - Không ghi token ra đĩa: với `git`, dùng cơ chế `GIT_CONFIG_COUNT` + `http.<origin>.extraheader` truyền hoàn toàn qua môi trường tiến trình con.
 *  - Che sạch cả token gốc lẫn chuỗi Basic base64 khỏi stdout, stderr và luồng stream trước khi gửi về BE.
 */

export const ALLOWED_AUTH_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'VERCEL_TOKEN',
  'VERCEL_ORG_ID',
  'VERCEL_PROJECT_ID',
  'NETLIFY_AUTH_TOKEN',
  'NPM_TOKEN',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'LINEAR_API_KEY',
  'NOTION_TOKEN',
]);

const MAX_AUTH_VARS = 16;
const MAX_AUTH_VAL_LEN = 4096;

/** Lọc sạch map `call.auth_env` BE gửi xuống; trả null nếu không có biến hợp lệ nào. */
export function sanitizeAuthEnv(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let count = 0;
  for (const [key, val] of Object.entries(raw)) {
    if (count >= MAX_AUTH_VARS) break;
    if (!ALLOWED_AUTH_ENV_KEYS.has(key)) continue;
    if (typeof val !== 'string') continue;
    const clean = val.trim();
    if (!clean || clean.length > MAX_AUTH_VAL_LEN || /[\r\n\0]/.test(clean)) continue;
    out[key] = clean;
    count += 1;
  }
  return count ? out : null;
}

/**
 * Xây biến môi trường tạm cho lệnh shell từ `authEnv`:
 *  - Giữ các biến trong `authEnv`.
 *  - Nếu lệnh gọi `git` và có token GitHub / GitLab → gắn thêm `GIT_TERMINAL_PROMPT=0` và `GIT_CONFIG_*` (không chạm `~/.gitconfig`).
 * Trả `{ env, secrets }` (secrets gồm cả chuỗi base64 header để che sạch nếu lệnh in ra).
 */
export function buildCommandAuthEnv(authEnv, command = '') {
  const clean = sanitizeAuthEnv(authEnv);
  if (!clean) return { env: {}, secrets: [] };
  const env = { ...clean };
  const secretSet = new Set();

  for (const [k, v] of Object.entries(clean)) {
    if (!/_ID$/.test(k) && v.length >= 6) secretSet.add(v);
  }

  if (/\bgit\b/i.test(String(command || ''))) {
    const configs = [];
    const ghToken = clean.GITHUB_TOKEN || clean.GH_TOKEN;
    if (ghToken) {
      const b64 = Buffer.from(`x-access-token:${ghToken}`, 'utf8').toString('base64');
      secretSet.add(b64);
      configs.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${b64}`]);
    }
    const glToken = clean.GITLAB_TOKEN || clean.GL_TOKEN;
    if (glToken) {
      const b64 = Buffer.from(`oauth2:${glToken}`, 'utf8').toString('base64');
      secretSet.add(b64);
      configs.push(['http.https://gitlab.com/.extraheader', `AUTHORIZATION: basic ${b64}`]);
    }
    if (configs.length) {
      env.GIT_TERMINAL_PROMPT = '0';
      env.GIT_CONFIG_COUNT = String(configs.length);
      configs.forEach(([k, v], i) => {
        env[`GIT_CONFIG_KEY_${i}`] = k;
        env[`GIT_CONFIG_VALUE_${i}`] = v;
      });
    }
  }

  return { env, secrets: [...secretSet] };
}

/** Che mọi giá trị bí mật khỏi chuỗi đầu ra trước khi trả về BE. */
export function redactAuthText(text, secrets) {
  if (!text || !Array.isArray(secrets) || !secrets.length) return text;
  let out = String(text);
  const ordered = secrets.filter((s) => typeof s === 'string' && s.length >= 6).sort((a, b) => b.length - a.length);
  for (const s of ordered) {
    if (out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  return out;
}
