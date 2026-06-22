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

  ; ── Core Python packages ──────────────────────────────────────────────────
  ; FFmpeg is bundled via imageio-ffmpeg (installed on first use with whisper).
  ; openai-whisper + imageio-ffmpeg (~1 GB) are installed on first use so the
  ; installer stays fast.
  DetailPrint "Installing Python packages (openai, pydantic, xlsxwriter)..."
  nsExec::ExecToLog '"python" "-m" "pip" "install" "--quiet" "--upgrade" "openai>=1.68" "pydantic>=2.10" "python-dotenv>=1.0" "xlsxwriter>=3.2"'
  Pop $R0

  DetailPrint "Auto Gen Studio dependency setup complete."
!macroend
