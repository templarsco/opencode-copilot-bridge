# install-bridge.ps1 — OpenCode Copilot Bridge Installer
#
# Downloads the latest bridge release, closes all OpenCode instances,
# replaces sidecars with the patched binary, and restarts the apps.
#
# One-liner install (PowerShell):
#   irm https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1 | iex
#
# From cloned repo:
#   .\scripts\install-bridge.ps1
#   .\scripts\install-bridge.ps1 -Uninstall         # Restore originals
#   .\scripts\install-bridge.ps1 -Version bridge-v1.2.20  # Specific version

param(
    [switch]$Uninstall,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$repo = "templarsco/opencode-copilot-bridge"
$apiBase = "https://api.github.com/repos/$repo"

$targets = @(
    @{
        Name = "Desktop (Stable)"
        Path = "$env:LOCALAPPDATA\OpenCode\opencode-cli.exe"
        App  = "$env:LOCALAPPDATA\OpenCode\OpenCode.exe"
        Proc = "OpenCode"
    },
    @{
        Name = "Desktop (Beta)"
        Path = "$env:LOCALAPPDATA\OpenCode Beta\opencode-cli.exe"
        App  = "$env:LOCALAPPDATA\OpenCode Beta\OpenCode.exe"
        Proc = "OpenCode"
    },
    @{
        Name = "CLI (Bun)"
        Path = "$env:USERPROFILE\.bun\bin\opencode.exe"
        App  = $null
        Proc = $null
    }
)

# ─── Banner ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host "  |   OpenCode Copilot Bridge - Installer       |" -ForegroundColor Cyan
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host ""

# ─── Uninstall mode ─────────────────────────────────────────────────
if ($Uninstall) {
    Write-Host "[Uninstall] Restoring original binaries..." -ForegroundColor Yellow
    $restored = 0
    foreach ($target in $targets) {
        $orig = "$($target.Path).original"
        if (Test-Path $orig) {
            # Kill process if running
            if ($target.Proc) {
                Get-Process -Name $target.Proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Milliseconds 500
            Copy-Item $orig $target.Path -Force
            Remove-Item $orig -Force
            Write-Host "  Restored: $($target.Name)" -ForegroundColor Green
            $restored++
        } else {
            Write-Host "  Skipped:  $($target.Name) (no backup found)" -ForegroundColor DarkGray
        }
    }
    if ($restored -gt 0) {
        Write-Host "`n  Original binaries restored. Restart OpenCode." -ForegroundColor Green
    } else {
        Write-Host "`n  No backups found. Nothing to restore." -ForegroundColor DarkGray
    }
    Write-Host ""
    return
}

# ─── Step 1: Detect installations ──────────────────────────────────
Write-Host "[1/5] Detecting OpenCode installations..." -ForegroundColor Yellow
$found = @()
foreach ($target in $targets) {
    $dir = Split-Path -Parent $target.Path
    if (Test-Path $dir) {
        Write-Host "  Found: $($target.Name)" -ForegroundColor Green
        Write-Host "         $($target.Path)" -ForegroundColor DarkGray
        $found += $target
    } else {
        Write-Host "  Skip:  $($target.Name) (not installed)" -ForegroundColor DarkGray
    }
}

if ($found.Count -eq 0) {
    Write-Host "`n  No OpenCode installations found." -ForegroundColor Red
    Write-Host ""
    return
}

# ─── Step 2: Fetch latest release ──────────────────────────────────
Write-Host "`n[2/5] Fetching latest bridge release..." -ForegroundColor Yellow

if ($Version) {
    $releaseUrl = "$apiBase/releases/tags/$Version"
} else {
    $releaseUrl = "$apiBase/releases/latest"
}

try {
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers @{ "User-Agent" = "opencode-bridge-installer" }
} catch {
    Write-Host "  Failed to fetch release info." -ForegroundColor Red
    Write-Host "  Error: $_" -ForegroundColor DarkRed
    Write-Host ""
    return
}

$tag = $release.tag_name
$releaseName = $release.name
$asset = $release.assets | Where-Object { $_.name -like "*windows-x64*" -and $_.name -like "*.exe" } | Select-Object -First 1

if (-not $asset) {
    Write-Host "  No Windows x64 binary found in release $tag" -ForegroundColor Red
    Write-Host ""
    return
}

$sizeMB = [math]::Round($asset.size / 1MB, 1)
Write-Host "  Release: $releaseName" -ForegroundColor Green
Write-Host "  Tag:     $tag" -ForegroundColor DarkGray
Write-Host "  Binary:  $($asset.name) ($sizeMB MB)" -ForegroundColor DarkGray

# ─── Step 3: Download ──────────────────────────────────────────────
Write-Host "`n[3/5] Downloading bridge binary..." -ForegroundColor Yellow
$tempDir = Join-Path $env:TEMP "opencode-bridge-install"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$downloadPath = Join-Path $tempDir $asset.name

try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloadPath -UseBasicParsing
    $ProgressPreference = 'Continue'
} catch {
    Write-Host "  Download failed: $_" -ForegroundColor Red
    Write-Host ""
    return
}

if (-not (Test-Path $downloadPath)) {
    Write-Host "  Download failed — file not found." -ForegroundColor Red
    Write-Host ""
    return
}

$actualSize = [math]::Round((Get-Item $downloadPath).Length / 1MB, 1)
Write-Host "  Downloaded: $actualSize MB" -ForegroundColor Green

# ─── Step 4: Kill OpenCode processes ───────────────────────────────
Write-Host "`n[4/5] Closing OpenCode processes..." -ForegroundColor Yellow

# Kill sidecar first, then desktop apps
$processNames = @("opencode-cli", "OpenCode")
$killed = $false

foreach ($proc in $processNames) {
    $running = Get-Process -Name $proc -ErrorAction SilentlyContinue
    if ($running) {
        foreach ($p in $running) {
            Write-Host "  Closing: $($p.Name) (PID $($p.Id))" -ForegroundColor DarkYellow
        }
        Stop-Process -Name $proc -Force -ErrorAction SilentlyContinue
        $killed = $true
    }
}

if (-not $killed) {
    Write-Host "  No OpenCode processes running" -ForegroundColor DarkGray
} else {
    Write-Host "  Waiting for processes to exit..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
}

# ─── Step 5: Replace binaries ──────────────────────────────────────
Write-Host "`n[5/5] Installing bridge binary..." -ForegroundColor Yellow
$installed = @()
$appsToRestart = @()

foreach ($target in $found) {
    # Backup original (only first time — never overwrite existing backup)
    if ((Test-Path $target.Path) -and -not (Test-Path "$($target.Path).original")) {
        Copy-Item $target.Path "$($target.Path).original" -Force
        Write-Host "  Backed up original: $($target.Name)" -ForegroundColor DarkGray
    }

    try {
        Copy-Item $downloadPath $target.Path -Force
        Write-Host "  Installed: $($target.Name)" -ForegroundColor Green
        $installed += $target.Name
    } catch {
        Write-Host "  FAILED:   $($target.Name) — $_" -ForegroundColor Red
        Write-Host "            Close the app manually and re-run." -ForegroundColor DarkRed
        continue
    }

    if ($target.App -and (Test-Path $target.App)) {
        $appsToRestart += $target
    }
}

# ─── Restart Desktop apps ──────────────────────────────────────────
if ($appsToRestart.Count -gt 0) {
    Write-Host "`n  Restarting Desktop apps..." -ForegroundColor Yellow
    foreach ($target in $appsToRestart) {
        Start-Process $target.App
        Write-Host "  Started:  $($target.Name)" -ForegroundColor Green
    }
}

# ─── Cleanup temp files ────────────────────────────────────────────
Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

# ─── Summary ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  +=============================================+" -ForegroundColor Green
Write-Host "  |   Bridge $tag installed!       |" -ForegroundColor Green
Write-Host "  +=============================================+" -ForegroundColor Green
Write-Host ""
Write-Host "  Patched: $($installed -join ', ')" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To uninstall (restore originals):" -ForegroundColor DarkGray
Write-Host "    .\scripts\install-bridge.ps1 -Uninstall" -ForegroundColor DarkGray
Write-Host ""
