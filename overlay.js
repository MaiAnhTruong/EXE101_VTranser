// /home/truong/EXE/my-tab-audio-ext/overlay.js
(() => {
  const ROOT_ID = 'stt-yt-overlay';
  if (document.getElementById(ROOT_ID)) return;

  const DEBUG = (localStorage.getItem('sttOverlayDebug') === '1');
  const dlog  = (...a) => { if (DEBUG) console.log('[stt-overlay]', ...a); };

  // mỗi dòng tối đa bao nhiêu "câu"
  const MAX_SENTENCES_PER_LINE = Number(localStorage.getItem('sttMaxSentPerLine') || 2);

  // ---------- mount UI ----------
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('role', 'log');
  root.setAttribute('aria-live', 'polite');
  root.innerHTML = `
    <div class="frame">
      <div class="bubble">
        <div class="line line1" id="stt-line1"></div>
        <div class="line line2" id="stt-line2"></div>
      </div>
    </div>`;
  document.documentElement.appendChild(root);

  const $frame  = root.querySelector('.frame');
  const $bubble = root.querySelector('.bubble');
  const $l1 = root.querySelector('#stt-line1');
  const $l2 = root.querySelector('#stt-line2');
  $l2.classList.add('compact');

  // ---------- measurer để đo bề rộng text ----------
  const measurer = document.createElement('div');
  document.documentElement.appendChild(measurer);
  const syncMeasureStyle = () => {
    const cs = getComputedStyle($l2);
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

  // bề rộng tối đa dùng cho text bên trong (khung - padding bong bóng)
  const innerMaxPx = () => {
    const frameW = $frame.clientWidth;
    const cs = getComputedStyle($bubble);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return Math.max(0, frameW - padL - padR);
  };

  // ---------- model (toàn văn realtime, áp patch) ----------
  let fullText = '';

  // 1) tách thành câu hoàn chỉnh + tail (chưa kết câu)
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

  // 2) cắt 1 câu theo bề rộng còn lại (không vượt maxPx).
  //    Ưu tiên cắt theo token (từ/space); nếu 1 token quá dài -> cắt theo ký tự (binary search).
  function fitPrefixByWidth(sentence, remPx) {
    if (remPx <= 0) return { fit: '', rest: sentence };
    const tokens = String(sentence).split(/(\s+)/); // giữ khoảng trắng
    let fit = '';
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      const next = fit + tok;
      if (textWidth(next) <= remPx) {
        fit = next;
      } else {
        // token quá to hoặc không còn chỗ -> thử cắt ký tự trong tok
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
          fit = cut;
          const rest = restTok + tokens.slice(i + 1).join('');
          return { fit, rest };
        }
        // đã có fit, dừng tại đây
        return { fit, rest: tokens.slice(i).join('') };
      }
    }
    return { fit, rest: '' }; // câu fit trọn
  }

  // 3) chuyển toàn văn -> danh sách "dòng" theo quy tắc:
  //    - Mỗi dòng chứa tối đa K=MAX_SENTENCES_PER_LINE "câu".
  //    - Khi chèn 1 câu mà không đủ chỗ, cắt phần thừa xuống dòng (và phần thừa đếm là 1 câu).
  function buildLines(text) {
    const { sents, tail } = splitSentencesAndTail(text);
    const queue = sents.slice();
    if (tail) queue.push(tail);

    const lines = [];
    const maxPx = innerMaxPx();

    while (queue.length) {
      let line = '';
      let used = 0;
      let guard = 0;

      while (used < MAX_SENTENCES_PER_LINE && queue.length && guard++ < 10000) {
        const sentence = queue.shift();
        const candidate = line + sentence;

        if (textWidth(candidate) <= maxPx) {
          // nguyên câu vừa khung
          line = candidate;
          used += 1;
          continue;
        }

        // không vừa: lấy phần prefix vừa khung -> phần còn lại trả lại hàng đợi (đếm như 1 câu)
        const remPx = maxPx - textWidth(line);
        if (remPx <= 0) {
          // dòng đã kín -> trả câu lại để dòng sau xử lý
          queue.unshift(sentence);
          break;
        }
        const { fit, rest } = fitPrefixByWidth(sentence, remPx);
        if (fit) {
          line += fit;
          used += 1;                 // phần đã fit tính là 1 câu
          if (rest) queue.unshift(rest); // phần thừa cho dòng sau (1 câu)
        } else {
          // không fit được gì (edge case) -> kết thúc dòng
          queue.unshift(sentence);
        }
        break; // sau khi cắt một câu -> dừng thêm nữa cho dòng này
      }

      if (line) {
        lines.push(line);
      } else {
        // fallback để tránh kẹt: ép lấy ít nhất 1 ký tự từ câu đầu
        const s = queue.shift();
        const { fit, rest } = fitPrefixByWidth(s, maxPx);
        lines.push(fit || s.slice(0, 1));
        if (rest) queue.unshift(rest);
      }
    }

    return lines;
  }

  // 4) render 2 dòng cuối (cũ trên / mới dưới)
  function renderFromModel() {
    const lines = buildLines(fullText);
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

  // ---------- rAF batching patch ----------
  let qDel = 0, qIns = '';
  let scheduled = false;

  function enqueuePatch(delN, insS) {
    qDel += (delN|0);
    if (insS) qIns += String(insS);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flushPatches); }
  }

  function flushPatches() {
    try {
      if (qDel || qIns) {
        if (qDel > 0) fullText = qDel >= fullText.length ? '' : fullText.slice(0, fullText.length - qDel);
        if (qIns) fullText += qIns;
        qDel = 0; qIns = '';
        renderFromModel();
      }
    } finally { scheduled = false; }
  }

  // ---------- message handlers ----------
  function handleMessage(msg) {
    if (!msg) return;
    const type = msg.__cmd || msg.type;
    if (!type) return;

    if (type === '__TRANSCRIPT_PATCH__' || type === 'patch') {
      const delN = Number(msg.payload?.delete ?? msg.delete ?? 0) || 0;
      const insS = String(msg.payload?.insert ?? msg.insert ?? '');
      enqueuePatch(delN, insS);
      return;
    }
    if (type === '__TRANSCRIPT_DELTA__' || type === 'delta' || type === 'delta-append') {
      const append = String(msg.payload?.append ?? msg.append ?? '');
      enqueuePatch(0, append);
      return;
    }
    if (type === '__TRANSCRIPT_STABLE__' || type === 'stable') {
      const full = msg.full ?? msg.detail?.full ?? msg.payload?.full;
      if (typeof full === 'string' && full.length >= fullText.length) {
        if (scheduled) flushPatches();
        fullText = full;
        renderFromModel();
      }
      return;
    }
    if (type === '__OVERLAY_RESET__') {
      if (scheduled) flushPatches();
      fullText = '';
      $l1.textContent = '';
      $l2.textContent = '';
      $l2.classList.add('compact');
      return;
    }
    if (type === '__OVERLAY_TEARDOWN__') {
      try { root.remove(); } catch {}
      return;
    }
  }

  // ---------- wiring ----------
  try { chrome.runtime.onMessage.addListener((m) => handleMessage(m)); } catch {}
  try { const port = chrome.runtime.connect({ name: 'stt-overlay' }); port.onMessage.addListener((m) => handleMessage(m)); } catch {}
  window.addEventListener('message', (ev) => { const m = ev?.data; if (m && (m.__cmd || m.type)) handleMessage(m); });

  // re-sync font metrics & re-render khi resize (khung cố định theo min(90vw, 1100px))
  window.addEventListener('resize', () => { syncMeasureStyle(); renderFromModel(); });

  try { chrome.runtime.sendMessage({ __cmd: '__OVERLAY_PING__' }, () => {}); } catch {}
})();