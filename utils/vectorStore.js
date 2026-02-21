(function (global) {
  "use strict";

  var DEFAULT_DIMENSION = 256;
  var DEFAULT_CHUNK_SIZE = 700;
  var DEFAULT_OVERLAP = 140;
  var DEFAULT_MIN_CHUNK = 80;

  var STOPWORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he", "in", "is", "it",
    "its", "of", "on", "that", "the", "to", "was", "were", "will", "with", "i", "you", "your", "my",
    "we", "our", "they", "their", "or", "if", "this", "those", "these", "into", "about", "than", "then"
  ]);
  var SINGLE_CHAR_TECH_TOKENS = new Set(["c", "r"]);

  function normalizeText(text) {
    return String(text || "").replace(/\r/g, "").trim();
  }

  function normalizeTechTerms(text) {
    var lowered = normalizeText(text).toLowerCase();

    return lowered
      .replace(/\bc\+\+\b/g, " cpp ")
      .replace(/\bc#\b/g, " csharp ")
      .replace(/\bf#\b/g, " fsharp ")
      .replace(/\b\.net\b/g, " dotnet ")
      .replace(/\bnode\.js\b/g, " nodejs ")
      .replace(/\bnext\.js\b/g, " nextjs ")
      .replace(/\breact\.js\b/g, " reactjs ")
      .replace(/\bvue\.js\b/g, " vuejs ")
      .replace(/\bexpress\.js\b/g, " expressjs ")
      .replace(/\bnuxt\.js\b/g, " nuxtjs ");
  }

  function normalizeForSemantic(text) {
    return normalizeTechTerms(text)
      .replace(/^\s*#{1,6}\s*/gm, " ")
      .replace(/^\s*[-*•]\s+/gm, " ")
      .replace(/[–—]/g, " ")
      .replace(/[^a-z0-9+#.\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function canonicalizeForDedup(text) {
    return normalizeText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function splitIntoChunks(text, options) {
    var normalized = normalizeText(text);
    if (!normalized) {
      return [];
    }

    var maxChars = (options && options.maxChars) || DEFAULT_CHUNK_SIZE;
    var overlapChars = (options && options.overlapChars) || DEFAULT_OVERLAP;
    var minChars = (options && options.minChars) || DEFAULT_MIN_CHUNK;

    maxChars = clamp(maxChars, 250, 2000);
    overlapChars = clamp(overlapChars, 0, Math.floor(maxChars * 0.5));

    var chunks = [];
    var cursor = 0;

    while (cursor < normalized.length) {
      var tentativeEnd = Math.min(cursor + maxChars, normalized.length);

      if (tentativeEnd < normalized.length) {
        var lookbackStart = Math.max(cursor + Math.floor(maxChars * 0.6), cursor);
        var lookback = normalized.slice(lookbackStart, tentativeEnd);
        var boundary = Math.max(
          lookback.lastIndexOf(". "),
          lookback.lastIndexOf("? "),
          lookback.lastIndexOf("! "),
          lookback.lastIndexOf("\n")
        );

        if (boundary > 20) {
          tentativeEnd = lookbackStart + boundary + 1;
        }
      }

      var chunk = normalized.slice(cursor, tentativeEnd).trim();
      if (chunk.length >= minChars) {
        chunks.push(chunk);
      }

      if (tentativeEnd >= normalized.length) {
        break;
      }

      var nextCursor = tentativeEnd - overlapChars;
      cursor = nextCursor > cursor ? nextCursor : cursor + 1;
    }

    if (!chunks.length && normalized.length) {
      chunks.push(normalized);
    }

    return chunks;
  }

  function tokenize(text) {
    var cleaned = normalizeForSemantic(text);

    if (!cleaned) {
      return [];
    }

    return cleaned
      .split(" ")
      .map(function (token) {
        return token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      })
      .filter(function (token) {
        if (!token) {
          return false;
        }
        if (STOPWORDS.has(token)) {
          return false;
        }
        if (token.length > 1) {
          return true;
        }
        return SINGLE_CHAR_TECH_TOKENS.has(token);
      });
  }

  function hashToken(token, seed) {
    var hash = (2166136261 ^ seed) >>> 0;
    for (var i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function vectorNorm(vector) {
    var sum = 0;
    for (var i = 0; i < vector.length; i += 1) {
      sum += vector[i] * vector[i];
    }
    return Math.sqrt(sum);
  }

  function embedSemantic(text, dimension) {
    var vector = new Array(dimension).fill(0);
    var tokens = tokenize(text);

    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i];
      var baseHash = hashToken(token, 17);
      var index = baseHash % dimension;
      var sign = ((baseHash >>> 1) & 1) === 0 ? 1 : -1;
      var weight = 1 + Math.log(1 + token.length);
      vector[index] += sign * weight;

      var altHash = hashToken(token, 97);
      var altIndex = altHash % dimension;
      var altSign = ((altHash >>> 1) & 1) === 0 ? 1 : -1;
      vector[altIndex] += altSign * weight * 0.45;
    }

    return vector;
  }

  function embedStyle(text, dimension) {
    var source = normalizeText(text);
    var vector = new Array(dimension).fill(0);

    if (!source) {
      return vector;
    }

    var words = source.split(/\s+/).filter(Boolean);
    var sentences = source.split(/[.!?]+/).map(function (s) {
      return s.trim();
    }).filter(Boolean);

    var wordCount = words.length || 1;
    var sentenceCount = sentences.length || 1;
    var chars = source.length || 1;

    var avgSentenceWords = wordCount / sentenceCount;
    var avgWordLength = words.reduce(function (sum, w) { return sum + w.length; }, 0) / wordCount;
    var questionRatio = (source.match(/\?/g) || []).length / sentenceCount;
    var exclaimRatio = (source.match(/!/g) || []).length / sentenceCount;
    var commaRatio = (source.match(/,/g) || []).length / sentenceCount;
    var semicolonRatio = (source.match(/;/g) || []).length / sentenceCount;
    var firstPersonRatio = (source.match(/\b(i|me|my|mine|we|our|ours)\b/gi) || []).length / wordCount;
    var contractionRatio = (source.match(/\b\w+'(m|re|ve|ll|d|s|t)\b/gi) || []).length / wordCount;
    var uppercaseRatio = (source.match(/[A-Z]/g) || []).length / chars;
    var uniqueRatio = new Set(words.map(function (w) { return w.toLowerCase(); })).size / wordCount;
    var newlineRatio = (source.match(/\n/g) || []).length / chars;
    var longSentenceRatio = sentences.filter(function (s) {
      return s.split(/\s+/).filter(Boolean).length > 25;
    }).length / sentenceCount;

    var features = [
      avgSentenceWords / 30,
      avgWordLength / 10,
      questionRatio,
      exclaimRatio,
      commaRatio,
      semicolonRatio,
      firstPersonRatio * 2,
      contractionRatio * 2,
      uppercaseRatio * 4,
      uniqueRatio,
      newlineRatio * 8,
      longSentenceRatio
    ];

    for (var i = 0; i < features.length; i += 1) {
      vector[i] = features[i];
    }

    return vector;
  }

  function combineVectors(base, overlay, overlayWeight) {
    var output = new Array(base.length);
    for (var i = 0; i < base.length; i += 1) {
      output[i] = base[i] + overlay[i] * overlayWeight;
    }
    return output;
  }

  function embedText(text, bankType, dimension) {
    var dim = dimension || DEFAULT_DIMENSION;
    var semantic = embedSemantic(text, dim);

    if (bankType === "voice") {
      var style = embedStyle(text, dim);
      return combineVectors(semantic, style, 3.2);
    }

    return semantic;
  }

  function dotProduct(a, b) {
    var sum = 0;
    for (var i = 0; i < a.length; i += 1) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  function cosineSimilarity(a, b, normA, normB) {
    if (!a || !b || !a.length || !b.length) {
      return 0;
    }
    var denom = (normA || vectorNorm(a)) * (normB || vectorNorm(b));
    if (!denom) {
      return 0;
    }
    return dotProduct(a, b) / denom;
  }

  function textFingerprint(text) {
    var normalized = canonicalizeForDedup(text);
    var hash = (2166136261 ^ 137) >>> 0;
    for (var i = 0; i < normalized.length; i += 1) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash.toString(16) + "_" + normalized.length;
  }

  function isNearDuplicate(vector, norm, keptChunks, threshold) {
    for (var i = 0; i < keptChunks.length; i += 1) {
      var existing = keptChunks[i];
      var score = cosineSimilarity(vector, existing.vector, norm, existing.norm);
      if (score >= threshold) {
        return true;
      }
    }
    return false;
  }

  function sanitizeEntryText(text, minChars) {
    var cleaned = normalizeText(text);
    if (cleaned.length < minChars) {
      return "";
    }
    return cleaned;
  }

  function buildIndexFromChunks(chunks, sourceChars, type, dimension, options) {
    var nearDuplicateThreshold = typeof (options && options.nearDuplicateThreshold) === "number"
      ? options.nearDuplicateThreshold
      : 0.965;
    var maxNearChecks = typeof (options && options.maxNearChecks) === "number"
      ? options.maxNearChecks
      : 220;
    var exactFingerprints = new Set();
    var indexedChunks = [];
    var droppedExact = 0;
    var droppedNear = 0;

    for (var i = 0; i < chunks.length; i += 1) {
      var chunk = chunks[i];
      var fingerprint = textFingerprint(chunk);
      if (exactFingerprints.has(fingerprint)) {
        droppedExact += 1;
        continue;
      }

      var vector = embedText(chunk, type, dimension);
      var norm = vectorNorm(vector);
      var nearCheckPool = indexedChunks.length > maxNearChecks
        ? indexedChunks.slice(indexedChunks.length - maxNearChecks)
        : indexedChunks;

      if (isNearDuplicate(vector, norm, nearCheckPool, nearDuplicateThreshold)) {
        droppedNear += 1;
        continue;
      }

      exactFingerprints.add(fingerprint);
      indexedChunks.push({
        id: type + "_" + indexedChunks.length + "_" + Date.now(),
        text: chunk,
        vector: vector,
        norm: norm,
        chars: chunk.length
      });
    }

    return {
      version: 1,
      bankType: type,
      dimension: dimension,
      sourceChars: sourceChars,
      sourceChunkCount: chunks.length,
      chunkCount: indexedChunks.length,
      dedup: {
        exactDropped: droppedExact,
        nearDropped: droppedNear,
        nearDuplicateThreshold: nearDuplicateThreshold,
        maxNearChecks: maxNearChecks
      },
      createdAt: new Date().toISOString(),
      chunks: indexedChunks
    };
  }

  function createIndex(rawText, bankType, options) {
    var source = normalizeText(rawText);
    var type = bankType === "voice" ? "voice" : "facts";
    var dimension = (options && options.dimension) || DEFAULT_DIMENSION;
    var chunks = splitIntoChunks(source, options || {});
    return buildIndexFromChunks(chunks, source.length, type, dimension, options || {});
  }

  function createIndexFromEntries(entries, bankType, options) {
    var type = bankType === "voice" ? "voice" : "facts";
    var dimension = (options && options.dimension) || DEFAULT_DIMENSION;
    var minChars = (options && options.minChars) || DEFAULT_MIN_CHUNK;
    var list = Array.isArray(entries) ? entries : [];
    var prepared = [];
    var sourceChars = 0;

    for (var i = 0; i < list.length; i += 1) {
      var cleaned = sanitizeEntryText(list[i], minChars);
      if (!cleaned) {
        continue;
      }
      prepared.push(cleaned);
      sourceChars += cleaned.length;
    }

    if (!prepared.length) {
      return buildIndexFromChunks([], 0, type, dimension, options || {});
    }

    return buildIndexFromChunks(prepared, sourceChars, type, dimension, options || {});
  }

  function searchIndex(index, queryText, topK, minScore) {
    if (!index || !Array.isArray(index.chunks) || !index.chunks.length) {
      return [];
    }

    var k = typeof topK === "number" ? topK : 4;
    var threshold = typeof minScore === "number" ? minScore : -1;
    var queryVector = embedText(queryText, index.bankType, index.dimension || DEFAULT_DIMENSION);
    var queryNorm = vectorNorm(queryVector);

    var scored = index.chunks.map(function (chunk) {
      var score = cosineSimilarity(queryVector, chunk.vector, queryNorm, chunk.norm);
      return {
        id: chunk.id,
        text: chunk.text,
        score: score,
        chars: chunk.chars
      };
    })
    .filter(function (item) {
      return item.score >= threshold;
    })
    .sort(function (a, b) {
      return b.score - a.score;
    })
    .slice(0, k);

    return scored;
  }

  // Search using a pre-computed external vector (e.g. from neural embedding API).
  // The index must have been built with the same embedding model.
  function searchIndexWithVector(index, queryVector, topK, minScore) {
    if (!index || !Array.isArray(index.chunks) || !index.chunks.length) {
      return [];
    }
    if (!Array.isArray(queryVector) || !queryVector.length) {
      return [];
    }

    var k = typeof topK === "number" ? topK : 4;
    var threshold = typeof minScore === "number" ? minScore : -1;
    var queryNorm = vectorNorm(queryVector);

    return index.chunks
      .map(function (chunk) {
        var score = cosineSimilarity(queryVector, chunk.vector, queryNorm, chunk.norm);
        return { id: chunk.id, text: chunk.text, score: score, chars: chunk.chars };
      })
      .filter(function (item) { return item.score >= threshold; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, k);
  }

  // Replace hash-projection vectors in an index with externally-provided embeddings.
  // embeddings is an array of float arrays, one per chunk (same order as index.chunks).
  function applyExternalEmbeddings(index, embeddings, modelName, dimension) {
    if (!index || !Array.isArray(embeddings) || embeddings.length !== index.chunks.length) {
      return index;
    }
    var updatedChunks = index.chunks.map(function (chunk, i) {
      var vec = embeddings[i];
      return Object.assign({}, chunk, {
        vector: vec,
        norm: vectorNorm(vec)
      });
    });
    return Object.assign({}, index, {
      chunks: updatedChunks,
      dimension: dimension || embeddings[0].length,
      embeddingModel: modelName || "external"
    });
  }

  global.VectorStore = {
    splitIntoChunks: splitIntoChunks,
    createIndex: createIndex,
    createIndexFromEntries: createIndexFromEntries,
    searchIndex: searchIndex,
    searchIndexWithVector: searchIndexWithVector,
    applyExternalEmbeddings: applyExternalEmbeddings,
    embedText: embedText,
    cosineSimilarity: cosineSimilarity,
    vectorNorm: vectorNorm
  };
})(self);
