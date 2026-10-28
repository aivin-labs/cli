import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { DeviceErrorCode, REMOTE_CONFIG_DIR } from './constants.mjs';
import { DeviceToolError, scrubEnv } from './sandbox.mjs';
import { createMemberFsPool, runsInMemberWorker } from './memberFsPool.mjs';
import { deleteMemoryItems, getMemoryItem, listMemoryItems, putMemoryItems, searchMemory } from './deviceMemory.mjs';

/**
 * Chế độ nhiều người dùng (`aivin remote start --multi-user`) — máy tính đám mây của tổ chức: một container, mọi thành viên org dùng
 * chung. BE gắn `user_scope` (băm client + user id, dạng `u<12 hex>`) vào từng lời gọi; mỗi vùng là một tài khoản Linux riêng với thư
 * mục nhà riêng (700) — lệnh shell / git / ripgrep chạy dưới tài khoản đó, công cụ tệp chạy trong tiến trình con cũng dưới tài khoản
 * đó (memberFsPool.mjs) và chỉ thấy thư mục nhà của họ + thư mục chung,
 * bộ nhớ trên máy tách theo vùng. Tiến trình CLI chạy root (cần để tạo tài khoản và đổi sang tài khoản đó khi chạy lệnh); thư mục cấu
 * hình (token) chỉ root đọc được.
 *
 * Khớp BE: `src/official-plugins/device-agent/helper/OrgComputerHelper.ts` (thư mục nhà, thư mục chung, dạng vùng).
 */

export const HOME_BASE = '/home';
export const SHARED_DIR = '/shared';
/**
 * Nhóm CHÍNH của mọi tài khoản thành viên — tệp mới ở /shared tự thuộc nhóm này (không cần setgid: container không có CAP_FSETID nên nhân
 * Linux xoá bit setgid khi chmod). Thư mục nhà thì không cho nhóm vào (700).
 */
export const MEMBER_GROUP = 'aivin';
export const MEMBER_GID = 10000;
const FIRST_UID = 10001;
const USERS_FILE = path.join(REMOTE_CONFIG_DIR, 'users.json');
const SCOPE_RE = /^u[0-9a-f]{12}$/;

export function isValidUserScope(scope) {
  return typeof scope === 'string' && SCOPE_RE.test(scope);
}

export function isMultiUserMode(options = {}, env = process.env) {
  return !!options.multiUser || env.AIVIN_MULTI_USER === '1';
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'ignore' });
}

function readUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return data && typeof data === 'object' && data.users ? data : { users: {} };
  } catch {
    return { users: {} };
  }
}

