/**
 * Ô hỏi của linh vật, phía cửa sổ (29/10/2026) — mã PowerShell chèn vào host.ps1 tại dấu `# @ASK_HOOK` (index.mjs ghép), dùng khung
 * XAML `Ask` / `ChatList` / `AskBox` / `MicBtn` (`MicIcon` / `SendIcon`) / `AskStatus` của hostSource.mjs.
 *
 * - Rê chuột vào bot → ô hỏi hiện ra (chưa nhận bàn phím); rời chuột ~0,6 s → ẩn. Bấm bot / bấm vào ô / phím tắt → cửa sổ nhận bàn phím (bỏ
 *   WS_EX_NOACTIVATE + đưa lên trước) để gõ; bấm ra ngoài / Esc / bấm bot lần nữa thì đóng, về không cướp focus. Chữ gõ dở vẫn giữ cho lần
 *   hiện sau. Chuột phải → nhật ký.
 * - Ô đang mở mà rảnh `ASK_IDLE_MS` thì tự thu lại (kể cả mở bằng cú bấm / phím tắt; đang nhận bàn phím thì trả bàn phím về cửa sổ trước đó).
 *   Còn đang dùng thì đếm lại: chuột trên ô / bot, đang nói chuyện, đang kéo, Aivin đang chờ trả lời (HIL), hoặc đang nhận bàn phím mà có chữ
 *   gõ dở / tệp chờ gửi / lượt đang chạy.
 * - Mỗi lúc một khung: ô hỏi đang mở thì việc bot làm trên máy không bật bong bóng (chỉ cập nhật chữ); ô đóng mà bot còn bận thì
 *   bong bóng hiện lại bước mới nhất.
 * - Một nút ở góc dưới: ô trống = mic, có chữ = gửi. Enter / nút gửi → `{ t: 'ask', text, window }`. Mic = nói chuyện trực tiếp (realtime) với Aivin:
 *   bấm → `{ t: 'voice_start', window }`, daemon mở phiên thoại trên BE rồi gửi `voice_begin { in_rate, out_rate }` → mở mic + loa (voiceSource.mjs,
 *   âm thanh đi thẳng giữa C# và stdin/stdout). Đang nghe mà bấm → `voice_stop`; bot đang nói mà bấm → `voice_interrupt` (ngắt lời; có
 *   khử tiếng vọng thì nói chen bằng giọng cũng được). BE cũ chưa có nói chuyện: `voice_begin { state: 'recording' }` — nói xong bấm mic để gửi.
 *   Phím tắt nói (`hotkeys.voice` trong config.json do daemon ghi theo hotkey.mjs — mặc định Alt+Shift+Space, chủ máy đặt riêng / tắt bằng
 *   `aivin remote mascot hotkey`; hiện trong chú thích nút mic) ở đâu cũng = bấm mic; phím tắt chat (`hotkeys.chat`) = mở ô hỏi. Trạng thái "đang nói" giữ tới khi loa im thật (BE báo xong sớm hơn loa phát hết); mặt bot theo
 *   trạng thái nói chuyện (nghe / nghĩ / nói).
 * - `window` = `{ window: '0x..', title, process }` của cửa sổ chủ máy đang dùng ngay trước khi rê / bấm vào bot hay nhấn phím tắt (không tính
 *   chính bot, thanh tác vụ, màn nền), hoặc null — để "cái này" trong câu hỏi trỏ đúng cửa sổ đó.
 * - Lệnh vào thêm: `chat { role, id, text, remove? }`, `chat_busy { busy }`, `ask_status { text }`, `voice_begin`, `voice_state { state }`
 *   (listening | thinking | speaking), `voice_end { text? }`.
 * Giữ toàn ASCII (xem hostSource.mjs).
 */
import { ASK_BLOCKS_PS1, ICON_INKS } from './askBlocksSource.mjs';
import { ASK_BTN, MASCOT_CENTER } from './hostSource.mjs';
import { lucidePath } from './lucideIcons.mjs';

/** Ô hỏi rảnh chừng này thì tự thu lại. */
export const ASK_IDLE_MS = 10000;
/** Câu trả lời có bảng / thẻ / ảnh: cần thời gian đọc hơn một câu chữ. */
const ASK_RICH_IDLE_MS = 30000;

/**
 * Lựa chọn khi Aivin hỏi lại: mỗi thẻ tô một màu pastel nhạt (xoay vòng hồng → tím nhạt → xanh trời → xanh bạc hà, theo viền ô hỏi), không
 * viền, chữ xám đậm; rê chuột thì thẻ đậm lên nhẹ.
 */
const CHOICE_CARDS = Object.freeze(['#FDF2F8', '#F5F3FF', '#EFF6FF', '#ECFDF5']);
const CHOICE_INK = '#3B4256';
const CHOICE_HOVER = '#0F1E1B4B';
/** Viền chấm tròn / ô vuông đầu mỗi lựa chọn (chưa tích). */
const CHOICE_MARK = '#9AA1B2';
/**
 * Bề rộng nội dung nút lựa chọn / nút link. Trong ô hỏi (240) nút rộng 213, còn 207 khi thanh cuộn hiện; trừ lề trong 10 + 10 còn 187. Rộng hơn
 * thì mép phải bị cắt — đúng chỗ icon (05/11/2026: 192 làm mất nửa icon khi hội thoại đủ dài để cuộn).
 */
