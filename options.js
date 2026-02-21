(function () {
  "use strict";

  // ── Storage keys ────────────────────────────────────────────────────────────
  var SETTINGS_KEY = "aiia_settings";
  var INDEX_KEY    = "aiia_indexes";

  // ── DOM refs: Settings ───────────────────────────────────────────────────────
  var apiKeyInput             = document.getElementById("apiKey");
  var backendUrlInput         = document.getElementById("langextractBackendUrl");

  // ── DOM refs: Facts (Experience) ─────────────────────────────────────────────
  var factBox                 = document.getElementById("factBox");
  var factFiles               = document.getElementById("factFiles");
  var factFilesStatus         = document.getElementById("factFilesStatus");
  var factRaw                 = document.getElementById("factRaw");
  var factRawMeta             = document.getElementById("factRawMeta");
  var factChunks              = document.getElementById("factChunks");
  var factChunksMeta          = document.getElementById("factChunksMeta");

  // ── DOM refs: Resume / CV ────────────────────────────────────────────────────
  var resumeBox               = document.getElementById("resumeBox");
  var resumeFiles             = document.getElementById("resumeFiles");
  var resumeFilesStatus       = document.getElementById("resumeFilesStatus");
  var resumeRaw               = document.getElementById("resumeRaw");
  var resumeRawMeta           = document.getElementById("resumeRawMeta");
  var resumeChunks            = document.getElementById("resumeChunks");
  var resumeChunksMeta        = document.getElementById("resumeChunksMeta");

  // ── DOM refs: Voice (Past Cover Letters) ─────────────────────────────────────
  var voiceBox                = document.getElementById("voiceBox");
  var voiceFiles              = document.getElementById("voiceFiles");
  var voiceFilesStatus        = document.getElementById("voiceFilesStatus");
  var voiceRaw                = document.getElementById("voiceRaw");
  var voiceRawMeta            = document.getElementById("voiceRawMeta");
  var voiceChunks             = document.getElementById("voiceChunks");
  var voiceChunksMeta         = document.getElementById("voiceChunksMeta");

  // ── DOM refs: About Me / LinkedIn ────────────────────────────────────────────
  var linkedinText            = document.getElementById("linkedinText");
  var linkedinFiles           = document.getElementById("linkedinFiles");
  var linkedinFilesStatus     = document.getElementById("linkedinFilesStatus");
  var linkedinRaw             = document.getElementById("linkedinRaw");
  var linkedinRawMeta         = document.getElementById("linkedinRawMeta");
  var linkedinChunks          = document.getElementById("linkedinChunks");
  var linkedinChunksMeta      = document.getElementById("linkedinChunksMeta");

  // ── DOM refs: Company ────────────────────────────────────────────────────────
  var companyContext          = document.getElementById("companyContext");
  var companyScrapedText      = document.getElementById("companyScrapedText");
  var companyUrl              = document.getElementById("companyUrl");
  var companyFiles            = document.getElementById("companyFiles");
  var companyFilesStatus      = document.getElementById("companyFilesStatus");
  var companyRaw              = document.getElementById("companyRaw");
  var companyRawMeta          = document.getElementById("companyRawMeta");
  var companyChunks           = document.getElementById("companyChunks");
  var companyChunksMeta       = document.getElementById("companyChunksMeta");

  // ── DOM refs: Save + PDF extractor ───────────────────────────────────────────
  var saveBtn                 = document.getElementById("saveBtn");
  var globalStatus            = document.getElementById("globalStatus");
  var resumePdfInput          = document.getElementById("resumePdfInput");
  var extractResumePdfBtn     = document.getElementById("extractResumePdfBtn");
  var resumeExtractStatus     = document.getElementById("resumeExtractStatus");
  var resumeExtractResult     = document.getElementById("resumeExtractResult");
  var resumeExtractBackendUrl = document.getElementById("resumeExtractBackendUrl");

  // ── DOM refs: Stale indicators ────────────────────────────────────────────────
  var factStale    = document.getElementById("factStale");
  var resumeStale  = document.getElementById("resumeStale");
  var voiceStale   = document.getElementById("voiceStale");
  var linkedinStale= document.getElementById("linkedinStale");
  var companyStale = document.getElementById("companyStale");

  // ── DOM refs: Generation settings ────────────────────────────────────────────
  var promptSuffixEl    = document.getElementById("promptSuffix");
  var temperatureSlider = document.getElementById("temperatureSlider");
  var tempValEl         = document.getElementById("tempVal");
  var chunkSliders = {
    fact:    { slider: document.getElementById("chunkSliderFact"),     val: document.getElementById("chunkValFact"),    max: document.getElementById("chunkMaxFact") },
    resume:  { slider: document.getElementById("chunkSliderResume"),   val: document.getElementById("chunkValResume"),  max: document.getElementById("chunkMaxResume") },
    voice:   { slider: document.getElementById("chunkSliderVoice"),    val: document.getElementById("chunkValVoice"),   max: document.getElementById("chunkMaxVoice") },
    linkedin:{ slider: document.getElementById("chunkSliderLinkedin"), val: document.getElementById("chunkValLinkedin"),max: document.getElementById("chunkMaxLinkedin") },
    company: { slider: document.getElementById("chunkSliderCompany"),  val: document.getElementById("chunkValCompany"), max: document.getElementById("chunkMaxCompany") }
  };

  // Upload-extracted text held in memory (cleared on reset, persisted in settings)
  var uploadTexts = {
    fact: "", resume: "", voice: "", linkedin: "", company: ""
  };

  var saveInProgress   = false;
  var parseInProgress  = 0;

  // Snapshot of raw text at the time the index was last built.
  // Used to show stale badges when content has changed since.
  var indexedSnap = { fact: null, resume: null, voice: null, linkedin: null, company: null };

  function updateStaleIndicators() {
    var laneMap = [
      { snap: "fact",    raw: buildFactRaw(),     el: factStale },
      { snap: "resume",  raw: buildResumeRaw(),   el: resumeStale },
      { snap: "voice",   raw: buildVoiceRaw(),    el: voiceStale },
      { snap: "linkedin",raw: buildLinkedinRaw(), el: linkedinStale },
      { snap: "company", raw: buildCompanyRaw(),  el: companyStale }
    ];
    laneMap.forEach(function(lane) {
      var isStale = lane.el &&
                    indexedSnap[lane.snap] !== null &&
                    lane.raw.trim() !== indexedSnap[lane.snap].trim();
      if (lane.el) { lane.el.style.display = isStale ? "inline-flex" : "none"; }
    });
  }

  function updateChunkSlider(laneKey, chunkCount) {
    var s = chunkSliders[laneKey];
    if (!s) { return; }
    var maxN = Math.max(1, chunkCount || 0);
    s.slider.max = maxN;
    if (parseInt(s.slider.value) > maxN) { s.slider.value = maxN; }
    s.val.textContent = s.slider.value;
    s.max.textContent = "/ " + maxN + " chunks";
    s.slider.disabled = chunkCount === 0;
  }

  // ── Utilities ────────────────────────────────────────────────────────────────
  function setStatus(msg, kind) {
    globalStatus.textContent = msg;
    globalStatus.className   = kind || "";
  }

  function setFileStatus(el, msg, kind) {
    el.textContent  = msg || "";
    el.className    = "file-status" + (kind ? " " + kind : "");
  }

  function refreshSaveState() {
    saveBtn.disabled = saveInProgress || parseInProgress > 0;
  }

  function normalizeUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "") || "http://127.0.0.1:8787";
  }

  function joinParts() {
    var parts = Array.prototype.slice.call(arguments);
    return parts.map(function(p){ return String(p || "").trim(); }).filter(Boolean).join("\n\n");
  }

  function storageGet(keys) {
    return new Promise(function(resolve) {
      chrome.storage.local.get(keys, function(r){ resolve(r || {}); });
    });
  }

  function storageSet(obj) {
    return new Promise(function(resolve, reject) {
      chrome.storage.local.set(obj, function() {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve();
      });
    });
  }

  function runtimeSend(msg) {
    return new Promise(function(resolve, reject) {
      chrome.runtime.sendMessage(msg, function(r) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(r || {});
      });
    });
  }

  // ── Raw preview builders ─────────────────────────────────────────────────────
  function buildFactRaw()    { return joinParts(factBox.value,     uploadTexts.fact); }
  function buildResumeRaw()  { return joinParts(resumeBox.value,   uploadTexts.resume); }
  function buildVoiceRaw()   { return joinParts(voiceBox.value,    uploadTexts.voice); }
  function buildLinkedinRaw(){ return joinParts(linkedinText.value,uploadTexts.linkedin); }
  function buildCompanyRaw() {
    return joinParts(
      companyUrl.value ? "Company URL: " + companyUrl.value : "",
      companyContext.value,
      companyScrapedText.value,
      uploadTexts.company
    );
  }

  function charLabel(n) { return n ? n.toLocaleString() + " chars" : "empty"; }

  function refreshAllRaw() {
    var fr = buildFactRaw(), rr = buildResumeRaw(), vr = buildVoiceRaw(),
        lr = buildLinkedinRaw(), cr = buildCompanyRaw();
    factRaw.value    = fr; factRawMeta.textContent    = charLabel(fr.length);
    resumeRaw.value  = rr; resumeRawMeta.textContent  = charLabel(rr.length);
    voiceRaw.value   = vr; voiceRawMeta.textContent   = charLabel(vr.length);
    linkedinRaw.value= lr; linkedinRawMeta.textContent= charLabel(lr.length);
    companyRaw.value = cr; companyRawMeta.textContent = charLabel(cr.length);
  }

  // ── Chunk rendering ──────────────────────────────────────────────────────────
  function renderChunks(index, container, metaEl) {
    container.innerHTML = "";
    if (!index || !Array.isArray(index.chunks) || !index.chunks.length) {
      container.innerHTML = "<div class=\"chunks-empty\">No chunks yet \u2014 click Save &amp; Reindex.</div>";
      if (metaEl) { metaEl.textContent = ""; }
      return;
    }
    var neural = index.embeddingModel ? " \u00b7 neural \u2713" : " \u00b7 hash vectors";
    if (metaEl) {
      metaEl.textContent = index.chunkCount + " chunks" + neural;
    }
    index.chunks.forEach(function(chunk, i) {
      var item = document.createElement("div");
      item.className = "chunk-item";
      var num = document.createElement("span");
      num.className = "chunk-num";
      num.textContent = i + 1;
      var text = document.createElement("span");
      text.className = "chunk-text";
      text.textContent = String(chunk.text || "").trim();
      item.appendChild(num);
      item.appendChild(text);
      container.appendChild(item);
    });
  }

  // ── Per-lane reindex (triggered by stale badge click or scrape) ───────────────
  var LANE_CONFIG = {
    fact:    { buildRaw: function(){ return buildFactRaw(); },     bankType: "facts", chunkOpts: { maxChars:760, overlapChars:120, minChars:24 }, indexKey: "factIndex",    chunksEl: function(){ return factChunks; },    metaEl: function(){ return factChunksMeta; } },
    resume:  { buildRaw: function(){ return buildResumeRaw(); },  bankType: "facts", chunkOpts: { maxChars:760, overlapChars:120, minChars:24 }, indexKey: "resumeIndex",   chunksEl: function(){ return resumeChunks; },  metaEl: function(){ return resumeChunksMeta; } },
    voice:   { buildRaw: function(){ return buildVoiceRaw(); },   bankType: "voice", chunkOpts: { maxChars:900, overlapChars:160, minChars:24 }, indexKey: "voiceIndex",   chunksEl: function(){ return voiceChunks; },   metaEl: function(){ return voiceChunksMeta; } },
    linkedin:{ buildRaw: function(){ return buildLinkedinRaw(); },bankType: "facts", chunkOpts: { maxChars:760, overlapChars:120, minChars:24 }, indexKey: "linkedinIndex", chunksEl: function(){ return linkedinChunks; },metaEl: function(){ return linkedinChunksMeta; } },
    company: { buildRaw: function(){ return buildCompanyRaw(); }, bankType: "facts", chunkOpts: { maxChars:760, overlapChars:120, minChars:24 }, indexKey: "companyIndex", chunksEl: function(){ return companyChunks; }, metaEl: function(){ return companyChunksMeta; } }
  };

  async function reindexLane(laneKey) {
    var cfg = LANE_CONFIG[laneKey];
    if (!cfg) { return; }
    var btn = document.getElementById(laneKey === "fact" ? "factStale" : laneKey === "resume" ? "resumeStale" : laneKey === "voice" ? "voiceStale" : laneKey === "linkedin" ? "linkedinStale" : "companyStale");
    if (btn) { btn.disabled = true; btn.textContent = "Indexing…"; }
    setStatus("Reindexing " + laneKey + "…", "warn");
    try {
      var backendUrl = normalizeUrl(backendUrlInput.value);
      var rawText = cfg.buildRaw();
      var index = VectorStore.createIndex(rawText, cfg.bankType, cfg.chunkOpts);
      index = await reembedIndex(index, backendUrl);
      var existing = await storageGet([SETTINGS_KEY, INDEX_KEY]);
      var indexes = Object.assign({}, existing[INDEX_KEY] || {});
      indexes[cfg.indexKey] = index;
      await storageSet({ [INDEX_KEY]: indexes });
      renderChunks(index, cfg.chunksEl(), cfg.metaEl());
      indexedSnap[laneKey] = rawText;
      updateStaleIndicators();
      updateChunkSlider(laneKey, index.chunkCount);
      setStatus(laneKey + " reindexed \u2713 \u2014 " + index.chunkCount + " chunks" + (index.embeddingModel ? " (neural)" : " (hash)"), "ok");
    } catch (err) {
      setStatus(laneKey + " reindex failed: " + err.message, "warn");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Reindex"; }
    }
  }

  // ── Company-only reindex (auto-triggered on scrape) ─────────────────────────
  async function reindexCompanyOnly() {
    setStatus("Auto-reindexing company data…", "warn");
    try {
      var backendUrl  = normalizeUrl(backendUrlInput.value);
      var companyText = buildCompanyRaw();
      var chunkOpts   = { maxChars: 760, overlapChars: 120, minChars: 24 };
      var companyIndex = VectorStore.createIndex(companyText, "facts", chunkOpts);
      companyIndex = await reembedIndex(companyIndex, backendUrl);

      var existingData = await storageGet([SETTINGS_KEY, INDEX_KEY]);
      var settings = Object.assign({}, existingData[SETTINGS_KEY] || {});
      var indexes  = Object.assign({}, existingData[INDEX_KEY]  || {});
      settings.companyText        = companyContext.value.trim();
      settings.companyScrapedText = companyScrapedText.value.trim();
      settings.companyUrl         = companyUrl.value.trim();
      indexes.companyIndex = companyIndex;
      await storageSet({ [SETTINGS_KEY]: settings, [INDEX_KEY]: indexes });

      renderChunks(companyIndex, companyChunks, companyChunksMeta);
      indexedSnap.company = companyText;
      updateStaleIndicators();
      setStatus("Company reindexed ✓ — " + companyIndex.chunkCount + " chunks" +
        (companyIndex.embeddingModel ? " (neural)" : " (hash)"), "ok");
    } catch (err) {
      setStatus("Company reindex failed: " + err.message, "warn");
    }
  }

  // ── Index builder ────────────────────────────────────────────────────────────
  function buildIndex(rawText, bankType, opts) {
    return VectorStore.createIndex(rawText, bankType, opts || {});
  }

  // ── Neural reembedding ────────────────────────────────────────────────────────
  async function reembedIndex(index, backendUrl) {
    if (!index || !Array.isArray(index.chunks) || !index.chunks.length) { return index; }
    var texts = index.chunks.map(function(c){ return c.text; });
    try {
      var resp = await fetch(normalizeUrl(backendUrl) + "/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: texts, task_type: "RETRIEVAL_DOCUMENT" })
      });
      if (!resp.ok) { return index; }
      var data = await resp.json();
      if (!data.ok || !Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) { return index; }
      return VectorStore.applyExternalEmbeddings(index, data.embeddings, data.model, data.dimension);
    } catch (_) {
      return index; // Gemini rate-limit or backend offline → keep hash vectors
    }
  }

  // ── File parsing ─────────────────────────────────────────────────────────────
  async function parseFiles(fileInput, laneKey, statusEl, label) {
    if (!fileInput.files || !fileInput.files.length) {
      setFileStatus(statusEl, "No files selected.");
      return;
    }
    parseInProgress++;
    refreshSaveState();
    try {
      setFileStatus(statusEl, "Parsing " + fileInput.files.length + " file(s)…");
      var result = await FileParser.extractTextFromFiles(fileInput.files, function(p) {
        setFileStatus(statusEl, p.current + "/" + p.total + " — " + p.summary.name);
      });
      uploadTexts[laneKey] = result.combinedText;
      var ok  = result.summaries.filter(function(s){ return s.success; }).length;
      var bad = result.summaries.length - ok;
      setFileStatus(statusEl, label + ": " + ok + " parsed" + (bad ? ", " + bad + " failed" : ""), bad ? "warn" : "ok");
    } catch (err) {
      setFileStatus(statusEl, "Parse error: " + err.message, "warn");
    } finally {
      parseInProgress--;
      refreshAllRaw();
      updateStaleIndicators();
      refreshSaveState();
    }
  }

  // ── Save & Reindex ───────────────────────────────────────────────────────────
  async function handleSave() {
    saveInProgress = true;
    refreshSaveState();
    try {
      var apiKey     = apiKeyInput.value.trim();
      var backendUrl = normalizeUrl(backendUrlInput.value);

      var factText    = buildFactRaw();
      var resumeText  = buildResumeRaw();
      var voiceText   = buildVoiceRaw();
      var liText      = buildLinkedinRaw();
      var companyText = buildCompanyRaw();

      // ── Structured extraction via LangExtract backend (optional, falls back gracefully)
      var structuredFact = "", structuredVoice = "", structuredCompany = "";
      if (apiKey && (factText || voiceText || companyText)) {
        setStatus("Running structured extraction…", "warn");
        try {
          var extractResp = await runtimeSend({
            type: "AIIA_EXTRACT_STRUCTURED_LANES",
            payload: { apiKey: apiKey, backendUrl: backendUrl, factText: factText, voiceText: voiceText, companyText: companyText }
          });
          if (extractResp && extractResp.ok) {
            var s = extractResp.structured || {};
            structuredFact    = String(s.factText    || "").trim();
            structuredVoice   = String(s.voiceText   || "").trim();
            structuredCompany = String(s.companyText || "").trim();
          }
        } catch (_) { /* falls through — raw text used */ }
      }

      setStatus("Building indexes…", "warn");

      var chunkOpts   = { maxChars: 760, overlapChars: 120, minChars: 24 };
      var voiceOpts   = { maxChars: 900, overlapChars: 160, minChars: 24 }; // paragraphs

      var factIndex    = VectorStore.createIndex(factText,    "facts", chunkOpts);
      var resumeIndex  = VectorStore.createIndex(resumeText,  "facts", chunkOpts);
      var voiceIndex   = VectorStore.createIndex(voiceText,   "voice", voiceOpts);
      var linkedinIdx  = VectorStore.createIndex(liText,      "facts", chunkOpts);
      var companyIndex = VectorStore.createIndex(companyText, "facts", chunkOpts);

      // ── Neural reembedding (falls back silently if backend rate-limited or offline)
      var totalChunks = factIndex.chunkCount + resumeIndex.chunkCount + voiceIndex.chunkCount +
                        linkedinIdx.chunkCount + companyIndex.chunkCount;
      setStatus("Embedding " + totalChunks + " chunks (gemini-embedding-001)…", "warn");

      var reembedded = await Promise.all([
        reembedIndex(factIndex,    backendUrl),
        reembedIndex(resumeIndex,  backendUrl),
        reembedIndex(voiceIndex,   backendUrl),
        reembedIndex(linkedinIdx,  backendUrl),
        reembedIndex(companyIndex, backendUrl)
      ]);
      factIndex    = reembedded[0];
      resumeIndex  = reembedded[1];
      voiceIndex   = reembedded[2];
      linkedinIdx  = reembedded[3];
      companyIndex = reembedded[4];

      var neuralLanes = reembedded.filter(function(i){ return i.embeddingModel; }).length;
      if (neuralLanes === 0) {
        setStatus("Backend offline — using local hash vectors. Save continuing…", "warn");
      }

      // ── Persist ───────────────────────────────────────────────────────────────
      var existing = (await storageGet([SETTINGS_KEY]))[SETTINGS_KEY] || {};
      await storageSet({
        [SETTINGS_KEY]: Object.assign({}, existing, {
          apiKey:              apiKey,
          langextractBackendUrl: backendUrl,
          factText:            factBox.value.trim(),
          factUploadText:      uploadTexts.fact,
          resumeText:          resumeBox.value.trim(),
          resumeUploadText:    uploadTexts.resume,
          voiceText:           voiceBox.value.trim(),
          voiceUploadText:     uploadTexts.voice,
          linkedinText:        linkedinText.value.trim(),
          linkedinUploadText:  uploadTexts.linkedin,
          companyText:         companyContext.value.trim(),
          companyUploadText:   uploadTexts.company,
          companyScrapedText:  companyScrapedText.value.trim(),
          companyUrl:          companyUrl.value.trim(),
          promptSuffix:        promptSuffixEl.value.trim(),
          temperature:         parseFloat(temperatureSlider.value),
          chunkLimits:         (function() { var l = {}; Object.keys(chunkSliders).forEach(function(k){ l[k] = parseInt(chunkSliders[k].slider.value); }); return l; })(),
          updatedAt:           new Date().toISOString()
        }),
        [INDEX_KEY]: {
          factIndex:    factIndex,
          resumeIndex:  resumeIndex,
          voiceIndex:   voiceIndex,
          linkedinIndex: linkedinIdx,
          companyIndex: companyIndex
        }
      });

      // ── Render chunks inline ──────────────────────────────────────────────────
      renderChunks(factIndex,    factChunks,    factChunksMeta);
      renderChunks(resumeIndex,  resumeChunks,  resumeChunksMeta);
      renderChunks(voiceIndex,   voiceChunks,   voiceChunksMeta);
      renderChunks(linkedinIdx,  linkedinChunks,linkedinChunksMeta);
      renderChunks(companyIndex, companyChunks, companyChunksMeta);

      // Update stale snapshots — everything is now freshly indexed
      indexedSnap.fact    = factText;
      indexedSnap.resume  = resumeText;
      indexedSnap.voice   = voiceText;
      indexedSnap.linkedin= liText;
      indexedSnap.company = companyText;
      updateStaleIndicators();

      // Update chunk slider maxes to reflect newly built indexes
      updateChunkSlider("fact",     factIndex.chunkCount);
      updateChunkSlider("resume",   resumeIndex.chunkCount);
      updateChunkSlider("voice",    voiceIndex.chunkCount);
      updateChunkSlider("linkedin", linkedinIdx.chunkCount);
      updateChunkSlider("company",  companyIndex.chunkCount);

      var total = factIndex.chunkCount + resumeIndex.chunkCount + voiceIndex.chunkCount +
                  linkedinIdx.chunkCount + companyIndex.chunkCount;
      setStatus(
        "Saved \u2713 — " + total + " chunks total" +
        (neuralLanes > 0 ? " (" + neuralLanes + "/5 neural)" : " (hash vectors — start backend for neural)"),
        "ok"
      );

    } catch (err) {
      setStatus("Save failed: " + err.message, "warn");
    } finally {
      saveInProgress = false;
      refreshSaveState();
    }
  }

  // ── Hydrate from storage ─────────────────────────────────────────────────────
  async function hydrate() {
    var data     = await storageGet([SETTINGS_KEY, INDEX_KEY]);
    var settings = data[SETTINGS_KEY] || {};
    var indexes  = data[INDEX_KEY]    || {};

    apiKeyInput.value    = settings.apiKey    || "";
    backendUrlInput.value = settings.langextractBackendUrl || "http://127.0.0.1:8787";

    // Restore paste areas
    factBox.value         = settings.factText        || "";
    resumeBox.value       = settings.resumeText       || "";
    voiceBox.value        = settings.voiceText        || "";
    linkedinText.value    = settings.linkedinText     || "";
    companyContext.value  = settings.companyText      || "";
    companyScrapedText.value = settings.companyScrapedText || "";
    companyUrl.value      = settings.companyUrl       || "";

    // Restore upload texts into memory + file-status
    uploadTexts.fact     = settings.factUploadText    || "";
    uploadTexts.resume   = settings.resumeUploadText  || "";
    uploadTexts.voice    = settings.voiceUploadText   || "";
    uploadTexts.linkedin = settings.linkedinUploadText|| "";
    uploadTexts.company  = settings.companyUploadText || "";

    setFileStatus(factFilesStatus,     uploadTexts.fact     ? "Previously saved upload text loaded." : "No files selected.", uploadTexts.fact     ? "ok" : "");
    setFileStatus(resumeFilesStatus,   uploadTexts.resume   ? "Previously saved upload text loaded." : "No files selected.", uploadTexts.resume   ? "ok" : "");
    setFileStatus(voiceFilesStatus,    uploadTexts.voice    ? "Previously saved upload text loaded." : "No files selected.", uploadTexts.voice    ? "ok" : "");
    setFileStatus(linkedinFilesStatus, uploadTexts.linkedin ? "Previously saved upload text loaded." : "No files selected.", uploadTexts.linkedin ? "ok" : "");
    setFileStatus(companyFilesStatus,  uploadTexts.company  ? "Previously saved upload text loaded." : "No files selected.", uploadTexts.company  ? "ok" : "");

    refreshAllRaw();

    // Snapshot the raw text that corresponds to what was just indexed,
    // so stale badges can detect edits made after this point.
    indexedSnap.fact     = buildFactRaw();
    indexedSnap.resume   = buildResumeRaw();
    indexedSnap.voice    = buildVoiceRaw();
    indexedSnap.linkedin = buildLinkedinRaw();
    indexedSnap.company  = buildCompanyRaw();

    // Render saved chunks
    renderChunks(indexes.factIndex,    factChunks,    factChunksMeta);
    renderChunks(indexes.resumeIndex,  resumeChunks,  resumeChunksMeta);
    renderChunks(indexes.voiceIndex,   voiceChunks,   voiceChunksMeta);
    renderChunks(indexes.linkedinIndex,linkedinChunks,linkedinChunksMeta);
    renderChunks(indexes.companyIndex, companyChunks, companyChunksMeta);

    // Restore generation settings + set chunk slider maxes from saved indexes
    promptSuffixEl.value    = settings.promptSuffix || "";
    var savedTemp = typeof settings.temperature === "number" ? settings.temperature : 0.5;
    temperatureSlider.value = savedTemp;
    tempValEl.textContent   = savedTemp.toFixed(2);
    var savedChunkLimits = settings.chunkLimits || {};
    var indexKeyMap = { fact:"factIndex", resume:"resumeIndex", voice:"voiceIndex", linkedin:"linkedinIndex", company:"companyIndex" };
    Object.keys(chunkSliders).forEach(function(k) {
      var idx = indexes[indexKeyMap[k]];
      var maxN = (idx && idx.chunkCount) || 0;
      updateChunkSlider(k, maxN);
      var saved = savedChunkLimits[k];
      if (typeof saved === "number" && saved >= 1 && saved <= maxN) {
        chunkSliders[k].slider.value = saved;
        chunkSliders[k].val.textContent = saved;
      }
    });

    var savedTotal = ["factIndex","resumeIndex","voiceIndex","linkedinIndex","companyIndex"].reduce(function(s, k){
      return s + ((indexes[k] && indexes[k].chunkCount) || 0);
    }, 0);

    if (savedTotal > 0) {
      setStatus("Loaded " + savedTotal + " indexed chunks from storage.", "ok");
    }

    syncBackendUrl();
    updateStaleIndicators();
  }

  // ── Reset helpers ─────────────────────────────────────────────────────────────
  function clearChunksDiv(divEl, metaEl) {
    divEl.innerHTML = '<div class="chunks-empty">No chunks yet \u2014 click Save &amp; Reindex.</div>';
    if (metaEl) { metaEl.textContent = ""; }
  }

  async function persistReset(laneKey, laneSuccessMsg) {
    setStatus("Resetting " + laneSuccessMsg + "…", "warn");
    try {
      var existing = (await storageGet([SETTINGS_KEY, INDEX_KEY]));
      var settings = Object.assign({}, existing[SETTINGS_KEY] || {});
      var indexes  = Object.assign({}, existing[INDEX_KEY]  || {});
      var fieldMap = {
        fact:     ["factText", "factUploadText", "factIndex"],
        resume:   ["resumeText", "resumeUploadText", "resumeIndex"],
        voice:    ["voiceText", "voiceUploadText", "voiceIndex"],
        linkedin: ["linkedinText", "linkedinUploadText", "linkedinIndex"],
        company:  ["companyText", "companyUploadText", "companyScrapedText", "companyUrl", "companyIndex"]
      };
      (fieldMap[laneKey] || []).forEach(function(k) {
        if (k.endsWith("Index")) { delete indexes[k]; }
        else { settings[k] = ""; }
      });
      await storageSet({ [SETTINGS_KEY]: settings, [INDEX_KEY]: indexes });
      setStatus(laneSuccessMsg + " cleared and saved \u2713", "ok");
    } catch(err) {
      setStatus("Reset failed: " + err.message, "warn");
    }
  }

  // ── Reset handlers ────────────────────────────────────────────────────────────
  function resetFacts() {
    factBox.value = ""; uploadTexts.fact = "";
    factFiles.value = ""; setFileStatus(factFilesStatus, "No files selected.");
    refreshAllRaw(); clearChunksDiv(factChunks, factChunksMeta);
    indexedSnap.fact = buildFactRaw(); updateStaleIndicators();
    persistReset("fact", "Experience");
  }
  function resetResume() {
    resumeBox.value = ""; uploadTexts.resume = "";
    resumeFiles.value = ""; setFileStatus(resumeFilesStatus, "No files selected.");
    refreshAllRaw(); clearChunksDiv(resumeChunks, resumeChunksMeta);
    indexedSnap.resume = buildResumeRaw(); updateStaleIndicators();
    persistReset("resume", "CV / Resume");
  }
  function resetVoice() {
    voiceBox.value = ""; uploadTexts.voice = "";
    voiceFiles.value = ""; setFileStatus(voiceFilesStatus, "No files selected.");
    refreshAllRaw(); clearChunksDiv(voiceChunks, voiceChunksMeta);
    indexedSnap.voice = buildVoiceRaw(); updateStaleIndicators();
    persistReset("voice", "Voice");
  }
  function resetLinkedin() {
    linkedinText.value = ""; uploadTexts.linkedin = "";
    linkedinFiles.value = ""; setFileStatus(linkedinFilesStatus, "No files selected.");
    refreshAllRaw(); clearChunksDiv(linkedinChunks, linkedinChunksMeta);
    indexedSnap.linkedin = buildLinkedinRaw(); updateStaleIndicators();
    persistReset("linkedin", "About Me");
  }
  function resetCompany() {
    companyContext.value = ""; companyScrapedText.value = ""; companyUrl.value = "";
    uploadTexts.company = ""; companyFiles.value = "";
    setFileStatus(companyFilesStatus, "No files selected.");
    refreshAllRaw(); clearChunksDiv(companyChunks, companyChunksMeta);
    indexedSnap.company = buildCompanyRaw(); updateStaleIndicators();
    persistReset("company", "Company");
  }

  // ── Event listeners ──────────────────────────────────────────────────────────
  factFiles.addEventListener("change",     function(){ parseFiles(factFiles,    "fact",    factFilesStatus,    "Experience"); });
  resumeFiles.addEventListener("change",   function(){ parseFiles(resumeFiles,  "resume",  resumeFilesStatus,  "CV");         });
  voiceFiles.addEventListener("change",    function(){ parseFiles(voiceFiles,   "voice",   voiceFilesStatus,   "Voice");      });
  linkedinFiles.addEventListener("change", function(){ parseFiles(linkedinFiles,"linkedin",linkedinFilesStatus,"About Me");   });
  companyFiles.addEventListener("change",  function(){ parseFiles(companyFiles, "company", companyFilesStatus, "Company");    });

  [factBox, resumeBox, voiceBox, linkedinText,
   companyContext, companyScrapedText, companyUrl].forEach(function(el){
    el.addEventListener("input", function() { refreshAllRaw(); updateStaleIndicators(); });
  });

  document.getElementById("resetFactsBtn").addEventListener("click",   resetFacts);
  document.getElementById("resetResumeBtn").addEventListener("click",  resetResume);
  document.getElementById("resetVoiceBtn").addEventListener("click",   resetVoice);
  document.getElementById("resetLinkedInBtn").addEventListener("click",resetLinkedin);
  document.getElementById("resetCompanyBtn").addEventListener("click", resetCompany);

  document.getElementById("factStale").addEventListener("click",    function(){ reindexLane("fact"); });
  document.getElementById("resumeStale").addEventListener("click",   function(){ reindexLane("resume"); });
  document.getElementById("voiceStale").addEventListener("click",    function(){ reindexLane("voice"); });
  document.getElementById("linkedinStale").addEventListener("click", function(){ reindexLane("linkedin"); });
  document.getElementById("companyStale").addEventListener("click",  function(){ reindexLane("company"); });

  saveBtn.addEventListener("click", handleSave);

  temperatureSlider.addEventListener("input", function() {
    tempValEl.textContent = parseFloat(temperatureSlider.value).toFixed(2);
  });
  Object.keys(chunkSliders).forEach(function(k) {
    chunkSliders[k].slider.addEventListener("input", function() {
      chunkSliders[k].val.textContent = chunkSliders[k].slider.value;
    });
  });

  // ── Storage change listener (popup → options sync) ────────────────────────────
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== "local" || !changes[SETTINGS_KEY]) { return; }
    var next = (changes[SETTINGS_KEY].newValue) || {};
    if (document.activeElement !== linkedinText) {
      linkedinText.value = next.linkedinText || "";
    }
    if (document.activeElement !== companyUrl) {
      companyUrl.value = next.companyUrl || companyUrl.value || "";
    }
    if (document.activeElement !== companyScrapedText) {
      companyScrapedText.value = next.companyScrapedText || "";
    }
    refreshAllRaw();
    if (next.linkedinUpdatedAt) { setStatus("LinkedIn import received. Click Save & Reindex to include it.", "ok"); }
    if (next.companyUpdatedAt)  {
      // Auto-reindex company lane so new scrape takes effect immediately
      setTimeout(reindexCompanyOnly, 0);
    }
  });

  // ── PDF Extractor ─────────────────────────────────────────────────────────────
  function syncBackendUrl() {
    resumeExtractBackendUrl.value = normalizeUrl(backendUrlInput.value);
  }
  backendUrlInput.addEventListener("input", syncBackendUrl);

  resumePdfInput.addEventListener("change", function() {
    var has = resumePdfInput.files && resumePdfInput.files.length > 0;
    extractResumePdfBtn.disabled = !has;
    setFileStatus(resumeExtractStatus, has ? resumePdfInput.files[0].name : "");
  });

  function _esc(str) {
    return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function renderResumeJson(data) {
    var grouped = data.grouped || {};
    var order   = ["contact","education","experience","projects","skills","other"];
    var labels  = { contact:"Contact",education:"Education",experience:"Experience",projects:"Projects",skills:"Skills",other:"Other",voice_style:"Voice Style",company_signals:"Company Signals" };
    var icons   = { contact:"📌",education:"🎓",experience:"💼",projects:"🚀",skills:"⚙️",voice_style:"🎤",company_signals:"🏢",other:"📋" };
    var keys    = order.filter(function(k){ return grouped[k] && grouped[k].length; });
    Object.keys(grouped).forEach(function(k){ if (keys.indexOf(k) === -1 && grouped[k] && grouped[k].length) { keys.push(k); } });
    if (!keys.length) { return "<p style='color:var(--warn);margin:0;'>No data extracted.</p>"; }

    var html = "<div style='font-size:.78rem;color:var(--muted);margin-bottom:8px;'>Model: <b>" + _esc(data.model||"?") + "</b> &middot; " + (data.rawCount||0) + " items &middot; " + (data.charCount||0) + " chars</div>";
    keys.forEach(function(key) {
      var items = grouped[key] || [];
      html += "<details open style='margin-bottom:8px;'><summary style='cursor:pointer;font-weight:700;font-size:.88rem;padding:3px 0;list-style:none;'>" + (icons[key]||"📋") + " " + (labels[key]||key) + " <span style='color:var(--muted);font-weight:400;font-size:.78rem;'>(" + items.length + ")</span></summary><div style='padding:5px 0 0 10px;'>";
      items.forEach(function(item) {
        var main = _esc(item.text || item.extraction_text || "");
        var extras = ["organization","institution","company","degree","date","dates","location"].filter(function(f){ return item[f] && String(item[f]).trim() && String(item[f]).trim() !== (item.text||""); });
        html += "<div style='border-left:3px solid var(--border);padding:5px 8px;margin-bottom:5px;background:#fff;border-radius:0 6px 6px 0;'>";
        if (main) { html += "<div style='font-weight:600;font-size:.84rem;'>" + main + "</div>"; }
        if (extras.length) {
          extras.forEach(function(f){ html += "<div style='font-size:.76rem;color:var(--muted);'>" + f + ": " + _esc(String(item[f])) + "</div>"; });
        }
        html += "</div>";
      });
      html += "</div></details>";
    });
    return html;
  }

  function resumeJsonToText(grouped) {
    var sections = ["contact","education","experience","projects","skills","other"];
    var labels   = { contact:"Contact",education:"Education",experience:"Experience",projects:"Projects",skills:"Skills",other:"Other" };
    var lines = [];
    sections.forEach(function(key) {
      var items = grouped[key]; if (!items || !items.length) { return; }
      lines.push("=== " + (labels[key]||key) + " ===");
      items.forEach(function(item) {
        var text = String(item.text || item.extraction_text || "").trim();
        if (!text) { return; }
        var extras = ["organization","institution","company","degree","date","dates","location"].filter(function(f){ return item[f] && String(item[f]).trim() && String(item[f]).trim() !== text; }).map(function(f){ return String(item[f]).trim(); });
        lines.push(text + (extras.length ? " (" + extras.join(", ") + ")" : ""));
      });
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  extractResumePdfBtn.addEventListener("click", async function() {
    var file = resumePdfInput.files && resumePdfInput.files[0];
    if (!file) { return; }
    extractResumePdfBtn.disabled = true;
    setFileStatus(resumeExtractStatus, "Uploading and extracting…");
    resumeExtractResult.innerHTML = "<p style='color:var(--muted);margin:0;'>Processing…</p>";
    try {
      var backendUrl = normalizeUrl(resumeExtractBackendUrl.value || backendUrlInput.value);
      var form = new FormData();
      form.append("file", file);
      var resp = await fetch(backendUrl + "/extract-resume-pdf", { method: "POST", body: form });
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        var errMsg = (data && data.detail) || (data && data.error) || ("HTTP " + resp.status);
        setFileStatus(resumeExtractStatus, "Error: " + errMsg, "warn");
        resumeExtractResult.innerHTML = "<p style='color:var(--warn);margin:0;'>❌ " + _esc(errMsg) + "</p>";
        return;
      }
      setFileStatus(resumeExtractStatus, "✓ Extracted " + (data.rawCount||0) + " items via " + (data.model||"model"), "ok");
      resumeExtractResult.innerHTML = renderResumeJson(data);

      // Push extracted text into the CV / Resume paste box
      var extracted = resumeJsonToText(data.grouped || {});
      if (extracted) {
        var existing = resumeBox.value.trim();
        resumeBox.value = existing
          ? existing + "\n\n--- Extracted from PDF ---\n" + extracted
          : extracted;
        refreshAllRaw();
        setStatus("PDF extracted → added to CV lane. Click Save & Reindex when ready.", "ok");
      }
    } catch (err) {
      setFileStatus(resumeExtractStatus, "Failed: " + err.message, "warn");
      resumeExtractResult.innerHTML = "<p style='color:var(--warn);margin:0;'>❌ " + _esc(err.message) + "</p>";
    } finally {
      extractResumePdfBtn.disabled = false;
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  hydrate()
    .then(refreshSaveState)
    .catch(function(err){ setStatus("Failed to load settings: " + err.message, "warn"); refreshSaveState(); });

})();
