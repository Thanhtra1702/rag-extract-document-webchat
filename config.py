import os

from faster_whisper import WhisperModel
from langchain_ollama import ChatOllama, OllamaEmbeddings


LLM_MODEL = "qwen2.5:3b"
LLM_TEMPERATURE = 0.1

EMBEDDING_MODEL = "bge-m3"

WHISPER_MODEL = "small"
LAYOUT_MODEL_ENV = "OMNICHAT_LAYOUT_MODEL"
OLLAMA_BASE_URL_ENV = "OLLAMA_BASE_URL"
OLLAMA_FIGURE_CAPTION_MODEL_ENV = "OLLAMA_FIGURE_CAPTION_MODEL"
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_FIGURE_CAPTION_MODEL = "glm-ocr:latest"


def get_ollama_base_url() -> str:
    return (os.getenv(OLLAMA_BASE_URL_ENV) or DEFAULT_OLLAMA_BASE_URL).rstrip("/")


def get_figure_caption_model_name() -> str:
    return (
        os.getenv(OLLAMA_FIGURE_CAPTION_MODEL_ENV)
        or DEFAULT_OLLAMA_FIGURE_CAPTION_MODEL
    ).strip()


def get_llm_model_name() -> str:
    return LLM_MODEL


def get_llm():
    return ChatOllama(
        base_url=get_ollama_base_url(),
        model=LLM_MODEL,
        temperature=LLM_TEMPERATURE,
    )


def get_embeddings():
    return OllamaEmbeddings(
        base_url=get_ollama_base_url(),
        model=EMBEDDING_MODEL,
    )


def get_whisper_model():
    candidates = [
        ("cuda", "float16"),
        ("cuda", "int8_float16"),
        ("cpu", "int8"),
    ]
    last_error = None
    for device, compute_type in candidates:
        try:
            return WhisperModel(
                WHISPER_MODEL,
                device=device,
                compute_type=compute_type,
            )
        except Exception as exc:
            last_error = exc
            print(f"[WHISPER WARN] Failed to initialize on {device}/{compute_type}: {exc}")
    raise RuntimeError(f"Could not initialize WhisperModel: {last_error}")
