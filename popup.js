(function () {
  "use strict";

  var SETTINGS_KEY = "aiia_settings";
  var PREFS_KEY = "aiia_preferences";

  var globalToggle = document.getElementById("globalToggle");
  var siteToggle = document.getElementById("siteToggle");
  var autoPrefetchToggle = document.getElementById("autoPrefetchToggle");
  var siteLabel = document.getElementById("siteLabel");
  var toggleHint = document.getElementById("toggleHint");
  var prefetchCard = document.getElementById("prefetchCard");
  var prefetchList = document.getElementById("prefetchList");
  var prefetchSummary = document.getElementById("prefetchSummary");
  var statusText = document.getElementById("status");
  var scrapeLinkedInButton = document.getElementById("scrapeLinkedInBtn");
  var scrapeCompanyButton = document.getElementById("scrapeCompanyBtn");
  var generateCoverLetterButton = document.getElementById("generateCoverLetterBtn");
  var openSettingsButton = document.getElementById("openSettingsBtn");

  var activeTab = null;
  var activeHost = "";
  var currentPrefs = {
    globalEnabled: true,
    enabledDomains: {},
    autoPrefetch: true
  };

  var clReviewCard   = document.getElementById("clReviewCard");
  var clReviewText   = document.getElementById("clReviewText");
  var clDownloadBtn  = document.getElementById("clDownloadBtn");
  var clCancelBtn    = document.getElementById("clCancelBtn");
  var actionsCard    = document.querySelector(".card.actions");
  var clSourceTitle  = ""; // saved for filename

  function setStatus(message, variant) {
    statusText.textContent = message || "";
    statusText.className = "status" + (variant ? " " + variant : "");
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (result) {
        resolve(result || {});
      });
    });
  }

  function storageSet(payload) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function normalizeHost(hostname) {
    return String(hostname || "").toLowerCase().replace(/^www\./, "");
  }

  function parseHostFromUrl(url) {
    try {
      var parsed = new URL(url);
      if (!/^https?:$/i.test(parsed.protocol)) {
        return "";
      }
      return normalizeHost(parsed.hostname);
    } catch (_error) {
      return "";
    }
  }

  function isSiteEnabled(prefs, host) {
    if (!prefs.globalEnabled || !host) {
      return false;
    }
    return Boolean(prefs.enabledDomains && prefs.enabledDomains[host]);
  }

  function refreshToggleState() {
    globalToggle.checked = Boolean(currentPrefs.globalEnabled);

    if (!activeHost) {
      siteToggle.checked = false;
      siteToggle.disabled = true;
      siteLabel.textContent = "No supported page open";
      toggleHint.textContent = "Open a website tab, then enable it there.";
      scrapeLinkedInButton.disabled = true;
      scrapeCompanyButton.disabled = true;
      generateCoverLetterButton.disabled = true;
      return;
    }

    siteToggle.disabled = !currentPrefs.globalEnabled;
    siteToggle.checked = isSiteEnabled(currentPrefs, activeHost);
    siteLabel.textContent = activeHost;
    autoPrefetchToggle.disabled = !isSiteEnabled(currentPrefs, activeHost);
    autoPrefetchToggle.checked = currentPrefs.autoPrefetch !== false;

    var siteOn = isSiteEnabled(currentPrefs, activeHost);
    var masterOn = Boolean(currentPrefs.globalEnabled);
    var prefetchOn = currentPrefs.autoPrefetch !== false;
    if (!masterOn) {
      toggleHint.textContent = "Master switch is off \u2014 fill buttons are disabled everywhere. Turn it on to use this site.";
      toggleHint.style.color = "var(--warn)";
    } else if (!siteOn) {
      toggleHint.textContent = "Toggle \u201cEnable on this site\u201d to show fill buttons on " + activeHost + ".";
      toggleHint.style.color = "var(--muted)";
    } else if (prefetchOn) {
      toggleHint.textContent = "\u2713 Active on " + activeHost + ". Answers are pre-fetched automatically in the background.";
      toggleHint.style.color = "var(--ok)";
    } else {
      toggleHint.textContent = "\u2713 Active on " + activeHost + ". Manual mode: click a button to generate an answer on demand.";
      toggleHint.style.color = "var(--ok)";
    }

    var isLinkedIn = activeHost.indexOf("linkedin.com") !== -1;
    scrapeLinkedInButton.disabled = !isLinkedIn;
    scrapeCompanyButton.disabled = false;
    generateCoverLetterButton.disabled = false;
  }

  function savePrefs() {
    return storageSet({
      aiia_preferences: currentPrefs
    });
  }

  function notifyActiveTabPrefsUpdated() {
    if (!activeTab || !activeTab.id) {
      return;
    }

    chrome.tabs.sendMessage(activeTab.id, { type: "AIIA_REFRESH_PREFS" }, { frameId: 0 }, function () {
      void chrome.runtime.lastError;
    });
  }

  async function handleGlobalToggle() {
    currentPrefs.globalEnabled = globalToggle.checked;
    await savePrefs();
    refreshToggleState();
    notifyActiveTabPrefsUpdated();
    setStatus("Master setting updated.", "ok");
  }

  async function handleSiteToggle() {
    if (!activeHost) {
      return;
    }

    if (!currentPrefs.enabledDomains) {
      currentPrefs.enabledDomains = {};
    }

    currentPrefs.enabledDomains[activeHost] = siteToggle.checked;
    await savePrefs();
    refreshToggleState();
    notifyActiveTabPrefsUpdated();
    setStatus(siteToggle.checked ? "Enabled on " + activeHost + "." : "Disabled on " + activeHost + ".", "ok");
  }

  async function handleAutoPrefetchToggle() {
    currentPrefs.autoPrefetch = autoPrefetchToggle.checked;
    await savePrefs();
    refreshToggleState();
    notifyActiveTabPrefsUpdated();
    setStatus(autoPrefetchToggle.checked ? "Auto pre-fetch enabled." : "Manual mode: click to generate.", "ok");
  }

  function readActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve((tabs && tabs[0]) || null);
      });
    });
  }

  function sendTabMessage(tabId, message) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || {});
      });
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || {});
      });
    });
  }

  function sanitizeFilenamePart(value) {
    return String(value || "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 56) || "Company";
  }

  function buildCoverLetterPdf(letterText, sourceTitle) {
    var jspdfNs = window.jspdf;
    if (!jspdfNs || !jspdfNs.jsPDF) {
      throw new Error("PDF library failed to load.");
    }

    var doc = new jspdfNs.jsPDF({
      unit: "pt",
      format: "letter"
    });

    doc.setFont("times", "normal");
    doc.setFontSize(11);

    var pageWidth = doc.internal.pageSize.getWidth();
    var pageHeight = doc.internal.pageSize.getHeight();
    var margin = 72;
    var maxWidth = pageWidth - margin * 2;
    var lineHeight = 14.5;
    var y = margin;
    var maxY = pageHeight - margin;
    var paragraphs = String(letterText || "").replace(/\r/g, "").split(/\n+/);
    var clipped = false;

    for (var i = 0; i < paragraphs.length; i += 1) {
      var paragraph = paragraphs[i].trim();
      if (!paragraph) {
        y += lineHeight;
        if (y > maxY) {
          clipped = true;
          break;
        }
        continue;
      }

      var lines = doc.splitTextToSize(paragraph, maxWidth);
      for (var j = 0; j < lines.length; j += 1) {
        if (y > maxY) {
          clipped = true;
          break;
        }
        doc.text(lines[j], margin, y);
        y += lineHeight;
      }

      if (y > maxY) {
        clipped = true;
        break;
      }

      y += 4;
    }

    var filePart = sanitizeFilenamePart(sourceTitle || activeHost || "Company");
    doc.save("Cover_Letter_" + filePart + ".pdf");
    return { clipped: clipped };
  }

  async function handleLinkedInImport() {
    if (!activeTab || !activeTab.id) {
      setStatus("No active tab available.", "warn");
      return;
    }

    scrapeLinkedInButton.disabled = true;
    setStatus("Scraping LinkedIn profile text...", "");

    try {
      var result = await sendTabMessage(activeTab.id, { type: "AIIA_SCRAPE_LINKEDIN" });
      if (!result || !result.ok || !result.text) {
        throw new Error((result && result.error) || "Could not extract profile text from this page.");
      }

      var data = await storageGet([SETTINGS_KEY]);
      var settings = data[SETTINGS_KEY] || {};

      settings.linkedinText = result.text;
      settings.linkedinSource = activeTab.url || "";
      settings.linkedinUpdatedAt = new Date().toISOString();

      await storageSet({ aiia_settings: settings });
      setStatus("LinkedIn imported. Open Full Settings and click Save & Reindex.", "ok");
    } catch (error) {
      setStatus("LinkedIn import failed: " + error.message, "warn");
    } finally {
      scrapeLinkedInButton.disabled = false;
    }
  }

  async function handleCompanyImport() {
    if (!activeTab || !activeTab.id) {
      setStatus("No active tab available.", "warn");
      return;
    }

    scrapeCompanyButton.disabled = true;
    setStatus("Scraping company/job page text...", "");

    try {
      var result = await sendTabMessage(activeTab.id, { type: "AIIA_SCRAPE_COMPANY" });
      if (!result || !result.ok || !result.text) {
        throw new Error((result && result.error) || "Could not extract company data from this page.");
      }

      var data = await storageGet([SETTINGS_KEY]);
      var settings = data[SETTINGS_KEY] || {};

      settings.companyScrapedText = result.text;
      settings.companyUrl = activeTab.url || settings.companyUrl || "";
      settings.companySourceTitle = result.pageTitle || "";
      settings.companyUpdatedAt = new Date().toISOString();

      await storageSet({ aiia_settings: settings });
      setStatus("Company page imported. Open Full Settings and click Save & Reindex.", "ok");
    } catch (error) {
      setStatus("Company import failed: " + error.message, "warn");
    } finally {
      refreshToggleState();
    }
  }

  async function handleGenerateCoverLetter() {
    if (!activeTab || !activeTab.id) {
      setStatus("No active tab available.", "warn");
      return;
    }

    generateCoverLetterButton.disabled = true;
    setStatus("Generating one-page cover letter...", "");

    try {
      var scrapeResult;
      try {
        scrapeResult = await sendTabMessage(activeTab.id, { type: "AIIA_SCRAPE_COMPANY" });
      } catch (_error) {
        scrapeResult = null;
      }

      var payload = {
        pageUrl: activeTab.url || "",
        pageContext: (scrapeResult && scrapeResult.pageTitle) || activeTab.title || activeHost || "",
        jobPageText: (scrapeResult && scrapeResult.text) || ""
      };

      var response = await sendRuntimeMessage({
        type: "AIIA_GENERATE_COVER_LETTER",
        payload: payload
      });

      if (!response || !response.ok || !response.letter) {
        throw new Error((response && response.error) || "Cover letter generation failed.");
      }

      // Show review/edit panel instead of downloading immediately
      clSourceTitle = payload.pageContext;
      clReviewText.value = response.letter;
      actionsCard.style.display = "none";
      clReviewCard.style.display = "block";
      document.body.style.width = "560px";
      setStatus("Review and edit below, then click Download PDF.", "ok");
    } catch (error) {
      setStatus("Cover letter failed: " + error.message, "warn");
    } finally {
      generateCoverLetterButton.disabled = false;
      refreshToggleState();
    }
  }

  async function loadCacheStatus() {
    if (!activeTab || !activeTab.id) { return; }
    try {
      var response = await sendTabMessage(activeTab.id, { type: "AIIA_GET_CACHE_STATUS" });
      if (!response || !response.ok || !Array.isArray(response.fields)) { return; }
      var fields = response.fields;
      if (!fields.length) { return; }
      var ready = fields.filter(function (f) { return f.ready; }).length;
      var pending = fields.length - ready;
      prefetchSummary.textContent = ready + " ready" + (pending ? " \u00b7 " + pending + " loading" : "");
      prefetchList.innerHTML = fields.map(function (f) {
        var icon = f.ready ? "\u2713" : "\u231b";
        var color = f.ready ? "#2d8a3f" : "#9a6c1f";
        var label = f.question.length > 60 ? f.question.slice(0, 60) + "\u2026" : f.question;
        var preview = f.ready && f.preview ? "<div style='color:#888;margin-top:1px;padding-left:14px;'>" + f.preview.replace(/</g, "&lt;") + (f.preview.length >= 80 ? "\u2026" : "") + "</div>" : "";
        return "<div style='border-left:2px solid " + color + ";padding-left:6px;'>" +
          "<span style='color:" + color + ";font-weight:700;'>" + icon + "</span> " + label + preview + "</div>";
      }).join("");
      prefetchCard.style.display = "block";
    } catch (_) { /* content script not ready */ }
  }

  async function init() {
    var data = await storageGet([PREFS_KEY]);
    currentPrefs = Object.assign(
      {
        globalEnabled: true,
        enabledDomains: {},
        autoPrefetch: true
      },
      data[PREFS_KEY] || {}
    );

    activeTab = await readActiveTab();
    activeHost = parseHostFromUrl(activeTab && activeTab.url);

    refreshToggleState();
    await loadCacheStatus();
  }

  globalToggle.addEventListener("change", function () {
    handleGlobalToggle().catch(function (error) {
      setStatus("Failed to update setting: " + error.message, "warn");
    });
  });

  siteToggle.addEventListener("change", function () {
    handleSiteToggle().catch(function (error) {
      setStatus("Failed to update setting: " + error.message, "warn");
    });
  });

  autoPrefetchToggle.addEventListener("change", function () {
    handleAutoPrefetchToggle().catch(function (error) {
      setStatus("Failed to update setting: " + error.message, "warn");
    });
  });

  scrapeLinkedInButton.addEventListener("click", handleLinkedInImport);
  scrapeCompanyButton.addEventListener("click", handleCompanyImport);
  generateCoverLetterButton.addEventListener("click", handleGenerateCoverLetter);

  clDownloadBtn.addEventListener("click", function () {
    try {
      var pdfResult = buildCoverLetterPdf(clReviewText.value, clSourceTitle);
      setStatus(
        pdfResult.clipped ? "Downloaded (trimmed to one page)." : "Cover letter downloaded.",
        "ok"
      );
      clReviewCard.style.display = "none";
      actionsCard.style.display = "";
      document.body.style.width = "";
    } catch (err) {
      setStatus("PDF error: " + err.message, "warn");
    }
  });

  clCancelBtn.addEventListener("click", function () {
    clReviewCard.style.display = "none";
    actionsCard.style.display = "";
    document.body.style.width = "";
    setStatus("", "");
  });

  openSettingsButton.addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
  });

  init().catch(function (error) {
    setStatus("Popup failed: " + error.message, "warn");
  });
})();
