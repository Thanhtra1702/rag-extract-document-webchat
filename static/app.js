/* ================================================================
   app.js — FreeChat RAG SPA
   ================================================================ */

const API = "";

// ---- DOM refs ----
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarToggleInner = document.getElementById("sidebar-toggle-inner");
const newChatBtn = document.getElementById("new-chat-btn");
const sessionListEl = document.getElementById("session-list");
const topbarTitle = document.getElementById("topbar-title");
const chatArea = document.getElementById("chat-area");
const welcomeScreen = document.getElementById("welcome-screen");
const messagesEl = document.getElementById("messages");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const micBtn = document.getElementById("mic-btn");
const plusBtn = document.getElementById("plus-btn");
const dropdownMenu = document.getElementById("input-dropdown-menu");
const menuUploadBtn = document.getElementById("menu-upload-btn");
const menuParseBtn = document.getElementById("menu-parse-btn");
const parserFileInput = document.getElementById("parser-file-input");
const parserUploadZone = document.getElementById("parser-upload-zone");
const parserSelectFileBtn = document.getElementById("parser-select-file-btn");
const parserProgressBarFill = document.getElementById("parser-progress-bar-fill");
const parserProgressText = document.getElementById("parser-progress-text");
const parserUploadProgress = document.getElementById("parser-upload-progress");
const fileInput = document.getElementById("file-input");
const toastContainer = document.getElementById("toast-container");
const sessionDocsSection = document.getElementById("session-docs-section");
const sessionDocsListEl = document.getElementById("session-docs-list");
const dragOverlay = document.getElementById("drag-overlay");

// ---- Document Parser DOM refs ----
const parserView = document.getElementById("parser-view");
const mainView = document.querySelector(".main");
const parserWorkspace = document.querySelector(".parser-workspace");
const parserFilenameBreadcrumb = document.getElementById("parser-filename-breadcrumb");
const parserPrevBtn = document.getElementById("parser-prev-btn");
const parserNextBtn = document.getElementById("parser-next-btn");
const parserPageIndicator = document.getElementById("parser-page-indicator");
const parserCloseBtn = document.getElementById("parser-close-btn");
const parserResizeHandle = document.getElementById("parser-resize-handle");
const parserViewerContainer = document.getElementById("parser-viewer-container");
const pdfRenderCanvas = document.getElementById("pdf-render-canvas");
const imageRenderView = document.getElementById("image-render-view");
const textRenderView = document.getElementById("text-render-view");
const boundingBoxesOverlay = document.getElementById("bounding-boxes-overlay");
const parsedBlocksList = document.getElementById("parsed-blocks-list");
const extractedBlocksList = document.getElementById("extracted-blocks-list");
const parserJsonCode = document.getElementById("parser-json-code");
const parserOutputDownloadBtn = document.getElementById("parser-output-download-btn");
const parserOutputCopyBtn = document.getElementById("parser-output-copy-btn");
const parserFileStrip = document.getElementById("parser-file-strip");
const parserFileStripTitle = document.getElementById("parser-file-strip-title");
const parserFileStripToggle = document.getElementById("parser-file-strip-toggle");
const parserFileUploadTile = document.getElementById("parser-file-upload-tile");
const parserFileThumbs = document.getElementById("parser-file-thumbs");
const parserFileStripProgress = document.getElementById("parser-file-strip-progress");
const parserFileStripProgressFill = document.getElementById("parser-file-strip-progress-fill");
const parserFileStripProgressText = document.getElementById("parser-file-strip-progress-text");
const parserChatMessages = document.getElementById("parser-chat-messages");
const parserChatInput = document.getElementById("parser-chat-input");
const parserChatSendBtn = document.getElementById("parser-chat-send-btn");

// ---- State ----
let currentSessionId = null;
let sessions = [];
let isProcessing = false;
let mediaRecorder = null;
let isRecording = false;
let recordingTimerInterval = null;
let recordingSeconds = 0;
let originalMicBtnHtml = "";
let parseModeEnabled = localStorage.getItem("parseDocumentMode") === "true";

// ---- Document Parser State ----
let parserCurrentFile = null;
let parserCurrentSessionId = null;
let parserLayoutData = null;
let parserCurrentPage = 1;
let pdfDoc = null;
let resizeObserver = null;
let parserStripCollapsed = localStorage.getItem("parserFileStripCollapsed") === "true";
let parserSelectedBlockId = null;
let parserChatHistory = [];

// ================================================================
// UTILITIES
// ================================================================

function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

function renderMarkdown(text) {
    if (!text) return "";
    let html = text
        // Code blocks
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Bold
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // Unordered lists
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        // Parser custom links
        .replace(/\[([^\]]+)\]\(parser:\/\/([^)]+)\)/g, '<a href="#" class="parser-trigger-link" data-filename="$2" style="font-weight:600;text-decoration:underline;">$1</a>')
        // Links
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        // Line breaks → paragraphs
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');

    // Wrap list items
    html = html.replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');

    return `<p>${html}</p>`;
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
    });
}

function autoResizeInput() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
    // Enable/disable send
    const hasText = messageInput.value.trim().length > 0;
    sendBtn.classList.toggle("enabled", hasText);
}

function updateWelcomeState(isWelcome) {
    const mainEl = document.querySelector(".main");
    if (mainEl) {
        mainEl.classList.toggle("welcome-active", isWelcome);
    }
}



// ================================================================
// SESSION MANAGEMENT
// ================================================================

async function fetchSessions() {
    try {
        const res = await fetch(`${API}/api/sessions`);
        sessions = await res.json();
        renderSessionList();
    } catch (e) {
        console.error("Failed to fetch sessions:", e);
    }
}