export const CHOICE_ROW_WIDTH = 186;
/** Nút mở link: icon Lucide + màu đậm cùng tông với nền nút (`CHOICE_CARDS[2]`, xanh trời). */
const LINK_ICON_PATH = lucidePath('external-link');
/** Nút x trên chip tệp đính kèm. */
const DETACH_ICON_PATH = lucidePath('x');

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
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    public static bool ClickOutside() { return (GetAsyncKeyState(1) & 0x8000) != 0; }
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
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    /** The box closed by itself while holding the keyboard: back to the window the person came from (only if we still hold it). */
    public static bool GiveFocusBack(IntPtr me, string target) {
      if (GetForegroundWindow() != me) return false;
      IntPtr h = new IntPtr(Convert.ToInt64(target, 16));
      return IsWindow(h) && SetForegroundWindow(h);
    }
  }
}
'@
(E 'AskHint').Text = $T.ask_hint; (E 'MicBtn').ToolTip = $T.ask_mic
# "New chat" on the activity panel: the daemon opens a new chat on the server and sends chat_clear; the ask box opens for the first line.
(E 'NewChatText').Text = $T.new_chat; (E 'NewChatBtn').ToolTip = $T.new_chat_tip
(E 'NewChatBtn').Add_Click({ Send @{ t = 'new_chat' }; OpenAsk })

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
  $el = E 'AskStatus'; SetText $el $text; $el.Visibility = if ($text) { 'Visible' } else { 'Collapsed' }
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
  NoteTarget; AskHide 'Panel'
  $script:askOpen = $true; AskShow 'Ask'; $w.FindResource('AskGlow').Begin($w, $true)
  $script:askFocused = $true; SetActivatable $true; $ok = [AivinMascotAsk.Native]::TakeFocus($script:hwnd); [void]$w.Activate(); Dbg "ask focus=$ok"
  [void](E 'AskBox').Focus(); [void][Windows.Input.Keyboard]::Focus((E 'AskBox'))
  HideAskLater ${ASK_IDLE_MS}
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
function ShowBubble($text) { if ($script:askOpen) { SetText (E 'NowText') $text; return }; & $script:baseShowBubble $text }
$script:baseCloseAsk = (Get-Item function:CloseAsk).ScriptBlock
function CloseAsk {
  $was = $script:askOpen; & $script:baseCloseAsk
  if (-not $was -or (E 'Panel').Visibility -eq 'Visible') { return }
  if ($script:chatBusy -and $script:chatLast) { ChatBubble $script:chatLast }
  elseif ((IsBusy) -or $script:state -eq 'waiting') { & $script:baseShowBubble ([AivinMascot.Emoji]::Text((E 'NowText'))) }
  if ((E 'Bubble').Visibility -eq 'Visible') { $script:bubbleTimer.Stop(); $script:bubbleTimer.Start() }
}
# What the chat turn is doing, short, for the bubble on the bot's head while the box is closed: progress lines, the answer as it is
# written (its tail), the answer / error. Stays up while the turn runs; once it ends the bubble times out as usual.
$script:chatLast = ''
function ChatShort($m) {
  $text = ([string]$m.text -replace '\s+', ' ').Trim()
  if ($m.partial -and $text.Length -gt 90) { $text = "$([char]0x2026)" + $text.Substring($text.Length - 89) }
  $text
}
function ChatBubble($text) {
  if (-not $text -or (E 'Panel').Visibility -eq 'Visible') { return }
  & $script:baseShowBubble $text
  $script:bubbleTimer.Stop(); $script:bubbleTimer.Start()
}
# The box only stays out for a while: it peeks while the mouse is over the bot / the box and slips away shortly after it leaves; opened with
# a click / hotkey, or left open after an answer, it folds away once idle for ASK_IDLE_MS. Still in use when the timer fires = count again.
$script:askHideTimer = New-Object Windows.Threading.DispatcherTimer
$script:askHideTimer.Add_Tick({
  if ($script:askOpen -and (AskInUse)) { HideAskLater ${ASK_IDLE_MS}; return }
  $held = $script:askFocused; CloseAsk
  if ($held -and $script:askTarget) { try { [void][AivinMascotAsk.Native]::GiveFocusBack($script:hwnd, [string]$script:askTarget.window) } catch { } }
})
# In use = keep the box out: mouse over it, talking, dragging, a pinned question, or holding the keyboard with unsent text / files or a running turn.
function AskInUse {
  $w.IsMouseOver -or $script:voiceLive -or $script:drag -or $script:askPinned -or ($script:askFocused -and ($script:chatBusy -or $script:files -or (E 'AskBox').Text.Trim()))
}
# Aivin is waiting for an answer (HIL): the box stays out with the question + option buttons until it is answered (no focus taken).
$script:askPinned = $false
function HideAskLater($ms) { $script:askHideTimer.Stop(); $script:askHideTimer.Interval = [TimeSpan]::FromMilliseconds($ms); $script:askHideTimer.Start() }
(E 'Mascot').ToolTip = $null
(E 'Mascot').Add_MouseEnter({ $script:askHideTimer.Stop(); if ((E 'Panel').Visibility -ne 'Visible' -and -not $script:drag) { PeekAsk } })
(E 'Ask').Add_MouseEnter({ $script:askHideTimer.Stop() })
# Only peeking: gone right after the mouse leaves. Holding the keyboard: the person may be about to type, so the full wait.
$w.Add_MouseLeave({ if ($script:askOpen) { HideAskLater $(if ($script:askFocused) { ${ASK_IDLE_MS} } else { 600 }) } })
# Clicked somewhere else: release keyboard focus and close the box.
$w.Add_Deactivated({
  $script:askFocused = $false; SetActivatable $false
  if ($script:askOpen -and -not $script:voiceLive -and -not $script:drag -and -not $script:askPinned) { CloseAsk }
  if ((E 'Panel').Visibility -eq 'Visible') { ClosePanel }
})
# Click outside detection: transparent window region or anywhere on other windows
$w.Add_PreviewMouseLeftButtonDown({ param($s, $e)
  if (-not $script:askOpen -or $script:drag) { return }
  $pt = $e.GetPosition($w)
  $askBox = E 'Ask'; $mascot = E 'Mascot'; $panel = E 'Panel'
  $inAsk = $askBox.Visibility -eq 'Visible' -and (New-Object Windows.Rect ($askBox.TranslatePoint((New-Object Windows.Point 0, 0), $w)), $askBox.RenderSize).Contains($pt)
  $inMascot = (New-Object Windows.Rect ($mascot.TranslatePoint((New-Object Windows.Point 0, 0), $w)), $mascot.RenderSize).Contains($pt)
  $inPanel = $panel.Visibility -eq 'Visible' -and (New-Object Windows.Rect ($panel.TranslatePoint((New-Object Windows.Point 0, 0), $w)), $panel.RenderSize).Contains($pt)
  if (-not $inAsk -and -not $inMascot -and -not $inPanel -and -not $script:askPinned) {
    CloseAsk
  }
  if (-not $inPanel -and (E 'Panel').Visibility -eq 'Visible' -and -not $inMascot) {
    ClosePanel
  }
})
$script:clickCheckTimer = New-Object Windows.Threading.DispatcherTimer
$script:clickCheckTimer.Interval = [TimeSpan]::FromMilliseconds(50)
$script:clickCheckTimer.Add_Tick({
  if ($script:askOpen -and -not $script:voiceLive -and -not $script:drag -and -not $script:askPinned) {
    if (-not $w.IsMouseOver -and [AivinMascotAsk.Native]::ClickOutside()) {
      CloseAsk
    }
  }
  if ((E 'Panel').Visibility -eq 'Visible' -and -not $script:drag) {
    if (-not $w.IsMouseOver -and [AivinMascotAsk.Native]::ClickOutside()) {
      ClosePanel
    }
  }
})
$script:clickCheckTimer.Start()
# Clicking into the peeking box = about to type: take keyboard focus.
(E 'Ask').Add_PreviewMouseLeftButtonDown({ if (-not $script:askFocused) { OpenAsk } })
# Right-click on the bot: the activity panel.
(E 'Mascot').Add_MouseRightButtonUp({ param($s, $e) CloseAsk; OpenPanel; $e.Handled = $true })
# One button: empty box = mic, typed text = send.
# Waiting on a turn the server can stop (chat_busy { cancel }): the empty-box button is a stop button instead of the mic.
function StopMode { $script:chatBusy -and $script:canCancel -and -not $script:voiceLive -and -not (E 'AskBox').Text.Trim() -and -not $script:files }
function SyncAction {
  # Files waiting (chips above the input): the button sends even with nothing typed, and the hint asks what to do with them.
  $typed = [bool](E 'AskBox').Text.Trim() -or ($script:files -gt 0 -and -not $script:voiceLive)
  $stop = StopMode
  (E 'AskHint').Text = if ($script:files -gt 0) { $T.ask_attached } else { $T.ask_hint }
  (E 'AskHint').Visibility = if ((E 'AskBox').Text) { 'Collapsed' } else { 'Visible' }
  (E 'SendIcon').Visibility = if ($typed) { 'Visible' } else { 'Collapsed' }; (E 'MicIcon').Visibility = if ($typed -or $stop) { 'Collapsed' } else { 'Visible' }
  (E 'StopIcon').Visibility = if ($stop) { 'Visible' } else { 'Collapsed' }
  (E 'MicBtn').ToolTip = if ($typed) { $T.ask_send } elseif ($stop) { $T.ask_stop } else { $T.ask_mic }
  InputLayout
}
# Input row height: two lines for a fresh question; once a conversation is above it (or while talking), one line with the hint and the mic
# button centred on the same line - the box only grows (mic back at the bottom) when the typed text wraps.
function InputLayout {
  $box = E 'AskBox'
  # Box hidden = the voice bar is in its place (VoiceLook hides it before the voice state is set).
  $compact = $box.Visibility -ne 'Visible' -or [bool]$script:voiceLive -or (E 'ChatList').Children.Count -gt 0
  $wrapped = $box.Visibility -eq 'Visible' -and $box.LineCount -gt 1
  $box.Parent.MinHeight = if ($compact) { 26 } else { 40 }
  $mid = if ($compact -and -not $wrapped) { 'Center' } else { 'Top' }
  $box.VerticalAlignment = $mid; (E 'AskHint').VerticalAlignment = $mid
  (E 'MicBtn').VerticalAlignment = if ($compact -and -not $wrapped) { 'Center' } else { 'Bottom' }
}
(E 'AskBox').Add_TextChanged({ SyncAction; AttendAsk; if ($script:askOpen) { HideAskLater ${ASK_IDLE_MS} } })
# Typing: the bot looks at the box (above or below it) while keys come in; a little nod when a question / answer goes out.
function AttendAsk {
  if (-not (E 'AskBox').Text) { return }
  $a = E 'Ask'; $p = $a.TranslatePoint((New-Object Windows.Point ($a.ActualWidth / 2), ($a.ActualHeight / 2)), (E 'Mascot'))
  $script:rig.Attend($p.X - ${MASCOT_CENTER.x}, $p.Y - ${MASCOT_CENTER.y})
}

