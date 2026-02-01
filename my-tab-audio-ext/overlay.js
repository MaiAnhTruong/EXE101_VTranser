// overlay.js
(() => {
  const ROOT_ID = 'stt-yt-overlay';
  if (document.getElementById(ROOT_ID)) return;

  const DEBUG = (localStorage.getItem('sttOverlayDebug') === '1');
  const dlog  = (...a) => { if (DEBUG) console.log('[stt-overlay]', ...a); };

  const MAX_SENTENCES_PER_LINE = Number(localStorage.getItem('sttMaxSentPerLine') || 2);

  // ---------- mount UI ----------
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('role', 'log');
  root.setAttribute('aria-live', 'polite');
  root.innerHTML = `
    <div class="frame">
      <div class="bubble" id="bubble-en">
        <div class="line line1" id="stt-line1"></div>
        <div class="line line2" id="stt-line2"></div>
      </div>
      <div class="bubble-vi" id="bubble-vi">
        <div class="line line1" id="stt-line1-vi"></div>
        <div class="line line2" id="stt-line2-vi"></div>
      </div>
    </div>`;

  // append vào body nếu có để chắc render
  (document.body || document.documentElement).appendChild(root);

  const $frame  = root.querySelector('.frame');
  const $bubbleEN = root.querySelector('#bubble-en');
  const $bubbleVI = root.querySelector('#bubble-vi');

  const $l1EN = root.querySelector('#stt-line1');
  const $l2EN = root.querySelector('#stt-line2');
  const $l1VI = root.querySelector('#stt-line1-vi');
  const $l2VI = root.querySelector('#stt-line2-vi');

  $l2EN.classList.add('compact');
  $l2VI.classList.add('compact');

  // mode control
  let showEN = false;
  let showVI = false;
  let gotMode = false;      // NEW
  let seenAnyText = false;  // NEW: nếu đã có transcript mà chưa có mode -> fallback

  function applyOverlayMode(enOn, viOn) {
    gotMode = true;
    showEN = !!enOn;
    showVI = !!viOn;
    const any = showEN || showVI;
    root.style.display = any ? '' : 'none';
    if ($bubbleEN) $bubbleEN.style.display = showEN ? '' : 'none';
    if ($bubbleVI) $bubbleVI.style.display = showVI ? '' : 'none';
    dlog('applyOverlayMode', { showEN, showVI });
  }

  // Ban đầu ẩn overlay, đợi mode
  applyOverlayMode(false, false);

  // NEW fallback: nếu 1.2s chưa nhận mode, vẫn chưa show,
  // nhưng có transcript đến => bật EN để user thấy ngay.
  const modeFallbackTimer = setTimeout(() => {
    if (!gotMode && seenAnyText) {
      applyOverlayMode(true, false);
      dlog('fallback show EN (no mode received)');
    }
  }, 1200);

  // ---------- measurer ----------
  const measurer = document.createElement('div');
  measurer.setAttribute('aria-hidden', 'true');
  (document.body || document.documentElement).appendChild(measurer);

  const syncMeasureStyle = () => {
    const cs = getComputedStyle($l2EN);
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
    const frameW = $frame.clientWidth;
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
    if (remPx <= 0) return { fit: '', rest: sentence };
    const tokens = String(sentence).split(/(\s+)/);
    let fit = '';
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
          const rest = restTok + tokens.slice(i + 1).join('');
          return { fit: cut, rest };
        }
        return { fit, rest: tokens.slice(i).join('') };
      }
    }
    return { fit, rest: '' };
  }

  function buildLines(text, bubbleEl) {
    const { sents, tail } = splitSentencesAndTail(text);
    const queue = sents.slice();
    if (tail) queue.push(tail);

    const lines = [];
    const maxPx = innerMaxPx(bubbleEl);

    while (queue.length) {
      let line = '';
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
    let line1 = '', line2 = '';

    if (lines.length === 0) {
      line1 = ''; line2 = '';
    } else if (lines.length === 1) {
      line1 = ''; line2 = lines[0];
    } else {
      line1 = lines[lines.length - 2];
      line2 = lines[lines.length - 1];
    }

    if ($l1.textContent !== line1) $l1.textContent = line1;
    if ($l2.textContent !== line2) $l2.textContent = line2;

    if (!line1.trim()) $l2.classList.add('compact'); else $l2.classList.remove('compact');
  }

  // ---------- EN ----------
  let fullTextEN = '';
  let qDelEN = 0, qInsEN = '';
  let scheduledEN = false;

  function enqueuePatchEN(delN, insS) {
    qDelEN += (delN|0);
    if (insS) qInsEN += String(insS);
    if (!scheduledEN) { scheduledEN = true; requestAnimationFrame(flushPatchesEN); }
  }
  function flushPatchesEN() {
    try {
      if (qDelEN || qInsEN) {
        if (qDelEN > 0) fullTextEN = qDelEN >= fullTextEN.length ? '' : fullTextEN.slice(0, fullTextEN.length - qDelEN);
        if (qInsEN) fullTextEN += qInsEN;
        qDelEN = 0; qInsEN = '';
        renderTwoLines(fullTextEN, $bubbleEN, $l1EN, $l2EN);
      }
    } finally { scheduledEN = false; }
  }

  // ---------- VI ----------
  let fullTextVI = '';
  let qDelVI = 0, qInsVI = '';
  let scheduledVI = false;

  function enqueuePatchVI(delN, insS) {
    qDelVI += (delN|0);
    if (insS) qInsVI += String(insS);
    if (!scheduledVI) { scheduledVI = true; requestAnimationFrame(flushPatchesVI); }
  }
  function flushPatchesVI() {
    try {
      if (qDelVI || qInsVI) {
        if (qDelVI > 0) fullTextVI = qDelVI >= fullTextVI.length ? '' : fullTextVI.slice(0, fullTextVI.length - qDelVI);
        if (qInsVI) fullTextVI += qInsVI;
        qDelVI = 0; qInsVI = '';
        renderTwoLines(fullTextVI, $bubbleVI, $l1VI, $l2VI);
      }
    } finally { scheduledVI = false; }
  }

  // ---------- message handlers ----------
  function ensureVisibleIfNeeded() {
    // nếu đã nhận text mà chưa nhận mode => fallback bật EN
    if (!gotMode && seenAnyText) {
      applyOverlayMode(true, false);
    }
  }

  function handleMessage(msg) {
    if (!msg) return;
    const type = msg.__cmd || msg.type;
    if (!type) return;

    // EN
    if (type === '__TRANSCRIPT_PATCH__' || type === 'patch') {
      seenAnyText = true;
      ensureVisibleIfNeeded();
      const delN = Number(msg.payload?.delete ?? msg.delete ?? 0) || 0;
      const insS = String(msg.payload?.insert ?? msg.insert ?? '');
      enqueuePatchEN(delN, insS);
      return;
    }
    if (type === '__TRANSCRIPT_DELTA__' || type === 'delta' || type === 'delta-append') {
      seenAnyText = true;
      ensureVisibleIfNeeded();
      const append = String(msg.payload?.append ?? msg.append ?? '');
      enqueuePatchEN(0, append);
      return;
    }
    if (type === '__TRANSCRIPT_STABLE__' || type === 'stable') {
      seenAnyText = true;
      ensureVisibleIfNeeded();
      const full = msg.full ?? msg.detail?.full ?? msg.payload?.full;
      if (typeof full === 'string' && full.length >= fullTextEN.length) {
        if (scheduledEN) flushPatchesEN();
        fullTextEN = full;
        renderTwoLines(fullTextEN, $bubbleEN, $l1EN, $l2EN);
      }
      return;
    }

    // VI
    if (type === '__TRANS_VI_DELTA__' || type === 'vi-delta') {
      seenAnyText = true;
      ensureVisibleIfNeeded();
      const append = String(msg.payload?.append ?? msg.append ?? '');
      enqueuePatchVI(0, append);
      return;
    }
    if (type === '__TRANS_VI_STABLE__' || type === 'vi-stable') {
      seenAnyText = true;
      ensureVisibleIfNeeded();
      const full = msg.full ?? msg.detail?.full ?? msg.payload?.full;
      if (typeof full === 'string' && full.length >= fullTextVI.length) {
        if (scheduledVI) flushPatchesVI();
        fullTextVI = full;
        renderTwoLines(fullTextVI, $bubbleVI, $l1VI, $l2VI);
      }
      return;
    }

    if (type === '__OVERLAY_MODE__' || type === 'overlay-mode') {
      const cfg = msg.payload || msg.detail || {};
      const enOn = !!(cfg.en ?? cfg.subtitle ?? cfg.showEN);
      const viOn = !!(cfg.vi ?? cfg.subtitle_vi ?? cfg.showVI);
      applyOverlayMode(enOn, viOn);
      return;
    }

    if (type === '__OVERLAY_RESET__') {
      if (scheduledEN) flushPatchesEN();
      if (scheduledVI) flushPatchesVI();
      fullTextEN = ''; fullTextVI = '';
      $l1EN.textContent = ''; $l2EN.textContent = ''; $l2EN.classList.add('compact');
      $l1VI.textContent = ''; $l2VI.textContent = ''; $l2VI.classList.add('compact');
      return;
    }

    if (type === '__OVERLAY_TEARDOWN__') {
      try { clearTimeout(modeFallbackTimer); } catch {}
      try { measurer.remove(); } catch {}
      try { root.remove(); } catch {}
      return;
    }
  }

  // ---------- wiring ----------
  try { chrome.runtime.onMessage.addListener((m) => handleMessage(m)); } catch {}
  try {
    const port = chrome.runtime.connect({ name: 'stt-overlay' });
    port.onMessage.addListener((m) => handleMessage(m));
  } catch {}
  window.addEventListener('message', (ev) => {
    const m = ev?.data;
    if (m && (m.__cmd || m.type)) handleMessage(m);
  });

  window.addEventListener('resize', () => {
    syncMeasureStyle();
    renderTwoLines(fullTextEN, $bubbleEN, $l1EN, $l2EN);
    renderTwoLines(fullTextVI, $bubbleVI, $l1VI, $l2VI);
  });

  // ✅ NEW: notify SW that overlay is ready (anti-race)
  try { chrome.runtime.sendMessage({ __cmd: '__OVERLAY_READY__' }, () => {}); } catch {}

  // ping mode
  try { chrome.runtime.sendMessage({ __cmd: '__OVERLAY_PING__' }, () => {}); } catch {}

  dlog("overlay mounted:", ROOT_ID);
})();