function renderSessionList() {
    // Keep the label
    sessionListEl.innerHTML = '<div class="session-label">Recent</div>';

    if (sessions.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "padding:12px;color:var(--text-muted);font-size:13px;";
        empty.textContent = "No conversations yet";
        sessionListEl.appendChild(empty);
        return;
    }

    sessions.forEach(s => {
        const item = document.createElement("div");
        item.className = `session-item${s.id === currentSessionId ? " active" : ""}`;
        item.innerHTML = `
            <svg class="session-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="session-title">${escapeHtml(s.title)}</span>
            <button class="session-delete" title="Delete">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        `;

        item.addEventListener("click", (e) => {
            if (e.target.closest(".session-delete")) return;
            loadSession(s.id);
        });

        item.querySelector(".session-delete").addEventListener("click", async (e) => {
            e.stopPropagation();
            await deleteSession(s.id);
        });

        sessionListEl.appendChild(item);
    });
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

async function createNewSession() {
    try {
        const res = await fetch(`${API}/api/sessions`, { method: "POST" });
        const session = await res.json();
        currentSessionId = session.id;
        topbarTitle.textContent = "New Chat";
        messagesEl.innerHTML = "";
        messagesEl.style.display = "none";
        welcomeScreen.style.display = "";
        updateWelcomeState(true);
        await fetchSessions();
        await fetchAndRenderDocuments();
        closeSidebarOnMobile();
    } catch (e) {
        showToast("Failed to create session", "error");
    }
}

async function loadSession(sessionId) {
    try {
        const res = await fetch(`${API}/api/sessions/${sessionId}`);
        if (!res.ok) throw new Error("Not found");
        const session = await res.json();
        currentSessionId = session.id;
        topbarTitle.textContent = session.title || "New Chat";

        // Render messages
        messagesEl.innerHTML = "";
        if (session.messages && session.messages.length > 0) {
            welcomeScreen.style.display = "none";
            updateWelcomeState(false);
            messagesEl.style.display = "flex";
            session.messages.forEach(m => appendMessage(m.role, m.content, m.image_url, m.source, false));
            scrollToBottom();
        } else {
            messagesEl.style.display = "none";
            welcomeScreen.style.display = "";
            updateWelcomeState(true);
        }

        renderSessionList();
        await fetchAndRenderDocuments();
        closeSidebarOnMobile();
    } catch (e) {
        showToast("Failed to load session", "error");
    }
}

async function deleteSession(sessionId) {
    try {
        await fetch(`${API}/api/sessions/${sessionId}`, { method: "DELETE" });
        if (sessionId === currentSessionId) {
            await createNewSession();
        } else {
            await fetchSessions();
        }
        showToast("Chat deleted", "info");
    } catch (e) {
        showToast("Failed to delete", "error");
    }
}

// ================================================================
// CHAT
// ================================================================

function appendMessage(role, content, imageUrl, source, animate = true) {
    const row = document.createElement("div");
    row.className = `message-row ${role}`;
    if (!animate) row.style.animation = "none";

    const avatar = document.createElement("div");
    avatar.className = `msg-avatar ${role}`;
    if (role === "user") {
        avatar.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
            </svg>
        `;
    } else {
        avatar.innerHTML = `
            <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
            </svg>
        `;
    }

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    if (source === "voice" && role === "user") {
        bubble.innerHTML = `
            <div class="voice-badge">
                <svg class="voice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                </svg>
                Voice Input
            </div>
        `;
    }

    bubble.innerHTML += renderMarkdown(content);

    if (imageUrl) {
        const img = document.createElement("img");
        img.src = imageUrl;
        img.alt = "Visual Context";
        img.loading = "lazy";
        bubble.appendChild(img);
    }

    if (role === "user") {
        row.appendChild(bubble);
        row.appendChild(avatar);
    } else {
        row.appendChild(avatar);
        row.appendChild(bubble);
    }

    messagesEl.appendChild(row);
}

function showTypingIndicator() {
    const el = document.createElement("div");
    el.className = "typing-indicator";
    el.id = "typing";
    el.innerHTML = `
        <div class="msg-avatar assistant">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
            </svg>
        </div>
        <div class="typing-dots"><span></span><span></span><span></span></div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
}

function hideTypingIndicator() {
    const el = document.getElementById("typing");
    if (el) el.remove();
}

function buildWebSocketUrl(path) {
    if (API && API.startsWith("http")) {
        const url = new URL(API + path);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${API}${path}`;
}

async function sendMessage(text, source = "text") {
    if (!text.trim() || isProcessing) return;
    if (!currentSessionId) await createNewSession();

    isProcessing = true;
    sendBtn.classList.remove("enabled");

    // Hide welcome, show messages
    welcomeScreen.style.display = "none";
    updateWelcomeState(false);
    messagesEl.style.display = "flex";

    // Append user message
    appendMessage("user", text, null, source);
    scrollToBottom();

    // Clear input
    messageInput.value = "";
    autoResizeInput();

    // --- Create assistant streaming bubble with loading dots ---
    const row = document.createElement("div");
    row.className = "message-row assistant";
    row.style.animation = "fadeIn 300ms ease";

    const avatar = document.createElement("div");
    avatar.className = "msg-avatar assistant";
    avatar.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble streaming-dots";
    bubble.innerHTML = `<div class="loading-dots"><span></span><span></span><span></span></div>`;

    row.appendChild(avatar);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();

    let fullText = "";
    let firstToken = true;

    try {
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(buildWebSocketUrl("/api/chat/ws"));
            let settled = false;
            let doneReceived = false;

            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                fn(value);
            };

            socket.onopen = () => {
                socket.send(JSON.stringify({
                    session_id: currentSessionId,
                    message: text,
                    source,
                }));
            };

            socket.onmessage = (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch {
                    return;
                }

                if (data.error) {
                    bubble.classList.remove("streaming-dots", "streaming");
                    bubble.innerHTML = renderMarkdown("⚠ " + data.error);
                    socket.close();
                    settle(reject, new Error(data.error));
                    return;
                }

                if (data.token) {
                    if (firstToken) {
                        bubble.classList.remove("streaming-dots");
                        bubble.classList.add("streaming");
                        bubble.innerHTML = "";
                        firstToken = false;
                    }
                    fullText += data.token;
                    bubble.innerHTML = renderMarkdown(fullText);
                    scrollToBottom();
                    return;
                }

                if (data.done) {
                    doneReceived = true;
                    bubble.classList.remove("streaming-dots", "streaming");
                    bubble.innerHTML = renderMarkdown(fullText);
                    if (data.image_url) {
                        const img = document.createElement("img");
                        img.src = data.image_url;
                        img.alt = "Visual Context";
                        img.loading = "lazy";
                        bubble.appendChild(img);
                    }
                    scrollToBottom();
                    socket.close();
                    settle(resolve);
                }
            };

            socket.onerror = () => {
                settle(reject, new Error("WebSocket connection failed"));
            };

            socket.onclose = () => {
                if (!doneReceived) {
                    settle(reject, new Error("WebSocket closed before response completed"));
                }
            };
        });

        // Refresh session list (title may have changed)
        await fetchSessions();
        const session = sessions.find(s => s.id === currentSessionId);
        if (session) topbarTitle.textContent = session.title;

    } catch (e) {
        bubble.classList.remove("streaming-dots", "streaming");
        bubble.innerHTML = renderMarkdown("Sorry, something went wrong. Please try again.");
        showToast("Failed to get response. Is the server running?", "error");
        console.error(e);
    } finally {
        isProcessing = false;
    }
}

// ================================================================
// VOICE RECORDING (MediaRecorder API)
// ================================================================

async function toggleRecording() {
    if (isRecording) {
        stopRecording();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        const chunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            // Stop timer & restore icon
            clearInterval(recordingTimerInterval);
            recordingTimerInterval = null;
            if (originalMicBtnHtml) {
                micBtn.innerHTML = originalMicBtnHtml;
            }
            micBtn.classList.remove("recording");
            isRecording = false;

            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(chunks, { type: "audio/webm" });

            // Send to backend for transcription
            showToast("Transcribing...", "info");
            const formData = new FormData();
            formData.append("file", blob, "recording.webm");

            try {
                const res = await fetch(`${API}/api/transcribe`, {
                    method: "POST",
                    body: formData,
                });
                if (!res.ok) throw new Error("Transcription failed");
                const data = await res.json();
                if (data.transcript && data.transcript.trim()) {
                    sendMessage(data.transcript, "voice");
                } else {
                    showToast("Couldn't catch that. Try again.", "error");
                }
            } catch (e) {
                showToast("Transcription failed", "error");
                console.error(e);
            }
        };

        // Start timer
        originalMicBtnHtml = micBtn.innerHTML;
        micBtn.innerHTML = `
            <div class="audio-wave">
                <span></span>
                <span></span>
                <span></span>
                <span></span>
            </div>
            <span class="recording-timer">00:00</span>
        `;
        recordingSeconds = 0;
        recordingTimerInterval = setInterval(() => {
            recordingSeconds++;
            const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, "0");
            const secs = String(recordingSeconds % 60).padStart(2, "0");
            const timerEl = micBtn.querySelector(".recording-timer");
            if (timerEl) {
                timerEl.textContent = `${mins}:${secs}`;
            }
        }, 1000);

        mediaRecorder.start();
        isRecording = true;
        micBtn.classList.add("recording");
        showToast("Recording... Click mic again to stop", "info");
    } catch (e) {
        clearInterval(recordingTimerInterval);
        recordingTimerInterval = null;
        if (originalMicBtnHtml) {
            micBtn.innerHTML = originalMicBtnHtml;
        }
        micBtn.classList.remove("recording");
        isRecording = false;
        showToast("Microphone access denied", "error");
        console.error(e);
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
}

// ================================================================
// FILE UPLOAD
// ================================================================

async function handleFileUpload(files, sessionId, parseDocument = false) {
    if (!sessionId) {
        showToast("Please open a chat session before uploading documents.", "info");
        return;
    }
    for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        // Create a persistent progress toast
        const progressToast = document.createElement("div");
        progressToast.className = "toast info";
        progressToast.style.animation = "slideIn 300ms ease";
        progressToast.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:6px;">
                <span class="upload-toast-text">${parseDocument ? "Parsing" : "Uploading"} ${file.name}...</span>
                <div class="upload-progress-bar-bg">
                    <div class="upload-progress-bar-fill" style="width:0%"></div>
                </div>
                <span class="upload-toast-detail" style="font-size:12px;opacity:0.8;"></span>
            </div>
        `;
        toastContainer.appendChild(progressToast);

        const toastText = progressToast.querySelector(".upload-toast-text");
        const progressFill = progressToast.querySelector(".upload-progress-bar-fill");
        const toastDetail = progressToast.querySelector(".upload-toast-detail");

        try {
            const query = new URLSearchParams();
            query.set("session_id", sessionId);
            query.set("parse_document", String(parseDocument));
            const url = `${API}/api/upload?${query.toString()}`;
            const res = await fetch(url, {
                method: "POST",
                body: formData,
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Upload failed");
            }

            const contentType = res.headers.get("content-type") || "";

            if (contentType.includes("text/event-stream")) {
                // SSE streaming progress
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop();

                    for (const part of parts) {
                        if (!part.startsWith("data: ")) continue;
                        const jsonStr = part.slice(6).trim();
                        if (!jsonStr) continue;

                        let data;
                        try { data = JSON.parse(jsonStr); } catch { continue; }

                        if (data.status === "parsing" || data.status === "preparing") {
                            progressFill.style.width = "8%";
                            toastText.textContent = data.status === "parsing"
                                ? `Parsing ${file.name}...`
                                : `Preparing ${file.name}...`;
                            toastDetail.textContent = data.message || "Please wait...";
                        } else if (data.status === "embedding" || data.status === "processing") {
                            const pct = data.total_chunks > 0
                                ? Math.round((data.processed / data.total_chunks) * 100)
                                : 0;
                            const visualPct = Math.max(12, pct);
                            progressFill.style.width = visualPct + "%";
                            toastText.textContent = `Embedding ${file.name}...`;
                            toastDetail.textContent = `${data.processed}/${data.total_chunks} chunks (${pct}%)`;
                        } else if (data.status === "error") {
                            throw new Error(data.message || "Upload failed");
                        } else if (data.status === "done") {
                            progressFill.style.width = "100%";
                            progressToast.className = "toast success";
                            toastText.textContent = `${file.name} uploaded!`;
                            toastDetail.textContent = data.parse_enabled
                                ? `${data.chunks} chunks added - parser enabled`
                                : `${data.chunks} chunks added - knowledge only`;
                            if (typeof data.elapsed_seconds === "number") {
                                toastDetail.textContent += ` - ${data.elapsed_seconds}s`;
                            }
                            setTimeout(() => progressToast.remove(), 3500);
                        }
                    }
                }
            } else {
                // Fallback: non-streaming JSON response (small files)
                const data = await res.json();
                progressToast.className = "toast success";
                toastText.textContent = `${file.name} uploaded!`;
                toastDetail.textContent = data.parse_enabled
                    ? `${data.chunks} chunks added - parser enabled`
                    : `${data.chunks} chunks added - knowledge only`;
                progressFill.style.width = "100%";
                setTimeout(() => progressToast.remove(), 3500);
            }
        } catch (e) {
            progressToast.className = "toast error";
            progressToast.querySelector(".upload-toast-text").textContent = `${file.name}: ${e.message}`;
            const detail = progressToast.querySelector(".upload-toast-detail");
            if (detail) detail.remove();
            const bar = progressToast.querySelector(".upload-progress-bar-bg");
            if (bar) bar.remove();
            setTimeout(() => progressToast.remove(), 5000);
        }
    }
    await fetchAndRenderDocuments();
    if (sessionId === currentSessionId) {
        await loadSession(sessionId);
    }
}

// ================================================================
// DOCUMENT MANAGEMENT
// ================================================================

async function fetchAndRenderDocuments() {
    if (currentSessionId) {
        sessionDocsSection.style.display = "block";
        try {
            const res = await fetch(`${API}/api/documents?session_id=${currentSessionId}`);
            const docs = await res.json();
            renderDocsList(docs, sessionDocsListEl, currentSessionId);
        } catch (e) {
            console.error("Failed to fetch session documents:", e);
            renderDocsList([], sessionDocsListEl, currentSessionId);
        }
    } else {
        sessionDocsSection.style.display = "none";
    }
}

function renderDocsList(docs, element, sessionId) {
    element.innerHTML = "";
    if (docs.length === 0) {
        element.innerHTML = '<div style="color:var(--text-muted);font-size:11.5px;padding:4px 0;">No documents uploaded</div>';
        return;
    }

    docs.forEach(doc => {
        const item = document.createElement("div");
        item.className = "uploaded-doc-item";
        const parserStateLabel = doc.parse_enabled ? "Parser" : "Knowledge";
        item.innerHTML = `
            <div class="uploaded-doc-main">
                <span class="uploaded-doc-name ${doc.parse_enabled ? "is-clickable" : "is-disabled"}" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</span>
                <span class="uploaded-doc-mode ${doc.parse_enabled ? "parser" : "knowledge"}">${parserStateLabel}</span>
            </div>
            <button class="uploaded-doc-delete" title="Delete document">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        `;

        item.querySelector(".uploaded-doc-name").addEventListener("click", () => {
            if (!doc.parse_enabled) {
                showToast("This file was uploaded as session knowledge only, so it cannot be opened in Parser.", "info");
                return;
            }
            openDocumentParser(doc.filename, sessionId);
        });

        item.querySelector(".uploaded-doc-delete").addEventListener("click", async (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete "${doc.filename}"?`)) {
                await deleteUploadedDocument(doc.filename, sessionId);
            }
        });

        element.appendChild(item);
    });
}

async function deleteUploadedDocument(filename, sessionId) {
    try {
        const res = await fetch(`${API}/api/documents?filename=${encodeURIComponent(filename)}&session_id=${sessionId}`, {
            method: "DELETE"
        });
        if (!res.ok) throw new Error("Delete failed");
        showToast("Document deleted", "info");
        await fetchAndRenderDocuments();
    } catch (e) {
        showToast("Failed to delete document", "error");
        console.error(e);
    }
}

// ================================================================
// SIDEBAR TOGGLE
// ================================================================

function toggleSidebar() {
    const isCollapsed = sidebar.classList.toggle("collapsed");
    const appEl = document.querySelector(".app");
    if (appEl) {
        appEl.classList.toggle("sidebar-collapsed", isCollapsed);
    }
    sidebarOverlay.classList.toggle("visible", !isCollapsed && window.innerWidth <= 768);
}

function closeSidebarOnMobile() {
    if (window.innerWidth <= 768) {
        sidebar.classList.add("collapsed");
        const appEl = document.querySelector(".app");
        if (appEl) {
            appEl.classList.add("sidebar-collapsed");
        }
        sidebarOverlay.classList.remove("visible");
    }
}

// ================================================================
// EVENT LISTENERS
// ================================================================

// Sidebar toggle
sidebarToggle.addEventListener("click", toggleSidebar);
if (sidebarToggleInner) {
    sidebarToggleInner.addEventListener("click", toggleSidebar);
}
sidebarOverlay.addEventListener("click", () => {
    sidebar.classList.add("collapsed");
    sidebarOverlay.classList.remove("visible");
});

// New chat
newChatBtn.addEventListener("click", createNewSession);

// Text input
messageInput.addEventListener("input", autoResizeInput);
messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(messageInput.value);
    }
});

// Send button
sendBtn.addEventListener("click", () => sendMessage(messageInput.value));

// Mic
micBtn.addEventListener("click", toggleRecording);

// Plus button dropdown menu listeners
if (plusBtn && dropdownMenu) {
    plusBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = dropdownMenu.style.display === "none";
        dropdownMenu.style.display = isHidden ? "flex" : "none";
    });

    // Close dropdown on click outside
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#input-menu-container")) {
            dropdownMenu.style.display = "none";
        }
    });
}

if (menuUploadBtn) {
    menuUploadBtn.addEventListener("click", () => {
        if (dropdownMenu) dropdownMenu.style.display = "none";
        fileInput.click();
    });
}

if (menuParseBtn) {
    menuParseBtn.addEventListener("click", () => {
        if (dropdownMenu) dropdownMenu.style.display = "none";
        openDocumentParser(null, currentSessionId);
    });
}

fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
        handleFileUpload(e.target.files, currentSessionId, false);
        e.target.value = "";
    }
});



// Quick-start cards click handler
document.addEventListener("click", (e) => {
    const card = e.target.closest(".quick-start-card");
    if (card) {
        const prompt = card.getAttribute("data-prompt");
        if (prompt) {
            sendMessage(prompt);
        }
    }
});



// ================================================================
// DOCUMENT PARSER
// ================================================================

function formatTableHtml(markdownTable) {
    const raw = (markdownTable || "").trim();
    if (!raw) return "";
    if (raw.startsWith("<table")) {
        return raw;
    }

    const lines = raw.split("\n");
    if (lines.length < 2) return escapeHtml(markdownTable);

    let html = "<table>";
    let headersParsed = false;

    for (let line of lines) {
        line = line.trim();
        if (!line.startsWith("|") || !line.endsWith("|")) {
            continue;
        }
        
        if (line.includes("---") || line.includes("- -")) {
            continue;
        }

        const cells = line.split("|").slice(1, -1).map(c => c.trim());
        
        if (!headersParsed) {
            html += "<thead><tr>";
            cells.forEach(c => {
                html += `<th>${escapeHtml(c)}</th>`;
            });
            html += "</tr></thead><tbody>";
            headersParsed = true;
        } else {
            html += "<tr>";
            cells.forEach(c => {
                html += `<td>${escapeHtml(c)}</td>`;
            });
            html += "</tr>";
        }
    }
    
    if (headersParsed) {
        html += "</tbody>";
    }
    html += "</table>";
    return html;
}

function getActiveParserOutputTab() {
    const activeTab = document.querySelector(".parser-tab.active");
    return activeTab?.dataset?.tab === "json" ? "json" : "markdown";
}

function updateParserToolbarActions() {
    const activeTab = document.querySelector(".parser-tab.active")?.dataset?.tab;
    const parserTabActions = document.querySelector(".parser-tab-actions");
    if (parserTabActions) {
        parserTabActions.style.visibility = activeTab === "chat" ? "hidden" : "visible";
    }
}

function getParsedMarkdownOutput() {
    if (!parserLayoutData?.pages?.length) return "";

    return parserLayoutData.pages.map(page => {
        const blocks = page.blocks || [];
        const blockText = blocks.map((block, index) => {
            const typeLabel = formatBlockTypeLabel(block.type || "text");
            let content = "";

            if (block.type === "table") {
                content = block.html || block.text || "";
            } else if (isVisualBlockType(block.type)) {
                content = `<::figure::> ${block.description || block.text || "Figure"}`;
            } else {
                content = block.text || block.description || "";
            }

            if (!content.trim()) return "";
            return `${index + 1} - ${typeLabel}\n\n${content.trim()}`;
        }).filter(Boolean).join("\n\n");

        return `# Page ${page.page_number || 1}\n\n${blockText}`.trim();
    }).filter(Boolean).join("\n\n");
}

function getParserOutputPayload() {
    const tab = getActiveParserOutputTab();
    if (tab === "json") {
        return {
            tab,
            extension: "json",
            mime: "application/json",
            text: JSON.stringify(parserLayoutData?.parse_json || parserLayoutData || {}, null, 2),
        };
    }

    return {
        tab,
        extension: "md",
        mime: "text/markdown",
        text: getParsedMarkdownOutput(),
    };
}

function getParserOutputFilename(extension) {
    const base = (parserCurrentFile || "parsed-document")
        .replace(/\.[^.]+$/, "")
        .replace(/[^A-Za-z0-9_.-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "parsed-document";
    return `${base}.parse.${extension}`;
}

function downloadTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function setParserUploadProgress({ visible, text, width, error = false }) {
    const progressEls = [parserUploadProgress, parserFileStripProgress].filter(Boolean);
    const fillEls = [parserProgressBarFill, parserFileStripProgressFill].filter(Boolean);
    const textEls = [parserProgressText, parserFileStripProgressText].filter(Boolean);

    progressEls.forEach(el => {
        el.style.display = visible ? "flex" : "none";
    });
    fillEls.forEach(el => {
        if (typeof width === "string") el.style.width = width;
        el.style.backgroundColor = error ? "var(--danger)" : "";
    });
    textEls.forEach(el => {
        if (text) el.textContent = text;
    });
}

function getDocumentDownloadUrl(filename, sessionId) {
    return `${API}/api/documents/download?filename=${encodeURIComponent(filename)}&session_id=${encodeURIComponent(sessionId)}`;
}

function getFileExtension(filename) {
    const match = String(filename || "").match(/\.([^.]+)$/);
    return match ? match[1].toUpperCase() : "FILE";
}

async function renderParserFileStrip(sessionId = currentSessionId) {
    if (!parserFileStrip || !parserFileThumbs) return;
    if (!sessionId) return;

    parserFileStrip.classList.toggle("collapsed", parserStripCollapsed);
    parserFileThumbs.innerHTML = "";

    try {
        const res = await fetch(`${API}/api/documents?session_id=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error("Could not load files");
        const docs = await res.json();
        const parserDocs = (docs || []).filter(doc => doc.parse_enabled);

        if (parserFileStripTitle) {
            parserFileStripTitle.textContent = `Files (${parserDocs.length})`;
        }

        parserDocs.forEach(doc => {
            const tile = document.createElement("button");
            tile.className = `parser-file-thumb ${doc.filename === parserCurrentFile ? "active" : ""}`;
            tile.title = doc.filename;

            if (isImageFile(doc.filename)) {
                tile.innerHTML = `<img src="${getDocumentDownloadUrl(doc.filename, sessionId)}" alt="${escapeHtml(doc.filename)}">`;
            } else {
                tile.innerHTML = `
                    <div class="parser-file-thumb-fallback">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        <span>${escapeHtml(getFileExtension(doc.filename))}</span>
                    </div>
                `;
            }

            tile.addEventListener("click", () => {
                openDocumentParser(doc.filename, sessionId);
            });
            parserFileThumbs.appendChild(tile);
        });
    } catch (e) {
        console.error("Failed to load parser files:", e);
        if (parserFileStripTitle) parserFileStripTitle.textContent = "Files";
    }
}

function initParserResize() {
    if (!parserWorkspace || !parserResizeHandle) return;

    const savedWidth = Number(localStorage.getItem("parserLeftWidthPercent"));
    if (Number.isFinite(savedWidth) && savedWidth >= 28 && savedWidth <= 72) {
        parserWorkspace.style.setProperty("--parser-left-width", `${savedWidth}%`);
    }

    let dragging = false;

    const setWidthFromClientX = (clientX) => {
        const rect = parserWorkspace.getBoundingClientRect();
        if (!rect.width) return;
        const percent = ((clientX - rect.left) / rect.width) * 100;
        const clamped = Math.min(72, Math.max(28, percent));
        parserWorkspace.style.setProperty("--parser-left-width", `${clamped}%`);
        localStorage.setItem("parserLeftWidthPercent", String(Math.round(clamped)));
        renderBoundingBoxes();
    };

    parserResizeHandle.addEventListener("pointerdown", (e) => {
        if (window.matchMedia("(max-width: 900px)").matches) return;
        dragging = true;
        parserResizeHandle.classList.add("dragging");
        document.body.classList.add("parser-resizing");
        parserResizeHandle.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    parserResizeHandle.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        setWidthFromClientX(e.clientX);
    });

    const stopDragging = (e) => {
        if (!dragging) return;
        dragging = false;
        parserResizeHandle.classList.remove("dragging");
        document.body.classList.remove("parser-resizing");
        try {
            parserResizeHandle.releasePointerCapture(e.pointerId);
        } catch {}
        renderBoundingBoxes();
    };

    parserResizeHandle.addEventListener("pointerup", stopDragging);
    parserResizeHandle.addEventListener("pointercancel", stopDragging);
}

async function openDocumentParser(filename = null, sessionId = null) {
    if (!sessionId) sessionId = currentSessionId;
    if (!sessionId) {
        showToast("Please open a chat session before using Document Parser.", "info");
        return;
    }
    
    parserCurrentFile = filename;
    parserCurrentSessionId = sessionId;
    parserCurrentPage = 1;
    parserSelectedBlockId = null;
    parserChatHistory = [];
    pdfDoc = null;
    
    // Hide main chat, show parser
    mainView.style.display = "none";
    parserView.style.display = "flex";
    
    // Reset tabs
    document.querySelectorAll(".parser-tab").forEach(t => t.classList.remove("active"));
    document.querySelector('.parser-tab[data-tab="markdown"]').classList.add("active");
    
    document.querySelectorAll(".parser-tab-panel").forEach(p => p.classList.remove("active"));
    document.getElementById("parser-panel-markdown").classList.add("active");
    updateParserToolbarActions();
    
    // Clear content
    parsedBlocksList.innerHTML = "";
    if (extractedBlocksList) {
        extractedBlocksList.innerHTML = "";
    }
    parserJsonCode.textContent = "";
    parserChatMessages.innerHTML = `
        <div class="parser-chat-welcome">
            <h3>Document Q&A</h3>
            <p>RAG is enabled for this document. You can ask questions about its content.</p>
        </div>
    `;
    boundingBoxesOverlay.innerHTML = "";
    pdfRenderCanvas.style.display = "none";
    imageRenderView.style.display = "none";
    textRenderView.style.display = "none";
    await renderParserFileStrip(sessionId);
    
    const viewerScroller = document.querySelector(".parser-viewer-scroller");
    const pageControls = document.querySelector(".parser-page-controls");
    
    if (!filename) {
        // Show upload zone, hide viewer content
        if (parserUploadZone) parserUploadZone.style.display = "flex";
        if (viewerScroller) viewerScroller.style.display = "none";
        
        parserFilenameBreadcrumb.textContent = "No document selected";
        if (pageControls) pageControls.style.display = "none";
        
        parsedBlocksList.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); padding: 40px 20px;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 32px; height: 32px; margin-bottom: 12px; opacity: 0.5;">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
                <p>Upload a document in the left pane to start layout analysis.</p>
            </div>
        `;
        return;
    }
    
    // Show viewer content, hide upload zone
    if (parserUploadZone) parserUploadZone.style.display = "none";
    if (viewerScroller) viewerScroller.style.display = "flex";
    if (pageControls) pageControls.style.display = "flex";
    
    parserFilenameBreadcrumb.textContent = filename;
    parsedBlocksList.innerHTML = "Loading layout data...";
    
    try {
        const url = `${API}/api/parse?filename=${encodeURIComponent(filename)}&session_id=${sessionId}`;
        const res = await fetch(url);
        if (!res.ok) {
            let errorMessage = "Parse request failed";
            try {
                const err = await res.json();
                errorMessage = err.detail || errorMessage;
            } catch {}
            throw new Error(errorMessage);
        }
        
        parserLayoutData = await res.json();
        
        // Render raw JSON display
        parserJsonCode.textContent = JSON.stringify(parserLayoutData.parse_json || parserLayoutData, null, 2);
        
        const isPdf = filename.toLowerCase().endsWith(".pdf");
        const isImage = isImageFile(filename);
        const downloadUrl = `${API}/api/documents/download?filename=${encodeURIComponent(filename)}&session_id=${sessionId}`;
        
        if (isPdf) {
            pdfRenderCanvas.style.display = "block";
            const loadingTask = pdfjsLib.getDocument(downloadUrl);
            pdfDoc = await loadingTask.promise;
            await renderPdfPage(1);
        } else if (isImage) {
            imageRenderView.style.display = "block";
            imageRenderView.src = downloadUrl;
            imageRenderView.onload = () => {
                updateParserPageControls();
                renderBoundingBoxes();
            };
        } else {
            textRenderView.style.display = "block";
            renderTextPage(1);
        }
        
        renderParsedBlocks();
        updateParserPageControls();
        
        if (resizeObserver) {
            resizeObserver.disconnect();
        }
        resizeObserver = new ResizeObserver(() => {
            renderBoundingBoxes();
        });
        resizeObserver.observe(parserViewerContainer);
        
    } catch (e) {
        showToast("Failed to load document analysis", "error");
        parsedBlocksList.innerHTML = `<div style="color:var(--danger)">Error: ${e.message}</div>`;
        console.error(e);
    }
}

function isImageFile(filename) {
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(filename || "");
}

async function renderPdfPage(pageNum) {
    if (!pdfDoc) return;
    
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.25 });
        
        const context = pdfRenderCanvas.getContext("2d");
        pdfRenderCanvas.height = viewport.height;
        pdfRenderCanvas.width = viewport.width;
        
        const renderContext = {
            canvasContext: context,
            viewport: viewport
        };
        await page.render(renderContext).promise;
        
        updateParserPageControls();
        
        renderBoundingBoxes();
    } catch (e) {
        console.error("Failed to render PDF page:", e);
    }
}

function renderTextPage(pageNum) {
    const pageData = parserLayoutData?.pages?.find(p => p.page_number === pageNum)
        || parserLayoutData?.pages?.[0];
    if (!pageData) return;

    const pageWidth = pageData.page_width || 800;
    const pageHeight = pageData.page_height || 1050;
    textRenderView.style.width = `${pageWidth}px`;
    textRenderView.style.minHeight = `${pageHeight}px`;
    textRenderView.innerHTML = "";

    pageData.blocks.forEach(block => {
        const blockEl = document.createElement("div");
        blockEl.className = `text-page-block type-${block.type}`;
        blockEl.style.left = `${block.bbox?.[0] || 0}px`;
        blockEl.style.top = `${block.bbox?.[1] || 0}px`;
        blockEl.style.width = `${block.bbox?.[2] || 300}px`;
        blockEl.style.minHeight = `${block.bbox?.[3] || 60}px`;
        blockEl.textContent = block.text || block.description || "";
        textRenderView.appendChild(blockEl);
    });

    updateParserPageControls();
    renderBoundingBoxes();
}

function getParserPageCount() {
    if (pdfDoc) return pdfDoc.numPages;
    return parserLayoutData?.pages?.length || 1;
}

function updateParserPageControls() {
    const totalPages = getParserPageCount();
    parserPageIndicator.textContent = `Page ${parserCurrentPage} / ${totalPages}`;
    parserPrevBtn.disabled = parserCurrentPage <= 1;
    parserNextBtn.disabled = parserCurrentPage >= totalPages;
}

function renderBoundingBoxes() {
    boundingBoxesOverlay.innerHTML = "";
    if (!parserLayoutData || !parserLayoutData.pages) return;
    
    const pageData = parserLayoutData.pages.find(p => p.page_number === parserCurrentPage) 
                     || parserLayoutData.pages[0];
                     
    if (!pageData || !pageData.blocks) return;
    
    const isPdf = parserCurrentFile.toLowerCase().endsWith(".pdf");
    const displayElement = isPdf ? pdfRenderCanvas : (isImageFile(parserCurrentFile) ? imageRenderView : textRenderView);
    
    const displayWidth = displayElement.clientWidth;
    const displayHeight = displayElement.clientHeight;
    
    if (displayWidth === 0 || displayHeight === 0) {
        setTimeout(renderBoundingBoxes, 150);
        return;
    }
    
    const origWidth = pageData.page_width || 800;
    const origHeight = pageData.page_height || 1050;
    
    const scaleX = displayWidth / origWidth;
    const scaleY = displayHeight / origHeight;
    
    const blockOrder = new Map((pageData.blocks || []).map((block, index) => [block.id, index + 1]));
    const renderBlocks = [...pageData.blocks].sort((a, b) => {
        const areaA = (a.bbox?.[2] || 0) * (a.bbox?.[3] || 0);
        const areaB = (b.bbox?.[2] || 0) * (b.bbox?.[3] || 0);
        return areaB - areaA;
    });

    renderBlocks.forEach(block => {
        if (block.overlay === false) return;
        if (!block.bbox || block.bbox.length !== 4) return;
        
        const left = block.bbox[0] * scaleX;
        const top = block.bbox[1] * scaleY;
        const width = block.bbox[2] * scaleX;
        const height = block.bbox[3] * scaleY;
        
        const box = document.createElement("div");
        box.className = `bounding-box type-${block.type}`;
        if (block.id === parserSelectedBlockId) {
            box.classList.add("selected");
        }
        box.dataset.blockId = block.id;
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
        box.style.zIndex = String(getBoundingBoxZIndex(block.type));
        box.title = `${blockOrder.get(block.id) || ""}. ${formatBlockTypeLabel(block.type)}`.trim();
        
        box.addEventListener("mouseenter", () => {
            highlightBlock(block.id);
        });
        box.addEventListener("mouseleave", () => {
            clearHighlight(block.id);
        });
        box.addEventListener("click", () => {
            selectParserBlock(block.id);
            scrollToDetailsBlock(block.id);
        });
        
        boundingBoxesOverlay.appendChild(box);
    });
}

function getBoundingBoxZIndex(type) {
    const normalized = String(type || "").toLowerCase();
    if (normalized === "region") return 0;
    if (normalized === "table") return 1;
    if (["figure", "image", "graph"].includes(normalized)) return 2;
    if (["qr", "barcode", "logo", "signature", "seal"].includes(normalized)) return 3;
    return 4;
}

function attachDescriptionCopyHandler(container, block) {
    const descBtn = container.querySelector('[data-copy-target="description"]');
    if (!descBtn || !block.description) return;

    descBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(block.description).then(() => {
            const original = descBtn.innerHTML;
            descBtn.classList.add("copied");
            descBtn.textContent = "Copied";
            setTimeout(() => {
                descBtn.classList.remove("copied");
                descBtn.innerHTML = original;
            }, 2000);
        }).catch(err => {
            console.error("Failed to copy:", err);
        });
    });
}

function isVisualBlockType(type) {
    return [
        "figure", "logo", "qr", "barcode", "image", "graph",
        "region", "signature", "seal",
    ].includes(type);
}

function formatBlockTypeLabel(type) {
    const normalized = String(type || "text").toLowerCase();
    const labels = {
        text: "Text",
        table: "Table",
        logo: "Logo",
        qr: "QR",
        barcode: "Barcode",
        figure: "Figure",
        image: "Image",
        graph: "Graph",
        region: "Region",
        signature: "Signature",
        seal: "Seal",
        marginalia: "Marginalia",
    };
    return labels[normalized] || `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function getBlockCopyText(block) {
    if (!block) return "";
    if (block.type === "table") {
        return block.html || block.text || "";
    }
    if (isVisualBlockType(block.type)) {
        return block.description || block.text || "";
    }
    return block.text || "";
}

function getBlockDisplayHtml(block) {
    if (block.type === "table") {
        return formatTableHtml(block.html || block.text || "");
    }
    if (isVisualBlockType(block.type)) {
        const figureText = escapeHtml(block.description || block.text || "Figure");
        return `<div class="parsed-block-figure">&lt;::figure::&gt; ${figureText}</div>`;
    }
    const rawText = escapeHtml(block.text || "").replace(/\n/g, "<br>");
    return `<div class="parsed-block-text">${rawText || "<span class=\"parsed-block-empty\">Empty block</span>"}</div>`;
}

function renderParsedBlocks() {
    parsedBlocksList.innerHTML = "";
    if (extractedBlocksList) {
        extractedBlocksList.innerHTML = "";
    }

    if (!parserLayoutData || !parserLayoutData.pages) {
        parsedBlocksList.innerHTML = "No layouts parsed.";
        return;
    }

    const pageData = parserLayoutData.pages.find(p => p.page_number === parserCurrentPage)
                     || parserLayoutData.pages[0];

    if (!pageData || !pageData.blocks) {
        parsedBlocksList.innerHTML = "No blocks found on this page.";
        return;
    }

    pageData.blocks.forEach((block, index) => {
        const item = document.createElement("article");
        item.className = `parsed-block-item type-${block.type}`;
        item.dataset.blockId = block.id;

        const header = document.createElement("div");
        header.className = "block-header";
        header.innerHTML = `
            <div class="block-heading">
                <span class="block-index">${index + 1}</span>
                <span class="block-type-label">${escapeHtml(formatBlockTypeLabel(block.type))}</span>
            </div>
            <div class="block-actions">
                <button class="block-copy-btn" data-copy-target="text" title="Copy block">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                    Copy
                </button>
            </div>
        `;

        const body = document.createElement("div");
        body.className = "block-body";
        body.innerHTML = getBlockDisplayHtml(block);

        item.appendChild(header);
        item.appendChild(body);

        item.querySelector('[data-copy-target="text"]').addEventListener("click", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(getBlockCopyText(block)).then(() => {
                const copyBtn = item.querySelector('[data-copy-target="text"]');
                copyBtn.classList.add("copied");
                copyBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;">
                        <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Copied
                `;
                setTimeout(() => {
                    copyBtn.classList.remove("copied");
                    copyBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        Copy
                    `;
                }, 2000);
            }).catch(err => {
                console.error("Failed to copy:", err);
            });
        });

        item.addEventListener("mouseenter", () => {
            highlightOverlayBox(block.id);
        });
        item.addEventListener("mouseleave", () => {
            clearHighlightOverlayBox(block.id);
        });
        item.addEventListener("click", () => {
            selectParserBlock(block.id);
            scrollToOverlayBox(block.id);
        });

        parsedBlocksList.appendChild(item);
    });
}

function selectParserBlock(blockId) {
    parserSelectedBlockId = blockId;
    document.querySelectorAll(".parsed-block-item").forEach(item => {
        item.classList.toggle("selected", item.dataset.blockId === blockId);
    });
    document.querySelectorAll(".bounding-box").forEach(box => {
        box.classList.toggle("selected", box.dataset.blockId === blockId);
    });
}

function highlightBlock(blockId) {
    document.querySelectorAll(".parsed-block-item").forEach(item => {
        if (item.dataset.blockId === blockId) {
            item.classList.add("highlighted");
        }
    });
}

function clearHighlight(blockId) {
    document.querySelectorAll(".parsed-block-item").forEach(item => {
        if (item.dataset.blockId === blockId) {
            item.classList.remove("highlighted");
        }
    });
}

function scrollToDetailsBlock(blockId) {
    const detailItem = parsedBlocksList.querySelector(`[data-block-id="${blockId}"]`);
    if (detailItem) {
        detailItem.scrollIntoView({ behavior: "smooth", block: "center" });
        detailItem.classList.add("highlighted");
        setTimeout(() => {
            detailItem.classList.remove("highlighted");
        }, 1500);
    }
}

function scrollToOverlayBox(blockId) {
    const box = boundingBoxesOverlay.querySelector(`[data-block-id="${blockId}"]`);
    if (box) {
        box.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        box.classList.add("highlighted");
        setTimeout(() => {
            box.classList.remove("highlighted");
        }, 1500);
    }
}

function highlightOverlayBox(blockId) {
    const box = boundingBoxesOverlay.querySelector(`[data-block-id="${blockId}"]`);
    if (box) {
        box.classList.add("highlighted");
    }
}

function clearHighlightOverlayBox(blockId) {
    const box = boundingBoxesOverlay.querySelector(`[data-block-id="${blockId}"]`);
    if (box) {
        box.classList.remove("highlighted");
    }
}

async function sendParserChatMessage() {
    const text = parserChatInput.value.trim();
    if (!text || !parserCurrentFile || parserChatSendBtn.disabled) return;
    
    parserChatInput.value = "";
    parserChatSendBtn.disabled = true;
    
    // Add User message
    const userMsg = document.createElement("div");
    userMsg.className = "parser-chat-msg user";
    userMsg.textContent = text;
    parserChatMessages.appendChild(userMsg);
    parserChatMessages.scrollTop = parserChatMessages.scrollHeight;
    
    // Add Assistant loading dots
    const loadingMsg = document.createElement("div");
    loadingMsg.className = "parser-chat-msg assistant typing";
    loadingMsg.innerHTML = `<div class="loading-dots"><span></span><span></span><span></span></div>`;
    parserChatMessages.appendChild(loadingMsg);
    parserChatMessages.scrollTop = parserChatMessages.scrollHeight;
    
    try {
        const res = await fetch(`${API}/api/parse/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: parserCurrentSessionId,
                message: text,
                filename: parserCurrentFile,
                chat_history: parserChatHistory
            })
        });
        
        loadingMsg.remove();
        
        if (!res.ok) {
            let errorMessage = "Chat request failed";
            try {
                const errorData = await res.json();
                errorMessage = errorData.detail || errorMessage;
            } catch {}
            throw new Error(errorMessage);
        }
        
        const data = await res.json();
        parserChatHistory = data.chat_history || parserChatHistory;
        
        const assistantMsg = document.createElement("div");
        assistantMsg.className = "parser-chat-msg assistant";
        assistantMsg.innerHTML = renderMarkdown(data.answer);
        parserChatMessages.appendChild(assistantMsg);
        parserChatMessages.scrollTop = parserChatMessages.scrollHeight;
    } catch (e) {
        loadingMsg.remove();
        const errMsg = document.createElement("div");
        errMsg.className = "parser-chat-msg assistant";
        errMsg.textContent = e.message || "Sorry, something went wrong while processing your question.";
        parserChatMessages.appendChild(errMsg);
        parserChatMessages.scrollTop = parserChatMessages.scrollHeight;
        console.error(e);
    } finally {
        parserChatSendBtn.disabled = false;
        parserChatInput.focus();
    }
}

