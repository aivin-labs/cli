import os from 'os';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline/promises';
import { io } from 'socket.io-client';
import { DEFAULT_AIVIN_BASE_URL } from '../context.mjs';
import { logActivity } from './activityLog.mjs';
import { DEFAULT_SCOPE_LIMITS, DEVICE_NAMESPACE, CastState, DeviceAccess, DeviceErrorCode, DeviceEvent, HoldPhase, MAX_RESULT_BYTES, PROTOCOL_VERSION, REMOTE_IDEM_FILE, REMOTE_OUTBOX_FILE, ServerFeature, ToolGroup } from './constants.mjs';
import { CallState, createCallLedger } from './callLedger.mjs';
import { fallBackToPreviousToken, settleRotation } from './tokenRotation.mjs';
import { configureProxy, proxyAgentFor } from './netProxy.mjs';
import { createKeepAwake } from './keepAwake.mjs';
import { createPolicyGuard, describeCall, evaluateLocalPolicy } from './localPolicy.mjs';
import { ConfirmResult, createLocalConfirmer } from './localConfirm.mjs';
import { clearDeviceCredentials, credentialsFromEnv, listDevices, loadDeviceCredentials, pairDevice, pairDeviceWithCode, readStoredTokenFresh, saveDeviceCredentials } from './credentials.mjs';
import { ensureMemoryLoaded, memoryStats, stopWatchingMemory, watchMemoryDir } from './deviceMemory.mjs';
import { buildCatalog, buildDeviceProfile } from './deviceProfile.mjs';
import { createFileIndex, indexRootsFor } from './fileIndexer.mjs';
import { createScheduler } from './scheduler.mjs';
import { acquireDaemonLock, lockHolder } from './daemonLock.mjs';
import { randomUUID } from 'crypto';
import { DeviceToolError, fullAccessRoots, isRemotePaused, setRemotePaused } from './sandbox.mjs';
import { createMascot, HostEvent as MascotHostEvent, loadMascotSettings, saveMascotSettings } from './mascot/index.mjs';
import { createMascotChat } from './mascot/ask.mjs';
import { mascotLang } from './mascot/strings.mjs';
import { refreshDesktopIntegration } from './desktop/index.mjs';
import { WORK_FOLDER_CONFIRM_SEC, WorkFolderStatus, isAllowedWorkFolder, resolveWorkFolder, withExtraRoots, workFolderConfirmText } from './workFolder.mjs';
import { showOSNotification } from './notify.mjs';
import { createMeetingManager, watchMeetingRequests } from './meeting/index.mjs';
import { createMediaHost, mediaSupported } from './meeting/recorder.mjs';
import { createClipboard } from './clipboard.mjs';
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
import { createAutoUpdater } from './autoUpdate.mjs';
import { createDesktopCastManager } from './desktop/desktopCast.mjs';
import { createDesktopWebRtcWorker } from './desktop/webrtcWorker.mjs';
import { CastInputRejection, createCastInputGate } from './desktop/castInput.mjs';
import { createCastFileDrop, FileDropReason, revealInExplorer } from './desktop/castFileDrop.mjs';
import {
  BootAction, MAX_BOOTS_BEFORE_ROLLBACK, RESTART_EXIT_CODE, UPDATE_CONFIRM_AFTER_MS, UPDATE_ROLLED_BACK, checkBootAfterUpdate, cleanupRetired, clearStaleInstalledMarker,
  confirmUpdate, ingestSupervisorRollback, isStandaloneBinary, noteCleanExit, updateProfile,
} from '../selfUpdate.mjs';
import { cliLaunchCommand, detectSupervisor } from './autoStart.mjs';

const HEARTBEAT_MS = 20_000;
// Nhịp nối lại tối đa. Máy cá nhân giãn tới 30 s (nhiều máy cùng dội BE lúc deploy). Cloud Computer (`--multi-user`): một socket / org qua
// mạng nội bộ, BE có thể đang chờ máy nối về để giao việc — giãn 30 s (+50 % ngẫu nhiên) nghĩa là BE lên lại rồi vẫn chờ tới ~45 s (28/10/2026).
const RECONNECT_DELAY_MAX_MS = 30_000;
const MULTI_USER_RECONNECT_DELAY_MAX_MS = 2_000;
const STREAM_FLUSH_MS = 150;
const STREAM_FLUSH_BYTES = 16 * 1024;
const ACK_TIMEOUT_MS = 10_000;
/** Một lô tính vector (32 đoạn) trên BE — bge-m3 bận thì chờ lâu hơn ack thường. */
const EMBED_TIMEOUT_MS = 60_000;
/** Kiểm công tắc tạm dừng (`aivin remote pause` ở cửa sổ khác) bấy nhiêu lâu một lần. */
const PAUSE_POLL_MS = 2000;
/** Chờ BE xác nhận đã nhận một kết quả (BE có `resume`) — quá hạn thì giữ kết quả trên đĩa, gửi lại khi nối lại. */
const RESULT_ACK_TIMEOUT_MS = 15_000;
/** Tự cập nhật: báo BE "sắp khởi động lại để chuyển bản" (chờ ack tối đa bấy nhiêu), và máy dự kiến quay lại trong bấy nhiêu. */
const RESTARTING_ACK_TIMEOUT_MS = 2_000;
const RESTART_EXPECT_BACK_MS = 30_000;

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
  if (call.purpose !== undefined && call.purpose !== null && typeof call.purpose !== 'string') return false;
  return true;
}

