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
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] public static extern int AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder outStr, ref uint outLen);
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
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
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
    [DllImport("user32.dll")] public static extern IntPtr RealChildWindowFromPoint(IntPtr parent, POINT clientPoint);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public uint cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeoutPtr(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int pos);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int pos);
    [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr menu, uint id, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint id, StringBuilder text, int max, uint flags);
    [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hWnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object acc);
    [DllImport("oleacc.dll")] public static extern int AccessibleChildren(Accessibility.IAccessible container, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children, out int obtained);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  }

  public class Host {
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x1, MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10;
    const uint MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
    static readonly object OutputLock = new object();
    static readonly object StateLock = new object();
    static readonly HashSet<string> CancelledIds = new HashSet<string>();
    static readonly HashSet<string> ActiveWaits = new HashSet<string>();
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
    /** Thao tác đang chạy có kiểm người dùng không (giữ suốt thao tác — pendingInputCheck chỉ cho lần kiểm đầu). */
    static bool userInputCheck = false;
    static long inputGraceMs = 1500;
    /** Giữa các lô gõ: input mới hơn lô AI vừa phát quá ngưỡng này (ms) = của người dùng (lô của AI xử lý xong trong vài ms). */
    const int BATCH_USER_INPUT_MARGIN_MS = 60;
    const int TYPE_BATCH_PAUSE_MS = 80;
    /** Điểm màn hình thật của lần bấm / cuộn / kéo chuột vừa rồi (tính SAU khi đưa cửa sổ lên) — cho screen_point. */
    static Dictionary<string, object> lastMousePoint = null;

    /** Thao tác này chỉ được chạy nền (method "background"): tới bước cần chuột / phím thật thì dừng. */
    static bool backgroundOnly = false;

    /**
     * Cửa duy nhất trước khi đụng chuột / phím thật (10/11/2026, user: "sao lại chiếm quyền điều khiển của user"). Có người vừa dùng máy thì
     * báo GUI_PERSON_PRESENT, chưa làm gì; phía Node chờ họ ngừng tay rồi thử lại.
     */
    static void GuardInput() {
      if (backgroundOnly) throw new GuiError("GUI_NEEDS_REAL_INPUT", "This action needs the real mouse/keyboard");
      if (!pendingInputCheck) return;
      pendingInputCheck = false;
      long idle = UserIdleMs();
      if (idle < inputGraceMs) throw new GuiError("GUI_PERSON_PRESENT", "The person at this computer used the mouse/keyboard " + idle + " ms ago — this action needs the real mouse/keyboard");
    }

    /**
     * Gõ dài nhiều lô (02/11/2026): người dùng chen vào giữa chừng → dừng. Kiểm con trỏ dời chỗ (gõ phím không di chuột) và input mới hơn lô
     * cuối của AI quá BATCH_USER_INPUT_MARGIN_MS (UserIdleMs coi mọi input trong 150 ms sau lô AI là của AI → không thấy người gõ chen).
     */
    static bool UserTouchedSince(Native.POINT cursorAtStart) {
      Native.POINT now;
      if (Native.GetCursorPos(out now) && (now.X != cursorAtStart.X || now.Y != cursorAtStart.Y)) return true;
      var info = new Native.LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
      if (!Native.GetLastInputInfo(ref info) || lastInjectedTick == 0) return false;
      return (int)(info.dwTime - lastInjectedTick) > BATCH_USER_INPUT_MARGIN_MS;
    }

    static void MoveCursor(int x, int y) { GuardInput(); Native.SetCursorPos(x, y); }

    /**
     * Di chuột bằng SendInput (toạ độ tuyệt đối trên màn hình ảo) — sinh sự kiện di chuyển thật như chuột người. SetCursorPos chỉ đặt vị trí:
     * ứng dụng nhận input kiểu pointer (Paint mới, canvas XAML / WinUI) không thấy nét kéo (gui-bench 13/11/2026: kéo trên Paint không vẽ gì).
     */
    static void MoveCursorInput(int x, int y) {
      GuardInput();
      var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
      int nx = (int)Math.Round((x - vs.Left) * 65535.0 / Math.Max(1, vs.Width - 1));
      int ny = (int)Math.Round((y - vs.Top) * 65535.0 / Math.Max(1, vs.Height - 1));
      Send(new[] { MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0) });
    }

    public static void Run() {
      try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
      // Host trước bị giết giữa lúc mở tệp → Excel / Word ẩn nó tạo còn sống, giữ khoá tệp: dọn (chỉ bản chắc chắn do host tạo).
      try { Office.CleanupOrphans(); } catch { }
      var t = new Thread(Loop);
      t.SetApartmentState(ApartmentState.MTA);
      t.Start();
      t.Join();
    }

    static void WriteLineSafe(StreamWriter output, Dictionary<string, object> res) {
      string line = Json.Serialize(res);
      lock (OutputLock) { output.WriteLine(line); }
    }

    static bool IsCancelled(string reqId) {
      if (string.IsNullOrEmpty(reqId)) return false;
      lock (CancelledIds) { return CancelledIds.Contains(reqId); }
    }

    static void ExecuteAndWrite(StreamWriter output, object id, string op, Dictionary<string, object> args) {
      var res = new Dictionary<string, object>();
      try {
        res["result"] = Dispatch(op, args);
        res["ok"] = true;
      } catch (GuiError e) {
        res["ok"] = false; res["code"] = e.Code; res["error"] = e.Message;
      } catch (ElementNotAvailableException e) {
        res["ok"] = false; res["code"] = "GUI_STALE_NODE"; res["error"] = "Element is gone: " + e.Message;
      } catch (Exception e) {
        res["ok"] = false; res["code"] = "EXECUTION_FAILED"; res["error"] = e.GetType().Name + ": " + e.Message;
      }
      res["id"] = id;
      WriteLineSafe(output, res);
    }

    static void Loop() {
      var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
      output.AutoFlush = true;
      WriteLineSafe(output, new Dictionary<string, object> { { "ready", true } });
      string line;
      while ((line = input.ReadLine()) != null) {
        if (line.Trim().Length == 0) continue;
        object id = null;
        try {
          var req = (Dictionary<string, object>)Json.DeserializeObject(line);
          string cancelId = Str(req, "cancel");
          if (!string.IsNullOrEmpty(cancelId)) {
            lock (CancelledIds) { if (ActiveWaits.Contains(cancelId)) CancelledIds.Add(cancelId); }
            continue;
          }
          id = Get(req, "id");
          string op = Str(req, "op");
          var args = Get(req, "args") as Dictionary<string, object>;
          if (args == null) args = new Dictionary<string, object>();
          args["__req_id"] = id == null ? null : Convert.ToString(id);
          // wait_for / ping / idle chỉ đọc trạng thái → chạy trên luồng MTA riêng để wait_for (chờ tới 60s) không chặn observe / act / windows.
          if (op == "wait_for" || op == "ping" || op == "idle") {
            object reqId = id;
            string reqOp = op;
            var reqArgs = args;
            string reqIdStr = id == null ? null : Convert.ToString(id);
            if (op == "wait_for" && !string.IsNullOrEmpty(reqIdStr)) { lock (CancelledIds) { ActiveWaits.Add(reqIdStr); } }
            var worker = new Thread(delegate () { try { ExecuteAndWrite(output, reqId, reqOp, reqArgs); } finally { if (reqOp == "wait_for" && !string.IsNullOrEmpty(reqIdStr)) { lock (CancelledIds) { ActiveWaits.Remove(reqIdStr); CancelledIds.Remove(reqIdStr); } } } });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            continue;
          }
          ExecuteAndWrite(output, id, op, args);
        } catch (Exception e) {
          var errRes = new Dictionary<string, object> { { "id", id }, { "ok", false }, { "code", "EXECUTION_FAILED" }, { "error", e.GetType().Name + ": " + e.Message } };
          WriteLineSafe(output, errRes);
        }
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
          long contentWait = Bool(a, "wait_content", false) ? WaitForUwpContent(h, 3000) : 0;
          bool restored = false;
          IntPtr fgNow = Native.GetForegroundWindow();
          if (prev != IntPtr.Zero && fgNow != prev && TookForeground(fgNow, h)) {
            restored = RestoreForeground(prev, h);
            // Ứng dụng Store không nhường bằng cách gắn luồng input → cách của gui.focus; lúc này focus đang ở ứng dụng AI vừa mở, phím Alt không rơi vào việc của người dùng.
            if (!restored) { try { restored = ForceForeground(prev); } catch (GuiError) { } }
          }
          SendToBack(h);
          return new Dictionary<string, object> { { "sent_to_back", true }, { "focus_returned_to_user", restored }, { "content_wait_ms", contentWait } };
        }
        case "act": return Act(a);
        case "read_table": return ReadTable(a);
        case "ocr": return OcrSnapshot(a);
        case "wait_for": return WaitFor(a);
        case "office": return Office.Run(a);
        case "idle": return new Dictionary<string, object> { { "idle_ms", IdleMs() }, { "user_idle_ms", UserIdleMs() } };
        case "assoc": return Assoc(Str(a, "ext"));
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

    /**
     * Lệnh mà Windows sẽ chạy khi mở tệp có đuôi này bằng verb mặc định (cùng cách explorer.exe / ShellExecute chọn — kể cả khi ProgID mặc định
     * hỏng và Windows rơi về verb đầu tiên còn lại, vd "Open with AIVIN Office Suite" ở SystemFileAssociations). Không có liên kết → command rỗng.
     */
    static Dictionary<string, object> Assoc(string ext) {
      if (string.IsNullOrEmpty(ext)) throw new GuiError("INVALID_ARGS", "ext is required");
      if (ext[0] != '.') ext = "." + ext;
      return new Dictionary<string, object> { { "command", AssocString(ext, 1) }, { "executable", AssocString(ext, 2) } };
    }

    static string AssocString(string ext, int which) {
      uint len = 2048;
      var sb = new StringBuilder((int)len);
      // ASSOCF_NOTRUNCATE (0x20); which: ASSOCSTR_COMMAND = 1, ASSOCSTR_EXECUTABLE = 2.
      return Native.AssocQueryString(0x20, which, ext, null, sb, ref len) == 0 ? sb.ToString() : "";
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

    static IntPtr ResolveWindow(Dictionary<string, object> a) { return ResolveWindow(a, false); }

    /**
     * Cửa sổ theo handle, hoặc tìm theo tiêu đề / tên tiến trình (chứa, không phân biệt hoa thường); không có → cửa sổ đang focus (chỉ cho
     * thao tác đọc). forInput (act không node_id, 02/11/2026): không nêu cửa sổ thì KHÔNG lấy cửa sổ đang focus — người dùng có thể vừa
     * chuyển sang cửa sổ khác, phím / chuột rơi nhầm chỗ. Ngoại lệ: hỏi từ linh vật → cửa sổ chủ máy dùng ngay trước đó ("fallback").
     */
    static IntPtr ResolveWindow(Dictionary<string, object> a, bool forInput) {
      string w = Str(a, "window");
      IntPtr h = ParseWindow(w);
      if (h != IntPtr.Zero) {
        if (!Native.IsWindow(h)) throw new GuiError("GUI_WINDOW_GONE", "Window no longer exists: " + w);
        return h;
      }
      if (!string.IsNullOrEmpty(w)) {
        string q = w.ToLowerInvariant();
        // Cửa sổ chính trước, rồi tới hộp thoại con (Save as, Options…) — nêu tiêu đề hộp thoại phải tìm được nó.
        foreach (bool withDialogs in new[] { false, true }) {
          foreach (Dictionary<string, object> info in ListWindows(withDialogs)) {
            if (Convert.ToString(info["title"]).ToLowerInvariant().Contains(q) || Convert.ToString(info["process"]).ToLowerInvariant() == q) {
              return ParseWindow(Convert.ToString(info["window"]));
            }
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
          if (back != IntPtr.Zero && Native.IsWindow(back)) return back;
          if (forInput) throw new GuiError("INVALID_ARGS", "Name the window for this action (window: handle 0x… or a title/process)");
          return IntPtr.Zero;
        }
      }
      if (forInput) throw new GuiError("INVALID_ARGS", "Name the window for this action (window: handle 0x… or a title/process) — input is never sent to whatever window happens to be focused");
      return fg;
    }

    /** Tiêu điểm đang ở ứng dụng vừa mở. Mọi ứng dụng Store chung tiến trình ApplicationFrameHost nên phải so đúng cửa sổ, kẻo giật focus khỏi ứng dụng Store người dùng vừa chuyển sang. */
    static bool TookForeground(IntPtr fg, IntPtr h) {
      if (fg == IntPtr.Zero || h == IntPtr.Zero) return false;
      if (ClassOf(h) == "ApplicationFrameWindow") return fg == h;
      uint pa, pb; Native.GetWindowThreadProcessId(fg, out pa); Native.GetWindowThreadProcessId(h, out pb);
      return pa != 0 && pa == pb;
    }

    /** Ứng dụng Store: khung ApplicationFrameWindow có trước, nội dung (CoreWindow) gắn vào sau; lúc đang khởi động / bị treo tạm thì chưa có. */
    static bool IsUwpFrameOnly(IntPtr h) {
      if (ClassOf(h) != "ApplicationFrameWindow") return false;
      // Chỉ còn thanh tiêu đề + lớp nhận input của khung. Ứng dụng không dùng CoreWindow (Sticky Notes…) vẫn có cửa sổ con khác.
      for (IntPtr c = Native.FindWindowEx(h, IntPtr.Zero, null, null); c != IntPtr.Zero; c = Native.FindWindowEx(h, c, null, null)) {
        string cls = ClassOf(c);
        if (cls != "ApplicationFrameTitleBarWindow" && cls != "ApplicationFrameInputSinkWindow") return false;
      }
      return true;
    }

    /** Đẩy ứng dụng Store xuống quá sớm thì nó có thể bị treo tạm khi chưa dựng xong nội dung — chờ nội dung gắn vào khung (có giới hạn). */
    static long WaitForUwpContent(IntPtr h, int timeoutMs) {
      var sw = Stopwatch.StartNew();
      while (IsUwpFrameOnly(h) && sw.ElapsedMilliseconds < timeoutMs) Thread.Sleep(100);
      return sw.ElapsedMilliseconds;
    }

    /** Đẩy cửa sổ xuống đáy chồng cửa sổ, không kích hoạt — nằm dưới cửa sổ người dùng, thao tác theo pattern vẫn chạy được. */
    static void SendToBack(IntPtr h) {
      if (h == IntPtr.Zero || !Native.IsWindow(h)) return;
      // SWP_ASYNCWINDOWPOS: cửa sổ của ứng dụng đang treo thì lệnh đồng bộ sẽ chờ tới khi nó hết treo.
      Native.SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010 | 0x4000);
    }

    /** Cửa sổ trên cùng bị thao tác vừa rồi đổi đi → đưa cửa sổ cũ lên lại (gắn luồng input tạm, không phát phím giả). */
    static bool RestoreForeground(IntPtr prev, IntPtr target) {
      IntPtr cur = Native.GetForegroundWindow();
      if (prev == IntPtr.Zero || cur == prev || prev == target || !Native.IsWindow(prev)) return false;
      uint pid;
      uint curThread = Native.GetWindowThreadProcessId(cur, out pid);
      uint me = Native.GetCurrentThreadId();
      bool attached = curThread != 0 && curThread != me && IsWindowResponsive(cur, 200) && Native.AttachThreadInput(me, curThread, true);
      try { Native.SetForegroundWindow(prev); } finally { if (attached) Native.AttachThreadInput(me, curThread, false); }
      return Native.GetForegroundWindow() == prev;
    }

    const uint GA_ROOT = 2, GA_ROOTOWNER = 3;
    const int GWL_STYLE = -16;
    const int WS_POPUP = unchecked((int)0x80000000), WS_CAPTION = 0x00C00000;

    static IntPtr RootOf(IntPtr h) {
      if (h == IntPtr.Zero) return IntPtr.Zero;
      IntPtr r = Native.GetAncestor(h, GA_ROOT);
      return r == IntPtr.Zero ? h : r;
    }

    static IntPtr RootOwnerOf(IntPtr h) {
      if (h == IntPtr.Zero) return IntPtr.Zero;
      IntPtr r = Native.GetAncestor(h, GA_ROOTOWNER);
      return r == IntPtr.Zero ? RootOf(h) : r;
    }

    /** w thuộc cửa sổ đích: cùng cửa sổ gốc, hoặc hộp thoại / popup cùng cây sở hữu (hộp thoại modal của đích lên trên cùng là đúng). */
    static bool BelongsTo(IntPtr w, IntPtr target) {
      if (w == IntPtr.Zero || target == IntPtr.Zero) return false;
      IntPtr tr = RootOf(target), wr = RootOf(w);
      if (wr == tr) return true;
      IntPtr two = RootOwnerOf(target), wo = RootOwnerOf(w);
      return wo == tr || wo == two || wr == two;
    }

    /** Điểm màn hình (x, y) hiện đang thuộc cửa sổ đích — không bị cửa sổ khác che. Menu Win32 / popup không khung cùng tiến trình cũng tính. */
    static bool PointOnWindow(int x, int y, IntPtr target) {
      var p = new Native.POINT { X = x, Y = y };
      IntPtr hit = Native.WindowFromPoint(p);
      if (BelongsTo(hit, target)) return true;
      IntPtr root = RootOf(hit);
      if (root == IntPtr.Zero) return false;
      uint hp, tp;
      Native.GetWindowThreadProcessId(root, out hp);
      Native.GetWindowThreadProcessId(target, out tp);
      if (hp != tp) return false;
      int style = Native.GetWindowLong(root, GWL_STYLE);
      return ClassOf(root) == "#32768" || ((style & WS_POPUP) != 0 && (style & WS_CAPTION) != WS_CAPTION);
    }

    /** Bấm chuột thật: điểm bị cửa sổ khác che → không bấm (bấm sẽ rơi vào cửa sổ đang che, có thể là việc riêng của người dùng). */
    static void AssertPointOnWindow(int x, int y, IntPtr target) {
      if (PointOnWindow(x, y, target)) return;
      IntPtr hit = Native.WindowFromPoint(new Native.POINT { X = x, Y = y });
      uint pid = 0;
      if (hit != IntPtr.Zero) Native.GetWindowThreadProcessId(hit, out pid);
      // Hộp Windows Security làm tối cả màn hình bằng một lớp phủ: nói thẳng nguyên nhân để Planner hỏi người dùng thay vì thử lại.
      if (hit != IntPtr.Zero && ClassOf(RootOf(hit)) == "Shell_SystemDim") {
        throw new GuiError("GUI_FOCUS_LOST", "A Windows Security prompt is covering the screen — nothing was clicked. Ask the person at this computer to answer it, or use an accessibility action (click by node_id / set_value)");
      }
      string who = pid == 0 ? "nothing" : ProcessName(pid);
      throw new GuiError("GUI_FOCUS_LOST", "Another window (" + who + ") is on top of the target point — nothing was clicked. Observe again, or use an accessibility action (click by node_id / set_value)");
    }

    /**
     * Đưa cửa sổ lên trên cùng (khôi phục nếu thu nhỏ). Trả true khi cửa sổ trên cùng đúng là đích (hoặc hộp thoại của nó) — Windows có thể từ
     * chối SetForegroundWindow (tiến trình khác vừa có input, khoá đổi cửa sổ) mà không báo lỗi (02/11/2026: trước đây vẫn gõ / bấm tiếp).
     */
    static bool ForceForeground(IntPtr h) {
      if (h == IntPtr.Zero) return false;
      if (Native.GetForegroundWindow() == h && !Native.IsIconic(h)) {
        // Đang là cửa sổ được focus nhưng có thể đã bị SendToBack đẩy xuống đáy chồng (cửa sổ AI vừa mở / vừa thao tác) — vẫn bị cửa sổ khác che,
        // chuột thật sẽ GUI_FOCUS_LOST (gui-bench 13/11/2026). Đưa lên trên cùng; không đổi focus nên không cần mẹo phím Alt.
        Native.BringWindowToTop(h);
        Native.SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010);
        Thread.Sleep(30);
        return true;
      }
      GuardInput();
      if (Native.IsIconic(h)) { Native.ShowWindow(h, 9); Thread.Sleep(120); }
      if (Native.GetForegroundWindow() == h) return true;
      // Windows chỉ cho đổi cửa sổ trước khi tiến trình vừa có input → nhấn nhả Alt (không tạo ký tự) rồi đặt.
      KeyTap(0x12);
      Native.SetForegroundWindow(h);
      Native.BringWindowToTop(h);
      Thread.Sleep(80);
      if (BelongsTo(Native.GetForegroundWindow(), h)) return true;
      // Lần 2: gắn tạm luồng input với cửa sổ đang ở trên cùng rồi đặt lại.
      IntPtr cur = Native.GetForegroundWindow();
      uint pid;
      uint curThread = cur == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(cur, out pid);
      uint me = Native.GetCurrentThreadId();
      bool attached = curThread != 0 && curThread != me && Native.AttachThreadInput(me, curThread, true);
      try { Native.SetForegroundWindow(h); Native.BringWindowToTop(h); } finally { if (attached) Native.AttachThreadInput(me, curThread, false); }
      Thread.Sleep(80);
      return BelongsTo(Native.GetForegroundWindow(), h);
    }

    /** Chuột / phím thật cần cửa sổ đích ở trên cùng; không đưa lên được → dừng, KHÔNG phát input vào cửa sổ đang ở trên. */
    static void RequireForeground(IntPtr h) {
      if (h == IntPtr.Zero) throw new GuiError("INVALID_ARGS", "Name the window for real mouse/keyboard input (window: handle 0x… or a title/process)");
      if (!ForceForeground(h)) {
        throw new GuiError("GUI_FOCUS_LOST", "Could not bring the target window to the front (Windows refused, or another window took focus) — nothing was clicked or typed. Prefer an accessibility action (set_value / click by node_id), or ask the user to switch to that window");
      }
    }

    /** Giữa lúc gõ / bấm phím: cửa sổ trên cùng vẫn là đích, không thì dừng (phím sẽ rơi vào cửa sổ khác). */
    static void AssertStillForeground(IntPtr h, string done) {
      if (h == IntPtr.Zero || BelongsTo(Native.GetForegroundWindow(), h)) return;
      throw new GuiError("GUI_FOCUS_LOST", "Another window took focus — stopped" + (string.IsNullOrEmpty(done) ? "" : " after " + done));
    }

    static object FocusWindowOp(Dictionary<string, object> a) {
      IntPtr h = ResolveWindow(a);
      backgroundOnly = false;
      inputGraceMs = Int(a, "user_input_grace_ms", 1500);
      pendingInputCheck = Bool(a, "check_user_input", false);
      try { ForceForeground(h); } finally { pendingInputCheck = false; }
      return new Dictionary<string, object> { { "focused", Native.GetForegroundWindow() == h }, { "window", WindowInfo(h, Native.GetForegroundWindow()) } };
    }

    // ── observe: cây trợ năng rút gọn + ảnh ─────────────────────────────────────────────────────

    static CacheRequest BuildCache() {
      var c = new CacheRequest();
      c.TreeScope = TreeScope.Element;
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

    class ObsItem { public AutomationElement E; public int Depth; public bool InChrome; }

    /**
     * Khung cửa sổ do hệ điều hành / khung ứng dụng vẽ: thanh tiêu đề, menu hệ thống ("System", AutomationId "Item 1"), nút thu nhỏ / phóng to /
     * đóng. gui-bench 13/11/2026: "bấm 1" khớp AutomationId "Item 1" của menu hệ thống và bấm bằng chuột thật mà vẫn báo ok; "System" của Settings
     * mơ hồ với menu hệ thống. Đánh dấu "chrome" để chọn đích bỏ qua (trừ khi nói thẳng thu nhỏ / đóng…) và để không tính vào chất lượng cây.
     */
    static bool IsChromeRoot(Dictionary<string, object> n) {
      string role = Convert.ToString(n["role"]);
      string aid = n.ContainsKey("automation_id") ? Convert.ToString(n["automation_id"]) : "";
      string cls = n.ContainsKey("class") ? Convert.ToString(n["class"]) : "";
      return role == "titlebar" || aid == "TitleBar" || aid == "SystemMenuBar" || cls == "ApplicationFrameTitleBarWindow";
    }

    /** Trong vùng khung: chỉ phần tử của chính khung là chrome — tab / ô tìm kiếm ứng dụng tự đặt lên thanh tiêu đề (Explorer, Edge) vẫn là nội dung. */
    static bool IsChromeNode(Dictionary<string, object> n) {
      if (IsChromeRoot(n)) return true;
      string role = Convert.ToString(n["role"]);
      string aid = n.ContainsKey("automation_id") ? Convert.ToString(n["automation_id"]) : "";
      return role == "menubar" || role == "menuitem" || IsCaptionButton(n);
    }

    /**
     * Nút thu nhỏ / phóng to / đóng của khung (ứng dụng Store có thêm một bộ ngoài thanh tiêu đề). Theo AutomationId (tên đổi theo ngôn ngữ:
     * "Thu nhỏ", "Đóng"). Nút "Close" riêng của ứng dụng có cùng AutomationId cũng bị tính là khung — vô hại: nói "đóng / close" là vẫn chọn được.
     */
    static bool IsCaptionButton(Dictionary<string, object> n) {
      if (Convert.ToString(n["role"]) != "button" || !n.ContainsKey("automation_id")) return false;
      string aid = Convert.ToString(n["automation_id"]);
      return aid == "Minimize" || aid == "Maximize" || aid == "Restore" || aid == "Close";
    }

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

    const int FIND_ELEMENT_BUDGET_MS = 3000, OBSERVE_BUDGET_MS = 5000, LIST_BUDGET_MS = 1500, MAX_CHILDREN_PER_NODE = 80, MAX_OFFSCREEN_CHILDREN = 15;
    static readonly CacheRequest Lean = BuildLeanCache();
    static CacheRequest BuildLeanCache() {
      var c = new CacheRequest();
      c.TreeScope = TreeScope.Element;
      c.TreeFilter = Automation.ControlViewCondition;
      c.Add(AutomationElement.IsOffscreenProperty);
      return c;
    }

    /**
     * Con của một phần tử. Khung thường dùng FindAll (nhanh hơn đi từng bước nhiều lần). Bảng / danh sách đi từng bước để dừng được giữa chừng:
     * FindAll không huỷ được, và trên bảng dài (DataGridView qua cầu MSAA) mất hàng chục giây. Mỗi danh sách chỉ được dùng một phần ngân sách,
     * để các nút nằm sau bảng vẫn đọc được. Dòng đã cuộn khuất chỉ giữ một phần và không tính vào trần: cuộn xuống sâu thì các dòng đầu đều khuất,
     * dừng ở chúng sẽ không bao giờ thấy dòng đang hiện.
     */
    static List<AutomationElement> ChildrenOf(AutomationElement e, string role, CacheRequest cache, TreeWalker walker, Stopwatch sw, int budgetMs, ref bool cut) {
      var kids = new List<AutomationElement>();
      if (role != "table" && role != "datagrid" && role != "list" && role != "tree") {
        try {
          using (cache.Activate()) { foreach (AutomationElement k in e.FindAll(TreeScope.Children, Condition.TrueCondition)) kids.Add(k); }
        } catch { /* phần tử vừa mất giữa chừng */ }
        return kids;
      }
      long stopAt = Math.Min(sw.ElapsedMilliseconds + LIST_BUDGET_MS, budgetMs);
      var visible = new List<AutomationElement>();
      var hidden = new List<AutomationElement>();
      try {
        using (Lean.Activate()) {
          // Đi bằng bộ đệm chỉ có IsOffscreen: qua cầu MSAA mỗi thuộc tính là một lượt hỏi sang ứng dụng, đọc đủ cho từng dòng thì không đi tới được dòng đang hiện.
          AutomationElement k = walker.GetFirstChild(e, Lean);
          int visibleRun = 0;
          bool passedView = false;
          while (k != null) {
            if (visible.Count >= MAX_CHILDREN_PER_NODE || sw.ElapsedMilliseconds >= stopAt) { cut = true; break; }
            if (!true.Equals(Cached(k, AutomationElement.IsOffscreenProperty))) { visible.Add(k); if (++visibleRun >= 3) passedView = true; }
            else {
              visibleRun = 0;
              if (hidden.Count < MAX_OFFSCREEN_CHILDREN) hidden.Add(k);
              else {
                cut = true;
                // Đã qua vùng đang hiện (ít nhất 3 dòng liền nhau, không phải dòng tiêu đề lẻ) và đủ phần khuất: phía sau chỉ còn dòng khuất.
                if (passedView) break;
              }
            }
            k = walker.GetNextSibling(k, Lean);
          }
        }
      } catch { /* phần tử vừa mất giữa chừng: giữ phần đã đọc được */ }
      // Đọc đủ thuộc tính sau cùng, dòng đang hiện trước: hết giờ thì mất phần khuất chứ không mất phần người dùng đang thấy.
      using (cache.Activate()) {
        visible.AddRange(hidden);
        foreach (AutomationElement x in visible) {
          if (sw.ElapsedMilliseconds >= budgetMs) { cut = true; break; }
          try { kids.Add(x.GetUpdatedCache(cache)); } catch { /* dòng vừa mất */ }
        }
      }
      return kids;
    }

    /**
     * Cửa sổ đang bị một hộp thoại modal của chính nó khoá (MessageBox "Xoá phiếu?", "Lưu thay đổi?", hộp Lưu thành): hộp thoại là cửa sổ riêng
     * nên không có trong cây của cửa sổ chính — tìm "Không" / "No" trong cửa sổ chính không bao giờ thấy, mà cửa sổ chính thì không nhận thao
     * tác nào. Trả hộp thoại đó (GW_ENABLEDPOPUP) để observe / find / gui.do làm việc thẳng trên nó; không có → IntPtr.Zero.
     */
    static IntPtr ModalPopupOf(IntPtr h) {
      if (h == IntPtr.Zero || Native.IsWindowEnabled(h)) return IntPtr.Zero;
      IntPtr p = Native.GetWindow(h, 6);
      return p != IntPtr.Zero && p != h && Native.IsWindowVisible(p) ? p : IntPtr.Zero;
    }

    static object Observe(Dictionary<string, object> a) {
      IntPtr h = ResolveWindow(a);
      if (h == IntPtr.Zero) throw new GuiError("NOT_FOUND", "No window is focused");
      IntPtr blockedOwner = IntPtr.Zero;
      IntPtr modal = ModalPopupOf(h);
      if (modal != IntPtr.Zero) { blockedOwner = h; h = modal; }
      int maxNodes = Math.Max(20, Math.Min(Int(a, "max_nodes", 300), 1500));
      int maxDepth = Math.Max(2, Math.Min(Int(a, "max_depth", 25), 60));
      int budgetMs = Math.Max(500, Math.Min(Int(a, "budget_ms", OBSERVE_BUDGET_MS), 30000));
      var sw = Stopwatch.StartNew();
      AssertWindowResponsive(h);
      if (Native.IsIconic(h)) {
        IntPtr fgBefore = Native.GetForegroundWindow();
        Native.ShowWindow(h, 4);
        if (fgBefore != IntPtr.Zero && fgBefore != h) {
          RestoreForeground(fgBefore, h);
          SendToBack(h);
        }
        Thread.Sleep(60);
      }
      AutomationElement root = AutomationElement.FromHandle(h);
      var cache = BuildCache();
      var nodes = new List<object>();
      var map = new Dictionary<int, AutomationElement>();
      int snap = ++snapSeq;
      Native.RECT wr; Native.GetWindowRect(h, out wr);
      var winRect = new System.Windows.Rect(wr.Left, wr.Top, Math.Max(1, wr.Right - wr.Left), Math.Max(1, wr.Bottom - wr.Top));
      int named = 0, interactive = 0;
      bool truncated = false;
      var queue = new Queue<ObsItem>();
      using (cache.Activate()) {
        root = root.GetUpdatedCache(cache);
      }
      queue.Enqueue(new ObsItem { E = root, Depth = 0 });
      var walker = new TreeWalker(Automation.ControlViewCondition);
      bool timedOut = false, listCut = false;
      var unreached = new List<AutomationElement>();
      while (queue.Count > 0) {
        if (nodes.Count >= maxNodes) { truncated = true; break; }
        if (sw.ElapsedMilliseconds >= budgetMs) { truncated = true; timedOut = true; break; }
        var item = queue.Dequeue();
        AutomationElement e = item.E;
        int idx = nodes.Count;
        var n = Describe(e, snap + "." + idx, item.Depth, winRect);
        bool inChrome = item.InChrome || IsChromeRoot(n);
        bool chrome = (inChrome && IsChromeNode(n)) || IsCaptionButton(n);
        if (chrome) n["chrome"] = true;
        // Ngoài màn hình và không có chữ → bỏ (danh sách dài cuộn ẩn), vẫn đi vào con nếu là khung chứa.
        bool skip = n.ContainsKey("offscreen") && !n.ContainsKey("name") && item.Depth > 0;
        if (!skip) {
          map[idx] = e;
          nodes.Add(n);
          // Khung cửa sổ (thanh tiêu đề, menu hệ thống, nút thu nhỏ / đóng) không tính: cửa sổ vẽ tay hoàn toàn vẫn có đủ chừng ấy phần tử,
          // tính vào là chấm "good" và không bao giờ tự đọc chữ trên ảnh (gui-bench 13/11/2026).
          if (!chrome && n.ContainsKey("name")) named++;
          if (!chrome && IsInteractive(n)) interactive++;
        }
        if (item.Depth >= maxDepth) continue;
        bool thisCut = false;
        int visibleKids = 0;
        foreach (AutomationElement k in ChildrenOf(e, Convert.ToString(n["role"]), cache, walker, sw, budgetMs, ref thisCut)) {
          if (!true.Equals(Cached(k, AutomationElement.IsOffscreenProperty))) visibleKids++;
          queue.Enqueue(new ObsItem { E = k, Depth = item.Depth + 1, InChrome = inChrome });
        }
        if (thisCut) {
          listCut = true;
          // Không đi tới được dòng nào đang hiện (chỉ thấy dòng tiêu đề, thanh cuộn): bảng đã cuộn xa.
          if (visibleKids <= 2) unreached.Add(e);
        }
      }
      if (listCut) truncated = true;
      lock (StateLock) {
        Snapshots[snap] = map;
        SnapshotWindow[snap] = h;
        while (Snapshots.Count > KEEP_SNAPSHOTS) {
          int oldest = int.MaxValue;
          foreach (var k in Snapshots.Keys) if (k < oldest) oldest = k;
          Snapshots.Remove(oldest); SnapshotWindow.Remove(oldest); OcrSnapshots.Remove(oldest);
        }
      }
      foreach (AutomationElement list in unreached) AddVisibleRows(list, snap, nodes, wr, sw, budgetMs);
      // Cây nghèo: ít phần tử có tên / thao tác được (ứng dụng vẽ tay, canvas, Electron tắt trợ năng) → cần ảnh để định vị.
      // Ứng dụng Store mới chỉ có khung: thanh tiêu đề đủ phần tử để chấm "good" nhưng chưa có nội dung thật.
      bool frameOnly = IsUwpFrameOnly(h);
      string quality = (!frameOnly && interactive >= 3 && named >= 5) ? "good" : "poor";
      var res = new Dictionary<string, object> {
        { "snapshot", snap }, { "window", WindowInfo(h, Native.GetForegroundWindow()) }, { "nodes", nodes }, { "node_count", nodes.Count },
        { "interactive_count", interactive }, { "tree_quality", quality }, { "truncated", truncated }, { "tree_ms", sw.ElapsedMilliseconds },
        { "truncated_by", timedOut ? "time" : listCut ? "long_list" : truncated ? "node_limit" : null },
        { "dpi", (long)SafeDpi(h) },
      };
      if (frameOnly) res["content_unavailable"] = true;
      if (blockedOwner != IntPtr.Zero) res["modal_dialog_of"] = WindowInfo(blockedOwner, Native.GetForegroundWindow());
      bool wantImage = Bool(a, "include_image", false) || (quality == "poor" && Bool(a, "image_when_poor", true));
      // Cây nghèo → đọc chữ trên ảnh (OCR của Windows, chạy trên máy): mỗi cụm chữ thành một node "text" có toạ độ, thang quyết định đích
      // ở BE tìm được "nút Lưu" theo chữ như với phần tử thật thay vì đoán toạ độ trên ảnh.
      bool wantOcr = Bool(a, "ocr", quality == "poor");
      if (wantImage || wantOcr) {
        var sw2 = Stopwatch.StartNew();
        string imageError;
        var bmp = GrabWindow(h, out imageError);
        if (bmp == null) {
          res["image_error"] = imageError;
          if (wantOcr) res["ocr"] = new Dictionary<string, object> { { "error", "no usable screenshot: " + imageError } };
        } else {
          using (bmp) {
            if (wantImage) {
              res["image"] = EncodeImage(bmp, Int(a, "image_max_width", 1366), Int(a, "image_quality", 70));
              res["image_ms"] = sw2.ElapsedMilliseconds;
            }
            if (wantOcr) AddOcrNodes(res, nodes, snap, bmp, Str(a, "ocr_lang"), Int(a, "ocr_max_nodes", 200));
          }
        }
      }
      return res;
    }

    /**
     * Bảng dài đã cuộn xa: đi từng dòng qua cầu MSAA mất ~100 ms mỗi bước nên không tới được vùng đang hiện. Hỏi thẳng control dòng nào đang nằm ở
     * từng độ cao (accHitTest không xét cửa sổ đang che, nên dùng được cả khi AI làm dưới nền). Mỗi dòng thành một node cùng kiểu với chữ OCR
     * ("<snap>.t<k>"): có toạ độ, gui.act bấm được.
     */
    static void AddVisibleRows(AutomationElement list, int snap, List<object> nodes, Native.RECT wr, Stopwatch sw, int budgetMs) {
      Accessibility.IAccessible client = AccessibleClient(OwnHandle(list));
      object boxObj = Cached(list, AutomationElement.BoundingRectangleProperty);
      if (client == null || !(boxObj is System.Windows.Rect)) return;
      var box = (System.Windows.Rect)boxObj;
      if (box.IsEmpty || box.Height < 4) return;
      var known = new HashSet<string>();
      foreach (object o in nodes) {
        var d = (Dictionary<string, object>)o;
        if (d.ContainsKey("name") && !d.ContainsKey("offscreen")) known.Add(Convert.ToString(d["name"]));
      }
      var rects = new List<System.Windows.Rect>();
      lock (StateLock) { List<System.Windows.Rect> had; if (OcrSnapshots.TryGetValue(snap, out had)) rects = had; else OcrSnapshots[snap] = rects; }
      int added = 0;
      foreach (AccRow row in SampleRows(client, box, sw, budgetMs + 1000)) {
        if (added >= 60 || !known.Add(row.Name)) continue;
        var n = new Dictionary<string, object> {
          { "id", snap + ".t" + rects.Count }, { "role", "row" }, { "name", Clip(row.Name, 200) }, { "source", "accessible" },
          { "rect", new Dictionary<string, object> { { "x", row.Left - wr.Left }, { "y", row.Top - wr.Top }, { "w", row.Width }, { "h", row.Height } } },
        };
        if (!string.IsNullOrEmpty(row.Value)) n["value"] = Clip(row.Value, 400);
        lock (StateLock) { rects.Add(new System.Windows.Rect(row.Left - wr.Left, row.Top - wr.Top, row.Width, row.Height)); }
        nodes.Add(n);
        added++;
      }
    }

    class AccRow { public string Name, Value; public int Left, Top, Width, Height; }

    /** Các dòng đang hiện của một bảng, từ trên xuống, hỏi thẳng control. Control không trả lời được thì trả phần đã đọc. */
    static List<AccRow> SampleRows(Accessibility.IAccessible client, System.Windows.Rect box, Stopwatch sw, long stopAtMs) {
      var rows = new List<AccRow>();
      int x = (int)(box.Left + Math.Min(60, box.Width / 3));
      double y = box.Top + 2;
      try {
        while (y < box.Bottom && sw.ElapsedMilliseconds < stopAtMs) {
          object hit = client.accHitTest(x, (int)y);
          Accessibility.IAccessible row = hit as Accessibility.IAccessible ?? client;
          object child = hit is int ? hit : 0;
          if (ReferenceEquals(row, client) && child is int && (int)child == 0) { y += 8; continue; }
          // Trúng một ô: lấy cả dòng để có đủ các cột.
          if (Convert.ToInt32(row.get_accRole(child)) == ROLE_SYSTEM_CELL) {
            var parent = row.accParent as Accessibility.IAccessible;
            if (parent != null) { row = parent; child = 0; }
          }
          int left, top, w, h;
          row.accLocation(out left, out top, out w, out h, child);
          if (h <= 0) { y += 8; continue; }
          string name = row.get_accName(child);
          if (!string.IsNullOrEmpty(name) && (rows.Count == 0 || rows[rows.Count - 1].Name != name)) {
            string value = null;
            try { value = row.get_accValue(child); } catch (COMException) { }
            rows.Add(new AccRow { Name = name, Value = value, Left = left, Top = top, Width = w, Height = h });
          }
          y = Math.Max(y + 1, top + h + 1);
        }
      } catch (COMException) { } catch (ArgumentException) { } catch (InvalidCastException) { } catch (NotImplementedException) { }
      return rows;
    }

    const int READ_TABLE_BUDGET_MS = 20000;
    /**
     * Số nấc lăn liên tiếp không đổi gì mới coi là tới đầu / cuối bảng. Một nấc có thể bị bỏ qua vì người dùng đang giữ Shift hay nút chuột
     * (DataGridView tự kiểm phím thật): chạy thật 10/11/2026 dừng ở dòng 62/200 mà vẫn báo đã đọc hết.
     */
    const int READ_TABLE_STALL_NOTCHES = 8, READ_TABLE_STALL_WAIT_MS = 80;

    /** Lăn một nấc và chờ control xử lý xong, để lần đọc sau thấy đúng vị trí mới. */
    static bool Wheel(IntPtr control, int delta, IntPtr screenPoint) {
      IntPtr r;
      return Native.SendMessageTimeoutPtr(control, WM_MOUSEWHEEL, new IntPtr(delta << 16), screenPoint, SMTO_ABORTIFHUNG, 1000, out r) != IntPtr.Zero;
    }

    static string FirstDataRow(List<AccRow> page) {
      foreach (AccRow row in page) if (row.Value != row.Name) return row.Name;
      return null;
    }

    const int ROLE_SYSTEM_COLUMNHEADER = 0x19, ROLE_SYSTEM_ROWHEADER = 0x1A;

    /** Ô sâu nhất tại một điểm của bảng (bảng → dòng → ô). null = không trúng mục nào. */
    static Accessibility.IAccessible CellAt(Accessibility.IAccessible client, int x, int y) {
      var cell = client.accHitTest(x, y) as Accessibility.IAccessible;
      if (cell == null) return null;
      var deeper = cell.accHitTest(x, y) as Accessibility.IAccessible;
      return deeper ?? cell;
    }

    /**
     * Tên cột: dò ngang dòng tiêu đề, chỉ lấy ô tiêu đề cột. Ô ngay trên cột đầu dòng (dưới nó là tiêu đề hàng) không phải một cột, nên bỏ;
     * toạ độ dò theo bước nhỏ vì độ rộng các ô tiêu đề không phải control nào cũng báo đúng.
     */
    static List<object> ReadColumns(Accessibility.IAccessible client, System.Windows.Rect box, AccRow header) {
      var cols = new List<object>();
      try {
        int y = header.Top + header.Height / 2, below = header.Top + header.Height + 4;
        string last = null;
        for (double x = box.Left + 2; x < box.Right && cols.Count < 100; x += 12) {
          var cell = CellAt(client, (int)x, y);
          if (cell == null || Convert.ToInt32(cell.get_accRole(0)) != ROLE_SYSTEM_COLUMNHEADER) continue;
          var under = CellAt(client, (int)x, below);
          if (under != null && Convert.ToInt32(under.get_accRole(0)) == ROLE_SYSTEM_ROWHEADER) continue;
          string name = cell.get_accName(0);
          if (string.IsNullOrEmpty(name) || name == last) continue;
          cols.Add(Clip(name, 120));
          last = name;
        }
      } catch (COMException) { } catch (ArgumentException) { } catch (InvalidCastException) { } catch (NotImplementedException) { }
      return cols;
    }

    /**
     * Đọc cả bảng dưới nền: cuộn lên đầu, đọc dòng đang hiện, lăn một nấc, lặp tới khi hết dòng mới, rồi cuộn về chỗ cũ. Mỗi lần một nấc để các trang gối nhau;
     * hai trang liền nhau không có dòng chung (ứng dụng cuộn quá nhanh) thì báo gaps, không âm thầm bỏ sót.
     */
    const int ROLE_SYSTEM_ROW = 0x1C, ROLE_SYSTEM_LISTITEM = 0x22, ROLE_SYSTEM_OUTLINEITEM = 0x24;

    /**
     * Bảng MSAA (DataGridView, ListView Win32…) liệt kê được MỌI dòng — cả dòng đã cuộn khuất — qua AccessibleChildren, mỗi dòng một lần hỏi
     * tên + giá trị (giá trị = các ô nối bằng ";"). Không cuộn, không lấy mẫu theo toạ độ. gui-bench 13/11/2026: bảng 800 dòng cách cuộn +
     * accHitTest đọc được 104 dòng trong 20 s; cách này đọc hết. Control không liệt kê dòng kiểu đó (UIA thuần, ảo hoá) → null, đi đường cũ.
     */
    static Dictionary<string, object> ReadRowsByChildren(Accessibility.IAccessible client, System.Windows.Rect box, int maxRows, Stopwatch sw) {
      try {
        int count = client.accChildCount;
        if (count < 2 || count > 500000) return null;
        int take = Math.Min(count, maxRows + 2);
        var kids = new object[take];
        int got;
        if (Native.AccessibleChildren(client, 0, take, kids, out got) != 0 || got < 2) return null;
        var rows = new List<object>();
        List<object> columns = null;
        int rowish = 0;
        for (int i = 0; i < got && rows.Count < maxRows; i++) {
          if (sw.ElapsedMilliseconds >= READ_TABLE_BUDGET_MS) break;
          Accessibility.IAccessible acc = kids[i] as Accessibility.IAccessible;
          object child = 0;
          if (acc == null) { if (!(kids[i] is int)) continue; acc = client; child = kids[i]; }
          int role;
          try { role = Convert.ToInt32(acc.get_accRole(child)); } catch (COMException) { continue; } catch (ArgumentException) { continue; }
          if (role != ROLE_SYSTEM_ROW && role != ROLE_SYSTEM_LISTITEM && role != ROLE_SYSTEM_OUTLINEITEM) continue;
          rowish++;
          string name = null, value = null;
          try { name = acc.get_accName(child); } catch (COMException) { }
          try { value = acc.get_accValue(child); } catch (COMException) { } catch (NotImplementedException) { }
          if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(value)) continue;
          // Dòng tiêu đề (DataGridView "Top Row"): giá trị trùng tên như ở đường lấy mẫu — đọc tên cột từ đó.
          if (value == name && rowish == 1) {
            if (columns == null) {
              int left, top, w, h;
              try { acc.accLocation(out left, out top, out w, out h, child); columns = ReadColumns(client, box, new AccRow { Name = name, Value = value, Left = left, Top = top, Width = w, Height = h }); } catch (COMException) { }
            }
            continue;
          }
          rows.Add(Clip(string.IsNullOrEmpty(value) ? name : value, 800));
        }
        if (rows.Count < 1) return null;
        bool all = rowish >= count - 1 || rows.Count >= maxRows;
        return new Dictionary<string, object> {
          { "columns", columns ?? new List<object>() }, { "rows", rows }, { "row_count", rows.Count }, { "complete", rows.Count < maxRows && got >= count && all },
          { "reason", rows.Count >= maxRows ? "max_rows reached" : got < count ? "time limit reached" : null }, { "gaps", false }, { "ms", sw.ElapsedMilliseconds }, { "source", "children" },
        };
      } catch (COMException) { return null; } catch (InvalidCastException) { return null; } catch (NotImplementedException) { return null; }
    }

    /** Chọn dòng của bảng MSAA có một ô đúng bằng "text" (hoặc tên dòng trùng): chọn + nhận focus, control tự cuộn tới. */
    static bool SelectRowByValue(AutomationElement table, string text) {
      try {
        Accessibility.IAccessible client = AccessibleClient(OwnHandle(table));
        if (client == null) return false;
        int count = client.accChildCount;
        if (count < 1 || count > 500000) return false;
        var kids = new object[count];
        int got;
        if (Native.AccessibleChildren(client, 0, count, kids, out got) != 0) return false;
        string want = text.Trim();
        for (int i = 0; i < got; i++) {
          Accessibility.IAccessible acc = kids[i] as Accessibility.IAccessible;
          object child = 0;
          if (acc == null) { if (!(kids[i] is int)) continue; acc = client; child = kids[i]; }
          string name = null, value = null;
          try { name = acc.get_accName(child); } catch (COMException) { }
          try { value = acc.get_accValue(child); } catch (COMException) { } catch (NotImplementedException) { }
          bool hit = string.Equals(name, want, StringComparison.OrdinalIgnoreCase);
          if (!hit && !string.IsNullOrEmpty(value)) foreach (string cell in value.Split(';')) if (string.Equals(cell.Trim(), want, StringComparison.OrdinalIgnoreCase)) { hit = true; break; }
          if (!hit) continue;
          // Chọn ô đầu của dòng như người bấm vào dòng: DataGridView mới đổi dòng hiện hành (CurrentRow) — chọn cả dòng chỉ tô dòng,
          // dòng hiện hành vẫn là dòng cũ (gui-bench 13/11/2026). Dòng không có ô con → chọn dòng.
          if (child is int && (int)child == 0 && SelectFirstCell(acc)) return true;
          acc.accSelect(SELFLAG_TAKEFOCUS | SELFLAG_TAKESELECTION, child);
          return true;
        }
      } catch (COMException) { } catch (InvalidCastException) { } catch (NotImplementedException) { } catch (ArgumentException) { }
      return false;
    }

    static bool SelectFirstCell(Accessibility.IAccessible row) {
      try {
        int n = row.accChildCount;
        if (n < 1) return false;
        var cells = new object[Math.Min(n, 4)];
        int got;
        if (Native.AccessibleChildren(row, 0, cells.Length, cells, out got) != 0) return false;
        for (int i = 0; i < got; i++) {
          var cell = cells[i] as Accessibility.IAccessible;
          if (cell == null || Convert.ToInt32(cell.get_accRole(0)) != ROLE_SYSTEM_CELL) continue;
          cell.accSelect(SELFLAG_TAKEFOCUS | SELFLAG_TAKESELECTION, 0);
          // Lệnh mặc định của ô (DataGridView: đặt ô hiện hành) — accSelect chỉ tô chọn, chưa chắc đổi dòng hiện hành.
          string def = null;
          try { def = cell.get_accDefaultAction(0); } catch (COMException) { }
          if (!string.IsNullOrEmpty(def) && def.IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0) { try { cell.accDoDefaultAction(0); } catch (COMException) { } }
          return true;
        }
      } catch (COMException) { } catch (InvalidCastException) { } catch (NotImplementedException) { } catch (ArgumentException) { }
      return false;
    }

    static object ReadTable(Dictionary<string, object> a) {
      IntPtr window;
      AutomationElement el = NodeOf(Str(a, "node_id"), out window);
      AssertWindowResponsive(window);
      int maxRows = Math.Max(1, Math.Min(Int(a, "max_rows", 300), 2000));
      IntPtr control = OwnHandle(el);
      Accessibility.IAccessible client = AccessibleClient(control);
      System.Windows.Rect box = el.Current.BoundingRectangle;
      if (client == null || box.IsEmpty) throw new GuiError("GUI_NO_PATTERN", "This table cannot be read directly — use gui.observe / gui.find and scroll");
      var sw = Stopwatch.StartNew();
      var direct = ReadRowsByChildren(client, box, maxRows, sw);
      if (direct != null) return direct;
      bool canScroll = AcceptsPostedInput(control);
      var seen = new HashSet<string>();
      var rows = new List<object>();
      List<object> columns = null;
      bool gaps = false, endReached = false;
      int notches = 0, stale = 0, movedUp = 0;
      var lp = new IntPtr((((int)box.Top + 20 & 0xFFFF) << 16) | ((int)box.Left + 20 & 0xFFFF));
      HashSet<string> previous = null;
      // Bảng có thể đang cuộn dở: lên đầu trước, nhớ đã lên bao nhiêu nấc để trả về đúng chỗ.
      if (canScroll) {
        string top = FirstDataRow(SampleRows(client, box, sw, READ_TABLE_BUDGET_MS));
        int stalled = 0;
        while (top != null && movedUp < 2000 && stalled < READ_TABLE_STALL_NOTCHES && sw.ElapsedMilliseconds < READ_TABLE_BUDGET_MS / 2) {
          if (!Wheel(control, 120, lp)) break;
          string now = FirstDataRow(SampleRows(client, box, sw, READ_TABLE_BUDGET_MS));
          if (now == top) { stalled++; Thread.Sleep(READ_TABLE_STALL_WAIT_MS); continue; }
          stalled = 0;
          top = now;
          movedUp++;
        }
      }
      while (rows.Count < maxRows && sw.ElapsedMilliseconds < READ_TABLE_BUDGET_MS) {
        var page = SampleRows(client, box, sw, READ_TABLE_BUDGET_MS);
        var names = new HashSet<string>();
        int fresh = 0;
        bool overlap = false;
        foreach (AccRow row in page) {
          bool header = row.Value == row.Name;
          if (header) { if (columns == null) columns = ReadColumns(client, box, row); continue; }
          names.Add(row.Name);
          if (previous != null && previous.Contains(row.Name)) overlap = true;
          if (!seen.Add(row.Name)) continue;
          fresh++;
          if (rows.Count < maxRows) rows.Add(Clip(string.IsNullOrEmpty(row.Value) ? row.Name : row.Value, 800));
        }
        if (previous != null && previous.Count > 0 && names.Count > 0 && !overlap) gaps = true;
        previous = names;
        if (!canScroll) break;
        if (fresh == 0) {
          if (++stale >= READ_TABLE_STALL_NOTCHES) { endReached = true; break; }
          Thread.Sleep(READ_TABLE_STALL_WAIT_MS);
        } else stale = 0;
        if (!Wheel(control, -120, lp)) break;
        notches++;
      }
      if (canScroll) {
        for (int i = 0; i < notches; i++) if (!Wheel(control, 120, lp)) break;
        for (int i = 0; i < movedUp; i++) if (!Wheel(control, -120, lp)) break;
      }
      string reason = endReached ? null : !canScroll ? "this app cannot be scrolled in the background: only the rows on screen were read" : rows.Count >= maxRows ? "max_rows reached" : "time limit reached";
      return new Dictionary<string, object> {
        { "columns", columns ?? new List<object>() }, { "rows", rows }, { "row_count", rows.Count }, { "complete", endReached }, { "reason", reason }, { "gaps", gaps }, { "ms", sw.ElapsedMilliseconds },
      };
    }

    static uint SafeDpi(IntPtr h) { try { return Native.GetDpiForWindow(h); } catch { return 96; } }

    /**
     * Ảnh cửa sổ bằng PrintWindow (chụp đúng cửa sổ kể cả khi bị che). PrintWindow hỏng / ảnh đen (vài ứng dụng GPU) → chụp vùng màn hình,
     * NHƯNG chỉ khi cửa sổ đích đang trên cùng và không bị che (02/11/2026): chụp vùng màn hình lấy cả cửa sổ khác đang đè lên (lộ việc riêng
     * của người dùng, VLM chọn toạ độ trên cửa sổ khác). Không an toàn → null + lý do (image_error), không trả ảnh sai.
     */
    static Bitmap GrabWindow(IntPtr h, out string error) {
      error = null;
      Native.RECT r; Native.GetWindowRect(h, out r);
      int w = Math.Max(1, r.Right - r.Left), ht = Math.Max(1, r.Bottom - r.Top);
      var bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
      bool ok = false;
      try {
        using (var g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { ok = Native.PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); }
          if (!ok || IsMostlyBlack(bmp)) {
            error = ScreenCopyBlocker(h, r);
            if (error == null) g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, ht));
          }
        }
      } catch { bmp.Dispose(); throw; }
      if (error != null) { bmp.Dispose(); return null; }
      return bmp;
    }

    /** null = chụp vùng màn hình của cửa sổ an toàn (đích trên cùng, tâm + lưới 3×3 điểm đều thuộc đích); không thì lý do. */
    static string ScreenCopyBlocker(IntPtr h, Native.RECT r) {
      if (Native.IsIconic(h)) return "the window is minimized and cannot be captured";
      if (!BelongsTo(Native.GetForegroundWindow(), h)) return "this app cannot be captured in the background and the window is not in front — bring it to the front (gui.focus) to get a screenshot";
      int inset = 8;
      int[] xs = { r.Left + inset, (r.Left + r.Right) / 2, r.Right - inset };
      int[] ys = { r.Top + inset, (r.Top + r.Bottom) / 2, r.Bottom - inset };
      foreach (int x in xs) foreach (int y in ys) {
        if (!PointOnWindow(x, y, h)) return "another window covers part of this window, so a screen capture would show it — bring the window to the front (gui.focus) to get a screenshot";
      }
      return null;
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

    /**
     * Đọc chữ trên ảnh cho một lần observe đã có (cùng snapshot, node chữ nối tiếp id "<snap>.t<k>") — không đi lại cây trợ năng. gui.do
     * cần OCR sau khi tìm trong cây không thấy: trước đây observe lại cả cửa sổ (form WinForms có bảng: ~2 s mỗi lần).
     */
    static object OcrSnapshot(Dictionary<string, object> a) {
      int snap = Int(a, "snapshot", -1);
      IntPtr h;
      lock (StateLock) { if (!SnapshotWindow.TryGetValue(snap, out h)) throw new GuiError("GUI_STALE_NODE", "Snapshot " + snap + " is gone — observe again"); }
      if (!Native.IsWindow(h)) throw new GuiError("GUI_WINDOW_GONE", "The window of snapshot " + snap + " is closed");
      AssertWindowResponsive(h);
      var res = new Dictionary<string, object> { { "snapshot", snap } };
      var nodes = new List<object>();
      string imageError;
      var bmp = GrabWindow(h, out imageError);
      if (bmp == null) res["ocr"] = new Dictionary<string, object> { { "error", "no usable screenshot: " + imageError } };
      else using (bmp) AddOcrNodes(res, nodes, snap, bmp, Str(a, "ocr_lang"), Int(a, "ocr_max_nodes", 200));
      res["nodes"] = nodes;
      return res;
    }

    static void AddOcrNodes(Dictionary<string, object> res, List<object> nodes, int snap, Bitmap bmp, string lang, int max) {
      var sw = Stopwatch.StartNew();
      try {
        string used;
        var segments = Ocr.Read(bmp, lang, out used);
        var rects = new List<System.Windows.Rect>();
        lock (StateLock) { List<System.Windows.Rect> had; if (OcrSnapshots.TryGetValue(snap, out had)) rects = had; }
        foreach (var s in segments) {
          if (rects.Count >= Math.Max(0, max)) break;
          var r = s.Rect;
          nodes.Add(new Dictionary<string, object> {
            { "id", snap + ".t" + rects.Count }, { "role", "text" }, { "name", s.Text }, { "source", "ocr" },
            { "rect", new Dictionary<string, object> { { "x", (int)r.X }, { "y", (int)r.Y }, { "w", (int)r.Width }, { "h", (int)r.Height } } },
          });
          rects.Add(r);
        }
        lock (StateLock) { OcrSnapshots[snap] = rects; }
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
      int w = b.Width, h = b.Height;
      if (w <= 0 || h <= 0) return true;
      var data = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        int stride = Math.Abs(data.Stride);
        byte[] bytes = new byte[stride * h];
        Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
        int stepX = Math.Max(1, w / 16), stepY = Math.Max(1, h / 16);
        for (int y = 0; y < h; y += stepY) {
          int row = y * stride;
          for (int x = 0; x < w; x += stepX) {
            int idx = row + x * 4;
            total++;
            if (bytes[idx + 2] < 8 && bytes[idx + 1] < 8 && bytes[idx] < 8) dark++;
          }
        }
      } finally { b.UnlockBits(data); }
      // Đã thay GetPixel bằng LockBits + Marshal.Copy để đọc mảng byte trực tiếp trên bộ nhớ.
      /*
          var c = b.GetPixel(x, y); total++;
          if (c.R < 8 && c.G < 8 && c.B < 8) dark++;
        }
      }
      */
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
      AutomationElement e;
      lock (StateLock) {
        if (!Snapshots.TryGetValue(snap, out map)) throw new GuiError("GUI_STALE_NODE", "Node " + nodeId + " is from an old observation — observe again");
        if (!map.TryGetValue(idx, out e)) throw new GuiError("NOT_FOUND", "No node " + nodeId);
        window = SnapshotWindow[snap];
      }
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
      backgroundOnly = method == "background";
      inputGraceMs = Int(a, "user_input_grace_ms", 1500);
      pendingInputCheck = Bool(a, "check_user_input", true);
      userInputCheck = pendingInputCheck;
      lastMousePoint = null;
      if (!InteractiveDesktop()) throw new GuiError("GUI_LOCKED", "The screen is locked or a secure prompt is showing");
      AutomationElement el = null;
      IntPtr window = IntPtr.Zero;
      ocrPoint = null;
      ocrNodeId = null;
      if (!string.IsNullOrEmpty(nodeId) && nodeId.Contains(".t")) {
        ocrPoint = OcrPointOf(nodeId, out window);
        ocrNodeId = nodeId;
        if (action != "click" && action != "double_click" && action != "right_click" && action != "set_value" && action != "type") {
          throw new GuiError("INVALID_ARGS", "Text read from the screenshot (OCR) supports click / double_click / right_click / set_value / type only");
        }
        // Khi điền chữ vào nhãn OCR (vd "Họ tên:", "Số tiền"): tìm ô nhập thật (Edit / ComboBox / Document) nằm ngay bên phải hoặc ngay bên
        // dưới nhãn trong cùng cửa sổ để dùng ValuePattern / WM_SETTEXT chạy nền. Chỉ khi không có ô nhập UIA nào (ứng dụng vẽ tay hoàn toàn)
        // mới bấm vào toạ độ chữ rồi gõ bàn phím.
        if (action == "set_value" || action == "type") {
          AutomationElement nearby = FindNearbyInputForOcr(nodeId, window);
          if (nearby != null) {
            el = nearby;
            ocrPoint = null;
            ocrNodeId = null;
          } else {
            MouseAt(null, window, a, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1);
            method = "mouse";
          }
        }
      }
      else if (!string.IsNullOrEmpty(nodeId)) el = NodeOf(nodeId, out window);
      else window = ResolveWindow(a, true);
      string beforeTitle = window == IntPtr.Zero ? "" : WindowText(window);
      if (el != null) {
        bool isPassword = false;
        try { isPassword = el.Current.IsPassword; } catch (ElementNotAvailableException) { throw new GuiError("GUI_STALE_NODE", "Node " + nodeId + " is gone — observe again"); }
        if (isPassword && (action == "type" || action == "set_value")) throw new GuiError("GUI_PASSWORD_FIELD", "Typing into a password field is not allowed — ask the user to type it");
      }
      AssertWindowResponsive(window);
      Dictionary<string, object> screenPoint = null;
      try {
        var sp = PointFor(el, window, a);
        screenPoint = new Dictionary<string, object> { { "x", (int)Math.Round(sp.X) }, { "y", (int)Math.Round(sp.Y) } };
      } catch { }
      IntPtr fgBefore = Native.GetForegroundWindow();
      Native.POINT cursorBefore;
      bool haveCursor = Native.GetCursorPos(out cursorBefore);
      string used = DoAction(action, method, el, window, a);
      // Thao tác theo pattern không cần cửa sổ đích ở trên cùng, nhưng nhiều ứng dụng (WinForms qua MSAA) tự lấy focus khi bị SetValue /
      // Expand → phím người dùng đang gõ ở cửa sổ khác rơi vào ô của AI (chạy thật 28/10/2026: ô Họ tên bị chèn "ã", "x", "ch"). Trả focus
      // về cửa sổ người dùng đang dùng ngay sau thao tác.
      bool restored = used != "mouse" && used != "keyboard" && RestoreForeground(fgBefore, window);
      // Vẫn chưa trả được (hay gặp với ô hỏi của linh vật) mà tiêu điểm đang ở ứng dụng AI vừa thao tác → cách của gui.focus; GuardInput trong đó
      // bỏ qua bước này khi người dùng đang gõ, để phím Alt không chen vào giữa.
      IntPtr fgAfter = Native.GetForegroundWindow();
      if (!restored && used != "mouse" && used != "keyboard" && fgBefore != IntPtr.Zero && fgAfter != fgBefore && Native.IsWindow(fgBefore) && TookForeground(fgAfter, window)) {
        try { restored = ForceForeground(fgBefore); } catch (GuiError) { }
      }
      // Chạy nền: người dùng đang ở cửa sổ khác → cửa sổ của AI về lại dưới đáy (không chồng lên việc của người dùng).
      if (used == "mouse" || used == "keyboard") restored = GiveBackRealInput(action, window, fgBefore, haveCursor, cursorBefore);
      if (restored || (used != "mouse" && used != "keyboard" && fgBefore != window && window != IntPtr.Zero)) SendToBack(window);
      // Pattern actions expose their new state synchronously in most UIA providers. Keep a short grace for
      // providers that publish property changes just after returning; real mouse/keyboard still needs longer.
      int defaultSettle = used == "mouse" || used == "keyboard" ? 250 : used == "posted" ? 200 : 30;
      Thread.Sleep(Math.Max(0, Math.Min(Int(a, "settle_ms", defaultSettle), 3000)));
      var res = new Dictionary<string, object> { { "action", action }, { "method", used } };
      if (window != IntPtr.Zero && Native.IsWindow(window)) res["window_class"] = ClassOf(window);
      if (lastMousePoint != null) screenPoint = lastMousePoint;
      if (screenPoint != null) res["screen_point"] = screenPoint;
      if (restored) res["focus_returned_to_user"] = true;
      // Nút khởi chạy việc nặng làm luồng giao diện đứng: đọc bằng chứng lúc đó sẽ kẹt theo ứng dụng, nên báo đang bận rồi trả về ngay.
      bool appBusy = window != IntPtr.Zero && Native.IsWindow(window) && !IsWindowResponsive(window, 1500);
      if (appBusy) res["app_busy"] = true;
      if (el != null && !appBusy) res["target"] = Live(el);
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
      if (!appBusy) try {
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
            // Nút Win32 / WinForms có handle riêng: gửi BM_CLICK (bất đồng bộ). Invoke qua MSAA là lời gọi đồng bộ — nút mở hộp modal
            // ("Xoá phiếu?") thì ứng dụng chạy MessageBox ngay trong lời gọi đó, host chờ tới hết hạn và cửa sổ bị coi là treo tới khi hộp
            // đóng (gui-bench 13/11/2026: 5 s rồi GUI_WINDOW_HUNG cho mọi bước sau).
            if (invokeRole && role.EndsWith(".Button") && PostButtonClick(el)) return "posted";
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
            // Mục nằm dưới vùng cuộn (trang Settings dài, danh sách): chưa có toạ độ để bấm → cuộn tới trước; vẫn không có điểm mà phần tử
            // tự bấm được (Invoke) thì gọi thẳng (gui-bench 13/11/2026: "About" của Settings báo "no position on screen").
            if (!HasClickablePoint(el)) {
              ScrollIntoView(el);
              if (!HasClickablePoint(el) && ip != null) { ip.Invoke(); return "invoke"; }
            }
          }
          if (method == "auto" || method == "background") {
            string quiet = TryBackgroundClick(el, window, a, 1);
            if (quiet != null) return quiet;
          }
          MouseAt(el, window, a, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1);
          return "mouse";
        }
        case "double_click": {
          if (method == "auto" || method == "background") {
            string quiet = TryBackgroundClick(el, window, a, 2);
            if (quiet != null) return quiet;
          }
          MouseAt(el, window, a, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 2);
          return "mouse";
        }
        case "right_click": MouseAt(el, window, a, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 1); return "mouse";
        case "set_value": {
          string text = Str(a, "text") ?? "";
          if (el != null && allowPattern) {
            var vp = Pattern(el, ValuePattern.Pattern) as ValuePattern;
            if (vp != null && !vp.Current.IsReadOnly) { vp.SetValue(text); return "value"; }
            if (TryBackgroundSetText(el, text)) return "background";
          }
          FocusTarget(el, window);
          KeyCombo("ctrl+a", window);
          TypeText(text, window);
          return "keyboard";
        }
        case "type": {
          string text = Str(a, "text") ?? "";
          if (allowPattern && TryBackgroundType(el, text)) return "background";
          FocusTarget(el, window); TypeText(text, window); return "keyboard";
        }
        case "key":
          if ((method == "auto" || method == "background") && TryBackgroundKeys(el, window, Str(a, "keys") ?? "")) return "posted";
          FocusTarget(el, window); KeyCombo(Str(a, "keys") ?? "", window); return "keyboard";
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
          if ((method == "auto" || method == "background") && TryBackgroundScroll(el, window, a, dir, amount)) return "posted";
          RequireForeground(window);
          var p = PointFor(el, window, a);
          AssertPointOnWindow((int)p.X, (int)p.Y, window);
          MoveCursor((int)p.X, (int)p.Y);
          lastMousePoint = new Dictionary<string, object> { { "x", (int)p.X }, { "y", (int)p.Y } };
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
            // Bảng / danh sách: chọn theo giá trị ô qua danh sách con MSAA TRƯỚC — FindFirst theo tên trên bảng dài qua cầu MSAA đi từng ô
            // (800 dòng: hơn 60 s, gui-bench 13/11/2026) và tên ô không phải giá trị ô nên vẫn không thấy.
            string elRole = el.Current.ControlType.ProgrammaticName;
            bool tabular = elRole.EndsWith(".Table") || elRole.EndsWith(".DataGrid") || elRole.EndsWith(".List") || elRole.EndsWith(".Tree");
            if (tabular && SelectRowByValue(el, option)) return "select";
            var ep = Pattern(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
            var match = tabular ? null : el.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, option, PropertyConditionFlags.IgnoreCase));
            bool expanded = false;
            if (match == null && ep != null) { try { ep.Expand(); expanded = true; Thread.Sleep(200); } catch { } }
            if (match == null && !tabular) match = FindByName(el, option);
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
          var toD = Get(a, "to") as Dictionary<string, object>;
          if (toD == null) throw new GuiError("INVALID_ARGS", "drag needs to {x,y}");
          RequireForeground(window);
          var start = PointFor(el, window, a);
          var to = WindowPoint(window, a, toD);
          AssertPointOnWindow((int)start.X, (int)start.Y, window);
          AssertPointOnWindow((int)to.X, (int)to.Y, window);
          lastMousePoint = new Dictionary<string, object> { { "x", (int)start.X }, { "y", (int)start.Y } };
          MoveCursorInput((int)start.X, (int)start.Y);
          Thread.Sleep(30);
          Send(new[] { MouseInput(MOUSEEVENTF_LEFTDOWN, 0, 0, 0) });
          Thread.Sleep(30);
          for (int i = 1; i <= 20; i++) {
            MoveCursorInput((int)(start.X + (to.X - start.X) * i / 20), (int)(start.Y + (to.Y - start.Y) * i / 20));
            Thread.Sleep(12);
          }
          Thread.Sleep(30);
          Send(new[] { MouseInput(MOUSEEVENTF_LEFTUP, 0, 0, 0) });
          return "mouse";
        }
        default: throw new GuiError("INVALID_ARGS", "Unknown action: " + action);
      }
    }

    /** Phần tử đang có chỗ trên màn hình để bấm (không khuất trong vùng cuộn, khung không rỗng). */
    static bool HasClickablePoint(AutomationElement el) {
      try {
        if (el.Current.IsOffscreen) return false;
        var r = el.Current.BoundingRectangle;
        return !r.IsEmpty && r.Width > 0 && r.Height > 0;
      } catch (ElementNotAvailableException) { return false; }
    }

    /** Cuộn vùng chứa tới phần tử (ScrollItemPattern) — chạy bằng pattern, không cần cửa sổ ở trên cùng. Trả false nếu phần tử không hỗ trợ. */
    static bool ScrollIntoView(AutomationElement el) {
      var sip = Pattern(el, ScrollItemPattern.Pattern) as ScrollItemPattern;
      if (sip == null) return false;
      try { sip.ScrollIntoView(); Thread.Sleep(120); return true; } catch (InvalidOperationException) { return false; } catch (ElementNotAvailableException) { return false; }
    }

    static AutomationElement FindByName(AutomationElement root, string name) {
      var cond = new PropertyCondition(AutomationElement.NameProperty, name, PropertyConditionFlags.IgnoreCase);
      var hit = root.FindFirst(TreeScope.Descendants, cond);
      if (hit != null) return hit;
      // Danh sách thả xuống của ComboBox Win32 là cửa sổ riêng → tìm từ gốc màn hình trong các popup đang mở.
      return AutomationElement.RootElement.FindFirst(TreeScope.Descendants, new AndCondition(cond, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem)));
    }

    const uint WM_SETTEXT = 0x000C, WM_CHAR = 0x0102, SMTO_ABORTIFHUNG = 0x0002;

    /** Kiểm tra nhanh nhịp phản hồi của cửa sổ bằng WM_NULL + SMTO_ABORTIFHUNG để tránh UI Automation treo cứng khi ứng dụng đích bị đơ. */
    static bool IsWindowResponsive(IntPtr h, uint timeoutMs) {
      if (h == IntPtr.Zero || !Native.IsWindow(h)) return false;
      IntPtr r;
      return Native.SendMessageTimeout(h, 0, IntPtr.Zero, null, SMTO_ABORTIFHUNG, timeoutMs, out r) != IntPtr.Zero;
    }

    static void AssertWindowResponsive(IntPtr h) {
      if (h == IntPtr.Zero) return;
      if (!Native.IsWindow(h)) throw new GuiError("GUI_WINDOW_GONE", "The target window has closed");
      // 1,5 s: ứng dụng WinForms / ERP nặng vừa trả lời một loạt câu hỏi UIA (bảng dài qua cầu MSAA) có thể bận vài trăm ms — ngưỡng 500 ms
      // báo treo nhầm (gui-bench 13/11/2026). Windows chỉ coi là "Not Responding" sau 5 s.
      if (!IsWindowResponsive(h, 1500)) {
        if (!Native.IsWindow(h)) throw new GuiError("GUI_WINDOW_GONE", "The target window has closed");
        throw new GuiError("GUI_WINDOW_HUNG", "The target window is not responding (frozen UI thread)");
      }
    }

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
    const uint BM_CLICK = 0x00F5;

    /** Nút Win32 thật (lớp "Button" hoặc nút WinForms) → PostMessage(BM_CLICK). Ô tích / nút chọn cùng lớp Button thì không (đi đường toggle). */
    static bool PostButtonClick(AutomationElement el) {
      IntPtr h = OwnHandle(el);
      if (h == IntPtr.Zero || !Native.IsWindowEnabled(h)) return false;
      string cls = ClassOf(h);
      bool button = string.Equals(cls, "Button", StringComparison.OrdinalIgnoreCase) || cls.IndexOf(".BUTTON.", StringComparison.OrdinalIgnoreCase) >= 0;
      if (!button) return false;
      int style = Native.GetWindowLong(h, GWL_STYLE) & 0xF;
      // BS_PUSHBUTTON 0, BS_DEFPUSHBUTTON 1, BS_COMMANDLINK 0xE / 0xF; ô tích / radio / groupbox là các kiểu khác.
      if (style != 0 && style != 1 && style != 0xE && style != 0xF) return false;
      return Native.PostMessage(h, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    static bool TryBackgroundSetText(AutomationElement el, string text) {
      IntPtr h = OwnHandle(el);
      if (h == IntPtr.Zero) return false;
      // Chỉ ô nhập: WM_SETTEXT vào nhãn tĩnh / nút cũng "thành công" — đổi luôn chữ của nhãn mà không điền gì (gui-bench 13/11/2026: điền
      // "Họ tên" vào chính nhãn "Họ tên" báo background ok, ô nhập vẫn trống).
      if (!IsTextControl(h)) return false;
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

    const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_LBUTTONDBLCLK = 0x0203, WM_MOUSEWHEEL = 0x020A, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101;
    const uint OBJID_CLIENT = 0xFFFFFFFC;
    const int ROLE_SYSTEM_CELL = 0x1D;
    const int SELFLAG_TAKEFOCUS = 1, SELFLAG_TAKESELECTION = 2;
    static readonly HashSet<string> ClassicClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "Button", "Edit", "Static", "ComboBox", "ComboLBox", "ListBox", "#32770", "SysListView32", "SysTreeView32", "SysTabControl32", "SysHeader32",
      "SysDateTimePick32", "SysMonthCal32", "SysLink", "ToolbarWindow32", "ReBarWindow32", "msctls_statusbar32", "msctls_updown32", "msctls_trackbar32",
    };

    /**
     * Chỉ các ứng dụng Windows truyền thống xử lý đủ thông điệp chuột / phím gửi thẳng vào cửa sổ. Chromium, UWP, WPF, DirectUI bỏ qua hoặc xử lý
     * nửa vời mà không báo gì, nên danh sách này cố tình là danh sách cho phép: không chắc thì để đường chuột thật (có hỏi người dùng).
     */
    static bool AcceptsPostedInput(IntPtr h) {
      string c = ClassOf(h);
      if (c.StartsWith("WindowsForms10.") || c.StartsWith("Afx") || c.StartsWith("Thunder") || c.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) return true;
      if (c.Length > 1 && c[0] == 'T' && char.IsUpper(c[1])) return true; // Delphi / C++Builder: TForm1, TDBGrid, TPanel…
      return ClassicClasses.Contains(c);
    }

    /** Cửa sổ con sâu nhất tại điểm màn hình, tính theo cây cửa sổ của đích nên không phụ thuộc cửa sổ nào đang che nó. */
    static IntPtr DeepestChildAt(IntPtr window, int x, int y) {
      Native.RECT r;
      if (window == IntPtr.Zero || Native.IsIconic(window) || !Native.GetWindowRect(window, out r)) return IntPtr.Zero;
      if (x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom) return IntPtr.Zero;
      IntPtr cur = window;
      for (int depth = 0; depth < 30; depth++) {
        var p = new Native.POINT { X = x, Y = y };
        Native.ScreenToClient(cur, ref p);
        IntPtr child = Native.RealChildWindowFromPoint(cur, p);
        if (child == IntPtr.Zero || child == cur) break;
        cur = child;
      }
      return cur;
    }

    /** Điểm cần thao tác nền: phần tử đã cuộn khuất hay không có toạ độ thì không đoán. */
    static bool QuietPoint(AutomationElement el, IntPtr window, Dictionary<string, object> a, out int x, out int y) {
      x = 0; y = 0;
      if (window == IntPtr.Zero) return false;
      try {
        if (el != null && el.Current.IsOffscreen) return false;
        var p = PointFor(el, window, a);
        x = (int)p.X; y = (int)p.Y;
        return true;
      } catch (GuiError) { return false; } catch (ElementNotAvailableException) { return false; }
    }

    /**
     * Mượn xong thì trả: con trỏ về chỗ cũ, tiêu điểm về cửa sổ người dùng đang dùng. Họ đã cầm lại chuột thì không kéo con trỏ của họ đi; menu AI vừa
     * mở thì giữ (mất tiêu điểm là menu đóng, bước sau không chọn được).
     */
    static bool GiveBackRealInput(string action, IntPtr window, IntPtr fgBefore, bool haveCursor, Native.POINT cursorBefore) {
      Native.POINT aiCursor;
      bool haveAi = Native.GetCursorPos(out aiCursor);
      Thread.Sleep(150); // để ứng dụng nhận xong cú bấm / phím trước khi đổi tiêu điểm
      Native.POINT now;
      if (haveCursor && haveAi && Native.GetCursorPos(out now) && now.X == aiCursor.X && now.Y == aiCursor.Y && (now.X != cursorBefore.X || now.Y != cursorBefore.Y)) {
        Native.SetCursorPos(cursorBefore.X, cursorBefore.Y);
      }
      if (action == "right_click" || InMenuMode(window)) return false;
      IntPtr fg = Native.GetForegroundWindow();
      if (fgBefore == IntPtr.Zero || fgBefore == window || !Native.IsWindow(fgBefore) || !TookForeground(fg, window)) return false;
      if (RestoreForeground(fgBefore, window)) return true;
      if (UserIdleMs() < 300) return false; // cách còn lại nhấn phím Alt, không chen vào lúc họ đang gõ
      try { return ForceForeground(fgBefore); } catch (GuiError) { return false; }
    }

    static bool InMenuMode(IntPtr window) {
      uint pid;
      var info = new Native.GUITHREADINFO();
      info.cbSize = (uint)Marshal.SizeOf(info);
      uint thread = window == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(window, out pid);
      if (thread == 0 || !Native.GetGUIThreadInfo(thread, ref info)) return false;
      return (info.flags & 0x14) != 0; // GUI_INMENUMODE | GUI_POPUPMENUMODE
    }

    /**
     * Bấm không đụng chuột thật: gửi thẳng thông điệp bấm vào cửa sổ con; không được thì dùng lệnh mặc định của MSAA (chọn dòng, ô). WinForms chỉ
     * coi là cú bấm khi đúng điểm đó không bị cửa sổ khác che (nó tự kiểm WindowFromPoint), nên bị che thì bỏ qua cách gửi thông điệp.
     * Trả null = không làm được dưới nền, chưa có gì xảy ra.
     */
    static string TryBackgroundClick(AutomationElement el, IntPtr window, Dictionary<string, object> a, int times) {
      int x, y;
      if (!QuietPoint(el, window, a, out x, out y)) return null;
      IntPtr target = DeepestChildAt(window, x, y);
      if (target == IntPtr.Zero) return null;
      bool exposed = Native.WindowFromPoint(new Native.POINT { X = x, Y = y }) == target;
      if (AcceptsPostedInput(target) && (exposed || !ClassOf(target).StartsWith("WindowsForms10."))) {
        PostClick(target, x, y, times);
        return "posted";
      }
      if (times == 1 && TryAccessibleClick(target, x, y)) return "accessible";
      return null;
    }

    static void PostClick(IntPtr h, int screenX, int screenY, int times) {
      var c = new Native.POINT { X = screenX, Y = screenY };
      Native.ScreenToClient(h, ref c);
      var lp = new IntPtr(((c.Y & 0xFFFF) << 16) | (c.X & 0xFFFF));
      var pressed = new IntPtr(1); // MK_LBUTTON
      Native.PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
      for (int i = 0; i < times; i++) {
        Native.PostMessage(h, i == 0 ? WM_LBUTTONDOWN : WM_LBUTTONDBLCLK, pressed, lp);
        Native.PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, lp);
      }
    }

    static Accessibility.IAccessible AccessibleClient(IntPtr control) {
      if (control == IntPtr.Zero) return null;
      object raw;
      var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      if (Native.AccessibleObjectFromWindow(control, OBJID_CLIENT, ref iid, out raw) != 0) return null;
      return raw as Accessibility.IAccessible;
    }

    /** Hỏi chính control (accHitTest không xét cửa sổ đang che) rồi chạy lệnh mặc định, không có thì chọn. Trả false nếu control không tự trả lời được. */
    static bool TryAccessibleClick(IntPtr target, int x, int y) {
      try {
        Accessibility.IAccessible client = AccessibleClient(target);
        if (client == null) return false;
        Accessibility.IAccessible node = client;
        object child = 0;
        // Đi xuống tới mục sâu nhất tại điểm đó (bảng → dòng → ô): chọn ô mới đổi ô hiện hành như một cú bấm, chọn dòng thì không.
        for (int depth = 0; depth < 5; depth++) {
          object hit = node.accHitTest(x, y);
          if (hit is Accessibility.IAccessible && !ReferenceEquals(hit, node)) { node = (Accessibility.IAccessible)hit; child = 0; continue; }
          if (hit is int && (int)hit != 0) child = hit;
          break;
        }
        if (ReferenceEquals(node, client) && child is int && (int)child == 0) return false; // chỉ trúng nền của control, không phải một mục cụ thể
        if (!string.IsNullOrEmpty(node.get_accDefaultAction(child))) node.accDoDefaultAction(child);
        else node.accSelect(SELFLAG_TAKEFOCUS | SELFLAG_TAKESELECTION, child);
        return true;
      } catch (COMException) { return false; } catch (ArgumentException) { return false; } catch (InvalidCastException) { return false; } catch (NotImplementedException) { return false; }
    }

    static bool TryBackgroundScroll(AutomationElement el, IntPtr window, Dictionary<string, object> a, string dir, int amount) {
      if (dir != "up" && dir != "down") return false;
      int x, y;
      if (!QuietPoint(el, window, a, out x, out y)) return false;
      IntPtr target = DeepestChildAt(window, x, y);
      if (target == IntPtr.Zero || !AcceptsPostedInput(target)) return false;
      int notch = dir == "up" ? 120 : -120;
      var lp = new IntPtr(((y & 0xFFFF) << 16) | (x & 0xFFFF));
      for (int i = 0; i < amount; i++) Native.PostMessage(target, WM_MOUSEWHEEL, new IntPtr(notch << 16), lp);
      return true;
    }

    const uint WM_CUT = 0x0300, WM_COPY = 0x0301, WM_PASTE = 0x0302, WM_UNDO = 0x0304, EM_SETSEL = 0x00B1, WM_COMMAND = 0x0111, WM_CLOSE = 0x0010, MF_BYPOSITION = 0x400, MF_GRAYED = 1, MF_DISABLED = 2;

    static bool IsTextControl(IntPtr h) {
      string c = ClassOf(h);
      return c.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0 || c.IndexOf("Memo", StringComparison.Ordinal) >= 0 || c.IndexOf("TextBox", StringComparison.Ordinal) >= 0;
    }

    /** "Ctrl + Shift+S" → "ctrl+s+shift": thứ tự phím bổ trợ khác nhau vẫn so được. */
    static string NormalizeChord(string s) {
      var parts = new List<string>(s.ToLowerInvariant().Replace(" ", "").Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries));
      parts.Sort(StringComparer.Ordinal);
      return string.Join("+", parts);
    }

    /** Lệnh trong menu của cửa sổ có ghi đúng phím tắt này (Ctrl+S…); mục đang mờ thì coi như không có. */
    static bool FindMenuCommand(IntPtr menu, string chord, int depth, out uint id) {
      id = 0;
      if (menu == IntPtr.Zero || depth > 4) return false;
      int count = Native.GetMenuItemCount(menu);
      for (int i = 0; i < count; i++) {
        IntPtr sub = Native.GetSubMenu(menu, i);
        if (sub != IntPtr.Zero) { if (FindMenuCommand(sub, chord, depth + 1, out id)) return true; continue; }
        var sb = new StringBuilder(256);
        if (Native.GetMenuString(menu, (uint)i, sb, sb.Capacity, MF_BYPOSITION) <= 0) continue;
        string text = sb.ToString();
        int tab = text.LastIndexOf('\t');
        if (tab < 0 || NormalizeChord(text.Substring(tab + 1)) != chord) continue;
        if ((Native.GetMenuState(menu, (uint)i, MF_BYPOSITION) & (MF_GRAYED | MF_DISABLED)) != 0) return false;
        id = Native.GetMenuItemID(menu, i);
        return id != 0xFFFFFFFF;
      }
      return false;
    }

    /** Một phím tắt thành thông điệp tương đương; chưa gửi gì. null = phải dùng phím thật. */
    static Action ChordAsCommand(string combo, IntPtr target, IntPtr window) {
      string chord = NormalizeChord(combo);
      if (target != IntPtr.Zero && IsTextControl(target)) {
        uint msg = chord == "c+ctrl" ? WM_COPY : chord == "ctrl+x" ? WM_CUT : chord == "ctrl+v" ? WM_PASTE : chord == "ctrl+z" ? WM_UNDO : 0;
        if (msg != 0) return () => Native.PostMessage(target, msg, IntPtr.Zero, IntPtr.Zero);
        if (chord == "a+ctrl") return () => Native.PostMessage(target, EM_SETSEL, IntPtr.Zero, new IntPtr(-1));
      }
      if (chord == "alt+f4") return () => Native.PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      uint id;
      if (FindMenuCommand(Native.GetMenu(window), chord, 0, out id)) return () => Native.PostMessage(window, WM_COMMAND, new IntPtr(id), IntPtr.Zero);
      return null;
    }

    /** Phím đơn gửi thẳng vào ô đích; tổ hợp có Ctrl / Shift / Alt đổi thành lệnh tương đương (ứng dụng đọc trạng thái phím thật nên không gửi phím được). Được cả chuỗi mới gửi. */
    static bool TryBackgroundKeys(AutomationElement el, IntPtr window, string spec) {
      if (window == IntPtr.Zero || spec.Length == 0) return false;
      IntPtr target = OwnHandle(el);
      if (el == null) {
        uint pid;
        var info = new Native.GUITHREADINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        uint thread = Native.GetWindowThreadProcessId(window, out pid);
        if (thread == 0 || !Native.GetGUIThreadInfo(thread, ref info)) return false;
        target = info.hwndFocus;
      }
      // Không có ô đích (cửa sổ đang ở nền, chưa có ô nào được focus): phím đơn không biết gửi vào đâu, nhưng lệnh trong menu thì vẫn được.
      if (target != IntPtr.Zero && (!BelongsTo(target, window) || !AcceptsPostedInput(target))) target = IntPtr.Zero;
      var steps = new List<Action>();
      foreach (string raw in spec.ToLowerInvariant().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
        if (raw.Contains("+")) {
          Action cmd = ChordAsCommand(raw, target, window);
          if (cmd == null) return false;
          steps.Add(cmd);
          continue;
        }
        ushort vk;
        if (target == IntPtr.Zero || !Keys.TryGetValue(raw, out vk) || vk == 0x11 || vk == 0x10 || vk == 0x12 || vk == 0x5B) return false;
        steps.Add(() => {
          Native.PostMessage(target, WM_KEYDOWN, new IntPtr(vk), new IntPtr(1));
          Native.PostMessage(target, WM_KEYUP, new IntPtr(vk), new IntPtr(unchecked((int)0xC0000001)));
        });
      }
      foreach (Action step in steps) step();
      return true;
    }

    /** Phím thật: cửa sổ đích phải lên được trên cùng (không thì GUI_FOCUS_LOST, không gõ), rồi focus phần tử. */
    static void FocusTarget(AutomationElement el, IntPtr window) {
      RequireForeground(window);
      if (el != null) { try { el.SetFocus(); } catch { } Thread.Sleep(50); }
      AssertStillForeground(window, null);
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
      string reqId = Str(a, "__req_id");
      var sw = Stopwatch.StartNew();
      try {
        while (true) {
          if (IsCancelled(reqId)) throw new GuiError("CANCELLED", "Wait cancelled");
          bool alive = h == IntPtr.Zero || Native.IsWindow(h);
          Dictionary<string, object> match = null;
          bool incomplete = false;
          if (windowLevel) {
            if (h != IntPtr.Zero) {
              if (alive && WindowText(h).IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) match = WindowInfo(h, Native.GetForegroundWindow());
            } else {
              foreach (Dictionary<string, object> info in ListWindows(true)) { // gồm cả hộp thoại con: chờ "Save as" là việc hay gặp nhất
                if (Convert.ToString(info["title"]).IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) { match = info; break; }
              }
            }
          } else if (alive) {
            match = FindElement(h, name, aid, role, ref incomplete);
          }
          // Chưa duyệt xong cây (hết ngân sách / ứng dụng đang bận) thì chưa thể kết luận phần tử đã mất.
          if (gone ? (match == null && !incomplete) : match != null) {
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
      } finally {
        if (!string.IsNullOrEmpty(reqId)) { lock (CancelledIds) { CancelledIds.Remove(reqId); } }
      }
    }

    /** Phần tử đầu tiên khớp (AutomationId trùng hẳn, hoặc tên chứa chữ — không phân biệt hoa thường), có lọc vai trò. */
    static Dictionary<string, object> FindElement(IntPtr h, string name, string aid, string role, ref bool incomplete) {
      if (!IsWindowResponsive(h, 300)) { incomplete = true; return null; }
      AutomationElement root;
      try { root = AutomationElement.FromHandle(h); } catch { return null; }
      var cache = new CacheRequest();
      cache.Add(AutomationElement.NameProperty); cache.Add(AutomationElement.ControlTypeProperty); cache.Add(AutomationElement.AutomationIdProperty);
      cache.Add(AutomationElement.IsOffscreenProperty);
      // Đi theo tầng với trần thời gian, không FindAll(Descendants): trên cửa sổ có bảng dài một lượt hỏi mất hàng chục giây và không huỷ được.
      var walker = new TreeWalker(Automation.ControlViewCondition);
      var sw = Stopwatch.StartNew();
      try { using (cache.Activate()) { root = root.GetUpdatedCache(cache); } } catch (ElementNotAvailableException) { return null; }
      var queue = new Queue<AutomationElement>();
      queue.Enqueue(root);
      bool cut = false;
      while (queue.Count > 0) {
        if (sw.ElapsedMilliseconds >= FIND_ELEMENT_BUDGET_MS) { incomplete = true; return null; }
        AutomationElement e = queue.Dequeue();
        string n = Cached(e, AutomationElement.NameProperty) as string ?? "";
        var ct = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
        string r = ct == null ? "" : ct.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
        foreach (AutomationElement k in ChildrenOf(e, r, cache, walker, sw, FIND_ELEMENT_BUDGET_MS, ref cut)) queue.Enqueue(k);
        if (!string.IsNullOrEmpty(aid) && !string.Equals(Cached(e, AutomationElement.AutomationIdProperty) as string, aid, StringComparison.Ordinal)) continue;
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
    /** node_id OCR của thao tác đang chạy — tính lại điểm theo vị trí cửa sổ lúc bấm (sau khi khôi phục cửa sổ thu nhỏ). */
    static string ocrNodeId = null;

    static System.Windows.Point OcrPointOf(string nodeId, out IntPtr window) {
      window = IntPtr.Zero;
      int dot = nodeId.IndexOf(".t");
      int snap, idx;
      if (!int.TryParse(nodeId.Substring(0, dot), out snap) || !int.TryParse(nodeId.Substring(dot + 2), out idx)) throw new GuiError("INVALID_ARGS", "Bad node id: " + nodeId);
      List<System.Windows.Rect> rects;
      lock (StateLock) {
        if (!OcrSnapshots.TryGetValue(snap, out rects)) throw new GuiError("GUI_STALE_NODE", "Node " + nodeId + " is from an old observation — observe again");
        if (idx < 0 || idx >= rects.Count) throw new GuiError("NOT_FOUND", "No node " + nodeId);
        window = SnapshotWindow[snap];
      }
      if (!Native.IsWindow(window)) throw new GuiError("GUI_STALE_NODE", "The window of " + nodeId + " is closed — observe again");
      // Khung chữ tính theo góc cửa sổ lúc observe → cộng vị trí cửa sổ HIỆN TẠI (người dùng có thể đã kéo cửa sổ đi).
      Native.RECT wr; Native.GetWindowRect(window, out wr);
      var r = rects[idx];
      return new System.Windows.Point(wr.Left + r.X + r.Width / 2, wr.Top + r.Y + r.Height / 2);
    }

    /**
     * Tìm ô nhập UIA (Edit / ComboBox / Document, hoặc có ValuePattern ghi được) nằm ngay bên phải hoặc ngay bên dưới một nhãn chữ OCR.
     * Giúp thao tác điền vào nhãn OCR điền thẳng vào ô nhập thật thay vì gõ vào chữ tĩnh.
     */
    static AutomationElement FindNearbyInputForOcr(string nodeId, IntPtr window) {
      if (window == IntPtr.Zero || !Native.IsWindow(window)) return null;
      int dot = nodeId.IndexOf(".t");
      int snap, idx;
      if (dot <= 0 || !int.TryParse(nodeId.Substring(0, dot), out snap) || !int.TryParse(nodeId.Substring(dot + 2), out idx)) return null;
      System.Windows.Rect ocrRect;
      var candidates = new List<AutomationElement>();
      lock (StateLock) {
        List<System.Windows.Rect> rects;
        if (!OcrSnapshots.TryGetValue(snap, out rects) || idx < 0 || idx >= rects.Count) return null;
        ocrRect = rects[idx];
        Dictionary<int, AutomationElement> map;
        if (Snapshots.TryGetValue(snap, out map)) {
          foreach (var kv in map) candidates.Add(kv.Value);
        }
      }
      Native.RECT wr; Native.GetWindowRect(window, out wr);
      AutomationElement best = null;
      double bestScore = double.MaxValue;
      foreach (AutomationElement e in candidates) {
        try {
          if (!e.Current.IsEnabled || e.Current.IsOffscreen) continue;
          ControlType ct = e.Current.ControlType;
          bool isInput = ct == ControlType.Edit || ct == ControlType.ComboBox || ct == ControlType.Document;
          if (!isInput) {
            var vp = Pattern(e, ValuePattern.Pattern) as ValuePattern;
            if (vp == null || vp.Current.IsReadOnly) continue;
          }
          System.Windows.Rect er = e.Current.BoundingRectangle;
          if (er.IsEmpty || er.Width <= 4 || er.Height <= 4) continue;
          double rx = er.X - wr.Left, ry = er.Y - wr.Top, rw = er.Width, rh = er.Height;
          // Bỏ qua nếu chính phần tử bao trùm cả cửa sổ
          if (rw >= (wr.Right - wr.Left) * 0.95 && rh >= (wr.Bottom - wr.Top) * 0.9) continue;
          // 1. Ô nhập nằm bên phải nhãn (cùng hàng ngang)
          double overlapY = Math.Min(ocrRect.Bottom, ry + rh) - Math.Max(ocrRect.Top, ry);
          double minH = Math.Min(ocrRect.Height, rh);
          if (minH > 0 && overlapY >= minH * 0.35 && rx >= ocrRect.Right - 12 && rx - ocrRect.Right <= 280) {
            double dist = Math.Max(0, rx - ocrRect.Right) + Math.Abs((ry + rh / 2) - (ocrRect.Y + ocrRect.Height / 2)) * 2.0;
            if (dist < bestScore) { bestScore = dist; best = e; }
          }
          // 2. Ô nhập nằm ngay bên dưới nhãn (cùng cột dọc)
          double overlapX = Math.Min(ocrRect.Right, rx + rw) - Math.Max(ocrRect.Left, rx);
          if ((Math.Abs(rx - ocrRect.Left) <= 140 || overlapX >= ocrRect.Width * 0.4) && ry >= ocrRect.Bottom - 8 && ry - ocrRect.Bottom <= 72) {
            double dist = Math.Max(0, ry - ocrRect.Bottom) * 1.5 + Math.Abs(rx - ocrRect.Left);
            if (dist < bestScore) { bestScore = dist; best = e; }
          }
        } catch { continue; }
      }
      return best;
    }

    static System.Windows.Point PointFor(AutomationElement el, IntPtr window, Dictionary<string, object> a) {
      if (el != null) return CenterOf(el);
      if (ocrPoint.HasValue) {
        if (ocrNodeId != null) { IntPtr w; return OcrPointOf(ocrNodeId, out w); }
        return ocrPoint.Value;
      }
      var pt = Get(a, "point") as Dictionary<string, object>;
      if (pt == null) throw new GuiError("INVALID_ARGS", "Give node_id or point {x,y}");
      return WindowPoint(window, a, pt);
    }

    /**
     * Bấm chuột thật (02/11/2026): đưa cửa sổ lên (khôi phục nếu thu nhỏ) TRƯỚC khi tính toạ độ — cửa sổ thu nhỏ có toạ độ ảo; không lên được
     * trên cùng, hoặc điểm bấm đang bị cửa sổ khác che → GUI_FOCUS_LOST, không bấm.
     */
    static void MouseAt(AutomationElement el, IntPtr window, Dictionary<string, object> a, uint down, uint up, int times) {
      RequireForeground(window);
      var p = PointFor(el, window, a);
      int x = (int)p.X, y = (int)p.Y;
      AssertPointOnWindow(x, y, window);
      MoveCursor(x, y);
      Thread.Sleep(30);
      // Trong lúc di chuột có cửa sổ khác nhảy lên (thông báo, hộp thoại của ứng dụng khác) → không bấm.
      AssertPointOnWindow(x, y, window);
      lastMousePoint = new Dictionary<string, object> { { "x", x }, { "y", y } };
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

    /**
     * Gõ chữ theo lô 200 input. Trước MỖI lô (02/11/2026): cửa sổ trên cùng vẫn là đích, và (khi kiểm người dùng) người dùng không vừa đụng
     * chuột / phím từ lô trước — lệch thì dừng, báo đã gõ bao nhiêu ký tự (chữ còn lại không rơi vào cửa sổ khác).
     */
    static void TypeText(string text, IntPtr window) {
      var list = new List<Native.INPUT>();
      Native.POINT cursor;
      bool haveCursor = Native.GetCursorPos(out cursor);
      int typed = 0, inBatch = 0, total = text.Replace("\r", "").Length;
      bool first = true;
      foreach (char ch in text) {
        if (ch == '\r') continue;
        if (ch == '\n') { list.Add(KeyInput(0x0D, 0, 0)); list.Add(KeyInput(0x0D, 0, KEYEVENTF_KEYUP)); }
        else {
          list.Add(KeyInput(0, ch, KEYEVENTF_UNICODE));
          list.Add(KeyInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        inBatch++;
        if (list.Count >= 200) {
          SendTextBatch(list, window, first, haveCursor, cursor, typed, total);
          typed += inBatch; inBatch = 0; first = false; list.Clear();
          Thread.Sleep(TYPE_BATCH_PAUSE_MS);
        }
      }
      SendTextBatch(list, window, first, haveCursor, cursor, typed, total);
    }

    static void SendTextBatch(List<Native.INPUT> list, IntPtr window, bool first, bool haveCursor, Native.POINT cursor, int typed, int total) {
      if (list.Count == 0) return;
      string done = typed + " of " + total + " characters";
      if (!first && userInputCheck && haveCursor && UserTouchedSince(cursor)) {
        throw new GuiError("GUI_USER_ACTIVE", "The user started using the mouse/keyboard while the AI was typing — stopped after " + done);
      }
      AssertStillForeground(window, done);
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
    static void KeyCombo(string spec, IntPtr window) {
      int n = 0;
      foreach (string combo in spec.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
        // Mỗi tổ hợp: cửa sổ trên cùng vẫn là đích (tổ hợp trước có thể đã mở / đóng cửa sổ).
        AssertStillForeground(window, n == 0 ? null : n + " key combination(s)");
        n++;
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

    /**
     * OCR của Windows chỉnh cho dòng chữ cỡ đọc sách: chữ trên nút nhỏ và ký tự đơn ("C", "7", "+") ở cỡ giao diện 100% hay bị bỏ qua hẳn
     * (gui-bench 13/11/2026: cả bàn phím Máy tính chỉ đọc được "CE"). Phóng ảnh 2 lần (nội suy bicubic) trước khi đọc rồi chia toạ độ lại;
     * ảnh đã lớn (màn hình 4K, cửa sổ phóng to) thì đọc nguyên cỡ để không vượt MaxImageDimension và không tốn thời gian.
     */
    const int OCR_UPSCALE_MAX_SIDE = 1400;

    static List<OcrSegment> ReadInner(Bitmap bmp, string lang, out string used) {
      double scale = Math.Max(bmp.Width, bmp.Height) <= OCR_UPSCALE_MAX_SIDE ? 2.0 : 1.0;
      if (scale == 1.0) return ReadAt(bmp, lang, 1.0, out used);
      using (var big = new Bitmap((int)(bmp.Width * scale), (int)(bmp.Height * scale), PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(big)) {
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
          g.DrawImage(bmp, 0, 0, big.Width, big.Height);
        }
        return ReadAt(big, lang, scale, out used);
      }
    }

    static List<OcrSegment> ReadAt(Bitmap bmp, string lang, double scale, out string used) {
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
          var rect = new System.Windows.Rect(D(r, "X") / scale, D(r, "Y") / scale, D(r, "Width") / scale, D(r, "Height") / scale);
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
$refs = @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions', 'Accessibility')
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
