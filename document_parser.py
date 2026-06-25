import base64
import hashlib
import io
import json
import os
import re
import tempfile
import threading
import time
import traceback
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from langchain_core.documents import Document
from langchain_classic.text_splitter import RecursiveCharacterTextSplitter
from PIL import Image

from config import (
    get_figure_caption_model_name,
    get_llm_model_name,
    get_ollama_base_url,
)

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
PDF_EXTENSIONS = {".pdf"}
SUPPORTED_LAYOUT_EXTENSIONS = PDF_EXTENSIONS | IMAGE_EXTENSIONS
LAYOUT_CACHE_VERSION = "2026-06-24-paddle-layout-glm-qwen-caption-v8"
FIGURE_CAPTION_TIMEOUT_SECONDS = 120
PADDLE_FIGURE_LABELS = {
    "image",
    "header_image",
    "footer_image",
    "chart",
    "seal",
    "figure",
}

_splitter = RecursiveCharacterTextSplitter(
    chunk_size=650,
    chunk_overlap=80,
    length_function=len,
    separators=["\n\n", "\n", ". ", ", ", " ", ""],
)

_paddlex_pipeline: Any | None = None
_paddlex_unavailable_reason: str | None = None
_paddlex_init_lock = threading.Lock()
_paddlex_predict_lock = threading.Lock()
_paddle_masked_scatter_patched = False


def sanitize_filename(filename: str) -> str:
    name = os.path.basename(filename or "document")
    name = name.replace("\\", "_").replace("/", "_").strip()
    return name or "document"


def _cache_dir(storage_dir: str | None) -> str | None:
    if not storage_dir:
        return None
    path = os.path.join(storage_dir, "_layout_cache")
    os.makedirs(path, exist_ok=True)
    return path