function closeDocumentParser() {
    parserView.style.display = "none";
    mainView.style.display = "flex";
    parserCurrentFile = null;
    parserCurrentSessionId = null;
    pdfDoc = null;
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }
    
    if (currentSessionId) {
        loadSession(currentSessionId);
    }
}

// Parser event listeners
parserPrevBtn.addEventListener("click", () => {
    if (parserCurrentPage > 1) {
        parserCurrentPage--;
        parserSelectedBlockId = null;
        if (pdfDoc) {
            renderPdfPage(parserCurrentPage);
        } else if (!isImageFile(parserCurrentFile)) {
            renderTextPage(parserCurrentPage);
        } else {
            updateParserPageControls();
            renderBoundingBoxes();
        }
        renderParsedBlocks();
    }
});

parserNextBtn.addEventListener("click", () => {
    if (parserCurrentPage < getParserPageCount()) {
        parserCurrentPage++;
        parserSelectedBlockId = null;
        if (pdfDoc) {
            renderPdfPage(parserCurrentPage);
        } else if (!isImageFile(parserCurrentFile)) {
            renderTextPage(parserCurrentPage);
        } else {
            updateParserPageControls();
            renderBoundingBoxes();
        }
        renderParsedBlocks();
    }
});

if (parserOutputDownloadBtn) {
    parserOutputDownloadBtn.addEventListener("click", () => {
        const output = getParserOutputPayload();
        if (!output.text.trim()) {
            showToast("No parsed output to download", "info");
            return;
        }
        downloadTextFile(getParserOutputFilename(output.extension), output.text, output.mime);
    });
}

