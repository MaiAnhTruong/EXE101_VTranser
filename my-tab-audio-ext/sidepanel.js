// D:\vtranser\EXE101_VTranser\my-tab-audio-ext\sidepanel.js

document.addEventListener('DOMContentLoaded', () => {
  // ===== Constants =====
  const LS_KEY_SERVER = 'sttServerWs';
  const DEFAULT_WS = 'ws://localhost:8765';
  const LS_KEY_TRANS_SERVER = 'sttTranslatorWs';
  const DEFAULT_TRANS_WS = 'ws://localhost:8766';

  const LS_CHAT_API = 'sttChatApiBase';
  const DEFAULT_API = 'http://127.0.0.1:8000';
  const LS_CHAT_SESSION = 'sttChatSessionId';
  const LS_CHAT_RUNTIME_MARK = 'sttChatRuntimeMarkV1';
  const LS_CHAT_HISTORY = 'sttChatHistoryV1';
  const LS_CHAT_SESSION_META = 'sttChatSessionMetaV1';
  const LS_CHAT_DB_CURSOR = 'sttChatDbCursorV1';
  const CHAT_HISTORY_MAX = 120;
  const CHAT_CONV_LIST_MAX = 80;
  const SESSION_RUN_KEY = 'vtRuntimeRunIdV1';

  // Persist transcript modes
  const LS_MODE_EN = 'sttModeEn';
  const LS_MODE_VI = 'sttModeVi';
  const LS_MODE_VOICE = 'sttModeVoice';
  const LS_MODE_RECORD = 'sttModeRecord';
  const LS_STT_SOURCE_LANG = 'sttSourceLang';
  const STT_SOURCE_LANG_ONLY = 'en';
  const STT_LOCKED_MODES = Object.freeze({
    voice: true,
    record: true,
  });

  // Persist chat toggles
  const LS_CHAT_USE_RAG = 'sttChatUseRag';
  const LS_CHAT_USE_R1 = 'sttChatUseR1';
  const LS_CHAT_USE_REALTIME = 'sttChatUseRealtime';

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

  function deriveTranslatorServerFromStt(sttServer) {
    try {
      const u = new URL(String(sttServer || '').trim());
      const out = new URL(u.toString());
      const p = out.pathname || '/';

      if ((out.hostname === 'localhost' || out.hostname === '127.0.0.1') && String(out.port || '') === '8765') {
        out.port = '8766';
        if (/^\/stt(?:\/|$)/i.test(p)) out.pathname = p.replace(/^\/stt/i, '/tr');
        out.search = '';
        out.hash = '';
        return out.toString();
      }

      if (/^\/stt(?:\/|$)/i.test(p)) out.pathname = p.replace(/^\/stt/i, '/tr');
      else if (!p || p === '/') out.pathname = '/tr';

      out.search = '';
      out.hash = '';
      return out.toString();
    } catch {
      return '';
    }
  }

  function getTranslatorServer() {
    const v = (localStorage.getItem(LS_KEY_TRANS_SERVER) || '').trim();
    if (v) return v;
    const derived = deriveTranslatorServerFromStt(getServer());
    return derived || DEFAULT_TRANS_WS;
  }

  function normalizeHttpBaseUrl(raw) {
    const input = String(raw || '').trim();
    if (!input) return '';

    const normalizePath = (pathname) => {
      let p = String(pathname || '').replace(/\/+$/, '');
      p = p.replace(/\/openapi\.json$/i, '');
      p = p.replace(/\/docs$/i, '');
      p = p.replace(/\/redoc$/i, '');
      return p.replace(/\/+$/, '');
    };

    const parseOne = (candidate) => {
      try {
        const u = new URL(candidate);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        const p = normalizePath(u.pathname || '');
        return `${u.origin}${p}`.replace(/\/+$/, '');
      } catch {
        return '';
      }
    };

    const direct = parseOne(input);
    if (direct) return direct;

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
      const withHttps = parseOne(`https://${input}`);
      if (withHttps) return withHttps;
    }

    return input
      .replace(/\/+$/, '')
      .replace(/\/openapi\.json$/i, '')
      .replace(/\/docs$/i, '')
      .replace(/\/redoc$/i, '')
      .replace(/\/+$/, '');
  }

  function getApiBase() {
    const rawStored = (localStorage.getItem(LS_CHAT_API) || '').trim();
    if (!rawStored) return DEFAULT_API;
    const normalized = normalizeHttpBaseUrl(rawStored);
    return normalized || rawStored.replace(/\/+$/, '');
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

  function readChatSessionMetaMap() {
    try {
      const raw = localStorage.getItem(LS_CHAT_SESSION_META);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch {
      return {};
    }
  }

  function writeChatSessionMetaMap(map) {
    try {
      localStorage.setItem(LS_CHAT_SESSION_META, JSON.stringify(map || {}));
    } catch {}
  }

  function chatClipText(s, maxLen = 84) {
    const txt = String(s || '').replace(/\s+/g, ' ').trim();
    if (!txt) return '';
    if (txt.length <= maxLen) return txt;
    return txt.slice(0, Math.max(0, maxLen - 3)) + '...';
  }

  function toIsoOrNow(v) {
    const t = Date.parse(String(v || ''));
    if (Number.isFinite(t)) return new Date(t).toISOString();
    return new Date().toISOString();
  }

  function parseDateMs(v) {
    const t = Date.parse(String(v || ''));
    return Number.isFinite(t) ? t : 0;
  }

  function normalizeIdentityKey(k) {
    return String(k || '').trim().toLowerCase();
  }

  function formatConversationTime(iso) {
    const d = parseDateMs(iso);
    if (!d) return '';
    const dt = new Date(d);
    return `${pad(dt.getHours())}:${pad(dt.getMinutes())} ${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}`;
  }

  function upsertChatSessionMeta(sessionId, patch = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const map = readChatSessionMetaMap();
    const prev = (map[sid] && typeof map[sid] === 'object') ? map[sid] : {};
    const createdAt = toIsoOrNow(prev.createdAt || patch.createdAt);
    const next = {
      identityKey: normalizeIdentityKey(patch.identityKey || prev.identityKey || ''),
      title: chatClipText(patch.title || prev.title || '', 72),
      preview: chatClipText(patch.preview || prev.preview || '', 110),
      createdAt,
      updatedAt: toIsoOrNow(patch.updatedAt || prev.updatedAt || createdAt),
      messageCount: Math.max(0, Number(patch.messageCount ?? prev.messageCount ?? 0) || 0),
    };
    map[sid] = next;

    const keys = Object.keys(map);
    const MAX_META = 400;
    if (keys.length > MAX_META) {
      keys
        .sort((a, b) => parseDateMs(map[b]?.updatedAt) - parseDateMs(map[a]?.updatedAt))
        .slice(MAX_META)
        .forEach((k) => { delete map[k]; });
    }
    writeChatSessionMetaMap(map);
  }

  function touchChatSessionMetaFromItems(sessionId, items, opts = {}) {
    const sid = String(sessionId || '').trim();
    const arr = Array.isArray(items) ? items : [];
    if (!sid) return;

    const firstUser = arr.find((x) => x?.who === 'user' && String(x?.text || '').trim());
    const lastMsg = arr.length ? arr[arr.length - 1] : null;
    const titleHint = chatClipText(opts.titleHint || firstUser?.text || lastMsg?.text || 'Cuộc trò chuyện mới', 72);
    const preview = chatClipText(lastMsg?.text || opts.preview || '', 110);
    upsertChatSessionMeta(sid, {
      identityKey: opts.identityKey || '',
      title: titleHint,
      preview,
      updatedAt: new Date().toISOString(),
      messageCount: arr.length,
    });
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
    const nextItems = (Array.isArray(items) ? items : [])
      .slice(-CHAT_HISTORY_MAX)
      .map((x) => ({
        who: x?.who === 'assistant' ? 'assistant' : 'user',
        text: String(x?.text || ''),
        meta: String(x?.meta || ''),
      }));
    if (nextItems.length) map[sid] = nextItems;
    else delete map[sid];
    writeChatHistoryMap(map);
  }

  function pushChatHistoryItem(who, text, meta = '', opts = {}) {
    const msgText = String(text || '').trim();
    if (!msgText) return;
    const sid = String(opts.sessionId || getSessionId() || '').trim();
    if (!sid) return;
    const arr = getChatHistoryItems(sid);
    arr.push({
      who: who === 'assistant' ? 'assistant' : 'user',
      text: msgText,
      meta: String(meta || ''),
    });
    saveChatHistoryItems(sid, arr);
    touchChatSessionMetaFromItems(sid, arr, {
      identityKey: opts.identityKey || '',
      titleHint: opts.titleHint || '',
    });
    syncConversationPanelAfterHistoryChange();
  }

  function clearChatDbCursorStateByLocalSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    const map = readJsonObjectLS(LS_CHAT_DB_CURSOR);
    let changed = false;
    Object.keys(map).forEach((k) => {
      if (String(k || '').endsWith(`::${sid}`)) {
        delete map[k];
        changed = true;
      }
    });
    if (changed) writeJsonObjectLS(LS_CHAT_DB_CURSOR, map);
    return changed;
  }

  function deleteChatConversationData(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;

    let changed = false;
    const histMap = readChatHistoryMap();
    if (Object.prototype.hasOwnProperty.call(histMap, sid)) {
      delete histMap[sid];
      writeChatHistoryMap(histMap);
      changed = true;
    }

    const metaMap = readChatSessionMetaMap();
    if (Object.prototype.hasOwnProperty.call(metaMap, sid)) {
      delete metaMap[sid];
      writeChatSessionMetaMap(metaMap);
      changed = true;
    }

    if (clearChatDbCursorStateByLocalSession(sid)) changed = true;
    return changed;
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
  function storeSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj || {}, () => resolve()); } catch { resolve(); }
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
  const historyButton = document.getElementById('btn-history'); // NEW
  const moreButton = document.getElementById('btn-more');
  const collapseButton = document.getElementById('btn-collapse');
  const fullscreenButton = document.getElementById('btn-fullscreen');
  const settingButton = document.getElementById('btn-setting');
  const navButtons = document.querySelectorAll('.toolbar .nav-btn');

  const chatView = document.getElementById('chat-content');
  const transcriptView = document.getElementById('transcript-content');
  const historyView = document.getElementById('history-content'); // NEW
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

  // settings modal
  const settingsModal = document.getElementById('settingsModal');
  const settingsClose = document.getElementById('settingsClose');
  const settingsCancelBtn = document.getElementById('settingsCancelBtn');
  const settingsSaveBtn = document.getElementById('settingsSaveBtn');
  const settingsResetBtn = document.getElementById('settingsResetBtn');
  const settingsStatus = document.getElementById('settingsStatus');
  const settingsWsInput = document.getElementById('settingsWsInput');
  const settingsTransInput = document.getElementById('settingsTransInput');
  const settingsApiInput = document.getElementById('settingsApiInput');
  const settingsModeEn = document.getElementById('settingsModeEn');
  const settingsModeVi = document.getElementById('settingsModeVi');
  const settingsModeVoice = document.getElementById('settingsModeVoice');
  const settingsModeRecord = document.getElementById('settingsModeRecord');
  const settingsDebugChat = document.getElementById('settingsDebugChat');

  // bottom bar
  const bottomGreetingEl = document.getElementById('bottomGreeting');
  const toolbarAccountPlanEl = document.getElementById('toolbarAccountPlan');
  const loginBtns = document.querySelectorAll('.login-btn');

  // chat view elements
  const chatTextArea = document.querySelector('#chat-content .textarea-wrapper textarea');
  const chatHistory = document.querySelector('.chat-history-area');
  const chatConversationsToggle = document.getElementById('chatConversationsToggle');
  const chatConversationsPanel = document.getElementById('chatConversationsPanel');
  const chatConversationsList = document.getElementById('chatConversationsList');
  const chatConversationsEmpty = document.getElementById('chatConversationsEmpty');
  const chatConversationsNewBtn = document.getElementById('chatConversationsNewBtn');
  const chatDeleteModal = document.getElementById('chatDeleteModal');
  const chatDeleteClose = document.getElementById('chatDeleteClose');
  const chatDeleteMeta = document.getElementById('chatDeleteMeta');
  const chatDeleteText = document.getElementById('chatDeleteText');
  const chatDeleteCancelBtn = document.getElementById('chatDeleteCancelBtn');
  const chatDeleteConfirmBtn = document.getElementById('chatDeleteConfirmBtn');
  let chatScrollbarHideTimer = null;
  const chatConversationsState = {
    open: false,
    identityKey: '',
  };
  const chatDeleteState = {
    sessionId: '',
    label: '',
    submitting: false,
  };

  const chipRag = document.getElementById('chatChipRag');
  const chipRealtime = document.getElementById('chatChipRealtime');
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
  const transcriptSourceLangSelect = document.getElementById('sttSourceLang');

  const subtitleBtn = document.getElementById('btn-subtitle');            // EN
  const subtitleTransBtn = document.getElementById('btn-subtitle-trans'); // VI translate
  const voiceBtn = document.getElementById('btn-voice');
  const recordBtn = document.getElementById('btn-record');

  function syncLockedTranscriptControlsUi() {
    if (voiceBtn) {
      voiceBtn.disabled = !!STT_LOCKED_MODES.voice;
      voiceBtn.setAttribute('aria-disabled', STT_LOCKED_MODES.voice ? 'true' : 'false');
    }
    if (recordBtn) {
      recordBtn.disabled = !!STT_LOCKED_MODES.record;
      recordBtn.setAttribute('aria-disabled', STT_LOCKED_MODES.record ? 'true' : 'false');
    }
    if (settingsModeVoice) {
      settingsModeVoice.disabled = !!STT_LOCKED_MODES.voice;
      if (STT_LOCKED_MODES.voice) settingsModeVoice.checked = false;
    }
    if (settingsModeRecord) {
      settingsModeRecord.disabled = !!STT_LOCKED_MODES.record;
      if (STT_LOCKED_MODES.record) settingsModeRecord.checked = false;
    }
  }

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

  // If SW asked to login recently
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
      const plan = String(p?.plan || p?.subscription_plan || p?.tier || 'Free').trim() || 'Free';
      if (bottomGreetingEl) bottomGreetingEl.textContent = name ? `Xin chào, ${name}` : 'Xin chào';
      if (toolbarAccountPlanEl) toolbarAccountPlanEl.textContent = plan;
      // hide login when authed
      if (loginBtns && loginBtns.length) {
        const authed = !!(p && (p.email || p.id || p.name || p.full_name));
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
        chatConversationsState.identityKey = '';
        if (chatConversationsState.open) {
          getCurrentChatIdentityKey()
            .then((key) => {
              chatConversationsState.identityKey = key;
              renderChatConversations(key);
            })
            .catch(() => {});
        }
      }
    });
  }

  historyController?.init?.({
    openAuthOverlay: openAuthOverlayFromPanel,
  });

  // ===== Settings modal =====
  function isSettingsOpen() {
    return !!(settingsModal && !settingsModal.classList.contains('hidden'));
  }

  function setSettingsStatus(text = '', tone = '') {
    if (!settingsStatus) return;
    settingsStatus.textContent = String(text || '');
    settingsStatus.classList.remove('error', 'success');
    if (tone === 'error') settingsStatus.classList.add('error');
    if (tone === 'success') settingsStatus.classList.add('success');
  }

  function normalizeApiBaseInput(v) {
    return normalizeHttpBaseUrl(v);
  }

  function normalizeWsServerInput(v) {
    return String(v || '').trim().replace(/\s+/g, '');
  }

  function isValidHttpUrl(v) {
    try {
      const u = new URL(String(v || ''));
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function isValidWsUrl(v) {
    try {
      const u = new URL(String(v || ''));
      return u.protocol === 'ws:' || u.protocol === 'wss:';
    } catch {
      return false;
    }
  }

  async function fillSettingsFormFromStorage() {
    if (!settingsModal) return;
    const wsVal = getServer();
    if (settingsApiInput) settingsApiInput.value = getApiBase();
    if (settingsWsInput) settingsWsInput.value = wsVal;
    let transVal = (localStorage.getItem(LS_KEY_TRANS_SERVER) || '').trim();
    if (!transVal) {
      const st = await storeGet([LS_KEY_TRANS_SERVER]);
      transVal = String(st?.[LS_KEY_TRANS_SERVER] || '').trim();
      if (transVal) {
        try { localStorage.setItem(LS_KEY_TRANS_SERVER, transVal); } catch {}
      }
    }
    if (!transVal) transVal = getTranslatorServer();
    if (settingsTransInput) settingsTransInput.value = transVal;
    if (settingsModeEn) settingsModeEn.checked = readBoolLS(LS_MODE_EN, false);
    if (settingsModeVi) settingsModeVi.checked = readBoolLS(LS_MODE_VI, false);
    if (settingsModeVoice) settingsModeVoice.checked = readBoolLS(LS_MODE_VOICE, false);
    if (settingsModeRecord) settingsModeRecord.checked = readBoolLS(LS_MODE_RECORD, false);
    if (settingsDebugChat) settingsDebugChat.checked = isDebug();
    syncLockedTranscriptControlsUi();
    setSettingsStatus('');
  }

  function fillSettingsFormDefault() {
    if (settingsApiInput) settingsApiInput.value = DEFAULT_API;
    if (settingsWsInput) settingsWsInput.value = DEFAULT_WS;
    if (settingsTransInput) settingsTransInput.value = DEFAULT_TRANS_WS;
    if (settingsModeEn) settingsModeEn.checked = false;
    if (settingsModeVi) settingsModeVi.checked = false;
    if (settingsModeVoice) settingsModeVoice.checked = false;
    if (settingsModeRecord) settingsModeRecord.checked = false;
    if (settingsDebugChat) settingsDebugChat.checked = false;
    syncLockedTranscriptControlsUi();
    setSettingsStatus('Đã đưa về bộ mặc định. Nhấn "Lưu cài đặt" để áp dụng.', 'success');
  }

  function closeSettingsModal() {
    if (!settingsModal) return;
    settingsModal.classList.add('hidden');
    settingsModal.setAttribute('aria-hidden', 'true');
  }

  async function openSettingsModal() {
    if (!settingsModal) return;
    await fillSettingsFormFromStorage();
    settingsModal.classList.remove('hidden');
    settingsModal.setAttribute('aria-hidden', 'false');
    settingsApiInput?.focus?.();
  }

  async function applySettingsFromForm() {
    const apiInputRaw = String(settingsApiInput?.value || '');
    const apiVal = normalizeApiBaseInput(apiInputRaw);
    const wsVal = normalizeWsServerInput(settingsWsInput?.value || '');
    const transRaw = normalizeWsServerInput(settingsTransInput?.value || '');
    const transVal = transRaw || deriveTranslatorServerFromStt(wsVal) || DEFAULT_TRANS_WS;
    const apiInputTrimmed = apiInputRaw.trim().replace(/\/+$/, '');
    const apiAutoFixed = !!apiVal && apiVal !== apiInputTrimmed;
    if (!isValidWsUrl(transVal)) {
      setSettingsStatus('Translator WebSocket (VI) must be a valid ws/wss URL.', 'error');
      settingsTransInput?.focus?.();
      return false;
    }

    if (!isValidHttpUrl(apiVal)) {
      setSettingsStatus('Chat API Base phải là URL http/https hợp lệ.', 'error');
      settingsApiInput?.focus?.();
      return false;
    }
    if (!isValidWsUrl(wsVal)) {
      setSettingsStatus('STT WebSocket Server phải là URL ws/wss hợp lệ.', 'error');
      settingsWsInput?.focus?.();
      return false;
    }

    try {
      localStorage.setItem(LS_CHAT_API, apiVal);
      localStorage.setItem(LS_KEY_SERVER, wsVal);
      localStorage.setItem(LS_KEY_TRANS_SERVER, transVal);
      localStorage.setItem(LS_CHAT_DEBUG, settingsDebugChat?.checked ? '1' : '0');
      localStorage.setItem(LS_STT_SOURCE_LANG, STT_SOURCE_LANG_ONLY);
    } catch {}
    if (settingsApiInput) settingsApiInput.value = apiVal;
    if (settingsTransInput) settingsTransInput.value = transVal;
    if (hasChromeRuntime) {
      try { await storeSet({ [LS_KEY_TRANS_SERVER]: transVal }); } catch {}
    }

    modes.en = !!settingsModeEn?.checked;
    modes.vi = !!settingsModeVi?.checked;
    modes.voice = !!settingsModeVoice?.checked;
    modes.record = !!settingsModeRecord?.checked;
    if (STT_LOCKED_MODES.voice) modes.voice = false;
    if (STT_LOCKED_MODES.record) modes.record = false;
    syncLockedTranscriptControlsUi();
    sendTranscriptModes();

    if (transcriptSourceLangSelect) transcriptSourceLangSelect.value = STT_SOURCE_LANG_ONLY;
    if (apiAutoFixed) {
      setSettingsStatus(`Đã lưu cài đặt. Chat API Base được chuẩn hóa thành: ${apiVal}`, 'success');
    } else {
      setSettingsStatus('Đã lưu cài đặt.', 'success');
    }
    return true;
  }

  if (settingButton) {
    settingButton.addEventListener('click', (e) => {
      e.preventDefault?.();
      openSettingsModal().catch(() => {});
    });
  }

  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target?.closest?.('[data-settings-close]')) closeSettingsModal();
    });
  }
  if (settingsClose) settingsClose.addEventListener('click', closeSettingsModal);
  if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettingsModal);
  if (settingsResetBtn) settingsResetBtn.addEventListener('click', fillSettingsFormDefault);
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', () => {
      applySettingsFromForm().catch(() => {});
    });
  }

  [settingsApiInput, settingsWsInput, settingsTransInput, settingsModeEn, settingsModeVi, settingsModeVoice, settingsModeRecord, settingsDebugChat]
    .filter(Boolean)
    .forEach((el) => {
      const evt = (el.tagName === 'INPUT' && el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(evt, () => setSettingsStatus(''));
    });

  if (settingsModal) {
    settingsModal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target === settingsApiInput || e.target === settingsWsInput || e.target === settingsTransInput)) {
        e.preventDefault?.();
        applySettingsFromForm().catch(() => {});
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isSettingsOpen()) closeSettingsModal();
  });

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
  // TRANSCRIPT MODES
  // ============================================================
  const modes = {
    en: readBoolLS(LS_MODE_EN, false),
    vi: readBoolLS(LS_MODE_VI, false),
    voice: readBoolLS(LS_MODE_VOICE, false),
    record: readBoolLS(LS_MODE_RECORD, false),
  };

  function enforceLockedTranscriptModes() {
    if (STT_LOCKED_MODES.voice) modes.voice = false;
    if (STT_LOCKED_MODES.record) modes.record = false;
  }

  function setBtnActive(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', !!on);
  }

  function applyModesToUI() {
    enforceLockedTranscriptModes();
    syncLockedTranscriptControlsUi();
    setBtnActive(subtitleBtn, modes.en);
    setBtnActive(subtitleTransBtn, modes.vi);
    setBtnActive(voiceBtn, modes.voice);
    setBtnActive(recordBtn, modes.record);

    writeBoolLS(LS_MODE_EN, modes.en);
    writeBoolLS(LS_MODE_VI, modes.vi);
    writeBoolLS(LS_MODE_VOICE, modes.voice);
    writeBoolLS(LS_MODE_RECORD, modes.record);
  }

  function sendTranscriptModes() {
    if (!hasChromeRuntime) return;
    applyModesToUI();
    const payload = { en: !!modes.en, vi: !!modes.vi, voice: !!modes.voice, record: !!modes.record };
    try {
      chrome.runtime.sendMessage({ __cmd: '__TRANSCRIPT_MODES__', payload });
    } catch {}
  }

  function bindModeButtons() {
    if (subtitleBtn) {
      subtitleBtn.addEventListener('click', () => {
        modes.en = !modes.en;
        sendTranscriptModes();
      });
    }

    if (subtitleTransBtn) {
      subtitleTransBtn.addEventListener('click', () => {
        modes.vi = !modes.vi;
        sendTranscriptModes();
      });
    }

    if (voiceBtn) {
      voiceBtn.addEventListener('click', () => {
        if (STT_LOCKED_MODES.voice) return;
        modes.voice = !modes.voice;
        sendTranscriptModes();
      });
    }

    if (recordBtn) {
      recordBtn.addEventListener('click', () => {
        if (STT_LOCKED_MODES.record) return;
        modes.record = !modes.record;
        sendTranscriptModes();
      });
    }
  }

  function initTranscriptLanguagePicker() {
    if (!transcriptSourceLangSelect) return;
    const selected = STT_SOURCE_LANG_ONLY;
    transcriptSourceLangSelect.value = selected;
    try { localStorage.setItem(LS_STT_SOURCE_LANG, selected); } catch {}

    transcriptSourceLangSelect.addEventListener('change', () => {
      const next = String(transcriptSourceLangSelect.value || '').toLowerCase();
      if (next !== STT_SOURCE_LANG_ONLY) {
        transcriptSourceLangSelect.value = STT_SOURCE_LANG_ONLY;
      }
      try { localStorage.setItem(LS_STT_SOURCE_LANG, STT_SOURCE_LANG_ONLY); } catch {}
    });
  }

  // ============================================================
  // VIEW SWITCHING (chỉ đổi màn giữa)
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
      closeChatConversationsPanel();
      closeRagPicker();
      closeChatRagDetailModal();
    } else {
      syncChatFocusMode();
      requestAnimationFrame(() => positionChatConversationAnchor());
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
  const realtimeSnapshotCache = {
    active: false,
    starting: false,
    seq: 0,
    tMs: 0,
    full: '',
    capturedAt: 0,
  };

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
          setRealtimeSnapshotCache({ active: false, starting: true });
          setStartActive(true);
          startInFlight = true;
          setStartLoading(true);
          // Chỉ chuyển sang play.gif khi OFFSCREEN báo running
          setPlayVisual(false);
          chrome.runtime.sendMessage(
            { __cmd: '__PANEL_START__', payload: { server: getServer() } },
            (res) => {
              if (!res?.ok) {
                setRealtimeSnapshotCache({ active: false, starting: false });
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
                Đang xử lý realtime...
              </div>`;
          }

          loggedSentCount = 0;
          updateTranscriptHeaderUrl();
          sendTranscriptModes();
          // timer & play visual sẽ bật khi nhận state 'running' từ OFFSCREEN_STATUS
        } else {
          setRealtimeSnapshotCache({ active: false, starting: false });
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
        if (server) {
          try { localStorage.setItem(LS_KEY_SERVER, server); } catch {}
          const curTrans = (localStorage.getItem(LS_KEY_TRANS_SERVER) || '').trim();
          if (!curTrans) {
            const derivedTrans = deriveTranslatorServerFromStt(server);
            if (derivedTrans) {
              try { localStorage.setItem(LS_KEY_TRANS_SERVER, derivedTrans); } catch {}
              storeSet({ [LS_KEY_TRANS_SERVER]: derivedTrans }).catch(() => {});
            }
          }
        }

        if (typeof msg.payload?.active === 'boolean') {
          const active = !!msg.payload.active;
          const starting = !!msg.payload.starting;
          setRealtimeSnapshotCache({ active, starting });

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
        if (level === 'info' && text) {
          addTranscriptRow(text, 'System • info');
        }
        if (level === 'error' && /bận|busy/i.test(text || '')) {
          showBusyModal(text || undefined);
        }
        if (level === 'error') {
          setRealtimeSnapshotCache({ active: false, starting: false });
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
          setRealtimeSnapshotCache({ active: false, starting: true });
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
          setRealtimeSnapshotCache({ active: true, starting: false });
          setStartActive(true);
          setPlayVisual(true);
          startInFlight = false;
          setStartLoading(false);
          if (transcriptLiveFooter) transcriptLiveFooter.textContent = 'Live • Đang ghi';
        }
        if (s === 'stopped' || s === 'server-busy' || s === 'server-error' || s === 'error') {
          setRealtimeSnapshotCache({ active: false, starting: false });
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
        const seq = Number(msg.payload?.seq ?? msg.seq ?? 0);
        const tMs = Number(msg.payload?.t_ms ?? msg.t_ms ?? 0);
        setRealtimeSnapshotCache({
          active: true,
          starting: false,
          seq: Number.isFinite(seq) ? seq : 0,
          tMs: Number.isFinite(tMs) ? tMs : 0,
          full,
        });
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
            setRealtimeSnapshotCache({ active, starting });

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
  // CHAT TOGGLES
  // ============================================================
  const chatToggles = {
    useRag: readBoolLS(LS_CHAT_USE_RAG, false),
    useRealtime: readBoolLS(LS_CHAT_USE_REALTIME, false),
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
    if (s === 'running') return 'Đang chạy';
    if (s === 'stopped') return 'Đã dừng';
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
    if (!clean) return 'Đang cập nhật transcript...';
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
    chatRagPickerEmpty.textContent = String(text || 'Không có dữ liệu.');
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
        `<span class="chat-rag-selection-chip${pinnedCls}" data-rag-open-id="${sid}" title="${escapeHtml(label)}">` +
        `<span class="chat-rag-selection-chip-text">${escapeHtml(label)}</span>` +
        `<button class="chat-rag-selection-remove" type="button" data-rag-remove-id="${sid}" ` +
        `aria-label="Xóa nguồn này" title="Xóa nguồn">x</button>` +
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

  function removeRagSource(sessionId) {
    const sid = Number(sessionId || 0);
    if (!sid) return;

    ragPickerState.selectedIds.delete(sid);
    ragPickerState.pinnedIds.delete(sid);
    chatToggles.useRag = ragPickerState.pinnedIds.size > 0;
    applyChatTogglesUI();

    if (isRagPickerOpen()) renderRagPickerList();
    else renderChatRagSelectionBar();
  }

  function renderRagPickerList() {
    if (!chatRagPickerList) return;
    chatRagPickerList.innerHTML = '';

    if (!ragPickerState.filtered.length) {
      setRagPickerEmpty('Không tìm thấy transcript phù hợp.', true);
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
            ${escapeHtml(`Tổng thời gian: ${ragFormatDurationMs(ragCalcDurationMs(item))} - Trạng thái: ${ragStatusLabel(item?.status)}${pinned ? ' - Đã chốt' : ''}`)}
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
      setRagPickerEmpty('Không có chrome.runtime.', true);
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
        setRagPickerEmpty('Bạn cần đăng nhập để xem transcript history.', true);
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
            ? `Không tìm thấy user id hợp lệ cho tài khoản hiện tại.\n[debug] ${dbg}`
            : 'Không tìm thấy user id hợp lệ cho tài khoản hiện tại.',
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
        setRagPickerEmpty('Chưa có transcript nào được lưu.', true);
      }
    } catch (e) {
      ragPickerState.items = [];
      ragPickerState.filtered = [];
      ragPickerState.loaded = false;
      renderRagPickerList();
      setRagPickerEmpty(`Không tải được transcript history: ${String(e?.message || e)}`, true);
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
        `Website: ${item?.tab_url || ragDomainFrom(item)} - Bắt đầu: ${ragFormatDateTime(item?.started_at)} - Tổng thời gian: ${ragFormatDurationMs(ragCalcDurationMs(item))}`;
    }
    if (chatRagDetailContent) chatRagDetailContent.textContent = 'Đang tải nội dung transcript...';
    document.body.classList.add('history-modal-open');
  }

  function fillChatRagDetail(item, fullText) {
    if (!chatRagDetailModal) return;
    if (chatRagDetailTitle) chatRagDetailTitle.textContent = ragDomainFrom(item);
    if (chatRagDetailMeta) {
      chatRagDetailMeta.textContent =
        `Website: ${item?.tab_url || ragDomainFrom(item)} - Bắt đầu: ${ragFormatDateTime(item?.started_at)} - Tổng thời gian: ${ragFormatDurationMs(ragCalcDurationMs(item))}`;
    }
    if (chatRagDetailContent) {
      chatRagDetailContent.textContent = String(fullText || 'Đang cập nhật transcript...');
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
              ? `Không tìm thấy user id hợp lệ cho tài khoản hiện tại.\n\n[debug] ${dbg}`
              : 'Không tìm thấy user id hợp lệ cho tài khoản hiện tại.';
          })(),
        };
      }
      if (!res?.ok) {
        return {
          ok: false,
          code: 'DETAIL_FAILED',
          item: baseItem,
          fullText: `Không tải được transcript: ${String(res?.error || 'DETAIL_FAILED')}`,
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
        fullText: `Không tải được transcript: ${String(e?.message || e)}`,
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
      fillChatRagDetail(baseItem, 'Không tải được nội dung transcript.');
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

    if (chatRagSelectionBar) {
      chatRagSelectionBar.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('[data-rag-remove-id]');
        if (!btn) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        const sid = Number(btn.getAttribute('data-rag-remove-id') || 0);
        if (!sid) return;
        removeRagSource(sid);
      });

      chatRagSelectionBar.addEventListener('click', (e) => {
        const chip = e.target?.closest?.('[data-rag-open-id]');
        if (!chip) return;
        if (e.target?.closest?.('[data-rag-remove-id]')) return;
        e.preventDefault?.();
        const sid = Number(chip.getAttribute('data-rag-open-id') || 0);
        if (!sid) return;
        openChatRagDetail(sid);
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
      positionChatConversationAnchor();
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
    if (chipRealtime) chipRealtime.classList.toggle('active', !!chatToggles.useRealtime);
    if (chipR1) chipR1.classList.toggle('active', !!chatToggles.useR1);
    writeBoolLS(LS_CHAT_USE_RAG, !!chatToggles.useRag);
    writeBoolLS(LS_CHAT_USE_REALTIME, !!chatToggles.useRealtime);
    writeBoolLS(LS_CHAT_USE_R1, !!chatToggles.useR1);
    updateRagPickerPinUi();
  }

  if (chipRealtime) chipRealtime.addEventListener('click', () => {
    chatToggles.useRealtime = !chatToggles.useRealtime;
    applyChatTogglesUI();
    if (chatToggles.useRealtime) {
      refreshRealtimeSnapshotCache().catch((e) => dlog('refreshRealtimeSnapshotCache failed:', e));
    }
  });

  if (chipR1) chipR1.addEventListener('click', () => {
    chatToggles.useR1 = !chatToggles.useR1;
    applyChatTogglesUI();
  });

  // ============================================================
  // Smart rewrite (giữ nguyên logic của bạn)
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
  // Chat UI
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

  function ensureChatEmptyHint() {
    if (!chatHistory) return;
    let hint = chatHistory.querySelector('.chat-empty-hint');
    if (hint) return;
    hint = document.createElement('div');
    hint.className = 'chat-empty-hint';
    hint.innerHTML = '<p class="chat-empty-hint-text">Tôi có thể giúp gì cho bạn?</p>';
    chatHistory.prepend(hint);
  }

  function positionChatConversationAnchor() {
    if (!chatView || !chatHistory) return;
    if (typeof chatView.getBoundingClientRect !== 'function') return;
    if (typeof chatHistory.getBoundingClientRect !== 'function') return;

    const viewRect = chatView.getBoundingClientRect();
    const historyRect = chatHistory.getBoundingClientRect();
    if (viewRect.width <= 0 || viewRect.height <= 0) return;
    if (historyRect.width <= 0 || historyRect.height <= 0) return;

    const left = Math.max(8, Math.round(historyRect.left - viewRect.left + 8));
    const top = Math.max(8, Math.round(historyRect.top - viewRect.top + 8));
    chatView.style.setProperty('--chat-conv-anchor-left', `${left}px`);
    chatView.style.setProperty('--chat-conv-anchor-top', `${top}px`);

    if (chatConversationsPanel) {
      const maxW = Math.max(220, Math.round(historyRect.width - 12));
      const width = Math.min(360, maxW);
      chatConversationsPanel.style.width = `${width}px`;
    }
  }

  function syncChatFocusMode() {
    if (!chatView || !chatHistory) return;
    const hasMessages = chatHistory.querySelector('.msg-row') !== null;
    const hint = chatHistory.querySelector('.chat-empty-hint');
    if (hasMessages) {
      if (hint) hint.remove();
    } else if (!hint) {
      ensureChatEmptyHint();
    }
    chatView.classList.toggle('focus-mode', hasMessages);
    positionChatConversationAnchor();
  }

  async function getCurrentChatIdentityKey() {
    const profile = await getVtAuthProfile();
    const key = normalizeIdentityKey(authIdentityKeyFromProfile(profile) || 'guest');
    return key || 'guest';
  }

  function collectConversationRowsForIdentity(identityKey) {
    const wanted = normalizeIdentityKey(identityKey || 'guest') || 'guest';
    const histMap = readChatHistoryMap();
    const metaMap = readChatSessionMetaMap();
    const allSessionIds = [...new Set([...Object.keys(histMap), ...Object.keys(metaMap)])];
    const rows = [];

    for (const sid of allSessionIds) {
      const sessionId = String(sid || '').trim();
      if (!sessionId) continue;

      const items = getChatHistoryItems(sessionId);
      const meta = (metaMap[sessionId] && typeof metaMap[sessionId] === 'object') ? metaMap[sessionId] : {};
      const rowIdentity = normalizeIdentityKey(meta.identityKey || '');

      // Keep per-user list: strict when row has explicit identity; legacy rows (empty identity) stay visible.
      if (wanted !== 'guest') {
        if (rowIdentity && rowIdentity !== wanted) continue;
      } else if (rowIdentity && rowIdentity !== 'guest') {
        continue;
      }

      const hasAssistantReply = items.some(
        (x) => x?.who === 'assistant' && String(x?.text || '').trim()
      );
      if (!hasAssistantReply) continue;

      const firstUser = items.find((x) => x?.who === 'user' && String(x?.text || '').trim());
      const lastMsg = items.length ? items[items.length - 1] : null;
      const title = chatClipText(
        meta.title || firstUser?.text || lastMsg?.text || 'Cuộc trò chuyện mới',
        72
      );
      const preview = chatClipText(meta.preview || lastMsg?.text || '', 110);
      const updatedAt = String(meta.updatedAt || '');
      const createdAt = String(meta.createdAt || '');
      const updatedMs = parseDateMs(updatedAt) || parseDateMs(createdAt) || 0;
      const messageCount = Math.max(0, Number(meta.messageCount || items.length || 0) || 0);

      rows.push({
        sessionId,
        title,
        preview,
        timeLabel: formatConversationTime(updatedAt || createdAt),
        updatedMs,
        messageCount,
      });
    }

    rows.sort((a, b) => b.updatedMs - a.updatedMs || String(b.sessionId).localeCompare(String(a.sessionId)));
    return rows.slice(0, CHAT_CONV_LIST_MAX);
  }

  function renderChatConversations(identityKey = '') {
    if (!chatConversationsList || !chatConversationsEmpty) return;
    const rows = collectConversationRowsForIdentity(identityKey || chatConversationsState.identityKey || 'guest');
    const currentSid = getSessionId();

    if (!rows.length) {
      chatConversationsList.innerHTML = '';
      chatConversationsEmpty.classList.remove('hidden');
      return;
    }

    chatConversationsEmpty.classList.add('hidden');
    chatConversationsList.innerHTML = rows
      .map((row) => {
        const activeCls = row.sessionId === currentSid ? ' active' : '';
        const previewHtml = row.preview
          ? `<p class="chat-conv-item-preview">${escapeHtml(row.preview)}</p>`
          : '';
        const timeHtml = row.timeLabel
          ? `<div class="chat-conv-item-time">${escapeHtml(row.timeLabel)}${row.messageCount ? ` • ${row.messageCount}` : ''}</div>`
          : '';
        return (
          `<div class="chat-conv-row${activeCls}" data-chat-conv-row="${escapeHtml(row.sessionId)}">` +
          `<button class="chat-conv-item${activeCls}" type="button" data-chat-session-id="${escapeHtml(row.sessionId)}">` +
          `<p class="chat-conv-item-title">${escapeHtml(row.title || 'Cuộc trò chuyện')}</p>` +
          `${previewHtml}${timeHtml}</button>` +
          `<button class="chat-conv-delete-btn" type="button" data-chat-delete-session-id="${escapeHtml(row.sessionId)}" ` +
          `aria-label="Xóa cuộc trò chuyện" title="Xóa cuộc trò chuyện">&times;</button>` +
          `</div>`
        );
      })
      .join('');
  }
  function syncConversationPanelAfterHistoryChange() {
    if (!chatConversationsState.open) return;
    renderChatConversations(chatConversationsState.identityKey || 'guest');
  }

  function closeChatConversationsPanel() {
    chatConversationsState.open = false;
    if (chatConversationsPanel) {
      chatConversationsPanel.classList.add('hidden');
      chatConversationsPanel.setAttribute('aria-hidden', 'true');
    }
    if (chatConversationsToggle) {
      chatConversationsToggle.classList.remove('active');
      chatConversationsToggle.setAttribute('aria-expanded', 'false');
    }
  }

  async function openChatConversationsPanel() {
    if (!chatConversationsPanel || !chatConversationsToggle) return;
    positionChatConversationAnchor();
    chatConversationsState.identityKey = await getCurrentChatIdentityKey();
    renderChatConversations(chatConversationsState.identityKey);
    chatConversationsState.open = true;
    chatConversationsPanel.classList.remove('hidden');
    chatConversationsPanel.setAttribute('aria-hidden', 'false');
    chatConversationsToggle.classList.add('active');
    chatConversationsToggle.setAttribute('aria-expanded', 'true');
  }

  async function toggleChatConversationsPanel() {
    if (chatConversationsState.open) {
      closeChatConversationsPanel();
      return;
    }
    await openChatConversationsPanel();
  }

  function switchChatSession(sessionId, opts = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    try {
      localStorage.setItem(LS_CHAT_SESSION, sid);
    } catch {}
    restoreChatHistory();
    renderChatConversations(chatConversationsState.identityKey || 'guest');
    if (opts.focusInput && chatTextArea) chatTextArea.focus();
    if (opts.closePanel !== false) closeChatConversationsPanel();
  }

  function isChatDeleteModalOpen() {
    return !!(chatDeleteModal && !chatDeleteModal.classList.contains('hidden'));
  }

  function setChatDeleteModalBusy(on) {
    const busy = !!on;
    chatDeleteState.submitting = busy;
    if (chatDeleteConfirmBtn) chatDeleteConfirmBtn.disabled = busy;
    if (chatDeleteCancelBtn) chatDeleteCancelBtn.disabled = busy;
    if (chatDeleteClose) chatDeleteClose.disabled = busy;
  }

  function closeChatDeleteModal(opts = {}) {
    const force = !!opts.force;
    if (!chatDeleteModal) return;
    if (chatDeleteState.submitting && !force) return;
    setChatDeleteModalBusy(false);
    chatDeleteModal.classList.add('hidden');
    chatDeleteModal.setAttribute('aria-hidden', 'true');
    chatDeleteState.sessionId = '';
    chatDeleteState.label = '';
    if (chatDeleteMeta) chatDeleteMeta.textContent = '';
    if (chatDeleteText) {
      chatDeleteText.textContent = 'Bạn có chắc chắn muốn xóa cuộc trò chuyện này không? Hành động này không thể hoàn tác.';
    }
  }

  async function openChatDeleteModal(sessionId, label = '') {
    const sid = String(sessionId || '').trim();
    if (!sid || !chatDeleteModal) return;

    const identityKey = chatConversationsState.identityKey || await getCurrentChatIdentityKey();
    chatConversationsState.identityKey = identityKey;
    const rows = collectConversationRowsForIdentity(identityKey);
    const row = rows.find((x) => x.sessionId === sid) || null;
    const finalLabel = String(label || row?.title || 'Cuộc trò chuyện').trim();

    chatDeleteState.sessionId = sid;
    chatDeleteState.label = finalLabel;
    setChatDeleteModalBusy(false);
    if (chatDeleteMeta) chatDeleteMeta.textContent = finalLabel;
    if (chatDeleteText) {
      chatDeleteText.textContent = `Bạn có chắc chắn muốn xóa "${finalLabel}" không? Hành động này không thể hoàn tác.`;
    }
    chatDeleteModal.classList.remove('hidden');
    chatDeleteModal.setAttribute('aria-hidden', 'false');
  }

  async function submitChatDeleteModal() {
    const sid = String(chatDeleteState.sessionId || '').trim();
    if (!sid || chatDeleteState.submitting) return;
    setChatDeleteModalBusy(true);
    try {
      const deleted = await deleteChatConversation(sid, { focusInput: false });
      if (!deleted) throw new Error('DELETE_CHAT_FAILED');
      closeChatDeleteModal({ force: true });
    } catch (err) {
      if (chatDeleteText) {
        chatDeleteText.textContent = `Xóa cuộc trò chuyện thất bại: ${String(err?.message || err)}`;
      }
      dlog('submitChatDeleteModal failed:', err);
      setChatDeleteModalBusy(false);
    }
  }

  async function deleteChatConversation(sessionId, opts = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;

    const identityKey = chatConversationsState.identityKey || await getCurrentChatIdentityKey();
    chatConversationsState.identityKey = identityKey;

    deleteChatConversationData(sid);

    if (getSessionId() === sid) {
      const remainRows = collectConversationRowsForIdentity(identityKey);
      const nextSid = remainRows[0]?.sessionId || ('sess_' + uid());
      try {
        localStorage.setItem(LS_CHAT_SESSION, nextSid);
      } catch {}
      restoreChatHistory();
    }

    renderChatConversations(identityKey);
    if (opts.focusInput !== false && chatTextArea) chatTextArea.focus();
    return true;
  }

  async function createNewChatConversation() {
    const sid = 'sess_' + uid();
    try {
      localStorage.setItem(LS_CHAT_SESSION, sid);
    } catch {}
    const identityKey = chatConversationsState.identityKey || await getCurrentChatIdentityKey();
    chatConversationsState.identityKey = identityKey;
    restoreChatHistory();
    renderChatConversations(identityKey);
    closeChatConversationsPanel();
    if (chatTextArea) chatTextArea.focus();
  }

  function bindChatConversationsUi() {
    if (chatConversationsToggle) {
      chatConversationsToggle.addEventListener('click', (e) => {
        e.preventDefault?.();
        toggleChatConversationsPanel();
      });
    }

    if (chatConversationsNewBtn) {
      chatConversationsNewBtn.addEventListener('click', () => {
        createNewChatConversation().catch((err) => dlog('createNewChatConversation failed:', err));
      });
    }

    if (chatConversationsList) {
      chatConversationsList.addEventListener('click', (e) => {
        const deleteBtn = e.target?.closest?.('[data-chat-delete-session-id]');
        if (deleteBtn) {
          const delSid = String(deleteBtn.getAttribute('data-chat-delete-session-id') || '').trim();
          if (!delSid) return;
          const rowEl = deleteBtn.closest('[data-chat-conv-row]');
          const titleEl = rowEl?.querySelector?.('.chat-conv-item-title');
          const title = String(titleEl?.textContent || '').trim();
          openChatDeleteModal(delSid, title)
            .catch((err) => dlog('openChatDeleteModal failed:', err));
          return;
        }
        const row = e.target?.closest?.('[data-chat-session-id]');
        if (!row) return;
        const sid = String(row.getAttribute('data-chat-session-id') || '').trim();
        if (!sid) return;
        switchChatSession(sid, { focusInput: true, closePanel: true });
      });
    }

    document.addEventListener('mousedown', (e) => {
      if (!chatConversationsState.open) return;
      const tgt = e.target;
      if (!tgt) return;
      if (isChatDeleteModalOpen()) return;
      if (chatConversationsPanel && chatConversationsPanel.contains(tgt)) return;
      if (chatConversationsToggle && chatConversationsToggle.contains(tgt)) return;
      closeChatConversationsPanel();
    });

    if (chatDeleteModal) {
      chatDeleteModal.addEventListener('click', (e) => {
        const tgt = e.target;
        if (!tgt) return;
        if (tgt.closest?.('[data-chat-delete-close="1"]')) closeChatDeleteModal();
      });
    }
    if (chatDeleteClose) chatDeleteClose.addEventListener('click', () => closeChatDeleteModal());
    if (chatDeleteCancelBtn) chatDeleteCancelBtn.addEventListener('click', () => closeChatDeleteModal());
    if (chatDeleteConfirmBtn) {
      chatDeleteConfirmBtn.addEventListener('click', () => {
        submitChatDeleteModal().catch((err) => dlog('submitChatDeleteModal failed:', err));
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (isChatDeleteModalOpen()) {
        closeChatDeleteModal();
        return;
      }
      if (chatConversationsState.open) closeChatConversationsPanel();
    });
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
          if (assistBubble) {
            const currentText = String(assistBubble.textContent || '').trim();
            if (currentText === '...' || currentText === '\u2026') {
              assistBubble.textContent = '';
            }
          }
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

  function clipRealtimeSnapshotText(text, maxLen = 6000) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (raw.length <= maxLen) return raw;
    return `...${raw.slice(-maxLen)}`;
  }

  function cloneRealtimeSnapshot(snapshot = realtimeSnapshotCache) {
    const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
      active: !!src.active,
      starting: !!src.starting,
      seq: Number(src.seq || 0),
      tMs: Number(src.tMs || 0),
      full: clipRealtimeSnapshotText(src.full, 6000),
      capturedAt: Number(src.capturedAt || 0),
    };
  }

  function setRealtimeSnapshotCache(patch = {}) {
    if (!patch || typeof patch !== 'object') return cloneRealtimeSnapshot(realtimeSnapshotCache);
    const next = {
      active: Object.prototype.hasOwnProperty.call(patch, 'active')
        ? !!patch.active
        : !!realtimeSnapshotCache.active,
      starting: Object.prototype.hasOwnProperty.call(patch, 'starting')
        ? !!patch.starting
        : !!realtimeSnapshotCache.starting,
      seq: Object.prototype.hasOwnProperty.call(patch, 'seq')
        ? Number(patch.seq || 0)
        : Number(realtimeSnapshotCache.seq || 0),
      tMs: Object.prototype.hasOwnProperty.call(patch, 'tMs')
        ? Number(patch.tMs || 0)
        : Number(realtimeSnapshotCache.tMs || 0),
      full: Object.prototype.hasOwnProperty.call(patch, 'full')
        ? clipRealtimeSnapshotText(patch.full, 6000)
        : clipRealtimeSnapshotText(realtimeSnapshotCache.full, 6000),
      capturedAt: Date.now(),
    };
    realtimeSnapshotCache.active = !!next.active;
    realtimeSnapshotCache.starting = !!next.starting;
    realtimeSnapshotCache.seq = Number.isFinite(next.seq) ? next.seq : 0;
    realtimeSnapshotCache.tMs = Number.isFinite(next.tMs) ? next.tMs : 0;
    realtimeSnapshotCache.full = String(next.full || '');
    realtimeSnapshotCache.capturedAt = Number.isFinite(next.capturedAt) ? next.capturedAt : 0;
    return cloneRealtimeSnapshot(realtimeSnapshotCache);
  }

  async function refreshRealtimeSnapshotCache() {
    try {
      const snap = await getRealtimeTranscriptSnapshot();
      if (snap) return setRealtimeSnapshotCache(snap);
    } catch {}
    return cloneRealtimeSnapshot(realtimeSnapshotCache);
  }

  function captureRealtimeSnapshotForSend() {
    return cloneRealtimeSnapshot(realtimeSnapshotCache);
  }

  async function getRealtimeTranscriptSnapshot() {
    const res = await sendRuntime({ __cmd: '__CHAT_REALTIME_SNAPSHOT__' });
    if (!res?.ok) return null;
    return {
      active: !!res.active,
      starting: !!res.starting,
      seq: Number(res.seq || 0),
      tMs: Number(res.t_ms || 0),
      full: clipRealtimeSnapshotText(res.full, 6000),
      capturedAt: Date.now(),
    };
  }

  function buildRealtimeContextBlock(snapshot) {
    if (!snapshot?.full) return '';
    const status = snapshot.active ? 'running' : (snapshot.starting ? 'starting' : 'idle');
    return [
      '[Realtime transcript snapshot]',
      `status: ${status}`,
      `seq: ${snapshot.seq}`,
      `t_ms: ${snapshot.tMs}`,
      `captured_at_ms: ${Number(snapshot.capturedAt || 0)}`,
      snapshot.full,
    ].join('\n');
  }

  async function sendChat(question) {
    if (!question || !question.trim()) return;

    const rawUserQ = question.trim();
    const sid = getSessionId();
    const frozenRealtimeSnapshot = chatToggles.useRealtime ? captureRealtimeSnapshotForSend() : null;

    const profile = await getVtAuthProfile();
    const ok = !!(profile && (profile.email || profile.id || profile.name || profile.full_name));
    if (!ok) {
      openAuthOverlayFromPanel();
      appendBubble('assistant', 'Bạn cần đăng nhập để dùng Chat.', nowTime());
      return;
    }

    const authIdentityKey = authIdentityKeyFromProfile(profile);
    const modelTag = chatToggles.useR1 ? 'r1' : 'default';
    const langTag = 'vi';

    const userMeta = nowTime();
    appendBubble('user', rawUserQ, userMeta);

    const assistBubble = appendBubble('assistant', '...');
    const apiBase = getApiBase();
    let useRag = !!chatToggles.useRag;

    const okBase = await probeApiBase(apiBase);
    if (!okBase) {
      const errText = `Không kết nối được API ở ${apiBase}. Mở Setting để nhập đúng base (vd: http://127.0.0.1:8000).`;
      if (assistBubble) assistBubble.textContent = errText;
      return;
    }

    let pinnedContext = '';
    try {
      pinnedContext = await buildPinnedRagContextBlock();
    } catch (e) {
      dlog('buildPinnedRagContextBlock failed:', e);
    }
    if (pinnedContext && !useRag) useRag = true;

    const realtimeSnapshot = frozenRealtimeSnapshot;
    let realtimeContext = '';
    if (chatToggles.useRealtime) {
      realtimeContext = buildRealtimeContextBlock(realtimeSnapshot);
    }
    if (realtimeContext && !useRag) useRag = true;

    const selectedContextParts = [];
    if (pinnedContext) selectedContextParts.push(pinnedContext);
    if (realtimeContext) selectedContextParts.push(realtimeContext);
    const selectedContext = selectedContextParts.join('\n\n');

    const pinnedCount = ragPickerState.pinnedIds.size;
    const metaLine = `${nowTime()}${useRag ? ' | RAG: ON' : ' | RAG: OFF'}${pinnedCount ? ` | PIN: ${pinnedCount}` : ''}`;
    const metaLineOut = `${metaLine}${chatToggles.useRealtime ? (realtimeContext ? ' | RT: ON' : ' | RT: EMPTY') : ''}`;

    const selectedSourceIds = [...ragPickerState.pinnedIds];
    const q0Raw = buildQuestionToServer(rawUserQ, useRag, 0);
    const body0 = { question: q0Raw, session_id: sid, user_id: 'sidepanel', use_rag: useRag };
    if (selectedContext) body0.selected_context = selectedContext;
    if (selectedSourceIds.length) body0.selected_source_ids = selectedSourceIds;

    dlog('apiBase', apiBase);
    dlog('Q0 sent:', q0Raw);
    dlog('selected_source_ids:', selectedSourceIds);
    dlog('realtime_snapshot:', realtimeSnapshot ? {
      active: !!realtimeSnapshot.active,
      starting: !!realtimeSnapshot.starting,
      seq: Number(realtimeSnapshot.seq || 0),
      tMs: Number(realtimeSnapshot.tMs || 0),
      hasText: !!realtimeContext,
      capturedAt: Number(realtimeSnapshot.capturedAt || 0),
    } : null);

    let out0 = '';
    try {
      out0 = await callChatOnce(apiBase, body0, assistBubble);

      if (useRag && looksLikeBoilerplateAnswer(out0)) {
        if (assistBubble) assistBubble.textContent = '... (retry)';
        const q1Raw = buildQuestionToServer(rawUserQ, useRag, 1);
        const body1 = { question: q1Raw, session_id: sid, user_id: 'sidepanel', use_rag: useRag };
        if (selectedContext) body1.selected_context = selectedContext;
        if (selectedSourceIds.length) body1.selected_source_ids = selectedSourceIds;
        dlog('Q1 retry:', q1Raw);
        out0 = await callChatOnce(apiBase, body1, assistBubble);
      }

      out0 = String(out0 || '').trim();
      if (!out0) throw new Error('EMPTY_ASSISTANT_RESPONSE');

      if (assistBubble) {
        const extra = isDebug()
          ? `\n\n[sent]\n${(useRag ? (looksLikeBoilerplateAnswer(out0) ? 'retry' : 'ok') : 'no-rag')}`
          : '';
        assistBubble.innerHTML =
          escapeHtml(out0 + extra) +
          `<span class="meta">${escapeHtml(metaLineOut)}</span>`;
      }

      pushChatHistoryItem('user', rawUserQ, userMeta, {
        sessionId: sid,
        identityKey: authIdentityKey,
        titleHint: rawUserQ,
      });
      pushChatHistoryItem('assistant', out0, metaLineOut, {
        sessionId: sid,
        identityKey: authIdentityKey,
        titleHint: rawUserQ,
      });

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
      const errText = `Lỗi: ${String(err)}`;
      if (assistBubble) assistBubble.textContent = errText;
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
  initTranscriptLanguagePicker();
  bindModeButtons();
  applyModesToUI();
  sendTranscriptModes();

  bindRagPickerEvents();
  bindChatConversationsUi();
  bindChatHistoryScrollbarAutoHide();
  applyChatTogglesUI();
  if (chatToggles.useRealtime) {
    refreshRealtimeSnapshotCache().catch((e) => dlog('refreshRealtimeSnapshotCache init failed:', e));
  }
  updateRagPickerPinUi();
  (async () => {
    await rotateChatSessionIfRuntimeChanged();
    restoreChatHistory();
  })();
});
