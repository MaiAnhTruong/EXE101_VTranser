// panel.js — UI Chat + STT giữ nguyên; SSE trực tiếp (nếu không mixed-content) + REST fallback qua Service Worker
(() => {
  const ROOT_ID = 'stt-sidepanel-root';
  if (window.__stt_panel_injected__) return;
  window.__stt_panel_injected__ = true;

  // ===== Constants
  const LS_KEY_SERVER    = 'sttServerWs';
  const DEFAULT_WS       = 'ws://localhost:8765';
  const iconURL          = (name) => chrome.runtime.getURL(`icons/${name}`);

  // Chat constants
  const LS_CHAT_API      = 'sttChatApiBase';
  const DEFAULT_API      = 'http://127.0.0.1:8000';
  const LS_CHAT_SESSION  = 'sttChatSessionId';

  // ===== Utils
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const uid = () => Math.random().toString(36).slice(2, 10);

  function mount() {
    if (document.getElementById(ROOT_ID)) return;
    document.documentElement.classList.add('stt-panel-open');
    if (!localStorage.getItem(LS_CHAT_API)) localStorage.setItem(LS_CHAT_API, DEFAULT_API);

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div id="panel">
        <div class="view-container">
          <div class="content-flipper">

            <!-- CHAT VIEW -->
            <div id="chat-content" class="content-view">
              <div class="main-header">
                <h1>Xin chào,</h1>
                <p>Tôi có thể hỗ trợ gì cho bạn?</p>
              </div>

              <div class="action-buttons">
                <button class="action-btn">
                  <img src="${iconURL('maximize.svg')}" class="action-btn-icon" />
                  Toàn màn hình
                </button>
                <button class="action-btn" id="rag-toggle-btn">
                  <img src="${iconURL('database.svg')}" class="action-btn-icon" />
                  Truy xuất thông tin
                </button>
                <button class="action-btn">
                  <img src="${iconURL('star.svg')}" class="action-btn-icon" />
                  Kho lưu trữ
                </button>
                <button class="action-btn">
                  <img src="${iconURL('file-text.svg')}" class="action-btn-icon" />
                  Vẽ hình tài liệu
                </button>
              </div>

              <div class="chat-history-area"></div>

              <div class="chat-input-area">
                <div class="input-header">
                  <button class="chip-button" id="chip-rag">
                    <img src="${iconURL('database.svg')}" class="input-btn-icon" />
                    Truy xuất thông tin
                  </button>
                  <button class="chip-button" id="chip-r1">
                    <img src="${iconURL('brain.svg')}" class="input-btn-icon" />
                    Suy luận (R1)
                  </button>
                </div>
                <div class="textarea-wrapper">
                  <textarea placeholder="Nhập câu hỏi, Enter để gửi • Shift+Enter xuống dòng"></textarea>
                  <button id="icon-btn-paperclip" class="icon-btn-simple" title="paperclip"></button>
                  <button id="icon-btn-more" class="icon-btn-simple" title="more"></button>
                  <button id="icon-btn-send" class="icon-btn-simple" title="send"></button>
                </div>
                <div class="input-footer">
                  <button class="login-btn" id="stt-chat-api-edit" title="Sửa API base">Đăng nhập</button>
                  <div class="icon-group">
                    <button class="icon-btn-simple" title="gift"  style="background-image:url('${iconURL('gift.svg')}')"></button>
                    <button class="icon-btn-simple" title="heart" style="background-image:url('${iconURL('heart.svg')}')"></button>
                    <button class="icon-btn-simple" title="help"  style="background-image:url('${iconURL('help.svg')}')"></button>
                    <button class="icon-btn-simple" title="mail"  style="background-image:url('${iconURL('mail.svg')}')"></button>
                  </div>
                </div>
              </div>
            </div>

            <!-- TRANSCRIPT VIEW -->
            <div id="transcript-content" class="content-view hidden">
              <div class="transcript-box">
                <div class="transcript-header">
                  <h3>Transcript</h3>
                  <p id="stt-page-url"></p>
                </div>
                <div id="stt-transcript-body" class="transcript-body">
                  <div class="placeholder-text">Chưa có nội dung…</div>
                </div>
                <div class="transcript-live-footer">
                  <span id="stt-live-status">Live</span>
                </div>
              </div>

              <div id="stt-live-clock" class="live-timestamp">${escapeHtml(nowTime())}</div>

              <div class="transcript-controls-row">
                <button class="transcript-btn1 start"></button>
              </div>

              <div class="transcript-actions-row">
                <button class="transcript-btn"><img src="icons/phude.svg" alt="" class="action-btn-icon" />Phụ đề</button>
                <button class="transcript-btn"><img src="icons/dichphude.svg" alt="" class="action-btn-icon"/>Dịch phụ đề</button>
                <button class="transcript-btn"><img src="icons/giongnoi.svg" alt="" class="action-btn-icon" />Giọng nói</button>
              </div>
              <div class="input-footer transcript">
                  <button class="login-btn">Đăng nhập</button>
                  <div class="icon-group">
                    <button id="icon-btn-gift" class="icon-btn-simple" title="gift"></button>
                    <button id="icon-btn-heart" class="icon-btn-simple" title="heart"></button>
                    <button id="icon-btn-help" class="icon-btn-simple" title="help"></button>
                    <button id="icon-btn-mail" class="icon-btn-simple" title="mail"></button>
                  </div>
              </div>
            </div>

          </div>
        </div>

        <div class="toolbar">
          <button id="btn-transcript" class="icon-btn" title="Transcript"></button>
          <button id="btn-chat" class="icon-btn active" title="Chat"></button>
          <button id="btn-setting" class="icon-btn" title="Setting"></button>
          <button id="btn-account" class="icon-btn" title="Account"></button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    // toolbar icons
    root.querySelector('#btn-chat').style.backgroundImage       = `url('${iconURL('message.svg')}')`;
    root.querySelector('#btn-transcript').style.backgroundImage = `url('${iconURL('transcript.svg')}')`;
    root.querySelector('#btn-setting').style.backgroundImage    = `url('${iconURL('setting.svg')}')`;
    root.querySelector('#btn-account').style.backgroundImage    = `url('${iconURL('account.svg')}')`;

    // helpers
    const $  = (sel, base = root) => base.querySelector(sel);
    const $$ = (sel, base = root) => Array.from(base.querySelectorAll(sel));

    // switch views
    const chatBtn  = $('#btn-chat');
    const tranBtn  = $('#btn-transcript');
    const tbBtns   = $$('.toolbar .icon-btn');
    const chatView = $('#chat-content');
    const tranView = $('#transcript-content');
    const views    = [chatView, tranView];

    const chatHeader  = root.querySelector('.main-header');
    const chatActions = root.querySelector('.action-buttons');
    const chatInputWrap   = root.querySelector('.textarea-wrapper');

    function showView(viewId, clicked) {
      views.forEach(v => v && v.classList.add('hidden'));
      tbBtns.forEach(b => b.classList.remove('active'));
      const v = $('#' + viewId);
      if (v) v.classList.remove('hidden');
      if (clicked) clicked.classList.add('active');
      if (viewId === 'chat-content') {
        chatHeader?.classList.remove('hidden');
        chatActions?.classList.remove('hidden');
        chatInputWrap?.classList.remove('hidden');
      } else {
        chatHeader?.classList.add('hidden');
        chatActions?.classList.add('hidden');
        chatInputWrap?.classList.add('hidden');
      }
    }
    chatBtn.addEventListener('click', () => showView('chat-content', chatBtn));
    tranBtn.addEventListener('click', () => showView('transcript-content', tranBtn));
    showView('chat-content', chatBtn);

    // ===== Transcript logic (giữ như cũ)
    const $body       = $('#stt-transcript-body');
    const $liveClock  = $('#stt-live-clock');
    const $liveStatus = $('#stt-live-status');
    const $pageUrl    = $('#stt-page-url');
    if ($pageUrl) $pageUrl.textContent = `Website: ${location.href}`;

    const clockTimer = setInterval(() => { if ($liveClock) $liveClock.textContent = nowTime(); }, 1000);

    function splitSentencesAndTail(text) {
      const sents = [];
      const re = /[^.!?…]*[.!?…]+(?:["”’']+)?(?:\s+|$)/g;
      let lastEnd = 0, m;
      while ((m = re.exec(text)) !== null) { sents.push(m[0]); lastEnd = re.lastIndex; }
      return { sents, tail: text.slice(lastEnd) };
    }
    function addTranscriptRow(timeStr, text, meta = 'Speaker • en • live') {
      if (!$body) return;
      if ($body.querySelector('.placeholder-text')) $body.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'transcript-entry';
      row.innerHTML = `
        <span class="timestamp">${escapeHtml(timeStr)}</span>
        <div class="text-block">
          <p>${escapeHtml(text)}</p>
          <span class="speaker-info">${escapeHtml(meta)}</span>
        </div>`;
      $body.appendChild(row);
      $body.scrollTop = $body.scrollHeight;
    }

    let loggedSentCount = 0;
    const getServer = () => (localStorage.getItem(LS_KEY_SERVER) || DEFAULT_WS).trim();

    $('#stt-btn-start')?.addEventListener('click', () => {
      const server = getServer();
      chrome.runtime.sendMessage({ __cmd: '__PANEL_START__', payload: { server } });
      if ($liveStatus) $liveStatus.textContent = 'Live • Đang ghi';
    });
    $('#stt-btn-stop')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ __cmd: '__PANEL_STOP__' });
      if ($liveStatus) $liveStatus.textContent = 'Live';
    });

    chrome.runtime.onMessage.addListener((m) => {
      if (!m || !m.__cmd) return;
      if (m.__cmd === '__PANEL_OPENED__') {
        const server = (m.payload?.server || '').trim();
        if (server) { try { localStorage.setItem(LS_KEY_SERVER, server); } catch {} }
        if ($liveStatus) $liveStatus.textContent = m.payload?.active ? 'Live • Đang ghi' : 'Live';
        return;
      }
      if (m.__cmd === '__TRANSCRIPT_STABLE__') {
        const full = String(m.payload?.full ?? m.full ?? '');
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
          if ($liveStatus) $liveStatus.textContent = 'Live • Đang ghi';
        }
        return;
      }
    });

    try {
      chrome.runtime.sendMessage({ __cmd: '__OVERLAY_PING__' }, (res) => {
        if ($liveStatus) $liveStatus.textContent = (res && res.active) ? 'Live • Đang ghi' : 'Live';
      });
    } catch {}

    // ====== CHATBOT ======
    const chatHistory = root.querySelector('.chat-history-area');
    const chatInputEl = root.querySelector('.textarea-wrapper textarea');
    const apiEditBtn  = root.querySelector('#stt-chat-api-edit');
    const chipRag     = root.querySelector('#chip-rag');
    const ragToggleBtn = root.querySelector('#rag-toggle-btn');

    // toggle RAG
    function toggleRag(btn) {
      btn?.classList.toggle('active');
      chipRag?.classList.toggle('active', btn?.classList.contains('active'));
    }
    chipRag?.addEventListener('click', () => toggleRag(chipRag));
    ragToggleBtn?.addEventListener('click', () => toggleRag(chipRag));

    function getApiBase() { return (localStorage.getItem(LS_CHAT_API) || DEFAULT_API).replace(/\/+$/, ''); }
    function getSessionId() {
      let sid = localStorage.getItem(LS_CHAT_SESSION);
      if (!sid) { sid = 'sess_' + uid(); localStorage.setItem(LS_CHAT_SESSION, sid); }
      return sid;
    }
    function appendBubble(who, text, meta = '') {
      const row = document.createElement('div');
      row.className = `chat-row ${who}`;
      const bubble = document.createElement('div');
      bubble.style.padding = '8px 10px';
      bubble.style.borderRadius = '8px';
      bubble.style.margin = '6px 0';
      bubble.style.whiteSpace = 'pre-wrap';
      bubble.style.background = who === 'user' ? '#EEF2FF' : '#F3F4F6';
      bubble.innerHTML = escapeHtml(text) + (meta ? `<div style="font-size:12px;color:#6B7280;margin-top:3px">${escapeHtml(meta)}</div>` : '');
      row.appendChild(bubble);
      chatHistory.appendChild(row);
      chatHistory.scrollTop = chatHistory.scrollHeight;
      return bubble;
    }

    async function streamSSEDirect(url, body, onDelta, onDone) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          'x-user-id': 'chrome_ext'
        },
        body: JSON.stringify(body)
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
          const lines = raw.split(/\r?\n/);
          for (const line of lines) {
            if (!line) continue;
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { data = { raw: dataStr }; }
          if (event === 'delta' && data && typeof data.text === 'string') onDelta?.(data.text);
          else if (event === 'done') onDone?.();
        }
      }
    }

    async function sendChat(question) {
      if (!question.trim()) return;
      const sid = getSessionId();
      appendBubble('user', question, nowTime());
      const bub = appendBubble('assistant', '…');

      const apiBase = getApiBase();
      const useRag  = chipRag?.classList.contains('active');
      const sseUrl  = `${apiBase}/v1/sse-retrieve/`;
      const restUrl = `${apiBase}/v1/rest-retrieve/`;
      const body    = { question, session_id: sid, user_id: 'chrome_ext', use_rag: !!useRag };

      const pageIsHttps = location.protocol === 'https:';
      const sseAllowed  = !pageIsHttps; // tránh mixed-content
      let gotAny = false;

      try {
        if (sseAllowed) {
          await streamSSEDirect(
            sseUrl,
            body,
            (tok) => {
              gotAny = true;
              if (bub.textContent === '…') bub.textContent = '';
              bub.textContent += tok;
              chatHistory.scrollTop = chatHistory.scrollHeight;
            },
            () => {}
          );
          if (!gotAny) throw new Error('SSE connected but empty');
        } else {
          throw new Error('SSE blocked on https page');
        }
      } catch (e) {
        try {
          // REST proxy qua SW để tránh mixed-content
          const resp = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ __cmd: '__CHAT_REST__', payload: { apiBase, body } }, (res) => resolve(res));
          });
          if (resp && resp.ok && resp.text) {
            bub.textContent = resp.text;
          } else {
            if (!pageIsHttps) {
              const r = await fetch(restUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-user-id': 'chrome_ext' },
                body: JSON.stringify(body)
              });
              const j = await r.json();
              const text = j?.text || j?.answer || j?.output || JSON.stringify(j);
              bub.textContent = text;
            } else {
              bub.textContent = `⚠️ ${resp?.error || String(e)}`;
            }
          }
        } catch (ee) {
          bub.textContent = `⚠️ ${String(ee)}`;
        }
      }
    }

    chatInputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const q = chatInputEl.value;
        chatInputEl.value = '';
        sendChat(q);
        chatView.classList.add('focus-mode');
      }
    });

    $('#stt-chat-api-edit')?.addEventListener('click', () => {
      const cur = localStorage.getItem(LS_CHAT_API) || DEFAULT_API;
      const next = prompt('Nhập API base (vd: http://127.0.0.1:8000)', cur);
      if (next && next.trim()) localStorage.setItem(LS_CHAT_API, next.trim());
    });

    root.__cleanup__ = () => { try { clearInterval(clockTimer); } catch {} };
  }

  function teardown() {
    const root = document.getElementById(ROOT_ID);
    if (root && root.__cleanup__) { try { root.__cleanup__(); } catch {} }
    if (root) root.remove();
    document.documentElement.classList.remove('stt-panel-open');
    window.__stt_panel_injected__ = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.__cmd) return;
    if (msg.__cmd === '__PANEL_MOUNT__') mount();
    if (msg.__cmd === '__PANEL_TEARDOWN__') teardown();
  });

  mount();
})();
