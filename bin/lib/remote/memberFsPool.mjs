import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { DeviceErrorCode } from './constants.mjs';
import { DeviceToolError } from './sandbox.mjs';

/**
 * Công cụ tệp của máy tính tổ chức chạy trong tiến trình con DƯỚI TÀI KHOẢN THÀNH VIÊN (mỗi vùng một tiến trình, dùng lại giữa các lời
 * gọi). Daemon chạy root: nếu root tự đọc / ghi thì thành viên tráo một thư mục thành symlink giữa lúc kiểm đường và lúc dùng là root đọc
 * / ghi được mọi nơi (nhà người khác, thư mục token, /etc). Chạy bằng uid của thành viên thì nhân Linux tự chặn phần họ không có quyền.
 *
 * Giao thức IPC: `{ id, tool, args, timeoutMs }` → `{ id, ok, result | error, error_code }`; huỷ: `{ cancel: id }`. Rảnh quá `idleMs` thì
 * tắt, chết giữa chừng thì lời gọi đang chờ báo lỗi và lần sau dựng lại.
 */

export const MEMBER_FS_WORKER_PATH = fileURLToPath(new URL('./memberFsWorker.mjs', import.meta.url));
export const MEMBER_FS_IDLE_MS = 10 * 60_000;
/** Biến môi trường mang cấu hình cho tiến trình con (gốc, chương trình có trên máy, uid mong đợi). */
export const MEMBER_FS_CONFIG_ENV = 'AIVIN_FS_WORKER_CONFIG';

/** Công cụ nào chạy trong tiến trình của thành viên: mọi `fs.*` — công cụ tệp thêm sau này mặc định cũng không chạy bằng root. */
export function runsInMemberWorker(toolName) {
  return typeof toolName === 'string' && toolName.startsWith('fs.');
}

/**
 * `envOf(account)` → biến môi trường cho tiến trình con (đã lọc bí mật, HOME / USER của thành viên). `rootsOf(account)` → gốc được phép.
 * `account` = { name, home, uid?, gid? } — không có uid (Windows / test) thì chạy cùng tài khoản hiện tại.
 */
export function createMemberFsPool({ envOf, rootsOf, binaries = [], idleMs = MEMBER_FS_IDLE_MS, workerPath = MEMBER_FS_WORKER_PATH } = {}) {
  const workers = new Map();
  let seq = 0;

  function stopWorker(state) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    try { state.child.disconnect(); } catch { /* đã ngắt */ }
    // Tiến trình con thoát khi mất kênh IPC; không thoát kịp thì giết.
    const killer = setTimeout(() => { if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGKILL'); }, 2000);
    killer.unref?.();
  }

  function touch(state) {
    if (state.pending.size || state.idleTimer) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (!state.pending.size) {
        if (workers.get(state.name) === state) workers.delete(state.name);
        stopWorker(state);
      }
    }, idleMs);
    state.idleTimer.unref?.();
  }

  function failAll(state, error) {
    for (const p of state.pending.values()) p.fail(error);
    state.pending.clear();
  }

  function spawnWorker(account) {
    const hasIds = typeof account.uid === 'number' && typeof process.getuid === 'function';
    const config = { roots: rootsOf(account), binaries, ...(hasIds ? { expectUid: account.uid } : {}) };
    const child = fork(workerPath, [], {
      cwd: account.home,
      env: { ...envOf(account), [MEMBER_FS_CONFIG_ENV]: JSON.stringify(config) },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      ...(hasIds ? { uid: account.uid, gid: account.gid } : {}),
    });
    const state = { name: account.name, child, pending: new Map(), idleTimer: null };
    const onGone = (reason) => {
      if (workers.get(account.name) === state) workers.delete(account.name);
      clearTimeout(state.idleTimer);
      failAll(state, new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `File worker stopped (${reason}) — retry the call`));
    };
    child.on('message', (msg) => {
      const p = msg && state.pending.get(msg.id);
      if (!p) return;
      state.pending.delete(msg.id);
      p.settle(msg);
      touch(state);
    });
    child.on('exit', (code, signal) => onGone(signal || `exit ${code}`));
    child.on('error', (e) => onGone(e.message));
    workers.set(account.name, state);
    return state;
  }

  function workerFor(account) {
    const current = workers.get(account.name);
    if (current && current.child.connected && current.child.exitCode === null) return current;
    return spawnWorker(account);
  }

  /** Chạy một công cụ tệp trong tiến trình của thành viên. `ctx.signal` huỷ → báo tiến trình con dừng, trả lỗi ngay. */
  function call(account, tool, args, { signal, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason || new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled'));
      const state = workerFor(account);
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
      const id = ++seq;
      const onAbort = () => {
        if (!state.pending.delete(id)) return;
        try { state.child.send({ cancel: id }); } catch { /* đã chết */ }
        reject(signal.reason || new DeviceToolError(DeviceErrorCode.CANCELLED, 'Cancelled'));
        touch(state);
      };
      const done = () => signal?.removeEventListener('abort', onAbort);
      state.pending.set(id, {
        settle: (msg) => {
          done();
          if (msg.ok) resolve(msg.result);
          else reject(new DeviceToolError(msg.error_code || DeviceErrorCode.EXECUTION_FAILED, msg.error || 'File worker failed'));
        },
        fail: (e) => { done(); reject(e); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        state.child.send({ id, tool, args: args || {}, timeoutMs }, (err) => {
          if (err && state.pending.delete(id)) { done(); reject(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `File worker unavailable: ${err.message}`)); }
        });
      } catch (e) {
        if (state.pending.delete(id)) { done(); reject(new DeviceToolError(DeviceErrorCode.EXECUTION_FAILED, `File worker unavailable: ${e.message}`)); }
      }
    });
  }

  function closeAll() {
    for (const state of workers.values()) stopWorker(state);
    workers.clear();
  }

  return { call, closeAll, size: () => workers.size, pidOf: (name) => workers.get(name)?.child.pid };
}
