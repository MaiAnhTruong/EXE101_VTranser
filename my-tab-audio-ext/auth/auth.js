// auth/auth.js
(() => {
  const cfg = window.VT_AUTH_CONFIG || {};
  const toastEl = document.getElementById("toast");
  const $ = (id) => document.getElementById(id);

  // ===== Storage keys =====
  const KEY_SESSION = "vtAuth";
  const KEY_EMAIL_USER_ID_MAP = "vtEmailUserIdMapV1";

  // ===== Crypto params =====
  const PBKDF2_ITERS = 120000;
  const SALT_BYTES = 16;
  const HASH_PREFIX = "pbkdf2_sha256"; // prefix$iter$salt$hash

  // ===== Supabase config =====
  const SUPA_URL = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  const SUPA_KEY = String(cfg.SUPABASE_KEY || "").trim();

  // ------------------------------------------------------------------
  // UI helpers
  function toast(msg, ms = 2600) {
    if (!toastEl) return alert(msg);
    toastEl.textContent = String(msg || "");
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
  }

  function mustChromeStorage() {
    if (!window.chrome || !chrome.storage || !chrome.storage.local) {
      toast('chrome.storage.local khong san sang. Kiem tra permission "storage" roi reload extension.');
      return false;
    }
    return true;
  }

  async function storageSet(obj) {
    if (!mustChromeStorage()) throw new Error("chrome.storage.local unavailable");
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  async function storageGet(keys) {
    if (!mustChromeStorage()) throw new Error("chrome.storage.local unavailable");
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  // ------------------------------------------------------------------
  // Supabase helpers
  function supaReady() {
    if (!SUPA_URL || !SUPA_KEY) {
      toast("Thieu SUPABASE_URL hoac SUPABASE_KEY trong auth/config.js");
      return false;
    }
    return true;
  }

  async function supaFetch(path, init = {}) {
    if (!supaReady()) throw new Error("Supabase config missing");
    const url = `${SUPA_URL}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Supabase error", res.status, txt);
    }
    return res;
  }

  async function supaSelectUserByEmail(email) {
    const em = normalizedEmail(email);
    const res = await supaFetch(
      `/rest/v1/users?email=eq.${encodeURIComponent(em)}&select=id,email,phone,password_hash,auth_provider,status,created_at,last_login_at`
    );
    if (!res.ok) throw new Error(`Supabase select by email failed (${res.status})`);
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  async function supaSelectUserByPhone(phone) {
    const ph = normalizedPhone(phone);
    if (!ph) return null;
    const res = await supaFetch(
      `/rest/v1/users?phone=eq.${encodeURIComponent(ph)}&select=id,email,phone&limit=1`
    );
    if (!res.ok) throw new Error(`Supabase select by phone failed (${res.status})`);
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  async function supaInsertUser(email, phone, passwordHash) {
    const body = {
      email: normalizedEmail(email),
      phone: normalizedPhone(phone),
      password_hash: passwordHash,
      auth_provider: "local",
      status: "active",
      created_at: new Date().toISOString(),
      last_login_at: null,
    };
    const res = await supaFetch("/rest/v1/users", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) throw new Error("duplicate");
    if (!res.ok) throw new Error((await res.text()) || `insert failed (${res.status})`);
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : body;
  }

  async function supaUpdateLastLogin(id) {
    if (id === undefined || id === null || id === "") return;
    const res = await supaFetch(`/rest/v1/users?id=eq.${encodeURIComponent(String(id))}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ last_login_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Update last_login_at failed", res.status, txt);
    }
  }

  async function supaInsertAuthLogin(userId, provider, success, reason = null) {
    try {
      await supaFetch("/rest/v1/auth_logins", {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          provider,
          success,
          failure_reason: reason,
          created_at: new Date().toISOString(),
          ip: null,
          user_agent: navigator.userAgent || "",
        }),
      });
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  // Crypto helpers
  function base64url(bytes) {
    const bin = String.fromCharCode(...bytes);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64urlToBytes(s) {
    const b64 = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function pbkdf2(password, saltBytes, iterations = PBKDF2_ITERS) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
      keyMaterial,
      256
    );
    return new Uint8Array(bits);
  }

  async function makePasswordHash(password) {
    const salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
    const hashBytes = await pbkdf2(password, salt, PBKDF2_ITERS);
    return `${HASH_PREFIX}$${PBKDF2_ITERS}$${base64url(salt)}$${base64url(hashBytes)}`;
  }

  async function verifyPassword(password, stored) {
    if (!stored || typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return false;
    const iter = Number(parts[1]) || PBKDF2_ITERS;
    const salt = base64urlToBytes(parts[2]);
    const expect = parts[3];
    const calc = await pbkdf2(password, salt, iter);
    return base64url(calc) === expect;
  }

  // ------------------------------------------------------------------
  // Validation
  function normalizedEmail(v) {
    return String(v || "").trim().toLowerCase();
  }

  function emailLooksOk(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(normalizedEmail(email));
  }

  function normalizedPhone(v) {
    const s = String(v || "").trim().replace(/[\s\-().]/g, "");
    if (!s) return "";
    if (s.startsWith("+")) return `+${s.slice(1).replace(/\D/g, "")}`;
    return s.replace(/\D/g, "");
  }

  function phoneLooksOk(phone) {
    return /^\+?[0-9]{8,15}$/.test(normalizedPhone(phone));
  }

  function normalizeDbUserId(v) {
    const s = String(v ?? "").trim();
    return /^\d+$/.test(s) ? s : null;
  }

  // Password policy: 8+ chars + lower + upper + number + special
  function passwordPolicy(pw) {
    const s = String(pw || "");
    const len = s.length >= 8;
    const lower = /[a-z]/.test(s);
    const upper = /[A-Z]/.test(s);
    const num = /[0-9]/.test(s);
    const special = /[^A-Za-z0-9]/.test(s);
    return { ok: len && lower && upper && num && special, len, lower, upper, num, special };
  }

  // ------------------------------------------------------------------
  // Session helpers
  async function rememberEmailUserId(email, userId) {
    const em = normalizedEmail(email);
    const uid = normalizeDbUserId(userId);
    if (!em || !uid) return;
    try {
      const st = await storageGet([KEY_EMAIL_USER_ID_MAP]);
      const raw = st?.[KEY_EMAIL_USER_ID_MAP];
      const map = raw && typeof raw === "object" ? { ...raw } : {};
      map[em] = { user_id: uid, updated_at: Date.now() };
      await storageSet({ [KEY_EMAIL_USER_ID_MAP]: map });
    } catch {}
  }

  function profileFromUserRow(u) {
    const email = normalizedEmail(u?.email || "");
    const uid = normalizeDbUserId(u?.id);
    const name = email.includes("@") ? email.split("@")[0] : email || "user";
    return {
      id: uid || email,
      email,
      phone: normalizedPhone(u?.phone || ""),
      name,
      provider: "email",
      picture: "",
      user_id: uid,
      db_user_id: uid,
    };
  }

  async function setSession(provider, profile, tokens) {
    const session = { provider, profile, tokens: tokens || {}, updated_at: Date.now() };
    await storageSet({ [KEY_SESSION]: session });
    return session;
  }

  function notifySuccess(payload) {
    window.parent?.postMessage({ type: "VT_AUTH_SUCCESS", payload }, "*");
  }

  // ------------------------------------------------------------------
  // UI setup
  const screenLogin = $("screenLogin");
  const screenSignup = $("screenSignup");
  const toSignup = $("toSignup");
  const toLogin = $("toLogin");

  function showSignup() {
    screenLogin?.classList.add("hidden");
    screenSignup?.classList.remove("hidden");
  }

  function showLogin() {
    screenSignup?.classList.add("hidden");
    screenLogin?.classList.remove("hidden");
  }

  function syncByHash() {
    const h = String(location.hash || "#login").toLowerCase();
    if (h === "#signup") showSignup();
    else showLogin();
  }

  toSignup?.addEventListener("click", (e) => {
    e.preventDefault();
    location.hash = "#signup";
  });
  toLogin?.addEventListener("click", (e) => {
    e.preventDefault();
    location.hash = "#login";
  });
  window.addEventListener("hashchange", syncByHash);
  syncByHash();

  $("btnClose")?.addEventListener("click", () => {
    window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
  });

  function bindPwToggle(btnId, inputId) {
    const btn = $(btnId);
    const inp = $(inputId);
    if (!btn || !inp) return;
    const syncText = () => {
      btn.textContent = inp.type === "password" ? "Hien" : "An";
    };
    syncText();
    btn.addEventListener("click", () => {
      inp.type = inp.type === "password" ? "text" : "password";
      syncText();
    });
  }

  bindPwToggle("togglePw", "loginPass");
  bindPwToggle("togglePwS", "signupPass");
  bindPwToggle("togglePwS2", "signupPass2");

  // Form refs
  const loginEmail = $("loginEmail");
  const loginPass = $("loginPass");
  const btnEmailLogin = $("btnEmailLogin");

  const signupEmail = $("signupEmail");
  const signupPhone = $("signupPhone");
  const signupPass = $("signupPass");
  const signupPass2 = $("signupPass2");
  const btnEmailSignup = $("btnEmailSignup");

  // Password rule refs
  const ruleLen = $("ruleLen");
  const ruleLower = $("ruleLower");
  const ruleUpper = $("ruleUpper");
  const ruleNum = $("ruleNum");
  const ruleSpecial = $("ruleSpecial");
  const confirmErr = $("confirmErr");

  function setRule(el, ok) {
    if (!el) return;
    el.classList.toggle("ok", !!ok);
  }

  function setInvalid(inp, invalid) {
    if (!inp) return;
    inp.classList.toggle("invalid", !!invalid);
  }

  function renderSignupRules() {
    const pw = String(signupPass?.value || "");
    const p = passwordPolicy(pw);
    setRule(ruleLen, p.len);
    setRule(ruleLower, p.lower);
    setRule(ruleUpper, p.upper);
    setRule(ruleNum, p.num);
    setRule(ruleSpecial, p.special);

    const c = String(signupPass2?.value || "");
    const mismatch = c.length > 0 && pw !== c;
    if (confirmErr) confirmErr.classList.toggle("hidden", !mismatch);
    setInvalid(signupPass2, mismatch);
    return { policyOk: p.ok, mismatch };
  }

  function refreshButtons() {
    if (btnEmailLogin) {
      const ok = emailLooksOk(loginEmail?.value) && String(loginPass?.value || "").length > 0;
      btnEmailLogin.disabled = !ok;
    }

    if (btnEmailSignup) {
      const emailOk = emailLooksOk(signupEmail?.value);
      const phoneOk = phoneLooksOk(signupPhone?.value);
      const { policyOk, mismatch } = renderSignupRules();
      const confirmOk = String(signupPass2?.value || "").length > 0 && !mismatch;

      setInvalid(signupPhone, String(signupPhone?.value || "").length > 0 && !phoneOk);
      setInvalid(signupPass, String(signupPass?.value || "").length > 0 && !policyOk);

      btnEmailSignup.disabled = !(emailOk && phoneOk && policyOk && confirmOk);
    }
  }

  [loginEmail, loginPass, signupEmail, signupPhone, signupPass, signupPass2]
    .filter(Boolean)
    .forEach((el) => el.addEventListener("input", refreshButtons));
  refreshButtons();

  // ------------------------------------------------------------------
  // Signup / Login
  async function doEmailSignup() {
    try {
      if (!supaReady()) return;

      const email = normalizedEmail(signupEmail?.value);
      const phone = normalizedPhone(signupPhone?.value);
      const pw = String(signupPass?.value || "");
      const pw2 = String(signupPass2?.value || "");

      if (!emailLooksOk(email)) return toast("Email khong hop le.");
      if (!phoneLooksOk(phone)) return toast("So dien thoai khong hop le.");
      const pol = passwordPolicy(pw);
      if (!pol.ok) return toast("Mat khau chua dat yeu cau.");
      if (pw !== pw2) return toast("Mat khau nhap lai chua khop.");

      const existsByEmail = await supaSelectUserByEmail(email);
      if (existsByEmail) return toast("Tai khoan da ton tai. Vui long dang nhap.");

      const existsByPhone = await supaSelectUserByPhone(phone);
      if (existsByPhone) return toast("So dien thoai da duoc su dung.");

      const passwordHash = await makePasswordHash(pw);
      await supaInsertUser(email, phone, passwordHash);

      toast("Dang ky thanh cong. Vui long dang nhap.", 2600);
      setTimeout(() => {
        location.hash = "#login";
        showLogin();
        if (loginEmail) loginEmail.value = email;
        if (loginPass) loginPass.value = "";
        if (signupPass) signupPass.value = "";
        if (signupPass2) signupPass2.value = "";
        if (signupPhone) signupPhone.value = "";
        refreshButtons();
        loginPass?.focus?.();
      }, 600);
    } catch (e) {
      toast("Dang ky that bai: " + String(e?.message || e));
    }
  }

  async function doEmailLogin() {
    try {
      if (!supaReady()) return;

      const email = normalizedEmail(loginEmail?.value);
      const pw = String(loginPass?.value || "");
      if (!emailLooksOk(email)) return toast("Email khong hop le.");
      if (!pw) return toast("Vui long nhap mat khau.");

      const u = await supaSelectUserByEmail(email);
      if (!u) {
        toast("Sai email hoac tai khoan chua dang ky.");
        await supaInsertAuthLogin(null, "local", false, "user_not_found");
        return;
      }

      if (u.status && u.status !== "active") {
        toast("Tai khoan dang bi khoa hoac chua kich hoat.");
        await supaInsertAuthLogin(u.id, "local", false, "status_" + u.status);
        return;
      }

      const ok = await verifyPassword(pw, u.password_hash);
      if (!ok) {
        toast("Sai mat khau.");
        await supaInsertAuthLogin(u.id, "local", false, "bad_password");
        return;
      }

      await supaUpdateLastLogin(u.id);
      await supaInsertAuthLogin(u.id, "local", true, null);

      const profile = profileFromUserRow(u);
      await rememberEmailUserId(profile.email, profile.user_id || profile.db_user_id);
      const session = await setSession("email", profile, {});
      notifySuccess({ provider: "email", user: profile, tokens: {}, session });

      toast("Dang nhap thanh cong.");
      window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
    } catch (e) {
      toast("Dang nhap that bai: " + String(e?.message || e));
    }
  }

  btnEmailSignup?.addEventListener("click", doEmailSignup);
  btnEmailLogin?.addEventListener("click", doEmailLogin);

  $("forgotPw")?.addEventListener("click", (e) => {
    e.preventDefault();
    toast("Chuc nang quen mat khau can luong backend rieng.", 4200);
  });
})();
