"""
FLUX.2-klein-4B Image Generation API
Standalone version with just the API endpoints.
"""

import os
import io
import base64
import time
import threading
import sys
import collections
import traceback
import gc
import asyncio

from fastapi import FastAPI, HTTPException, Form, File, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_DIR not in sys.path:
    sys.path.insert(0, REPO_DIR)

from gpu_backend import configure_pipeline_device, create_generator, get_backend_config, get_model_dtype, release_memory

app = FastAPI(title="FLUX.2-klein-4B Image API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logs_deque = collections.deque(maxlen=200)


class LogStreamer:
    def __init__(self, stream):
        self.stream = stream

    def write(self, data):
        self.stream.write(data)
        if data.strip():
            logs_deque.append(data.strip())

    def flush(self):
        self.stream.flush()

    def isatty(self):
        return self.stream.isatty()

    def fileno(self):
        return self.stream.fileno()


sys.stdout = LogStreamer(sys.stdout)
sys.stderr = LogStreamer(sys.stderr)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.environ.get("CACHE_DIR", os.path.join(BASE_DIR, "cache"))
HF_HOME = os.path.join(CACHE_DIR, "huggingface")
TORCH_HOME = os.path.join(CACHE_DIR, "torch")
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", os.path.join(BASE_DIR, "outputs"))
BACKEND_CONFIG = get_backend_config()

os.makedirs(HF_HOME, exist_ok=True)
os.makedirs(TORCH_HOME, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

os.environ.setdefault("HF_HOME", HF_HOME)
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(HF_HOME, "hub"))
os.environ.setdefault("TORCH_HOME", TORCH_HOME)

app.mount("/outputs", StaticFiles(directory=OUTPUT_DIR), name="outputs")

DEFAULT_MODEL_VARIANT = os.environ.get("MODEL_VARIANT", "gguf-q4-1")
MODEL_LOAD_ON_STARTUP = os.environ.get("MODEL_LOAD_ON_STARTUP", "1").lower() not in ("0", "false", "no")
WAIT_FOR_FLAG = os.environ.get("WAIT_FOR_FLAG", "0").lower() in ("1", "true", "yes")
FLAG_PATH = os.environ.get("FLAG_PATH", os.path.join(CACHE_DIR, "tmp", "ml_installed.flag"))

model_status = {
    "loaded": False,
    "status": "loading" if MODEL_LOAD_ON_STARTUP else "idle",
    "message": "Waiting to load model..." if MODEL_LOAD_ON_STARTUP else "Idle. Call /api/load-model to load a variant.",
    "progress": {"step": 0, "total": 0},
    "selected_variant": None,
    "variant_label": None,
    "variant_size": None,
    "backend": BACKEND_CONFIG.backend,
    "backend_label": BACKEND_CONFIG.label,
}

pipe = None
loaded_variant = None
model_lock = threading.Lock()


def make_gguf_variant(label: str, size: str, gguf_file: str) -> dict:
    return {
        "label": label,
        "size": size,
        "loader": "gguf_single_file",
        "base_repo_id": "black-forest-labs/FLUX.2-klein-4B",
        "repo_id": "unsloth/FLUX.2-klein-4B-GGUF",
        "gguf_file": gguf_file,
        "gguf_url": f"https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF/resolve/main/{gguf_file}",
        "torch_dtype": "bfloat16",
    }


MODEL_VARIANTS = {
    "bf16": {
        "label": "BF16",
        "size": "~13GB",
        "loader": "diffusers",
        "repo_id": "black-forest-labs/FLUX.2-klein-4B",
        "torch_dtype": "bfloat16",
    },
    "fp8": {
        "label": "FP8",
        "size": "~8GB",
        "loader": "torchao_fp8_static",
        "repo_id": "photoroom/FLUX.2-klein-4b-fp8-diffusers",
        "torch_dtype": "bfloat16",
    },
    "gguf-bf16": make_gguf_variant("BF16 GGUF", "~7.75GB", "flux-2-klein-4b-BF16.gguf"),
    "gguf-f16": make_gguf_variant("F16 GGUF", "~7.75GB", "flux-2-klein-4b-F16.gguf"),
    "gguf-q2-k": make_gguf_variant("Q2_K GGUF", "~1.83GB", "flux-2-klein-4b-Q2_K.gguf"),
    "gguf-q3-k-m": make_gguf_variant("Q3_K_M GGUF", "~2.12GB", "flux-2-klein-4b-Q3_K_M.gguf"),
    "gguf-q3-k-s": make_gguf_variant("Q3_K_S GGUF", "~2.10GB", "flux-2-klein-4b-Q3_K_S.gguf"),
    "gguf-q4-0": make_gguf_variant("Q4_0 GGUF", "~2.46GB", "flux-2-klein-4b-Q4_0.gguf"),
    "gguf-q4-1": make_gguf_variant("Q4_1 GGUF", "~2.69GB", "flux-2-klein-4b-Q4_1.gguf"),
    "gguf-q4-k-m": make_gguf_variant("Q4_K_M GGUF", "~2.60GB", "flux-2-klein-4b-Q4_K_M.gguf"),
    "gguf-q4-k-s": make_gguf_variant("Q4_K_S GGUF", "~2.58GB", "flux-2-klein-4b-Q4_K_S.gguf"),
    "gguf-q5-0": make_gguf_variant("Q5_0 GGUF", "~2.92GB", "flux-2-klein-4b-Q5_0.gguf"),
    "gguf-q5-1": make_gguf_variant("Q5_1 GGUF", "~3.15GB", "flux-2-klein-4b-Q5_1.gguf"),
    "gguf-q5-k-m": make_gguf_variant("Q5_K_M GGUF", "~3.07GB", "flux-2-klein-4b-Q5_K_M.gguf"),
    "gguf-q5-k-s": make_gguf_variant("Q5_K_S GGUF", "~3.05GB", "flux-2-klein-4b-Q5_K_S.gguf"),
    "gguf-q6-k": make_gguf_variant("Q6_K GGUF", "~3.41GB", "flux-2-klein-4b-Q6_K.gguf"),
    "gguf-q8-0": make_gguf_variant("Q8_0 GGUF", "~4.30GB", "flux-2-klein-4b-Q8_0.gguf"),
}

MODEL_VARIANT_ALIASES = {
    "bf16": "bf16", "full": "bf16", "full-bf16": "bf16",
    "fp8": "fp8",
    "gguf-bf16": "gguf-bf16", "bf16-gguf": "gguf-bf16",
    "gguf-f16": "gguf-f16", "f16-gguf": "gguf-f16",
    "gguf-q2-k": "gguf-q2-k", "q2k": "gguf-q2-k", "q2-k": "gguf-q2-k",
    "gguf-q3-k-m": "gguf-q3-k-m", "q3km": "gguf-q3-k-m", "q3-k-m": "gguf-q3-k-m",
    "gguf-q3": "gguf-q3-k-m", "q3": "gguf-q3-k-m",
    "gguf-q3-k-s": "gguf-q3-k-s", "q3ks": "gguf-q3-k-s", "q3-k-s": "gguf-q3-k-s",
    "gguf-q4-0": "gguf-q4-0", "q4-0": "gguf-q4-0", "q40": "gguf-q4-0",
    "gguf-q4-1": "gguf-q4-1", "q4-1": "gguf-q4-1", "q41": "gguf-q4-1",
    "gguf-q4-k-m": "gguf-q4-k-m", "gguf-q4km": "gguf-q4-k-m", "q4km": "gguf-q4-k-m",
    "q4-k-m": "gguf-q4-k-m", "gguf-q4": "gguf-q4-k-m", "q4": "gguf-q4-k-m",
    "gguf-q4-k-s": "gguf-q4-k-s", "gguf-q4ks": "gguf-q4-k-s", "q4ks": "gguf-q4-k-s",
    "q4-k-s": "gguf-q4-k-s",
    "gguf-q5-0": "gguf-q5-0", "q5-0": "gguf-q5-0", "q50": "gguf-q5-0",
    "gguf-q5-1": "gguf-q5-1", "q5-1": "gguf-q5-1", "q51": "gguf-q5-1",
    "gguf-q5-k-m": "gguf-q5-k-m", "gguf-q5km": "gguf-q5-k-m", "q5km": "gguf-q5-k-m",
    "q5-k-m": "gguf-q5-k-m", "gguf-q5": "gguf-q5-k-m", "q5": "gguf-q5-k-m",
    "gguf-q5-k-s": "gguf-q5-k-s", "gguf-q5ks": "gguf-q5-k-s", "q5ks": "gguf-q5-k-s",
    "q5-k-s": "gguf-q5-k-s",
    "gguf-q6-k": "gguf-q6-k", "q6k": "gguf-q6-k", "q6-k": "gguf-q6-k",
    "gguf-q6": "gguf-q6-k", "q6": "gguf-q6-k",
    "gguf-q8-0": "gguf-q8-0", "gguf-q8": "gguf-q8-0", "gguf-q8_0": "gguf-q8-0",
    "q8": "gguf-q8-0", "q8-0": "gguf-q8-0", "q8_0": "gguf-q8-0",
}


def normalize_model_variant(model_variant: str | None) -> str:
    normalized = (model_variant or DEFAULT_MODEL_VARIANT).strip().lower().replace(" ", "-").replace("_", "-")
    return MODEL_VARIANT_ALIASES.get(normalized, normalized)


def get_variant_config(model_variant: str | None) -> tuple[str, dict]:
    normalized = normalize_model_variant(model_variant)
    if normalized not in MODEL_VARIANTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model variant '{model_variant}'. Use bf16, fp8, or a supported gguf-* variant.",
        )
    return normalized, MODEL_VARIANTS[normalized]


