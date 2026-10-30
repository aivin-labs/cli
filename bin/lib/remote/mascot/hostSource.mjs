import { AIVIN_BRAND } from '../brand.mjs';
import { BOT_FACES, BOT_LAYER_FILES, BOT_XAML } from './bot.mjs';
import { RIG_CS, RIG_REFERENCES_PS } from './rigSource.mjs';
import { VOICE_CS } from './voiceSource.mjs';

/**
 * Cửa sổ linh vật (Windows, WPF qua PowerShell) — sống suốt phiên `aivin remote start`, nhận lệnh từng dòng JSON trên stdin, gửi sự kiện
 * người dùng ra stdout. Nhận diện theo hộp xác nhận tại máy (localConfirm.mjs): logo, màu phẳng của logo, bo góc, chuyển động ngắn.
 *
 * - Không viền, nền trong suốt (vùng trong suốt bấm xuyên qua), luôn nằm trên, không có trên thanh tác vụ / Alt+Tab.
 * - KHÔNG cướp focus (WS_EX_NOACTIVATE): người dùng đang gõ, hoặc AI đang điều khiển một ứng dụng, không bị cửa sổ này giật phím.
 * - Không có trong ảnh chụp màn hình (WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+): ảnh AI chụp để điều khiển giao diện, chia sẻ màn hình
 *   khi họp không thấy linh vật. Thử nghiệm cần chụp được thì đặt AIVIN_MASCOT_CAPTURABLE=1.
 * - Kéo để di chuyển (nhớ chỗ), bấm để mở / thu bảng nhật ký; bảng mở về phía còn chỗ trên màn hình, kẹp trong vùng màn hình.
 * - Chuyển động của bot: rigSource.mjs (C#, theo nhịp màn hình) — PowerShell chỉ báo trạng thái / rê chuột / nhấn / kéo cho rig.
 * Lệnh vào: state | main | log | gui | show | quit. Sự kiện ra: ready | pos | pause | resume | hide | off.
 * Tệp .ps1 giữ toàn ASCII (PowerShell 5 đọc .ps1 không BOM theo bảng mã cũ) — mọi chữ hiện ra nằm trong config.json (UTF-8).
 */

const B = AIVIN_BRAND;

/** Cỡ linh vật: thân vẽ trên khung gốc rồi Viewbox thu về MASCOT_BOX (60 px); khung bấm / kéo bao quanh thân; tâm khung = điểm neo vị trí. */
// The rendered bot is a MASCOT_BOX-sized Viewbox. Keep the hit/layout box equally large so the rounded lower body is not clipped.
const MASCOT_BOX = { w: 60, h: 60 };
export const MASCOT_CENTER = Object.freeze({ x: 30, y: 28.5 });
/** Rảnh (idle) liền chừng này phút mà không ai rê chuột → bot ngủ gật; có việc / rê chuột vào thì thức. */
const MASCOT_DOZE_MIN = 10;
/** Không chạm chuột / bàn phím chừng này phút = chủ máy đi vắng (khoá máy, đi họp…) → daemon gom việc xảy ra để báo khi quay lại. */
const MASCOT_AWAY_MIN = 10;
/** Lề trong cửa sổ quanh bot / các hộp (chỗ cho bóng đổ). */
const ROOT_MARGIN = 14;
/**
 * Cửa sổ cỡ cố định (đủ cho bảng nhật ký 372 px + lề bóng, cao đủ cho bảng / ô hỏi + bot): hiện / ẩn ô hỏi, bảng, bong bóng chỉ đổi
 * chỗ bên trong cửa sổ, không đổi cỡ / dời cửa sổ — cửa sổ layered bị dời thì ảnh cũ nhảy theo một nhịp trước khi vẽ lại (bot "chập").
 * Vùng trong suốt hẳn bấm xuyên qua nên cửa sổ lớn không che gì.
 */
const WINDOW = { w: 372 + 2 * ROOT_MARGIN, h: 640 };

/** Màu từng trạng thái: `fg` chấm / chữ, `bg` nền chip. */
export const MASCOT_PALETTE = Object.freeze({
  idle: { fg: '#00B42A', bg: '#E8FFEA' },
  working: { fg: B.brand, bg: '#E8F3FF' },
  thinking: { fg: B.light, bg: '#E6F9FF' },
  waiting: { fg: B.warn, bg: B.warnBg },
  paused: { fg: B.muted, bg: '#F2F3F5' },
  offline: { fg: B.muted, bg: '#F2F3F5' },
  done: { fg: '#00B42A', bg: '#E8FFEA' },
  error: { fg: '#F53F3F', bg: '#FFECE8' },
  ink: B.ink,
  muted: B.muted,
  log: { run: B.brand, ok: '#00B42A', fail: '#F53F3F', info: B.muted, warn: B.warn },
});

export const MASCOT_GLYPHS = Object.freeze({ run: '●', ok: '✓', fail: '✕', info: '•', warn: '!' });

const ease = (mode = 'EaseOut') => `<DoubleAnimation.EasingFunction><CubicEase EasingMode="${mode}"/></DoubleAnimation.EasingFunction>`;

/** Hiện / ẩn có chuyển động: mờ → rõ + phóng nhẹ (gốc phóng đặt ở phần tử). */
const motion = (key, opacity, scale, ms, mode) => `<Storyboard x:Key="${key}">
  <DoubleAnimation Storyboard.TargetProperty="Opacity" To="${opacity}" Duration="0:0:0.${ms}"/>
  ${['ScaleX', 'ScaleY'].map((axis) => `<DoubleAnimation Storyboard.TargetProperty="(UIElement.RenderTransform).(ScaleTransform.${axis})" To="${scale}" Duration="0:0:0.${ms}">${ease(mode)}</DoubleAnimation>`).join('\n  ')}
</Storyboard>`;

