import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class BackendConfig:
    backend: str
    label: str


def _normalize_backend_name(raw_backend: str | None) -> str | None:
    if raw_backend is None:
        return None

    normalized = raw_backend.strip().lower()
    aliases = {
        "cuda": "cuda",
        "nvidia": "cuda",
        "directml": "directml",
        "dml": "directml",
        "amd": "directml",
        "intel": "directml",
        "cpu": "cpu",
    }
    return aliases.get(normalized)


def _config_for_backend(backend: str) -> BackendConfig:
    if backend == "cuda":
        return BackendConfig(backend="cuda", label="NVIDIA CUDA")
    if backend == "directml":
        return BackendConfig(backend="directml", label="DirectML")
    return BackendConfig(backend="cpu", label="CPU")


@lru_cache(maxsize=1)
def get_backend_config() -> BackendConfig:
    configured_backend = _normalize_backend_name(os.environ.get("ML_BACKEND"))
    if configured_backend is not None:
        return _config_for_backend(configured_backend)

    try:
        import torch
    except Exception:
        return _config_for_backend("cpu")

    if torch.cuda.is_available():
        return _config_for_backend("cuda")

    try:
        import torch_directml

        torch_directml.device()
        return _config_for_backend("directml")
    except Exception:
        return _config_for_backend("cpu")


def get_model_dtype(torch):
    backend = get_backend_config().backend
    if backend == "cuda":
        is_bf16_supported = getattr(torch.cuda, "is_bf16_supported", None)
        if callable(is_bf16_supported) and is_bf16_supported():
            return torch.bfloat16
        return torch.float16
    if backend == "directml":
        return torch.float16
    return torch.float32


def get_runtime_device(torch):
    backend = get_backend_config().backend
    if backend == "cuda":
        return torch.device("cuda")
    if backend == "directml":
        import torch_directml

        return torch_directml.device()
    return torch.device("cpu")


def configure_pipeline_device(pipe, torch) -> None:
    backend = get_backend_config().backend
    if backend == "cuda":
        pipe.enable_model_cpu_offload()
        pipe.text_encoder.to("cuda")
        return

    pipe.to(get_runtime_device(torch))


def create_generator(torch, seed: int):
    generator_device = "cuda" if get_backend_config().backend == "cuda" else "cpu"
    generator = torch.Generator(device=generator_device)
    if seed != -1:
        generator.manual_seed(seed)
    else:
        generator.seed()
    return generator


def release_memory(torch) -> None:
    if get_backend_config().backend == "cuda" and torch.cuda.is_available():
        torch.cuda.empty_cache()