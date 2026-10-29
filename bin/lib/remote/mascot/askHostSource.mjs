/**
 * Ô hỏi của linh vật, phía cửa sổ (29/10/2026) — mã PowerShell chèn vào host.ps1 tại dấu `# @ASK_HOOK` (index.mjs ghép), dùng khung
 * XAML `Ask` / `ChatList` / `AskBox` / `MicBtn` (`MicIcon` / `SendIcon`) / `AskStatus` của hostSource.mjs.
 *
 * - Rê chuột vào bot → ô hỏi hiện ra (chưa nhận bàn phím); rời chuột ~0,6 s → ẩn, trừ khi đang dùng (đang gõ trong ô, đang ghi âm, đang
 *   chờ trả lời — trả lời xong mà chuột không ở đó thì ẩn sau 8 s). Bấm bot / bấm vào ô → cửa sổ nhận bàn phím (bỏ WS_EX_NOACTIVATE + đưa lên
 *   trước) để gõ; bấm ra ngoài / Esc / bấm bot lần nữa thì đóng, về không cướp focus. Chữ gõ dở vẫn giữ cho lần hiện sau. Chuột phải → nhật ký.
 * - Mỗi lúc một khung: ô hỏi đang mở thì việc bot làm trên máy không bật bong bóng (chỉ cập nhật chữ); ô đóng mà bot còn bận thì
 *   bong bóng hiện lại bước mới nhất.
 * - Một nút ở góc dưới: ô trống = mic, có chữ = gửi. Enter / nút gửi → `{ t: 'ask', text, window }`. Mic = nói chuyện trực tiếp (realtime) với Aivin:
 *   bấm → `{ t: 'voice_start', window }`, daemon mở phiên thoại trên BE rồi gửi `voice_begin { in_rate, out_rate }` → mở mic + loa (voiceSource.mjs,
 *   âm thanh đi thẳng giữa C# và stdin/stdout). Đang nghe mà bấm → `voice_stop`; bot đang nói mà bấm → `voice_interrupt` (ngắt lời; có
 *   khử tiếng vọng thì nói chen bằng giọng cũng được). BE cũ chưa có nói chuyện: `voice_begin { state: 'recording' }` — nói xong bấm mic để gửi.
 *   Phím tắt (Ctrl+Alt+Space, bị chiếm thì Win+Alt+Space / Ctrl+Alt+V; hiện trong chú thích nút mic) ở đâu cũng = bấm mic. Trạng thái "đang nói" giữ tới khi loa im thật (BE báo xong sớm hơn loa phát hết); mặt bot theo
 *   trạng thái nói chuyện (nghe / nghĩ / nói).
 * - `window` = `{ window: '0x..', title, process }` của cửa sổ chủ máy đang dùng ngay trước khi rê / bấm vào bot hay nhấn phím tắt (không tính
 *   chính bot, thanh tác vụ, màn nền), hoặc null — để "cái này" trong câu hỏi trỏ đúng cửa sổ đó.
 * - Lệnh vào thêm: `chat { role, id, text, remove? }`, `chat_busy { busy }`, `ask_status { text }`, `voice_begin`, `voice_state { state }`
 *   (listening | thinking | speaking), `voice_end { text? }`.
 * Giữ toàn ASCII (xem hostSource.mjs).
 */
import { ASK_BTN } from './hostSource.mjs';

/**
 * Lựa chọn khi Aivin hỏi lại: mỗi thẻ tô một màu pastel nhạt (xoay vòng hồng → tím nhạt → xanh trời → xanh bạc hà, theo viền ô hỏi), không
 * viền, chữ xám đậm; rê chuột thì thẻ đậm lên nhẹ.
 */
const CHOICE_CARDS = Object.freeze(['#FDF2F8', '#F5F3FF', '#EFF6FF', '#ECFDF5']);
const CHOICE_INK = '#3B4256';
const CHOICE_HOVER = '#0F1E1B4B';