if (parserOutputCopyBtn) {
    parserOutputCopyBtn.addEventListener("click", () => {
        const output = getParserOutputPayload();
        if (!output.text.trim()) {
            showToast("No parsed output to copy", "info");
            return;
        }

        navigator.clipboard.writeText(output.text).then(() => {
            parserOutputCopyBtn.classList.add("copied");
            showToast("Copied parsed output", "success");
            setTimeout(() => {
                parserOutputCopyBtn.classList.remove("copied");
            }, 1200);
        }).catch(err => {
            console.error("Failed to copy parser output:", err);
            showToast("Failed to copy parsed output", "error");
        });
    });
}

parserCloseBtn.addEventListener("click", closeDocumentParser);

parserChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendParserChatMessage();
    }
});

parserChatSendBtn.addEventListener("click", sendParserChatMessage);

// Switch tabs
document.querySelectorAll(".parser-tab").forEach(tab => {
    tab.addEventListener("click", () => {
        const targetTab = tab.dataset.tab;
        
        document.querySelectorAll(".parser-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        
        document.querySelectorAll(".parser-tab-panel").forEach(p => p.classList.remove("active"));
        
        const panelId = `parser-panel-${targetTab}`;
        const panel = document.getElementById(panelId);
        if (panel) {
            panel.classList.add("active");
        }
        updateParserToolbarActions();
        if (targetTab === "chat") {
            parserChatInput.focus();
        }
    });
});

// ================================================================
// INIT
// ================================================================

async function init() {
    initParserResize();
    await fetchSessions();

    // If we have sessions, load the most recent one
    if (sessions.length > 0) {
        await loadSession(sessions[0].id);
    } else {
        // Create first session
        await createNewSession();
    }

    // Focus input
    messageInput.focus();
}

// Drag and Drop Event Listeners
window.addEventListener("dragenter", (e) => {
    if (e.dataTransfer.types.includes("Files") && parserView.style.display === "none") {
        dragOverlay.style.display = "flex";
    }
});

dragOverlay.addEventListener("dragover", (e) => {
    e.preventDefault();
});

dragOverlay.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null || !dragOverlay.contains(e.relatedTarget)) {
        dragOverlay.style.display = "none";
    }
});

