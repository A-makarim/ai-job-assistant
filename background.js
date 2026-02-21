importScripts("utils/vectorStore.js");

"use strict";

var SETTINGS_KEY = "aiia_settings";
var INDEX_KEY = "aiia_indexes";
var ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
var LANGEXTRACT_BACKEND_DEFAULT_URL = "http://127.0.0.1:8787";
var MODEL_FALLBACK_IDS = [
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022"
];
var MODEL_HINTS = ["sonnet-4-5", "sonnet-4", "3-7-sonnet", "3-5-sonnet", "haiku"];
var cachedModelId = null;
var ROLE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "their", "into", "about", "have", "will", "would",
  "should", "could", "our", "you", "are", "job", "role", "team", "company", "intern", "internship", "position", "page",
  "cloudflare", "summer", "london", "application", "hiring", "candidate", "using", "build", "built", "work", "working",
  "skills", "experience", "requirements", "responsibilities", "qualifications", "what", "who", "where", "when", "why"
]);
var PRIORITY_ROLE_KEYWORDS = new Set([
  "software", "engineering", "engineer", "backend", "frontend", "fullstack", "distributed", "systems", "reliability",
  "infrastructure", "networking", "security", "zero", "trust", "ddos", "performance", "latency", "scalability",
  "api", "apis", "microservices", "cloud", "edge", "workers", "developer", "platform", "javascript", "typescript",
  "python", "java", "go", "rust", "kubernetes", "docker", "linux", "databases", "postgres", "sql", "nosql"
]);

function anthropicHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
}

function uniqueList(items) {
  var seen = new Set();
  return items.filter(function (item) {
    if (!item || seen.has(item)) {
      return false;
    }
    seen.add(item);
    return true;
  });
}

function pickPreferredModel(modelIds) {
  if (!modelIds.length) {
    return null;
  }

  for (var i = 0; i < MODEL_HINTS.length; i += 1) {
    var hint = MODEL_HINTS[i];
    var matched = modelIds.find(function (id) {
      return id.toLowerCase().indexOf(hint) !== -1;
    });
    if (matched) {
      return matched;
    }
  }

  var anySonnet = modelIds.find(function (id) {
    return id.toLowerCase().indexOf("sonnet") !== -1;
  });

  return anySonnet || modelIds[0];
}

async function fetchAvailableModels(apiKey) {
  var response = await fetch(ANTHROPIC_MODELS_URL, {
    method: "GET",
    headers: anthropicHeaders(apiKey)
  });

  if (!response.ok) {
    return [];
  }

  var data = await response.json();
  var models = Array.isArray(data.data) ? data.data : [];

  return models
    .map(function (model) {
      return model && model.id;
    })
    .filter(Boolean);
}

async function resolveCandidateModels(apiKey) {
  var available = await fetchAvailableModels(apiKey);
  var preferred = pickPreferredModel(available);
  return uniqueList([cachedModelId, preferred].concat(available).concat(MODEL_FALLBACK_IDS));
}

async function parseErrorPayload(response) {
  var text = await response.text();

  try {
    var parsed = JSON.parse(text);
    var errorObject = parsed.error || {};
    return {
      status: response.status,
      type: errorObject.type || "",
      message: errorObject.message || text,
      raw: text
    };
  } catch (_error) {
    return {
      status: response.status,
      type: "",
      message: text || response.statusText || "Unknown error",
      raw: text
    };
  }
}

function isModelNotFound(errorInfo) {
  if (!errorInfo) {
    return false;
  }

  if (errorInfo.status !== 404) {
    return false;
  }

  var msg = (errorInfo.message || "").toLowerCase();
  return errorInfo.type === "not_found_error" || msg.indexOf("model") !== -1 || msg.indexOf("not found") !== -1;
}

function storageGet(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, function (result) {
      resolve(result || {});
    });
  });
}

function getStoredContext() {
  return storageGet([SETTINGS_KEY, INDEX_KEY]).then(function (data) {
    return {
      settings: data[SETTINGS_KEY] || {},
      indexes: data[INDEX_KEY] || {}
    };
  });
}

function normalizeBackendUrl(value) {
  var url = String(value || "").trim();
  if (!url) {
    return LANGEXTRACT_BACKEND_DEFAULT_URL;
  }
  return url.replace(/\/+$/, "");
}

async function callLangExtractBackend(backendUrl, payload) {
  var baseUrl = normalizeBackendUrl(backendUrl);
  var response = await fetch(baseUrl + "/extract-structured-lanes", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    var text = await response.text();
    throw new Error("LangExtract backend failed (" + response.status + "): " + text);
  }

  var data = await response.json();
  if (!data || !data.ok || !data.structured) {
    throw new Error("LangExtract backend returned invalid response.");
  }
  return data.structured;
}

// Embed a single query string using the backend neural embedding model.
// Returns an array of floats, or null if the backend is unavailable.
async function embedQuery(backendUrl, queryText) {
  try {
    var baseUrl = normalizeBackendUrl(backendUrl);
    var response = await fetch(baseUrl + "/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: [queryText.slice(0, 2048)], task_type: "RETRIEVAL_QUERY" })
    });
    if (!response.ok) { return null; }
    var data = await response.json();
    if (!data.ok || !Array.isArray(data.embeddings) || !data.embeddings.length) { return null; }
    return data.embeddings[0];
  } catch (_err) {
    return null;
  }
}

function compressSnippetText(text, maxChars) {
  var cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return cleaned;
  }

  var limit = typeof maxChars === "number" ? maxChars : 360;
  if (cleaned.length <= limit) {
    return cleaned;
  }

  var sentences = cleaned.match(/[^.!?]+[.!?]?/g) || [cleaned];
  var selected = "";

  for (var i = 0; i < sentences.length; i += 1) {
    var candidate = (selected + " " + sentences[i]).trim();
    if (candidate.length > limit) {
      break;
    }
    selected = candidate;
  }

  if (!selected) {
    selected = cleaned.slice(0, Math.max(120, limit - 3)).trim() + "...";
  }

  return selected;
}

