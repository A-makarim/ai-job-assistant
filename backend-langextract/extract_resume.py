"""
extract_resume.py — Resume extraction module using LangExtract (Google Gemini).

Public API:
  group_extractions(extractions) -> dict   (used by vendor_main.py)
  extract_from_text(text, api_key) -> dict (used by the FastAPI backend)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

import langextract as lx

# ---------------------------------------------------------------------------
# Model candidates (Google Gemini via AI Studio key)
# ---------------------------------------------------------------------------
DEFAULT_MODEL_CANDIDATES: List[str] = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
]

MAX_INPUT_CHARS = 40_000

# ---------------------------------------------------------------------------
# Extraction prompt — comprehensive resume parser with structured output
# ---------------------------------------------------------------------------
RESUME_EXTRACTION_PROMPT = (
    "You are a meticulous resume parser. "
    "Extract every distinct piece of information from the resume and classify each into one of these classes:\n"
    "  - contact    : name, email, phone, LinkedIn, GitHub, location\n"
    "  - education  : degree, institution, dates, GPA, achievements, relevant modules\n"
    "  - experience : job title, company, dates, responsibilities, tools, measurable outcomes\n"
    "  - project    : project name, technologies/tools, description, outcomes/impact, dates\n"
    "  - skill      : technical skills, languages, frameworks, tools, certifications\n\n"
    "Rules:\n"
    "  1. Extract EVERY experience, project, and education entry as a SEPARATE item.\n"
    "  2. Preserve exact titles, dates, company names, and numbers.\n"
    "  3. Include measurable results (e.g. '40% faster', 'won 1st prize') in the impact attribute.\n"
    "  4. Do NOT invent or infer facts not present in the resume text.\n"
    "  5. For projects, list all technologies in the tools attribute.\n"
    "  6. For skills sections, produce one extraction_class='skill' item per line or per category."
)

# ---------------------------------------------------------------------------
# Few-shot examples
# ---------------------------------------------------------------------------
_SAMPLE_RESUME = """
Alex Johnson
alex.johnson@email.com | +44 7700 000000 | linkedin.com/in/alexjohnson | github.com/alexjohnson

Education
Westfield University                                          Sep 2020 – June 2024
Bachelor of Science in Computer Science – First Class         London, UK
Achievements: Dean's List 2022–2024, TA for Data Structures
Modules: Machine Learning, Distributed Systems, Algorithms

Experience
Software Engineering Intern                                   Jun 2023 – Aug 2023
TechCorp · Platform Team · London, UK
- Built REST API endpoints reducing average response time by 40%.
- Automated CI/CD pipeline using Docker and GitHub Actions.

Technical Projects
SmartRoute: Delivery Optimization | Python, React, Google Maps API    Jun 2023
- Real-time routing algorithm cut delivery time by 25%.
- Won 1st Prize at University Hackathon 2023.