dragOverlay.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragOverlay.style.display = "none";
    if (e.dataTransfer.files.length > 0) {
        handleFileUpload(e.dataTransfer.files, currentSessionId, false);
    }
});

// Function to upload and parse file inside Document Parser view
async function handleParserFileUpload(file, sessionId) {
    if (!sessionId) {
        showToast("Please open a chat session before uploading documents.", "info");
        return;
    }
    if (parserSelectFileBtn) parserSelectFileBtn.disabled = true;
    if (parserFileUploadTile) parserFileUploadTile.disabled = true;
    setParserUploadProgress({ visible: true, text: "Uploading file...", width: "0%" });
    
    const formData = new FormData();
    formData.append("file", file);
    
    try {
        const query = new URLSearchParams();
        query.set("session_id", sessionId);
        query.set("parse_document", "true");
        const url = `${API}/api/upload?${query.toString()}`;
        
        const res = await fetch(url, {
            method: "POST",
            body: formData,
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Upload failed");
        }
        
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop();
                
                for (const part of parts) {
                    if (!part.startsWith("data: ")) continue;
                    const jsonStr = part.slice(6).trim();
                    if (!jsonStr) continue;
                    
                    let data;
                    try { data = JSON.parse(jsonStr); } catch { continue; }
                    
                    if (data.status === "parsing" || data.status === "preparing") {
                        setParserUploadProgress({ visible: true, text: `Parsing: ${data.message || 'running...'}`, width: "25%" });
                    } else if (data.status === "embedding" || data.status === "processing") {
                        const pct = data.total_chunks > 0 ? Math.round((data.processed / data.total_chunks) * 100) : 0;
                        setParserUploadProgress({ visible: true, text: `Embed: ${data.processed}/${data.total_chunks} (${pct}%)`, width: `${50 + pct / 2}%` });
                    } else if (data.status === "error") {
                        throw new Error(data.message || "Processing failed");
                    } else if (data.status === "done") {
                        setParserUploadProgress({ visible: true, text: "Complete!", width: "100%" });
                        showToast(`Document ${file.name} parsed successfully.`, "success");
                        
                        setTimeout(async () => {
                            setParserUploadProgress({ visible: false, text: "Processing...", width: "0%" });
                            if (parserSelectFileBtn) parserSelectFileBtn.disabled = false;
                            if (parserFileUploadTile) parserFileUploadTile.disabled = false;
                            await fetchAndRenderDocuments();
                            await renderParserFileStrip(sessionId);
                            openDocumentParser(file.name, sessionId);
                        }, 800);
                    }
                }
            }
        } else {
            const data = await res.json();
            setParserUploadProgress({ visible: true, text: "Complete!", width: "100%" });
            showToast(`Document ${file.name} parsed successfully.`, "success");
            
            setTimeout(async () => {
                setParserUploadProgress({ visible: false, text: "Processing...", width: "0%" });
                if (parserSelectFileBtn) parserSelectFileBtn.disabled = false;
                if (parserFileUploadTile) parserFileUploadTile.disabled = false;
                await fetchAndRenderDocuments();
                await renderParserFileStrip(sessionId);
                openDocumentParser(file.name, sessionId);
            }, 800);
        }
    } catch (e) {
        setParserUploadProgress({ visible: true, text: `Error: ${e.message}`, width: "100%", error: true });
        if (parserSelectFileBtn) parserSelectFileBtn.disabled = false;
        if (parserFileUploadTile) parserFileUploadTile.disabled = false;
        showToast(`Parse error: ${e.message}`, "error");
        
        setTimeout(() => {
            setParserUploadProgress({ visible: false, text: "Processing...", width: "0%" });
        }, 5000);
    }
}