$script:chatBusy = $false
$script:canCancel = $false
function SubmitAsk {
  $text = (E 'AskBox').Text.Trim(); if ((-not $text -and -not $script:files) -or $script:chatBusy -or $script:voiceLive) { return }
  NoteTarget; (E 'AskBox').Text = ''; $script:rig.Play('ack'); Send @{ t = 'ask'; text = $text; window = $script:askTarget }
}
(E 'AskBox').Add_KeyDown({ param($s, $e)
  if ($e.Key -eq 'Return') { SubmitAsk; $e.Handled = $true }
  elseif ($e.Key -eq 'Escape') { CloseAsk; $e.Handled = $true }
})

# Conversation rows: user (right, light brand), assistant (left, grey), one live progress line, errors. Bubbles point at their speaker
# (the corner on the speaker's side is nearly square, 3 px) and new ones fade + rise in.
$script:chatRows = @{}
# "Working on it": three dots bouncing in turn inside an assistant bubble (a staggered key-frame hop, then a rest).
function TypingDots {
  $sp = New-Object Windows.Controls.StackPanel; $sp.Orientation = 'Horizontal'; $sp.Margin = '1,5,1,5'
  for ($i = 0; $i -lt 3; $i++) {
    $e = New-Object Windows.Shapes.Ellipse; $e.Width = 6; $e.Height = 6; $e.Margin = '2,0,2,0'; $e.Fill = Brush '#9AA0AB'
    $tt = New-Object Windows.Media.TranslateTransform; $e.RenderTransform = $tt
    $a = New-Object Windows.Media.Animation.DoubleAnimationUsingKeyFrames
    $a.Duration = [TimeSpan]::FromMilliseconds(1200); $a.BeginTime = [TimeSpan]::FromMilliseconds(160 * $i)
    $a.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
    foreach ($k in @(@(0, 0), @(280, -4.5), @(560, 0), @(1200, 0))) {
      $f = New-Object Windows.Media.Animation.EasingDoubleKeyFrame ([double]$k[1]), ([Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($k[0])))
      $f.EasingFunction = New-Object Windows.Media.Animation.SineEase; [void]$a.KeyFrames.Add($f)
    }
    $tt.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $a)
    [void]$sp.Children.Add($e)
  }
  $sp
}
# Link buttons under a bubble (the answer's "open this page" buttons, "view on Aivin"): a click opens the browser, nothing goes to the agent.
function LinkCard($text, $url, $iconPath = '${LINK_ICON_PATH}') {
  $dock = New-Object Windows.Controls.DockPanel; $dock.MaxWidth = ${CHOICE_ROW_WIDTH}
  $icon = LucideIcon $(if ($iconPath) { $iconPath } else { '${LINK_ICON_PATH}' }) 13 '${ICON_INKS[2]}'; $icon.Margin = '8,3,0,0'; $icon.VerticalAlignment = 'Top'; [Windows.Controls.DockPanel]::SetDock($icon, 'Right'); [void]$dock.Children.Add($icon)
  $tb = New-Object Windows.Controls.TextBlock; $tb.TextWrapping = 'Wrap'; $tb.Foreground = Brush '${CHOICE_INK}'; SetText $tb $text; [void]$dock.Children.Add($tb)
  $btn = New-Object Windows.Controls.Button; $btn.Style = $w.FindResource('Btn'); $btn.Content = $dock; $btn.CommandParameter = [string]$url; $btn.ToolTip = [string]$url
  $btn.FontSize = 13; $btn.FontWeight = 'Normal'; $btn.Padding = '10,6,10,6'; $btn.Margin = '0,0,0,3'; $btn.HorizontalAlignment = 'Left'
  $btn.Background = Brush '${CHOICE_CARDS[2]}'; $btn.BorderThickness = '0'; $btn.Tag = Brush '${CHOICE_HOVER}'
  $btn.Add_Click({ param($s) OpenWebUrl $s.CommandParameter })
  $btn
}
function ChatLinks($row, $links) {
  $list = E 'ChatList'
  if ($row.links) { [void]$list.Children.Remove($row.links); $row.links = $null }
  $items = @(@($links) | Where-Object { $_ -and $_.url })
  if (-not $items.Count) { return }
  $sp = New-Object Windows.Controls.StackPanel; $sp.Margin = '0,0,0,4'; $sp.HorizontalAlignment = 'Left'
  foreach ($l in $items) { [void]$sp.Children.Add((LinkCard $l.text $l.url $l.icon_path)) }
  $after = if ($row.blocks) { $row.blocks } else { $row.box }
  $list.Children.Insert($list.Children.IndexOf($after) + 1, $sp); $row.links = $sp
}
${ASK_BLOCKS_PS1}
function ChatRow($m) {
  $list = E 'ChatList'; $id = [string]$m.id
  $row = $null; if ($id) { $row = $script:chatRows[$id] }
  if ($m.remove) { if ($row) { ChatLinks $row $null; ChatBlocks $row $null; [void]$list.Children.Remove($row.box); $script:chatRows.Remove($id) }; return }
  (E 'ChatScroll').Visibility = 'Visible'
  if (-not $row) {
    # Segoe UI adds its own space above / below the letters: block line height + slim vertical padding so the space you see is about
    # the same on all four sides.
    $b = New-Object Windows.Controls.Border; $b.Padding = '10,5,10,5'; $b.Margin = '0,0,0,4'; $b.MaxWidth = $script:bubbleMax
    $tb = New-Object Windows.Controls.TextBlock; $tb.TextWrapping = 'Wrap'; $tb.FontSize = 14; $tb.LineHeight = 20; $tb.LineStackingStrategy = 'BlockLineHeight'
    $b.Child = $tb; [void]$list.Children.Add($b)
    $slide = New-Object Windows.Media.TranslateTransform 0, 6; $b.RenderTransform = $slide
    $ease = New-Object Windows.Media.Animation.CubicEase; $ease.EasingMode = 'EaseOut'
    $fade = New-Object Windows.Media.Animation.DoubleAnimation 0, 1, ([TimeSpan]::FromMilliseconds(200)); $fade.EasingFunction = $ease
    $rise = New-Object Windows.Media.Animation.DoubleAnimation 6, 0, ([TimeSpan]::FromMilliseconds(240)); $rise.EasingFunction = $ease
    $b.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade); $slide.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $rise)
    $row = @{ box = $b; text = $tb; url = $null }
    # The link rides on the bubble itself (Tag, updated below): the handler is not a closure, $row at click time is not this row.
    $b.Add_MouseLeftButtonUp({ param($s) OpenWebUrl $s.Tag })
    if ($id) { $script:chatRows[$id] = $row }
    while ($list.Children.Count -gt 40) { $list.Children.RemoveAt(0) }
  }
  if ($m.url) {
    $row.url = [string]$m.url; $row.box.Tag = [string]$m.url
    $row.box.Cursor = [Windows.Input.Cursors]::Hand
    $row.box.ToolTip = [string]$m.url
  } else {
    $row.url = $null; $row.box.Tag = $null
    $row.box.Cursor = [Windows.Input.Cursors]::Arrow
    $row.box.ToolTip = $null
  }
  $role = [string]$m.role
  $row.box.HorizontalAlignment = if ($role -eq 'user') { 'Right' } else { 'Left' }
  # CornerRadius = top-left, top-right, bottom-right, bottom-left.
  $row.box.CornerRadius = if ($role -eq 'user') { '10,10,3,10' } elseif ($role -eq 'progress') { '0' } else { '10,10,10,3' }
  $bg = if ($role -eq 'user') { '#E8F3FF' } elseif ($role -eq 'error') { '#FFECE8' } elseif ($role -eq 'progress') { '#00FFFFFF' } else { '#F4F6FA' }
  $fg = if ($role -eq 'progress') { $P.muted } elseif ($role -eq 'error') { '#CB2634' } else { $P.ink }
  $row.box.Background = Brush $bg; $row.text.Foreground = Brush $fg
  $row.text.FontStyle = if ($role -eq 'progress') { 'Italic' } else { 'Normal' }
  SetText $row.text $m.text
  ChatLinks $row $null
  ChatBlocks $row $m.blocks
  ChatLinks $row $m.links
  # The bubble on the bot's head cannot show a table: the owner just asked, so open the box (without taking the keyboard).
  if ($m.peek -and -not $script:askOpen -and (E 'Panel').Visibility -ne 'Visible') { PeekAsk }
  if ($m.typing) {
    if (-not $row.dots) { $row.dots = TypingDots }
    $row.box.Child = $row.dots; $row.box.Background = Brush '#F4F6FA'; $row.box.CornerRadius = '10,10,10,3'
  } elseif ($row.dots -and $row.box.Child -ne $row.text) { $row.box.Child = $row.text }
  # Words the owner is still saying: lighter until the sentence is settled (the box's own opacity is the fade-in).
  $row.text.Opacity = if ($m.partial) { 0.55 } else { 1 }
  $script:scrollRow = if ($row.blocks) { $row } else { $null }
  if ($script:scrollRow) { ScrollToRow $row } else { (E 'ChatScroll').ScrollToEnd() }
  InputLayout
}

