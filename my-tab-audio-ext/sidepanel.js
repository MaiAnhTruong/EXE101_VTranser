// sidepanel.js
document.addEventListener('DOMContentLoaded', () => {
  // ===== Constants =====
  const LS_KEY_SERVER = 'sttServerWs';
  const DEFAULT_WS = 'ws://localhost:8765';

  const LS_CHAT_API = 'sttChatApiBase';
  const DEFAULT_API = 'http://127.0.0.1:8000';
  const LS_CHAT_SESSION = 'sttChatSessionId';

  // Persist mode
  const LS_MODE_EN = 'sttModeEn';
  const LS_MODE_VI = 'sttModeVi';
  const LS_MODE_VOICE = 'sttModeVoice';

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

  const subtitleBtn = document.getElementById('btn-subtitle');           // EN
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

  // ✅ Nếu SW set vtNeedAuth trước đó (ví dụ user bấm Start ở in-page panel),
  // sidepanel mở lên sẽ tự bật login.
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
  // ✅ MODES STATE (Quan trọng: đảm bảo vi=false nếu không chọn dịch)
  // ============================================================
  const modes = {
    en: readBoolLS(LS_MODE_EN, true),     // default ON
    vi: readBoolLS(LS_MODE_VI, false),    // default OFF
    voice: readBoolLS(LS_MODE_VOICE, false)
  };

  function setBtnActive(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', !!on);
  }

  function applyModesToUI() {
    // Rule: nếu bật vi thì phải bật en
    if (modes.vi) modes.en = true;

    // Rule: không cho tắt sạch en+vi
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
    applyModesToUI(); // đảm bảo rule trước khi gửi
    const payload = { en: !!modes.en, vi: !!modes.vi, voice: !!modes.voice };

    try {
      chrome.runtime.sendMessage({ __cmd: '__TRANSCRIPT_MODES__', payload });
    } catch {}
  }

  function bindModeButtons() {
    if (subtitleBtn) {
      subtitleBtn.addEventListener('click', () => {
        modes.en = !modes.en;

        // Nếu tắt EN mà VI đang bật -> tắt VI luôn (vì VI phụ thuộc EN)
        if (!modes.en && modes.vi) modes.vi = false;

        sendTranscriptModes();
      });
    }

    if (subtitleTransBtn) {
      subtitleTransBtn.addEventListener('click', () => {
        modes.vi = !modes.vi;
        // bật VI -> tự bật EN
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

  // default transcript
  if (transcriptButton) showView('transcript-content', transcriptButton);
  else showView('chat-content', chatButton);

  // ===== Transcript: clock =====
  if (liveTimestampEl) {
    liveTimestampEl.textContent = nowTime();
    setInterval(() => (liveTimestampEl.textContent = nowTime()), 1000);
  }

  let loggedSentCount = 0;

  // split sentences
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

      // Nếu đang tắt -> chuẩn bị bật start => check auth trước
      if (!currentlyActive) {
        const ok = await isAuthed();
        if (!ok) {
          // bắt buộc login
          openAuthOverlayFromPanel();
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';
          return;
        }
      }

      // toggle UI sau khi pass auth
      const isActive = transcriptStart.classList.toggle('active');

      if (hasChromeRuntime) {
        if (isActive) {
          chrome.runtime.sendMessage(
            { __cmd: '__PANEL_START__', payload: { server: getServer() } },
            (res) => {
              if (!res?.ok) {
                transcriptStart.classList.remove('active');
                if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';

                // ✅ nếu SW trả AUTH_REQUIRED -> mở login luôn
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

          // ✅ gửi mode ngay lúc bắt đầu (payload vi sẽ đúng theo state)
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

      // ✅ SW broadcast: yêu cầu đăng nhập
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

  // ===== Chat =====
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

  async function streamSSE(url, body, onDelta, onDone) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'x-user-id': 'sidepanel',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        let event = 'message';
        let dataStr = '';
        for (const line of raw.split(/\r?\n/)) {
          if (!line) continue;
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
        }

        if (!dataStr) continue;
        let data;
        try { data = JSON.parse(dataStr); } catch { data = { raw: dataStr }; }

        if (event === 'delta' && typeof data?.text === 'string') onDelta?.(data.text);
        else if (event === 'done') onDone?.();
      }
    }
  }

  async function sendChat(question) {
    if (!question || !question.trim()) return;

    // ✅ AUTH gate (bắt buộc login mới được chat)
    const ok = await isAuthed();
    if (!ok) {
      openAuthOverlayFromPanel();
      appendBubble('assistant', '🔒 Bạn cần đăng nhập để dùng Chat.', nowTime());
      return;
    }

    const q = question.trim();
    const sid = getSessionId();

    appendBubble('user', q, nowTime());
    const assistBubble = appendBubble('assistant', '…');

    const apiBase = getApiBase();
    const sseUrl = `${apiBase}/v1/sse-retrieve/`;
    const restUrl = `${apiBase}/v1/rest-retrieve/`;

    const useRag = !!(chipRag && chipRag.classList.contains('active'));
    const body = { question: q, session_id: sid, user_id: 'sidepanel', use_rag: useRag };

    let gotAny = false;
    const setText = (txt) => {
      if (!assistBubble) return;
      assistBubble.textContent = txt;
      if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
    };

    try {
      await streamSSE(
        sseUrl,
        body,
        (tok) => {
          gotAny = true;
          if (assistBubble && assistBubble.textContent === '…') assistBubble.textContent = '';
          if (assistBubble) {
            assistBubble.textContent += tok;
            if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
          }
        },
        () => {}
      );
      if (!gotAny) throw new Error('SSE connected but no data');
    } catch {
      try {
        const r = await fetch(restUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user-id': 'sidepanel' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        const text = j?.text || j?.answer || j?.output || JSON.stringify(j, null, 2);
        setText(text);
      } catch (err2) {
        setText(`⚠️ ${String(err2)}`);
      }
    }
  }

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

  if (chipRag) chipRag.addEventListener('click', () => chipRag.classList.toggle('active'));
  if (chipR1) chipR1.addEventListener('click', () => chipR1.classList.toggle('active'));

  // ✅ bind + init modes
  bindModeButtons();
  applyModesToUI();

  // ✅ gửi mode ngay khi mở sidepanel để SW biết đúng vi=false nếu chưa bật dịch
  sendTranscriptModes();
});
