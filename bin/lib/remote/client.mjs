import os from 'os';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import { io } from 'socket.io-client';
import { DEFAULT_AIVIN_BASE_URL } from '../context.mjs';
import { logActivity } from './activityLog.mjs';
import { DEFAULT_SCOPE_LIMITS, DEVICE_NAMESPACE, DeviceAccess, DeviceErrorCode, DeviceEvent, MAX_RESULT_BYTES, PROTOCOL_VERSION, ServerFeature } from './constants.mjs';
import { clearDeviceCredentials, credentialsFromEnv, listDevices, loadDeviceCredentials, pairDevice, pairDeviceWithCode, saveDeviceCredentials } from './credentials.mjs';
import { ensureMemoryLoaded, memoryStats, stopWatchingMemory, watchMemoryDir } from './deviceMemory.mjs';
import { buildCatalog, buildDeviceProfile } from './deviceProfile.mjs';
import { createFileIndex, indexRootsFor } from './fileIndexer.mjs';
import { createScheduler } from './scheduler.mjs';
import { acquireDaemonLock } from './daemonLock.mjs';
import { randomUUID } from 'crypto';
import { fullAccessRoots, isRemotePaused } from './sandbox.mjs';
import { buildTools, toolMap } from './toolHandlers.mjs';
import { createBrowserTunnels, detectLocalBrowser } from './browserTunnel.mjs';
import { createGuiController, detectGui } from './gui/index.mjs';
import { createWindowsHost } from './gui/windowsHost.mjs';
import { detectOfficeApps } from './office/index.mjs';
import { createUndoStore } from './undoStore.mjs';
import { createProcessManager } from './processes.mjs';
import { createIdempotentRunner } from './idempotency.mjs';
import { createWatchManager } from './deviceWatches.mjs';
import { createScheduleManager } from './schedule.mjs';
import { remoteDebuggingPage } from './dailyBrowser.mjs';
import { HOME_BASE, SHARED_DIR, createMultiUserHost, isMultiUserMode } from './multiUser.mjs';

const HEARTBEAT_MS = 20_000;
const STREAM_FLUSH_MS = 150;
const STREAM_FLUSH_BYTES = 16 * 1024;
const ACK_TIMEOUT_MS = 10_000;
/** Một lô tính vector (32 đoạn) trên BE — bge-m3 bận thì chờ lâu hơn ack thường. */
const EMBED_TIMEOUT_MS = 60_000;
/** Kiểm công tắc tạm dừng (`aivin remote pause` ở cửa sổ khác) bấy nhiêu lâu một lần. */
const PAUSE_POLL_MS = 2000;
/** Giữ tối đa bấy nhiêu kết quả làm xong lúc mất kết nối (gửi khi nối lại). */
const MAX_UNSENT_RESULTS = 200;

/** Gom đoạn stdout/stderr của một lời gọi, đẩy lên theo nhịp (không bắn mỗi dòng một gói). */
function createStreamer(socket, callId) {
  const buffers = { stdout: '', stderr: '' };
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    for (const stream of Object.keys(buffers)) {
      if (!buffers[stream]) continue;
      if (socket.connected) socket.emit(DeviceEvent.STREAM, { call_id: callId, stream, chunk: buffers[stream] });
      buffers[stream] = '';
    }
  };
  const push = (stream, chunk) => {
    buffers[stream] = (buffers[stream] || '') + chunk;
    if (buffers[stream].length >= STREAM_FLUSH_BYTES) flush();
    else if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS);
  };
  return { push, flush };
}

let unhandledRejectionHooked = false;
const MAX_CALL_ID = 64;
const MAX_TOOL_NAME = 128;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Lời gọi BE gửi xuống có đúng dạng không (object, call_id chuỗi ≤ 64, tool chuỗi, args object hoặc bỏ trống, timeout là số). */
export function isValidDeviceCall(call) {
  if (!isPlainObject(call)) return false;
  if (typeof call.call_id !== 'string' || !call.call_id || call.call_id.length > MAX_CALL_ID) return false;
  if (typeof call.tool !== 'string' || !call.tool || call.tool.length > MAX_TOOL_NAME) return false;
  if (call.args !== undefined && call.args !== null && !isPlainObject(call.args)) return false;
  if (call.timeout_ms !== undefined && call.timeout_ms !== null && !Number.isFinite(call.timeout_ms)) return false;
  if (call.user_scope !== undefined && call.user_scope !== null && typeof call.user_scope !== 'string') return false;
  if (call.idem_key !== undefined && call.idem_key !== null && (typeof call.idem_key !== 'string' || call.idem_key.length > 80)) return false;
  return true;
}

