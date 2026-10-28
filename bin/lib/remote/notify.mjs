import { spawn } from 'child_process';
import { AIVIN_NOTIF_AUMID, ensureWindowsNotificationIdentity } from '../missionStream.mjs';

/**
 * Thông báo của hệ điều hành khi AI cần người dùng (27/10/2026): AI Browser chạy trên trình duyệt của máy này mà gặp đăng nhập / captcha / cần duyệt
 * thao tác → BE gọi `notify.show`. Windows: toast có biểu tượng Aivin, bấm vào mở đúng cuộc trò chuyện (`url`); macOS / Linux: thông báo chữ.
 * Chữ và đường dẫn đi qua biến môi trường, không ghép vào script (không trích dẫn / chèn lệnh được). Không bao giờ ném lỗi.
 */

const MAX_TITLE = 120;
const MAX_BODY = 400;

/** Chỉ nhận http(s) — toast mở đường dẫn này bằng trình duyệt mặc định khi bấm. */
export function safeNotifyUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

export function showOSNotification({ title, body, url } = {}) {
  const t = String(title || 'Aivin').slice(0, MAX_TITLE);
  const m = String(body || '').slice(0, MAX_BODY);
  const link = safeNotifyUrl(url);
  try {
    if (process.platform === 'win32') {
      ensureWindowsNotificationIdentity();
      const script = [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
        "$t = [System.Security.SecurityElement]::Escape($env:AIVIN_NOTIF_TITLE)",
        "$m = [System.Security.SecurityElement]::Escape($env:AIVIN_NOTIF_MSG)",
        "$u = [System.Security.SecurityElement]::Escape($env:AIVIN_NOTIF_URL)",
        "$launch = if ($u) { \" activationType='protocol' launch='$u'\" } else { '' }",
        "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
        "$xml.LoadXml(\"<toast scenario='reminder'$launch><visual><binding template='ToastGeneric'><text>$t</text><text>$m</text></binding></visual><actions><action content='OK' arguments='dismiss' activationType='system'/></actions></toast>\")",
        "$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)",
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AIVIN_NOTIF_AUMID}').Show($toast)`,
      ].join('; ');
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, AIVIN_NOTIF_TITLE: t, AIVIN_NOTIF_MSG: m, AIVIN_NOTIF_URL: link },
        stdio: 'ignore', detached: true, windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', 'display notification (system attribute "AIVIN_NOTIF_MSG") with title (system attribute "AIVIN_NOTIF_TITLE") sound name "Glass"'], {
        env: { ...process.env, AIVIN_NOTIF_TITLE: t, AIVIN_NOTIF_MSG: m },
        stdio: 'ignore', detached: true,
      }).unref();
    } else {
      spawn('notify-send', ['--urgency=critical', t, m], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // best-effort
  }
  return { shown: true };
}
