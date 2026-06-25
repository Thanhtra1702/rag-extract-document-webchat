# OmniChat RAG

A locally hosted RAG web application for chatting with documents through Ollama. It supports document uploads, content extraction, semantic search, streamed responses, layout-aware OCR, and voice input.

## Features

- Chat with documents in isolated sessions.
- Stream responses in real time using Server-Sent Events (SSE).
- Process PDF, DOCX, TXT, CSV, JSON, XLSX, Markdown, PPTX, and common image formats.
- Analyze PDF and image layouts with OCR and image captioning.
- Store vectors in ChromaDB and generate embeddings with `bge-m3`.
- Use `qwen2.5:3b` as the default chat model.
- Transcribe voice input with Faster-Whisper.
- Manage chat history, uploaded documents, and processing progress from the web interface.

## Technology Stack

- Backend: FastAPI, LangChain, ChromaDB
- AI runtime: Ollama, PaddleOCR, Faster-Whisper
- Frontend: HTML, CSS, and JavaScript
- Local storage: `db/`, `chat_sessions/`, and `uploaded_files/`

## Requirements

- Python 3.10 or later; Python 3.11 is recommended.
- [Ollama](https://ollama.com/) installed and running.
- Git and a modern web browser.

For scanned PDFs, `pdf2image` is preferred when Poppler is available. Otherwise, the application can use PyMuPDF as a fallback.

## Installation

### 1. Create a virtual environment

Windows PowerShell:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
python3 -m venv venv
source venv/bin/activate
```

### 2. Install dependencies

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### 3. Download the Ollama models

```bash
ollama pull qwen2.5:3b
ollama pull bge-m3
ollama pull glm-ocr:latest
```

`glm-ocr:latest` is the default model used to caption images in the document-analysis pipeline.

### 4. Configure environment variables

Create a `.env` file in the project root if you need to override the default configuration:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_FIGURE_CAPTION_MODEL=glm-ocr:latest

# Optional: an external layout model compatible with the application
# OMNICHAT_LAYOUT_MODEL=lp://PubLayNet/faster_rcnn_R_50_FPN_3x/config
```

The `.env` file is excluded from Git. Do not commit API keys or other secrets to the repository.

### 5. Start the application

```bash
python server.py
```

Open [http://localhost:8000](http://localhost:8000). When started directly, the server listens on `0.0.0.0:8000` with auto-reload enabled.

## Supported Formats

| Category | Formats |
| --- | --- |
| Documents | `.pdf`, `.docx`, `.txt`, `.csv`, `.json`, `.xlsx`, `.md`, `.pptx` |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp` |

## Project Structure

```text
.
├── static/                 # Web interface
├── config.py               # Ollama and Faster-Whisper configuration
├── document_parser.py      # Layout analysis, OCR, and image captioning
├── file_processor.py       # Document extraction and chunking
├── rag_engine.py           # Retrieval, embeddings, and answer generation
├── server.py               # FastAPI routes and application entry point
├── requirements.txt        # Python dependencies
├── chat_sessions/          # Chat history generated at runtime
├── db/                     # ChromaDB data generated at runtime
└── uploaded_files/         # Uploaded files and parser cache
```

The runtime data directories above, along with local model caches, are excluded through `.gitignore`.

## Notes

- Make sure Ollama is running and all required models have been downloaded before starting the application.
- OCR, Faster-Whisper, and layout-processing models may take additional time to download or initialize on first use.
- The pipeline prefers a compatible GPU when available and falls back to the CPU for supported components.
- Documents, chat history, and vector data are stored locally. Back them up separately if they need to be preserved.
