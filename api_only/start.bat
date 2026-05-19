@echo off
setlocal enabledelayedexpansion
echo ---------------------------------------------------------
echo FLUX.2-klein-4B Image API Setup
echo ---------------------------------------------------------

:: Model variant selection
:: Options: bf16, fp8, gguf-q8-0, gguf-q4-k-m, etc.
:: See /api/models for the full list
if "%MODEL_VARIANT%"=="" set MODEL_VARIANT=gguf-q4-1
echo [INFO] Model variant: %MODEL_VARIANT%

:: Skip reinstalling packages if venv already set up
if "%FAST_MODE%"=="" set FAST_MODE=1
echo [INFO] Fast mode: %FAST_MODE%

:: Cache drive — set CACHE_DRIVE to a different drive letter (e.g. D:) to avoid using C:
if "%CACHE_DRIVE%"=="" set CACHE_DRIVE=R:
echo [INFO] Cache drive: %CACHE_DRIVE%

:: Cache directories (on CACHE_DRIVE)
set CACHE_DIR=%CACHE_DRIVE%\flux-api-cache
set HF_HOME=%CACHE_DIR%\huggingface
set TORCH_HOME=%CACHE_DIR%\torch
set PIP_CACHE_DIR=%CACHE_DIR%\pip
set TEMP=%CACHE_DIR%\tmp
set TMP=%CACHE_DIR%\tmp
set TMPDIR=%CACHE_DIR%\tmp

:: Create cache directories
mkdir "%CACHE_DIR%\huggingface" >nul 2>&1
mkdir "%CACHE_DIR%\torch" >nul 2>&1
mkdir "%CACHE_DIR%\pip" >nul 2>&1
mkdir "%CACHE_DIR%\tmp" >nul 2>&1

:: Output directory
set OUTPUT_DIR=%~dp0outputs
mkdir "%~dp0outputs" >nul 2>&1

:: Find compatible Python (3.10, 3.11, or 3.12)
set PYTHON_CMD=
py -3.12 --version >nul 2>&1
if !errorlevel! equ 0 set PYTHON_CMD=py -3.12
if "!PYTHON_CMD!"=="" (
    py -3.11 --version >nul 2>&1
    if !errorlevel! equ 0 set PYTHON_CMD=py -3.11
)
if "!PYTHON_CMD!"=="" (
    py -3.10 --version >nul 2>&1
    if !errorlevel! equ 0 set PYTHON_CMD=py -3.10
)
if "!PYTHON_CMD!"=="" (
    python --version >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=2 delims= " %%I in ('python --version 2^>^&1') do set PVER=%%I
        echo !PVER! | findstr /b /c:"3.10" /c:"3.11" /c:"3.12" >nul
        if !errorlevel! equ 0 set PYTHON_CMD=python
    )
)

if "!PYTHON_CMD!"=="" (
    echo [ERROR] Could not find Python 3.10, 3.11, or 3.12.
    echo PyTorch does not support Python 3.13 yet.
    pause
    exit /b
)

echo [INFO] Using Python command: !PYTHON_CMD!

:: Create venv if missing
set VENV_PYTHON=%~dp0venv\Scripts\python.exe
if not exist "!VENV_PYTHON!" (
    echo [INFO] Creating Python virtual environment...
    !PYTHON_CMD! -m venv "%~dp0venv"
)

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

echo [INFO] Python version:
"!VENV_PYTHON!" --version

if "!FAST_MODE!"=="1" goto :FAST_MODE

:: -- Full setup: install everything into venv --

echo [INFO] Downloading AI model dependencies (~10-15GB)...
echo [INFO] Do not close this window until complete.

echo [INFO] Upgrading pip...
"!VENV_PYTHON!" -m pip install --upgrade pip -q

echo [INFO] Installing web server...
"!VENV_PYTHON!" -m pip install fastapi uvicorn python-multipart -q

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

echo [INFO] Installing ML libraries (Diffusers, Transformers, etc.)...
"!VENV_PYTHON!" -m pip install -r requirements.txt --cache-dir "%PIP_CACHE_DIR%"

goto :START_SERVER

:FAST_MODE
echo [INFO] Fast mode - skipping package installs.
goto :START_SERVER

:START_SERVER
echo [INFO] Starting FLUX Image API on port 8000...
set PORT=8000
set MODEL_VARIANT=%MODEL_VARIANT%

:: Detect LAN IP
set LAN_IP=
for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress"') do set LAN_IP=%%a

echo [INFO] API server running.
echo [INFO]   Local:  http://localhost:8000
if defined LAN_IP (
    echo [INFO]   LAN:    http://!LAN_IP!:8000
) else (
    echo [INFO]   LAN:    Run 'ipconfig' to find your address, then use port 8000
)
echo [INFO]   Docs:   http://localhost:8000/docs
echo [INFO] ---------------------------------------------------------
echo [INFO] The model will auto-load on startup.
echo [INFO] Check http://localhost:8000/api/model-status for progress.
echo [INFO] Press Ctrl+C to stop the server.
echo.

venv\Scripts\python.exe app.py