function boundedResult(outcome) {
  if (!outcome.ok) return outcome;
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(outcome.result ?? null)); } catch { size = MAX_RESULT_BYTES + 1; }
  if (size <= MAX_RESULT_BYTES) return outcome;
  return { ok: false, error: `Result too large (${size} bytes) — read smaller ranges`, error_code: DeviceErrorCode.OUTPUT_TOO_LARGE, duration_ms: outcome.duration_ms };
}

/**
 * Máy chủ của daemon: `--server` nêu rõ → có mã kết nối thì mặc định (mã chỉ đúng với máy chủ tạo ra nó, không theo cấu hình đăng nhập
 * cũ) → máy chủ ĐÃ GHÉP → cấu hình đăng nhập → mặc định. Máy đã ghép đứng trước đăng nhập: ngược lại thì máy ghép bằng mã với máy chủ A,
 * khởi động lại trên máy đang đăng nhập CLI với máy chủ B sẽ lặng lẽ ghép lại sang B bằng API key (chạy thật 26/10/2026). Đổi máy chủ
 * thì dùng `--server` (hoặc `--repair`).
 */
export function resolveServerUrl(options, saved, env = process.env) {
  const url = options.server || options.serverUrl
    || (options.code ? undefined : (options.repair ? undefined : saved?.server_url) || env.AIVIN_BASE_URL)
    || DEFAULT_AIVIN_BASE_URL;
  return String(url).replace(/\/+$/, '');
}

/**
 * Thông tin ghép máy: có mã kết nối thì luôn ghép bằng mã (người dùng vừa bấm "Thêm máy tính này"); có sẵn và đúng máy chủ thì dùng;
 * không thì ghép mới bằng API key đang đăng nhập.
 */
async function ensurePaired({ serverUrl, apiKey, code, roots, rootsGiven, name, repair, profile }) {
  let creds = loadDeviceCredentials();
  if (code) {
    creds = await pairDeviceWithCode({ serverUrl, code, roots, name, profile });
  } else if (!creds || creds.server_url !== serverUrl || repair) {
    creds = await pairDevice({ serverUrl, apiKey, roots, name, profile });
  } else if (rootsGiven && JSON.stringify(roots) !== JSON.stringify(creds.roots)) {
    creds.roots = roots;
    saveDeviceCredentials(creds);
  }
  return creds;
}

/**
 * Daemon nhận việc từ BE (`aivin remote start`): ghép máy (token thiết bị riêng), nối namespace `/device`, công bố hồ sơ + danh mục công
 * cụ theo năng lực máy, nhận lô lời gọi, chạy song song theo nhóm, trả kết quả + luồng stdout. Thư mục gốc, công tắc ngắt, lọc biến môi
 * trường là sàn cứng trên máy — BE không đổi được.
 */
