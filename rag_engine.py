import json
import os
import re
import tempfile
import uuid
from datetime import datetime

from langchain_chroma import Chroma
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from document_parser import (
    analyze_document,
    delete_cached_layout,
    layout_to_documents,
    sanitize_filename,
)
from file_processor import process_file
from config import get_embeddings, get_llm, get_whisper_model

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SESSIONS_DIR = "./chat_sessions"

# Regex to find image URLs in text content
_IMAGE_URL_RE = re.compile(
    r'https?://[^\s"\',)]+\.(?:jpg|jpeg|png|gif|webp|svg)(?:[^\s"\',)]*)',
    re.IGNORECASE,
)


def _extract_image_from_docs(context_docs: list) -> str | None:
    """Extract the first image URL from context documents (metadata or page_content)."""
    for doc in context_docs:
        # 1. Check metadata first (legacy support)
        candidate = doc.metadata.get("image_url") or doc.metadata.get("image")
        if candidate:
            return candidate
        # 2. Scan page_content for image URLs
        match = _IMAGE_URL_RE.search(doc.page_content)
        if match:
            return match.group(0)
    return None


DB_DIR = "./db"
MAX_RETRIEVAL_DISTANCE = 1.15
os.makedirs(SESSIONS_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# RAG Engine (singleton)
# ---------------------------------------------------------------------------

class RAGEngine:
    """Encapsulates all RAG components: LLM, vector store, chains, Whisper."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        print("Loading models...")
        self.llm = get_llm()
        self.embeddings = get_embeddings()
        self.db = Chroma(persist_directory=DB_DIR, embedding_function=self.embeddings)
        self.whisper_model = get_whisper_model()
        self._build_chains()
        self._initialized = True
        print("All models loaded.")

    def _build_chains(self):
        self.prompt = ChatPromptTemplate.from_messages([
            (
                "system",
                "You are OmniChat, a helpful assistant. "
                "When the user provides document content, answer based on that content. "
                "When no document content is provided, answer from your general knowledge. "
                "ALWAYS respond in the same language the user used. "
                "Use Markdown when helpful.",
            ),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", "{context_section}{input}"),
        ])

    def _to_langchain_history(self, chat_history_dicts: list[dict]) -> list:
        return [
            HumanMessage(content=m["content"]) if m["type"] == "human"
            else AIMessage(content=m["content"])
            for m in chat_history_dicts
        ]

    def _serialize_history(self, chat_history: list) -> list[dict]:
        return [
            {"type": "human", "content": m.content}
            if isinstance(m, HumanMessage)
            else {"type": "ai", "content": m.content}
            for m in chat_history[-10:]
        ]

    def _format_context_section(self, context_docs: list) -> str:
        """Format context documents for injection into the user message."""
        if not context_docs:
            return ""
        parts = [doc.page_content for doc in context_docs]
        context_text = "\n\n".join(parts)
        return (
            "Below is content from my uploaded document. "
            "Use it to answer my question.\n\n"
            "---DOCUMENT START---\n"
            f"{context_text}\n"
            "---DOCUMENT END---\n\n"
            "My question: "
        )

    def _get_context_documents(self, text: str, session_id: str, filename: str | None = None) -> list:
        """Retrieve relevant documents. Always provides context when session has documents (ChatGPT-style)."""
        if not session_id:
            return []

        if filename:
            search_filter = {
                "$and": [
                    {"session_id": {"$eq": session_id}},
                    {"source": {"$eq": filename}},
                ]
            }
        else:
            search_filter = {"session_id": session_id}

        # Fetch all chunks for this session (needed for fallback)
        try:
            res = self.db.get(where=search_filter, include=["metadatas", "documents"])
            if not res or not res.get("ids"):
                return []
        except Exception as e:
            print(f"[RAG] Error checking session documents: {e}")
            return []

        total_chunks = len(res["ids"])
        print(f"[RAG] Session '{session_id}' has {total_chunks} chunks.")

        # 1. Try similarity search for the most relevant chunks
        sim_docs = []
        try:
            results = self.db.similarity_search_with_score(
                text, k=8, filter=search_filter,
            )
            sim_docs = [doc for doc, score in results if score <= MAX_RETRIEVAL_DISTANCE]
            if sim_docs:
                print(f"[RAG] Similarity search returned {len(sim_docs)} relevant chunks.")
        except Exception as e:
            print(f"[RAG] Similarity search error: {e}")

        # 2. If similarity search returned enough results, use them directly
        if len(sim_docs) >= 3:
            return sim_docs

        # 3. Supplement with representative chunks from beginning/middle/end
        #    so the LLM has a broad view of the document (handles "what is this
        #    about?", "summarize", etc.)
        try:
            from langchain_core.documents import Document
            existing_contents = {doc.page_content for doc in sim_docs}

            # Collect all chunks sorted by position in document
            all_chunks = []
            for doc_id, metadata, content in zip(
                res["ids"], res.get("metadatas") or [], res.get("documents") or []
            ):
                if not content:
                    continue
                all_chunks.append((metadata or {}, content))
            all_chunks.sort(key=lambda x: x[0].get("chunk_index", 0))

            if not all_chunks:
                return sim_docs

            # Pick indices from beginning, middle, and end
            n = len(all_chunks)
            pick_indices = set()
            # Beginning (first 3)
            for i in range(min(3, n)):
                pick_indices.add(i)
            # Middle
            mid = n // 2
            for i in range(max(0, mid - 1), min(n, mid + 2)):
                pick_indices.add(i)
            # End (last 2)
            for i in range(max(0, n - 2), n):
                pick_indices.add(i)

            added = 0
            for idx in sorted(pick_indices):
                metadata, content = all_chunks[idx]
                if content not in existing_contents:
                    sim_docs.append(Document(page_content=content, metadata=metadata))
                    existing_contents.add(content)
                    added += 1

            if added:
                print(f"[RAG] Added {added} representative chunks (beginning/middle/end). "
                      f"Total context: {len(sim_docs)} chunks.")
        except Exception as e:
            print(f"[RAG] Error adding representative chunks: {e}")

        return sim_docs

    def answer(self, text: str, chat_history_dicts: list[dict], session_id: str, filename: str | None = None) -> dict:
        """
        Process a user message. Automatically retrieves document context
        when available, like ChatGPT/Gemini.
        """
        chat_history = self._to_langchain_history(chat_history_dicts)
        context_docs = self._get_context_documents(text, session_id, filename)
        context_section = self._format_context_section(context_docs)

        chain = self.prompt | self.llm | StrOutputParser()
        answer = chain.invoke({
            "input": text,
            "chat_history": chat_history,
            "context_section": context_section,
        }).strip()

        image_url = _extract_image_from_docs(context_docs) if context_docs else None

        chat_history.extend([
            HumanMessage(content=text),
            AIMessage(content=answer),
        ])
        return {
            "answer": answer,
            "image_url": image_url,
            "chat_history": self._serialize_history(chat_history),
        }

    async def answer_stream(self, text: str, chat_history_dicts: list[dict], session_id: str, filename: str | None = None):
        """
        Stream tokens. Automatically retrieves document context when available.
        """
        chat_history = self._to_langchain_history(chat_history_dicts)
        context_docs = self._get_context_documents(text, session_id, filename)
        context_section = self._format_context_section(context_docs)

        print(f"[RAG DEBUG] context_docs count: {len(context_docs)}, "
              f"context_section length: {len(context_section)} chars")
        if context_section:
            print(f"[RAG DEBUG] context_section preview: {context_section[:200]}...")

        chain = self.prompt | self.llm | StrOutputParser()
        full_answer = ""

        async for token in chain.astream({
            "input": text,
            "chat_history": chat_history,
            "context_section": context_section,
        }):
            if token:
                full_answer += token
                yield {"token": token}

        image_url = _extract_image_from_docs(context_docs) if context_docs else None

        chat_history.extend([
            HumanMessage(content=text),
            AIMessage(content=full_answer),
        ])
        yield {
            "done": True,
            "image_url": image_url,
            "chat_history": self._serialize_history(chat_history),
            "answer": full_answer,
        }

    def transcribe(self, audio_bytes: bytes) -> str:
        """Transcribe audio bytes using Whisper."""
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:
            f.write(audio_bytes)
            temp_path = f.name
        try:
            segments, _ = self.whisper_model.transcribe(temp_path)
            return " ".join(seg.text.strip() for seg in segments).strip()
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def add_documents(
        self,
        filename: str,
        file_bytes: bytes,
        session_id: str,
        parse_enabled: bool = True,
    ) -> int:
        """Process and add a file to the vector store. Returns chunk count.

        Uses batch processing to avoid overwhelming the embedding model
        with too many chunks at once.
        """
        filename = sanitize_filename(filename)
        docs = self._prepare_documents(filename, file_bytes, session_id, prefer_layout=parse_enabled)
        if not docs:
            return 0

        for doc in docs:
            doc.metadata["session_id"] = session_id
            doc.metadata["parse_enabled"] = parse_enabled

        # Batch add to avoid overwhelming Ollama embeddings
        BATCH_SIZE = 20
        total = len(docs)
        added = 0
        print(f"[EMBED] Processing {total} chunks for '{filename}' in batches of {BATCH_SIZE}...")

        for i in range(0, total, BATCH_SIZE):
            batch = docs[i:i + BATCH_SIZE]
            try:
                self.db.add_documents(batch)
                added += len(batch)
                print(f"[EMBED] Progress: {added}/{total} chunks embedded")
            except Exception as e:
                print(f"[EMBED ERROR] Batch {i//BATCH_SIZE + 1} failed: {e}")
                # Try one-by-one for the failed batch
                for j, doc in enumerate(batch):
                    try:
                        self.db.add_documents([doc])
                        added += 1
                    except Exception as e2:
                        print(f"[EMBED ERROR] Chunk {i+j} skipped: {e2}")

        print(f"[EMBED] Done: {added}/{total} chunks added for '{filename}'")
        return added

    def _prepare_documents(
        self,
        filename: str,
        file_bytes: bytes,
        session_id: str,
        prefer_layout: bool = True,
    ) -> list:
        """Prepare documents for embedding, optionally preferring the layout parser."""
        if prefer_layout:
            try:
                from server import UPLOADED_FILES_DIR
                layout = analyze_document(filename, file_bytes, session_id, UPLOADED_FILES_DIR)
                docs = layout_to_documents(layout)
                if docs:
                    return docs
            except Exception as e:
                print(f"[DOC AI WARN] Falling back to plain extraction for {filename}: {e}")

        return process_file(filename, file_bytes)

    def delete_session_documents(self, session_id: str):
        """Delete all documents in the vector store belonging to a specific session."""
        try:
            res = self.db.get(where={"session_id": session_id})
            if res and res.get("ids"):
                self.db.delete(ids=res["ids"])
                print(f"Cleaned up {len(res['ids'])} documents for session {session_id}.")
        except Exception as e:
            print(f"Error cleaning up documents for session {session_id}: {e}")

    def get_uploaded_documents(self, session_id: str) -> list[dict]:
        """Get a list of unique uploaded document filenames and their chunk count."""
        try:
            res = self.db.get(where={"session_id": session_id})
            if not res or not res.get("metadatas"):
                return []

            doc_counts = {}
            for metadata in res["metadatas"]:
                if metadata:
                    source = metadata.get("source", "Unknown")
                    entry = doc_counts.setdefault(source, {"filename": source, "chunks": 0, "parse_enabled": False})
                    entry["chunks"] += 1
                    entry["parse_enabled"] = entry["parse_enabled"] or bool(metadata.get("parse_enabled"))

            return list(doc_counts.values())
        except Exception as e:
            print(f"Error getting uploaded documents for session {session_id}: {e}")
            return []

    def is_document_parse_enabled(self, filename: str, session_id: str) -> bool:
        filename = sanitize_filename(filename)
        try:
            res = self.db.get(where={"session_id": session_id})
            if not res or not res.get("metadatas"):
                return False

            for metadata in res["metadatas"]:
                if not metadata:
                    continue
                if metadata.get("source") == filename:
                    return bool(metadata.get("parse_enabled"))
        except Exception as e:
            print(f"Error checking parse status for {filename} in {session_id}: {e}")
        return False

    def delete_document(self, filename: str, session_id: str) -> bool:
        """Delete a document by its source filename for a given session."""
        filename = sanitize_filename(filename)
        try:
            res = self.db.get(where={"session_id": session_id})
            if not res or not res.get("ids"):
                return False

            ids_to_delete = []
            for doc_id, metadata in zip(res["ids"], res.get("metadatas") or []):
                if metadata:
                    doc_source = metadata.get("source")
                    if doc_source == filename or (filename == "Unknown" and not doc_source):
                        ids_to_delete.append(doc_id)

            if ids_to_delete:
                self.db.delete(ids=ids_to_delete)
                try:
                    from server import UPLOADED_FILES_DIR
                    delete_cached_layout(UPLOADED_FILES_DIR, session_id, filename)
                except Exception:
                    pass
                print(f"Deleted document {filename} ({len(ids_to_delete)} chunks) for session {session_id}.")
                return True
            return False
        except Exception as e:
            print(f"Error deleting document {filename} for session {session_id}: {e}")
            return False

    def get_document_layout(self, filename: str, session_id: str) -> dict:
        """
        Load structured document layout with bounding boxes for visual overlay.
        """
        filename = sanitize_filename(filename)
        if not self.is_document_parse_enabled(filename, session_id):
            raise ValueError("Document parser is not enabled for this file.")
        try:
            from server import UPLOADED_FILES_DIR

            file_path = os.path.join(UPLOADED_FILES_DIR, f"{session_id}_{filename}")
            if os.path.exists(file_path):
                with open(file_path, "rb") as f:
                    return analyze_document(filename, f.read(), session_id, UPLOADED_FILES_DIR)
        except Exception as e:
            print(f"[DOC AI ERROR] Could not analyze layout for {filename}: {e}")

        return {
            "filename": filename,
            "session_id": session_id,
            "pages": [
                {
                    "page_number": 1,
                    "page_width": 800,
                    "page_height": 1050,
                    "blocks": [
                        {
                            "id": "p1_empty",
                            "type": "text",
                            "bbox": [50, 60, 700, 80],
                            "text": f"Could not analyze the layout for {filename}.",
                            "description": "The original file was not found or the layout parser failed.",
                        }
                    ],
                }
            ],
        }


# ---------------------------------------------------------------------------
# Session management (JSON files)
# ---------------------------------------------------------------------------

def _session_path(session_id: str) -> str:
    return os.path.join(SESSIONS_DIR, f"{session_id}.json")


def create_session() -> dict:
    sid = str(uuid.uuid4())[:8]
    data = {
        "id": sid,
        "title": "New Chat",
        "created_at": datetime.now().isoformat(),
        "messages": [],
        "chat_history": [],
    }
    with open(_session_path(sid), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


def save_session(session_id: str, data: dict):
    with open(_session_path(session_id), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_session(session_id: str) -> dict | None:
    path = _session_path(session_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def list_sessions() -> list[dict]:
    sessions = []
    for fname in os.listdir(SESSIONS_DIR):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(SESSIONS_DIR, fname), "r", encoding="utf-8") as f:
                data = json.load(f)
            sessions.append({
                "id": data["id"],
                "title": data.get("title", "New Chat"),
                "created_at": data.get("created_at", ""),
            })
        except (json.JSONDecodeError, KeyError):
            continue
    sessions.sort(key=lambda s: s.get("created_at", ""), reverse=True)
    return sessions


def delete_session(session_id: str) -> bool:
    try:
        engine = RAGEngine()
        engine.delete_session_documents(session_id)
    except Exception as e:
        print(f"⚠️ Error cleaning up session documents: {e}")

    path = _session_path(session_id)
    if os.path.exists(path):
        os.remove(path)
        return True
    return False
