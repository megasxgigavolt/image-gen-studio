# Auto Gen Studio - Release Build Script
# Run from repo root: .\released\build-release.ps1 [-Version "1.2.x"]
#
# If a signing key exists at $env:USERPROFILE\.tauri-keys\auto-gen-studio.key
# (generated once via `npx tauri signer generate`, see releases/README.md),
# the build is signed so it can be published as an auto-update via
# releases/publish-release.ps1. Without the key, the build still succeeds
# but is unsigned and cannot serve as an auto-update.

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

# Sign the build if a local signing key is present, so it can be published
# as an auto-update afterwards.
$KeyPath = Join-Path $env:USERPROFILE ".tauri-keys\auto-gen-studio.key"
$KeyPasswordPath = Join-Path $env:USERPROFILE ".tauri-keys\auto-gen-studio.key.password"
if (Test-Path $KeyPath) {
    Write-Host "Signing key found - build will be signed for auto-update." -ForegroundColor Yellow
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $KeyPath -Raw
    if (Test-Path $KeyPasswordPath) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $KeyPasswordPath -Raw).Trim()
    }
} else {
    Write-Host "No signing key at $KeyPath - build will be UNSIGNED (auto-update won't work for this build)." -ForegroundColor Yellow
}

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

# Copy the updater signature alongside it, if this was a signed build.
$SigSrc = "$InstallerSrc.sig"
if (Test-Path $SigSrc) {
    Copy-Item $SigSrc "$Dest.sig" -Force
}

Write-Host ""
Write-Host "Done! Installer saved to:" -ForegroundColor Green
Write-Host "  $Dest" -ForegroundColor White
if (Test-Path "$Dest.sig") {
    Write-Host ""
    Write-Host "Signed. To publish this as an auto-update for existing installs, run:" -ForegroundColor Green
    Write-Host "  .\releases\publish-release.ps1 -Version $Version" -ForegroundColor White
}
