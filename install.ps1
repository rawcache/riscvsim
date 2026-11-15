# StudyRISC-V CLI installer (Windows PowerShell)
#
#   irm https://studyriscv.com/install.ps1 | iex
#
# Non-interactive / scripted use (skips any confirmation prompts):
#   $env:RISCVSIM_INSTALL_YES = "1"; irm https://studyriscv.com/install.ps1 | iex
# or, when running the downloaded file directly:
#   .\install.ps1 -Yes
#
# Downloads a prebuilt riscvsim binary for your architecture from GitHub
# releases and adds it to your user PATH. Falls back to building from source
# with cargo if no prebuilt binary exists for your platform.

[CmdletBinding()]
param(
    [Alias("y")]
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

$Repo = "rawcache/riscvsim"
$InstallDir = if ($env:RISCVSIM_INSTALL_DIR) { $env:RISCVSIM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "riscvsim\bin" }

# -----------------------------------------------------------------------------
# --yes equivalent: -Yes switch or RISCVSIM_INSTALL_YES=1. The installer has
# no confirmation prompts today, so this is a forward-compatible no-op; any
# future prompt must go through Confirm-Step so it honors this.
# -----------------------------------------------------------------------------
$AssumeYes = $Yes -or ($env:RISCVSIM_INSTALL_YES -eq "1")

function Confirm-Step($Question) {
    if ($AssumeYes) { return $true }
    if ([Console]::IsInputRedirected) { return $true }  # piped installs never hang
    $reply = Read-Host "$Question [Y/n]"
    return ($reply -notmatch "^(n|no)$")
}

# -----------------------------------------------------------------------------
# Output: animated spinner in a real console; plain instant lines with no
# ANSI/redraws when output is redirected, or in CI / NO_COLOR environments.
# -----------------------------------------------------------------------------
$Fancy = (-not [Console]::IsOutputRedirected) -and (-not $env:CI) -and (-not $env:NO_COLOR)

function Write-Ok($msg)   { Write-Host "[OK] $msg"   -ForegroundColor Green }
function Write-Dim($msg)  { Write-Host $msg          -ForegroundColor DarkGray }
function Write-Fail($msg) { Write-Host "[X] $msg"    -ForegroundColor Red }

# Invoke-Step "Doing the thing..." { work } -> spinner while the block runs
# in a background job, then the line settles to [OK]/[X].
function Invoke-Step($Message, [scriptblock]$Action, $ArgumentList = @()) {
    if (-not $Fancy) {
        Write-Host $Message
        & $Action @ArgumentList
        Write-Ok $Message
        return
    }
    $job = Start-Job -ScriptBlock $Action -ArgumentList $ArgumentList
    $frames = "|", "/", "-", "\"
    $i = 0
    try {
        while ($job.State -eq "Running") {
            Write-Host -NoNewline ("`r{0} {1}" -f $frames[$i % $frames.Count], $Message)
            $i++
            Start-Sleep -Milliseconds 120
        }
        $null = Receive-Job $job -ErrorAction Stop
        Write-Host ("`r[OK] {0}" -f $Message) -ForegroundColor Green
    } catch {
        Write-Host ("`r[X] {0}" -f $Message) -ForegroundColor Red
        throw
    } finally {
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    }
}

# -----------------------------------------------------------------------------
# 1. detect platform
# -----------------------------------------------------------------------------
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "ARM64" { "arm64" }
    "AMD64" { "x86_64" }
    default { $null }
}
if (-not $arch) {
    Write-Fail "unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
    exit 1
}
Write-Ok "Found your platform: windows/$arch"

$asset = "riscvsim-windows-$arch.zip"
$url = "https://github.com/$Repo/releases/latest/download/$asset"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("riscvsim-install-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    # -------------------------------------------------------------------------
    # 2. download the prebuilt binary (or build from source as a fallback)
    # -------------------------------------------------------------------------
    $zipPath = Join-Path $tmp $asset
    $downloaded = $true
    try {
        Invoke-Step "Downloading riscvsim..." {
            param($u, $out)
            $ProgressPreference = "SilentlyContinue"
            Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing
        } @($url, $zipPath)
    } catch {
        $downloaded = $false
    }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    if ($downloaded) {
        Invoke-Step "Installing to $InstallDir..." {
            param($zip, $dir, $dest)
            Expand-Archive -Path $zip -DestinationPath $dir -Force
            Copy-Item (Join-Path $dir "riscvsim.exe") (Join-Path $dest "riscvsim.exe") -Force
        } @($zipPath, $tmp, $InstallDir)
    } elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
        Write-Fail "prebuilt binary not yet available for your platform, building from source instead (requires Rust)"
        Invoke-Step "Building riscvsim from source (this may take a minute or two)..." {
            param($repo, $dir, $dest)
            git clone --depth 1 "https://github.com/$repo" (Join-Path $dir "src") 2>&1 | Out-Null
            Push-Location (Join-Path $dir "src\cli")
            cargo build --release --quiet
            Pop-Location
            Copy-Item (Join-Path $dir "src\cli\target\release\riscvsim.exe") (Join-Path $dest "riscvsim.exe") -Force
        } @($Repo, $tmp, $InstallDir)
    } else {
        Write-Fail "prebuilt binary not yet available for your platform, and cargo is not installed. Install Rust from https://rustup.rs and re-run"
        exit 1
    }

    # -------------------------------------------------------------------------
    # 3. verify it actually runs before declaring victory
    # -------------------------------------------------------------------------
    $exe = Join-Path $InstallDir "riscvsim.exe"
    $version = & $exe --version
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "installed binary failed to run. Please report this at https://github.com/$Repo/issues"
        exit 1
    }

    # add to the user PATH if it isn't there yet
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathNote = $null
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
        $pathNote = "added $InstallDir to your PATH. Restart your terminal so it can find riscvsim"
    }

    Write-Host ""
    Write-Ok "$version installed"
    if ($pathNote) { Write-Dim $pathNote }
    Write-Host ""
    Write-Host "run your first program:"
    Write-Dim '  "addi x1, x0, 5", "addi x2, x1, 3" | Set-Content add.s'
    Write-Host "  riscvsim run add.s"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
