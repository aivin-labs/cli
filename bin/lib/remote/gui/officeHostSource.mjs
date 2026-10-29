/**
 * Đầu nối Office qua COM (28/10/2026) — cùng tiến trình host với tầng giao diện (windowsHostSource.mjs), op `office`. Người dùng không cấu
 * hình gì: máy có Excel / Word / Outlook (ProgID trong registry) thì CLI tự bật công cụ `office.*`.
 *
 * Tệp người dùng ĐANG MỞ trong Excel / Word → thao tác thẳng trên bản đó (người dùng thấy ngay, chỉ lưu khi được yêu cầu). Tệp chưa mở →
 * mở bằng một bản Excel / Word ẨN riêng (chạy nền, không hiện cửa sổ), lưu rồi đóng. Gọi COM bằng reflection (C# 5, không cần interop).
 * Không có `using` — ghép sau phần chính, dùng chung các `using` ở đầu tệp.
 */
export const OFFICE_CSHARP = String.raw`
namespace AivinGui {
  public static class Office {
    const int MAX_CELLS = 5000;
    const int MAX_TEXT = 200000;

    class Opened { public object App; public object Doc; public bool Own; }

    static string S(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null; }
    static bool B(Dictionary<string, object> d, string k, bool def) { object v; try { return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToBoolean(v) : def; } catch { return def; } }
    static int I(Dictionary<string, object> d, string k, int def) { object v; try { return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : def; } catch { return def; } }

    static object Inv(object o, string n, BindingFlags f, object[] a) {
      try { return o.GetType().InvokeMember(n, f, null, o, a); }
      catch (TargetInvocationException e) { throw new GuiError("OFFICE_FAILED", n + ": " + (e.InnerException != null ? e.InnerException.Message : e.Message)); }
      catch (COMException e) { throw new GuiError("OFFICE_FAILED", n + ": " + e.Message); }
    }
    static object Get(object o, string n, params object[] a) { return Inv(o, n, BindingFlags.GetProperty | BindingFlags.InvokeMethod, a); }
    static void Set(object o, string n, object v) { Inv(o, n, BindingFlags.SetProperty, new object[] { v }); }
    static object Call(object o, string n, params object[] a) { return Inv(o, n, BindingFlags.InvokeMethod, a); }
    static void Release(object o) { try { if (o != null && Marshal.IsComObject(o)) Marshal.ReleaseComObject(o); } catch { } }
    static object Running(string progId) { try { return Marshal.GetActiveObject(progId); } catch { return null; } }

    static object Create(string progId) {
      Type t = Type.GetTypeFromProgID(progId);
      if (t == null) throw new GuiError("OFFICE_NOT_INSTALLED", progId + " is not installed on this computer");
      try { return Activator.CreateInstance(t); }
      catch (COMException e) {
        // 0x80080005: ứng dụng đang chạy ở mức quyền khác (mở bằng "Run as administrator") hoặc bản mới không còn COM (Outlook mới) — chạy
        // thật 28/10/2026 trên máy có cả Outlook cổ điển đang mở lẫn Outlook mới.
        if ((uint)e.ErrorCode == 0x80080005) throw new GuiError("OFFICE_UNAVAILABLE", progId + " is running with different permissions (e.g. opened as administrator) or is the new app without automation - ask the user to reopen it normally, or use the GUI");
        throw new GuiError("OFFICE_UNAVAILABLE", progId + " could not start: " + e.Message);
      }
    }

    public static object Run(Dictionary<string, object> a) {
      string op = S(a, "op") ?? "";
      switch (op) {
        case "excel.read": return ExcelRead(a);
        case "excel.write": return ExcelWrite(a);
        case "word.read": return WordRead(a);
        case "word.edit": return WordEdit(a);
        case "outlook.list": return OutlookList(a);
        case "outlook.compose": return OutlookCompose(a);
        default: throw new GuiError("INVALID_ARGS", "Unknown office op: " + op);
      }
    }

    // ── Excel ──────────────────────────────────────────────────────────────────────────────────

    /** Sổ đang mở trong Excel của người dùng (so FullName) → dùng luôn; không thì mở bằng Excel ẩn riêng. */
    static Opened OpenWorkbook(string path, bool create, bool readOnly) {
      object app = Running("Excel.Application");
      if (app != null) {
        // Bản đang chạy không trả lời (treo / bận, RPC_E_SERVERCALL_RETRYLATER) → bỏ qua, mở bản ẩn riêng (29/10/2026: một Excel treo
        // trên máy làm mọi lời gọi office.excel.* hỏng, Planner thử lại 12 lượt).
        try {
          object books = Get(app, "Workbooks");
          int n = Convert.ToInt32(Get(books, "Count"));
          for (int i = 1; i <= n; i++) {
            object b = Get(books, "Item", i);
            if (string.Equals(Convert.ToString(Get(b, "FullName")), path, StringComparison.OrdinalIgnoreCase)) { Release(books); return new Opened { App = app, Doc = b, Own = false }; }
            Release(b);
          }
          Release(books);
        } catch (GuiError) { }
        Release(app);
      }
      object own = Create("Excel.Application");
      try {
        Set(own, "Visible", false);
        Set(own, "DisplayAlerts", false);
        object wbs = Get(own, "Workbooks");
        object book;
        if (File.Exists(path)) book = Call(wbs, "Open", path, 0, readOnly);
        else if (create) { book = Call(wbs, "Add"); Call(book, "SaveAs", path); }
        else throw new GuiError("NOT_FOUND", "File not found: " + path);
        Release(wbs);
        return new Opened { App = own, Doc = book, Own = true };
      } catch { try { Call(own, "Quit"); } catch { } Release(own); throw; }
    }

    static void CloseWorkbook(Opened o, bool save) {
      try {
        if (save) Call(o.Doc, "Save");
        if (o.Own) Call(o.Doc, "Close", false);
      } finally {
        Release(o.Doc);
        if (o.Own) { try { Call(o.App, "Quit"); } catch { } }
        Release(o.App);
      }
    }

    static object SheetOf(object book, string name) {
      if (!string.IsNullOrEmpty(name)) {
        object sheets = Get(book, "Worksheets");
        try { return Get(sheets, "Item", name); } catch (GuiError) { throw new GuiError("NOT_FOUND", "No sheet named: " + name); } finally { Release(sheets); }
      }
      return Get(book, "ActiveSheet");
    }

    static List<object> SheetNames(object book) {
      var names = new List<object>();
      object sheets = Get(book, "Worksheets");
      int n = Convert.ToInt32(Get(sheets, "Count"));
      for (int i = 1; i <= n; i++) { object s = Get(sheets, "Item", i); names.Add(Convert.ToString(Get(s, "Name"))); Release(s); }
      Release(sheets);
      return names;
    }

    static object Cell(object v) {
      if (v == null) return null;
      if (v is double || v is string || v is bool) return v;
      return Convert.ToString(v);
    }

    /** Value2 của vùng → mảng hàng (cắt ở MAX_CELLS ô). */
    static List<object> Rows(object value, out bool truncated) {
      truncated = false;
      var rows = new List<object>();
      var arr = value as object[,];
      if (arr == null) { rows.Add(new List<object> { Cell(value) }); return rows; }
      int cells = 0;
      for (int r = arr.GetLowerBound(0); r <= arr.GetUpperBound(0); r++) {
        var row = new List<object>();
        for (int c = arr.GetLowerBound(1); c <= arr.GetUpperBound(1); c++) {
          if (++cells > MAX_CELLS) { truncated = true; break; }
          row.Add(Cell(arr[r, c]));
        }
        rows.Add(row);
        if (truncated) break;
      }
      return rows;
    }

    static object ExcelRead(Dictionary<string, object> a) {
      Opened o = OpenWorkbook(S(a, "path"), false, true);
      try {
        object ws = SheetOf(o.Doc, S(a, "sheet"));
        string range = S(a, "range");
        object rng = string.IsNullOrEmpty(range) ? Get(ws, "UsedRange") : Get(ws, "Range", range);
        bool truncated;
        var res = new Dictionary<string, object> {
          { "path", S(a, "path") }, { "sheet", Convert.ToString(Get(ws, "Name")) }, { "sheets", SheetNames(o.Doc) },
          { "range", Convert.ToString(Get(rng, "Address", false, false)) }, { "rows", Rows(Get(rng, "Value2"), out truncated) },
          { "open_in_user_excel", !o.Own },
        };
        if (B(a, "formulas", false)) { bool t2; res["formulas"] = Rows(Get(rng, "Formula"), out t2); }
        if (truncated) res["truncated"] = true;
        Release(rng); Release(ws);
        return res;
      } finally { CloseWorkbook(o, false); }
    }

    static object JsonValue(object v) {
      if (v is decimal) return Convert.ToDouble(v);
      if (v is int || v is long) return Convert.ToDouble(v);
      return v;
    }

    static void WriteCell(object ws, string addr, object v) {
      object r = Get(ws, "Range", addr);
      string s = v as string;
      if (s != null && s.StartsWith("=")) Set(r, "Formula", s); else Set(r, "Value2", JsonValue(v));
      Release(r);
    }

    /** cells {"B2": giá trị | "=công thức"} và / hoặc range + values (mảng hàng). Đọc lại ô vừa ghi làm bằng chứng. */
    static object ExcelWrite(Dictionary<string, object> a) {
      string path = S(a, "path");
      Opened o = OpenWorkbook(path, B(a, "create", false), false);
      bool save = B(a, "save", true);
      try {
        object ws = SheetOf(o.Doc, S(a, "sheet"));
        var written = new Dictionary<string, object>();
        var cells = a.ContainsKey("cells") ? a["cells"] as Dictionary<string, object> : null;
        if (cells != null) {
          foreach (var kv in cells) {
            WriteCell(ws, kv.Key, kv.Value);
            object r = Get(ws, "Range", kv.Key);
            written[kv.Key] = Cell(Get(r, "Text"));
            Release(r);
          }
        }
        var values = a.ContainsKey("values") ? a["values"] as object[] : null;
        string range = S(a, "range");
        if (values != null && !string.IsNullOrEmpty(range)) {
          int rowsN = values.Length, colsN = 0;
          foreach (var row in values) { var arr = row as object[]; if (arr != null && arr.Length > colsN) colsN = arr.Length; }
          if (rowsN * colsN > MAX_CELLS) throw new GuiError("INVALID_ARGS", "Too many cells in one write (max " + MAX_CELLS + ")");
          object start = Get(ws, "Range", range);
          object target = Get(start, "Resize", rowsN, Math.Max(1, colsN));
          var data = new object[rowsN, Math.Max(1, colsN)];
          for (int r = 0; r < rowsN; r++) {
            var arr = values[r] as object[];
            for (int c = 0; arr != null && c < arr.Length; c++) data[r, c] = JsonValue(arr[c]);
          }
          Set(target, "Value2", data);
          written[Convert.ToString(Get(target, "Address", false, false))] = rowsN + "x" + colsN;
          Release(target); Release(start);
        }
        if (written.Count == 0) throw new GuiError("INVALID_ARGS", "Give cells {\"B2\": value} or range + values");
        Release(ws);
        return new Dictionary<string, object> { { "path", path }, { "written", written }, { "saved", save }, { "open_in_user_excel", !o.Own } };
      } finally { CloseWorkbook(o, save); }
    }

    // ── Word ───────────────────────────────────────────────────────────────────────────────────

    static Opened OpenDocument(string path, bool create, bool readOnly) {
      object app = Running("Word.Application");
      if (app != null) {
        // Bản đang chạy không trả lời → bỏ qua, mở bản ẩn riêng (như OpenWorkbook).
        try {
          object docs = Get(app, "Documents");
          int n = Convert.ToInt32(Get(docs, "Count"));
          for (int i = 1; i <= n; i++) {
            object d = Get(docs, "Item", i);
            if (string.Equals(Convert.ToString(Get(d, "FullName")), path, StringComparison.OrdinalIgnoreCase)) { Release(docs); return new Opened { App = app, Doc = d, Own = false }; }
            Release(d);
          }
          Release(docs);
        } catch (GuiError) { }
        Release(app);
      }
      object own = Create("Word.Application");
      try {
        Set(own, "Visible", false);
        Set(own, "DisplayAlerts", 0);
        object docs = Get(own, "Documents");
        object doc;
        if (File.Exists(path)) doc = Call(docs, "Open", path, false, readOnly, false);
        else if (create) { doc = Call(docs, "Add"); Call(doc, "SaveAs2", path); }
        else throw new GuiError("NOT_FOUND", "File not found: " + path);
        Release(docs);
        return new Opened { App = own, Doc = doc, Own = true };
      } catch { try { Call(own, "Quit", 0); } catch { } Release(own); throw; }
    }

    static void CloseDocument(Opened o, bool save) {
      try {
        if (save) Call(o.Doc, "Save");
        if (o.Own) Call(o.Doc, "Close", 0);
      } finally {
        Release(o.Doc);
        if (o.Own) { try { Call(o.App, "Quit", 0); } catch { } }
        Release(o.App);
      }
    }

    static object WordRead(Dictionary<string, object> a) {
      Opened o = OpenDocument(S(a, "path"), false, true);
      try {
        object content = Get(o.Doc, "Content");
        string text = Convert.ToString(Get(content, "Text")).Replace("\r", "\n");
        int max = Math.Max(500, Math.Min(I(a, "max_chars", 20000), MAX_TEXT));
        Release(content);
        var res = new Dictionary<string, object> { { "path", S(a, "path") }, { "chars", text.Length }, { "text", text.Length > max ? text.Substring(0, max) : text }, { "open_in_user_word", !o.Own } };
        if (text.Length > max) res["truncated"] = true;
        return res;
      } finally { CloseDocument(o, false); }
    }

    static int CountOf(string text, string find) {
      if (string.IsNullOrEmpty(find)) return 0;
      int n = 0, i = 0;
      while ((i = text.IndexOf(find, i, StringComparison.Ordinal)) >= 0) { n++; i += find.Length; }
      return n;
    }

    /** Thay chữ (mọi chỗ, giữ định dạng của Word) và / hoặc thêm đoạn cuối tài liệu. */
    static object WordEdit(Dictionary<string, object> a) {
      string path = S(a, "path");
      Opened o = OpenDocument(path, B(a, "create", false), false);
      bool save = B(a, "save", true);
      try {
        var res = new Dictionary<string, object> { { "path", path }, { "saved", save }, { "open_in_user_word", !o.Own } };
        string find = S(a, "find"), replace = S(a, "replace"), append = S(a, "append");
        if (!string.IsNullOrEmpty(find)) {
          object content = Get(o.Doc, "Content");
          int before = CountOf(Convert.ToString(Get(content, "Text")), find);
          object finder = Get(content, "Find");
          Call(finder, "Execute", find, true, false, false, false, false, true, 1, false, replace ?? "", 2);
          Release(finder); Release(content);
          object after = Get(o.Doc, "Content");
          res["replaced"] = before - CountOf(Convert.ToString(Get(after, "Text")), find);
          Release(after);
        }
        if (!string.IsNullOrEmpty(append)) {
          object content = Get(o.Doc, "Content");
          Call(content, "InsertParagraphAfter");
          Call(content, "InsertAfter", append);
          Release(content);
          res["appended_chars"] = append.Length;
        }
        if (!res.ContainsKey("replaced") && !res.ContainsKey("appended_chars")) throw new GuiError("INVALID_ARGS", "Give find + replace and / or append");
        return res;
      } finally { CloseDocument(o, save); }
    }

    // ── Outlook ────────────────────────────────────────────────────────────────────────────────

    static object OutlookApp() { return Running("Outlook.Application") ?? Create("Outlook.Application"); }

    static object OutlookList(Dictionary<string, object> a) {
      object app = OutlookApp();
      object ns = Call(app, "GetNamespace", "MAPI");
      object folder = Call(ns, "GetDefaultFolder", S(a, "folder") == "sent" ? 5 : 6);
      object items = Get(folder, "Items");
      Call(items, "Sort", "[ReceivedTime]", true);
      int limit = Math.Max(1, Math.Min(I(a, "limit", 20), 100));
      bool unreadOnly = B(a, "unread_only", false);
      int previewChars = Math.Max(0, Math.Min(I(a, "preview_chars", 300), 3000));
      var list = new List<object>();
      int n = Convert.ToInt32(Get(items, "Count"));
      for (int i = 1; i <= n && list.Count < limit; i++) {
        object it = null;
        try {
          it = Call(items, "Item", i);
          if (unreadOnly && !true.Equals(Get(it, "UnRead"))) continue;
          string body = Convert.ToString(Get(it, "Body") ?? "");
          list.Add(new Dictionary<string, object> {
            { "subject", Convert.ToString(Get(it, "Subject")) }, { "from", Convert.ToString(Get(it, "SenderName")) },
            { "from_email", Convert.ToString(Get(it, "SenderEmailAddress")) }, { "received", Convert.ToDateTime(Get(it, "ReceivedTime")).ToString("s") },
            { "unread", true.Equals(Get(it, "UnRead")) }, { "preview", body.Length > previewChars ? body.Substring(0, previewChars) : body },
          });
        } catch (GuiError) { /* mục không phải thư (lịch họp…) */ } finally { Release(it); }
      }
      Release(items); Release(folder); Release(ns); Release(app);
      return new Dictionary<string, object> { { "folder", S(a, "folder") == "sent" ? "sent" : "inbox" }, { "messages", list } };
    }

    /** Soạn thư: lưu vào Bản nháp (mặc định) hoặc gửi luôn (send). */
    static object OutlookCompose(Dictionary<string, object> a) {
      object app = OutlookApp();
      object mail = Call(app, "CreateItem", 0);
      try {
        Set(mail, "To", S(a, "to") ?? "");
        if (!string.IsNullOrEmpty(S(a, "cc"))) Set(mail, "CC", S(a, "cc"));
        Set(mail, "Subject", S(a, "subject") ?? "");
        Set(mail, "Body", S(a, "body") ?? "");
        var files = a.ContainsKey("attachments") ? a["attachments"] as object[] : null;
        if (files != null) {
          object att = Get(mail, "Attachments");
          foreach (var f in files) Call(att, "Add", Convert.ToString(f));
          Release(att);
        }
        bool send = B(a, "send", false);
        if (send) Call(mail, "Send"); else Call(mail, "Save");
        return new Dictionary<string, object> { { "sent", send }, { "saved_to_drafts", !send }, { "to", S(a, "to") }, { "subject", S(a, "subject") }, { "attachments", files == null ? 0 : files.Length } };
      } finally { Release(mail); Release(app); }
    }
  }
}
`;
