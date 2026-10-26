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
#   AIVIN_SERVER         Aivin server the code belongs to
#   AIVIN_DIR            folder the agent may work in (default: current folder)
#   AIVIN_VERSION        release, e.g. v1.1.0 (default: the one in <root>/latest.txt)
#   AIVIN_DOWNLOAD_ROOT  versioned download site: <root>/latest.txt + <root>/<version>/<asset> (default: https://get.aivin.vn)
#   AIVIN_DOWNLOAD_BASE  one folder holding every asset, e.g. a GitHub release - overrides the root
#   AIVIN_INSTALL_DIR    install folder (default: %LOCALAPPDATA%\Aivin\bin)
#   AIVIN_NO_MODIFY_PATH set to 1 to leave the user PATH untouched
#
# Keep this file ASCII-only: GitHub serves release assets as application/octet-stream and
# Windows PowerShell 5 may decode them with a legacy code page.

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
# Expected failures: print one clear line, then stop the installer. Never `exit` - under `irm | iex` that would close the
# user's PowerShell window; the outer try/catch below swallows this marker exception instead of dumping an error record.
function Fail($text) { Write-Host "  $text" -ForegroundColor Red; throw [System.OperationCanceledException]::new($text) }

function Install-AivinCli {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'  # the Invoke-WebRequest progress bar slows downloads a lot on PowerShell 5

    if ($env:AIVIN_DOWNLOAD_BASE) {
        $base = $env:AIVIN_DOWNLOAD_BASE.TrimEnd('/')
    } else {
        # Resolve "latest" to a concrete version first, then download from that version's folder: the CDN may cache
        # files, and a versioned folder never mixes a new checksum list with an old binary.
        $root = if ($env:AIVIN_DOWNLOAD_ROOT) { $env:AIVIN_DOWNLOAD_ROOT.TrimEnd('/') } else { 'https://get.aivin.vn' }
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
    Write-Step "Downloading $asset ..."
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('aivin-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $gz = Join-Path $tmp "$asset.gz"
        $exe = Join-Path $tmp $asset
        $sums = Join-Path $tmp 'SHA256SUMS'
        try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.gz" -OutFile $gz }
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
                try { $unzip.CopyTo($out) } finally { $unzip.Dispose() }
            } finally { $out.Dispose() }
        } finally { $in.Dispose() }

        # Make sure the new build actually starts on this machine before replacing a working one.
        Unblock-File -Path $exe -ErrorAction SilentlyContinue
        try { $installedVersion = (& $exe --version 2>$null) } catch { $installedVersion = $null }
        if ($LASTEXITCODE -ne 0 -or -not $installedVersion) { Fail "The $asset build does not start on this machine ($cpu). Please report this to Aivin." }

        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        # A running copy (still taking jobs) keeps the file locked - move it aside, then copy the new one in.
        if (Test-Path $target) {
            $old = "$target.old"
            if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
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

    if ($env:AIVIN_PAIR_CODE) {
        $argsList = @('remote', 'start', '--code', $env:AIVIN_PAIR_CODE)
        if ($env:AIVIN_SERVER) { $argsList += @('--server', $env:AIVIN_SERVER) }
        if ($env:AIVIN_DIR) { $argsList += @('--dir', $env:AIVIN_DIR) }
        Write-Step 'Connecting this computer to Aivin - keep this window open so the AI can work here.'
        Write-Host ''
        & $target @argsList
    } else {
        Write-Host ''
        Write-Host '  Next: create a code in Aivin (chat box -> Browser menu -> Add this computer), then run:' -ForegroundColor Gray
        Write-Host '    aivin remote start --code <code>' -ForegroundColor White
    }
}

try {
    Install-AivinCli
} catch [System.OperationCanceledException] {
    # Already explained by Fail.
} catch {
    Write-Host "  Install failed: $($_.Exception.Message)" -ForegroundColor Red
}