function writeUsers(data) {
  fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
  const tmp = `${USERS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

/** Tài khoản đã có trong /etc/passwd của container chưa (container tạo lại thì mất, sổ uid trên volume thì còn). */
function linuxUserExists(name) {
  try {
    return fs.readFileSync('/etc/passwd', 'utf8').split('\n').some((line) => line.startsWith(`${name}:`));
  } catch {
    return false;
  }
}

/**
 * Bộ nhớ trên máy theo vùng: khoá mục mang tiền tố `<vùng>:` (một kho YAML chung, không đổi định dạng tệp). Đọc ra bỏ tiền tố và chỉ
 * trả mục của vùng — thành viên này không thấy quy trình / ghi nhớ của thành viên khác.
 */
export function scopedMemory(scope) {
  const prefix = `${scope}:`;
  const own = (item) => item && String(item.key || '').startsWith(prefix);
  const strip = (item) => ({ ...item, key: String(item.key).slice(prefix.length) });
  const all = (kind) => {
    const out = [];
    for (let cursor = 0; cursor !== null;) {
      const page = listMemoryItems({ kind, cursor, limit: 200 });
      out.push(...page.items);
      cursor = page.next_cursor;
    }
    return out.filter(own);
  };
  return {
    put: (items = []) => putMemoryItems((Array.isArray(items) ? items : []).map((i) => ({ ...i, key: `${prefix}${String(i?.key || '')}` }))),
    search: ({ query, vector, kinds, limit = 8 } = {}) => searchMemory({ query, vector, kinds, limit: Math.min(limit * 8, 200) })
      .filter(own).slice(0, limit).map(strip),
    get: ({ id, kind, key } = {}) => {
      const item = getMemoryItem(id ? { id } : { kind, key: `${prefix}${key || ''}` });
      return own(item) ? strip(item) : null;
    },
    list: ({ kind, cursor = 0, limit = 50 } = {}) => {
      const items = all(kind);
      const start = Math.max(0, Number(cursor) || 0);
      const size = Math.min(Math.max(1, Number(limit) || 50), 200);
      return { total: items.length, items: items.slice(start, start + size).map(strip), next_cursor: start + size < items.length ? start + size : null };
    },
    delete: ({ ids = [], kind, key } = {}) => {
      const mine = new Set(all().map((i) => i.id));
      return deleteMemoryItems({ ids: ids.filter((id) => mine.has(id)), ...(kind && key ? { kind, key: `${prefix}${key}` } : {}) });
    },
  };
}

/**
 * Máy chủ nhiều người dùng: chuẩn bị nhóm + thư mục chung lúc khởi động, cấp tài khoản Linux cho từng vùng theo yêu cầu (uid ổn định
 * ghi ở sổ trên volume cấu hình), dựng `env` riêng cho lời gọi của vùng đó.
 */
export function createMultiUserHost({ baseEnv, say = () => {} }) {
  const users = readUsers();
  const ready = new Map();

  function prepare() {
    process.umask(0o002);
    try { run('groupadd', ['-f', '-g', String(MEMBER_GID), MEMBER_GROUP]); } catch { /* đã có */ }
    for (const dir of [HOME_BASE, SHARED_DIR]) fs.mkdirSync(dir, { recursive: true });
    fs.chownSync(SHARED_DIR, 0, MEMBER_GID);
    // Sticky: mọi thành viên ghi / sửa được tệp chung (umask 002), nhưng chỉ chủ tệp xoá / đổi tên được — AI của người này không xoá
    // nhầm tệp của người khác.
    fs.chmodSync(SHARED_DIR, 0o1775);
    fs.chmodSync(HOME_BASE, 0o711);
    fs.mkdirSync(REMOTE_CONFIG_DIR, { recursive: true });
    fs.chmodSync(REMOTE_CONFIG_DIR, 0o700);
    say(`   Nhiều người dùng: ${Object.keys(users.users).length} tài khoản thành viên, thư mục chung ${SHARED_DIR}`);
  }

  function allocateUid() {
    const used = Object.values(users.users).map((u) => u.uid);
    return used.length ? Math.max(...used) + 1 : FIRST_UID;
  }

  /** Tài khoản + thư mục nhà của vùng (tạo lần đầu; container tạo lại thì dựng lại tài khoản theo đúng uid cũ). */
  function ensureUser(scope) {
    if (ready.has(scope)) return ready.get(scope);
    let entry = users.users[scope];
    if (!entry) {
      entry = { uid: allocateUid(), created_at: new Date().toISOString() };
      users.users[scope] = entry;
      writeUsers(users);
    }
    const home = path.join(HOME_BASE, scope);
    if (!linuxUserExists(scope)) {
      run('useradd', ['-M', '-N', '-u', String(entry.uid), '-g', String(MEMBER_GID), '-d', home, '-s', '/bin/bash', scope]);
    }
    if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
    fs.chownSync(home, entry.uid, MEMBER_GID);
    fs.chmodSync(home, 0o700);
    const account = { uid: entry.uid, gid: MEMBER_GID, home, name: scope };
    ready.set(scope, account);
    return account;
  }

  /** `env` cho một lời gọi: gốc = thư mục nhà của vùng + thư mục chung, lệnh chạy dưới tài khoản vùng, bộ nhớ của vùng. */
  function envFor(scope) {
    if (!isValidUserScope(scope)) throw new DeviceToolError(DeviceErrorCode.INVALID_ARGS, 'This shared computer needs a user scope for every call');
    const account = ensureUser(scope);
    return {
      ...baseEnv,
      roots: [account.home, SHARED_DIR],
      projects: [],
      fileIndex: null,
      browserTunnels: null,
      runAs: account,
      memory: scopedMemory(scope),
    };
  }

  // Công cụ tệp chạy trong tiến trình của chính thành viên (memberFsPool.mjs) — root không tự đụng tệp trong vùng người dùng nữa, tệp
  // mới cũng tự thuộc về họ (không cần chown lại).
  const fsPool = createMemberFsPool({
    binaries: baseEnv?.binaries || [],
    rootsOf: (account) => [account.home, SHARED_DIR],
    envOf: (account) => ({ ...accountEnv(account, scrubEnv()), AIVIN_REMOTE_HOME: REMOTE_CONFIG_DIR }),
  });
  const quota = createDiskQuota();

  function start() {
    prepare();
    quota.start();
  }

  /** Lời gọi `fs.*` của một vùng → tiến trình tệp của vùng đó. */
  function runFs(scope, tool, args, ctx) {
    return fsPool.call(ensureUser(scope), tool, args, ctx);
  }

  function close() {
    quota.stop();
    fsPool.closeAll();
  }

  return { prepare, start, envFor, ensureUser, runFs, runsInWorker: runsInMemberWorker, assertQuota: quota.assertAllowed, close };
}

/** Biến môi trường cho lệnh chạy dưới tài khoản thành viên (HOME / USER đúng tài khoản, không mang biến của tiến trình root). */
export function accountEnv(account, base) {
  return { ...base, HOME: account.home, USER: account.name, LOGNAME: account.name, SHELL: '/bin/bash', PATH: `${account.home}/.local/bin:${base.PATH || '/usr/local/bin:/usr/bin:/bin'}` };
}

// ── trần tài nguyên mỗi thành viên ──────────────────────────────────────────────────────────────

const PRLIMIT = '/usr/bin/prlimit';
const DEFAULT_MEMBER_MAX_PROCS = 128;
let nprocHardLimit;

/** Trần cứng RLIMIT_NPROC hiện tại của daemon (tiến trình con thừa hưởng) — không đặt cao hơn, prlimit của người thường sẽ lỗi. */
function currentNprocHard() {
  if (nprocHardLimit !== undefined) return nprocHardLimit;
  nprocHardLimit = Infinity;
  try {
    const m = fs.readFileSync('/proc/self/limits', 'utf8').match(/^Max processes\s+\S+\s+(\S+)/m);
    if (m && m[1] !== 'unlimited' && Number(m[1]) > 0) nprocHardLimit = Number(m[1]);
  } catch { /* không phải Linux */ }
  return nprocHardLimit;
}

export function memberMaxProcs(env = process.env) {
  const n = Math.floor(Number(env.AIVIN_MEMBER_MAX_PROCS));
  return n > 0 ? n : DEFAULT_MEMBER_MAX_PROCS;
}

/**
 * Lệnh chạy dưới tài khoản thành viên → bọc `prlimit --nproc=N:N -- <lệnh>` (Linux, có prlimit). RLIMIT_NPROC tính theo uid nên đây là
 * trần cho từng thành viên — fork bomb của một người không làm cạn bảng tiến trình của cả container.
 */
export function withProcessCap(cmd, argv, { platform = process.platform, exists = fs.existsSync, limit = memberMaxProcs(), hard } = {}) {
  if (platform !== 'linux' || !exists(PRLIMIT)) return [cmd, argv];
  const n = Math.min(limit, hard ?? currentNprocHard());
  return [PRLIMIT, [`--nproc=${n}:${n}`, '--', cmd, ...argv]];
}

/** Công cụ bị chặn khi hết dung lượng — đọc, liệt kê, xoá vẫn chạy để người dùng tự dọn chỗ. */
export const QUOTA_GUARDED_TOOLS = new Set(['fs.write', 'fs.edit', 'fs.move', 'shell.exec']);
const DISK_MEASURE_MS = 60_000;

/** Tổng byte của các thư mục (`du -sx -B1`, mỗi thư mục một dòng). */
export function measureDiskUsage(dirs) {
  return new Promise((resolve, reject) => {
    execFile('du', ['-sx', '-B1', ...dirs], { timeout: 50_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const lines = String(stdout || '').split('\n').map((l) => Number(l.split(/\s+/)[0])).filter((n) => Number.isFinite(n) && n >= 0);
      // du vẫn in tổng khi gặp vài tệp không đọc được (mã thoát ≠ 0) → còn số thì dùng.
      if (!lines.length) return reject(err || new Error('du printed nothing'));
      resolve(lines.reduce((a, b) => a + b, 0));
    });
  });
}

/**
 * Hạn mức đĩa mềm của máy tính tổ chức (`AIVIN_ORG_COMPUTER_DISK_GB`, BE đặt): đo nền mỗi phút, dùng số đã đo — lời gọi không chờ du.
 * Không có hạn mức / chưa đo được → không chặn.
 */
export function createDiskQuota({ dirs = [HOME_BASE, SHARED_DIR], quotaGb = Number(process.env.AIVIN_ORG_COMPUTER_DISK_GB), intervalMs = DISK_MEASURE_MS, measure = measureDiskUsage } = {}) {
  const limit = Number.isFinite(quotaGb) && quotaGb > 0 ? quotaGb * 1024 ** 3 : 0;
  let used = null;
  let running = false;
  let timer = null;

  async function refresh() {
    if (!limit || running) return used;
    running = true;
    try { used = await measure(dirs); } catch { /* giữ số đo trước */ } finally { running = false; }
    return used;
  }

  function start() {
    if (!limit || timer) return;
    void refresh();
    timer = setInterval(() => void refresh(), intervalMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  function assertAllowed(toolName) {
    if (!limit || used === null || used < limit || !QUOTA_GUARDED_TOOLS.has(toolName)) return;
    const gb = (used / 1024 ** 3).toFixed(1);
    throw new DeviceToolError(DeviceErrorCode.QUOTA_EXCEEDED, `Disk quota of this shared computer is full (${gb} GB used of ${quotaGb} GB) — delete files to free space, then retry`);
  }

  return { start, stop, refresh, assertAllowed, usage: () => ({ used, limit }) };
}
