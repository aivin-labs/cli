import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import { io } from 'socket.io-client';
import { DEFAULT_AIVIN_BASE_URL } from '../context.mjs';
import { logActivity } from './activityLog.mjs';
import { DEVICE_NAMESPACE, DeviceErrorCode, DeviceEvent, MAX_RESULT_BYTES, PROTOCOL_VERSION } from './constants.mjs';
import { clearDeviceCredentials, listDevices, loadDeviceCredentials, pairDevice, pairDeviceWithCode, saveDeviceCredentials } from './credentials.mjs';
import { ensureMemoryLoaded, memoryStats, stopWatchingMemory, watchMemoryDir } from './deviceMemory.mjs';
import { buildCatalog, buildDeviceProfile } from './deviceProfile.mjs';
import { createFileIndex } from './fileIndexer.mjs';
import { createScheduler } from './scheduler.mjs';
import { isRemotePaused } from './sandbox.mjs';
import { buildTools, toolMap } from './toolHandlers.mjs';

const HEARTBEAT_MS = 20_000;
const STREAM_FLUSH_MS = 150;
const STREAM_FLUSH_BYTES = 16 * 1024;
const ACK_TIMEOUT_MS = 10_000;

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
  const saved = loadDeviceCredentials();
  const serverUrl = resolveServerUrl(options, saved);
  const apiKey = options.apiKey ?? process.env.API_KEY;
  const rootsGiven = Boolean(options.dir);
  const roots = rootsGiven ? [path.resolve(options.dir)] : (saved?.roots?.length ? saved.roots : [process.cwd()]);
  const quiet = !!options.quiet;
  const say = (...args) => { if (!quiet) console.log(...args); };

  const profile = buildDeviceProfile(roots);
  const creds = await ensurePaired({ serverUrl, apiKey, code: options.code, roots, rootsGiven, name: options.name, repair: options.repair, profile });
  if (options.code) say(chalk.green(`✅ Đã kết nối máy "${creds.name}" với tài khoản Aivin của bạn — quay lại Aivin để chọn máy này.`));
  ensureMemoryLoaded();
  watchMemoryDir();
  const fileIndex = createFileIndex(roots);
  const env = { roots, binaries: profile.binaries, projects: profile.projects, fileIndex };
  const tools = buildTools(env);
  const byName = toolMap(tools);
  const { catalog, hash } = buildCatalog(tools);
  const scheduler = createScheduler();

  say(chalk.blue('💻 Aivin Device Agent — máy này nhận việc từ agent của bạn'));
  say(chalk.gray(`   Máy:        ${creds.name} (${creds.device_id})`));
  say(chalk.gray(`   Thư mục:    ${roots.join(' | ')}`));
  say(chalk.gray(`   Máy chủ:    ${serverUrl}`));
  say(chalk.gray(`   Công cụ:    ${catalog.length} (${profile.binaries.join(', ') || 'không phát hiện chương trình nào'})`));
  say(chalk.gray(`   Ghi nhớ:    ${memoryStats().total} mục — ${memoryStats().dir}`));
  if (isRemotePaused()) say(chalk.yellow('   ⏸  Đang TẠM DỪNG (aivin remote resume để nhận việc lại)'));

  fileIndex.build()
    .then((s) => { say(chalk.gray(`   Chỉ mục tệp: ${s.files} tệp (${s.updated} cập nhật, ${s.ms} ms)`)); fileIndex.watch(); })
    .catch((e) => say(chalk.yellow(`   ⚠️  Lập chỉ mục tệp lỗi: ${e.message}`)));

  const socket = io(`${serverUrl}${DEVICE_NAMESPACE}`, {
    auth: { device_token: creds.device_token, protocol: PROTOCOL_VERSION },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.5,
  });

  let stopped = false;
  const heartbeat = setInterval(() => { if (socket.connected) socket.emit(DeviceEvent.HEARTBEAT, {}); }, HEARTBEAT_MS);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    socket.disconnect();
    fileIndex.close();
    stopWatchingMemory();
    say(chalk.gray('🛑 Đã dừng nhận việc từ xa.'));
  };

  const announce = async () => {
    try {
      const hello = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.HELLO, { protocol: PROTOCOL_VERSION, profile, catalog_hash: hash });
      if (hello?.need_catalog) await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(DeviceEvent.CATALOG, { catalog_hash: hash, tools: catalog });
      say(chalk.green('✅ Đã kết nối — sẵn sàng nhận việc.'));
      logActivity({ type: 'connected', serverUrl, deviceId: creds.device_id });
    } catch (e) {
      say(chalk.yellow(`⚠️  Chào máy chủ lỗi (${e.message}) — sẽ thử lại khi nối lại.`));
    }
  };

  const handleCall = async (call) => {
    const tool = byName.get(call.tool);
    const streamer = createStreamer(socket, call.call_id);
    let outcome;
    if (isRemotePaused()) outcome = { ok: false, error: 'Remote control is paused on this device', error_code: DeviceErrorCode.KILL_SWITCH, duration_ms: 0 };
    else if (!tool) outcome = { ok: false, error: `Unknown tool: ${call.tool}`, error_code: DeviceErrorCode.TOOL_UNKNOWN, duration_ms: 0 };
    else {
      if (!tool.internal) say(chalk.yellow(`⚡ ${call.tool}`), chalk.gray(JSON.stringify(call.args || {}).slice(0, 160)));
      outcome = boundedResult(await scheduler.run(
        call,
        { group: tool.group, lockKeys: tool.lockKeys ? (a) => tool.lockKeys(a, env) : undefined },
        (args, ctx) => tool.handler(args, ctx, env),
        { onOutput: streamer.push },
      ));
    }
    streamer.flush();
    if (socket.connected) socket.emit(DeviceEvent.RESULT, { call_id: call.call_id, ...outcome });
    logActivity({ type: 'tool_call', tool: call.tool, id: call.call_id, success: outcome.ok, error: outcome.error, ms: outcome.duration_ms });
    if (!tool?.internal) say(outcome.ok ? chalk.green(`  ✓ ${call.tool} (${outcome.duration_ms} ms)`) : chalk.red(`  ✗ ${call.tool}: ${outcome.error}`));
  };

  socket.on('connect', () => void announce());
  let serverKicks = 0;
  socket.on('disconnect', (reason) => {
    if (stopped) return;
    say(chalk.yellow(`⚠️  Mất kết nối (${reason}) — tự nối lại...`));
    logActivity({ type: 'disconnected', reason });
    // Server chủ động cắt (BE khởi động lại, socket khác của máy này vừa thay chỗ…) → socket.io-client KHÔNG tự nối lại; nối tay, giãn nhịp.
    if (reason === 'io server disconnect') {
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(serverKicks++, 5)) + Math.floor(Math.random() * 500);
      setTimeout(() => { if (!stopped) socket.connect(); }, delay);
    }
  });
  socket.on('connect', () => { serverKicks = 0; });
  socket.on('connect_error', (err) => {
    if (err?.message === 'DEVICE_UNAUTHORIZED') {
      const replaced = !clearDeviceCredentials(creds.device_token);
      console.log(chalk.red(replaced
        ? '❌ Máy này vừa được ghép lại bởi một cửa sổ khác — cửa sổ này dừng, cửa sổ mới tiếp tục nhận việc.'
        : '❌ Token của máy không còn hiệu lực (đã thu hồi hoặc ghép lại ở nơi khác). Chạy `aivin remote start` để ghép lại.'));
      stop();
      return;
    }
    say(chalk.gray(`   (chưa nối được: ${err?.message} — thử lại...)`));
  });
  socket.on(DeviceEvent.REVOKED, () => {
    clearDeviceCredentials(creds.device_token);
    console.log(chalk.red('❌ Máy này đã bị thu hồi quyền điều khiển từ xa.'));
    stop();
  });
  socket.on(DeviceEvent.CALLS, (payload) => {
    const calls = Array.isArray(payload?.calls) ? payload.calls : [];
    if (!calls.length) return;
    socket.emit(DeviceEvent.ACK, { call_ids: calls.map((c) => c.call_id) });
    calls.forEach((call) => void handleCall(call));
  });
  socket.on(DeviceEvent.CANCEL, (payload) => scheduler.cancel(payload?.call_ids));

  if (options.handleSignals !== false) {
    const onSignal = () => { stop(); process.exit(0); };
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
