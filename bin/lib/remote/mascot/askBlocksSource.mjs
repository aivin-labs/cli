/**
 * Bảng, thẻ, ảnh trong ô hỏi của linh vật (03/11/2026) — mã PowerShell chèn vào ASK_PS1 (askHostSource.mjs), nhận `blocks` của lệnh `chat` (blocks.mjs).
 * - Có khối thì ô hỏi nới rộng ra `ASK_WIDE_WIDTH` (chữ bình thường vẫn ô nhỏ), `chat_clear` thu về; vùng chat cao thêm để đọc được bảng.
 * - Bảng: cột co giãn theo `weights`, ô dài xuống dòng rồi cắt bằng dấu "…". Thẻ: xếp dọc, ảnh nhỏ hoặc icon bên trái. Ảnh: giữ tỉ lệ, bấm mở trên trình duyệt.
 * - Ảnh chờ daemon tải (`done` chưa có): ô xám; tải xong daemon gửi lại đúng dòng đó. Giải mã không được (máy thiếu codec WebP…) → nút mở link.
 * - Biểu đồ: daemon tính sẵn từng hình (chartLayout.mjs), ở đây chỉ đặt lên canvas. Sơ đồ: ảnh do daemon dựng (diagramRender.mjs). Công cụ tương tác, tệp, video, link,
 *   phiên trình duyệt: thẻ bấm mở. Nguồn trích dẫn: chip nhỏ.
 * Giữ toàn ASCII (xem hostSource.mjs).
 */
const ASK_NARROW_WIDTH = 240;
const ASK_WIDE_WIDTH = 320;
const CHAT_NARROW_HEIGHT = 220;
const CHAT_WIDE_HEIGHT = 380;
const BUBBLE_NARROW_WIDTH = 200;
const BUBBLE_WIDE_WIDTH = 276;
/** Bề rộng dùng được của khối trong ô đã nới rộng. */
const BLOCK_WIDTH = 288;
const IMAGE_MAX_HEIGHT = 180;
const IMAGE_PLACEHOLDER_HEIGHT = 110;
const THUMB_SIZE = 28;
const CARD_BG = '#F7F8FA';
const LINE = '#E5E6EB';
const CELL_LINE = '#EEF0F4';
const HEADER_BG = '#F7F8FA';
const PLACEHOLDER = '#F2F3F5';
const TAG_BG = '#EEF0FF';
const TAG_INK = '#5B50D6';
/** Ô icon của thẻ: nền pastel, icon cùng tông nhưng đậm hơn (hồng, tím, xanh trời, xanh bạc hà — xoay vòng như lựa chọn trong ô hỏi). */
const ICON_TINTS = Object.freeze(['#FCE7F3', '#EDE9FE', '#DBEAFE', '#D1FAE5']);
export const ICON_INKS = Object.freeze(['#DB2777', '#7C3AED', '#2563EB', '#059669']);
const CARD_ICON_SIZE = 14;
/** Sơ đồ thường cao hơn ảnh: thấp quá thì chữ không đọc được. */
const DIAGRAM_MAX_HEIGHT = 320;

