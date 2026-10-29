import { UpdateStatus, compareVersions, currentCliVersion, installUpdate, installedNewerThanRunning, loadUpdateSettings, parseVersion, tagOf } from '../selfUpdate.mjs';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Tự cập nhật trong `aivin remote start` (29/10/2026). Mỗi ~6 giờ (lần đầu sau 2–5 phút, rải ngẫu nhiên để các máy không cùng dội trang tải
 * sau một lần phát hành) kiểm bản mới; có (và máy thuộc đợt phát hành, xem rollout.json) thì tải + kiểm chữ ký + thay tệp chạy ngay (tiến
 * trình đang chạy không bị ảnh hưởng). Rồi:
 * - chạy dưới trình giữ chạy thật (`supervised`, xem detectSupervisor ở autoStart.mjs): chờ máy yên `idleGraceMs` tính từ lần hoạt động cuối
 *   (`lastActivityAt` — lời gọi bắt đầu / kết thúc — hoặc lần cuối thấy còn tiến trình nền / đường hầm trình duyệt) → `onRestart` dừng gọn +
 *   thoát mã 75, trình giữ chạy mở lại bằng bản mới. 10 phút: khoảng nghỉ giữa các bước của một nhiệm vụ (lượt Planner, chờ người duyệt trên
 *   web) không bị coi là rảnh;
 * - không có trình giữ chạy (cửa sổ chạy tay, script riêng): báo một lần "đóng, chạy lại" — không tự thoát.
 * `setMinVersion` (BE báo trong ack của HELLO): bản đang chạy cũ hơn → kiểm trong vài phút (rải ngẫu nhiên: BE khởi động lại thì mọi máy
 * cùng nối lại), bỏ qua đợt phát hành.
 * Tắt: `aivin update --auto off`, `--no-auto-update`, hoặc AIVIN_AUTO_UPDATE=0 — khi tắt chỉ nhắc, không tải gì.
 */
export function createAutoUpdater({
  enabled = true, supervised = false, isIdle = () => true, lastActivityAt = () => 0, onRestart = () => {}, say = () => {}, deviceId,
  checkEveryMs = 6 * HOUR, firstCheckMs = 2 * MINUTE + Math.floor(Math.random() * 3 * MINUTE), tickMs = 30_000, idleGraceMs = 10 * MINUTE,
  retryMs = HOUR, urgentGapMs = 10 * MINUTE, urgentJitterMs = 5 * MINUTE,
  install = installUpdate, settings = loadUpdateSettings, installedNewer = installedNewerThanRunning, current = currentCliVersion(),
  now = Date.now, random = Math.random,
} = {}) {
  let nextCheckAt = now() + firstCheckMs;
  let checking = null;
  let ready = null;
  let lastBusyAt = now();
  let restarting = false;
  let minVersion = null;
  let urgent = false;
  let lastUrgentAt = -Infinity;
  const notices = new Set();
  const noticeOnce = (key, text) => {
    if (notices.has(key)) return;
    notices.add(key);
    say(text);
  };
  const jitter = (ms) => Math.round(ms * (0.8 + random() * 0.4));
  const restartHint = 'đóng cửa sổ này và chạy lại `aivin remote start` để dùng bản mới';

  const check = async () => {
    if (!settings().auto) {
      nextCheckAt = now() + checkEveryMs;
      if (minVersion) noticeOnce(`min-off:${minVersion}`, `⚠️  Máy chủ cần aivin ${tagOf(minVersion)} trở lên (máy này ${tagOf(current)}), tự cập nhật đang tắt — chạy \`aivin update\`.`);
      return;
    }
    try {
      const res = await install({ deviceId, urgent: urgent && !!minVersion && compareVersions(current, minVersion) < 0 });
      nextCheckAt = now() + jitter(checkEveryMs);
      if (res.status === UpdateStatus.INSTALLED) {
        ready = res.latest;
        notices.add(`ready:${ready}`);
        say(`⬆  Đã tải aivin ${res.latest} (đang chạy ${res.current}) — ${supervised ? 'chuyển sang bản mới khi máy rảnh' : restartHint}.`);
      } else if (res.status === UpdateStatus.NOT_BINARY) {
        noticeOnce(`npm:${res.latest}`, `⬆  Có aivin ${res.latest} (máy này ${res.current}) — cập nhật: npm i -g @aivin-labs/cli@latest`);
      } else if (res.status === UpdateStatus.SKIPPED) {
        noticeOnce(`skip:${res.latest}`, `   (bỏ qua aivin ${res.latest}: máy này đã tự lùi khỏi bản đó vì khởi động hỏng — cài lại: aivin update --to ${res.latest})`);
      }
    } catch (e) {
      nextCheckAt = now() + retryMs;
      noticeOnce(`err:${e?.message}`, `   (chưa cập nhật được: ${e?.message || e} — thử lại sau)`);
    }
  };

  const tick = async () => {
    if (!enabled || restarting) return;
    if (!isIdle()) lastBusyAt = now();
    ready = ready || installedNewer();
    if (ready) {
      if (!supervised) return noticeOnce(`ready:${ready}`, `⬆  Đã cài aivin ${ready} — ${restartHint}.`);
      if (!isIdle() || now() - Math.max(lastBusyAt, Number(lastActivityAt()) || 0) < idleGraceMs) return;
      restarting = true;
      return onRestart(ready);
    }
    if (checking || now() < nextCheckAt) return;
    checking = check().finally(() => { checking = null; });
    await checking;
  };

  const timer = enabled ? setInterval(() => { void tick(); }, tickMs) : null;
  timer?.unref?.();

  return {
    tick,
    /** BE yêu cầu bản tối thiểu: máy cũ hơn → kiểm trong `urgentJitterMs` (tối đa một lần / `urgentGapMs`), bỏ qua đợt phát hành. */
    setMinVersion(version) {
      if (!enabled || !parseVersion(version) || compareVersions(current, version) >= 0) return;
      minVersion = version;
      urgent = true;
      if (now() - lastUrgentAt < urgentGapMs) return;
      lastUrgentAt = now();
      nextCheckAt = Math.min(nextCheckAt, now() + Math.floor(random() * urgentJitterMs));
    },
    close() { if (timer) clearInterval(timer); },
    state: () => ({ ready, nextCheckAt, minVersion, checking: !!checking }),
  };
}
