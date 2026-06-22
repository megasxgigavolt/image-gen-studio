; Auto Gen Studio – NSIS custom install hooks
; Runs after the main files are copied.
; Installs Python, FFmpeg, and the core pip packages silently.
; openai-whisper is downloaded on first use (it pulls ~1 GB of PyTorch).

!macro customInstall
  SetDetailsPrint both

  ; ── Python ────────────────────────────────────────────────────────────────
  DetailPrint "Checking for Python 3..."
  nsExec::ExecToLog '"python" "--version"'
  Pop $R0
  ${If} $R0 != 0
    DetailPrint "Python not found — installing via winget (this may take a minute)..."
    nsExec::ExecToLog 'winget install --id Python.Python.3 --silent --accept-package-agreements --accept-source-agreements --no-upgrade'
    Pop $R0
    ; Reload PATH in this process so pip is reachable without a reboot.
    ReadRegStr $R1 HKCU "Environment" "PATH"
    ReadRegStr $R2 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "PATH"
    ${If} $R1 != ""
      System::Call 'kernel32::SetEnvironmentVariable(t "PATH", t "$R2;$R1")'
    ${Else}
      System::Call 'kernel32::SetEnvironmentVariable(t "PATH", t "$R2")'
    ${EndIf}
  ${EndIf}

  ; ── FFmpeg ────────────────────────────────────────────────────────────────
  DetailPrint "Checking for FFmpeg..."
  nsExec::ExecToLog '"ffmpeg" "-version"'
  Pop $R0
  ${If} $R0 != 0
    DetailPrint "FFmpeg not found — installing via winget..."
    nsExec::ExecToLog 'winget install --id Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements --no-upgrade'
    Pop $R0
    ; Reload PATH again so ffmpeg is visible to the running installer process.
    ReadRegStr $R1 HKCU "Environment" "PATH"
    ReadRegStr $R2 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "PATH"
    ${If} $R1 != ""
      System::Call 'kernel32::SetEnvironmentVariable(t "PATH", t "$R2;$R1")'
    ${Else}
      System::Call 'kernel32::SetEnvironmentVariable(t "PATH", t "$R2")'
    ${EndIf}
  ${EndIf}

  ; ── Core Python packages (fast: no PyTorch / Whisper) ──────────────────────
  ; openai-whisper (~1 GB download) is installed on first use inside the app.
  DetailPrint "Installing Python packages (openai, pydantic, xlsxwriter)..."
  nsExec::ExecToLog '"python" "-m" "pip" "install" "--quiet" "--upgrade" "openai>=1.68" "pydantic>=2.10" "python-dotenv>=1.0" "xlsxwriter>=3.2"'
  Pop $R0

  DetailPrint "Auto Gen Studio dependency setup complete."
!macroend
