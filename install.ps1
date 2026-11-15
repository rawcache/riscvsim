# StudyRISC-V CLI installer (Windows PowerShell)
#
#   irm https://studyriscv.com/install.ps1 | iex
#
# Downloads a prebuilt riscvsim binary for your architecture from GitHub
# releases and adds it to your user PATH. If no prebuilt binary exists it
# falls back to building from source with cargo, if available.

$ErrorActionPreference = "Stop"

$Repo = "rawcache/riscvsim"
$InstallDir = if ($env:RISCVSIM_INSTALL_DIR) { $env:RISCVSIM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "riscvsim\bin" }

function Write-Status($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host $msg -ForegroundColor Green }
function Write-Err($msg)    { Write-Host $msg -ForegroundColor Red }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "ARM64" { "arm64" }
    "AMD64" { "x86_64" }
    default { $null }
}
if (-not $arch) {
    Write-Err "✗ unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
    exit 1
}

$asset = "riscvsim-windows-$arch.zip"
$url = "https://github.com/$Repo/releases/latest/download/$asset"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "riscvsim-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    Write-Status "Downloading riscvsim (windows/$arch)..."
    $zipPath = Join-Path $tmp $asset
    $downloaded = $true
    try {
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    } catch {
        $downloaded = $false
    }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    if ($downloaded) {
        Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
        Copy-Item (Join-Path $tmp "riscvsim.exe") (Join-Path $InstallDir "riscvsim.exe") -Force
    } elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
        Write-Err "✗ prebuilt binary not yet available for your platform — building from source instead (requires Rust)"
        Write-Status "Cloning $Repo..."
        git clone --depth 1 "https://github.com/$Repo" (Join-Path $tmp "src") | Out-Null
        Write-Status "Building riscvsim (this takes a minute)..."
        Push-Location (Join-Path $tmp "src\cli")
        cargo build --release --quiet
        Pop-Location
        Copy-Item (Join-Path $tmp "src\cli\target\release\riscvsim.exe") (Join-Path $InstallDir "riscvsim.exe") -Force
    } else {
        Write-Err "✗ prebuilt binary not yet available for your platform, and cargo is not installed — install Rust from https://rustup.rs and re-run"
        exit 1
    }

    # verify the binary actually runs before declaring victory
    $version = & (Join-Path $InstallDir "riscvsim.exe") --version
    if ($LASTEXITCODE -ne 0) {
        Write-Err "✗ installed binary failed to run — please report this at https://github.com/$Repo/issues"
        exit 1
    }

    # add to the user PATH if it isn't there yet
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
        $pathNote = "added $InstallDir to your PATH — restart your terminal to pick it up"
    } else {
        $pathNote = $null
    }

    Write-Ok "✓ riscvsim installed ($version)"
    if ($pathNote) { Write-Host $pathNote -ForegroundColor DarkGray }
    Write-Host ""
    Write-Host "get started:"
    Write-Host "  riscvsim run program.s        # assemble + run, print final state"
    Write-Host "  riscvsim run program.s -v     # full instruction trace"
    Write-Host "  riscvsim serve program.s      # step through it in the browser"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
