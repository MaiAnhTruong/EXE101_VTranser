// Read transcript history from Supabase for sidepanel History view.

const SUPABASE_URL = "https://izziphjuznnzhcdbbptw.supabase.co";
const SUPABASE_KEY = "sb_publishable_YNUg4THwvvBurGGn59s8Kg_OSkVpVfh";

function authHeaders(authToken = "") {
  const bearer = String(authToken || "").trim() || SUPABASE_KEY;
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
  };
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function isNumericId(v) {
  return /^\d+$/.test(String(v || "").trim());
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "").trim()
  );
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function parseNumericId(v) {
  const s = String(v ?? "").trim();
  return isNumericId(s) ? s : "";
}

function parseDbId(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return isNumericId(s) ? s : "";
}

async function fetchJson(url, init = {}) {
  const r = await fetch(url, init);
  const txt = await r.text().catch(() => "");
  const json = txt ? (() => { try { return JSON.parse(txt); } catch { return null; } })() : null;
  if (!r.ok) {
    const detail = (json && (json.message || json.error || json.hint)) || txt || `HTTP ${r.status}`;
    throw new Error(`SUPABASE_${r.status}: ${String(detail)}`);
  }
  return json;
}

async function fetchJsonWithAuthFallback(url, authToken = "") {
  const token = String(authToken || "").trim();
  try {
    return await fetchJson(url, { headers: authHeaders(token) });
  } catch (e) {
    if (!token) throw e;
    // fallback for environments where key-only access is still enabled
    return await fetchJson(url, { headers: authHeaders("") });
  }
}

function normalizeUserIdOrThrow(userId) {
  const uid = parseDbId(userId);
  if (!uid) throw new Error("USER_ID_INVALID");
  return uid;
}

async function selectUsersIdByEmail(email, authToken = "") {
  const emLower = normalizeEmail(email);
  const emRaw = String(email || "").trim();
  const cands = [...new Set([emLower, emRaw].filter(Boolean))];

  for (const em of cands) {
    for (const op of ["eq", "ilike"]) {
      const p = new URLSearchParams({
        select: "id",
        email: `${op}.${em}`,
        limit: "1",
      });
      const url = `${SUPABASE_URL}/rest/v1/users?${p.toString()}`;
      try {
        const rows = await fetchJson(url, { headers: authHeaders(authToken) });
        const rid = parseDbId(rows?.[0]?.id);
        if (Array.isArray(rows) && rid) {
          return rid;
        }
      } catch {
        // RLS/permissions can block users lookup; fallback logic handles it.
      }
    }
  }
  return "";
}

async function selectUsersIdByAuthUid(authUid, authToken = "") {
  const au = String(authUid || "").trim().toLowerCase();
  if (!isUuid(au)) return "";

  const p = new URLSearchParams({
    select: "id",
    auth_uid: `eq.${au}`,
    limit: "1",
  });
  const url = `${SUPABASE_URL}/rest/v1/users?${p.toString()}`;
  try {
    const rows = await fetchJson(url, { headers: authHeaders(authToken) });
    const rid = parseDbId(rows?.[0]?.id);
    if (Array.isArray(rows) && rid) {
      return rid;
    }
  } catch {
    // Column missing / RLS deny / permission deny => keep fallback chain.
  }
  return "";
}