function formatSnippets(snippets, options) {
  if (!snippets.length) {
    return "[No matching snippets found]";
  }

  var maxChars = options && typeof options.maxChars === "number" ? options.maxChars : 0;

  return snippets
    .map(function (snippet, i) {
      var cleaned = snippet.text.replace(/\s+/g, " ").trim();
      if (maxChars > 0) {
        cleaned = compressSnippetText(cleaned, maxChars);
      }
      return "[" + (i + 1) + "] " + cleaned;
    })
    .join("\n\n");
}

function buildPrompt(payload, factSnippets, voiceSnippets, linkedinSnippets, companySnippets, roleKeywords, groundedEvidenceBlock) {
  var companyContextBlock = companySnippets.length
    ? formatSnippets(companySnippets, { maxChars: 240 })
    : "[No company-specific context provided. Infer broad priorities from role/job context only.]";
  var roleKeywordBlock = roleKeywords && roleKeywords.length
    ? roleKeywords.slice(0, 18).join(", ")
    : "[No explicit role keywords extracted]";
  var evidenceBlock = groundedEvidenceBlock || "[No extracted evidence available, fall back to fact/company references.]";

  return [
    "You are [User]. You are applying for a job.",
    "MY VOICE SAMPLES (Write like this):",
    "<style_reference>" + formatSnippets(voiceSnippets, { maxChars: 260 }) + "</style_reference>",
    "MY ACTUAL EXPERIENCES (Use these facts):",
    "<fact_reference>" + formatSnippets(factSnippets, { maxChars: 230 }) + "</fact_reference>",
    "PERSONAL BACKGROUND (Who I am, my story):",
    "<personal_reference>" + (linkedinSnippets && linkedinSnippets.length ? formatSnippets(linkedinSnippets, { maxChars: 180 }) : "[No personal background provided]") + "</personal_reference>",
    "COMPANY / ROLE CONTEXT (Use for alignment):",
    "<company_reference>" + companyContextBlock + "</company_reference>",
    "ROLE KEYWORDS TO PRIORITIZE:",
    "<role_keywords>" + roleKeywordBlock + "</role_keywords>",
    "GROUNDED EVIDENCE (Use this as primary source):",
    "<grounded_reference>" + evidenceBlock + "</grounded_reference>",
    "APPLICATION QUESTION: " + (payload.question || ""),
    "JOB CONTEXT: " + (payload.pageContext || ""),
    "INSTRUCTIONS:",
    "Analyze the 'Voice Samples' for tone, rhythm, and word choice. Use human-like voice. Be very confident, passionate and personalise. try to stand out in a good way.",
    "Answer the 'Application Question' using ONLY the 'Actual Experiences' for personal claims.",
    "Use 'Company / Role Context' to align with priorities, products, and mission where relevant.",
    "Prefer facts that directly match the role keywords and software engineering needs.",
    "If a fact is not relevant to this role, skip it and use a more relevant fact.",
    "Prefer evidence items from the grounded reference block when available.",
    "Make the response concrete, high-impact, memorable, and screening-friendly.",
    "Highlight measurable outcomes, ownership, and why this candidate stands out.",
    "Do not sound like an AI. Don't sound generic. Do not use corporate cliches. Match my voice. Be confident and passionate. Be specific and personal. Take advantage of my unique expereinces and where I come from.",
    "Do not invent personal experiences, metrics, or credentials.",
    "Return plain text only.",
    "Do not use Markdown formatting: no asterisks, no bold, no bullet points, no numbered lists, no headings.",
    "Do not use em dash or en dash characters. Prefer commas and periods.",
    "If the facts are missing, skip that section."
  ].join("\n");
}

