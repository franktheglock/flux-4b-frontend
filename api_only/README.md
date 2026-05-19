# FLUX.2-klein-4B Image Generation API

Standalone REST API for the [FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) text-to-image model. Supports text-to-image generation, image-to-image editing, and 16 model variants (BF16, FP8, GGUF quantized).

## Quickstart

```bash
pip install -r requirements.txt
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
python app.py
```

On Windows, `start.bat` is the recommended entrypoint because it auto-detects the GPU vendor and chooses the matching runtime:
- NVIDIA -> CUDA wheels
- AMD/Intel -> `torch-directml`
- No supported GPU -> CPU wheels

Server starts at `http://0.0.0.0:8000`. OpenAPI docs at `/docs`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | Server port |
| `CACHE_DIR` | `./cache` | HuggingFace/Torch cache directory |
| `OUTPUT_DIR` | `./outputs` | Generated image output directory |
| `MODEL_VARIANT` | `bf16` | Default model variant to load on startup |
| `MODEL_LOAD_ON_STARTUP` | `1` | Auto-load model on startup (`0` to disable) |
| `WAIT_FOR_FLAG` | `0` | Wait for `cache/tmp/ml_installed.flag` before loading |
| `ML_BACKEND` | `auto` | Override backend detection with `cuda`, `directml`, or `cpu` |

---

## API Reference

All endpoints are prefixed with `/api`.

### Status & Info

#### `GET /api/health`

Health check. Returns model readiness.

```json
{"status": "ok", "model_loaded": true, "model_status": "ready", "model_variant": "bf16", "backend": "cuda"}
```

#### `GET /api/model-status`

Full model status including generation progress, available variants, and loading state.

```json
{
  "loaded": true,
  "status": "ready",
  "message": "Model ready: BF16",
  "selected_variant": "bf16",
  "variant_label": "BF16",
  "variant_size": "~13GB",
  "is_generating": false,
  "progress": {"step": 0, "total": 0},
  "available_variants": [
    {"key": "bf16", "label": "BF16", "size": "~13GB"},
    {"key": "fp8", "label": "FP8", "size": "~8GB"},
    {"key": "gguf-q4-k-m", "label": "Q4_K_M GGUF", "size": "~2.60GB"}
  ]
}
```

#### `GET /api/models`

List all available model variants with metadata.

```json
{
  "default": "bf16",
  "currently_loaded": "bf16",
  "variants": [
    {
      "key": "bf16",
      "label": "BF16",
      "size": "~13GB",
      "loader": "diffusers",
      "repo_id": "black-forest-labs/FLUX.2-klein-4B"
    }
  ]
}
```

#### `GET /api/logs`

Server-Sent Events stream of server logs. Connect with `EventSource`.

```js
const evt = new EventSource("/api/logs");
evt.onmessage = (e) => console.log(e.data);
```

---

### Model Management

#### `POST /api/load-model`

Load a model variant (runs in background). Poll `/api/model-status` to track.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model_variant` | string | `bf16` | Variant key (e.g. `bf16`, `gguf-q4-k-m`) |

```bash
curl -X POST http://localhost:8000/api/load-model -F "model_variant=gguf-q4-k-m"
```

Response: `{"status": "loading", "message": "Loading variant: gguf-q4-k-m"}`

---

### Image Generation

#### `POST /api/generate`

Text-to-image generation. Returns base64-encoded images + disk URLs.

**Parameters** (all sent as `multipart/form-data`)

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `prompt` | string | *required* | | Text description of the desired image |
| `num_inference_steps` | int | `8` | 1--100 | Denoising steps (more = higher quality, slower) |
| `guidance_scale` | float | `3.5` | 1.0--20.0 | How closely to follow the prompt |
| `width` | int | `1024` | 256--4096 (multiple of 32) | Output width |
| `height` | int | `1024` | 256--4096 (multiple of 32) | Output height |
| `seed` | int | `-1` | | Random seed. `-1` for random |
| `num_images_per_prompt` | int | `1` | 1--4 | Number of variations to generate |
| `model_variant` | string | `bf16` | See `/api/models` | Model variant to use |

**Example**

```bash
curl -X POST http://localhost:8000/api/generate \
  -F "prompt=A cat wearing a wizard hat in a library" \
  -F "num_inference_steps=8" \
  -F "guidance_scale=3.5" \
  -F "seed=42" \
  -F "num_images_per_prompt=2"
