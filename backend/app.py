import os
import io
import base64
import time
import threading
from fastapi import FastAPI, HTTPException, Form, File, UploadFile, BackgroundTasks
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

app = FastAPI()

# Mount frontend
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "public")
os.makedirs(PUBLIC_DIR, exist_ok=True)
app.mount("/interface", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")

@app.get("/")
def read_root():
    return RedirectResponse(url="/interface/index.html")

# Model Loading Status Tracking
model_status = {
    "loaded": False,
    "status": "loading", # start in loading state for UI
    "message": "Waiting for dependency installation to complete...",
    "progress": {"step": 0, "total": 0}
}

pipe = None
model_id = "black-forest-labs/FLUX.2-klein-4B"
flag_path = os.path.join(os.path.dirname(PUBLIC_DIR), "cache", "tmp", "ml_installed.flag")


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
    global pipe, model_status
    
    # 1. Wait for batch script to finish pip installs
    while not os.path.exists(flag_path):
        model_status["message"] = "Downloading PyTorch and ML libraries (~10GB). Check the command prompt window."
        time.sleep(3)
        
    # Clean up the flag
    try:
        os.remove(flag_path)
    except:
        pass
        
    model_status["message"] = "Libraries installed! Initializing machine learning environment..."
    time.sleep(1) # Give system a second to unlock files

    try:
        # 2. Dynamic Imports (Only imported AFTER they are installed)
        model_status["message"] = "Importing Core ML modules..."
        import torch
        from diffusers import Flux2KleinPipeline
        
        # 3. Load the Model Core
        model_status["message"] = "Downloading/Loading FLUX.2 Weights... (This may take a moment)"
        print(f"Loading {model_id}...")
        
        pipe = Flux2KleinPipeline.from_pretrained(
            model_id,
            torch_dtype=torch.bfloat16
        )
        
        model_status["message"] = "Configuring memory optimizations..."
        # Enable sequential CPU offload for maximum RAM/VRAM savings
        # Note: Do not call .to("cuda") when using offload methods
        pipe.enable_sequential_cpu_offload()
        
        # Optional: enable slicing if VRAM is still an issue
        try:
            pipe.vae.enable_slicing()
            pipe.vae.enable_tiling()
        except Exception:
            pass
        
        model_status["loaded"] = True
        model_status["status"] = "ready"
        model_status["message"] = "Model ready"
        print("Models loaded successfully.")
    except Exception as e:
        status_msg = str(e)
        model_status["status"] = "error"
        model_status["message"] = f"Failed to load: {status_msg}. Please ensure you have the latest 'diffusers' and enough VRAM (~13GB)."
        print(f"Error loading model: {e}")

@app.on_event("startup")
async def startup_event():
    # Start loading in background thread on startup
    thread = threading.Thread(target=load_models_sync)
    thread.start()

@app.get("/api/model-status")
def get_model_status():
    # Include generating status for the frontend polling
    status = model_status.copy()
    status["is_generating"] = model_status.get("progress", {}).get("total", 0) > 0 and \
                              model_status["progress"].get("step", 0) < model_status["progress"].get("total", 0)
    return JSONResponse(status)

def check_model_ready():
    if not model_status["loaded"]:
        if model_status["status"] == "error":
            raise HTTPException(status_code=500, detail=model_status["message"])
        raise HTTPException(status_code=503, detail="Model is still loading. Please wait.")

@app.post("/api/generate")
def generate_image(
    prompt: str = Form(...),
    num_inference_steps: int = Form(8),
    guidance_scale: float = Form(3.5),
    width: int = Form(1024),
    height: int = Form(1024),
    seed: int = Form(-1),
    num_images_per_prompt: int = Form(1)
):
    try:
        check_model_ready()
        import torch
        
        model_status["progress"] = {"step": 0, "total": num_inference_steps}

        def step_callback(step, timestep, latents):
            model_status["progress"]["step"] = step + 1
            print(f"Sampling Step: {step+1}/{num_inference_steps}")

        generator = torch.Generator(device="cuda")
        if seed != -1:
            generator.manual_seed(seed)
        else:
            generator.seed()

        print(f"Generating {num_images_per_prompt} variation(s) for prompt: '{prompt}'")
        # Ensure callback is passed as the correct key for this diffusers version
        # Some versions use 'callback_on_step_end' while others use 'callback'
        kwargs = {
            "prompt": prompt,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance_scale,
            "width": width,
            "height": height,
            "generator": generator,
            "num_images_per_prompt": num_images_per_prompt
        }
        
        # Try different callback formats based on common diffusers pipeline signatures
        if hasattr(pipe, "_callback_tensor_inputs"):
            # Newer callback system (callback_on_step_end) expects (pipe, step, timestep, callback_kwargs)
            def wrap_callback(pipeline, step, timestep, callback_kwargs):
                step_callback(step, timestep, None)
                return callback_kwargs
            kwargs["callback_on_step_end"] = wrap_callback
        else:
            kwargs["callback"] = step_callback
            kwargs["callback_steps"] = 1

        output = pipe(**kwargs)
        
        images_base64 = []
        for image in output.images:
            buffered = io.BytesIO()
            image.save(buffered, format="PNG")
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            images_base64.append(f"data:image/png;base64,{img_str}")
        
        # Free up RAM/VRAM
        import gc
        gc.collect()
        torch.cuda.empty_cache()
        
        return JSONResponse({
            "status": "success", 
            "images": images_base64,
            "image": images_base64[0] # Back-compat
        })

    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

@app.post("/api/edit")
def edit_image(
    prompt: str = Form(...),
    image: UploadFile = File(...),
    reference_image: UploadFile = File(None),
    num_inference_steps: int = Form(28),
    strength: float = Form(0.8),
    guidance_scale: float = Form(3.5),
    seed: int = Form(-1),
    num_images_per_prompt: int = Form(1)
):
    try:
        check_model_ready()
        
        # Read the primary uploaded image
        contents = image.file.read()
        init_image, width, height = normalize_condition_image(Image.open(io.BytesIO(contents)))
        
        # Read the reference image if provided
        images_list = [init_image]
        if reference_image is not None and reference_image.filename:
            ref_contents = reference_image.file.read()
            ref_img, _, _ = normalize_condition_image(
                Image.open(io.BytesIO(ref_contents)),
                target_size=(width, height)
            )
            images_list.append(ref_img)
        
        import torch
        generator = torch.Generator(device="cuda")
        if seed != -1:
            generator.manual_seed(seed)
        else:
            generator.seed()
            
        print(f"Editing image for prompt: '{prompt}' (Variations: {num_images_per_prompt})")
        
        model_status["progress"] = {"step": 0, "total": num_inference_steps}
        def step_callback(step, timestep, latents):
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
            "num_images_per_prompt": num_images_per_prompt
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
        
        images_base64 = []
        for res_image in output.images:
            buffered = io.BytesIO()
            res_image.save(buffered, format="PNG")
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            images_base64.append(f"data:image/png;base64,{img_str}")
        
        # Free up RAM/VRAM
        import gc
        gc.collect()
        torch.cuda.empty_cache()
        
        return JSONResponse({
            "status": "success", 
            "images": images_base64,
            "image": images_base64[0]
        })

    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)