def load_model_variant(model_variant: str | None = None):
    global pipe, loaded_variant, model_status

    normalized_variant, variant_config = get_variant_config(model_variant)

    with model_lock:
        if model_status["loaded"] and loaded_variant == normalized_variant and pipe is not None:
            return pipe

        model_status["loaded"] = False
        model_status["status"] = "loading"
        model_status["selected_variant"] = normalized_variant
        model_status["variant_label"] = variant_config["label"]
        model_status["variant_size"] = variant_config["size"]
        model_status["message"] = f"Loading {variant_config['label']} model assets..."
        model_status["progress"] = {"step": 0, "total": 0}

        import torch
        from huggingface_hub import hf_hub_download
        from diffusers import Flux2KleinPipeline, GGUFQuantizationConfig, Flux2Transformer2DModel

        torch_dtype = get_model_dtype(torch)
        print(f"Loading {variant_config['repo_id']} ({variant_config['label']}) on {BACKEND_CONFIG.label}...")

        if variant_config["loader"] == "diffusers":
            pipe = Flux2KleinPipeline.from_pretrained(
                variant_config["repo_id"],
                torch_dtype=torch_dtype,
                cache_dir=HF_HOME,
            )
        elif variant_config["loader"] == "torchao_fp8_static":
            raise HTTPException(
                status_code=501,
                detail=(
                    "FP8 static is not available in this Windows setup because the required TorchAO/Triton "
                    "kernel path is unavailable here. Use BF16 or GGUF for this machine."
                ),
            )
        elif variant_config["loader"] == "gguf_single_file":
            try:
                gguf_path = hf_hub_download(
                    repo_id=variant_config["repo_id"],
                    filename=variant_config["gguf_file"],
                    cache_dir=HF_HOME,
                )
                transformer = Flux2Transformer2DModel.from_single_file(
                    gguf_path,
                    quantization_config=GGUFQuantizationConfig(compute_dtype=torch_dtype),
                    config=variant_config["base_repo_id"],
                    subfolder="transformer",
                    torch_dtype=torch_dtype,
                    cache_dir=HF_HOME,
                )
                pipe = Flux2KleinPipeline.from_pretrained(
                    variant_config["base_repo_id"],
                    transformer=None,
                    torch_dtype=torch_dtype,
                    cache_dir=HF_HOME,
                )
                pipe.transformer = transformer
            except Exception as exc:
                model_status["status"] = "error"
                model_status["message"] = (
                    f"Failed to load {variant_config['label']}: {exc}. "
                    "The GGUF checkpoint or loader is not compatible with this environment."
                )
                print(f"Error loading {variant_config['label']}: {exc}")
                raise
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported loader for variant '{normalized_variant}'.")

        model_status["message"] = f"Configuring {BACKEND_CONFIG.label} runtime..."
        configure_pipeline_device(pipe, torch)

        try:
            pipe.vae.enable_slicing()
            pipe.vae.enable_tiling()
        except Exception:
            pass

        loaded_variant = normalized_variant
        model_status["loaded"] = True
        model_status["status"] = "ready"
        model_status["message"] = f"Model ready: {variant_config['label']}"
        print(f"Model loaded successfully: {variant_config['label']}")

        return pipe