Technical Skills
Languages: Python, Java, JavaScript, TypeScript, SQL
Frameworks: FastAPI, React, Docker, Git, PyTorch
""".strip()

RESUME_EXAMPLES: List[lx.data.ExampleData] = [
    lx.data.ExampleData(
        text=_SAMPLE_RESUME,
        extractions=[
            lx.data.Extraction(
                extraction_class="contact",
                extraction_text="Alex Johnson | alex.johnson@email.com | linkedin.com/in/alexjohnson | github.com/alexjohnson",
                attributes={
                    "name": "Alex Johnson",
                    "email": "alex.johnson@email.com",
                    "linkedin": "linkedin.com/in/alexjohnson",
                    "github": "github.com/alexjohnson",
                },
            ),
            lx.data.Extraction(
                extraction_class="education",
                extraction_text="Westfield University Sep 2020 – June 2024",
                attributes={
                    "institution": "Westfield University",
                    "degree": "Bachelor of Science in Computer Science, First Class",
                    "dates": "Sep 2020 – June 2024",
                    "location": "London, UK",
                    "impact": "Dean's List 2022–2024, TA for Data Structures",
                    "modules": "Machine Learning, Distributed Systems, Algorithms",
                },
            ),
            lx.data.Extraction(
                extraction_class="experience",
                extraction_text="Software Engineering Intern Jun 2023 – Aug 2023",
                attributes={
                    "title": "Software Engineering Intern",
                    "company": "TechCorp · Platform Team",
                    "dates": "Jun 2023 – Aug 2023",
                    "location": "London, UK",
                    "description": "Built REST API endpoints and automated CI/CD pipeline.",
                    "tools": "Docker, GitHub Actions",
                    "impact": "Reduced average API response time by 40%.",
                },
            ),
            lx.data.Extraction(
                extraction_class="project",
                extraction_text="SmartRoute: Delivery Optimization | Python, React, Google Maps API",
                attributes={
                    "project": "SmartRoute: Delivery Optimization",
                    "tools": "Python, React, Google Maps API",
                    "dates": "Jun 2023",
                    "description": "Real-time routing algorithm and fleet management dashboard.",
                    "impact": "Reduced delivery time by 25%. Won 1st Prize at University Hackathon 2023.",
                },
            ),
            lx.data.Extraction(
                extraction_class="skill",
                extraction_text="Languages: Python, Java, JavaScript, TypeScript, SQL",
                attributes={
                    "category": "Languages",
                    "items": "Python, Java, JavaScript, TypeScript, SQL",
                },
            ),
            lx.data.Extraction(
                extraction_class="skill",
                extraction_text="Frameworks: FastAPI, React, Docker, Git, PyTorch",
                attributes={
                    "category": "Frameworks",
                    "items": "FastAPI, React, Docker, Git, PyTorch",
                },
            ),
        ],
    )
]

# ---------------------------------------------------------------------------
# group_extractions — used by vendor_main.py (groups by extraction_class)
# ---------------------------------------------------------------------------
_CLASS_TO_BUCKET: Dict[str, str] = {
    "contact": "contact",
    "education": "education",
    "experience": "experience",
    "project": "projects",
    "projects": "projects",
    "skill": "skills",
    "skills": "skills",
    "tone": "voice_style",
    "voice_pattern": "voice_style",
    "product_priority": "company_signals",
    "engineering_goal": "company_signals",
}


def group_extractions(extractions: List[Any]) -> Dict[str, Any]:
    """Group a flat list of extraction objects into a structured dict.

    Each item may be a dict or an object with .extraction_class /
    .extraction_text / .attributes attributes (matches vendor_main.py usage).
    """
    buckets: Dict[str, List[Dict[str, Any]]] = {}

    for ex in extractions:
        if isinstance(ex, dict):
            cls = str(ex.get("extraction_class") or "other")
            text = str(ex.get("extraction_text") or "")
            attrs = ex.get("attributes") or {}
        else:
            cls = str(getattr(ex, "extraction_class", None) or "other")
            text = str(getattr(ex, "extraction_text", None) or "")
            attrs = getattr(ex, "attributes", None) or {}

        if not isinstance(attrs, dict):
            attrs = {}

        bucket = _CLASS_TO_BUCKET.get(cls, "other")
        buckets.setdefault(bucket, []).append(
            {"text": text, "type": cls, **attrs}
        )

    # Always include the main buckets even if empty, for predictable schema
    canonical_order = [
        "contact", "education", "experience", "projects",
        "skills", "voice_style", "company_signals", "other",
    ]
    result: Dict[str, Any] = {}
    for key in canonical_order:
        if key in buckets:
            result[key] = buckets[key]
    # Any unexpected buckets appended at end
    for key, val in buckets.items():
        if key not in result:
            result[key] = val

    return result


# ---------------------------------------------------------------------------
# extract_from_text — main extraction pipeline called by the API backend
# ---------------------------------------------------------------------------
def _safe_get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def extract_from_text(
    text: str,
    api_key: str,
    model_candidates: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Run LangExtract on resume text and return structured grouped JSON.

    Returns a dict:
      {
        "ok": bool,
        "model": str | None,
        "error": str | None,
        "grouped": { ...grouped by class... },
        "raw_count": int,
      }
    """
    source = str(text or "").strip()
    if len(source) > MAX_INPUT_CHARS:
        source = source[:MAX_INPUT_CHARS]

    if not source:
        return {"ok": False, "model": None, "error": "Empty text", "grouped": {}, "raw_count": 0}

    candidates = model_candidates or DEFAULT_MODEL_CANDIDATES
    last_error: Optional[str] = None

    for model_id in candidates:
        try:
            result = lx.extract(
                text_or_documents=source,
                prompt_description=RESUME_EXTRACTION_PROMPT,
                examples=RESUME_EXAMPLES,
                model_id=model_id,
                api_key=api_key,
                fence_output=True,
            )

            raw_extractions = _safe_get(result, "extractions", []) or []

            grouped = group_extractions(raw_extractions)
            return {
                "ok": True,
                "model": model_id,
                "error": None,
                "grouped": grouped,
                "raw_count": len(raw_extractions),
            }
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            continue

    return {
        "ok": False,
        "model": None,
        "error": last_error,
        "grouped": {},
        "raw_count": 0,
    }
