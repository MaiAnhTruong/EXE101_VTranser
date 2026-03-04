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
// - Mode EN/VI độc lập: bật cái nào thì hiện cái đó, không auto-force.
// - AUTH REQUIRED: bắt buộc đăng nhập mới được dùng (START/CHAT...)

import { createTranscriptPersist } from "./sw/transcript_persist.js";
import {
  resolveUsersTableUserId,
  listTranscriptSessionsForUser,
  getTranscriptSessionDetailForUser,
  deleteTranscriptSessionForUser,
} from "./sw/history_repo.js";
import {
  ensureChatSessionForUser,
  insertChatMessage,
  touchChatSession,
} from "./sw/chat_repo.js";
"use strict";

// -------------------- Global state --------------------
// current: { tabId, server, finalWsUrl, startedAt, panelOpen, starting }
let current = null;
let currentModes = { en: false, vi: false, voice: false, record: false };
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
function err(...args) { console.warn(TAG, ...args); }
const SYSTEM_BUSY_TEXT = "Hệ thống đang bận, vui lòng thử lại sau.";

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
  TRANS_URL: "sttTranslatorWs", // optional override, e.g. ws://127.0.0.1:8766 or wss://host/tr
  TRANS_DEBUG: "sttTransDebug",
  EMAIL_USER_ID_MAP: "vtEmailUserIdMapV1",
};

// Keep overlay payload bounded so long sessions stay visually realtime.
const OVERLAY_EN_STABLE_MAX_CHARS = 3200;

function trimTailForOverlay(text, maxChars = OVERLAY_EN_STABLE_MAX_CHARS) {
  const s = String(text || "");
  const n = Number(maxChars) | 0;
  if (n <= 0 || s.length <= n) return s;

  let from = s.length - n;
  const head = s.slice(from, Math.min(s.length, from + 180));
  const sentBoundary = head.match(/[.!?…]\s+/);
  if (sentBoundary && Number.isFinite(sentBoundary.index)) {
    from += sentBoundary.index + sentBoundary[0].length;
    return s.slice(from);
  }

  const ws = s.indexOf(" ", from);
  if (ws > from && ws - from < 100) from = ws + 1;
  return s.slice(from);
}