// Parser Upload Zone event listeners
if (parserSelectFileBtn && parserFileInput) {
    parserSelectFileBtn.addEventListener("click", () => {
        parserFileInput.click();
    });
    
    parserFileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) {
            handleParserFileUpload(e.target.files[0], currentSessionId);
            e.target.value = "";
        }
    });
}

if (parserFileUploadTile && parserFileInput) {
    parserFileUploadTile.addEventListener("click", () => {
        parserFileInput.click();
    });
}

if (parserFileStripToggle && parserFileStrip) {
    parserFileStripToggle.addEventListener("click", () => {
        parserStripCollapsed = !parserStripCollapsed;
        localStorage.setItem("parserFileStripCollapsed", String(parserStripCollapsed));
        parserFileStrip.classList.toggle("collapsed", parserStripCollapsed);
        setTimeout(renderBoundingBoxes, 50);
    });

    parserFileStrip.addEventListener("dragover", (e) => {
        e.preventDefault();
    });

    parserFileStrip.addEventListener("drop", (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) {
            handleParserFileUpload(e.dataTransfer.files[0], currentSessionId);
        }
    });
}

if (parserUploadZone) {
    parserUploadZone.addEventListener("dragenter", (e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) {
            parserUploadZone.classList.add("drag-over");
        }
    });
    
    parserUploadZone.addEventListener("dragover", (e) => {
        e.preventDefault();
    });
    
    parserUploadZone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        parserUploadZone.classList.remove("drag-over");
    });
    
    parserUploadZone.addEventListener("drop", (e) => {
        e.preventDefault();
        parserUploadZone.classList.remove("drag-over");
        if (e.dataTransfer.files.length > 0) {
            handleParserFileUpload(e.dataTransfer.files[0], currentSessionId);
        }
    });
}

// Click event listener for parser trigger links
document.addEventListener("click", (e) => {
    const triggerLink = e.target.closest(".parser-trigger-link");
    if (triggerLink) {
        e.preventDefault();
        const filename = triggerLink.getAttribute("data-filename");
        openDocumentParser(filename, currentSessionId);
    }
});

init();
