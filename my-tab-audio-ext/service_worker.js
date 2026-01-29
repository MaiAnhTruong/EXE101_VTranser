// service_worker.js — điều phối Offscreen/Overlay/Panel + proxy REST cho chatbot (__CHAT_REST__)
// + Translator WS (VI) chỉ connect khi bật "Dịch phụ đề" và đang chạy capture.

// -------------------- Global state --------------------
let current = null; // { tabId, server, startedAt, panelOpen }
let currentModes = { en: false, vi: false, voice: false };

// User "muốn" dịch VI hay không (từ UI). KHÔNG đồng nghĩa đang kết nối.
let wantTranslateVI = false;

const offscreenUrl = chrome.runtime.getURL('offscreen.html');

// -------------------- Side Panel behavior (FIX) --------------------
function ensureSidePanelBehavior() {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      chrome.sidePanel
        .setPanelBehavior({ openPanelOnActionClick: true })
        .catch((e) => console.warn('setPanelBehavior failed', e));
    }
  } catch (e) {
    console.warn('ensureSidePanelBehavior error', e);
  }
}

ensureSidePanelBehavior();
chrome.runtime.onInstalled.addListener(() => ensureSidePanelBehavior());

// -------------------- Offscreen --------------------
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Process tab audio, audio worklet, WebSocket STT',
    });
  }
}

// -------------------- Overlay --------------------
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['overlay.css'] });
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
  } catch {}
  try {
    await chrome.tabs.sendMessage(tabId, { __cmd: '__OVERLAY_RESET__' });
  } catch {}
}

async function removeOverlay(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { __cmd: '__OVERLAY_TEARDOWN__' });
  } catch {}
  try {
    await chrome.scripting.removeCSS({ target: { tabId }, files: ['overlay.css'] });
  } catch {}
}

// -------------------- In-page Panel (inject vào tab) --------------------
async function injectPanel(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['panel.css'] });
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['panel.js'] });
  try {
    await chrome.tabs.sendMessage(tabId, { __cmd: '__PANEL_MOUNT__' });
  } catch {}
}

async function removePanel(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { __cmd: '__PANEL_TEARDOWN__' });
  } catch {}
  try {
    await chrome.scripting.removeCSS({ target: { tabId }, files: ['panel.css'] });
  } catch {}
}

// -------------------- Capture --------------------
async function startCaptureOnTab(tabId, server) {
  if (!server) return;
  await ensureOffscreen();

  const tab = await chrome.tabs.get(tabId);
  const url = tab?.url || '';

  const isForbidden =
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('chrome-untrusted://') ||
    url.startsWith('devtools://') ||
    /^https?:\/\/chrome\.google\.com\/webstore\//i.test(url);

  if (isForbidden) {
    throw new Error(
      'Không thể capture âm thanh từ tab hệ thống (chrome://, Chrome Web Store, trang cài đặt, devtools...). ' +
        'Hãy mở video/audio trên website bình thường (youtube.com, v.v.).'
    );
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    console.error('tabCapture.getMediaStreamId error', e);
    throw e;
  }

  await chrome.runtime.sendMessage({
    __cmd: '__OFFSCREEN_START__',
    payload: { streamId, server },
  });

  current = { tabId, server, startedAt: Date.now(), panelOpen: true };

  // Sau khi bắt đầu capture, nếu user đang bật "Dịch phụ đề" => mới connect translator
  maybeUpdateTranslator();
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ __cmd: '__OFFSCREEN_STOP__' });
  if (current) current.startedAt = null;

  // Stop capture => chắc chắn ngắt translator
  maybeUpdateTranslator(true);
}

// -------------------- Open/Close in-page panel --------------------
async function openPanel(tabId) {
  await injectPanel(tabId);
  await injectOverlay(tabId);
  current = current || { tabId, server: null, startedAt: null, panelOpen: true };
  current.tabId = tabId;
  current.panelOpen = true;

  try {
    await chrome.tabs.sendMessage(tabId, {
      __cmd: '__PANEL_OPENED__',
      payload: {
        server: current.server || 'ws://127.0.0.1:8765',
        active: !!current.startedAt,
      },
    });
  } catch {}
}

