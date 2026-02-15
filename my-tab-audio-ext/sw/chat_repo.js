// Persist chat sessions/messages to Supabase for sidepanel chatbot.

const SUPABASE_URL = "https://izziphjuznnzhcdbbptw.supabase.co";
const SUPABASE_KEY = "sb_publishable_YNUg4THwvvBurGGn59s8Kg_OSkVpVfh";

function authHeaders(extra = {}, authToken = "") {
  const bearer = String(authToken || "").trim() || SUPABASE_KEY;
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    ...extra,
  };
}

function normalizeBigintId(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? s : null;
}

function normalizeTextRef(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function normalizeUuid(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s)
    ? s
    : "";
}

function toIsoOrNow(v) {
  const t = Date.parse(String(v || ""));
  if (Number.isFinite(t)) return new Date(t).toISOString();
  return new Date().toISOString();
}

function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clipText(s, maxLen = 160) {
  const txt = String(s || "").replace(/\s+/g, " ").trim();
  if (!txt) return "Chat sidepanel";
  if (txt.length <= maxLen) return txt;
  return txt.slice(0, Math.max(0, maxLen - 3)) + "...";
}

async function fetchJson(url, init = {}) {
  const r = await fetch(url, init);
  const txt = await r.text().catch(() => "");
  const json = txt
    ? (() => {
      try { return JSON.parse(txt); } catch { return null; }
    })()
    : null;
  if (!r.ok) {
    const detail = (json && (json.message || json.error || json.hint)) || txt || `HTTP ${r.status}`;
    throw new Error(`SUPABASE_${r.status}: ${String(detail)}`);
  }
  return json;
}

async function getChatSessionForUser(userId, chatSessionId, ownerUid = "", authToken = "") {
  const uid = normalizeBigintId(userId);
  const sid = normalizeBigintId(chatSessionId);
  const owner = normalizeUuid(ownerUid);
  if (!sid) return null;
  if (!uid && !owner) return null;

  const p = new URLSearchParams({ select: "id,user_id,title,owner_uid", id: `eq.${String(sid)}`, limit: "1" });
  if (uid) p.set("user_id", `eq.${String(uid)}`);
  else p.set("owner_uid", `eq.${owner}`);
  const url = `${SUPABASE_URL}/rest/v1/chat_sessions?${p.toString()}`;
  const rows = await fetchJson(url, { headers: authHeaders({}, authToken) });
  if (!Array.isArray(rows) || !rows[0]) return null;
  return rows[0];
}

export async function createChatSessionForUser(userId, opts = {}) {
  const uid = normalizeBigintId(userId);
  if (!uid) throw new Error("USER_ID_INVALID");

  const body = {
    user_id: uid,
    started_at: toIsoOrNow(opts.startedAt),
    ended_at: null,
    title: clipText(opts.titleHint || ""),
    source: String(opts.source || "sidepanel"),
    model: String(opts.model || ""),
    language: String(opts.language || ""),
  };
  const ownerUid = normalizeUuid(opts.ownerUid || opts.owner_uid || "");
  if (ownerUid) body.owner_uid = ownerUid;

  const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/chat_sessions`, {
    method: "POST",
    headers: authHeaders({ Prefer: "return=representation" }, opts.authToken || ""),
    body: JSON.stringify(body),
  });

  const row = Array.isArray(rows) ? rows[0] : null;
  const sid = normalizeBigintId(row?.id);
  if (!sid) throw new Error("CHAT_SESSION_CREATE_FAILED");
  return sid;
}

export async function ensureChatSessionForUser(userId, opts = {}) {
  const uid = normalizeBigintId(userId);
  if (!uid) throw new Error("USER_ID_INVALID");
  const ownerUid = normalizeUuid(opts.ownerUid || opts.owner_uid || "");

  const sid = normalizeBigintId(opts.chatSessionId);
  if (sid) {
    const found = await getChatSessionForUser(uid, sid, ownerUid, opts.authToken || "");
    if (found) return { chatSessionId: normalizeBigintId(found.id), created: false };
  }

  const createdId = await createChatSessionForUser(uid, { ...opts, ownerUid });
  return { chatSessionId: createdId, created: true };
}

export async function insertChatMessage(chatSessionId, opts = {}) {
  const sid = normalizeBigintId(chatSessionId);
  if (!sid) throw new Error("CHAT_SESSION_ID_INVALID");

  const roleRaw = String(opts.role || "").trim().toLowerCase();
  const role = roleRaw === "assistant" || roleRaw === "system" ? roleRaw : "user";
  const content = String(opts.content || "").trim();
  if (!content) throw new Error("EMPTY_MESSAGE_CONTENT");

  const parentMsgId = normalizeTextRef(opts.parentMsgId);
  const body = {
    chat_session_id: sid,
    parent_msg_id: parentMsgId || null,
    role,
    content,
    tokens_in: toNumOrNull(opts.tokensIn),
    tokens_out: toNumOrNull(opts.tokensOut),
    latency_ms: toNumOrNull(opts.latencyMs),
    created_at: toIsoOrNow(opts.createdAt),
  };

  const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method: "POST",
    headers: authHeaders({ Prefer: "return=representation" }, opts.authToken || ""),
    body: JSON.stringify(body),
  });

  const row = Array.isArray(rows) ? rows[0] : null;
  const msgId = normalizeBigintId(row?.id);
  if (!msgId) throw new Error("CHAT_MESSAGE_INSERT_FAILED");
  return msgId;
}

export async function touchChatSession(chatSessionId, patch = {}, authToken = "") {
  const sid = normalizeBigintId(chatSessionId);
  if (!sid) return false;

  const body = {};
  if (patch.endedAt !== undefined) body.ended_at = toIsoOrNow(patch.endedAt);
  if (patch.title !== undefined) body.title = clipText(patch.title || "");
  if (!Object.keys(body).length) return false;

  const url = `${SUPABASE_URL}/rest/v1/chat_sessions?id=eq.${encodeURIComponent(String(sid))}`;
  await fetchJson(url, {
    method: "PATCH",
    headers: authHeaders({ Prefer: "return=minimal" }, authToken),
    body: JSON.stringify(body),
  });
  return true;
}
