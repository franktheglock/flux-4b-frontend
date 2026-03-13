FLUX.2-klein-4B — Local Web UI

This repository provides a small FastAPI + frontend web UI for running the
`black-forest-labs/FLUX.2-klein-4B` pipeline locally (text-to-image and image-to-image).

Highlights
- Simple single-repo web UI (FastAPI backend + static frontend in `public/`).
- `start.bat` bootstraps a virtual environment and installs dependencies, then
  begins the large model downloads.

Prerequisites
- Windows (this repo includes `start.bat` designed for Windows).
- Python 3.10, 3.11, or 3.12.
- Recommended: NVIDIA GPU with CUDA (the `start.bat` attempts to install CUDA 12.1 PyTorch wheels).
- ~15GB disk available for model weights and caches.

Quick start (Windows)
1. Open a Command Prompt in the repository root.
2. Run `start.bat` and follow the output. This will:
   - create a venv (if needed),
   - install minimal web dependencies,
   - start the FastAPI server,
   - then install PyTorch + large ML dependencies and trigger model download.

3. Open http://localhost:8000 in your browser and use the UI at `/interface/index.html`.

Manual setup (if you prefer):
```powershell
python -m venv venv
venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
cd backend
venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Important notes
- The first run downloads many GB of packages and model weights — be patient.
- Image edit mode is more memory-sensitive (the pipeline encodes uploaded images
  through the VAE). Use a GPU where possible; the UI will reflect model-loading status.
- If you encounter dtype-related errors during image edits, fully stop and restart
  the backend process after any code changes (the pipeline is kept in-memory).

Contributing
- This repo is a small local tooling example. Open a PR with bugfixes or quality improvements.

License
- This repository is provided under the MIT License (see LICENSE).
