# install-bridge.ps1 — OpenCode Copilot Bridge Installer
#
# Downloads the latest bridge release, closes all OpenCode instances,
# replaces sidecars with the patched binary, and restarts the apps.
#
# Universal one-liner install (works on PowerShell 5.1, 7.x, and newer):
#   irm https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1 | iex
#
#   To install beta:   $env:BRIDGE_CHANNEL='beta';  irm https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1 | iex
#   To install both:   $env:BRIDGE_CHANNEL='all';   irm https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1 | iex
#   To uninstall:      $env:BRIDGE_UNINSTALL='1';   irm https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1 | iex
#
# From cloned repo:
#   .\scripts\install-bridge.ps1
#   .\scripts\install-bridge.ps1 -Uninstall
#   .\scripts\install-bridge.ps1 -Version bridge-v1.2.20
#   .\scripts\install-bridge.ps1 -Channel beta
#   .\scripts\install-bridge.ps1 -Channel all

param(
    [switch]$Uninstall,
    [string]$Version = "",
    [string]$Channel = ''
)

# ─── Env var fallback (enables universal `irm | iex` one-liners) ──
# When piped via `irm | iex`, PowerShell can't pass params directly.
# Instead, set env vars before the pipeline: $env:BRIDGE_CHANNEL='beta'
if (-not $Channel -and $env:BRIDGE_CHANNEL) {
    $Channel = $env:BRIDGE_CHANNEL
    Remove-Item Env:BRIDGE_CHANNEL -ErrorAction SilentlyContinue
}
if (-not $Channel) { $Channel = 'stable' }

# Validate channel value
if ($Channel -notin @('stable', 'beta', 'all')) {
    Write-Host "ERROR: Invalid channel '$Channel'. Must be: stable, beta, all" -ForegroundColor Red
    exit 1
}

if (-not $Uninstall -and $env:BRIDGE_UNINSTALL) {
    $Uninstall = [switch]$true
    Remove-Item Env:BRIDGE_UNINSTALL -ErrorAction SilentlyContinue
}

if (-not $Version -and $env:BRIDGE_VERSION) {
    $Version = $env:BRIDGE_VERSION
    Remove-Item Env:BRIDGE_VERSION -ErrorAction SilentlyContinue
}

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
$bannerTitle = "OpenCode Copilot Bridge - Installer ($Channel channel)"
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host "  |   $bannerTitle" -ForegroundColor Cyan
Write-Host "  +=============================================+" -ForegroundColor Cyan
Write-Host ""

