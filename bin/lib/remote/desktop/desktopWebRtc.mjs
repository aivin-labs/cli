/**
 * Desktop Cast WebRTC transport. Có `nonstandard.RTCVideoSource` (02/11/2026): hình đi video track — libwebrtc mã hoá VP8 liên khung, tự
 * chỉnh bitrate theo mạng; kênh `aivin-desktop-frames` chỉ mang gói meta (kích thước, màn hình) để FE quy đổi toạ độ. Không có: JPEG theo
 * khung qua kênh dữ liệu không thứ tự (khung cũ không bao giờ xếp trước khung mới). Quay màn hình ở desktopCast.mjs; JPEG qua Socket.IO là
 * đường lùi khi không có runtime native.
 */

const MAX_BUFFERED_BYTES = 512 * 1024;
/** Kênh thao tác chuột / phím người xem → máy: tin cậy + đúng thứ tự (nhả chuột không được đến trước nhấn), đi thẳng peer-to-peer. */
export const INPUT_CHANNEL = 'aivin-desktop-input';
const MAX_INPUT_MESSAGE_BYTES = 8 * 1024;

export function packDesktopFrame(frame) {
  const image = Buffer.from(String(frame?.image || ''), 'base64');
  const meta = Buffer.from(JSON.stringify({
    t: 'frame', sessionId: frame?.sessionId, seq: frame?.seq, ts: frame?.ts,
    width: frame?.width, height: frame?.height,
    screenWidth: frame?.screenWidth, screenHeight: frame?.screenHeight,
    screenX: frame?.screenX, screenY: frame?.screenY,
    monitor: frame?.monitor, screens: frame?.screens,
    mime: 'image/jpeg', bytes: image.length,
  }) + '\n');
  return Buffer.concat([meta, image]);
}

export function unpackDesktopFrame(packet) {
  const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  const nl = buf.indexOf(0x0a);
  if (nl <= 0) return null;
  try {
    const meta = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    const imageBytes = buf.subarray(nl + 1);
    return { meta, imageBytes, jpeg: imageBytes };
  } catch {
    return null;
  }
}

