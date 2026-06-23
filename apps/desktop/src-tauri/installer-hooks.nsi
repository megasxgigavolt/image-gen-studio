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
  DetailPrint "  This may take 5-15 minutes on a fresh machine."
  DetailPrint "  Please wait. Do not close this window."
  DetailPrint "=========================================================="
  DetailPrint " "

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

  ; -- [1/5] PYTHON --
  FileWrite $R7 'Log "[1/5] PYTHON - locating Python 3.10 or later ..."$\n'
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

  ; -- [2/5] PACKAGES --
  FileWrite $R7 'Log "[2/5] PACKAGES - core libraries ..."$\n'
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

  ; -- [3/5] WHISPER --
  FileWrite $R7 'Log "[3/5] WHISPER - speech-to-text engine (~1 GB, optional) ..."$\n'
  FileWrite $R7 '& $pyExe "-c" "import whisper" 2>$null$\n'
  FileWrite $R7 'if ($LASTEXITCODE -eq 0) {$\n'
  FileWrite $R7 '  Log "   [OK] openai-whisper already installed"$\n'
  FileWrite $R7 '} else {$\n'
  FileWrite $R7 '  Log "   [--] Installing openai-whisper + PyTorch (may take 5-15 min) ..."$\n'
  FileWrite $R7 '  & $pyExe "-m" "pip" "install" "openai-whisper>=20240930" 2>&1 | ForEach-Object { Log "        $_" }$\n'
  FileWrite $R7 '  if ($LASTEXITCODE -eq 0) { Log "   [OK] openai-whisper installed" } else { Log "   [!!] whisper failed - Visual Plan will install it on first use" }$\n'
  FileWrite $R7 '}$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [4/5] MODEL --
  FileWrite $R7 'Log "[4/5] MODEL - caching Whisper base model (~140 MB) ..."$\n'
  FileWrite $R7 '& $pyExe "-c" "import whisper; whisper.load_model($\'base$\')" 2>$null$\n'
  FileWrite $R7 'if ($LASTEXITCODE -eq 0) { Log "   [OK] Whisper base model cached" } else { Log "   [--] Model will download on first Visual Plan use" }$\n'
  FileWrite $R7 'Log ""$\n'

  ; -- [5/5] FFMPEG --
  FileWrite $R7 'Log "[5/5] FFMPEG - audio processing ..."$\n'
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