/** Nút bo góc: lớp phủ màu `Tag` hiện dần khi rê chuột, nhấn thì thu nhẹ (như hộp xác nhận). */
const buttonStyle = (key, radius) => `<Style x:Key="${key}" TargetType="Button">
  <Setter Property="FontSize" Value="13"/><Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Cursor" Value="Hand"/>
  <Setter Property="FocusVisualStyle" Value="{x:Null}"/><Setter Property="Focusable" Value="False"/>
  <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Grid x:Name="root" RenderTransformOrigin="0.5,0.5" Background="Transparent">
      <Grid.RenderTransform><ScaleTransform ScaleX="1" ScaleY="1"/></Grid.RenderTransform>
      <Border CornerRadius="${radius}" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"/>
      <Border x:Name="h" CornerRadius="${radius}" Background="{Binding Tag, RelativeSource={RelativeSource TemplatedParent}}" Opacity="0"/>
      <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
    </Grid>
    <ControlTemplate.Triggers>
      <Trigger Property="IsMouseOver" Value="True">
        <Trigger.EnterActions><BeginStoryboard><Storyboard><DoubleAnimation Storyboard.TargetName="h" Storyboard.TargetProperty="Opacity" To="1" Duration="0:0:0.150"/></Storyboard></BeginStoryboard></Trigger.EnterActions>
        <Trigger.ExitActions><BeginStoryboard><Storyboard><DoubleAnimation Storyboard.TargetName="h" Storyboard.TargetProperty="Opacity" To="0" Duration="0:0:0.200"/></Storyboard></BeginStoryboard></Trigger.ExitActions>
      </Trigger>
      <Trigger Property="IsPressed" Value="True">
        <Trigger.EnterActions><BeginStoryboard><Storyboard>${['ScaleX', 'ScaleY'].map((a) => `<DoubleAnimation Storyboard.TargetName="root" Storyboard.TargetProperty="(UIElement.RenderTransform).(ScaleTransform.${a})" To="0.97" Duration="0:0:0.090"/>`).join('')}</Storyboard></BeginStoryboard></Trigger.EnterActions>
        <Trigger.ExitActions><BeginStoryboard><Storyboard>${['ScaleX', 'ScaleY'].map((a) => `<DoubleAnimation Storyboard.TargetName="root" Storyboard.TargetProperty="(UIElement.RenderTransform).(ScaleTransform.${a})" To="1" Duration="0:0:0.090"/>`).join('')}</Storyboard></BeginStoryboard></Trigger.ExitActions>
      </Trigger>
    </ControlTemplate.Triggers>
  </ControlTemplate></Setter.Value></Setter>
</Style>`;

const SHADOW = '<DropShadowEffect BlurRadius="24" ShadowDepth="6" Direction="270" Opacity="0.16" Color="#0B1B3F"/>';

/** Biểu tượng nét (Path) cho ô hỏi: mic (thân + vòng + chân), gửi (mũi tên giấy). */
const ICON_MIC = 'M12,3 A3,3 0 0 1 15,6 L15,12 A3,3 0 0 1 9,12 L9,6 A3,3 0 0 1 12,3 Z M5,11 A7,7 0 0 0 19,11 M12,18 L12,21';
/** Gửi: mũi tên lên (nét). */
const ICON_SEND_UP = 'M12,20 L12,5 M5,11 L12,4 L19,11';
/** Viền ô hỏi: pastel hồng → tím nhạt → xanh nhạt (theo ô nhập của FE), khép vòng để xoay không bị nối gãy. */
const ASK_GLOW_STOPS = [['#F9A8D4', 0], ['#C4B5FD', 0.3], ['#93C5FD', 0.58], ['#A5F3FC', 0.8], ['#F9A8D4', 1]]
  .map(([color, offset]) => `<GradientStop Color="${color}" Offset="${offset}"/>`).join('');
/** Nút của ô hỏi: nền tím nhạt, biểu tượng tím (ghi âm: nền đỏ nhạt, biểu tượng đỏ). Dùng cả ở askHostSource.mjs. */
export const ASK_BTN = Object.freeze({ bg: '#EEF0FF', icon: '#8B7CF6', recBg: '#FEE2E2', recIcon: '#EF4444' });


