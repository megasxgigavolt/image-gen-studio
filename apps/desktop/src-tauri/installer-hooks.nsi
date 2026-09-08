; Auto Gen Studio – Dependency Setup (runs inside the installer window)
; Tauri invokes NSIS_HOOK_POSTINSTALL after files are copied.
; nsExec::ExecToLog runs PowerShell HIDDEN and streams its output straight into
; the installer's own details list — no separate console window.
; Python is resolved to a FULL exe path and pip is always called as
; "<python.exe> -m pip", so a missing PATH entry never breaks installation.

!macro NSIS_HOOK_POSTINSTALL
  SetDetailsView show
  SetDetailsPrint both

  DetailPrint " "
  DetailPrint "=========================================================="
  DetailPrint "  AUTO GEN STUDIO  -  Installing Dependencies"
  DetailPrint "  This may take 5-20 minutes on a fresh machine."
  DetailPrint "  Please wait. Do not close this window."
  DetailPrint "=========================================================="
  DetailPrint " "

  ; ── Gemini Chrome Extension: optional ────────────────────────────────────
  ; Tauri's own resource-copying step (see tauri.conf.json's bundle.resources)
  ; already unconditionally copied it to $INSTDIR\gemini-chrome-extension
  ; before this hook ever runs — this is purely an install-time choice about
  ; whether to KEEP those files on disk or remove them again, since not every
  ; user runs the Chrome-extension-based live-generation feature. Asked here,
  ; first, before the long unattended dependency setup below, so it's one
  ; quick click rather than something to notice mid-wait. Not published on
  ; the Chrome Web Store (it drives Gemini's own web UI via chrome.debugger,
  ; which the Web Store's review process doesn't allow) — it has to stay a
  ; manually-loaded "unpacked" extension either way, hence the Load-unpacked
  ; instructions in the "yes" branch below.
  MessageBox MB_YESNO "Install the Gemini Chrome Extension?$\r$\n$\r$\nThis adds an optional browser-driven way to bulk-generate images through your own Gemini account in Chrome, instead of the built-in API path. You can skip this now and add it later by reinstalling.$\r$\n$\r$\nInstall it?" IDYES ags_ext_keep IDNO ags_ext_skip

  ags_ext_skip:
    RMDir /r "$INSTDIR\gemini-chrome-extension"
    Goto ags_ext_done

  ags_ext_keep:
    DetailPrint "Gemini Chrome Extension installed to:"
    DetailPrint "  $INSTDIR\gemini-chrome-extension"
    DetailPrint "To load it: open chrome://extensions, enable Developer mode,"
    DetailPrint "click 'Load unpacked', and select that folder."
    DetailPrint " "

  ags_ext_done:

  ; ── Write the FFmpeg helper (pure Python, no $ tokens) ────────────────────
  FileOpen $R8 "$TEMP\ags_ffmpeg.py" w
  FileWrite $R8 'import imageio_ffmpeg, shutil, os, winreg$\n'
  FileWrite $R8 'from pathlib import Path$\n'
  FileWrite $R8 'src = Path(imageio_ffmpeg.get_ffmpeg_exe())$\n'
  FileWrite $R8 'd = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AutoGenStudio" / "bin"$\n'
  FileWrite $R8 'd.mkdir(parents=True, exist_ok=True)$\n'
  FileWrite $R8 'dst = d / "ffmpeg.exe"$\n'
  FileWrite $R8 'if not dst.exists():$\n'
  FileWrite $R8 '    shutil.copy2(str(src), str(dst))$\n'
  FileWrite $R8 'bs = str(d)$\n'
  FileWrite $R8 'key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ | winreg.KEY_WRITE)$\n'
  FileWrite $R8 'try:$\n'
  FileWrite $R8 '    cur, _ = winreg.QueryValueEx(key, "PATH")$\n'
  FileWrite $R8 'except FileNotFoundError:$\n'
  FileWrite $R8 '    cur = ""$\n'
  FileWrite $R8 'parts = [p for p in cur.split(";") if p]$\n'
  FileWrite $R8 'if bs not in parts:$\n'
  FileWrite $R8 '    parts.append(bs)$\n'
  FileWrite $R8 '    winreg.SetValueEx(key, "PATH", 0, winreg.REG_EXPAND_SZ, ";".join(parts))$\n'
  FileWrite $R8 'winreg.CloseKey(key)$\n'
  FileWrite $R8 'print("FFmpeg ready:", dst)$\n'
  FileClose $R8

  ; ── Write the PowerShell driver ───────────────────────────────────────────
  FileOpen $R7 "$TEMP\ags_dep_setup.ps1" w
  FileWrite $R7 '$ErrorActionPreference = "Continue"$\n'
  FileWrite $R7 'function Log($msg){ Write-Output $msg }$\n'
  FileWrite $R7 '$\n'

  ; -- robust Python locator (returns a full python.exe path or $null) --
  FileWrite $R7 'function Find-Python {$\n'
  FileWrite $R7 '  foreach ($cmd in @("py","python","python3")) {$\n'
  FileWrite $R7 '    try {$\n'
  FileWrite $R7 '      $out = & $cmd "-c" "import sys;print(sys.executable)" 2>$null$\n'
  FileWrite $R7 '      if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Select-Object -First 1).ToString().Trim() }$\n'
  FileWrite $R7 '    } catch {}$\n'
  FileWrite $R7 '  }$\n'
  FileWrite $R7 '  $env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")$\n'
  FileWrite $R7 '  foreach ($cmd in @("py","python","python3")) {$\n'
  FileWrite $R7 '    try {$\n'
  FileWrite $R7 '      $out = & $cmd "-c" "import sys;print(sys.executable)" 2>$null$\n'
  FileWrite $R7 '      if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Select-Object -First 1).ToString().Trim() }$\n'
  FileWrite $R7 '    } catch {}$\n'
  FileWrite $R7 '  }$\n'
  FileWrite $R7 '  $roots = @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles\Python312", "$env:ProgramFiles\Python311", "$env:ProgramFiles\Python310", ([Environment]::GetEnvironmentVariable("ProgramFiles(x86)") + "\Python311"))$\n'
  FileWrite $R7 '  foreach ($root in $roots) {$\n'
  FileWrite $R7 '    if ($root -and (Test-Path $root)) {$\n'
  FileWrite $R7 '      $hit = Get-ChildItem -Path $root -Recurse -Filter "python.exe" -ErrorAction SilentlyContinue | Select-Object -First 1$\n'
  FileWrite $R7 '      if ($hit) { return $hit.FullName }$\n'
  FileWrite $R7 '    }$\n'
  FileWrite $R7 '  }$\n'
  FileWrite $R7 '  return $null$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 '$\n'

  ; -- [1/7] PYTHON --
  FileWrite $R7 'Log "[1/7] PYTHON - locating Python 3.10 or later ..."$\n'
  FileWrite $R7 '$pyExe = Find-Python$\n'
  FileWrite $R7 'if (-not $pyExe) {$\n'
  FileWrite $R7 '  Log "   [--] Python not found. Installing Python 3.11 via winget (please wait) ..."$\n'
  FileWrite $R7 '  winget install --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements --scope user --no-upgrade 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '  Start-Sleep 2$\n'
  FileWrite $R7 '  $pyExe = Find-Python$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'if (-not $pyExe) {$\n'
  FileWrite $R7 '  Log "   [!!] Python could not be installed automatically."$\n'
  FileWrite $R7 '  Log "        Install it from https://www.python.org/downloads/ (tick ADD PYTHON TO PATH),"$\n'
  FileWrite $R7 '  Log "        then re-run this installer. The app itself is installed."$\n'
  FileWrite $R7 '  exit 0$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'Log "   [OK] Python found: $pyExe"$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [2/7] PACKAGES --
  FileWrite $R7 'Log "[2/7] PACKAGES - core libraries ..."$\n'
  FileWrite $R7 '& $pyExe "-c" "import openai, pydantic, dotenv, xlsxwriter, imageio_ffmpeg" 2>$null$\n'
  FileWrite $R7 'if ($LASTEXITCODE -eq 0) {$\n'
  FileWrite $R7 '  Log "   [OK] openai, pydantic, python-dotenv, xlsxwriter, imageio-ffmpeg already present"$\n'
  FileWrite $R7 '} else {$\n'
  FileWrite $R7 '  Log "   [--] Installing core packages (a few minutes) ..."$\n'
  FileWrite $R7 '  & $pyExe "-m" "pip" "install" "--upgrade" "pip" 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '  & $pyExe "-m" "pip" "install" "--upgrade" "openai>=1.68" "pydantic>=2.10" "python-dotenv>=1.0" "xlsxwriter>=3.2" "imageio-ffmpeg" 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '  if ($LASTEXITCODE -eq 0) { Log "   [OK] Core packages installed" } else { Log "   [!!] Some packages failed - the app will retry on first launch" }$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [3/7] WHISPER --
  FileWrite $R7 'Log "[3/7] WHISPER - speech-to-text engine (~1 GB, optional) ..."$\n'
  FileWrite $R7 '& $pyExe "-c" "import whisper" 2>$null$\n'
  FileWrite $R7 'if ($LASTEXITCODE -eq 0) {$\n'
  FileWrite $R7 '  Log "   [OK] openai-whisper already installed"$\n'
  FileWrite $R7 '} else {$\n'
  FileWrite $R7 '  Log "   [--] Installing openai-whisper + PyTorch (may take 5-15 min) ..."$\n'
  FileWrite $R7 '  & $pyExe "-m" "pip" "install" "openai-whisper>=20240930" 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '  if ($LASTEXITCODE -eq 0) { Log "   [OK] openai-whisper installed" } else { Log "   [!!] whisper failed - Visual Plan will install it on first use" }$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [4/7] MODEL --
  FileWrite $R7 'Log "[4/7] MODEL - caching Whisper base model (~140 MB) ..."$\n'
  FileWrite $R7 '& $pyExe "-c" "import whisper; whisper.load_model($\'base$\')" 2>$null$\n'
  FileWrite $R7 'if ($LASTEXITCODE -eq 0) { Log "   [OK] Whisper base model cached" } else { Log "   [--] Model will download on first Visual Plan use" }$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [5/7] FFMPEG --
  FileWrite $R7 'Log "[5/7] FFMPEG - audio processing ..."$\n'
  FileWrite $R7 '$ffmpeg = $null$\n'
  FileWrite $R7 'try { $ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source } catch {}$\n'
  FileWrite $R7 'if ($ffmpeg) {$\n'
  FileWrite $R7 '  Log "   [OK] FFmpeg already available: $ffmpeg"$\n'
  FileWrite $R7 '} else {$\n'
  FileWrite $R7 '  Log "   [--] Setting up bundled FFmpeg and adding it to PATH ..."$\n'
  FileWrite $R7 '  & $pyExe "$env:TEMP\ags_ffmpeg.py" 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '  if ($LASTEXITCODE -eq 0) { Log "   [OK] FFmpeg ready in %LOCALAPPDATA%\AutoGenStudio\bin" } else { Log "   [!!] FFmpeg setup failed - install manually from https://ffmpeg.org" }$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [6/7] NODE.JS --
  ; Required to render AI-assigned Camera Effect / motion-graphics
  ; treatments (services/motion-engine is a Remotion project, invoked via
  ; npx from video_export_engine.py). Missing Node.js used to only surface
  ; as an export-time failure with no install path — same self-installing
  ; treatment as Python above, via winget's official Node.js LTS package.
  FileWrite $R7 'Log "[6/7] NODE.JS - required for AI camera-effect rendering ..."$\n'
  FileWrite $R7 '$nodeExe = $null$\n'
  FileWrite $R7 'try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch {}$\n'
  FileWrite $R7 'if (-not $nodeExe) {$\n'
  FileWrite $R7 '  $env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")$\n'
  FileWrite $R7 '  try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch {}$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'if ($nodeExe) {$\n'
  FileWrite $R7 '  Log "   [OK] Node.js found: $nodeExe"$\n'
  FileWrite $R7 '} else {$\n'
  FileWrite $R7 '  Log "   [--] Node.js not found. Installing Node.js LTS via winget (please wait) ..."$\n'
  FileWrite $R7 '  winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements --scope user --no-upgrade 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '  Start-Sleep 2$\n'
  FileWrite $R7 '  $env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")$\n'
  FileWrite $R7 '  try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch {}$\n'
  FileWrite $R7 '  if ($nodeExe) { Log "   [OK] Node.js installed: $nodeExe" } else { Log "   [!!] Node.js could not be installed automatically. Install it from https://nodejs.org (LTS) and re-run this installer - camera-effect/motion-graphics exports will fail until then." }$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [7/7] MOTION ENGINE --
  ; Pre-warms services/motion-engine's own npm install (plus its headless-
  ; Chromium download) here, with full visibility in the installer log,
  ; instead of leaving it to happen lazily (and silently) on the first
  ; export. `_ensure_motion_engine_ready`/`_ensure_remotion_browser_downloaded`
  ; in video_export_engine.py are still the runtime safety net if this step
  ; is skipped (no Node.js yet) or fails here — including the same
  ; delete-and-retry recovery for a Windows file-lock breaking `npm ci`'s own
  ; cleanup mid-install (a real user hit this: ENOTEMPTY during npm ci's
  ; delete, then ENOENT on the install that followed, from node_modules
  ; being left in a broken partial state).
  FileWrite $R7 'Log "[7/7] MOTION ENGINE - preparing the AI camera-effects render engine (may take a few minutes) ..."$\n'
  FileWrite $R7 'if ($nodeExe) {$\n'
  FileWrite $R7 '  $npmCmd = $null$\n'
  FileWrite $R7 '  try { $npmCmd = (Get-Command npm -ErrorAction Stop).Source } catch {}$\n'
  FileWrite $R7 '  if (-not $npmCmd) { $npmCmd = Join-Path (Split-Path $nodeExe) "npm.cmd" }$\n'
  FileWrite $R7 '  $motionDir = "$INSTDIR\motion-engine"$\n'
  FileWrite $R7 '  if (Test-Path $motionDir) {$\n'
  FileWrite $R7 '    Push-Location $motionDir$\n'
  FileWrite $R7 '    if (Test-Path "package-lock.json") { & $npmCmd "ci" 2>&1 | ForEach-Object { Log "        $_" } } else { & $npmCmd "install" 2>&1 | ForEach-Object { Log "        $_" } }$\n'
  FileWrite $R7 '    $npmExit = $LASTEXITCODE$\n'
  FileWrite $R7 '    if ($npmExit -ne 0 -and (Test-Path "node_modules")) {$\n'
  FileWrite $R7 '      Log "        Cleaning up an interrupted install and retrying ..."$\n'
  FileWrite $R7 '      for ($i = 0; $i -lt 5; $i++) {$\n'
  FileWrite $R7 '        try { Remove-Item -Recurse -Force "node_modules" -ErrorAction Stop; break } catch { Start-Sleep 1 }$\n'
  FileWrite $R7 '      }$\n'
  FileWrite $R7 '      & $npmCmd "install" 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '      $npmExit = $LASTEXITCODE$\n'
  FileWrite $R7 '    }$\n'
  FileWrite $R7 '    $remotionOk = $npmExit -eq 0 -and (Test-Path "node_modules\.bin\remotion.cmd")$\n'
  FileWrite $R7 '    if ($remotionOk) {$\n'
  FileWrite $R7 '      Log "   [OK] Motion engine dependencies installed"$\n'
  FileWrite $R7 '      & $nodeExe "-e" "require($\'@remotion/renderer$\').ensureBrowser().then(()=>process.exit(0)).catch((e)=>{console.error(String(e&&e.stack||e));process.exit(1)})" 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '      if ($LASTEXITCODE -eq 0) { Log "   [OK] Headless Chromium ready" } else { Log "   [!!] Headless Chromium download failed - the app will retry automatically on first export" }$\n'
  FileWrite $R7 '    } else {$\n'
  FileWrite $R7 '      Log "   [!!] Motion engine setup failed - the app will retry automatically on first export"$\n'
  FileWrite $R7 '    }$\n'
  FileWrite $R7 '    Pop-Location$\n'
  FileWrite $R7 '  } else {$\n'
  FileWrite $R7 '    Log "   [!!] Motion engine folder not found at $motionDir - camera-effect exports will fail. Reinstall the app."$\n'
  FileWrite $R7 '  }$\n'
  FileWrite $R7 '} else {$\n'
  FileWrite $R7 '  Log "   [--] Skipped (Node.js unavailable) - the app will retry automatically once Node.js is installed"$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'Log ""$\n'

  FileWrite $R7 'Log "All dependency steps complete."$\n'
  FileWrite $R7 'exit 0$\n'
  FileClose $R7

  ; ── Run PowerShell HIDDEN; stream output into this installer's details list ─
  nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -NoProfile -NonInteractive -File "$TEMP\ags_dep_setup.ps1"'
  Pop $0

  Delete "$TEMP\ags_dep_setup.ps1"
  Delete "$TEMP\ags_ffmpeg.py"

  DetailPrint " "
  DetailPrint "=========================================================="
  DetailPrint "  Dependency setup finished. Auto Gen Studio is ready."
  DetailPrint "=========================================================="
  DetailPrint " "

!macroend
