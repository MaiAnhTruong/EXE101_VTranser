// service_worker.js
// Điều phối Offscreen/Overlay/Panel + proxy REST cho chatbot (__CHAT_REST__)
// + Translator WS (VI) chỉ connect khi bật "Dịch phụ đề" và đang chạy capture.
//
// Tương thích server.py:
// - Ticket query: ws(s)://... ?ticket=...
// - Auth message đầu tiên: {"type":"auth","token":"..."} (offscreen sẽ gửi nếu auth.sendFirst=true)
// - Server events: hello/status/patch/stable/error/auth_ok/ack (được relay qua offscreen)
//
// FIX/Behaviors:
// - Ưu tiên tabCapture trước, fallback getDisplayMedia sau.
// - Không nuốt lỗi inject overlay (log rõ và ném lỗi để panel thấy).
// - __OVERLAY_PING__ không spam warning nếu chưa có receiver.
// - Default bật EN mode khi start nếu chưa có mode.
// - AUTH REQUIRED: bắt buộc đăng nhập mới được dùng (START/CHAT...)

import { createTranscriptPersist } from "./sw/transcript_persist.js";
import {
  resolveUsersTableUserId,
  listTranscriptSessionsForUser,
  getTranscriptSessionDetailForUser,
} from "./sw/history_repo.js";
"use strict";

// -------------------- Global state --------------------
// current: { tabId, server, finalWsUrl, startedAt, panelOpen, starting }
let current = null;
let currentModes = { en: false, vi: false, voice: false };
let wantTranslateVI = false;
let transcriptPersist = null;

// -------------------- Transcript relay debug --------------------
let trCount = { patch: 0, delta: 0, stable: 0, lastLogAt: 0 };
function maybeLogTranscriptRate(kind) {
  trCount[kind] = (trCount[kind] || 0) + 1;
  const now = Date.now();
  if (!trCount.lastLogAt) trCount.lastLogAt = now;
  if (now - trCount.lastLogAt >= 2000) {
    log("TRANSCRIPT relay rate/2s:", { ...trCount });
    trCount.patch = 0;
    trCount.delta = 0;
    trCount.stable = 0;
    trCount.lastLogAt = now;
  }
}

// -------------------- Const / Logging --------------------
const TAG = "[VT][SW]";
function log(...args) { console.log(TAG, ...args); }
function warn(...args) { console.warn(TAG, ...args); }
function err(...args) { console.error(TAG, ...args); }

const offscreenUrl = chrome.runtime.getURL("offscreen.html");

// -------------------- Product defaults --------------------
const DEFAULT_SERVER = "wss://api.example.com/stt"; // TODO đổi domain thật
const DEFAULT_TICKET_PATH = "/stt/ws-ticket";       // TODO đổi path thật nếu khác
const DEFAULT_REFRESH_PATH = "/auth/refresh";       // TODO đổi path thật nếu khác

const STORAGE_KEYS = {
  SERVER: "sttServerWs",
  API_TOKEN: "sttApiToken", // advanced/manual override (token riêng cho backend nếu có)
  VT_AUTH: "vtAuth",        // overlay session (profile/tokens)
  API_BASE: "sttApiBase",   // optional: https://api.example.com
  VT_NEED_AUTH: "vtNeedAuth",
  TRANS_URL: "sttTranslatorWs", // optional: ws://127.0.0.1:8787
  TRANS_DEBUG: "sttTransDebug",
};

// -------------------- chrome.storage helpers --------------------
function storeGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storeSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}
function storeRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

// -------------------- Utils: Tabs / Send message safely --------------------
async function safeSendTab(tabId, msg) {
  if (!tabId) return false;
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch {
    return false; // receiver may not exist
  }
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// -------------------- Utils: URL & JWT --------------------
function isForbiddenTabUrl(url = "") {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome-untrusted://") ||
    url.startsWith("devtools://") ||
    /^https?:\/\/chrome\.google\.com\/webstore\//i.test(url)
  );
}
function parseUrlOrNull(s) {
  try { return new URL(s); } catch { return null; }
}
function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}
function deriveApiBaseFromServer(serverUrl) {
  const u = parseUrlOrNull(serverUrl);
  if (!u) return "";
  const origin = u.origin;
  if (origin.startsWith("wss://")) return origin.replace("wss://", "https://");
  if (origin.startsWith("ws://"))  return origin.replace("ws://", "http://");
  return origin;
}
function safeJwtExpMs(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64));
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch {}
  return null;
}

