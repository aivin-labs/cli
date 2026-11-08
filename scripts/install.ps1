# Aivin CLI installer for Windows (x64 and ARM64) - no Node.js required.
#
#   irm https://get.aivin.vn/install.ps1 | iex
#
# Install, then connect this computer to Aivin right away (Aivin prints this command in
# chat box -> Browser menu -> Add this computer):
#
#   $env:AIVIN_PAIR_CODE='ABCD-EFGH'; irm https://get.aivin.vn/install.ps1 | iex
#
# Optional environment variables (`irm | iex` cannot pass arguments):
#   AIVIN_PAIR_CODE      one-time pairing code from Aivin
#   AIVIN_SERVER         Aivin server (default: inferred from get.aivin.vn -> api.aivin.vn on every install)
#   AIVIN_PRESERVE_SERVER set to 1 to keep the currently selected server when reinstalling from another download domain
#   AIVIN_FULL_ACCESS    set to 1 to let the agent work anywhere on this computer (otherwise one folder)
#   AIVIN_DIR            folder the agent may work in (default: current folder; ignored with AIVIN_FULL_ACCESS)
#   AIVIN_VERSION        release, e.g. v1.1.0 (default: the one in <root>/latest.txt)
#   AIVIN_DOWNLOAD_ROOT  versioned download site: <root>/latest.txt + <root>/<version>/<asset> (default: https://get.aivin.vn)
#   AIVIN_DOWNLOAD_BASE  one folder holding every asset, e.g. a GitHub release - overrides the root
#   AIVIN_INSTALL_DIR    install folder (default: %LOCALAPPDATA%\Aivin\bin)
#   AIVIN_NO_MODIFY_PATH set to 1 to leave the user PATH untouched
#   AIVIN_NO_AUTOSTART   set to 1 to not start Aivin with Windows (can be turned on later in the tray menu / Task Manager)
#   AIVIN_OPEN_PLATFORM  set to 0 to keep the install in background-only mode; default opens the platform app window once after setup
#   AIVIN_NO_DESKTOP     set to 1 to skip the system tray app, the Start menu entry and start-with-Windows (servers, CI)
#
# Keep this file ASCII-only: GitHub serves release assets as application/octet-stream and
# Windows PowerShell 5 may decode them with a legacy code page.

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
# Expected failures: print one clear line, then stop the installer. Never `exit` - under `irm | iex` that would close the
# user's PowerShell window; the outer try/catch below swallows this marker exception instead of dumping an error record.
function Fail($text) { Write-Host "  $text" -ForegroundColor Red; throw [System.OperationCanceledException]::new($text) }

function Download-FileWithProgress {
    param(
        [Parameter(Mandatory = $true)] [string]$Uri,
        [Parameter(Mandatory = $true)] [string]$OutFile,
        [string]$Label = 'Downloading'
    )

    $req = [System.Net.HttpWebRequest]::Create($Uri)
    $req.Method = 'GET'
    $req.UserAgent = 'Aivin-Installer'
    $req.Timeout = 120000

    $res = $req.GetResponse()
    $totalBytes = $res.ContentLength
    $stream = $res.GetResponseStream()
    $fileStream = [System.IO.File]::Create($OutFile)

    $buffer = New-Object byte[] 65536
    $receivedBytes = 0
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastUpdate = 0
    $frames = @('|', '/', '-', '\')
    $frameIdx = 0
    $isRedirected = $false
    try { $isRedirected = [Console]::IsOutputRedirected } catch { }

    try {
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $receivedBytes += $read

            if ($sw.ElapsedMilliseconds - $lastUpdate -ge 80) {
                $lastUpdate = $sw.ElapsedMilliseconds
                $frameIdx = ($frameIdx + 1) % $frames.Length
                $spinner = $frames[$frameIdx]

                if ($totalBytes -gt 0) {
                    $pct = [Math]::Min(100, [Math]::Floor(($receivedBytes / $totalBytes) * 100))
                    $mbRecv = [Math]::Round($receivedBytes / 1MB, 1)
                    $mbTotal = [Math]::Round($totalBytes / 1MB, 1)
                    $speed = if ($sw.Elapsed.TotalSeconds -gt 0) { [Math]::Round(($receivedBytes / 1MB) / $sw.Elapsed.TotalSeconds, 1) } else { 0 }

                    $barWidth = 20
                    $filled = [Math]::Min($barWidth, [Math]::Floor(($pct / 100) * $barWidth))
                    $bar = ('=' * $filled)
                    if ($filled -lt $barWidth) {
                        $bar = $bar + '>' + (' ' * ($barWidth - $filled - 1))
                    }
                    if (-not $isRedirected) {
                        Write-Host -NoNewline ("`r  $spinner $Label [$bar] $pct% ($mbRecv / $mbTotal MB, $speed MB/s)".PadRight(75))
                    }
                } else {
                    $mbRecv = [Math]::Round($receivedBytes / 1MB, 1)
                    if (-not $isRedirected) {
                        Write-Host -NoNewline ("`r  $spinner $Label ($mbRecv MB) ...".PadRight(75))
                    }
                }
            }
        }
    } finally {
        $fileStream.Dispose()
        $stream.Dispose()
        $res.Dispose()
    }

    $totalMb = [Math]::Round($receivedBytes / 1MB, 1)
    $finalBar = '=' * 20
    if (-not $isRedirected) {
        Write-Host ("`r  [+] $Label [$finalBar] 100% ($totalMb MB)".PadRight(75)) -ForegroundColor Green
    } else {
        Write-Host "  [+] $Label ($totalMb MB) completed." -ForegroundColor Green
    }
}