export const ASK_BLOCKS_PS1 = String.raw`
# ---- Rich blocks in the ask box (askBlocksSource.mjs) ----
$script:askWide = $false; $script:bubbleMax = ${BUBBLE_NARROW_WIDTH}; $script:scrollRow = $null
function AskWidth($wide) {
  if ([bool]$wide -eq $script:askWide) { return }
  $script:askWide = [bool]$wide
  $script:bubbleMax = if ($wide) { ${BUBBLE_WIDE_WIDTH} } else { ${BUBBLE_NARROW_WIDTH} }
  foreach ($r in $script:chatRows.Values) { $r.box.MaxWidth = $script:bubbleMax }
  (E 'ChatScroll').MaxHeight = if ($wide) { ${CHAT_WIDE_HEIGHT} } else { ${CHAT_NARROW_HEIGHT} }
  $ease = New-Object Windows.Media.Animation.CubicEase; $ease.EasingMode = 'EaseOut'
  $a = New-Object Windows.Media.Animation.DoubleAnimation ([double]$(if ($wide) { ${ASK_WIDE_WIDTH} } else { ${ASK_NARROW_WIDTH} })), ([TimeSpan]::FromMilliseconds(180))
  $a.EasingFunction = $ease
  # Text wraps again while the box grows: the answer's first line is only in its final place afterwards.
  $a.Add_Completed({ if ($script:scrollRow) { ScrollToRow $script:scrollRow } })
  (E 'Ask').BeginAnimation([Windows.FrameworkElement]::WidthProperty, $a)
}
# A table is read from the top: show the answer's first line, not the end of the list.
function ScrollToRow($row) {
  $sv = E 'ChatScroll'; $sv.UpdateLayout()
  $p = $row.box.TranslatePoint((New-Object Windows.Point 0, 0), (E 'ChatList'))
  $sv.ScrollToVerticalOffset([Math]::Max(0, $p.Y - 2))
}
# Lucide icon outline from the daemon (lucideIcons.mjs): drawn on its 24 x 24 grid, stroke 2, round ends, like on the web. Clipped to the grid: a browser
# clips an svg to its box, and a few Lucide icons do have a stroke outside it (save-off).
function LucideIcon($path, $size, $ink) {
  $p = New-Object Windows.Shapes.Path; $p.Data = [Windows.Media.Geometry]::Parse([string]$path); $p.Stroke = Brush $ink; $p.StrokeThickness = 2
  $p.StrokeStartLineCap = 'Round'; $p.StrokeEndLineCap = 'Round'; $p.StrokeLineJoin = 'Round'
  $grid = New-Object Windows.Controls.Canvas; $grid.Width = 24; $grid.Height = 24; $grid.ClipToBounds = $true; [void]$grid.Children.Add($p)
  $box = New-Object Windows.Controls.Viewbox; $box.Width = $size; $box.Height = $size; $box.Child = $grid; $box
}
function BlockText($text, $size, $ink) {
  $t = New-Object Windows.Controls.TextBlock; $t.TextWrapping = 'Wrap'; $t.FontSize = $size; $t.Foreground = Brush $ink; SetText $t $text; $t
}
function BlockTitle($text) { $t = BlockText $text 12 $P.muted; $t.FontWeight = 'SemiBold'; $t.Margin = '2,0,0,4'; $t }
function BlockNote($text) { $t = BlockText $text 11.5 $P.muted; $t.Margin = '2,3,0,0'; $t }
# Rounded corners for what is inside a border (a border does not clip its child). The radius rides on Tag: the handler is not a closure.
function RoundCorners($el, $radius) {
  $el.Tag = [double]$radius
  $el.Add_SizeChanged({ param($s)
    $s.Clip = New-Object Windows.Media.RectangleGeometry -ArgumentList (New-Object Windows.Rect 0, 0, $s.ActualWidth, $s.ActualHeight), ([double]$s.Tag), ([double]$s.Tag)
  })
}
function BlockTable($b) {
  $wrap = New-Object Windows.Controls.StackPanel; $wrap.Margin = '0,0,0,6'
  if ($b.title) { [void]$wrap.Children.Add((BlockTitle $b.title)) }
  $grid = New-Object Windows.Controls.Grid; $grid.Background = Brush '#FFFFFF'; RoundCorners $grid 7
  foreach ($weight in @($b.weights)) {
    $cd = New-Object Windows.Controls.ColumnDefinition
    $cd.Width = New-Object Windows.GridLength -ArgumentList ([double]$weight), ([Windows.GridUnitType]::Star)
    [void]$grid.ColumnDefinitions.Add($cd)
  }
  $rows = @($b.rows); $cols = [int]$b.cols
  for ($r = 0; $r -lt $rows.Count; $r++) {
    $rd = New-Object Windows.Controls.RowDefinition; $rd.Height = [Windows.GridLength]::Auto; [void]$grid.RowDefinitions.Add($rd)
    $isHeader = $b.header -and $r -eq 0
    $col = 0
    foreach ($cell in @($rows[$r])) {
      if ($col -ge $cols) { break }
      if ($cell.covered) { $col++; continue }
      $span = [Math]::Min($(if ($cell.span) { [int]$cell.span } else { 1 }), $cols - $col)
      $box = New-Object Windows.Controls.Border; $box.Padding = '7,4,7,4'; $box.BorderBrush = Brush '${CELL_LINE}'
      $box.BorderThickness = if ($b.plain) { New-Object Windows.Thickness 0 } else { New-Object Windows.Thickness -ArgumentList 0, 0, $(if ($col + $span -lt $cols) { 1 } else { 0 }), $(if ($r -lt $rows.Count - 1) { 1 } else { 0 }) }
      $box.Background = Brush $(if ($cell.bg) { [string]$cell.bg } elseif ($isHeader) { '${HEADER_BG}' } else { '#FFFFFF' })
      $t = BlockText $cell.text 12 $(if ($cell.color) { [string]$cell.color } else { $P.ink })
      $t.MaxHeight = 48; $t.TextTrimming = 'CharacterEllipsis'; $t.LineHeight = 16; $t.LineStackingStrategy = 'BlockLineHeight'
      if ($isHeader -or $cell.bold) { $t.FontWeight = 'SemiBold' }
      if ($cell.italic) { $t.FontStyle = 'Italic' }
      $t.TextAlignment = switch ([string]$cell.align) { 'right' { 'Right' } 'center' { 'Center' } default { 'Left' } }
      $box.Child = $t
      [Windows.Controls.Grid]::SetRow($box, $r); [Windows.Controls.Grid]::SetColumn($box, $col)
      if ($span -gt 1) { [Windows.Controls.Grid]::SetColumnSpan($box, $span) }
      if ($cell.rowspan) { [Windows.Controls.Grid]::SetRowSpan($box, [int]$cell.rowspan) }
      [void]$grid.Children.Add($box)
      $col += $span
    }
  }
  $frame = New-Object Windows.Controls.Border; $frame.CornerRadius = '8'; $frame.BorderThickness = $(if ($b.plain) { '0' } else { '1' }); $frame.BorderBrush = Brush '${LINE}'; $frame.Child = $grid
  [void]$wrap.Children.Add($frame)
  if ($b.note) { [void]$wrap.Children.Add((BlockNote $b.note)) }
  $wrap
}
# Image file checked by the daemon (images.mjs) -> bitmap, or null when this machine cannot decode it.
function LoadBitmap($file, $width) {
  try {
    $bmp = New-Object Windows.Media.Imaging.BitmapImage; $bmp.BeginInit(); $bmp.UriSource = New-Object Uri ([string]$file); $bmp.CacheOption = 'OnLoad'
    $bmp.CreateOptions = 'IgnoreColorProfile'; $bmp.DecodePixelWidth = [int]$width; $bmp.EndInit(); $bmp.Freeze(); return $bmp
  } catch { Dbg "image: $($_.Exception.Message)"; return $null }
}
function PictureFill($bmp) {
  $brush = New-Object Windows.Media.ImageBrush $bmp; $brush.Stretch = 'UniformToFill'; $brush.Freeze(); $brush
}
function CardThumb($c, $tint, $ink) {
  $box = New-Object Windows.Controls.Border; $box.Width = ${THUMB_SIZE}; $box.Height = ${THUMB_SIZE}; $box.CornerRadius = '8'; $box.Margin = '0,1,8,0'; $box.VerticalAlignment = 'Top'
  $bmp = if ($c.file) { LoadBitmap $c.file 160 } else { $null }
  if ($bmp) { $box.Background = PictureFill $bmp; return $box }
  # An image still loading: a grey square, the picture replaces it.
  if ($c.image) { $box.Background = Brush '${PLACEHOLDER}'; return $box }
  $box.Background = Brush $tint
  if ($c.icon_path) { $icon = LucideIcon $c.icon_path ${CARD_ICON_SIZE} $ink; $icon.HorizontalAlignment = 'Center'; $icon.VerticalAlignment = 'Center'; $box.Child = $icon }
  $box
}
function BlockCards($b) {
  $wrap = New-Object Windows.Controls.StackPanel; $wrap.Margin = '0,0,0,6'
  if ($b.title) { [void]$wrap.Children.Add((BlockTitle $b.title)) }
  $tints = @(${ICON_TINTS.map((c) => `'${c}'`).join(', ')}); $inks = @(${ICON_INKS.map((c) => `'${c}'`).join(', ')}); $k = 0
  foreach ($c in @($b.cards)) {
    $card = New-Object Windows.Controls.Border; $card.CornerRadius = '10'; $card.Background = Brush '${CARD_BG}'; $card.Padding = '8,7,10,7'; $card.Margin = '0,0,0,4'
    $dock = New-Object Windows.Controls.DockPanel
    $thumb = CardThumb $c $tints[$k % $tints.Count] $inks[$k % $inks.Count]; $k++
    [Windows.Controls.DockPanel]::SetDock($thumb, 'Left'); [void]$dock.Children.Add($thumb)
    $sp = New-Object Windows.Controls.StackPanel
    $title = BlockText $c.title 13 $P.ink; $title.FontWeight = 'SemiBold'; [void]$sp.Children.Add($title)
    if ($c.text) { $d = BlockText $c.text 12 $P.muted; $d.MaxHeight = 50; $d.TextTrimming = 'CharacterEllipsis'; $d.Margin = '0,1,0,0'; [void]$sp.Children.Add($d) }
    if ($c.tags) {
      $tags = New-Object Windows.Controls.WrapPanel; $tags.Margin = '0,3,0,0'
      foreach ($tag in @($c.tags)) {
        $chip = New-Object Windows.Controls.Border; $chip.CornerRadius = '6'; $chip.Background = Brush '${TAG_BG}'; $chip.Padding = '6,1,6,2'; $chip.Margin = '0,0,4,2'
        $chip.Child = BlockText $tag 11 '${TAG_INK}'; [void]$tags.Children.Add($chip)
      }
      [void]$sp.Children.Add($tags)
    }
    if ($c.footer) { $f = BlockText $c.footer 11 $P.muted; $f.Margin = '0,2,0,0'; [void]$sp.Children.Add($f) }
    [void]$dock.Children.Add($sp); $card.Child = $dock; [void]$wrap.Children.Add($card)
  }
  if ($b.note) { [void]$wrap.Children.Add((BlockNote $b.note)) }
  $wrap
}
function BlockImage($b, $maxHeight = ${IMAGE_MAX_HEIGHT}) {
  $wrap = New-Object Windows.Controls.StackPanel; $wrap.Margin = '0,0,0,6'
  if (-not $b.done) {
    $wait = New-Object Windows.Controls.Border; $wait.CornerRadius = '8'; $wait.Height = ${IMAGE_PLACEHOLDER_HEIGHT}; $wait.Background = Brush '${PLACEHOLDER}'
    [void]$wrap.Children.Add($wait)
  } else {
    $bmp = if ($b.file) { LoadBitmap $b.file ${BLOCK_WIDTH * 2} } else { $null }
    if (-not $bmp) { if ($b.url) { [void]$wrap.Children.Add((LinkCard $b.open_text $b.url)) }; return $wrap }
    # Keep the picture's shape: as wide as the box, unless that makes it too tall.
    $width = [Math]::Min(${BLOCK_WIDTH}, [double]$bmp.PixelWidth); $height = $width * $bmp.PixelHeight / [Math]::Max(1, $bmp.PixelWidth)
    if ($height -gt $maxHeight) { $width = $width * $maxHeight / $height; $height = $maxHeight }
    $pic = New-Object Windows.Controls.Border; $pic.CornerRadius = '8'; $pic.Width = $width; $pic.Height = $height; $pic.HorizontalAlignment = 'Left'
    $pic.Background = PictureFill $bmp
    if ($b.url) {
      $pic.Cursor = [Windows.Input.Cursors]::Hand; $pic.ToolTip = [string]$b.url; $pic.Tag = [string]$b.url
      $pic.Add_MouseLeftButtonUp({ param($s) OpenWebUrl $s.Tag })
    }
    [void]$wrap.Children.Add($pic)
  }
  if ($b.caption) { [void]$wrap.Children.Add((BlockNote $b.caption)) }
  $wrap
}
# Chart: the daemon works out every shape (chartLayout.mjs), here they are only placed on a canvas. k = r(ect), p(ath), c(ircle), t(ext).
function ChartShape($canvas, $s) {
  $el = switch ([string]$s.k) {
    'r' { $x = New-Object Windows.Shapes.Rectangle; $x.Width = [double]$s.w; $x.Height = [double]$s.h; $x.Fill = Brush $s.f; if ($s.rx) { $x.RadiusX = [double]$s.rx; $x.RadiusY = [double]$s.rx }; [Windows.Controls.Canvas]::SetLeft($x, [double]$s.x); [Windows.Controls.Canvas]::SetTop($x, [double]$s.y); $x }
    'p' {
      $x = New-Object Windows.Shapes.Path; $x.Data = [Windows.Media.Geometry]::Parse([string]$s.d)
      if ($s.s) { $x.Stroke = Brush $s.s; $x.StrokeThickness = $(if ($s.sw) { [double]$s.sw } else { 1 }); $x.StrokeLineJoin = 'Round' }
      if ($s.f) { $x.Fill = Brush $s.f }
      $x
    }
    'c' {
      $x = New-Object Windows.Shapes.Ellipse; $r = [double]$s.r; $x.Width = 2 * $r; $x.Height = 2 * $r
      if ($s.f) { $x.Fill = Brush $s.f }
      if ($s.s) { $x.Stroke = Brush $s.s; $x.StrokeThickness = 1.4 }
      [Windows.Controls.Canvas]::SetLeft($x, [double]$s.x - $r); [Windows.Controls.Canvas]::SetTop($x, [double]$s.y - $r); $x
    }
    't' {
      $x = New-Object Windows.Controls.TextBlock; $x.Text = [string]$s.t; $x.Width = [double]$s.w; $x.FontSize = $(if ($s.z) { [double]$s.z } else { 11 }); $x.TextTrimming = 'CharacterEllipsis'
      $x.Foreground = Brush $(if ($s.c) { [string]$s.c } else { $P.ink }); if ($s.b) { $x.FontWeight = 'SemiBold' }
      $x.TextAlignment = switch ([string]$s.a) { 'r' { 'Right' } 'c' { 'Center' } default { 'Left' } }
      [Windows.Controls.Canvas]::SetLeft($x, [double]$s.x); [Windows.Controls.Canvas]::SetTop($x, [double]$s.y); $x
    }
    default { $null }
  }
  if ($el) { [void]$canvas.Children.Add($el) }
}
function BlockChart($b) {
  $wrap = New-Object Windows.Controls.StackPanel; $wrap.Margin = '0,0,0,6'
  if ($b.title) { [void]$wrap.Children.Add((BlockTitle $b.title)) }
  $canvas = New-Object Windows.Controls.Canvas; $canvas.Width = [double]$b.layout.w; $canvas.Height = [double]$b.layout.h; $canvas.HorizontalAlignment = 'Left'
  foreach ($s in @($b.layout.shapes)) { ChartShape $canvas $s }
  [void]$wrap.Children.Add($canvas)
  if ($b.layout.legend) {
    $legend = New-Object Windows.Controls.WrapPanel; $legend.Margin = '2,5,0,0'
    foreach ($l in @($b.layout.legend)) {
      $item = New-Object Windows.Controls.StackPanel; $item.Orientation = 'Horizontal'; $item.Margin = '0,0,10,2'
      $dot = New-Object Windows.Shapes.Rectangle; $dot.Width = 9; $dot.Height = 9; $dot.RadiusX = 2.5; $dot.RadiusY = 2.5; $dot.Fill = Brush $l.color; $dot.VerticalAlignment = 'Center'; $dot.Margin = '0,1,4,0'
      [void]$item.Children.Add($dot)
      $tb = BlockText $l.label 11.5 $P.muted; $tb.TextWrapping = 'NoWrap'; [void]$item.Children.Add($tb)
      [void]$legend.Children.Add($item)
    }
    [void]$wrap.Children.Add($legend)
  }
  if ($b.note) { [void]$wrap.Children.Add((BlockNote $b.note)) }
  $wrap
}
# A card that opens something: tool (webview: the daemon opens it in its own window), file, video, link, the AI browser session on the web.
function BlockActionCard($b) {
  $btn = New-Object Windows.Controls.Button; $btn.Style = $w.FindResource('Btn'); $btn.Background = Brush '${CARD_BG}'; $btn.BorderThickness = '0'; $btn.Tag = Brush '#0A000000'
  $btn.FontSize = 13; $btn.FontWeight = 'Normal'; $btn.Padding = '8,7,10,7'; $btn.Margin = '0,0,0,6'; $btn.HorizontalContentAlignment = 'Stretch'; $btn.HorizontalAlignment = 'Stretch'
  $dock = New-Object Windows.Controls.DockPanel; $dock.Width = ${BLOCK_WIDTH - 20}
  $thumb = CardThumb $b '${ICON_TINTS[2]}' '${ICON_INKS[2]}'
  [Windows.Controls.DockPanel]::SetDock($thumb, 'Left'); [void]$dock.Children.Add($thumb)
  $sp = New-Object Windows.Controls.StackPanel; $sp.VerticalAlignment = 'Center'
  $title = BlockText $b.title 13 $P.ink; $title.FontWeight = 'SemiBold'; [void]$sp.Children.Add($title)
  if ($b.text) { $d = BlockText $b.text 12 $P.muted; $d.MaxHeight = 34; $d.TextTrimming = 'CharacterEllipsis'; [void]$sp.Children.Add($d) }
  if ($b.action) { $a = BlockText $b.action 12 '${ICON_INKS[2]}'; $a.Margin = '0,1,0,0'; [void]$sp.Children.Add($a) }
  [void]$dock.Children.Add($sp); $btn.Content = $dock
  if ([string]$b.type -eq 'webview') {
    $btn.CommandParameter = @{ t = 'open_webview'; session_id = [string]$b.session_id; message_id = [string]$b.message_id; index = [int]$b.index; title = [string]$b.title }
    $btn.Add_Click({ param($s) Send $s.CommandParameter })
  } else {
    $btn.CommandParameter = [string]$b.url; $btn.ToolTip = [string]$b.url
    $btn.Add_Click({ param($s) OpenWebUrl $s.CommandParameter })
  }
  $btn
}
# Sources the answer cites: small chips, a click opens the page when the source has one.
function BlockSources($b) {
  $wrap = New-Object Windows.Controls.WrapPanel; $wrap.Margin = '0,0,0,6'
  $label = BlockText $b.label 11.5 $P.muted; $label.TextWrapping = 'NoWrap'; $label.Margin = '2,2,6,2'; $label.VerticalAlignment = 'Center'; [void]$wrap.Children.Add($label)
  foreach ($i in @($b.items)) {
    $chip = New-Object Windows.Controls.Border; $chip.CornerRadius = '6'; $chip.Background = Brush '${PLACEHOLDER}'; $chip.Padding = '6,1,6,2'; $chip.Margin = '0,0,4,3'; $chip.MaxWidth = 180
    $tb = BlockText $i.name 11.5 $P.ink; $tb.TextWrapping = 'NoWrap'; $tb.TextTrimming = 'CharacterEllipsis'; $chip.Child = $tb
    if ($i.url) {
      $chip.Cursor = [Windows.Input.Cursors]::Hand; $chip.ToolTip = [string]$i.url; $chip.Tag = [string]$i.url
      $chip.Add_MouseLeftButtonUp({ param($s) OpenWebUrl $s.Tag })
    }
    [void]$wrap.Children.Add($chip)
  }
  $wrap
}
function ChatBlocks($row, $blocks) {
  $list = E 'ChatList'
  if ($row.blocks) { [void]$list.Children.Remove($row.blocks); $row.blocks = $null }
  $items = @(@($blocks) | Where-Object { $_ })
  if (-not $items.Count) { return }
  AskWidth $true
  $sp = New-Object Windows.Controls.StackPanel; $sp.Margin = '0,2,0,0'
  foreach ($b in $items) {
    $el = $null
    try {
      $el = switch ([string]$b.type) {
        'table' { BlockTable $b } 'cards' { BlockCards $b } 'image' { BlockImage $b } 'diagram' { BlockImage $b ${DIAGRAM_MAX_HEIGHT} } 'chart' { BlockChart $b }
        'webview' { BlockActionCard $b } 'link_card' { BlockActionCard $b } 'sources' { BlockSources $b } default { $null }
      }
    } catch { Dbg "block: $($_.Exception.Message)" }
    if ($el) { [void]$sp.Children.Add($el) }
  }
  $list.Children.Insert($list.Children.IndexOf($row.box) + 1, $sp); $row.blocks = $sp
}
# ---- end rich blocks ----
`;