def _safe_cache_name(filename: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", sanitize_filename(filename))


def _cache_path(
    storage_dir: str | None,
    session_id: str,
    filename: str,
    file_key: str | None = None,
) -> str | None:
    root = _cache_dir(storage_dir)
    if not root:
        return None
    safe = _safe_cache_name(filename)
    if file_key:
        return os.path.join(root, f"{file_key}_{safe}.layout.json")
    return os.path.join(root, f"{session_id}_{safe}.layout.json")


def _cache_artifact_path(
    storage_dir: str | None,
    session_id: str,
    filename: str,
    suffix: str,
    extension: str,
    file_key: str | None = None,
) -> str | None:
    root = _cache_dir(storage_dir)
    if not root:
        return None
    safe = _safe_cache_name(filename)
    prefix = file_key or session_id
    return os.path.join(root, f"{prefix}_{safe}.{suffix}.{extension}")


def _file_cache_key(file_bytes: bytes) -> str:
    digest = hashlib.sha1(file_bytes).hexdigest()[:16]
    return f"sha1_{digest}"


def load_cached_layout(
    storage_dir: str | None,
    session_id: str,
    filename: str,
    file_key: str | None = None,
) -> dict | None:
    candidates = []
    if file_key:
        candidates.append(_cache_path(storage_dir, session_id, filename, file_key=file_key))
    candidates.append(_cache_path(storage_dir, session_id, filename))

    for path in candidates:
        if not path or not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("_cache_version") == LAYOUT_CACHE_VERSION:
                return cached
        except (OSError, json.JSONDecodeError):
            continue
    return None


def save_cached_layout(
    storage_dir: str | None,
    session_id: str,
    filename: str,
    layout: dict,
    file_key: str | None = None,
) -> None:
    payload = dict(layout)
    payload["_cache_version"] = LAYOUT_CACHE_VERSION

    for path in filter(
        None,
        [
            _cache_path(storage_dir, session_id, filename, file_key=file_key),
            _cache_path(storage_dir, session_id, filename),
        ],
    ):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    parse_json = layout.get("parse_json")
    if parse_json is not None:
        for path in filter(
            None,
            [
                _cache_artifact_path(storage_dir, session_id, filename, "parse", "json", file_key=file_key),
                _cache_artifact_path(storage_dir, session_id, filename, "parse", "json"),
            ],
        ):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(parse_json, f, ensure_ascii=False, indent=2)

    markdown_parts = []
    for page in layout.get("pages", []):
        page_markdown = (_build_page_markdown(page.get("blocks", [])) or page.get("markdown") or "").strip()
        if page_markdown:
            markdown_parts.append(f"# Page {page.get('page_number', 1)}\n\n{page_markdown}")
    markdown_text = "\n\n".join(markdown_parts).strip()
    if markdown_text:
        for path in filter(
            None,
            [
                _cache_artifact_path(storage_dir, session_id, filename, "parse", "md", file_key=file_key),
                _cache_artifact_path(storage_dir, session_id, filename, "parse", "md"),
            ],
        ):
            with open(path, "w", encoding="utf-8") as f:
                f.write(markdown_text)


def delete_cached_layout(storage_dir: str | None, session_id: str, filename: str) -> None:
    if not storage_dir:
        return
    safe = _safe_cache_name(filename)
    root = _cache_dir(storage_dir)
    if not root:
        return
    for path in [
        os.path.join(root, f"{session_id}_{safe}.layout.json"),
        os.path.join(root, f"{session_id}_{safe}.parse.json"),
        os.path.join(root, f"{session_id}_{safe}.parse.md"),
    ]:
        if os.path.exists(path):
            os.remove(path)


def analyze_document(
    filename: str,
    file_bytes: bytes,
    session_id: str,
    storage_dir: str | None = None,
    force: bool = False,
) -> dict:
    filename = sanitize_filename(filename)
    file_key = _file_cache_key(file_bytes)
    if not force:
        cached = load_cached_layout(storage_dir, session_id, filename, file_key=file_key)
        if cached:
            print(f"[PARSE CACHE] Using cached layout for {filename} ({session_id}).")
            return cached

    ext = os.path.splitext(filename)[1].lower()
    print(f"[PARSE CACHE] Cache miss for {filename} ({session_id}). Running OCR pipeline.")
    if ext in IMAGE_EXTENSIONS:
        layout = _analyze_image(filename, file_bytes, session_id)
    elif ext in PDF_EXTENSIONS:
        layout = _analyze_pdf(filename, file_bytes, session_id)
    else:
        raise ValueError("Structured document parse currently supports PDF and image files only.")

    save_cached_layout(storage_dir, session_id, filename, layout, file_key=file_key)
    return layout


def layout_to_documents(layout: dict) -> list[Document]:
    docs: list[Document] = []
    source = layout.get("filename", "document")
    chunk_index = 0

    for page in layout.get("pages", []):
        for block in page.get("blocks", []):
            text = (block.get("text") or "").strip()
            description = (block.get("description") or "").strip()
            if not text and not description:
                continue

            header = (
                f"Source: {source}\n"
                f"Page: {page.get('page_number', 1)}\n"
                f"Block: {block.get('type', 'text')}\n"
                f"Bounding box: {block.get('bbox', [])}\n"
            )
            content = header
            if text:
                content += f"Text:\n{text}\n"
            if description:
                content += f"Description:\n{description}\n"

            for chunk in _splitter.split_text(content.strip()):
                docs.append(
                    Document(
                        page_content=chunk,
                        metadata={
                            "source": source,
                            "chunk_index": chunk_index,
                            "page": page.get("page_number", 1),
                            "block_id": str(block.get("id") or ""),
                            "block_type": str(block.get("type") or ""),
                            "bbox": json.dumps(block.get("bbox", [])),
                            "description": description,
                        },
                    )
                )
                chunk_index += 1

    total = len(docs)
    for doc in docs:
        doc.metadata["total_chunks"] = total
    return docs


def _rasterize_pdf_pages(file_bytes: bytes) -> list[Image.Image]:
    try:
        from pdf2image import convert_from_bytes  # type: ignore

        pages = convert_from_bytes(file_bytes, dpi=180, fmt="png")
        if pages:
            return pages
    except ImportError:
        pass
    except Exception as exc:
        try:
            import fitz  # type: ignore
        except ImportError:
            print(f"[PARSE WARN] pdf2image rasterization failed: {exc}")

    try:
        import fitz  # type: ignore

        images: list[Image.Image] = []
        with fitz.open(stream=file_bytes, filetype="pdf") as doc:
            for page in doc:
                pix = page.get_pixmap(dpi=180)
                images.append(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
        return images
    except Exception as exc:
        raise RuntimeError(
            "PDF rasterization failed. Install pdf2image (preferred) or keep PyMuPDF available."
        ) from exc


def _new_block(
    block_id: str,
    block_type: str,
    bbox: list[float],
    text: str = "",
    description: str = "",
    html: str = "",
    overlay: bool = True,
) -> dict:
    return {
        "id": block_id,
        "type": block_type,
        "bbox": [round(float(v), 2) for v in bbox],
        "text": text.strip(),
        "description": description.strip(),
        "html": html.strip(),
        "overlay": overlay,
    }


def _block_markdown(block: dict, index: int) -> str:
    block_type = str(block.get("type") or "text").strip().lower()
    title = block_type[:1].upper() + block_type[1:]
    text = str(block.get("text") or "").strip()
    html = str(block.get("html") or "").strip()
    description = str(block.get("description") or "").strip()

    if block_type == "table":
        content = html or text
    elif block_type == "figure":
        content = f"<::figure::> {description or text or 'Figure'}"
    else:
        content = text or description

    content = content.strip()
    if not content:
        return ""
    return f"{index} - {title}\n\n{content}"


def _build_page_markdown(blocks: list[dict]) -> str:
    parts = []
    for index, block in enumerate(blocks or [], 1):
        block_markdown = _block_markdown(block, index)
        if block_markdown:
            parts.append(block_markdown)
    return "\n\n".join(parts).strip()


def _crop_figure(image: Image.Image, bbox_xywh: list[float]) -> Image.Image | None:
    if len(bbox_xywh) != 4:
        return None
    x, y, width, height = bbox_xywh
    left = max(0, min(image.width, int(round(x))))
    top = max(0, min(image.height, int(round(y))))
    right = max(left, min(image.width, int(round(x + width))))
    bottom = max(top, min(image.height, int(round(y + height))))
    if right - left < 8 or bottom - top < 8:
        return None
    return image.crop((left, top, right, bottom)).convert("RGB")


def _clean_figure_caption(value: str) -> str:
    caption = (value or "").strip()
    caption = re.sub(r"^```(?:text|markdown)?\s*", "", caption, flags=re.IGNORECASE)
    caption = re.sub(r"\s*```$", "", caption)
    caption = re.sub(
        r"^(?:caption|figure caption|mô tả hình)\s*:\s*",
        "",
        caption,
        flags=re.IGNORECASE,
    )
    return caption.strip()


def _caption_figure_with_ollama(image: Image.Image) -> str:
    image = image.copy().convert("RGB")
    image.thumbnail((1400, 1400))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    encoded_image = base64.b64encode(buffer.getvalue()).decode("ascii")
    model = get_figure_caption_model_name()
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {
                "role": "user",
                "content": (
                    "Analyze this cropped visual from a document. It may be a photo, illustration, "
                    "logo, icon, signature, stamp, QR code, barcode, chart, or diagram. Return only "
                    "a concise factual description in the same language as visible text when possible. "
                    "Identify the visual type and include important readable text, labels, codes, "
                    "values, or trends. Do not add a heading and do not invent details."
                ),
                "images": [encoded_image],
            }
        ],
        "keep_alive": "10m",
        "options": {
            "temperature": 0.1,
            "num_predict": 320,
        },
    }
    req = urllib_request.Request(
        f"{get_ollama_base_url()}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=FIGURE_CAPTION_TIMEOUT_SECONDS) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (urllib_error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Ollama figure caption failed: {exc}") from exc

    extracted_content = _clean_figure_caption(
        str((result.get("message") or {}).get("content") or result.get("response") or "")
    )
    if not extracted_content:
        raise RuntimeError(f"Ollama model {model} returned an empty figure caption.")
    return _summarize_figure_caption(extracted_content)