function Select-InstallMode {
    $mode = @{ Autostart = ($env:AIVIN_NO_AUTOSTART -ne '1'); OpenPlatform = ($env:AIVIN_OPEN_PLATFORM -ne '0') }
    # Explicit environment settings and pairing-code installs are suitable for scripts/one-line setup.
    if ($env:AIVIN_NO_DESKTOP -or $env:AIVIN_PAIR_CODE -or $null -ne $env:AIVIN_NO_AUTOSTART -or $null -ne $env:AIVIN_OPEN_PLATFORM) { return $mode }

    $choices = [System.Management.Automation.Host.ChoiceDescription[]]@(
        (New-Object -TypeName System.Management.Automation.Host.ChoiceDescription -ArgumentList '&1'),
        (New-Object -TypeName System.Management.Automation.Host.ChoiceDescription -ArgumentList '&2'),
        (New-Object -TypeName System.Management.Automation.Host.ChoiceDescription -ArgumentList '&3')
    )
    $promptMsg = "Choose how AIVIN should start. Press Enter for the recommended setup.`n`n  [1] Recommended - start with Windows and open AIVIN`n  [2] Background only - start with Windows, do not open platform`n  [3] Open AIVIN now, do not start with Windows`n"
    try {
        $selected = $Host.UI.PromptForChoice('AIVIN setup', $promptMsg, $choices, 0)
    } catch { $selected = 0 }
    if ($selected -eq 1) { $mode.OpenPlatform = $false }
    if ($selected -eq 2) { $mode.Autostart = $false }
    return $mode
}

