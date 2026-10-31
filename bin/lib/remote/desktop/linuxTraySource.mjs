/**
 * Aivin trên màn hình Linux (29/10/2026) — biểu tượng khay qua AppIndicator (Ubuntu / KDE / phần lớn môi trường có khay; GNOME cần tiện
 * ích AppIndicator) bằng python3 + PyGObject có sẵn trên đa số bản desktop. Không có AppIndicator / GTK / màn hình → vẫn chạy, chỉ giữ
 * daemon chạy (không biểu tượng). Không có python3 → kịch bản sh khởi chạy tự lặp giữ daemon. Như Aivin.exe: mã 0 → chờ tới khi máy rảnh lại,
 * 75 → chạy lại ngay, khác → giãn dần tới 5 phút (tự lùi bản nằm trong aivin-remote-run.sh). `@@HOME@@` = thư mục cấu hình (chuỗi JSON).
 */
export const LINUX_TRAY_PY = String.raw`#!/usr/bin/env python3
# Aivin tray (Linux): AppIndicator icon + keeps aivin-remote-run.sh running. Falls back to no icon when GTK / AppIndicator is missing.
import calendar
import json
import os
import shutil
import signal
import subprocess
import sys
import time

HOME = @@HOME@@
CREDS = os.path.join(HOME, 'device-credentials.json')
# Listener sập: mở lại sau 2 s, rồi gấp đôi (tối đa 5 phút) nếu sập liên tục.
FIRST_DELAY = 2
LOCK = os.path.join(HOME, 'remote-daemon.lock')
PAUSED = os.path.join(HOME, 'remote-paused')
DESK = os.path.join(HOME, 'desktop')
CFG = os.path.join(DESK, 'launch.cfg')
LOGO = os.path.join(DESK, 'logo.png')
LOGO_GREY = os.path.join(DESK, 'logo-grey.png')
TRAY_LOCK = os.path.join(DESK, 'tray.lock')
OPEN_REQ = os.path.join(DESK, 'open-request')
QUIT_REQ = os.path.join(DESK, 'quit-request')
RESTART_CODE = 75


def load_cfg():
    cfg = {'exe': None, 'args': [], 's': {}, 'extra': {}}
    try:
        with open(CFG, encoding='utf-8') as f:
            for line in f.read().splitlines():
                k, sep, v = line.partition('=')
                if not sep or not k:
                    continue
                if k == 'exe':
                    cfg['exe'] = v
                elif k == 'arg':
                    cfg['args'].append(v)
                elif k.startswith('s.'):
                    cfg['s'][k[2:]] = v
                else:
                    cfg['extra'][k] = v
    except OSError:
        pass
    return cfg


def mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0


def touch(path):
    with open(path, 'w') as f:
        f.write(str(time.time()))


def notify(text):
    if shutil.which('notify-send'):
        subprocess.Popen(['notify-send', '-i', LOGO, 'AIVIN Bot CLI', text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


class Supervisor:
    def __init__(self):
        self.cfg = load_cfg()
        self.child = None
        self.child_pid = 0
        self.started = 0
        self.next_start = 0
        self.delay = FIRST_DELAY
        self.pairing = False
        self.was_paired = os.path.exists(CREDS)
        self.seen_open = mtime(OPEN_REQ)
        self.seen_quit = mtime(QUIT_REQ)
        self.on_open = None
        self.on_quit = None

    def t(self, key):
        return self.cfg['s'].get(key, key)

    def lock_held(self):
        try:
            with open(LOCK, encoding='utf-8') as f:
                d = json.load(f)
            pid = int(d.get('pid') or 0)
            if self.child is None and pid == self.child_pid:
                return False
            beat = str(d.get('beat_at') or d.get('started_at') or '')
            if beat:
                at = calendar.timegm(time.strptime(beat[:19], '%Y-%m-%dT%H:%M:%S'))
                if time.time() - at > 90:
                    return False
            return pid > 0 and pid_alive(pid)
        except (OSError, ValueError):
            return False

    def running(self):
        return (self.child is not None and self.child.poll() is None) or self.lock_held()

    def backoff(self):
        self.next_start = time.time() + self.delay
        self.delay = min(self.delay * 2, 300)

    def start(self, code=None):
        self.cfg = load_cfg()
        if not self.cfg['exe']:
            return
        args = [self.cfg['exe']] + self.cfg['args'] + (['--code', code] if code else [])
        try:
            self.child = subprocess.Popen(args, cwd=os.path.expanduser('~'), stdin=subprocess.DEVNULL, start_new_session=True)
            self.child_pid = self.child.pid
            self.started = time.time()
            self.pairing = bool(code)
        except OSError:
            self.child = None
            self.backoff()

    def on_exit(self, rc):
        secs = time.time() - self.started
        self.child = None
        was_pairing, self.pairing = self.pairing, False
        if was_pairing and not os.path.exists(CREDS):
            notify(self.t('pairFailed'))
            return
        if rc == 0:
            # Dừng có chủ đích (thu hồi, ghép lại, cửa sổ khác nhận việc): chờ ngắn; thoát 0 liền nhau (hai máy chung token) thì giãn dần.
            if secs < 30:
                self.backoff()
            else:
                self.delay = FIRST_DELAY
                self.next_start = time.time() + FIRST_DELAY
        elif rc == RESTART_CODE:
            self.next_start = time.time() + 1
        else:
            if secs > 300:
                self.delay = FIRST_DELAY
            self.backoff()

    def kill(self):
        c, self.child = self.child, None
        if c is None or c.poll() is not None:
            return
        try:
            os.killpg(c.pid, signal.SIGTERM)
            c.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(c.pid, signal.SIGKILL)
            except OSError:
                pass

    def start_now(self):
        if self.child is None and not self.lock_held():
            self.next_start = 0
            self.delay = FIRST_DELAY

    def tick(self):
        if mtime(QUIT_REQ) > self.seen_quit:
            self.seen_quit = mtime(QUIT_REQ)
            if self.on_quit:
                self.on_quit()
            return
        if self.child is not None:
            rc = self.child.poll()
            if rc is not None:
                self.on_exit(rc)
        paired = os.path.exists(CREDS)
        if paired and not self.was_paired:
            notify(self.t('connected'))
        self.was_paired = paired
        if self.child is None and paired and time.time() >= self.next_start and not self.lock_held():
            self.start()
        req = mtime(OPEN_REQ)
        if req > self.seen_open:
            self.seen_open = req
            if self.on_open:
                self.on_open()


def startup_file(sup):
    return sup.cfg['extra'].get('autostart')


def startup_enabled(sup):
    path = startup_file(sup)
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except (OSError, TypeError):
        return False
    return 'Hidden=true' not in text and 'X-GNOME-Autostart-enabled=false' not in text


def set_startup(sup, on):
    path, copy = startup_file(sup), sup.cfg['extra'].get('autostart_copy')
    if not path:
        return
    try:
        if on:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            shutil.copyfile(copy, path)
        elif os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                text = f.read()
            text = text.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false').replace('Hidden=false', 'Hidden=true')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(text)
    except OSError:
        pass


def gtk_ui(sup):
    """Biểu tượng khay. None khi không có màn hình / GTK / AppIndicator (khi đó chạy không biểu tượng)."""
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        return None
    try:
        import gi
        gi.require_version('Gtk', '3.0')
        gi.require_version('GdkPixbuf', '2.0')
        try:
            gi.require_version('AyatanaAppIndicator3', '0.1')
            from gi.repository import AyatanaAppIndicator3 as AppIndicator
        except (ValueError, ImportError):
            gi.require_version('AppIndicator3', '0.1')
            from gi.repository import AppIndicator3 as AppIndicator
        from gi.repository import GdkPixbuf, GLib, Gtk
    except (ImportError, ValueError):
        return None

    try:
        pb = GdkPixbuf.Pixbuf.new_from_file(LOGO)
        grey = pb.copy()
        pb.saturate_and_pixelate(grey, 0.0, False)
        grey.save(LOGO_GREY, 'png')
    except Exception:
        pass

    t = sup.t
    ind = AppIndicator.Indicator.new('aivin', LOGO, AppIndicator.IndicatorCategory.APPLICATION_STATUS)
    ind.set_status(AppIndicator.IndicatorStatus.ACTIVE)
    ind.set_title('AIVIN Bot CLI')
    menu = Gtk.Menu()
    status = Gtk.MenuItem(label='AIVIN Bot CLI')
    status.set_sensitive(False)
    connect = Gtk.MenuItem(label=t('connect'))
    pause = Gtk.MenuItem(label=t('pause'))
    startup = Gtk.CheckMenuItem(label=t('startup'))
    folder = Gtk.MenuItem(label=t('folder'))
    quit_item = Gtk.MenuItem(label=t('quit'))
    for item in (status, Gtk.SeparatorMenuItem(), connect, pause, startup, folder, Gtk.SeparatorMenuItem(), quit_item):
        menu.append(item)
    state = {'icon': None, 'syncing': False, 'dialog': False}

    def refresh():
        paired, paused, up = os.path.exists(CREDS), os.path.exists(PAUSED), sup.running()
        text = t('connecting' if sup.pairing else 'notPaired') if not paired else t('stopped') if not up else t('paused') if paused else t('running')
        status.set_label(text)
        icon = LOGO if paired and up and not paused else (LOGO_GREY if os.path.exists(LOGO_GREY) else LOGO)
        if icon != state['icon']:
            state['icon'] = icon
            ind.set_icon_full(icon, 'Aivin - ' + text)
        connect.set_visible(not paired)
        pause.set_label(t('resume' if paused else 'pause'))
        pause.set_visible(paired)
        state['syncing'] = True
        startup.set_active(startup_enabled(sup))
        state['syncing'] = False

    def ask_code(*_):
        if state['dialog']:
            return
        state['dialog'] = True
        d = Gtk.Dialog(title='AIVIN Bot CLI')
        d.add_buttons(t('pairCancel'), Gtk.ResponseType.CANCEL, t('pairOk'), Gtk.ResponseType.OK)
        d.set_default_response(Gtk.ResponseType.OK)
        d.set_keep_above(True)
        box = d.get_content_area()
        box.set_spacing(10)
        box.set_border_width(14)
        label = Gtk.Label(label=t('pairPrompt'))
        label.set_line_wrap(True)
        label.set_max_width_chars(48)
        entry = Gtk.Entry()
        entry.set_activates_default(True)
        box.pack_start(label, False, False, 0)
        box.pack_start(entry, False, False, 0)
        d.show_all()
        response = d.run()
        code = entry.get_text().strip().upper()
        d.destroy()
        state['dialog'] = False
        if response == Gtk.ResponseType.OK and code:
            sup.kill()
            sup.start(code)
        refresh()

    def toggle_pause(*_):
        try:
            if os.path.exists(PAUSED):
                os.remove(PAUSED)
            else:
                with open(PAUSED, 'w') as f:
                    f.write(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        except OSError:
            pass
        refresh()

    def toggle_startup(item):
        if not state['syncing']:
            set_startup(sup, item.get_active())
            refresh()

    def open_folder(*_):
        opener = shutil.which('xdg-open')
        if opener:
            subprocess.Popen([opener, HOME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def quit_app(*_):
        sup.kill()
        Gtk.main_quit()

    def open_aivin():
        if not os.path.exists(CREDS):
            ask_code()
        else:
            sup.start_now()
            notify(t('running') if sup.running() else t('stopped'))

    connect.connect('activate', ask_code)
    pause.connect('activate', toggle_pause)
    startup.connect('toggled', toggle_startup)
    folder.connect('activate', open_folder)
    quit_item.connect('activate', quit_app)
    menu.show_all()
    ind.set_menu(menu)
    sup.on_open = open_aivin
    sup.on_quit = quit_app

    def on_tick():
        sup.tick()
        refresh()
        return True

    GLib.timeout_add_seconds(2, on_tick)
    refresh()

    class Ui:
        open = staticmethod(open_aivin)

        @staticmethod
        def run():
            Gtk.main()
    return Ui


def main(argv):
    import fcntl
    os.makedirs(DESK, exist_ok=True)
    lock = open(TRAY_LOCK, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        # Đã có một bản chạy: mở lần nữa = mở Aivin; --quit = bảo bản đó thoát.
        if '--quit' in argv:
            touch(QUIT_REQ)
        elif '--autostart' not in argv and '--installed' not in argv:
            touch(OPEN_REQ)
        return 0
    if '--quit' in argv:
        return 0
    sup = Supervisor()
    signal.signal(signal.SIGTERM, lambda *_: (sup.kill(), sys.exit(0)))
    ui = gtk_ui(sup)
    sup.tick()
    if ui is None:
        stop = []
        sup.on_quit = lambda: (sup.kill(), stop.append(True))
        while not stop:
            time.sleep(2)
            sup.tick()
        return 0
    if '--installed' in argv:
        notify(sup.t('firstRun' if sup.was_paired else 'connectHint'))
    elif '--autostart' not in argv:
        ui.open()
    ui.run()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
`;

/**
 * Kịch bản mở Aivin (menu ứng dụng, autostart). Có python3 → khay; không thì tự lặp giữ daemon (chỉ khi đã ghép máy — chưa ghép thì
 * daemon không tự kết nối được, chạy lặp vô ích). `@@…@@` thay bằng đường dẫn đã bọc nháy đơn.
 */
export const LINUX_LAUNCHER_SH = `#!/bin/sh
# Aivin desktop app (Linux): tray icon + keeps \`aivin remote start\` running (tray.py); without python3, keeps it running without an icon.
exec >>@@LOG@@ 2>&1
if command -v python3 >/dev/null 2>&1; then exec python3 @@TRAY@@ "$@"; fi
case " $* " in *" --quit "*) exit 0 ;; esac
delay=10
while [ -f @@CREDS@@ ]; do
  started=$(date +%s)
  /bin/sh @@RUN@@
  rc=$?
  [ "$rc" -eq 0 ] && exit 0
  if [ "$rc" -eq 75 ]; then sleep 1; continue; fi
  [ $(( $(date +%s) - started )) -gt 300 ] && delay=10
  sleep "$delay"
  delay=$(( delay * 2 ))
  [ "$delay" -gt 300 ] && delay=300
done
`;