# Aivin asked something with choices: a vertical list, one full-width card per option (the daemon clears them once answered). Typing
# still works. Like the cards in Aivin: a round dot at the start (pick one: click = answer) or a square box (pick several: click ticks /
# unticks, a confirm button sends the ticked ones), the text, the option's icon at the end when it has one we can draw.
# Soft look: each card filled with a light pastel (cycling the ask box's glow colors), no border, dark-grey text; hover deepens it.
# Icon at the end of an option: the daemon looks up the Lucide name (the set Aivin's web uses) and sends its outline; an emoji is drawn as is.
function ChoiceIcon($o, $ink) {
  if ($o.icon_path) { $i = LucideIcon $o.icon_path 14 $ink; $i.Margin = '8,3,0,0'; $i.VerticalAlignment = 'Top'; return $i }
  if (-not $o.icon) { return $null }
  $tb = New-Object Windows.Controls.TextBlock; $tb.FontSize = 13; $tb.Margin = '8,1,0,0'; $tb.VerticalAlignment = 'Top'; SetText $tb $o.icon; $tb
}
function ChoiceMark($multi) {
  $m = New-Object Windows.Controls.Border; $m.Width = 13; $m.Height = 13; $m.Margin = '0,2,8,0'; $m.VerticalAlignment = 'Top'
  $m.CornerRadius = if ($multi) { '3.5' } else { '6.5' }; $m.BorderThickness = '1.4'
  $tick = New-Object Windows.Shapes.Path; $tick.Data = [Windows.Media.Geometry]::Parse('M2.4,6.2 L4.9,8.6 L9.4,3.6'); $tick.Stroke = Brush '#FFFFFF'
  $tick.StrokeThickness = 1.7; $tick.StrokeStartLineCap = 'Round'; $tick.StrokeEndLineCap = 'Round'; $tick.StrokeLineJoin = 'Round'
  $m.Child = $tick; SetTicked $m $false; $m
}
function SetTicked($mark, $on) {
  $mark.Background = if ($on) { Brush '${ASK_BTN.icon}' } else { Brush '#B3FFFFFF' }
  $mark.BorderBrush = if ($on) { Brush '${ASK_BTN.icon}' } else { Brush '${CHOICE_MARK}' }
  $mark.Child.Visibility = if ($on) { 'Visible' } else { 'Collapsed' }
}
$script:picked = New-Object Collections.ArrayList; $script:choiceMarks = @{}; $script:choiceConfirm = $null
function SyncConfirm {
  $b = $script:choiceConfirm; if (-not $b) { return }
  $b.Content = $T.ask_confirm -replace '\{n\}', $script:picked.Count
  $b.Visibility = if ($script:picked.Count) { 'Visible' } else { 'Collapsed' }
}
function ChoiceButtons($options, $multiple) {
  $panel = E 'Choices'; $panel.Children.Clear(); $k = 0; $multi = [bool]$multiple
  $script:picked.Clear(); $script:choiceMarks = @{}; $script:choiceConfirm = $null
  $cards = @(${CHOICE_CARDS.map((c) => `'${c}'`).join(', ')}); $inks = @(${ICON_INKS.map((c) => `'${c}'`).join(', ')})
  foreach ($o in @($options)) {
    if (-not $o) { continue }
    $c = $cards[$k % $cards.Count]; $k++; $id = [string]$o.id
    $row = New-Object Windows.Controls.DockPanel; $row.Width = ${CHOICE_ROW_WIDTH}
    $mark = ChoiceMark $multi; [Windows.Controls.DockPanel]::SetDock($mark, 'Left'); [void]$row.Children.Add($mark)
    $icon = ChoiceIcon $o $inks[($k - 1) % $inks.Count]; if ($icon) { [Windows.Controls.DockPanel]::SetDock($icon, 'Right'); [void]$row.Children.Add($icon) }
    $tb = New-Object Windows.Controls.TextBlock; SetText $tb $o.text; $tb.TextWrapping = 'Wrap'; $tb.Foreground = Brush '${CHOICE_INK}'; [void]$row.Children.Add($tb)
    $btn = New-Object Windows.Controls.Button; $btn.Style = $w.FindResource('Btn'); $btn.Content = $row; $btn.CommandParameter = $id
    $btn.FontSize = 13; $btn.FontWeight = 'Normal'; $btn.Padding = '10,6,10,6'; $btn.Margin = '0,0,0,4'; $btn.HorizontalAlignment = 'Stretch'
    $btn.Background = Brush $c; $btn.BorderThickness = '0'; $btn.Tag = Brush '${CHOICE_HOVER}'
    $script:choiceMarks[$id] = $mark
    if ($multi) {
      $btn.Add_Click({ param($s)
        $id = [string]$s.CommandParameter; $on = -not $script:picked.Contains($id)
        if ($on) { [void]$script:picked.Add($id) } else { $script:picked.Remove($id) }
        SetTicked $script:choiceMarks[$id] $on; SyncConfirm
      })
    } else {
      $btn.Add_Click({ param($s) if (-not $script:chatBusy) { SetTicked $script:choiceMarks[[string]$s.CommandParameter] $true; $script:rig.Play('ack'); Send @{ t = 'choose'; id = [string]$s.CommandParameter } } })
    }
    [void]$panel.Children.Add($btn)
  }
  if ($multi -and $panel.Children.Count) {
    $ok = New-Object Windows.Controls.Button; $ok.Style = $w.FindResource('Btn'); $ok.FontSize = 13; $ok.Padding = '12,5,12,5'; $ok.Margin = '0,1,0,4'
    $ok.HorizontalAlignment = 'Right'; $ok.Background = Brush '${ASK_BTN.icon}'; $ok.Foreground = Brush '#FFFFFF'; $ok.BorderThickness = '0'; $ok.Tag = Brush '#1F000000'
    $ok.Add_Click({ if (-not $script:chatBusy -and $script:picked.Count) { $script:rig.Play('ack'); Send @{ t = 'choose'; ids = @($script:picked.ToArray()) } } })
    $script:choiceConfirm = $ok; [void]$panel.Children.Add($ok); SyncConfirm
  }
  $panel.Visibility = if ($panel.Children.Count) { 'Visible' } else { 'Collapsed' }
  if ($panel.Children.Count) { (E 'ChatScroll').Visibility = 'Visible'; (E 'ChatScroll').ScrollToEnd() }
}

