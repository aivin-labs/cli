/**
 * Emoji màu trong cửa sổ linh vật (03/11/2026) — mã C# biên dịch trong host.ps1 (cùng khối Add-Type với AivinMascot.Native).
 *
 * WPF trên .NET Framework không vẽ được font màu: emoji trong TextBlock ra một màu theo chữ, kể cả khi đặt font Segoe UI Emoji. DirectWrite /
 * Direct2D vẽ được nhưng phải gọi COM qua PowerShell, dễ sập cả tiến trình; nên ở đây đọc thẳng bảng màu của font (COLR + CPAL):
 * mỗi emoji là vài lớp glyph, mỗi lớp một màu, vẽ chồng thành hình vector rồi đặt vào dòng chữ bằng InlineUIContainer.
 *
 * - Ghép chuỗi emoji (tông da, ZWJ, keycap) theo các bảng ghép mặc định của font (GSUB); không ghép được thì vẽ từng emoji rời.
 * - Chỉ đọc font khi gặp emoji đầu tiên. Máy không có font / font không có bảng màu → chữ thường như trước, không bao giờ làm hỏng cửa sổ.
 * - Ký hiệu không phải emoji (✓ ✕ → ●) không có lớp màu nên vẫn là chữ. Ký tự có hai dạng (©, mũi tên, số) chỉ thành emoji khi có U+FE0F.
 * - Ô nhập (TextBox) không chứa được hình: emoji chủ máy đang gõ vẫn một màu, gửi đi hiện dòng chat thì có màu.
 * Giữ toàn ASCII (xem hostSource.mjs).
 */
