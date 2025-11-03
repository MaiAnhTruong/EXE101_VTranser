//home/truong/EXE/my-tab-audio-ext/service_worker.js:
// SW: toggle Side Panel 1/4 phải, Start/Stop, relay transcript tới overlay & panel

let current = null; // { tabId, server, startedAt, panelOpen }
const offscreenUrl = chrome.runtime.getURL('offscreen.html');

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

async function injectOverlay(tabId) {
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['overlay.css'] }); } catch {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] }); } catch {}
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__OVERLAY_RESET__' }); } catch {}
}

async function removeOverlay(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__OVERLAY_TEARDOWN__' }); } catch {}
  try { await chrome.scripting.removeCSS({ target: { tabId }, files: ['overlay.css'] }); } catch {}
}

async function injectPanel(tabId) {
  // CSS trước để tránh flash
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ['panel.css'] }); } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['panel.js'] });
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__PANEL_MOUNT__' }); } catch {}
}

async function removePanel(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { __cmd: '__PANEL_TEARDOWN__' }); } catch {}
  try { await chrome.scripting.removeCSS({ target: { tabId }, files: ['panel.css'] }); } catch {}
}

async function startCaptureOnTab(tabId, server) {
  if (!server) return;
  await ensureOffscreen();
  // lấy streamId của TAB đang hoạt động (tabId)
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  // khởi động offscreen
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

async function openPanel(tabId) {
  await injectPanel(tabId);
  await injectOverlay(tabId);
  current = current || { tabId, server: null, startedAt: null, panelOpen: true };
  current.panelOpen = true;
  // báo panel biết trạng thái
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

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!current || current.tabId !== tab.id || !current.panelOpen) {
    await openPanel(tab.id);
  } else {
    await closePanel(tab.id);
  }
});

// Message bus
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.__cmd) return;

    // giữ nguyên kênh trạng thái từ offscreen
    if (msg.__cmd === '__OFFSCREEN_STATUS__') {
      if (current?.tabId) {
        try { await chrome.tabs.sendMessage(current.tabId, msg); } catch {}
      }
      return;
    }

    // relay transcript tới overlay & panel
    if (msg.__cmd === '__TRANSCRIPT_DELTA__' || msg.__cmd === '__TRANSCRIPT_STABLE__' || msg.__cmd === '__TRANSCRIPT_PATCH__') {
      if (current?.tabId) {
        try { await chrome.tabs.sendMessage(current.tabId, msg); } catch {}
      }
      return;
    }

    // Panel yêu cầu mở/đóng
    if (msg.__cmd === '__PANEL_TOGGLE__') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
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
      sendResponse?.({ ok: true });
      return;
    }

    // Panel Stop
    if (msg.__cmd === '__PANEL_STOP__') {
      await stopCapture();
      sendResponse?.({ ok: true });
      return;
    }

    // overlay ping (giữ nguyên từ bản cũ)
    if (msg.__cmd === '__OVERLAY_PING__') {
      sendResponse?.({ ok: true, active: !!current?.startedAt, tabId: current?.tabId || null });
      return;
    }
  })();
  return true;
});
