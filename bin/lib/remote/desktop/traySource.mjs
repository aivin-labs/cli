/**
 * Ứng dụng khay hệ thống Aivin trên Windows (29/10/2026) — `Aivin.exe`, một tệp chạy giao diện (không cửa sổ console) biên dịch trên chính
 * máy người dùng bằng csc của .NET Framework (CodeDom, chỉ cú pháp C# 5: không `$"..."`, không `?.`, không `=>` cho thân hàm). Nó là:
 * - biểu tượng ở khay hệ thống: trạng thái (đang chạy / tạm dừng / chưa kết nối), mở linh vật, tạm dừng, bật / tắt khởi động cùng Windows, thoát;
 * - trình giữ chạy của `aivin remote start` (thay kịch bản VBS): chạy ẩn, mã 0 → thôi tới khi máy rảnh lại, 75 → chạy lại ngay, khác → giãn
 *   dần tới 5 phút, tự lùi bản mới sập liên tục (như windowsWatchdogScript);
 * - mục khởi động trong Task Manager → Startup apps (khoá HKCU Run trỏ vào chính nó, tên + biểu tượng lấy từ thông tin phiên bản của tệp).
 * Đọc launch.cfg (desktop/index.mjs) mỗi lần chạy daemon — đổi `--dir` / `--proxy` không cần biên dịch lại. `@@HOME@@` = thư mục cấu hình.
 */
export const TRAY_CS = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("AIVIN Bot CLI")]
[assembly: AssemblyDescription("Aivin - lets your Aivin agents work on this computer")]
[assembly: AssemblyCompany("Aivin Labs")]
[assembly: AssemblyProduct("AIVIN Bot CLI")]
[assembly: AssemblyCopyright("Aivin Labs")]
[assembly: AssemblyVersion("@@VERSION@@")]
[assembly: AssemblyFileVersion("@@VERSION@@")]

namespace AivinDesktop {
  static class Program {
    public const string Home = @@HOME@@;

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main(string[] args) {
      bool autostart = Array.IndexOf(args, "--autostart") >= 0;
      bool installed = Array.IndexOf(args, "--installed") >= 0;
      bool quit = Array.IndexOf(args, "--quit") >= 0;
      string id = ((uint)Home.ToLowerInvariant().GetHashCode()).ToString("x8");
      bool created;
      using (Mutex mutex = new Mutex(true, "Local\\AivinTray-" + id, out created)) {
        if (!created) {
          // Đã có một bản chạy: mở Start menu / Aivin.exe lần nữa = mở Aivin; --quit = bảo bản đó thoát.
          if (quit) Signal("Local\\AivinTrayQuit-" + id);
          else if (!autostart && !installed) Signal("Local\\AivinTrayOpen-" + id);
          return 0;
        }
        if (quit) return 0;
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayApp(id, !autostart && !installed, installed));
        GC.KeepAlive(mutex);
      }
      return 0;
    }

