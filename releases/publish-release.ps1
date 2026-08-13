# Auto Gen Studio - Publish Release Script
# Publishes a build produced by build-release.ps1 as a GitHub Release, and
# writes the latest.json manifest the in-app auto-updater polls (see
# apps/desktop/src-tauri/tauri.conf.json -> plugins.updater.endpoints, which
# points at https://github.com/<repo>/releases/latest/download/latest.json).
#
# Requires: `gh` CLI, authenticated with `repo` scope, and a build produced
# with a signing key present (see releases/README.md) — an unsigned build
# has no .sig file and cannot be published as an auto-update.
#
# Run from repo root: .\releases\publish-release.ps1 [-Version "2.12.0"] [-Notes "..."]

param(
    [string]$Version = "",
    [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TauriConf = Join-Path $RepoRoot "apps\desktop\src-tauri\tauri.conf.json"

if (-not $Version) {
    $conf = Get-Content $TauriConf | ConvertFrom-Json
    $Version = $conf.version
}

$OutDir = Join-Path $PSScriptRoot "v$Version"
$Installer = Get-ChildItem $OutDir -Filter "*setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Installer) {
    Write-Error "No installer found in $OutDir. Run build-release.ps1 first."
    exit 1
}
$SigFile = "$($Installer.FullName).sig"
if (-not (Test-Path $SigFile)) {
    Write-Error "No .sig file next to the installer ($SigFile). This build was not signed - re-run build-release.ps1 with a signing key present at `$env:USERPROFILE\.tauri-keys\auto-gen-studio.key, or auto-update will not work for this release."
    exit 1
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "GitHub CLI (gh) is required. Install it and run 'gh auth login' first."
    exit 1
}

$Tag = "v$Version"
if (-not $Notes) {
    $Notes = "Auto Gen Studio v$Version"
}

Write-Host "Publishing $Tag to GitHub Releases..." -ForegroundColor Cyan

# Tag the current commit if this tag doesn't already exist.
$existingTag = git -C $RepoRoot tag -l $Tag
if (-not $existingTag) {
    git -C $RepoRoot tag $Tag
    git -C $RepoRoot push origin $Tag
    Write-Host "Created and pushed tag $Tag" -ForegroundColor Yellow
}

# Build latest.json - the manifest the updater plugin fetches.
$Signature = Get-Content $SigFile -Raw
$PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$AssetName = $Installer.Name
$DownloadUrl = "https://github.com/megasxgigavolt/image-gen-studio/releases/download/$Tag/$AssetName"

$LatestJson = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = $PubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $Signature.Trim()
            url       = $DownloadUrl
        }
    }
} | ConvertTo-Json -Depth 5

$LatestJsonPath = Join-Path $OutDir "latest.json"
Set-Content -Path $LatestJsonPath -Value $LatestJson -Encoding utf8NoBOM

# Create the release if it doesn't exist yet, otherwise just refresh assets.
$releaseExists = $false
try {
    gh release view $Tag --repo megasxgigavolt/image-gen-studio *> $null
    $releaseExists = $true
} catch {
    $releaseExists = $false
}

if ($releaseExists) {
    Write-Host "Release $Tag already exists - updating its assets." -ForegroundColor Yellow
    gh release upload $Tag $Installer.FullName $SigFile $LatestJsonPath --repo megasxgigavolt/image-gen-studio --clobber
} else {
    gh release create $Tag $Installer.FullName $SigFile $LatestJsonPath `
        --repo megasxgigavolt/image-gen-studio `
        --title "Auto Gen Studio v$Version" `
        --notes $Notes
}
if ($LASTEXITCODE -ne 0) {
    Write-Error "gh release command failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Done! Published:" -ForegroundColor Green
Write-Host "  https://github.com/megasxgigavolt/image-gen-studio/releases/tag/$Tag" -ForegroundColor White
Write-Host ""
Write-Host "Existing installs will pick this up automatically the next time they launch" -ForegroundColor Green
Write-Host "(checked once on startup via the updater endpoint's 'latest' redirect)." -ForegroundColor Green
