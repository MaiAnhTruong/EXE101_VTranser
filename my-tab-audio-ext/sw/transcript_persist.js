// Transcript persistence to Supabase with “delay 1 sentence” appends.
import { splitSentences } from "./sentence_splitter.js";

const SUPABASE_URL = "https://izziphjuznnzhcdbbptw.supabase.co";
const SUPABASE_KEY = "sb_publishable_YNUg4THwvvBurGGn59s8Kg_OSkVpVfh";

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxxyxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function headers(authToken = "", extra = {}) {
  const bearer = String(authToken || "").trim() || SUPABASE_KEY;
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    Prefer: "return=representation",
    ...extra,
  };
}

function domainFromUrl(u = "") {
  try {
    const p = new URL(u);
    return p.hostname || "";
  } catch {
    return "";
  }
}

function normalizeDbId(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return /^\d+$/.test(s) ? s : "";
}

export function createTranscriptPersist(opts) {
  const {
    userId = "",
    userEmail = "",
    authToken = "",
    tabUrl = "",
    sttServer = "",
    translatorServer = "",
    langSrc = "en",
    langTgt = "",
  } = opts || {};

  const numOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const toSessionId = (id) => normalizeDbId(id);

  const state = {
    sessionId: uuid(),
    trSessionId: null,
    fullLatest: "",
    fullSeq: null,
    lastSnapshotHash: "",
    startedAt: Date.now(),
    stopped: false,
  };

  async function fetchUserId() {
    // 1) caller provided id
    const direct = normalizeDbId(userId);
    if (direct) return direct;

    // 2) lookup by email (if available)
    if (userEmail) {
      try {
        const url = `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(
          userEmail
        )}&select=id&limit=1`;
        const r = await fetch(url, { headers: headers(authToken) });
        if (r.ok) {
          const j = await r.json();
          const rid = normalizeDbId(j?.[0]?.id);
          if (Array.isArray(j) && rid) return rid;
        } else {
          const txt = await r.text().catch(() => "");
          console.warn("[persist] fetchUserId select failed", r.status, txt);
        }
      } catch (e) {
        console.warn("[persist] fetchUserId failed", e?.message || e);
      }
    }

    // 3) create minimal user row to satisfy FK (using email if có)
    if (userEmail) {
      const body = {
        email: userEmail,
        phone: null,
        auth_provider: "ext",
        status: "active",
        created_at: new Date().toISOString(),
        last_login_at: new Date().toISOString(),
      };
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
          method: "POST",
          headers: headers(authToken),
          body: JSON.stringify(body),
        });
        if (r.ok) {
          const j = await r.json().catch(() => []);
          const rid = normalizeDbId(j?.[0]?.id);
          if (Array.isArray(j) && rid) return rid;
        }
        const txt = await r.text().catch(() => "");
        console.warn("[persist] insert user failed", r.status, txt);
      } catch (e) {
        console.warn("[persist] insert user error", e?.message || e);
      }
    }

    // 4) fallback: give up (avoid FK violation)
    return null;
  }

  async function startSession() {
    const resolvedUserId = await fetchUserId();
    if (!resolvedUserId) {
      console.warn("[persist] skip: cannot resolve users.id");
      state.stopped = true;
      return;
    }

    const body = {
      user_id: resolvedUserId,
      tab_url: tabUrl || null,
      tab_domain: domainFromUrl(tabUrl) || null,
      stt_server: sttServer || null,
      translator_server: translatorServer || null,
      lang_src: langSrc || null,
      lang_tgt: langTgt || null,
      started_at: new Date(state.startedAt).toISOString(),
      status: "running",
    };
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/transcript_sessions`, {
        method: "POST",
        headers: headers(authToken),
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${txt || ""}`.trim());
      }
      const j = await r.json().catch(() => []);
      const sid = Array.isArray(j) && j[0]?.id ? j[0].id : null;
      const sidNorm = toSessionId(sid);
      if (!sidNorm) {
        console.warn("[persist] startSession got invalid id -> stop", sid);
        state.stopped = true;
        return;
      }
      state.trSessionId = sidNorm;
      console.log("[persist] startSession OK trSessionId=", state.trSessionId);
    } catch (e) {
      console.warn("[persist] startSession failed", e?.message || e);
      state.stopped = true;
    }
  }

  async function updateLatest(fullText, seq) {
    if (!state.trSessionId) return;
    const seqNum = numOrNull(seq);
    const body = {
      latest_text_en: fullText,
      last_seq: seqNum,
      last_updated_at: new Date().toISOString(),
    };
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/transcript_sessions?id=eq.${encodeURIComponent(String(state.trSessionId))}`,
        {
          method: "PATCH",
          headers: headers(authToken),
          body: JSON.stringify(body),
        }
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn("[persist] updateLatest failed", r.status, txt);
      }
    } catch (e) {
      console.warn("[persist] updateLatest error", e?.message || e);
    }
  }

  async function insertFullSnapshot(fullText) {
    if (!state.trSessionId || !fullText) return;
    const body = {
      tr_session_id: state.trSessionId,
      seq: 0,
      text_en: fullText,
      is_stable: true,
    };
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/transcript_chunks?on_conflict=tr_session_id,seq`,
        {
          method: "POST",
          headers: headers(authToken, { Prefer: "resolution=merge-duplicates,return=minimal" }),
          body: JSON.stringify(body),
        }
      );
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn("[persist] insert chunk failed", r.status, txt);
      }
    } catch (e) {
      console.warn("[persist] insertFullSnapshot error", e?.message || e);
    }
  }

  function handleStable(fullText = "", seq = null) {
    if (state.stopped || !state.trSessionId) return;
    const text = (fullText || "").toString();
    const seqNum = seq ?? state.fullSeq;
    const hash = `${seqNum || ""}|${text}`;
    if (hash === state.lastSnapshotHash) return;
    state.fullLatest = text;
    state.fullSeq = seqNum;
    state.lastSnapshotHash = hash;

    // snapshot full transcript on every stable
    insertFullSnapshot(text);
    updateLatest(text, seqNum);
  }

  async function stop(finalText = "") {
    state.stopped = true;
    const finalTextStr = (finalText || state.fullLatest || "").toString();
    await insertFullSnapshot(finalTextStr);
    await updateLatest(finalTextStr, state.fullSeq);

    const body = {
      status: "stopped",
      ended_at: new Date().toISOString(),
    };
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/transcript_sessions?id=eq.${encodeURIComponent(String(state.trSessionId))}`,
        {
          method: "PATCH",
          headers: headers(authToken),
          body: JSON.stringify(body),
        }
      );
    } catch (e) {
      console.warn("[persist] stop session failed", e);
    }
  }

  return {
    start: startSession,
    handleStable,
    stop,
    getSessionId: () => state.trSessionId,
  };
}
