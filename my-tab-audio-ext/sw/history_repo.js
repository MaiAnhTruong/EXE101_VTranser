// Read transcript history from Supabase for sidepanel History view.

const SUPABASE_URL = "https://izziphjuznnzhcdbbptw.supabase.co";
const SUPABASE_KEY = "sb_publishable_YNUg4THwvvBurGGn59s8Kg_OSkVpVfh";

function authHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
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

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
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

function normalizeUserIdOrThrow(userId) {
  const uid = toInt(userId, 0);
  if (!uid) throw new Error("USER_ID_INVALID");
  return uid;
}

async function selectUsersIdByEmail(email) {
  const em = normalizeEmail(email);
  if (!em) return 0;

  const p = new URLSearchParams({
    select: "id",
    email: `eq.${em}`,
    limit: "1",
  });
  const url = `${SUPABASE_URL}/rest/v1/users?${p.toString()}`;
  const rows = await fetchJson(url, { headers: authHeaders() });
  if (Array.isArray(rows) && rows[0] && isNumericId(rows[0].id)) {
    return toInt(rows[0].id, 0);
  }
  return 0;
}

export async function resolveUsersTableUserId(profile = {}) {
  // Canonical source: public.users (lookup by account email).
  const byEmail = await selectUsersIdByEmail(profile?.email);
  if (byEmail) return byEmail;

  // Fallback only when email is unavailable.
  const profileId = profile?.id;
  if (isNumericId(profileId)) return toInt(profileId, 0);

  throw new Error("USER_ID_INVALID");
}

function normalizeSessionRow(row) {
  const id = toInt(row?.id, 0);
  if (!id) return null;
  return {
    id,
    user_id: Number.isFinite(Number(row?.user_id)) ? toInt(row.user_id, 0) : null,
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
  { limit = 200, offset = 0 } = {}
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
  const rows = await fetchJson(url, { headers: authHeaders() });
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
  sessionId
) {
  const uid = normalizeUserIdOrThrow(userId);

  const sid = toInt(sessionId, 0);
  if (!sid) throw new Error("INVALID_SESSION_ID");

  const pSession = new URLSearchParams({
    select: "*",
    id: `eq.${sid}`,
    user_id: `eq.${uid}`,
    limit: "1",
  });
  const sessionUrl = `${SUPABASE_URL}/rest/v1/transcript_sessions?${pSession.toString()}`;
  const sessionRows = await fetchJson(sessionUrl, { headers: authHeaders() });
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
    const chunk0Rows = await fetchJson(chunk0Url, { headers: authHeaders() });
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
      const chunkLatestRows = await fetchJson(chunkLatestUrl, { headers: authHeaders() });
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