async function closePanel(tabId) {
  await removePanel(tabId);
  await removeOverlay(tabId);
  if (current && current.tabId === tabId) current.panelOpen = false;
}

// -------------------- Browser action (CLICK ICON) --------------------
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null || tab.windowId == null) return;

  current = current || { tabId: tab.id, server: null, startedAt: null, panelOpen: false };
  current.tabId = tab.id;

  try {
    chrome.sidePanel?.setOptions?.({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: true,
    });
  } catch {}

  if (!chrome.sidePanel?.setPanelBehavior && chrome.sidePanel?.open) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch((e) => console.error('open sidepanel failed (fallback)', e));
  }
});

// -------------------- Translator WS (VI) — LAZY --------------------
let transWs = null;
let transUrl = 'ws://127.0.0.1:8787';
let transBackoffMs = 500;
let transReconnectTimer = null;

// Khi true => bắt buộc disconnect và hủy timer
function disconnectTranslator(hard = false) {
  try { if (transReconnectTimer) clearTimeout(transReconnectTimer); } catch {}
  transReconnectTimer = null;

  try {
    if (transWs) {
      transWs.onopen = null;
      transWs.onmessage = null;
      transWs.onclose = null;
      transWs.onerror = null;
      try { transWs.close(); } catch {}
    }
  } catch {}
  transWs = null;

  if (hard) {
    transBackoffMs = 500;
  }
}

function shouldTranslateNow() {
  // Chỉ connect translate khi:
  // - user bật "Dịch phụ đề"
  // - đang capture/transcript (startedAt != null)
  // - có tabId để relay
  return !!(wantTranslateVI && current?.tabId && current?.startedAt);
}

function scheduleTranslatorReconnect() {
  if (!shouldTranslateNow()) return;

  const delay = Math.min(5000, transBackoffMs);
  transReconnectTimer = setTimeout(connectTranslator, delay);
  transBackoffMs = Math.min(5000, transBackoffMs * 2);
}