function buildCoverLetterPrompt(payload, factSnippets, voiceSnippets, linkedinSnippets, companySnippets, roleKeywords, groundedEvidenceBlock) {
  var pageContext = String(payload.pageContext || "").trim();
  var pageUrl = String(payload.pageUrl || "").trim();
  var pageText = String(payload.jobPageText || "").replace(/\s+/g, " ").trim();
  var pageTextBlock = pageText ? pageText.slice(0, 4500) : "[No scraped job page text provided]";
  var companyReference = companySnippets.length
    ? formatSnippets(companySnippets, { maxChars: 230 })
    : "[No company-specific context provided. Use general knowledge of the company and role area.]";
  var roleKeywordBlock = roleKeywords && roleKeywords.length
    ? roleKeywords.slice(0, 24).join(", ")
    : "[No explicit role keywords extracted]";
  var evidenceBlock = groundedEvidenceBlock || "[No extracted evidence available, use best role-relevant references.]";

  return [
    "You are [User]. Write a tailored cover letter for this application.",
    "MY VOICE SAMPLES (Write like this):",
    "<style_reference>" + formatSnippets(voiceSnippets, { maxChars: 260 }) + "</style_reference>",
    "MY ACTUAL EXPERIENCES (Use these facts only for personal claims):",
    "<fact_reference>" + formatSnippets(factSnippets, { maxChars: 210 }) + "</fact_reference>",
    "PERSONAL BACKGROUND (Who I am, my story):",
    "<personal_reference>" + (linkedinSnippets && linkedinSnippets.length ? formatSnippets(linkedinSnippets, { maxChars: 160 }) : "[No personal background provided]") + "</personal_reference>",
    "COMPANY / ROLE CONTEXT (Align with this):",
    "<company_reference>" + companyReference + "</company_reference>",
    "ROLE KEYWORDS TO PRIORITIZE:",
    "<role_keywords>" + roleKeywordBlock + "</role_keywords>",
    "GROUNDED EVIDENCE (Use this as primary source):",
    "<grounded_reference>" + evidenceBlock + "</grounded_reference>",
    "JOB PAGE TEXT (Additional context):",
    "<job_page_reference>" + pageTextBlock + "</job_page_reference>",
    "PAGE TITLE / CONTEXT: " + pageContext,
    "PAGE URL: " + pageUrl,
    "INSTRUCTIONS:",
    "Write a one-page cover letter in plain text with proper structure. Be Be very confident, passionate and personalise. try to stand out in a good way.",
    "Use this exact structure: greeting line, blank line, 3 to 4 body paragraphs, blank line, closing line.",
    "Greeting should be: Dear Hiring Team,",
    "Closing should be: Sincerely, then [Your Name] on the next line.",
    "Each body paragraph should have 3 to 5 sentences.",
    "Maximum length 420 words.",
    "No markdown, no bullet points, no numbered lists, no headings.",
    "No bold or italics indicators or symbols.",
    "Do not use em dash or en dash characters. Don't sound generic or like an AI. Be specific and personal. Take advantage of my unique expereinces and where I come from.",
    "Use only provided personal facts for achievements and credentials.",
    "Prioritize facts directly relevant to software engineering responsibilities in this role.",
    "If a fact is unrelated to the role, skip it and use a more relevant fact.",
    "Mention only the most relevant projects or experiences, not all projects.",
    "Prioritize grounded evidence items above generic context.",
    "Tailor to role priorities, team impact, and company mission.",
    "Make it concrete, memorable, and screening-friendly.",
    "If a key personal detail is missing, insert [Insert specific detail here]."
  ].join("\n");
}