export async function startRemoteClient(options = {}) {
  // Máy tính tổ chức (`--multi-user`, container do Aivin cấp): token từ env, mọi thành viên org dùng chung, mỗi người một vùng riêng.
  const multiUser = isMultiUserMode(options);
  const envCreds = multiUser ? credentialsFromEnv() : null;
  if (multiUser && !envCreds) throw new Error('--multi-user cần AIVIN_DEVICE_TOKEN, AIVIN_DEVICE_ID và AIVIN_SERVER (máy tính tổ chức do Aivin cấp).');
  if (multiUser && process.platform === 'win32') throw new Error('--multi-user chỉ chạy trên Linux (container máy tính tổ chức).');
  const saved = envCreds || loadDeviceCredentials();
  const serverUrl = resolveServerUrl(options, saved);
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const rootsGiven = Boolean(options.dir) && !multiUser;
  // Toàn quyền: chủ máy chọn lúc kết nối (`--full-access`), giữ qua các lần khởi động lại; `--dir` tường minh thì về chế độ một thư mục.
  // Nhiều người dùng: mỗi thành viên toàn quyền trong vùng của mình (thư mục nhà + thư mục chung) — gốc thật đặt theo từng lời gọi.
  const fullAccess = multiUser || (!rootsGiven && (!!options.fullAccess || (!options.code && saved?.access === DeviceAccess.FULL)));
  const roots = multiUser ? [HOME_BASE, SHARED_DIR] : fullAccess ? fullAccessRoots()
    : rootsGiven ? [path.resolve(options.dir)] : (saved?.access !== DeviceAccess.FULL && saved?.roots?.length ? saved.roots : [process.cwd()]);
  // Dò dự án + chỉ mục tệp chỉ trong thư mục nhà khi toàn quyền — quét cả ổ C: là hàng trăm nghìn tệp hệ thống vô ích.
  const scanRoots = multiUser ? [] : fullAccess ? [os.homedir()] : roots;
  const quiet = !!options.quiet;
  const say = (...args) => { if (!quiet) console.log(...args); };

  // Cửa sổ thứ hai cùng thư mục cấu hình → dừng ngay với hướng dẫn (trừ khi ghép lại bằng mã: cửa sổ cũ sẽ tự dừng).
  const releaseLock = acquireDaemonLock({ takeOver: !!options.code });
  const access = fullAccess ? DeviceAccess.FULL : DeviceAccess.FOLDERS;
  // Chrome / Edge cho AI Browser (CLI ≥ 1.0.8) — có thì BE cho việc trên web chạy ở trình duyệt của máy này.
  const browser = options.browser === false || multiUser ? null : detectLocalBrowser();
  // Điều khiển giao diện (Windows): cây trợ năng + chuột / bàn phím cho ứng dụng không có dòng lệnh.
  const guiProfile = detectGui({ disabled: options.gui === false, multiUser });
  // Excel / Word / Outlook có trên máy → công cụ office.* qua COM (tự phát hiện, người dùng không cấu hình gì).
  const officeApps = detectOfficeApps({ multiUser });
  const profile = {
    ...buildDeviceProfile(scanRoots), roots: roots.map((r) => path.resolve(r)), access,
    ...(browser ? { browser } : {}), ...(guiProfile ? { gui: guiProfile } : {}), ...(officeApps.length ? { apps: officeApps } : {}),
    // Theo dõi kích hoạt việc (CLI ≥ 1.0.9) — máy tính tổ chức không có.
    ...(multiUser ? {} : { watch: true }),
    // Tệp lớn qua HTTP thẳng (fs.upload / fs.download, công cụ BE-only nên BE biết qua cờ này) — máy tính tổ chức không có.
    ...(multiUser ? {} : { direct_transfer: true }),
  };
  let creds;
  try {
    creds = envCreds || await ensurePaired({ serverUrl, apiKey, code: options.code, roots, rootsGiven, name: options.name, repair: options.repair, profile });
  } catch (e) {
    releaseLock();
    throw e;
  }
  if (!envCreds && (creds.access !== access || JSON.stringify(creds.roots) !== JSON.stringify(profile.roots))) {
    creds.access = access;
    creds.roots = profile.roots;
    saveDeviceCredentials(creds);
  }
  if (options.code) say(chalk.green(`✅ Đã kết nối máy "${creds.name}" với tài khoản Aivin của bạn — quay lại Aivin để chọn máy này.`));
  ensureMemoryLoaded();
  watchMemoryDir();
  const fileIndex = multiUser ? null : createFileIndex(indexRootsFor(roots, fullAccess));
  const useDailyBrowser = options.separateBrowser !== true;
  const browserTunnels = browser ? createBrowserTunnels({ serverUrl, deviceToken: creds.device_token, browser, useDailyBrowser, say: (m) => say(chalk.cyan(m)) }) : null;
  // Một tiến trình host chung cho giao diện + Office (chỉ dựng khi lời gọi đầu tiên cần).
  const winHost = guiProfile || officeApps.length ? createWindowsHost() : null;
  const gui = guiProfile ? createGuiController({ fullAccess, host: winHost, say: (m) => say(chalk.magenta(m)) }) : null;
  // Kho hoàn tác (xoá → thùng rác của kho, ghi đè → giữ bản cũ). Máy tính tổ chức: công cụ tệp chạy dưới tài khoản thành viên, không có kho.
  const undo = multiUser ? null : createUndoStore();
  void undo?.cleanup().catch(() => undefined);
  const processes = createProcessManager();
  const schedules = multiUser ? null : createScheduleManager({ undo });
  // Sự kiện của theo dõi đi lên BE qua socket (đã nối) — `socket` được tạo ngay bên dưới, sự kiện chỉ có sau khi BE đặt danh sách.
  const watches = multiUser ? null : createWatchManager({
    roots, say: (m) => say(chalk.cyan(m)),
    emit: (payload) => { if (socket?.connected) socket.emit(DeviceEvent.EVENT, payload); },
  });
  // Tệp lớn đi HTTP thẳng với vé của BE (fs.upload / fs.download) — máy tính tổ chức không có (gửi HTTP chạy bằng tài khoản của daemon).
  const transfer = multiUser ? null : { serverUrl, deviceToken: creds.device_token };
  const env = { roots, binaries: profile.binaries, projects: profile.projects, fileIndex, browserTunnels, gui, office: officeApps.length ? { host: winHost, apps: officeApps } : null, undo, processes, schedules, watches, transfer };
  const host = multiUser ? createMultiUserHost({ baseEnv: env, say: (m) => say(chalk.gray(m)) }) : null;
  host?.start();
  const tools = buildTools(env);
  const byName = toolMap(tools);
  const { catalog, hash } = buildCatalog(tools);
  // Nhiều người dùng: thêm trần song song theo từng thành viên — một người không chiếm hết chỗ của cả tổ chức.
  const scheduler = createScheduler(multiUser ? { scopeLimits: DEFAULT_SCOPE_LIMITS } : undefined);

  say(chalk.blue('💻 Aivin Device Agent — máy này nhận việc từ agent của bạn'));
  say(chalk.gray(`   Máy:        ${creds.name} (${creds.device_id})`));
  say(chalk.gray(fullAccess ? `   Quyền:      TOÀN QUYỀN máy (${roots.slice(1).join(' ')}) — trừ thư mục cấu hình Aivin` : `   Thư mục:    ${roots.join(' | ')}`));
  say(chalk.gray(`   Máy chủ:    ${serverUrl}`));
  say(chalk.gray(`   Công cụ:    ${catalog.length} (${profile.binaries.join(', ') || 'không phát hiện chương trình nào'})`));
  say(chalk.gray(`   Ghi nhớ:    ${memoryStats().total} mục — ${memoryStats().dir}`));
  if (officeApps.length) say(chalk.gray(`   Office:     ${officeApps.join(', ')} — AI làm qua ứng dụng, chạy nền`));
  say(chalk.gray(`   Giao diện:  ${gui ? 'AI điều khiển được cửa sổ ứng dụng (di chuột / gõ phím để AI dừng; tắt: --no-gui)' : 'không (chỉ Windows, tắt bằng --no-gui)'}`));
  say(chalk.gray(`   Trình duyệt: ${!browser ? 'không có Chrome / Edge — AI dùng trình duyệt trên máy chủ'
    : useDailyBrowser ? `${browser.name} hằng ngày của bạn nếu đã bật ${remoteDebuggingPage(browser.id)}, không thì cửa sổ riêng của Aivin`
      : `${browser.name} (cửa sổ riêng của Aivin)`}`));
  if (isRemotePaused()) say(chalk.yellow('   ⏸  Đang TẠM DỪNG (aivin remote resume để nhận việc lại)'));

  fileIndex?.build()
    .then((s) => { say(chalk.gray(`   Chỉ mục tệp: ${s.files} tệp (${s.updated} cập nhật, ${s.ms} ms)`)); fileIndex.watch(); })
    .catch((e) => say(chalk.yellow(`   ⚠️  Lập chỉ mục tệp lỗi: ${e.message}`)));

  // Mã phiên chạy của tiến trình này: BE báo socket cũ "bị thay bởi instance X" — chỉ dừng khi X là tiến trình KHÁC (tự nối lại
  // sau khi mạng chập chờn thì không dừng nhầm).
  const instance = randomUUID();
  const socket = io(`${serverUrl}${DEVICE_NAMESPACE}`, {
    auth: { device_token: creds.device_token, protocol: PROTOCOL_VERSION, instance },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.5,
  });

  let stopped = false;
  const heartbeat = setInterval(() => { if (socket.connected) socket.emit(DeviceEvent.HEARTBEAT, {}); }, HEARTBEAT_MS);

  // `aivin remote pause` ở cửa sổ khác: huỷ NGAY việc đang chạy (lệnh shell, đường hầm trình duyệt), không chỉ chặn việc mới.
  let pausedSeen = isRemotePaused();
  const pauseWatch = setInterval(() => {
    const paused = isRemotePaused();
    if (paused && !pausedSeen) {
      say(chalk.yellow('⏸  Đã tạm dừng — huỷ việc đang chạy và đóng trình duyệt AI đang dùng.'));
      void scheduler.cancelAll('Remote control was paused on this device');
      browserTunnels?.closeAll();
      winHost?.close();
      processes.stopAll();
    }
    pausedSeen = paused;
  }, PAUSE_POLL_MS);
  pauseWatch.unref?.();

  // Kết quả làm xong lúc đang mất kết nối: giữ lại, gửi khi nối lại (BE vẫn chờ tới hết giờ — mất là agent chạy lại lệnh có tác dụng phụ).
  const unsent = new Map();
  const sendResult = (payload) => {
    if (socket.connected) socket.emit(DeviceEvent.RESULT, payload);
    else if (unsent.size < MAX_UNSENT_RESULTS) unsent.set(payload.call_id, payload);
  };
  const flushUnsent = () => {
    for (const [id, payload] of unsent) {
      if (!socket.connected) return;
      socket.emit(DeviceEvent.RESULT, payload);
      unsent.delete(id);
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    clearInterval(pauseWatch);
    const draining = scheduler.cancelAll('The Aivin agent on this device stopped');
    socket.disconnect();
    browserTunnels?.closeAll();
    gui?.close();
    winHost?.close();
    processes.stopAll();
    watches?.closeAll();
    host?.close();
    fileIndex?.close();
    stopWatchingMemory();
    releaseLock();
    say(chalk.gray('🛑 Đã dừng nhận việc từ xa.'));
    return draining;
  };

  const embedTexts = async (texts) => {
    if (!socket.connected) return null;
    const res = await socket.timeout(EMBED_TIMEOUT_MS).emitWithAck(DeviceEvent.EMBED, { texts });
    return res?.ok ? res.vectors : null;
  };

  const announce = async () => {
    try {
      const hello = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.HELLO, { protocol: PROTOCOL_VERSION, profile, catalog_hash: hash });
      if (hello?.need_catalog) await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.CATALOG, { catalog_hash: hash, tools: catalog });
      // BE mới tính vector cho tệp tài liệu (tìm theo nghĩa); BE cũ không báo → chỉ tìm theo từ khoá.
      if (fileIndex && Array.isArray(hello?.features) && hello.features.includes(ServerFeature.EMBED)) fileIndex.setEmbedder(embedTexts);
      // Theo dõi của máy (BE giữ) — nối lại sau khi mất mạng / khởi động lại daemon thì mở lại đúng danh sách.
      if (watches && Array.isArray(hello?.features) && hello.features.includes(ServerFeature.WATCH)) {
        const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.WATCHES, {}).catch(() => null);
        if (Array.isArray(res?.watches)) watches.set(res.watches);
      }
      say(chalk.green('✅ Đã kết nối — sẵn sàng nhận việc.'));
      logActivity({ type: 'connected', serverUrl, deviceId: creds.device_id });
    } catch (e) {
      say(chalk.yellow(`⚠️  Chào máy chủ lỗi (${e.message}) — sẽ thử lại khi nối lại.`));
    }
  };

  // Nhiều người dùng: stdout vào log docker của máy chủ → không in tham số / thông báo lỗi (đường tệp, nội dung của thành viên), chỉ
  // tên công cụ + vài ký tự đầu của vùng.
  const callLabel = (call) => (host ? `${call.tool} [${String(call.user_scope || '-').slice(0, 5)}]` : call.tool);

  const runCall = async (call, streamer) => {
    const tool = byName.get(call.tool);
    if (isRemotePaused()) return { tool, outcome: { ok: false, error: 'Remote control is paused on this device', error_code: DeviceErrorCode.KILL_SWITCH, duration_ms: 0 } };
    if (!tool) return { tool, outcome: { ok: false, error: `Unknown tool: ${call.tool}`, error_code: DeviceErrorCode.TOOL_UNKNOWN, duration_ms: 0 } };
    if (!tool.internal) say(chalk.yellow(`⚡ ${callLabel(call)}`), ...(host ? [] : [chalk.gray(JSON.stringify(call.args || {}).slice(0, 160))]));
    let callEnv = env;
    try {
      if (host) {
        callEnv = host.envFor(call.user_scope);
        host.assertQuota(call.tool);
      }
    } catch (e) {
      return { tool, outcome: { ok: false, error: e.message, error_code: e.code || DeviceErrorCode.INVALID_ARGS, duration_ms: 0 } };
    }
    // Máy tính tổ chức: công cụ tệp chạy trong tiến trình của thành viên, không chạy bằng root (xem memberFsPool.mjs).
    const handler = host?.runsInWorker(call.tool)
      ? (args, ctx) => host.runFs(call.user_scope, call.tool, args, ctx)
      : (args, ctx) => tool.handler(args, ctx, callEnv);
    const outcome = boundedResult(await scheduler.run(
      call,
      { group: tool.group, lockKeys: tool.lockKeys ? (a) => tool.lockKeys(a, callEnv) : undefined },
      handler,
      { onOutput: streamer.push },
    ));
    return { tool, outcome };
  };

  // Chống làm trùng khi BE gửi lại lô bước dở (xem idempotency.mjs).
  const runOnce = createIdempotentRunner(runCall, (name) => !!byName.get(name)?.read_only, {
    onDuplicate: (call) => say(chalk.gray(`  ↺ ${callLabel(call)}: đã làm ở lần gửi trước — trả lại kết quả cũ`)),
  });

  /** Không bao giờ ném / để lọt promise bị từ chối: lỗi bất ngờ vẫn trả kết quả lỗi cho BE. */
  const handleCall = async (call) => {
    const streamer = createStreamer(socket, call.call_id);
    let tool;
    let outcome;
    try {
      ({ tool, outcome } = await runOnce(call, streamer));
    } catch (e) {
      outcome = { ok: false, error: e?.message || String(e), error_code: e?.code || DeviceErrorCode.EXECUTION_FAILED, duration_ms: 0 };
    }
    try {
      streamer.flush();
      sendResult({ call_id: call.call_id, ...outcome });
      logActivity({ type: 'tool_call', tool: call.tool, id: call.call_id, success: outcome.ok, error: outcome.error, ms: outcome.duration_ms });
      if (!tool?.internal) {
        const failed = host ? outcome.error_code : outcome.error;
        say(outcome.ok ? chalk.green(`  ✓ ${callLabel(call)} (${outcome.duration_ms} ms)`) : chalk.red(`  ✗ ${callLabel(call)}: ${failed}`));
      }
    } catch (e) {
      console.error(chalk.red(`⚠️  Gửi kết quả ${call.tool} lỗi: ${e?.message || e}`));
    }
  };

  /** Bọc trình xử lý sự kiện socket: một gói hỏng không được làm sập daemon (socket.io không bắt lỗi trong listener). */
  const guarded = (event, fn) => (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error(chalk.red(`⚠️  Xử lý ${event} lỗi: ${e?.message || e}`)));
    } catch (e) {
      console.error(chalk.red(`⚠️  Xử lý ${event} lỗi: ${e?.message || e}`));
    }
  };

  socket.on('connect', guarded('connect', async () => { await announce(); flushUnsent(); }));
  let serverKicks = 0;
  socket.on('disconnect', guarded('disconnect', (reason) => {
    if (stopped) return;
    say(chalk.yellow(`⚠️  Mất kết nối (${reason}) — tự nối lại...`));
    logActivity({ type: 'disconnected', reason });
    // Server chủ động cắt (BE khởi động lại, socket khác của máy này vừa thay chỗ…) → socket.io-client KHÔNG tự nối lại; nối tay, giãn nhịp.
    if (reason === 'io server disconnect') {
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(serverKicks++, 5)) + Math.floor(Math.random() * 500);
      setTimeout(() => { if (!stopped) socket.connect(); }, delay);
    }
  }));
  socket.on('connect', () => { serverKicks = 0; });
  socket.on('connect_error', guarded('connect_error', (err) => {
    if (err?.message === 'DEVICE_UNAUTHORIZED') {
      const replaced = !clearDeviceCredentials(creds.device_token);
      console.log(chalk.red(replaced
        ? '❌ Máy này vừa được ghép lại bởi một cửa sổ khác — cửa sổ này dừng, cửa sổ mới tiếp tục nhận việc.'
        : '❌ Token của máy không còn hiệu lực (đã thu hồi hoặc ghép lại ở nơi khác). Chạy `aivin remote start` để ghép lại.'));
      stop();
      return;
    }
    say(chalk.gray(`   (chưa nối được: ${err?.message} — thử lại...)`));
  }));
  socket.on(DeviceEvent.REPLACED, guarded(DeviceEvent.REPLACED, (payload) => {
    if (!payload?.by_instance || payload.by_instance === instance) return;
    console.log(chalk.red('❌ Máy này vừa được mở nhận việc ở một cửa sổ hoặc máy khác — cửa sổ này dừng để hai bên không tranh nhau.'));
    stop();
  }));
  socket.on(DeviceEvent.REVOKED, guarded(DeviceEvent.REVOKED, () => {
    clearDeviceCredentials(creds.device_token);
    console.log(chalk.red('❌ Máy này đã bị thu hồi quyền điều khiển từ xa.'));
    stop();
  }));
  socket.on(DeviceEvent.CALLS, guarded(DeviceEvent.CALLS, (payload) => {
    // Chỉ nhận / ACK lời gọi đúng dạng — `{ calls: [null] }` từng làm sập daemon (null.call_id trong listener).
    const calls = (Array.isArray(payload?.calls) ? payload.calls : []).filter(isValidDeviceCall);
    if (!calls.length) return;
    socket.emit(DeviceEvent.ACK, { call_ids: calls.map((c) => c.call_id) });
    calls.forEach((call) => void handleCall(call));
  }));
  socket.on(DeviceEvent.CANCEL, guarded(DeviceEvent.CANCEL, (payload) => {
    if (Array.isArray(payload?.call_ids)) scheduler.cancel(payload.call_ids.filter((id) => typeof id === 'string'));
  }));

  // Lưới cuối: promise bị từ chối mà không ai bắt → ghi log, KHÔNG thoát (daemon phục vụ cả tổ chức, chết là mất mọi lời gọi đang chạy).
  if (!unhandledRejectionHooked) {
    unhandledRejectionHooked = true;
    process.on('unhandledRejection', (reason) => console.error(chalk.red(`⚠️  Lỗi không được xử lý: ${reason?.stack || reason?.message || reason}`)));
  }

  if (options.handleSignals !== false) {
    // Chờ huỷ xong việc đang chạy (giết cây tiến trình con) rồi mới thoát — trước đây tiến trình con tách rời còn sống sau Ctrl+C.
    const onSignal = () => { Promise.resolve(stop()).finally(() => process.exit(0)); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  return { stop, socket, profile, env, creds, scheduler, catalog };
}

/**
 * Kiểm nhanh: máy chủ HTTP, đã ghép chưa, BE có thấy máy này online không. KHÔNG tự bắt tay bằng token thiết bị — mỗi máy chỉ một
 * socket, bắt tay thử sẽ đá daemon đang chạy ra.
 */
export async function testRemoteConnection(options = {}) {
  const creds = loadDeviceCredentials();
  const serverUrl = resolveServerUrl(options, creds);
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const report = { serverUrl, paired: !!creds, deviceId: creds?.device_id, httpOk: false, latencyMs: null, online: null, error: null };
  const startedAt = Date.now();
  try {
    const res = await axios.get(`${serverUrl}/setting/lang/default`, { timeout: 6000, validateStatus: () => true });
    report.httpOk = res.status < 500;
    report.latencyMs = Date.now() - startedAt;
  } catch (e) {
    report.error = `HTTP: ${e.message}`;
  }
  if (!creds || !apiKey) return report;
  try {
    const devices = await listDevices({ serverUrl, apiKey });
    const me = devices.find((d) => d.device_id === creds.device_id);
    report.online = me ? me.online : false;
    report.registered = !!me;
    report.toolsOnServer = me?.tools_count;
  } catch (e) {
    report.error = e.message;
  }
  return report;
}