function Install-AivinCli {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'  # the Invoke-WebRequest progress bar slows downloads a lot on PowerShell 5
    $mode = Select-InstallMode

    $downloadRoot = if ($env:AIVIN_DOWNLOAD_ROOT) { $env:AIVIN_DOWNLOAD_ROOT.TrimEnd('/') } else { 'https://get.aivin.vn' }
    if ($env:AIVIN_DOWNLOAD_BASE) {
        $base = $env:AIVIN_DOWNLOAD_BASE.TrimEnd('/')
    } else {
        # Resolve "latest" to a concrete version first, then download from that version's folder: the CDN may cache
        # files, and a versioned folder never mixes a new checksum list with an old binary.
        $root = $downloadRoot
        $version = $env:AIVIN_VERSION
        if (-not $version) {
            try { $version = ([Text.Encoding]::ASCII.GetString((Invoke-WebRequest -UseBasicParsing -Uri "$root/latest.txt" -Headers @{ 'Cache-Control' = 'no-cache' }).RawContentStream.ToArray())).Trim() }
            catch { Fail "Could not reach $root. ($($_.Exception.Message))" }
            if ($version -notmatch '^v\d+\.\d+\.\d+') { Fail "Could not read the latest version from $root/latest.txt." }
        }
        $base = "$root/$version"
    }
    # 32-bit PowerShell on 64-bit Windows reports x86 here and the real CPU in PROCESSOR_ARCHITEW6432.
    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $asset = if ($cpu -eq 'ARM64') { 'aivin-windows-arm64.exe' } else { 'aivin-windows-x64.exe' }
    $installDir = if ($env:AIVIN_INSTALL_DIR) { $env:AIVIN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Aivin\bin' }
    $target = Join-Path $installDir 'aivin.exe'

    Write-Host ''
    Write-Host '  Aivin - installing the computer connector' -ForegroundColor White
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('aivin-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $gz = Join-Path $tmp "$asset.gz"
        $exe = Join-Path $tmp $asset
        $sums = Join-Path $tmp 'SHA256SUMS'
        try { Download-FileWithProgress -Uri "$base/$asset.gz" -OutFile $gz -Label "Downloading $asset" }
        catch { Fail "Could not download $asset from $base - check the network, or this platform may not be published yet. ($($_.Exception.Message))" }
        try { Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums }
        catch { Fail "Could not download the checksum list from $base. ($($_.Exception.Message))" }

        # Integrity: the download must match the checksum published with the same release.
        $line = Get-Content $sums | Where-Object { $_ -match "\s\*?$([regex]::Escape("$asset.gz"))$" } | Select-Object -First 1
        $expected = if ($line) { ($line -split '\s+')[0] } else { $null }
        if (-not $expected) { Fail "No checksum for $asset.gz in SHA256SUMS." }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $gz).Hash.ToLower()
        if ($actual -ne $expected.ToLower()) { Fail 'Downloaded file does not match its checksum - install stopped for safety. Please try again later.' }

        # Decompress (.NET GZipStream ships with Windows PowerShell 5 - no extra tools).
        $in = [IO.File]::OpenRead($gz)
        try {
            $out = [IO.File]::Create($exe)
            try {
                $unzip = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
                try {
                    $buf = New-Object byte[] 65536
                    $decompressed = 0
                    $swZip = [System.Diagnostics.Stopwatch]::StartNew()
                    $lastZip = 0
                    $zipFrames = @('|', '/', '-', '\')
                    $zIdx = 0
                    $isRedir = $false
                    try { $isRedir = [Console]::IsOutputRedirected } catch { }
                    while (($r = $unzip.Read($buf, 0, $buf.Length)) -gt 0) {
                        $out.Write($buf, 0, $r)
                        $decompressed += $r
                        if ($swZip.ElapsedMilliseconds - $lastZip -ge 80) {
                            $lastZip = $swZip.ElapsedMilliseconds
                            $zIdx = ($zIdx + 1) % $zipFrames.Length
                            $mb = [Math]::Round($decompressed / 1MB, 1)
                            if (-not $isRedir) {
                                Write-Host -NoNewline ("`r  $($zipFrames[$zIdx]) Extracting $asset ($mb MB) ...".PadRight(75))
                            }
                        }
                    }
                    if (-not $isRedir) {
                        Write-Host ("`r  [+] Extracted $asset ($([Math]::Round($decompressed / 1MB, 1)) MB)".PadRight(75)) -ForegroundColor Green
                    } else {
                        Write-Host "  [+] Extracted $asset ($([Math]::Round($decompressed / 1MB, 1)) MB)" -ForegroundColor Green
                    }
                } finally { $unzip.Dispose() }
            } finally { $out.Dispose() }
        } finally { $in.Dispose() }

        # Make sure the new build actually starts on this machine before replacing a working one.
        Unblock-File -Path $exe -ErrorAction SilentlyContinue
        try { $installedVersion = (& $exe --version 2>$null) } catch { $installedVersion = $null }
        if ($LASTEXITCODE -ne 0 -or -not $installedVersion) { Fail "The $asset build does not start on this machine ($cpu). Please report this to Aivin." }

        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        # A running copy (still taking jobs) keeps the file locked - move it aside under a fresh name (a copy moved aside by an earlier
        # install may still be running and locked too), then copy the new one in. aivin deletes *.trash copies once they are unlocked.
        if (Test-Path $target) {
            Get-ChildItem -Path $installDir -Filter 'aivin.exe*' | Where-Object { $_.Name -match '\.(old|trash)$' } | Remove-Item -Force -ErrorAction SilentlyContinue
            $old = "$target-$([DateTime]::UtcNow.Ticks).trash"
            try { Move-Item $target $old -Force } catch { Fail 'Could not replace the installed copy. Close the window running aivin and try again.' }
        }
        Copy-Item $exe $target -Force
        Unblock-File -Path $target -ErrorAction SilentlyContinue
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Add to the user's PATH (no admin rights needed) and to this session. AIVIN_NO_MODIFY_PATH=1 skips it (servers, CI).
    if (-not $env:AIVIN_NO_MODIFY_PATH) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not $userPath) { $userPath = '' }
        # Put the install folder FIRST: an older `aivin` (e.g. the npm package) elsewhere on PATH must not shadow this one.
        $rest = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $installDir })
        $newUserPath = (@($installDir) + $rest) -join ';'
        if ($newUserPath -ne $userPath) { [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User') }
        $env:Path = ((@($installDir) + @($env:Path -split ';' | Where-Object { $_ -and $_ -ne $installDir })) -join ';')
    }

    Write-Step "Installed aivin $installedVersion to $installDir"

    # The selected installer/download domain is the source of truth on every install. This keeps
    # the desktop app on the same environment as the installer (e.g. get.aivin.vn -> api.aivin.vn).
    # Set AIVIN_PRESERVE_SERVER=1 to keep a deliberate existing choice during a reinstall.
    $remoteHome = if ($env:AIVIN_REMOTE_HOME) { $env:AIVIN_REMOTE_HOME } else { Join-Path $env:USERPROFILE '.aivin' }
    $serverConfig = Join-Path $remoteHome 'server.json'
    $inferredServer = $null
    try {
        if (-not $env:AIVIN_DOWNLOAD_BASE) {
            $downloadHost = ([Uri]$downloadRoot).Host.ToLowerInvariant()
            if ($downloadHost -match '^get\.aivin\.(?<zone>cloud|vn)$') { $inferredServer = "https://api.aivin.$($Matches.zone)" }
        }
    } catch { }
    $serverTarget = if ($env:AIVIN_SERVER) { $env:AIVIN_SERVER } else { $inferredServer }
    $configureServer = $serverTarget -and ($env:AIVIN_SERVER -or $env:AIVIN_PRESERVE_SERVER -ne '1' -or -not (Test-Path $serverConfig))
    if ($configureServer) {
        $oldServer = $null
        if (Test-Path -LiteralPath $serverConfig) {
            try { $oldServer = (Get-Content -Raw -LiteralPath $serverConfig | ConvertFrom-Json).server_url } catch { }
        }
        if ($oldServer -and $oldServer.TrimEnd('/') -ne $serverTarget.TrimEnd('/')) {
            Write-Step "Switching Aivin server from $oldServer to $serverTarget; running remote work will stop and this computer may need to be paired again"
        }
        & $target server $serverTarget --force | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "Could not select Aivin server $serverTarget." }
        Write-Step "Using Aivin server $serverTarget"
    }

    # System tray app + Desktop/Start shortcuts + start with Windows (on by default; listed in Task Manager -> Startup apps).
    $desktop = $false
    if (-not $env:AIVIN_NO_DESKTOP) {
        $desktopArgs = @('desktop', 'install')
        if (-not $mode.Autostart) { $desktopArgs += '--no-autostart' }
        try { & $target @desktopArgs | Out-Null; $desktop = ($LASTEXITCODE -eq 0) } catch { $desktop = $false }
        if ($desktop) { Write-Step 'Aivin shortcuts are on the Desktop and Start menu; background startup is enabled' }
        else { Write-Host '  Could not set up the system tray app - aivin still works from the command line.' -ForegroundColor Yellow }
    }

    if ($env:AIVIN_PAIR_CODE) {
        # With the tray app: only pair here - the tray starts taking work as soon as this computer is paired, so this window can close.
        # Without it (servers, CI): pair and keep taking work in this window.
        $argsList = @('remote', $(if ($desktop) { 'pair' } else { 'start' }), '--code', $env:AIVIN_PAIR_CODE)
        if ($serverTarget) { $argsList += @('--server', $serverTarget) }
        if ($env:AIVIN_FULL_ACCESS) { $argsList += @('--full-access') }
        elseif ($env:AIVIN_DIR) { $argsList += @('--dir', $env:AIVIN_DIR) }
        if ($desktop) { Write-Step 'Connecting this computer to Aivin ...' }
        else { Write-Step 'Connecting this computer to Aivin - keep this window open so the AI can work here.' }
        Write-Host ''
        & $target @argsList
        if ($desktop -and $LASTEXITCODE -eq 0) {
            Write-Host ''
            Write-Step 'Done - Aivin runs from the system tray and starts with Windows. You can close this window.'
        }
    } else {
        Write-Host ''
        if ($desktop) {
            Write-Host '  Next: click the Aivin icon in the system tray and choose "Sign in to connect".' -ForegroundColor Gray
            Write-Host '  Or create a one-time code in Aivin Web and run:' -ForegroundColor Gray
        } else {
            Write-Host '  Next: create a one-time code in Aivin Web (chat box -> Browser menu -> Add this computer), then run:' -ForegroundColor Gray
        }
        Write-Host '    aivin remote start --code <code>' -ForegroundColor White
    }

    # Open platform + mascot after pairing/setup. Set AIVIN_OPEN_PLATFORM=0 for background-only setup.
    if ($desktop -and $mode.OpenPlatform) {
        $app = Join-Path $env:LOCALAPPDATA 'Aivin\Aivin.exe'
        if (Test-Path $app) { Start-Process -FilePath $app }
    }
}

try {
    Install-AivinCli
} catch [System.OperationCanceledException] {
    # Already explained by Fail.
} catch {
    Write-Host "  Install failed: $($_.Exception.Message)" -ForegroundColor Red
}