    static void Signal(string name) {
      try { using (EventWaitHandle e = EventWaitHandle.OpenExisting(name)) e.Set(); } catch { }
    }
  }

  class Config {
    public string Exe;
    public List<string> Args = new List<string>();
    public string Pending;
    public string Rollback;
    Dictionary<string, string> strings = new Dictionary<string, string>();

    public static Config Load(string file) {
      Config c = new Config();
      try {
        foreach (string line in File.ReadAllLines(file, Encoding.UTF8)) {
          int i = line.IndexOf('=');
          if (i <= 0) continue;
          string k = line.Substring(0, i), v = line.Substring(i + 1);
          if (k == "exe") c.Exe = v;
          else if (k == "arg") c.Args.Add(v);
          else if (k == "pending") c.Pending = v;
          else if (k == "rollback") c.Rollback = v;
          else if (k.StartsWith("s.")) c.strings[k.Substring(2)] = v.Replace("\\n", "\n");
        }
      } catch { }
      return c;
    }

    public string T(string key) {
      string v;
      return strings.TryGetValue(key, out v) ? v : key;
    }
  }

  class TrayApp : ApplicationContext {
    const int RestartCode = 75;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const string ValueName = "Aivin";

    static readonly string CredsFile = Path.Combine(Program.Home, "device-credentials.json");
    static readonly string LockFile = Path.Combine(Program.Home, "remote-daemon.lock");
    static readonly string PausedFile = Path.Combine(Program.Home, "remote-paused");
    static readonly string ShowFile = Path.Combine(Program.Home, "mascot-show");
    static readonly string MascotFile = Path.Combine(Program.Home, "mascot.json");
    static readonly string CfgFile = Path.Combine(Program.Home, "desktop", "launch.cfg");
    static readonly string LogoFile = Path.Combine(Program.Home, "desktop", "logo.png");
    static readonly string StateFile = Path.Combine(Program.Home, "desktop", "tray-state.txt");
    static readonly string LogFile = Path.Combine(Program.Home, "remote-service.log");
    static readonly object logLock = new object();

    /** Nhật ký chung với macOS / Linux: đầu ra của daemon + lúc khay chạy / thấy daemon thoát. Quá 5 MB thì đổi sang .1. */
    static void Log(string line) {
      if (line == null) return;
      lock (logLock) {
        try {
          FileInfo fi = new FileInfo(LogFile);
          if (fi.Exists && fi.Length > 5 * 1024 * 1024) {
            File.Delete(LogFile + ".1");
            File.Move(LogFile, LogFile + ".1");
          }
          File.AppendAllText(LogFile, line + "\r\n");
        } catch { }
      }
    }
    string lastWhy;

    Config cfg;
    NotifyIcon tray;
    Icon colorIcon, greyIcon, shownIcon;
    ToolStripMenuItem status, open, pause, startup, quit;
    System.Windows.Forms.Timer timer;
    Control invoker;
    EventWaitHandle openEvent, quitEvent;
    Process child;
    DateTime childStarted;
    DateTime nextStart = DateTime.MinValue;
    int delay = 10;
    int fast = 0;
    bool pairing = false;
    bool wasPaired;
    bool quitting = false;
    Form pairForm;

    public TrayApp(string id, bool interactive, bool hint) {
      invoker = new Control();
      invoker.CreateControl();
      cfg = Config.Load(CfgFile);
      LoadIcons();

      ContextMenuStrip menu = new ContextMenuStrip();
      status = new ToolStripMenuItem();
      status.Enabled = false;
      open = Item("", delegate { OpenAivin(); });
      open.Font = new Font(open.Font, FontStyle.Bold);
      pause = Item("", delegate { TogglePause(); });
      startup = Item(cfg.T("startup"), delegate { SetStartup(!StartupEnabled()); Refresh(); });
      ToolStripMenuItem folder = Item(cfg.T("folder"), delegate { Run("explorer.exe", Quote(Program.Home)); });
      quit = Item(cfg.T("quit"), delegate { Quit(); });
      menu.Items.AddRange(new ToolStripItem[] { status, new ToolStripSeparator(), open, pause, startup, folder, new ToolStripSeparator(), quit });
      menu.Opening += delegate { Refresh(); };

      tray = new NotifyIcon();
      tray.ContextMenuStrip = menu;
      tray.Text = "AIVIN Bot CLI";
      tray.Icon = shownIcon = greyIcon;
      tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenAivin(); };
      tray.Visible = true;

      openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AivinTrayOpen-" + id);
      quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AivinTrayQuit-" + id);
      ThreadPool.RegisterWaitForSingleObject(openEvent, delegate { UI(OpenAivin); }, null, -1, false);
      ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate { UI(Quit); }, null, -1, false);

      timer = new System.Windows.Forms.Timer();
      timer.Interval = 2000;
      timer.Tick += delegate { Tick(); };
      timer.Start();

      wasPaired = File.Exists(CredsFile);
      Tick();
      if (interactive) {
        if (wasPaired) Balloon(cfg.T("firstRun"), ToolTipIcon.Info);
        OpenAivin();
      } else if (hint) {
        // Vừa cài: chỉ báo ở khay, không bật hộp nhập mã (bộ cài có thể đang ghép máy bằng mã ở cửa sổ của nó).
        Balloon(cfg.T(wasPaired ? "firstRun" : "connectHint"), ToolTipIcon.Info);
      }
    }

    ToolStripMenuItem Item(string text, EventHandler onClick) {
      ToolStripMenuItem item = new ToolStripMenuItem(text);
      item.Click += onClick;
      return item;
    }

    void UI(Action action) {
      try { invoker.BeginInvoke(action); } catch { }
    }

    void Balloon(string text, ToolTipIcon icon) {
      try { tray.ShowBalloonTip(6000, "AIVIN Bot CLI", text, icon); } catch { }
    }

    // --- Trình giữ chạy --------------------------------------------------------------------------------------------------------------

    void Tick() {
      if (quitting) return;
      if (child != null && child.HasExited) OnChildExit();
      bool paired = File.Exists(CredsFile);
      if (paired && !wasPaired) Balloon(cfg.T("connected"), ToolTipIcon.Info);
      wasPaired = paired;
      if (child == null && paired && DateTime.Now >= nextStart && LockHolder() == 0) StartChild(null);
      Refresh();
    }

    void StartChild(string code) {
      cfg = Config.Load(CfgFile);
      if (string.IsNullOrEmpty(cfg.Exe)) return;
      List<string> args = new List<string>(cfg.Args);
      if (code != null) { args.Add("--code"); args.Add(code); }
      StringBuilder line = new StringBuilder();
      foreach (string a in args) { if (line.Length > 0) line.Append(' '); line.Append(Quote(a)); }
      ProcessStartInfo psi = new ProcessStartInfo(cfg.Exe, line.ToString());
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      psi.EnvironmentVariables["AIVIN_SUPERVISOR"] = "tray";
      psi.RedirectStandardOutput = true;
      psi.RedirectStandardError = true;
      psi.StandardOutputEncoding = Encoding.UTF8;
      psi.StandardErrorEncoding = Encoding.UTF8;
      try {
        child = Process.Start(psi);
        child.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
        child.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { Log(e.Data); };
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
        childStarted = DateTime.Now;
        pairing = code != null;
        Log(DateTime.Now.ToString("s") + " [tray] started listener (pid " + child.Id + (code != null ? ", connecting with a code" : "") + ")");
      } catch (Exception e) {
        Log(DateTime.Now.ToString("s") + " [tray] could not start the listener: " + e.Message);
        child = null;
        Backoff();
      }
    }

    void Backoff() {
      nextStart = DateTime.Now.AddSeconds(delay);
      delay = Math.Min(delay * 2, 300);
    }

    void OnChildExit() {
      int rc;
      try { rc = child.ExitCode; } catch { rc = 1; }
      double secs = (DateTime.Now - childStarted).TotalSeconds;
      try { child.WaitForExit(); } catch { }
      Log(DateTime.Now.ToString("s") + " [tray] listener exited with code " + rc + " after " + (int)secs + " s");
      child.Dispose();
      child = null;
      bool wasPairing = pairing;
      pairing = false;
      if (wasPairing && !File.Exists(CredsFile)) {
        Balloon(cfg.T("pairFailed"), ToolTipIcon.Warning);
        return;
      }
      if (rc != 0 && rc != RestartCode && RollBack(secs)) rc = RestartCode;
      // 0 = dừng có chủ đích (thu hồi, đã có cửa sổ khác nhận việc) → chỉ chạy lại khi vẫn còn ghép máy và không ai giữ khoá.
      if (rc == 0) { nextStart = DateTime.Now.AddSeconds(60); return; }
      if (rc == RestartCode) { nextStart = DateTime.Now.AddSeconds(1); return; }
      if (secs > 300) delay = 10;
      Backoff();
    }

    /** Bản mới (còn chờ xác nhận, có .prev) sập trong 30 s, 3 lần liền → trả bản trước về, ghi phiên bản hỏng cho daemon bỏ qua. */
    bool RollBack(double secs) {
      string exe = cfg.Exe;
      if (string.IsNullOrEmpty(cfg.Pending) || string.IsNullOrEmpty(cfg.Rollback) || string.IsNullOrEmpty(exe)) return false;
      if (secs < 30 && File.Exists(cfg.Pending) && File.Exists(exe + ".prev")) fast++;
      else { fast = 0; return false; }
      if (fast < 3) return false;
      fast = 0;
      try {
        string[] lines = File.ReadAllLines(cfg.Pending);
        string ver = lines.Length > 0 ? lines[0].Trim() : "";
        File.Move(exe, exe + "-" + DateTime.Now.Ticks + ".trash");
        File.Move(exe + ".prev", exe);
        File.WriteAllText(cfg.Rollback, ver + "\r\n");
        File.Delete(cfg.Pending);
      } catch { }
      return true;
    }

    /** PID đang giữ khoá daemon (remote-daemon.lock, xem daemonLock.mjs) — 0 nếu không ai giữ / khoá cũ. */
    static int LockHolder() {
      try {
        string s = File.ReadAllText(LockFile);
        Match m = Regex.Match(s, "\"pid\"\\s*:\\s*(\\d+)");
        if (!m.Success) return 0;
        int pid = int.Parse(m.Groups[1].Value);
        Match b = Regex.Match(s, "\"beat_at\"\\s*:\\s*\"([^\"]+)\"");
        DateTime at;
        if (b.Success && DateTime.TryParse(b.Groups[1].Value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out at)
            && (DateTime.UtcNow - at.ToUniversalTime()).TotalSeconds > 90) return 0;
        using (Process p = Process.GetProcessById(pid)) return pid;
      } catch {
        return 0;
      }
    }

    bool Running() {
      return (child != null && !child.HasExited) || LockHolder() != 0;
    }

    void KillChild() {
      Process c = child;
      child = null;
      if (c == null) return;
      try {
        if (!c.HasExited) {
          ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe", "/PID " + c.Id + " /T /F");
          psi.UseShellExecute = false;
          psi.CreateNoWindow = true;
          using (Process k = Process.Start(psi)) k.WaitForExit(5000);
          if (!c.HasExited) c.Kill();
        }
      } catch { }
      c.Dispose();
    }

    // --- Menu -------------------------------------------------------------------------------------------------------------------------

    void Refresh() {
      bool paired = File.Exists(CredsFile);
      bool paused = File.Exists(PausedFile);
      bool running = Running();
      string state = !paired ? cfg.T(pairing ? "connecting" : "notPaired")
        : !running ? cfg.T("stopped") : paused ? cfg.T("paused") : cfg.T("running");
      status.Text = state;
      string tip = "Aivin - " + state;
      tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
      Icon want = paired && running && !paused ? colorIcon : greyIcon;
      if (want != shownIcon) { tray.Icon = want; shownIcon = want; }
      // Ghi trạng thái khi đổi — để chẩn đoán (biểu tượng xám vì sao) mà không phải mở khay.
      string why = "paired=" + paired + " running=" + running + " child=" + (child != null) + " lock=" + LockHolder() + " paused=" + paused;
      if (why != lastWhy) {
        lastWhy = why;
        try { File.AppendAllText(StateFile, DateTime.Now.ToString("s") + " " + (want == colorIcon ? "color" : "grey") + " " + why + "\r\n"); } catch { }
      }
      open.Text = cfg.T(paired ? "open" : "connect");
      pause.Text = cfg.T(paused ? "resume" : "pause");
      pause.Visible = paired;
      startup.Checked = StartupEnabled();
    }

    /** Mở Aivin: chưa ghép máy → hỏi mã; có rồi → bật + hiện linh vật (như "aivin ui"), chạy daemon ngay nếu đang không chạy. */
    void OpenAivin() {
      if (quitting) return;
      if (!File.Exists(CredsFile)) { ShowPair(); return; }
      try {
        if (File.Exists(MascotFile)) {
          string s = File.ReadAllText(MascotFile);
          string t = Regex.Replace(s, "\"enabled\"\\s*:\\s*false", "\"enabled\": true");
          if (t != s) File.WriteAllText(MascotFile, t);
        }
        long ms = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        File.WriteAllText(ShowFile, ms.ToString(CultureInfo.InvariantCulture));
      } catch { }
      if (child == null && LockHolder() == 0) {
        nextStart = DateTime.MinValue;
        delay = 10;
        Tick();
      }
    }

    void TogglePause() {
      try {
        if (File.Exists(PausedFile)) File.Delete(PausedFile);
        else File.WriteAllText(PausedFile, DateTime.UtcNow.ToString("o"));
      } catch { }
      Refresh();
    }

    void ShowPair() {
      if (pairForm != null) { pairForm.Activate(); return; }
      Form f = new Form();
      f.Text = "AIVIN Bot CLI";
      f.Icon = colorIcon;
      f.Font = SystemFonts.MessageBoxFont;
      f.AutoScaleDimensions = new SizeF(96F, 96F);
      f.AutoScaleMode = AutoScaleMode.Dpi;
      f.FormBorderStyle = FormBorderStyle.FixedDialog;
      f.MaximizeBox = false;
      f.MinimizeBox = false;
      f.StartPosition = FormStartPosition.CenterScreen;
      f.TopMost = true;
      f.ClientSize = new Size(420, 170);
      Label label = new Label();
      label.Text = cfg.T("pairPrompt");
      label.SetBounds(16, 14, 388, 64);
      TextBox box = new TextBox();
      box.SetBounds(16, 84, 388, 24);
      box.CharacterCasing = CharacterCasing.Upper;
      Button ok = new Button();
      ok.Text = cfg.T("pairOk");
      ok.SetBounds(218, 126, 90, 30);
      ok.DialogResult = DialogResult.OK;
      Button cancel = new Button();
      cancel.Text = cfg.T("pairCancel");
      cancel.SetBounds(314, 126, 90, 30);
      cancel.DialogResult = DialogResult.Cancel;
      f.Controls.AddRange(new Control[] { label, box, ok, cancel });
      f.AcceptButton = ok;
      f.CancelButton = cancel;
      pairForm = f;
      DialogResult r = f.ShowDialog();
      string code = box.Text.Trim();
      pairForm = null;
      f.Dispose();
      if (r != DialogResult.OK || code.Length == 0 || quitting) return;
      KillChild();
      StartChild(code);
      Refresh();
    }

    void Quit() {
      if (quitting) return;
      quitting = true;
      timer.Stop();
      if (pairForm != null) pairForm.Close();
      KillChild();
      tray.Visible = false;
      tray.Dispose();
      ExitThread();
    }

    // --- Khởi động cùng Windows: cùng chỗ Task Manager → Startup apps bật / tắt --------------------------------------------------------

    static bool StartupEnabled() {
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey)) {
          if (k == null || k.GetValue(ValueName) == null) return false;
        }
        using (RegistryKey a = Registry.CurrentUser.OpenSubKey(ApprovedKey)) {
          byte[] b = a == null ? null : a.GetValue(ValueName) as byte[];
          return b == null || b.Length == 0 || (b[0] & 1) == 0;
        }
      } catch {
        return false;
      }
    }

    static void SetStartup(bool on) {
      try {
        if (on) {
          using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey)) k.SetValue(ValueName, Quote(Application.ExecutablePath) + " --autostart");
        }
        byte[] data = new byte[12];
        data[0] = (byte)(on ? 2 : 3);
        if (!on) Array.Copy(BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc()), 0, data, 4, 8);
        using (RegistryKey a = Registry.CurrentUser.CreateSubKey(ApprovedKey)) a.SetValue(ValueName, data, RegistryValueKind.Binary);
      } catch { }
    }

    // --- Tiện ích ---------------------------------------------------------------------------------------------------------------------

    static void Run(string file, string args) {
      try { Process.Start(file, args); } catch { }
    }

    /** Một đối số dòng lệnh Windows (quy tắc CommandLineToArgvW). */
    static string Quote(string a) {
      if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
      StringBuilder sb = new StringBuilder("\"");
      int slashes = 0;
      foreach (char ch in a) {
        if (ch == '\\') { slashes++; continue; }
        if (ch == '"') sb.Append('\\', slashes * 2 + 1);
        else sb.Append('\\', slashes);
        slashes = 0;
        sb.Append(ch);
      }
      sb.Append('\\', slashes * 2);
      sb.Append('"');
      return sb.ToString();
    }

    void LoadIcons() {
      Bitmap src = null;
      try { src = new Bitmap(LogoFile); } catch { }
      if (src == null) {
        try { src = Icon.ExtractAssociatedIcon(Application.ExecutablePath).ToBitmap(); } catch { }
      }
      Size size = SystemInformation.SmallIconSize;
      colorIcon = MakeIcon(src, size, false);
      greyIcon = MakeIcon(src, size, true);
    }

    static Icon MakeIcon(Bitmap src, Size size, bool grey) {
      if (src == null) return SystemIcons.Application;
      Bitmap bmp = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(bmp)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        ImageAttributes attr = new ImageAttributes();
        if (grey) {
          attr.SetColorMatrix(new ColorMatrix(new float[][] {
            new float[] { 0.3f, 0.3f, 0.3f, 0, 0 },
            new float[] { 0.59f, 0.59f, 0.59f, 0, 0 },
            new float[] { 0.11f, 0.11f, 0.11f, 0, 0 },
            new float[] { 0, 0, 0, 0.7f, 0 },
            new float[] { 0, 0, 0, 0, 1 },
          }));
        }
        g.DrawImage(src, new Rectangle(0, 0, size.Width, size.Height), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, attr);
      }
      return Icon.FromHandle(bmp.GetHicon());
    }
  }
}
`;
