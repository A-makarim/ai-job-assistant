from __future__ import annotations

import io
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Load .env from backend root, then vendor extract_resume module
# ---------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=_BACKEND_ROOT / ".env", encoding="utf-8-sig")
LANGEXTRACT_API_KEY: str = os.environ.get("LANGEXTRACT_API_KEY", "").strip()

sys.path.insert(0, str(_BACKEND_ROOT))
import extract_resume  # vendor module  # noqa: E402

try:
    import langextract as lx
    _HAS_LX = True
except ImportError:
    lx = None  # type: ignore
    _HAS_LX = False

try:
    import pypdf
    _HAS_PYPDF = True
except ImportError:
    _HAS_PYPDF = False

# Gemini model candidates — verified available for this key (run /health to confirm)
_GEMINI_CANDIDATES: List[str] = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
]
# Anthropic fallback
_ANTHROPIC_CANDIDATES: List[str] = [
    "anthropic-claude-3-5-sonnet-latest",
    "anthropic-claude-3-7-sonnet-latest",
    "anthropic-claude-3-5-sonnet-20241022",
]
MAX_INPUT_CHARS = 36000
ROLE_KEYWORDS = (
    "engineer",
    "researcher",
    "intern",
    "assistant",
    "lead",
    "developer",
    "manager",
    "analyst",
    "designer",
    "captain",
    "founder",
)
MONTH_PATTERN = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?"
DATE_RANGE_RE = re.compile(
    rf"({MONTH_PATTERN}\s*\d{{4}}(?:\s*-\s*(?:{MONTH_PATTERN}\s*\d{{4}}|Present))?)",
    re.IGNORECASE,
)
# Matches CV section headers that appear mid-line (not at line start)
_CV_SECTION_RE = re.compile(
    r"(?<=[^\n])\s+"
    r"(Technical\s+Projects|Technical\s+Skills|Work\s+Experience|Professional\s+Experience"
    r"|Education|Experience|Projects|Skills)"
    r"(?=\s+[A-Za-z0-9])",
    re.IGNORECASE,
)


try:
    from google import genai as _genai
    from google.genai import types as _genai_types
    _HAS_GENAI = True
except ImportError:
    _genai = None  # type: ignore
    _genai_types = None  # type: ignore
    _HAS_GENAI = False

_EMBED_MODEL = "gemini-embedding-001"
_EMBED_DIM   = 768
_EMBED_BATCH = 50  # max texts per embedContent call


class EmbedRequest(BaseModel):
    texts: List[str]
    task_type: str = "RETRIEVAL_DOCUMENT"


class StructuredLaneRequest(BaseModel):
    # apiKey is now optional — backend reads key from .env
    # Kept so existing extension payloads don't extend.
    apiKey: Optional[str] = None
    factText: str = ""
    voiceText: str = ""
    companyText: str = ""


