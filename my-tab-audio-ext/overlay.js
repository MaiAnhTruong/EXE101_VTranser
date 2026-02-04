// overlay.js
(() => {
  const ROOT_ID = "stt-yt-overlay";
  if (document.getElementById(ROOT_ID)) return;

  const DEBUG = localStorage.getItem("sttOverlayDebug") === "1";
  const dlog = (...a) => { if (DEBUG) console.log("[stt-overlay]", ...a); };

  // ---------- debug counters ----------
  const DBG = {
    recv: 0,
    enPatch: 0,
    enStable: 0,
    enDelta: 0,
    flush: 0,
    lastRecvAt: 0,
    lastFlushAt: 0,
    opsInFrameEN: 0,
    opsInFrameVI: 0,
  };
  function nowMs() { return Math.round(performance.now()); }
  window.__sttOverlayDbg = DBG;

  const MAX_SENTENCES_PER_LINE = Number(localStorage.getItem("sttMaxSentPerLine") || 2);

  // ---------- mount UI ----------
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "log");
  root.setAttribute("aria-live", "polite");

  const frame = document.createElement("div");
  frame.className = "frame";

  // EN bubble
  const bubbleEN = document.createElement("div");
  bubbleEN.className = "bubble";
  bubbleEN.id = "bubble-en";

  const l1EN = document.createElement("div");
  l1EN.className = "line line1";
  l1EN.id = "stt-line1";

  const l2EN = document.createElement("div");
  l2EN.className = "line line2";
  l2EN.id = "stt-line2";

  bubbleEN.appendChild(l1EN);
  bubbleEN.appendChild(l2EN);

  // VI bubble
  const bubbleVI = document.createElement("div");
  bubbleVI.className = "bubble-vi";
  bubbleVI.id = "bubble-vi";

  const l1VI = document.createElement("div");
  l1VI.className = "line line1";
  l1VI.id = "stt-line1-vi";

  const l2VI = document.createElement("div");
  l2VI.className = "line line2";
  l2VI.id = "stt-line2-vi";

  bubbleVI.appendChild(l1VI);
  bubbleVI.appendChild(l2VI);

  frame.appendChild(bubbleEN);
  frame.appendChild(bubbleVI);
  root.appendChild(frame);
  (document.body || document.documentElement).appendChild(root);

  l2EN.classList.add("compact");
  l2VI.classList.add("compact");

  // ---------- show/hide by mode ----------
  let showEN = false;
  let showVI = false;

  function applyOverlayMode(enOn, viOn) {
    showEN = !!enOn;
    showVI = !!viOn;
    const any = showEN || showVI;

    root.style.display = any ? "" : "none";
    bubbleEN.style.display = showEN ? "" : "none";
    bubbleVI.style.display = showVI ? "" : "none";

    if (showEN && !fullTextEN) l2EN.textContent = "…";
    if (showVI && !fullTextVI) l2VI.textContent = "…";
    if (!showEN) { l1EN.textContent = ""; l2EN.textContent = ""; l2EN.classList.add("compact"); }
    if (!showVI) { l1VI.textContent = ""; l2VI.textContent = ""; l2VI.classList.add("compact"); }
  }
  applyOverlayMode(false, false);

  // ---------- measurer ----------
  const measurer = document.createElement("div");
  (document.body || document.documentElement).appendChild(measurer);

  const syncMeasureStyle = () => {
    const cs = getComputedStyle(l2EN);
    measurer.style.cssText = `
      position: fixed; left: -99999px; top: -99999px;
      visibility: hidden; white-space: nowrap;
      font-family: ${cs.fontFamily};
      font-weight: ${cs.fontWeight};
      font-size: ${cs.fontSize};
      line-height: ${cs.lineHeight};
    `;
  };
  syncMeasureStyle();

  const textWidth = (s) => { measurer.textContent = s; return measurer.scrollWidth; };

  const innerMaxPx = (bubbleEl) => {
    const frameW = frame.clientWidth;
    const cs = getComputedStyle(bubbleEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return Math.max(0, frameW - padL - padR);
  };

  // ---------- tools ----------
  function splitSentencesAndTail(text) {
    const sents = [];
    const re = /[^.!?…]*[.!?…]+(?:["”’']+)?(?:\s+|$)/g;
    let lastEnd = 0, m;
    while ((m = re.exec(text)) !== null) {
      sents.push(m[0]);
      lastEnd = re.lastIndex;
    }
    const tail = text.slice(lastEnd);
    return { sents, tail };
  }

  function fitPrefixByWidth(sentence, remPx) {
    if (remPx <= 0) return { fit: "", rest: sentence };
    const tokens = String(sentence).split(/(\s+)/);
    let fit = "";
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      const next = fit + tok;
      if (textWidth(next) <= remPx) {
        fit = next;
      } else {
        if (!fit) {
          let lo = 0, hi = tok.length, best = 0;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const cand = tok.slice(0, mid);
            if (!cand) { lo = mid + 1; continue; }
            if (textWidth(cand) <= remPx) { best = mid; lo = mid + 1; }
            else { hi = mid - 1; }
          }
          const cut = tok.slice(0, best);
          const restTok = tok.slice(best);
          const rest = restTok + tokens.slice(i + 1).join("");
          return { fit: cut, rest };
        }
        return { fit, rest: tokens.slice(i).join("") };
      }
    }
    return { fit, rest: "" };
  }

  function buildLines(text, bubbleEl) {
    const { sents, tail } = splitSentencesAndTail(text);
    const queue = sents.slice();
    if (tail) queue.push(tail);

    const lines = [];
    const maxPx = innerMaxPx(bubbleEl);

    while (queue.length) {
      let line = "";
      let used = 0;
      let guard = 0;

      while (used < MAX_SENTENCES_PER_LINE && queue.length && guard++ < 10000) {
        const sentence = queue.shift();
        const candidate = line + sentence;

        if (textWidth(candidate) <= maxPx) {
          line = candidate;
          used += 1;
          continue;
        }

        const remPx = maxPx - textWidth(line);
        if (remPx <= 0) {
          queue.unshift(sentence);
          break;
        }
        const { fit, rest } = fitPrefixByWidth(sentence, remPx);
        if (fit) {
          line += fit;
          used += 1;
          if (rest) queue.unshift(rest);
        } else {
          queue.unshift(sentence);
        }
        break;
      }

      if (line) {
        lines.push(line);
      } else {
        const s = queue.shift();
        const { fit, rest } = fitPrefixByWidth(s, maxPx);
        lines.push(fit || s.slice(0, 1));
        if (rest) queue.unshift(rest);
      }
    }

    return lines;
  }

  function renderTwoLines(text, bubbleEl, $l1, $l2) {
    const lines = buildLines(text, bubbleEl);
    let line1 = "", line2 = "";

    if (lines.length === 0) {
      line1 = ""; line2 = "";
    } else if (lines.length === 1) {
      line1 = ""; line2 = lines[0];
    } else {
      line1 = lines[lines.length - 2];
      line2 = lines[lines.length - 1];
    }

    if (DEBUG) {
      const prev1 = $l1.textContent || "";
      const prev2 = $l2.textContent || "";
      if (prev1 !== line1 || prev2 !== line2) {
        dlog(`[render] maxPx=${innerMaxPx(bubbleEl).toFixed?.(0)} line1Len=${line1.length} line2Len=${line2.length}`);
        dlog(`[render] prev1="${prev1}"`);
        dlog(`[render] prev2="${prev2}"`);
        dlog(`[render] new1 ="${line1}"`);
        dlog(`[render] new2 ="${line2}"`);
      }
    }

    if ($l1.textContent !== line1) $l1.textContent = line1;
    if ($l2.textContent !== line2) $l2.textContent = line2;

    if (!line1.trim()) $l2.classList.add("compact"); else $l2.classList.remove("compact");
  }

  // ---------- Models (FIX: apply patches in-order) ----------
  let fullTextEN = "";
  let scheduledEN = false;

  // Queue of operations to apply sequentially
  const opsEN = []; // { del, ins, seq }
  let lastPatchSeqEN = -1;
  let lastStableSeqEN = -1;

  function enqueueOpEN(delN, insS, seq = null) {
    DBG.enPatch++;
    DBG.opsInFrameEN++;

    const t = nowMs();
    const dt = DBG.lastRecvAt ? (t - DBG.lastRecvAt) : 0;
    DBG.lastRecvAt = t;

    const del = (delN | 0);
    const ins = insS ? String(insS) : "";

    // seq guard (best-effort). Accept ops without seq.
    if (seq != null) {
      const s = Number(seq);
      if (Number.isFinite(s)) {
        if (s <= lastPatchSeqEN) {
          if (DEBUG) dlog(`[EN drop patch] seq=${s} <= lastPatchSeq=${lastPatchSeqEN}`);
          return;
        }
        lastPatchSeqEN = s;
      }
    }

    if (DEBUG) {
      dlog(`[EN enqueue] dt=${dt}ms del=${del} insLen=${ins.length} fullLen=${fullTextEN.length} seq=${seq ?? "-"}`);
      if (ins) dlog(`[EN enqueue] ins="${ins.slice(0, 80)}"${ins.length > 80 ? "..." : ""}`);
    }

    opsEN.push({ del, ins, seq: seq ?? null });

    if (!scheduledEN) {
      scheduledEN = true;
      requestAnimationFrame(flushEN);
    }
  }

  function applyOneOp(text, op) {
    let out = text;
    if (op.del > 0) out = op.del >= out.length ? "" : out.slice(0, out.length - op.del);
    if (op.ins) out += op.ins;
    return out;
  }

  function flushEN() {
    try {
      DBG.flush++;
      const t = nowMs();
      const dt = DBG.lastFlushAt ? (t - DBG.lastFlushAt) : 0;
      DBG.lastFlushAt = t;

      if (DEBUG) {
        dlog(`[EN flush] dt=${dt}ms opsInFrame=${DBG.opsInFrameEN} queued=${opsEN.length} fullLen(before)=${fullTextEN.length}`);
      }

      if (opsEN.length) {
        const beforeTail = fullTextEN.slice(Math.max(0, fullTextEN.length - 80));
        for (let i = 0; i < opsEN.length; i++) {
          fullTextEN = applyOneOp(fullTextEN, opsEN[i]);
        }
        opsEN.length = 0;

        if (DEBUG) {
          const afterTail = fullTextEN.slice(Math.max(0, fullTextEN.length - 80));
          dlog(`[EN flush] fullLen(after)=${fullTextEN.length}`);
          dlog(`[EN flush] tail(before)="${beforeTail}"`);
          dlog(`[EN flush] tail(after )="${afterTail}"`);
        }

        renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN);
      }
    } finally {
      DBG.opsInFrameEN = 0;
      scheduledEN = false;
    }
  }

  function applyStableEN(full, seq = null) {
    if (typeof full !== "string") return;
    DBG.enStable++;

    // stable seq guard (best-effort)
    if (seq != null) {
      const s = Number(seq);
      if (Number.isFinite(s) && s <= lastStableSeqEN) {
        if (DEBUG) dlog(`[EN drop stable] seq=${s} <= lastStableSeq=${lastStableSeqEN}`);
        return;
      }
      if (Number.isFinite(s)) lastStableSeqEN = s;
    }

    if (DEBUG) {
      dlog(`[EN stable] fullLen=${full.length} curLen=${fullTextEN.length} scheduledEN=${scheduledEN} seq=${seq ?? "-"}`);
      dlog(`[EN stable] tail="${full.slice(Math.max(0, full.length - 80))}"`);
    }

    // ensure pending ops applied first (keep monotonic)
    if (scheduledEN) flushEN();

    // Prefer stable as authoritative, but avoid weird shrink glitches:
    if (full === fullTextEN) return;

    if (full.length >= fullTextEN.length) {
      fullTextEN = full;
      renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN);
      return;
    }

    // If stable is a prefix of current => allow shrink (safe)
    if (fullTextEN.startsWith(full)) {
      fullTextEN = full;
      renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN);
      return;
    }

    // If divergence lớn => resync theo stable (đỡ nhảy loạn lâu dài)
    const diff = Math.abs(full.length - fullTextEN.length);
    if (diff > 24) {
      if (DEBUG) dlog(`[EN stable] RESYNC (diff=${diff})`);
      fullTextEN = full;
      renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN);
      return;
    }

    // Otherwise: skip nhỏ để tránh giật
    if (DEBUG) dlog(`[EN stable] SKIP (shorter but not prefix, diff=${diff})`);
  }

  // ---------- VI model (same fix) ----------
  let fullTextVI = "";
  let scheduledVI = false;
  const opsVI = [];
  let lastPatchSeqVI = -1;
  let lastStableSeqVI = -1;

  function enqueueOpVI(delN, insS, seq = null) {
    DBG.opsInFrameVI++;
    const del = (delN | 0);
    const ins = insS ? String(insS) : "";

    if (seq != null) {
      const s = Number(seq);
      if (Number.isFinite(s)) {
        if (s <= lastPatchSeqVI) return;
        lastPatchSeqVI = s;
      }
    }
    opsVI.push({ del, ins, seq: seq ?? null });
    if (!scheduledVI) { scheduledVI = true; requestAnimationFrame(flushVI); }
  }

  function flushVI() {
    try {
      if (opsVI.length) {
        for (let i = 0; i < opsVI.length; i++) {
          fullTextVI = applyOneOp(fullTextVI, opsVI[i]);
        }
        opsVI.length = 0;
        renderTwoLines(fullTextVI, bubbleVI, l1VI, l2VI);
      }
    } finally {
      DBG.opsInFrameVI = 0;
      scheduledVI = false;
    }
  }

  function applyStableVI(full, seq = null) {
    if (typeof full !== "string") return;

    if (seq != null) {
      const s = Number(seq);
      if (Number.isFinite(s) && s <= lastStableSeqVI) return;
      if (Number.isFinite(s)) lastStableSeqVI = s;
    }

    if (scheduledVI) flushVI();

    if (full === fullTextVI) return;

    if (full.length >= fullTextVI.length || fullTextVI.startsWith(full) || Math.abs(full.length - fullTextVI.length) > 24) {
      fullTextVI = full;
      renderTwoLines(fullTextVI, bubbleVI, l1VI, l2VI);
    }
  }

  // ---------- message handlers ----------
  function handleMessage(msg) {
    if (!msg) return;
    const type = msg.__cmd || msg.type;
    if (!type) return;

    // EN patch
    if (type === "__TRANSCRIPT_PATCH__" || type === "patch") {
      const delN = Number(msg.payload?.delete ?? msg.delete ?? 0) || 0;
      const insS = String(msg.payload?.insert ?? msg.insert ?? "");
      const seq  = msg.payload?.seq ?? msg.seq ?? null;
      enqueueOpEN(delN, insS, seq);
      return;
    }

    // EN delta
    if (type === "__TRANSCRIPT_DELTA__" || type === "delta" || type === "delta-append") {
      DBG.enDelta++;
      const append = String(msg.payload?.append ?? msg.append ?? "");
      if (DEBUG) dlog(`[EN delta] appendLen=${append.length} "${append.slice(0,80)}"${append.length>80?"...":""}`);
      enqueueOpEN(0, append, msg.payload?.seq ?? msg.seq ?? null);
      return;
    }

    // EN stable
    if (type === "__TRANSCRIPT_STABLE__" || type === "stable") {
      const full = msg.full ?? msg.detail?.full ?? msg.payload?.full;
      const seq  = msg.payload?.seq ?? msg.seq ?? null;
      applyStableEN(full, seq);
      return;
    }

    // VI delta
    if (type === "__TRANS_VI_DELTA__" || type === "vi-delta") {
      const append = String(msg.payload?.append ?? msg.append ?? "");
      enqueueOpVI(0, append, msg.payload?.seq ?? msg.seq ?? null);
      return;
    }

    // VI stable
    if (type === "__TRANS_VI_STABLE__" || type === "vi-stable") {
      const full = msg.full ?? msg.detail?.full ?? msg.payload?.full;
      const seq  = msg.payload?.seq ?? msg.seq ?? null;
      applyStableVI(full, seq);
      return;
    }

    // MODE
    if (type === "__OVERLAY_MODE__" || type === "overlay-mode") {
      const cfg = msg.payload || msg.detail || {};
      const enOn = !!(cfg.en ?? cfg.subtitle ?? cfg.showEN);
      const viOn = !!(cfg.vi ?? cfg.subtitle_vi ?? cfg.showVI);
      applyOverlayMode(enOn, viOn);
      return;
    }

    // RESET
    if (type === "__OVERLAY_RESET__") {
      // flush remaining (optional)
      if (scheduledEN) flushEN();
      if (scheduledVI) flushVI();

      fullTextEN = ""; fullTextVI = "";
      opsEN.length = 0; opsVI.length = 0;
      lastPatchSeqEN = lastStableSeqEN = -1;
      lastPatchSeqVI = lastStableSeqVI = -1;

      l1EN.textContent = ""; l2EN.textContent = ""; l2EN.classList.add("compact");
      l1VI.textContent = ""; l2VI.textContent = ""; l2VI.classList.add("compact");
      applyOverlayMode(showEN, showVI);
      return;
    }

    // TEARDOWN
    if (type === "__OVERLAY_TEARDOWN__") {
      try { root.remove(); } catch {}
      try { measurer.remove(); } catch {}
      return;
    }
  }

  // ---------- wiring ----------
  try { chrome.runtime.onMessage.addListener((m) => handleMessage(m)); } catch {}
  try {
    const port = chrome.runtime.connect({ name: "stt-overlay" });
    port.onMessage.addListener((m) => handleMessage(m));
  } catch {}
  window.addEventListener("message", (ev) => {
    const m = ev?.data;
    if (m && (m.__cmd || m.type)) handleMessage(m);
  });

  window.addEventListener("resize", () => {
    syncMeasureStyle();
    if (showEN) renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN);
    if (showVI) renderTwoLines(fullTextVI, bubbleVI, l1VI, l2VI);
  });

  try { chrome.runtime.sendMessage({ __cmd: "__OVERLAY_PING__" }, () => {}); } catch {}

  dlog("overlay mounted OK");
})();
