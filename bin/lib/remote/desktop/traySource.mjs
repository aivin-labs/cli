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
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("AIVIN Bot")]
[assembly: AssemblyDescription("Aivin - lets your Aivin agents work on this computer")]
[assembly: AssemblyCompany("Aivin Labs")]
[assembly: AssemblyProduct("AIVIN Bot")]
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
      // "Mở bằng AIVIN Bot" (Explorer / Open with): chuyển cho aivin open, không đụng tới khay đang chạy.
      int openAt = Array.IndexOf(args, "--open");
      if (openAt >= 0) return OpenFiles(args, openAt + 1);
      string id = ((uint)Home.ToLowerInvariant().GetHashCode()).ToString("x8");
      // "Gửi cho AIVIN Bot" (chuột phải / Send to): ghi yêu cầu cho daemon rồi mở Aivin (khay đang chạy thì báo nó, chưa thì mở khay).
      if (Array.IndexOf(args, "--uninstall") >= 0) return Uninstall();
      int shareAt = Array.IndexOf(args, "--share");
      if (shareAt >= 0) return SendRequest(args, shareAt + 1, id, ".txt");
      int workAt = Array.IndexOf(args, "--workdir");
      if (workAt >= 0) return SendRequest(args, workAt + 1, id, ".workdir");
      bool autostart = Array.IndexOf(args, "--autostart") >= 0;
      bool installed = Array.IndexOf(args, "--installed") >= 0;
      bool openPlatform = Array.IndexOf(args, "--platform") >= 0;
      bool quit = Array.IndexOf(args, "--quit") >= 0;
      bool created;
      using (EventWaitHandle platformLaunch = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AivinTrayPlatform-" + id)) {
      using (Mutex mutex = new Mutex(true, "Local\\AivinTray-" + id, out created)) {
        if (!created) {
          // Double-click Aivin.exe / Start menu mở platform; lệnh nội bộ vẫn chỉ đánh thức linh vật.
          if (quit) Signal("Local\\AivinTrayQuit-" + id);
          else if (openPlatform) {
            TrayApp.OpenPlatformNow();
            Signal("Local\\AivinTrayOpen-" + id);
          }
          else if (args.Length == 0) platformLaunch.Set();
          else if (!autostart && !installed) Signal("Local\\AivinTrayOpen-" + id);
          return 0;
        }
        if (quit) return 0;
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayApp(id, !autostart && (!installed || openPlatform), installed));
        GC.KeepAlive(mutex);
      }
      }
      // Sau khi nhả mutex: mở trước đó thì bản mới gặp mutex, thoát im lặng.
      if (Relaunch) try { Process.Start(Application.ExecutablePath, "--autostart"); } catch { }
      return 0;
    }

    /** Aivin.exe đã được thay (TrayApp.SwapIfExeReplaced): thoát xong mở lại từ tệp mới. */
    internal static bool Relaunch;

    /**
     * Chạy ẩn "<lệnh aivin> open <tệp>..." — lệnh aivin lấy từ launch.cfg (phần đứng trước "remote start"; bản npm là node + cli.mjs),
     * nên tự đi theo đường dẫn mới sau khi CLI cập nhật. Không chờ: tải lên + mở trình duyệt là việc của aivin open.
     */
    static int OpenFiles(string[] args, int from) {
      Config cfg = Config.Load(Path.Combine(Path.Combine(Home, "desktop"), "launch.cfg"));
      if (from >= args.Length) return 1;
      if (string.IsNullOrEmpty(cfg.Exe)) {
        MessageBox.Show("The launch configuration is missing. Run aivin desktop install to repair AIVIN Office Suite.", "AIVIN Office Suite", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
      }
      StringBuilder line = new StringBuilder();
      foreach (string a in cfg.Args) {
        if (a == "remote") break;
        line.Append(TrayApp.Quote(a)).Append(' ');
      }
      line.Append("open");
      for (int i = from; i < args.Length; i++) line.Append(' ').Append(TrayApp.Quote(args[i]));
      ProcessStartInfo psi = new ProcessStartInfo(cfg.Exe, line.ToString());
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      psi.EnvironmentVariables["AIVIN_OPEN_UI"] = "toast";
      try { Process.Start(psi); return 0; }
      catch (Exception ex) {
        MessageBox.Show("AIVIN Office Suite could not start the file handler.\n\n" + ex.Message, "AIVIN Office Suite", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
      }
    }

    /**
     * "Gửi cho AIVIN Bot" (đuôi .txt) / "Làm việc ở đây với AIVIN Bot" (đuôi .workdir): mỗi lần gọi một tệp yêu cầu riêng trong mascot-attach
     * (mỗi dòng một đường dẫn; ghi .tmp rồi đổi tên để daemon không đọc dở) — Explorer chạy một Aivin.exe cho mỗi mục được chọn.
     * Daemon (mascot/index.mjs) đọc, xoá, rồi mở ô hỏi.
     */
    static int SendRequest(string[] args, int from, string id, string ext) {
      List<string> paths = new List<string>();
      for (int i = from; i < args.Length; i++) {
        // Gốc ổ: Explorer đưa "C:\" trong ngoặc kép, dấu \" bị hiểu là ngoặc thoát → nhận được C:" (và GetFullPath("C:") là thư mục hiện tại của ổ).
        string p = args[i].Trim().Trim('"');
        if (p.Length == 0) continue;
        if (p.Length == 2 && p[1] == ':') p += "\\";
        try { p = Path.GetFullPath(p); } catch { }
        paths.Add(p);
      }
      if (paths.Count == 0) return 1;
      try {
        string dir = Path.Combine(Home, "mascot-attach");
        Directory.CreateDirectory(dir);
        string name = DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture) + "-" + Process.GetCurrentProcess().Id + ext;
        string file = Path.Combine(dir, name);
        File.WriteAllText(file + ".tmp", string.Join("\r\n", paths.ToArray()), new UTF8Encoding(false));
        File.Move(file + ".tmp", file);
      } catch { return 1; }
      bool running = false;
      try { using (Mutex m = Mutex.OpenExisting("Local\\AivinTray-" + id)) running = true; } catch { }
      if (running) Signal("Local\\AivinTrayOpen-" + id);
      else try { Process.Start(Application.ExecutablePath); } catch { }
      return 0;
    }

    /**
     * Programs & Features / Settings → Apps: hỏi chủ máy rồi chạy ẩn "<lệnh aivin> uninstall --yes" và thoát ngay — Aivin.exe đang chạy thì lệnh đó không xoá được tệp này.
     * launch.cfg thiếu chữ (bản cũ, chưa kịp làm mới) → tiếng Anh; thiếu lệnh aivin → thử bin\aivin.exe cạnh tệp này.
     */
    static int Uninstall() {
      Config cfg = Config.Load(Path.Combine(Path.Combine(Home, "desktop"), "launch.cfg"));
      string prompt = cfg.T("uninstallPrompt");
      if (prompt == "uninstallPrompt") prompt = "Remove AIVIN Bot from this computer?\n\nThe app, the aivin command and this computer's connection to your account will be removed.\nAlso delete your data (the bot's memory, file copies kept for undo, browser sign-ins)? This cannot be undone.\n\nYes = remove and delete data\nNo = remove, keep data\nCancel = do not remove";
      DialogResult choice = MessageBox.Show(prompt, "AIVIN Bot", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
      if (choice == DialogResult.Cancel) return 1;
      string exe = cfg.Exe;
      StringBuilder line = new StringBuilder();
      foreach (string a in cfg.Args) {
        if (a == "remote") break;
        line.Append(TrayApp.Quote(a)).Append(' ');
      }
      if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) {
        exe = Path.Combine(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "bin"), "aivin.exe");
        line.Length = 0;
      }
      line.Append("uninstall --yes");
      if (choice == DialogResult.Yes) line.Append(" --delete-data");
      ProcessStartInfo psi = new ProcessStartInfo(exe, line.ToString());
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      psi.EnvironmentVariables["AIVIN_OPEN_UI"] = "toast";
      try { Process.Start(psi); return 0; } catch {
        string failed = cfg.T("uninstallFailed");
        MessageBox.Show(failed == "uninstallFailed" ? "Could not remove it automatically. Open a terminal and run: aivin uninstall" : failed, "AIVIN Bot", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
      }
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
    public string Version = "";
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
          else if (k == "version") c.Version = v;
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

  class ModernMenuRenderer : ToolStripProfessionalRenderer {
    static readonly Color ClrBorder = Color.FromArgb(229, 230, 235);
    static readonly Color ClrHover = Color.FromArgb(242, 243, 245);
    static readonly Color ClrText = Color.FromArgb(29, 33, 41);
    static readonly Color ClrMuted = Color.FromArgb(134, 144, 156);
    static readonly Color ClrGreen = Color.FromArgb(0, 180, 42);
    static readonly Color ClrOrange = Color.FromArgb(255, 125, 0);

    public ModernMenuRenderer() : base(new ModernColorTable()) { }

    static void FillRoundedRectangle(Graphics g, Brush b, Rectangle r, int radius) {
      using (System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath()) {
        int d = radius * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.FillPath(b, path);
      }
    }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
      if (e.Item.Selected && e.Item.Enabled) {
        int width = Math.Min(e.Item.Width, e.ToolStrip.ClientSize.Width - e.Item.Bounds.Left);
        Rectangle rc = new Rectangle(4, 1, width - 8, e.Item.Height - 2);
        using (SolidBrush b = new SolidBrush(ClrHover)) {
          FillRoundedRectangle(e.Graphics, b, rc, 6);
        }
      }
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
      Color textColor = !e.Item.Enabled ? ClrMuted : ClrText;
      int left = Math.Max(16, e.Item.Padding.Left);

      // Phím tắt bên cạnh mục menu: WinForms vẽ riêng bằng chính hàm này, căn phải + màu nhạt.
      ToolStripMenuItem menuItem = e.Item as ToolStripMenuItem;
      if (menuItem != null && !string.IsNullOrEmpty(menuItem.ShortcutKeyDisplayString) && e.Text == menuItem.ShortcutKeyDisplayString) {
        int visible = Math.Min(e.Item.Width, e.ToolStrip.ClientSize.Width - e.Item.Bounds.Left);
        Rectangle keyRect = new Rectangle(0, 0, Math.Max(0, visible - 16), e.Item.Height);
        TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, keyRect, ClrMuted, TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        return;
      }

      if (e.Text != null && e.Text.Length > 0 && (e.Text[0] == '●' || e.Text[0] == '•' || e.Text[0] == '\u25CF' || e.Text[0] == '\u2022')) {
        string remainingText = e.Text.Substring(1).TrimStart(' ');
        string lower = remainingText.ToLowerInvariant();
        Color dotColor = ClrMuted;
        if (lower.Contains("chạy") || lower.Contains("running") || lower.Contains("sẵn sàng")) {
          dotColor = ClrGreen;
        } else if (lower.Contains("tạm dừng") || lower.Contains("paused")) {
          dotColor = ClrOrange;
        }

        int dotSize = 8;
        int dotY = (e.Item.Height - dotSize) / 2;
        SmoothingMode oldMode = e.Graphics.SmoothingMode;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (SolidBrush dotBrush = new SolidBrush(dotColor)) {
          e.Graphics.FillEllipse(dotBrush, left, dotY, dotSize, dotSize);
        }
        e.Graphics.SmoothingMode = oldMode;

        int textLeft = left + dotSize + 7;
        Rectangle rect = new Rectangle(
          textLeft,
          0,
          Math.Max(0, e.Item.Width - textLeft - 16),
          e.Item.Height
        );
        TextFormatFlags flags = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix;
        TextRenderer.DrawText(e.Graphics, remainingText, e.TextFont, rect, textColor, flags);
        return;
      }

      Rectangle r = new Rectangle(
        left,
        0,
        Math.Max(0, e.Item.Width - left - 16),
        e.Item.Height
      );
      TextFormatFlags f = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix;
      TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, r, textColor, f);
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
      using (Pen p = new Pen(ClrBorder)) {
        int y = e.Item.Height / 2;
        e.Graphics.DrawLine(p, 16, y, e.Item.Width - 16, y);
      }
    }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) {
      using (Pen p = new Pen(ClrBorder)) {
        e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
      }
    }
  }

  class ModernColorTable : ProfessionalColorTable {
    public override Color ToolStripDropDownBackground { get { return Color.White; } }
    public override Color ImageMarginGradientBegin { get { return Color.White; } }
    public override Color ImageMarginGradientMiddle { get { return Color.White; } }
    public override Color ImageMarginGradientEnd { get { return Color.White; } }
    public override Color MenuBorder { get { return Color.FromArgb(229, 230, 235); } }
    public override Color MenuItemBorder { get { return Color.Transparent; } }
    public override Color MenuItemSelected { get { return Color.FromArgb(242, 243, 245); } }
    public override Color MenuStripGradientBegin { get { return Color.White; } }
    public override Color MenuStripGradientEnd { get { return Color.White; } }
    public override Color CheckBackground { get { return Color.Transparent; } }
    public override Color CheckSelectedBackground { get { return Color.Transparent; } }
    public override Color CheckPressedBackground { get { return Color.Transparent; } }
  }

  class TrayApp : ApplicationContext {
    const int RestartCode = 75;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const string ValueName = "Aivin";

    static readonly string CredsFile = Path.Combine(Program.Home, "device-credentials.json");
    static readonly string ServerFile = Path.Combine(Program.Home, "server.json");
    static readonly string LockFile = Path.Combine(Program.Home, "remote-daemon.lock");
    static readonly string PausedFile = Path.Combine(Program.Home, "remote-paused");
    static readonly string ShowFile = Path.Combine(Program.Home, "mascot-show");
    static readonly string HideFile = Path.Combine(Program.Home, "mascot-hide");
    static readonly string VoiceFile = Path.Combine(Program.Home, "mascot-voice");
    static readonly string HotkeysFile = Path.Combine(Program.Home, "mascot-hotkeys.json");
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
    ToolStripMenuItem status, updateItem, open, connectCodeItem, quickChat, quickVoice, pause, startup, mascot, terminal, quit, serverMenu, serverCloud, serverVn, serverLocal;
    ToolStripSeparator quickSeparator;
    System.Windows.Forms.Timer timer;
    Control invoker;
    EventWaitHandle openEvent, quitEvent;
    EventWaitHandle platformEvent;
    Process child;
    DateTime childStarted;
    DateTime nextStart = DateTime.MinValue;
    readonly DateTime exeStamp = File.GetLastWriteTimeUtc(Application.ExecutablePath);
    bool isUpdating = false;
    // Listener sập: mở lại sau 2 s, rồi gấp đôi (tối đa 5 phút) nếu sập liên tục.
    const int FirstDelay = 2;
    int delay = FirstDelay;
    int fast = 0;
    bool pairing = false;
    bool browserConnectInProgress = false;
    bool rePairPromptPending = false;
    bool wasPaired;
    bool quitting = false;
    Form pairForm;

    public TrayApp(string id, bool interactive, bool hint) {
      invoker = new Control();
      invoker.CreateControl();
      cfg = Config.Load(CfgFile);
      LoadIcons();

      ContextMenuStrip menu = new ContextMenuStrip();
      menu.ShowImageMargin = false;
      menu.ShowCheckMargin = false;
      menu.BackColor = Color.White;
      menu.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
      menu.Renderer = new ModernMenuRenderer();
      menu.Padding = new Padding(2, 6, 2, 6);

      open = Item("", delegate { OpenAivin(); });
      open.Font = new Font("Segoe UI", 10.0f, FontStyle.Bold);
      open.Padding = new Padding(16, 7, 24, 7);
      connectCodeItem = Item(cfg.T("connectCode"), delegate { ShowPairWithCode(); });

      quickChat = Item(cfg.T("quickChat"), delegate { OpenAivin(); });
      quickVoice = Item(cfg.T("quickVoice"), delegate { RequestMascot(VoiceFile); });
      quickSeparator = new ToolStripSeparator();
      mascot = Item(cfg.T("mascot"), delegate { ToggleMascot(); });
      pause = Item("", delegate { TogglePause(); });
      terminal = Item(cfg.T("terminal"), delegate { OpenTerminal(); });
      serverMenu = Item(cfg.T("server"), delegate { });
      serverCloud = Item(cfg.T("serverCloud"), delegate { ChangeServer("https://api.aivin.cloud"); });
      serverVn = Item(cfg.T("serverVn"), delegate { ChangeServer("https://api.aivin.vn"); });
      serverLocal = Item(cfg.T("serverLocal"), delegate { ChangeServer("http://localhost:3001"); });
      serverMenu.DropDownItems.AddRange(new ToolStripItem[] { serverCloud, serverVn, serverLocal });
      startup = Item(cfg.T("startup"), delegate { SetStartup(!StartupEnabled()); Refresh(); });
      updateItem = Item("", delegate { CheckOrApplyUpdate(); });

      status = new ToolStripMenuItem();
      status.Enabled = false;
      status.Padding = new Padding(16, 4, 24, 4);
      status.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);

      quit = Item(cfg.T("quit"), delegate { Quit(); });

      menu.Items.AddRange(new ToolStripItem[] {
        open,
        connectCodeItem,
        mascot,
        pause,
        quickSeparator,
        quickVoice,
        quickChat,
        new ToolStripSeparator(),
        serverMenu,
        new ToolStripSeparator(),
        startup,
        updateItem,
        status,
        new ToolStripSeparator(),
        quit
      });
      menu.Opening += delegate { Refresh(); };

      tray = new NotifyIcon();
      tray.ContextMenuStrip = menu;
      tray.Text = "AIVIN Bot";
      tray.Icon = shownIcon = greyIcon;
      tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenAivin(); };
      tray.DoubleClick += delegate { OpenAivin(); };
      tray.Visible = true;

      openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AivinTrayOpen-" + id);
      quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AivinTrayQuit-" + id);
      platformEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AivinTrayPlatform-" + id);
      ThreadPool.RegisterWaitForSingleObject(openEvent, delegate { UI(OpenAivin); }, null, -1, false);
      ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate { UI(Quit); }, null, -1, false);
      ThreadPool.RegisterWaitForSingleObject(platformEvent, delegate { UI(OpenPlatform); }, null, -1, false);

      timer = new System.Windows.Forms.Timer();
      timer.Interval = 2000;
      timer.Tick += delegate { Tick(); };
      timer.Start();

      wasPaired = HasPairedServer();
      Tick();
      if (interactive) {
        if (wasPaired) Balloon(cfg.T("firstRun"), ToolTipIcon.Info);
        OpenPlatform();
      } else if (hint) {
        // Vừa cài: chỉ báo ở khay, không bật hộp nhập mã (bộ cài có thể đang ghép máy bằng mã ở cửa sổ của nó).
        Balloon(cfg.T(wasPaired ? "firstRun" : "connectHint"), ToolTipIcon.Info);
      }
    }

    ToolStripMenuItem Item(string text, EventHandler onClick) {
      ToolStripMenuItem item = new ToolStripMenuItem(text);
      item.Padding = new Padding(16, 6, 24, 6);
      item.Click += onClick;
      return item;
    }

    void UI(Action action) {
      try { invoker.BeginInvoke(action); } catch { }
    }

    // Windows 10+ lấy icon khay lúc gửi làm logo của thông báo → tạm dùng icon màu để thông báo không bị xám, gửi xong trả lại icon trạng thái.
    void Balloon(string text, ToolTipIcon icon) {
      try {
        tray.Icon = colorIcon;
        tray.ShowBalloonTip(6000, "AIVIN Bot", text, icon);
      } catch { }
      try { tray.Icon = shownIcon; } catch { }
    }

    // --- Trình giữ chạy --------------------------------------------------------------------------------------------------------------

    void Tick() {
      if (quitting) return;
      if (child != null && child.HasExited) OnChildExit();
      if (SwapIfExeReplaced()) return;
      bool paired = HasPairedServer();
      if (paired && !wasPaired) Balloon(cfg.T("connected"), ToolTipIcon.Info);
      if (!paired && wasPaired) rePairPromptPending = true;
      wasPaired = paired;
      if (child == null && paired && DateTime.Now >= nextStart && LockHolder() == 0) StartChild(null);
      Refresh();
      if (rePairPromptPending && child == null && !pairing && !browserConnectInProgress && pairForm == null && !tray.ContextMenuStrip.Visible) {
        rePairPromptPending = false;
        StartBrowserConnect();
      }
    }

    /**
     * ensureLauncher thay Aivin.exe lúc khay đang chạy thì khay này chạy từ tệp .old-*. Windows nhớ icon khay theo đường dẫn exe, nên icon có thể
     * rơi vào mục mới chưa ghim (ẩn trong mũi tên ^). Chuyển sang tệp mới khi không giữ daemon: đang giữ thì chờ daemon tự thoát (nâng bản, sập)
     * để không ngắt việc đang chạy.
     */
    bool SwapIfExeReplaced() {
      if (child != null || pairing || browserConnectInProgress || pairForm != null || isUpdating || tray.ContextMenuStrip.Visible) return false;
      try {
        string exe = Application.ExecutablePath;
        if (!File.Exists(exe) || File.GetLastWriteTimeUtc(exe) == exeStamp) return false;
      } catch { return false; }
      Log(DateTime.Now.ToString("s") + " [tray] Aivin.exe replaced, reopening from the new file");
      Program.Relaunch = true;
      Quit();
      return true;
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
      psi.EnvironmentVariables.Remove("AIVIN_BASE_URL");
      psi.EnvironmentVariables.Remove("API_KEY");
      psi.EnvironmentVariables.Remove("SDK_ENDPOINT");
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
      if (wasPairing && !HasPairedServer()) {
        Balloon(cfg.T("pairFailed"), ToolTipIcon.Warning);
        return;
      }
      if (rc != 0 && rc != RestartCode && RollBack(secs)) rc = RestartCode;
      // 0 = dừng có chủ đích (thu hồi, ghép lại, cửa sổ khác nhận việc) → Tick chỉ chạy lại khi vẫn còn ghép máy và không ai giữ khoá:
      // chờ ngắn để máy vừa ghép lại / cửa sổ cài vừa đóng có người nhận việc ngay. Thoát 0 liền nhau (hai máy dùng chung token đẩy nhau)
      // thì giãn dần như khi sập.
      if (rc == 0) {
        if (secs < 30) { Backoff(); return; }
        delay = FirstDelay;
        nextStart = DateTime.Now.AddSeconds(FirstDelay);
        return;
      }
      if (rc == RestartCode) { nextStart = DateTime.Now.AddSeconds(1); return; }
      if (secs > 300) delay = FirstDelay;
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

    void CheckOrApplyUpdate() {
      if (isUpdating) return;
      isUpdating = true;
      Balloon(cfg.T("updateUpdating"), ToolTipIcon.Info);
      Refresh();
      ThreadPool.QueueUserWorkItem(delegate {
        try {
          ProcessStartInfo psi = new ProcessStartInfo(cfg.Exe, "update");
          psi.UseShellExecute = false;
          psi.CreateNoWindow = true;
          psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
          using (Process p = Process.Start(psi)) {
            p.WaitForExit(180000);
          }
        } catch { }
        isUpdating = false;
        UI(delegate {
          Refresh();
          Balloon("AIVIN Bot: " + cfg.T("updateUpToDate"), ToolTipIcon.Info);
        });
      });
    }

    static int CompareVersions(string left, string right) {
      string a = (left ?? "").Trim().TrimStart('v', 'V').Split('-')[0].Split('+')[0];
      string b = (right ?? "").Trim().TrimStart('v', 'V').Split('-')[0].Split('+')[0];
      Version av, bv;
      if (Version.TryParse(a, out av) && Version.TryParse(b, out bv)) return av.CompareTo(bv);
      return string.Compare(left, right, StringComparison.OrdinalIgnoreCase);
    }

    void Refresh() {
      bool paired = HasPairedServer();
      bool paused = File.Exists(PausedFile);
      bool running = Running();
      string state = !paired ? cfg.T(pairing || browserConnectInProgress ? "connecting" : "notPaired")
        : !running ? cfg.T("stopped") : paused ? cfg.T("paused") : cfg.T("running");
      status.Text = "●  " + state;
      string tip = "Aivin - " + state;
      tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
      Icon want = paired && running && !paused ? colorIcon : greyIcon;
      if (want != shownIcon) { tray.Icon = want; shownIcon = want; }

      // Phiên bản hiện tại
      string ver = !string.IsNullOrEmpty(cfg.Version) ? cfg.Version : "1.0.13";
      if (!ver.StartsWith("v", StringComparison.OrdinalIgnoreCase)) ver = "v" + ver;

      // Đọc update-status.json
      string siteLatest = null;
      try {
        string updateFile = Path.Combine(Program.Home, "update-status.json");
        if (File.Exists(updateFile)) {
          string txt = File.ReadAllText(updateFile);
          Match m = Regex.Match(txt, "\"site_latest\"\\s*:\\s*\"([^\"]+)\"");
          if (m.Success) siteLatest = m.Groups[1].Value;
        }
      } catch { }

      if (isUpdating) {
        updateItem.Text = cfg.T("updateUpdating");
        updateItem.Enabled = false;
      } else if (!string.IsNullOrEmpty(siteLatest) && CompareVersions(siteLatest, ver) > 0) {
        updateItem.Text = "★  " + cfg.T("updateAvailable").Replace("{version}", siteLatest);
        updateItem.Font = new Font(updateItem.Font, FontStyle.Bold);
        updateItem.Enabled = true;
      } else if (!string.IsNullOrEmpty(siteLatest)) {
        updateItem.Text = "✓  " + cfg.T("updateUpToDate") + " (" + ver + ")";
        updateItem.Font = new Font(updateItem.Font, FontStyle.Regular);
        updateItem.Enabled = true;
      } else {
        updateItem.Text = cfg.T("updateCheckNow") + " (" + ver + ")";
        updateItem.Font = new Font(updateItem.Font, FontStyle.Regular);
        updateItem.Enabled = true;
      }

      // Ghi trạng thái khi đổi — để chẩn đoán (biểu tượng xám vì sao) mà không phải mở khay.
      string why = "paired=" + paired + " running=" + running + " child=" + (child != null) + " lock=" + LockHolder() + " paused=" + paused;
      if (why != lastWhy) {
        lastWhy = why;
        try { File.AppendAllText(StateFile, DateTime.Now.ToString("s") + " " + (want == colorIcon ? "color" : "grey") + " " + why + "\r\n"); } catch { }
      }
      string selectedServer = CurrentServerUrl();
      serverMenu.Text = cfg.T("server") + ": " + ServerName(selectedServer);
      serverCloud.Checked = selectedServer == "https://api.aivin.cloud";
      serverVn.Checked = selectedServer == "https://api.aivin.vn";
      serverLocal.Checked = selectedServer == "http://localhost:3001";
      open.Text = cfg.T(paired ? "open" : "connect");
      connectCodeItem.Visible = !paired;
      connectCodeItem.Enabled = !browserConnectInProgress;
      pause.Text = cfg.T(paused ? "resume" : "pause");
      pause.Visible = paired;
      terminal.Text = cfg.T("terminal");
      bool startupOn = StartupEnabled();
      startup.Text = (startupOn ? "✓  " : "    ") + cfg.T("startup");
      bool mascotOn = IsMascotEnabled();
      mascot.Text = (mascotOn ? "✓  " : "    ") + cfg.T("mascot");
      quickChat.Visible = quickVoice.Visible = quickSeparator.Visible = paired;
      // Chỉ hiện phím đang có tác dụng: phím do cửa sổ linh vật giữ, linh vật tắt / daemon dừng thì không còn (tệp có thể sót sau khi daemon chết).
      string hotkeys = running && mascotOn ? ReadHotkeys() : "";
      quickChat.ShortcutKeyDisplayString = HotkeyLabel(hotkeys, "chat");
      quickVoice.ShortcutKeyDisplayString = HotkeyLabel(hotkeys, "voice");
      // WinForms không tính đủ chỗ cho cột phím tắt khi menu tự vẽ chữ: tự giữ bề rộng tối thiểu để phím không bị cắt / đè lên tên mục.
      quickChat.Owner.MinimumSize = new Size(Math.Max(ShortcutRowWidth(quickChat), ShortcutRowWidth(quickVoice)), 0);
    }

    static int ShortcutRowWidth(ToolStripMenuItem item) {
      if (string.IsNullOrEmpty(item.ShortcutKeyDisplayString)) return 0;
      return item.Padding.Left + TextRenderer.MeasureText(item.Text, item.Font).Width + 32 + TextRenderer.MeasureText(item.ShortcutKeyDisplayString, item.Font).Width + 24;
    }

    static string ReadHotkeys() {
      try { return File.ReadAllText(HotkeysFile); } catch { return ""; }
    }

    static string HotkeyLabel(string json, string key) {
      Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"([^\"]+)\"");
      return m.Success ? m.Groups[1].Value : null;
    }

    bool IsMascotEnabled() {
      try {
        if (!File.Exists(MascotFile)) return true;
        string s = File.ReadAllText(MascotFile);
        return !Regex.IsMatch(s, "\"enabled\"\\s*:\\s*false");
      } catch { return true; }
    }

    /**
     * Bật / tắt "enabled" trong mascot.json mà giữ nguyên các khoá khác (vị trí, phím tắt, mức báo), ghi nguyên tử (tệp tạm + Replace):
     * daemon cũng ghi tệp này — ghi dở / đọc lúc đang ghi không được làm mất cài đặt. Tệp hỏng (không phải object JSON) → không ghi đè;
     * daemon vẫn nhận yêu cầu qua mascot-show / mascot-hide (02/11/2026).
     */
    static void SetMascotEnabled(bool on) {
      string want = on ? "true" : "false";
      string t;
      if (File.Exists(MascotFile)) {
        string s = File.ReadAllText(MascotFile);
        if (!s.TrimStart().StartsWith("{")) return;
        t = Regex.Replace(s, "\"enabled\"\\s*:\\s*(true|false)", "\"enabled\": " + want);
        if (t == s && !Regex.IsMatch(s, "\"enabled\"\\s*:")) t = new Regex("\\{").Replace(s, "{\r\n  \"enabled\": " + want + (s.Trim() == "{}" ? "" : ","), 1);
        if (t == s) return;
      } else {
        t = "{\r\n  \"enabled\": " + want + "\r\n}\r\n";
      }
      string tmp = MascotFile + ".tray.tmp";
      File.WriteAllText(tmp, t);
      try {
        if (File.Exists(MascotFile)) File.Replace(tmp, MascotFile, null);
        else File.Move(tmp, MascotFile);
      } catch {
        File.Copy(tmp, MascotFile, true);
        try { File.Delete(tmp); } catch { }
      }
    }

    void ToggleMascot() {
      bool enabled = IsMascotEnabled();
      try {
        if (enabled) {
          try { SetMascotEnabled(false); } catch { }
          long ms = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
          File.WriteAllText(HideFile, ms.ToString(CultureInfo.InvariantCulture));
        } else {
          try { SetMascotEnabled(true); } catch { }
          long ms = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
          File.WriteAllText(ShowFile, ms.ToString(CultureInfo.InvariantCulture));
        }
      } catch { }
      Refresh();
    }

    /** Mở Aivin: chưa ghép máy → hỏi mã; có rồi → hiện linh vật và ô hỏi đáp ngay trên màn hình. */
    void OpenAivin() {
      RequestMascot(ShowFile);
    }

    /** Double-click Aivin.exe: show the mascot and the platform in a browser app window. */
    void OpenPlatform() {
      if (!HasPairedServer()) { StartBrowserConnect(); return; }
      ThreadPool.QueueUserWorkItem(delegate { LaunchPlatformApp(); });
      OpenAivin();
    }

    static string PlatformUrl() {
      string api = CurrentServerUrl();
      api = CanonicalServerUrl(api);
      try {
        ServicePointManager.SecurityProtocol = ServicePointManager.SecurityProtocol | SecurityProtocolType.Tls12;
        using (WebClient client = new WebClient()) {
          client.Encoding = Encoding.UTF8;
          client.Headers[HttpRequestHeader.UserAgent] = "AIVIN Bot";
          string json = client.DownloadString(api + "/setting/lang/default");
          Match appUrl = Regex.Match(json, "\\\"app_url\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
          if (appUrl.Success) {
            string value = Regex.Unescape(appUrl.Groups[1].Value);
            Uri uri;
            if (Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps) return uri.ToString().TrimEnd('/');
          }
        }
      } catch { }
      if (api == "https://api.aivin.vn") return "https://app.aivin.vn";
      if (api == "https://api.aivin.cloud") return "https://brain.aivin.cloud";
      return "https://brain.aivin.cloud";
    }

    static string BrowserPath(string browser) {
      string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
      string pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? "C:\\Program Files";
      string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
      string[] candidates;
      if (browser == "edge") candidates = new string[] {
        Path.Combine(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
        Path.Combine(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
        Path.Combine(local, "Microsoft\\Edge\\Application\\msedge.exe")
      };
      else candidates = new string[] {
        Path.Combine(pf, "Google\\Chrome\\Application\\chrome.exe"),
        Path.Combine(pf86, "Google\\Chrome\\Application\\chrome.exe"),
        Path.Combine(local, "Google\\Chrome\\Application\\chrome.exe")
      };
      foreach (string candidate in candidates) if (File.Exists(candidate)) return candidate;
      return null;
    }

    static void LaunchPlatformApp() {
      string url = PlatformUrl();
      try {
        string progId = "";
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice")) {
          if (key != null) progId = Convert.ToString(key.GetValue("ProgId")) ?? "";
        }
        string browser = progId.IndexOf("edge", StringComparison.OrdinalIgnoreCase) >= 0 ? "edge" :
          progId.IndexOf("chrome", StringComparison.OrdinalIgnoreCase) >= 0 ? "chrome" : "";
        string exe = browser.Length > 0 ? BrowserPath(browser) : null;
        // Unknown default browsers keep their own profile/session via the normal URL handler.
        if (exe == null && progId.Length == 0) exe = BrowserPath("edge") ?? BrowserPath("chrome");
        if (exe != null) {
          ProcessStartInfo app = new ProcessStartInfo(exe, "--app=\"" + url + "\" --start-maximized");
          app.UseShellExecute = false;
          IntPtr before = GetForegroundWindow();
          Process.Start(app);
          MaximizeLaunchedBrowser(exe, before);
          return;
        }
      } catch { }
      try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    static void MaximizeLaunchedBrowser(string exe, IntPtr previousWindow) {
      string expectedProcess = Path.GetFileNameWithoutExtension(exe);
      for (int i = 0; i < 30; i++) {
        IntPtr window = GetForegroundWindow();
        if (window != IntPtr.Zero && window != previousWindow) {
          uint processId;
          GetWindowThreadProcessId(window, out processId);
          try {
            using (Process owner = Process.GetProcessById((int)processId)) {
              if (string.Equals(owner.ProcessName, expectedProcess, StringComparison.OrdinalIgnoreCase)) {
                ShowWindowAsync(window, 3); // SW_MAXIMIZE
                return;
              }
            }
          } catch { }
        }
        Thread.Sleep(100);
      }
    }

    internal static void OpenPlatformNow() { LaunchPlatformApp(); }

    /** Gửi yêu cầu cho daemon qua tệp đánh dấu (mascot-show = mở ô hỏi, mascot-voice = nói chuyện); daemon đang dừng thì chạy lại để nó nhận. */
    void RequestMascot(string requestFile) {
      if (quitting) return;
      if (!HasPairedServer()) { StartBrowserConnect(); return; }
      try {
        try { SetMascotEnabled(true); } catch { }
        long ms = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        File.WriteAllText(requestFile, ms.ToString(CultureInfo.InvariantCulture));
      } catch { }

      if (child == null && LockHolder() == 0) {
        nextStart = DateTime.MinValue;
        delay = FirstDelay;
        Tick();
      }
      Refresh();
    }

    static string CurrentServerUrl() {
      try {
        if (File.Exists(ServerFile)) {
          Match selected = Regex.Match(File.ReadAllText(ServerFile), "\"server_url\"\\s*:\\s*\"([^\"]+)\"");
          if (selected.Success) {
            string saved = selected.Groups[1].Value.TrimEnd('/');
            string canonical = CanonicalServerUrl(saved);
            if (!string.Equals(saved, canonical, StringComparison.OrdinalIgnoreCase)) {
              try {
                string tmp = ServerFile + ".tmp";
                File.WriteAllText(tmp, "{\"server_url\":\"" + canonical + "\"}\r\n", new UTF8Encoding(false));
                if (File.Exists(ServerFile)) File.Replace(tmp, ServerFile, null); else File.Move(tmp, ServerFile);
              } catch { }
            }
            return canonical;
          }
        }
        if (File.Exists(CredsFile)) {
          Match legacy = Regex.Match(File.ReadAllText(CredsFile), "\"server_url\"\\s*:\\s*\"([^\"]+)\"");
          if (legacy.Success) return CanonicalServerUrl(legacy.Groups[1].Value.TrimEnd('/'));
        }
      } catch { }
      return "https://api.aivin.cloud";
    }

    static string CanonicalServerUrl(string url) {
      if (string.Equals(url, "https://beta-api.aivin.vn", StringComparison.OrdinalIgnoreCase)) return "https://api.aivin.vn";
      if (string.Equals(url, "https://beta-api.aivin.cloud", StringComparison.OrdinalIgnoreCase)) return "https://api.aivin.cloud";
      return url;
    }

    static bool HasPairedServer() {
      try {
        if (!File.Exists(CredsFile)) return false;
        string url = CurrentServerUrl();
        string json = File.ReadAllText(CredsFile);
        foreach (Match m in Regex.Matches(json, "\"server_url\"\\s*:\\s*\"([^\"]+)\""))
          if (string.Equals(CanonicalServerUrl(m.Groups[1].Value.TrimEnd('/')), url, StringComparison.OrdinalIgnoreCase)) return true;
      } catch { }
      return false;
    }

    static string ServerName(string url) {
      if (url == "https://api.aivin.cloud") return "Cloud";
      if (url == "https://api.aivin.vn") return "VN";
      if (url.StartsWith("http://localhost:", StringComparison.OrdinalIgnoreCase)) return "Local";
      return url;
    }

    void ChangeServer(string url) {
      string current = CurrentServerUrl();
      if (string.Equals(current, url, StringComparison.OrdinalIgnoreCase)) return;
      int holder = LockHolder();
      if ((child != null || holder > 0) && MessageBox.Show(
          cfg.T("serverConfirm").Replace("{server}", ServerName(url)), "AIVIN Bot",
          MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
      try {
        string tmp = ServerFile + ".tmp";
        File.WriteAllText(tmp, "{\"server_url\":\"" + url + "\"}\r\n", new UTF8Encoding(false));
        if (File.Exists(ServerFile)) File.Replace(tmp, ServerFile, null); else File.Move(tmp, ServerFile);
      } catch (Exception e) {
        Balloon("Could not change server: " + e.Message, ToolTipIcon.Error);
        return;
      }
      try {
        if (child != null) {
          child.Kill();
          child.WaitForExit(5000);
          if (child.HasExited) OnChildExit();
        } else if (holder > 0) {
          using (Process p = Process.GetProcessById(holder)) p.Kill();
        }
      } catch { }
      nextStart = DateTime.MinValue;
      delay = FirstDelay;
      Refresh();
      if (!HasPairedServer()) StartBrowserConnect();
      else Tick();
    }

    void OpenTerminal() {
      try {
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string workDir = !string.IsNullOrEmpty(userProfile) && Directory.Exists(userProfile) ? userProfile : Program.Home;
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = true;

        try {
          psi.FileName = "wt.exe";
          Process.Start(psi);
          return;
        } catch { }

        try {
          psi.FileName = "powershell.exe";
          Process.Start(psi);
          return;
        } catch { }

        psi.FileName = "cmd.exe";
        Process.Start(psi);
      } catch { }
    }

    void TogglePause() {
      try {
        if (File.Exists(PausedFile)) File.Delete(PausedFile);
        else File.WriteAllText(PausedFile, DateTime.UtcNow.ToString("o"));
      } catch { }
      Refresh();
    }

    void StartBrowserConnect() {
      if (browserConnectInProgress) return;
      browserConnectInProgress = true;
      rePairPromptPending = false;
      Refresh();
      Balloon(cfg.T("connectBrowserHint"), ToolTipIcon.Info);
      ThreadPool.QueueUserWorkItem(delegate {
        int loginResult = RunCliAndWait("login");
        if (quitting) return;
        if (loginResult != 0) {
          UI(delegate {
            if (quitting) return;
            browserConnectInProgress = false;
            Refresh();
            Balloon(cfg.T("connectFailed"), ToolTipIcon.Warning);
          });
          return;
        }
        UI(delegate { if (!quitting) Balloon(cfg.T("connectPairing"), ToolTipIcon.Info); });
        int pairResult = RunCliAndWait("remote pair");
        UI(delegate {
          if (quitting) return;
          browserConnectInProgress = false;
          if (pairResult == 0 && HasPairedServer()) {
            wasPaired = true;
            Balloon(cfg.T("connectDone"), ToolTipIcon.Info);
          } else {
            Balloon(cfg.T("connectFailed"), ToolTipIcon.Warning);
          }
          Refresh();
        });
      });
    }

    int RunCliAndWait(string command) {
      try {
        cfg = Config.Load(CfgFile);
        if (string.IsNullOrEmpty(cfg.Exe)) return 1;
        List<string> args = new List<string>();
        foreach (string a in cfg.Args) { if (a == "remote") break; args.Add(a); }
        foreach (string a in command.Split(' ')) args.Add(a);
        StringBuilder line = new StringBuilder();
        foreach (string a in args) { if (line.Length > 0) line.Append(' '); line.Append(Quote(a)); }
        ProcessStartInfo psi = new ProcessStartInfo(cfg.Exe, line.ToString());
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        psi.EnvironmentVariables.Remove("AIVIN_SUPERVISOR");
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        Process p = Process.Start(psi);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        p.WaitForExit();
        int result = p.ExitCode;
        p.Dispose();
        return result;
      } catch { return 1; }
    }

    void ShowPairWithCode() {
      if (pairForm != null) { pairForm.Activate(); return; }
      Form f = new Form();
      f.Text = "AIVIN Bot";
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
      string pairingCode = box.Text.Trim();
      pairForm = null;
      f.Dispose();
      if (r != DialogResult.OK || pairingCode.Length == 0 || quitting) return;
      KillChild();
      StartChild(pairingCode);
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
    internal static string Quote(string a) {
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
