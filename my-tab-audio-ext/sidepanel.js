document.addEventListener('DOMContentLoaded', () => {
  // ===== Constants =====
  const LS_KEY_SERVER = 'sttServerWs';
  const DEFAULT_WS = 'ws://localhost:8765';

  const LS_CHAT_API = 'sttChatApiBase';
  const DEFAULT_API = 'http://127.0.0.1:8000';
  const LS_CHAT_SESSION = 'sttChatSessionId';

  // Persist transcript modes
  const LS_MODE_EN = 'sttModeEn';
  const LS_MODE_VI = 'sttModeVi';
  const LS_MODE_VOICE = 'sttModeVoice';

  // Persist chat toggles
  const LS_CHAT_USE_RAG = 'sttChatUseRag';
  const LS_CHAT_USE_R1 = 'sttChatUseR1';

  // Optional debug
  const LS_CHAT_DEBUG = 'sttChatDebug'; // set "1" to log + show sent prompt in meta

  const hasChromeRuntime =
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === 'function';

  // ===== Utils =====
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));

  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  const nowTime = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const uid = () => Math.random().toString(36).slice(2, 10);

  function getServer() {
    const v = (localStorage.getItem(LS_KEY_SERVER) || '').trim();
    return v || DEFAULT_WS;
  }

  function getApiBase() {
    const raw = (localStorage.getItem(LS_CHAT_API) || DEFAULT_API).trim();
    return raw.replace(/\/+$/, '');
  }

  function getSessionId() {
    let sid = localStorage.getItem(LS_CHAT_SESSION);
    if (!sid) {
      sid = 'sess_' + uid();
      localStorage.setItem(LS_CHAT_SESSION, sid);
    }
    return sid;
  }

  function readBoolLS(key, fallback) {
    const v = localStorage.getItem(key);
    if (v === null || v === undefined) return fallback;
    return v === '1' || v === 'true';
  }

  function writeBoolLS(key, val) {
    try { localStorage.setItem(key, val ? '1' : '0'); } catch {}
  }

  function isDebug() {
    return (localStorage.getItem(LS_CHAT_DEBUG) || '') === '1';
  }

  const dlog = (...args) => { if (isDebug()) console.log('[sidepanel]', ...args); };

  // ===== chrome.storage helpers =====
  function storeGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, resolve); } catch { resolve({}); }
    });
  }
  function storeRemove(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.remove(keys, resolve); } catch { resolve(); }
    });
  }

  // ===== Auth checks =====
  async function getVtAuthProfile() {
    const st = await storeGet(['vtAuth']);
    const raw = st?.vtAuth || null;
    const profile = raw?.profile || raw?.currentSession?.profile || null;
    return profile;
  }
  async function isAuthed() {
    const p = await getVtAuthProfile();
    return !!(p && (p.email || p.id || p.name));
  }

  // ===== DOM Refs =====
  const chatButton = document.getElementById('btn-chat');
  const transcriptButton = document.getElementById('btn-transcript');
  const settingButton = document.getElementById('btn-setting');
  const allToolbarButtons = document.querySelectorAll('.toolbar .icon-btn');

  const chatView = document.getElementById('chat-content');
  const transcriptView = document.getElementById('transcript-content');
  const allViews = [chatView, transcriptView];

  const chatHeader = document.querySelector('.main-header');
  const chatActionButtons = document.querySelector('.action-buttons');
  const chatInputArea = document.querySelector('.chat-input-area');
  const chatTextArea = document.querySelector('#chat-content .textarea-wrapper textarea');
  const chatHistory = document.querySelector('.chat-history-area');

  const transcriptStart = document.querySelector('.transcript-btn1.start');
  const transcriptBody = document.querySelector('.transcript-body');
  const transcriptLiveFooter = document.querySelector('.transcript-live-footer span');
  const liveTimestampEl = document.querySelector('.live-timestamp');
  const transcriptHeaderUrlEl = document.querySelector('.transcript-header .transcript-url');

  const subtitleBtn = document.getElementById('btn-subtitle');            // EN
  const subtitleTransBtn = document.getElementById('btn-subtitle-trans'); // VI translate
  const voiceBtn = document.getElementById('btn-voice');

  const chipButtons = document.querySelectorAll('.input-header .chip-button');
  const chipRag = chipButtons[0] || null;
  const chipR1 = chipButtons[1] || null;

  const sendBtn = document.getElementById('icon-btn-send');
  const loginBtns = document.querySelectorAll('.login-btn');

  // ===== Auth open helper =====
  function openAuthOverlayFromPanel() {
    if (typeof window.__vtOpenAccountOrAuth === 'function') {
      window.__vtOpenAccountOrAuth('login');
      return;
    }
    if (typeof window.__vtOpenAuthOverlay === 'function') {
      window.__vtOpenAuthOverlay('login');
      return;
    }
    const btnAccount =
      document.getElementById('btnAccount') ||
      document.querySelector('[data-vt-account]');
    if (btnAccount) btnAccount.click();
  }

  if (loginBtns && loginBtns.length) {
    loginBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault?.();
        openAuthOverlayFromPanel();
      });
    });
  }

  // ✅ If SW asked to login recently
  (async () => {
    try {
      const st = await storeGet(['vtNeedAuth']);
      const need = st?.vtNeedAuth;
      if (need && need.at && (Date.now() - Number(need.at) < 5 * 60 * 1000)) {
        openAuthOverlayFromPanel();
      }
      if (need) await storeRemove(['vtNeedAuth']);
    } catch {}
  })();

  // ===== Setting: config API + WS =====
  if (settingButton) {
    settingButton.addEventListener('click', () => {
      const apiCur = localStorage.getItem(LS_CHAT_API) || DEFAULT_API;
      const wsCur = localStorage.getItem(LS_KEY_SERVER) || DEFAULT_WS;

      const apiNext = prompt('Nhập Chat API base (vd: http://127.0.0.1:8000)', apiCur);
      if (apiNext && apiNext.trim()) localStorage.setItem(LS_CHAT_API, apiNext.trim());

      const wsNext = prompt('Nhập STT WS server (vd: ws://localhost:8765)', wsCur);
      if (wsNext && wsNext.trim()) localStorage.setItem(LS_KEY_SERVER, wsNext.trim());
    });
  }

  // ===== Transcript header URL =====
  async function updateTranscriptHeaderUrl() {
    if (!hasChromeRuntime || !transcriptHeaderUrlEl) return;
    if (!chrome.tabs || !chrome.tabs.query) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab && tab.url ? tab.url : '';
      transcriptHeaderUrlEl.textContent = url
        ? `Website: ${url}`
        : 'Website: (không xác định)';
    } catch {}
  }

  // ============================================================
  // ✅ TRANSCRIPT MODES
  // ============================================================
  const modes = {
    en: readBoolLS(LS_MODE_EN, true),
    vi: readBoolLS(LS_MODE_VI, false),
    voice: readBoolLS(LS_MODE_VOICE, false)
  };

  function setBtnActive(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', !!on);
  }

  function applyModesToUI() {
    if (modes.vi) modes.en = true;
    if (!modes.en && !modes.vi) modes.en = true;

    setBtnActive(subtitleBtn, modes.en);
    setBtnActive(subtitleTransBtn, modes.vi);
    setBtnActive(voiceBtn, modes.voice);

    writeBoolLS(LS_MODE_EN, modes.en);
    writeBoolLS(LS_MODE_VI, modes.vi);
    writeBoolLS(LS_MODE_VOICE, modes.voice);
  }

  function sendTranscriptModes() {
    if (!hasChromeRuntime) return;
    applyModesToUI();
    const payload = { en: !!modes.en, vi: !!modes.vi, voice: !!modes.voice };
    try {
      chrome.runtime.sendMessage({ __cmd: '__TRANSCRIPT_MODES__', payload });
    } catch {}
  }

  function bindModeButtons() {
    if (subtitleBtn) {
      subtitleBtn.addEventListener('click', () => {
        modes.en = !modes.en;
        if (!modes.en && modes.vi) modes.vi = false;
        sendTranscriptModes();
      });
    }

    if (subtitleTransBtn) {
      subtitleTransBtn.addEventListener('click', () => {
        modes.vi = !modes.vi;
        if (modes.vi) modes.en = true;
        sendTranscriptModes();
      });
    }

    if (voiceBtn) {
      voiceBtn.addEventListener('click', () => {
        modes.voice = !modes.voice;
        sendTranscriptModes();
      });
    }
  }

  // ===== View switching =====
  function showView(viewId, clickedButton) {
    allViews.forEach(view => view && view.classList.add('hidden'));
    allToolbarButtons.forEach(btn => btn.classList.remove('active'));

    const viewToShow = document.getElementById(viewId);
    if (viewToShow) viewToShow.classList.remove('hidden');

    if (clickedButton) clickedButton.classList.add('active');

    if (viewId === 'chat-content') {
      chatHeader && chatHeader.classList.remove('hidden');
      chatActionButtons && chatActionButtons.classList.remove('hidden');
      chatInputArea && chatInputArea.classList.remove('hidden');
    } else {
      chatHeader && chatHeader.classList.add('hidden');
      chatActionButtons && chatActionButtons.classList.add('hidden');
      chatInputArea && chatInputArea.classList.add('hidden');
      chatView && chatView.classList.remove('focus-mode');
    }
  }

  if (chatButton) chatButton.addEventListener('click', () => showView('chat-content', chatButton));
  if (transcriptButton) transcriptButton.addEventListener('click', () => showView('transcript-content', transcriptButton));

  if (transcriptButton) showView('transcript-content', transcriptButton);
  else showView('chat-content', chatButton);

  // ===== Transcript: clock =====
  if (liveTimestampEl) {
    liveTimestampEl.textContent = nowTime();
    setInterval(() => (liveTimestampEl.textContent = nowTime()), 1000);
  }

  let loggedSentCount = 0;

  const SENT_RE = /[^.!?…]*[.!?…]+(?:["”’']+)?(?:\s+|$)/g;
  function splitSentencesAndTail(text) {
    const sents = [];
    let lastEnd = 0;
    let m;
    while ((m = SENT_RE.exec(text)) !== null) {
      sents.push(m[0]);
      lastEnd = SENT_RE.lastIndex;
    }
    return { sents, tail: text.slice(lastEnd) };
  }

  function addTranscriptRow(timeStr, text, meta = 'Speaker • en • live') {
    if (!transcriptBody) return;
    const placeholder = transcriptBody.querySelector('.transcript-placeholder');
    if (placeholder) placeholder.remove();

    const row = document.createElement('div');
    row.className = 'transcript-entry';
    row.innerHTML = `
      <span class="timestamp">${escapeHtml(timeStr)}</span>
      <div class="text-block">
        <p>${escapeHtml(text)}</p>
        <span class="speaker-info">${escapeHtml(meta)}</span>
      </div>
    `;
    transcriptBody.appendChild(row);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }

  // ===== START/STOP capture =====
  if (transcriptStart) {
    transcriptStart.addEventListener('click', async () => {
      const currentlyActive = transcriptStart.classList.contains('active');

      if (!currentlyActive) {
        const ok = await isAuthed();
        if (!ok) {
          openAuthOverlayFromPanel();
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';
          return;
        }
      }

      const isActive = transcriptStart.classList.toggle('active');

      if (hasChromeRuntime) {
        if (isActive) {
          chrome.runtime.sendMessage(
            { __cmd: '__PANEL_START__', payload: { server: getServer() } },
            (res) => {
              if (!res?.ok) {
                transcriptStart.classList.remove('active');
                if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';

                if (res?.code === 'AUTH_REQUIRED') {
                  openAuthOverlayFromPanel();
                  return;
                }

                if (res?.error) alert('Không capture được tab hiện tại:\n' + res.error);
              }
            }
          );

          if (transcriptBody) {
            transcriptBody.innerHTML = `
              <div class="placeholder-text transcript-placeholder">
                Đang ghi phụ đề...
              </div>`;
          }

          loggedSentCount = 0;
          updateTranscriptHeaderUrl();
          sendTranscriptModes();
        } else {
          chrome.runtime.sendMessage({ __cmd: '__PANEL_STOP__' });
        }
      }

      if (transcriptLiveFooter) {
        transcriptLiveFooter.textContent = isActive ? 'Live • Đang ghi' : 'Live';
      }
    });
  }

  // ===== Receive transcript + AUTH_REQUIRED broadcast =====
  if (hasChromeRuntime) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.__cmd) return;

      if (msg.__cmd === '__AUTH_REQUIRED__') {
        openAuthOverlayFromPanel();
        return;
      }

      if (msg.__cmd === '__PANEL_OPENED__') {
        const server = (msg.payload?.server || '').trim();
        if (server) { try { localStorage.setItem(LS_KEY_SERVER, server); } catch {} }

        if (typeof msg.payload?.active === 'boolean' && transcriptLiveFooter) {
          transcriptLiveFooter.textContent = msg.payload.active ? 'Live • Đang ghi' : 'Live';
          if (transcriptStart) transcriptStart.classList.toggle('active', msg.payload.active);
        }

        if (msg.payload?.url && transcriptHeaderUrlEl) {
          transcriptHeaderUrlEl.textContent = `Website: ${msg.payload.url}`;
        } else {
          updateTranscriptHeaderUrl();
        }
        return;
      }

      if (msg.__cmd === '__TRANSCRIPT_STABLE__') {
        const full = String(msg.payload?.full ?? msg.full ?? '');
        if (!full) return;
        const { sents } = splitSentencesAndTail(full);
        const target = Math.max(0, sents.length - 1);
        if (target > loggedSentCount) {
          const t = nowTime();
          for (let i = loggedSentCount; i < target; i++) {
            const s = sents[i].trim();
            if (s) addTranscriptRow(t, s, 'Speaker • en • live');
          }
          loggedSentCount = target;
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live • Đang ghi';
        }
        return;
      }
    });

    try {
      chrome.runtime.sendMessage({ __cmd: '__OVERLAY_PING__' }, (res) => {
        if (transcriptLiveFooter) {
          transcriptLiveFooter.textContent = res?.active ? 'Live • Đang ghi' : 'Live';
        }
        if (transcriptStart && typeof res?.active === 'boolean') {
          transcriptStart.classList.toggle('active', res.active);
        }
      });
    } catch {}
  }

  // ============================================================
  // ✅ CHAT TOGGLES
  // ============================================================
  const chatToggles = {
    useRag: readBoolLS(LS_CHAT_USE_RAG, true),  // default ON
    useR1: readBoolLS(LS_CHAT_USE_R1, false),
  };

  function applyChatTogglesUI() {
    if (chipRag) chipRag.classList.toggle('active', !!chatToggles.useRag);
    if (chipR1) chipR1.classList.toggle('active', !!chatToggles.useR1);
    writeBoolLS(LS_CHAT_USE_RAG, !!chatToggles.useRag);
    writeBoolLS(LS_CHAT_USE_R1, !!chatToggles.useR1);
  }

  if (chipRag) chipRag.addEventListener('click', () => {
    chatToggles.useRag = !chatToggles.useRag;
    applyChatTogglesUI();
  });
  if (chipR1) chipR1.addEventListener('click', () => {
    chatToggles.useR1 = !chatToggles.useR1;
    applyChatTogglesUI();
  });

  // ============================================================
  // ✅ Smart rewrite (TRÁNH chữ "tóm tắt tài liệu" để không trigger template)
  // ============================================================
  function isGenericAboutQuery(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return false;
    if (s.length > 80) return false;

    const viPatterns = [
      'nội dung nói về cái gì',
      'trong bài nói về cái gì',
      'bài nói về cái gì',
      'đang nói về cái gì',
      'nội dung là gì',
      'bài này nói về gì',
      'talk about what',
      'what is it about',
      'what is the lecture about',
    ];
    if (viPatterns.some(p => s.includes(p))) return true;

    const hasCore = (s.includes('nội dung') || s.includes('bài') || s.includes('nói') || s.includes('about'));
    const hasWhat = (s.includes('gì') || s.includes('what'));
    return hasCore && hasWhat;
  }

  function buildRagQuestionV1(userQ) {
    // V1: prompt "mềm" nhưng rõ ràng, không dùng từ "tóm tắt tài liệu"
    return [
      'Hãy trả lời trực tiếp dựa trên các đoạn transcript đã được truy xuất (RAG).',
      'Câu hỏi: Bài nói đang nói về chủ đề gì?',
      'Yêu cầu: 1 câu mô tả chủ đề + 3-6 gạch đầu dòng ý chính.',
      'Không hỏi lại người dùng kiểu "bạn cần tóm tắt gì". Nếu không tìm thấy transcript, hãy nói rõ: "Không tìm thấy transcript trong RAG" và gợi ý kiểm tra TXT_RAG_PATH.',
      'English keywords (to match transcript): what is the lecture about, artificial intelligence, machine learning, deep learning, definition, subset.',
    ].join('\n');
  }

  function buildRagQuestionV2(userQ) {
    // V2: prompt "cứng" để tránh model tiếp tục boilerplate
    return [
      'NHIỆM VỤ BẮT BUỘC: trả lời câu hỏi ngay, KHÔNG đặt câu hỏi ngược.',
      'Trả lời dựa trên transcript RAG. Nếu RAG rỗng: trả lời "Không tìm thấy transcript".',
      'CÂU HỎI: Chủ đề chính của bài nói là gì? Nêu các ý chính.',
      'Output format:',
      '- Chủ đề: ...',
      '- Ý chính 1: ...',
      '- Ý chính 2: ...',
      '- Ý chính 3: ...',
      'English hint: Answer now. Do not ask the user what to summarize.',
    ].join('\n');
  }

  function buildQuestionToServer(rawQ, useRag, attempt) {
    const q = String(rawQ || '').trim();
    if (!useRag) return q;

    if (isGenericAboutQuery(q)) {
      return attempt === 0 ? buildRagQuestionV1(q) : buildRagQuestionV2(q);
    }

    // query thường: append thêm english hint nhẹ để match transcript EN
    // (không phá nghĩa câu hỏi)
    return [
      q,
      '',
      'English hint: use the retrieved transcript snippets (RAG) to answer.'
    ].join('\n');
  }

  function looksLikeBoilerplateAnswer(text) {
    const s = String(text || '').toLowerCase();
    // các câu bạn đang gặp
    if (s.includes('hiểu rồi! tôi sẽ') && s.includes('tóm tắt')) return true;
    if (s.includes('bạn cần tôi') && s.includes('tóm tắt')) return true;
    if (s.includes('xin vui lòng cung cấp') && s.includes('tóm tắt')) return true;
    return false;
  }

  // ============================================================
  // ✅ Chat UI
  // ============================================================
  function appendBubble(who, text, meta = '') {
    if (!chatHistory) return null;
    const row = document.createElement('div');
    row.className = `msg-row ${who}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = escapeHtml(text) + (meta ? `<span class="meta">${escapeHtml(meta)}</span>` : '');
    row.appendChild(bubble);
    chatHistory.appendChild(row);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    return bubble;
  }

  async function fetchWithTimeout(url, opts = {}, timeoutMs = 2500) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  async function probeApiBase(apiBase) {
    try {
      const r = await fetchWithTimeout(`${apiBase}/openapi.json`, { method: 'GET' }, 1800);
      return !!(r && r.ok);
    } catch {
      return false;
    }
  }

  function extractDeltaText(eventName, dataStr) {
    const ev = (eventName || 'message').toLowerCase();
    if (ev === 'done' || ev === 'end') return { kind: 'done', text: '' };
    if (ev === 'error') return { kind: 'error', text: dataStr || '' };

    if (typeof dataStr === 'string') {
      const s = dataStr.trim();

      // Handle: {"session_id":"..."}TEXT
      if (s.startsWith('{') && s.includes('"session_id"')) {
        const close = s.indexOf('}');
        if (close > 0 && close < s.length - 1) {
          const rest = s.slice(close + 1).trim();
          if (rest) return { kind: 'delta', text: rest };
          return { kind: 'meta', text: '' };
        }
      }

      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === 'object') {
          const t =
            (typeof obj.text === 'string' && obj.text) ||
            (typeof obj.delta === 'string' && obj.delta) ||
            (typeof obj.token === 'string' && obj.token) ||
            (typeof obj.content === 'string' && obj.content) ||
            (typeof obj.answer === 'string' && obj.answer) ||
            '';
          if (t) return { kind: 'delta', text: t };
          if (obj.session_id && !t) return { kind: 'meta', text: '' };
        }
      } catch {
        if (s) return { kind: 'delta', text: dataStr };
      }
    }
    return { kind: 'meta', text: '' };
  }

  async function streamSSE(url, body, onDelta, onDone) {
    const ac = new AbortController();
    const timeoutMs = 60_000;
    const t = setTimeout(() => ac.abort(), timeoutMs);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'x-user-id': 'sidepanel',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!res.ok || !res.body) {
      clearTimeout(t);
      throw new Error(`SSE HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let buf = '';
    let gotAny = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        while (true) {
          let sep = '\n\n';
          let idx = buf.indexOf(sep);
          if (idx < 0) {
            sep = '\r\n\r\n';
            idx = buf.indexOf(sep);
          }
          if (idx < 0) break;

          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + sep.length);

          let event = 'message';
          let dataStr = '';

          for (const line of raw.split(/\r?\n/)) {
            if (!line) continue;
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
          }

          if (!dataStr) continue;

          const out = extractDeltaText(event, dataStr);
          if (out.kind === 'delta' && out.text) {
            gotAny = true;
            onDelta?.(out.text);
          } else if (out.kind === 'done') {
            onDone?.();
          }
        }

        // lenient fallback for non-sse chunk
        if (buf.length > 4096 && !buf.includes('data:') && !buf.includes('event:')) {
          const s = buf.trim();
          buf = '';
          const out = extractDeltaText('delta', s);
          if (out.kind === 'delta' && out.text) {
            gotAny = true;
            onDelta?.(out.text);
          }
        }
      }
    } finally {
      clearTimeout(t);
    }

    if (!gotAny) throw new Error('SSE connected but no data');
  }

  async function callChatOnce(apiBase, body, assistBubble) {
    const sseUrl = `${apiBase}/v1/sse-retrieve/`;
    const restUrl = `${apiBase}/v1/rest-retrieve/`;

    let acc = '';
    const setAcc = (txt) => {
      acc = txt;
      if (!assistBubble) return;
      assistBubble.textContent = txt;
      if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
    };

    try {
      await streamSSE(
        sseUrl,
        body,
        (tok) => {
          if (assistBubble && assistBubble.textContent === '…') assistBubble.textContent = '';
          acc += tok;
          if (assistBubble) assistBubble.textContent += tok;
          if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
        },
        () => {}
      );
      return acc;
    } catch (e) {
      // fallback REST
      const r = await fetch(restUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'sidepanel' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`REST HTTP ${r.status}`);
      const j = await r.json();
      const text = j?.text || j?.answer || j?.output || JSON.stringify(j, null, 2);
      setAcc(text);
      return acc;
    }
  }

  async function sendChat(question) {
    if (!question || !question.trim()) return;

    // AUTH gate
    const ok = await isAuthed();
    if (!ok) {
      openAuthOverlayFromPanel();
      appendBubble('assistant', '🔒 Bạn cần đăng nhập để dùng Chat.', nowTime());
      return;
    }

    const rawUserQ = question.trim();
    const sid = getSessionId();

    appendBubble('user', rawUserQ, nowTime());
    const assistBubble = appendBubble('assistant', '…');

    const apiBase = getApiBase();
    const useRag = !!chatToggles.useRag;

    const okBase = await probeApiBase(apiBase);
    if (!okBase) {
      if (assistBubble) assistBubble.textContent =
        `⚠️ Không kết nối được API ở ${apiBase}. Mở Setting để nhập đúng base (vd: http://127.0.0.1:8000).`;
      return;
    }

    const metaLine = `${nowTime()}${useRag ? ' • RAG: ON' : ' • RAG: OFF'}`;

    // attempt 0
    const q0 = buildQuestionToServer(rawUserQ, useRag, 0);
    const body0 = { question: q0, session_id: sid, user_id: 'sidepanel', use_rag: useRag };

    dlog('apiBase', apiBase);
    dlog('Q0 sent:', q0);

    let out0 = '';
    try {
      out0 = await callChatOnce(apiBase, body0, assistBubble);

      // ✅ nếu backend trả boilerplate -> retry 1 lần với prompt cứng hơn
      if (useRag && looksLikeBoilerplateAnswer(out0)) {
        if (assistBubble) assistBubble.textContent = '… (retry)';
        const q1 = buildQuestionToServer(rawUserQ, useRag, 1);
        const body1 = { question: q1, session_id: sid, user_id: 'sidepanel', use_rag: useRag };
        dlog('Q1 retry:', q1);
        out0 = await callChatOnce(apiBase, body1, assistBubble);
      }

      // attach meta
      if (assistBubble) {
        const extra = isDebug() ? `\n\n[sent]\n${(useRag ? (looksLikeBoilerplateAnswer(out0) ? 'retry' : 'ok') : 'no-rag')}` : '';
        assistBubble.innerHTML =
          escapeHtml(assistBubble.textContent + extra) +
          `<span class="meta">${escapeHtml(metaLine)}</span>`;
      }
    } catch (err) {
      if (assistBubble) assistBubble.textContent = `⚠️ ${String(err)}`;
    }
  }

  // ===== Chat events =====
  if (chatTextArea) {
    chatTextArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const value = chatTextArea.value;
        chatTextArea.value = '';
        sendChat(value);
        if (chatView) chatView.classList.add('focus-mode');
      }
    });
  }

  if (sendBtn && chatTextArea) {
    sendBtn.addEventListener('click', () => {
      const value = chatTextArea.value;
      if (!value.trim()) return;
      chatTextArea.value = '';
      sendChat(value);
      if (chatView) chatView.classList.add('focus-mode');
    });
  }

  // ===== Init =====
  bindModeButtons();
  applyModesToUI();
  sendTranscriptModes();

  applyChatTogglesUI();
});