function sanitizeAnswerText(text) {
  var output = String(text || "");

  output = output.replace(/\r/g, "");
  output = output.replace(/\*\*(.*?)\*\*/g, "$1");
  output = output.replace(/__(.*?)__/g, "$1");
  output = output.replace(/`([^`]+)`/g, "$1");
  output = output.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  output = output.replace(/^\s*[-*•]\s+/gm, "");
  output = output.replace(/[–—]/g, ", ");
  output = output.replace(/\s-\s/g, ", ");
  output = output.replace(/\*/g, "");
  output = output.replace(/[ \t]{2,}/g, " ");
  output = output.replace(/\n{3,}/g, "\n\n");
  output = output.trim();

  return output;
}

function limitWords(text, maxWords) {
  var normalized = String(text || "").trim();
  if (!normalized) {
    return normalized;
  }

  var words = normalized.split(/\s+/);
  if (words.length <= maxWords) {
    return normalized;
  }

  return words.slice(0, maxWords).join(" ").trim();
}

function normalizeRoleText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\bc\+\+\b/g, " cpp ")
    .replace(/\bc#\b/g, " csharp ")
    .replace(/\b\.net\b/g, " dotnet ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRoleKeywords(payload) {
  var source = [
    payload && payload.pageContext,
    payload && payload.pageUrl,
    payload && payload.jobPageText
  ].filter(Boolean).join(" ");

  var normalized = normalizeRoleText(source);
  var counts = Object.create(null);
  var tokens = normalized.split(" ");

  for (var i = 0; i < tokens.length; i += 1) {
    var token = tokens[i];
    if (!token || token.length < 3 || ROLE_STOPWORDS.has(token)) {
      continue;
    }
    counts[token] = (counts[token] || 0) + 1;
  }

  var ranked = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });

  var selected = [];
  for (var j = 0; j < ranked.length; j += 1) {
    var keyword = ranked[j];
    if (counts[keyword] >= 2 || PRIORITY_ROLE_KEYWORDS.has(keyword)) {
      selected.push(keyword);
    }
    if (selected.length >= 24) {
      break;
    }
  }

  if (!selected.length) {
    selected = ranked.slice(0, 16);
  }

  return selected;
}

function countKeywordHits(text, keywords) {
  var normalized = normalizeRoleText(text);
  var hits = 0;
  for (var i = 0; i < keywords.length; i += 1) {
    if (normalized.indexOf(keywords[i]) !== -1) {
      hits += 1;
    }
  }
  return hits;
}

function selectRoleRelevantFactSnippets(candidates, roleKeywords, limit) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return [];
  }

  if (!Array.isArray(roleKeywords) || !roleKeywords.length) {
    return candidates.slice(0, limit);
  }

  var ranked = candidates.map(function (snippet) {
    var hits = countKeywordHits(snippet.text || "", roleKeywords);
    var lexical = Math.min(1, hits / Math.max(1, Math.min(roleKeywords.length, 8)));
    var semantic = typeof snippet.score === "number" ? snippet.score : 0;
    var blended = semantic * 0.72 + lexical * 0.48;

    if (hits === 0) {
      blended -= 0.16;
    }

    return {
      snippet: snippet,
      blended: blended,
      hits: hits
    };
  });

  ranked.sort(function (a, b) {
    return b.blended - a.blended;
  });

  var positiveHits = ranked.filter(function (item) {
    return item.hits > 0;
  });

  var chosen = [];
  if (positiveHits.length >= Math.min(3, limit)) {
    chosen = positiveHits.slice(0, limit);
  } else {
    chosen = ranked.slice(0, limit);
  }

  return chosen.map(function (item) {
    return item.snippet;
  });
}

function buildSnippetReferences(snippets, prefix, maxChars) {
  var limit = typeof maxChars === "number" ? maxChars : 240;
  var list = Array.isArray(snippets) ? snippets : [];

  return list.map(function (snippet, index) {
    return {
      refId: prefix + "_" + (index + 1),
      snippet: snippet,
      text: compressSnippetText(snippet && snippet.text ? snippet.text : "", limit)
    };
  });
}

function formatReferencesForPrompt(references) {
  if (!Array.isArray(references) || !references.length) {
    return "[No references found]";
  }

  return references.map(function (ref) {
    return "[" + ref.refId + "] " + ref.text;
  }).join("\n\n");
}

function parseJsonFromText(text) {
  var raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  var candidates = [raw];
  var codeFenceMatches = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (var i = 0; i < codeFenceMatches.length; i += 1) {
    var fenced = codeFenceMatches[i].replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    if (fenced) {
      candidates.push(fenced);
    }
  }

  var firstBrace = raw.indexOf("{");
  var lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (var j = 0; j < candidates.length; j += 1) {
    try {
      return JSON.parse(candidates[j]);
    } catch (_error) {
    }
  }

  return null;
}

function uniqueStringList(values) {
  var seen = new Set();
  var output = [];
  var list = Array.isArray(values) ? values : [];

  for (var i = 0; i < list.length; i += 1) {
    var value = String(list[i] || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }

  return output;
}

function chooseByReferenceIds(references, refIds, fallbackLimit) {
  var refList = Array.isArray(references) ? references : [];
  var wanted = uniqueStringList(refIds);
  var picked = [];
  var byId = Object.create(null);

  for (var i = 0; i < refList.length; i += 1) {
    byId[refList[i].refId] = refList[i];
  }

  for (var j = 0; j < wanted.length; j += 1) {
    var ref = byId[wanted[j]];
    if (ref && ref.snippet) {
      picked.push(ref.snippet);
    }
  }

  if (picked.length) {
    return picked;
  }

  var limit = typeof fallbackLimit === "number" ? fallbackLimit : refList.length;
  return refList.slice(0, limit).map(function (refItem) {
    return refItem.snippet;
  });
}

function buildGroundedEvidenceBlock(extraction, factRefs, companyRefs) {
  if (!extraction || !Array.isArray(extraction.evidenceItems) || !extraction.evidenceItems.length) {
    return "[No structured evidence extracted]";
  }

  var map = Object.create(null);
  var i;
  for (i = 0; i < factRefs.length; i += 1) {
    map[factRefs[i].refId] = factRefs[i];
  }
  for (i = 0; i < companyRefs.length; i += 1) {
    map[companyRefs[i].refId] = companyRefs[i];
  }

  var lines = [];
  for (i = 0; i < extraction.evidenceItems.length; i += 1) {
    var item = extraction.evidenceItems[i];
    var sourceRef = map[item.sourceId];
    var sourceText = sourceRef ? sourceRef.text : "[Source text unavailable]";
    var why = item.whyRelevant ? " | Why relevant: " + item.whyRelevant : "";
    lines.push("[" + item.sourceId + "] " + item.claim + why + " | Source: " + sourceText);
  }

  return lines.join("\n\n");
}

function canonicalizeStructuredItem(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupStructuredItems(items, maxItems) {
  var seen = new Set();
  var output = [];
  var list = Array.isArray(items) ? items : [];
  var limit = typeof maxItems === "number" ? maxItems : 80;

  for (var i = 0; i < list.length; i += 1) {
    var cleaned = String(list[i] || "").replace(/\s+/g, " ").trim();
    if (!cleaned) {
      continue;
    }

    cleaned = cleaned
      .replace(/^[-*•\d.\)\s]+/, "")
      .replace(/[–—]/g, ", ")
      .trim();

    if (cleaned.length < 24) {
      continue;
    }

    var key = canonicalizeStructuredItem(cleaned);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(cleaned);

    if (output.length >= limit) {
      break;
    }
  }

  return output;
}

function splitForStructuredExtraction(text) {
  var source = String(text || "").trim();
  if (!source) {
    return [];
  }

  var chunks = VectorStore.splitIntoChunks(source, {
    maxChars: 760,
    overlapChars: 90,
    minChars: 45
  });

  if (chunks.length <= 64) {
    return chunks;
  }

  var selected = [];
  var stride = Math.max(1, Math.floor(chunks.length / 64));
  for (var i = 0; i < chunks.length; i += stride) {
    selected.push(chunks[i]);
    if (selected.length >= 64) {
      break;
    }
  }

  return selected;
}

function buildStructuredReferences(rawText, prefix) {
  var chunks = splitForStructuredExtraction(rawText);
  return chunks.map(function (chunk, index) {
    return {
      refId: prefix + "_" + (index + 1),
      text: compressSnippetText(chunk, 320)
    };
  });
}

function structuredHeuristicFallback(rawText, maxItems) {
  var normalized = String(rawText || "").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  var parts = normalized
    .split(/\n+/)
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);

  if (!parts.length) {
    parts = normalized.match(/[^.!?]+[.!?]?/g) || [];
  }

  return dedupStructuredItems(parts, maxItems || 60);
}

function buildStructuredLanePrompt(laneType, laneLabel, references) {
  var refBlock = references.length
    ? formatReferencesForPrompt(references)
    : "[No references found]";
  var laneGuidance = laneType === "voice"
    ? "Extract style patterns as concrete writing cues. Avoid invented claims."
    : laneType === "company"
      ? "Extract company priorities, products, team needs, and role expectations."
      : "Extract concrete personal experiences, outcomes, and skills from the facts.";

  return [
    "You are a strict extractor that converts unstructured application data into grounded bullet items.",
    "Lane: " + laneLabel + ".",
    "LANE REFERENCES:",
    refBlock,
    "INSTRUCTIONS:",
    laneGuidance,
    "Each item must be concise, specific, and grounded in one reference.",
    "Do not invent facts.",
    "Prefer measurable outcomes and directly useful details.",
    "Return strict JSON only with this schema:",
    "{",
    "  \"items\": [",
    "    {\"source_id\": \"src_1\", \"bullet\": \"clear grounded bullet\"}",
    "    ]",
    "}",
    "Rules:",
    "source_id must exist in the provided references.",
    "Return 15 to 45 items when data is available.",
    "No markdown code fences."
  ].join("\n");
}

async function extractStructuredLane(apiKey, laneType, rawText) {
  var source = String(rawText || "").trim();
  if (!source) {
    return {
      structuredText: "",
      items: [],
      sourceCount: 0,
      fromModel: false
    };
  }

  var references = buildStructuredReferences(source, "src");
  var laneLabel = laneType === "voice"
    ? "Voice"
    : laneType === "company"
      ? "Company"
      : "Facts";
  var prompt = buildStructuredLanePrompt(laneType, laneLabel, references);
  var fallbackItems = structuredHeuristicFallback(source, laneType === "voice" ? 70 : 60);

  try {
    var raw = await callClaude(apiKey, prompt, 1300, 0.16);
    var parsed = parseJsonFromText(raw);
    var byId = Object.create(null);
    var parsedItems = [];

    for (var i = 0; i < references.length; i += 1) {
      byId[references[i].refId] = true;
    }

    if (parsed && Array.isArray(parsed.items)) {
      for (var j = 0; j < parsed.items.length; j += 1) {
        var row = parsed.items[j] || {};
        var refId = String(row.source_id || "").trim();
        var bullet = String(row.bullet || "").trim();
        if (!refId || !byId[refId] || !bullet) {
          continue;
        }
        parsedItems.push(bullet);
      }
    }

    var finalItems = dedupStructuredItems(parsedItems, laneType === "voice" ? 90 : 72);
    if (!finalItems.length) {
      finalItems = fallbackItems;
    }

    return {
      structuredText: finalItems.map(function (item) {
        return "- " + item;
      }).join("\n"),
      items: finalItems,
      sourceCount: references.length,
      fromModel: true
    };
  } catch (_error) {
    var fallback = dedupStructuredItems(fallbackItems, laneType === "voice" ? 90 : 72);
    return {
      structuredText: fallback.map(function (item) {
        return "- " + item;
      }).join("\n"),
      items: fallback,
      sourceCount: references.length,
      fromModel: false
    };
  }
}

async function extractStructuredLanes(payload) {
  var stored = await getStoredContext();
  var settings = stored.settings;
  var apiKey = String((payload && payload.apiKey) || settings.apiKey || "").trim();
  var backendUrl = normalizeBackendUrl(
    (payload && payload.backendUrl) || settings.langextractBackendUrl || LANGEXTRACT_BACKEND_DEFAULT_URL
  );

  if (!apiKey) {
    throw new Error("Missing API key. Add it in options and save again.");
  }

  var factText = payload && payload.factText ? payload.factText : "";
  var voiceText = payload && payload.voiceText ? payload.voiceText : "";
  var companyText = payload && payload.companyText ? payload.companyText : "";

  try {
    var backendStructured = await callLangExtractBackend(backendUrl, {
      apiKey: apiKey,
      factText: factText,
      voiceText: voiceText,
      companyText: companyText
    });
    return backendStructured;
  } catch (_backendError) {
    var fact = await extractStructuredLane(apiKey, "facts", factText);
    var voice = await extractStructuredLane(apiKey, "voice", voiceText);
    var company = await extractStructuredLane(apiKey, "company", companyText);

    return {
      factText: fact.structuredText,
      voiceText: voice.structuredText,
      companyText: company.structuredText,
      stats: {
        fact: { items: fact.items.length, sourceRefs: fact.sourceCount, fromModel: fact.fromModel, provider: "local_fallback" },
        voice: { items: voice.items.length, sourceRefs: voice.sourceCount, fromModel: voice.fromModel, provider: "local_fallback" },
        company: { items: company.items.length, sourceRefs: company.sourceCount, fromModel: company.fromModel, provider: "local_fallback" }
      }
    };
  }
}

async function extractGroundedEvidence(apiKey, payload, factPool, companyPool, roleKeywords, mode) {
  var factRefs = buildSnippetReferences(factPool, "fact", 220);
  var companyRefs = buildSnippetReferences(companyPool, "company", 220);
  var roleKeywordBlock = roleKeywords && roleKeywords.length
    ? roleKeywords.slice(0, 26).join(", ")
    : "[No explicit role keywords extracted]";
  var roleText = [
    payload && payload.pageContext,
    payload && payload.pageUrl,
    payload && payload.jobPageText,
    payload && payload.question
  ].filter(Boolean).join("\n");

  var taskLabel = mode === "cover_letter" ? "cover letter" : "application answer";
  var extractionPrompt = [
    "You are a strict relevance extractor for internship applications.",
    "Task type: " + taskLabel + ".",
    "ROLE CONTEXT:",
    roleText || "[No role context provided]",
    "ROLE KEYWORDS:",
    roleKeywordBlock,
    "FACT REFERENCES:",
    formatReferencesForPrompt(factRefs),
    "COMPANY REFERENCES:",
    formatReferencesForPrompt(companyRefs),
    "INSTRUCTIONS:",
    "Select only references that are directly relevant to the role context and keywords.",
    "Prefer software engineering relevance over unrelated domains.",
    "Return strict JSON only with this schema:",
    "{",
    "  \"selected_fact_ids\": [\"fact_1\"],",
    "  \"selected_company_ids\": [\"company_1\"],",
    "  \"evidence\": [",
    "    {\"source_id\": \"fact_1\", \"claim\": \"short grounded claim\", \"why_relevant\": \"short reason\"}",
    "  ]",
    "}",
    "Use only source_id values that exist in provided references.",
    "If nothing is relevant, return empty arrays."
  ].join("\n");

  var raw = await callClaude(apiKey, extractionPrompt, 900, 0.12);
  var parsed = parseJsonFromText(raw);

  if (!parsed || typeof parsed !== "object") {
    return {
      selectedFactIds: [],
      selectedCompanyIds: [],
      evidenceItems: [],
      factRefs: factRefs,
      companyRefs: companyRefs
    };
  }

  var selectedFactIds = uniqueStringList(parsed.selected_fact_ids);
  var selectedCompanyIds = uniqueStringList(parsed.selected_company_ids);
  var evidenceRaw = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  var evidenceItems = [];

  for (var i = 0; i < evidenceRaw.length; i += 1) {
    var row = evidenceRaw[i] || {};
    var sourceId = String(row.source_id || "").trim();
    var claim = String(row.claim || "").replace(/\s+/g, " ").trim();
    var whyRelevant = String(row.why_relevant || "").replace(/\s+/g, " ").trim();

    if (!sourceId || !claim) {
      continue;
    }

    if (sourceId.indexOf("fact_") === 0) {
      selectedFactIds.push(sourceId);
    } else if (sourceId.indexOf("company_") === 0) {
      selectedCompanyIds.push(sourceId);
    } else {
      continue;
    }

    evidenceItems.push({
      sourceId: sourceId,
      claim: claim,
      whyRelevant: whyRelevant
    });
  }

  return {
    selectedFactIds: uniqueStringList(selectedFactIds),
    selectedCompanyIds: uniqueStringList(selectedCompanyIds),
    evidenceItems: evidenceItems.slice(0, 16),
    factRefs: factRefs,
    companyRefs: companyRefs
  };
}

function ensureCoverLetterEnding(text) {
  var normalized = String(text || "").trim();
  if (!normalized) {
    return normalized;
  }

  var lines = normalized.split("\n").map(function (line) {
    return line.trim();
  });

  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }

  var scanStart = Math.max(0, lines.length - 8);
  var closeStart = -1;
  for (var i = scanStart; i < lines.length; i += 1) {
    if (/^sincerely,?$/i.test(lines[i])) {
      closeStart = i;
      break;
    }
  }

  var extractedName = "";
  if (closeStart >= 0 && closeStart + 1 < lines.length) {
    var candidate = (lines[closeStart + 1] || "").trim();
    if (candidate && !/^sincerely,?$/i.test(candidate) && candidate.length <= 70) {
      extractedName = candidate;
    }
  }

  if (closeStart >= 0) {
    lines = lines.slice(0, closeStart);
  }

  var body = lines.join("\n").trim();
  return body + "\n\nSincerely,\n" + (extractedName || "[Your Name]");
}

function ensureCoverLetterLayout(text) {
  var normalized = String(text || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return normalized;
  }

  var lines = normalized.split(/\n+/).map(function (line) {
    return line.trim();
  }).filter(Boolean);

  if (!lines.length) {
    return normalized;
  }

  var header = lines[0];
  var startsDear = /^dear\s+/i.test(header);

  if (!startsDear) {
    header = "Dear Hiring Team,";
  }

  var bodyText = startsDear ? lines.slice(1).join(" ") : lines.join(" ");
  var alreadyStructured = /\n\s*\n/.test(normalized);

  if (alreadyStructured && startsDear) {
    return ensureCoverLetterEnding(normalized);
  }

  var sentences = bodyText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [bodyText];
  var paragraphs = [];
  var sentenceIndex = 0;

  while (sentenceIndex < sentences.length) {
    var take = Math.min(4, sentences.length - sentenceIndex);
    var paragraph = sentences.slice(sentenceIndex, sentenceIndex + take).join(" ").replace(/\s+/g, " ").trim();
    if (paragraph) {
      paragraphs.push(paragraph);
    }
    sentenceIndex += take;
  }

  var rebuilt = header + "\n\n" + paragraphs.join("\n\n");
  return ensureCoverLetterEnding(rebuilt);
}

async function callClaude(apiKey, prompt, maxTokens, temperature) {
  var candidates = await resolveCandidateModels(apiKey);
  var lastModelError = null;
  var maxTokenCount = typeof maxTokens === "number" ? maxTokens : 700;
  var temp = typeof temperature === "number" ? temperature : 0.55;

  for (var i = 0; i < candidates.length; i += 1) {
    var modelId = candidates[i];
    var response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokenCount,
        temperature: temp,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      var errorInfo = await parseErrorPayload(response);

      if (isModelNotFound(errorInfo)) {
        lastModelError = errorInfo;
        cachedModelId = null;
        continue;
      }

      throw new Error(
        "Claude request failed with model '" + modelId + "' (" + errorInfo.status + "): " + errorInfo.message
      );
    }

    var data = await response.json();
    var blocks = Array.isArray(data.content) ? data.content : [];
    var text = blocks
      .filter(function (block) {
        return block && block.type === "text";
      })
      .map(function (block) {
        return block.text;
      })
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Claude returned an empty response.");
    }

    cachedModelId = modelId;
    return text;
  }

  var details = lastModelError ? lastModelError.message : "No compatible model IDs were accepted by Anthropic.";
  throw new Error("Claude model resolution failed: " + details);
}

async function generateAnswer(payload) {
  var stored = await getStoredContext();
  var settings = stored.settings;
  var indexes = stored.indexes;

  var apiKey = (settings.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("Missing API key in storage. Open options, paste key, click Save & Reindex, then retry.");
  }

  var factIndex = indexes.factIndex;
  var voiceIndex = indexes.voiceIndex;
  var companyIndex = indexes.companyIndex;

  if (!factIndex || !voiceIndex) {
    throw new Error("Missing indexed data. Open extension options and click Save & Reindex.");
  }

  var temperature  = typeof settings.temperature  === "number" ? settings.temperature  : 0.46;
  var promptSuffix = String(settings.promptSuffix || "").trim();
  var chunkLimits  = settings.chunkLimits || {};
  var factLimit    = Math.max(1, chunkLimits.fact     || 6);
  var resumeLimit  = Math.max(1, chunkLimits.resume   || 12);
  var voiceLimit   = Math.max(1, chunkLimits.voice    || 5);
  var liLimit      = Math.max(1, chunkLimits.linkedin || 5);
  var compLimit    = Math.max(1, chunkLimits.company  || 5);

  var factQuery = [payload.question, payload.pageContext, payload.existingText].filter(Boolean).join("\n");
  var voiceQuery = [payload.question, payload.pageContext].filter(Boolean).join("\n");
  var companyQuery = [payload.question, payload.pageContext, payload.pageUrl].filter(Boolean).join("\n");
  var roleKeywords = extractRoleKeywords(payload || {});

  // Use neural embeddings if the index was built with gemini-embedding-001
  var backendUrl = normalizeBackendUrl(settings.langextractBackendUrl || LANGEXTRACT_BACKEND_DEFAULT_URL);
  var useNeural = factIndex.embeddingModel && factIndex.embeddingModel.indexOf("gemini") !== -1;
  var factQueryVector = null;
  var voiceQueryVector = null;
  var companyQueryVector = null;

  if (useNeural) {
    var queryResults = await Promise.all([
      embedQuery(backendUrl, factQuery),
      embedQuery(backendUrl, voiceQuery),
      companyIndex ? embedQuery(backendUrl, companyQuery) : Promise.resolve(null)
    ]);
    factQueryVector = queryResults[0];
    voiceQueryVector = queryResults[1];
    companyQueryVector = queryResults[2];
    // If any embed call failed, fall back to local for all
    if (!factQueryVector || !voiceQueryVector) { useNeural = false; }
  }

  var factCandidates, voiceSnippets, companyPool;
  if (useNeural) {
    factCandidates = VectorStore.searchIndexWithVector(factIndex, factQueryVector, 40, -1);
    voiceSnippets = VectorStore.searchIndexWithVector(voiceIndex, voiceQueryVector, voiceLimit, -1);
    companyPool = (companyIndex && companyQueryVector)
      ? VectorStore.searchIndexWithVector(companyIndex, companyQueryVector, Math.max(compLimit * 3, 16), -1)
      : [];
  } else {
    factCandidates = VectorStore.searchIndex(factIndex, factQuery, 40, -1);
    voiceSnippets = VectorStore.searchIndex(voiceIndex, voiceQuery, voiceLimit, -1);
    companyPool = companyIndex ? VectorStore.searchIndex(companyIndex, companyQuery, Math.max(compLimit * 3, 16), -1) : [];
  }

  var resumeIndex = indexes.resumeIndex || null;
  if (resumeIndex) {
    var resumeSnippets = useNeural && factQueryVector
      ? VectorStore.searchIndexWithVector(resumeIndex, factQueryVector, Math.max(resumeLimit, 8), -1)
      : VectorStore.searchIndex(resumeIndex, factQuery, Math.max(resumeLimit, 8), -1);
    factCandidates = factCandidates.concat(resumeSnippets);
  }
  var factPool = selectRoleRelevantFactSnippets(factCandidates, roleKeywords, 24);
  var linkedinIndex = indexes.linkedinIndex || null;
  var linkedinSnippets = linkedinIndex
    ? (useNeural && factQueryVector
        ? VectorStore.searchIndexWithVector(linkedinIndex, factQueryVector, liLimit, -1)
        : VectorStore.searchIndex(linkedinIndex, factQuery, liLimit, -1))
    : [];
  var factSnippets = factPool.slice(0, factLimit);
  var companySnippets = companyPool.slice(0, compLimit);
  var groundedEvidenceBlock = "[No structured evidence extracted]";

  try {
    var extraction = await extractGroundedEvidence(
      apiKey,
      payload || {},
      factPool,
      companyPool,
      roleKeywords,
      "qa"
    );

    factSnippets = chooseByReferenceIds(extraction.factRefs, extraction.selectedFactIds, factLimit);
    companySnippets = chooseByReferenceIds(extraction.companyRefs, extraction.selectedCompanyIds, compLimit);
    groundedEvidenceBlock = buildGroundedEvidenceBlock(extraction, extraction.factRefs, extraction.companyRefs);
  } catch (_error) {
  }

  var prompt = buildPrompt(
    payload,
    factSnippets,
    voiceSnippets,
    linkedinSnippets,
    companySnippets,
    roleKeywords,
    groundedEvidenceBlock
  );
  if (promptSuffix) { prompt += "\n" + promptSuffix; }
  var rawAnswer = await callClaude(apiKey, prompt, 820, temperature);
  var cleanedAnswer = sanitizeAnswerText(rawAnswer);

  if (!cleanedAnswer) {
    throw new Error("Model response was empty after formatting cleanup.");
  }

  return cleanedAnswer;
}

async function generateCoverLetter(payload) {
  var stored = await getStoredContext();
  var settings = stored.settings;
  var indexes = stored.indexes;

  var apiKey = (settings.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("Missing API key in storage. Open options, paste key, click Save & Reindex, then retry.");
  }

  var factIndex = indexes.factIndex;
  var voiceIndex = indexes.voiceIndex;
  var companyIndex = indexes.companyIndex;

  if (!factIndex || !voiceIndex) {
    throw new Error("Missing indexed data. Open extension options and click Save & Reindex.");
  }

  var temperature  = typeof settings.temperature  === "number" ? settings.temperature  : 0.44;
  var promptSuffix = String(settings.promptSuffix || "").trim();
  var chunkLimits  = settings.chunkLimits || {};
  var factLimit    = Math.max(1, chunkLimits.fact     || 14);
  var resumeLimit  = Math.max(1, chunkLimits.resume   || 16);
  var voiceLimit   = Math.max(1, chunkLimits.voice    || 8);
  var liLimit      = Math.max(1, chunkLimits.linkedin || 5);
  var compLimit    = Math.max(1, chunkLimits.company  || 9);

  var coverLetterQuery = [
    "cover letter",
    payload.pageContext,
    payload.pageUrl,
    payload.jobPageText
  ].filter(Boolean).join("\n");

  var roleKeywords = extractRoleKeywords(payload || {});

  // Use neural embeddings if the index was built with gemini-embedding-001
  var backendUrl = normalizeBackendUrl(settings.langextractBackendUrl || LANGEXTRACT_BACKEND_DEFAULT_URL);
  var useNeural = factIndex.embeddingModel && factIndex.embeddingModel.indexOf("gemini") !== -1;
  var clQueryVector = null;
  var clVoiceVector = null;
  var clCompanyVector = null;

  if (useNeural) {
    var clQueryResults = await Promise.all([
      embedQuery(backendUrl, coverLetterQuery),
      embedQuery(backendUrl, coverLetterQuery),
      companyIndex ? embedQuery(backendUrl, coverLetterQuery) : Promise.resolve(null)
    ]);
    clQueryVector = clQueryResults[0];
    clVoiceVector = clQueryResults[1];
    clCompanyVector = clQueryResults[2];
    if (!clQueryVector || !clVoiceVector) { useNeural = false; }
  }
  var factCandidates, voiceSnippets, companyPool;
  if (useNeural) {
    factCandidates = VectorStore.searchIndexWithVector(factIndex, clQueryVector, 52, -1);
    voiceSnippets = VectorStore.searchIndexWithVector(voiceIndex, clVoiceVector, voiceLimit, -1);
    companyPool = (companyIndex && clCompanyVector)
      ? VectorStore.searchIndexWithVector(companyIndex, clCompanyVector, Math.max(compLimit * 3, 20), -1)
      : [];
  } else {
    factCandidates = VectorStore.searchIndex(factIndex, coverLetterQuery, 52, -1);
    voiceSnippets = VectorStore.searchIndex(voiceIndex, coverLetterQuery, voiceLimit, -1);
    companyPool = companyIndex
      ? VectorStore.searchIndex(companyIndex, coverLetterQuery, Math.max(compLimit * 3, 20), -1)
      : [];
  }
  var resumeIndex = indexes.resumeIndex || null;
  if (resumeIndex) {
    var resumeSnippetsCL = useNeural && clQueryVector
      ? VectorStore.searchIndexWithVector(resumeIndex, clQueryVector, Math.max(resumeLimit, 12), -1)
      : VectorStore.searchIndex(resumeIndex, coverLetterQuery, Math.max(resumeLimit, 12), -1);
    factCandidates = factCandidates.concat(resumeSnippetsCL);
  }
  var factPool = selectRoleRelevantFactSnippets(factCandidates, roleKeywords, 24);
  var linkedinIndex = indexes.linkedinIndex || null;
  var linkedinSnippets = linkedinIndex
    ? (useNeural && clQueryVector
        ? VectorStore.searchIndexWithVector(linkedinIndex, clQueryVector, liLimit, -1)
        : VectorStore.searchIndex(linkedinIndex, coverLetterQuery, liLimit, -1))
    : [];

  var factSnippets = factPool.slice(0, factLimit);
  var companySnippets = companyPool.slice(0, compLimit);
  var groundedEvidenceBlock = "[No structured evidence extracted]";

  try {
    var extraction = await extractGroundedEvidence(
      apiKey,
      payload || {},
      factPool,
      companyPool,
      roleKeywords,
      "cover_letter"
    );

    factSnippets = chooseByReferenceIds(extraction.factRefs, extraction.selectedFactIds, factLimit);
    companySnippets = chooseByReferenceIds(extraction.companyRefs, extraction.selectedCompanyIds, compLimit);
    groundedEvidenceBlock = buildGroundedEvidenceBlock(extraction, extraction.factRefs, extraction.companyRefs);
  } catch (_error) {
  }

  var prompt = buildCoverLetterPrompt(
    payload,
    factSnippets,
    voiceSnippets,
    linkedinSnippets,
    companySnippets,
    roleKeywords,
    groundedEvidenceBlock
  );
  if (promptSuffix) { prompt += "\n" + promptSuffix; }
  var rawLetter = await callClaude(apiKey, prompt, 1100, temperature);
  var cleanedLetter = sanitizeAnswerText(rawLetter);
  cleanedLetter = ensureCoverLetterLayout(cleanedLetter);
  cleanedLetter = limitWords(cleanedLetter, 420);
  cleanedLetter = ensureCoverLetterEnding(cleanedLetter);

  if (!cleanedLetter) {
    throw new Error("Cover letter response was empty after formatting cleanup.");
  }

  return cleanedLetter;
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "AIIA_GENERATE_ANSWER") {
    generateAnswer(message.payload || {})
      .then(function (answer) {
        sendResponse({ ok: true, answer: answer });
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.type === "AIIA_GENERATE_COVER_LETTER") {
    generateCoverLetter(message.payload || {})
      .then(function (letter) {
        sendResponse({ ok: true, letter: letter });
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.type === "AIIA_EXTRACT_STRUCTURED_LANES") {
    extractStructuredLanes(message.payload || {})
      .then(function (result) {
        sendResponse({ ok: true, structured: result });
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  return;
});
