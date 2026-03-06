# apply-patch.ps1 — Apply Copilot JWT bridge patch to local OpenCode installation
#
# Usage:
#   .\scripts\apply-patch.ps1                           # Patch only (no build)
#   .\scripts\apply-patch.ps1 -Build                    # Patch + build + deploy
#   .\scripts\apply-patch.ps1 -SourcePath "C:\my\src"   # Use specific source dir
#
# Prerequisites:
#   - Bun installed (https://bun.sh)
#   - OpenCode source code (cloned from anomalyco/opencode)
#   - VS Code with GitHub Copilot extension (authenticated)

param(
    [string]$SourcePath = "",
    [switch]$Build,
    [switch]$NoDeploy
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

# ─── Find OpenCode source ───────────────────────────────────────────
function Find-OpenCodeSource {
    $candidates = @(
        $SourcePath,
        "$RepoRoot\..\opencode-source",
        "$RepoRoot\..\UsersUsuarioDocumentsProjetosopencode-source",
        "$env:USERPROFILE\Documents\Projetos\opencode-beta\UsersUsuarioDocumentsProjetosopencode-source"
    )

    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path "$dir\packages\opencode\src\plugin\copilot.ts")) {
            return (Resolve-Path $dir).Path
        }
    }

    Write-Host "OpenCode source not found. Provide path with -SourcePath or clone:" -ForegroundColor Yellow
    Write-Host "  git clone https://github.com/anomalyco/opencode.git opencode-source"
    exit 1
}

$src = Find-OpenCodeSource
$copilot = "$src\packages\opencode\src\plugin\copilot.ts"
Write-Host "Source: $src" -ForegroundColor Cyan
Write-Host "Target: $copilot" -ForegroundColor Cyan
Write-Host ""

# ─── Create backup ──────────────────────────────────────────────────
$backup = "$copilot.bak"
if (-not (Test-Path $backup)) {
    Copy-Item $copilot $backup
    Write-Host "Backup created: $backup" -ForegroundColor Green
}

# ─── Apply patch ─────────────────────────────────────────────────────
Write-Host "Applying patch..." -ForegroundColor Cyan
$patchScript = "$RepoRoot\scripts\patch-copilot.ts"
bun run $patchScript $copilot

if ($LASTEXITCODE -eq 1) {
    Write-Host "`nPatch failed. Restoring backup..." -ForegroundColor Red
    Copy-Item $backup $copilot -Force
    exit 1
}

if (-not $Build) {
    Write-Host "`nPatch applied. Run with -Build to compile and deploy." -ForegroundColor Yellow
    exit 0
}

# ─── Build ───────────────────────────────────────────────────────────
Write-Host "`nBuilding Windows binary..." -ForegroundColor Cyan
Push-Location $src
bun install
bun run ./packages/opencode/script/build.ts --single
Pop-Location

$exe = "$src\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
if (-not (Test-Path $exe)) {
    Write-Host "Build failed — output not found: $exe" -ForegroundColor Red
    exit 1
}

$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Build successful: $exe ($size MB)" -ForegroundColor Green

if ($NoDeploy) {
    Write-Host "`nBinary ready at: $exe" -ForegroundColor Yellow
    exit 0
}

# ─── Deploy ──────────────────────────────────────────────────────────
Write-Host "`nDeploying..." -ForegroundColor Cyan

$targets = @(
    "$env:LOCALAPPDATA\OpenCode Beta\opencode-cli.exe",
    "$env:USERPROFILE\.bun\bin\opencode.exe"
)

foreach ($dest in $targets) {
    $dir = Split-Path -Parent $dest
    if (Test-Path $dir) {
        # Backup existing
        if ((Test-Path $dest) -and -not (Test-Path "$dest.bak")) {
            Copy-Item $dest "$dest.bak"
            Write-Host "  Backed up: $dest" -ForegroundColor DarkGray
        }
        Copy-Item $exe $dest -Force
        Write-Host "  Deployed: $dest" -ForegroundColor Green
    }
}

Write-Host "`nDone! Restart OpenCode to use the patched version." -ForegroundColor Green