export const ASK_PS1 = String.raw`
# ---- Ask box (askHostSource.mjs) ----
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
namespace AivinMascotAsk {
  public static class Native {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    /** The window the person is using (not the bot, the taskbar or the desktop): { "0x..", title, pid }, or null. */
    public static string[] UserWindow() {
      IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return null;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == (uint)System.Diagnostics.Process.GetCurrentProcess().Id) return null;
      var c = new System.Text.StringBuilder(256); GetClassName(h, c, 256);
      string cls = c.ToString(); if (cls == "Shell_TrayWnd" || cls == "Progman" || cls == "WorkerW") return null;
      var t = new System.Text.StringBuilder(512); GetWindowText(h, t, 512);
      return new string[] { "0x" + h.ToInt64().ToString("x"), t.ToString(), pid.ToString() };
    }
    /** The user just clicked the bot: take keyboard focus (Windows refuses SetForegroundWindow from a background window otherwise). */
    public static bool TakeFocus(IntPtr h) {
      uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
      bool attached = fg != 0 && fg != me && AttachThreadInput(fg, me, true);
      try { BringWindowToTop(h); return SetForegroundWindow(h); }
      finally { if (attached) AttachThreadInput(fg, me, false); }
    }
  }
}
'@
(E 'AskHint').Text = $T.ask_hint; (E 'MicBtn').ToolTip = $T.ask_mic

function AskShow($name) {
  $script:bubbleTimer.Stop(); (E 'Bubble').Visibility = 'Collapsed'; (E 'Bubble').Opacity = 0
  $el = E $name; $el.Visibility = 'Visible'; $w.FindResource('PanelIn').Begin($el)
}
function AskHide($name) {
  $el = E $name; if ($el.Visibility -ne 'Visible') { return }
  # The ask box may be shown again while it is still fading out: then the finished fade must not collapse it.
  $sb = $w.FindResource('PanelOut').Clone(); $sb.Add_Completed({ if ($name -ne 'Ask' -or -not $script:askOpen) { (E $name).Visibility = 'Collapsed' } }.GetNewClosure()); $sb.Begin($el)
}
function SetActivatable($on) {
  if (-not $script:hwnd) { return }
  $ex = [AivinMascot.Native]::GetWindowLong($script:hwnd, -20)
  $ex = if ($on) { $ex -band (-bnot 0x08000000) } else { $ex -bor 0x08000000 }
  [void][AivinMascot.Native]::SetWindowLong($script:hwnd, -20, $ex)
}
function AskStatus($text) {
  $el = E 'AskStatus'; $el.Text = [string]$text; $el.Visibility = if ($text) { 'Visible' } else { 'Collapsed' }
}
$script:askOpen = $false; $script:askFocused = $false
# The window the person was on right before reaching for the bot: sent with each question / talk so "this" means that window.
$script:askTarget = $null
function NoteTarget {
  $i = $null; try { $i = [AivinMascotAsk.Native]::UserWindow() } catch { }
  if (-not $i) { return }
  $p = ''; try { $p = (Get-Process -Id ([int]$i[2]) -ErrorAction Stop).ProcessName } catch { }
  $script:askTarget = @{ window = $i[0]; title = $i[1]; process = $p }
}
function PeekAsk {
  NoteTarget
  if ($script:askOpen) { return }
  $script:askOpen = $true; AskShow 'Ask'; $w.FindResource('AskGlow').Begin($w, $true)
}
function OpenAsk {
  NoteTarget; AskHide 'Panel'; PeekAsk
  $script:askFocused = $true; SetActivatable $true; $ok = [AivinMascotAsk.Native]::TakeFocus($script:hwnd); [void]$w.Activate(); Dbg "ask focus=$ok"
  [void](E 'AskBox').Focus(); [void][Windows.Input.Keyboard]::Focus((E 'AskBox'))
}
function CloseAsk {
  $script:askHideTimer.Stop()
  if (-not $script:askOpen) { return }
  if ($script:voiceLive) { StopVoice }
  $script:askOpen = $false; $script:askFocused = $false
  AskHide 'Ask'; SetActivatable $false; $w.FindResource('AskGlow').Stop($w)
}
function MascotClick { if ($script:askFocused) { CloseAsk } else { OpenAsk } }
# One box at a time: while the ask box is open, what the bot does on the machine only updates the text; the bubble
# (notification) comes back with the latest step once the box closes, if the bot is still busy.
$script:baseShowBubble = (Get-Item function:ShowBubble).ScriptBlock
function ShowBubble($text) { if ($script:askOpen) { (E 'NowText').Text = $text; return }; & $script:baseShowBubble $text }
$script:baseCloseAsk = (Get-Item function:CloseAsk).ScriptBlock
function CloseAsk {
  $was = $script:askOpen; & $script:baseCloseAsk
  if ($was -and (E 'Panel').Visibility -ne 'Visible' -and ((IsBusy) -or $script:state -eq 'waiting')) { & $script:baseShowBubble (E 'NowText').Text }
}
# Hover: the box peeks while the mouse is over the bot / the box and slips away shortly after it leaves, unless it is in use.
$script:askHideTimer = New-Object Windows.Threading.DispatcherTimer
$script:askHideTimer.Add_Tick({ $script:askHideTimer.Stop(); if (-not (AskInUse)) { CloseAsk } })
function AskInUse { $w.IsMouseOver -or $script:askFocused -or $script:voiceLive -or $script:chatBusy -or $script:drag -or $script:askPinned }
# Aivin is waiting for an answer (HIL): the box stays out with the question + option buttons until it is answered (no focus taken).
$script:askPinned = $false
function HideAskLater($ms) { $script:askHideTimer.Stop(); $script:askHideTimer.Interval = [TimeSpan]::FromMilliseconds($ms); $script:askHideTimer.Start() }
(E 'Mascot').ToolTip = $null
(E 'Mascot').Add_MouseEnter({ $script:askHideTimer.Stop(); if ((E 'Panel').Visibility -ne 'Visible' -and -not $script:drag) { PeekAsk } })
(E 'Ask').Add_MouseEnter({ $script:askHideTimer.Stop() })
$w.Add_MouseLeave({ if ($script:askOpen) { HideAskLater 600 } })
# Clicked somewhere else: give the keyboard back and let the box go once the mouse is away too.
$w.Add_Deactivated({ if ($script:askFocused) { $script:askFocused = $false; SetActivatable $false; if (-not $w.IsMouseOver) { HideAskLater 600 } } })
# Clicking into the peeking box = about to type: take keyboard focus.
(E 'Ask').Add_PreviewMouseLeftButtonDown({ if (-not $script:askFocused) { OpenAsk } })
# Right-click on the bot: the activity panel.
(E 'Mascot').Add_MouseRightButtonUp({ param($s, $e) CloseAsk; TogglePanel; $e.Handled = $true })
# One button: empty box = mic, typed text = send.
function SyncAction {
  $typed = [bool](E 'AskBox').Text.Trim()
  (E 'AskHint').Visibility = if ((E 'AskBox').Text) { 'Collapsed' } else { 'Visible' }
  (E 'SendIcon').Visibility = if ($typed) { 'Visible' } else { 'Collapsed' }; (E 'MicIcon').Visibility = if ($typed) { 'Collapsed' } else { 'Visible' }
  (E 'MicBtn').ToolTip = if ($typed) { $T.ask_send } else { $T.ask_mic }
}
(E 'AskBox').Add_TextChanged({ SyncAction })

$script:chatBusy = $false
function SubmitAsk {
  $text = (E 'AskBox').Text.Trim(); if (-not $text -or $script:chatBusy -or $script:voiceLive) { return }
  NoteTarget; (E 'AskBox').Text = ''; Send @{ t = 'ask'; text = $text; window = $script:askTarget }
}
(E 'AskBox').Add_KeyDown({ param($s, $e)
  if ($e.Key -eq 'Return') { SubmitAsk; $e.Handled = $true }
  elseif ($e.Key -eq 'Escape') { CloseAsk; $e.Handled = $true }
})

# Conversation rows: user (right, light brand), assistant (left, grey), one live progress line, errors. Bubbles point at their speaker
# (the corner on the speaker's side is nearly square, 3 px) and new ones fade + rise in.
$script:chatRows = @{}
function ChatRow($m) {
  $list = E 'ChatList'; $id = [string]$m.id
  $row = $null; if ($id) { $row = $script:chatRows[$id] }
  if ($m.remove) { if ($row) { [void]$list.Children.Remove($row.box); $script:chatRows.Remove($id) }; return }
  (E 'ChatScroll').Visibility = 'Visible'
  if (-not $row) {
    # Segoe UI adds its own space above / below the letters: block line height + slim vertical padding so the space you see is about
    # the same on all four sides.
    $b = New-Object Windows.Controls.Border; $b.Padding = '9,4,9,4'; $b.Margin = '0,0,0,4'; $b.MaxWidth = 188
    $tb = New-Object Windows.Controls.TextBlock; $tb.TextWrapping = 'Wrap'; $tb.FontSize = 12; $tb.LineHeight = 16; $tb.LineStackingStrategy = 'BlockLineHeight'
    $b.Child = $tb; [void]$list.Children.Add($b)
    $slide = New-Object Windows.Media.TranslateTransform 0, 6; $b.RenderTransform = $slide
    $ease = New-Object Windows.Media.Animation.CubicEase; $ease.EasingMode = 'EaseOut'
    $fade = New-Object Windows.Media.Animation.DoubleAnimation 0, 1, ([TimeSpan]::FromMilliseconds(200)); $fade.EasingFunction = $ease
    $rise = New-Object Windows.Media.Animation.DoubleAnimation 6, 0, ([TimeSpan]::FromMilliseconds(240)); $rise.EasingFunction = $ease
    $b.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade); $slide.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $rise)
    $row = @{ box = $b; text = $tb }
    if ($id) { $script:chatRows[$id] = $row }
    while ($list.Children.Count -gt 40) { $list.Children.RemoveAt(0) }
  }
  $role = [string]$m.role
  $row.box.HorizontalAlignment = if ($role -eq 'user') { 'Right' } else { 'Left' }
  # CornerRadius = top-left, top-right, bottom-right, bottom-left.
  $row.box.CornerRadius = if ($role -eq 'user') { '10,10,3,10' } elseif ($role -eq 'progress') { '0' } else { '10,10,10,3' }
  $bg = if ($role -eq 'user') { '#E8F3FF' } elseif ($role -eq 'error') { '#FFECE8' } elseif ($role -eq 'progress') { '#00FFFFFF' } else { '#F4F6FA' }
  $fg = if ($role -eq 'progress') { $P.muted } elseif ($role -eq 'error') { '#CB2634' } else { $P.ink }
  $row.box.Background = Brush $bg; $row.text.Foreground = Brush $fg
  $row.text.FontStyle = if ($role -eq 'progress') { 'Italic' } else { 'Normal' }
  $row.text.Text = [string]$m.text
  # Words the owner is still saying: lighter until the sentence is settled (the box's own opacity is the fade-in).
  $row.text.Opacity = if ($m.partial) { 0.55 } else { 1 }
  (E 'ChatScroll').ScrollToEnd()
}

# Aivin asked something with choices: a vertical list, one full-width row per option (text left, wraps), click = answer (the daemon
# clears them once answered). Typing still works.
# Soft look: each card filled with a light pastel (cycling the ask box's glow colors), no border, dark-grey text; hover deepens it.
function ChoiceButtons($options) {
  $panel = E 'Choices'; $panel.Children.Clear(); $k = 0
  $cards = @(${CHOICE_CARDS.map((c) => `'${c}'`).join(', ')})
  foreach ($o in @($options)) {
    if (-not $o) { continue }
    $c = $cards[$k % $cards.Count]; $k++
    $tb = New-Object Windows.Controls.TextBlock; $tb.Text = [string]$o.text; $tb.TextWrapping = 'Wrap'; $tb.Width = 192; $tb.Foreground = Brush '${CHOICE_INK}'
    $btn = New-Object Windows.Controls.Button; $btn.Style = $w.FindResource('Btn'); $btn.Content = $tb; $btn.CommandParameter = [string]$o.id
    $btn.FontSize = 12; $btn.FontWeight = 'Normal'; $btn.Padding = '10,6,10,6'; $btn.Margin = '0,0,0,4'; $btn.HorizontalAlignment = 'Stretch'
    $btn.Background = Brush $c; $btn.BorderThickness = '0'; $btn.Tag = Brush '${CHOICE_HOVER}'
    $btn.Add_Click({ param($s) if (-not $script:chatBusy) { Send @{ t = 'choose'; id = [string]$s.CommandParameter } } })
    [void]$panel.Children.Add($btn)
  }
  $panel.Visibility = if ($panel.Children.Count) { 'Visible' } else { 'Collapsed' }
}

# Voice: a live conversation with Aivin (voiceSource.mjs streams the mic / speaker). '' = off, else connecting | listening | thinking | speaking,
# or recording (older Aivin server without live voice: talk, click the mic to send, it goes through voice-to-text).
$script:voiceLive = ''
# While talking, the text input gives way to a voice bar in the same spot: level bars (the mic while listening, the bot's voice while it
# talks, a soft wave while it thinks) + a short state. The mic button turns red (its tooltip says what a click does now).
$inputCell = (E 'AskBox').Parent
$voiceBar = New-Object Windows.Controls.StackPanel; $voiceBar.Orientation = 'Horizontal'; $voiceBar.VerticalAlignment = 'Center'; $voiceBar.Visibility = 'Collapsed'
$voiceBar.Margin = '2,0,0,0'
$script:levelBars = @()
foreach ($i in 0..4) {
  $r = New-Object Windows.Shapes.Rectangle; $r.Width = 3; $r.Height = 4; $r.RadiusX = 1.5; $r.RadiusY = 1.5; $r.Margin = '0,0,3,0'
  $r.VerticalAlignment = 'Center'; $r.Fill = Brush '#8B7CF6'; [void]$voiceBar.Children.Add($r); $script:levelBars += $r
}
$voiceLabel = New-Object Windows.Controls.TextBlock; $voiceLabel.FontSize = 13; $voiceLabel.Foreground = Brush $P.ink; $voiceLabel.Margin = '7,0,0,1'
$voiceLabel.VerticalAlignment = 'Center'; $voiceLabel.TextTrimming = 'CharacterEllipsis'; [void]$voiceBar.Children.Add($voiceLabel)
[void]$inputCell.Children.Add($voiceBar)
$script:levelShape = @(0.55, 0.85, 1, 0.85, 0.55); $script:levelNow = @(0, 0, 0, 0, 0)
$script:levelTimer = New-Object Windows.Threading.DispatcherTimer; $script:levelTimer.Interval = [TimeSpan]::FromMilliseconds(50)
$script:levelTimer.Add_Tick({
  $t = [Environment]::TickCount / 1000.0
  $level = switch ($script:voiceLive) {
    'listening' { [AivinMascot.Voice]::MicLevel }
    'recording' { [AivinMascot.Voice]::MicLevel }
    'speaking' { [AivinMascot.Voice]::OutLevel }
    default { -1 }
  }
  for ($i = 0; $i -lt 5; $i++) {
    # No live level (connecting / thinking): a slow travelling wave, so it reads as "working on it".
    $target = if ($level -lt 0) { 0.18 + 0.22 * (0.5 + 0.5 * [Math]::Sin($t * 5 - $i * 0.9)) } else { [Math]::Min(1, $level * $script:levelShape[$i] * (0.8 + 0.2 * [Math]::Sin($t * 17 + $i * 1.7))) }
    $script:levelNow[$i] = $script:levelNow[$i] + ($target - $script:levelNow[$i]) * $(if ($target -gt $script:levelNow[$i]) { 0.6 } else { 0.25 })
    $script:levelBars[$i].Height = 4 + 16 * $script:levelNow[$i]
  }
})
function VoiceLook($on) {
  (E 'MicBtn').Background = Brush $(if ($on) { '${ASK_BTN.recBg}' } else { '${ASK_BTN.bg}' })
  (E 'MicIcon').Stroke = Brush $(if ($on) { '${ASK_BTN.recIcon}' } else { '${ASK_BTN.icon}' })
  (E 'MicBtn').VerticalAlignment = if ($on) { 'Center' } else { 'Bottom' }
  # The input row is two lines tall for typing; the voice bar only needs the button's height.
  $inputCell.MinHeight = if ($on) { 26 } else { 40 }
  (E 'AskBox').Visibility = if ($on) { 'Collapsed' } else { 'Visible' }
  $voiceBar.Visibility = if ($on) { 'Visible' } else { 'Collapsed' }
  if ($on) { (E 'MicIcon').Visibility = 'Visible'; (E 'SendIcon').Visibility = 'Collapsed'; (E 'AskHint').Visibility = 'Collapsed'; $script:levelTimer.Start() }
  else { $script:levelTimer.Stop(); SyncAction }
}
function VoiceState($state) {
  $script:voiceLive = [string]$state
  $voiceLabel.Text = switch ($state) { 'connecting' { $T.voice_connecting } 'listening' { $T.voice_listening } 'thinking' { $T.voice_thinking } 'speaking' { $T.voice_speaking } 'recording' { $T.voice_recording } default { '' } }
  $bars = if ($state -eq 'speaking') { '#F472B6' } elseif ($state -eq 'listening' -or $state -eq 'recording') { '#8B7CF6' } else { '#C4B5FD' }
  foreach ($r in $script:levelBars) { $r.Fill = Brush $bars }
  AskStatus ''
  (E 'MicBtn').ToolTip = switch ($state) { 'speaking' { $T.voice_hint_interrupt } 'recording' { $T.voice_hint_send } default { $T.voice_hint_end } }
  # The bot's face follows the conversation: all ears, thinking, talking (animated mouth).
  SetFace $(switch ($state) { 'thinking' { 'thinking' } 'speaking' { 'speaking' } default { 'listening' } })
}
# The server says the bot finished talking, but the speaker still plays what it has: keep "talking" (and a click = interrupt) until it is
# really quiet, then show the next state.
$script:afterSpeak = ''
$script:speakTimer = New-Object Windows.Threading.DispatcherTimer; $script:speakTimer.Interval = [TimeSpan]::FromMilliseconds(150)
$script:speakTimer.Add_Tick({
  if ($script:afterSpeak -and -not [AivinMascot.Voice]::Playing) { $s = $script:afterSpeak; $script:afterSpeak = ''; if ($script:voiceLive) { VoiceState $s } }
})
function StartVoice { VoiceLook $true; VoiceState 'connecting'; $script:speakTimer.Start(); NoteTarget; Send @{ t = 'voice_start'; window = $script:askTarget } }
function EndVoice($text) {
  [AivinMascot.Voice]::End(); $script:speakTimer.Stop(); $script:afterSpeak = ''; $script:voiceLive = ''; VoiceLook $false; AskStatus $text
  SetFace $script:state
}
function StopVoice { Send @{ t = 'voice_stop' }; EndVoice $T.voice_ended }
function InterruptVoice { [AivinMascot.Voice]::Flush(); $script:afterSpeak = ''; Send @{ t = 'voice_interrupt' }; VoiceState 'listening' }
# One action for the mic button and the hotkey: bot talking -> interrupt; talking with it -> end; idle -> start.
function VoiceToggle {
  if ($script:voiceLive -and $script:voiceLive -ne 'recording' -and [AivinMascot.Voice]::Playing) { InterruptVoice }
  elseif ($script:voiceLive) { StopVoice }
  elseif (-not $script:chatBusy) { PeekAsk; StartVoice }
}
(E 'MicBtn').Add_Click({ if (-not $script:voiceLive -and (E 'AskBox').Text.Trim()) { SubmitAsk } else { VoiceToggle } })
# A hotkey anywhere = the mic button (no need to reach for the bot): the first free of Ctrl+Alt+Space, Win+Alt+Space, Ctrl+Alt+V
# (other apps often hold the first one). Shown in the mic button's tooltip; none free -> no hotkey.
$w.Add_ContentRendered({
  if (-not $script:hwnd) { return }
  $keys = @(@{ n = 'Ctrl+Alt+Space'; m = 0x4003; v = 0x20 }, @{ n = 'Win+Alt+Space'; m = 0x4009; v = 0x20 }, @{ n = 'Ctrl+Alt+V'; m = 0x4003; v = 0x56 })
  $key = $null
  foreach ($k in $keys) { if ([AivinMascotAsk.Native]::RegisterHotKey($script:hwnd, 0xA171, $k.m, $k.v)) { $key = $k; break } }
  if (-not $key) { Dbg 'voice hotkey: all taken'; return }
  Dbg "voice hotkey: $($key.n)"
  $T.ask_mic = "$($T.ask_mic) ($($key.n))"; SyncAction
  [System.Windows.Interop.HwndSource]::FromHwnd($script:hwnd).AddHook([System.Windows.Interop.HwndSourceHook]{
    param($h, $msg, $wp, $lp, [ref]$handled)
    if ($msg -eq 0x0312 -and $wp.ToInt32() -eq 0xA171) { VoiceToggle; $handled.Value = $true }
    [IntPtr]::Zero
  })
})

# Route the ask-box commands; everything else goes to the base handler of hostSource.mjs.
$script:baseHandle = (Get-Item function:Handle).ScriptBlock
function Handle($m) {
  switch ($m.t) {
    'chat' { ChatRow $m; return }
    'chat_busy' {
      $script:chatBusy = [bool]$m.busy; (E 'MicBtn').Opacity = if ($script:chatBusy) { 0.5 } else { 1 }
      # Answer arrived while the user looked elsewhere: leave it readable a while, then tuck the box away.
      if (-not $script:chatBusy -and $script:askOpen -and -not $script:askFocused -and -not $w.IsMouseOver) { HideAskLater 8000 }
      return
    }
    'ask_status' { AskStatus $m.text; return }
    'ask_choices' { ChoiceButtons $m.options; return }
    'ask_pin' {
      $script:askPinned = [bool]$m.on
      if ($script:askPinned) { $script:userHidden = $false; ApplyVisibility; AskHide 'Panel'; PeekAsk; (E 'ChatScroll').ScrollToEnd() }
      elseif ($script:askOpen -and -not $script:askFocused) { HideAskLater 4000 }
      return
    }
    'voice_begin' {
      if (-not $script:voiceLive) { Send @{ t = 'voice_stop' }; return }
      if ([AivinMascot.Voice]::Begin([int]$m.in_rate, [int]$m.out_rate, $true)) {
        Dbg "voice: on, echo cancelled=$([AivinMascot.Voice]::EchoCancelled) $([AivinMascot.Voice]::AecError)"
        VoiceState $(if ($m.state) { [string]$m.state } else { 'listening' })
      } else { Dbg 'voice: no mic'; Send @{ t = 'voice_stop' }; EndVoice $T.ask_no_mic }
      return
    }
    'voice_state' {
      if (-not $script:voiceLive) { return }
      if ($script:voiceLive -eq 'speaking' -and $m.state -ne 'speaking' -and [AivinMascot.Voice]::Playing) { $script:afterSpeak = [string]$m.state }
      else { $script:afterSpeak = ''; VoiceState $m.state }
      return
    }
    'voice_end' { if ($script:voiceLive) { EndVoice $m.text }; return }
    # aivin ui: the user just asked for the mascot from a terminal -> show it and open the ask box ready to type.
    'open_ask' { $script:userHidden = $false; ApplyVisibility; if (-not $script:askFocused) { OpenAsk }; return }
    # Debug only (AIVIN_MASCOT_DEBUG): show the ask box WITHOUT taking keyboard focus, to look at it / screenshot it.
    'ask_preview' { if ($env:AIVIN_MASCOT_DEBUG) { PeekAsk }; return }
    # Debug only: start talking as if the mic was clicked (end-to-end voice test without clicking / taking focus).
    'voice_preview' { if ($env:AIVIN_MASCOT_DEBUG -and -not $script:voiceLive) { VoiceToggle }; return }
    # Debug only: render the ask box (not the screen) to a PNG, to look at the design without screenshots.
    'snap' {
      if (-not $env:AIVIN_MASCOT_DEBUG -or -not $m.file) { return }
      $el = E 'Ask'; $el.UpdateLayout(); $dpi = 2
      $bmp = New-Object Windows.Media.Imaging.RenderTargetBitmap ([int]($el.ActualWidth * $dpi + 24)), ([int]($el.ActualHeight * $dpi + 24)), (96 * $dpi), (96 * $dpi), ([Windows.Media.PixelFormats]::Pbgra32)
      $vis = New-Object Windows.Media.DrawingVisual; $dc = $vis.RenderOpen()
      $dc.DrawRectangle((Brush '#F3F4F6'), $null, (New-Object Windows.Rect 0, 0, ($el.ActualWidth + 12), ($el.ActualHeight + 12)))
      # 1:1, no stretching (the drop shadow makes the visual's bounds bigger than the box).
      $vb = New-Object Windows.Media.VisualBrush $el; $vb.Stretch = 'None'; $vb.AlignmentX = 'Left'; $vb.AlignmentY = 'Top'
      $vb.ViewboxUnits = 'Absolute'; $vb.Viewbox = New-Object Windows.Rect 0, 0, $el.ActualWidth, $el.ActualHeight
      $dc.DrawRectangle($vb, $null, (New-Object Windows.Rect 6, 6, $el.ActualWidth, $el.ActualHeight)); $dc.Close()
      $bmp.Render($vis); $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder; $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
      $fs = [IO.File]::Create([string]$m.file); $enc.Save($fs); $fs.Close(); return
    }
  }
  & $script:baseHandle $m
}
# ---- end ask box ----
`;