export const MASCOT_XAML = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Width="${WINDOW.w}" Height="${WINDOW.h}" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
  Topmost="True" ShowInTaskbar="False" ShowActivated="False" FontFamily="Segoe UI" UseLayoutRounding="True" Opacity="0">
 <Window.Resources>
  ${buttonStyle('Btn', 9)}
  ${buttonStyle('IconBtn', 8)}
  ${motion('PanelIn', 1, 1, 180, 'EaseOut')}
  ${motion('PanelOut', 0, 0.96, 120, 'EaseIn')}
  ${motion('BubbleIn', 1, 1, 160, 'EaseOut')}
  ${motion('BubbleOut', 0, 0.94, 140, 'EaseIn')}
  <Storyboard x:Key="WindowIn"><DoubleAnimation Storyboard.TargetProperty="Opacity" To="1" Duration="0:0:0.250"/></Storyboard>
  <Storyboard x:Key="AskGlow" RepeatBehavior="Forever">
   <DoubleAnimation Storyboard.TargetName="AskGlowSpin" Storyboard.TargetProperty="Angle" From="0" To="360" Duration="0:0:3"/>
  </Storyboard>
 </Window.Resources>
 <!-- Bot và các hộp đặt bằng toạ độ trong cửa sổ (Place / ArrangeBoxes): bot đứng đúng điểm neo, hộp nằm trên bot (hoặc dưới khi
      sát mép trên), kẹp trong cửa sổ. -->
 <Canvas>
 <StackPanel x:Name="Boxes">
  <Border x:Name="Panel" Visibility="Collapsed" Width="372" Margin="0,0,0,10" CornerRadius="16" Background="White" BorderBrush="#E5E6EB"
          BorderThickness="1" Opacity="0" RenderTransformOrigin="0.5,1">
   <Border.RenderTransform><ScaleTransform ScaleX="0.96" ScaleY="0.96"/></Border.RenderTransform>
   <Border.Effect>${SHADOW}</Border.Effect>
   <DockPanel Margin="18,14,12,14">
    <DockPanel DockPanel.Dock="Top" LastChildFill="False">
     <Image x:Name="PanelLogo" Width="22" Height="22" RenderOptions.BitmapScalingMode="HighQuality" VerticalAlignment="Center"/>
     <TextBlock x:Name="PanelTitle" FontSize="14" FontWeight="SemiBold" Foreground="${B.ink}" Margin="8,0,0,0" VerticalAlignment="Center"/>
     <Border x:Name="Chip" CornerRadius="10" Padding="8,2,8,3" Margin="8,0,0,0" VerticalAlignment="Center">
      <TextBlock x:Name="ChipText" FontSize="11.5" FontWeight="SemiBold"/>
     </Border>
     <Button x:Name="PanelClose" DockPanel.Dock="Right" Style="{StaticResource IconBtn}" Content="✕" Width="30" Height="30" FontSize="11"
             FontWeight="Normal" Background="Transparent" BorderThickness="0" Tag="#F2F3F5" Foreground="${B.muted}"/>
    </DockPanel>
    <TextBlock x:Name="NowLabel" DockPanel.Dock="Top" Margin="0,14,0,4" FontSize="11" FontWeight="SemiBold" Foreground="${B.muted}"/>
    <TextBlock x:Name="NowText" DockPanel.Dock="Top" FontSize="14" Foreground="${B.ink}" TextWrapping="Wrap" LineHeight="20" Margin="0,0,6,0"/>
    <DockPanel DockPanel.Dock="Bottom" Margin="0,12,6,0" LastChildFill="False">
     <Button x:Name="PauseBtn" Style="{StaticResource Btn}" Height="34" Padding="14,0" Background="White" Foreground="${B.ink}"
             BorderBrush="#C9CDD4" BorderThickness="1" Tag="#0F000000"/>
     <Button x:Name="OffBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="34" Padding="10,0" Background="Transparent"
             Foreground="${B.muted}" BorderThickness="0" Tag="#F2F3F5" FontWeight="Normal"/>
     <Button x:Name="HideBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Height="34" Padding="10,0" Background="Transparent"
             Foreground="${B.body}" BorderThickness="0" Tag="#F2F3F5" FontWeight="Normal"/>
    </DockPanel>
    <TextBlock x:Name="LogLabel" DockPanel.Dock="Top" Margin="0,16,0,6" FontSize="11" FontWeight="SemiBold" Foreground="${B.muted}"/>
    <Border CornerRadius="10" Background="#F7F8FA" BorderBrush="#EEF0F4" BorderThickness="1" Margin="0,0,6,0">
     <Grid>
      <TextBlock x:Name="Empty" Margin="12,14" FontSize="12.5" Foreground="${B.muted}" TextWrapping="Wrap"/>
      <ScrollViewer Height="260" VerticalScrollBarVisibility="Auto"><StackPanel x:Name="LogList" Margin="0,4"/></ScrollViewer>
     </Grid>
    </Border>
   </DockPanel>
  </Border>
  <!-- Ô hỏi (gọn, ô nhập cao 2 dòng): cả khung là ô nhập, viền mảnh chuyển màu pastel xoay quanh khi hiện (storyboard AskGlow). Nút
       cùng dòng bên phải: trống = mic, có chữ = gửi (mũi tên lên). Hội thoại hiện phía trên dòng nhập khi đã hỏi. -->
  <Border x:Name="Ask" Visibility="Collapsed" Width="240" Margin="0,0,0,7" CornerRadius="14" Background="White" BorderThickness="1.2"
          Opacity="0" RenderTransformOrigin="0.5,1">
   <Border.BorderBrush>
    <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
     <LinearGradientBrush.RelativeTransform><RotateTransform x:Name="AskGlowSpin" CenterX="0.5" CenterY="0.5"/></LinearGradientBrush.RelativeTransform>
     ${ASK_GLOW_STOPS}
    </LinearGradientBrush>
   </Border.BorderBrush>
   <Border.RenderTransform><ScaleTransform ScaleX="0.96" ScaleY="0.96"/></Border.RenderTransform>
   <Border.Effect><DropShadowEffect BlurRadius="12" ShadowDepth="1" Direction="270" Opacity="0.10" Color="#6B5CE7"/></Border.Effect>
   <StackPanel Margin="12,8,7,7">
    <ScrollViewer x:Name="ChatScroll" MaxHeight="160" VerticalScrollBarVisibility="Hidden" Visibility="Collapsed" Margin="0,3,4,5">
     <StackPanel x:Name="ChatList"/>
    </ScrollViewer>
    <!-- Nút trả lời nhanh khi Aivin hỏi lại (thẻ chọn của agent) — askHostSource.mjs dựng theo lệnh ask_choices. -->
    <StackPanel x:Name="Choices" Visibility="Collapsed" Margin="0,0,4,5"/>
    <DockPanel>
     <Button x:Name="MicBtn" DockPanel.Dock="Right" Style="{StaticResource IconBtn}" Width="26" Height="26" Margin="6,0,0,0" VerticalAlignment="Bottom"
             Background="${ASK_BTN.bg}" BorderThickness="0" Tag="#14000000">
      <Grid>
       <Path x:Name="MicIcon" Data="${ICON_MIC}" Stroke="${ASK_BTN.icon}" StrokeThickness="1.8" StrokeStartLineCap="Round" StrokeEndLineCap="Round"
             Width="11" Height="13" Stretch="Uniform"/>
       <Path x:Name="SendIcon" Data="${ICON_SEND_UP}" Stroke="${ASK_BTN.icon}" StrokeThickness="1.9" StrokeStartLineCap="Round" StrokeEndLineCap="Round"
             StrokeLineJoin="Round" Width="11" Height="12" Stretch="Uniform" Visibility="Collapsed"/>
      </Grid>
     </Button>
     <Grid MinHeight="40">
      <TextBox x:Name="AskBox" BorderThickness="0" Background="Transparent" FontSize="13" Foreground="${B.ink}" TextWrapping="Wrap"
               MaxHeight="60" VerticalScrollBarVisibility="Hidden" CaretBrush="#8B7CF6" MaxLength="2000" Padding="0,1,0,1"/>
      <TextBlock x:Name="AskHint" IsHitTestVisible="False" FontSize="13" Foreground="#A9AEB8" Margin="2,1,0,0" TextTrimming="CharacterEllipsis"/>
     </Grid>
    </DockPanel>
    <TextBlock x:Name="AskStatus" Visibility="Collapsed" FontSize="11" Foreground="${B.muted}" Margin="0,2,4,1" TextTrimming="CharacterEllipsis"/>
   </StackPanel>
  </Border>
  <Grid x:Name="Bubble" Visibility="Collapsed" Opacity="0" RenderTransformOrigin="0.5,1">
   <Grid.RenderTransform><ScaleTransform ScaleX="0.94" ScaleY="0.94"/></Grid.RenderTransform>
   <Border x:Name="BubbleBox" CornerRadius="12" Background="White" BorderBrush="#E5E6EB" BorderThickness="1" Padding="10,6,12,7" MaxWidth="220" Margin="0,0,0,7">
    <Border.Effect>${SHADOW}</Border.Effect>
    <DockPanel>
     <!-- Chấm trạng thái đã có ở quả cầu ăng-ten trên đầu bot — bong bóng không lặp lại (giữ phần tử ẩn vì SetState còn tô màu nó). -->
     <Ellipse x:Name="BubbleDot" Width="6" Height="6" Margin="0,5,7,0" VerticalAlignment="Top" Visibility="Collapsed"/>
     <TextBlock x:Name="BubbleText" FontSize="12" Foreground="${B.ink}" TextWrapping="Wrap" MaxHeight="34" TextTrimming="CharacterEllipsis" LineHeight="17"/>
    </DockPanel>
   </Border>
   <Path x:Name="Tail" Data="M0,0 L14,0 L7,7 Z" Fill="#D9DCE1" VerticalAlignment="Bottom" HorizontalAlignment="Center" RenderTransformOrigin="0.5,0.5"/>
  </Grid>
 </StackPanel>
  <!-- Nền alpha 1/255: cửa sổ layered cho bấm xuyên qua điểm trong suốt hẳn — khoảng trống quanh bot vẫn phải bấm / kéo được.
       Bóng dưới đất nằm trong BOT_XAML (co / nhạt theo cú nhún). -->
  <Grid x:Name="Mascot" Width="${MASCOT_BOX.w}" Height="${MASCOT_BOX.h}" Cursor="Hand" Background="#01FFFFFF">
   <Viewbox x:Name="Floater" Width="${MASCOT_BOX.w}" Height="${MASCOT_BOX.h}" VerticalAlignment="Top" HorizontalAlignment="Center" Stretch="Uniform">
    ${BOT_XAML}
   </Viewbox>
  </Grid>
 </Canvas>
