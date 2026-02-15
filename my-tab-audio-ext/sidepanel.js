// D:\vtranser\EXE101_VTranser\my-tab-audio-ext\sidepanel.js

document.addEventListener('DOMContentLoaded', () => {
  // ===== Constants =====
  const LS_KEY_SERVER = 'sttServerWs';
  const DEFAULT_WS = 'ws://localhost:8765';

  const LS_CHAT_API = 'sttChatApiBase';
  const DEFAULT_API = 'http://127.0.0.1:8000';
  const LS_CHAT_SESSION = 'sttChatSessionId';
  const LS_CHAT_RUNTIME_MARK = 'sttChatRuntimeMarkV1';
  const LS_CHAT_HISTORY = 'sttChatHistoryV1';
  const LS_CHAT_DB_CURSOR = 'sttChatDbCursorV1';
  const CHAT_HISTORY_MAX = 120;
  const SESSION_RUN_KEY = 'vtRuntimeRunIdV1';

  // Persist transcript modes
  const LS_MODE_EN = 'sttModeEn';
  const LS_MODE_VI = 'sttModeVi';
  const LS_MODE_VOICE = 'sttModeVoice';

  // Persist chat toggles
  const LS_CHAT_USE_RAG = 'sttChatUseRag';
  const LS_CHAT_USE_R1 = 'sttChatUseR1';

  // Optional debug
  const LS_CHAT_DEBUG = 'sttChatDebug'; // set "1" to log + show sent prompt in meta

  // play.gif can fail to loop on some environments;
  // refresh periodically to keep it animated while active.
  const PLAY_GIF_REFRESH_MS = 1800;
  const CHAT_SCROLLBAR_HIDE_MS = 900;

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

  function readChatHistoryMap() {
    try {
      const raw = localStorage.getItem(LS_CHAT_HISTORY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch {
      return {};
    }
  }

  function writeChatHistoryMap(map) {
    try {
      localStorage.setItem(LS_CHAT_HISTORY, JSON.stringify(map || {}));
    } catch {}
  }

  function readJsonObjectLS(key) {
    try {
      const raw = localStorage.getItem(String(key || ''));
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch {
      return {};
    }
  }

  function writeJsonObjectLS(key, obj) {
    try {
      localStorage.setItem(String(key || ''), JSON.stringify(obj || {}));
    } catch {}
  }

  function normalizeDbId(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    return /^\d+$/.test(s) ? s : null;
  }

  function getChatHistoryItems(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return [];
    const map = readChatHistoryMap();
    const arr = Array.isArray(map[sid]) ? map[sid] : [];
    return arr
      .map((x) => ({
        who: x?.who === 'assistant' ? 'assistant' : 'user',
        text: String(x?.text || ''),
        meta: String(x?.meta || ''),
      }))
      .filter((x) => x.text.trim().length > 0);
  }

  function saveChatHistoryItems(sessionId, items) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const map = readChatHistoryMap();
    map[sid] = (Array.isArray(items) ? items : [])
      .slice(-CHAT_HISTORY_MAX)
      .map((x) => ({
        who: x?.who === 'assistant' ? 'assistant' : 'user',
        text: String(x?.text || ''),
        meta: String(x?.meta || ''),
      }));
    writeChatHistoryMap(map);
  }

  function pushChatHistoryItem(who, text, meta = '') {
    const msgText = String(text || '').trim();
    if (!msgText) return;
    const sid = getSessionId();
    const arr = getChatHistoryItems(sid);
    arr.push({
      who: who === 'assistant' ? 'assistant' : 'user',
      text: msgText,
      meta: String(meta || ''),
    });
    saveChatHistoryItems(sid, arr);
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

  function storeSessionGet(keys) {
    return new Promise((resolve) => {
      try {
        if (chrome?.storage?.session?.get) {
          chrome.storage.session.get(keys, (v) => resolve(v || {}));
          return;
        }
      } catch {}
      resolve({});
    });
  }

  function storeSessionSet(obj) {
    return new Promise((resolve) => {
      try {
        if (chrome?.storage?.session?.set) {
          chrome.storage.session.set(obj || {}, () => resolve());
          return;
        }
      } catch {}
      resolve();
    });
  }

  async function getOrCreateRuntimeRunId() {
    try {
      const st = await storeSessionGet([SESSION_RUN_KEY]);
      let rid = String(st?.[SESSION_RUN_KEY] || '').trim();
      if (!rid) {
        rid = `run_${Date.now().toString(36)}_${uid()}`;
        await storeSessionSet({ [SESSION_RUN_KEY]: rid });
      }
      return rid;
    } catch {
      return '';
    }
  }

  async function rotateChatSessionIfRuntimeChanged() {
    const runtimeRunId = await getOrCreateRuntimeRunId();
    if (!runtimeRunId) return false;

    const prevRunId = String(localStorage.getItem(LS_CHAT_RUNTIME_MARK) || '').trim();
    if (prevRunId && prevRunId === runtimeRunId) return false;

    const nextSid = 'sess_' + uid();
    try {
      localStorage.setItem(LS_CHAT_SESSION, nextSid);
      localStorage.setItem(LS_CHAT_RUNTIME_MARK, runtimeRunId);
    } catch {}
    return true;
  }

  function formatUserIdDebug(debug) {
    if (!debug || typeof debug !== 'object') return '';
    const parts = [];
    const email = String(debug.email || '').trim();
    const provider = String(debug.provider || '').trim();
    const id = String(debug.id || '').trim();
    const userId = String(debug.user_id || '').trim();
    const dbUserId = String(debug.db_user_id || '').trim();
    if (email) parts.push(`email=${email}`);
    if (provider) parts.push(`provider=${provider}`);
    if (id) parts.push(`id=${id}`);
    if (userId) parts.push(`user_id=${userId}`);
    if (dbUserId) parts.push(`db_user_id=${dbUserId}`);
    return parts.join(' | ');
  }

  function authIdentityKeyFromProfile(profile) {
    const email = String(profile?.email || '').trim().toLowerCase();
    if (email) return `email:${email}`;
    const pid = String(profile?.id || '').trim();
    if (pid) return `id:${pid}`;
    const name = String(profile?.name || profile?.full_name || '').trim().toLowerCase();
    if (name) return `name:${name}`;
    return '';
  }

  function chatDbCursorKey(identityKey, localSessionId) {
    const a = String(identityKey || '').trim();
    const b = String(localSessionId || '').trim();
    if (!a || !b) return '';
    return `${a}::${b}`;
  }

  function getChatDbCursorState(identityKey, localSessionId) {
    const key = chatDbCursorKey(identityKey, localSessionId);
    if (!key) return { chatSessionId: null, parentMsgId: null };
    const map = readJsonObjectLS(LS_CHAT_DB_CURSOR);
    const row = map[key];
    return {
      chatSessionId: normalizeDbId(row?.chatSessionId),
      parentMsgId: normalizeDbId(row?.parentMsgId),
    };
  }

  function setChatDbCursorState(identityKey, localSessionId, state) {
    const key = chatDbCursorKey(identityKey, localSessionId);
    if (!key) return;
    const map = readJsonObjectLS(LS_CHAT_DB_CURSOR);
    map[key] = {
      chatSessionId: normalizeDbId(state?.chatSessionId),
      parentMsgId: normalizeDbId(state?.parentMsgId),
      updatedAt: new Date().toISOString(),
    };
    writeJsonObjectLS(LS_CHAT_DB_CURSOR, map);
  }

  async function persistChatMessageToDb(opts = {}) {
    const identityKey = String(opts.identityKey || '').trim();
    const localSessionId = String(opts.localSessionId || '').trim();
    const roleRaw = String(opts.role || '').trim().toLowerCase();
    const role = roleRaw === 'assistant' || roleRaw === 'system' ? roleRaw : 'user';
    const content = String(opts.content || '').trim();

    if (!identityKey || !localSessionId || !content) return null;

    const cursor = getChatDbCursorState(identityKey, localSessionId);
    const payload = {
      chatSessionId: cursor.chatSessionId,
      parentMsgId: cursor.parentMsgId,
      role,
      content,
      titleHint: String(opts.titleHint || content).trim(),
      source: String(opts.source || 'sidepanel'),
      model: String(opts.model || ''),
      language: String(opts.language || ''),
      createdAt: String(opts.createdAt || new Date().toISOString()),
      startedAt: String(opts.startedAt || new Date().toISOString()),
    };

    if (Number.isFinite(Number(opts.tokensIn))) payload.tokensIn = Number(opts.tokensIn);
    if (Number.isFinite(Number(opts.tokensOut))) payload.tokensOut = Number(opts.tokensOut);
    if (Number.isFinite(Number(opts.latencyMs))) payload.latencyMs = Number(opts.latencyMs);

    const res = await sendRuntime({ __cmd: '__CHAT_DB_SAVE__', payload });
    if (!res?.ok) {
      dlog('chat db save failed:', res?.error || res);
      return res || null;
    }

    setChatDbCursorState(identityKey, localSessionId, {
      chatSessionId: res.chatSessionId,
      parentMsgId: res.messageId,
    });
    return res;
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
  function sendRuntime(msg) {
    return new Promise((resolve) => {
      if (!hasChromeRuntime) return resolve(null);
      try { chrome.runtime.sendMessage(msg, (res) => resolve(res || null)); } catch { resolve(null); }
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
    return !!(p && (p.email || p.id || p.name || p.full_name));
  }

  // ===== DOM Refs =====
  const panelEl = document.getElementById('panel');
  const chatButton = document.getElementById('btn-chat');
  const transcriptButton = document.getElementById('btn-transcript');
  const historyButton = document.getElementById('btn-history'); // ✅ NEW
  const moreButton = document.getElementById('btn-more');
  const collapseButton = document.getElementById('btn-collapse');
  const fullscreenButton = document.getElementById('btn-fullscreen');
  const settingButton = document.getElementById('btn-setting');
  const navButtons = document.querySelectorAll('.toolbar .nav-btn');

  const chatView = document.getElementById('chat-content');
  const transcriptView = document.getElementById('transcript-content');
  const historyView = document.getElementById('history-content'); // ✅ NEW
  const allViews = [chatView, transcriptView, historyView];
  const historyController = window.__vtHistoryView || null;

  // busy modal
  const busyModal = document.getElementById('vtBusyModal');
  const busyClose = document.getElementById('vtBusyClose');
  const busyText = document.querySelector('#vtBusyModal .vt-busy-text');

  // error modal
  const errorModal = document.getElementById('vtErrorModal');
  const errorClose = document.getElementById('vtErrorClose');
  const errorText = document.querySelector('#vtErrorModal .vt-modal-text');

  // bottom bar
  const bottomGreetingEl = document.getElementById('bottomGreeting');
  const loginBtns = document.querySelectorAll('.login-btn');

  // chat view elements
  const chatTextArea = document.querySelector('#chat-content .textarea-wrapper textarea');
  const chatHistory = document.querySelector('.chat-history-area');
  let chatScrollbarHideTimer = null;

  const chipRag = document.getElementById('chatChipRag');
  const chipR1 = document.getElementById('chatChipR1');

  const sendBtn = document.getElementById('icon-btn-send');
  const chatRagSelectionBar = document.getElementById('chatRagSelectionBar');
  const chatActionRetrieveBtn = document.getElementById('chatActionRetrieveBtn');
  const chatActionStoreBtn = document.getElementById('chatActionStoreBtn');
  const ragPickerTriggers = [...new Set([chatActionRetrieveBtn, chipRag].filter(Boolean))];

  const chatRagPicker = document.getElementById('chatRagPicker');
  const chatRagPickerClose = document.getElementById('chatRagPickerClose');
  const chatRagPinBtn = document.getElementById('chatRagPinBtn');
  const chatRagSearch = document.getElementById('chatRagSearch');
  const chatRagPickerLoading = document.getElementById('chatRagPickerLoading');
  const chatRagPickerEmpty = document.getElementById('chatRagPickerEmpty');
  const chatRagPickerList = document.getElementById('chatRagPickerList');

  const chatRagDetailModal = document.getElementById('chatRagDetailModal');
  const chatRagDetailClose = document.getElementById('chatRagDetailClose');
  const chatRagDetailTitle = document.getElementById('chatRagDetailTitle');
  const chatRagDetailMeta = document.getElementById('chatRagDetailMeta');
  const chatRagDetailContent = document.getElementById('chatRagDetailContent');
  let ragPickerOpenTimer = null;
  let ragPickerRestoreOnDetailClose = false;
  let ragPickerDetailReturnAnchor = null;

  // transcript view elements
  const transcriptStart = document.querySelector('.transcript-btn1.start');
  const transcriptBody = document.querySelector('.transcript-body');
  const transcriptLiveFooter = document.querySelector('.transcript-live-footer span');
  const transcriptHeaderUrlEl = document.querySelector('.transcript-header .transcript-url');

  const subtitleBtn = document.getElementById('btn-subtitle');            // EN
  const subtitleTransBtn = document.getElementById('btn-subtitle-trans'); // VI translate
  const voiceBtn = document.getElementById('btn-voice');

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

  // bottom-bar login buttons
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

  // ===== Greeting on bottom bar =====
  async function refreshGreeting() {
    try {
      const p = await getVtAuthProfile();
      const name = String(p?.full_name || p?.name || p?.email || '').trim();
      if (bottomGreetingEl) bottomGreetingEl.textContent = name ? `Xin chào, ${name}` : 'Hi';
      // hide login when authed
      if (loginBtns && loginBtns.length) {
        const authed = !!name;
        loginBtns.forEach((b) => b.classList.toggle('hidden', authed));
      }
    } catch {}
  }
  refreshGreeting();

  // auto refresh if vtAuth changes
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.vtAuth) {
        refreshGreeting();
        historyController?.onAuthChanged?.();
        resetRagPickerState();
      }
    });
  }

  historyController?.init?.({
    openAuthOverlay: openAuthOverlayFromPanel,
  });

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

  // ============================================================
  // ✅ VIEW SWITCHING (chỉ đổi màn giữa)
  // ============================================================
  function showView(viewId, clickedButton) {
    allViews.forEach(view => view && view.classList.add('hidden'));
    navButtons.forEach(btn => btn.classList.remove('active'));

    const viewToShow = document.getElementById(viewId);
    if (viewToShow) viewToShow.classList.remove('hidden');

    if (clickedButton) clickedButton.classList.add('active');

    // reset focus-mode when leaving chat
    if (viewId !== 'chat-content') {
      chatView && chatView.classList.remove('focus-mode');
      if (chatHistory) chatHistory.classList.remove('scrollbar-visible');
      if (chatScrollbarHideTimer) {
        clearTimeout(chatScrollbarHideTimer);
        chatScrollbarHideTimer = null;
      }
      closeRagPicker();
      closeChatRagDetailModal();
    } else {
      syncChatFocusMode();
    }

    // refresh transcript url when open transcript
    if (viewId === 'transcript-content') updateTranscriptHeaderUrl();
    if (viewId === 'history-content') historyController?.onViewShown?.();
  }

  if (chatButton) chatButton.addEventListener('click', () => showView('chat-content', chatButton));
  if (transcriptButton) transcriptButton.addEventListener('click', () => showView('transcript-content', transcriptButton));
  if (historyButton) historyButton.addEventListener('click', () => showView('history-content', historyButton));

  if (transcriptButton) showView('transcript-content', transcriptButton);
  else showView('chat-content', chatButton);

  // ===== Toolbar utilities: collapse / fullscreen / more =====
  function setCollapsed() {
    if (!panelEl) return;
    panelEl.classList.remove('is-fullscreen');
    panelEl.classList.add('is-collapsed');
  }

  function setFullscreen() {
    if (!panelEl) return;
    panelEl.classList.remove('is-collapsed');
    panelEl.classList.add('is-fullscreen');
  }

  if (collapseButton) collapseButton.addEventListener('click', setCollapsed);
  if (fullscreenButton) fullscreenButton.addEventListener('click', setFullscreen);
  if (moreButton) {
    moreButton.addEventListener('click', () => {
      console.log('[sidepanel] More feature clicked');
    });
  }

  // ===== Busy modal =====
  function showBusyModal(text = 'Hệ thống đang bận, vui lòng thử lại sau.') {
    if (busyText) busyText.textContent = text;
    if (busyModal) busyModal.classList.remove('hidden');
  }
  function hideBusyModal() {
    if (busyModal) busyModal.classList.add('hidden');
  }
  if (busyClose) busyClose.addEventListener('click', hideBusyModal);

  // ===== Error modal =====
  function showErrorModal(text = 'Đã xảy ra lỗi.') {
    if (errorText) errorText.textContent = text;
    if (errorModal) errorModal.classList.remove('hidden');
  }
  function hideErrorModal() {
    if (errorModal) errorModal.classList.add('hidden');
  }
  if (errorClose) errorClose.addEventListener('click', hideErrorModal);

  // ===== Transcript start/play states =====
  let startInFlight = false;
  let playGifLoopTimer = null;
  let playGifFlip = 0;

  function stopPlayGifLoop() {
    if (playGifLoopTimer) clearInterval(playGifLoopTimer);
    playGifLoopTimer = null;
    if (transcriptStart) transcriptStart.style.backgroundImage = '';
  }

  function refreshPlayGifOnce() {
    if (!transcriptStart) return;
    if (!transcriptStart.classList.contains('is-playing')) return;
    playGifFlip = (playGifFlip + 1) % 2;
    transcriptStart.style.backgroundImage = `url("icons/play.gif?v=${playGifFlip}")`;
  }

  function startPlayGifLoop() {
    stopPlayGifLoop();
    refreshPlayGifOnce();
    playGifLoopTimer = setInterval(refreshPlayGifOnce, PLAY_GIF_REFRESH_MS);
  }

  function setPlayVisual(on) {
    if (!transcriptStart) return;
    const play = !!on;
    transcriptStart.classList.toggle('is-playing', play);
    if (play) startPlayGifLoop();
    else stopPlayGifLoop();
  }

  function setStartActive(on) {
    if (!transcriptStart) return;
    transcriptStart.classList.toggle('active', !!on);
  }

  function setStartLoading(on) {
    if (!transcriptStart) return;
    transcriptStart.classList.toggle('is-loading', !!on);
  }

  // ===== Transcript sentence delay logging =====
  let loggedSentCount = 0;

  const SENT_RE = /[^.!?]*[.!?]+(?:["']+)?(?:\s+|$)/g;
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

  function addTranscriptRow(text, meta = 'Speaker • en • live') {
    if (!transcriptBody) return;
    const placeholder = transcriptBody.querySelector('.transcript-placeholder');
    if (placeholder) placeholder.remove();

    const row = document.createElement('div');
    row.className = 'transcript-entry';
    row.innerHTML = `
      <div class="text-block">
        <p>${escapeHtml(text)}</p>
        <span class="speaker-info">${escapeHtml(meta)}</span>
      </div>
    `;
    // Luôn hiển thị câu mới nhất ở trên cùng;
    // câu cũ vẫn giữ lại và cuộn xuống sẽ thấy.
    transcriptBody.prepend(row);
    transcriptBody.scrollTop = 0;
  }

  // ===== START/STOP capture =====
  if (transcriptStart) {
    transcriptStart.addEventListener('click', async () => {
      const currentlyActive = transcriptStart.classList.contains('active');
      // Chỉ chặn spam khi đang "bắt đầu"; vẫn cho phép click để dừng.
      if (startInFlight && !currentlyActive) return;
      const willStart = !currentlyActive;

      if (willStart) {
        const ok = await isAuthed();
        if (!ok) {
          openAuthOverlayFromPanel();
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';
          return;
        }
      }

      if (hasChromeRuntime) {
        if (willStart) {
          setStartActive(true);
          startInFlight = true;
          setStartLoading(true);
          // Chỉ chuyển sang play.gif khi OFFSCREEN báo running
          setPlayVisual(false);
          chrome.runtime.sendMessage(
            { __cmd: '__PANEL_START__', payload: { server: getServer() } },
            (res) => {
              if (!res?.ok) {
                setStartActive(false);
                startInFlight = false;
                setStartLoading(false);
                setPlayVisual(false);
                if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';

                if (res?.code === 'AUTH_REQUIRED') {
                  openAuthOverlayFromPanel();
                  return;
                }

                if (res?.error) {
                  const msgErr = String(res.error || '');
                  if (/bận|busy/i.test(msgErr)) {
                    showBusyModal(msgErr);
                  } else {
                    showErrorModal(msgErr);
                  }
                }
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
          // timer & play visual sẽ bật khi nhận state 'running' từ OFFSCREEN_STATUS
        } else {
          setStartActive(false);
          startInFlight = false;
          setStartLoading(false);
          setPlayVisual(false);
          chrome.runtime.sendMessage({ __cmd: '__PANEL_STOP__' });
        }
      }

      if (transcriptLiveFooter) {
        transcriptLiveFooter.textContent = willStart ? 'Live • Đang kết nối...' : 'Live';
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

        if (typeof msg.payload?.active === 'boolean') {
          const active = !!msg.payload.active;
          const starting = !!msg.payload.starting;

          if (transcriptLiveFooter) {
            transcriptLiveFooter.textContent = active
              ? 'Live • Đang ghi'
              : (starting ? 'Live • Đang kết nối...' : 'Live');
          }

          setStartActive(active || starting);
          setStartLoading(starting && !active);
          setPlayVisual(active);
          startInFlight = starting && !active;
        }

        if (msg.payload?.url && transcriptHeaderUrlEl) {
          transcriptHeaderUrlEl.textContent = `Website: ${msg.payload.url}`;
        } else {
          updateTranscriptHeaderUrl();
        }
        return;
      }

      if (msg.__cmd === '__PANEL_NOTIFY__') {
        const level = msg.payload?.level || '';
        const text = msg.payload?.text || '';
        if (level === 'error' && /bận|busy/i.test(text || '')) {
          showBusyModal(text || undefined);
        }
        if (level === 'error') {
          setPlayVisual(false);
          setStartActive(false);
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';
          startInFlight = false;
          setStartLoading(false);
        }
        return;
      }

      if (msg.__cmd === '__OFFSCREEN_STATUS__') {
        const s = msg.payload?.state || '';
        const runningUi = !!(transcriptStart && transcriptStart.classList.contains('is-playing'));

        if (
          s === 'starting' ||
          s === 'picker' ||
          s === 'ws-connecting' ||
          s === 'media-ok' ||
          s === 'audio-graph-ok' ||
          s === 'ws-open' ||
          s === 'ws-auth-sent'
        ) {
          if (!runningUi) {
            startInFlight = true;
            setStartActive(true);
            setStartLoading(true);
            setPlayVisual(false);
            if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live • Đang kết nối...';
          }
          return;
        }

        // server-status can arrive continuously while running;
        // never pull UI back to "connecting" from running state.
        if (s === 'server-hello' || s === 'server-status' || s === 'server-auth-ok') {
          if (!runningUi && startInFlight && transcriptLiveFooter) {
            transcriptLiveFooter.textContent = 'Live • Đang kết nối...';
          }
          return;
        }
        if (s === 'running') {
          setStartActive(true);
          setPlayVisual(true);
          startInFlight = false;
          setStartLoading(false);
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live • Đang ghi';
        }
        if (s === 'stopped' || s === 'server-busy' || s === 'server-error' || s === 'error') {
          if (s === 'server-busy') {
            showBusyModal(msg.payload?.text || 'Hệ thống đang bận, vui lòng thử lại sau.');
          }
          setPlayVisual(false);
          setStartActive(false);
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live';
          startInFlight = false;
          setStartLoading(false);
        }
        return;
      }

      if (msg.__cmd === '__TRANSCRIPT_STABLE__') {
        const full = String(msg.payload?.full ?? msg.full ?? '');
        if (!full) return;
        const { sents } = splitSentencesAndTail(full);

        // delay 1 sentence
        const target = Math.max(0, sents.length - 1);
        if (target > loggedSentCount) {
          for (let i = loggedSentCount; i < target; i++) {
            const s = sents[i].trim();
            if (s) addTranscriptRow(s, 'Speaker • en • live');
          }
          loggedSentCount = target;
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live • Đang ghi';
        }
        return;
      }
    });

      try {
        chrome.runtime.sendMessage({ __cmd: '__OVERLAY_PING__' }, (res) => {
          if (transcriptStart && typeof res?.active === 'boolean') {
            const active = !!res.active;
            const starting = !!res.starting;

            if (transcriptLiveFooter) {
              transcriptLiveFooter.textContent = active
                ? 'Live • Đang ghi'
                : (starting ? 'Live • Đang kết nối...' : 'Live');
            }

            setStartActive(active || starting);
            setStartLoading(starting && !active);
            setPlayVisual(active);
            startInFlight = starting && !active;
          }
        });
      } catch {}
    }

  // ============================================================
  // ✅ CHAT TOGGLES
  // ============================================================
  const chatToggles = {
    useRag: readBoolLS(LS_CHAT_USE_RAG, false),
    useR1: readBoolLS(LS_CHAT_USE_R1, false),
  };

  const RAG_CONTEXT_PER_ITEM_MAX = 2400;
  const RAG_CONTEXT_TOTAL_MAX = 9000;

  const ragPickerState = {
    loaded: false,
    loading: false,
    prefetching: false,
    items: [],
    filtered: [],
    selectedIds: new Set(),
    pinnedIds: new Set(),
    previewHydratedIds: new Set(),
    details: new Map(), // sessionId -> { ok, item, fullText }
    detailInflight: new Map(), // sessionId -> Promise
    anchorEl: null,
  };

  // RAG chat mode is now confirmed by pressing OK on selected history sources.
  chatToggles.useRag = false;

  function ragToDateOrNull(v) {
    const t = Date.parse(String(v || ''));
    return Number.isFinite(t) ? new Date(t) : null;
  }

  function ragFormatDateTime(v) {
    const d = ragToDateOrNull(v);
    if (!d) return 'N/A';
    return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function ragCalcDurationMs(item) {
    const startMs = Date.parse(String(item?.started_at || ''));
    if (!Number.isFinite(startMs)) return 0;
    const endRaw = item?.ended_at || item?.last_updated_at || new Date().toISOString();
    const endMs = Date.parse(String(endRaw || ''));
    if (!Number.isFinite(endMs)) return 0;
    return Math.max(0, endMs - startMs);
  }

  function ragFormatDurationMs(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function ragDomainFrom(item) {
    const domain = String(item?.tab_domain || '').trim();
    if (domain) return domain;
    try {
      const u = new URL(String(item?.tab_url || ''));
      return u.hostname || 'Unknown website';
    } catch {
      return 'Unknown website';
    }
  }

  function ragStatusLabel(raw) {
    const s = String(raw || '').toLowerCase();
    if (s === 'running') return 'Dang chay';
    if (s === 'stopped') return 'Da dung';
    return s || 'N/A';
  }

  function hasTextValue(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  function pickTranscriptText(item, detailText = '') {
    const cands = [
      detailText,
      item?.preview_text,
      item?.latest_text_en,
      item?.latest_text_vi,
      item?.latest_text,
      item?.text_en,
      item?.text_vi,
      item?.text,
    ];
    for (const c of cands) {
      if (hasTextValue(c)) return String(c);
    }
    return '';
  }

  function ragNormalizePreview(s, maxLen = 180) {
    const clean = String(s || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'Dang cap nhat transcript...';
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, maxLen - 3) + '...';
  }

  function ragSortSessionsDesc(rows) {
    const ts = (r) => {
      const t = Date.parse(String(r?.started_at || r?.last_updated_at || ''));
      return Number.isFinite(t) ? t : 0;
    };
    return rows.sort((a, b) => ts(b) - ts(a) || (Number(b?.id || 0) - Number(a?.id || 0)));
  }

  function clipText(s, maxLen) {
    const str = String(s || '');
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.slice(0, Math.max(0, maxLen - 3)) + '...';
  }

  function isRagPickerOpen() {
    return !!(chatRagPicker && !chatRagPicker.classList.contains('hidden'));
  }

  function isElementVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function resetRagPickerState() {
    ragPickerState.loaded = false;
    ragPickerState.loading = false;
    ragPickerState.prefetching = false;
    ragPickerState.items = [];
    ragPickerState.filtered = [];
    ragPickerState.selectedIds.clear();
    ragPickerState.pinnedIds.clear();
    ragPickerState.previewHydratedIds.clear();
    ragPickerState.details.clear();
    ragPickerState.detailInflight.clear();
    if (chatRagSearch) chatRagSearch.value = '';
    renderRagPickerList();
    renderChatRagSelectionBar();
    closeRagPicker();
    closeChatRagDetailModal();
  }

  function setRagPickerLoading(on) {
    ragPickerState.loading = !!on;
    if (chatRagPickerLoading) chatRagPickerLoading.classList.toggle('hidden', !on);
  }

  function setRagPickerEmpty(text, show) {
    if (!chatRagPickerEmpty) return;
    chatRagPickerEmpty.textContent = String(text || 'Khong co du lieu.');
    chatRagPickerEmpty.classList.toggle('hidden', !show);
  }

  function syncRagSelectionSets() {
    const validIds = new Set(ragPickerState.items.map((it) => Number(it?.id || 0)).values());
    ragPickerState.selectedIds = new Set([...ragPickerState.selectedIds].filter((id) => validIds.has(id)));
    ragPickerState.pinnedIds = new Set([...ragPickerState.pinnedIds].filter((id) => validIds.has(id)));
  }

  function applyRagFilter() {
    const q = String(chatRagSearch?.value || '').trim().toLowerCase();
    if (!q) {
      ragPickerState.filtered = ragPickerState.items.slice();
      return;
    }
    ragPickerState.filtered = ragPickerState.items.filter((it) => {
      const hay = [
        String(it?.tab_domain || ''),
        String(it?.tab_url || ''),
        pickTranscriptText(it, ragPickerState.details.get(Number(it?.id || 0))?.fullText || ''),
        String(it?.status || ''),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function findRagItem(sessionId) {
    const sid = Number(sessionId || 0);
    if (!sid) return null;
    return ragPickerState.items.find((x) => Number(x?.id || 0) === sid) || null;
  }

  function updateRagPickerPinUi() {
    const selectedCount = ragPickerState.selectedIds.size;
    const pinnedCount = ragPickerState.pinnedIds.size;
    const ragOn = pinnedCount > 0 && !!chatToggles.useRag;

    if (chatRagPinBtn) {
      chatRagPinBtn.classList.toggle('active', ragOn || selectedCount > 0);
      chatRagPinBtn.textContent = 'Xác nhận';
    }
  }

  function renderChatRagSelectionBar() {
    if (!chatRagSelectionBar) return;
    const selectedIds = [...ragPickerState.selectedIds];
    const pinned = ragPickerState.pinnedIds;
    const ids = selectedIds.length ? selectedIds : [...pinned];

    if (!ids.length) {
      chatRagSelectionBar.innerHTML = '';
      chatRagSelectionBar.classList.add('hidden');
      return;
    }

    const chips = [];
    const maxShow = 4;
    for (let i = 0; i < Math.min(maxShow, ids.length); i++) {
      const sid = ids[i];
      const item = findRagItem(sid) || {};
      const label = `${ragDomainFrom(item)} • ${ragFormatDateTime(item?.started_at)}`;
      const pinnedCls = pinned.has(sid) ? ' pinned' : '';
      chips.push(
        `<span class="chat-rag-selection-chip${pinnedCls}" title="${escapeHtml(label)}">` +
        `<span class="chat-rag-selection-chip-text">${escapeHtml(label)}</span>` +
        `</span>`
      );
    }

    const more = ids.length > maxShow
      ? `<span class="chat-rag-selection-more">+${ids.length - maxShow}</span>`
      : '';
    chatRagSelectionBar.innerHTML =
      `<span class="chat-rag-selection-label"></span>${chips.join('')}${more}`;
    chatRagSelectionBar.classList.remove('hidden');
  }

  function renderRagPickerList() {
    if (!chatRagPickerList) return;
    chatRagPickerList.innerHTML = '';

    if (!ragPickerState.filtered.length) {
      setRagPickerEmpty('Khong tim thay transcript phu hop.', true);
      updateRagPickerPinUi();
      return;
    }
    setRagPickerEmpty('', false);

    const frag = document.createDocumentFragment();
    for (const item of ragPickerState.filtered) {
      const sid = Number(item?.id || 0);
      if (!sid) continue;

      const selected = ragPickerState.selectedIds.has(sid);
      const pinned = ragPickerState.pinnedIds.has(sid);
      const detail = ragPickerState.details.get(sid);
      const previewText = ragNormalizePreview(
        pickTranscriptText(item, detail?.ok ? detail.fullText : ''),
      );

      const row = document.createElement('div');
      row.className = `rag-item${selected ? ' selected' : ''}`;
      row.dataset.sessionId = String(sid);
      row.innerHTML = `
        <label class="rag-item-check-wrap">
          <input class="rag-item-check" type="checkbox" ${selected ? 'checked' : ''} />
        </label>
        <div class="rag-item-main" data-rag-open="1">
          <div class="rag-item-top">
            <span class="rag-item-domain">${escapeHtml(ragDomainFrom(item))}</span>
            <span class="rag-item-time">${escapeHtml(ragFormatDateTime(item?.started_at))}</span>
          </div>
          <p class="rag-item-preview">${escapeHtml(previewText)}</p>
          <div class="rag-item-meta">
            ${escapeHtml(`Tong thoi gian: ${ragFormatDurationMs(ragCalcDurationMs(item))} - Trang thai: ${ragStatusLabel(item?.status)}${pinned ? ' - Da chot' : ''}`)}
          </div>
        </div>
        <button class="rag-item-open" type="button" data-rag-open-btn="1">Chi tiết</button>
      `;
      frag.appendChild(row);
    }
    chatRagPickerList.appendChild(frag);
    updateRagPickerPinUi();
    renderChatRagSelectionBar();
  }

  async function loadRagPickerList(force = false) {
    if (!hasChromeRuntime) {
      setRagPickerEmpty('Khong co chrome.runtime.', true);
      return;
    }
    if (ragPickerState.loading) return;
    if (ragPickerState.loaded && !force) {
      applyRagFilter();
      renderRagPickerList();
      return;
    }
    if (force) {
      ragPickerState.details.clear();
      ragPickerState.detailInflight.clear();
    }

    setRagPickerLoading(true);
    setRagPickerEmpty('', false);
    try {
      const res = await sendRuntime({
        __cmd: '__HISTORY_LIST__',
        payload: { limit: 300, offset: 0 },
      });

      if (res?.code === 'AUTH_REQUIRED') {
        ragPickerState.items = [];
        ragPickerState.filtered = [];
        ragPickerState.loaded = true;
        renderRagPickerList();
        setRagPickerEmpty('Ban can dang nhap de xem transcript history.', true);
        openAuthOverlayFromPanel();
        return;
      }
      if (res?.code === 'USER_ID_INVALID') {
        ragPickerState.items = [];
        ragPickerState.filtered = [];
        ragPickerState.loaded = true;
        renderRagPickerList();
        const dbg = formatUserIdDebug(res?.debug);
        setRagPickerEmpty(
          dbg
            ? `Khong tim thay user id hop le cho tai khoan hien tai.\n[debug] ${dbg}`
            : 'Khong tim thay user id hop le cho tai khoan hien tai.',
          true
        );
        return;
      }
      if (!res?.ok) throw new Error(String(res?.error || 'HISTORY_LIST_FAILED'));

      const rows = Array.isArray(res.items) ? res.items.slice() : [];
      ragPickerState.items = ragSortSessionsDesc(rows);
      ragPickerState.loaded = true;
      syncRagSelectionSets();
      applyRagFilter();
      renderRagPickerList();
      prefetchRagMissingPreviews();
      if (!ragPickerState.items.length) {
        setRagPickerEmpty('Chua co transcript nao duoc luu.', true);
      }
    } catch (e) {
      ragPickerState.items = [];
      ragPickerState.filtered = [];
      ragPickerState.loaded = false;
      renderRagPickerList();
      setRagPickerEmpty(`Khong tai duoc transcript history: ${String(e?.message || e)}`, true);
    } finally {
      setRagPickerLoading(false);
      positionRagPicker();
    }
  }

  async function prefetchRagMissingPreviews() {
    if (ragPickerState.prefetching) return;
    const targets = ragPickerState.items
      .filter((item) => {
        const sid = Number(item?.id || 0);
        if (!sid) return false;
        if (ragPickerState.previewHydratedIds.has(sid)) return false;
        return !hasTextValue(pickTranscriptText(item));
      })
      .slice(0, 36);
    if (!targets.length) return;

    ragPickerState.prefetching = true;
    try {
      await Promise.all(targets.map(async (item) => {
        const sid = Number(item?.id || 0);
        if (!sid) return;
        const detail = await ensureRagDetail(sid);
        if (detail?.ok && hasTextValue(detail.fullText)) {
          item.latest_text_en = detail.fullText;
        }
        ragPickerState.previewHydratedIds.add(sid);
      }));
    } finally {
      ragPickerState.prefetching = false;
      applyRagFilter();
      renderRagPickerList();
    }
  }

  function positionRagPicker() {
    if (!chatRagPicker || !isRagPickerOpen()) return;
    const anchor = (isElementVisible(chipRag) ? chipRag : null)
      || ragPickerState.anchorEl
      || (isElementVisible(chatActionRetrieveBtn) ? chatActionRetrieveBtn : null)
      || (isElementVisible(chatActionStoreBtn) ? chatActionStoreBtn : null)
      || null;
    if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;

    const hostRect =
      (isElementVisible(chatView) ? chatView.getBoundingClientRect() : null)
      || (isElementVisible(panelEl) ? panelEl.getBoundingClientRect() : null);
    const anchorRect = anchor.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const hostLeft = hostRect ? Math.round(hostRect.left) : 8;
    const hostRight = hostRect ? Math.round(hostRect.right) : Math.round(vw - 8);
    const hostTop = hostRect ? Math.round(hostRect.top) : 8;
    const hostBottom = hostRect ? Math.round(hostRect.bottom) : Math.round((window.innerHeight || document.documentElement.clientHeight || 0) - 8);
    const hostWidth = Math.max(260, hostRight - hostLeft);

    // larger picker width for better readability, still clamped to chat area
    const desiredWidth = Math.round(hostWidth * 0.66);
    const width = Math.min(
      Math.max(360, desiredWidth),
      Math.min(780, vw - 20, Math.max(260, hostWidth - 8))
    );
    chatRagPicker.style.width = `${width}px`;

    const tailH = 12;
    const anchorGap = 8; // keep arrow tip slightly above chip, never overlap
    const safePad = 8;
    const availableAbove = Math.max(
      0,
      Math.floor(anchorRect.top - hostTop - tailH - anchorGap - safePad)
    );
    const desiredMaxH = Math.min(680, Math.max(300, Math.round((hostBottom - hostTop) * 0.78)));
    let maxHeight = Math.min(desiredMaxH, availableAbove);
    if (!Number.isFinite(maxHeight) || maxHeight <= 0) maxHeight = 24;
    chatRagPicker.style.maxHeight = `${maxHeight}px`;

    const pickerRect = chatRagPicker.getBoundingClientRect();
    const ph = Math.min(pickerRect.height || maxHeight, maxHeight);

    const leftBound = hostRect ? Math.max(8, Math.round(hostRect.left + 4)) : 10;
    const rightBound = hostRect ? Math.round(hostRect.right - width - 4) : Math.round(vw - width - 10);

    let left = Math.round(anchorRect.left - width * 0.2);
    if (left > rightBound) left = rightBound;
    if (left < leftBound) left = leftBound;

    let top = Math.round(anchorRect.top - ph - tailH - anchorGap);
    const minTop = Math.round(hostTop + safePad);
    if (top < minTop) top = minTop;

    chatRagPicker.style.left = `${Math.round(left)}px`;
    chatRagPicker.style.top = `${Math.round(top)}px`;

    const tailX = Math.max(24, Math.min(width - 24, Math.round(anchorRect.left + (anchorRect.width / 2) - left)));
    chatRagPicker.style.setProperty('--rag-tail-x', `${tailX}px`);
    chatRagPicker.style.setProperty('--rag-origin-x', `${tailX}px`);
    chatRagPicker.style.setProperty('--rag-origin-y', '100%');
    chatRagPicker.dataset.placement = 'top';
  }

  function openRagPicker(anchorEl = null, opts = {}) {
    if (!chatRagPicker) return;
    ragPickerState.anchorEl = (isElementVisible(chipRag) ? chipRag : null)
      || anchorEl
      || (isElementVisible(chatActionRetrieveBtn) ? chatActionRetrieveBtn : null)
      || (isElementVisible(chatActionStoreBtn) ? chatActionStoreBtn : null)
      || null;
    ragPickerDetailReturnAnchor = ragPickerState.anchorEl || chipRag || chatActionRetrieveBtn || null;
    if (ragPickerOpenTimer) {
      clearTimeout(ragPickerOpenTimer);
      ragPickerOpenTimer = null;
    }
    chatRagPicker.classList.remove('is-open');
    chatRagPicker.classList.remove('hidden');
    chatRagPicker.setAttribute('aria-hidden', 'false');
    positionRagPicker();
    requestAnimationFrame(() => {
      if (!chatRagPicker.classList.contains('hidden')) chatRagPicker.classList.add('is-open');
    });
    if (opts.focusSearch && chatRagSearch) chatRagSearch.focus();
    loadRagPickerList(!!opts.forceReload);
  }

  function closeRagPicker() {
    if (!chatRagPicker) return;
    if (ragPickerOpenTimer) {
      clearTimeout(ragPickerOpenTimer);
      ragPickerOpenTimer = null;
    }
    chatRagPicker.classList.remove('is-open');
    ragPickerOpenTimer = setTimeout(() => {
      chatRagPicker.classList.add('hidden');
      chatRagPicker.setAttribute('aria-hidden', 'true');
      ragPickerOpenTimer = null;
    }, 150);
  }

  function openChatRagDetailSkeleton(item) {
    if (!chatRagDetailModal) return;
    chatRagDetailModal.classList.remove('hidden');
    chatRagDetailModal.setAttribute('aria-hidden', 'false');
    if (chatRagDetailTitle) chatRagDetailTitle.textContent = ragDomainFrom(item);
    if (chatRagDetailMeta) {
      chatRagDetailMeta.textContent =
        `Website: ${item?.tab_url || ragDomainFrom(item)} - Bat dau: ${ragFormatDateTime(item?.started_at)} - Tong thoi gian: ${ragFormatDurationMs(ragCalcDurationMs(item))}`;
    }
    if (chatRagDetailContent) chatRagDetailContent.textContent = 'Dang tai noi dung transcript...';
    document.body.classList.add('history-modal-open');
  }

  function fillChatRagDetail(item, fullText) {
    if (!chatRagDetailModal) return;
    if (chatRagDetailTitle) chatRagDetailTitle.textContent = ragDomainFrom(item);
    if (chatRagDetailMeta) {
      chatRagDetailMeta.textContent =
        `Website: ${item?.tab_url || ragDomainFrom(item)} - Bat dau: ${ragFormatDateTime(item?.started_at)} - Tong thoi gian: ${ragFormatDurationMs(ragCalcDurationMs(item))}`;
    }
    if (chatRagDetailContent) {
      chatRagDetailContent.textContent = String(fullText || 'Dang cap nhat transcript...');
    }
  }

  function closeChatRagDetailModal(opts = {}) {
    const reopenPicker = !!opts.reopenPicker;
    if (!chatRagDetailModal) {
      ragPickerRestoreOnDetailClose = false;
      return;
    }
    chatRagDetailModal.classList.add('hidden');
    chatRagDetailModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('history-modal-open');

    const shouldReopenPicker = reopenPicker && ragPickerRestoreOnDetailClose;
    ragPickerRestoreOnDetailClose = false;
    if (shouldReopenPicker) {
      const anchor = ragPickerDetailReturnAnchor || chipRag || chatActionRetrieveBtn || null;
      requestAnimationFrame(() => openRagPicker(anchor));
    }
  }

  async function ensureRagDetail(sessionId) {
    const sid = Number(sessionId || 0);
    if (!sid) return null;

    const cached = ragPickerState.details.get(sid);
    if (cached) return cached;

    const inflight = ragPickerState.detailInflight.get(sid);
    if (inflight) return inflight;

    const p = (async () => {
      const baseItem = findRagItem(sid) || { id: sid };
      const res = await sendRuntime({
        __cmd: '__HISTORY_DETAIL__',
        payload: { sessionId: sid },
      });

      if (res?.code === 'AUTH_REQUIRED') {
        openAuthOverlayFromPanel();
        return { ok: false, code: 'AUTH_REQUIRED', item: baseItem, fullText: '' };
      }
      if (res?.code === 'USER_ID_INVALID') {
        return {
          ok: false,
          code: 'USER_ID_INVALID',
          item: baseItem,
          fullText: (() => {
            const dbg = formatUserIdDebug(res?.debug);
            return dbg
              ? `Khong tim thay user id hop le cho tai khoan hien tai.\n\n[debug] ${dbg}`
              : 'Khong tim thay user id hop le cho tai khoan hien tai.';
          })(),
        };
      }
      if (!res?.ok) {
        return {
          ok: false,
          code: 'DETAIL_FAILED',
          item: baseItem,
          fullText: `Khong tai duoc transcript: ${String(res?.error || 'DETAIL_FAILED')}`,
        };
      }

      const item = res.item || baseItem;
      const fullText = String(res.fullText || pickTranscriptText(item) || '');
      const out = { ok: true, item, fullText };
      ragPickerState.details.set(sid, out);
      return out;
    })()
      .catch((e) => ({
        ok: false,
        code: 'DETAIL_FAILED',
        item: findRagItem(sid) || { id: sid },
        fullText: `Khong tai duoc transcript: ${String(e?.message || e)}`,
      }))
      .finally(() => {
        ragPickerState.detailInflight.delete(sid);
      });

    ragPickerState.detailInflight.set(sid, p);
    return p;
  }

  async function openChatRagDetail(sessionId) {
    const sid = Number(sessionId || 0);
    if (!sid) return;
    const baseItem = findRagItem(sid) || { id: sid };
    ragPickerRestoreOnDetailClose = isRagPickerOpen();
    ragPickerDetailReturnAnchor = ragPickerState.anchorEl || chipRag || chatActionRetrieveBtn || null;
    closeRagPicker();
    openChatRagDetailSkeleton(baseItem);
    const detail = await ensureRagDetail(sid);
    if (!detail) {
      fillChatRagDetail(baseItem, 'Khong tai duoc noi dung transcript.');
      return;
    }
    if (detail.code === 'AUTH_REQUIRED') {
      closeChatRagDetailModal();
      return;
    }
    fillChatRagDetail(detail.item || baseItem, detail.fullText || '');
  }

  function toggleRagSelected(sessionId, checked) {
    const sid = Number(sessionId || 0);
    if (!sid) return;
    if (checked) ragPickerState.selectedIds.add(sid);
    else ragPickerState.selectedIds.delete(sid);
    renderRagPickerList();
  }

  function pinSelectedRagSources() {
    ragPickerState.pinnedIds = new Set([...ragPickerState.selectedIds]);
    chatToggles.useRag = ragPickerState.pinnedIds.size > 0;
    applyChatTogglesUI();
    renderRagPickerList();
    closeRagPicker();
  }

  async function buildPinnedRagContextBlock() {
    const ids = [...ragPickerState.pinnedIds];
    if (!ids.length) return '';

    const detailRows = await Promise.all(ids.map((sid) => ensureRagDetail(sid)));
    const chunks = [];
    let total = 0;

    for (let i = 0; i < ids.length; i++) {
      if (total >= RAG_CONTEXT_TOTAL_MAX) break;
      const sid = ids[i];
      const detail = detailRows[i];
      const item = detail?.item || findRagItem(sid) || { id: sid };

      const full = String((detail?.ok ? detail.fullText : '') || pickTranscriptText(item) || '')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!full) continue;

      const clipped = clipText(full, RAG_CONTEXT_PER_ITEM_MAX);
      const remain = RAG_CONTEXT_TOTAL_MAX - total;
      const usable = clipped.length > remain ? clipText(clipped, remain) : clipped;
      if (!usable) continue;

      const header = `[Transcript ${chunks.length + 1}] ${ragDomainFrom(item)} | ${ragFormatDateTime(item?.started_at)}`;
      chunks.push(`${header}\n${usable}`);
      total += usable.length;
    }

    if (!chunks.length) return '';
    return chunks.join('\n\n');
  }

  function bindRagPickerEvents() {
    ragPickerTriggers.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault?.();
        openRagPicker(btn);
      });
    });

    if (chatRagPickerClose) {
      chatRagPickerClose.addEventListener('click', () => closeRagPicker());
    }

    if (chatRagPinBtn) {
      chatRagPinBtn.addEventListener('click', () => {
        pinSelectedRagSources();
      });
    }

    if (chatRagSearch) {
      chatRagSearch.addEventListener('input', () => {
        applyRagFilter();
        renderRagPickerList();
      });
    }

    if (chatRagPickerList) {
      chatRagPickerList.addEventListener('change', (e) => {
        const cb = e.target?.closest?.('.rag-item-check');
        if (!cb) return;
        const row = cb.closest('.rag-item');
        if (!row) return;
        const sid = Number(row.dataset.sessionId || 0);
        toggleRagSelected(sid, !!cb.checked);
      });

      chatRagPickerList.addEventListener('click', (e) => {
        const tgt = e.target;
        if (!tgt) return;
        if (tgt.closest?.('.rag-item-check-wrap') || tgt.closest?.('.rag-item-check')) return;
        const row = tgt.closest?.('.rag-item');
        if (!row) return;
        const sid = Number(row.dataset.sessionId || 0);
        if (!sid) return;
        openChatRagDetail(sid);
      });
    }

    if (chatRagDetailClose) {
      chatRagDetailClose.addEventListener('click', () => closeChatRagDetailModal({ reopenPicker: true }));
    }
    if (chatRagDetailModal) {
      chatRagDetailModal.addEventListener('click', (e) => {
        const tgt = e.target;
        if (tgt && tgt.dataset?.chatRagClose === '1') closeChatRagDetailModal({ reopenPicker: true });
      });
    }

    window.addEventListener('resize', () => {
      if (isRagPickerOpen()) positionRagPicker();
    });

    document.addEventListener('mousedown', (e) => {
      if (!isRagPickerOpen()) return;
      const tgt = e.target;
      if (!tgt) return;
      if (chatRagPicker && chatRagPicker.contains(tgt)) return;
      if (tgt.closest?.('[data-rag-picker-trigger="1"]')) return;
      if (chipRag && chipRag.contains(tgt)) return;
      closeRagPicker();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (chatRagDetailModal && !chatRagDetailModal.classList.contains('hidden')) {
        closeChatRagDetailModal({ reopenPicker: true });
        return;
      }
      if (isRagPickerOpen()) closeRagPicker();
    });
  }

  function applyChatTogglesUI() {
    if (chipRag) chipRag.classList.toggle('active', !!chatToggles.useRag);
    if (chipR1) chipR1.classList.toggle('active', !!chatToggles.useR1);
    writeBoolLS(LS_CHAT_USE_RAG, !!chatToggles.useRag);
    writeBoolLS(LS_CHAT_USE_R1, !!chatToggles.useR1);
    updateRagPickerPinUi();
  }

  if (chipR1) chipR1.addEventListener('click', () => {
    chatToggles.useR1 = !chatToggles.useR1;
    applyChatTogglesUI();
  });

  // ============================================================
  // ✅ Smart rewrite (giữ nguyên logic của bạn)
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
    return [
      'Hãy trả lời trực tiếp dựa trên các đoạn transcript đã được truy xuất (RAG).',
      'Câu hỏi: Bài nói đang nói về chủ đề gì?',
      'Yêu cầu: 1 câu mô tả chủ đề + 3-6 gạch đầu dòng ý chính.',
      'Không hỏi lại người dùng kiểu "bạn cần tóm tắt gì". Nếu không tìm thấy transcript, hãy nói rõ: "Không tìm thấy transcript trong RAG" và gợi ý kiểm tra TXT_RAG_PATH.',
      'English keywords (to match transcript): what is the lecture about, artificial intelligence, machine learning, deep learning, definition, subset.',
    ].join('\n');
  }

  function buildRagQuestionV2(userQ) {
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

    return [
      q,
      '',
      'English hint: use the retrieved transcript snippets (RAG) to answer.'
    ].join('\n');
  }

  function looksLikeBoilerplateAnswer(text) {
    const s = String(text || '').toLowerCase();
    if (s.includes('hiểu rồi! tôi sẽ') && s.includes('tóm tắt')) return true;
    if (s.includes('bạn cần tôi') && s.includes('tóm tắt')) return true;
    if (s.includes('xin vui lòng cung cấp') && s.includes('tóm tắt')) return true;
    return false;
  }

  // ============================================================
  // ✅ Chat UI
  // ============================================================
  function showChatScrollbarTemporarily(ms = CHAT_SCROLLBAR_HIDE_MS) {
    if (!chatHistory) return;
    const hasOverflow = chatHistory.scrollHeight > (chatHistory.clientHeight + 1);
    if (!hasOverflow) {
      chatHistory.classList.remove('scrollbar-visible');
      return;
    }
    chatHistory.classList.add('scrollbar-visible');
    if (chatScrollbarHideTimer) clearTimeout(chatScrollbarHideTimer);
    chatScrollbarHideTimer = setTimeout(() => {
      chatHistory.classList.remove('scrollbar-visible');
      chatScrollbarHideTimer = null;
    }, Math.max(180, Number(ms) || CHAT_SCROLLBAR_HIDE_MS));
  }

  function bindChatHistoryScrollbarAutoHide() {
    if (!chatHistory) return;

    chatHistory.addEventListener('wheel', () => {
      showChatScrollbarTemporarily();
    }, { passive: true });

    chatHistory.addEventListener('touchstart', () => {
      showChatScrollbarTemporarily();
    }, { passive: true });

    chatHistory.addEventListener('touchmove', () => {
      showChatScrollbarTemporarily();
    }, { passive: true });

    chatHistory.addEventListener('mousedown', (e) => {
      const rect = chatHistory.getBoundingClientRect();
      const nearRightEdge = (rect.right - e.clientX) <= 24;
      if (nearRightEdge) showChatScrollbarTemporarily(1200);
    });
  }

  function syncChatFocusMode() {
    if (!chatView || !chatHistory) return;
    const hasMessages = chatHistory.querySelector('.msg-row') !== null;
    chatView.classList.toggle('focus-mode', hasMessages);
  }

  function restoreChatHistory() {
    if (!chatHistory) return;
    const sid = getSessionId();
    const items = getChatHistoryItems(sid);
    chatHistory.innerHTML = '';
    for (const it of items) {
      appendBubble(it.who, it.text, it.meta || '');
    }
    syncChatFocusMode();
  }

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
    syncChatFocusMode();
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

    const profile = await getVtAuthProfile();
    const ok = !!(profile && (profile.email || profile.id || profile.name || profile.full_name));
    if (!ok) {
      openAuthOverlayFromPanel();
      const blockedText = '🔒 Bạn cần đăng nhập để dùng Chat.';
      const blockedMeta = nowTime();
      appendBubble('assistant', blockedText, blockedMeta);
      pushChatHistoryItem('assistant', blockedText, blockedMeta);
      return;
    }

    const rawUserQ = question.trim();
    const sid = getSessionId();
    const authIdentityKey = authIdentityKeyFromProfile(profile);
    const modelTag = chatToggles.useR1 ? 'r1' : 'default';
    const langTag = 'vi';

    const userMeta = nowTime();
    appendBubble('user', rawUserQ, userMeta);
    pushChatHistoryItem('user', rawUserQ, userMeta);

    const assistBubble = appendBubble('assistant', '…');
    const apiBase = getApiBase();
    let useRag = !!chatToggles.useRag;

    try {
      await persistChatMessageToDb({
        identityKey: authIdentityKey,
        localSessionId: sid,
        role: 'user',
        content: rawUserQ,
        titleHint: rawUserQ,
        source: 'sidepanel',
        model: modelTag,
        language: langTag,
      });
    } catch (e) {
      dlog('persist user chat failed:', e);
    }

    const okBase = await probeApiBase(apiBase);
    if (!okBase) {
      const errText = `⚠️ Không kết nối được API ở ${apiBase}. Mở Setting để nhập đúng base (vd: http://127.0.0.1:8000).`;
      if (assistBubble) assistBubble.textContent = errText;
      pushChatHistoryItem('assistant', errText, nowTime());
      try {
        await persistChatMessageToDb({
          identityKey: authIdentityKey,
          localSessionId: sid,
          role: 'assistant',
          content: errText,
          titleHint: rawUserQ,
          source: 'sidepanel',
          model: modelTag,
          language: langTag,
        });
      } catch (e) {
        dlog('persist assistant error msg failed:', e);
      }
      return;
    }

    let pinnedContext = '';
    try {
      pinnedContext = await buildPinnedRagContextBlock();
    } catch (e) {
      dlog('buildPinnedRagContextBlock failed:', e);
    }
    if (pinnedContext && !useRag) useRag = true;

    const pinnedCount = ragPickerState.pinnedIds.size;
    const metaLine = `${nowTime()}${useRag ? ' • RAG: ON' : ' • RAG: OFF'}${pinnedCount ? ` • PIN: ${pinnedCount}` : ''}`;

    const selectedSourceIds = [...ragPickerState.pinnedIds];
    const q0Raw = buildQuestionToServer(rawUserQ, useRag, 0);
    const body0 = { question: q0Raw, session_id: sid, user_id: 'sidepanel', use_rag: useRag };
    if (pinnedContext) body0.selected_context = pinnedContext;
    if (selectedSourceIds.length) body0.selected_source_ids = selectedSourceIds;

    dlog('apiBase', apiBase);
    dlog('Q0 sent:', q0Raw);
    dlog('selected_source_ids:', selectedSourceIds);

    let out0 = '';
    try {
      out0 = await callChatOnce(apiBase, body0, assistBubble);

      if (useRag && looksLikeBoilerplateAnswer(out0)) {
        if (assistBubble) assistBubble.textContent = '… (retry)';
        const q1Raw = buildQuestionToServer(rawUserQ, useRag, 1);
        const body1 = { question: q1Raw, session_id: sid, user_id: 'sidepanel', use_rag: useRag };
        if (pinnedContext) body1.selected_context = pinnedContext;
        if (selectedSourceIds.length) body1.selected_source_ids = selectedSourceIds;
        dlog('Q1 retry:', q1Raw);
        out0 = await callChatOnce(apiBase, body1, assistBubble);
      }

      if (assistBubble) {
        const extra = isDebug()
          ? `\n\n[sent]\n${(useRag ? (looksLikeBoilerplateAnswer(out0) ? 'retry' : 'ok') : 'no-rag')}`
          : '';
        assistBubble.innerHTML =
          escapeHtml(assistBubble.textContent + extra) +
          `<span class="meta">${escapeHtml(metaLine)}</span>`;
      }
      pushChatHistoryItem('assistant', out0, metaLine);
      try {
        await persistChatMessageToDb({
          identityKey: authIdentityKey,
          localSessionId: sid,
          role: 'assistant',
          content: out0,
          titleHint: rawUserQ,
          source: 'sidepanel',
          model: modelTag,
          language: langTag,
        });
      } catch (e) {
        dlog('persist assistant chat failed:', e);
      }
    } catch (err) {
      const errText = `⚠️ ${String(err)}`;
      if (assistBubble) assistBubble.textContent = errText;
      pushChatHistoryItem('assistant', errText, nowTime());
      try {
        await persistChatMessageToDb({
          identityKey: authIdentityKey,
          localSessionId: sid,
          role: 'assistant',
          content: errText,
          titleHint: rawUserQ,
          source: 'sidepanel',
          model: modelTag,
          language: langTag,
        });
      } catch (e) {
        dlog('persist assistant catch msg failed:', e);
      }
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
      }
    });
  }

  if (sendBtn && chatTextArea) {
    sendBtn.addEventListener('click', () => {
      const value = chatTextArea.value;
      if (!value.trim()) return;
      chatTextArea.value = '';
      sendChat(value);
    });
  }

  // ===== Init =====
  bindModeButtons();
  applyModesToUI();
  sendTranscriptModes();

  bindRagPickerEvents();
  bindChatHistoryScrollbarAutoHide();
  applyChatTogglesUI();
  updateRagPickerPinUi();
  (async () => {
    await rotateChatSessionIfRuntimeChanged();
    restoreChatHistory();
  })();
});