# Attached files: one chip each above the input - the file type's icon + colour (fileChips.mjs), its name (full path in the tooltip),
# an x that drops it (detach -> the daemon answers with the new ask_files).
function AttachChips($chips) {
  $bar = E 'AttachBar'; $bar.Children.Clear()
  foreach ($c in @($chips)) {
    if (-not $c -or -not $c.path) { continue }
    $ink = [string]$c.ink; if (-not $ink) { $ink = '#64748B' }
    $chip = New-Object Windows.Controls.Border; $chip.CornerRadius = '8'; $chip.Padding = '6,2,2,2'; $chip.Margin = '4,0,0,4'; $chip.ToolTip = [string]$c.path
    $chip.Background = Brush $(if ($c.bg) { [string]$c.bg } else { '#F8FAFC' })
    # Hairline in the type's colour (ink at ~20 %): keeps the very light chip readable on the white box.
    $chip.BorderThickness = '1'; $chip.BorderBrush = Brush ('#33' + $ink.TrimStart('#'))
    $row = New-Object Windows.Controls.StackPanel; $row.Orientation = 'Horizontal'
    if ($c.icon_path) { $i = LucideIcon $c.icon_path 13 $ink; $i.VerticalAlignment = 'Center'; $i.Margin = '0,0,5,0'; [void]$row.Children.Add($i) }
    $tb = New-Object Windows.Controls.TextBlock; $tb.Text = [string]$c.name; $tb.FontSize = 12; $tb.Foreground = Brush $ink; $tb.MaxWidth = 140
    $tb.TextTrimming = 'CharacterEllipsis'; $tb.VerticalAlignment = 'Center'; [void]$row.Children.Add($tb)
    $x = New-Object Windows.Controls.Button; $x.Style = $w.FindResource('IconBtn'); $x.Width = 18; $x.Height = 18; $x.Margin = '3,0,0,0'
    $x.Background = Brush '#00000000'; $x.BorderThickness = '0'; $x.Tag = Brush '#1F000000'; $x.ToolTip = $T.ask_detach
    $x.Content = LucideIcon '${DETACH_ICON_PATH}' 10 $ink; $x.CommandParameter = [string]$c.path
    $x.Add_Click({ param($s) Send @{ t = 'detach'; path = [string]$s.CommandParameter } })
    [void]$row.Children.Add($x); $chip.Child = $row; [void]$bar.Children.Add($chip)
  }
  $bar.Visibility = if ($bar.Children.Count) { 'Visible' } else { 'Collapsed' }
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
$voiceLabel = New-Object Windows.Controls.TextBlock; $voiceLabel.FontSize = 14; $voiceLabel.Foreground = Brush $P.ink; $voiceLabel.Margin = '7,0,0,1'
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
  # The voice bar only needs the button's height (InputLayout, via SyncAction / below).
  (E 'AskBox').Visibility = if ($on) { 'Collapsed' } else { 'Visible' }
  $voiceBar.Visibility = if ($on) { 'Visible' } else { 'Collapsed' }
  if ($on) { (E 'MicIcon').Visibility = 'Visible'; (E 'SendIcon').Visibility = 'Collapsed'; (E 'AskHint').Visibility = 'Collapsed'; $script:levelTimer.Start(); InputLayout }
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
  if ($script:askOpen) { HideAskLater ${ASK_IDLE_MS} }
}
function StopVoice { Send @{ t = 'voice_stop' }; EndVoice $T.voice_ended }
function InterruptVoice { [AivinMascot.Voice]::Flush(); $script:afterSpeak = ''; Send @{ t = 'voice_interrupt' }; VoiceState 'listening' }
# One action for the mic button and the hotkey: bot talking -> interrupt; talking with it -> end; idle -> start.
function VoiceToggle {
  if ($script:voiceLive -and $script:voiceLive -ne 'recording' -and [AivinMascot.Voice]::Playing) { InterruptVoice }
  elseif ($script:voiceLive) { StopVoice }
  elseif (-not $script:chatBusy) { PeekAsk; StartVoice }
}
(E 'MicBtn').Add_Click({
  if (-not $script:voiceLive -and (E 'AskBox').Text.Trim()) { SubmitAsk }
  elseif (StopMode) { $script:canCancel = $false; (E 'MicBtn').Opacity = 0.5; SyncAction; Send @{ t = 'cancel' } }
  else { VoiceToggle }
})
# Hotkeys anywhere (no need to reach for the bot): voice = the mic button, chat = open the ask box. Each is the first free combination of
# the list the daemon wrote into config.json (hotkey.mjs: the owner's own choice first, then the defaults; "hotkey off" = empty lists ->
# none). Shown in the mic button's tooltip / the tray menu; none free -> no hotkey. WM_HOTKEY is filtered in C# (AivinMascot.HotKeys).
function RegisterKeyList($id, $list) {
  $keys = @(@($list) | Where-Object { $_ -and $_.n })
  if (-not $keys.Count) { return $null }
  $mods = [uint32[]]@($keys | ForEach-Object { [uint32]$_.m }); $vks = [uint32[]]@($keys | ForEach-Object { [uint32]$_.v })
  $i = [AivinMascot.HotKeys]::RegisterFirst($script:hwnd, $id, $mods, $vks)
  if ($i -lt 0) { Dbg ('hotkey ' + $id + ': none free'); return $null }
  [string]$keys[$i].n
}
$w.Add_ContentRendered({
  if (-not $script:hwnd) { return }
  $voiceKey = RegisterKeyList 0xA171 $cfg.hotkeys.voice
  if ($voiceKey) { $T.ask_mic = "$($T.ask_mic) ($voiceKey)"; SyncAction }
  $chatKey = RegisterKeyList 0xA172 $cfg.hotkeys.chat
  # The tray menu shows the same combinations next to its Quick chat / Quick voice items.
  Send @{ t = 'hotkeys'; chat = $chatKey; voice = $voiceKey }
  if ($voiceKey -or $chatKey) {
    [AivinMascot.HotKeys]::Start($script:hwnd, [Action[int]]{ param($id)
      if ($id -eq 0xA171) { VoiceToggle }
      elseif ($id -eq 0xA172) { OpenAsk; [void](E 'AskBox').Focus() }
    })
  }
})

