@echo off
setlocal enabledelayedexpansion
echo ---------------------------------------------------------
echo Setting up FLUX.2-klein-4B Web Environment
echo ---------------------------------------------------------

:: Model variant selection: Set MODEL_VARIANT before running this script
:: Options: bf16, fp8, gguf-* variants.
:: Example: set MODEL_VARIANT=gguf-q8
if "%MODEL_VARIANT%"=="" (
    echo [INFO] Model variant: auto (last saved in .env, or bf16 if unset)
) else (
    echo [INFO] Model variant override: %MODEL_VARIANT%
)

:: Fast mode selection: set FAST_MODE=1 to skip reinstalling packages in an existing venv
if "%FAST_MODE%"=="" set FAST_MODE=1
echo [INFO] Fast mode: %FAST_MODE%

:: Set Cache Directories to current folder
set HF_HOME=%~dp0cache\huggingface
set TORCH_HOME=%~dp0cache\torch
set PIP_CACHE_DIR=%~dp0cache\pip
set TMPDIR=%~dp0cache\tmp
set TMP=%~dp0cache\tmp
set TEMP=%~dp0cache\tmp

:: Ensure tmp directory exists
if not exist "%~dp0cache\tmp" mkdir "%~dp0cache\tmp"

:: Find a compatible Python version (3.10, 3.11, or 3.12)
set PYTHON_CMD=
py -3.12 --version >nul 2>&1
if %errorlevel% equ 0 set PYTHON_CMD=py -3.12
if "%PYTHON_CMD%"=="" (
    py -3.11 --version >nul 2>&1
    if %errorlevel% equ 0 set PYTHON_CMD=py -3.11
)
if "%PYTHON_CMD%"=="" (
    py -3.10 --version >nul 2>&1
    if %errorlevel% equ 0 set PYTHON_CMD=py -3.10
)
if "%PYTHON_CMD%"=="" (
    python --version >nul 2>&1
    if %errorlevel% equ 0 (
        for /f "tokens=2 delims= " %%I in ('python --version 2^>^&1') do set PVER=%%I
        echo !PVER! | findstr /b /c:"3.10" /c:"3.11" /c:"3.12" >nul
        if %errorlevel% equ 0 set PYTHON_CMD=python
    )
)

if "%PYTHON_CMD%"=="" (
    echo [ERROR] Could not find Python 3.10, 3.11, or 3.12.
    echo Please ensure one of these versions is installed. PyTorch does not support 3.13 yet.
    pause
    exit /b
)

echo [INFO] Using Python command: %PYTHON_CMD%

:: Create Virtual Environment if it doesn't exist
if not exist "venv\Scripts\activate.bat" (
    echo [INFO] Creating Python virtual environment...
    %PYTHON_CMD% -m venv venv
)

:: Activate Virtual Environment
call venv\Scripts\activate.bat
set VENV_PYTHON=%~dp0venv\Scripts\python.exe

:: Detect the preferred ML backend unless the caller already chose one
if not defined ML_BACKEND (
    set GPU_NAMES=
    for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$names = Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }; if ($names) { $names -join '; ' }"`) do set GPU_NAMES=%%a
    if not defined GPU_NAMES set GPU_NAMES=No dedicated GPU detected

    set ML_BACKEND=cpu
    set GPU_BACKEND_LABEL=CPU
    echo !GPU_NAMES! | find /I "NVIDIA" >nul
    if !errorlevel! equ 0 (
        set ML_BACKEND=cuda
        set GPU_BACKEND_LABEL=NVIDIA CUDA
    ) else (
        echo !GPU_NAMES! | findstr /I "AMD Radeon Intel Arc Iris Xe UHD" >nul
        if !errorlevel! equ 0 (
            set ML_BACKEND=directml
            set GPU_BACKEND_LABEL=DirectML
        )
    )
) else (
    if /I "!ML_BACKEND!"=="cuda" set GPU_BACKEND_LABEL=NVIDIA CUDA
    if /I "!ML_BACKEND!"=="directml" set GPU_BACKEND_LABEL=DirectML
    if /I "!ML_BACKEND!"=="cpu" set GPU_BACKEND_LABEL=CPU
    if not defined GPU_BACKEND_LABEL set GPU_BACKEND_LABEL=!ML_BACKEND!
    if not defined GPU_NAMES set GPU_NAMES=Manual override
)

echo [INFO] GPU detection: !GPU_NAMES!
echo [INFO] ML backend: !ML_BACKEND! (!GPU_BACKEND_LABEL!)

:: Diagnostics
echo [INFO] Python version:
"!VENV_PYTHON!" --version

:: Start Web Server in Background
echo [INFO] Starting FastAPI Web Server...
start "FLUX Web UI" /b cmd /c "cd backend && ..\venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000"

:: Wait a moment for server to spin up
timeout /t 3 >nul

:: Detect LAN IP for remote access info
set LAN_IP=
for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress"') do set LAN_IP=%%a

echo [INFO] The web interface is now running!
echo [INFO]   Local:  http://localhost:8000
if defined LAN_IP (
    echo [INFO]   LAN:    http://%LAN_IP%:8000
) else (
    echo [INFO]   LAN:    Run 'ipconfig' to find your local address, then use port 8000
)
echo [INFO] ---------------------------------------------------------
if "%FAST_MODE%"=="1" goto :FAST_MODE
goto :FULL_SETUP

:FAST_MODE
echo [INFO] Fast mode enabled. Reusing the existing venv without reinstalling packages.
if not exist "cache\tmp\ml_installed.flag" echo done > "cache\tmp\ml_installed.flag"
echo [INFO] The web UI will now load the model using the existing environment.
echo [INFO] You can now open http://localhost:8000
pause
goto :EOF

:FULL_SETUP
echo [INFO] Now beginning massive AI Model downloads (~10-15GB)...
echo [INFO] Do not close this window until complete!

:: Upgrade pip
echo [INFO] Upgrading pip...
"!VENV_PYTHON!" -m pip install --upgrade pip >nul 2>&1

:: Install Minimal Web Dependencies First
echo [INFO] Installing Web Server...
"!VENV_PYTHON!" -m pip install fastapi uvicorn python-multipart >nul

:: Install the ML runtime that matches the detected GPU backend
echo [INFO] Ensuring ML runtime for !GPU_BACKEND_LABEL! is installed...
"!VENV_PYTHON!" -m pip uninstall -y torch torchvision torchaudio torch-directml >nul 2>&1
if /I "!ML_BACKEND!"=="cuda" (
    "!VENV_PYTHON!" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 --cache-dir "%PIP_CACHE_DIR%"
) else (
    if /I "!ML_BACKEND!"=="directml" (
        "!VENV_PYTHON!" -m pip install torch-directml --cache-dir "%PIP_CACHE_DIR%"
    ) else (
        "!VENV_PYTHON!" -m pip install torch torchvision torchaudio --cache-dir "%PIP_CACHE_DIR%"
    )
)

:: Install Remaining Dependencies
echo [INFO] Installing ML libraries (Diffusers, Transformers)...
"!VENV_PYTHON!" -m pip install -r requirements.txt

:: Alert server that dependencies are installed and it can load the model
if exist "cache\tmp\ml_installed.flag" del "cache\tmp\ml_installed.flag"
echo done > "cache\tmp\ml_installed.flag"

echo [SUCCESS] All downloads complete! The web UI will now begin loading the model into your GPU.
:: The pause was BEFORE the server could see the flag, which caused the hang.
:: Moving it after.
timeout /t 5 >nul
echo [INFO] You can now open http://localhost:8000
pause
