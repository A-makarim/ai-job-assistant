# AI Job Voice (Chrome Extension)

Let math do the work!

I was taught PCAs in my last term ML module. Here's another way I'm using math to solve a real-life problem. (So humans like can work smart, save time, and watch more movies)

A Chrome extension that fills job application fields in your own voice, powered by Gemini semantic embedding and Claude.

## How it works

1. You store your experiences, CV, writing samples, and LinkedIn bio in the extension's settings (basically tons and tons of data)
2. Text is chunked, embedded (locally or via Gemini neural embeddings), and indexed.
3. On any job application page, click **✨ Fill in my Voice** next to a field.
4. The extension retrieves the most relevant chunks from each lane, calls Claude, and inserts a grounded, personalised answer.

If someone is more interested:
All your data is broken into chunks. Its converted to a high dimentional vector. I used PCA to squash it to 3D for visualization playground. 

Next up, your job application advert and questions are also broken down in parallel chunks. They are vectorized. 
Here is the fun part:
You take the data from your profile that best matches the job application. This is pure math. Your data and requirements are compared in a high dimension. And most relevant aspects of your credentials are picked. Again, I've made a small playground at the bottom of extension page. Try searching in a query, and see it link to nearest vector points. In 3D, they might look further apart but they are the best embedding alignments. I'm using google's API for this. Any other algorithm can also be used. You will not need to bring a gemini API for this one. But to generate automatics best-fit cover letters or application questions, you will need Claude's API. 

---

## Architecture

```
Chrome Extension (MV3)
├── content.js          Field detection, button injection, SPA observer, scraping
├── background.js       RAG orchestration: retrieval → evidence → Claude prompt → answer
├── popup.html/js       Per-site toggle, LinkedIn/company scrape, cover letter review panel
├── options.html/js     Data entry, file upload, indexing, generation settings
├── utils/
│   ├── vectorStore.js  Chunking, hash + neural embeddings, cosine similarity search
│   └── fileParser.js   PDF / DOCX / plain-text extraction
└── vendor/             jsPDF, Mammoth (DOCX), PDF.js (bundled, no CDN)

Backend (optional, greatly improves retrieval accuracy)
└── backend-langextract/
    └── app/main.py     FastAPI — Gemini neural embeddings + structured lane extraction
```

**Five retrieval lanes:** Experience · CV/Resume · Voice (your past writing) · About Me/LinkedIn · Company context. Each lane is indexed independently and can be reindexed individually without a full rebuild.

---

## Extension setup

### Requirements
- Google Chrome (or Chromium-based browser)
- An [Anthropic API key](https://console.anthropic.com/)

### Install (unpacked)
1. `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select the repo root folder (the one containing `manifest.json`)
3. Pin the extension icon

### Configure
1. Click the extension icon → **Open Full Settings**
2. Paste your **Anthropic API key**
3. Add content to the five lanes (paste, upload PDF/DOCX, or scrape from the popup)
4. Optionally set the **LangExtract Backend URL** (see backend section)
5. Click **Save & Reindex**

### Use
- Navigate to a job application page
- Open the popup → enable for this site
- Text inputs and textareas show a **✨ Fill in my Voice** button
- Use **Scrape Company** then **Generate Cover Letter PDF** from the popup for a full cover letter

---

## Backend (neural embeddings)

The backend is optional but strongly recommended — it upgrades retrieval from local hash vectors to Gemini `gemini-embedding-001` neural embeddings and runs structured lane extraction via LangExtract.

For backend you can use: https://ai-job-assistant-7and.onrender.com

Paste it into lang-extract backend field box. 

As I'm on free tier, backend might take some time to wake up in a long time. Please raise an issue if it's not working.

Alternatively, you can also run backend locally: 

### Run locally

```bash
cd backend-langextract
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
```

Create `backend-langextract/.env`:
```
LANGEXTRACT_API_KEY=your_google_api_key_here
```

Start the server:
```bash
uvicorn app.main:app --host 127.0.0.1 --port 8787
```

In extension settings, set **LangExtract Backend URL** to `http://127.0.0.1:8787` and click **Save & Reindex**.


## Generation settings

In **Full Settings → Generation Settings** you can tune:

| Setting | Description |
|---|---|
| **Additional prompt instructions** | Appended to every fill-in and cover letter prompt |
| **Temperature** | 0.05 (focused/deterministic) → 1.0 (creative/varied) |
| **Chunks per lane** | How many retrieved context snippets Claude sees from each lane |

Chunk sliders update their maximum automatically after each index/reindex.

---

## Privacy

- All personal data stays in Chrome's local storage — nothing is sent to any server other than `api.anthropic.com` (for Claude) and your configured backend URL.
- The Anthropic API key is stored locally and never logged or transmitted elsewhere.
- The backend only receives text you explicitly send during indexing; it does not store anything.

---

## License

MIT