</Window>`;

export const MASCOT_PS1 = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml
$utf8 = New-Object Text.UTF8Encoding $false
$dir = $env:AIVIN_MASCOT_DIR
function ReadText($name) { [IO.File]::ReadAllText((Join-Path $dir $name), $utf8) }
$cfg = ReadText 'config.json' | ConvertFrom-Json
$T = $cfg.strings; $P = $cfg.palette
# stdout goes through AivinMascot.Output (one lock shared with the voice capture thread, see voiceSource.mjs) so lines never interleave.
function Send($o) { [AivinMascot.Output]::Line(($o | ConvertTo-Json -Compress)) }
# Debug trace: stderr + debug.log in the host folder (stderr is only kept as the last error line by the daemon).
function Dbg($text) { if ($env:AIVIN_MASCOT_DEBUG) { $line = "$([DateTime]::Now.ToString('HH:mm:ss.fff')) $text"; [Console]::Error.WriteLine("mascot: $line"); try { [IO.File]::AppendAllText((Join-Path $dir 'debug.log'), ($line + [Environment]::NewLine), $utf8) } catch {} } }
# Win32 calls + a background thread that reads stdin lines into a queue (stream ReadLineAsync faults on a console pipe in .NET Framework)
# + the bot's per-frame motion rig (C#, see rigSource.mjs) + live voice: mic / speaker streaming (C#, see voiceSource.mjs).
Add-Type -ReferencedAssemblies ${RIG_REFERENCES_PS} -TypeDefinition @'
using System; using System.Collections.Concurrent; using System.Collections.Generic; using System.Diagnostics; using System.IO;
using System.Runtime.InteropServices; using System.Text; using System.Threading; using System.Windows; using System.Windows.Media;
namespace AivinMascot {
  public static class Native {
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
    /** Seconds since the last mouse / keyboard input anywhere in this session (locked screen counts as no input). */
    public static double IdleSeconds() {
      var l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l);
      return GetLastInputInfo(ref l) ? unchecked((uint)Environment.TickCount - l.dwTime) / 1000.0 : 0;
    }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
    /** Bounds (left, top, right, bottom; device pixels) of the monitor at / nearest to a point - a saved spot on a monitor that is gone
        lands on the nearest one. */
    public static int[] MonitorAt(int x, int y) {
      var p = new POINT(); p.X = x; p.Y = y;
      var i = new MONITORINFO(); i.cbSize = Marshal.SizeOf(i);
      if (!GetMonitorInfo(MonitorFromPoint(p, 2), ref i)) return null;
      return new[] { i.rcMonitor.L, i.rcMonitor.T, i.rcMonitor.R, i.rcMonitor.B };
    }
  }
  /** Screens added / removed / resized or the taskbar moved: the window re-places itself (C# hook - a PowerShell one would run for
      every window message). */
  public static class DisplayWatch {
    static Action changed; static System.Windows.Interop.HwndSourceHook hook;
    public static void Start(IntPtr h, Action onChanged) {
      changed = onChanged; hook = Hook;
      System.Windows.Interop.HwndSource.FromHwnd(h).AddHook(hook);
    }
    static IntPtr Hook(IntPtr h, int msg, IntPtr wp, IntPtr lp, ref bool handled) {
      // WM_DISPLAYCHANGE, WM_DPICHANGED, WM_SETTINGCHANGE + SPI_SETWORKAREA.
      if (msg == 0x007E || msg == 0x02E0 || (msg == 0x001A && wp.ToInt64() == 0x2F)) {
        System.Windows.Threading.Dispatcher.CurrentDispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.Background, changed);
      }
      return IntPtr.Zero;
    }
  }
  /** Keep the mascot above the taskbar: the taskbar is topmost too and jumps to the front when it (or any window) is activated, so
      re-assert HWND_TOPMOST right at each foreground change and once more shortly after (the shell raises itself a beat later). */
  public static class TopKeeper {
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    static WinEventProc proc; static IntPtr target; static System.Windows.Threading.DispatcherTimer again;
    public static void Raise() { if (target != IntPtr.Zero) Native.SetWindowPos(target, new IntPtr(-1), 0, 0, 0, 0, 0x0013); }
    public static void Start(IntPtr h) {
      target = h;
      again = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(180) };
      again.Tick += (s, e) => { again.Stop(); Raise(); };
      proc = (hook, ev, hwnd, obj, child, thread, time) => { if (hwnd == target) return; Raise(); again.Stop(); again.Start(); };
      // EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS: delivered on this (UI) thread's message loop.
      SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, proc, 0, 0, 0x0002);
    }
  }
  public static class Input {
    public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static volatile bool Closed;
    public static void Start() {
      var t = new Thread(() => {
        try {
          var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
          string line; while ((line = r.ReadLine()) != null) { if (!Voice.Take(line)) Lines.Enqueue(line); }
        } catch { }
        Closed = true;
      });
      t.IsBackground = true; t.Start();
    }
  }
${RIG_CS}
${VOICE_CS}
}
'@

$w = [Windows.Markup.XamlReader]::Parse((ReadText 'mascot.xaml'))
function E($n) { $w.FindName($n) }
$conv = New-Object Windows.Media.BrushConverter
function Brush($hex) { $conv.ConvertFromString($hex) }
function Img($file) { $b = New-Object Windows.Media.Imaging.BitmapImage; $b.BeginInit(); $b.UriSource = New-Object Uri (Join-Path $dir $file); $b.CacheOption = 'OnLoad'; $b.EndInit(); $b.Freeze(); $b }
${Object.entries(BOT_LAYER_FILES).map(([el, file]) => `(E '${el}').Source = Img '${file}'`).join('; ')}; (E 'PanelLogo').Source = Img 'logo.png'
$script:rig = [AivinMascot.Rig]::new($w)
$w.Title = $T.window_title; (E 'Mascot').ToolTip = $T.tooltip; (E 'PanelTitle').Text = $T.panel_title
(E 'NowLabel').Text = $T.now_label; (E 'LogLabel').Text = $T.log_label; (E 'Empty').Text = $T.nothing_yet; (E 'NowText').Text = $T.ready
(E 'HideBtn').Content = $T.hide; (E 'OffBtn').Content = $T.turn_off; (E 'PanelClose').ToolTip = $T.close

# No focus stealing + no Alt+Tab entry; hidden from screen capture (AI screenshots, screen sharing).
$w.Add_SourceInitialized({
  $h = (New-Object Windows.Interop.WindowInteropHelper $w).Handle
  $ex = [AivinMascot.Native]::GetWindowLong($h, -20)
  [void][AivinMascot.Native]::SetWindowLong($h, -20, ($ex -bor 0x08000000 -bor 0x00000080))
  if (-not $env:AIVIN_MASCOT_CAPTURABLE) { [void][AivinMascot.Native]::SetWindowDisplayAffinity($h, 0x11) }
  $script:hwnd = $h
  [AivinMascot.TopKeeper]::Start($h)
  [AivinMascot.DisplayWatch]::Start($h, [Action]{ Dbg 'display changed'; Place })
})

# Stay above the taskbar: TopKeeper re-asserts HWND_TOPMOST on every foreground change; this timer is the fallback for the shell
# raising itself without one (SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE - no focus change, no flicker).
$script:topTimer = New-Object Windows.Threading.DispatcherTimer; $script:topTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:topTimer.Add_Tick({ if ($script:hwnd -and $w.IsVisible) { [AivinMascot.TopKeeper]::Raise() } })
$script:topTimer.Start()

# Anchor = screen point of the mascot center (DIPs). The window has a fixed size and only moves when the bot is dragged or the screens
# change: the bot sits at the anchor inside it, the boxes (ask box, bubble, activity panel) are laid out around the bot (ArrangeBoxes).
$wa = [Windows.SystemParameters]::WorkArea
$script:cx = if ($cfg.x -ne $null) { [double]$cfg.x } else { $wa.Right - 76 }
$script:cy = if ($cfg.y -ne $null) { [double]$cfg.y } else { $wa.Bottom - 70 }
# Bot center inside the window (DIPs).
$script:mx = ${WINDOW.w / 2}; $script:my = ${WINDOW.h - ROOT_MARGIN - (MASCOT_BOX.h - MASCOT_CENTER.y)}
function DeviceScale {
  $src = [Windows.PresentationSource]::FromVisual($w)
  if ($src -and $src.CompositionTarget) { $src.CompositionTarget.TransformToDevice.M11 } else { 1 }
}
function Clamp($v, $lo, $hi) { [Math]::Max($lo, [Math]::Min($v, $hi)) }
function Place {
  $k = DeviceScale
  # The monitor the anchor is on (nearest one if it is on none): the bot stays whole on it, the window too.
  $r = [AivinMascot.Native]::MonitorAt([int]($script:cx * $k), [int]($script:cy * $k))
  if ($r) { $ml = $r[0] / $k; $mt = $r[1] / $k; $mr = $r[2] / $k; $mb = $r[3] / $k }
  else {
    $ml = [Windows.SystemParameters]::VirtualScreenLeft; $mt = [Windows.SystemParameters]::VirtualScreenTop
    $mr = $ml + [Windows.SystemParameters]::VirtualScreenWidth; $mb = $mt + [Windows.SystemParameters]::VirtualScreenHeight
  }
  $script:cx = Clamp $script:cx ($ml + ${MASCOT_CENTER.x}) ($mr - ${MASCOT_BOX.w - MASCOT_CENTER.x})
  $script:cy = Clamp $script:cy ($mt + ${MASCOT_CENTER.y}) ($mb - ${MASCOT_BOX.h - MASCOT_CENTER.y})
  # Bot centered at the bottom of the window when there is room; near a screen edge the window stays on the monitor and the bot moves
  # inside it instead. One SetWindowPos (device pixels) - setting Left then Top moved the window twice.
  $px = [Math]::Round((Clamp ($script:cx - ${WINDOW.w / 2}) $ml ($mr - ${WINDOW.w})) * $k)
  $py = [Math]::Round((Clamp ($script:cy - ${WINDOW.h - ROOT_MARGIN - (MASCOT_BOX.h - MASCOT_CENTER.y)}) $mt ($mb - ${WINDOW.h})) * $k)
  if ($script:hwnd) { [void][AivinMascot.Native]::SetWindowPos($script:hwnd, [IntPtr]::Zero, [int]$px, [int]$py, 0, 0, 0x0015) }
  else { $w.Left = $px / $k; $w.Top = $py / $k }
  $script:mx = $script:cx - $px / $k; $script:my = $script:cy - $py / $k
  $m = E 'Mascot'; [Windows.Controls.Canvas]::SetLeft($m, $script:mx - ${MASCOT_CENTER.x}); [Windows.Controls.Canvas]::SetTop($m, $script:my - ${MASCOT_CENTER.y})
  Dbg "place anchor $($script:cx),$($script:cy) -> window $px,$py px (scale $k), bot at $($script:mx),$($script:my)"
  ArrangeBoxes
}
# Boxes centered over the bot, kept inside the window (shadow margin). Not enough room above (bot near the top of the screen) -> below
# the bot: the gap to the bot (each box's margin), the bubble tail and the grow-in origin flipped to the top.
function ArrangeBoxes {
  $b = E 'Boxes'; $bw = $b.ActualWidth; $bh = $b.ActualHeight
  $top = $script:my - ${MASCOT_CENTER.y}; $bottom = $top + ${MASCOT_BOX.h}
  $below = $bh -gt ($top - ${ROOT_MARGIN}) -and (${WINDOW.h - ROOT_MARGIN} - $bottom) -gt ($top - ${ROOT_MARGIN})
  $left = Clamp ($script:mx - $bw / 2) ${ROOT_MARGIN} (${WINDOW.w - ROOT_MARGIN} - $bw)
  [Windows.Controls.Canvas]::SetLeft($b, $left)
  [Windows.Controls.Canvas]::SetTop($b, $(if ($below) { $bottom } else { $top - $bh }))
  if ($below -ne $script:boxesBelow) {
    $script:boxesBelow = $below
    $origin = if ($below) { '0.5,0' } else { '0.5,1' }
    foreach ($n in 'Panel', 'Ask', 'Bubble') { (E $n).RenderTransformOrigin = $origin }
    $tail = E 'Tail'
    $tail.VerticalAlignment = if ($below) { 'Top' } else { 'Bottom' }
    $tail.RenderTransform = if ($below) { New-Object Windows.Media.ScaleTransform 1, -1 } else { [Windows.Media.Transform]::Identity }
    (E 'Panel').Margin = if ($below) { '0,10,0,0' } else { '0,0,0,10' }
    foreach ($n in 'Ask', 'BubbleBox') { (E $n).Margin = if ($below) { '0,7,0,0' } else { '0,0,0,7' } }
  }
  # The bubble tail points at the bot even when the bubble is pushed sideways by the window edge (centered + margin 2d = moved by d).
  $d = $script:mx - ($left + $bw / 2)
  (E 'Tail').Margin = if ($d -ge 0) { "$(2 * $d),0,0,0" } else { "0,0,$(-2 * $d),0" }
}
$script:boxesBelow = $false
# A box shown / hidden / grown: lay the boxes out again in the same layout pass (before the frame is drawn), the window stays put.
(E 'Boxes').Add_SizeChanged({ ArrangeBoxes })

$script:state = 'idle'
$faceMap = ConvertFrom-Json '${JSON.stringify(BOT_FACES)}'
# Face changes morph in the rig (eyes squash shut + reopen, mouth pops) instead of cutting.
function SetFace($s) {
  $f = $faceMap.$s; if (-not $f) { $f = $faceMap.idle }
  $script:rig.SetFace([string]$f.eyes, [string]$f.mouth)
}
# Reactions picked from the state pair (the rig plays them, see rigSource.mjs): busy -> needs you = startle; done after an error in the
# last minutes = relief; done after long work = cheer, after a quick one = a nod. Busy time counts from the first working / thinking
# until done / error / idle (a question in between does not reset it).
$script:busySince = $null; $script:errorAt = [DateTime]::MinValue
function React($prev, $s) {
  $now = Get-Date
  $busyFor = if ($script:busySince) { ($now - $script:busySince).TotalSeconds } else { 0 }
  if ($s -eq 'working' -or $s -eq 'thinking') { if (-not $script:busySince) { $script:busySince = $now } }
  elseif ($s -ne 'waiting') { $script:busySince = $null }
  if ($s -eq 'error') { $script:errorAt = $now }
  if ($s -eq 'waiting' -and ($prev -eq 'working' -or $prev -eq 'thinking')) { $script:rig.Play('startle') }
  elseif ($s -eq 'done') {
    if (($now - $script:errorAt).TotalMinutes -lt 5) { $script:errorAt = [DateTime]::MinValue; PlayFace 'relief' 'relief' 1.3 }
    elseif ($busyFor -ge 60) { $script:rig.Play('cheer') }
    elseif ($busyFor -gt 0 -and $busyFor -lt 10) { $script:rig.Play('small') }
  }
}
function SetState($s) {
  if (-not $P.$s) { return }
  $prev = $script:state
  if ($s -ne $prev) { Wake }
  $script:state = $s; $c = $P.$s
  (E 'BubbleDot').Fill = Brush $c.fg
  (E 'Chip').Background = Brush $c.bg; (E 'ChipText').Foreground = Brush $c.fg; (E 'ChipText').Text = $T.('state_' + $s)
  $busy = $s -eq 'working' -or $s -eq 'thinking'
  if (-not ($script:rig.Hover -and -not $busy) -and -not $script:rig.Dozing) { SetFace $s }
  $script:rig.SetState($s, $c.fg)
  if ($s -ne $prev) { React $prev $s }
  (E 'PauseBtn').Content = if ($s -eq 'paused') { $T.resume } else { $T.pause }
  if (-not $busy -and $s -ne 'waiting' -and (E 'Bubble').Visibility -eq 'Visible') { $script:bubbleTimer.Stop(); $script:bubbleTimer.Start() }
}

# Pointer: the rig follows the cursor with its eyes on its own (anywhere near the bot). Hovering greets with a happy face and a lean-in.
function IsBusy { $script:state -eq 'working' -or $script:state -eq 'thinking' }
(E 'Mascot').Add_MouseEnter({ Wake; $script:rig.Hover = $true; if (-not (IsBusy) -and -not $script:rig.Dizzy) { SetFace 'hello' } })

# Doze: idle for a long while with nobody around -> the bot nods off (closed eyes, zzz); new work or the pointer wakes it up.
$script:lastActive = Get-Date
function Wake { $script:lastActive = Get-Date; $script:yawned = $false; if ($script:rig.Dozing) { $script:rig.Doze($false); SetFace $script:state } }
$script:dozeTimer = New-Object Windows.Threading.DispatcherTimer; $script:dozeTimer.Interval = [TimeSpan]::FromSeconds(15)
$script:dozeTimer.Add_Tick({
  if ($script:state -eq 'idle' -and -not $script:rig.Dozing -and -not $script:rig.Hover -and ((Get-Date) - $script:lastActive).TotalMinutes -ge ${MASCOT_DOZE_MIN}) {
    # A yawn first, nodding off on the next tick (PlayFace would count as activity: keep the idle clock and the yawn flag).
    if (-not $script:yawned) { $script:rig.Play('yawn'); SetFace 'yawn'; $script:faceTimer.Stop(); $script:faceTimer.Interval = [TimeSpan]::FromSeconds(2); $script:faceTimer.Start(); $script:yawned = $true }
    else { $script:rig.Doze($true); SetFace 'offline' }
  }
})
$script:dozeTimer.Start()
(E 'Mascot').Add_MouseLeave({ $script:rig.Hover = $false; if (-not $script:rig.Dizzy) { SetFace $script:state } })

# Play: a one-shot face for a reaction, then back to the normal face (hello while hovered and free, else the state's face).
$script:faceTimer = New-Object Windows.Threading.DispatcherTimer
$script:faceTimer.Add_Tick({ $script:faceTimer.Stop(); SetFace $(if ($script:rig.Hover -and -not (IsBusy)) { 'hello' } else { $script:state }) })
function PlayFace($gesture, $face, $sec) {
  Wake; $script:rig.Play($gesture); SetFace $face
  $script:faceTimer.Stop(); $script:faceTimer.Interval = [TimeSpan]::FromSeconds($sec); $script:faceTimer.Start()
}
# Petting: the pointer rubs back and forth over the bot (no button) -> it leans in, eyes closed happily, antenna wagging.
$script:pet = @{ x = $null; dir = 0; flips = 0; at = Get-Date }
(E 'Mascot').Add_MouseMove({ param($s, $e)
  if ($script:drag -or $script:rig.Dizzy) { return }
  $p = $script:pet; $x = $e.GetPosition($w).X
  if ($p.x -eq $null) { $p.x = $x; return }
  $dx = $x - $p.x; if ([Math]::Abs($dx) -lt 6) { return }
  $p.x = $x; $dir = [Math]::Sign($dx)
  if (((Get-Date) - $p.at).TotalSeconds -gt 0.6) { $p.flips = 0 }
  $p.at = Get-Date
  if ($p.dir -and $dir -ne $p.dir) { $p.flips++ }
  $p.dir = $dir
  if ($p.flips -ge 4 -and -not (IsBusy)) { PlayFace 'purr' 'purr' 1.2 }
})

# The user is away (no input for a while) / back -> the daemon sums up what happened meanwhile.
$script:away = $false
$script:awayTimer = New-Object Windows.Threading.DispatcherTimer; $script:awayTimer.Interval = [TimeSpan]::FromSeconds(5)
$script:awayTimer.Add_Tick({
  $idle = [AivinMascot.Native]::IdleSeconds()
  if (-not $script:away -and $idle -ge ${MASCOT_AWAY_MIN * 60}) { $script:away = $true; Send @{ t = 'away' } }
  elseif ($script:away -and $idle -lt 5) { $script:away = $false; Send @{ t = 'back' } }
})
$script:awayTimer.Start()

# Drop files / folders on the bot (or the ask box) -> they ride along with the next question. Dragging over: wide-eyed "ooh".
function HasFiles($e) { $e.Data.GetDataPresent([Windows.DataFormats]::FileDrop) }
foreach ($n in 'Mascot', 'Ask') {
  (E $n).AllowDrop = $true
  (E $n).Add_DragEnter({ param($s, $e) if (HasFiles $e) { Wake; $script:rig.Hover = $true; SetFace 'waiting' } })
  (E $n).Add_DragOver({ param($s, $e) $e.Effects = if (HasFiles $e) { 'Copy' } else { 'None' }; $e.Handled = $true })
  (E $n).Add_DragLeave({ param($s, $e) $script:rig.Hover = $false; SetFace $script:state })
  (E $n).Add_Drop({ param($s, $e)
    if (-not (HasFiles $e)) { return }
    $files = @($e.Data.GetData([Windows.DataFormats]::FileDrop)) | ForEach-Object { [string]$_ }
    $e.Handled = $true
    Send @{ t = 'drop'; files = @($files) }
    PlayFace 'wave' 'hello' 1.4
    if (Get-Command OpenAsk -ErrorAction SilentlyContinue) { OpenAsk }
  })
}

$script:bubbleTimer = New-Object Windows.Threading.DispatcherTimer; $script:bubbleTimer.Interval = [TimeSpan]::FromSeconds(7)
$script:bubbleTimer.Add_Tick({ $script:bubbleTimer.Stop(); HideBubble })
function HideBubble {
  $b = E 'Bubble'; if ($b.Visibility -ne 'Visible') { return }
  $sb = $w.FindResource('BubbleOut').Clone(); $sb.Add_Completed({ (E 'Bubble').Visibility = 'Collapsed' }); $sb.Begin($b)
}
function ShowBubble($text) {
  (E 'NowText').Text = $text
  if ((E 'Panel').Visibility -eq 'Visible') { return }
  (E 'BubbleText').Text = $text
  $b = E 'Bubble'
  if ($b.Visibility -ne 'Visible') { $b.Visibility = 'Visible'; $w.FindResource('BubbleIn').Begin($b) }
  $script:bubbleTimer.Stop()
  if ($script:state -ne 'working' -and $script:state -ne 'thinking' -and $script:state -ne 'waiting') { $script:bubbleTimer.Start() }
}

$script:rows = @{}; $script:order = New-Object System.Collections.Generic.Queue[string]
function LogEntry($m) {
  $row = $null; if ($m.id) { $row = $script:rows[[string]$m.id] }
  if (-not $row) {
    $dp = New-Object Windows.Controls.DockPanel; $dp.Margin = '10,6,10,6'
    $g = New-Object Windows.Controls.TextBlock; $g.Width = 16; $g.FontSize = 12; $g.FontWeight = 'Bold'; $g.Margin = '0,1,6,0'; [Windows.Controls.DockPanel]::SetDock($g, 'Left')
    $tm = New-Object Windows.Controls.TextBlock; $tm.FontSize = 11; $tm.Foreground = Brush $P.muted; $tm.Margin = '8,2,0,0'; [Windows.Controls.DockPanel]::SetDock($tm, 'Right')
    $sp = New-Object Windows.Controls.StackPanel
    $ti = New-Object Windows.Controls.TextBlock; $ti.FontSize = 13; $ti.Foreground = Brush $P.ink; $ti.TextWrapping = 'Wrap'
    $sub = New-Object Windows.Controls.TextBlock; $sub.FontSize = 11.5; $sub.Foreground = Brush $P.muted; $sub.TextWrapping = 'Wrap'; $sub.MaxHeight = 32; $sub.TextTrimming = 'CharacterEllipsis'; $sub.Margin = '0,1,0,0'
    [void]$sp.Children.Add($ti); [void]$sp.Children.Add($sub)
    [void]$dp.Children.Add($g); [void]$dp.Children.Add($tm); [void]$dp.Children.Add($sp)
    $list = E 'LogList'; $list.Children.Insert(0, $dp); (E 'Empty').Visibility = 'Collapsed'
    $row = @{ glyph = $g; time = $tm; title = $ti; sub = $sub }
    if ($m.id) { $script:rows[[string]$m.id] = $row; $script:order.Enqueue([string]$m.id) }
    while ($list.Children.Count -gt 150) { $list.Children.RemoveAt($list.Children.Count - 1) }
    while ($script:order.Count -gt 150) { $script:rows.Remove($script:order.Dequeue()) }
  }
  if ($m.status) { $row.glyph.Text = $cfg.glyphs.($m.status); $row.glyph.Foreground = Brush $P.log.($m.status) }
  if ($m.title) { $row.title.Text = $m.title }
  if ($m.PSObject.Properties['sub']) { $row.sub.Text = [string]$m.sub; $row.sub.Visibility = if ($m.sub) { 'Visible' } else { 'Collapsed' } }
  if ($m.time) { $row.time.Text = $m.time }
}

function TogglePanel {
  $p = E 'Panel'
  if ($p.Visibility -eq 'Visible') {
    $sb = $w.FindResource('PanelOut').Clone(); $sb.Add_Completed({ (E 'Panel').Visibility = 'Collapsed' }); $sb.Begin($p)
  } else {
    $script:bubbleTimer.Stop(); (E 'Bubble').Visibility = 'Collapsed'; (E 'Bubble').Opacity = 0
    $p.Visibility = 'Visible'; $w.FindResource('PanelIn').Begin($p)
  }
}

$script:userHidden = $false; $script:guiHidden = $false
function ApplyVisibility { $w.Visibility = if ($script:userHidden -or $script:guiHidden) { 'Hidden' } else { 'Visible' } }

# Drag to move, click to open / collapse the activity panel. Own drag loop (mouse capture + screen DIPs): Window.DragMove on a
# no-activate window jumped the window on a plain click and swallowed the click.
$script:drag = $null
function ScreenDip($e) {
  $p = $w.PointToScreen($e.GetPosition($w)); $m = [Windows.PresentationSource]::FromVisual($w).CompositionTarget.TransformToDevice
  New-Object Windows.Point ($p.X / $m.M11), ($p.Y / $m.M22)
}
function SendPos { Send @{ t = 'pos'; x = [int]$script:cx; y = [int]$script:cy } }
(E 'Mascot').Add_MouseLeftButtonDown({ param($s, $e)
  $script:drag = @{ start = (ScreenDip $e); cx = $script:cx; cy = $script:cy; moved = $false }
  $script:rig.Pressed = $true
  $ok = (E 'Mascot').CaptureMouse(); Dbg "down at $($script:drag.start) anchor $($script:cx),$($script:cy) capture=$ok"; $e.Handled = $true
})
(E 'Mascot').Add_MouseMove({ param($s, $e)
  $d = $script:drag; if (-not $d) { return }
  $p = ScreenDip $e; $dx = $p.X - $d.start.X; $dy = $p.Y - $d.start.Y
  if (-not $d.moved -and [Math]::Abs($dx) + [Math]::Abs($dy) -lt 5) { return }
  if (-not $d.moved) { Dbg "drag starts d=$dx,$dy"; $script:rig.Pressed = $false; $script:rig.Dragging = $true }
  $px = $script:cx; $py = $script:cy
  $d.moved = $true; $script:cx = $d.cx + $dx; $script:cy = $d.cy + $dy; Place
  $script:rig.Nudge($script:cx - $px, $script:cy - $py)
  # Shaken back and forth while dragged -> dizzy when let go.
  $step = $script:cx - $px
  if ([Math]::Abs($step) -ge 4) { $sg = [Math]::Sign($step); if ($d.sg -and $sg -ne $d.sg) { $d.flips++ }; $d.sg = $sg }
})
(E 'Mascot').Add_MouseLeftButtonUp({ param($s, $e)
  $d = $script:drag; $script:drag = $null; $script:rig.Pressed = $false; $script:rig.Dragging = $false; (E 'Mascot').ReleaseMouseCapture()
  Dbg "up drag=$([bool]$d) moved=$($d.moved) anchor $($script:cx),$($script:cy)"
  if (-not $d) { return }
  if ($d.moved) { SendPos; if ($d.flips -ge 4) { PlayFace 'dizzy' 'dizzy' 2.6 } }
  elseif (QuickClicks) { PlayFace 'giggle' 'hello' 1.1; if (Get-Command CloseAsk -ErrorAction SilentlyContinue) { CloseAsk } }
  else { MascotClick }
  $e.Handled = $true
})
# Three quick clicks = tickled: a giggle instead of opening / closing the box again.
$script:clicks = @()
function QuickClicks {
  $now = Get-Date
  $script:clicks = @($script:clicks | Where-Object { ($now - $_).TotalSeconds -lt 1.2 }) + $now
  if ($script:clicks.Count -lt 3) { return $false }
  $script:clicks = @(); return $true
}
# Click on the bot: the activity panel by default; the ask box (askHostSource.mjs, inserted at @ASK_HOOK) redefines it.
function MascotClick { TogglePanel }
(E 'Mascot').Add_LostMouseCapture({ $d = $script:drag; $script:drag = $null; $script:rig.Pressed = $false; $script:rig.Dragging = $false; Dbg "lost capture drag=$([bool]$d)"; if ($d -and $d.moved) { SendPos } })
(E 'PanelClose').Add_Click({ TogglePanel })
(E 'PauseBtn').Add_Click({ if ($script:state -eq 'paused') { Send @{ t = 'resume' } } else { Send @{ t = 'pause' } } })
(E 'HideBtn').Add_Click({ $script:userHidden = $true; ApplyVisibility; Send @{ t = 'hide' } })
(E 'OffBtn').Add_Click({ Send @{ t = 'off' } })

function Handle($m) {
  if ($env:AIVIN_MASCOT_DEBUG) { Dbg "recv $($m.t) $($m.state)$($m.text)$($m.title)" }
  switch ($m.t) {
    'state' { SetState $m.state }
    'main' { if ($m.quiet) { (E 'NowText').Text = $m.text } else { ShowBubble $m.text } }
    'log' { LogEntry $m }
    'gui' { $script:guiHidden = [bool]$m.active; ApplyVisibility }
    'show' { $script:userHidden = $false; ApplyVisibility }
    # Daemon-driven reaction, e.g. 'wave' when the user comes back.
    'gesture' { if (-not (IsBusy)) { PlayFace ([string]$m.g) 'hello' 1.6 } else { $script:rig.Play([string]$m.g) } }
    'quit' { $w.Close() }
  }
}

# @ASK_HOOK
# Commands arrive as JSON lines on stdin (background thread -> queue); the UI drains the queue. stdin closed = daemon gone -> close.
[AivinMascot.Input]::Start()
$pump = New-Object Windows.Threading.DispatcherTimer; $pump.Interval = [TimeSpan]::FromMilliseconds(80)
$pump.Add_Tick({
  $line = $null
  while ([AivinMascot.Input]::Lines.TryDequeue([ref]$line)) {
    if ($line) { try { Handle ($line | ConvertFrom-Json) } catch { [Console]::Error.WriteLine($_.Exception.Message) } }
  }
  if ([AivinMascot.Input]::Closed -and [AivinMascot.Input]::Lines.IsEmpty) { $pump.Stop(); $w.Close() }
})
$w.Add_ContentRendered({
  SetState 'idle'; Place; $w.FindResource('WindowIn').Begin($w); $script:rig.Start(); $script:rig.Intro(); $pump.Start(); Send @{ t = 'ready' }
})
$w.Add_Closed({ $script:rig.Stop() })
$app = New-Object Windows.Application
$app.ShutdownMode = 'OnMainWindowClose'
[void]$app.Run($w)
`;