export function createDesktopWebRtc({ emitSignal = () => {}, emitStatus = () => {}, onInput = () => {}, onPeerReady = () => {}, loadRuntime } = {}) {
  const peers = new Map();
  let runtime = null;
  let sequence = 0;
  /**
   * Một nguồn video dùng chung mọi người xem (một lần quay → nhiều track). Bẫy wrtc 0.10.0 (đo 02/11/2026): đã tạo RTCVideoSource thì
   * tiến trình THOÁT TỰ NHIÊN (hết event loop) bị segfault lúc huỷ native — `process.exit()` thì sạch. Daemon luôn thoát bằng
   * `process.exit` (stopForGood / tín hiệu / tự cập nhật); thêm đường thoát mới phải giữ như vậy, không thì trình giữ chạy tưởng CLI sập.
   */
  let videoSource = null;
  // Không nhớ kết quả rỗng: runtime có thể vừa tải xong ở nền (webrtcRuntime.mjs) — phiên xem sau dùng được ngay, không cần khởi động lại.
  const load = async () => {
    if (runtime) return runtime;
    runtime = await (loadRuntime ? loadRuntime() : import('@roamhq/wrtc').catch(() => null));
    return runtime;
  };

  async function start({ sessionId, viewerId, iceServers = [] }) {
    close(viewerId);
    const wrtc = await load();
    const RTCPeerConnection = wrtc?.RTCPeerConnection || wrtc?.default?.RTCPeerConnection;
    if (!RTCPeerConnection) return false;
    const pc = new RTCPeerConnection({ iceServers });
    const channel = pc.createDataChannel('aivin-desktop-frames', { ordered: false, maxRetransmits: 0 });
    const inputChannel = pc.createDataChannel(INPUT_CHANNEL, { ordered: true });
    const VideoSource = wrtc?.nonstandard?.RTCVideoSource || wrtc?.default?.nonstandard?.RTCVideoSource;
    if (VideoSource && !videoSource) videoSource = new VideoSource({ isScreencast: true });
    const track = videoSource ? videoSource.createTrack() : null;
    if (track) pc.addTrack(track);
    const peer = { pc, channel, inputChannel, track, video: !!track, sessionId, viewerId, open: false, dropped: 0 };
    inputChannel.onmessage = ({ data }) => {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      if (text.length > MAX_INPUT_MESSAGE_BYTES) return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      // Mã phiên lấy từ peer (đã gắn lúc BE mời), không tin mã trong gói.
      onInput({ ...msg, session_id: peer.sessionId }, viewerId);
    };
    peers.set(viewerId, peer);
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      peer.open = true;
      emitStatus({ session_id: sessionId, viewer_id: viewerId, state: 'connected', transport: 'webrtc', video: peer.video });
      onPeerReady(viewerId);
    };
    channel.onclose = () => { peer.open = false; };
    pc.onicecandidate = ({ candidate }) => {
      emitSignal({ session_id: sessionId, viewer_id: viewerId, type: 'ice', candidate: candidate?.toJSON?.() || candidate || null });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        peer.open = false;
        emitStatus({ session_id: sessionId, viewer_id: viewerId, state: pc.connectionState, transport: 'jpeg' });
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    emitSignal({ session_id: sessionId, viewer_id: viewerId, type: 'offer', sdp: pc.localDescription?.sdp, ice_servers: iceServers });
    return true;
  }

  async function signal(msg) {
    const peer = peers.get(String(msg?.viewer_id || ''));
    if (!peer || msg?.session_id !== peer.sessionId) return false;
    if (msg.type === 'answer' && msg.sdp) {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      return true;
    }
    if (msg.type === 'ice') {
      await peer.pc.addIceCandidate(msg.candidate || null).catch(() => {});
      return true;
    }
    return false;
  }

  /** JPEG cho người xem chưa có video; người có video chỉ nhận gói meta (không ảnh). */
  function push(frame) {
    const packet = packDesktopFrame({ ...frame, seq: ++sequence });
    const metaPacket = packDesktopFrame({ ...frame, image: '', seq: sequence });
    let sent = 0;
    for (const peer of peers.values()) {
      if (!peer.open || peer.channel.readyState !== 'open') continue;
      if (peer.video) {
        try { peer.channel.send(metaPacket); } catch { /* kênh vừa đóng */ }
        continue;
      }
      if (peer.channel.bufferedAmount > MAX_BUFFERED_BYTES) { peer.dropped++; continue; }
      try { peer.channel.send(packet); sent++; } catch { peer.dropped++; }
    }
    return sent;
  }

  /** Khung thô I420 từ tiến trình quay → nguồn video (mọi track cùng nguồn). */
  function pushRaw(frame) {
    if (!videoSource || ![...peers.values()].some(p => p.video && p.open)) return false;
    try { videoSource.onFrame(frame); return true; } catch { return false; }
  }

  /** Còn người xem cần ảnh JPEG (chưa nối WebRTC, hoặc nối nhưng không có video). */
  function needsJpeg() { return needsFallback() || [...peers.values()].some(p => !p.video); }
  function hasVideo() { return [...peers.values()].some(p => p.video); }

  function anyOpen() { return [...peers.values()].some(p => p.open && p.channel.readyState === 'open'); }
  function needsFallback() { return peers.size === 0 || [...peers.values()].some(p => !p.open || p.channel.readyState !== 'open'); }

  function close(viewerId) {
    const peer = peers.get(String(viewerId || ''));
    if (!peer) return;
    peers.delete(String(viewerId));
    try { peer.channel.close(); } catch { /* already closed */ }
    try { peer.inputChannel?.close(); } catch { /* already closed */ }
    try { peer.track?.stop(); } catch { /* already stopped */ }
    try { peer.pc.close(); } catch { /* already closed */ }
  }

  function closeAll() { for (const id of [...peers.keys()]) close(id); }
  return { start, signal, push, pushRaw, needsJpeg, hasVideo, anyOpen, needsFallback, close, closeAll };
}