def normalize_condition_image(image: Image.Image, target_size: tuple[int, int] | None = None) -> tuple[Image.Image, int, int]:
    image = ImageOps.exif_transpose(image).convert("RGB")

    width, height = image.size
    if width <= 0 or height <= 0:
        raise ValueError("Uploaded image has invalid dimensions.")

    if target_size is None:
        max_area = 1024 * 1024
        area = width * height
        if area > max_area:
            scale = (max_area / area) ** 0.5
            width = max(32, int(width * scale))
            height = max(32, int(height * scale))

        width = max(32, (width // 32) * 32)
        height = max(32, (height // 32) * 32)
    else:
        width, height = target_size

    if image.size != (width, height):
        image = image.resize((width, height), Image.Resampling.LANCZOS)

    return image, width, height


def load_models_sync():
    global model_status
    if not MODEL_LOAD_ON_STARTUP:
        return

    if WAIT_FOR_FLAG:
        while not os.path.exists(FLAG_PATH):
            model_status["message"] = "Waiting for dependency installation to complete..."
            time.sleep(3)
        try:
            os.remove(FLAG_PATH)
        except Exception:
            pass

    model_status["message"] = "Initializing machine learning environment..."
    time.sleep(1)

    try:
        load_model_variant(DEFAULT_MODEL_VARIANT)
    except Exception as e:
        model_status["status"] = "error"
        model_status["message"] = f"Failed to load {normalize_model_variant(DEFAULT_MODEL_VARIANT)}: {e}"
        print(f"Error loading model: {e}")


@app.on_event("startup")
async def startup_event():
    thread = threading.Thread(target=load_models_sync, daemon=True)
    thread.start()


def check_model_ready():
    if not model_status["loaded"]:
        if model_status["status"] == "error":
            raise HTTPException(status_code=500, detail=model_status["message"])
        raise HTTPException(status_code=503, detail="Model is still loading. Please wait.")


def ensure_variant_loaded(model_variant: str | None):
    if model_status["loaded"] and loaded_variant == normalize_model_variant(model_variant):
        return
    load_model_variant(model_variant)


# ─── Helpers ─────────────────────────────────────────────────────────────────

generation_cancelled = threading.Event()

def make_error_response(status_code: int, message: str, exc: Exception | None = None) -> JSONResponse:
    return JSONResponse({
        "status": "error",
        "message": message,
        "detail": str(exc) if exc else None,
    }, status_code=status_code)


def validate_dimensions(w: int, h: int):
    errors = []
    min_dim, max_dim = 256, 4096
    if w < min_dim or w > max_dim:
        errors.append(f"width must be {min_dim}--{max_dim}, got {w}")
    if h < min_dim or h > max_dim:
        errors.append(f"height must be {min_dim}--{max_dim}, got {h}")
    if w % 32 != 0:
        errors.append(f"width must be a multiple of 32, got {w}")
    if h % 32 != 0:
        errors.append(f"height must be a multiple of 32, got {h}")
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))


# ─── API Routes ──────────────────────────────────────────────────────────────


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "model_loaded": model_status["loaded"],
        "model_status": model_status["status"],
        "model_variant": model_status.get("selected_variant"),
        "backend": BACKEND_CONFIG.backend,
    }


@app.get("/api/models")
def list_models():
    return {
        "default": DEFAULT_MODEL_VARIANT,
        "currently_loaded": loaded_variant,
        "variants": [
            {
                "key": key,
                "label": value["label"],
                "size": value["size"],
                "loader": value["loader"],
                "repo_id": value["repo_id"],
            }
            for key, value in MODEL_VARIANTS.items()
        ],
    }


@app.get("/api/model-status")
def get_model_status():
    status = model_status.copy()
    progress = model_status.get("progress", {})
    status["is_generating"] = (
        progress.get("total", 0) > 0
        and progress.get("step", 0) < progress.get("total", 0)
    )
    status["available_variants"] = [
        {"key": key, "label": value["label"], "size": value["size"]}
        for key, value in MODEL_VARIANTS.items()
    ]
    return JSONResponse(status)


@app.post("/api/load-model")
def load_model_endpoint(model_variant: str = Form(DEFAULT_MODEL_VARIANT)):
    global model_status
    if not model_status["loaded"] or loaded_variant != normalize_model_variant(model_variant):
        thread = threading.Thread(target=load_model_variant, args=(model_variant,), daemon=True)
        thread.start()
        return {"status": "loading", "message": f"Loading variant: {model_variant}"}
    return {"status": "already_loaded", "variant": loaded_variant}


@app.post("/api/cancel")
def cancel_generation():
    generation_cancelled.set()
    return {"status": "cancelled", "message": "Generation cancellation requested."}


@app.get("/api/logs")
async def stream_logs():
    async def event_generator():
        sent_index = 0
        while True:
            current_logs = list(logs_deque)
            if len(current_logs) > sent_index:
                for i in range(sent_index, len(current_logs)):
                    yield f"data: {current_logs[i]}\n\n"
                sent_index = len(current_logs)
            await asyncio.sleep(0.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/outputs")
def list_outputs():
    files = []
    for f in sorted(os.listdir(OUTPUT_DIR), reverse=True):
        if f.endswith(".png"):
            fpath = os.path.join(OUTPUT_DIR, f)
            stat = os.stat(fpath)
            files.append({
                "filename": f,
                "url": f"/outputs/{f}",
                "size_bytes": stat.st_size,
                "created": stat.st_ctime,
            })
    return {"count": len(files), "files": files}


@app.delete("/api/outputs/{filename}")
def delete_output(filename: str):
    fpath = os.path.join(OUTPUT_DIR, filename)
    if not os.path.isfile(fpath):
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    os.remove(fpath)
    return {"status": "deleted", "filename": filename}


@app.post("/api/generate")
def generate_image(
    prompt: str = Form(...),
    num_inference_steps: int = Form(8),
    guidance_scale: float = Form(3.5),
    width: int = Form(1024),
    height: int = Form(1024),
    seed: int = Form(-1),
    num_images_per_prompt: int = Form(1),
    model_variant: str = Form(DEFAULT_MODEL_VARIANT),
):
    try:
        validate_dimensions(width, height)
        generation_cancelled.clear()
        ensure_variant_loaded(model_variant)
        check_model_ready()
        import torch
        generation_started_at = time.perf_counter()

        model_status["progress"] = {"step": 0, "total": num_inference_steps}

        def step_callback(step, timestep, latents):
            if generation_cancelled.is_set():
                raise InterruptedError("Generation cancelled by user")
            model_status["progress"]["step"] = step + 1
            print(f"Sampling Step: {step+1}/{num_inference_steps}")

        generator = create_generator(torch, seed)

        print(f"Generating {num_images_per_prompt} variation(s) for prompt: '{prompt}'")

        kwargs = {
            "prompt": prompt,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance_scale,
            "width": width,
            "height": height,
            "generator": generator,
            "num_images_per_prompt": num_images_per_prompt,
        }

        if hasattr(pipe, "_callback_tensor_inputs"):
            def wrap_callback(pipeline, step, timestep, callback_kwargs):
                step_callback(step, timestep, None)
                return callback_kwargs
            kwargs["callback_on_step_end"] = wrap_callback
        else:
            kwargs["callback"] = step_callback
            kwargs["callback_steps"] = 1

        output = pipe(**kwargs)
        generation_time_ms = int((time.perf_counter() - generation_started_at) * 1000)

        images_base64 = []
        image_urls = []

        for i, image in enumerate(output.images):
            buffered = io.BytesIO()
            image.save(buffered, format="PNG")
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            images_base64.append(f"data:image/png;base64,{img_str}")

            timestamp = int(time.time() * 1000)
            safe_prompt = "".join([c if c.isalnum() or c in " _-" else "_" for c in prompt[:50]])
            filename = f"{safe_prompt}_{timestamp}_{i}.png"
            file_path = os.path.join(OUTPUT_DIR, filename)
            image.save(file_path, "PNG")
            image_urls.append(f"/outputs/{filename}")

        gc.collect()
        release_memory(torch)

        return JSONResponse({
            "status": "success",
            "images": images_base64,
            "image": images_base64[0],
            "urls": image_urls,
            "generation_time_ms": generation_time_ms,
            "parameters": {
                "prompt": prompt,
                "num_inference_steps": num_inference_steps,
                "guidance_scale": guidance_scale,
                "width": width,
                "height": height,
                "seed": seed,
                "num_images_per_prompt": num_images_per_prompt,
            },
        })

    except Exception as e:
        error_message = traceback.format_exc()
        print(error_message)
        status_code = 500
        if isinstance(e, HTTPException):
            status_code = e.status_code
        return JSONResponse({"status": "error", "message": str(e), "traceback": error_message}, status_code=status_code)


@app.post("/api/edit")
def edit_image(
    prompt: str = Form(...),
    image: UploadFile = File(...),
    reference_image: UploadFile = File(None),
    num_inference_steps: int = Form(8),
    strength: float = Form(0.8),
    guidance_scale: float = Form(3.5),
    seed: int = Form(-1),
    num_images_per_prompt: int = Form(1),
    model_variant: str = Form(DEFAULT_MODEL_VARIANT),
):
    try:
        generation_cancelled.clear()
        ensure_variant_loaded(model_variant)
        check_model_ready()
        generation_started_at = time.perf_counter()

        contents = image.file.read()
        init_image, width, height = normalize_condition_image(Image.open(io.BytesIO(contents)))
        validate_dimensions(width, height)

        images_list = [init_image]
        if reference_image is not None and reference_image.filename:
            ref_contents = reference_image.file.read()
            ref_img, _, _ = normalize_condition_image(
                Image.open(io.BytesIO(ref_contents)),
                target_size=(width, height),
            )
            images_list.append(ref_img)

        import torch
        generator = create_generator(torch, seed)

        print(f"Editing image for prompt: '{prompt}' (Variations: {num_images_per_prompt})")

        model_status["progress"] = {"step": 0, "total": num_inference_steps}

        def step_callback(step, timestep, latents):
            if generation_cancelled.is_set():
                raise InterruptedError("Generation cancelled by user")
            model_status["progress"]["step"] = step + 1
            print(f"Sampling Step: {step+1}/{num_inference_steps}")

        kwargs = {
            "prompt": prompt,
            "image": init_image if len(images_list) == 1 else images_list,
            "width": width,
            "height": height,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance_scale,
            "generator": generator,
            "num_images_per_prompt": num_images_per_prompt,
        }

        if hasattr(pipe, "_callback_tensor_inputs"):
            def wrap_callback_edit(pipeline, step, timestep, callback_kwargs):
                step_callback(step, timestep, None)
                return callback_kwargs
            kwargs["callback_on_step_end"] = wrap_callback_edit
        else:
            kwargs["callback"] = step_callback
            kwargs["callback_steps"] = 1

        output = pipe(**kwargs)
        generation_time_ms = int((time.perf_counter() - generation_started_at) * 1000)

        images_base64 = []
        image_urls = []

        for i, res_image in enumerate(output.images):
            buffered = io.BytesIO()
            res_image.save(buffered, format="PNG")
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            images_base64.append(f"data:image/png;base64,{img_str}")

            timestamp = int(time.time() * 1000)
            safe_prompt = "".join([c if c.isalnum() or c in " _-" else "_" for c in prompt[:50]])
            filename = f"edit_{safe_prompt}_{timestamp}_{i}.png"
            file_path = os.path.join(OUTPUT_DIR, filename)
            res_image.save(file_path, "PNG")
            image_urls.append(f"/outputs/{filename}")

        gc.collect()
        release_memory(torch)

        return JSONResponse({
            "status": "success",
            "images": images_base64,
            "image": images_base64[0],
            "urls": image_urls,
            "generation_time_ms": generation_time_ms,
            "parameters": {
                "prompt": prompt,
                "num_inference_steps": num_inference_steps,
                "strength": strength,
                "guidance_scale": guidance_scale,
                "seed": seed,
                "num_images_per_prompt": num_images_per_prompt,
            },
        })

    except Exception as e:
        error_message = traceback.format_exc()
        print(error_message)
        status_code = 500
        if isinstance(e, HTTPException):
            status_code = e.status_code
        return JSONResponse({"status": "error", "message": str(e), "traceback": error_message}, status_code=status_code)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