```

**Success Response** (200)

```json
{
  "status": "success",
  "images": ["data:image/png;base64,...", "data:image/png;base64,..."],
  "image": "data:image/png;base64,...",
  "urls": ["/outputs/A_cat_wearing_a_wizard_hat_1715892345678_0.png"],
  "generation_time_ms": 4521,
  "parameters": {
    "prompt": "A cat wearing a wizard hat",
    "num_inference_steps": 8,
    "guidance_scale": 3.5,
    "width": 1024,
    "height": 1024,
    "seed": 42,
    "num_images_per_prompt": 1
  }
}
```

| Field | Description |
|-------|-------------|
| `images` | Array of base64 data URIs (one per variation) |
| `image` | First image's base64 data URI (convenience) |
| `urls` | Array of disk paths accessible via `/outputs/` |
| `generation_time_ms` | Total generation time in milliseconds |
| `parameters` | Echo of the parameters used |

**Error Responses**

| Status | Meaning |
|--------|---------|
| 400 | Invalid parameters (bad dimensions, unsupported variant) |
| 500 | Generation error (includes `traceback`) |
| 503 | Model not yet loaded |

---

### Image Editing

#### `POST /api/edit`

Image-to-image editing. Upload an image and describe the desired changes.

**Parameters** (multipart/form-data)

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `prompt` | string | *required* | | Description of the desired edit |
| `image` | file | *required* | PNG/JPEG | The input image to edit |
| `reference_image` | file | optional | PNG/JPEG | Optional style reference image |
| `num_inference_steps` | int | `28` | 1--100 | Denoising steps |
| `strength` | float | `0.8` | 0.0--1.0 | Edit strength (higher = more deviation from input) |
| `guidance_scale` | float | `3.5` | 1.0--20.0 | Prompt adherence |
| `seed` | int | `-1` | | Random seed |
| `num_images_per_prompt` | int | `1` | 1--4 | Variations |
| `model_variant` | string | `bf16` | | Model variant |

**Image Processing**

Uploaded images are automatically:
- EXIF auto-rotated
- Converted to RGB
- Clamped to 1024x1024 max area
- Snapped to multiples of 32 pixels (VAE requirement)

**Example**

```bash
curl -X POST http://localhost:8000/api/edit \
  -F "prompt=Make it look like a watercolor painting" \
  -F "image=@photo.png" \
  -F "strength=0.7"
```

Response matches `/api/generate` format.

---

### Cancellation

#### `POST /api/cancel`

Request cancellation of the current generation. Best-effort; the running step will finish but no further steps will execute.

```bash
curl -X POST http://localhost:8000/api/cancel
```

---

### Outputs

#### `GET /api/outputs`

List all generated images on disk.

```json
{
  "count": 5,
  "files": [
    {"filename": "cat_wizard_1715892345678_0.png", "url": "/outputs/cat_wizard_1715892345678_0.png", "size_bytes": 452100, "created": 1715892345.0}
  ]
}
```

#### `DELETE /api/outputs/{filename}`

Delete a generated image file.

```bash
curl -X DELETE http://localhost:8000/api/outputs/cat_wizard_1715892345678_0.png
```

---

## Model Variants

| Key | Label | Size | Loader |
|-----|-------|------|--------|
| `bf16` | BF16 | ~13GB | diffusers |
| `fp8` | FP8 | ~8GB | torchao_fp8_static |
| `gguf-bf16` | BF16 GGUF | ~7.75GB | gguf_single_file |
| `gguf-f16` | F16 GGUF | ~7.75GB | gguf_single_file |
| `gguf-q2-k` | Q2_K GGUF | ~1.83GB | gguf_single_file |
| `gguf-q3-k-m` | Q3_K_M GGUF | ~2.12GB | gguf_single_file |
| `gguf-q3-k-s` | Q3_K_S GGUF | ~2.10GB | gguf_single_file |
| `gguf-q4-0` | Q4_0 GGUF | ~2.46GB | gguf_single_file |
| `gguf-q4-1` | Q4_1 GGUF | ~2.69GB | gguf_single_file |
| `gguf-q4-k-m` | Q4_K_M GGUF | ~2.60GB | gguf_single_file |
| `gguf-q4-k-s` | Q4_K_S GGUF | ~2.58GB | gguf_single_file |
| `gguf-q5-0` | Q5_0 GGUF | ~2.92GB | gguf_single_file |
| `gguf-q5-1` | Q5_1 GGUF | ~3.15GB | gguf_single_file |
| `gguf-q5-k-m` | Q5_K_M GGUF | ~3.07GB | gguf_single_file |
| `gguf-q5-k-s` | Q5_K_S GGUF | ~3.05GB | gguf_single_file |
| `gguf-q6-k` | Q6_K GGUF | ~3.41GB | gguf_single_file |
| `gguf-q8-0` | Q8_0 GGUF | ~4.30GB | gguf_single_file |

## Aliases

Shorthand aliases are accepted: `q4km` -> `gguf-q4-k-m`, `q8` -> `gguf-q8-0`, etc.

## Python Client Example

```python
import httpx
import asyncio

async def generate(prompt: str, steps: int = 8):
    async with httpx.AsyncClient() as client:
        # Wait for model
        while True:
            r = await client.get("http://localhost:8000/api/model-status")
            if r.json()["loaded"]:
                break
            await asyncio.sleep(2)

        # Generate
        r = await client.post("http://localhost:8000/api/generate", data={
            "prompt": prompt,
            "num_inference_steps": steps,
            "seed": 42,
        })
        return r.json()

result = asyncio.run(generate("A fox in a spacesuit"))
# result["images"][0] is a base64 data URI
# result["urls"][0] is a disk path like /outputs/...
```