function connectTranslator() {
  if (!shouldTranslateNow()) return;

  disconnectTranslator(false);

  try {
    const ws = new WebSocket(transUrl);
    transWs = ws;

    ws.onopen = () => {
      transBackoffMs = 500;
    };

    ws.onmessage = async (ev) => {
      if (typeof ev.data !== 'string') return;

      let obj = null;
      try { obj = JSON.parse(ev.data); } catch { return; }
      if (!obj || !obj.type) return;

      if (!current?.tabId) return;

      try {
        if (obj.type === 'vi-delta' && typeof obj.append === 'string') {
          await chrome.tabs.sendMessage(current.tabId, {
            __cmd: '__TRANS_VI_DELTA__',
            payload: { append: obj.append },
          });
        } else if (obj.type === 'vi-stable' && typeof obj.full === 'string') {
          await chrome.tabs.sendMessage(current.tabId, {
            __cmd: '__TRANS_VI_STABLE__',
            payload: { full: obj.full },
          });
        }
      } catch {}
    };

    ws.onclose = () => {
      // Chỉ reconnect nếu vẫn đang cần translate
      if (shouldTranslateNow()) scheduleTranslatorReconnect();
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  } catch {
    scheduleTranslatorReconnect();
  }
}

// Gọi khi có thay đổi mode/capture
function maybeUpdateTranslator(forceStop = false) {
  if (forceStop || !shouldTranslateNow()) {
    disconnectTranslator(true);
    return;
  }
  // shouldTranslateNow() = true
  if (!transWs) connectTranslator();
}

// -------------------- Helpers: normalize modes từ sidepanel --------------------
function normalizeModes(raw) {
  const m = raw || {};
  const en = !!(m.en ?? m.subtitle ?? m.caption ?? m.phude);
  const vi = !!(m.vi ?? m.subtitle_vi ?? m.translate ?? m.dichphude);
  const voice = !!(m.voice ?? m.tts ?? m.giongnoi);
  return { en, vi, voice };
}

// -------------------- Message bus --------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.__cmd) return;

    // status từ offscreen -> relay tới tab
    if (msg.__cmd === '__OFFSCREEN_STATUS__') {
      if (current?.tabId) {
        try { await chrome.tabs.sendMessage(current.tabId, msg); } catch {}
      }
      return;
    }

    // relay transcript EN tới overlay/panel
    if (
      msg.__cmd === '__TRANSCRIPT_DELTA__' ||
      msg.__cmd === '__TRANSCRIPT_STABLE__' ||
      msg.__cmd === '__TRANSCRIPT_PATCH__'
    ) {
      if (current?.tabId) {
        try { await chrome.tabs.sendMessage(current.tabId, msg); } catch {}
      }
      return;
    }

    // Toggle in-page panel (inject)
    if (msg.__cmd === '__PANEL_TOGGLE__') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse?.({ ok: false });
        return;
      }
      if (!current || current.tabId !== tab.id || !current.panelOpen) await openPanel(tab.id);
      else await closePanel(tab.id);

      sendResponse?.({ ok: true, open: !!(current && current.panelOpen) });
      return;
    }

    // Panel Start
    if (msg.__cmd === '__PANEL_START__') {
      const server = (msg.payload?.server || '').trim();
      if (!server) {
        sendResponse?.({ ok: false, error: 'Missing server' });
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse?.({ ok: false, error: 'No active tab' });
        return;
      }

      try {
        await injectOverlay(tab.id);
        await startCaptureOnTab(tab.id, server);

        current.server = server;
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e) });
      }
      return;
    }

    // Panel Stop
    if (msg.__cmd === '__PANEL_STOP__') {
      await stopCapture();
      sendResponse?.({ ok: true });
      return;
    }

    // overlay ping – overlay mới load xong, xin trạng thái
    if (msg.__cmd === '__OVERLAY_PING__') {
      const tabId = (sender && sender.tab && sender.tab.id) || current?.tabId || null;

      if (tabId != null) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            __cmd: '__OVERLAY_MODE__',
            payload: currentModes,
          });
        } catch (e) {
          console.warn('__OVERLAY_PING__ send overlay-mode failed', e);
        }
      }

      sendResponse?.({
        ok: true,
        active: !!current?.startedAt,
        tabId: current?.tabId || null,
        modes: currentModes,
      });
      return;
    }

    // nhận mode Phụ đề / Dịch phụ đề / Giọng nói từ sidepanel
    if (msg.__cmd === '__TRANSCRIPT_MODES__') {
      const modes = normalizeModes(msg.payload);

      currentModes = modes;
      wantTranslateVI = !!modes.vi;

      // cập nhật overlay mode
      const tabId = current?.tabId ?? null;
      if (tabId != null) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            __cmd: '__OVERLAY_MODE__',
            payload: currentModes,
          });
        } catch {}
      }

      // cập nhật translator connect/disconnect (quan trọng)
      maybeUpdateTranslator(false);

      sendResponse?.({ ok: true, modes: currentModes });
      return;
    }

    // Proxy REST cho chatbot
    if (msg.__cmd === '__CHAT_REST__') {
      try {
        const { apiBase, body } = msg.payload || {};
        const url = (apiBase || '').replace(/\/+$/, '') + '/v1/rest-retrieve/';
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-user-id': body?.user_id || 'chrome_ext',
          },
          body: JSON.stringify(body || {}),
        });
        const j = await r.json();
        sendResponse({
          ok: r.ok,
          text: j?.text || j?.answer || j?.output || JSON.stringify(j),
          raw: j,
          status: r.status,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }
  })();

  return true;
});

// đảm bảo mọi tab đều dùng sidepanel.html
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') {
    try {
      chrome.sidePanel?.setOptions?.({
        tabId,
        path: 'sidepanel.html',
        enabled: true,
      });
    } catch {}
  }
});
