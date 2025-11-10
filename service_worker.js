// service_worker.js — điều phối Offscreen/Overlay/Panel + proxy REST cho chatbot (__CHAT_REST__)

let current = null; // { tabId, server, startedAt, panelOpen }
const offscreenUrl = chrome.runtime.getURL('offscreen.html');

// ---------- Offscreen ----------
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Process tab audio, audio worklet, WebSocket STT'
    });
  }
}

// ---------- Overlay ----------
async function injectOverlay(tabId) {
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['overlay.css'] }); } catch {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] }); } catch {}
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__OVERLAY_RESET__' }); } catch {}
}
async function removeOverlay(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__OVERLAY_TEARDOWN__' }); } catch {}
  try { await chrome.scripting.removeCSS({ target: { tabId }, files: ['overlay.css'] }); } catch {}
}

// ---------- Panel ----------
async function injectPanel(tabId) {
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['panel.css'] }); } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['panel.js'] });
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__PANEL_MOUNT__' }); } catch {}
}
async function removePanel(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__PANEL_TEARDOWN__' }); } catch {}
  try { await chrome.scripting.removeCSS({ target: { tabId }, files: ['panel.css'] }); } catch {}
}

// ---------- Capture ----------
async function startCaptureOnTab(tabId, server) {
  if (!server) return;
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await chrome.runtime.sendMessage({
    __cmd: '__OFFSCREEN_START__',
    payload: { streamId, server }
  });
  current = { tabId, server, startedAt: Date.now(), panelOpen: true };
}
async function stopCapture() {
  await chrome.runtime.sendMessage({ __cmd: '__OFFSCREEN_STOP__' });
  if (current) current.startedAt = null;
}

// ---------- Open/Close panel ----------
async function openPanel(tabId) {
  await injectPanel(tabId);
  await injectOverlay(tabId);
  current = current || { tabId, server: null, startedAt: null, panelOpen: true };
  current.panelOpen = true;
  try {
    await chrome.tabs.sendMessage(tabId, { __cmd: '__PANEL_OPENED__', payload: {
      server: current.server || 'ws://localhost:8765',
      active: !!current.startedAt
    }});
  } catch {}
}
async function closePanel(tabId) {
  await removePanel(tabId);
  await removeOverlay(tabId);
  if (current && current.tabId === tabId) current.panelOpen = false;
}

// ---------- Browser action: toggle panel ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!current || current.tabId !== tab.id || !current.panelOpen) {
    await openPanel(tab.id);
  } else {
    await closePanel(tab.id);
  }
});

// ---------- Message bus ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.__cmd) return;

    // trạng thái từ offscreen -> relay tới tab
    if (msg.__cmd === '__OFFSCREEN_STATUS__') {
      if (current?.tabId) {
        try { await chrome.tabs.sendMessage(current.tabId, msg); } catch {}
      }
      return;
    }

    // relay transcript tới overlay & panel
    if (msg.__cmd === '__TRANSCRIPT_DELTA__' ||
        msg.__cmd === '__TRANSCRIPT_STABLE__' ||
        msg.__cmd === '__TRANSCRIPT_PATCH__') {
      if (current?.tabId) {
        try { await chrome.tabs.sendMessage(current.tabId, msg); } catch {}
      }
      return;
    }

    // Toggle panel
    if (msg.__cmd === '__PANEL_TOGGLE__') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse?.({ ok: false }); return; }
      if (!current || current.tabId !== tab.id || !current.panelOpen) await openPanel(tab.id);
      else await closePanel(tab.id);
      sendResponse?.({ ok: true, open: !!(current && current.panelOpen) });
      return;
    }

    // Panel Start
    if (msg.__cmd === '__PANEL_START__') {
      const server = (msg.payload?.server || '').trim();
      if (!server) { sendResponse?.({ ok: false, error: 'Missing server' }); return; }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse?.({ ok: false }); return; }
      await startCaptureOnTab(tab.id, server);
      current.server = server;
      sendResponse?.({ ok: true });
      return;
    }

    // Panel Stop
    if (msg.__cmd === '__PANEL_STOP__') {
      await stopCapture();
      sendResponse?.({ ok: true });
      return;
    }

    // overlay ping
    if (msg.__cmd === '__OVERLAY_PING__') {
      sendResponse?.({ ok: true, active: !!current?.startedAt, tabId: current?.tabId || null });
      return;
    }

    // === NEW: Proxy REST cho chatbot (tránh mixed-content https -> http) ===
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
          status: r.status
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }

  })();
  return true; // cho phép sendResponse async
});