// -------------------- ✅ AUTH: get session from storage --------------------
async function getVtAuthSession() {
  const st = await storeGet([STORAGE_KEYS.VT_AUTH]);
  const raw = st?.[STORAGE_KEYS.VT_AUTH] || null;
  const profile = raw?.profile || raw?.currentSession?.profile || null;
  const tokens  = raw?.tokens  || raw?.currentSession?.tokens  || null;
  return { raw, profile, tokens };
}
function isAuthedSession(sess) {
  const p = sess?.profile;
  if (!p) return false;
  return !!(p.email || p.id || p.name);
}
async function markNeedAuth(action = "unknown") {
  try {
    await storeSet({ [STORAGE_KEYS.VT_NEED_AUTH]: { at: Date.now(), action } });
  } catch {}
}
function broadcastAuthRequired(action = "unknown") {
  try {
    chrome.runtime.sendMessage({ __cmd: "__AUTH_REQUIRED__", payload: { action } });
  } catch {}
}
async function notifyPanel(tabId, payload) {
  if (!tabId) return;
  await safeSendTab(tabId, { __cmd: "__PANEL_NOTIFY__", payload });
}
async function notifyAuthRequired({ action, tabId, sendResponse }) {
  const text = "🔒 Vui lòng đăng nhập để sử dụng tính năng này.";
  await markNeedAuth(action);
  broadcastAuthRequired(action);
  if (tabId) await notifyPanel(tabId, { level: "error", text });
  sendResponse?.({ ok: false, code: "AUTH_REQUIRED", error: text });
}
async function requireAuthOrFail({ action, tabId, sendResponse }) {
  const sess = await getVtAuthSession();
  if (isAuthedSession(sess)) return sess;
  await notifyAuthRequired({ action, tabId, sendResponse });
  return null;
}

// -------------------- Auth: get token from storage/vtAuth --------------------
async function getAccessToken({ overrideToken = "" } = {}) {
  if (overrideToken) return { accessToken: overrideToken, source: "override" };

  const st = await storeGet([STORAGE_KEYS.API_TOKEN, STORAGE_KEYS.VT_AUTH]);
  if (st[STORAGE_KEYS.API_TOKEN]) {
    return { accessToken: st[STORAGE_KEYS.API_TOKEN], source: "manual" };
  }

  const vtAuth = st[STORAGE_KEYS.VT_AUTH] || null;

  const accessToken =
    vtAuth?.tokens?.access_token ||
    vtAuth?.tokens?.accessToken ||
    vtAuth?.currentSession?.tokens?.access_token ||
    vtAuth?.currentSession?.tokens?.accessToken ||
    "";

  const refreshToken =
    vtAuth?.tokens?.refresh_token ||
    vtAuth?.tokens?.refreshToken ||
    vtAuth?.currentSession?.tokens?.refresh_token ||
    vtAuth?.currentSession?.tokens?.refreshToken ||
    "";

  return { accessToken, refreshToken, source: accessToken ? "vtAuth" : "none" };
}

async function maybeRefreshAccessToken({ apiBase, accessToken, refreshToken }) {
  if (!apiBase || !accessToken || !refreshToken) return { accessToken };

  const expMs = safeJwtExpMs(accessToken);
  if (!expMs) return { accessToken };
  if (expMs - Date.now() > 60_000) return { accessToken };

  const url = apiBase.replace(/\/+$/, "") + DEFAULT_REFRESH_PATH;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || `REFRESH_FAILED_${r.status}`);

    const newAccess = j?.access_token || j?.accessToken;
    if (newAccess) return { accessToken: newAccess };
  } catch (e) {
    warn("refresh failed:", String(e));
  }
  return { accessToken };
}

// -------------------- Ticket: POST /stt/ws-ticket --------------------
async function requestWsTicket({ apiBase, accessToken, server }) {
  const url = apiBase.replace(/\/+$/, "") + DEFAULT_TICKET_PATH;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ server }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || j?.message || `TICKET_FAILED_${r.status}`);

  const wsUrl = j.ws_url || j.wsUrl || j.wss_url || j.wssUrl || "";
  const ticket = j.ticket || j.ws_ticket || "";

  if (wsUrl) return { wsUrl };
  if (ticket) {
    const u = new URL(server);
    u.searchParams.set("ticket", ticket);
    return { wsUrl: u.toString() };
  }
  throw new Error("TICKET_RESPONSE_INVALID");
}

// -------------------- Side Panel behavior --------------------
function ensureSidePanelBehavior() {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      chrome.sidePanel
        .setPanelBehavior({ openPanelOnActionClick: true })
        .catch((e) => console.warn("setPanelBehavior failed", e));
    }
  } catch (e) {
    console.warn("ensureSidePanelBehavior error", e);
  }
}
ensureSidePanelBehavior();
chrome.runtime.onInstalled.addListener(() => ensureSidePanelBehavior());

// -------------------- Offscreen --------------------
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
      justification: "Capture tab audio via getDisplayMedia/tabCapture in offscreen, process audio worklet, WebSocket STT",
    });
    log("offscreen created OK:", offscreenUrl);
  }
}

// -------------------- Overlay helpers --------------------
async function trySendOverlayMode(tabId) {
  if (!tabId) return;
  await safeSendTab(tabId, { __cmd: "__OVERLAY_MODE__", payload: currentModes });
}

// -------------------- Overlay inject/remove --------------------
async function injectOverlay(tabId) {
  if (!tabId) throw new Error("Missing tabId");

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
  } catch (e) {
    warn("insertCSS overlay failed:", e);
    // insertCSS có thể fail trên trang bị chặn, nhưng vẫn thử executeScript để lấy lỗi rõ hơn
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
  } catch (e) {
    err("executeScript overlay failed:", e);
    // Đây là lỗi critical: nếu overlay không inject được, user sẽ không thấy phụ đề
    throw new Error(`Không inject được overlay: ${String(e?.message || e)}`);
  }

  await safeSendTab(tabId, { __cmd: "__OVERLAY_RESET__" });
  await trySendOverlayMode(tabId);
}

