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

    // --- VI translate debug ---
    viDelta: 0,
    viStable: 0,
    viDraft: 0,
    viCommit: 0,

    viFlush: 0,
    viDropSeq: 0,
    viDropEpoch: 0,
    viDropReq: 0,
    viDropEnSeq: 0,
    viDropDiverge: 0,

    viLastRecvAt: 0,
    viLastFlushAt: 0,
    opsInFrameVI: 0,

    lastViSeqSeen: -1,
    lastViEnSeqSeen: -1,
    lastEnStableSeqSeen: -1,

    viLastRenderAt: 0,
    viLastRenderedLen: 0,
  };

  function nowMs() { return Math.round(performance.now()); }
  window.__sttOverlayDbg = DBG;

  // ---------- trace ring buffer (for debugging in DevTools) ----------
  const TRACE_MAX = Number(localStorage.getItem("sttOverlayTraceMax") || 200);
  const TRACE = [];
  function tracePush(kind, data) {
    if (!DEBUG) return;
    const obj = { t: nowMs(), kind, ...(data || {}) };
    TRACE.push(obj);
    if (TRACE.length > TRACE_MAX) TRACE.splice(0, TRACE.length - TRACE_MAX);
  }
  window.__sttOverlayTrace = TRACE;

  const MAX_SENTENCES_PER_LINE = Number(localStorage.getItem("sttMaxSentPerLine") || 2);

  // VI render throttling: “ra chữ theo word/cụm” cho ổn định
  const VI_MIN_RENDER_MS = Number(localStorage.getItem("sttViMinRenderMs") || 120);
  const VI_FORCE_RENDER_MS = Number(localStorage.getItem("sttViForceRenderMs") || 260);
  const VI_RENDER_BOUNDARY_RE = /(\s|[.!?…,:;，。？！])$/;

  // ---------- mount UI ----------
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "log");
  root.setAttribute("aria-live", "polite");

  const frame = document.createElement("div");
  frame.className = "frame";

  // 🔒 Force EN on top, VI below (không phụ thuộc CSS ngoài)
  frame.style.display = "flex";
  frame.style.flexDirection = "column";
  frame.style.gap = "6px";

  // EN bubble
  const bubbleEN = document.createElement("div");
  bubbleEN.className = "bubble";
  bubbleEN.id = "bubble-en";
  bubbleEN.style.order = "0";

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
  bubbleVI.style.order = "1";

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
    if (showVI && !getVIVisibleText()) l2VI.textContent = "…";

    if (!showEN) { l1EN.textContent = ""; l2EN.textContent = ""; l2EN.classList.add("compact"); }
    if (!showVI) { l1VI.textContent = ""; l2VI.textContent = ""; l2VI.classList.add("compact"); }
  }
  applyOverlayMode(false, false);

  // ---------- measurer (EN + VI separate to avoid wrap jitter) ----------
  const measurerEN = document.createElement("div");
  const measurerVI = document.createElement("div");
  (document.body || document.documentElement).appendChild(measurerEN);
  (document.body || document.documentElement).appendChild(measurerVI);

  const syncMeasureStyle = () => {
    const csEN = getComputedStyle(l2EN);
    measurerEN.style.cssText = `
      position: fixed; left: -99999px; top: -99999px;
      visibility: hidden; white-space: nowrap;
      font-family: ${csEN.fontFamily};
      font-weight: ${csEN.fontWeight};
      font-size: ${csEN.fontSize};
      line-height: ${csEN.lineHeight};
    `;

    const csVI = getComputedStyle(l2VI);
    measurerVI.style.cssText = `
      position: fixed; left: -99999px; top: -99999px;
      visibility: hidden; white-space: nowrap;
      font-family: ${csVI.fontFamily};
      font-weight: ${csVI.fontWeight};
      font-size: ${csVI.fontSize};
      line-height: ${csVI.lineHeight};
    `;
  };
  syncMeasureStyle();

  const textWidthEN = (s) => { measurerEN.textContent = s; return measurerEN.scrollWidth; };
  const textWidthVI = (s) => { measurerVI.textContent = s; return measurerVI.scrollWidth; };

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

  function fitPrefixByWidth(sentence, remPx, widthFn) {
    if (remPx <= 0) return { fit: "", rest: sentence };
    const tokens = String(sentence).split(/(\s+)/);
    let fit = "";
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      const next = fit + tok;
      if (widthFn(next) <= remPx) {
        fit = next;
      } else {
        if (!fit) {
          let lo = 0, hi = tok.length, best = 0;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const cand = tok.slice(0, mid);
            if (!cand) { lo = mid + 1; continue; }
            if (widthFn(cand) <= remPx) { best = mid; lo = mid + 1; }
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

  function buildLines(text, bubbleEl, widthFn) {
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

        if (widthFn(candidate) <= maxPx) {
          line = candidate;
          used += 1;
          continue;
        }

        const remPx = maxPx - widthFn(line);
        if (remPx <= 0) {
          queue.unshift(sentence);
          break;
        }
        const { fit, rest } = fitPrefixByWidth(sentence, remPx, widthFn);
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
        const { fit, rest } = fitPrefixByWidth(s, maxPx, widthFn);
        lines.push(fit || s.slice(0, 1));
        if (rest) queue.unshift(rest);
      }
    }

    return lines;
  }

  function renderTwoLines(text, bubbleEl, $l1, $l2, widthFn) {
    const lines = buildLines(text, bubbleEl, widthFn);
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
      }
    }

    if ($l1.textContent !== line1) $l1.textContent = line1;
    if ($l2.textContent !== line2) $l2.textContent = line2;

    if (!line1.trim()) $l2.classList.add("compact"); else $l2.classList.remove("compact");
  }

  // ---------- Models (EN: patch in-order) ----------
  let fullTextEN = "";
  let scheduledEN = false;

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

    if (DEBUG) dlog(`[EN enqueue] dt=${dt}ms del=${del} insLen=${ins.length} fullLen=${fullTextEN.length} seq=${seq ?? "-"}`);

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

      if (DEBUG) dlog(`[EN flush] dt=${dt}ms opsInFrame=${DBG.opsInFrameEN} queued=${opsEN.length} fullLen(before)=${fullTextEN.length}`);

      if (opsEN.length) {
        for (let i = 0; i < opsEN.length; i++) {
          fullTextEN = applyOneOp(fullTextEN, opsEN[i]);
        }
        opsEN.length = 0;

        if (showEN) renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN, textWidthEN);
      }
    } finally {
      DBG.opsInFrameEN = 0;
      scheduledEN = false;
    }
  }

  function applyStableEN(full, seq = null) {
    if (typeof full !== "string") return;
    DBG.enStable++;

    if (seq != null) {
      const s = Number(seq);
      if (Number.isFinite(s) && s <= lastStableSeqEN) {
        if (DEBUG) dlog(`[EN drop stable] seq=${s} <= lastStableSeq=${lastStableSeqEN}`);
        return;
      }
      if (Number.isFinite(s)) {
        lastStableSeqEN = s;
        DBG.lastEnStableSeqSeen = s;
      }
    }

    if (scheduledEN) flushEN();
    if (full === fullTextEN) return;

    if (full.length >= fullTextEN.length) {
      fullTextEN = full;
      if (showEN) renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN, textWidthEN);
      return;
    }

    if (fullTextEN.startsWith(full)) {
      fullTextEN = full;
      if (showEN) renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN, textWidthEN);
      return;
    }

    const diff = Math.abs(full.length - fullTextEN.length);
    if (diff > 24) {
      fullTextEN = full;
      if (showEN) renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN, textWidthEN);
      return;
    }

    if (DEBUG) dlog(`[EN stable] SKIP (shorter but not prefix, diff=${diff})`);
  }

  // ---------- VI model: commit + draft + throttle render ----------
  // commit: phần đã “ổn định”
  let viCommitText = "";
  // draft: phần nháp thay đổi liên tục (không được phép phá commit)
  let viDraftText = "";

  // ops apply lên COMMIT (delta/commit/patch)
  let scheduledVI = false;
  const opsVI = []; // { del, ins, seq }

  let lastViSeqApplied = -1;       // guard mọi msg VI có seq
  let lastViEnSeqApplied = -1;     // guard theo en_seq nếu có
  let viEpoch = 0;                // guard theo epoch nếu có
  let viLastReqId = -1;           // guard theo req_id nếu có

  function getVIVisibleText() {
    if (viDraftText && viDraftText.startsWith(viCommitText)) return viDraftText;
    return viCommitText;
  }

  function viAcceptMeta(payload) {
    const epoch = payload?.epoch ?? payload?.Epoch ?? payload?.ep ?? null;
    const reqId = payload?.req_id ?? payload?.reqId ?? payload?.request_id ?? null;
    const enSeq = payload?.en_seq ?? payload?.enSeq ?? null;
    const seq = payload?.seq ?? payload?.Seq ?? null;
    return { epoch, reqId, enSeq, seq };
  }

  function viGuardAndUpdate({ epoch, reqId, enSeq, seq }, kind) {
    // epoch guard
    if (epoch != null) {
      const e = Number(epoch);
      if (Number.isFinite(e)) {
        if (e < viEpoch) {
          DBG.viDropEpoch++;
          tracePush("vi-drop-epoch", { kind, epoch: e, cur: viEpoch });
          return false;
        }
        if (e > viEpoch) {
          // adopt newer epoch if upstream uses it
          viEpoch = e;
          viLastReqId = -1;
          lastViSeqApplied = -1;
          lastViEnSeqApplied = -1;
          tracePush("vi-epoch-adopt", { kind, epoch: e });
        }
      }
    }

    // req_id guard (chỉ để chống draft cũ đè draft mới)
    if (reqId != null) {
      const r = Number(reqId);
      if (Number.isFinite(r)) {
        if (r < viLastReqId) {
          DBG.viDropReq++;
          tracePush("vi-drop-req", { kind, reqId: r, last: viLastReqId });
          return false;
        }
        if (r > viLastReqId) viLastReqId = r;
      }
    }

    // en_seq guard (đảm bảo VI không “đi lùi” theo EN stable cũ)
    if (enSeq != null) {
      const es = Number(enSeq);
      if (Number.isFinite(es)) {
        if (es < lastViEnSeqApplied) {
          DBG.viDropEnSeq++;
          tracePush("vi-drop-enseq", { kind, enSeq: es, last: lastViEnSeqApplied });
          return false;
        }
        lastViEnSeqApplied = es;
        DBG.lastViEnSeqSeen = es;
      }
    }

    // seq guard
    if (seq != null) {
      const s = Number(seq);
      if (Number.isFinite(s)) {
        if (s <= lastViSeqApplied) {
          DBG.viDropSeq++;
          tracePush("vi-drop-seq", { kind, seq: s, last: lastViSeqApplied });
          return false;
        }
        lastViSeqApplied = s;
        DBG.lastViSeqSeen = s;
      }
    }

    return true;
  }

  function enqueueOpVI(delN, insS, meta) {
    DBG.opsInFrameVI++;

    const t = nowMs();
    const dt = DBG.viLastRecvAt ? (t - DBG.viLastRecvAt) : 0;
    DBG.viLastRecvAt = t;

    const del = (delN | 0);
    const ins = insS ? String(insS) : "";

    // best-effort guard
    if (!viGuardAndUpdate(meta || {}, "vi-op")) return;

    opsVI.push({ del, ins, seq: meta?.seq ?? null });
    tracePush("vi-enqueue", { dt, del, insLen: ins.length, commitLen: viCommitText.length });

    if (!scheduledVI) {
      scheduledVI = true;
      requestAnimationFrame(flushVI);
    }
  }

  // throttle render VI: ra theo word/cụm, tránh update liên tục gây loạn
  let viRenderTimer = null;

  function shouldRenderVI(text, force = false) {
    if (force) return true;
    const t = nowMs();
    const dt = DBG.viLastRenderAt ? (t - DBG.viLastRenderAt) : 999999;

    // nếu tới hạn bắt buộc thì render
    if (dt >= VI_FORCE_RENDER_MS) return true;

    // nếu gặp boundary thì render sớm hơn
    if (dt >= VI_MIN_RENDER_MS && VI_RENDER_BOUNDARY_RE.test(text)) return true;

    return false;
  }

  function doRenderVI(force = false) {
    if (!showVI) return;
    const text = getVIVisibleText();

    const t = nowMs();
    const can = shouldRenderVI(text, force);
    if (!can) {
      // đảm bảo không “kẹt” quá lâu: setTimeout ép render
      if (!viRenderTimer) {
        viRenderTimer = setTimeout(() => {
          viRenderTimer = null;
          doRenderVI(true);
        }, Math.max(0, VI_FORCE_RENDER_MS));
      }
      return;
    }

    DBG.viLastRenderAt = t;
    DBG.viLastRenderedLen = text.length;
    renderTwoLines(text, bubbleVI, l1VI, l2VI, textWidthVI);
  }

  function flushVI() {
    try {
      if (!opsVI.length) return;

      DBG.viFlush++;
      const t = nowMs();
      const dt = DBG.viLastFlushAt ? (t - DBG.viLastFlushAt) : 0;
      DBG.viLastFlushAt = t;

      if (DEBUG) {
        dlog(`[VI flush] dt=${dt}ms opsInFrame=${DBG.opsInFrameVI} queued=${opsVI.length} commitLen(before)=${viCommitText.length}`);
      }

      for (let i = 0; i < opsVI.length; i++) {
        viCommitText = applyOneOp(viCommitText, opsVI[i]);
      }
      opsVI.length = 0;

      // nếu draft không còn extends commit => bỏ draft (tránh draft cũ đè commit mới)
      if (viDraftText && !viDraftText.startsWith(viCommitText)) {
        // nhưng nếu commit lại là prefix của draft (ngược) => vẫn ok (đã check)
        // ở đây là diverge => drop draft
        viDraftText = "";
      }

      tracePush("vi-flush", { dt, commitLen: viCommitText.length, visLen: getVIVisibleText().length });

      doRenderVI(false);
    } finally {
      DBG.opsInFrameVI = 0;
      scheduledVI = false;
    }
  }

  function applyStableVI(full, meta) {
    if (typeof full !== "string") return;
    DBG.viStable++;

    if (!viGuardAndUpdate(meta || {}, "vi-stable")) return;

    if (scheduledVI) flushVI();
    if (full === viCommitText) return;

    // policy: accept grow / prefix shrink / big diff resync
    if (
      full.length >= viCommitText.length ||
      viCommitText.startsWith(full) ||
      Math.abs(full.length - viCommitText.length) > 24
    ) {
      viCommitText = full;

      // draft chỉ được giữ nếu nó extends commit
      if (viDraftText && !viDraftText.startsWith(viCommitText)) viDraftText = "";

      doRenderVI(true);
    } else {
      // shorter but not prefix => skip (tránh giật)
      if (DEBUG) dlog(`[VI stable] SKIP (shorter but not prefix, diff=${Math.abs(full.length - viCommitText.length)})`);
      tracePush("vi-stable-skip", { diff: Math.abs(full.length - viCommitText.length) });
    }
  }

  function applyDraftVI(full, meta) {
    if (typeof full !== "string") return;
    DBG.viDraft++;

    if (!viGuardAndUpdate(meta || {}, "vi-draft")) return;

    // draft không được phép phá commit => nếu diverge thì drop
    if (viCommitText && !full.startsWith(viCommitText)) {
      DBG.viDropDiverge++;
      tracePush("vi-drop-diverge", { draftLen: full.length, commitLen: viCommitText.length });
      return;
    }

    viDraftText = full;
    doRenderVI(false);
  }

  function resetOverlayState({ keepMode = true, showDots = true } = {}) {
    // EN reset
    fullTextEN = "";
    opsEN.length = 0;
    scheduledEN = false;
    lastPatchSeqEN = -1;
    lastStableSeqEN = -1;

    // VI reset
    viCommitText = "";
    viDraftText = "";
    opsVI.length = 0;
    scheduledVI = false;
    lastViSeqApplied = -1;
    lastViEnSeqApplied = -1;
    viLastReqId = -1;
    viEpoch = (viEpoch | 0) + 1; // drop late VI packets from previous session

    if (viRenderTimer) {
      clearTimeout(viRenderTimer);
      viRenderTimer = null;
    }

    l1EN.textContent = "";
    l2EN.textContent = "";
    l1VI.textContent = "";
    l2VI.textContent = "";
    l2EN.classList.add("compact");
    l2VI.classList.add("compact");

    if (!keepMode) {
      applyOverlayMode(false, false);
      tracePush("overlay-reset", { keepMode: false, showDots: false, epoch: viEpoch });
      return;
    }

    // Keep current mode but clear old text from previous run.
    applyOverlayMode(showEN, showVI);
    if (!showDots) {
      if (showEN) l2EN.textContent = "";
      if (showVI) l2VI.textContent = "";
    }
    tracePush("overlay-reset", { keepMode: true, showDots: !!showDots, epoch: viEpoch });
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

    // ---------- VI: delta/commit/patch (apply to COMMIT) ----------
    // VI delta (append)
    if (type === "__TRANS_VI_DELTA__" || type === "vi-delta") {
      DBG.viDelta++;
      const payload = msg.payload || msg.detail || {};
      const append = String(payload.append ?? msg.append ?? "");
      const meta = viAcceptMeta(payload);

      tracePush("vi-delta", { appendLen: append.length, seq: meta.seq ?? null, en_seq: meta.enSeq ?? null, epoch: meta.epoch ?? null, req: meta.reqId ?? null });

      enqueueOpVI(0, append, meta);
      return;
    }

    // VI commit (append or patch)
    if (type === "__TRANS_VI_COMMIT__" || type === "vi-commit") {
      DBG.viCommit++;
      const payload = msg.payload || msg.detail || {};
      const delN = Number(payload.delete ?? msg.delete ?? 0) || 0;
      const insS = String(payload.insert ?? payload.append ?? msg.insert ?? msg.append ?? "");
      const meta = viAcceptMeta(payload);

      tracePush("vi-commit", { del: delN, insLen: insS.length, seq: meta.seq ?? null });

      enqueueOpVI(delN, insS, meta);
      return;
    }

    // VI stable (authoritative full commit)
    if (type === "__TRANS_VI_STABLE__" || type === "vi-stable") {
      const payload = msg.payload || msg.detail || {};
      const full = msg.full ?? payload.full ?? msg.detail?.full;
      const meta = viAcceptMeta(payload);

      tracePush("vi-stable-msg", { fullLen: (full || "").length, seq: meta.seq ?? null });

      applyStableVI(full, meta);
      return;
    }

    // VI draft (replace, frequent) -> THROTTLED + must extend commit
    if (type === "__TRANS_VI_DRAFT__" || type === "vi-draft") {
      const payload = msg.payload || msg.detail || {};
      const full = msg.full ?? payload.full ?? payload.text ?? msg.detail?.full;
      const meta = viAcceptMeta(payload);

      tracePush("vi-draft-msg", { fullLen: (full || "").length, seq: meta.seq ?? null });

      applyDraftVI(full, meta);
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

    // Full reset between sessions (start/stop/restart).
    if (type === "__OVERLAY_RESET__" || type === "overlay-reset") {
      const p = msg.payload || msg.detail || {};
      resetOverlayState({
        keepMode: p.keepMode !== false,
        showDots: p.showDots !== false,
      });
      return;
    }

    // ✅ RESET VI ONLY (không đụng EN)
    if (type === "__TRANS_VI_RESET__") {
      if (scheduledVI) flushVI();

      viCommitText = "";
      viDraftText = "";
      opsVI.length = 0;

      lastViSeqApplied = -1;
      lastViEnSeqApplied = -1;
      viLastReqId = -1;
      viEpoch = (viEpoch | 0) + 1; // bump local epoch to drop late messages

      if (viRenderTimer) { clearTimeout(viRenderTimer); viRenderTimer = null; }

      l1VI.textContent = "";
      l2VI.textContent = "";
      l2VI.classList.add("compact");

      if (showVI && !getVIVisibleText()) l2VI.textContent = "…";
      tracePush("vi-reset", { epoch: viEpoch });
      return;
    }

    // TEARDOWN
    if (type === "__OVERLAY_TEARDOWN__") {
      try { root.remove(); } catch {}
      try { measurerEN.remove(); } catch {}
      try { measurerVI.remove(); } catch {}
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
    if (showEN) renderTwoLines(fullTextEN, bubbleEN, l1EN, l2EN, textWidthEN);
    if (showVI) doRenderVI(true);
  });

  try { chrome.runtime.sendMessage({ __cmd: "__OVERLAY_PING__" }, () => {}); } catch {}

  dlog("overlay mounted OK");
})();
