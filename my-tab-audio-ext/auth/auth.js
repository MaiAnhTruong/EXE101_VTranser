// auth/auth.js
(() => {
  const cfg = window.VT_AUTH_CONFIG || {};
  const toastEl = document.getElementById("toast");
  const $ = (id) => document.getElementById(id);

  // ===== Storage keys =====
  const KEY_SESSION = "vtAuth";

  // ===== Crypto params =====
  const PBKDF2_ITERS = 120000;
  const SALT_BYTES = 16;
  const HASH_PREFIX = "pbkdf2_sha256"; // prefix$iter$salt$hash

  // ===== Supabase config =====
  const SUPA_URL = (cfg.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  const SUPA_KEY = (cfg.SUPABASE_KEY || "").trim();

  // ------------------------------------------------------------------
  // UI helpers
  function toast(msg, ms = 2600) {
    if (!toastEl) return alert(msg);
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
  }

  function mustChromeIdentity() {
    if (!window.chrome || !chrome.identity || !chrome.identity.launchWebAuthFlow) {
      toast('chrome.identity không sẵn sàng. Kiểm tra permission "identity" rồi reload extension.');
      return false;
    }
    return true;
  }

  function mustChromeStorage() {
    if (!window.chrome || !chrome.storage || !chrome.storage.local) {
      toast('chrome.storage.local không sẵn sàng. Kiểm tra permission "storage" rồi reload extension.');
      return false;
    }
    return true;
  }

  async function storageSet(obj) {
    if (!mustChromeStorage()) throw new Error("chrome.storage.local unavailable");
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  // ------------------------------------------------------------------
  // Supabase helpers
  function supaReady() {
    if (!SUPA_URL || !SUPA_KEY) {
      toast("Thiếu SUPABASE_URL hoặc SUPABASE_KEY trong auth/config.js");
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

      if (res.status === 401 && txt.includes("row-level security")) {
        toast("RLS đang chặn thao tác trên bảng users. Bạn cần tạo policy INSERT/SELECT/UPDATE cho role anon.");
      }
    }
    return res;
  }

  async function supaSelectUser(email) {
    const res = await supaFetch(
      `/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id,email,phone,password_hash,auth_provider,status,created_at,last_login_at`
    );
    if (!res.ok) throw new Error(`Supabase select failed (${res.status})`);
    const arr = await res.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  }

  async function supaInsertUser(email, password_hash) {
    const body = {
      email,
      phone: null,
      password_hash,
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

  async function supaInsertAuthLogin(user_id, provider, success, reason = null) {
    try {
      await supaFetch("/rest/v1/auth_logins", {
        method: "POST",
        body: JSON.stringify({
          user_id,
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
    const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sha256(str) {
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(hash);
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
    const saltB64 = base64url(salt);
    const hashB64 = base64url(hashBytes);
    return `${HASH_PREFIX}$${PBKDF2_ITERS}$${saltB64}$${hashB64}`;
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
  function emailLooksOk(email) {
    const e = String(email || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e);
  }

  // ✅ policy mới: 8 ký tự + thường + hoa + số + ký tự đặc biệt
  function passwordPolicy(pw) {
    const s = String(pw || "");
    const len = s.length >= 8;
    const lower = /[a-z]/.test(s);
    const upper = /[A-Z]/.test(s);
    const num = /[0-9]/.test(s);
    const special = /[^A-Za-z0-9]/.test(s);
    const ok = len && lower && upper && num && special;
    return { ok, len, lower, upper, num, special };
  }

  // ------------------------------------------------------------------
  // UI switch
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
    const h = (location.hash || "#login").toLowerCase();
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

  // Close button
  $("btnClose")?.addEventListener("click", () => {
    window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
  });

  // Notify host
  function notifySuccess(payload) {
    window.parent?.postMessage({ type: "VT_AUTH_SUCCESS", payload }, "*");
  }

  // Password toggles (VN)
  function bindPwToggle(btnId, inputId) {
    const btn = $(btnId);
    const inp = $(inputId);
    if (!btn || !inp) return;

    const syncText = () => {
      btn.textContent = inp.type === "password" ? "Hiện" : "Ẩn";
    };
    syncText();

    btn.addEventListener("click", () => {
      const isPw = inp.type === "password";
      inp.type = isPw ? "text" : "password";
      syncText();
    });
  }
  bindPwToggle("togglePw", "loginPass");
  bindPwToggle("togglePwS", "signupPass");
  bindPwToggle("togglePwS2", "signupPass2");

  // Email form refs
  const loginEmail = $("loginEmail");
  const loginPass = $("loginPass");
  const btnEmailLogin = $("btnEmailLogin");

  const signupEmail = $("signupEmail");
  const signupPass = $("signupPass");
  const signupPass2 = $("signupPass2");
  const btnEmailSignup = $("btnEmailSignup");

  // rules + confirm error
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

    // confirm mismatch UI
    const c = String(signupPass2?.value || "");
    const mismatch = c.length > 0 && pw !== c;

    if (confirmErr) confirmErr.classList.toggle("hidden", !mismatch);
    setInvalid(signupPass2, mismatch);

    return { policyOk: p.ok, mismatch };
  }

  // ✅ Nút sáng khi hợp lệ
  function refreshButtons() {
    // Login: chỉ cần email hợp lệ + có nhập password (không ép policy để tránh chặn user cũ)
    if (btnEmailLogin) {
      const ok = emailLooksOk(loginEmail?.value) && String(loginPass?.value || "").length > 0;
      btnEmailLogin.disabled = !ok;
    }

    // Signup: email hợp lệ + policy ok + confirm đúng
    if (btnEmailSignup) {
      const emailOk = emailLooksOk(signupEmail?.value);
      const { policyOk, mismatch } = renderSignupRules();
      const confirmOk = String(signupPass2?.value || "").length > 0 && !mismatch;

      const ok = emailOk && policyOk && confirmOk;
      btnEmailSignup.disabled = !ok;

      // highlight password nếu chưa đạt và user đã bắt đầu nhập
      const pw = String(signupPass?.value || "");
      const started = pw.length > 0;
      setInvalid(signupPass, started && !policyOk);
    }
  }

  [loginEmail, loginPass, signupEmail, signupPass, signupPass2]
    .filter(Boolean)
    .forEach((el) => el.addEventListener("input", refreshButtons));
  refreshButtons();

  function profileFromEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    const name = e.includes("@") ? e.split("@")[0] : e;
    return { id: e, email: e, name: name || e, provider: "email", picture: "" };
  }

  async function setSession(provider, profile, tokens) {
    const session = { provider, profile, tokens: tokens || {}, updated_at: Date.now() };
    await storageSet({ [KEY_SESSION]: session });
    return session;
  }

  // ------------------------------------------------------------------
  // SIGNUP (Supabase)
  async function doEmailSignup() {
    try {
      if (!supaReady()) return;

      const email = String(signupEmail?.value || "").trim().toLowerCase();
      const pw = String(signupPass?.value || "");
      const pw2 = String(signupPass2?.value || "");

      if (!emailLooksOk(email)) return toast("Email không hợp lệ.");
      const pol = passwordPolicy(pw);
      if (!pol.ok) return toast("Mật khẩu chưa đạt yêu cầu. Vui lòng kiểm tra các tiêu chí bên dưới.");
      if (pw !== pw2) return toast("Mật khẩu nhập lại chưa khớp.");

      const exists = await supaSelectUser(email);
      if (exists) return toast("Tài khoản đã tồn tại. Vui lòng đăng nhập.");

      const password_hash = await makePasswordHash(pw);
      await supaInsertUser(email, password_hash);

      toast("Đăng ký thành công ✅ Vui lòng đăng nhập.", 2600);
      setTimeout(() => {
        location.hash = "#login";
        showLogin();
        if (loginEmail) loginEmail.value = email;
        if (loginPass) loginPass.value = "";
        if (signupPass) signupPass.value = "";
        if (signupPass2) signupPass2.value = "";
        refreshButtons();
        loginPass?.focus?.();
      }, 600);
    } catch (e) {
      toast("Đăng ký thất bại: " + String(e?.message || e));
    }
  }

  // ------------------------------------------------------------------
  // LOGIN (Supabase)
  async function doEmailLogin() {
    try {
      if (!supaReady()) return;

      const email = String(loginEmail?.value || "").trim().toLowerCase();
      const pw = String(loginPass?.value || "");

      if (!emailLooksOk(email)) return toast("Email không hợp lệ.");
      if (!pw) return toast("Vui lòng nhập mật khẩu.");

      const u = await supaSelectUser(email);
      if (!u) {
        toast("Sai email hoặc tài khoản chưa đăng ký.");
        await supaInsertAuthLogin(null, "local", false, "user_not_found");
        return;
      }

      if (u.status && u.status !== "active") {
        toast("Tài khoản đang bị khóa hoặc chưa kích hoạt.");
        await supaInsertAuthLogin(u.id, "local", false, "status_" + u.status);
        return;
      }

      const ok = await verifyPassword(pw, u.password_hash);
      if (!ok) {
        toast("Sai mật khẩu.");
        await supaInsertAuthLogin(u.id, "local", false, "bad_password");
        return;
      }

      await supaUpdateLastLogin(u.id);
      await supaInsertAuthLogin(u.id, "local", true, null);

      const profile = profileFromEmail(email);
      const session = await setSession("email", profile, {});
      notifySuccess({ provider: "email", user: profile, tokens: {}, session });

      toast("Đăng nhập thành công ✅");
      window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
    } catch (e) {
      toast("Đăng nhập thất bại: " + String(e?.message || e));
    }
  }

  btnEmailSignup?.addEventListener("click", doEmailSignup);
  btnEmailLogin?.addEventListener("click", doEmailLogin);

  $("forgotPw")?.addEventListener("click", (e) => {
    e.preventDefault();
    toast("Chức năng quên mật khẩu cần luồng backend riêng (hoặc tạo tài khoản mới).", 4200);
  });

  // ------------------------------------------------------------------
  // OAuth helpers
  function randStr(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return base64url(a).slice(0, n);
  }

  function getRedirectUri() {
    return chrome.identity.getRedirectURL("auth_cb");
  }

  // ------------------------------------------------------------------
  // Google OAuth (Auth Code + PKCE)
  async function googleLogin() {
    if (!mustChromeIdentity()) return;

    const clientId = (cfg.GOOGLE_CLIENT_ID || "").trim();
    if (!clientId) return toast("Thiếu GOOGLE_CLIENT_ID (auth/config.js)");

    const redirectUri = getRedirectUri();
    const codeVerifier = randStr(64);
    const codeChallenge = base64url(await sha256(codeVerifier));
    const scope = encodeURIComponent("openid email profile");
    const state = randStr(24);

    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&state=${encodeURIComponent(state)}` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&code_challenge_method=S256` +
      `&prompt=select_account`;

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectedTo) => {
      const err = chrome.runtime?.lastError?.message;
      if (err) return toast("Lỗi đăng nhập Google: " + err);
      if (!redirectedTo) return toast("Đăng nhập Google: không nhận được URL redirect.");

      const u = new URL(redirectedTo);
      const code = u.searchParams.get("code");
      const returnedState = u.searchParams.get("state");
      const error = u.searchParams.get("error");

      if (error) return toast("Google trả lỗi: " + error);
      if (!code) return toast("Google: thiếu code.");
      if (returnedState && returnedState !== state) return toast("Google: state không khớp.");

      try {
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            code: code,
            code_verifier: codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }).toString(),
        });

        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok) return toast("Đổi token thất bại: " + JSON.stringify(tokenJson));

        const accessToken = tokenJson.access_token;
        if (!accessToken) return toast("Google: thiếu access_token.");

        const meRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const me = await meRes.json();
        if (!meRes.ok) return toast("Lấy thông tin tài khoản thất bại: " + JSON.stringify(me));

        const profile = {
          id: me.sub,
          name: me.name || me.email || "Người dùng Google",
          email: me.email,
          picture: me.picture || "",
          provider: "google",
        };

        const session = await setSession("google", profile, tokenJson);
        notifySuccess({ provider: "google", user: profile, tokens: tokenJson, session });

        toast("Đăng nhập Google thành công ✅");
        window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
      } catch (e) {
        toast("Đăng nhập Google thất bại: " + String(e));
      }
    });
  }

  // ------------------------------------------------------------------
  // Facebook OAuth (Implicit token)
  async function facebookLogin() {
    if (!mustChromeIdentity()) return;

    const appId = (cfg.FACEBOOK_APP_ID || "").trim();
    if (!appId || appId === "PASTE_FACEBOOK_APP_ID_HERE") {
      return toast("Thiếu FACEBOOK_APP_ID (auth/config.js)");
    }

    const redirectUri = getRedirectUri();
    const state = randStr(24);

    const authUrl =
      "https://www.facebook.com/v20.0/dialog/oauth" +
      `?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent("public_profile,email")}` +
      `&state=${encodeURIComponent(state)}` +
      `&display=popup`;

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectedTo) => {
      const err = chrome.runtime?.lastError?.message;
      if (err) return toast("Lỗi đăng nhập Facebook: " + err);
      if (!redirectedTo) return toast("Đăng nhập Facebook: không nhận được URL redirect.");

      const hash = redirectedTo.split("#")[1] || "";
      const params = new URLSearchParams(hash);
      const accessToken = params.get("access_token");
      const returnedState = params.get("state");
      const error = params.get("error") || params.get("error_description");

      if (error) return toast("Facebook trả lỗi: " + error);
      if (!accessToken) return toast("Facebook: thiếu access_token.");
      if (returnedState && returnedState !== state) return toast("Facebook: state không khớp.");

      try {
        const meRes = await fetch(
          `https://graph.facebook.com/me?fields=id,name,email,picture.width(200).height(200)&access_token=${encodeURIComponent(
            accessToken
          )}`
        );
        const me = await meRes.json();
        if (!meRes.ok) return toast("Lấy thông tin Facebook thất bại: " + JSON.stringify(me));

        const profile = {
          id: me.id,
          name: me.name || me.email || "Người dùng Facebook",
          email: me.email,
          picture: me.picture?.data?.url || "",
          provider: "facebook",
        };

        const session = await setSession("facebook", profile, { access_token: accessToken });
        notifySuccess({ provider: "facebook", user: profile, tokens: { access_token: accessToken }, session });

        toast("Đăng nhập Facebook thành công ✅");
        window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
      } catch (e) {
        toast("Đăng nhập Facebook thất bại: " + String(e));
      }
    });
  }

  // Bind OAuth buttons
  const fbBtns = ["btnFbLogin", "btnFbSignup"].map($).filter(Boolean);
  const ggBtns = ["btnGgLogin", "btnGgSignup"].map($).filter(Boolean);

  const fbAppId = String(cfg.FACEBOOK_APP_ID || "").trim();
  const fbEnabled = !!fbAppId && fbAppId !== "PASTE_FACEBOOK_APP_ID_HERE";
  if (fbEnabled) {
    fbBtns.forEach((b) => b.addEventListener("click", facebookLogin));
  } else {
    // Hide Facebook login buttons in production build when app id is not configured.
    fbBtns.forEach((b) => (b.style.display = "none"));
  }

  const ggClientId = String(cfg.GOOGLE_CLIENT_ID || "").trim();
  const ggEnabled = !!ggClientId;
  if (ggEnabled) {
    ggBtns.forEach((b) => b.addEventListener("click", googleLogin));
  } else {
    ggBtns.forEach((b) => (b.style.display = "none"));
  }
})();
