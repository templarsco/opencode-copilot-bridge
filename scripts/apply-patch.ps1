<#
.SYNOPSIS
  Applies the Copilot Bridge patch to an OpenCode installation.

.DESCRIPTION
  Locates the OpenCode source or installed binary, applies the copilot.ts patch,
  and optionally rebuilds the binary. Supports both source installs and
  standalone binaries.

.PARAMETER OpenCodePath
  Path to the OpenCode source directory (contains packages/opencode/).
  If not specified, attempts to find it automatically.

.PARAMETER BinaryOnly
  If set, patches the installed binary directly by replacing copilot.ts
  in the Bun standalone bundle. Requires the pre-built patched file.

.EXAMPLE
  .\apply-patch.ps1 -OpenCodePath "C:\Users\me\opencode"
  .\apply-patch.ps1 -BinaryOnly
#>
param(
  [string]$OpenCodePath,
  [switch]$BinaryOnly
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchFile = Join-Path (Split-Path -Parent $ScriptDir) "patches\copilot.ts.patch"

if (-not (Test-Path $PatchFile)) {
  Write-Error "Patch file not found: $PatchFile"
  exit 1
}

# --- Source patch mode ---
if (-not $BinaryOnly) {
  # Find OpenCode source
  if (-not $OpenCodePath) {
    # Try common locations
    $candidates = @(
      (Join-Path $env:USERPROFILE "opencode"),
      (Join-Path $env:USERPROFILE "Documents\opencode"),
      (Join-Path $env:USERPROFILE "Documents\Projetos\opencode")
    )
    foreach ($c in $candidates) {
      if (Test-Path (Join-Path $c "packages\opencode\src\plugin\copilot.ts")) {
        $OpenCodePath = $c
        break
      }
    }
  }

  if (-not $OpenCodePath -or -not (Test-Path $OpenCodePath)) {
    Write-Error "OpenCode source not found. Specify path with -OpenCodePath"
    exit 1
  }

  $target = Join-Path $OpenCodePath "packages\opencode\src\plugin\copilot.ts"
  if (-not (Test-Path $target)) {
    Write-Error "copilot.ts not found at: $target"
    exit 1
  }

  Write-Host "Patching: $target" -ForegroundColor Cyan

  # Backup original
  $backup = "$target.bak"
  if (-not (Test-Path $backup)) {
    Copy-Item $target $backup
    Write-Host "Backup created: $backup" -ForegroundColor Green
  }

  # Apply patch
  try {
    Push-Location $OpenCodePath
    git apply --check $PatchFile 2>$null
    if ($LASTEXITCODE -eq 0) {
      git apply $PatchFile
      Write-Host "Patch applied successfully!" -ForegroundColor Green
    } else {
      Write-Host "Patch may already be applied or source has changed." -ForegroundColor Yellow
      Write-Host "Attempting reverse check..." -ForegroundColor Yellow
      git apply --check --reverse $PatchFile 2>$null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Patch is already applied." -ForegroundColor Green
      } else {
        Write-Error "Patch cannot be applied cleanly. Manual intervention needed."
        exit 1
      }
    }
    Pop-Location
  } catch {
    Pop-Location
    Write-Error "Failed to apply patch: $_"
    exit 1
  }

  # Build
  Write-Host ""
  $build = Read-Host "Build patched binary? (y/N)"
  if ($build -eq "y" -or $build -eq "Y") {
    Write-Host "Building..." -ForegroundColor Cyan
    Push-Location $OpenCodePath
    bun run ./packages/opencode/script/build.ts --single
    if ($LASTEXITCODE -eq 0) {
      $exe = Join-Path $OpenCodePath "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
      Write-Host "Build complete: $exe" -ForegroundColor Green
    } else {
      Write-Error "Build failed"
    }
    Pop-Location
  }
} else {
  Write-Host "Binary-only mode not yet implemented." -ForegroundColor Yellow
  Write-Host "Use source mode: .\apply-patch.ps1 -OpenCodePath <path>" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Run 'bun run scripts/discover-models.ts --diff' to find new models"
Write-Host "  2. Run 'bun run scripts/discover-models.ts --apply' to add them to config"
Write-Host "  3. Restart OpenCode"