async function removeOverlay(tabId) {
  if (!tabId) return;
  await safeSendTab(tabId, { __cmd: "__OVERLAY_TEARDOWN__" });
  try { await chrome.scripting.removeCSS({ target: { tabId }, files: ["overlay.css"] }); } catch {}
}

// -------------------- In-page Panel inject/remove --------------------
async function injectPanel(tabId) {
  if (!tabId) return;
  try { await chrome.scripting.insertCSS({ target: { tabId }, files: ["panel.css"] }); } catch {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["panel.js"] }); } catch {}
  await safeSendTab(tabId, { __cmd: "__PANEL_MOUNT__" });
}
async function removePanel(tabId) {
  if (!tabId) return;
  await safeSendTab(tabId, { __cmd: "__PANEL_TEARDOWN__" });
  try { await chrome.scripting.removeCSS({ target: { tabId }, files: ["panel.css"] }); } catch {}
}

// -------------------- Capture state helpers --------------------
function setCurrentStarting(tabId, serverUrl) {
  current = current || { tabId, server: serverUrl, finalWsUrl: serverUrl, startedAt: null, panelOpen: true, starting: false };
  current.tabId = tabId;
  current.server = serverUrl;
  current.finalWsUrl = serverUrl;
  current.starting = true;
  current.startedAt = null;
}
function setCurrentRunning() {
  if (!current) return;
  current.starting = false;
  if (!current.startedAt) current.startedAt = Date.now();
}
function setCurrentStopped() {
  if (!current) return;
  current.starting = false;
  current.startedAt = null;
}

// ✅ tabCapture.getMediaStreamId helper (Promise wrapper)
function tabCaptureGetStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.tabCapture?.getMediaStreamId) return resolve(null);
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) return reject(new Error(lastErr.message));
        resolve(streamId || null);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ✅ tabCapture FIRST
async function startCaptureOnTab(tabId, wsUrl, auth = null, strictWs = true) {
  if (!wsUrl) throw new Error("Missing server");

  await ensureOffscreen();

  const tab = await chrome.tabs.get(tabId);
  const url = tab?.url || "";
  if (isForbiddenTabUrl(url)) {
    throw new Error(
      "Không thể capture âm thanh từ tab hệ thống (chrome://, Chrome Web Store, trang cài đặt, devtools...). " +
      "Hãy mở video/audio trên website bình thường (youtube.com, v.v.)."
    );
  }

  setCurrentStarting(tabId, wsUrl);
  current.finalWsUrl = wsUrl;

  log("startCaptureOnTab tabId=", tabId, "wsUrl=", wsUrl, "strictWs=", strictWs);

  // 1) tabCapture first
  let streamId = null;
  try {
    streamId = await tabCaptureGetStreamId(tabId);
    if (streamId) log("tabCapture.getMediaStreamId OK");
  } catch (e) {
    warn("tabCapture.getMediaStreamId failed -> fallback displayMedia. err=", String(e));
  }

  if (streamId) {
    const resp = await chrome.runtime.sendMessage({
      __cmd: "__OFFSCREEN_START__",
      payload: { streamId, server: wsUrl, auth, captureSource: "tab", strictWs },
    });
    if (!resp?.ok) throw new Error(resp?.error || "OFFSCREEN_START_FAILED");
    maybeUpdateTranslator();
    return;
  }

  // 2) displayMedia fallback
  await notifyPanel(tabId, {
    level: "info",
    text: "Đang dùng chế độ chọn tab (Share audio). Hãy chọn đúng TAB đang mở overlay.",
  });

  let resp2 = null;
  try {
    resp2 = await chrome.runtime.sendMessage({
      __cmd: "__OFFSCREEN_START__",
      payload: { server: wsUrl, auth, captureSource: "display", strictWs },
    });
  } catch (e) {
    resp2 = { ok: false, error: String(e) };
  }
  if (!resp2?.ok) throw new Error(resp2?.error || "OFFSCREEN_START_FAILED");

  maybeUpdateTranslator();
}

async function stopCapture() {
  const tabId = current?.tabId || null;

  // Mark stopped immediately so late packets from previous run are ignored.
  setCurrentStopped();

  try { await chrome.runtime.sendMessage({ __cmd: "__OFFSCREEN_STOP__" }); } catch {}

  // Clear + remove overlay so next run starts from a clean visual state.
  if (tabId != null) {
    try { await safeSendTab(tabId, { __cmd: "__OVERLAY_RESET__", payload: { keepMode: false, showDots: false } }); } catch {}
    await removeOverlay(tabId);
  }

  maybeUpdateTranslator(true);
  if (transcriptPersist) {
    try { await transcriptPersist.stop(lastEnStable?.full || ""); } catch {}
    transcriptPersist = null;
  }
}

