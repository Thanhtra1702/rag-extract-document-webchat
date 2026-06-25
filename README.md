# OmniChat RAG 🚀

OmniChat RAG là một ứng dụng trợ lý ảo AI cao cấp (ChatGPT/Gemini-style) tích hợp tìm kiếm cơ sở tri thức động (Retrieval-Augmented Generation - RAG). Ứng dụng cho phép người dùng trò chuyện tự nhiên với các tài liệu cá nhân được tải lên trực tiếp tại thời điểm chạy.

---

## ✨ Tính Năng Nổi Bật

- **💻 Giao diện Premium Dark Mode**: Thiết kế tối giản, hiện đại lấy cảm hứng từ ChatGPT và Gemini với hiệu ứng chuyển động mượt mà.
- **📂 Hỗ trợ Đa định dạng Tài liệu**: Tải lên trực tiếp các file `.pdf`, `.docx`, `.txt`, `.csv`, `.json`, `.xlsx`, `.md`, `.pptx` để đưa vào cơ sở tri thức (Knowledge Base).
  - **Tối ưu hóa JSON**: Tự động lọc thẻ HTML và flatten JSON lồng nhau thành văn bản dễ đọc để các LLM nhỏ hiểu tốt hơn.
- **📡 Streaming Phản hồi (SSE)**: Trả câu trả lời dạng gõ chữ từng ký tự mượt mà (typewriter effect) thông qua cơ chế Server-Sent Events.
- **💬 Trạng thái Chờ thông minh**: 
  - Hiển thị hiệu ứng **3 dấu chấm nhấp nhô** (Bouncing Dots) ngay khi gửi câu hỏi để tạo cảm giác phản hồi tức thì.
  - Hiển thị **3 dấu chấm nhấp nháy** ở cuối văn bản khi nội dung đang được in ra thay vì con trỏ gạch dọc truyền thống.
- **🎙️ Trò chuyện bằng Giọng nói (Voice Input)**: Thu âm giọng nói trực tiếp qua micro với giao diện hiệu ứng **sóng âm thanh (Audio Wave)** và **đồng hồ đếm thời gian** thu âm. Tự động chuyển đổi sang văn bản bằng mô hình **Faster-Whisper** chạy trực tiếp trên CPU.
- **🖼️ Trích dẫn ngữ cảnh trực quan (Visual Context)**: Tự động đính kèm hình ảnh minh họa từ tài liệu nguồn nếu câu trả lời sử dụng thông tin từ tài liệu đó. (Hỗ trợ đọc ảnh từ metadata và quét link trực tiếp trong nội dung văn bản).
- **🎭 Phong Cách Trả Lời Thích Ứng (Adaptive Tone)**: Trợ lý ảo tự động phân tích và bắt chước phong cách nói chuyện của người dùng (gần gũi teen-code, trang trọng, lịch sự, hài hước) để tạo sự kết nối tự nhiên, không bị máy móc.
- **📁 Quản lý Lịch sử Chat chuyên nghiệp**: 
  - Sidebar quản lý các phiên chat cũ/mới (History sessions) lưu trữ cục bộ dưới dạng file JSON.
  - Nút đóng/mở sidebar linh hoạt ở cả góc chính và góc phụ, tự động ẩn thanh bar khi sidebar mở để tối ưu không gian hiển thị.
- **📤 Upload Tài liệu lớn với Thanh Tiến Trình**: 
  - Xử lý tài liệu theo **batch (20 chunks/batch)** để tránh quá tải mô hình embedding.
  - Hiển thị **thanh tiến trình (progress bar) real-time** trong toast notification khi upload, cho biết chính xác số chunks đã xử lý / tổng số chunks.
  - Tự động retry từng chunk riêng lẻ nếu một batch bị lỗi.
- **📋 Quản lý Tài liệu đã Upload**: 
  - Hiển thị danh sách các tài liệu đã upload trong sidebar (Knowledge Base & Session Files).
  - Hỗ trợ xóa từng tài liệu trực tiếp từ giao diện.

---

## 🛠️ Công Nghệ Sử Dụng

