/**
 * Mã C# của tiến trình điều khiển giao diện trên Windows (UI Automation + SendInput + chụp cửa sổ). Nhúng thành chuỗi vì CLI đóng gói
 * thành một tệp nhị phân (bun) — lúc chạy ghi ra thư mục cấu hình rồi PowerShell 5.1 biên dịch (`Add-Type`, CodeDom → chỉ cú pháp C# 5:
 * không `$"..."`, không `?.`, không thân hàm `=>`). Bản dịch được lưu thành DLL theo dấu vân tay mã, lần sau nạp thẳng.
 *
 * Giao thức: mỗi dòng stdin một JSON `{ id, op, args }`, mỗi dòng stdout một JSON `{ id, ok, result | error, code }`. Chạy trên luồng MTA
 * riêng (UI Automation phía client nên ở MTA). Toạ độ là pixel vật lý (tiến trình bật DPI-aware theo từng màn hình).
 *
 * Cùng tiến trình có đầu nối Office qua COM (officeHostSource.mjs, op `office`) — ghép sau phần chính.
 */
import { OFFICE_CSHARP } from './officeHostSource.mjs';

const MAIN_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace AivinGui {
  public class GuiError : Exception {
    public string Code;
    public GuiError(string code, string message) : base(message) { Code = code; }
  }

  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desk);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
  }

  public class Host {
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x1, MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10;
    const uint MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
    /** Ảnh chụp của lần observe: node_id = "<snap>.<idx>" → phần tử. Giữ vài lần gần nhất, cũ hơn → GUI_STALE_NODE. */
    static readonly Dictionary<int, Dictionary<int, AutomationElement>> Snapshots = new Dictionary<int, Dictionary<int, AutomationElement>>();
    static readonly Dictionary<int, IntPtr> SnapshotWindow = new Dictionary<int, IntPtr>();
    /** Chữ OCR của lần observe: node_id = "<snap>.t<k>" → khung chữ (pixel, so với góc trái trên cửa sổ). */
    static readonly Dictionary<int, List<System.Windows.Rect>> OcrSnapshots = new Dictionary<int, List<System.Windows.Rect>>();
    static int snapSeq = 0;
    const int KEEP_SNAPSHOTS = 6;
    /** Mốc lần cuối chính tiến trình này phát input (chuột / phím) — để phân biệt với input của người dùng. */
    static uint lastInjectedTick = 0;
    /**
     * Kiểm "người dùng đang dùng chuột / phím" CHỈ khi thao tác sắp phát input thật (chuột, phím, đổi cửa sổ trên cùng). Thao tác theo
     * pattern (SetValue / Invoke / Toggle / Select) không chiếm chuột, không giật focus → chạy song song với người dùng được (chạy thật
     * 28/10/2026: người dùng đang gõ ở cửa sổ khác, mọi set_value bị dừng oan 12 lượt).
     */
    static bool pendingInputCheck = false;
    static long inputGraceMs = 1500;

    static void GuardInput() {
      if (!pendingInputCheck) return;
      pendingInputCheck = false;
      long idle = UserIdleMs();
      if (idle < inputGraceMs) throw new GuiError("GUI_USER_ACTIVE", "The user is using the mouse/keyboard right now (" + idle + " ms ago) — this action needs the real mouse/keyboard");
    }

    static void MoveCursor(int x, int y) { GuardInput(); Native.SetCursorPos(x, y); }

    public static void Run() {
      try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
      var t = new Thread(Loop);
      t.SetApartmentState(ApartmentState.MTA);
      t.Start();
      t.Join();
    }

    static void Loop() {
      var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
      output.AutoFlush = true;
      output.WriteLine(Json.Serialize(new Dictionary<string, object> { { "ready", true } }));
      string line;
      while ((line = input.ReadLine()) != null) {
        if (line.Trim().Length == 0) continue;
        object id = null;
        var res = new Dictionary<string, object>();
        try {
          var req = (Dictionary<string, object>)Json.DeserializeObject(line);
          id = Get(req, "id");
          var args = Get(req, "args") as Dictionary<string, object>;
          if (args == null) args = new Dictionary<string, object>();
          res["result"] = Dispatch(Str(req, "op"), args);
          res["ok"] = true;
        } catch (GuiError e) {
          res["ok"] = false; res["code"] = e.Code; res["error"] = e.Message;
        } catch (ElementNotAvailableException e) {
          res["ok"] = false; res["code"] = "GUI_STALE_NODE"; res["error"] = "Element is gone: " + e.Message;
        } catch (Exception e) {
          res["ok"] = false; res["code"] = "EXECUTION_FAILED"; res["error"] = e.GetType().Name + ": " + e.Message;
        }
        res["id"] = id;
        output.WriteLine(Json.Serialize(res));
      }
    }

    static object Dispatch(string op, Dictionary<string, object> a) {
      switch (op) {
        case "ping": return new Dictionary<string, object> { { "pong", true }, { "screens", Screens() }, { "interactive", InteractiveDesktop() } };
        case "windows": return ListWindows(Bool(a, "all", false));
        case "observe": return Observe(a);
        case "window_info": { IntPtr h = ResolveWindow(a); if (h == IntPtr.Zero) throw new GuiError("NOT_FOUND", "No window is focused"); return WindowInfo(h, Native.GetForegroundWindow()); }
        case "focus": return FocusWindowOp(a);
        case "to_back": {
          IntPtr h = ResolveWindow(a);
          IntPtr prev = ParseWindow(Str(a, "restore_to"));
          bool restored = prev != IntPtr.Zero && RestoreForeground(prev, h);
          SendToBack(h);
          return new Dictionary<string, object> { { "sent_to_back", true }, { "focus_returned_to_user", restored } };
        }
        case "act": return Act(a);
        case "wait_for": return WaitFor(a);
        case "office": return Office.Run(a);
        case "idle": return new Dictionary<string, object> { { "idle_ms", IdleMs() }, { "user_idle_ms", UserIdleMs() } };
        default: throw new GuiError("INVALID_ARGS", "Unknown op: " + op);
      }
    }

    // ── tiện ích đọc tham số ────────────────────────────────────────────────────────────────────

    static object Get(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
    static string Str(Dictionary<string, object> d, string k) { var v = Get(d, k); return v == null ? null : Convert.ToString(v); }
    static long Long(Dictionary<string, object> d, string k) { var v = Get(d, k); try { return v == null ? 0 : Convert.ToInt64(v); } catch { return 0; } }
    static int Int(Dictionary<string, object> d, string k, int def) { var v = Get(d, k); try { return v == null ? def : Convert.ToInt32(v); } catch { return def; } }
    static double Dbl(Dictionary<string, object> d, string k, double def) { var v = Get(d, k); try { return v == null ? def : Convert.ToDouble(v); } catch { return def; } }
    static bool Bool(Dictionary<string, object> d, string k, bool def) { var v = Get(d, k); try { return v == null ? def : Convert.ToBoolean(v); } catch { return def; } }

    static List<object> Screens() {
      var list = new List<object>();
      foreach (var s in System.Windows.Forms.Screen.AllScreens) {
        list.Add(new Dictionary<string, object> { { "x", s.Bounds.X }, { "y", s.Bounds.Y }, { "w", s.Bounds.Width }, { "h", s.Bounds.Height }, { "primary", s.Primary } });
      }
      return list;
    }

    /** Màn hình đang khoá / chuyển sang desktop bảo mật (UAC) → không mở được desktop nhận input. */
    static bool InteractiveDesktop() {
      IntPtr d = Native.OpenInputDesktop(0, false, 0x0100);
      if (d == IntPtr.Zero) return false;
      Native.CloseDesktop(d);
      return true;
    }

    static uint IdleMs() {
      var info = new Native.LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
      if (!Native.GetLastInputInfo(ref info)) return 0;
      return Native.GetTickCount() - info.dwTime;
    }

    /** Thời gian từ lần input gần nhất KHÔNG phải của AI (gần đúng: input mới hơn lần AI phát cuối + 150 ms là của người). */
    static long UserIdleMs() {
      var info = new Native.LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
      if (!Native.GetLastInputInfo(ref info)) return long.MaxValue;
      uint now = Native.GetTickCount();
      if (lastInjectedTick != 0 && info.dwTime - lastInjectedTick < 150) return long.MaxValue;
      return now - info.dwTime;
    }

    // ── cửa sổ ──────────────────────────────────────────────────────────────────────────────────

    static string WindowText(IntPtr h) { var sb = new StringBuilder(512); Native.GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
    static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); Native.GetClassName(h, sb, sb.Capacity); return sb.ToString(); }

    static string ProcessName(uint pid) {
      try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }

    static bool IsCloaked(IntPtr h) {
      int cloaked = 0;
      try { Native.DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
      return cloaked != 0;
    }

    static Dictionary<string, object> RectDict(Native.RECT r) {
      return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "w", r.Right - r.Left }, { "h", r.Bottom - r.Top } };
    }

    static Dictionary<string, object> WindowInfo(IntPtr h, IntPtr fg) {
      uint pid; Native.GetWindowThreadProcessId(h, out pid);
      Native.RECT r; Native.GetWindowRect(h, out r);
      return new Dictionary<string, object> {
        { "window", "0x" + h.ToInt64().ToString("x") }, { "title", WindowText(h) }, { "process", ProcessName(pid) }, { "pid", (long)pid },
        { "class", ClassOf(h) }, { "rect", RectDict(r) }, { "focused", h == fg }, { "minimized", Native.IsIconic(h) },
      };
    }

    static List<object> ListWindows(bool all) {
      var list = new List<object>();
      IntPtr fg = Native.GetForegroundWindow();
      uint selfPid = (uint)Process.GetCurrentProcess().Id;
      Native.EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (!Native.IsWindowVisible(h) || IsCloaked(h)) return true;
        if (Native.GetWindow(h, 4) != IntPtr.Zero && !all) return true; // có cửa sổ chủ → hộp thoại con, lấy qua cửa sổ chủ
        if ((Native.GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
        string title = WindowText(h);
        if (title.Length == 0) return true;
        uint pid; Native.GetWindowThreadProcessId(h, out pid);
        if (pid == selfPid) return true;
        list.Add(WindowInfo(h, fg));
        return true;
      }, IntPtr.Zero);
      return list;
    }

    static IntPtr ParseWindow(string s) {
      if (string.IsNullOrEmpty(s)) return IntPtr.Zero;
      try {
        long v = s.StartsWith("0x") ? Convert.ToInt64(s.Substring(2), 16) : Convert.ToInt64(s);
        return new IntPtr(v);
      } catch { return IntPtr.Zero; }
    }

    /** Cửa sổ theo handle, hoặc tìm theo tiêu đề / tên tiến trình (chứa, không phân biệt hoa thường); không có → cửa sổ đang focus. */
    static IntPtr ResolveWindow(Dictionary<string, object> a) {
      string w = Str(a, "window");
      IntPtr h = ParseWindow(w);
      if (h != IntPtr.Zero) {
        if (!Native.IsWindow(h)) throw new GuiError("GUI_WINDOW_GONE", "Window no longer exists: " + w);
        return h;
      }
      if (!string.IsNullOrEmpty(w)) {
        string q = w.ToLowerInvariant();
        foreach (Dictionary<string, object> info in ListWindows(false)) {
          if (Convert.ToString(info["title"]).ToLowerInvariant().Contains(q) || Convert.ToString(info["process"]).ToLowerInvariant() == q) {
            return ParseWindow(Convert.ToString(info["window"]));
          }
        }
        throw new GuiError("NOT_FOUND", "No window matches: " + w);
      }
      // Đang focus là chính linh vật (chủ máy vừa bấm vào ô hỏi) → cửa sổ họ đang dùng ngay trước đó ("fallback"), không thì không có.
      IntPtr fg = Native.GetForegroundWindow();
      long avoid = Long(a, "avoid_pid");
      if (avoid > 0 && fg != IntPtr.Zero) {
        uint fgPid; Native.GetWindowThreadProcessId(fg, out fgPid);
        if (fgPid == avoid) {
          IntPtr back = ParseWindow(Str(a, "fallback"));
          return back != IntPtr.Zero && Native.IsWindow(back) ? back : IntPtr.Zero;
        }
      }
      return fg;
    }

    /** Đẩy cửa sổ xuống đáy chồng cửa sổ, không kích hoạt — nằm dưới cửa sổ người dùng, thao tác theo pattern vẫn chạy được. */
    static void SendToBack(IntPtr h) {
      if (h == IntPtr.Zero || !Native.IsWindow(h)) return;
      Native.SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010);
    }

    /** Cửa sổ trên cùng bị thao tác vừa rồi đổi đi → đưa cửa sổ cũ lên lại (gắn luồng input tạm, không phát phím giả). */
    static bool RestoreForeground(IntPtr prev, IntPtr target) {
      IntPtr cur = Native.GetForegroundWindow();
      if (prev == IntPtr.Zero || cur == prev || prev == target || !Native.IsWindow(prev)) return false;
      uint pid;
      uint curThread = Native.GetWindowThreadProcessId(cur, out pid);
      uint me = Native.GetCurrentThreadId();
      bool attached = curThread != 0 && curThread != me && Native.AttachThreadInput(me, curThread, true);
      try { Native.SetForegroundWindow(prev); } finally { if (attached) Native.AttachThreadInput(me, curThread, false); }
      return Native.GetForegroundWindow() == prev;
    }

    static void ForceForeground(IntPtr h) {
      if (Native.IsIconic(h)) Native.ShowWindow(h, 9);
      if (Native.GetForegroundWindow() == h) return;
      GuardInput();
      // Windows chỉ cho đổi cửa sổ trước khi tiến trình vừa có input → nhấn nhả Alt (không tạo ký tự) rồi đặt.
      KeyTap(0x12);
      Native.SetForegroundWindow(h);
      Native.BringWindowToTop(h);
      Thread.Sleep(80);
    }

    static object FocusWindowOp(Dictionary<string, object> a) {
      IntPtr h = ResolveWindow(a);
      ForceForeground(h);
      return new Dictionary<string, object> { { "focused", Native.GetForegroundWindow() == h }, { "window", WindowInfo(h, Native.GetForegroundWindow()) } };
    }

    // ── observe: cây trợ năng rút gọn + ảnh ─────────────────────────────────────────────────────

    static CacheRequest BuildCache() {
      var c = new CacheRequest();
      c.TreeScope = TreeScope.Element | TreeScope.Children;
      c.TreeFilter = Automation.ControlViewCondition;
      c.AutomationElementMode = AutomationElementMode.Full;
      c.Add(AutomationElement.NameProperty); c.Add(AutomationElement.ControlTypeProperty); c.Add(AutomationElement.AutomationIdProperty);
      c.Add(AutomationElement.ClassNameProperty); c.Add(AutomationElement.BoundingRectangleProperty); c.Add(AutomationElement.IsEnabledProperty);
      c.Add(AutomationElement.IsOffscreenProperty); c.Add(AutomationElement.IsPasswordProperty); c.Add(AutomationElement.HasKeyboardFocusProperty);
      c.Add(AutomationElement.AcceleratorKeyProperty); c.Add(AutomationElement.AccessKeyProperty); c.Add(AutomationElement.HelpTextProperty);
      c.Add(AutomationElement.IsInvokePatternAvailableProperty); c.Add(AutomationElement.IsValuePatternAvailableProperty);
      c.Add(AutomationElement.IsTogglePatternAvailableProperty); c.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
      c.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty); c.Add(AutomationElement.IsScrollPatternAvailableProperty);
      c.Add(AutomationElement.IsTextPatternAvailableProperty);
      c.Add(ValuePattern.ValueProperty); c.Add(ValuePattern.IsReadOnlyProperty); c.Add(TogglePattern.ToggleStateProperty);
      c.Add(SelectionItemPattern.IsSelectedProperty); c.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
      return c;
    }

    static object Cached(AutomationElement e, AutomationProperty p) {
      try { var v = e.GetCachedPropertyValue(p, true); return v == AutomationElement.NotSupported ? null : v; } catch { return null; }
    }

    static string Clip(string s, int max) { if (s == null) return null; s = s.Replace("\r", " ").Replace("\n", " ").Trim(); return s.Length > max ? s.Substring(0, max) + "…" : s; }

    static Dictionary<string, object> Describe(AutomationElement e, string nodeId, int depth, System.Windows.Rect win) {
      var n = new Dictionary<string, object>();
      n["id"] = nodeId;
      var ct = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
      n["role"] = ct == null ? "unknown" : ct.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
      string name = Clip(Cached(e, AutomationElement.NameProperty) as string, 160);
      if (!string.IsNullOrEmpty(name)) n["name"] = name;
      string aid = Cached(e, AutomationElement.AutomationIdProperty) as string;
      if (!string.IsNullOrEmpty(aid) && aid.Length <= 80) n["automation_id"] = aid;
      string cls = Cached(e, AutomationElement.ClassNameProperty) as string;
      if (!string.IsNullOrEmpty(cls) && cls.Length <= 60) n["class"] = cls;
      n["depth"] = depth;
      var patterns = new List<string>();
      if (true.Equals(Cached(e, AutomationElement.IsInvokePatternAvailableProperty))) patterns.Add("invoke");
      if (true.Equals(Cached(e, AutomationElement.IsValuePatternAvailableProperty))) {
        patterns.Add("value");
        if (!true.Equals(Cached(e, AutomationElement.IsPasswordProperty))) {
          string v = Clip(Cached(e, ValuePattern.ValueProperty) as string, 300);
          if (!string.IsNullOrEmpty(v)) n["value"] = v;
        }
        if (true.Equals(Cached(e, ValuePattern.IsReadOnlyProperty))) n["readonly"] = true;
      }
      if (true.Equals(Cached(e, AutomationElement.IsTogglePatternAvailableProperty))) {
        patterns.Add("toggle");
        var ts = Cached(e, TogglePattern.ToggleStateProperty);
        if (ts != null) n["checked"] = ts.ToString().ToLowerInvariant();
      }
      if (true.Equals(Cached(e, AutomationElement.IsSelectionItemPatternAvailableProperty))) {
        patterns.Add("select");
        if (true.Equals(Cached(e, SelectionItemPattern.IsSelectedProperty))) n["selected"] = true;
      }
      if (true.Equals(Cached(e, AutomationElement.IsExpandCollapsePatternAvailableProperty))) {
        patterns.Add("expand");
        var es = Cached(e, ExpandCollapsePattern.ExpandCollapseStateProperty);
        if (es != null) n["expanded"] = es.ToString().ToLowerInvariant();
      }
      if (true.Equals(Cached(e, AutomationElement.IsScrollPatternAvailableProperty))) patterns.Add("scroll");
      if (true.Equals(Cached(e, AutomationElement.IsTextPatternAvailableProperty))) patterns.Add("text");
      if (patterns.Count > 0) n["patterns"] = patterns;
      if (true.Equals(Cached(e, AutomationElement.IsPasswordProperty))) n["password"] = true;
      if (false.Equals(Cached(e, AutomationElement.IsEnabledProperty))) n["disabled"] = true;
      if (true.Equals(Cached(e, AutomationElement.HasKeyboardFocusProperty))) n["focused"] = true;
      string acc = Cached(e, AutomationElement.AcceleratorKeyProperty) as string;
      if (!string.IsNullOrEmpty(acc)) n["shortcut"] = acc;
      string help = Clip(Cached(e, AutomationElement.HelpTextProperty) as string, 120);
      if (!string.IsNullOrEmpty(help) && help != name) n["help"] = help;
      object rectObj = Cached(e, AutomationElement.BoundingRectangleProperty);
      if (rectObj is System.Windows.Rect) {
        var r = (System.Windows.Rect)rectObj;
        if (!r.IsEmpty && r.Width > 0 && r.Height > 0) {
          n["rect"] = new Dictionary<string, object> { { "x", (int)(r.X - win.X) }, { "y", (int)(r.Y - win.Y) }, { "w", (int)r.Width }, { "h", (int)r.Height } };
        }
      }
      if (true.Equals(Cached(e, AutomationElement.IsOffscreenProperty))) n["offscreen"] = true;
      return n;
    }

    static bool IsInteractive(Dictionary<string, object> n) {
      if (n.ContainsKey("patterns")) return true;
      string role = Convert.ToString(n["role"]);
      return role == "button" || role == "edit" || role == "menuitem" || role == "hyperlink" || role == "listitem" || role == "tabitem" || role == "treeitem" || role == "checkbox" || role == "radiobutton" || role == "combobox";
    }

    static object Observe(Dictionary<string, object> a) {
      IntPtr h = ResolveWindow(a);
      if (h == IntPtr.Zero) throw new GuiError("NOT_FOUND", "No window is focused");
      int maxNodes = Math.Max(20, Math.Min(Int(a, "max_nodes", 300), 1500));
      int maxDepth = Math.Max(2, Math.Min(Int(a, "max_depth", 25), 60));
      var sw = Stopwatch.StartNew();
      AutomationElement root = AutomationElement.FromHandle(h);
      var cache = BuildCache();
      var nodes = new List<object>();
      var map = new Dictionary<int, AutomationElement>();
      int snap = ++snapSeq;
      Native.RECT wr; Native.GetWindowRect(h, out wr);
      var winRect = new System.Windows.Rect(wr.Left, wr.Top, Math.Max(1, wr.Right - wr.Left), Math.Max(1, wr.Bottom - wr.Top));
      int named = 0, interactive = 0;
      bool truncated = false;
      var queue = new Queue<KeyValuePair<AutomationElement, int>>();
      using (cache.Activate()) {
        root = root.GetUpdatedCache(cache);
      }
      queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
      while (queue.Count > 0) {
        if (nodes.Count >= maxNodes) { truncated = true; break; }
        var item = queue.Dequeue();
        AutomationElement e = item.Key;
        int idx = nodes.Count;
        var n = Describe(e, snap + "." + idx, item.Value, winRect);
        // Ngoài màn hình và không có chữ → bỏ (danh sách dài cuộn ẩn), vẫn đi vào con nếu là khung chứa.
        bool skip = n.ContainsKey("offscreen") && !n.ContainsKey("name") && item.Value > 0;
        if (!skip) {
          map[idx] = e;
          nodes.Add(n);
          if (n.ContainsKey("name")) named++;
          if (IsInteractive(n)) interactive++;
        }
        if (item.Value >= maxDepth) continue;
        AutomationElementCollection kids;
        try {
          using (cache.Activate()) { kids = e.FindAll(TreeScope.Children, Condition.TrueCondition); }
        } catch { continue; }
        foreach (AutomationElement k in kids) queue.Enqueue(new KeyValuePair<AutomationElement, int>(k, item.Value + 1));
      }
      Snapshots[snap] = map;
      SnapshotWindow[snap] = h;
      while (Snapshots.Count > KEEP_SNAPSHOTS) {
        int oldest = int.MaxValue;
        foreach (var k in Snapshots.Keys) if (k < oldest) oldest = k;
        Snapshots.Remove(oldest); SnapshotWindow.Remove(oldest); OcrSnapshots.Remove(oldest);
      }
      // Cây nghèo: ít phần tử có tên / thao tác được (ứng dụng vẽ tay, canvas, Electron tắt trợ năng) → cần ảnh để định vị.
      string quality = (interactive >= 3 && named >= 5) ? "good" : "poor";
      var res = new Dictionary<string, object> {
        { "snapshot", snap }, { "window", WindowInfo(h, Native.GetForegroundWindow()) }, { "nodes", nodes }, { "node_count", nodes.Count },
        { "interactive_count", interactive }, { "tree_quality", quality }, { "truncated", truncated }, { "tree_ms", sw.ElapsedMilliseconds },
        { "dpi", (long)SafeDpi(h) },
      };
      bool wantImage = Bool(a, "include_image", false) || (quality == "poor" && Bool(a, "image_when_poor", true));
      // Cây nghèo → đọc chữ trên ảnh (OCR của Windows, chạy trên máy): mỗi cụm chữ thành một node "text" có toạ độ, thang quyết định đích
      // ở BE tìm được "nút Lưu" theo chữ như với phần tử thật thay vì đoán toạ độ trên ảnh.
      bool wantOcr = Bool(a, "ocr", quality == "poor");
      if (wantImage || wantOcr) {
        var sw2 = Stopwatch.StartNew();
        using (var bmp = GrabWindow(h)) {
          if (wantImage) {
            res["image"] = EncodeImage(bmp, Int(a, "image_max_width", 1366), Int(a, "image_quality", 70));
            res["image_ms"] = sw2.ElapsedMilliseconds;
          }
          if (wantOcr) AddOcrNodes(res, nodes, snap, bmp, Str(a, "ocr_lang"), Int(a, "ocr_max_nodes", 200));
        }
      }
      return res;
    }

    static uint SafeDpi(IntPtr h) { try { return Native.GetDpiForWindow(h); } catch { return 96; } }

    static Bitmap GrabWindow(IntPtr h) {
      Native.RECT r; Native.GetWindowRect(h, out r);
      int w = Math.Max(1, r.Right - r.Left), ht = Math.Max(1, r.Bottom - r.Top);
      var bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
      bool ok = false;
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        try { ok = Native.PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); }
        // PrintWindow trả ảnh đen với vài ứng dụng GPU → chụp vùng màn hình (cửa sổ phải đang hiện trên cùng).
        if (!ok || IsMostlyBlack(bmp)) g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, ht));
      }
      return bmp;
    }

    static Dictionary<string, object> EncodeImage(Bitmap bmp, int maxWidth, int quality) {
      int w = bmp.Width, ht = bmp.Height;
      double scale = w > maxWidth ? (double)maxWidth / w : 1.0;
      int ow = Math.Max(1, (int)(w * scale)), oh = Math.Max(1, (int)(ht * scale));
      using (var outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
        using (var g2 = Graphics.FromImage(outBmp)) {
          g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g2.DrawImage(bmp, 0, 0, ow, oh);
        }
        var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(30, Math.Min(quality, 95)));
        using (var ms = new MemoryStream()) {
          outBmp.Save(ms, codec, ep);
          return new Dictionary<string, object> { { "mime", "image/jpeg" }, { "base64", Convert.ToBase64String(ms.ToArray()) }, { "width", ow }, { "height", oh }, { "scale", scale } };
        }
      }
    }

    static void AddOcrNodes(Dictionary<string, object> res, List<object> nodes, int snap, Bitmap bmp, string lang, int max) {
      var sw = Stopwatch.StartNew();
      try {
        string used;
        var segments = Ocr.Read(bmp, lang, out used);
        var rects = new List<System.Windows.Rect>();
        foreach (var s in segments) {
          if (rects.Count >= Math.Max(0, max)) break;
          var r = s.Rect;
          nodes.Add(new Dictionary<string, object> {
            { "id", snap + ".t" + rects.Count }, { "role", "text" }, { "name", s.Text }, { "source", "ocr" },
            { "rect", new Dictionary<string, object> { { "x", (int)r.X }, { "y", (int)r.Y }, { "w", (int)r.Width }, { "h", (int)r.Height } } },
          });
          rects.Add(r);
        }
        OcrSnapshots[snap] = rects;
        var info = new Dictionary<string, object> { { "lang", used }, { "count", rects.Count }, { "ms", sw.ElapsedMilliseconds } };
        if (!used.StartsWith("vi", StringComparison.OrdinalIgnoreCase)) info["hint"] = "No Vietnamese OCR on this PC — Vietnamese text loses its accents. Settings → Time & language → Language → add Vietnamese (Optical character recognition)";
        res["ocr"] = info;
        res["node_count"] = nodes.Count;
      } catch (Exception e) {
        res["ocr"] = new Dictionary<string, object> { { "error", (e is GuiError ? e.Message : e.GetType().Name + ": " + e.Message) } };
      }
    }

    static bool IsMostlyBlack(Bitmap b) {
      int dark = 0, total = 0;
      for (int x = 0; x < b.Width; x += Math.Max(1, b.Width / 16)) {
        for (int y = 0; y < b.Height; y += Math.Max(1, b.Height / 16)) {
          var c = b.GetPixel(x, y); total++;
          if (c.R < 8 && c.G < 8 && c.B < 8) dark++;
        }
      }
      return total > 0 && dark * 10 >= total * 9;
    }

    // ── act ─────────────────────────────────────────────────────────────────────────────────────

    static AutomationElement NodeOf(string nodeId, out IntPtr window) {
      window = IntPtr.Zero;
      int dot = nodeId == null ? -1 : nodeId.IndexOf('.');
      if (dot <= 0) throw new GuiError("INVALID_ARGS", "Bad node id: " + nodeId);
      int snap, idx;
      if (!int.TryParse(nodeId.Substring(0, dot), out snap) || !int.TryParse(nodeId.Substring(dot + 1), out idx)) throw new GuiError("INVALID_ARGS", "Bad node id: " + nodeId);
      Dictionary<int, AutomationElement> map;
      if (!Snapshots.TryGetValue(snap, out map)) throw new GuiError("GUI_STALE_NODE", "Node " + nodeId + " is from an old observation — observe again");
      AutomationElement e;
      if (!map.TryGetValue(idx, out e)) throw new GuiError("NOT_FOUND", "No node " + nodeId);
      window = SnapshotWindow[snap];
      return e;
    }

    static object Pattern(AutomationElement e, AutomationPattern p) {
      object o; return e.TryGetCurrentPattern(p, out o) ? o : null;
    }

    static Dictionary<string, object> Live(AutomationElement e) {
      var d = new Dictionary<string, object>();
      try {
        d["exists"] = true;
        d["name"] = Clip(e.Current.Name, 160);
        d["enabled"] = e.Current.IsEnabled;
        d["focused"] = e.Current.HasKeyboardFocus;
        var vp = Pattern(e, ValuePattern.Pattern) as ValuePattern;
        if (vp != null && !e.Current.IsPassword) d["value"] = Clip(vp.Current.Value, 300);
        var tp = Pattern(e, TogglePattern.Pattern) as TogglePattern;
        if (tp != null) d["checked"] = tp.Current.ToggleState.ToString().ToLowerInvariant();
        var sp = Pattern(e, SelectionItemPattern.Pattern) as SelectionItemPattern;
        if (sp != null) d["selected"] = sp.Current.IsSelected;
        var ep = Pattern(e, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
        if (ep != null) d["expanded"] = ep.Current.ExpandCollapseState.ToString().ToLowerInvariant();
      } catch (ElementNotAvailableException) {
        d.Clear(); d["exists"] = false;
      }
      return d;
    }

    static System.Windows.Point CenterOf(AutomationElement e) {
      System.Windows.Point p;
      try { if (e.TryGetClickablePoint(out p)) return p; } catch { }
      System.Windows.Rect r = e.Current.BoundingRectangle;
      if (r.IsEmpty) throw new GuiError("GUI_NOT_CLICKABLE", "Element has no position on screen");
      return new System.Windows.Point(r.X + r.Width / 2, r.Y + r.Height / 2);
    }

    static object Act(Dictionary<string, object> a) {
      string action = Str(a, "action") ?? "click";
      string nodeId = Str(a, "node_id");
      string method = Str(a, "method") ?? "auto";
      inputGraceMs = Int(a, "user_input_grace_ms", 1500);
      pendingInputCheck = Bool(a, "check_user_input", true);
      if (!InteractiveDesktop()) throw new GuiError("GUI_LOCKED", "The screen is locked or a secure prompt is showing");
      AutomationElement el = null;
      IntPtr window = IntPtr.Zero;
      ocrPoint = null;
      if (!string.IsNullOrEmpty(nodeId) && nodeId.Contains(".t")) {
        ocrPoint = OcrPointOf(nodeId, out window);
        if (action != "click" && action != "double_click" && action != "right_click" && action != "set_value" && action != "type") {
          throw new GuiError("INVALID_ARGS", "Text read from the screenshot (OCR) supports click / double_click / right_click / set_value / type only");
        }
        // Chữ OCR không phải ô nhập: gõ vào nó = click vào chỗ đó trước rồi gõ bằng bàn phím.
        if (action == "set_value" || action == "type") { MouseAt(null, window, a, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1); method = "mouse"; }
      }
      else if (!string.IsNullOrEmpty(nodeId)) el = NodeOf(nodeId, out window);
      else window = ResolveWindow(a);
      string beforeTitle = window == IntPtr.Zero ? "" : WindowText(window);
      if (el != null) {
        bool isPassword = false;
        try { isPassword = el.Current.IsPassword; } catch (ElementNotAvailableException) { throw new GuiError("GUI_STALE_NODE", "Node " + nodeId + " is gone — observe again"); }
        if (isPassword && (action == "type" || action == "set_value")) throw new GuiError("GUI_PASSWORD_FIELD", "Typing into a password field is not allowed — ask the user to type it");
      }
      IntPtr fgBefore = Native.GetForegroundWindow();
      string used = DoAction(action, method, el, window, a);
      // Thao tác theo pattern không cần cửa sổ đích ở trên cùng, nhưng nhiều ứng dụng (WinForms qua MSAA) tự lấy focus khi bị SetValue /
      // Expand → phím người dùng đang gõ ở cửa sổ khác rơi vào ô của AI (chạy thật 28/10/2026: ô Họ tên bị chèn "ã", "x", "ch"). Trả focus
      // về cửa sổ người dùng đang dùng ngay sau thao tác.
      bool restored = used != "mouse" && used != "keyboard" && RestoreForeground(fgBefore, window);
      // Chạy nền: người dùng đang ở cửa sổ khác → cửa sổ của AI về lại dưới đáy (không chồng lên việc của người dùng).
      if (restored || (used != "mouse" && used != "keyboard" && fgBefore != window && window != IntPtr.Zero)) SendToBack(window);
      Thread.Sleep(Math.Max(0, Math.Min(Int(a, "settle_ms", 250), 3000)));
      var res = new Dictionary<string, object> { { "action", action }, { "method", used } };
      if (restored) res["focus_returned_to_user"] = true;
      if (el != null) res["target"] = Live(el);
      IntPtr fg = Native.GetForegroundWindow();
      res["foreground"] = WindowInfo(fg, fg);
      if (window != IntPtr.Zero) {
        bool alive = Native.IsWindow(window);
        res["window_closed"] = !alive;
        if (alive) {
          string after = WindowText(window);
          if (after != beforeTitle) res["window_title_changed"] = new Dictionary<string, object> { { "from", beforeTitle }, { "to", after } };
        }
      }
      try {
        var fe = AutomationElement.FocusedElement;
        if (fe != null) res["focused_element"] = new Dictionary<string, object> { { "role", fe.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant() }, { "name", Clip(fe.Current.Name, 120) } };
      } catch { }
      return res;
    }

    static string DoAction(string action, string method, AutomationElement el, IntPtr window, Dictionary<string, object> a) {
      bool allowPattern = method != "mouse";
      switch (action) {
        case "click": {
          if (el != null && allowPattern) {
            var ip = Pattern(el, InvokePattern.Pattern) as InvokePattern;
            string role = el.Current.ControlType.ProgrammaticName;
            bool invokeRole = role.EndsWith("Button") || role.EndsWith("MenuItem") || role.EndsWith("Hyperlink") || role.EndsWith("SplitButton");
            if (ip != null && invokeRole) { ip.Invoke(); return "invoke"; }
            if (role.EndsWith("ListItem") || role.EndsWith("TabItem") || role.EndsWith("TreeItem") || role.EndsWith("RadioButton")) {
              var sp = Pattern(el, SelectionItemPattern.Pattern) as SelectionItemPattern;
              if (sp != null) { sp.Select(); return "select"; }
            }
            if (role.EndsWith("CheckBox")) {
              var tp = Pattern(el, TogglePattern.Pattern) as TogglePattern;
              if (tp != null) { tp.Toggle(); return "toggle"; }
            }
            if (method == "pattern") {
              if (ip != null) { ip.Invoke(); return "invoke"; }
              throw new GuiError("GUI_NO_PATTERN", "Element has no click pattern — retry with method mouse");
            }
          }
          MouseAt(el, window, a, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1);
          return "mouse";
        }
        case "double_click": MouseAt(el, window, a, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 2); return "mouse";
        case "right_click": MouseAt(el, window, a, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 1); return "mouse";
        case "set_value": {
          string text = Str(a, "text") ?? "";
          if (el != null && allowPattern) {
            var vp = Pattern(el, ValuePattern.Pattern) as ValuePattern;
            if (vp != null && !vp.Current.IsReadOnly) { vp.SetValue(text); return "value"; }
            if (TryBackgroundSetText(el, text)) return "background";
          }
          FocusTarget(el, window);
          KeyCombo("ctrl+a");
          TypeText(text);
          return "keyboard";
        }
        case "type": {
          string text = Str(a, "text") ?? "";
          if (allowPattern && TryBackgroundType(el, text)) return "background";
          FocusTarget(el, window); TypeText(text); return "keyboard";
        }
        case "key": FocusTarget(el, window); KeyCombo(Str(a, "keys") ?? ""); return "keyboard";
        case "scroll": {
          string dir = (Str(a, "direction") ?? "down").ToLowerInvariant();
          int amount = Math.Max(1, Math.Min(Int(a, "amount", 3), 30));
          if (el != null && allowPattern) {
            var sp = Pattern(el, ScrollPattern.Pattern) as ScrollPattern;
            if (sp != null) {
              for (int i = 0; i < amount; i++) {
                if (dir == "up") sp.ScrollVertical(ScrollAmount.SmallDecrement);
                else if (dir == "left") sp.ScrollHorizontal(ScrollAmount.SmallDecrement);
                else if (dir == "right") sp.ScrollHorizontal(ScrollAmount.SmallIncrement);
                else sp.ScrollVertical(ScrollAmount.SmallIncrement);
              }
              return "scroll";
            }
          }
          var p = PointFor(el, window, a);
          ForceForeground(window);
          MoveCursor((int)p.X, (int)p.Y);
          int delta = (dir == "up" ? 120 : -120) * amount;
          var inp = MouseInput(MOUSEEVENTF_WHEEL, 0, 0, delta);
          Send(new[] { inp });
          return "mouse";
        }
        case "select": {
          if (el == null) throw new GuiError("INVALID_ARGS", "select needs node_id");
          string option = Str(a, "option");
          if (!string.IsNullOrEmpty(option)) {
            // Mục của danh sách thường có sẵn trong cây khi đang đóng → chọn thẳng, không thả danh sách xuống (thả xuống kéo cửa sổ lên
            // trên cùng, giật focus của người dùng). Chỉ mở khi mục chưa có trong cây.
            var ep = Pattern(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
            var match = el.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, option, PropertyConditionFlags.IgnoreCase));
            bool expanded = false;
            if (match == null && ep != null) { try { ep.Expand(); expanded = true; Thread.Sleep(200); } catch { } }
            if (match == null) match = FindByName(el, option);
            if (match == null) throw new GuiError("NOT_FOUND", "No option named: " + option);
            var sip = Pattern(match, SelectionItemPattern.Pattern) as SelectionItemPattern;
            if (sip != null) sip.Select(); else { var ip = Pattern(match, InvokePattern.Pattern) as InvokePattern; if (ip != null) ip.Invoke(); else throw new GuiError("GUI_NO_PATTERN", "Option cannot be selected"); }
            if (ep != null && expanded) { try { ep.Collapse(); } catch { } }
            return "select";
          }
          var sp2 = Pattern(el, SelectionItemPattern.Pattern) as SelectionItemPattern;
          if (sp2 == null) throw new GuiError("GUI_NO_PATTERN", "Element is not selectable");
          sp2.Select();
          return "select";
        }
        case "toggle": {
          if (el == null) throw new GuiError("INVALID_ARGS", "toggle needs node_id");
          var tp = Pattern(el, TogglePattern.Pattern) as TogglePattern;
          if (tp == null) throw new GuiError("GUI_NO_PATTERN", "Element is not a toggle");
          string want = Str(a, "state");
          for (int i = 0; i < 3; i++) {
            if (want != null && tp.Current.ToggleState.ToString().ToLowerInvariant() == want.ToLowerInvariant()) break;
            tp.Toggle();
            if (want == null) break;
          }
          return "toggle";
        }
        case "expand":
        case "collapse": {
          if (el == null) throw new GuiError("INVALID_ARGS", action + " needs node_id");
          var ep = Pattern(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
          if (ep == null) throw new GuiError("GUI_NO_PATTERN", "Element cannot expand/collapse");
          if (action == "expand") ep.Expand(); else ep.Collapse();
          return "expand";
        }
        case "drag": {
          var start = PointFor(el, window, a);
          var toD = Get(a, "to") as Dictionary<string, object>;
          if (toD == null) throw new GuiError("INVALID_ARGS", "drag needs to {x,y}");
          var to = WindowPoint(window, a, toD);
          ForceForeground(window);
          MoveCursor((int)start.X, (int)start.Y);
          Send(new[] { MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0) });
          for (int i = 1; i <= 10; i++) {
            MoveCursor((int)(start.X + (to.X - start.X) * i / 10), (int)(start.Y + (to.Y - start.Y) * i / 10));
            Thread.Sleep(15);
          }
          Send(new[] { MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0) });
          return "mouse";
        }
        default: throw new GuiError("INVALID_ARGS", "Unknown action: " + action);
      }
    }

    static AutomationElement FindByName(AutomationElement root, string name) {
      var cond = new PropertyCondition(AutomationElement.NameProperty, name, PropertyConditionFlags.IgnoreCase);
      var hit = root.FindFirst(TreeScope.Descendants, cond);
      if (hit != null) return hit;
      // Danh sách thả xuống của ComboBox Win32 là cửa sổ riêng → tìm từ gốc màn hình trong các popup đang mở.
      return AutomationElement.RootElement.FindFirst(TreeScope.Descendants, new AndCondition(cond, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem)));
    }

    const uint WM_SETTEXT = 0x000C, WM_CHAR = 0x0102, SMTO_ABORTIFHUNG = 0x0002;

    /** Handle Win32 riêng của phần tử (ô nhập / nút Win32, WinForms có; WPF / UWP / Chromium thì không). */
    static IntPtr OwnHandle(AutomationElement el) {
      if (el == null) return IntPtr.Zero;
      try { int h = el.Current.NativeWindowHandle; return h == 0 ? IntPtr.Zero : new IntPtr(h); } catch { return IntPtr.Zero; }
    }

    /**
     * Chạy NỀN (28/10/2026, user: "chạy nền, không chiếm focus"): ô Win32 có handle riêng → đặt chữ bằng WM_SETTEXT / gửi ký tự bằng
     * WM_CHAR thẳng vào handle — không đưa cửa sổ lên, không đụng bàn phím thật. Ô không có handle (WPF, UWP, trình duyệt) → false, nơi
     * gọi mới dùng bàn phím thật.
     */
    static bool TryBackgroundSetText(AutomationElement el, string text) {
      IntPtr h = OwnHandle(el);
      if (h == IntPtr.Zero) return false;
      IntPtr r;
      return Native.SendMessageTimeout(h, WM_SETTEXT, IntPtr.Zero, text, SMTO_ABORTIFHUNG, 2000, out r) != IntPtr.Zero;
    }

    static bool TryBackgroundType(AutomationElement el, string text) {
      IntPtr h = OwnHandle(el);
      if (h == IntPtr.Zero) return false;
      foreach (char ch in text) {
        if (ch == '\r') continue;
        Native.PostMessage(h, WM_CHAR, new IntPtr(ch == '\n' ? 13 : ch), IntPtr.Zero);
      }
      Thread.Sleep(30);
      return true;
    }

    static void FocusTarget(AutomationElement el, IntPtr window) {
      if (window != IntPtr.Zero) ForceForeground(window);
      if (el != null) { try { el.SetFocus(); } catch { } Thread.Sleep(50); }
    }

    /** Toạ độ theo ảnh của lần observe ({x,y} trong khung ảnh đã thu nhỏ, kèm scale) → toạ độ màn hình. */
    static System.Windows.Point WindowPoint(IntPtr window, Dictionary<string, object> a, Dictionary<string, object> pt) {
      if (window == IntPtr.Zero) throw new GuiError("INVALID_ARGS", "A window is required for x/y targets");
      Native.RECT r; Native.GetWindowRect(window, out r);
      double scale = Dbl(a, "image_scale", 1.0);
      if (scale <= 0) scale = 1.0;
      double x = Dbl(pt, "x", -1), y = Dbl(pt, "y", -1);
      if (x < 0 || y < 0) throw new GuiError("INVALID_ARGS", "x/y must be non-negative");
      double sx = r.Left + x / scale, sy = r.Top + y / scale;
      if (sx > r.Right || sy > r.Bottom) throw new GuiError("INVALID_ARGS", "x/y is outside the window");
      return new System.Windows.Point(sx, sy);
    }

    /**
     * Chờ giao diện tới trạng thái mong đợi thay vì Planner observe lặp: phần tử (tên chứa chữ / AutomationId, lọc vai trò) hiện ra hoặc mất
     * đi trong cửa sổ, hoặc cửa sổ có tiêu đề chứa chữ hiện ra / đóng (không nói cửa sổ = tìm trong mọi cửa sổ). Hỏi lại mỗi ~250 ms.
     */
    static object WaitFor(Dictionary<string, object> a) {
      string until = (Str(a, "until") ?? "appears").ToLowerInvariant();
      bool gone = until == "gone" || until == "disappears";
      string name = Str(a, "name"), aid = Str(a, "automation_id"), role = Str(a, "role"), title = Str(a, "title_contains");
      bool windowLevel = string.IsNullOrEmpty(name) && string.IsNullOrEmpty(aid);
      if (windowLevel && string.IsNullOrEmpty(title)) throw new GuiError("INVALID_ARGS", "Give name / automation_id (an element) or title_contains (a window)");
      int timeout = Math.Max(200, Math.Min(Int(a, "timeout_ms", 10000), 60000));
      IntPtr h = (!windowLevel || !string.IsNullOrEmpty(Str(a, "window"))) ? ResolveWindow(a) : IntPtr.Zero;
      if (!windowLevel && h == IntPtr.Zero) throw new GuiError("NOT_FOUND", "No window is focused");
      var sw = Stopwatch.StartNew();
      while (true) {
        bool alive = h == IntPtr.Zero || Native.IsWindow(h);
        Dictionary<string, object> match = null;
        if (windowLevel) {
          if (h != IntPtr.Zero) {
            if (alive && WindowText(h).IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) match = WindowInfo(h, Native.GetForegroundWindow());
          } else {
            foreach (Dictionary<string, object> info in ListWindows(false)) {
              if (Convert.ToString(info["title"]).IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) { match = info; break; }
            }
          }
        } else if (alive) {
          match = FindElement(h, name, aid, role);
        }
        if (gone ? match == null : match != null) {
          var res = new Dictionary<string, object> { { "met", true }, { "until", gone ? "gone" : "appears" }, { "waited_ms", sw.ElapsedMilliseconds } };
          if (match != null) res["match"] = match;
          if (!alive) res["window_closed"] = true;
          return res;
        }
        if (!alive) throw new GuiError("GUI_WINDOW_GONE", "The window closed while waiting for the element to appear");
        if (sw.ElapsedMilliseconds >= timeout) {
          throw new GuiError("GUI_WAIT_TIMEOUT", "Still " + (gone ? "present" : "not there") + " after " + sw.ElapsedMilliseconds + " ms — observe to see what the window shows instead");
        }
        Thread.Sleep(250);
      }
    }

    /** Phần tử đầu tiên khớp (AutomationId trùng hẳn, hoặc tên chứa chữ — không phân biệt hoa thường), có lọc vai trò. */
    static Dictionary<string, object> FindElement(IntPtr h, string name, string aid, string role) {
      AutomationElement root;
      try { root = AutomationElement.FromHandle(h); } catch { return null; }
      var cache = new CacheRequest();
      cache.Add(AutomationElement.NameProperty); cache.Add(AutomationElement.ControlTypeProperty); cache.Add(AutomationElement.AutomationIdProperty);
      cache.Add(AutomationElement.IsOffscreenProperty);
      cache.AutomationElementMode = AutomationElementMode.None;
      Condition cond = string.IsNullOrEmpty(aid) ? Condition.TrueCondition : new PropertyCondition(AutomationElement.AutomationIdProperty, aid);
      AutomationElementCollection all;
      try { using (cache.Activate()) { all = root.FindAll(TreeScope.Descendants, cond); } } catch (ElementNotAvailableException) { return null; }
      foreach (AutomationElement e in all) {
        string n = Cached(e, AutomationElement.NameProperty) as string ?? "";
        var ct = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
        string r = ct == null ? "" : ct.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
        if (!string.IsNullOrEmpty(name) && n.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
        if (!string.IsNullOrEmpty(role) && !string.Equals(r, role, StringComparison.OrdinalIgnoreCase)) continue;
        if (true.Equals(Cached(e, AutomationElement.IsOffscreenProperty)) && string.IsNullOrEmpty(aid)) continue;
        var m = new Dictionary<string, object> { { "role", r }, { "name", Clip(n, 120) } };
        string id = Cached(e, AutomationElement.AutomationIdProperty) as string;
        if (!string.IsNullOrEmpty(id)) m["automation_id"] = id;
        return m;
      }
      return null;
    }

    /** Điểm màn hình của node chữ OCR của thao tác đang chạy (null = không phải node OCR). */
    static System.Windows.Point? ocrPoint = null;

    static System.Windows.Point OcrPointOf(string nodeId, out IntPtr window) {
      window = IntPtr.Zero;
      int dot = nodeId.IndexOf(".t");
      int snap, idx;
      if (!int.TryParse(nodeId.Substring(0, dot), out snap) || !int.TryParse(nodeId.Substring(dot + 2), out idx)) throw new GuiError("INVALID_ARGS", "Bad node id: " + nodeId);
      List<System.Windows.Rect> rects;
      if (!OcrSnapshots.TryGetValue(snap, out rects)) throw new GuiError("GUI_STALE_NODE", "Node " + nodeId + " is from an old observation — observe again");
      if (idx < 0 || idx >= rects.Count) throw new GuiError("NOT_FOUND", "No node " + nodeId);
      window = SnapshotWindow[snap];
      if (!Native.IsWindow(window)) throw new GuiError("GUI_STALE_NODE", "The window of " + nodeId + " is closed — observe again");
      // Khung chữ tính theo góc cửa sổ lúc observe → cộng vị trí cửa sổ HIỆN TẠI (người dùng có thể đã kéo cửa sổ đi).
      Native.RECT wr; Native.GetWindowRect(window, out wr);
      var r = rects[idx];
      return new System.Windows.Point(wr.Left + r.X + r.Width / 2, wr.Top + r.Y + r.Height / 2);
    }

    static System.Windows.Point PointFor(AutomationElement el, IntPtr window, Dictionary<string, object> a) {
      if (el != null) return CenterOf(el);
      if (ocrPoint.HasValue) return ocrPoint.Value;
      var pt = Get(a, "point") as Dictionary<string, object>;
      if (pt == null) throw new GuiError("INVALID_ARGS", "Give node_id or point {x,y}");
      return WindowPoint(window, a, pt);
    }

    static void MouseAt(AutomationElement el, IntPtr window, Dictionary<string, object> a, uint down, uint up, int times) {
      var p = PointFor(el, window, a);
      if (window != IntPtr.Zero) ForceForeground(window);
      MoveCursor((int)p.X, (int)p.Y);
      Thread.Sleep(30);
      var list = new List<Native.INPUT>();
      for (int i = 0; i < times; i++) { list.Add(MouseInput(down, 0, 0, 0)); list.Add(MouseInput(up, 0, 0, 0)); }
      Send(list.ToArray());
    }

    static Native.INPUT MouseInput(uint flags, int dx, int dy, int data) {
      var i = new Native.INPUT { type = INPUT_MOUSE };
      i.u.mi = new Native.MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
      return i;
    }

    static Native.INPUT KeyInput(ushort vk, ushort scan, uint flags) {
      var i = new Native.INPUT { type = INPUT_KEYBOARD };
      i.u.ki = new Native.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
      return i;
    }

    static void Send(Native.INPUT[] inputs) {
      if (inputs.Length == 0) return;
      GuardInput();
      uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
      lastInjectedTick = Native.GetTickCount();
      if (sent != inputs.Length) throw new GuiError("GUI_INPUT_BLOCKED", "Windows blocked the input (a higher-privilege window is in front?)");
    }

    static void KeyTap(ushort vk) { Send(new[] { KeyInput(vk, 0, 0), KeyInput(vk, 0, KEYEVENTF_KEYUP) }); }

    static void TypeText(string text) {
      var list = new List<Native.INPUT>();
      foreach (char ch in text) {
        if (ch == '\n') { list.Add(KeyInput(0x0D, 0, 0)); list.Add(KeyInput(0x0D, 0, KEYEVENTF_KEYUP)); continue; }
        if (ch == '\r') continue;
        list.Add(KeyInput(0, ch, KEYEVENTF_UNICODE));
        list.Add(KeyInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        if (list.Count >= 200) { Send(list.ToArray()); list.Clear(); Thread.Sleep(5); }
      }
      Send(list.ToArray());
    }

    static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort> {
      { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B }, { "meta", 0x5B },
      { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B }, { "space", 0x20 },
      { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 },
      { "pageup", 0x21 }, { "pagedown", 0x22 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
      { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 },
      { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B }, { "apps", 0x5D }, { "menu", 0x5D },
    };
    static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5B, 0x5D };

    /** "ctrl+s", "alt+f4", "enter", "ctrl+shift+n" — nhiều tổ hợp cách nhau bằng dấu cách: "ctrl+a delete". */
    static void KeyCombo(string spec) {
      foreach (string combo in spec.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
        var vks = new List<ushort>();
        foreach (string raw in combo.ToLowerInvariant().Split('+')) {
          string k = raw.Trim();
          if (k.Length == 0) continue;
          ushort vk;
          if (Keys.TryGetValue(k, out vk)) { vks.Add(vk); continue; }
          if (k.Length == 1) {
            short s = Native.VkKeyScan(k[0]);
            if (s == -1) throw new GuiError("INVALID_ARGS", "Unknown key: " + k);
            vks.Add((ushort)(s & 0xFF));
            continue;
          }
          throw new GuiError("INVALID_ARGS", "Unknown key: " + k);
        }
        if (vks.Count == 0) continue;
        var list = new List<Native.INPUT>();
        foreach (var vk in vks) list.Add(KeyInput(vk, 0, Extended.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0));
        for (int i = vks.Count - 1; i >= 0; i--) list.Add(KeyInput(vks[i], 0, KEYEVENTF_KEYUP | (Extended.Contains(vks[i]) ? KEYEVENTF_EXTENDEDKEY : 0)));
        Send(list.ToArray());
        Thread.Sleep(40);
      }
    }
  }

  /** Một cụm chữ OCR liền nhau trên cùng dòng (một nút / nhãn), khung theo pixel của ảnh. */
  public class OcrSegment {
    public string Text;
    public System.Windows.Rect Rect;
  }

  /**
   * OCR có sẵn của Windows 10+ (Windows.Media.Ocr, chạy trên máy, không gửi ảnh đi đâu). Gọi WinRT qua reflection — Add-Type (CodeDom,
   * C# 5) không tham chiếu được .winmd. Lần đầu ~0,1 s, các lần sau ~15 ms. Ưu tiên tiếng Việt nếu máy có gói OCR tiếng Việt, rồi ngôn
   * ngữ hồ sơ người dùng.
   */
  public static class Ocr {
    const string WRT = "System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089";
    static readonly Dictionary<string, object> Engines = new Dictionary<string, object>();
    static MethodInfo asTask;

    static Type WinRT(string name, string asm) { return Type.GetType(name + ", " + asm + ", ContentType=WindowsRuntime", true); }

    /** Chờ một IAsyncOperation<T> của WinRT: kiểu T lấy từ kiểu trả về KHAI BÁO (đối tượng COM lúc chạy không lộ interface). */
    static object Call(MethodInfo mi, object target, params object[] args) {
      object op = mi.Invoke(target, args);
      if (asTask == null) {
        foreach (var m in Type.GetType("System.WindowsRuntimeSystemExtensions, " + WRT, true).GetMethods()) {
          var ps = m.GetParameters();
          if (m.Name == "AsTask" && m.IsGenericMethod && ps.Length == 1 && ps[0].ParameterType.GetGenericTypeDefinition().FullName == "Windows.Foundation.IAsyncOperation" + (char)96 + "1") { asTask = m; break; }
        }
        if (asTask == null) throw new GuiError("GUI_OCR_UNAVAILABLE", "WinRT async bridge not found");
      }
      var task = (System.Threading.Tasks.Task)asTask.MakeGenericMethod(mi.ReturnType.GetGenericArguments()[0]).Invoke(null, new[] { op });
      if (!task.Wait(15000)) throw new GuiError("GUI_OCR_UNAVAILABLE", "OCR timed out");
      return task.GetType().GetProperty("Result").GetValue(task, null);
    }

    static object Engine(string lang, out string used) {
      var engineT = WinRT("Windows.Media.Ocr.OcrEngine", "Windows.Media");
      var tries = new List<string>();
      if (!string.IsNullOrEmpty(lang)) tries.Add(lang);
      tries.Add("vi");
      tries.Add("");
      foreach (var t in tries) {
        object e;
        if (Engines.TryGetValue(t, out e) && e != null) { used = Tag(e); return e; }
        if (t.Length == 0) {
          e = engineT.GetMethod("TryCreateFromUserProfileLanguages").Invoke(null, null);
        } else {
          var langT = WinRT("Windows.Globalization.Language", "Windows.Globalization");
          object l;
          try { l = Activator.CreateInstance(langT, t); } catch { continue; }
          e = engineT.GetMethod("TryCreateFromLanguage").Invoke(null, new[] { l });
        }
        Engines[t] = e;
        if (e != null) { used = Tag(e); return e; }
      }
      throw new GuiError("GUI_OCR_UNAVAILABLE", "No OCR language is installed on this PC");
    }

    static string Tag(object engine) {
      var l = engine.GetType().GetProperty("RecognizerLanguage").GetValue(engine, null);
      return Convert.ToString(l.GetType().GetProperty("LanguageTag").GetValue(l, null));
    }

    static double D(object o, string p) { return Convert.ToDouble(o.GetType().GetProperty(p).GetValue(o, null)); }

    public static List<OcrSegment> Read(Bitmap bmp, string lang, out string used) {
      try {
        return ReadInner(bmp, lang, out used);
      } catch (TargetInvocationException e) {
        throw new GuiError("GUI_OCR_UNAVAILABLE", "OCR failed: " + (e.InnerException != null ? e.InnerException.Message : e.Message));
      } catch (AggregateException e) {
        throw new GuiError("GUI_OCR_UNAVAILABLE", "OCR failed: " + e.InnerException.Message);
      }
    }

    static List<OcrSegment> ReadInner(Bitmap bmp, string lang, out string used) {
      object engine = Engine(lang, out used);
      var engineT = engine.GetType();
      byte[] png;
      using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); png = ms.ToArray(); }
      var ras = Type.GetType("System.IO.WindowsRuntimeStreamExtensions, " + WRT, true)
        .GetMethod("AsRandomAccessStream", new[] { typeof(Stream) }).Invoke(null, new object[] { new MemoryStream(png) });
      var decT = WinRT("Windows.Graphics.Imaging.BitmapDecoder", "Windows.Graphics");
      var decoder = Call(decT.GetMethod("CreateAsync", new[] { WinRT("Windows.Storage.Streams.IRandomAccessStream", "Windows.Storage") }), null, ras);
      var soft = Call(decT.GetMethod("GetSoftwareBitmapAsync", Type.EmptyTypes), decoder);
      var result = Call(WinRT("Windows.Media.Ocr.OcrEngine", "Windows.Media").GetMethod("RecognizeAsync"), engine, soft);
      var segments = new List<OcrSegment>();
      foreach (var line in (System.Collections.IEnumerable)result.GetType().GetProperty("Lines").GetValue(result, null)) {
        // Một dòng OCR hay gộp nhiều nút cạnh nhau ("Save As   Cancel") → tách thành cụm khi khoảng trống giữa hai từ lớn hơn ~1 chiều cao chữ.
        OcrSegment cur = null;
        double lastRight = 0;
        foreach (var w in (System.Collections.IEnumerable)line.GetType().GetProperty("Words").GetValue(line, null)) {
          var r = w.GetType().GetProperty("BoundingRect").GetValue(w, null);
          var rect = new System.Windows.Rect(D(r, "X"), D(r, "Y"), D(r, "Width"), D(r, "Height"));
          string text = Convert.ToString(w.GetType().GetProperty("Text").GetValue(w, null));
          if (cur != null && rect.X - lastRight > Math.Max(8, Math.Max(rect.Height, cur.Rect.Height))) { segments.Add(cur); cur = null; }
          if (cur == null) cur = new OcrSegment { Text = text, Rect = rect };
          else { cur.Text += " " + text; cur.Rect = System.Windows.Rect.Union(cur.Rect, rect); }
          lastRight = rect.Right;
        }
        if (cur != null) segments.Add(cur);
      }
      return segments;
    }
  }
}
`;

export const WINDOWS_HOST_CSHARP = MAIN_CSHARP + OFFICE_CSHARP;

/** Script PowerShell: nạp DLL đã dịch (nếu có), không thì dịch từ mã C# rồi lưu DLL; sau đó chạy vòng đọc/ghi JSON. */
export const WINDOWS_HOST_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$dll = $env:AIVIN_GUI_DLL
$src = $env:AIVIN_GUI_SRC
$refs = @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions')
if ($dll -and (Test-Path -LiteralPath $dll)) {
  Add-Type -Path $dll
} else {
  foreach ($r in $refs) { Add-Type -AssemblyName $r }
  if ($dll) {
    Add-Type -TypeDefinition ([IO.File]::ReadAllText($src)) -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library
    Add-Type -Path $dll
  } else {
    Add-Type -TypeDefinition ([IO.File]::ReadAllText($src)) -ReferencedAssemblies $refs
  }
}
foreach ($r in $refs) { Add-Type -AssemblyName $r }
[AivinGui.Host]::Run()
`;