# ─── Uninstall mode ─────────────────────────────────────────────────
if ($Uninstall) {
    Write-Host "[Uninstall] Restoring original binaries..." -ForegroundColor Yellow

    # Kill ALL OpenCode processes first (sidecar + desktop apps)
    $processNames = @("opencode-cli", "opencode", "OpenCode")
    foreach ($proc in $processNames) {
        $running = Get-Process -Name $proc -ErrorAction SilentlyContinue
        if ($running) {
            foreach ($p in $running) {
                Write-Host "  Closing: $($p.Name) (PID $($p.Id))" -ForegroundColor DarkYellow
            }
            Stop-Process -Name $proc -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 3

    $restored = 0
    foreach ($target in $targets) {
        $orig = "$($target.Path).original"
        if (Test-Path $orig) {
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

# ─── Step 2: Fetch latest release(s) ───────────────────────────────
Write-Host "`n[2/5] Fetching latest bridge release(s)..." -ForegroundColor Yellow

# Helper: Fetch a specific release or tag
function Get-BridgeRelease([string]$tag) {
    if ($tag) {
        $url = "$apiBase/releases/tags/$tag"
    } else {
        $url = "$apiBase/releases/latest"
    }
    try {
        return Invoke-RestMethod -Uri $url -Headers @{ "User-Agent" = "opencode-bridge-installer" }
    } catch {
        return $null
    }
}

# Helper: Find asset matching pattern
function Find-Asset([object]$release, [string]$pattern) {
    return $release.assets | Where-Object { $_.name -like $pattern } | Select-Object -First 1
}

# Fetch release(s) based on channel
$releases = @{}
$assets = @{}

if ($Version) {
    # Explicit version overrides channel
    $release = Get-BridgeRelease -tag $Version
    if (-not $release) {
        Write-Host "  Release $Version not found." -ForegroundColor Red
        Write-Host ""
        return
    }
    $releases['explicit'] = $release
    $assets['explicit'] = Find-Asset $release "*windows-x64*exe"
} elseif ($Channel -eq 'stable' -or $Channel -eq 'all') {
    # Fetch all releases and find latest stable (non-beta tag)
    $allReleases = Invoke-RestMethod -Uri "$apiBase/releases" -Headers @{ "User-Agent" = "opencode-bridge-installer" }
    $stableRelease = $allReleases | Where-Object { $_.tag_name -like 'bridge-v*' -and $_.tag_name -notlike '*beta*' } | Select-Object -First 1
    if (-not $stableRelease) {
        Write-Host "  No stable release found." -ForegroundColor Red
        Write-Host ""
        return
    }
    $releases['stable'] = $stableRelease
    $assets['stable'] = Find-Asset $stableRelease "*-stable-windows-x64.exe"
}

if ($Channel -eq 'beta' -or $Channel -eq 'all') {
    # Fetch all releases and find latest beta
    $allReleases = Invoke-RestMethod -Uri "$apiBase/releases" -Headers @{ "User-Agent" = "opencode-bridge-installer" }
    $betaRelease = $allReleases | Where-Object { $_.tag_name -like 'bridge-beta-*' } | Select-Object -First 1
    if (-not $betaRelease) {
        Write-Host "  No beta release found." -ForegroundColor Red
        Write-Host ""
        return
    }
    $releases['beta'] = $betaRelease
    $assets['beta'] = Find-Asset $betaRelease "*-beta-windows-x64.exe"
}

# Validate that we have at least one asset
if ($assets.Count -eq 0) {
    Write-Host "  No compatible binaries found for channel '$Channel'." -ForegroundColor Red
    Write-Host ""
    return
}

# Log what we're installing
foreach ($key in $releases.Keys) {
    $rel = $releases[$key]
    $asset = $assets[$key]
    if ($asset) {
        $sizeMB = [math]::Round($asset.size / 1MB, 1)
        Write-Host "  Release: $($rel.name) [$($rel.tag_name)]" -ForegroundColor Green
        Write-Host "  Binary:  $($asset.name) ($sizeMB MB)" -ForegroundColor DarkGray
    } else {
        Write-Host "  WARNING: No Windows x64 binary found for $($rel.tag_name)" -ForegroundColor Yellow
    }
}

# ─── Step 3: Download ──────────────────────────────────────────────
Write-Host "`n[3/5] Downloading bridge binary(ies)..." -ForegroundColor Yellow
$tempDir = Join-Path $env:TEMP "opencode-bridge-install"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$downloads = @{}

foreach ($key in $assets.Keys) {
    $asset = $assets[$key]
    if (-not $asset) { continue }
    
    $downloadPath = Join-Path $tempDir $asset.name
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloadPath -UseBasicParsing
        $ProgressPreference = 'Continue'
    } catch {
        Write-Host "  Download failed [$key]: $_" -ForegroundColor Red
        Write-Host ""
        return
    }
    
    if (-not (Test-Path $downloadPath)) {
        Write-Host "  Download failed [$key] — file not found." -ForegroundColor Red
        Write-Host ""
        return
    }
    
    $actualSize = [math]::Round((Get-Item $downloadPath).Length / 1MB, 1)
    Write-Host "  Downloaded [$key]: $actualSize MB" -ForegroundColor Green
    $downloads[$key] = $downloadPath
}

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
Write-Host "`n[5/5] Installing bridge binary(ies)..." -ForegroundColor Yellow
$installed = @()
$appsToRestart = @()

# Map releases to target installations based on channel
$targetsByChannel = @{
    'stable' = @(
        ($targets | Where-Object { $_.Name -eq 'Desktop (Stable)' })
        ($targets | Where-Object { $_.Name -eq 'CLI (Bun)' })
    )
    'beta' = @(
        ($targets | Where-Object { $_.Name -eq 'Desktop (Beta)' })
    )
}

# Process each downloaded binary
foreach ($downloadKey in $downloads.Keys) {
    $downloadPath = $downloads[$downloadKey]
    
    # Determine which targets this binary applies to
    if ($Version) {
        # When using explicit version, apply to all found targets
        $targetsForBinary = $found
    } else {
        # Otherwise use channel-specific targets
        $targetsForBinary = $targetsByChannel[$downloadKey] | Where-Object { $_ -in $found }
    }
    
    if ($targetsForBinary.Count -eq 0) {
        Write-Host "  Skipped [$downloadKey]: No matching targets installed" -ForegroundColor DarkGray
        continue
    }
    
    foreach ($target in $targetsForBinary) {
        # Backup original (only first time — never overwrite existing backup)
        if ((Test-Path $target.Path) -and -not (Test-Path "$($target.Path).original")) {
            Copy-Item $target.Path "$($target.Path).original" -Force
            Write-Host "  Backed up original: $($target.Name)" -ForegroundColor DarkGray
        }
        
        try {
            Copy-Item $downloadPath $target.Path -Force
            Write-Host "  Installed [$downloadKey]: $($target.Name)" -ForegroundColor Green
            $installed += "$($target.Name) ($downloadKey)"
        } catch {
            Write-Host "  FAILED   [$downloadKey]: $($target.Name) — $_" -ForegroundColor Red
            Write-Host "            Close the app manually and re-run." -ForegroundColor DarkRed
            continue
        }
        
        if ($target.App -and (Test-Path $target.App)) {
            $appsToRestart += $target
        }
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
$tagSummary = if ($Version) { $Version } else { "$Channel channel" }
Write-Host "  +=============================================+" -ForegroundColor Green
Write-Host "  |   Bridge $tagSummary installed!             |" -ForegroundColor Green
Write-Host "  +=============================================+" -ForegroundColor Green
Write-Host ""
Write-Host "  Patched: $($installed -join ', ')" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To uninstall (restore originals):" -ForegroundColor DarkGray
Write-Host "    `$env:BRIDGE_UNINSTALL='1'; irm https://raw.githubusercontent.com/templarsco/opencode-copilot-bridge/main/scripts/install-bridge.ps1 | iex" -ForegroundColor DarkGray
Write-Host ""
