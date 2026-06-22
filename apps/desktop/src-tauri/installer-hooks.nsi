; Auto Gen Studio – NSIS custom install hooks
; Runs after the main files are copied.
; Installs Python, all pip packages (including Whisper AI + FFmpeg), silently.

!macro customInstall
  SetDetailsPrint both

  ; ── Python ────────────────────────────────────────────────────────────────
  DetailPrint "Checking for Python 3..."
  nsExec::ExecToLog '"python" "--version"'
  Pop $R0
  ${If} $R0 != 0
    DetailPrint "Python not found — installing via winget..."
    nsExec::ExecToLog 'winget install --id Python.Python.3 --silent --accept-package-agreements --accept-source-agreements --no-upgrade'
    Pop $R0
    ; Reload PATH so pip is reachable in this installer process.
    ReadRegStr $R1 HKCU "Environment" "PATH"
    ReadRegStr $R2 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "PATH"
    ${If} $R1 != ""
      System::Call 'kernel32::SetEnvironmentVariable(t "PATH", t "$R2;$R1")'
    ${Else}
      System::Call 'kernel32::SetEnvironmentVariable(t "PATH", t "$R2")'
    ${EndIf}
  ${EndIf}

  ; ── All Python packages ───────────────────────────────────────────────────
  ; openai-whisper pulls PyTorch (~1 GB). imageio-ffmpeg bundles its own
  ; ffmpeg binary so no separate FFmpeg install is needed.
  ; This step can take several minutes on a fresh machine.
  DetailPrint "Installing Python packages (Whisper AI + FFmpeg included)..."
  DetailPrint "This may take several minutes on first install — please wait..."
  nsExec::ExecToLog '"python" "-m" "pip" "install" "--upgrade" "openai>=1.68" "pydantic>=2.10" "python-dotenv>=1.0" "xlsxwriter>=3.2" "openai-whisper>=20240930" "imageio-ffmpeg"'
  Pop $R0

  DetailPrint "Auto Gen Studio setup complete."
!macroend
