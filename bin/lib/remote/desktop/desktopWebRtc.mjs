/**
 * Desktop Cast WebRTC transport. Frames use an unreliable/unordered data channel so an old desktop
 * frame can never queue ahead of a fresh one. This is deliberately a transport layer: Windows
 * capture stays in desktopCast.mjs and JPEG-over-Socket.IO remains the no-native-runtime fallback.
 */

const MAX_BUFFERED_BYTES = 512 * 1024;

export function packDesktopFrame(frame) {
  const image = Buffer.from(String(frame?.image || ''), 'base64');
  const meta = Buffer.from(JSON.stringify({
    t: 'frame', sessionId: frame?.sessionId, seq: frame?.seq, ts: frame?.ts,
    width: frame?.width, height: frame?.height,
    screenWidth: frame?.screenWidth, screenHeight: frame?.screenHeight,
    mime: 'image/jpeg', bytes: image.length,
  }) + '\n');
  return Buffer.concat([meta, image]);
}

export function createDesktopWebRtc({ emitSignal = () => {}, emitStatus = () => {}, loadRuntime } = {}) {
  const peers = new Map();
  let runtimePromise;
  let sequence = 0;
  const load = () => (runtimePromise ||= (loadRuntime
    ? loadRuntime()
    : import('@roamhq/wrtc').catch(() => null)));

  async function start({ sessionId, viewerId, iceServers = [] }) {
    close(viewerId);
    const wrtc = await load();
    const RTCPeerConnection = wrtc?.RTCPeerConnection || wrtc?.default?.RTCPeerConnection;
    if (!RTCPeerConnection) return false;
    const pc = new RTCPeerConnection({ iceServers });
    const channel = pc.createDataChannel('aivin-desktop-frames', { ordered: false, maxRetransmits: 0 });
    const peer = { pc, channel, sessionId, viewerId, open: false, dropped: 0 };
    peers.set(viewerId, peer);
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      peer.open = true;
      emitStatus({ session_id: sessionId, viewer_id: viewerId, state: 'connected', transport: 'webrtc' });
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
    emitSignal({ session_id: sessionId, viewer_id: viewerId, type: 'offer', sdp: pc.localDescription?.sdp });
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

  function push(frame) {
    const packet = packDesktopFrame({ ...frame, seq: ++sequence });
    let sent = 0;
    for (const peer of peers.values()) {
      if (!peer.open || peer.channel.readyState !== 'open') continue;
      if (peer.channel.bufferedAmount > MAX_BUFFERED_BYTES) { peer.dropped++; continue; }
      try { peer.channel.send(packet); sent++; } catch { peer.dropped++; }
    }
    return sent;
  }

  function anyOpen() { return [...peers.values()].some(p => p.open && p.channel.readyState === 'open'); }
  function needsFallback() { return peers.size === 0 || [...peers.values()].some(p => !p.open || p.channel.readyState !== 'open'); }

  function close(viewerId) {
    const peer = peers.get(String(viewerId || ''));
    if (!peer) return;
    peers.delete(String(viewerId));
    try { peer.channel.close(); } catch { /* already closed */ }
    try { peer.pc.close(); } catch { /* already closed */ }
  }

  function closeAll() { for (const id of [...peers.keys()]) close(id); }
  return { start, signal, push, anyOpen, needsFallback, close, closeAll };
}
