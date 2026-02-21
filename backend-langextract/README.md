# LangExtract Backend

FastAPI service providing Gemini neural embeddings and structured lane extraction for the extension.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check — returns model name and key status |
| POST | `/embed` | Embed text chunks via `gemini-embedding-001` |
| POST | `/extract-structured-lanes` | Structured extraction of fact/voice/company lanes |

## Local development

```bash
cd backend-langextract
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt
```

Create `.env` in this directory:

```
LANGEXTRACT_API_KEY=your_google_api_key_here
```

Start:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Verify: `http://127.0.0.1:8787/health`

