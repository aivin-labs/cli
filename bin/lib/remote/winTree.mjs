import { spawn } from 'child_process';

/**
 * Giết cả cây tiến trình trên Windows, kể cả phần đã "mồ côi" (09/11/2026). `taskkill /T` chỉ đi theo cây còn sống: shell đã thoát (lệnh dùng
 * `start`, `Start-Process`, script tự tách nền) thì các tiến trình cháu không còn nối với cây — huỷ / hết giờ là chúng chạy tiếp mãi. Windows không
 * đổi `ParentProcessId` của tiến trình mồ côi, nên vẫn lần ra được từ PID gốc; lọc theo giờ tạo (≥ lúc chạy lệnh) để không giết nhầm tiến trình
 * lạ dùng lại PID cũ.
 */
export function orphanSweepScript(rootPid, sinceMs) {
  const pid = Math.trunc(Number(rootPid));
  const since = Math.trunc(Number(sinceMs)) - 1000;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(since)) return null;
  return [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate',
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime`,
    `$q = New-Object System.Collections.Queue; $q.Enqueue([uint32]${pid}); $kill = New-Object System.Collections.Generic.List[uint32]`,
    'while ($q.Count) { $p = $q.Dequeue(); foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and $c.CreationDate -ge $since -and -not $kill.Contains($c.ProcessId)) { $kill.Add($c.ProcessId); $q.Enqueue($c.ProcessId) } } }',
    'foreach ($k in $kill) { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
}

/** `child`: tiến trình Node đã spawn; `startedAt`: ms lúc chạy. Cây còn sống → taskkill /T; luôn quét thêm phần mồ côi. */
export function killWindowsTree(child, startedAt, { spawnImpl = spawn } = {}) {
  const run = (cmd, args) => { try { spawnImpl(cmd, args, { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined); } catch { /* bỏ qua */ } };
  if (!child?.pid) return;
  if (child.exitCode === null && child.signalCode === null) run('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  const script = orphanSweepScript(child.pid, startedAt);
  if (script) run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}