// -------------------- Open/Close in-page panel --------------------
async function openPanel(tabId) {
  await injectPanel(tabId);

  // Overlay luôn inject để user thấy phụ đề ngay
  try {
    await injectOverlay(tabId);
  } catch (e) {
    // panel vẫn mở được, nhưng báo lỗi overlay rõ ràng
    await notifyPanel(tabId, { level: "error", text: String(e?.message || e) });
  }

  current = current || { tabId, server: null, finalWsUrl: null, startedAt: null, panelOpen: true, starting: false };
  current.tabId = tabId;
  current.panelOpen = true;

  const st = await storeGet([STORAGE_KEYS.SERVER]);
  const server = (st[STORAGE_KEYS.SERVER] || DEFAULT_SERVER).trim();

  await safeSendTab(tabId, {
    __cmd: "__PANEL_OPENED__",
    payload: {
      server,
      active: !!current.startedAt,
      starting: !!current.starting,
      url: (await chrome.tabs.get(tabId))?.url || ""
    },
  });

  await trySendOverlayMode(tabId);
}

async function closePanel(tabId) {
  await removePanel(tabId);
  // Overlay có thể giữ lại tùy sản phẩm; ở đây tắt luôn khi đóng panel
  await removeOverlay(tabId);
  if (current && current.tabId === tabId) current.panelOpen = false;
}

// -------------------- Browser action (CLICK ICON) --------------------
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null || tab.windowId == null) return;

  current = current || { tabId: tab.id, server: null, finalWsUrl: null, startedAt: null, panelOpen: false, starting: false };
  current.tabId = tab.id;

  try { chrome.sidePanel?.setOptions?.({ tabId: tab.id, path: "sidepanel.html", enabled: true }); } catch {}

  // fallback open if setPanelBehavior not available
  if (!chrome.sidePanel?.setPanelBehavior && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ windowId: tab.windowId })
      .catch((e) => console.error("open sidepanel failed (fallback)", e));
  }
});

// -------------------- Translator debug flag (chrome.storage) --------------------
let TRANS_DEBUG = false;

async function loadTransDebugFlag() {
  try {
    const st = await storeGet([STORAGE_KEYS.TRANS_DEBUG]);
    const v = st?.[STORAGE_KEYS.TRANS_DEBUG];
    TRANS_DEBUG = (v === 1 || v === true || v === "1");
  } catch {}
}

function tlog(...args) { if (TRANS_DEBUG) log("[TR]", ...args); }
function twarn(...args) { warn("[TR]", ...args); }

let trDbg = {
  txReset: 0,
  txBaseline: 0,
  txStable: 0,
  dropStable: 0,
  rxHello: 0,
  rxStatus: 0,
  rxDelta: 0,
  rxStable: 0,
  rxError: 0,
  lastLogAt: 0,
  lastTxStableSeq: -1,
  lastRxViSeq: -1,
};

function maybeLogTranslatorRate() {
  if (!TRANS_DEBUG) return;
  const now = Date.now();
  if (!trDbg.lastLogAt) trDbg.lastLogAt = now;
  if (now - trDbg.lastLogAt >= 2000) {
    tlog("rate/2s", { ...trDbg });
    // reset moving counters only (giữ lastTxStableSeq/lastRxViSeq)
    trDbg.txReset = trDbg.txBaseline = trDbg.txStable = trDbg.dropStable = 0;
    trDbg.rxHello = trDbg.rxStatus = trDbg.rxDelta = trDbg.rxStable = trDbg.rxError = 0;
    trDbg.lastLogAt = now;
  }
}


// -------------------- Translator WS (VI) — LAZY (STABLE-ONLY) --------------------
let transWs = null;
// ✅ default đúng với translator.py TR_PORT=8766
let transUrl = "ws://127.0.0.1:8766";

let transBackoffMs = 500;
let transReconnectTimer = null;

// cache stable EN để baseline khi translator connect
let lastEnStable = { full: "", seq: 0, t_ms: 0 };

// khi bật dịch / start capture => reset+bắt đầu từ baseline (không dịch history)
let transNeedHardResetOnOpen = false;
// guard stable gửi theo seq
let lastSentStableSeq = -1;

async function loadTranslatorUrlFromStorage() {
  const st = await storeGet([STORAGE_KEYS.TRANS_URL]);
  const v = (st?.[STORAGE_KEYS.TRANS_URL] || "").trim();
  if (v) transUrl = v;
}

function disconnectTranslator(hard = false) {
  try { if (transReconnectTimer) clearTimeout(transReconnectTimer); } catch {}
  transReconnectTimer = null;

  try {
    if (transWs) {
      transWs.onopen = transWs.onmessage = transWs.onclose = transWs.onerror = null;
      try { transWs.close(); } catch {}
    }
  } catch {}
  transWs = null;

  if (hard) {
    transBackoffMs = 500;
    lastSentStableSeq = -1;

    // ✅ CRITICAL: clear cached stable from previous session
    lastEnStable = { full: "", seq: 0, t_ms: 0 };
  }
}


function shouldTranslateNow() {
  // ✅ allow connect while "starting" (tránh miss thời điểm startedAt chưa set)
  return !!(wantTranslateVI && current?.tabId && (current?.startedAt || current?.starting));
}


