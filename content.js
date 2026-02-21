(function () {
  "use strict";

  var BUTTON_CLASS = "aiia-fill-voice-btn";
  var FIELD_MARK = "data-aiia-wired";
  var PREFS_KEY = "aiia_preferences";
  var VALID_INPUT_TYPES = new Set(["text", "search", "tel"]);
  var SCAN_INTERVAL_MS = 1800;

  // Standard browser-autofill autocomplete tokens — AI can't add value here
  var BROWSER_AUTOFILL_AC = new Set([
    "name", "given-name", "additional-name", "family-name",
    "honorific-prefix", "honorific-suffix", "nickname",
    "email", "username",
    "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-extension",
    "street-address", "address-line1", "address-line2", "address-line3",
    "address-level1", "address-level2", "address-level3", "address-level4",
    "country", "country-name", "postal-code",
    "bday", "bday-day", "bday-month", "bday-year",
    "sex", "url", "photo", "new-password", "current-password"
  ]);

  // Field name / id patterns that are unambiguously personal data
  var AUTOFILL_NAME_RE = /^(first[_\-. ]?name|given[_\-. ]?name|last[_\-. ]?name|family[_\-. ]?name|sur[_\-. ]?name|full[_\-. ]?name|middle[_\-. ]?name|email|e[_\-. ]?mail|phone|telephone|mobile|cell(phone)?|zip|zip[_\-. ]?code|postal|post[_\-. ]?code|postcode|country|city|town|location|state|province|region|address[_\-. ]?(line[_\-. ]?[123]|[123])?|street|birthday|date[_\-. ]?of[_\-. ]?birth|dob|gender|sex)$/i;

  // Label-text patterns that identify profile/identity fields that don't benefit from LLM
  var PROFILE_LABEL_RE = /\b(legal[\s_\-]?name|linkedin|github|gitlab|bitbucket|twitter|x\.com|portfolio|website|blog|discord|instagram|facebook|youtube|social[\s_\-]?media|profile[\s_\-]?(url|link|page)?|personal[\s_\-]?(url|site|website|homepage)|homepage|handle)\b/i;

  var runtimeEnabled = false;
  var runtimeAutoPrefetch = true;

  // ── Answer pre-fetch cache ───────────────────────────────────────────────
  // Keyed by normalised question string. Values: { answer, pending }
  var answerCache = new Map();
  var prefetchQueue = [];
  var prefetchBusy = false;

  function cacheKey(question) {
    return String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function drainPrefetchQueue() {
    if (prefetchBusy || !prefetchQueue.length) { return; }
    prefetchBusy = true;
    var item = prefetchQueue.shift();
    var key = item.key;
    if (answerCache.has(key)) { prefetchBusy = false; drainPrefetchQueue(); return; }
    answerCache.set(key, { answer: null, pending: true });
    chrome.runtime.sendMessage(
      { type: "AIIA_GENERATE_ANSWER", payload: item.payload },
      function (response) {
        if (!chrome.runtime.lastError && response && response.ok) {
          answerCache.set(key, { answer: response.answer, pending: false });
        } else {
          answerCache.delete(key);
        }
        prefetchBusy = false;
        setTimeout(drainPrefetchQueue, 300);
      }
    );
  }

  function schedulePrefetch(question, pageContext, pageUrl) {
    var key = cacheKey(question);
    if (!key || answerCache.has(key)) { return; }
    prefetchQueue.push({
      key: key,
      payload: { question: question, pageContext: pageContext, existingText: "", pageUrl: pageUrl }
    });
    setTimeout(drainPrefetchQueue, 0);
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (result) {
        resolve(result || {});
      });
    });
  }

  function normalizeHost(hostname) {
    return String(hostname || "").toLowerCase().replace(/^www\./, "");
  }

  function getCurrentHost() {
    return normalizeHost(window.location.hostname);
  }

  function isDomainEnabled(prefs, host) {
    if (!prefs || !prefs.globalEnabled || !host) {
      return false;
    }

    return Boolean(prefs.enabledDomains && prefs.enabledDomains[host]);
  }

  function clearInjectedButtons() {
    document.querySelectorAll("." + BUTTON_CLASS).forEach(function (button) {
      button.remove();
    });

    document.querySelectorAll("[" + FIELD_MARK + "]").forEach(function (field) {
      field.removeAttribute(FIELD_MARK);
    });

    // Drop cached answers — they belong to this page session only
    answerCache.clear();
    prefetchQueue.length = 0;
  }

  async function refreshRuntimeMode() {
    var data = await storageGet([PREFS_KEY]);
    var prefs = Object.assign(
      {
        globalEnabled: true,
        enabledDomains: {},
        autoPrefetch: true
      },
      data[PREFS_KEY] || {}
    );

    runtimeAutoPrefetch = prefs.autoPrefetch !== false;

    var nextEnabled = isDomainEnabled(prefs, getCurrentHost());
    if (nextEnabled === runtimeEnabled) {
      return;
    }

    runtimeEnabled = nextEnabled;

    if (!runtimeEnabled) {
      clearInjectedButtons();
      return;
    }

    sweepDocument();
  }

  // Lightweight label reader for use inside isSupportedField (no DOM mutation)
  function getQuickLabelText(element) {
    if (element.id) {
      try {
        var lbl = document.querySelector("label[for='" + CSS.escape(element.id) + "']");
        if (lbl) { return String(lbl.innerText || ""); }
      } catch (_) {}
    }
    var ariaLbl = element.getAttribute("aria-label");
    if (ariaLbl) { return ariaLbl; }
    var parentLbl = element.closest("label");
    if (parentLbl) { return String(parentLbl.innerText || ""); }
    var lblBy = element.getAttribute("aria-labelledby");
    if (lblBy) {
      var lbEl = document.getElementById(lblBy.split(/\s+/)[0]);
      if (lbEl) { return String(lbEl.innerText || ""); }
    }
    return element.getAttribute("placeholder") || "";
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    var style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function isWired(field) {
    return field.hasAttribute(FIELD_MARK);
  }

  function isSupportedField(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.disabled || element.readOnly) {
      return false;
    }

    if (element instanceof HTMLTextAreaElement) {
      return true;
    }

    if (element instanceof HTMLInputElement) {
      var inputType = (element.type || "text").toLowerCase();
      if (!VALID_INPUT_TYPES.has(inputType)) {
        return false;
      }
      // email and tel inputs are always browser-autofillable — skip
      if (inputType === "email" || inputType === "tel") {
        return false;
      }
      // Skip if the autocomplete attribute is a standard personal-data token
      var acAttr = (element.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
      if (acAttr.some(function (tok) { return BROWSER_AUTOFILL_AC.has(tok); })) {
        return false;
      }
      // Skip if name or id clearly matches a personal-data field
      var fieldName = (element.name || element.id || "");
      if (AUTOFILL_NAME_RE.test(fieldName)) {
        return false;
      }
      // Skip if the visible label text identifies a profile/social/identity field
      var labelText = getQuickLabelText(element);
      if (labelText && PROFILE_LABEL_RE.test(labelText)) {
        return false;
      }
      // Skip inputs that are actually custom dropdowns / comboboxes
      var role = (element.getAttribute("role") || "").toLowerCase();
      if (role === "combobox" || role === "listbox") {
        return false;
      }
      if (element.hasAttribute("aria-haspopup")) {
        return false;
      }
      var ariaAutoComplete = (element.getAttribute("aria-autocomplete") || "").toLowerCase();
      if (ariaAutoComplete === "list" || ariaAutoComplete === "both") {
        return false;
      }
      if ((element.getAttribute("inputmode") || "").toLowerCase() === "none") {
        return false;
      }
      if (element.hasAttribute("list")) {
        return false;
      }
      // Placeholder "Select..." is a dead giveaway for a styled dropdown
      var ph = (element.getAttribute("placeholder") || "").trim().toLowerCase();
      if (ph === "select..." || ph === "select" || ph === "-- select --" || ph === "--select--") {
        return false;
      }
      // If a nearby ancestor (up to 4 levels) is itself a combobox wrapper
      var anc = element.parentElement;
      for (var depth = 0; depth < 4 && anc; depth++) {
        var ancRole = (anc.getAttribute("role") || "").toLowerCase();
        if (ancRole === "combobox" || ancRole === "listbox") { return false; }
        var ancCls = (typeof anc.className === "string" ? anc.className : "").toLowerCase();
        if (/\bselect\b|\bdropdown\b|\bpicker\b|\bchoices\b|\bselectize\b/.test(ancCls)) { return false; }
        anc = anc.parentElement;
      }
      // If computed cursor is pointer the field is a clickable control, not typeable
      try {
        if (window.getComputedStyle(element).cursor === "pointer") { return false; }
      } catch (_) {}
      return true;
    }

    return false;
  }

  function isTargetField(element) {
    if (!runtimeEnabled) {
      return false;
    }

    if (!isSupportedField(element)) {
      return false;
    }

    if (isWired(element)) {
      return false;
    }

    return isVisible(element);
  }

  function uniqueNonEmpty(values) {
    var seen = new Set();
    var output = [];

    values.forEach(function (value) {
      var trimmed = String(value || "").replace(/\s+/g, " ").trim();
      if (!trimmed) {
        return;
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        output.push(trimmed);
      }
    });

    return output;
  }

  function findAssociatedLabel(field) {
    var values = [];

    if (field.id) {
      try {
        document.querySelectorAll("label[for='" + CSS.escape(field.id) + "']").forEach(function (label) {
          values.push(label.innerText);
        });
      } catch (_error) {
      }
    }

    var parentLabel = field.closest("label");
    if (parentLabel) {
      values.push(parentLabel.innerText);
    }

    var ariaLabel = field.getAttribute("aria-label");
    if (ariaLabel) {
      values.push(ariaLabel);
    }

    var labelledBy = field.getAttribute("aria-labelledby");
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          values.push(el.innerText);
        }
      });
    }

    var legend = field.closest("fieldset") && field.closest("fieldset").querySelector("legend");
    if (legend) {
      values.push(legend.innerText);
    }

    var container = field.closest("div, section, article, li, form");
    if (container) {
      var contextNode = container.querySelector("h1, h2, h3, h4, p, span");
      if (contextNode) {
        values.push(contextNode.innerText);
      }
    }

    values.push(field.getAttribute("placeholder"));
    values.push(field.getAttribute("name"));

    return uniqueNonEmpty(values).slice(0, 3).join(" | ");
  }

  function getPageContext() {
    var title = document.title || "";
    var h1 = document.querySelector("h1");
    var h2 = document.querySelector("h2");
    var site = document.querySelector("meta[property='og:site_name']");

    var contextParts = uniqueNonEmpty([
      title,
      h1 && h1.innerText,
      h2 && h2.innerText,
      site && site.getAttribute("content"),
      window.location.hostname,
      window.location.pathname
    ]);

    return contextParts.join(" | ");
  }

  function setElementValue(element, value) {
    var prototype = Object.getPrototypeOf(element);
    var descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillField(field, button) {
    var question = findAssociatedLabel(field);
    var pageContext = getPageContext();
    var key = cacheKey(question);
    var cached = answerCache.get(key);

    // ── Instant fill from cache ──────────────────────────────────────────
    if (cached && !cached.pending && cached.answer) {
      setElementValue(field, cached.answer);
      return;
    }

    // ── Still generating (prefetch in flight) — wait for it ─────────────
    if (cached && cached.pending) {
      var oldText = button.textContent;
      button.textContent = "Filling...";
      button.disabled = true;
      var pollInterval = setInterval(function () {
        var fresh = answerCache.get(key);
        if (!fresh || !fresh.pending) {
          clearInterval(pollInterval);
          button.disabled = false;
          button.textContent = oldText;
          if (fresh && fresh.answer) {
            setElementValue(field, fresh.answer);
          }
        }
      }, 200);
      return;
    }

    // ── No cache — send fresh request ────────────────────────────────────
    var oldText = button.textContent;
    button.textContent = "Filling...";
    button.disabled = true;

    chrome.runtime.sendMessage(
      {
        type: "AIIA_GENERATE_ANSWER",
        payload: {
          question: question,
          pageContext: pageContext,
          existingText: field.value || "",
          pageUrl: window.location.href
        }
      },
      function (response) {
        button.disabled = false;
        button.textContent = oldText;

        if (chrome.runtime.lastError) {
          console.error("AIIA message error:", chrome.runtime.lastError.message);
          return;
        }

        if (!response || !response.ok) {
          console.error("AIIA generation failed:", response && response.error);
          return;
        }

        answerCache.set(key, { answer: response.answer, pending: false });
        setElementValue(field, response.answer);
      }
    );
  }

  function addButton(field) {
    if (!runtimeEnabled || isWired(field)) {
      return;
    }

    field.setAttribute(FIELD_MARK, "1");

    var button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "✨ Fill in my Voice";

    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      fillField(field, button);
    });

    field.insertAdjacentElement("afterend", button);

    // Kick off background pre-fetch so answer is ready before user clicks
    if (runtimeAutoPrefetch) {
      var question = findAssociatedLabel(field);
      schedulePrefetch(question, getPageContext(), window.location.href);
    }
  }

  function wireNode(root) {
    if (!runtimeEnabled || !root) {
      return;
    }

    if (isTargetField(root)) {
      addButton(root);
    }

    if (!(root instanceof Element)) {
      return;
    }

    root.querySelectorAll("textarea, input").forEach(function (field) {
      if (isTargetField(field)) {
        addButton(field);
      }
    });
  }

  function sweepDocument() {
    if (!runtimeEnabled) {
      return;
    }
    wireNode(document.body);
  }

  function scrapeLinkedInProfile() {
    if (window.location.hostname.indexOf("linkedin.com") === -1) {
      throw new Error("Open a LinkedIn profile page first.");
    }

    var path = String(window.location.pathname || "").toLowerCase();
    if (!/^\/(in|pub)\//.test(path)) {
      throw new Error("Open a public LinkedIn profile URL (linkedin.com/in/...) first.");
    }

    var main = document.querySelector("main");
    if (!main) {
      throw new Error("Could not find LinkedIn profile content in this page.");
    }

    var selectors = "h1, h2, h3, p, li, span[aria-hidden='true']";
    var sectionHeadingRegex = /about|experience|education|skills|project|certification|volunteer|honor|award|publication|activity|summary/i;
    var blockedExact = new Set([
      "message",
      "follow",
      "connect",
      "more",
      "see all",
      "home",
      "jobs",
      "network",
      "promoted"
    ]);
    var blockedContains = [
      "promoted",
      "explore relevant opportunities",
      "latest jobs and industry news",
      "people also viewed",
      "suggested for you",
      "try premium",
      "advertisement",
      "ad "
    ];

    function shouldSkipText(text) {
      var lower = text.toLowerCase();
      if (blockedExact.has(lower)) {
        return true;
      }
      return blockedContains.some(function (token) {
        return lower.indexOf(token) !== -1;
      });
    }

    function collectFromScope(scope, textParts, seen, maxLines) {
      scope.querySelectorAll(selectors).forEach(function (node) {
        if (textParts.length >= maxLines || !isVisible(node)) {
          return;
        }

        var text = String(node.innerText || "").replace(/\s+/g, " ").trim();
        if (text.length < 4 || text.length > 320 || shouldSkipText(text)) {
          return;
        }

        if (!seen.has(text)) {
          seen.add(text);
          textParts.push(text);
        }
      });
    }

    var scopes = [];
    var scopeSet = new Set();

    function pushScope(node) {
      if (!node || scopeSet.has(node)) {
        return;
      }
      scopeSet.add(node);
      scopes.push(node);
    }

    pushScope(main.querySelector(".pv-top-card"));
    pushScope(main.querySelector("section.artdeco-card"));

    main.querySelectorAll("section").forEach(function (section) {
      var heading = section.querySelector("h2, h3");
      var title = String((heading && heading.innerText) || "").trim();
      if (sectionHeadingRegex.test(title)) {
        pushScope(section);
      }
    });

    if (!scopes.length) {
      pushScope(main);
    }

    var textParts = [];
    var seen = new Set();

    scopes.forEach(function (scope) {
      collectFromScope(scope, textParts, seen, 420);
    });

    if (textParts.length < 8) {
      collectFromScope(main, textParts, seen, 420);
    }

    var output = textParts.join("\n").trim();
    if (!output) {
      throw new Error("Could not extract profile text from this LinkedIn page.");
    }

    return output.slice(0, 60000);
  }

  function scrapeCompanyPage() {
    if (!/^https?:$/i.test(window.location.protocol)) {
      throw new Error("Open a company or job page in a regular website tab first.");
    }

    function cleanText(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function shouldSkip(text) {
      var lower = text.toLowerCase();
      if (lower.length < 4 || lower.length > 700) {
        return true;
      }

      var blockedContains = [
        "cookie",
        "privacy policy",
        "terms of service",
        "sign in",
        "log in",
        "subscribe",
        "enable javascript",
        "share this",
        "advertisement",
        // --- extension-injected form UI that bleeds into scraped text ---
        "fill in my voice",
        "accepted file types",
        "enter manually",
        "attach attach",
        "dropbox google drive"
      ];

      return blockedContains.some(function (token) {
        return lower.indexOf(token) !== -1;
      });
    }

    function scoreScope(scope) {
      var text = cleanText(scope.innerText || "");
      if (text.length < 120) {
        return -1;
      }

      var keywordRegex = /intern|internship|job|role|responsibilit|requirement|qualification|about the team|about us|what you'll do|skills|experience|benefit|apply/i;
      var matches = text.match(keywordRegex);
      var keywordScore = matches ? matches.length : 0;
      var lengthScore = Math.min(text.length / 1800, 15);
      return keywordScore * 3 + lengthScore;
    }

    var candidates = [];
    var seen = new Set();

    function addCandidate(node) {
      if (!node || seen.has(node) || !isVisible(node)) {
        return;
      }
      seen.add(node);
      candidates.push(node);
    }

    addCandidate(document.querySelector("main"));
    addCandidate(document.querySelector("[role='main']"));
    addCandidate(document.querySelector("article"));
    document.querySelectorAll("section").forEach(addCandidate);

    if (!candidates.length) {
      addCandidate(document.body);
    }

    candidates.sort(function (a, b) {
      return scoreScope(b) - scoreScope(a);
    });

    var selectedScopes = candidates.slice(0, 4);
    var lines = [];
    var lineSet = new Set();
    var selectors = "h1, h2, h3, h4, p, li, span, div";

    var pageTitle = cleanText(document.title || "");
    var metaDescriptionNode = document.querySelector("meta[name='description']");
    var metaDescription = cleanText(metaDescriptionNode && metaDescriptionNode.getAttribute("content"));

    [pageTitle, metaDescription].forEach(function (text) {
      if (text && !shouldSkip(text) && !lineSet.has(text)) {
        lineSet.add(text);
        lines.push(text);
      }
    });

    selectedScopes.forEach(function (scope) {
      scope.querySelectorAll(selectors).forEach(function (node) {
        if (!isVisible(node)) {
          return;
        }

        // Skip our own injected extension buttons and any element they're inside
        if (node.classList.contains(BUTTON_CLASS) || node.closest("." + BUTTON_CLASS)) {
          return;
        }

        var text = cleanText(node.innerText || "");
        if (!text || shouldSkip(text)) {
          return;
        }

        if (!lineSet.has(text)) {
          lineSet.add(text);
          lines.push(text);
        }
      });
    });

    var output = lines.join("\n").trim();
    if (!output) {
      throw new Error("Could not extract company/job context from this page.");
    }

    return {
      text: output.slice(0, 80000),
      pageTitle: pageTitle
    };
  }

  function init() {
    var observer = new MutationObserver(function (mutations) {
      if (!runtimeEnabled) {
        return;
      }

      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node instanceof Element) {
            wireNode(node);
          }
        });

        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          var target = mutation.target;
          if (isSupportedField(target) && !isWired(target) && isVisible(target)) {
            addButton(target);
          }
        }
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "disabled", "readonly", "aria-hidden", "type"]
    });

    document.addEventListener("focusin", function (event) {
      if (!runtimeEnabled) {
        return;
      }

      var target = event.target;
      if (isSupportedField(target) && !isWired(target) && isVisible(target)) {
        addButton(target);
      }
    });

    window.setInterval(sweepDocument, SCAN_INTERVAL_MS);

    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === "local" && changes[PREFS_KEY]) {
        refreshRuntimeMode().catch(function (error) {
          console.error("AIIA pref refresh failed:", error.message);
        });
      }
    });

    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || !message.type) {
        return;
      }

      if (message.type === "AIIA_GET_CACHE_STATUS") {
        var fields = [];
        answerCache.forEach(function (val, key) {
          fields.push({
            question: key,
            ready: !val.pending,
            preview: val.answer ? val.answer.slice(0, 80) : null
          });
        });
        sendResponse({ ok: true, enabled: runtimeEnabled, fields: fields });
        return;
      }

      if (message.type === "AIIA_REFRESH_PREFS") {
        refreshRuntimeMode()
          .then(function () {
            sendResponse({ ok: true, enabled: runtimeEnabled });
          })
          .catch(function (error) {
            sendResponse({ ok: false, error: error.message });
          });
        return true;
      }

      if (message.type === "AIIA_SCRAPE_LINKEDIN") {
        if (window.top !== window) {
          return;
        }

        try {
          var extracted = scrapeLinkedInProfile();
          sendResponse({ ok: true, text: extracted });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      }

      if (message.type === "AIIA_SCRAPE_COMPANY") {
        if (window.top !== window) {
          return;
        }

        try {
          var scraped = scrapeCompanyPage();
          sendResponse({ ok: true, text: scraped.text, pageTitle: scraped.pageTitle });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      }
    });

    refreshRuntimeMode().catch(function (error) {
      console.error("AIIA init failed:", error.message);
    });
  }

  init();
})();