# Route the ask-box commands; everything else goes to the base handler of hostSource.mjs.
$script:baseHandle = (Get-Item function:Handle).ScriptBlock
function Handle($m) {
  switch ($m.t) {
    'chat' {
      ChatRow $m
      if (-not $m.remove -and [string]$m.role -ne 'user' -and $m.text) {
        $script:chatLast = ChatShort $m
        if ($script:askOpen) { HideAskLater $(if ($m.blocks) { ${ASK_RICH_IDLE_MS} } else { ${ASK_IDLE_MS} }) } else { ChatBubble $script:chatLast }
      }
      return
    }
    'chat_clear' { (E 'ChatList').Children.Clear(); $script:chatRows.Clear(); $script:scrollRow = $null; AskWidth $false; (E 'ChatScroll').Visibility = 'Collapsed'; InputLayout; return }
    'chat_busy' {
      $script:chatBusy = [bool]$m.busy; $script:canCancel = [bool]$m.cancel
      (E 'MicBtn').Opacity = if ($script:chatBusy -and -not $script:canCancel) { 0.5 } else { 1 }
      SyncAction
      # Answer arrived: leave it readable a while, then tuck the box away.
      if (-not $script:chatBusy -and $script:askOpen) { HideAskLater ${ASK_IDLE_MS} }
      # Turn over with the box closed: the answer / error stays in the bubble a while, then the bubble times out.
      if (-not $script:chatBusy -and -not $script:askOpen -and (E 'Bubble').Visibility -eq 'Visible') { $script:bubbleTimer.Stop(); $script:bubbleTimer.Start() }
      if ($script:chatBusy) { $script:chatLast = '' }
      return
    }
    'ask_status' { AskStatus $m.text; return }
    'ask_choices' { ChoiceButtons $m.options $m.multiple; return }
    # Files waiting for the next question: chips above the input; then on to the bot's tray (no return).
    'ask_files' { $chips = @($m.files | Where-Object { $_ }); $more = $chips.Count -gt (E 'AttachBar').Children.Count; $script:files = [int]$m.n; AttachChips $chips; SyncAction; if ($more) { PeekAsk; HideAskLater ${ASK_IDLE_MS} } }
    'ask_pin' {
      $script:askPinned = [bool]$m.on
      if ($script:askPinned) { $script:userHidden = $false; ApplyVisibility; AskHide 'Panel'; PeekAsk; (E 'ChatScroll').ScrollToEnd() }
      elseif ($script:askOpen) { HideAskLater $(if ($script:askFocused) { ${ASK_IDLE_MS} } else { 4000 }) }
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
    'voice_toggle' { $script:userHidden = $false; ApplyVisibility; VoiceToggle; return }
    # Debug only (AIVIN_MASCOT_DEBUG): show the ask box WITHOUT taking keyboard focus, to look at it / screenshot it.
    'ask_preview' { if ($env:AIVIN_MASCOT_DEBUG) { PeekAsk }; return }
    # Debug/docs preview of the real file-drag UI, using the same tray, face and hint code as DragEnter without requiring Explorer.
    'drop_preview' {
      if ($env:AIVIN_MASCOT_DEBUG) {
        $script:userHidden = $false; ApplyVisibility; AskHide 'Panel'; CloseAsk
        $script:dragFiles = @('bao-cao.xlsx', 'anh-man-hinh.png'); $script:rig.Hover = $true; $script:rig.Tray('open', $script:files); SetFace 'waiting'
        DropHint ($T.drop_many.Replace('{n}', '2'))
      }
      return
    }
    'drop_preview_end' { if ($env:AIVIN_MASCOT_DEBUG) { DragEnd }; return }
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
    # Debug/docs only: render the complete live WPF visual tree (bot + every visible box), not the static seed artwork.
    'snap_full' {
      if (-not $env:AIVIN_MASCOT_DEBUG -or -not $m.file) { return }
      $el = E 'Root'; $el.UpdateLayout(); $dpi = 2
      $bmp = New-Object Windows.Media.Imaging.RenderTargetBitmap ([int]($el.ActualWidth * $dpi)), ([int]($el.ActualHeight * $dpi)), (96 * $dpi), (96 * $dpi), ([Windows.Media.PixelFormats]::Pbgra32)
      $bmp.Render($el); $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder; $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
      $fs = [IO.File]::Create([string]$m.file); $enc.Save($fs); $fs.Close(); return
    }
  }
  & $script:baseHandle $m
}
# ---- end ask box ----
`;