function scheduleTranslatorReconnect() {
  if (!shouldTranslateNow()) return;
  const delay = Math.min(5000, transBackoffMs);
  transReconnectTimer = setTimeout(connectTranslator, delay);
  transBackoffMs = Math.min(5000, transBackoffMs * 2);
}

function transSend(obj) {
  try {
    if (!transWs || transWs.readyState !== 1) return false;
    transWs.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function transSendBaselineIfAny() {
  const full = String(lastEnStable?.full || "");
  const seq = Number(lastEnStable?.seq || 0);
  const t_ms = Number(lastEnStable?.t_ms || 0);
  if (!full) {
    tlog("baseline skip (no lastEnStable)");
    return;
  }
  trDbg.txBaseline++;
  tlog("-> baseline", { seq, t_ms, fullLen: full.length, tail: full.slice(-60) });
  maybeLogTranslatorRate();
  transSend({ type: "baseline", full, seq, t_ms });
}


function transSendReset() {
  trDbg.txReset++;
  tlog("-> reset");
  maybeLogTranslatorRate();
  transSend({ type: "reset" });
}


function feedTranslatorStable(full, seq, t_ms) {
  if (!shouldTranslateNow()) return;
  if (!transWs || transWs.readyState !== 1) return;

  const s = Number(seq ?? 0);
  if (Number.isFinite(s) && s > 0) {
    if (s <= lastSentStableSeq) {
      trDbg.dropStable++;
      tlog("drop stable (old/out-of-order)", { seq: s, lastSentStableSeq });
      maybeLogTranslatorRate();
      return;
    }
    lastSentStableSeq = s;
    trDbg.lastTxStableSeq = s;
  }

  const text = String(full || "");
  trDbg.txStable++;
  tlog("-> stable", { seq: s || 0, t_ms: Number(t_ms || 0), fullLen: text.length, tail: text.slice(-60) });
  maybeLogTranslatorRate();

  transSend({ type: "stable", full: text, seq: s || 0, t_ms: Number(t_ms || 0) });
}


async function connectTranslator() {
  if (!shouldTranslateNow()) return;

  await loadTranslatorUrlFromStorage();
  await loadTransDebugFlag();
  tlog("connectTranslator()", { transUrl, wantTranslateVI, startedAt: !!current?.startedAt, starting: !!current?.starting });

  disconnectTranslator(false);

  try {
    const ws = new WebSocket(transUrl);
    transWs = ws;

    ws.onopen = () => {
      transBackoffMs = 500;
      tlog("WS open");

      if (transNeedHardResetOnOpen) {
        tlog("hard reset on open");
        transSendReset();
        transSendBaselineIfAny();
        transNeedHardResetOnOpen = false;
        return;
      }

      tlog("reconnect baseline");
      transSendBaselineIfAny();
    };


    ws.onmessage = async (ev) => {
      if (typeof ev.data !== "string") return;

      let obj = null;
      try { obj = JSON.parse(ev.data); } catch { return; }
      if (!obj || !obj.type) return;
      if (!current?.tabId) return;

      const typ = String(obj.type || "").toLowerCase();

      if (typ === "hello") { trDbg.rxHello++; tlog("<- hello", obj.detail || obj); }
      if (typ === "status") { trDbg.rxStatus++; tlog("<- status", obj.detail || obj); }

      if (typ === "vi-delta") {
        trDbg.rxDelta++;
        const viSeq = Number(obj.seq ?? 0);
        if (Number.isFinite(viSeq) && viSeq > 0) trDbg.lastRxViSeq = viSeq;

        tlog("<- vi-delta", {
          seq: obj.seq ?? null,
          en_seq: obj.en_seq ?? null,
          appendLen: (obj.append || "").length,
          tr_ms: obj.tr_ms ?? null,
          tail: String(obj.append || "").slice(-60),
        });
        maybeLogTranslatorRate();

        // ✅ Relay: gửi toàn bộ obj xuống overlay để overlay log được en_seq/tr_ms/...
        await safeSendTab(current.tabId, { __cmd: "__TRANS_VI_DELTA__", payload: obj });
        return;
      }

      if (typ === "vi-stable") {
        trDbg.rxStable++;
        tlog("<- vi-stable", { seq: obj.seq ?? null, fullLen: (obj.full || "").length });
        maybeLogTranslatorRate();

        await safeSendTab(current.tabId, { __cmd: "__TRANS_VI_STABLE__", payload: obj });
        return;
      }

      if (typ === "error") {
        trDbg.rxError++;
        twarn("Translator error:", obj.error || obj);
        maybeLogTranslatorRate();
        return;
      }
    };


    ws.onclose = (e) => {
      tlog("WS close", { code: e?.code, reason: e?.reason });
      if (shouldTranslateNow()) scheduleTranslatorReconnect();
    };
    ws.onerror = (e) => {
      twarn("WS error", e);
      try { ws.close(); } catch {}
    };

  } catch {
    scheduleTranslatorReconnect();
  }
}

function maybeUpdateTranslator(forceStop = false) {
  if (forceStop || !shouldTranslateNow()) { disconnectTranslator(true); return; }
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

// -------------------- ✅ Stop capture if user logs out while running --------------------
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes || !changes[STORAGE_KEYS.VT_AUTH]) return;

  const oldVal = changes[STORAGE_KEYS.VT_AUTH]?.oldValue;
  const newVal = changes[STORAGE_KEYS.VT_AUTH]?.newValue;

  const oldHas = !!(oldVal?.profile || oldVal?.currentSession?.profile);
  const newHas = !!(newVal?.profile || newVal?.currentSession?.profile);

  if (oldHas && !newHas) {
    (async () => {
      if (current?.startedAt || current?.starting) {
        warn("vtAuth removed -> stopping capture");
        await stopCapture();
        if (current?.tabId) {
          await notifyPanel(current.tabId, { level: "error", text: "Bạn đã đăng xuất. Capture đã dừng." });
        }
      }
    })();
  }
});