function buildOverlayStableRelayMsg(msg, fullText) {
  const trimmed = trimTailForOverlay(fullText, OVERLAY_EN_STABLE_MAX_CHARS);
  const out = { ...msg, full: trimmed };
  if (msg?.payload && typeof msg.payload === "object") {
    out.payload = { ...msg.payload, full: trimmed };
  }
  if (msg?.detail && typeof msg.detail === "object") {
    out.detail = { ...msg.detail, full: trimmed };
  }
  return out;
}

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
function isUuidLike(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "").trim()
  );
}
function pickAuthUidFromProfile(profile = {}) {
  const cands = [
    profile?.auth_uid,
    profile?.authUid,
    profile?.supabase_uid,
    profile?.supabaseUid,
    profile?.owner_uid,
    profile?.ownerUid,
    profile?.id, // only when UUID
  ];
  for (const c of cands) {
    if (isUuidLike(c)) return String(c).trim().toLowerCase();
  }
  return "";
}
function decodeJwtPayloadNoVerify(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(b64 + pad);
    const obj = JSON.parse(json);
    return (obj && typeof obj === "object") ? obj : null;
  } catch {
    return null;
  }
}
function pickSupabaseAccessToken(authSess = {}) {
  const cands = [
    authSess?.tokens?.access_token,
    authSess?.tokens?.accessToken,
    authSess?.raw?.tokens?.access_token,
    authSess?.raw?.tokens?.accessToken,
    authSess?.raw?.currentSession?.tokens?.access_token,
    authSess?.raw?.currentSession?.tokens?.accessToken,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  for (const tk of cands) {
    const payload = decodeJwtPayloadNoVerify(tk);
    const iss = String(payload?.iss || "").toLowerCase();
    const aud = payload?.aud;
    // Supabase access token usually has iss from project url and aud = authenticated.
    if (iss.includes("supabase.co/auth/v1") || aud === "authenticated") return tk;
  }
  return "";
}
function parseNumericUserId(v) {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? s : "";
}
function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}
function numericUserIdFromProfile(profile = {}) {
  const cands = [
    profile?.user_id,
    profile?.userId,
    profile?.db_user_id,
    profile?.dbUserId,
    profile?.users_id,
    profile?.usersId,
  ];
  for (const c of cands) {
    const n = parseNumericUserId(c);
    if (n) return n;
  }
  const provider = String(
    profile?.provider ||
    profile?.auth_provider ||
    ""
  ).trim().toLowerCase();
  if (!provider || provider === "email" || provider === "local") {
    const byId = parseNumericUserId(profile?.id);
    if (byId) return byId;
  }
  return "";
}
function sanitizeEmailUserIdMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const email = normalizeEmail(k);
    if (!email) continue;
    const rowUid = parseNumericUserId(v?.user_id ?? v?.id ?? v);
    if (!rowUid) continue;
    const updatedAt = Number(v?.updated_at || v?.updatedAt || Date.now());
    out[email] = {
      user_id: rowUid,
      updated_at: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    };
  }
  return out;
}
async function getEmailUserIdMap() {
  const st = await storeGet([STORAGE_KEYS.EMAIL_USER_ID_MAP]);
  return sanitizeEmailUserIdMap(st?.[STORAGE_KEYS.EMAIL_USER_ID_MAP]);
}
async function findCachedUserIdByEmail(email) {
  const em = normalizeEmail(email);
  if (!em) return "";
  const map = await getEmailUserIdMap();
  return parseNumericUserId(map?.[em]?.user_id);
}
async function cacheEmailUserId(email, userId) {
  const em = normalizeEmail(email);
  const uid = parseNumericUserId(userId);
  if (!em || !uid) return;

  const map = await getEmailUserIdMap();
  map[em] = { user_id: uid, updated_at: Date.now() };

  const keys = Object.keys(map);
  const MAX_KEYS = 300;
  if (keys.length > MAX_KEYS) {
    const sorted = keys
      .map((k) => ({ k, at: Number(map?.[k]?.updated_at || 0) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_KEYS);
    const pruned = {};
    for (const it of sorted) pruned[it.k] = map[it.k];
    await storeSet({ [STORAGE_KEYS.EMAIL_USER_ID_MAP]: pruned });
    return;
  }

  await storeSet({ [STORAGE_KEYS.EMAIL_USER_ID_MAP]: map });
}
async function patchStoredSessionUserId(userId) {
  const uid = parseNumericUserId(userId);
  if (!uid) return;

  const st = await storeGet([STORAGE_KEYS.VT_AUTH]);
  const raw = st?.[STORAGE_KEYS.VT_AUTH];
  if (!raw || typeof raw !== "object") return;

  let changed = false;
  const next = { ...raw };
  const patchProfile = (p) => {
    if (!p || typeof p !== "object") return p;
    const curA = parseNumericUserId(p.user_id);
    const curB = parseNumericUserId(p.db_user_id);
    if (curA === uid && curB === uid) return p;
    changed = true;
    return { ...p, user_id: uid, db_user_id: uid };
  };

  if (next.profile) next.profile = patchProfile(next.profile);
  if (next.currentSession?.profile) {
    next.currentSession = {
      ...next.currentSession,
      profile: patchProfile(next.currentSession.profile),
    };
  }

  if (changed) {
    await storeSet({ [STORAGE_KEYS.VT_AUTH]: next });
  }
}
async function resolveUsersTableUserIdSafe(profile = {}, authToken = "") {
  const email = normalizeEmail(profile?.email);

  // 0) If profile already has users.id, keep and cache by email.
  const direct = numericUserIdFromProfile(profile);
  if (direct) {
    if (email) await cacheEmailUserId(email, direct);
    await patchStoredSessionUserId(direct);
    return direct;
  }

  // 1) Fast local cache: email -> users.id
  if (email) {
    const cached = await findCachedUserIdByEmail(email);
    if (cached) {
      await patchStoredSessionUserId(cached);
      return cached;
    }
  }

  // 2) Remote resolve (email -> users.id, auth_uid -> users.id, etc.)
  try {
    const uid = await resolveUsersTableUserId(profile, { authToken });
    const n = parseNumericUserId(uid);
    if (n) {
      if (email) await cacheEmailUserId(email, n);
      await patchStoredSessionUserId(n);
      return n;
    }
  } catch {}

  // 3) Legacy fallback from profile hints.
  const fallback = numericUserIdFromProfile(profile);
  if (fallback) {
    if (email) await cacheEmailUserId(email, fallback);
    await patchStoredSessionUserId(fallback);
    return fallback;
  }
  throw new Error("USER_ID_INVALID");
}
function normalizeAuthProfile(authSess = {}) {
  const src = (authSess?.profile && typeof authSess.profile === "object")
    ? authSess.profile
    : {};
  const provider = String(
    src?.provider ||
    authSess?.raw?.provider ||
    authSess?.raw?.currentSession?.provider ||
    src?.auth_provider ||
    ""
  ).trim().toLowerCase();

  if (!provider) return { ...src };
  if (String(src?.provider || "").trim().toLowerCase() === provider) return { ...src };
  return { ...src, provider };
}
function buildUserIdDebug(profile = {}, authToken = "") {
  const out = {
    email: String(profile?.email || "").trim().toLowerCase(),
    provider: String(profile?.provider || "").trim().toLowerCase(),
    id: String(profile?.id || ""),
    user_id: String(profile?.user_id || ""),
    db_user_id: String(profile?.db_user_id || ""),
    has_auth_token: !!String(authToken || "").trim(),
  };
  return out;
}
function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}
function normalizeHttpApiBase(raw) {
  const input = String(raw || "").trim();
  if (!input) return "";

  const normalizePath = (pathname) => {
    let p = String(pathname || "").replace(/\/+$/, "");
    p = p.replace(/\/openapi\.json$/i, "");
    p = p.replace(/\/docs$/i, "");
    p = p.replace(/\/redoc$/i, "");
    return p.replace(/\/+$/, "");
  };

  const parseOne = (candidate) => {
    const u = parseUrlOrNull(candidate);
    if (!u) return "";
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const p = normalizePath(u.pathname || "");
    return `${u.origin}${p}`.replace(/\/+$/, "");
  };

  const direct = parseOne(input);
  if (direct) return direct;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const withHttps = parseOne(`https://${input}`);
    if (withHttps) return withHttps;
  }
  return input.replace(/\/+$/, "");
}
function deriveApiBaseFromServer(serverUrl) {
  const u = parseUrlOrNull(serverUrl);
  if (!u) return "";
  const origin = u.origin;
  if (origin.startsWith("wss://")) return origin.replace("wss://", "https://");
  if (origin.startsWith("ws://"))  return origin.replace("ws://", "http://");
  return origin;
}
function deriveTranslatorUrlFromServer(serverUrl) {
  const u = parseUrlOrNull(serverUrl);
  if (!u) return "";

  const out = new URL(u.toString());
  const p = out.pathname || "/";

  if (isLocalHost(out.hostname) && String(out.port || "") === "8765") {
    out.port = "8766";
    if (/^\/stt(?:\/|$)/i.test(p)) {
      out.pathname = p.replace(/^\/stt/i, "/tr");
    }
    out.search = "";
    out.hash = "";
    return out.toString();
  }

  if (/^\/stt(?:\/|$)/i.test(p)) {
    out.pathname = p.replace(/^\/stt/i, "/tr");
  } else if (!p || p === "/") {
    out.pathname = "/tr";
  }
  out.search = "";
  out.hash = "";
  return out.toString();
}
async function resolveTranslatorUrl(serverUrl = "") {
  const st = await storeGet([STORAGE_KEYS.TRANS_URL]);
  const stored = (st?.[STORAGE_KEYS.TRANS_URL] || "").trim();
  if (stored) return { url: stored, source: "stored" };

  const derived = deriveTranslatorUrlFromServer(serverUrl || current?.server || "");
  if (derived) return { url: derived, source: "derived" };

  return { url: "", source: "none" };
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
function buildSystemBusyResponse(extra = {}) {
  return { ok: false, code: "SYSTEM_BUSY", error: SYSTEM_BUSY_TEXT, ...extra };
}
async function notifySystemBusy(tabId) {
  if (!tabId) return;
  await notifyPanel(tabId, { level: "error", text: SYSTEM_BUSY_TEXT });
}
async function resetRuntimeAfterFailure(reason = "backend-failure") {
  try { await stopCapture(); } catch (e) { warn("stopCapture failed while resetting:", String(e?.message || e)); }
  try { setCurrentStopped(); } catch {}
  try { maybeUpdateTranslator(true); } catch {}
  warn("runtime reset after failure:", reason);
}
async function handleBackendFailure({ sendResponse, tabId, error, reason = "backend-failure", reset = true } = {}) {
  const msgErr = String(error?.message || error || "");
  warn(reason, msgErr);
  if (reset) await resetRuntimeAfterFailure(reason);
  await notifySystemBusy(tabId);
  try { sendResponse?.(buildSystemBusyResponse()); } catch {}
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

  const normalizedApiBase = normalizeHttpApiBase(apiBase);
  if (!normalizedApiBase) return { accessToken };
  const url = normalizedApiBase + DEFAULT_REFRESH_PATH;
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
  const normalizedApiBase = normalizeHttpApiBase(apiBase);
  if (!normalizedApiBase) throw new Error("API_BASE_INVALID");
  const url = normalizedApiBase + DEFAULT_TICKET_PATH;

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
async function startCaptureOnTab(tabId, wsUrl, auth = null, strictWs = true, recording = null) {
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
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({
        __cmd: "__OFFSCREEN_START__",
        payload: { streamId, server: wsUrl, auth, captureSource: "tab", strictWs, recording },
      });
    } catch (e) {
      resp = { ok: false, error: String(e?.message || e) };
    }
    if (resp?.ok) {
      maybeUpdateTranslator();
      return;
    }
    warn("OFFSCREEN_START tab failed -> fallback displayMedia. err=", String(resp?.error || "OFFSCREEN_START_FAILED"));
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
      payload: { server: wsUrl, auth, captureSource: "display", strictWs, recording },
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

  const offscreenStopPromise = chrome.runtime
    .sendMessage({ __cmd: "__OFFSCREEN_STOP__" })
    .catch(() => null);

  // Clear + remove overlay so next run starts from a clean visual state.
  if (tabId != null) {
    try { await safeSendTab(tabId, { __cmd: "__OVERLAY_RESET__", payload: { keepMode: false, showDots: false } }); } catch {}
    await removeOverlay(tabId);
  }
  try { await offscreenStopPromise; } catch {}

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
      .catch((e) => console.warn("open sidepanel failed (fallback)", e));
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
  rxCommit: 0,
  rxDraft: 0,
  rxStable: 0,
  rxError: 0,
  lastLogAt: 0,
  lastTxStableSeq: -1,
  lastRxViSeq: -1,
};
let lastTranslatorNotifyAt = 0;
let lastTranslatorNotifyText = "";

function maybeLogTranslatorRate() {
  if (!TRANS_DEBUG) return;
  const now = Date.now();
  if (!trDbg.lastLogAt) trDbg.lastLogAt = now;
  if (now - trDbg.lastLogAt >= 2000) {
    tlog("rate/2s", { ...trDbg });
    // reset moving counters only (giữ lastTxStableSeq/lastRxViSeq)
    trDbg.txReset = trDbg.txBaseline = trDbg.txStable = trDbg.dropStable = 0;
    trDbg.rxHello = trDbg.rxStatus = trDbg.rxDelta = trDbg.rxCommit = trDbg.rxDraft = trDbg.rxStable = trDbg.rxError = 0;
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
let lastRxViCommitSeq = -1;

async function loadTranslatorUrlFromStorage() {
  const resolved = await resolveTranslatorUrl(current?.server || "");
  if (resolved?.url) transUrl = resolved.url;
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
    lastRxViCommitSeq = -1;
    lastTranslatorNotifyAt = 0;
    lastTranslatorNotifyText = "";

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
      lastRxViCommitSeq = -1;
      tlog("WS open");

      // Reset VI overlay guard/state on every translator (re)connect so seq/epoch restarts stay stable.
      if (current?.tabId != null) {
        safeSendTab(current.tabId, { __cmd: "__TRANS_VI_RESET__" }).catch(() => {});
      }

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

      if (typ === "hello") {
        trDbg.rxHello++;
        tlog("<- hello", obj.detail || obj);
        const d = obj.detail || {};
        await safeSendTab(current.tabId, {
          __cmd: "__TRANS_VI_CFG__",
          payload: {
            draftEnabled: !!d.vi_draft_enabled,
            sentenceLag: Number.isFinite(Number(d.sentence_lag)) ? Number(d.sentence_lag) : null,
          },
        });
      }
      if (typ === "status") { trDbg.rxStatus++; tlog("<- status", obj.detail || obj); }

      if (typ === "vi-commit") {
        trDbg.rxCommit++;
        const viSeq = Number(obj.seq ?? 0);
        if (Number.isFinite(viSeq) && viSeq > 0) {
          trDbg.lastRxViSeq = viSeq;
          lastRxViCommitSeq = Math.max(lastRxViCommitSeq, viSeq);
        }
        tlog("<- vi-commit", {
          seq: obj.seq ?? null,
          en_seq: obj.en_seq ?? null,
          appendLen: (obj.append || "").length,
          tail: String(obj.append || "").slice(-60),
        });
        maybeLogTranslatorRate();

        await safeSendTab(current.tabId, { __cmd: "__TRANS_VI_COMMIT__", payload: obj });
        return;
      }

      if (typ === "vi-draft") {
        trDbg.rxDraft++;
        tlog("<- vi-draft", {
          seq: obj.seq ?? null,
          en_seq: obj.en_seq ?? null,
          req_id: obj.req_id ?? null,
          textLen: String(obj.text || obj.full || "").length,
        });
        maybeLogTranslatorRate();

        await safeSendTab(current.tabId, { __cmd: "__TRANS_VI_DRAFT__", payload: obj });
        return;
      }

      if (typ === "vi-delta") {
        trDbg.rxDelta++;
        const viSeq = Number(obj.seq ?? 0);
        if (Number.isFinite(viSeq) && viSeq > 0) {
          trDbg.lastRxViSeq = viSeq;
          // If commit channel is available, drop compatible delta duplicates.
          if (viSeq <= lastRxViCommitSeq) {
            maybeLogTranslatorRate();
            return;
          }
        }

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
        const trErrText = String(obj.error || obj.message || obj.detail || "Translator error");
        twarn("Translator error:", trErrText);
        if (current?.tabId) {
          const now = Date.now();
          if (
            trErrText !== lastTranslatorNotifyText ||
            (now - lastTranslatorNotifyAt) >= 8000
          ) {
            lastTranslatorNotifyAt = now;
            lastTranslatorNotifyText = trErrText;
            await notifyPanel(current.tabId, {
              level: "info",
              text: `Phiên dịch tạm thời không khả dụng: ${trErrText}`,
            });
          }
        }
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
  const record = !!(m.record ?? m.rec ?? m.recording ?? m.ghi);
  return { en, vi, voice, record };
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
    })().catch((e) => warn("storage.onChanged handler failed:", String(e?.message || e)));
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
    })().catch((e) => warn("tabs.onRemoved handler failed:", String(e?.message || e)));
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
        await resetRuntimeAfterFailure(`offscreen-${s}`);
        if (current?.tabId) await notifySystemBusy(current.tabId);
      } else if (s === "error") {
        // đảm bảo không giữ trạng thái running/starting giả nếu offscreen lỗi
        await resetRuntimeAfterFailure("offscreen-error");
        if (current?.tabId) await notifySystemBusy(current.tabId);
      } else if (s === "recording-saved") {
        log("recording saved:", p);
      } else if (s === "recording-error") {
        warn("recording error:", p);
        if (current?.tabId) {
          await notifyPanel(current.tabId, {
            level: "info",
            text: `Ghi video lỗi (${String(p?.stage || "unknown")}): ${String(p?.error || "unknown")}`,
            detail: p,
          });
        }
      }

      // logs
      if (s === "media-ok") {
        log("OFFSCREEN media-ok audioTracks=", p.audioTracks, "label=", p.audioLabel);
      } else if (s === "meter") {
        log("AUDIO meter rms=", p.rms?.toFixed?.(4), "peak=", p.peak?.toFixed?.(4),
          "wsOpen=", p.wsOpen, "bytesSent=", p.bytesSent, "chunksSent=", p.chunksSent,
          "bytesDropped=", p.bytesDropped, "chunksDropped=", p.chunksDropped,
          "wsBufferedAmount=", p.wsBufferedAmount, "backpressure=", p.wsBackpressureActive);
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

      const isStable = msg.__cmd === "__TRANSCRIPT_STABLE__";
      let stableFull = "";
      let stableSeq = null;
      let stableTms = null;

      if (isStable) {
        const p = msg.payload || msg.detail || {};
        stableFull = (
          p.full ??
          msg.full ??
          p.text ??
          msg.text ??
          p.detail?.full ??
          p.detail?.text ??
          ""
        ).toString();
        stableSeq = p.seq ?? msg.seq ?? p.stable_seq ?? null;
        stableTms = p.t_ms ?? msg.t_ms ?? null;
      }

      // relay to overlay (trim heavy stable payload for long-running sessions)
      if (current?.tabId) {
        const relayMsg = isStable ? buildOverlayStableRelayMsg(msg, stableFull) : msg;
        await safeSendTab(current.tabId, relayMsg);
      }

      // ✅ STABLE-ONLY translation: chỉ feed stable.full sang translator
      if (isStable) {
        // cache for baseline on connect
        lastEnStable = { full: stableFull, seq: Number(stableSeq || 0), t_ms: Number(stableTms || 0) };

        // feed stable if translator online
        feedTranslatorStable(stableFull, stableSeq, stableTms);

        // persist to Supabase (delay 1 sentence)
        if (transcriptPersist) {
          try { transcriptPersist.handleStable(stableFull, stableSeq); } catch {}
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

        // public wss may run without auth ticket (server.py REQUIRE_AUTH=0).
        if (isWss && !isLocalDev && !accessToken) {
          warn("No access token on non-local wss; continue in direct/no-auth mode.");
        }

        const st = await storeGet([STORAGE_KEYS.API_BASE]);
        const apiBaseRaw = (st[STORAGE_KEYS.API_BASE] || deriveApiBaseFromServer(server)).trim();
        const apiBase = normalizeHttpApiBase(apiBaseRaw);

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
        const trResolved = await resolveTranslatorUrl(server);
        const transServer = trResolved?.url || "";
        const profile = normalizeAuthProfile(authSess);
        const supaAuthToken = pickSupabaseAccessToken(authSess);
        const userEmail = String(profile.email || "").trim();
        let userId = "";
        try {
          const uid = await resolveUsersTableUserIdSafe(profile, supaAuthToken);
          userId = uid ? String(uid) : "";
        } catch {
          userId = "";
        }
        transcriptPersist = createTranscriptPersist({
          userId,
          userEmail,
          authToken: supaAuthToken,
          tabUrl: tab.url || "",
          sttServer: server,
          translatorServer: transServer,
          langSrc: "en",
          langTgt: wantTranslateVI ? "vi" : "",
        });
        try { await transcriptPersist.start(); } catch {}
        const trSessionId = transcriptPersist?.getSessionId?.() || "";
        const recordingEnabled = !!currentModes.record && !!userId;
        if (currentModes.record && !recordingEnabled) {
          await notifyPanel(tab.id, {
            level: "info",
            text: "Không thể bật Ghi vì chưa xác định được user id hợp lệ.",
          });
        }
        const recording =
          recordingEnabled
            ? {
              enabled: true,
              userId: userId || "",
              authToken: supaAuthToken || "",
              trSessionId: trSessionId ? String(trSessionId) : "",
              tabUrl: tab.url || "",
              sttServer: server,
            }
            : { enabled: false };

        await startCaptureOnTab(tab.id, finalWsUrl, auth, strictWs, recording);

        current = current || {};
        current.server = server;
        current.finalWsUrl = finalWsUrl;

        await trySendOverlayMode(tab.id);

        const mode = auth ? "auth-message" : ((isWss && accessToken && apiBase) ? "ticket" : "direct");
        sendResponse?.({ ok: true, mode, ws: finalWsUrl });
      } catch (e) {
        if (transcriptPersist) {
          try { await transcriptPersist.stop(lastEnStable?.full || ""); } catch {}
          transcriptPersist = null;
        }
        await handleBackendFailure({
          sendResponse,
          tabId: tab?.id || current?.tabId || null,
          error: e,
          reason: "__PANEL_START__ failed",
        });
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

    // snapshot realtime transcript for chat prompt context (sidepanel)
    if (msg.__cmd === "__CHAT_REALTIME_SNAPSHOT__") {
      sendResponse?.({
        ok: true,
        active: !!current?.startedAt,
        starting: !!current?.starting,
        tabId: current?.tabId || null,
        full: String(lastEnStable?.full || ""),
        seq: Number(lastEnStable?.seq || 0),
        t_ms: Number(lastEnStable?.t_ms || 0),
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
        const profile = normalizeAuthProfile(authSess);
        const supaAuthToken = pickSupabaseAccessToken(authSess);
        const userId = await resolveUsersTableUserIdSafe(profile, supaAuthToken);

        const items = await listTranscriptSessionsForUser(userId, {
          limit,
          offset,
          authToken: supaAuthToken,
        });
        sendResponse?.({ ok: true, items, userId });
      } catch (e) {
        const msgErr = String(e?.message || e);
        if (msgErr.includes("USER_ID_INVALID")) {
          const profile = normalizeAuthProfile(authSess);
          const supaAuthToken = pickSupabaseAccessToken(authSess);
          sendResponse?.({
            ok: false,
            code: "USER_ID_INVALID",
            error: "USER_ID_INVALID",
            debug: buildUserIdDebug(profile, supaAuthToken),
          });
          return;
        }
        if (tabIdForNotify) await notifySystemBusy(tabIdForNotify);
        sendResponse?.(buildSystemBusyResponse());
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

        const profile = normalizeAuthProfile(authSess);
        const supaAuthToken = pickSupabaseAccessToken(authSess);
        const userId = await resolveUsersTableUserIdSafe(profile, supaAuthToken);
        const detail = await getTranscriptSessionDetailForUser(userId, sessionId, {
          authToken: supaAuthToken,
        });

        if (!detail) {
          sendResponse?.({ ok: false, code: "NOT_FOUND", error: "NOT_FOUND" });
          return;
        }

        sendResponse?.({ ok: true, item: detail.session, fullText: detail.fullText, userId });
      } catch (e) {
        const msgErr = String(e?.message || e);
        if (msgErr.includes("USER_ID_INVALID")) {
          const profile = normalizeAuthProfile(authSess);
          const supaAuthToken = pickSupabaseAccessToken(authSess);
          sendResponse?.({
            ok: false,
            code: "USER_ID_INVALID",
            error: "USER_ID_INVALID",
            debug: buildUserIdDebug(profile, supaAuthToken),
          });
          return;
        }
        if (tabIdForNotify) await notifySystemBusy(tabIdForNotify);
        sendResponse?.(buildSystemBusyResponse());
      }
      return;
    }
    // Delete one history session from Supabase (AUTH REQUIRED)
    if (msg.__cmd === "__HISTORY_DELETE__") {
      const tabIdForNotify = current?.tabId || null;
      const authSess = await requireAuthOrFail({ action: "history_delete", tabId: tabIdForNotify, sendResponse });
      if (!authSess) return;

      try {
        const sessionId = Number(msg.payload?.sessionId || 0);
        if (!Number.isFinite(sessionId) || sessionId <= 0) {
          sendResponse?.({ ok: false, error: "INVALID_SESSION_ID" });
          return;
        }

        const profile = normalizeAuthProfile(authSess);
        const supaAuthToken = pickSupabaseAccessToken(authSess);
        const userId = await resolveUsersTableUserIdSafe(profile, supaAuthToken);
        const deleted = await deleteTranscriptSessionForUser(userId, sessionId, {
          authToken: supaAuthToken,
        });

        if (!deleted?.deleted) {
          sendResponse?.({
            ok: false,
            code: "NOT_FOUND",
            error: "NOT_FOUND",
            sessionId,
          });
          return;
        }

        sendResponse?.({
          ok: true,
          deleted: true,
          sessionId: Number(deleted.sessionId || sessionId),
          userId,
        });
      } catch (e) {
        const msgErr = String(e?.message || e);
        if (msgErr.includes("USER_ID_INVALID")) {
          const profile = normalizeAuthProfile(authSess);
          const supaAuthToken = pickSupabaseAccessToken(authSess);
          sendResponse?.({
            ok: false,
            code: "USER_ID_INVALID",
            error: "USER_ID_INVALID",
            debug: buildUserIdDebug(profile, supaAuthToken),
          });
          return;
        }
        if (tabIdForNotify) await notifySystemBusy(tabIdForNotify);
        sendResponse?.(buildSystemBusyResponse());
      }
      return;
    }
    // Persist chat session/messages to Supabase (AUTH REQUIRED)
    if (msg.__cmd === "__CHAT_DB_SAVE__") {
      const tabIdForNotify = current?.tabId || null;
      const authSess = await requireAuthOrFail({ action: "chat_save", tabId: tabIdForNotify, sendResponse });
      if (!authSess) return;

      try {
        const payload = msg.payload || {};
        const profile = normalizeAuthProfile(authSess);
        const supaAuthToken = pickSupabaseAccessToken(authSess);
        const userId = await resolveUsersTableUserIdSafe(profile, supaAuthToken);
        const ownerUid = pickAuthUidFromProfile(profile);

        const role = String(payload.role || "").trim().toLowerCase();
        const content = String(payload.content || "").trim();
        if (!content) {
          sendResponse?.({ ok: false, error: "EMPTY_MESSAGE_CONTENT" });
          return;
        }

        const ensured = await ensureChatSessionForUser(userId, {
          chatSessionId: payload.chatSessionId ?? null,
          titleHint: payload.titleHint || content,
          source: payload.source || "sidepanel",
          model: payload.model || "",
          language: payload.language || "",
          startedAt: payload.startedAt || payload.createdAt || new Date().toISOString(),
          ownerUid,
          authToken: supaAuthToken,
        });

        const messageId = await insertChatMessage(ensured.chatSessionId, {
          parentMsgId: payload.parentMsgId ?? null,
          role,
          content,
          createdAt: payload.createdAt || new Date().toISOString(),
          tokensIn: payload.tokensIn ?? null,
          tokensOut: payload.tokensOut ?? null,
          latencyMs: payload.latencyMs ?? null,
          authToken: supaAuthToken,
        });

        // Best-effort: keep ended_at fresh whenever assistant replies.
        if (role === "assistant") {
          try {
            await touchChatSession(ensured.chatSessionId, {
              endedAt: payload.createdAt || new Date().toISOString(),
            }, supaAuthToken);
          } catch {}
        }

        sendResponse?.({
          ok: true,
          userId,
          chatSessionId: ensured.chatSessionId,
          messageId,
          createdSession: !!ensured.created,
        });
      } catch (e) {
        const msgErr = String(e?.message || e);
        if (msgErr.includes("USER_ID_INVALID")) {
          const profile = normalizeAuthProfile(authSess);
          const supaAuthToken = pickSupabaseAccessToken(authSess);
          sendResponse?.({
            ok: false,
            code: "USER_ID_INVALID",
            error: "USER_ID_INVALID",
            debug: buildUserIdDebug(profile, supaAuthToken),
          });
          return;
        }
        if (tabIdForNotify) await notifySystemBusy(tabIdForNotify);
        sendResponse?.(buildSystemBusyResponse());
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
        const normalizedApiBase = normalizeHttpApiBase(apiBase || "");
        if (!normalizedApiBase) {
          sendResponse({ ok: false, error: "CHAT_API_BASE_INVALID" });
          return;
        }
        const url = normalizedApiBase + "/v1/rest-retrieve/";

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
        await handleBackendFailure({
          sendResponse,
          tabId: tabIdForNotify,
          error: e,
          reason: "__CHAT_REST__ failed",
          reset: false,
        });
      }
      return;
    }
  })().catch((e) => {
    const tabId = current?.tabId || sender?.tab?.id || null;
    handleBackendFailure({
      sendResponse,
      tabId,
      error: e,
      reason: "onMessage uncaught",
    }).catch(() => {});
  });

  // keep channel open for async sendResponse
  return true;
});

self.addEventListener("unhandledrejection", (event) => {
  try { event.preventDefault(); } catch {}
  warn("unhandledrejection captured:", String(event?.reason?.message || event?.reason || "unknown"));
});

self.addEventListener("error", (event) => {
  try { event.preventDefault?.(); } catch {}
  warn("error captured:", String(event?.message || "unknown"));
});

// đảm bảo mọi tab đều dùng sidepanel.html
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") {
    try { chrome.sidePanel?.setOptions?.({ tabId, path: "sidepanel.html", enabled: true }); } catch {}
  }
});
