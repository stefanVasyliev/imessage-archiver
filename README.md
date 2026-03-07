# iMessage AI Archiver

Automated system that monitors a selected iMessage group chat on macOS, extracts attachments, and organizes them using AI classification and duplicate detection.

The system helps automatically archive construction photos, documents, and videos sent via iMessage into a structured storage system with optional Dropbox synchronization.

---

## Features

- Monitors a specific iMessage group chat
- Automatically extracts new attachments (images, PDFs, videos)
- Detects duplicate images
- Uses AI to classify images by project and phase
- Automatically renames and organizes files
- Fallback storage if AI classification fails
- Optional Dropbox cloud synchronization
- Logging and debugging support

---

## System Flow

```
iMessage Chat
   ↓
chat.db (SQLite)
   ↓
Attachment Extraction
   ↓
Duplicate Detection
   ↓
AI Classification
   ↓
File Naming
   ↓
Archive Storage
```

---

## Tech Stack

- Node.js
- TypeScript
- SQLite
- OpenAI Vision API
- Dropbox (optional)

---

## Project Structure

```
src/
  config/
  db/
  services/
  utils/

storage/
  incoming/
  archive/
  duplicates/
  unsorted/
```

---

## Requirements

- macOS
- Node.js 18+
- OpenAI API key
- Access to iMessage database

---

## Installation

```
git clone https://github.com/your-repo/imessage-ai-archiver.git
cd imessage-ai-archiver
npm install
```

---

## Configuration

Create `.env` file:

```
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4.1-mini
POLL_INTERVAL_SECONDS=15
TARGET_CHAT_ID=1644
APP_STORAGE_ROOT=/Users/username/storage
```

---

## Run

```
npm run dev
```

The system will start monitoring the selected iMessage group chat.

---

## Author

Stefan Vasyliev  