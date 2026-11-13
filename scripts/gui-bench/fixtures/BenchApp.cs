// Ứng dụng mẫu cho bộ đo gui.* (scripts/gui-bench): một phiếu thu kiểu ERP viết bằng WinForms — ô nhập có nhãn đứng trước (cách các phần
// mềm kế toán Việt hay làm), combobox, checkbox, bảng dài, và một vùng tự vẽ (không có cây trợ năng) chỉ đọc được bằng OCR.
// Mọi thao tác ghi trạng thái ra tệp JSON (đối số 1) để bộ đo kiểm độc lập, không dựa vào chính tầng gui.* đang được đo.
// Biên dịch: csc /target:winexe /out:AivinBenchApp.exe BenchApp.cs (run.mjs tự làm).
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

static class BenchApp {
  public static string OutPath;
  [STAThread]
  static void Main(string[] args) {
    OutPath = args.Length > 0 ? args[0] : "bench-state.json";
    string mode = args.Length > 1 ? args[1] : "ledger";
    Application.EnableVisualStyles();
    Application.Run(mode == "drawn" ? (Form)new DrawnForm() : new LedgerForm());
  }
  public static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }
  public static void Write(string json) { File.WriteAllText(OutPath, json, new UTF8Encoding(false)); }
}

class LedgerForm : Form {
  TextBox name, amount, note;
  ComboBox kind;
  CheckBox approved;
  DataGridView grid;
  string lastAction = "";
  string drawnClicked = "";

  public LedgerForm() {
    Text = "Aivin Bench - Phiếu thu";
    ClientSize = new Size(900, 640);
    StartPosition = FormStartPosition.Manual;
    Location = new Point(120, 80);
    Font = new Font("Segoe UI", 10f);
    int y = 16;
    name = AddField("Họ tên", ref y);
    amount = AddField("Số tiền", ref y);
    // Ô không có nhãn đứng trước: chỉ có chữ gợi ý bên trong — kiểu hay gặp ở phần mềm tự viết.
    note = new TextBox { Left = 140, Top = y, Width = 300 };
    Controls.Add(note);
    y += 36;
    Controls.Add(new Label { Text = "Hình thức", Left = 16, Top = y + 3, AutoSize = true });
    kind = new ComboBox { Left = 140, Top = y, Width = 200, DropDownStyle = ComboBoxStyle.DropDownList };
    kind.Items.AddRange(new object[] { "Tiền mặt", "Chuyển khoản", "Thẻ" });
    kind.SelectedIndex = 0;
    Controls.Add(kind);
    y += 36;
    approved = new CheckBox { Text = "Đã duyệt", Left = 140, Top = y, AutoSize = true };
    Controls.Add(approved);
    y += 36;
    var save = new Button { Text = "Ghi sổ", Left = 140, Top = y, Width = 100 };
    save.Click += (s, e) => { lastAction = "save"; Dump(); };
    Controls.Add(save);
    var del = new Button { Text = "Xoá phiếu", Left = 250, Top = y, Width = 100 };
    // Hộp xác nhận modal (cửa sổ #32770 riêng, khoá cửa sổ chính) — kiểu hay gặp nhất ở phần mềm kế toán.
    del.Click += (s, e) => {
      lastAction = "delete_asked"; Dump();
      var answer = MessageBox.Show(this, "Xoá phiếu thu này?", "Xác nhận xoá", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
      lastAction = answer == DialogResult.Yes ? "delete" : "delete_cancelled"; Dump();
    };
    Controls.Add(del);
    y += 44;

    grid = new DataGridView {
      Left = 16, Top = y, Width = 520, Height = 640 - y - 16, ReadOnly = true, AllowUserToAddRows = false,
      SelectionMode = DataGridViewSelectionMode.FullRowSelect, RowHeadersVisible = false,
    };
    grid.Columns.Add("ma", "Mã");
    grid.Columns.Add("ten", "Tên hàng");
    grid.Columns.Add("sl", "Số lượng");
    for (int i = 1; i <= 800; i++) grid.Rows.Add("SP" + i.ToString("D4"), "Sản phẩm " + i, ((i * 37) % 97).ToString());
    grid.SelectionChanged += (s, e) => { lastAction = "select_row"; Dump(); };
    // SelectionChanged bắn lúc ô vừa được tô (CurrentRow còn là dòng cũ); đổi ô hiện hành sau đó không bắn lại khi dòng đã được chọn.
    grid.CurrentCellChanged += (s, e) => { lastAction = "current_row"; Dump(); };
    Controls.Add(grid);

    // Vùng tự vẽ: chữ nút chỉ có trên ảnh, không có phần tử trợ năng nào.
    var canvas = new DrawnPanel { Left = 560, Top = 16, Width = 320, Height = 300, BackColor = Color.White };
    canvas.Clicked += (label) => { drawnClicked = label; lastAction = "drawn"; Dump(); };
    Controls.Add(canvas);
    Shown += (s, e) => { lastAction = "shown"; Dump(); };
  }

  TextBox AddField(string label, ref int y) {
    Controls.Add(new Label { Text = label, Left = 16, Top = y + 3, AutoSize = true });
    var box = new TextBox { Left = 140, Top = y, Width = 300 };
    Controls.Add(box);
    y += 36;
    return box;
  }

  void Dump() {
    var row = grid.CurrentRow == null ? "" : Convert.ToString(grid.CurrentRow.Cells[0].Value);
    BenchApp.Write("{\"last\":\"" + lastAction + "\",\"name\":\"" + BenchApp.Esc(name.Text) + "\",\"amount\":\"" + BenchApp.Esc(amount.Text) +
      "\",\"note\":\"" + BenchApp.Esc(note.Text) + "\",\"kind\":\"" + BenchApp.Esc(Convert.ToString(kind.SelectedItem)) +
      "\",\"approved\":" + (approved.Checked ? "true" : "false") + ",\"row\":\"" + row + "\",\"drawn\":\"" + BenchApp.Esc(drawnClicked) + "\"}");
  }
}

/** Ba "nút" vẽ tay. Bấm trúng chữ nào thì báo chữ đó. */
class DrawnPanel : Panel {
  public event Action<string> Clicked;
  static readonly string[] Labels = { "Xuất hoá đơn", "In phiếu", "Gửi email" };
  public DrawnPanel() { DoubleBuffered = true; }
  Rectangle Box(int i) { return new Rectangle(20, 20 + i * 80, 260, 56); }
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e);
    using (var f = new Font("Segoe UI", 14f)) {
      for (int i = 0; i < Labels.Length; i++) {
        var r = Box(i);
        e.Graphics.FillRectangle(Brushes.Gainsboro, r);
        e.Graphics.DrawRectangle(Pens.DimGray, r);
        TextRenderer.DrawText(e.Graphics, Labels[i], f, r, Color.Black, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
      }
    }
  }
  protected override void OnMouseClick(MouseEventArgs e) {
    base.OnMouseClick(e);
    for (int i = 0; i < Labels.Length; i++) if (Box(i).Contains(e.Location) && Clicked != null) Clicked(Labels[i]);
  }
}

