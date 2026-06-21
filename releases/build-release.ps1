# Auto Gen Studio - Release Build Script
# Run from repo root: .\released\build-release.ps1 [-Version "1.2.x"]

param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $RepoRoot "apps\desktop"
$TauriDir = Join-Path $AppDir "src-tauri"

# Detect version from tauri.conf.json if not supplied
if (-not $Version) {
    $conf = Get-Content (Join-Path $TauriDir "tauri.conf.json") | ConvertFrom-Json
    $Version = $conf.version
}

Write-Host "Building Auto Gen Studio v$Version..." -ForegroundColor Cyan

# Install frontend deps if needed
Push-Location $AppDir
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing npm dependencies..." -ForegroundColor Yellow
    npm install
}

# Run Tauri release build
Write-Host "Running tauri build (this takes a few minutes)..." -ForegroundColor Yellow
npx tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Tauri build failed with exit code $LASTEXITCODE"
    Pop-Location
    exit $LASTEXITCODE
}
Pop-Location

# Locate the NSIS installer
$InstallerSrc = Join-Path $TauriDir "target\release\bundle\nsis\Auto Gen Studio_${Version}_x64-setup.exe"
if (-not (Test-Path $InstallerSrc)) {
    # Fallback: search bundle dir
    $InstallerSrc = Get-ChildItem (Join-Path $TauriDir "target\release\bundle\nsis") -Filter "*setup.exe" |
                    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}

if (-not $InstallerSrc -or -not (Test-Path $InstallerSrc)) {
    Write-Error "Could not locate installer in target\release\bundle\nsis"
    exit 1
}

# Copy into released/vX.Y.Z/
$OutDir = Join-Path $PSScriptRoot "v$Version"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Dest = Join-Path $OutDir (Split-Path -Leaf $InstallerSrc)
Copy-Item $InstallerSrc $Dest -Force

Write-Host ""
Write-Host "Done! Installer saved to:" -ForegroundColor Green
Write-Host "  $Dest" -ForegroundColor White
