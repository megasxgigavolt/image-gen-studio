@echo off
setlocal

:: Use the system Python 3.10 installation
set PYTHON=C:\Users\Ahmed\AppData\Local\Programs\Python\Python310\python.exe

echo ============================================================
echo  Image Gen Studio — Build Script
echo ============================================================

echo.
echo [1/3] Installing / updating dependencies...
"%PYTHON%" -m pip install -r requirements.txt pyinstaller --quiet

echo.
echo [2/3] Building .exe with PyInstaller...
"%PYTHON%" -m PyInstaller ^
  --onefile ^
  --windowed ^
  --name "ImageGenStudio" ^
  --collect-data customtkinter ^
  --hidden-import "PIL._tkinter_finder" ^
  --hidden-import "google.auth.transport.requests" ^
  --hidden-import "google.oauth2.service_account" ^
  image_gen_studio.py

echo.
echo [3/3] Copying required runtime files next to the .exe...
if not exist dist mkdir dist
copy /Y "beneath-the-fins-843aa8608070.json" "dist\" >nul 2>&1
copy /Y "other automations\.env"              "dist\.env" >nul 2>&1

echo.
echo ============================================================
echo  Build complete!  Output: dist\ImageGenStudio.exe
echo.
echo  The dist\ folder must contain:
echo    - ImageGenStudio.exe
echo    - beneath-the-fins-843aa8608070.json
echo    - .env  (with OPENAI_API_KEY=...)
echo ============================================================
pause
