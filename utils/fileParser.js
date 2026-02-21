(function (global) {
  "use strict";

  var TEXT_EXTENSIONS = new Set([
    "txt",
    "md",
    "markdown",
    "json",
    "csv",
    "tsv",
    "yaml",
    "yml",
    "xml",
    "html",
    "htm",
    "rtf",
    "log",
    "tex",
    "js",
    "ts",
    "py",
    "java",
    "go",
    "rs",
    "c",
    "cpp",
    "cs",
    "php",
    "rb",
    "swift",
    "kt",
    "scala"
  ]);

  var MAX_FILE_CHARS = 70000;

  function normalizeWhitespace(text) {
    return String(text || "")
      .replace(/\u0000/g, "")
      .replace(/\r/g, "")
      .replace(/\t/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getExtension(filename) {
    var name = String(filename || "");
    var index = name.lastIndexOf(".");
    if (index < 0) {
      return "";
    }
    return name.slice(index + 1).toLowerCase();
  }

  function truncateText(text, limit) {
    var max = typeof limit === "number" ? limit : MAX_FILE_CHARS;
    if (text.length <= max) {
      return text;
    }
    return text.slice(0, max) + "\n\n[Truncated for indexing size limits]";
  }

  function stripHtml(html) {
    try {
      var doc = new DOMParser().parseFromString(html, "text/html");
      return normalizeWhitespace(doc.body ? doc.body.innerText : html);
    } catch (_error) {
      return normalizeWhitespace(html);
    }
  }

  function stripRtf(text) {
    return normalizeWhitespace(
      String(text || "")
        .replace(/\\par[d]?/g, "\n")
        .replace(/\\'[0-9a-fA-F]{2}/g, "")
        .replace(/\\[a-z]+-?\d* ?/g, "")
        .replace(/[{}]/g, "")
    );
  }

  function binaryToBestEffortText(buffer) {
    var utf8Text = "";

    try {
      utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    } catch (_error) {
      utf8Text = "";
    }

    var printable = String(utf8Text || "")
      .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (printable.length > 80) {
      return normalizeWhitespace(printable);
    }

    var bytes = new Uint8Array(buffer);
    var chars = [];
    for (var i = 0; i < bytes.length; i += 1) {
      var code = bytes[i];
      if (code >= 32 && code <= 126) {
        chars.push(String.fromCharCode(code));
      } else {
        chars.push(" ");
      }
    }

    return normalizeWhitespace(chars.join("").replace(/\s{2,}/g, " "));
  }

  async function parsePdf(file) {
    if (!global.pdfjsLib || !global.pdfjsLib.getDocument) {
      throw new Error("PDF parser unavailable.");
    }

    if (global.pdfjsLib.GlobalWorkerOptions) {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");
    }

    var buffer = await file.arrayBuffer();
    var loadingTask = global.pdfjsLib.getDocument({ data: buffer });
    var pdf = await loadingTask.promise;
    var pageTexts = [];

    for (var i = 1; i <= pdf.numPages; i += 1) {
      var page = await pdf.getPage(i);
      var content = await page.getTextContent();
      var text = content.items.map(function (item) {
        return item.str;
      }).join(" ");
      if (text) {
        pageTexts.push(text);
      }
    }

    return normalizeWhitespace(pageTexts.join("\n"));
  }

  async function parseDocx(file) {
    if (!global.mammoth || !global.mammoth.extractRawText) {
      throw new Error("DOCX parser unavailable.");
    }

    var result = await global.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return normalizeWhitespace(result.value || "");
  }

  async function parseTextLikeFile(file, extension) {
    var raw = await file.text();

    if (extension === "html" || extension === "htm") {
      return stripHtml(raw);
    }

    if (extension === "rtf") {
      return stripRtf(raw);
    }

    return normalizeWhitespace(raw);
  }

  async function extractTextFromFile(file) {
    var ext = getExtension(file.name);
    var contentType = String(file.type || "").toLowerCase();
    var method = "text";
    var text = "";

    if (ext === "pdf") {
      method = "pdf";
      text = await parsePdf(file);
      return {
        text: truncateText(text),
        method: method,
        name: file.name
      };
    }

    if (ext === "docx") {
      method = "docx";
      text = await parseDocx(file);
      return {
        text: truncateText(text),
        method: method,
        name: file.name
      };
    }

    if (TEXT_EXTENSIONS.has(ext) || contentType.indexOf("text/") === 0 || contentType.indexOf("json") !== -1) {
      method = "text";
      text = await parseTextLikeFile(file, ext);
      return {
        text: truncateText(text),
        method: method,
        name: file.name
      };
    }

    method = "binary-fallback";
    text = binaryToBestEffortText(await file.arrayBuffer());

    return {
      text: truncateText(text),
      method: method,
      name: file.name
    };
  }

  async function extractTextFromFiles(files, onProgress) {
    var list = Array.from(files || []);
    var summaries = [];
    var fragments = [];

    for (var i = 0; i < list.length; i += 1) {
      var file = list[i];
      var summary = {
        name: file.name,
        size: file.size,
        method: "",
        chars: 0,
        success: false,
        error: ""
      };

      try {
        var extracted = await extractTextFromFile(file);
        var text = normalizeWhitespace(extracted.text || "");

        if (!text) {
          throw new Error("No text could be extracted.");
        }

        summary.method = extracted.method;
        summary.chars = text.length;
        summary.success = true;

        fragments.push(text);
      } catch (error) {
        summary.error = error.message || "Unknown parsing error";
      }

      summaries.push(summary);
      if (typeof onProgress === "function") {
        onProgress({
          current: i + 1,
          total: list.length,
          summary: summary
        });
      }
    }

    return {
      combinedText: fragments.join("\n\n"),
      summaries: summaries
    };
  }

  global.FileParser = {
    extractTextFromFiles: extractTextFromFiles
  };
})(self);