export const EMOJI_CS = String.raw`
  public static class Emoji {
    const int VS15 = 0xFE0E, VS16 = 0xFE0F, ZWJ = 0x200D, KEYCAP = 0x20E3;
    /** Bang mac dinh cua shaper: ngoai cac feature nay la bien the tuy chon, khong tu ap dung. */
    static readonly HashSet<string> LigFeatures = new HashSet<string> { "ccmp", "liga", "rlig", "clig" };
    /** Ke hoach mot lan doc font: false = chua doc, face == null sau khi doc = khong co bang mau. */
    static bool loaded;
    static GlyphTypeface face;
    static IDictionary<int, ushort> cmap;
    static Dictionary<ushort, int> baseFirst, baseCount;
    static ushort[] layerGlyphs, layerPalette;
    static byte[] colors;
    static List<Dictionary<ushort, List<ushort[]>>> ligLookups;
    static readonly Dictionary<ushort, DrawingImage> images = new Dictionary<ushort, DrawingImage>();
    /** Cao / rong hinh so voi co chu: nhich lon hon chu mot chut nhu emoji tren web. */
    const double ImageScale = 1.2;
    const double MinBoxOfAdvance = 0.8;

    static int U16(byte[] f, long o) { return (f[o] << 8) | f[o + 1]; }
    static long U32(byte[] f, long o) { return ((long)f[o] << 24) | ((long)f[o + 1] << 16) | ((long)f[o + 2] << 8) | f[o + 3]; }

    static void Load() {
      loaded = true;
      try {
        string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Fonts), "seguiemj.ttf");
        if (!File.Exists(file)) return;
        byte[] f = File.ReadAllBytes(file);
        var tables = new Dictionary<string, long>();
        int n = U16(f, 4);
        for (int i = 0; i < n; i++) { long r = 12 + 16 * i; tables[Encoding.ASCII.GetString(f, (int)r, 4)] = U32(f, r + 8); }
        if (!tables.ContainsKey("COLR") || !tables.ContainsKey("CPAL")) return;
        if (!ReadColors(f, tables["COLR"], tables["CPAL"])) return;
        ligLookups = new List<Dictionary<ushort, List<ushort[]>>>();
        if (tables.ContainsKey("GSUB")) { try { ReadLigatures(f, tables["GSUB"]); } catch { ligLookups.Clear(); } }
        var g = new GlyphTypeface(new Uri(file));
        cmap = g.CharacterToGlyphMap;
        face = g;
      } catch { face = null; }
    }

    static bool ReadColors(byte[] f, long colr, long cpal) {
      int bases = U16(f, colr + 2); long baseAt = colr + U32(f, colr + 4); long layerAt = colr + U32(f, colr + 8); int layers = U16(f, colr + 12);
      if (bases == 0 || layers == 0) return false;
      baseFirst = new Dictionary<ushort, int>(bases); baseCount = new Dictionary<ushort, int>(bases);
      for (int i = 0; i < bases; i++) {
        long r = baseAt + 6 * i; ushort g = (ushort)U16(f, r);
        baseFirst[g] = U16(f, r + 2); baseCount[g] = U16(f, r + 4);
      }
      layerGlyphs = new ushort[layers]; layerPalette = new ushort[layers];
      for (int i = 0; i < layers; i++) { long r = layerAt + 4 * i; layerGlyphs[i] = (ushort)U16(f, r); layerPalette[i] = (ushort)U16(f, r + 2); }
      int entries = U16(f, cpal + 2);
      long recordsAt = cpal + U32(f, cpal + 8) + 4L * U16(f, cpal + 12);
      colors = new byte[entries * 4];
      Array.Copy(f, recordsAt, colors, 0, colors.Length);
      return true;
    }

    static void ReadLigatures(byte[] f, long gsub) {
      long features = gsub + U16(f, gsub + 6), lookups = gsub + U16(f, gsub + 8);
      var on = new SortedSet<int>();
      int nf = U16(f, features);
      for (int i = 0; i < nf; i++) {
        long r = features + 2 + 6 * i;
        if (!LigFeatures.Contains(Encoding.ASCII.GetString(f, (int)r, 4))) continue;
        long table = features + U16(f, r + 4); int count = U16(f, table + 2);
        for (int k = 0; k < count; k++) on.Add(U16(f, table + 4 + 2 * k));
      }
      foreach (int li in on) {
        long lookup = lookups + U16(f, lookups + 2 + 2 * li);
        int type = U16(f, lookup), subs = U16(f, lookup + 4);
        var map = new Dictionary<ushort, List<ushort[]>>();
        for (int s = 0; s < subs; s++) {
          long st = lookup + U16(f, lookup + 6 + 2 * s); int t = type;
          if (t == 7) { t = U16(f, st + 2); st += U32(f, st + 4); }
          if (t == 4) ReadLigatureSubtable(f, st, map);
        }
        if (map.Count > 0) ligLookups.Add(map);
      }
    }

    static void ReadLigatureSubtable(byte[] f, long st, Dictionary<ushort, List<ushort[]>> map) {
      ushort[] covered = ReadCoverage(f, st + U16(f, st + 2));
      int sets = U16(f, st + 4);
      for (int i = 0; i < sets && i < covered.Length; i++) {
        long set = st + U16(f, st + 6 + 2 * i); int count = U16(f, set);
        List<ushort[]> list;
        if (!map.TryGetValue(covered[i], out list)) { list = new List<ushort[]>(); map[covered[i]] = list; }
        for (int k = 0; k < count; k++) {
          long lig = set + U16(f, set + 2 + 2 * k); int comps = U16(f, lig + 2);
          // [ket qua, thanh phan 2, thanh phan 3, ...] - thanh phan dau la khoa cua map.
          var entry = new ushort[comps]; entry[0] = (ushort)U16(f, lig);
          for (int c = 1; c < comps; c++) entry[c] = (ushort)U16(f, lig + 4 + 2 * (c - 1));
          list.Add(entry);
        }
      }
    }

    static ushort[] ReadCoverage(byte[] f, long c) {
      int format = U16(f, c), count = U16(f, c + 2);
      var list = new List<ushort>();
      if (format == 1) { for (int i = 0; i < count; i++) list.Add((ushort)U16(f, c + 4 + 2 * i)); }
      else if (format == 2) {
        for (int i = 0; i < count; i++) {
          long r = c + 4 + 6 * i; int a = U16(f, r), b = U16(f, r + 2);
          for (int g = a; g <= b; g++) list.Add((ushort)g);
        }
      }
      return list.ToArray();
    }

    /** Khoi Misc Symbols / Dingbats va dai emoji mo rong: co lop mau la emoji. Ngoai ra mot it ky tu BMP mac dinh hien dang emoji (Emoji_Presentation). */
    static bool DefaultEmoji(int cp) {
      if (cp >= 0x1F000 && cp <= 0x1FAFF) return !(cp >= 0x1F1E6 && cp <= 0x1F1FF) && !(cp >= 0x1F3FB && cp <= 0x1F3FF);
      if (cp >= 0x2600 && cp <= 0x27BF) return true;
      return cp == 0x231A || cp == 0x231B || (cp >= 0x23E9 && cp <= 0x23EC) || cp == 0x23F0 || cp == 0x23F3 || cp == 0x25FD || cp == 0x25FE
        || cp == 0x2B1B || cp == 0x2B1C || cp == 0x2B50 || cp == 0x2B55;
    }
    static bool KeycapBase(int cp) { return (cp >= 0x30 && cp <= 0x39) || cp == 0x23 || cp == 0x2A; }
    static bool Regional(int cp) { return cp >= 0x1F1E6 && cp <= 0x1F1FF; }

    /** Khong can doc font: chuoi khong co gi co the la emoji thi di duong TextBlock.Text nhu cu. */
    static bool MayHaveEmoji(string s) {
      for (int i = 0; i < s.Length; i++) {
        char c = s[i];
        if (char.IsSurrogate(c) || c == VS16 || c == KEYCAP) return true;
        if (DefaultEmoji(c)) return true;
      }
      return false;
    }

    /** Doc mot cum emoji tu vi tri i. Khong phai emoji / font khong co mau cho no: tra null, i khong doi. */
    static List<ushort> ReadCluster(string s, ref int i) {
      int at = i, cp = char.ConvertToUtf32(s, at); at += char.IsSurrogatePair(s, at) ? 2 : 1;
      int next = at < s.Length && !char.IsSurrogate(s[at]) ? s[at] : 0;
      if (next == VS15) return null;
      bool keycap = KeycapBase(cp) && ((next == KEYCAP) || (next == VS16 && at + 1 < s.Length && s[at + 1] == KEYCAP));
      if (KeycapBase(cp) && !keycap) return null;
      if (!keycap && !Regional(cp) && !DefaultEmoji(cp) && next != VS16) return null;
      ushort first; if (!cmap.TryGetValue(cp, out first)) return null;
      var run = new List<ushort> { first };
      if (Regional(cp) && at < s.Length && char.IsSurrogatePair(s, at) && Regional(char.ConvertToUtf32(s, at))) {
        ushort second; if (cmap.TryGetValue(char.ConvertToUtf32(s, at), out second)) { run.Add(second); at += 2; }
      }
      while (at < s.Length) {
        int c = char.ConvertToUtf32(s, at); int len = char.IsSurrogatePair(s, at) ? 2 : 1; ushort g;
        if (c == VS16) { at += len; continue; }
        if ((c == KEYCAP || (c >= 0x1F3FB && c <= 0x1F3FF)) && cmap.TryGetValue(c, out g)) { run.Add(g); at += len; continue; }
        if (c == ZWJ && at + 1 < s.Length) {
          int after = char.ConvertToUtf32(s, at + 1); ushort zwj, afterGlyph;
          if (cmap.TryGetValue(ZWJ, out zwj) && cmap.TryGetValue(after, out afterGlyph)) {
            run.Add(zwj); run.Add(afterGlyph); at += 1 + (char.IsSurrogatePair(s, at + 1) ? 2 : 1); continue;
          }
        }
        break;
      }
      Ligate(run);
      bool any = false;
      foreach (ushort g in run) if (baseFirst.ContainsKey(g)) { any = true; break; }
      if (!any) return null;
      i = at;
      return run;
    }

    /** Ap cac bang ghep theo dung thu tu trong font, nhu shaper: moi bang quet mot luot, tai moi vi tri lay ban ghep dau tien khop. */
    static void Ligate(List<ushort> run) {
      if (run.Count < 2) return;
      foreach (var map in ligLookups) {
        for (int p = 0; p < run.Count; p++) {
          List<ushort[]> ligs; if (!map.TryGetValue(run[p], out ligs)) continue;
          foreach (ushort[] lig in ligs) {
            if (p + lig.Length > run.Count) continue;
            bool same = true;
            for (int k = 1; k < lig.Length; k++) if (run[p + k] != lig[k]) { same = false; break; }
            if (!same) continue;
            run[p] = lig[0]; run.RemoveRange(p + 1, lig.Length - 1);
            break;
          }
        }
      }
    }

    static DrawingImage Picture(ushort glyph) {
      DrawingImage img;
      if (images.TryGetValue(glyph, out img)) return img;
      const double em = 256;
      var group = new DrawingGroup();
      int first = baseFirst[glyph], count = baseCount[glyph];
      Rect ink = Rect.Empty;
      for (int i = first; i < first + count && i < layerGlyphs.Length; i++) {
        var outline = face.GetGlyphOutline(layerGlyphs[i], em, em);
        ink.Union(outline.Bounds);
        var brush = new SolidColorBrush(LayerColor(layerPalette[i])); brush.Freeze();
        group.Children.Add(new GeometryDrawing(brush, null, outline));
      }
      // O vuong om sat net ve (khoang trong trong o em cua font lam emoji nho + cach xa chu); emoji nho hon han (vd o vuong nho) khong bi phong
      // len: o toi thieu theo be ngang cua font.
      double side = Math.Max(Math.Max(ink.Width, ink.Height), face.AdvanceWidths[glyph] * em * MinBoxOfAdvance);
      var box = new Rect(ink.X + ink.Width / 2 - side / 2, ink.Y + ink.Height / 2 - side / 2, side, side);
      group.Children.Insert(0, new GeometryDrawing(Brushes.Transparent, null, new RectangleGeometry(box)));
      group.Freeze();
      img = new DrawingImage(group); img.Freeze();
      images[glyph] = img;
      return img;
    }

    static Color LayerColor(ushort index) {
      // 0xFFFF = mau chu; font emoji gan nhu khong dung, cho toi cho doc duoc tren nen trang.
      if (index == 0xFFFF || index * 4 + 3 >= colors.Length) return Color.FromRgb(0x1D, 0x21, 0x29);
      int o = index * 4;
      return Color.FromArgb(colors[o + 3], colors[o + 2], colors[o + 1], colors[o]);
    }

    /** Hinh cua mot glyph, cao / rong theo co chu. */
    static System.Windows.Documents.InlineUIContainer PictureInline(ushort glyph, double fontSize) {
      double side = Math.Round(fontSize * ImageScale);
      var image = new System.Windows.Controls.Image { Source = Picture(glyph), Width = side, Height = side, Margin = new Thickness(1, 0, 1, 0), Stretch = Stretch.Uniform, IsHitTestVisible = false };
      return new System.Windows.Documents.InlineUIContainer(image) { BaselineAlignment = BaselineAlignment.Center };
    }

    /** Dat chu vao TextBlock: emoji thanh hinh mau, con lai la chu. Loi gi cung lui ve chu thuong. Tag giu chu goc (xem Text). */
    public static void Set(System.Windows.Controls.TextBlock block, string text) {
      string s = text ?? "";
      block.Tag = s;
      try {
        if (MayHaveEmoji(s)) {
          if (!loaded) Load();
          if (face != null && SetInlines(block, s)) return;
        }
      } catch { }
      block.Text = s;
    }

    /** Chu goc da dat bang Set (TextBlock.Text cua khoi co hinh khong tra lai dung chu). */
    public static string Text(System.Windows.Controls.TextBlock block) {
      string tag = block.Tag as string;
      return tag ?? block.Text;
    }

    static bool SetInlines(System.Windows.Controls.TextBlock block, string s) {
      var parts = new List<System.Windows.Documents.Inline>(); var plain = new StringBuilder(); bool any = false;
      for (int i = 0; i < s.Length; ) {
        if (char.IsHighSurrogate(s[i]) && !(i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) || char.IsLowSurrogate(s[i])) { plain.Append(s[i]); i++; continue; }
        int before = i;
        List<ushort> run = ReadCluster(s, ref i);
        if (run == null) {
          int len = char.IsSurrogatePair(s, before) ? 2 : 1;
          plain.Append(s, before, len); i = before + len; continue;
        }
        any = true;
        if (plain.Length > 0) { parts.Add(new System.Windows.Documents.Run(plain.ToString())); plain.Clear(); }
        foreach (ushort g in run) if (baseFirst.ContainsKey(g)) parts.Add(PictureInline(g, block.FontSize));
      }
      if (!any) return false;
      if (plain.Length > 0) parts.Add(new System.Windows.Documents.Run(plain.ToString()));
      block.Inlines.Clear();
      block.Inlines.AddRange(parts);
      return true;
    }
  }
`;