def _summarize_figure_caption(caption: str) -> str:
    payload = {
        "model": get_llm_model_name(),
        "stream": False,
        "messages": [
            {
                "role": "user",
                "content": (
                    "Shorten the following document-figure description to one or two concise, "
                    "factual sentences. Preserve the original language and summarize only the "
                    "figure's subject or trend. Omit numbers, dates, codes, measurements, and "
                    "currency amounts rather than risk changing them. Return only the shortened "
                    "caption.\n\n"
                    f"{caption}"
                ),
            }
        ],
        "options": {
            "temperature": 0.1,
            "num_predict": 100,
        },
    }
    req = urllib_request.Request(
        f"{get_ollama_base_url()}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=FIGURE_CAPTION_TIMEOUT_SECONDS) as response:
            result = json.loads(response.read().decode("utf-8"))
        shortened = _clean_figure_caption(
            str((result.get("message") or {}).get("content") or result.get("response") or "")
        )
        if shortened and re.search(r"\d|[₹€$£¥₫]", shortened):
            retry_payload = {
                "model": get_llm_model_name(),
                "stream": False,
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "Write a general caption of at most 25 words for the figure described "
                            "below. Describe only its subject or purpose. Do not include any digit, "
                            "date, code, measurement, price, amount, or currency symbol. Return only "
                            f"the caption.\n\n{caption}"
                        ),
                    }
                ],
                "options": {"temperature": 0.1, "num_predict": 60},
            }
            retry_req = urllib_request.Request(
                f"{get_ollama_base_url()}/api/chat",
                data=json.dumps(retry_payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib_request.urlopen(
                retry_req,
                timeout=FIGURE_CAPTION_TIMEOUT_SECONDS,
            ) as response:
                retry_result = json.loads(response.read().decode("utf-8"))
            retry_caption = _clean_figure_caption(
                str(
                    (retry_result.get("message") or {}).get("content")
                    or retry_result.get("response")
                    or ""
                )
            )
            if retry_caption:
                shortened = retry_caption
        return shortened or caption
    except (urllib_error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"[FIGURE CAPTION WARN] Qwen summarization failed: {exc}")
        return caption


def _workspace_tool_dir(*parts: str) -> str:
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools")
    path = os.path.join(root, *parts)
    os.makedirs(path, exist_ok=True)
    return path


def _prepare_paddleocr_env() -> None:
    cache_root = _workspace_tool_dir("paddlex-cache")
    home_root = _workspace_tool_dir("paddle-home")
    xdg_cache = os.path.join(home_root, ".cache")
    os.makedirs(xdg_cache, exist_ok=True)

    os.environ["PADDLE_PDX_CACHE_HOME"] = cache_root
    os.environ["PADDLE_HOME"] = os.path.join(home_root, ".paddle")
    os.environ["USERPROFILE"] = home_root
    os.environ["HOME"] = home_root
    os.environ["XDG_CACHE_HOME"] = xdg_cache
    os.environ.setdefault("FLAGS_use_mkldnn", "0")
    os.environ.setdefault("FLAGS_enable_pir_api", "0")
    os.environ.setdefault("FLAGS_enable_pir_in_executor", "0")
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")


def _patch_paddle_masked_scatter() -> None:
    global _paddle_masked_scatter_patched
    if _paddle_masked_scatter_patched:
        return

    import paddle

    def masked_scatter_bool_compat(tensor, mask, value):
        flat_tensor = tensor.reshape([-1])
        flat_mask = mask.reshape([-1])
        indices = paddle.nonzero(flat_mask).reshape([-1])
        updates = value.reshape([-1])
        if updates.shape[0] < indices.shape[0]:
            raise ValueError(
                "masked_scatter source has fewer values than the number of selected elements"
            )
        updates = updates[: indices.shape[0]].astype(flat_tensor.dtype)
        scattered = paddle.scatter(
            flat_tensor,
            indices,
            updates,
            overwrite=True,
        )
        return scattered.reshape(tensor.shape)

    paddle.Tensor.masked_scatter = masked_scatter_bool_compat
    _paddle_masked_scatter_patched = True
    print("[LAYOUT] Applied Paddle masked_scatter boolean-mask compatibility patch.")


def _get_paddlex_pipeline() -> Any | None:
    global _paddlex_pipeline, _paddlex_unavailable_reason
    if _paddlex_pipeline is not None:
        return _paddlex_pipeline
    if _paddlex_unavailable_reason is not None:
        return None

    with _paddlex_init_lock:
        if _paddlex_pipeline is not None:
            return _paddlex_pipeline
        if _paddlex_unavailable_reason is not None:
            return None

        try:
            _prepare_paddleocr_env()
            os.environ["FLAGS_use_mkldnn"] = "0"

            import paddle
            _patch_paddle_masked_scatter()
            device = "gpu" if paddle.device.is_compiled_with_cuda() else "cpu"
            print(f"[LAYOUT] Initializing PaddleOCR-VL-1.6 pipeline on device: {device}...")

            from paddlex import create_pipeline
            _paddlex_pipeline = create_pipeline(pipeline="PaddleOCR-VL-1.6", device=device)
            print("[LAYOUT] PaddleOCR-VL-1.6 pipeline initialized successfully.")
            return _paddlex_pipeline
        except Exception as exc:
            _paddlex_unavailable_reason = str(exc) or type(exc).__name__
            print(
                "[LAYOUT WARN] PaddleOCR-VL-1.6 pipeline unavailable:\n"
                f"{traceback.format_exc()}"
            )
            return None


def _pipeline_status_paddlex(
    pdf_backend: str | None = None,
    layout_backend: str | None = None,
) -> dict:
    try:
        import paddle
        device = "gpu" if paddle.device.is_compiled_with_cuda() else "cpu"
    except ImportError:
        device = "cpu"
        
    return {
        "preprocess": {
            "pdf_to_image": pdf_backend == "pdf2image",
            "image_resize_lt_2mb": False,
        },
        "vision": {
            "provider": "paddlex",
            "model": "PaddleOCR-VL-1.6",
            "device": device,
            "ready": _paddlex_unavailable_reason is None,
            "figure_caption_model": get_figure_caption_model_name(),
        },
        "parsing": {
            "json_parse": True,
            "pydantic_validation": True,
        },
        "layout_detection": {
            "preferred": "PP-DocLayoutV3",
            "paddleocr_ready": _paddlex_unavailable_reason is None,
            "paddleocr_error": _paddlex_unavailable_reason,
            "fallback": None,
        },
        "output": {
            "json": True,
            "markdown": True,
        },
        "layout": layout_backend or "paddleocr-vl-1.6",
        "validation": "pydantic",
    }


def _analyze_pil_image_with_paddlex(
    filename: str,
    image: Image.Image,
    session_id: str,
    page_number: int,
) -> tuple[dict, dict]:
    started_at = time.perf_counter()
    normalized = image.convert("RGB")
    page_width = float(normalized.width)
    page_height = float(normalized.height)
    print(f"[PARSE] Preparing page {page_number} ({int(page_width)}x{int(page_height)}) for PaddleOCR-VL-1.6.")

    import numpy as np
    import cv2

    img_rgb = np.array(normalized)
    img_bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)

    pipeline = _get_paddlex_pipeline()
    if pipeline is None:
        raise RuntimeError("PaddleOCR-VL-1.6 pipeline is unavailable. Check log details.")

    try:
        with _paddlex_predict_lock:
            print(f"[PARSE] Page {page_number} acquired PaddleOCR inference lock.")
            results = list(
                pipeline.predict(
                    img_bgr,
                    use_queues=False,
                )
            )
    except Exception as exc:
        print(
            f"[PARSE ERROR] PaddleOCR-VL failed for {filename}, page {page_number}: "
            f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        )
        raise
    if not results:
        raise RuntimeError(
            f"PaddleOCR-VL returned no result for {filename}, page {page_number}."
        )
    res = results[0]
    
    blocks = []
    parse_blocks = []
    
    res_json = res.json
    if isinstance(res_json, dict) and "res" in res_json:
        res_json = res_json["res"]
    parsing_res_list = res_json.get("parsing_res_list", []) if isinstance(res_json, dict) else []
    
    for idx, block_res in enumerate(parsing_res_list, 1):
        label = str(block_res.get("block_label", "text")).lower().strip()
        content = block_res.get("block_content", "")
        bbox = block_res.get("block_bbox", [0, 0, 0, 0])
        
        if len(bbox) == 4:
            x0, y0, x1, y1 = bbox
            w = x1 - x0
            h = y1 - y0
            bbox_xywh = [float(x0), float(y0), float(w), float(h)]
        else:
            bbox_xywh = [0.0, 0.0, 0.0, 0.0]

        text = ""
        html = None
        description = None

        if label == "table":
            block_type = "table"
        elif label in PADDLE_FIGURE_LABELS:
            block_type = "figure"
        else:
            block_type = "text"

        if block_type == "table":
            html = content
            text = content
        elif block_type == "figure":
            fallback_description = str(content or "").strip()
            figure_crop = _crop_figure(normalized, bbox_xywh)
            if figure_crop is not None:
                try:
                    print(
                        f"[FIGURE CAPTION] Page {page_number}, block {idx}: "
                        f"captioning {label} ({int(bbox_xywh[2])}x{int(bbox_xywh[3])}) "
                        f"with {get_figure_caption_model_name()}."
                    )
                    description = _caption_figure_with_ollama(figure_crop)
                except Exception as exc:
                    print(f"[FIGURE CAPTION WARN] Page {page_number}, block {idx}: {exc}")
            description = description or fallback_description or "Figure"
        else:
            text = str(content or "").strip()
            
        block = _new_block(
            f"p{page_number}_{block_type}_{idx}",
            block_type,
            bbox_xywh,
            text,
            description or "",
            html=html or "",
            overlay=True,
        )
        blocks.append(block)
        
        parse_blocks.append({
            "type": block_type,
            "text": text,
            "html": html,
            "description": description,
            "bbox": bbox_xywh,
            "layout_label": label,
            "layout_confidence": None,
            "caption_model": (
                f"{get_figure_caption_model_name()} + {get_llm_model_name()}"
                if block_type == "figure"
                else None
            ),
        })
        
    print(f"[PARSE] Page {page_number} fully parsed in {time.perf_counter() - started_at:.1f}s.")
    
    page = {
        "page_number": page_number,
        "page_width": page_width,
        "page_height": page_height,
        "blocks": blocks,
        "markdown": _build_page_markdown(blocks),
    }
    
    page_payload = {
        "page_markdown": _build_page_markdown(blocks),
        "blocks": parse_blocks,
        "layout_backend": "paddleocr-vl-1.6",
    }
    
    layout = {
        "filename": filename,
        "session_id": session_id,
        "pipeline": _pipeline_status_paddlex(
            pdf_backend="pdf2image",
            layout_backend="paddleocr-vl-1.6"
        ),
        "pages": [page],
        "parse_json": {"pages": [{"page_number": page_number, **page_payload}]},
    }
    
    return layout, {"page_number": page_number, **page_payload}


def _analyze_image(filename: str, file_bytes: bytes, session_id: str) -> dict:
    with Image.open(io.BytesIO(file_bytes)) as img:
        layout, _ = _analyze_pil_image_with_paddlex(filename, img.copy(), session_id, page_number=1)
        return layout


def _analyze_pdf(filename: str, file_bytes: bytes, session_id: str) -> dict:
    pages = []
    parse_pages = []
    raster_pages = _rasterize_pdf_pages(file_bytes)
    if not raster_pages:
        return {
            "filename": filename,
            "session_id": session_id,
            "pipeline": _pipeline_status_paddlex(pdf_backend="pdf2image", layout_backend="paddleocr-vl-1.6"),
            "pages": [_empty_page(filename)],
            "parse_json": {"pages": []},
        }

    for page_number, image in enumerate(raster_pages, 1):
        page_layout, parse_page = _analyze_pil_image_with_paddlex(filename, image, session_id, page_number=page_number)
        pages.append(page_layout["pages"][0])
        parse_pages.append(parse_page)

    return {
        "filename": filename,
        "session_id": session_id,
        "pipeline": _pipeline_status_paddlex(pdf_backend="pdf2image", layout_backend="paddleocr-vl-1.6"),
        "pages": pages or [_empty_page(filename)],
        "parse_json": {"pages": parse_pages},
    }


def _empty_page(filename: str) -> dict:
    return {
        "page_number": 1,
        "page_width": 800,
        "page_height": 1050,
        "blocks": [
            _new_block(
                "p1_empty",
                "text",
                [50, 60, 700, 80],
                f"Could not parse structured data for {filename}.",
                "Structured OCR returned no usable content.",
            )
        ],
        "markdown": "",
    }