async function insertUsersRowByEmail(email, authToken = "") {
  const em = normalizeEmail(email);
  if (!em) return "";

  const body = {
    email: em,
    phone: null,
    password_hash: "oauth",
    auth_provider: "oauth",
    status: "active",
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  };

  const url = `${SUPABASE_URL}/rest/v1/users`;
  try {
    const rows = await fetchJson(url, {
      method: "POST",
      headers: {
        ...authHeaders(authToken),
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });
    const rid = parseDbId(rows?.[0]?.id);
    if (Array.isArray(rows) && rid) return rid;
  } catch {
    // ignore; caller continues with next fallback.
  }
  const existing = await selectUsersIdByEmail(em, authToken);
  if (existing) return existing;
  return "";
}

async function selectUserIdFromOwnChatSessions(authToken = "", ownerUid = "") {
  const token = String(authToken || "").trim();
  if (!token) return "";

  const p = new URLSearchParams({
    select: "user_id",
    user_id: "not.is.null",
    order: "started_at.desc,id.desc",
    limit: "1",
  });
  const owner = String(ownerUid || "").trim().toLowerCase();
  if (isUuid(owner)) p.set("owner_uid", `eq.${owner}`);

  const url = `${SUPABASE_URL}/rest/v1/chat_sessions?${p.toString()}`;
  try {
    const rows = await fetchJson(url, { headers: authHeaders(token) });
    const rid = parseDbId(rows?.[0]?.user_id);
    if (Array.isArray(rows) && rid) return rid;
  } catch {}
  return "";
}

async function selectUserIdFromOwnTranscriptSessions(authToken = "") {
  const token = String(authToken || "").trim();
  if (!token) return "";

  const p = new URLSearchParams({
    select: "user_id",
    user_id: "not.is.null",
    order: "started_at.desc,id.desc",
    limit: "1",
  });
  const url = `${SUPABASE_URL}/rest/v1/transcript_sessions?${p.toString()}`;
  try {
    const rows = await fetchJson(url, { headers: authHeaders(token) });
    const rid = parseDbId(rows?.[0]?.user_id);
    if (Array.isArray(rows) && rid) return rid;
  } catch {}
  return "";
}

function userIdCandidateFromProfile(profile = {}) {
  const direct = [
    profile?.user_id,
    profile?.userId,
    profile?.db_user_id,
    profile?.dbUserId,
    profile?.users_id,
    profile?.usersId,
  ];
  for (const v of direct) {
    const n = parseDbId(v);
    if (n) return n;
  }
  const provider = String(
    profile?.provider ||
    profile?.auth_provider ||
    ""
  ).trim().toLowerCase();
  if (!provider || provider === "email" || provider === "local") {
    const byId = parseDbId(profile?.id);
    if (byId) return byId;
  }
  return "";
}

function authUidCandidateFromProfile(profile = {}) {
  const direct = [
    profile?.auth_uid,
    profile?.authUid,
    profile?.supabase_uid,
    profile?.supabaseUid,
    profile?.owner_uid,
    profile?.ownerUid,
  ];
  for (const v of direct) {
    if (isUuid(v)) return String(v).trim().toLowerCase();
  }

  // Some auth payloads place Supabase auth uid in profile.id.
  if (isUuid(profile?.id)) return String(profile.id).trim().toLowerCase();
  return "";
}

export async function resolveUsersTableUserId(profile = {}, opts = {}) {
  const authToken = String(opts?.authToken || "").trim();
  const email = normalizeEmail(profile?.email);

  // 0) Canonical mapping: users.email -> users.id
  if (email) {
    const byEmailWithAuth = await selectUsersIdByEmail(email, authToken);
    if (byEmailWithAuth) return byEmailWithAuth;

    const insertedWithAuth = await insertUsersRowByEmail(email, authToken);
    if (insertedWithAuth) return insertedWithAuth;

    // fallback without auth token when DB policy allows key-only access
    const byEmailKeyOnly = await selectUsersIdByEmail(email, "");
    if (byEmailKeyOnly) return byEmailKeyOnly;

    const insertedKeyOnly = await insertUsersRowByEmail(email, "");
    if (insertedKeyOnly) return insertedKeyOnly;
  }

  // 1) Fast fallback when profile already carries mapped users.id
  const directId = userIdCandidateFromProfile(profile);
  if (directId) return directId;

  // 2) Optional mapping by users.auth_uid (if schema/policy enabled)
  const authUid = authUidCandidateFromProfile(profile);
  const byAuthUid = await selectUsersIdByAuthUid(authUid, authToken);
  if (byAuthUid) return byAuthUid;

  // 3) Fallback mapping from rows already owned by this authenticated user.
  const fromOwnChats = await selectUserIdFromOwnChatSessions(authToken, authUid);
  if (fromOwnChats) return fromOwnChats;

  const fromOwnTranscripts = await selectUserIdFromOwnTranscriptSessions(authToken);
  if (fromOwnTranscripts) return fromOwnTranscripts;

  throw new Error("USER_ID_INVALID");
}

function normalizeSessionRow(row) {
  const id = toInt(row?.id, 0);
  if (!id) return null;
  return {
    id,
    user_id: parseDbId(row?.user_id) || null,
    tab_url: String(row?.tab_url || ""),
    tab_domain: String(row?.tab_domain || ""),
    started_at: row?.started_at || null,
    ended_at: row?.ended_at || null,
    status: String(row?.status || ""),
    latest_text_en: String(row?.latest_text_en || ""),
    last_seq: Number.isFinite(Number(row?.last_seq)) ? Number(row.last_seq) : null,
    last_updated_at: row?.last_updated_at || null,
  };
}

function sortSessionsDesc(rows) {
  const ts = (r) => {
    const t = Date.parse(r?.started_at || r?.last_updated_at || "");
    return Number.isFinite(t) ? t : 0;
  };
  return rows.sort((a, b) => ts(b) - ts(a) || (b.id - a.id));
}

export async function listTranscriptSessionsForUser(
  userId,
  { limit = 200, offset = 0, authToken = "" } = {}
) {
  const uid = normalizeUserIdOrThrow(userId);

  const lim = Math.max(1, Math.min(500, toInt(limit, 200)));
  const off = Math.max(0, toInt(offset, 0));

  const p = new URLSearchParams({
    select: "*",
    user_id: `eq.${uid}`,
    order: "started_at.desc,id.desc",
    limit: String(lim),
    offset: String(off),
  });

  const url = `${SUPABASE_URL}/rest/v1/transcript_sessions?${p.toString()}`;
  const rows = await fetchJsonWithAuthFallback(url, authToken);
  if (!Array.isArray(rows)) return [];

  const out = [];
  for (const r of rows) {
    const n = normalizeSessionRow(r);
    if (n) out.push(n);
  }
  return sortSessionsDesc(out);
}

export async function getTranscriptSessionDetailForUser(
  userId,
  sessionId,
  opts = {}
) {
  const uid = normalizeUserIdOrThrow(userId);
  const authToken = String(opts?.authToken || "").trim();

  const sid = toInt(sessionId, 0);
  if (!sid) throw new Error("INVALID_SESSION_ID");

  const pSession = new URLSearchParams({
    select: "*",
    id: `eq.${sid}`,
    user_id: `eq.${uid}`,
    limit: "1",
  });
  const sessionUrl = `${SUPABASE_URL}/rest/v1/transcript_sessions?${pSession.toString()}`;
  const sessionRows = await fetchJsonWithAuthFallback(sessionUrl, authToken);
  if (!Array.isArray(sessionRows) || !sessionRows[0]) return null;

  const session = normalizeSessionRow(sessionRows[0]);
  if (!session) return null;

  let fullText = session.latest_text_en || "";
  try {
    const pChunk0 = new URLSearchParams({
      select: "seq,text_en,is_stable",
      tr_session_id: `eq.${sid}`,
      seq: "eq.0",
      limit: "1",
    });
    const chunk0Url = `${SUPABASE_URL}/rest/v1/transcript_chunks?${pChunk0.toString()}`;
    const chunk0Rows = await fetchJsonWithAuthFallback(chunk0Url, authToken);
    if (Array.isArray(chunk0Rows) && chunk0Rows[0] && typeof chunk0Rows[0].text_en === "string") {
      fullText = chunk0Rows[0].text_en || fullText;
    } else {
      const pChunkLatest = new URLSearchParams({
        select: "seq,text_en,is_stable",
        tr_session_id: `eq.${sid}`,
        order: "seq.desc",
        limit: "1",
      });
      const chunkLatestUrl = `${SUPABASE_URL}/rest/v1/transcript_chunks?${pChunkLatest.toString()}`;
      const chunkLatestRows = await fetchJsonWithAuthFallback(chunkLatestUrl, authToken);
      if (Array.isArray(chunkLatestRows) && chunkLatestRows[0] && typeof chunkLatestRows[0].text_en === "string") {
        fullText = chunkLatestRows[0].text_en || fullText;
      }
    }
  } catch {
    // fallback latest_text_en only
  }

  return {
    session,
    fullText: String(fullText || ""),
  };
}
