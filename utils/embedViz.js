/* embedViz.js  Embedding space visualiser (3-D PCA scatter)
 * Completely self-contained. Loaded after vectorStore.js and options.js.
 */
(function () {
  "use strict";

  /*  1. Grab every DOM ref we need; bail only if the canvas is missing  */
  var canvas     = document.getElementById("vizCanvas");
  var statusEl   = document.getElementById("vizStatus");
  var legendEl   = document.getElementById("vizLegend");
  var infoEl     = document.getElementById("vizInfoContent");
  var queryInput = document.getElementById("vizQueryInput");
  var queryBtn   = document.getElementById("vizQueryBtn");
  var refreshBtn = document.getElementById("vizRefreshBtn");
  var tooltipEl  = document.getElementById("vizTooltip");
  var rankingEl  = document.getElementById("vizRankingList");
  var infoPanel  = document.getElementById("vizInfoPanel");

  function log(msg) {
    if (statusEl) { statusEl.textContent = msg; }
    console.log("[embedViz]", msg);
  }

  if (!canvas) { console.error("[embedViz] canvas#vizCanvas not found"); return; }

  var ctx = canvas.getContext("2d");
  if (!ctx) { log("Canvas 2-D context unavailable."); return; }

  log("Initialising...");

  /*  2. Colours per lane  */
  var LANES = {
    fact:     { color: "#4a9eff", label: "Experience"  },
    resume:   { color: "#818cf8", label: "CV / Resume" },
    voice:    { color: "#c084fc", label: "Voice"       },
    linkedin: { color: "#fb923c", label: "About Me"    },
    company:  { color: "#4ade80", label: "Company"     },
    query:    { color: "#ff4757", label: "Your query"  }
  };

  /*  3. State  */
  var W = 0, H = 0;
  var chunks   = [];   // { x,y,z, text, laneKey, vec, sim }
  var queryPt  = null; // { x,y,z, text, nearest[] }
  var pca      = null; // { mean[], axes[3][], mins[3], scales[3] }
  var theta    = 0.45, phi = 0.22, camZ = 4.2;
  var spinning = true;
  var dragging = false, dragX = 0, dragY = 0;
  var hovIdx   = -1, selIdx = -1;  // -2 = query point
  var raf      = null;

  /*  4. Canvas sizing  */
  function sizeCanvas() {
    var dpr  = window.devicePixelRatio || 1;
    var wrap = canvas.parentElement;
    var cssW = (wrap && wrap.clientWidth > 50) ? wrap.clientWidth : 760;
    W = Math.floor(cssW);
    H = Math.max(400, Math.floor(W * 0.52));
    canvas.width        = W * dpr;
    canvas.height       = H * dpr;
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /*  5. PCA: power iteration on data matrix X (O(N*D) per step)  */
  function fitPCA(vecs) {
    var N = vecs.length, D = vecs[0].length;

    // compute mean
    var mean = new Array(D).fill(0);
    for (var i = 0; i < N; i++) {
      for (var d = 0; d < D; d++) { mean[d] += (vecs[i][d] || 0); }
    }
    for (var d = 0; d < D; d++) { mean[d] /= N; }

    // centered copy
    var X = [];
    for (var i = 0; i < N; i++) {
      var row = new Array(D);
      for (var d = 0; d < D; d++) { row[d] = (vecs[i][d] || 0) - mean[d]; }
      X.push(row);
    }

    // 3 principal components via power iteration on X
    var axes = [];
    var deflX = X.map(function (r) { return r.slice(); });

    for (var c = 0; c < 3; c++) {
      var v = new Array(D);
      for (var d = 0; d < D; d++) { v[d] = Math.random() - 0.5; }
      normalise(v);

      for (var iter = 0; iter < 80; iter++) {
        // u = X v  (length N)
        var u = new Array(N).fill(0);
        for (var i = 0; i < N; i++) {
          for (var d = 0; d < D; d++) { u[i] += deflX[i][d] * v[d]; }
        }
        normalise(u);
        // v = X^T u  (length D)
        var vn = new Array(D).fill(0);
        for (var i = 0; i < N; i++) {
          for (var d = 0; d < D; d++) { vn[d] += deflX[i][d] * u[i]; }
        }
        normalise(vn);
        v = vn;
      }

      // scores
      var scores = new Array(N).fill(0);
      for (var i = 0; i < N; i++) {
        for (var d = 0; d < D; d++) { scores[i] += deflX[i][d] * v[d]; }
      }
      // deflate
      for (var i = 0; i < N; i++) {
        for (var d = 0; d < D; d++) { deflX[i][d] -= scores[i] * v[d]; }
      }

      axes.push(v);
    }

    // project all vecs to get normalisation range
    var raw = projectAll(X, axes);
    var mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < raw.length; i++) {
      for (var k = 0; k < 3; k++) {
        if (raw[i][k] < mins[k]) { mins[k] = raw[i][k]; }
        if (raw[i][k] > maxs[k]) { maxs[k] = raw[i][k]; }
      }
    }
    var scales = [0, 1, 2].map(function (k) { return (maxs[k] - mins[k]) || 1; });

    return { mean: mean, axes: axes, mins: mins, scales: scales };
  }

  function normalise(v) {
    var n = 0;
    for (var i = 0; i < v.length; i++) { n += v[i] * v[i]; }
    n = Math.sqrt(n) || 1;
    for (var i = 0; i < v.length; i++) { v[i] /= n; }
  }

  function projectAll(X, axes) {
    return X.map(function (row) {
      return axes.map(function (ax) {
        var s = 0;
        for (var d = 0; d < ax.length; d++) { s += row[d] * ax[d]; }
        return s;
      });
    });
  }

  // Project a single raw vec using fitted PCA model
  function projectOne(vec, p) {
    var D = p.mean.length;
    return p.axes.map(function (ax, k) {
      var s = 0;
      for (var d = 0; d < D; d++) { s += ((vec[d] || 0) - p.mean[d]) * ax[d]; }
      return ((s - p.mins[k]) / p.scales[k]) * 2 - 1;
    });
  }

  /*  6. 3-D perspective projection  */
  function project(x, y, z) {
    var ct = Math.cos(theta), st = Math.sin(theta);
    var cp = Math.cos(phi),   sp = Math.sin(phi);
    var rx  = x * ct - z * st;
    var rza = x * st + z * ct;
    var ry  = y * cp - rza * sp;
    var rz  = y * sp + rza * cp + camZ;
    var fov = W * 0.40;
    return { sx: W / 2 + fov * rx / rz,
             sy: H / 2 + fov * ry / rz,
             depth: rz };
  }

  /*  7. Render  */
  function drawText(msg) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0f1117";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#6070a0";
    ctx.font = "14px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(msg, W / 2, H / 2);
    ctx.textAlign = "left";
  }

  function draw() {
    if (!W || !H) { sizeCanvas(); }
    ctx.clearRect(0, 0, W, H);

    var g = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W,H)*0.7);
    g.addColorStop(0, "#151b2e");
    g.addColorStop(1, "#090b12");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (!chunks.length) {
      ctx.fillStyle = "#6070a0";
      ctx.font = "14px Segoe UI,system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No chunks indexed  add content and click  Save & Reindex  above.", W/2, H/2);
      ctx.textAlign = "left";
      return;
    }

    drawAxes();

    var projected = chunks.map(function (c) { return project(c.x, c.y, c.z); });
    var qProj     = queryPt ? project(queryPt.x, queryPt.y, queryPt.z) : null;

    // NN lines behind dots
    if (qProj && queryPt.nearest) {
      queryPt.nearest.forEach(function (ni) {
        var np = projected[ni];
        if (!np) { return; }
        ctx.beginPath();
        ctx.moveTo(qProj.sx, qProj.sy);
        ctx.lineTo(np.sx, np.sy);
        ctx.strokeStyle = "rgba(255,71,87,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    // Sort back-to-front
    var order = projected.map(function (_, i) { return i; });
    order.sort(function (a, b) { return projected[b].depth - projected[a].depth; });

    order.forEach(function (i) {
      var c   = chunks[i], pr = projected[i];
      var col = (LANES[c.laneKey] || LANES.fact).color;
      var isSel = (i === selIdx), isHov = (i === hovIdx);
      var r = isSel ? 8 : isHov ? 7 : 4.5;
      ctx.save();
      if (isHov || isSel) { ctx.shadowColor = col; ctx.shadowBlur = 18; }
      ctx.beginPath();
      ctx.arc(pr.sx, pr.sy, r, 0, 6.2832);
      ctx.fillStyle   = isSel ? "#fff" : col;
      ctx.globalAlpha = isHov ? 1 : 0.82;
      ctx.fill();
      if (isHov || isSel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.restore();
    });

    if (qProj) {
      var isQSel = selIdx === -2;
      ctx.save();
      ctx.shadowColor = "#ff4757"; ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.arc(qProj.sx, qProj.sy, isQSel ? 12 : 10, 0, 6.2832);
      ctx.fillStyle = "#ff4757";
      ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }
  }

  function drawAxes() {
    var o = project(-0.75, -0.75, -0.75);
    [
      [project( 0.75, -0.75, -0.75), "rgba(255,107,107,.7)", "PC1"],
      [project(-0.75,  0.75, -0.75), "rgba(107,255,138,.7)", "PC2"],
      [project(-0.75, -0.75,  0.75), "rgba(107,181,255,.7)", "PC3"]
    ].forEach(function (ax) {
      ctx.beginPath(); ctx.moveTo(o.sx, o.sy); ctx.lineTo(ax[0].sx, ax[0].sy);
      ctx.strokeStyle = ax[1]; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = ax[1]; ctx.font = "10px monospace";
      ctx.fillText(ax[2], ax[0].sx + 3, ax[0].sy + 3);
    });
  }

  /*  8. Animation loop  */
  function tick() {
    if (spinning && !dragging) { theta += 0.003; }
    draw();
    raf = requestAnimationFrame(tick);
  }

  /*  9. Hit-testing  */
  function hitTest(mx, my) {
    if (queryPt) {
      var qp = project(queryPt.x, queryPt.y, queryPt.z);
      if (dist(mx, my, qp.sx, qp.sy) < 14) { return -2; }
    }
    var best = -1, bestD = 13;
    for (var i = 0; i < chunks.length; i++) {
      var p = project(chunks[i].x, chunks[i].y, chunks[i].z);
      var d = dist(mx, my, p.sx, p.sy);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function dist(ax, ay, bx, by) {
    return Math.sqrt((ax-bx)*(ax-bx)+(ay-by)*(ay-by));
  }

  /*  10. Pointer events  */
  canvas.addEventListener("mousedown", function (e) {
    dragging = true; spinning = false;
    dragX = e.clientX; dragY = e.clientY;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", function () {
    dragging = false; canvas.style.cursor = "grab";
  });
  window.addEventListener("mousemove", function (e) {
    if (dragging) {
      theta += (e.clientX - dragX) * 0.007;
      phi    = Math.max(-1.3, Math.min(1.3, phi + (e.clientY - dragY) * 0.007));
      dragX = e.clientX; dragY = e.clientY;
      return;
    }
    if (!chunks.length) { return; }
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > W || my > H) {
      hovIdx = -1;
      if (tooltipEl) { tooltipEl.style.display = "none"; }
      return;
    }
    hovIdx = hitTest(mx, my);
    showTooltip(hovIdx, e.clientX, e.clientY, rect);
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    camZ = Math.max(1.5, Math.min(14, camZ + e.deltaY * 0.005));
    spinning = false;
  }, { passive: false });
  canvas.addEventListener("click", function (e) {
    var rect = canvas.getBoundingClientRect();
    var hit  = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    selIdx   = hit;
    if (tooltipEl) { tooltipEl.style.display = "none"; }
    if (hit === -2) { spinning = false; /* full table already rendered below */ }
    else if (hit >= 0) { showChunkInfo(hit); spinning = false; }
    else { spinning = true; }
  });

  /*  11. Tooltip  */
  function showTooltip(hit, cx, cy, rect) {
    if (!tooltipEl) { return; }
    if (hit === -2 && queryPt) {
      tooltipEl.style.cssText = ttBase(cx - rect.left + 12, cy - rect.top - 30);
      tooltipEl.textContent = 'Query: "' + queryPt.text + '"';
    } else if (hit >= 0) {
      var c = chunks[hit];
      tooltipEl.style.cssText = ttBase(cx - rect.left + 12, cy - rect.top - 30);
      tooltipEl.textContent = "[" + (LANES[c.laneKey]||{label:c.laneKey}).label + "]  " + c.text.slice(0, 130) + (c.text.length > 130 ? "..." : "");
    } else {
      tooltipEl.style.display = "none";
    }
  }

  function ttBase(left, top) {
    return "display:block;position:absolute;left:" + left + "px;top:" + Math.max(4, top) + "px;" +
           "background:rgba(16,20,42,.94);color:#dce4ff;font-size:.74rem;" +
           "padding:5px 10px;border-radius:7px;pointer-events:none;" +
           "max-width:300px;line-height:1.4;z-index:20;white-space:pre-wrap;box-shadow:0 4px 12px #0006;";
  }

  /*  12. Info panel & full ranking list  */
  function showChunkInfo(i) {
    if (!infoEl) { return; }
    var c   = chunks[i];
    var col = (LANES[c.laneKey] || LANES.fact).color;
    var simNote = c.sim != null ? " &nbsp;<span style='color:" + col + ";font-weight:700;'>" + (c.sim*100).toFixed(1) + "% similarity</span>" : "";
    infoEl.innerHTML =
      "<div style='font-weight:700;color:" + col + ";margin-bottom:5px;font-size:.85rem;'>" +
      (LANES[c.laneKey]||{label:c.laneKey}).label + simNote + "</div>" +
      c.text.replace(/&/g,"&amp;").replace(/</g,"&lt;");
    if (infoPanel) { infoPanel.style.display = "block"; }
  }

  function renderRankingList() {
    if (!rankingEl || !queryPt) { return; }
    // Sort all chunks by cosine similarity descending
    var sorted = chunks.slice().sort(function(a,b){return (b.sim||0)-(a.sim||0);});
    var rows = sorted.map(function (c, rank) {
      var col  = (LANES[c.laneKey]||LANES.fact).color;
      var pct  = ((c.sim||0)*100).toFixed(1);
      var bar  = Math.min(100, Math.round((c.sim||0)*100));
      var bg   = c.sim > 0.6 ? "#edfaf4" : c.sim > 0.35 ? "#fffbee" : "#fff";
      return "<tr style='background:" + bg + ";vertical-align:top;'>" +
        "<td style='padding:7px 10px;font-size:.8rem;color:#999;text-align:right;white-space:nowrap;width:32px;'>" + (rank+1) + "</td>" +
        "<td style='padding:7px 6px;white-space:nowrap;'>" +
          "<span style='display:inline-block;width:9px;height:9px;border-radius:50%;background:" + col + ";vertical-align:middle;'></span>" +
          "<span style='font-size:.78rem;font-weight:600;color:" + col + ";margin-left:5px;vertical-align:middle;'>" + (LANES[c.laneKey]||{label:c.laneKey}).label + "</span>" +
        "</td>" +
        "<td style='padding:7px 8px;width:68px;'>" +
          "<div style='font-size:.78rem;font-weight:700;color:#333;margin-bottom:2px;'>" + pct + "%</div>" +
          "<div style='height:4px;background:#e5e8f0;border-radius:2px;'><div style='height:4px;width:" + bar + "%;background:" + col + ";border-radius:2px;'></div></div>" +
        "</td>" +
        "<td style='padding:7px 10px 7px 4px;font-size:.8rem;color:#1a2035;line-height:1.48;'>" + c.text.replace(/&/g,"&amp;").replace(/</g,"&lt;") + "</td>" +
        "</tr>";
    }).join("");

    rankingEl.innerHTML =
      "<div style='font-weight:700;font-size:.92rem;margin-bottom:10px;color:#1a2035;'>" +
        "All chunks ranked by similarity to &ldquo;" + queryPt.text.replace(/</g,"&lt;") + "&rdquo;" +
      "</div>" +
      "<div style='overflow-x:auto;'>" +
      "<table style='width:100%;border-collapse:collapse;font-family:inherit;'>" +
        "<thead><tr style='border-bottom:2px solid #dde2f0;'>" +
          "<th style='padding:5px 10px;font-size:.76rem;color:#888;font-weight:600;text-align:right;'>#</th>" +
          "<th style='padding:5px 6px;font-size:.76rem;color:#888;font-weight:600;text-align:left;'>Lane</th>" +
          "<th style='padding:5px 8px;font-size:.76rem;color:#888;font-weight:600;text-align:left;'>Similarity</th>" +
          "<th style='padding:5px 10px 5px 4px;font-size:.76rem;color:#888;font-weight:600;text-align:left;'>Chunk text</th>" +
        "</tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table></div>";
    rankingEl.style.display = "block";
  }

  /*  13. Legend  */
  function buildLegend(present) {
    if (!legendEl) { return; }
    var html = Object.keys(LANES).filter(function(k){return k!=="query" && present[k];}).map(function(k){
      return "<span style='display:inline-flex;align-items:center;gap:4px;'>" +
        "<span style='width:9px;height:9px;border-radius:50%;background:"+LANES[k].color+";display:inline-block;'></span>" +
        LANES[k].label+"</span>";
    }).join("");
    html += "<span style='display:inline-flex;align-items:center;gap:4px;'><span style='width:11px;height:11px;border-radius:50%;background:#ff4757;border:2px solid #fff;display:inline-block;box-shadow:0 0 5px #ff4757;'></span>Your query</span>";
    legendEl.innerHTML = html;
  }

  /*  14. Cosine similarity  */
  function cosineSim(a, b) {
    var dot=0, na=0, nb=0, len=Math.min(a.length, b.length);
    for (var i=0;i<len;i++){dot+=(a[i]||0)*(b[i]||0);na+=(a[i]||0)*(a[i]||0);nb+=(b[i]||0)*(b[i]||0);}
    return (na&&nb) ? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
  }

  /*  15. Load & project  */
  function load() {
    log("Loading from storage...");
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    chunks = []; queryPt = null; pca = null; hovIdx = -1; selIdx = -1;
    theta = 0.45; phi = 0.22; camZ = 4.2; spinning = true;
    if (infoPanel) { infoPanel.style.display = "none"; }
    if (rankingEl) { rankingEl.style.display = "none"; rankingEl.innerHTML = ""; }
    if (infoEl) { infoEl.innerHTML = ""; }
    sizeCanvas();
    drawText("Loading...");

    chrome.storage.local.get("aiia_indexes", function (result) {
      try {
        var idxStore = (result && result["aiia_indexes"]) || {};
        var laneMap  = { factIndex:"fact", resumeIndex:"resume", voiceIndex:"voice", linkedinIndex:"linkedin", companyIndex:"company" };
        var rawChunks = [];
        var present   = {};

        Object.keys(laneMap).forEach(function (key) {
          var idx = idxStore[key];
          if (!idx || !Array.isArray(idx.chunks)) { return; }
          idx.chunks.forEach(function (ch) {
            if (!Array.isArray(ch.vector) || !ch.vector.length || !ch.text) { return; }
            rawChunks.push({ text: ch.text, vec: ch.vector, laneKey: laneMap[key], isNeural: !!idx.embeddingModel });
            present[laneMap[key]] = true;
          });
        });

        if (!rawChunks.length) {
          drawText("No indexed chunks  add content and click  Save & Reindex  above.");
          log("No chunks found.");
          if (raf) { cancelAnimationFrame(raf); }
          raf = requestAnimationFrame(function t(){draw();raf=requestAnimationFrame(t);});
          return;
        }

        // Use dominant vector dimension; cap to 200 chunks for speed
        var dimCount = {};
        rawChunks.forEach(function(c){var d=c.vec.length;dimCount[d]=(dimCount[d]||0)+1;});
        var domDim = +Object.keys(dimCount).sort(function(a,b){return dimCount[b]-dimCount[a];})[0];
        rawChunks = rawChunks.filter(function(c){return c.vec.length===domDim;});
        var isNeural = rawChunks[0].isNeural;

        if (rawChunks.length > 200) {
          rawChunks.sort(function(){return Math.random()-.5;});
          rawChunks = rawChunks.slice(0, 200);
          log("Subsampled to 200 chunks.");
        }

        log("Running PCA on " + rawChunks.length + " x " + domDim + "-dim vectors...");

        setTimeout(function () {
          try {
            pca = fitPCA(rawChunks.map(function(c){return c.vec;}));
            chunks = rawChunks.map(function (c) {
              var coord = projectOne(c.vec, pca);
              return { x: coord[0], y: coord[1], z: coord[2], text: c.text, laneKey: c.laneKey, vec: c.vec, sim: null };
            });
            buildLegend(present);
            var typeStr = isNeural ? "neural (" + domDim + "-dim)" : "hash (" + domDim + "-dim)";
            log(chunks.length + " chunks plotted (" + typeStr + ")  |  Drag to orbit  |  Scroll to zoom  |  Click to inspect");
            tick();
          } catch (e2) {
            log("PCA error: " + e2.message);
            console.error("[embedViz PCA]", e2);
            drawText("PCA failed: " + e2.message);
          }
        }, 20);

      } catch (e) {
        log("Load error: " + e.message);
        console.error("[embedViz load]", e);
        drawText("Load error: " + e.message);
      }
    });
  }

  /*  16. Embed & place query  */
  function embedQuery() {
    var q = queryInput ? queryInput.value.trim() : "";
    if (!q)   { log("Type a query first."); return; }
    if (!pca) { log("No index loaded  click Refresh first."); return; }
    if (queryBtn) { queryBtn.disabled = true; }
    log("Embedding query...");

    chrome.storage.local.get("aiia_settings", function (res) {
      var s   = (res && res["aiia_settings"]) || {};
      var url = (s.langextractBackendUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
      var dim = pca.mean.length;

      function fallback() {
        if (typeof VectorStore !== "undefined" && typeof VectorStore.embedText === "function") {
          placeQuery(q, VectorStore.embedText(q, "facts", dim), "local hash");
        } else {
          log("Backend unavailable and VectorStore not found.");
        }
        if (queryBtn) { queryBtn.disabled = false; }
      }

      fetch(url + "/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: [q], task_type: "RETRIEVAL_QUERY" })
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok && Array.isArray(data.embeddings) && data.embeddings[0] && data.embeddings[0].length === dim) {
          placeQuery(q, data.embeddings[0], "neural (" + data.model + ")");
        } else { fallback(); }
        if (queryBtn) { queryBtn.disabled = false; }
      })
      .catch(function () { fallback(); });
    });
  }

  function placeQuery(text, vec, method) {
    var coord = projectOne(vec, pca);
    chunks.forEach(function (c) { c.sim = cosineSim(vec, c.vec); });
    var sorted = chunks.map(function (_,i){return i;}).sort(function(a,b){return chunks[b].sim-chunks[a].sim;});
    var top5   = sorted.slice(0, 5);
    queryPt    = { x: coord[0], y: coord[1], z: coord[2], text: text, nearest: top5 };
    selIdx     = -2;
    spinning   = false;
    renderRankingList();
    // hide inspector panel since we're showing the full list
    if (infoPanel) { infoPanel.style.display = "none"; }
    var best   = chunks[top5[0]];
    log("Query plotted via " + method + ". Most similar: \"" + (best ? best.text.slice(0,55) : "?") + "...\" (" + (best ? (best.sim*100).toFixed(1) : "?") + "% cosine)");
  }

  /*  17. Wire buttons (always first, before any async)  */
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () { load(); });
  }
  if (queryBtn) {
    queryBtn.addEventListener("click", function () { embedQuery(); });
  }
  if (queryInput) {
    queryInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { embedQuery(); } });
  }
  if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
    new ResizeObserver(function () { sizeCanvas(); }).observe(canvas.parentElement);
  }

  log("Ready. Waiting for first paint...");

  /*  18. Boot: double-rAF to ensure layout is complete  */
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      sizeCanvas();
      load();
    });
  });

})();