// -------------------- Stop if tab closed --------------------
chrome.tabs.onRemoved.addListener((tabId) => {
  if (current?.tabId === tabId) {
    (async () => {
      warn("current tab closed -> stopping capture");
      await stopCapture();
      disconnectTranslator(true);
      current = null;
    })();
  }
});

// -------------------- Message bus --------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.__cmd) return;

    // OFFSCREEN STATUS relay + update state
    if (msg.__cmd === "__OFFSCREEN_STATUS__") {
      const p = msg.payload || {};
      const s = p.state || "unknown";

      if (s === "running") setCurrentRunning();
      else if (s === "stopped") setCurrentStopped();
      else if (s === "server-busy" || s === "server-error") {
        setCurrentStopped();
        if (current?.tabId) {
          await notifyPanel(current.tabId, {
            level: "error",
            text: s === "server-busy" ? "Hệ thống bận. Vui lòng thử lại sau." : `Lỗi server: ${p?.error || "unknown"}`,
            detail: p,
          });
        }
      } else if (s === "error") {
        // đảm bảo không giữ trạng thái running/starting giả nếu offscreen lỗi
        setCurrentStopped();
      }

      // logs
      if (s === "media-ok") {
        log("OFFSCREEN media-ok audioTracks=", p.audioTracks, "label=", p.audioLabel);
      } else if (s === "meter") {
        log("AUDIO meter rms=", p.rms?.toFixed?.(4), "peak=", p.peak?.toFixed?.(4),
          "wsOpen=", p.wsOpen, "bytesSent=", p.bytesSent, "chunksSent=", p.chunksSent);
      } else if (
        s === "ws-open" || s === "ws-auth-sent" || s === "ws-error" || s === "ws-close" ||
        s === "server-hello" || s === "server-status" || s === "server-auth-ok" ||
        s === "server-busy" || s === "server-error"
      ) {
        log("WS/state:", s, p);
      } else if (s === "error") {
        err("OFFSCREEN error:", p.stage, p.error);
      } else {
        log("OFFSCREEN_STATUS:", s, p);
      }

      // relay to tab (overlay/panel)
      if (current?.tabId) {
        await safeSendTab(current.tabId, msg);
      }
      return;
    }

    // transcript relay
    if (
      msg.__cmd === "__TRANSCRIPT_DELTA__" ||
      msg.__cmd === "__TRANSCRIPT_STABLE__" ||
      msg.__cmd === "__TRANSCRIPT_PATCH__"
    ) {
      // Drop transcript from stale sessions (e.g., packets arriving right after Stop).
      if (!(current?.tabId && (current?.startedAt || current?.starting))) {
        return;
      }

      if (msg.__cmd === "__TRANSCRIPT_PATCH__") maybeLogTranscriptRate("patch");
      else if (msg.__cmd === "__TRANSCRIPT_DELTA__") maybeLogTranscriptRate("delta");
      else if (msg.__cmd === "__TRANSCRIPT_STABLE__") maybeLogTranscriptRate("stable");

      // relay to overlay
      if (current?.tabId) await safeSendTab(current.tabId, msg);

      // ✅ STABLE-ONLY translation: chỉ feed stable.full sang translator
      if (msg.__cmd === "__TRANSCRIPT_STABLE__") {
        const p = msg.payload || msg.detail || {};
        const full = (
          p.full ??
          msg.full ??
          p.text ??
          msg.text ??
          p.detail?.full ??
          p.detail?.text ??
          ""
        ).toString();
        const seq = (p.seq ?? msg.seq ?? p.stable_seq ?? null);
        const t_ms = (p.t_ms ?? msg.t_ms ?? null);

        // cache for baseline on connect
        lastEnStable = { full, seq: Number(seq || 0), t_ms: Number(t_ms || 0) };

        // feed stable if translator online
        feedTranslatorStable(full, seq, t_ms);

        // persist to Supabase (delay 1 sentence)
        if (transcriptPersist) {
          try { transcriptPersist.handleStable(full, seq); } catch {}
        }
      }

      return;
    }

    // Toggle in-page panel (inject)
    if (msg.__cmd === "__PANEL_TOGGLE__") {
      const tab = await getActiveTab();
      if (!tab?.id) { sendResponse?.({ ok: false }); return; }

      if (!current || current.tabId !== tab.id || !current.panelOpen) await openPanel(tab.id);
      else await closePanel(tab.id);

      sendResponse?.({ ok: true, open: !!(current && current.panelOpen) });
      return;
    }

    // ✅ Panel Start (AUTH REQUIRED)
    if (msg.__cmd === "__PANEL_START__") {
      const serverInput = (msg.payload?.server || "").trim();
      const overrideToken = (msg.payload?.token || "").trim();

      const st0 = await storeGet([STORAGE_KEYS.SERVER]);
      const server = (serverInput || st0[STORAGE_KEYS.SERVER] || DEFAULT_SERVER).trim();
      if (!server) { sendResponse?.({ ok: false, error: "Missing server" }); return; }

      await storeSet({
        [STORAGE_KEYS.SERVER]: server,
        ...(overrideToken ? { [STORAGE_KEYS.API_TOKEN]: overrideToken } : {}),
      });

      const tab = await getActiveTab();
      if (!tab?.id) { sendResponse?.({ ok: false, error: "No active tab" }); return; }

      const authSess = await requireAuthOrFail({ action: "start", tabId: tab.id, sendResponse });
      if (!authSess) return;

      // default mode: bật EN để dễ thấy overlay
      if (!currentModes.en && !currentModes.vi && !currentModes.voice) {
        currentModes.en = true;
        currentModes.vi = false;
        currentModes.voice = false;
        wantTranslateVI = false;
      }

      // nếu đang chạy ở tab khác -> stop
      if (current?.startedAt && current.tabId !== tab.id) {
        warn("Already running on another tab -> stopping previous session");
        await stopCapture();
      }

      try {
        // inject overlay first (receiver). Nếu fail -> throw rõ ràng
        await injectOverlay(tab.id);

        const u = parseUrlOrNull(server);
        if (!u) throw new Error("Server URL invalid");

        const isLocalDev = isLocalHost(u.hostname);
        const isWss = u.protocol === "wss:";
        const okProto = isWss || (isLocalDev && u.protocol === "ws:");
        if (!okProto) throw new Error("Server phải là wss:// (hoặc ws://localhost cho dev)");

        const tok = await getAccessToken({ overrideToken });
        let accessToken = tok.accessToken || "";
        const refreshToken = tok.refreshToken || "";

        // production wss: yêu cầu token để xin ticket (nếu không có ticket endpoint)
        if (isWss && !isLocalDev && !accessToken) {
          throw new Error("Thiếu API token. Hãy nhập token (Advanced) hoặc cấu hình token trong vtAuth.");
        }

        const st = await storeGet([STORAGE_KEYS.API_BASE]);
        const apiBase = (st[STORAGE_KEYS.API_BASE] || deriveApiBaseFromServer(server)).trim();

        if (apiBase && accessToken && refreshToken) {
          const rf = await maybeRefreshAccessToken({ apiBase, accessToken, refreshToken });
          accessToken = rf.accessToken || accessToken;
        }

        let finalWsUrl = server;
        let auth = null;

        // Ưu tiên ticket query (server.py AUTH_MODE=ticket/either)
        // Fallback auth message (server.py AUTH_MODE=message/either)
        if (isWss && accessToken && apiBase) {
          try {
            const t = await requestWsTicket({ apiBase, accessToken, server });
            finalWsUrl = t.wsUrl;
            auth = null;
            log("ticket OK, ws=", finalWsUrl);
          } catch (e) {
            warn("ticket failed, fallback auth message:", String(e));
            auth = { sendFirst: true, token: accessToken };
            finalWsUrl = server;
          }
        }

        const strictWs = !(isLocalDev && u.protocol === "ws:");

        // start transcript persistence to Supabase (delay 1 sentence)
        if (transcriptPersist) {
          try { await transcriptPersist.stop(lastEnStable?.full || ""); } catch {}
        }
        const transUrlSt = await storeGet([STORAGE_KEYS.TRANS_URL]);
        const transServer = (transUrlSt[STORAGE_KEYS.TRANS_URL] || "").trim();
        const profile = authSess?.profile || authSess?.raw?.profile || authSess?.currentSession?.profile || {};
        const userEmail = String(profile.email || "").trim();
        let userId = "";
        try {
          const uid = await resolveUsersTableUserId(profile);
          userId = uid ? String(uid) : "";
        } catch {
          userId = "";
        }
        transcriptPersist = createTranscriptPersist({
          userId,
          userEmail,
          tabUrl: tab.url || "",
          sttServer: server,
          translatorServer: transServer,
          langSrc: "en",
          langTgt: wantTranslateVI ? "vi" : "",
        });
        try { await transcriptPersist.start(); } catch {}

        await startCaptureOnTab(tab.id, finalWsUrl, auth, strictWs);

        current = current || {};
        current.server = server;
        current.finalWsUrl = finalWsUrl;

        await trySendOverlayMode(tab.id);

        sendResponse?.({ ok: true, mode: auth ? "auth-message" : "ticket", ws: finalWsUrl });
      } catch (e) {
        const msgErr = String(e?.message || e);
        if (transcriptPersist) {
          try { await transcriptPersist.stop(lastEnStable?.full || ""); } catch {}
          transcriptPersist = null;
        }
        await notifyPanel(tab.id, { level: "error", text: msgErr });
        sendResponse?.({ ok: false, error: msgErr });
      }
      return;
    }

    // Panel Stop
    if (msg.__cmd === "__PANEL_STOP__") {
      await stopCapture();
      sendResponse?.({ ok: true });
      return;
    }

    // overlay ping (do overlay.js gọi)
    if (msg.__cmd === "__OVERLAY_PING__") {
      const tabId = (sender && sender.tab && sender.tab.id) || current?.tabId || null;
      if (tabId != null) await trySendOverlayMode(tabId);

      sendResponse?.({
        ok: true,
        active: !!current?.startedAt,
        starting: !!current?.starting,
        tabId: current?.tabId || null,
        modes: currentModes,
      });
      return;
    }

    // modes from sidepanel
    if (msg.__cmd === "__TRANSCRIPT_MODES__") {
      const modes = normalizeModes(msg.payload);

      const prevWantVI = !!wantTranslateVI;

      currentModes = modes;
      wantTranslateVI = !!modes.vi;

      const tabId = current?.tabId ?? null;
      if (tabId != null) {
        await safeSendTab(tabId, { __cmd: "__OVERLAY_MODE__", payload: currentModes });
      }

      // ✅ nếu vừa bật VI: reset riêng VI + hard reset translator + baseline current stable
      if (!prevWantVI && wantTranslateVI) {
        if (tabId != null) {
          await safeSendTab(tabId, { __cmd: "__TRANS_VI_RESET__" }); // reset VI only
        }
        transNeedHardResetOnOpen = true;
        maybeUpdateTranslator(false);
      }

      // ✅ nếu vừa tắt VI: disconnect translator (hard)
      if (prevWantVI && !wantTranslateVI) {
        maybeUpdateTranslator(true);
      }

      sendResponse?.({ ok: true, modes: currentModes });
      return;
    }

    // ✅ History list from Supabase (AUTH REQUIRED)
    if (msg.__cmd === "__HISTORY_LIST__") {
      const tabIdForNotify = current?.tabId || null;
      const authSess = await requireAuthOrFail({ action: "history_list", tabId: tabIdForNotify, sendResponse });
      if (!authSess) return;

      try {
        const limitRaw = Number(msg.payload?.limit);
        const offsetRaw = Number(msg.payload?.offset);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 200;
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
        const profile = authSess?.profile || {};
        const userId = await resolveUsersTableUserId(profile);

        const items = await listTranscriptSessionsForUser(userId, { limit, offset });
        sendResponse?.({ ok: true, items, userId });
      } catch (e) {
        const msgErr = String(e?.message || e);
        if (msgErr.includes("USER_ID_INVALID")) {
          sendResponse?.({ ok: false, code: "USER_ID_INVALID", error: "USER_ID_INVALID" });
          return;
        }
        sendResponse?.({ ok: false, error: msgErr });
      }
      return;
    }

    // ✅ History detail (full text) from Supabase (AUTH REQUIRED)
    if (msg.__cmd === "__HISTORY_DETAIL__") {
      const tabIdForNotify = current?.tabId || null;
      const authSess = await requireAuthOrFail({ action: "history_detail", tabId: tabIdForNotify, sendResponse });
      if (!authSess) return;

      try {
        const sessionId = Number(msg.payload?.sessionId || 0);
        if (!Number.isFinite(sessionId) || sessionId <= 0) {
          sendResponse?.({ ok: false, error: "INVALID_SESSION_ID" });
          return;
        }

        const profile = authSess?.profile || {};
        const userId = await resolveUsersTableUserId(profile);
        const detail = await getTranscriptSessionDetailForUser(userId, sessionId);

        if (!detail) {
          sendResponse?.({ ok: false, code: "NOT_FOUND", error: "NOT_FOUND" });
          return;
        }

        sendResponse?.({ ok: true, item: detail.session, fullText: detail.fullText, userId });
      } catch (e) {
        const msgErr = String(e?.message || e);
        if (msgErr.includes("USER_ID_INVALID")) {
          sendResponse?.({ ok: false, code: "USER_ID_INVALID", error: "USER_ID_INVALID" });
          return;
        }
        sendResponse?.({ ok: false, error: msgErr });
      }
      return;
    }


    // ✅ Proxy REST for chatbot (AUTH REQUIRED)
    if (msg.__cmd === "__CHAT_REST__") {
      const tabIdForNotify = current?.tabId || null;

      const authSess = await requireAuthOrFail({ action: "chat", tabId: tabIdForNotify, sendResponse });
      if (!authSess) return;

      try {
        const { apiBase, body } = msg.payload || {};
        const url = (apiBase || "").replace(/\/+$/, "") + "/v1/rest-retrieve/";

        const userIdHeader =
          body?.user_id ||
          authSess?.profile?.email ||
          authSess?.profile?.id ||
          "chrome_ext";

        const r = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-user-id": String(userIdHeader),
          },
          body: JSON.stringify(body || {}),
        });
        const j = await r.json().catch(() => ({}));
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

  // keep channel open for async sendResponse
  return true;
});

// đảm bảo mọi tab đều dùng sidepanel.html
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") {
    try { chrome.sidePanel?.setOptions?.({ tabId, path: "sidepanel.html", enabled: true }); } catch {}
  }
});