/** Cửa sổ vẽ hoàn toàn bằng tay (kiểu game / app canvas): cây trợ năng gần như rỗng. Gõ phím khi đã bấm vào "ô" vẽ tay → ghi chữ. */
class DrawnForm : Form {
  string typed = "";
  bool boxActive;
  string clicked = "";
  static readonly Rectangle Btn = new Rectangle(40, 40, 240, 60);
  static readonly Rectangle Box = new Rectangle(40, 140, 360, 50);
  public DrawnForm() {
    Text = "Aivin Bench - Canvas";
    ClientSize = new Size(460, 260);
    StartPosition = FormStartPosition.Manual;
    Location = new Point(160, 120);
    DoubleBuffered = true;
    KeyPreview = true;
    BackColor = Color.White;
    Shown += (s, e) => Dump();
  }
  protected override void OnPaint(PaintEventArgs e) {
    using (var f = new Font("Segoe UI", 14f)) {
      e.Graphics.FillRectangle(Brushes.LightSteelBlue, Btn);
      TextRenderer.DrawText(e.Graphics, "Confirm order", f, Btn, Color.Black, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
      e.Graphics.DrawRectangle(boxActive ? Pens.Blue : Pens.Gray, Box);
      TextRenderer.DrawText(e.Graphics, typed.Length > 0 ? typed : "Customer code", f, Box, typed.Length > 0 ? Color.Black : Color.Gray, TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
    }
  }
  protected override void OnMouseClick(MouseEventArgs e) {
    if (Btn.Contains(e.Location)) clicked = "Confirm order";
    boxActive = Box.Contains(e.Location);
    Invalidate();
    Dump();
  }
  protected override void OnKeyPress(KeyPressEventArgs e) {
    if (!boxActive) return;
    if (e.KeyChar == '\b') { if (typed.Length > 0) typed = typed.Substring(0, typed.Length - 1); }
    else if (!char.IsControl(e.KeyChar)) typed += e.KeyChar;
    Invalidate();
    Dump();
  }
  void Dump() { BenchApp.Write("{\"clicked\":\"" + BenchApp.Esc(clicked) + "\",\"typed\":\"" + BenchApp.Esc(typed) + "\"}"); }
}
