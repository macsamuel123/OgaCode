@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ==========================================
echo    OgaCode Installer for Windows
echo  ==========================================
echo.

:: ── Check Python ──────────────────────────────────────────────────────────────
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Python not found.
    echo.
    echo  Install Python 3.10 or newer from https://python.org/downloads
    echo  IMPORTANT: Check "Add Python to PATH" during install.
    echo.
    pause
    exit /b 1
)

python -c "import sys; exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Python 3.10 or newer is required.
    echo.
    python --version
    echo.
    echo  Download the latest Python from https://python.org/downloads
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('python --version') do echo   OK  %%v found
echo.

:: ── Install OgaCode ───────────────────────────────────────────────────────────
echo   Installing OgaCode CLI...
echo.
pip install cli\ --quiet
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Installation failed.
    echo  Try right-clicking install.bat and "Run as administrator".
    echo.
    pause
    exit /b 1
)

:: ── Verify command is reachable ───────────────────────────────────────────────
ogacode --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  WARNING: ogacode installed but not yet in PATH.
    echo.
    echo  Fix: close this window, open a NEW Command Prompt, and try:
    echo    ogacode setup
    echo.
    echo  If still not found, add Python Scripts to PATH manually:
    echo    Search "Environment Variables" in Start Menu, edit PATH,
    echo    and add:  %APPDATA%\Python\Scripts
    echo.
    pause
    exit /b 0
)

:: ── Done ─────────────────────────────────────────────────────────────────────
echo.
echo  ==========================================
echo    OgaCode installed successfully!
echo  ==========================================
echo.
echo  Next step: open a NEW Command Prompt window and run:
echo.
echo    ogacode setup
echo.
echo  You will be asked for your OgaCode access token.
echo  Just press Enter to accept the server URL default.
echo.
pause