function boundedResult(outcome) {
  if (!outcome.ok) return outcome;
  let size;
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
 * Máy đang ghép với máy chủ khác: chuyển sang máy chủ mới là giao máy cho bên quản trị máy chủ đó → phải có người trả lời trong terminal (rà
 * 02/11/2026). Không có terminal (lệnh do agent / script chạy) thì từ chối.
 */
async function confirmServerChange(saved, serverUrl) {
  if (!saved?.server_url || saved.server_url === serverUrl) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Máy này đang kết nối với ${saved.server_url}. Chuyển sang ${serverUrl} chỉ làm được khi gõ lệnh trong cửa sổ terminal.`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(chalk.yellow(`⚠️  Máy này đang kết nối với ${saved.server_url}. Chuyển sang ${serverUrl}? Máy chủ mới sẽ điều khiển được máy này. Gõ "co" để đồng ý: `));
    if (!/^\s*(co|có|yes|y)\s*$/i.test(answer)) throw new Error('Đã huỷ — máy giữ kết nối cũ.');
  } finally {
    rl.close();
  }
}

/**
 * Thông tin ghép máy: có mã kết nối thì luôn ghép bằng mã (người dùng vừa bấm "Thêm máy tính này"); có sẵn và đúng máy chủ thì dùng;
 * không thì ghép mới bằng API key đang đăng nhập.
 */
async function ensurePaired({ serverUrl, apiKey, code, roots, rootsGiven, name, repair, profile }) {
  let creds = loadDeviceCredentials();
  await confirmServerChange(creds, serverUrl);
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
 * `aivin remote pair --code`: chỉ ghép máy, không nhận việc — bộ cài dùng khi đã có khay (khay thấy máy đã ghép là mở listener ngay,
 * người dùng đóng được cửa sổ cài). Listener đang chạy bằng token cũ thì dừng nó để khay mở lại bằng token mới. Trả pid đã dừng (hoặc null).
 */
export async function pairWithCodeOnly(options) {
  const saved = loadDeviceCredentials();
  const serverUrl = resolveServerUrl(options, saved);
  await confirmServerChange(saved, serverUrl);
  configureProxy({ explicit: options.proxy });
  const fullAccess = !options.dir && !!options.fullAccess;
  const roots = (fullAccess ? fullAccessRoots() : [options.dir || process.cwd()]).map((r) => path.resolve(r));
  const access = fullAccess ? DeviceAccess.FULL : DeviceAccess.FOLDERS;
  const profile = { ...buildDeviceProfile(fullAccess ? [os.homedir()] : roots), roots, access };
  const creds = await pairDeviceWithCode({ serverUrl, code: options.code, roots, name: options.name, profile });
  saveDeviceCredentials({ ...creds, access });
  const stale = lockHolder();
  if (stale) try { process.kill(stale); } catch { /* vừa tự thoát */ }
  return { creds, stopped: stale };
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
  // Trước mọi lời gọi mạng (ghép máy cũng đi qua proxy).
  const proxy = configureProxy({ explicit: options.proxy });
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const rootsGiven = Boolean(options.dir) && !multiUser;
  // Toàn quyền: chủ máy chọn lúc kết nối (`--full-access`), giữ qua các lần khởi động lại; `--dir` tường minh thì về chế độ một thư mục.
  // Nhiều người dùng: mỗi thành viên toàn quyền trong vùng của mình (thư mục nhà + thư mục chung) — gốc thật đặt theo từng lời gọi.
  const fullAccess = multiUser || (!rootsGiven && (!!options.fullAccess || (!options.code && saved?.access === DeviceAccess.FULL)));
  const roots = multiUser ? [HOME_BASE, SHARED_DIR] : fullAccess ? fullAccessRoots()
    : withExtraRoots(rootsGiven ? [path.resolve(options.dir)] : (saved?.access !== DeviceAccess.FULL && saved?.roots?.length ? saved.roots : [process.cwd()]), saved?.extra_roots);
  // Dò dự án + chỉ mục tệp chỉ trong thư mục nhà khi toàn quyền — quét cả ổ C: là hàng trăm nghìn tệp hệ thống vô ích.
  const scanRoots = multiUser ? [] : fullAccess ? [os.homedir()] : roots;
  const quiet = !!options.quiet;
  const say = (...args) => { if (!quiet) console.log(...args); };

  // Cửa sổ thứ hai cùng thư mục cấu hình → dừng ngay với hướng dẫn (trừ khi ghép lại bằng mã: cửa sổ cũ sẽ tự dừng).
  const releaseLock = acquireDaemonLock({ takeOver: !!options.code });
  // Tự cập nhật — ngay sau khi giữ khoá (cửa sổ thứ hai bị từ chối không được tính là một lần khởi động): bản vừa cài sập nhiều lần trước
  // khi chạy ổn thì trả bản cũ trước khi đụng tới gì khác. Máy tính tổ chức: phiên bản do ảnh container quyết, không tự đổi.
  const selfManaged = !multiUser && isStandaloneBinary();
  const supervisor = multiUser ? null : detectSupervisor({ quiet });
  const autoUpdateEnabled = !multiUser && options.autoUpdate !== false && process.env.AIVIN_AUTO_UPDATE !== '0';
  if (selfManaged) {
    // Trình giữ chạy (VBS / kịch bản sh) đã tự lùi bản mới vì nó sập ngay khi khởi động → bản này (bản cũ) ghi nhận, bỏ qua bản lỗi.
    const supervisorRollback = ingestSupervisorRollback();
    if (supervisorRollback) {
      logActivity({ type: 'self_update_rollback', version: supervisorRollback, by: 'supervisor' });
      say(chalk.yellow(`↩  aivin ${supervisorRollback} sập ngay khi khởi động — đã trả về bản này và sẽ bỏ qua ${supervisorRollback}.`));
    }
    const boot = checkBootAfterUpdate();
    if (boot.action === BootAction.ROLLED_BACK) {
      releaseLock();
      logActivity({ type: 'self_update_rollback', version: boot.version, previous: boot.previous });
      const err = new Error(`aivin ${boot.version} không chạy ổn sau ${MAX_BOOTS_BEFORE_ROLLBACK} lần khởi động — đã trả về ${boot.previous || 'bản trước'}, sẽ bỏ qua bản này. Chạy lại \`aivin remote start\`.`);
      err.code = UPDATE_ROLLED_BACK;
      err.restart = !!supervisor;
      throw err;
    }
    clearStaleInstalledMarker();
    cleanupRetired();
  }
  const access = fullAccess ? DeviceAccess.FULL : DeviceAccess.FOLDERS;
  // Chrome / Edge cho AI Browser (CLI ≥ 1.0.8) — có thì BE cho việc trên web chạy ở trình duyệt của máy này.
  const browser = options.browser === false || multiUser ? null : detectLocalBrowser();
  // Điều khiển giao diện (Windows): cây trợ năng + chuột / bàn phím cho ứng dụng không có dòng lệnh.
  const guiProfile = detectGui({ disabled: options.gui === false, multiUser });
  // Excel / Word / Outlook có trên máy → công cụ office.* qua COM (tự phát hiện, người dùng không cấu hình gì).
  const officeApps = detectOfficeApps({ multiUser });
  // Sàn luật tại máy: chỉ nhận bản `aivin remote policy` đã ký; tệp bị sửa ngoài lệnh đó (agent ghi đè qua shell) chỉ được siết thêm.
  const policyGuard = createPolicyGuard({
    onTamper: (effective) => {
      say(chalk.yellow(`⚠️  Tệp luật tại máy bị sửa ngoài lệnh \`aivin remote policy\` — chỉ áp phần siết thêm (xác nhận: ${effective.confirm}).`));
      logActivity({ type: 'local_policy_tampered', confirm: effective.confirm });
    },
  });
  const profile = {
    ...buildDeviceProfile(scanRoots), roots: roots.map((r) => path.resolve(r)), access,
    ...(browser ? { browser } : {}), ...(guiProfile ? { gui: guiProfile } : {}), ...(officeApps.length ? { apps: officeApps } : {}),
    // Theo dõi kích hoạt việc (CLI ≥ 1.0.9) — máy tính tổ chức không có.
    ...(multiUser ? {} : { watch: true }),
    // Tệp lớn qua HTTP thẳng (fs.upload / fs.download, công cụ BE-only nên BE biết qua cờ này) — máy tính tổ chức không có.
    ...(multiUser ? {} : { direct_transfer: true }),
    // Sàn luật tại máy (localPolicy.mjs): BE biết việc nào sẽ phải chờ người bấm trên máy — máy tính tổ chức không có người ngồi trước máy.
    ...(multiUser ? {} : { local_confirm: policyGuard.read().confirm }),
    // Tình trạng tự cập nhật (BE gom lại thấy cả đội máy, tự hoãn bản nhiều máy phải lùi) — làm mới mỗi lần chào lại máy chủ.
    ...(multiUser ? {} : { update: updateProfile({ enabled: autoUpdateEnabled }) }),
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
  if (options.code) say(chalk.green(`✅ Đã kết nối máy "${creds.name}" với tài khoản ${creds.account || 'Aivin của bạn'} — quay lại Aivin để chọn máy này.`));
  ensureMemoryLoaded();
  watchMemoryDir();
  const fileIndex = multiUser ? null : createFileIndex(indexRootsFor(roots, fullAccess));
  const useDailyBrowser = options.separateBrowser !== true;
  const browserTunnels = browser ? createBrowserTunnels({ serverUrl, deviceToken: () => creds.device_token, browser, useDailyBrowser, say: (m) => say(chalk.cyan(m)) }) : null;
  // Tiến trình host riêng cho giao diện và cho Office COM (chỉ dựng khi lời gọi đầu tiên cần) — một lệnh COM treo / bị huỷ không làm mất snapshot giao diện.
  const guiHost = guiProfile ? createWindowsHost() : null;
  const officeHost = officeApps.length ? createWindowsHost() : null;
  // Không nói cửa sổ mà focus đang ở linh vật (chủ máy vừa gõ vào ô hỏi) → cửa sổ họ đang dùng lúc hỏi (mascot/ask.mjs).
  const gui = guiProfile ? createGuiController({
    fullAccess, host: guiHost, say: (m) => say(chalk.magenta(m)),
    defaultWindow: () => (mascot.pid() ? { avoid_pid: mascot.pid(), fallback: mascotChat?.userWindow()?.window } : null),
  }) : null;
  // Kho hoàn tác (xoá → thùng rác của kho, ghi đè → giữ bản cũ). Máy tính tổ chức: công cụ tệp chạy dưới tài khoản thành viên, không có kho.
  const undo = multiUser ? null : createUndoStore();
  void undo?.cleanup().catch(() => undefined);
  const processes = createProcessManager();
  // Giữ máy không tự ngủ khi đang có việc (keepAwake.mjs) — máy tính tổ chức (container) không cần.
  const keepAwake = createKeepAwake({
    enabled: !multiUser && options.keepAwake !== false && process.env.AIVIN_REMOTE_KEEP_AWAKE !== '0',
    say: (m) => say(chalk.gray(`   ${m}`)),
  });
  let procAwake = false;
  const syncProcAwake = () => {
    const running = !!processes.hasRunning?.();
    if (running === procAwake) return;
    procAwake = running;
    if (running) keepAwake.hold();
    else keepAwake.release();
  };
  const schedules = multiUser ? null : createScheduleManager({ undo });
  // Sự kiện của theo dõi đi lên BE qua socket (đã nối) — `socket` được tạo ngay bên dưới, sự kiện chỉ có sau khi BE đặt danh sách.
  const watches = multiUser ? null : createWatchManager({
    roots, say: (m) => say(chalk.cyan(m)),
    emit: (payload) => { if (socket?.connected) socket.emit(DeviceEvent.EVENT, payload); },
  });
  // Tệp lớn đi HTTP thẳng với vé của BE (fs.upload / fs.download) — máy tính tổ chức không có (gửi HTTP chạy bằng tài khoản của daemon).
  const transfer = multiUser ? null : { serverUrl, deviceToken: () => creds.device_token };
  // Ghi chú cuộc họp + chụp màn hình (meeting/) — Windows, máy cá nhân; tắt: --no-meetings / AIVIN_REMOTE_MEETINGS=0.
  const media = !multiUser && mediaSupported() && options.meetings !== false && process.env.AIVIN_REMOTE_MEETINGS !== '0' ? createMediaHost() : null;
  const meetings = media ? createMeetingManager({
    roots, media, lang: mascotLang(process.env, process.platform, creds?.lang),
    say: (m) => say(chalk.cyan(m)),
    notify: showOSNotification,
    isPaused: isRemotePaused,
    keepAwake,
    // Đang nói chuyện với linh vật → không ghi biên bản họp (và ngược lại, xem micBusy của mascotChat).
    micBusy: () => !!mascotChat?.inCall(),
    // Chuyển chữ từng đoạn qua chính `device:stt` của ô hỏi linh vật; mất mạng thì chờ nối lại (tối đa 10 phút) rồi mới báo lỗi.
    stt: async (audio, lang) => {
      const deadline = Date.now() + 10 * 60_000;
      while (!socket?.connected) {
        if (Date.now() > deadline) throw new Error('offline');
        await new Promise((r) => setTimeout(r, 5000));
      }
      return socket.timeout(60_000).emitWithAck(DeviceEvent.STT, { audio, lang });
    },
    // Lượt chat sau họp: qua ô hỏi của linh vật (câu trả lời hiện ở đó); không có linh vật thì gửi thẳng.
    followUp: async (text) => {
      if (!socket?.connected) return { ok: false, error: 'offline' };
      if (mascotChat) {
        if (mascotChat.busy()) return { ok: false, error: 'busy' };
        void mascotChat.ask(text);
        return { ok: true };
      }
      const ack = await socket.timeout(15_000).emitWithAck(DeviceEvent.CHAT, { text, request_id: `meeting-${Date.now()}` });
      return ack?.ok ? { ok: true } : { ok: false, error: ack?.error || 'failed' };
    },
  }) : null;
  const env = { roots, binaries: profile.binaries, projects: profile.projects, fileIndex, browserTunnels, gui, office: officeApps.length ? { host: officeHost, apps: officeApps } : null, undo, processes, schedules, watches, transfer, meetings, media, clipboard: multiUser ? null : createClipboard() };
  const host = multiUser ? createMultiUserHost({ baseEnv: env, say: (m) => say(chalk.gray(m)) }) : null;
  host?.start();
  const tools = buildTools(env);
  const byName = toolMap(tools);
  // Công cụ chủ máy tắt (`aivin remote policy deny`) không vào danh mục — Planner không lập kế hoạch với nó (gọi tới vẫn bị chặn ở sàn luật).
  const deniedTools = new Set(policyGuard.read().deny_tools);
  if (deniedTools.has('gui.act')) deniedTools.add('gui.do');
  const { catalog, hash } = buildCatalog(tools.filter((t) => !deniedTools.has(t.name)));
  const confirmer = multiUser ? null : createLocalConfirmer();
  // Nhiều người dùng: thêm trần song song theo từng thành viên — một người không chiếm hết chỗ của cả tổ chức.
  const scheduler = createScheduler(multiUser ? { scopeLimits: DEFAULT_SCOPE_LIMITS } : undefined);
  const earlyDrops = [];
  let earlyWorkDir = null;
  let announceProfile = null;
  const applyWorkDir = (dir) => { if (mascotChat) mascotChat.setWorkDir(dir); else earlyWorkDir = dir; };
  /** Chủ máy đồng ý mở thêm thư mục: có hiệu lực ngay (công cụ đọc env.roots lúc gọi), báo BE hồ sơ mới, lưu cho các lần chạy sau. */
  const grantRoot = (dir) => {
    roots.push(dir);
    profile.roots.push(dir);
    creds.roots = profile.roots;
    creds.extra_roots = [...new Set([...(creds.extra_roots || []), dir])];
    saveDeviceCredentials(creds);
    logActivity({ type: 'folder_allowed', path: dir, by: 'owner_confirm' });
    say(chalk.cyan(`   Đã cho phép thêm thư mục: ${dir}`));
    void announceProfile?.();
  };
  const chooseWorkFolder = async (dir) => {
    const res = await resolveWorkFolder(dir, {
      roots,
      confirm: async (folder) => (await confirmer.ask({ ...workFolderConfirmText(folder, mascotLang(process.env, process.platform, creds?.lang)), timeoutSec: WORK_FOLDER_CONFIRM_SEC })) === ConfirmResult.ALLOW,
    });
    if (res.status === WorkFolderStatus.DENIED) return void mascotChat?.workDirDenied(res.path);
    if (res.status === WorkFolderStatus.NEEDS_ROOT) grantRoot(res.path);
    applyWorkDir(res.path);
  };
  // Linh vật trên màn hình (mascot/): việc chính đang làm + nhật ký chi tiết; nút tạm dừng = công tắc ngắt. Máy tính tổ chức: không có.
  const mascot = createMascot({
    enabled: !multiUser && options.mascot !== false && process.env.AIVIN_MASCOT !== '0', lang: creds?.lang,
    onPause: () => setRemotePaused(true),
    onResume: () => setRemotePaused(false),
    say: (m) => say(chalk.gray(`   ${m}`)),
    // Ô hỏi của linh vật: gõ / nói → lượt chat trên Aivin qua socket của máy (mascot/ask.mjs, dựng sau khi có socket).
    // Gõ khi Aivin đang hỏi lại → là câu trả lời; nút lựa chọn → trả lời đúng lựa chọn đó.
    onAsk: (text, window) => { void mascotChat?.reply(text, window); },
    onChoose: (id) => { void mascotChat?.choose(id); },
    onCancel: () => { void mascotChat?.cancel(); },
    onNewChat: () => { void mascotChat?.newChat(); },
    onOpenTool: (msg) => { void mascotChat?.openTool(msg); },
    onNotifyFreq: (val) => { mascotChat?.setNotifyFreq(val); },
    // Thả tệp vào bot → đi kèm câu gõ kế tiếp.
    // "Gửi cho AIVIN Bot" từ Explorer có thể tới trước khi ô hỏi dựng xong (daemon vừa được khay mở) → giữ lại, dựng xong thì đính.
    onDrop: (files) => (mascotChat ? mascotChat.attach(files) : earlyDrops.push(...files)),
    // "Làm việc ở đây với AIVIN Bot": thư mục ngoài quyền thì hỏi chủ máy trước (workFolder.mjs).
    onWorkFolder: (dir) => { void chooseWorkFolder(dir).catch((e) => say(chalk.yellow(`⚠️  Không đặt được thư mục làm việc: ${e?.message || e}`))); },
    // Bấm × trên chip tệp trong ô hỏi → bỏ tệp đó.
    onDetach: (file) => mascotChat?.detach(file),
    // Nói chuyện trực tiếp: mic / loa ở cửa sổ, phiên thoại realtime trên BE (mascot/ask.mjs).
    onVoice: (msg) => {
      if (!mascotChat) return;
      if (msg.t === MascotHostEvent.VOICE_AUDIO) return mascotChat.voiceAudio(msg.audio);
      if (msg.t === MascotHostEvent.VOICE_START) return void mascotChat.voiceStart(msg.window);
      if (msg.t === MascotHostEvent.VOICE_INTERRUPT) return mascotChat.voiceInterrupt();
      if (msg.t === MascotHostEvent.VOICE_STOP) return mascotChat.voiceStop();
      if (msg.t === MascotHostEvent.VOICE_MIC_LOST) return mascotChat.voiceMicLost();
    },
  });
  if (isRemotePaused()) mascot.paused(true);
  // Máy cài ứng dụng Aivin rồi chỉ tự cập nhật: bắt kịp Aivin.exe + "Mở bằng / Gửi cho AIVIN Bot" của bản này (biên dịch vài giây → chạy sau).
  if (!multiUser && process.platform === 'win32') {
    const refresh = setTimeout(() => {
      try {
        const done = refreshDesktopIntegration({ lang: mascotLang() });
        if (done.length) say(chalk.gray(`   Ứng dụng Aivin trên máy: đã cập nhật ${done.join(', ')}`));
      } catch (e) {
        say(chalk.yellow(`⚠️  Chưa cập nhật được ứng dụng Aivin trên máy (Mở bằng / Gửi cho AIVIN Bot): ${String(e?.message || e).trim()}`));
      }
    }, 10_000);
    refresh.unref?.();
  }
  const desktopCast = createDesktopCastManager();
  // Công cụ GUI ghi của AI đang chạy → thao tác từ xa của người bị bỏ (và AI chờ người thôi thao tác trước khi bấm, xem handleCall).
  let aiGuiBusy = 0;
  const castGate = createCastInputGate({ isPaused: isRemotePaused, isAiBusy: () => aiGuiBusy > 0 });
  let castBlockedNoticeAt = 0;
  const emitCastStatus = (payload) => { if (socket?.connected) socket.emit(DeviceEvent.DESKTOP_CAST_STATUS, payload); };
  /** Thao tác từ xa (qua máy chủ hoặc kênh WebRTC) — qua cổng chặn rồi mới xuống tiến trình điều khiển. */
  const applyRemoteInput = (raw, viewerId) => {
    const sessionId = desktopCast.sessionId();
    if (!sessionId || (raw?.session_id && raw.session_id !== sessionId)) return;
    const res = castGate.accept(raw);
    if (res.ok) return desktopCast.sendInput(res.cmd);
    if (res.reason !== CastInputRejection.AI_ACTIVE || Date.now() - castBlockedNoticeAt < 2000) return;
    castBlockedNoticeAt = Date.now();
    emitCastStatus({ session_id: sessionId, viewer_id: viewerId, state: CastState.INPUT_BLOCKED, reason: res.reason });
  };
  /** AI sắp bấm / người xem rời giữa lúc đang kéo: nhả nút + phím bổ trợ trên máy, gói nhả của người xem có thể không bao giờ tới. */
  const releaseCastInput = () => { if (castGate.takeHeldInput()) desktopCast.sendInput({ action: 'release_all' }); };
  const castFileDrop = createCastFileDrop({
    reply: (viewerId, msg) => desktopWebRtc.replyFile(viewerId, msg),
    checkAllowed: () => (isRemotePaused() ? FileDropReason.PAUSED : aiGuiBusy > 0 ? FileDropReason.AI_ACTIVE : null),
    onSaved: ({ path: file, name, bytes, reveal }) => {
      say(chalk.cyan(`  📥 Đã nhận tệp từ web: ${file}`));
      logActivity({ type: 'desktop_cast_file', id: desktopCast.sessionId(), name, bytes });
      // Không mở cửa sổ đè lên giữa lúc AI đang bấm.
      if (reveal && aiGuiBusy === 0) revealInExplorer(file);
    },
  });
  // WebRTC chạy ở tiến trình con (thư viện native sập lúc thoát — xem webrtcWorker.mjs), daemon chỉ chuyển tín hiệu / thao tác / JPEG.
  const desktopWebRtc = createDesktopWebRtcWorker({
    command: cliLaunchCommand(),
    emitSignal: (payload) => { if (socket?.connected) socket.emit(DeviceEvent.DESKTOP_CAST_SIGNAL, payload); },
    emitStatus: emitCastStatus,
    onInput: (raw, viewerId) => applyRemoteInput(raw, viewerId),
    onFile: (viewerId, msg, sessionId) => { if (sessionId === desktopCast.sessionId()) castFileDrop.message(viewerId, msg); },
    onFileChunk: (viewerId, bytes) => castFileDrop.chunk(viewerId, bytes),
    // Người xem vừa nối: gửi ngay một khung (màn hình đứng yên thì bộ quay không tự gửi).
    onPeerReady: () => desktopCast.refresh(),
    onState: () => syncCastJpeg(),
    log: (m) => say(chalk.gray(`  ${m}`)),
  });
  /**
   * Chỉ nén JPEG khi còn người xem cần: chưa có WebRTC / không có video, hoặc khung thô chưa tới bộ mã hoá (pipe chưa nối).
   * Con trỏ tách khỏi khung chỉ khi mọi người xem đều có video + tự vẽ con trỏ (FE cũ, đường JPEG vẫn thấy con trỏ trong hình).
   */
  const syncCastJpeg = () => {
    const jpeg = desktopWebRtc.needsJpeg() || !desktopWebRtc.videoLive();
    desktopCast.setJpeg(jpeg);
    desktopCast.setCursorInFrame(jpeg || !desktopWebRtc.localCursor());
  };
  /** Dừng hẳn phiên trên máy (tạm dừng / mất kết nối / tắt daemon); `notify` = báo BE kết thúc phiên. */
  const stopDesktopCast = (reason, notify = true) => {
    const sessionId = desktopCast.sessionId();
    desktopWebRtc.closeAll();
    void castFileDrop.closeAll();
    castGate.takeHeldInput(); // Tiến trình điều khiển tự nhả khi dừng.
    if (!desktopCast.isActive()) return;
    desktopCast.stop();
    // Nhật ký trên máy của chủ máy: phiên xem + số thao tác đã nhận (cả qua WebRTC, không qua máy chủ).
    logActivity({ type: 'desktop_cast', id: sessionId, reason, inputs: castGate.takeAcceptedCount() });
    if (notify && sessionId) emitCastStatus({ session_id: sessionId, state: CastState.STOPPED, reason, final: true });
  };
  let mascotChat = null;

  say(chalk.blue('💻 Aivin Device Agent — máy này nhận việc từ agent của bạn'));
  say(chalk.gray(`   Máy:        ${creds.name} (${creds.device_id})`));
  say(chalk.gray(fullAccess ? `   Quyền:      TOÀN QUYỀN máy (${roots.slice(1).join(' ')}) — trừ thư mục cấu hình Aivin` : `   Thư mục:    ${roots.join(' | ')}`));
  say(chalk.gray(`   Máy chủ:    ${serverUrl}`));
  if (creds.seal_failed) say(chalk.yellow(`   ⚠️  Token máy đang nằm trong tệp thường (kho bí mật của hệ điều hành lỗi: ${creds.seal_failed.reason}) — chép thư mục .aivin là mang theo được quyền điều khiển máy`));
  if (proxy.url) say(chalk.gray(`   Proxy:      ${proxy.url} (${proxy.source === 'system' ? 'cài đặt của hệ điều hành' : proxy.source === 'env' ? 'HTTPS_PROXY' : '--proxy'})`));
  else if (proxy.pac) say(chalk.yellow(`   Proxy:      máy dùng tệp PAC (${proxy.pac}) — Aivin chưa đọc được, nếu không nối được hãy thêm --proxy http://<máy>:<cổng>`));
  say(chalk.gray(`   Công cụ:    ${catalog.length} (${profile.binaries.join(', ') || 'không phát hiện chương trình nào'})`));
  say(chalk.gray(`   Ghi nhớ:    ${memoryStats().total} mục — ${memoryStats().dir}`));
  if (officeApps.length) say(chalk.gray(`   Office:     ${officeApps.join(', ')} — AI làm qua ứng dụng, chạy nền`));
  say(chalk.gray(`   Giao diện:  ${gui ? 'AI điều khiển được cửa sổ ứng dụng (di chuột / gõ phím để AI dừng; tắt: --no-gui)' : 'không (chỉ Windows, tắt bằng --no-gui)'}`));
  say(chalk.gray(`   Trình duyệt: ${!browser ? 'không có Chrome / Edge — AI dùng trình duyệt trên máy chủ'
    : useDailyBrowser ? `${browser.name} hằng ngày của bạn nếu đã bật ${remoteDebuggingPage(browser.id)}, không thì cửa sổ riêng của Aivin`
      : `${browser.name} (cửa sổ riêng của Aivin)`}`));
  say(chalk.gray(`   Cuộc họp:   ${meetings ? 'AI ghi chú được cuộc họp (âm thanh máy + micro, bạn bấm Cho phép mỗi lần) và chụp màn hình; tắt: --no-meetings' : 'không (chỉ Windows)'}`));
  if (isRemotePaused()) say(chalk.yellow('   ⏸  Đang TẠM DỪNG (aivin remote resume để nhận việc lại)'));
  // `aivin remote meeting start|stop` gõ ở máy → daemon này; buổi ghi / biên bản dở từ lần chạy trước → làm nốt.
  const stopMeetingRequests = meetings ? watchMeetingRequests(meetings) : null;

  void gui?.prewarm?.();
  fileIndex?.build()
    .then((s) => { say(chalk.gray(`   Chỉ mục tệp: ${s.files} tệp (${s.updated} cập nhật, ${s.ms} ms)`)); fileIndex.watch(); })
    .catch((e) => say(chalk.yellow(`   ⚠️  Lập chỉ mục tệp lỗi: ${e.message}`)));

  // Mã phiên chạy của tiến trình này: BE báo socket cũ "bị thay bởi instance X" — chỉ dừng khi X là tiến trình KHÁC (tự nối lại
  // sau khi mạng chập chờn thì không dừng nhầm).
  const instance = randomUUID();
  const socket = io(`${serverUrl}${DEVICE_NAMESPACE}`, {
    auth: { device_token: creds.device_token, protocol: PROTOCOL_VERSION, instance },
    transports: ['websocket'],
    // Proxy công ty (netProxy.mjs): websocket đi qua đường hầm CONNECT; không có proxy → `undefined`, nối thẳng.
    agent: proxyAgentFor(`${serverUrl}${DEVICE_NAMESPACE}`),
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: multiUser ? MULTI_USER_RECONNECT_DELAY_MAX_MS : RECONNECT_DELAY_MAX_MS,
    randomizationFactor: 0.5,
  });

  let stopped = false;
  // Lời gọi đang xử lý (kể cả lúc chờ người bấm xác nhận trên máy) — tự cập nhật chỉ chạy lại daemon khi bằng 0.
  let activeCalls = 0;
  let lastActivityAt = Date.now();
  let updater = null;
  // Bản vừa tự cập nhật chạy đủ 10 phút không sập → xác nhận, bỏ bản cũ giữ để tự lùi.
  const confirmTimer = selfManaged ? setTimeout(() => { try { confirmUpdate(); } catch { /* lần sau */ } }, UPDATE_CONFIRM_AFTER_MS) : null;
  confirmTimer?.unref?.();
  // Cloud Computer: `busy` = còn tiến trình nền đang chạy → BE giữ máy không tắt vì rảnh (có trần giờ phía BE).
  const heartbeat = setInterval(() => {
    if (socket.connected) socket.emit(DeviceEvent.HEARTBEAT, multiUser ? { busy: processes.hasRunning() } : {});
    ledger.prune();
    // Kết quả đã gửi mà lỡ ack (BE quá tải) khi socket vẫn nối → gửi lại có giãn nhịp, cùng call_id (callLedger.dueForResend, 02/11/2026).
    if (socket.connected && serverResume) ledger.dueForResend().forEach(sendResult);
    syncProcAwake();
  }, HEARTBEAT_MS);

  // `aivin remote pause` ở cửa sổ khác: huỷ NGAY việc đang chạy (lệnh shell, đường hầm trình duyệt), không chỉ chặn việc mới.
  let pausedSeen = isRemotePaused();
  const pauseWatch = setInterval(() => {
    const paused = isRemotePaused();
    if (paused && !pausedSeen) {
      say(chalk.yellow('⏸  Đã tạm dừng — huỷ việc đang chạy và đóng trình duyệt AI đang dùng.'));
      void scheduler.cancelAll('Remote control was paused on this device');
      cancelGating([...gating.keys()]);
      browserTunnels?.closeAll();
      guiHost?.close();
      officeHost?.close();
      processes.stopAll();
      // Công tắc ngắt chặn cả xem / điều khiển màn hình từ web, không chỉ việc của AI.
      stopDesktopCast('paused');
    }
    if (paused !== pausedSeen) mascot.paused(paused);
    pausedSeen = paused;
  }, PAUSE_POLL_MS);
  pauseWatch.unref?.();

  // Sổ lời gọi (callLedger.mjs): kết quả làm xong lúc mất kết nối giữ trên đĩa, gửi khi nối lại (BE vẫn chờ tới hết giờ — mất là agent chạy
  // lại lệnh có tác dụng phụ); lời gọi BE gửi lại cùng `call_id` không chạy lần hai.
  const ledger = createCallLedger({ file: options.outboxFile || REMOTE_OUTBOX_FILE });
  // BE có `resume`: kết quả chỉ bỏ khỏi sổ khi BE xác nhận đã nhận (ack của device:result). BE cũ không ack → gửi là coi như xong.
  let serverResume = false;
  const sendResult = (payload) => {
    if (!socket.connected) return ledger.persist();
    if (!serverResume) {
      socket.emit(DeviceEvent.RESULT, payload);
      return ledger.markSent(payload.call_id);
    }
    ledger.markAttempt(payload.call_id);
    socket.timeout(RESULT_ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.RESULT, payload)
      .then(() => ledger.markSent(payload.call_id), () => ledger.persist());
  };
  const flushUnsent = () => {
    for (const payload of ledger.unsent()) {
      if (!socket.connected) return;
      sendResult(payload);
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    clearInterval(pauseWatch);
    clearTimeout(confirmTimer);
    updater?.close();
    mascot.close();
    if (selfManaged) noteCleanExit();
    const draining = scheduler.cancelAll('The Aivin agent on this device stopped');
    cancelGating([...gating.keys()]);
    ledger.persist({ sync: true });
    socket.disconnect();
    browserTunnels?.closeAll();
    // Đóng tệp ghi họp cho đúng; biên bản làm ở lần chạy sau (meetings.recover).
    stopMeetingRequests?.();
    void meetings?.shutdown();
    gui?.close();
    guiHost?.close();
    officeHost?.close();
    stopDesktopCast('device_stopped');
    processes.stopAll();
    keepAwake.close();
    watches?.closeAll();
    host?.close();
    fileIndex?.close();
    stopWatchingMemory();
    releaseLock();
    say(chalk.gray('🛑 Đã dừng nhận việc từ xa.'));
    return draining;
  };

  // Dừng hẳn (thu hồi / bị thay / token hết hiệu lực): thoát mã 0 — trình giữ chạy (Task Scheduler, launchd, systemd) không chạy lại.
  const stopForGood = () => {
    const draining = stop();
    if (options.handleSignals !== false) Promise.resolve(draining).finally(() => process.exit(0));
  };

  // Tự cập nhật (autoUpdate.mjs): tệp chạy đóng gói + bản npm (chỉ nhắc). Máy tính tổ chức: tắt.
  updater = createAutoUpdater({
    enabled: autoUpdateEnabled,
    // Chỉ tự thoát để chuyển bản khi chắc có trình giữ chạy mở lại (detectSupervisor) — không thì chỉ nhắc.
    supervised: !!supervisor && options.handleSignals !== false,
    deviceId: creds.device_id,
    // Đang ghi họp / làm biên bản: không tự khởi động lại để cập nhật (mất đoạn ghi).
    isIdle: () => activeCalls === 0 && !processes.hasRunning?.() && !(browserTunnels?.liveCount() > 0) && !meetings?.busy(),
    lastActivityAt: () => lastActivityAt,
    say: (m) => say(chalk.cyan(m)),
    onRestart: async (version) => {
      logActivity({ type: 'self_update', version });
      console.log(chalk.cyan(`⬆  Chuyển sang aivin ${version} — khởi động lại.`));
      // Báo máy chủ trước khi rớt: máy sắp quay lại (không phải mất máy) — BE cũ không biết sự kiện này, hết 2 s thì thôi.
      if (socket.connected) {
        await socket.timeout(RESTARTING_ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.RESTARTING, { reason: 'update', version, expect_back_ms: RESTART_EXPECT_BACK_MS }).catch(() => null);
      }
      Promise.resolve(stop()).finally(() => process.exit(RESTART_EXIT_CODE));
    },
  });

  const embedTexts = async (texts) => {
    if (!socket.connected) return null;
    const res = await socket.timeout(EMBED_TIMEOUT_MS).emitWithAck(DeviceEvent.EMBED, { texts });
    return res?.ok ? res.vectors : null;
  };

  /**
   * Xoay vòng token (BE cấp trong ack của HELLO): lưu token mới (kho bí mật của hệ điều hành) RỒI mới báo BE bỏ token cũ — lưu hỏng thì
   * không báo, token cũ vẫn dùng được. Lần nối lại sau dùng token mới (socket.io đọc lại `auth` mỗi lần nối).
   */
  const rotateToken = async (token) => {
    const previous = creds.device_token;
    try {
      // Giữ token cũ tới khi máy chủ xác nhận (tokenRotation.mjs) — 02/11/2026.
      const fallback = saveDeviceCredentials({ ...creds, device_token: token }, { previousToken: previous });
      if (fallback) say(chalk.yellow(`   ⚠️  Kho bí mật của máy lỗi (${fallback}) — token mới nằm trong tệp thường`));
      // Đọc lại thật từ tệp + kho bí mật (không qua bộ nhớ đệm): ghi hỏng mà vẫn báo BE là lần khởi động sau máy bị khoá ngoài.
      if (readStoredTokenFresh() !== token) throw new Error('saved token does not read back');
    } catch (e) {
      try { saveDeviceCredentials({ ...creds, device_token: previous }, { previousToken: null }); } catch { /* giữ nguyên tệp */ }
      say(chalk.yellow(`   ⚠️  Không lưu được token mới (${e.message}) — tiếp tục dùng token cũ`));
      return;
    }
    creds.device_token = token;
    socket.auth = { ...socket.auth, device_token: token };
    // Gửi kèm chính token mới: BE chỉ chốt khi băm của nó đúng token đang chờ (chứng minh máy này nhận được token đó).
    const ack = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.ROTATED, { token }).catch(() => null);
    if (ack?.ok === true) settleRotation(token);
    logActivity({ type: 'token_rotated', deviceId: creds.device_id, confirmed: ack?.ok === true });
    say(chalk.gray(ack?.ok
      ? '   🔑 Đã đổi token máy định kỳ (token cũ hết hiệu lực)'
      : '   🔑 Đã lưu token mới — máy chủ chưa xác nhận, sẽ chốt ở lần nối lại'));
  };

  const announce = async () => {
    try {
      if (!multiUser) profile.update = updateProfile({ enabled: autoUpdateEnabled });
      const hello = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.HELLO, { protocol: PROTOCOL_VERSION, profile, catalog_hash: hash, inflight: ledger.heldIds() });
      const userLang = hello?.user_lang || hello?.lang;
      if (userLang && mascot.enabled) {
        const resolvedLang = mascotLang(process.env, process.platform, userLang);
        if (resolvedLang !== mascot.lang) {
          mascot.setLang(resolvedLang);
          mascotChat?.setLang(resolvedLang);
          if (creds && creds.lang !== resolvedLang) {
            creds.lang = resolvedLang;
            saveDeviceCredentials(creds);
          }
        }
      }
      serverResume = Array.isArray(hello?.features) && hello.features.includes(ServerFeature.RESUME);
      mascotChat?.setServerFeatures(hello?.features);
      // Báo chủ động lỡ trong lúc offline + câu hỏi đang ghim đã đóng ở nơi khác (BE có hộp báo).
      void mascotChat?.syncInbox();
      // Việc máy còn giữ mà BE không còn chờ (đã huỷ / hết giờ lúc máy mất mạng — lệnh huỷ không tới được máy): dừng ngay, bỏ kết quả.
      const orphaned = Array.isArray(hello?.orphaned) ? hello.orphaned.filter((id) => typeof id === 'string') : [];
      if (orphaned.length) {
        say(chalk.gray(`   ↯ Huỷ ${orphaned.length} việc máy chủ không còn chờ (đã huỷ / hết giờ lúc mất kết nối)`));
        scheduler.cancel(orphaned);
        cancelGating(orphaned);
        ledger.drop(orphaned);
      }
      if (!envCreds) settleRotation(creds.device_token); // chào được bằng token đang dùng → bỏ token cũ còn giữ (nếu có)
      if (typeof hello?.rotate_token === 'string' && !envCreds) await rotateToken(hello.rotate_token);
      // BE cần bản CLI tối thiểu (tính năng mới phía máy) → kiểm cập nhật ngay thay vì chờ tới lượt.
      if (hello?.cli) updater?.setServerHints(hello.cli);
      if (hello?.need_catalog) await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.CATALOG, { catalog_hash: hash, tools: catalog });
      // BE mới tính vector cho tệp tài liệu (tìm theo nghĩa); BE cũ không báo → chỉ tìm theo từ khoá.
      if (fileIndex && Array.isArray(hello?.features) && hello.features.includes(ServerFeature.EMBED)) fileIndex.setEmbedder(embedTexts);
      // Theo dõi của máy (BE giữ) — nối lại sau khi mất mạng / khởi động lại daemon thì mở lại đúng danh sách.
      if (watches && Array.isArray(hello?.features) && hello.features.includes(ServerFeature.WATCH)) {
        const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.WATCHES, {}).catch(() => null);
        if (Array.isArray(res?.watches)) watches.set(res.watches);
      }
      say(chalk.green('✅ Đã kết nối — sẵn sàng nhận việc.'));
      mascot.connected();
      logActivity({ type: 'connected', serverUrl, deviceId: creds.device_id });
    } catch (e) {
      say(chalk.yellow(`⚠️  Chào máy chủ lỗi (${e.message}) — sẽ thử lại khi nối lại.`));
    }
  };

  // Nhiều người dùng: stdout vào log docker của máy chủ → không in tham số / thông báo lỗi (đường tệp, nội dung của thành viên), chỉ
  // tên công cụ + vài ký tự đầu của vùng.
  const callLabel = (call) => (host ? `${call.tool} [${String(call.user_scope || '-').slice(0, 5)}]` : call.tool);

  /**
   * Sàn luật tại máy: công cụ / lệnh chủ máy cấm → ném lỗi; việc cần xác nhận → hộp "Cho phép / Từ chối" trên máy (BE được báo giữ chỗ để
   * không tính hết giờ trong lúc chờ). Máy tính tổ chức: chỉ áp phần cấm (không có người ngồi trước máy để bấm).
   */
  // Lời gọi đang chờ người bấm xác nhận (chưa vào scheduler nên `scheduler.cancel` không chạm tới): huỷ từ BE / việc mồ côi / tạm dừng /
  // dừng daemon phải đóng hộp ở đây — trước đây hộp vẫn chờ, người bấm "Cho phép" muộn là lệnh chạy dù BE đã thôi chờ (29/10/2026).
  const gating = new Map();
  const cancelGating = (callIds) => {
    for (const id of callIds) gating.get(id)?.abort();
  };

  const localGate = async (call, tool) => {
    // Công cụ nội bộ cũng qua sàn luật (phần cấm luôn áp; phần hỏi do evaluateLocalPolicy miễn) — 02/11/2026.
    const policy = policyGuard.read();
    const verdict = evaluateLocalPolicy(policy, tool, call.args || {});
    if (verdict.action !== 'confirm' || !confirmer) return;
    const timeoutSec = policy.confirm_timeout_sec;
    const hold = (extraMs, phase = HoldPhase.WAITING) => { if (socket.connected) socket.emit(DeviceEvent.HOLD, { call_id: call.call_id, extra_ms: extraMs, phase }); };
    hold((timeoutSec + 15) * 1000);
    say(chalk.magenta(`  ✋ ${call.tool}: chờ bạn bấm xác nhận trên máy (${verdict.reason}, tối đa ${timeoutSec} s)`));
    const purpose = typeof call.purpose === 'string' ? call.purpose.slice(0, 200) : undefined;
    const controller = new AbortController();
    gating.set(call.call_id, controller);
    let result;
    mascot.waitingConfirm(call, tool);
    try {
      result = await confirmer.ask({
        reason: verdict.reason, purpose, detail: describeCall(tool, call.args || {}), timeoutSec, signal: controller.signal,
        // Hộp xếp hàng sau hộp khác: phần đã chờ chưa nằm trong lần xin lùi hạn đầu → xin thêm đúng phần đó.
        onStart: (queuedMs) => { if (queuedMs > 1000) hold(queuedMs); },
      });
    } finally {
      gating.delete(call.call_id);
    }
    logActivity({ type: 'local_confirm', tool: call.tool, id: call.call_id, result });
    mascot.confirmDone(call, result === ConfirmResult.ALLOW);
    // Bấm "Cho phép" đúng lúc chủ máy vừa tạm dừng → không chạy.
    if (result === ConfirmResult.ALLOW && isRemotePaused()) throw new DeviceToolError(DeviceErrorCode.KILL_SWITCH, 'Remote control is paused on this device');
    if (result === ConfirmResult.ALLOW) return hold(0, HoldPhase.STARTED);
    const fail = {
      [ConfirmResult.REJECT]: [DeviceErrorCode.LOCAL_REJECTED, 'The person at this computer rejected this step'],
      [ConfirmResult.TIMEOUT]: [DeviceErrorCode.LOCAL_CONFIRM_TIMEOUT, `Nobody confirmed this step on the computer within ${timeoutSec} s — it needs a click at the computer (the owner requires it for risky steps)`],
      [ConfirmResult.UNAVAILABLE]: [DeviceErrorCode.LOCAL_CONFIRM_UNAVAILABLE, 'This step needs a confirmation at the computer, but no confirmation box could be shown there'],
      [ConfirmResult.CANCELLED]: [DeviceErrorCode.CANCELLED, 'Cancelled while waiting for a confirmation at the computer — the step did not run'],
    }[result];
    throw new DeviceToolError(fail[0], fail[1]);
  };

  const runCall = async (call, streamer, hooks) => {
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
      await localGate(call, tool);
    } catch (e) {
      return { tool, outcome: { ok: false, error: e.message, error_code: e.code || DeviceErrorCode.INVALID_ARGS, duration_ms: 0 } };
    }
    hooks?.started?.();
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
    file: options.idemFile || REMOTE_IDEM_FILE,
    deferStart: true,
    onDuplicate: (call) => say(chalk.gray(`  ↺ ${callLabel(call)}: đã làm ở lần gửi trước — trả lại kết quả cũ`)),
  });

  /** Không bao giờ ném / để lọt promise bị từ chối: lỗi bất ngờ vẫn trả kết quả lỗi cho BE. */
  const handleCall = async (call) => {
    const streamer = createStreamer(socket, call.call_id);
    let tool;
    let outcome;
    activeCalls++;
    lastActivityAt = Date.now();
    mascot.callStarted(call, byName.get(call.tool));
    keepAwake.hold();
    const def = byName.get(call.tool);
    const guiWrite = def?.group === ToolGroup.GUI && !def?.read_only;
    try {
      if (guiWrite) {
        // Người đang điều khiển từ web → AI chờ người thôi tay (tối đa 3 s) rồi mới bấm; trong lúc AI bấm, thao tác từ web bị bỏ.
        await castGate.waitHumanIdle();
        releaseCastInput();
        aiGuiBusy++;
      }
      ({ tool, outcome } = await runOnce(call, streamer));
    } catch (e) {
      outcome = { ok: false, error: e?.message || String(e), error_code: e?.code || DeviceErrorCode.EXECUTION_FAILED, duration_ms: 0 };
    } finally {
      if (guiWrite) aiGuiBusy--;
      keepAwake.release();
      syncProcAwake();
    }
    try {
      streamer.flush();
      const payload = { call_id: call.call_id, ...outcome };
      ledger.finish(call.call_id, payload, { persistNow: !socket.connected });
      sendResult(payload);
      logActivity({ type: 'tool_call', tool: call.tool, id: call.call_id, success: outcome.ok, error: outcome.error, ms: outcome.duration_ms });
      if (!tool?.internal) {
        const failed = host ? outcome.error_code : outcome.error;
        say(outcome.ok ? chalk.green(`  ✓ ${callLabel(call)} (${outcome.duration_ms} ms)`) : chalk.red(`  ✗ ${callLabel(call)}: ${failed}`));
      }
    } catch (e) {
      console.error(chalk.red(`⚠️  Gửi kết quả ${call.tool} lỗi: ${e?.message || e}`));
    } finally {
      activeCalls--;
      lastActivityAt = Date.now();
      mascot.callFinished(call, tool, outcome);
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

  // Chưa nối thì thôi: lần chào khi nối mang theo hồ sơ mới.
  announceProfile = () => (socket.connected ? announce() : undefined);
  socket.on('connect', guarded('connect', async () => { await announce(); flushUnsent(); }));
  let serverKicks = 0;
  socket.on('disconnect', guarded('disconnect', (reason) => {
    if (stopped) return;
    say(chalk.yellow(`⚠️  Mất kết nối (${reason}) — tự nối lại...`));
    // Không quay màn hình khi không ai nhận được; nối lại thì BE mời phát lại cho người xem còn chờ.
    stopDesktopCast('disconnected', false);
    logActivity({ type: 'disconnected', reason });
    mascot.disconnected();
    mascotChat?.voiceDisconnected();
    // Server chủ động cắt (BE khởi động lại, socket khác của máy này vừa thay chỗ…) → socket.io-client KHÔNG tự nối lại; nối tay, giãn nhịp.
    if (reason === 'io server disconnect') {
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(serverKicks++, 5)) + Math.floor(Math.random() * 500);
      setTimeout(() => { if (!stopped) socket.connect(); }, delay);
    }
  }));
  socket.on('connect', () => { serverKicks = 0; });
  socket.on('connect_error', guarded('connect_error', (err) => {
    // Token cũ của máy (đã bị thay ở một lần xoay token mà máy này không làm) → có thể token bị chép: dừng + hướng dẫn ghép lại.
    if (err?.message === 'DEVICE_TOKEN_RETIRED') {
      console.log(chalk.red('❌ Token của máy này đã được đổi bởi một kết nối khác. Nếu không phải bạn, token có thể đã bị chép — chạy `aivin remote start --repair` để ghép lại (bản chép mất hiệu lực).'));
      stopForGood();
      return;
    }
    if (err?.message === 'DEVICE_UNAUTHORIZED') {
      // Token xoay vòng chưa được chốt → thử lại bằng token cũ trước khi xoá ghép máy (02/11/2026).
      if (!envCreds && fallBackToPreviousToken({ creds, socket, isStopped: () => stopped })) return void say(chalk.yellow('   ⚠️  Máy chủ chưa nhận token mới — nối lại bằng token cũ'));
      const replaced = !clearDeviceCredentials(creds.device_token);
      console.log(chalk.red(replaced
        ? '❌ Máy này vừa được ghép lại bởi một cửa sổ khác — cửa sổ này dừng, cửa sổ mới tiếp tục nhận việc.'
        : '❌ Token của máy không còn hiệu lực (đã thu hồi hoặc ghép lại ở nơi khác). Chạy `aivin remote start` để ghép lại.'));
      stopForGood();
      return;
    }
    say(chalk.gray(`   (chưa nối được: ${err?.message} — thử lại...)`));
  }));
  socket.on(DeviceEvent.REPLACED, guarded(DeviceEvent.REPLACED, (payload) => {
    if (!payload?.by_instance || payload.by_instance === instance) return;
    console.log(chalk.red('❌ Máy này vừa được mở nhận việc ở một cửa sổ hoặc máy khác — cửa sổ này dừng để hai bên không tranh nhau. Nếu không phải bạn, token có thể đã bị chép: chạy `aivin remote start --repair` để ghép lại.'));
    stopForGood();
  }));
  socket.on(DeviceEvent.REVOKED, guarded(DeviceEvent.REVOKED, () => {
    clearDeviceCredentials(creds.device_token);
    console.log(chalk.red('❌ Máy này đã bị thu hồi quyền điều khiển từ xa.'));
    stopForGood();
  }));
  socket.on(DeviceEvent.CALLS, guarded(DeviceEvent.CALLS, (payload) => {
    // Chỉ nhận / ACK lời gọi đúng dạng — `{ calls: [null] }` từng làm sập daemon (null.call_id trong listener).
    const calls = (Array.isArray(payload?.calls) ? payload.calls : []).filter(isValidDeviceCall);
    if (!calls.length) return;
    socket.emit(DeviceEvent.ACK, { call_ids: calls.map((c) => c.call_id) });
    // BE gửi lại cùng `call_id` (máy rớt mạng trước khi ACK / kết quả tới nơi): đang chạy thì thôi, đã xong thì gửi lại kết quả cũ.
    calls.forEach((call) => {
      const prior = ledger.admit(call);
      if (!prior) return void handleCall(call);
      say(chalk.gray(`  ↺ ${callLabel(call)}: máy chủ gửi lại — ${prior.state === CallState.RUNNING ? 'đang chạy' : 'trả lại kết quả đã có'}`));
      if (prior.state === CallState.DONE) sendResult(ledger.reopen(call.call_id));
    });
  }));
  socket.on(DeviceEvent.CANCEL, guarded(DeviceEvent.CANCEL, (payload) => {
    if (!Array.isArray(payload?.call_ids)) return;
    const ids = payload.call_ids.filter((id) => typeof id === 'string');
    scheduler.cancel(ids);
    cancelGating(ids);
  }));
  if (mascot.enabled) {
    mascotChat = createMascotChat({
      socket: () => socket, send: (cmd) => mascot.chat(cmd), lang: mascot.lang,
      onAlert: (alert) => mascot.alert(alert), onPending: (on) => mascot.needsYou(on),
      micBusy: () => !!meetings?.status()?.recording,
      serverUrl: creds?.server_url || serverUrl,
      notifyFreq: loadMascotSettings().notify_freq ?? 1,
      onWorkDir: (dir) => { try { saveMascotSettings({ work_dir: dir }); } catch { /* lần chạy sau không nhớ thư mục này */ } },
    });
    if (earlyDrops.length) mascotChat.attach(earlyDrops.splice(0));
    // Thư mục làm việc lần trước: chỉ khôi phục khi còn tồn tại và còn trong quyền (quyền có thể đã bị thu lại).
    const savedWorkDir = loadMascotSettings().work_dir;
    if (savedWorkDir && isAllowedWorkFolder(savedWorkDir, roots)) mascotChat.setWorkDir(savedWorkDir, { quiet: true });
    if (earlyWorkDir) mascotChat.setWorkDir(earlyWorkDir);
    socket.on(DeviceEvent.CHAT_EVENT, guarded(DeviceEvent.CHAT_EVENT, (payload) => mascotChat.onChatEvent(payload)));
    // Báo chủ động: việc của chủ máy (web, chạy nền, automation…) xong / lỗi / cần trả lời.
    socket.on(DeviceEvent.NOTIFY, guarded(DeviceEvent.NOTIFY, (payload) => mascotChat.onNotify(payload)));
    socket.on(DeviceEvent.VOICE_EVENT, guarded(DeviceEvent.VOICE_EVENT, (payload) => mascotChat.onVoiceEvent(payload)));
  }
  socket.on(DeviceEvent.UPDATE, guarded(DeviceEvent.UPDATE, (payload) => {
      if (!updater) return;
      if (payload?.min_version) updater.setMinVersion(payload.min_version);
      if (payload?.latest_version) updater.setServerHints(payload);
      updater.requestCheck();
    }));
    socket.on(DeviceEvent.DESKTOP_CAST_START, guarded(DeviceEvent.DESKTOP_CAST_START, async (payload) => {
    const sessionId = payload?.session_id;
    const viewerId = payload?.viewer_id;
    if (!sessionId || !viewerId) return;
    // Chủ máy đã tạm dừng điều khiển từ xa → từ chối cả xem màn hình.
    if (isRemotePaused()) {
      emitCastStatus({ session_id: sessionId, viewer_id: viewerId, state: CastState.REFUSED, reason: 'paused' });
      return;
    }
    const castConfig = {
      max_fps: payload?.max_fps || 15,
      max_width: payload?.max_width || 1366,
      quality: payload?.quality || 65,
      monitor: payload?.monitor ?? -1,
    };
    if (desktopCast.isActive() && desktopCast.sessionId() !== sessionId) stopDesktopCast('replaced', false);
    if (!desktopCast.isActive()) {
      const started = desktopCast.start({
        sessionId,
        maxFps: castConfig.max_fps,
        maxWidth: castConfig.max_width,
        quality: castConfig.quality,
        monitor: castConfig.monitor,
        onFrame: (frame) => {
          desktopWebRtc.push(frame);
          // Còn người xem chưa có kênh WebRTC (đang nối / runtime native không có) → JPEG qua máy chủ; BE chỉ chuyển cho những người đó.
          if (desktopWebRtc.needsFallback() && socket.connected) socket.volatile.emit(DeviceEvent.DESKTOP_CAST_FRAME, frame);
          syncCastJpeg();
        },
        // Mọi người xem đã có video → tiến trình quay thôi nén JPEG, chỉ gửi meta (toạ độ) + khung thô cho bộ mã hoá video.
        onMeta: (meta) => { desktopWebRtc.push(meta); syncCastJpeg(); },
        onCursor: (cursor) => desktopWebRtc.pushCursor(cursor),
        onCursorShape: (shape) => desktopWebRtc.pushCursorShape(shape),
        onInputFocus: (focus) => {
          desktopWebRtc.pushInputFocus?.(focus);
          // Người xem chưa có kênh WebRTC không nhận được tin trên → gửi qua máy chủ để điện thoại vẫn tự mở bàn phím.
          if (desktopWebRtc.needsFallback() && socket.connected) {
            socket.emit(DeviceEvent.DESKTOP_CAST_INPUT_FOCUS, { session_id: sessionId, editable: focus?.editable === true });
          }
        },
        onCapture: ({ mode, reason }) => say(chalk.gray(`  🖥️  Chụp màn hình: ${mode}${reason ? ` (${reason})` : ''}`)),
        rawPipe: true,
        onReady: (meta) => {
          say(chalk.cyan(`  🖥️  Đang có người xem + điều khiển màn hình máy này từ web (${meta.bounds?.width}x${meta.bounds?.height})`));
          mascot.remoteView(true);
          emitCastStatus({ session_id: sessionId, state: CastState.READY, bounds: meta.bounds });
        },
        onError: (err) => {
          say(chalk.yellow(`  ⚠️  Desktop Cast lỗi: ${err?.message || err}`));
        },
        onStop: () => {
          say(chalk.gray('  ⏹  Đã ngừng xem màn hình từ web'));
          mascot.remoteView(false);
        },
      });
      if (!started) return;
    } else {
      desktopCast.config(castConfig);
    }
    const webRtcStarted = payload?.transport === 'webrtc'
      ? await desktopWebRtc.start({ sessionId, viewerId, iceServers: payload?.ice_servers || [], videoBitrate: payload?.video_bitrate || null }).catch(() => false)
      : false;
    if (webRtcStarted) desktopWebRtc.attachPipe(desktopCast.pipeName());
    if (!webRtcStarted) emitCastStatus({
      session_id: sessionId, viewer_id: viewerId, state: CastState.DEGRADED, transport: 'jpeg', reason: 'webrtc_runtime_unavailable',
    });
  }));
  socket.on(DeviceEvent.DESKTOP_CAST_STOP, guarded(DeviceEvent.DESKTOP_CAST_STOP, (payload) => {
    if (payload?.session_id && payload.session_id !== desktopCast.sessionId()) return;
    if (payload?.viewer_id) {
      desktopWebRtc.close(payload.viewer_id);
      void castFileDrop.close(payload.viewer_id);
      releaseCastInput();
    }
    if (payload?.final !== false) stopDesktopCast('server', false);
  }));
  socket.on(DeviceEvent.DESKTOP_CAST_INPUT, guarded(DeviceEvent.DESKTOP_CAST_INPUT, (payload) => applyRemoteInput(payload)));
  socket.on(DeviceEvent.DESKTOP_CAST_CONFIG, guarded(DeviceEvent.DESKTOP_CAST_CONFIG, (payload) => {
    if (payload?.session_id && payload.session_id !== desktopCast.sessionId()) return;
    const { max_fps, max_width, quality, monitor } = payload || {};
    desktopCast.config({ max_fps, max_width, quality, monitor });
  }));
  socket.on(DeviceEvent.DESKTOP_CAST_SIGNAL, guarded(DeviceEvent.DESKTOP_CAST_SIGNAL, (payload) => {
    void desktopWebRtc.signal(payload).catch(() => undefined);
  }));
  meetings?.recover();

  // Lưới cuối: promise bị từ chối mà không ai bắt → ghi log, KHÔNG thoát (daemon phục vụ cả tổ chức, chết là mất mọi lời gọi đang chạy).
  if (!unhandledRejectionHooked) {
    unhandledRejectionHooked = true;
    process.on('unhandledRejection', (reason) => console.error(chalk.red(`⚠️  Lỗi không được xử lý: ${reason?.stack || reason?.message || reason}`)));
    // Như trên cho lỗi đồng bộ / sự kiện `error` không ai nghe: một lời gọi không được làm sập cả daemon (thoát 3 lần liền còn kích lùi bản CLI).
    process.on('uncaughtException', (error) => console.error(chalk.red(`⚠️  Lỗi không được xử lý: ${error?.stack || error?.message || error}`)));
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
