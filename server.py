"""
server.py — FastAPI backend serving the RAG chatbot API + static frontend.

Run with:  python server.py
"""

import json
import os
import time
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

load_dotenv()

from rag_engine import (
    RAGEngine,
    create_session,
    save_session,
    load_session,
    list_sessions,
    delete_session,
)
from document_parser import analyze_document, layout_to_documents, sanitize_filename
from file_processor import SUPPORTED_EXTENSIONS

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

# Serve static files (CSS, JS)
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(STATIC_DIR, exist_ok=True)
UPLOADED_FILES_DIR = os.path.join(os.path.dirname(__file__), "uploaded_files")
os.makedirs(UPLOADED_FILES_DIR, exist_ok=True)

# Initialize RAG engine at startup (force reload 3)
engine: RAGEngine | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    engine = RAGEngine()
    yield


app = FastAPI(title="FreeChat RAG", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# Request/Response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    session_id: str
    message: str
    source: str = "text"  # "text" or "voice"
    filename: str | None = None


class ChatResponse(BaseModel):
    answer: str
    image_url: str | None = None


class ParserChatRequest(BaseModel):
    session_id: str
    filename: str
    message: str
    chat_history: list[dict] = Field(default_factory=list)


class ParserChatResponse(BaseModel):
    answer: str
    chat_history: list[dict]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/")
def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# ---- Chat ----
@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    session = load_session(req.session_id)
    if session is None:
        raise HTTPException(404, "Session not found")

    chat_history = session.get("chat_history", [])
    result = engine.answer(req.message, chat_history, session_id=req.session_id, filename=req.filename)

    # Update session title from first message
    if session["title"] == "New Chat" and req.message.strip():
        session["title"] = req.message.strip()[:40]

    # Append messages
    session["messages"].append({
        "role": "user",
        "content": req.message,
        "source": req.source,
        "image_url": None,
    })
    session["messages"].append({
        "role": "assistant",
        "content": result["answer"],
        "source": "assistant",
        "image_url": result["image_url"],
    })
    session["chat_history"] = result["chat_history"]

    save_session(req.session_id, session)

    return ChatResponse(answer=result["answer"], image_url=result["image_url"])


# ---- Chat WebSocket ----
@app.websocket("/api/chat/ws")
async def chat_websocket(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except json.JSONDecodeError:
                await websocket.send_json({"error": "Invalid JSON payload"})
                continue

            session_id = payload.get("session_id")
            message = payload.get("message", "")
            source = payload.get("source", "text")
            filename = payload.get("filename")

            if not session_id or not isinstance(message, str) or not message.strip():
                await websocket.send_json({"error": "session_id and message are required"})
                continue

            session = load_session(session_id)
            if session is None:
                await websocket.send_json({"error": "Session not found"})
                continue

            chat_history = session.get("chat_history", [])
            full_answer = ""
            image_url = None
            updated_history = chat_history

            try:
                async for chunk in engine.answer_stream(message, chat_history, session_id=session_id, filename=filename):
                    if "token" in chunk:
                        full_answer += chunk["token"]
                        await websocket.send_json({"token": chunk["token"]})
                    elif chunk.get("done"):
                        image_url = chunk.get("image_url")
                        updated_history = chunk.get("chat_history", chat_history)
                        await websocket.send_json({"done": True, "image_url": image_url})
            except Exception as e:
                await websocket.send_json({"error": str(e)})
                continue

            if session["title"] == "New Chat" and message.strip():
                session["title"] = message.strip()[:40]

            session["messages"].append({
                "role": "user",
                "content": message,
                "source": source,
                "image_url": None,
            })
            session["messages"].append({
                "role": "assistant",
                "content": full_answer,
                "source": "assistant",
                "image_url": image_url,
            })
            session["chat_history"] = updated_history
            save_session(session_id, session)

    except WebSocketDisconnect:
        return


# ---- Sessions ----
@app.get("/api/sessions")
def get_sessions():
    return list_sessions()


@app.post("/api/sessions")
def new_session():
    return create_session()


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    session = load_session(session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    return session


@app.delete("/api/sessions/{session_id}")
def remove_session(session_id: str):
    if delete_session(session_id):
        return {"ok": True}
    raise HTTPException(404, "Session not found")


# ---- Transcribe ----
@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    transcript = engine.transcribe(audio_bytes)
    return {"transcript": transcript}


# ---- File Upload (with progress) ----
@app.post("/api/upload")
async def upload_document(
    file: UploadFile = File(...),
    session_id: str = Query(...),
    parse_document: bool = False,
):
    if load_session(session_id) is None:
        raise HTTPException(404, "Session not found")
    filename = sanitize_filename(file.filename)
    ext = os.path.splitext(filename)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            400,
            f"Unsupported format: {ext}. Supported: {', '.join(SUPPORTED_EXTENSIONS)}"
        )

    file_bytes = await file.read()
    print(f"[UPLOAD] File: {filename}, Size: {len(file_bytes)} bytes, Extension: {ext}")

    # Save the file to disk so we can serve/download it later
    save_path = os.path.join(UPLOADED_FILES_DIR, f"{session_id}_{filename}")
    with open(save_path, "wb") as f:
        f.write(file_bytes)

    async def progress_generator():
        BATCH_SIZE = 20
        added = 0
        layout = None
        docs = []
        total = 0
        started_at = time.perf_counter()

        if parse_document:
            yield f"data: {json.dumps({'status': 'parsing', 'filename': filename, 'message': 'Parsing document with local PaddleOCR-VL 1.6. This may take a moment on first execution.'}, ensure_ascii=False)}\n\n"
        else:
            yield f"data: {json.dumps({'status': 'preparing', 'filename': filename, 'message': 'Preparing the file for the knowledge session.'}, ensure_ascii=False)}\n\n"

        try:
            if parse_document:
                parse_started = time.perf_counter()
                layout = analyze_document(filename, file_bytes, session_id, UPLOADED_FILES_DIR)
                docs = layout_to_documents(layout)
                parse_elapsed = time.perf_counter() - parse_started
                print(f"[UPLOAD] Parse completed for {filename} in {parse_elapsed:.1f}s.")
            else:
                prep_started = time.perf_counter()
                docs = engine._prepare_documents(filename, file_bytes, session_id, prefer_layout=False)
                prep_elapsed = time.perf_counter() - prep_started
                print(f"[UPLOAD] Plain knowledge prep completed for {filename} in {prep_elapsed:.1f}s.")
        except Exception as e:
            print(f"[UPLOAD ERROR] {filename}: {type(e).__name__}: {e}")
            yield f"data: {json.dumps({'status': 'error', 'filename': filename, 'message': f'Processing failed: {e}'}, ensure_ascii=False)}\n\n"
            return

        if not docs:
            yield f"data: {json.dumps({'status': 'done', 'filename': filename, 'chunks': 0, 'total_chunks': 0, 'parse_enabled': parse_document, 'message': 'No text found in file.', 'layout_pipeline': layout.get('pipeline', {}) if layout else None}, ensure_ascii=False)}\n\n"
            return

        for doc in docs:
            doc.metadata["session_id"] = session_id
            doc.metadata["parse_enabled"] = parse_document

        total = len(docs)
        yield f"data: {json.dumps({'status': 'embedding', 'filename': filename, 'total_chunks': total, 'processed': 0, 'message': f'Parsing complete. Embedding {total} chunks into the session.'}, ensure_ascii=False)}\n\n"

        for i in range(0, total, BATCH_SIZE):
            batch = docs[i:i + BATCH_SIZE]
            try:
                engine.db.add_documents(batch)
                added += len(batch)
            except Exception as e:
                print(f"[EMBED ERROR] Batch {i//BATCH_SIZE + 1}: {e}")
                for doc in batch:
                    try:
                        engine.db.add_documents([doc])
                        added += 1
                    except Exception:
                        pass

            progress_data = {
                "status": "embedding",
                "filename": filename,
                "total_chunks": total,
                "processed": added,
            }
            yield f"data: {json.dumps(progress_data, ensure_ascii=False)}\n\n"

        # Final done event
        message = f"Added {added} chunks to the session context."
        done_data = {
            "status": "done",
            "filename": filename,
            "chunks": added,
            "total_chunks": total,
            "message": message,
            "parse_enabled": parse_document,
            "layout_pipeline": layout.get("pipeline", {}) if layout else None,
            "elapsed_seconds": round(time.perf_counter() - started_at, 1),
        }
        
        try:
            session = load_session(session_id)
            if session is not None:
                uploaded_label = f"[{filename}](parser://{filename})" if parse_document else filename
                upload_suffix = " - parser enabled" if parse_document else " - knowledge only"
                session["messages"].append({
                    "role": "system",
                    "content": f"Uploaded document: {uploaded_label} ({added} chunks){upload_suffix}",
                    "source": "system",
                    "image_url": None,
                })
                save_session(session_id, session)
        except Exception as e:
            print(f"[SESSION SAVE ERROR] {e}")
                
        yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        progress_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/supported-formats")
def supported_formats():
    return {"formats": SUPPORTED_EXTENSIONS}


# ---- Document Management ----
@app.get("/api/documents")
def get_documents(session_id: str = Query(...)):
    if load_session(session_id) is None:
        raise HTTPException(404, "Session not found")
    if engine is None:
        raise HTTPException(503, "RAG engine not initialized yet")
    return engine.get_uploaded_documents(session_id)


@app.delete("/api/documents")
def delete_uploaded_document(filename: str = Query(...), session_id: str = Query(...)):
    filename = sanitize_filename(filename)
    if load_session(session_id) is None:
        raise HTTPException(404, "Session not found")
    if engine is None:
        raise HTTPException(503, "RAG engine not initialized yet")
    if engine.delete_document(filename, session_id):
        # Also delete local copy if exists
        try:
            file_path = os.path.join(UPLOADED_FILES_DIR, f"{session_id}_{filename}")
            if os.path.exists(file_path):
                os.remove(file_path)
        except Exception:
            pass
        return {"ok": True}
    raise HTTPException(404, f"Document '{filename}' not found for session '{session_id}'")


@app.get("/api/documents/download")
def download_document(filename: str = Query(...), session_id: str = Query(...)):
    filename = sanitize_filename(filename)
    if load_session(session_id) is None:
        raise HTTPException(404, "Session not found")
    file_path = os.path.join(UPLOADED_FILES_DIR, f"{session_id}_{filename}")
    if not os.path.exists(file_path):
        raise HTTPException(404, "File not found")
    return FileResponse(file_path, filename=filename)


@app.get("/api/parse")
def parse_document(filename: str = Query(...), session_id: str = Query(...)):
    filename = sanitize_filename(filename)
    if load_session(session_id) is None:
        raise HTTPException(404, "Session not found")
    if engine is None:
        raise HTTPException(503, "RAG engine not initialized yet")
    try:
        return engine.get_document_layout(filename, session_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post("/api/parse/chat", response_model=ParserChatResponse)
def chat_with_parsed_document(req: ParserChatRequest):
    filename = sanitize_filename(req.filename)
    message = req.message.strip()
    if not message:
        raise HTTPException(400, "Message is required")
    if not req.session_id:
        raise HTTPException(400, "A valid chat session is required")
    if load_session(req.session_id) is None:
        raise HTTPException(404, "Session not found")
    if engine is None:
        raise HTTPException(503, "RAG engine not initialized yet")
    if not engine.is_document_parse_enabled(filename, req.session_id):
        raise HTTPException(409, "Document parser is not enabled for this file.")

    result = engine.answer(
        message,
        req.chat_history[-10:],
        session_id=req.session_id,
        filename=filename,
    )
    return ParserChatResponse(
        answer=result["answer"],
        chat_history=result["chat_history"],
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
