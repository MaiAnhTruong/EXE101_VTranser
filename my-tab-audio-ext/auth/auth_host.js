// auth/auth_host.js
(() => {
  "use strict";

  const cfg = window.VT_AUTH_CONFIG || {};

  // ========= DOM (Auth overlay) =========
  const overlay = document.getElementById("vtAuthOverlay");
  const backdrop = document.getElementById("vtAuthBackdrop");
  const frame = document.getElementById("vtAuthFrame");

  const btnAccount =
    document.getElementById("btnAccount") || document.querySelector("[data-vt-account]");

  // ========= DOM (Account overlay) =========
  const accOverlay = document.getElementById("vtAccountOverlay");
  const accBackdrop = document.getElementById("vtAccountBackdrop");
  const accPopover = accOverlay?.querySelector(".vt-account-popover") || null;

  const accNameEl = document.getElementById("vtAccName");
  const accEmailEl = document.getElementById("vtAccEmail");
  const accPlanEl = document.getElementById("vtAccPlan");
  const accAvatarImg = document.getElementById("vtAccAvatar");
  const accAvatarFb = document.getElementById("vtAccAvatarFallback");
  const accLogoutBtn = document.getElementById("vtAccLogout");
  const accToastEl = document.getElementById("vtAccToast");

  // ========= DOM (My Account / Edit Profile overlay) =========
  const profOverlay = document.getElementById("vtProfileOverlay");
  const profBackdrop = document.getElementById("vtProfileBackdrop");
  const profCloseBtn = document.getElementById("vtProfileClose");

  const profAvatarImg = document.getElementById("vtProfileAvatar");
  const profAvatarFb = document.getElementById("vtProfileAvatarFallback");
  const profFileInp = document.getElementById("vtProfileFile");
  const profRemoveBtn = document.getElementById("vtProfileRemoveAvatar");
  const profAvatarUrl = document.getElementById("vtProfileAvatarUrl");
  const profEmailInp = document.getElementById("vtProfileEmail");
  const profNameInp = document.getElementById("vtProfileFullName");
  const profCancelBtn = document.getElementById("vtProfileCancel");
  const profSaveBtn = document.getElementById("vtProfileSave");
  const profToastEl = document.getElementById("vtProfileToast");

  if (!overlay || !frame || !btnAccount) {
    console.warn("[auth_host] Missing overlay/frame/account button");
    return;
  }

  // ========= Storage keys =========
  const KEY_SESSION = "vtAuth";
  const KEY_EMAIL_USER_ID_MAP = "vtEmailUserIdMapV1";

  // ========= Guest lock =========
  const LOCK_CLASS = "vt-locked";
  let globalToastEl = null;

  // ========= Helpers =========
  const EXT_ORIGIN = location.origin; // chrome-extension://<id>
  let currentSession = null; // { provider, profile, tokens, updated_at }

  // ---- Global toast (for guest lock) ----
  function ensureGlobalToast() {
    if (globalToastEl) return globalToastEl;
    globalToastEl = document.getElementById("vtGlobalToast");
    if (!globalToastEl) {
      globalToastEl = document.createElement("div");
      globalToastEl.id = "vtGlobalToast";
      globalToastEl.className = "vt-global-toast";
      globalToastEl.setAttribute("aria-live", "polite");
      globalToastEl.setAttribute("role", "status");
      document.body.appendChild(globalToastEl);
    }
    return globalToastEl;
  }

  function toastGlobal(msg, ms = 1800) {
    const el = ensureGlobalToast();
    if (!el) return;
    el.textContent = String(msg || "");
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  function applyLockState(isAuthed) {
    // Lock everything when guest
    document.documentElement.classList.toggle(LOCK_CLASS, !isAuthed);
  }

  function isGuest() {
    return !currentSession?.profile;
  }

  function isAllowedGuestTarget(target) {
    if (!target) return false;

    // Allow anything inside auth overlay (login/signup)
    if (overlay && overlay.contains(target)) return true;

    // Allow account button (to open login)
    if (btnAccount && (target === btnAccount || btnAccount.contains(target))) return true;

    // Allow login buttons/links
    if (target.closest && target.closest(".login-btn")) return true;

    // Allow explicit guest exceptions if you ever need (optional)
    if (target.closest && target.closest("[data-vt-allow-guest]")) return true;

    return false;
  }

  function guestGuard(e) {
    if (!isGuest()) return;

    const t = e.target;

    // Allow login/account/auth overlay
    if (isAllowedGuestTarget(t)) return;

    // For keydown: only block activation keys to avoid breaking general typing if needed
    if (e.type === "keydown") {
      const k = e.key;
      const isActivationKey = k === "Enter" || k === " " || k === "Spacebar";
      if (!isActivationKey) return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

    toastGlobal("Bạn cần đăng nhập để dùng tính năng này.");
    openAuthOverlay("#login");
  }

  // Install guards (capture phase so it blocks other handlers like sidepanel.js)
  document.addEventListener("pointerdown", guestGuard, true);
  document.addEventListener("click", guestGuard, true);
  document.addEventListener("submit", guestGuard, true);
  document.addEventListener("keydown", guestGuard, true);

  // ---- Toast helpers (existing overlays) ----
  function toastAccount(msg, ms = 1800) {
    if (!accToastEl) return;
    accToastEl.textContent = msg || "";
    accToastEl.classList.remove("hidden");
    clearTimeout(accToastEl._t);
    accToastEl._t = setTimeout(() => accToastEl.classList.add("hidden"), ms);
  }
  function toastProfile(msg, ms = 2200) {
    if (!profToastEl) return;
    profToastEl.textContent = msg || "";
    profToastEl.classList.remove("hidden");
    clearTimeout(profToastEl._t);
    profToastEl._t = setTimeout(() => profToastEl.classList.add("hidden"), ms);
  }

  // ---- Storage helpers ----
  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, resolve);
      } catch {
        resolve();
      }
    });
  }
  function storageRemove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, resolve);
      } catch {
        resolve();
      }
    });
  }

  // ---- Session normalize (compat) ----
  function normalizeSession(raw) {
    if (!raw) return null;
    if (raw.currentSession && raw.currentSession.profile) return raw.currentSession;
    if (raw.profile) return raw;
    return null;
  }

  // ---- UI open/close ----
  function openAuthOverlay(hashOrMode = "#login") {
    closeAccountOverlay();
    closeProfileOverlay();

    overlay.classList.remove("vt-hidden");
    overlay.setAttribute("aria-hidden", "false");

    const hash = String(hashOrMode || "#login").startsWith("#")
      ? String(hashOrMode)
      : "#" + String(hashOrMode);

    const url = chrome.runtime.getURL("auth/auth.html") + hash;
    if (frame.src !== url) frame.src = url;
  }

  function closeAuthOverlay() {
    overlay.classList.add("vt-hidden");
    overlay.setAttribute("aria-hidden", "true");
  }

  function openAccountOverlay() {
    if (!accOverlay) return;

    closeAuthOverlay();
    closeProfileOverlay();

    const profile = currentSession?.profile;
    if (!profile) return openAuthOverlay("#login");

    renderAccount(profile);

    accOverlay.classList.remove("vt-hidden");
    accOverlay.setAttribute("aria-hidden", "false");
  }

  function closeAccountOverlay() {
    if (!accOverlay) return;
    accOverlay.classList.add("vt-hidden");
    accOverlay.setAttribute("aria-hidden", "true");
    accToastEl?.classList.add("hidden");
  }

  function toggleAccountOrAuth() {
    if (currentSession?.profile) {
      if (!accOverlay) return;
      const isHidden = accOverlay.classList.contains("vt-hidden");
      if (isHidden) openAccountOverlay();
      else closeAccountOverlay();
    } else {
      openAuthOverlay("#login");
    }
  }

  function openProfileOverlay() {
    if (!profOverlay) return;
    closeAuthOverlay();
    closeAccountOverlay();

    profOverlay.classList.remove("vt-hidden");
    profOverlay.setAttribute("aria-hidden", "false");
  }

  function closeProfileOverlay() {
    if (!profOverlay) return;
    profOverlay.classList.add("vt-hidden");
    profOverlay.setAttribute("aria-hidden", "true");
    profToastEl?.classList.add("hidden");
    if (profFileInp) profFileInp.value = "";
  }

  // ---- Render helpers ----
  function firstLetter(name) {
    const n = String(name || "").trim();
    return (n ? n.slice(0, 1) : "U").toUpperCase();
  }

  function renderAccount(profile) {
    if (!profile) return;

    const name = profile?.name || profile?.full_name || profile?.email || "User";
    const email = profile?.email || "";
    const pic = profile?.picture || profile?.avatar_url || "";

    if (accNameEl) accNameEl.textContent = name;
    if (accEmailEl) accEmailEl.textContent = email;
    if (accPlanEl) accPlanEl.textContent = "Free";

    if (accAvatarImg && accAvatarFb) {
      if (pic) {
        accAvatarImg.src = pic;
        accAvatarImg.classList.remove("hidden");
        accAvatarFb.classList.add("hidden");
      } else {
        accAvatarImg.classList.add("hidden");
        accAvatarFb.classList.remove("hidden");
        accAvatarFb.textContent = firstLetter(name);
      }
    }
  }

  function renderProfilePreview(name, avatar) {
    const n = String(name || "User").trim();
    const pic = String(avatar || "").trim();

    if (profAvatarImg && profAvatarFb) {
      if (pic) {
        profAvatarImg.src = pic;
        profAvatarImg.classList.remove("hidden");
        profAvatarFb.classList.add("hidden");
      } else {
        profAvatarImg.classList.add("hidden");
        profAvatarFb.classList.remove("hidden");
        profAvatarFb.textContent = firstLetter(n);
      }
    }
  }

  function updateAuthedUI(profile) {
    const name = profile?.name || profile?.full_name || profile?.email || "User";
    document.querySelectorAll(".login-btn").forEach((b) => {
      b.textContent = `Hi, ${name}`;
    });
    btnAccount.classList.add("vt-authed");
    applyLockState(true);
  }

  function updateLoggedOutUI() {
    document.querySelectorAll(".login-btn").forEach((b) => {
      b.textContent = "Log in";
    });
    btnAccount.classList.remove("vt-authed");
    applyLockState(false);
  }

  async function setSession(sess) {
    currentSession = sess || null;
    supaRlsWarned = false;

    if (currentSession?.profile) {
      await tryBackfillSessionUserId();
      updateAuthedUI(currentSession.profile);
      renderAccount(currentSession.profile);

      // best-effort: DB full_name/avatar_url override session UI
      if (pickSupabaseAccessToken(currentSession)) {
        await syncProfileFromDB().catch(() => {});
      }
    } else {
      updateLoggedOutUI();
      closeAccountOverlay();
      closeProfileOverlay();
    }
  }

  // ========= Supabase (ID schema) =========
  // ✅ users.id / user_profiles.id use bigint (int8)
  const SUPA_URL = String(cfg.SUPABASE_URL || "")
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/i, "");
  const SUPA_KEY = String(cfg.SUPABASE_KEY || "").trim();
  let supaRlsWarned = false;

  function supaReady() {
    return !!(SUPA_URL && SUPA_KEY);
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

  function pickSupabaseAccessToken(sess = currentSession) {
    const cands = [
      sess?.tokens?.access_token,
      sess?.tokens?.accessToken,
      sess?.currentSession?.tokens?.access_token,
      sess?.currentSession?.tokens?.accessToken,
    ]
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    for (const tk of cands) {
      const payload = decodeJwtPayloadNoVerify(tk);
      const iss = String(payload?.iss || "").toLowerCase();
      const aud = payload?.aud;
      if (iss.includes("supabase.co/auth/v1") || aud === "authenticated") {
        return tk;
      }
    }
    return "";
  }

  function parseNumericId(v) {
    const s = String(v ?? "").trim();
    return /^\d+$/.test(s) ? s : "";
  }

  async function supaFetch(path, init = {}) {
    if (!supaReady()) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
    const url = `${SUPA_URL}${path}`;
    const supaToken = pickSupabaseAccessToken();
    const bearer = supaToken || SUPA_KEY;

    const res = await fetch(url, {
      ...init,
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const denied =
        res.status === 401 &&
        /42501|permission denied|row-level security/i.test(String(txt || ""));
      if (!denied) {
        console.warn("[supaFetch]", res.status, txt);
      }
      if (denied && !supaRlsWarned) {
        supaRlsWarned = true;
        toastProfile(
          "RLS đang chặn (authenticated). Phiên hiện tại chưa có Supabase JWT hợp lệ hoặc policy chưa đúng.",
          4200
        );
      }
    }
    return res;
  }

  async function supaSelectUserByEmail(email) {
    const e = encodeURIComponent(String(email || "").trim().toLowerCase());
    const res = await supaFetch(`/rest/v1/users?email=eq.${e}&select=id,email&limit=1`);
    if (!res.ok) return null;
    const arr = await res.json().catch(() => []);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  async function tryBackfillSessionUserId() {
    const prof = currentSession?.profile || null;
    if (!prof) return;
    if (parseNumericId(prof.user_id) || parseNumericId(prof.db_user_id)) return;
    const email = String(prof.email || "").trim().toLowerCase();

    const provider = String(
      currentSession?.provider || prof.provider || ""
    ).trim().toLowerCase();
    const allowProfileIdFallback = !provider || provider === "email" || provider === "local";
    const numericProfileId = allowProfileIdFallback ? parseNumericId(prof.id) : "";
    if (numericProfileId) {
      const mergedProfile = {
        ...(prof || {}),
        user_id: numericProfileId,
        db_user_id: numericProfileId,
      };
      const mergedSession = {
        ...(currentSession || {}),
        profile: mergedProfile,
        updated_at: Date.now(),
      };
      currentSession = mergedSession;
      const saveObj = { [KEY_SESSION]: mergedSession };
      if (email) {
        const stMap = await storageGet([KEY_EMAIL_USER_ID_MAP]).catch(() => ({}));
        const rawMap = (stMap?.[KEY_EMAIL_USER_ID_MAP] && typeof stMap[KEY_EMAIL_USER_ID_MAP] === "object")
          ? { ...stMap[KEY_EMAIL_USER_ID_MAP] }
          : {};
        rawMap[email] = { user_id: numericProfileId, updated_at: Date.now() };
        saveObj[KEY_EMAIL_USER_ID_MAP] = rawMap;
      }
      await storageSet(saveObj);
      return;
    }
    if (!email) return;

    try {
      const stMap = await storageGet([KEY_EMAIL_USER_ID_MAP]);
      const rawMap = stMap?.[KEY_EMAIL_USER_ID_MAP];
      const mapped = parseNumericId(rawMap?.[email]?.user_id);
      if (mapped) {
        const mergedProfile = {
          ...(prof || {}),
          user_id: mapped,
          db_user_id: mapped,
        };
        const mergedSession = {
          ...(currentSession || {}),
          profile: mergedProfile,
          updated_at: Date.now(),
        };
        currentSession = mergedSession;
        const nextMap = (rawMap && typeof rawMap === "object") ? { ...rawMap } : {};
        nextMap[email] = { user_id: mapped, updated_at: Date.now() };
        await storageSet({ [KEY_SESSION]: mergedSession, [KEY_EMAIL_USER_ID_MAP]: nextMap });
        return;
      }
    } catch {}

    try {
      const u = await supaSelectUserByEmail(email);
      const uid = parseNumericId(u?.id);
      if (!uid) return;

      const mergedProfile = {
        ...(prof || {}),
        user_id: uid,
        db_user_id: uid,
      };
      const mergedSession = {
        ...(currentSession || {}),
        profile: mergedProfile,
        updated_at: Date.now(),
      };
      currentSession = mergedSession;
      const stMap = await storageGet([KEY_EMAIL_USER_ID_MAP]).catch(() => ({}));
      const rawMap = (stMap?.[KEY_EMAIL_USER_ID_MAP] && typeof stMap[KEY_EMAIL_USER_ID_MAP] === "object")
        ? { ...stMap[KEY_EMAIL_USER_ID_MAP] }
        : {};
      rawMap[email] = { user_id: uid, updated_at: Date.now() };
      await storageSet({ [KEY_SESSION]: mergedSession, [KEY_EMAIL_USER_ID_MAP]: rawMap });
    } catch {
      // best-effort backfill only
    }
  }

  async function supaInsertUser(email, provider) {
    const nowIso = new Date().toISOString();

    const body = {
      email: String(email || "").trim().toLowerCase(),
      phone: null,
      password_hash: "oauth",
      auth_provider: provider || "oauth",
      status: "active",
      created_at: nowIso,
      last_login_at: nowIso,
    };

    let res = await supaFetch("/rest/v1/users", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    });

    if (res.status === 409) return await supaSelectUserByEmail(email);
    if (!res.ok) return null;

    const arr = await res.json().catch(() => []);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  async function ensureUserIdForCurrentSession() {
    const email = String(currentSession?.profile?.email || "").trim().toLowerCase();
    const provider = currentSession?.provider || currentSession?.profile?.provider || "oauth";

    if (!email) {
      return { ok: false, error: "Tài khoản này không có email. Không thể đồng bộ profile lên database." };
    }

    let u = await supaSelectUserByEmail(email);
    if (!u) u = await supaInsertUser(email, provider);

    const id = u?.id;
    if (!id) return { ok: false, error: "Không tạo/không lấy được users.id từ Supabase." };

    return { ok: true, id, email };
  }

  async function supaSelectUserProfileById(id) {
    const idEnc = encodeURIComponent(String(id));
    const res = await supaFetch(
      `/rest/v1/user_profiles?id=eq.${idEnc}&select=id,full_name,avatar_url,locale,role&limit=1`
    );
    if (!res.ok) return null;
    const arr = await res.json().catch(() => []);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  async function supaUpsertUserProfile(row) {
    const res = await supaFetch(`/rest/v1/user_profiles?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(t || "Upsert user_profiles failed");
    }

    const arr = await res.json().catch(() => []);
    return Array.isArray(arr) && arr.length ? arr[0] : row;
  }

  // ========= My Account flow =========
  function profileFormValid() {
    const name = String(profNameInp?.value || "").trim();
    return name.length >= 2;
  }

  function refreshProfileSaveBtn() {
    if (!profSaveBtn) return;
    profSaveBtn.disabled = !profileFormValid() || !!profSaveBtn.dataset.saving;
  }

  function setSaving(on) {
    if (!profSaveBtn) return;
    if (on) {
      profSaveBtn.dataset.saving = "1";
      profSaveBtn.classList.add("is-loading");
      profSaveBtn.disabled = true;
    } else {
      delete profSaveBtn.dataset.saving;
      profSaveBtn.classList.remove("is-loading");
      refreshProfileSaveBtn();
    }
  }

  function avatarUrlValid(url) {
    const s = String(url || "").trim();
    if (!s) return true;
    if (/^https?:\/\//i.test(s)) return true;
    if (/^data:image\//i.test(s)) return true;
    return false;
  }

  async function openMyAccountScreen() {
    try {
      if (!currentSession?.profile) return openAuthOverlay("#login");
      if (!supaReady()) {
        toastAccount("Thiếu SUPABASE_URL / SUPABASE_KEY (auth/config.js)");
        return;
      }
      if (!pickSupabaseAccessToken(currentSession)) {
        toastAccount("RLS đang để authenticated. Phiên hiện tại chưa có Supabase JWT.");
        return;
      }

      openProfileOverlay();

      const ss = await ensureUserIdForCurrentSession();
      if (!ss.ok) {
        toastProfile(ss.error || "Không thể mở màn tài khoản.");
        return;
      }

      const email = ss.email;
      const id = ss.id;

      if (profEmailInp) profEmailInp.value = email;

      const dbp = await supaSelectUserProfileById(id);

      const curName = String(
        dbp?.full_name ||
          currentSession.profile?.name ||
          currentSession.profile?.email ||
          "User"
      ).trim();

      const curAvatar = String(
        dbp?.avatar_url || currentSession.profile?.picture || ""
      ).trim();

      if (profNameInp) profNameInp.value = curName;
      if (profAvatarUrl) profAvatarUrl.value = curAvatar;

      renderProfilePreview(curName, curAvatar);
      setSaving(false);

      if (profOverlay) profOverlay.dataset.userId = String(id);

      refreshProfileSaveBtn();
    } catch (e) {
      toastProfile("Không thể tải thông tin tài khoản: " + String(e?.message || e));
    }
  }

  async function saveMyAccount() {
    try {
      if (!currentSession?.profile) return;

      const id = profOverlay?.dataset?.userId;
      if (!id) {
        toastProfile("Thiếu id. Hãy đóng và mở lại My account.");
        return;
      }

      const full_name = String(profNameInp?.value || "").trim();
      if (full_name.length < 2) {
        toastProfile("Tên hiển thị phải có ít nhất 2 ký tự.");
        return;
      }

      const avatar_url = String(profAvatarUrl?.value || "").trim();
      if (!avatarUrlValid(avatar_url)) {
        toastProfile("Avatar URL không hợp lệ. Hãy dùng https://... hoặc data:image/...");
        return;
      }

      setSaving(true);

      const locale = (navigator.language || "vi").toLowerCase();

      const row = await supaUpsertUserProfile({
        id,
        full_name,
        avatar_url: avatar_url || null,
        locale,
        role: null,
      });

      // update session UI + persist
      const newProfile = {
        ...(currentSession.profile || {}),
        name: row.full_name || full_name,
        picture: row.avatar_url || avatar_url || "",
      };

      const newSession = {
        ...(currentSession || {}),
        profile: newProfile,
        updated_at: Date.now(),
      };

      await storageSet({ [KEY_SESSION]: newSession });
      await setSession(newSession);

      toastProfile("Đã cập nhật tài khoản ✅");
      setTimeout(() => {
        closeProfileOverlay();
        openAccountOverlay();
      }, 450);
    } catch (e) {
      toastProfile("Lưu thất bại: " + String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function syncProfileFromDB() {
    try {
      if (!currentSession?.profile) return;
      if (!supaReady()) return;

      const ss = await ensureUserIdForCurrentSession();
      if (!ss.ok) return;

      const dbp = await supaSelectUserProfileById(ss.id);
      if (!dbp) return;

      const full_name = String(dbp.full_name || "").trim();
      const avatar_url = String(dbp.avatar_url || "").trim();

      if (!full_name && !avatar_url) return;

      const merged = {
        ...(currentSession.profile || {}),
        name: full_name || currentSession.profile?.name,
        picture: avatar_url || currentSession.profile?.picture,
      };

      const sess2 = { ...currentSession, profile: merged, updated_at: Date.now() };
      await storageSet({ [KEY_SESSION]: sess2 });
      currentSession = sess2;

      updateAuthedUI(sess2.profile);
      renderAccount(sess2.profile);
    } catch {
      // ignore
    }
  }

  // ========= Wire UI events =========
  btnAccount.addEventListener("click", (e) => {
    e.preventDefault?.();
    toggleAccountOrAuth();
  });

  backdrop?.addEventListener("click", closeAuthOverlay);
  accBackdrop?.addEventListener("click", closeAccountOverlay);
  profBackdrop?.addEventListener("click", closeProfileOverlay);

  accPopover?.addEventListener("click", (e) => e.stopPropagation());
  profOverlay?.querySelector(".vt-profile-sheet")?.addEventListener("click", (e) => e.stopPropagation());
  overlay?.querySelector(".vt-auth-sheet")?.addEventListener("click", (e) => e.stopPropagation());

  profCloseBtn?.addEventListener("click", closeProfileOverlay);
  profCancelBtn?.addEventListener("click", () => {
    closeProfileOverlay();
    openAccountOverlay();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAuthOverlay();
      closeAccountOverlay();
      closeProfileOverlay();
    }
  });

  accLogoutBtn?.addEventListener("click", async () => {
    await storageRemove([KEY_SESSION]);
    await setSession(null);
    closeAccountOverlay();
    openAuthOverlay("#login");
  });

  document.querySelectorAll("[data-vt-acc-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-vt-acc-action") || "";
      if (!act) return;

      if (act === "my_account") {
        await openMyAccountScreen();
        return;
      }

      if (act === "help") return toastAccount("Help center: Coming soon…");
      if (act === "feedback") return toastAccount("Feedback: Coming soon…");
      if (act === "my_website") return toastAccount("My website: Coming soon…");
      if (act === "whats_new") return toastAccount("What's new: Coming soon…");
      if (act === "rewards") return toastAccount("Rewards center: Coming soon…");

      toastAccount("Coming soon…");
    });
  });

  // ========= Avatar upload (file -> dataURL) =========
  profFileInp?.addEventListener("change", async () => {
    try {
      const f = profFileInp.files?.[0];
      if (!f) return;

      if (f.size > 1024 * 1024) {
        toastProfile("Ảnh quá lớn (>1MB). Vui lòng chọn ảnh nhỏ hơn.");
        profFileInp.value = "";
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        if (profAvatarUrl) profAvatarUrl.value = dataUrl;

        const name = String(profNameInp?.value || currentSession?.profile?.name || "User");
        renderProfilePreview(name, dataUrl);
        refreshProfileSaveBtn();
      };
      reader.readAsDataURL(f);
    } catch (e) {
      toastProfile("Không đọc được file ảnh: " + String(e));
    }
  });

  profRemoveBtn?.addEventListener("click", () => {
    if (profAvatarUrl) profAvatarUrl.value = "";
    if (profFileInp) profFileInp.value = "";
    const name = String(profNameInp?.value || currentSession?.profile?.name || "User");
    renderProfilePreview(name, "");
    refreshProfileSaveBtn();
  });

  profAvatarUrl?.addEventListener("input", () => {
    const avatar = String(profAvatarUrl.value || "").trim();
    const name = String(profNameInp?.value || currentSession?.profile?.name || "User");
    renderProfilePreview(name, avatar);
    refreshProfileSaveBtn();
  });

  profNameInp?.addEventListener("input", () => {
    const avatar = String(profAvatarUrl?.value || "").trim();
    const name = String(profNameInp.value || currentSession?.profile?.name || "User");
    renderProfilePreview(name, avatar);
    refreshProfileSaveBtn();
  });

  profSaveBtn?.addEventListener("click", saveMyAccount);

  // ========= listen messages from auth iframe =========
  window.addEventListener("message", async (ev) => {
    const msg = ev?.data;
    if (!msg || typeof msg !== "object") return;

    // secure: only accept from our extension origin AND auth iframe window
    if (ev.origin && ev.origin !== EXT_ORIGIN) return;
    if (frame?.contentWindow && ev.source !== frame.contentWindow) return;

    if (msg.type === "VT_AUTH_CLOSE") {
      closeAuthOverlay();
      return;
    }

    if (msg.type === "VT_AUTH_SUCCESS") {
      try {
        // Always prioritize fresh login payload to avoid keeping stale vtAuth.
        const u = msg.payload?.user || msg.payload?.profile || null;
        const provider = String(
          msg.payload?.provider || u?.provider || u?.auth_provider || ""
        ).trim().toLowerCase();
        const tokens = msg.payload?.tokens || {};

        if (u) {
          const sess = {
            provider,
            profile: u,
            tokens,
            updated_at: Date.now(),
          };
          await storageSet({ [KEY_SESSION]: sess });
          await setSession(sess);
        } else {
          const res = await storageGet([KEY_SESSION]);
          const stored = normalizeSession(res?.[KEY_SESSION]);
          await setSession(stored || null);
        }
      } catch {}
      closeAuthOverlay();
      return;
    }
  });

  // ========= Restore session UI on load =========
  // Lock ngay từ đầu để tránh “click kịp lúc” trước khi load session
  applyLockState(false);

  chrome.storage.local.get([KEY_SESSION], async (res) => {
    const sess = normalizeSession(res?.[KEY_SESSION]);
    if (sess?.profile) await setSession(sess);
    else await setSession(null);
  });

  // ========= Expose helpers =========
  window.__vtOpenAuthOverlay = (mode = "login") => openAuthOverlay(mode);
  window.__vtOpenAccountOverlay = () => openAccountOverlay();
  window.__vtOpenAccountOrAuth = (mode = "login") => {
    if (currentSession?.profile) openAccountOverlay();
    else openAuthOverlay(mode);
  };
})();