app = FastAPI(title="AIIA LangExtract Backend", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _normalize_text(text: str) -> str:
    value = str(text or "")
    value = value.replace("\u2013", "-").replace("\u2014", "-").replace("\ufffd", " ")
    return re.sub(r"\s+", " ", value).strip()


def _canonical_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", text.lower())).strip()


def _truncate_text(text: str) -> str:
    source = str(text or "").strip()
    if len(source) <= MAX_INPUT_CHARS:
        return source
    return source[:MAX_INPUT_CHARS]


def _lane_prompt(lane: str) -> str:
    if lane == "voice":
        return (
            "Extract concrete writing-style cues that help mimic this person's voice. "
            "Capture rhythm, sentence structure, tone markers, and vocabulary preferences. "
            "Each extraction should be a direct quote or paraphrase from the text. "
            "Classify each item as 'tone' or 'voice_pattern'. "
            "Do not invent personal facts."
        )

    if lane == "company":
        return (
            "Extract concrete company and role signals useful for tailoring internship applications. "
            "Capture products, priorities, mission language, key technologies, team expectations, "
            "and engineering culture cues. "
            "Classify each as 'product_priority' or 'engineering_goal'."
        )

    return (
        "Extract concrete personal experience facts for internship applications. "
        "Prioritize measurable outcomes, ownership, tools used, and domain-relevant skills. "
        "When project entries are present, preserve the project name and separate the "
        "description, tools, and outcomes. "
        "Classify each extracted item as one of: education, experience, or project. "
        "Do not infer facts that are not explicitly stated."
    )


def _lane_examples(lane: str) -> List[Any]:
    if not _HAS_LX:
        return []

    if lane == "voice":
        sample_text = "I move fast, but I stay deliberate. I ask specific questions and then ship clean work under pressure."
        return [
            lx.data.ExampleData(
                text=sample_text,
                extractions=[
                    lx.data.Extraction(
                        extraction_class="tone",
                        extraction_text="I move fast, but I stay deliberate.",
                        attributes={"style_cue": "balanced urgency with control"},
                    ),
                    lx.data.Extraction(
                        extraction_class="voice_pattern",
                        extraction_text="I ask specific questions and then ship clean work under pressure.",
                        attributes={"style_cue": "direct, action-first sentence structure"},
                    ),
                ],
            )
        ]

    if lane == "company":
        sample_text = "Cloudflare Workers runs code close to users, reducing latency while improving performance and resilience."
        return [
            lx.data.ExampleData(
                text=sample_text,
                extractions=[
                    lx.data.Extraction(
                        extraction_class="product_priority",
                        extraction_text="Cloudflare Workers runs code close to users, reducing latency",
                        attributes={"signal": "edge compute and low latency"},
                    ),
                    lx.data.Extraction(
                        extraction_class="engineering_goal",
                        extraction_text="improving performance and resilience",
                        attributes={"signal": "reliability and performance at scale"},
                    ),
                ],
            )
        ]

    # Facts lane — use vendor resume examples (defined in extract_resume.py)
    return extract_resume.RESUME_EXAMPLES


def _safe_get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _compose_bullet(lane: str, extraction_text: str, extraction_class: str, attributes: Dict[str, Any]) -> str:
    text = _normalize_text(extraction_text)
    if not text:
        return ""

    parts = [text]

    if lane == "voice":
        cue = _normalize_text(attributes.get("style_cue") or attributes.get("signal") or "")
        if cue:
            parts.append("Style cue: " + cue)
    elif lane == "company":
        signal = _normalize_text(attributes.get("signal") or attributes.get("priority") or "")
        if signal:
            parts.append("Relevance: " + signal)
    else:
        project = _normalize_text(attributes.get("project") or "")
        description = _normalize_text(attributes.get("description") or "")
        tools = _normalize_text(attributes.get("tools") or attributes.get("tool") or "")
        impact = _normalize_text(attributes.get("impact") or attributes.get("outcome") or "")
        skill = _normalize_text(attributes.get("skill") or attributes.get("tool") or "")
        if project:
            parts.append("Project: " + project)
        if description:
            parts.append("Description: " + description)
        if tools:
            parts.append("Tools: " + tools)
        if impact:
            parts.append("Impact: " + impact)
        if skill:
            parts.append("Skill: " + skill)

    if extraction_class:
        parts.append("Type: " + extraction_class)

    return "; ".join(parts)


def _dedup_items(items: List[str], max_items: int) -> List[str]:
    seen_keys: List[str] = []
    output: List[str] = []

    for item in items:
        cleaned = _normalize_text(item).lstrip("- ").strip()
        if len(cleaned) < 18:
            continue

        key = _canonical_key(cleaned)
        if not key:
            continue

        is_dup = any(key == k or _is_near_duplicate(key, k) for k in seen_keys)
        if is_dup:
            continue

        seen_keys.append(key)
        output.append(cleaned)
        if len(output) >= max_items:
            break

    return output


def _to_lines_with_flags(text: str) -> List[Dict[str, Any]]:
    source = str(text or "").replace("\r", "\n")
    source = source.replace("â€¢", "\nâ€¢ ")
    source = source.replace("â—", "\nâ€¢ ")
    source = re.sub(r"\s{2,}", " ", source)
    rows: List[Dict[str, Any]] = []

    for raw in source.split("\n"):
        if not raw or not raw.strip():
            continue
        stripped = raw.strip()
        is_bullet = bool(re.match(r"^[\-\*â€¢]\s+", stripped))
        cleaned = re.sub(r"^[\-\*â€¢â—Â·\?]+\s*", "", stripped).strip()
        if not cleaned:
            continue
        rows.append({"text": cleaned, "is_bullet": is_bullet})

    return rows


def _section_from_line(line: str) -> Tuple[Optional[str], str]:
    value = str(line or "").strip()
    lowered = value.lower().strip(":")
    mapping = [
        ("technical projects", "projects"),
        ("projects", "projects"),
        ("work experience", "experience"),
        ("professional experience", "experience"),
        ("experience", "experience"),
        ("education", "education"),
        ("technical skills", "skills"),
        ("skills", "skills"),
    ]

    for key, section in mapping:
        if lowered == key:
            return section, ""
        if lowered.startswith(key + " "):
            remainder = value[len(key):].strip(" :-")
            return section, remainder

    return None, value


def _has_date_token(text: str) -> bool:
    source = str(text or "")
    return bool(DATE_RANGE_RE.search(source) or re.search(r"\b(19|20)\d{2}\b", source))


def _looks_like_project_header(line: str) -> bool:
    value = str(line or "").strip()
    if "|" not in value or len(value) < 12:
        return False
    lowered = value.lower()
    if lowered.startswith("languages"):
        return False
    if ("@" in lowered) or ("linkedin.com" in lowered) or ("github.com" in lowered):
        return False
    if re.search(r"\+\d{7,}", value):
        return False
    left, right = value.split("|", 1)
    if len(left.strip()) < 4 or len(right.strip()) < 4:
        return False
    if not ("," in right or DATE_RANGE_RE.search(right)):
        return False
    return True


def _parse_project_header(line: str) -> Dict[str, str]:
    value = str(line or "").strip()
    left, right = value.split("|", 1)
    title = left.strip(" :-")
    right_part = right.strip()

    date_match = DATE_RANGE_RE.search(right_part)
    dates = date_match.group(1).strip() if date_match else ""
    tools = right_part.replace(dates, "").strip(" |-")

    return {
        "kind": "project",
        "title": title,
        "dates": dates,
        "tools": tools,
        "details": [],
    }


def _looks_like_experience_header(line: str) -> bool:
    value = str(line or "").strip()
    if len(value) < 8:
        return False
    if value.endswith(".") and len(value.split()) > 14:
        return False
    lowered = value.lower()
    has_role_word = any(word in lowered for word in ROLE_KEYWORDS)
    has_separator = (" - " in value) or (" â€“ " in value)
    if has_role_word or has_separator:
        return True
    if _has_date_token(value) and ("team" in lowered or "lab" in lowered or "society" in lowered):
        return True
    return False


def _strip_dates_for_key(text: str) -> str:
    value = DATE_RANGE_RE.sub(" ", str(text or ""))
    value = re.sub(r"\b(19|20)\d{2}\b", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _shorten(text: str, max_chars: int = 220) -> str:
    value = _normalize_text(text)
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3].rstrip() + "..."


def _build_project_bullet(entry: Dict[str, Any]) -> str:
    title = _shorten(entry.get("title", ""), 140)
    tools = _shorten(entry.get("tools", ""), 170)
    dates = _shorten(entry.get("dates", ""), 60)
    details = [d for d in entry.get("details", []) if d]
    highlights = details[:3]

    parts = [f"Project: {title}"]
    if dates:
        parts.append(f"Dates: {dates}")
    if tools:
        parts.append(f"Tools: {tools}")
    if highlights:
        parts.append("Highlights: " + " | ".join(_shorten(x, 170) for x in highlights))
    return "; ".join(parts)


def _build_experience_bullet(entry: Dict[str, Any]) -> str:
    title = _shorten(entry.get("title", ""), 180)
    details = [d for d in entry.get("details", []) if d]
    highlights = details[:3]

    parts = [f"Experience: {title}"]
    if highlights:
        parts.append("Highlights: " + " | ".join(_shorten(x, 170) for x in highlights))
    return "; ".join(parts)


def _build_education_bullet(entry: Dict[str, Any]) -> str:
    title = _shorten(entry.get("title", ""), 180)
    details = [d for d in entry.get("details", []) if d]
    highlights = details[:2]

    parts = [f"Education: {title}"]
    if highlights:
        parts.append("Details: " + " | ".join(_shorten(x, 170) for x in highlights))
    return "; ".join(parts)


def _token_set(text: str) -> set:
    lowered = _canonical_key(text)
    return {t for t in lowered.split(" ") if len(t) > 2}


def _is_near_duplicate(a: str, b: str) -> bool:
    a_set = _token_set(a)
    b_set = _token_set(b)
    if not a_set or not b_set:
        return False
    overlap = len(a_set & b_set)
    union = len(a_set | b_set)
    if not union:
        return False
    score = overlap / union
    return score >= 0.86


def _dedup_fact_entries(items: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    kept: List[Dict[str, Any]] = []
    dropped = 0

    for item in items:
        key = _canonical_key(item.get("dedup_key", ""))
        if not key:
            key = _canonical_key(item.get("bullet", ""))
        if not key:
            continue

        is_duplicate = False
        for existing in kept:
            existing_key = _canonical_key(existing.get("dedup_key", existing.get("bullet", "")))
            if key == existing_key or _is_near_duplicate(key, existing_key):
                is_duplicate = True
                break

        if is_duplicate:
            dropped += 1
            continue

        kept.append(item)

    return kept, dropped


def _preprocess_cv_text(text: str) -> str:
    # Inject newlines before section headers embedded mid-line
    # e.g. "...Control 2. Education University College London..." → split at "Education"
    result = _CV_SECTION_RE.sub(r"\n\1", text)
    # Merge dates broken across lines: "Oct.\n2025 - Present" → "Oct. 2025 - Present"
    result = re.sub(r"(?<=\w)\.\n(\d{4})", r". \1", result)
    result = re.sub(
        r"\n(" + MONTH_PATTERN + r"\s*\d{4})",
        r" \1",
        result,
        flags=re.IGNORECASE,
    )
    return result


def _extract_structured_fact_entries(text: str) -> Tuple[List[str], Dict[str, Any]]:
    lines = _to_lines_with_flags(_preprocess_cv_text(text))
    if not lines:
        return [], {"duplicatesDropped": 0, "parsedEntries": 0}

    section: Optional[str] = None
    current: Optional[Dict[str, Any]] = None
    entries: List[Dict[str, Any]] = []

    def flush_current() -> None:
        nonlocal current
        if not current:
            return

        details = [_normalize_text(d) for d in current.get("details", []) if _normalize_text(d)]
        cleaned_details = []
        for detail in details:
            lowered = detail.lower()
            if lowered in {"experience", "projects", "technical projects", "education", "skills", "technical skills"}:
                continue
            cleaned_details.append(detail)
        current["details"] = cleaned_details

        if current.get("kind") == "project":
            bullet = _build_project_bullet(current)
            dedup_key = _strip_dates_for_key(current.get("title", "") + " " + current.get("tools", ""))
        elif current.get("kind") == "education":
            bullet = _build_education_bullet(current)
            dedup_key = _strip_dates_for_key(current.get("title", ""))
        else:
            bullet = _build_experience_bullet(current)
            dedup_key = _strip_dates_for_key(current.get("title", ""))

        if bullet and len(bullet) >= 22:
            entries.append({"bullet": bullet, "dedup_key": dedup_key})

        current = None

    i = 0
    while i < len(lines):
        row = lines[i]
        line = row["text"]
        is_bullet = bool(row["is_bullet"])
        section_candidate, remainder = _section_from_line(line)
        if section_candidate:
            flush_current()
            section = section_candidate
            line = remainder
            is_bullet = False
            if not line:
                i += 1
                continue

        if section == "projects":
            if _looks_like_project_header(line):
                flush_current()
                current = _parse_project_header(line)
            elif current is not None:
                current.setdefault("details", []).append(line)
        elif section == "education":
            if not is_bullet and _has_date_token(line) and not _looks_like_project_header(line):
                flush_current()
                current = {"kind": "education", "title": line, "details": []}
            elif current is not None:
                current.setdefault("details", []).append(line)
        elif section == "experience":
            if not is_bullet and _looks_like_experience_header(line):
                flush_current()
                header = line
                if i + 1 < len(lines):
                    nxt = lines[i + 1]
                    nxt_text = nxt["text"]
                    if (not nxt["is_bullet"]) and _has_date_token(nxt_text) and not _has_date_token(header):
                        header = header + " | " + nxt_text
                        i += 1
                current = {"kind": "experience", "title": header, "details": []}
            elif current is not None:
                current.setdefault("details", []).append(line)
        elif section is None:
            if _looks_like_project_header(line):
                flush_current()
                current = _parse_project_header(line)
                section = "projects"
            elif not is_bullet and _looks_like_experience_header(line):
                flush_current()
                current = {"kind": "experience", "title": line, "details": []}
                section = "experience"
            elif current is not None:
                current.setdefault("details", []).append(line)

        i += 1

    flush_current()
    deduped_entries, dropped = _dedup_fact_entries(entries)
    bullets = [item["bullet"] for item in deduped_entries]
    return bullets, {"duplicatesDropped": dropped, "parsedEntries": len(entries)}


def _heuristic_fallback(text: str, lane: str, max_items: int = 60) -> List[str]:
    source = str(text or "").replace("\r", "\n").strip()
    if not source:
        return []

    lines = [line.strip() for line in re.split(r"\n+", source) if line.strip()]
    if len(lines) < 8:
        lines = [s.strip() for s in re.split(r"(?<=[.!?])\s+", source) if s.strip()]

    if lane == "voice":
        lines = ["Voice sample: " + x for x in lines]
    elif lane == "company":
        lines = ["Company signal: " + x for x in lines]
    else:
        lines = ["Experience: " + x for x in lines]

    return _dedup_items(lines, max_items)


def _extract_with_langextract(text: str, lane: str) -> Tuple[List[str], Dict[str, Any]]:
    """Call LangExtract using LANGEXTRACT_API_KEY from .env. Tries Gemini first."""
    source = _truncate_text(text)
    if not source:
        return [], {"fromModel": False, "model": None, "error": None}

    if not LANGEXTRACT_API_KEY:
        items = _heuristic_fallback(source, lane)
        return items, {"fromModel": False, "model": None, "error": "No LANGEXTRACT_API_KEY in .env"}

    prompt_description = _lane_prompt(lane)
    examples = _lane_examples(lane)
    last_error: Optional[str] = None
    candidates = _GEMINI_CANDIDATES[:] + _ANTHROPIC_CANDIDATES

    for model_id in candidates:
        try:
            result = lx.extract(
                text_or_documents=source,
                prompt_description=prompt_description,
                examples=examples,
                model_id=model_id,
                api_key=LANGEXTRACT_API_KEY,
                fence_output=True,
            )

            raw_extractions = _safe_get(result, "extractions", []) or []
            bullets: List[str] = []

            for item in raw_extractions:
                extraction_text = _safe_get(item, "extraction_text", "")
                extraction_class = _safe_get(item, "extraction_class", "")
                attributes = _safe_get(item, "attributes", {}) or {}
                if not isinstance(attributes, dict):
                    attributes = {}

                bullet = _compose_bullet(lane, extraction_text, extraction_class, attributes)
                if bullet:
                    bullets.append(bullet)

            deduped = _dedup_items(bullets, 90 if lane == "voice" else 72)
            return deduped, {"fromModel": True, "model": model_id, "error": None}
        except Exception as err:  # noqa: BLE001
            last_error = str(err)
            continue

    if lane not in ("voice", "company"):
        struct_bullets, _ = _extract_structured_fact_entries(source)
        deduped_struct = _dedup_items(struct_bullets, 72)
        if deduped_struct:
            return deduped_struct, {"fromModel": False, "model": None, "error": last_error}

    fallback = _heuristic_fallback(source, lane, 90 if lane == "voice" else 72)
    return fallback, {"fromModel": False, "model": None, "error": last_error}


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    """Extract plain text from PDF bytes using pypdf."""
    if not _HAS_PYPDF:
        raise HTTPException(
            status_code=500,
            detail="pypdf is not installed. Run: pip install pypdf",
        )
    try:
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        pages_text = []
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                pages_text.append(page_text)
        return "\n\n".join(pages_text)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Failed to read PDF: {exc}") from exc


def _lane_response(text: str, lane: str) -> Dict[str, Any]:
    items, meta = _extract_with_langextract(text, lane)
    return {
        "text": "\n".join("- " + item for item in items),
        "stats": {
            "items": len(items),
            "sourceRefs": 0,
            "fromModel": bool(meta.get("fromModel")),
            "provider": "langextract",
            "model": meta.get("model"),
            "error": meta.get("error"),
            "duplicatesDropped": 0,
            "parsedEntries": len(items),
        },
    }


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "aiia-langextract-backend",
        "version": "2.0.0",
        "has_api_key": bool(LANGEXTRACT_API_KEY),
        "has_pypdf": _HAS_PYPDF,
        "has_langextract": _HAS_LX,
    }


@app.post("/embed")
async def embed_texts(payload: EmbedRequest) -> Dict[str, Any]:
    """Embed a list of texts using gemini-embedding-001 (768-dim Matryoshka).
    task_type: RETRIEVAL_DOCUMENT (for chunks) or RETRIEVAL_QUERY (for queries).
    """
    if not LANGEXTRACT_API_KEY:
        raise HTTPException(status_code=500, detail="LANGEXTRACT_API_KEY not set in .env")
    if not _HAS_GENAI:
        raise HTTPException(status_code=500, detail="google-genai package not installed")

    clean_texts = [str(t).strip() for t in (payload.texts or []) if str(t).strip()]
    if not clean_texts:
        raise HTTPException(status_code=400, detail="No texts provided")

    task = payload.task_type if payload.task_type in (
        "RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY", "SEMANTIC_SIMILARITY", "CLASSIFICATION", "CLUSTERING"
    ) else "RETRIEVAL_DOCUMENT"

    client = _genai.Client(api_key=LANGEXTRACT_API_KEY)
    all_embeddings: List[List[float]] = []

    for i in range(0, len(clean_texts), _EMBED_BATCH):
        batch = clean_texts[i: i + _EMBED_BATCH]
        result = client.models.embed_content(
            model=_EMBED_MODEL,
            contents=batch,
            config=_genai_types.EmbedContentConfig(
                task_type=task,
                output_dimensionality=_EMBED_DIM,
            ),
        )
        all_embeddings.extend([list(e.values) for e in result.embeddings])

    return {
        "ok": True,
        "model": _EMBED_MODEL,
        "dimension": _EMBED_DIM,
        "count": len(all_embeddings),
        "embeddings": all_embeddings,
    }


@app.post("/extract-resume-pdf")
async def extract_resume_pdf(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Accept a PDF upload and return structured grouped JSON extraction."""
    if not LANGEXTRACT_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="LANGEXTRACT_API_KEY is not set in backend/.env",
        )

    filename = file.filename or ""
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    text = _extract_pdf_text(pdf_bytes)
    if len(text.strip()) < 50:
        raise HTTPException(
            status_code=422,
            detail="Could not extract readable text from the PDF. Ensure it is a text-based (not scanned) PDF.",
        )

    result = extract_resume.extract_from_text(text, LANGEXTRACT_API_KEY)
    return {
        "ok": result["ok"],
        "filename": filename,
        "charCount": len(text),
        "model": result.get("model"),
        "error": result.get("error"),
        "rawCount": result.get("raw_count", 0),
        "grouped": result.get("grouped", {}),
        "textPreview": text[:800].strip(),
    }


@app.post("/extract-structured-lanes")
def extract_structured_lanes(payload: StructuredLaneRequest) -> Dict[str, Any]:
    """Extract structured bullets for fact / voice / company lanes.
    API key is read from .env — the apiKey field in the request body is ignored.
    """
    if not LANGEXTRACT_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="LANGEXTRACT_API_KEY is not set in backend/.env",
        )

    fact = _lane_response(payload.factText, "facts")
    voice = _lane_response(payload.voiceText, "voice")
    company = _lane_response(payload.companyText, "company")

    return {
        "ok": True,
        "structured": {
            "factText": fact["text"],
            "voiceText": voice["text"],
            "companyText": company["text"],
            "stats": {
                "fact": fact["stats"],
                "voice": voice["stats"],
                "company": company["stats"],
            },
        },
    }