### Backend (Python & LangChain Stack)
- **FastAPI**: Khung phát triển API hiệu năng cao với hỗ trợ StreamingResponse và SSE.
- **LangChain**: Xây dựng luồng xử lý RAG (`create_history_aware_retriever`, `create_retrieval_chain`).
- **ChromaDB**: Cơ sở dữ liệu vector lưu trữ nhúng (embeddings) tài liệu cục bộ tại thư mục `./db`.
- **Ollama**:
  - LLM: `qwen2.5:3b` (mô hình nhẹ và mạnh mẽ cho Tiếng Việt và Tiếng Anh).
  - Embeddings: `bge-m3` (được tối ưu hóa tối đa cho RAG).
- **Faster-Whisper**: Chuyển giọng nói thành văn bản từ file âm thanh WebM.

### Frontend (Modern SPA)
- **HTML5 & CSS3**: Giao diện Responsive cao cấp, hỗ trợ hoàn hảo cả máy tính lẫn thiết bị di động.
- **JavaScript (ES6+)**: Xử lý logic Single Page Application (SPA), đọc luồng SSE stream reader, xử lý thu âm MediaRecorder API, quản lý trạng thái tải.

---

## 🚀 Hướng Dẫn Cài Đặt

### 1. Yêu cầu hệ thống
- Python 3.10 trở lên.
- [Ollama](https://ollama.com/) đã được cài đặt và đang chạy ngầm.

### 2. Tải các mô hình cần thiết trên Ollama
Mở Terminal / Command Prompt và chạy lệnh:
```bash
# Tải mô hình LLM chính
ollama pull qwen2.5:3b

# Tải mô hình nhúng văn bản
ollama pull bge-m3
```

### 3. Cài đặt các thư viện Python
Kích hoạt môi trường ảo (Virtual Environment) của bạn và cài đặt các phụ thuộc:
```bash
pip install fastapi uvicorn pydantic PyPDF2 python-docx openpyxl python-pptx langchain langchain-chroma langchain-ollama faster-whisper

# Khuyến nghị cho pipeline parse document theo layout -> OCR/VLM
pip install pymupdf easyocr opencv-python

# Tùy chọn: nếu muốn dùng layoutparser với model ngoài
pip install layoutparser

# Khuyến nghị mạnh cho scanned PDF/form parsing
pip install paddlepaddle paddleocr
```

Biến môi trường liên quan đến pipeline document:
```bash
# Tùy chọn: model layoutparser nếu bạn có endpoint/model tương thích
set OMNICHAT_LAYOUT_MODEL=lp://PubLayNet/faster_rcnn_R_50_FPN_3x/config
```

### 4. Khởi chạy ứng dụng
Chạy script chính để kích hoạt server FastAPI:
```bash
python server.py
```
Ứng dụng sẽ tự động chạy tại: [http://localhost:8000](http://localhost:8000)

---

## 📂 Cấu Trúc Thư Mục Dự Án

```text
├── chat_sessions/          # Thư mục lưu trữ lịch sử chat dưới dạng file JSON
├── db/                     # Cơ sở dữ liệu Vector ChromaDB
├── static/                 # Giao diện Frontend (SPA)
│   ├── index.html          # Khung cấu trúc HTML
│   ├── style.css           # Định nghĩa CSS & Animations
│   └── app.js              # Xử lý Logic JavaScript (Stream Reader, Mic, Upload Progress)
├── file_processor.py       # Trích xuất văn bản từ tài liệu (.pdf, .docx, .xlsx, .json, ...)
├── config.py               # Cấu hình runtime và nạp mô hình Ollama/Whisper
├── rag_engine.py           # Core xử lý RAG (Retrieval-Augmented Generation)
└── server.py               # API FastAPI và điểm chạy server chính
```

---

## 💡 Lưu Ý Khi Sử Dụng

- **Tài liệu theo phiên chat**: Mọi tài liệu tải lên chỉ được lưu và tra cứu trong phiên chat hiện tại. Các phiên chat khác không thể truy cập tài liệu này.
- **File lớn**: Các tài liệu lớn (ví dụ: file JSON > 500KB) sẽ được xử lý theo batch với thanh tiến trình real-time. Quá trình này có thể mất vài phút tùy dung lượng file.
- **Microphone**: Đảm bảo micrô đã được cấp quyền truy cập đầy đủ trên trình duyệt nếu bạn muốn sử dụng tính năng Voice Input.
- **Ollama**: Đảm bảo Ollama đang chạy trước khi khởi động ứng dụng. Nếu gặp lỗi kết nối embedding, hãy kiểm tra lại trạng thái Ollama bằng lệnh `ollama list`.
# rag-extract-document-webchat
