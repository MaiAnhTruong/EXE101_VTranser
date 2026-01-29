// auth/auth.js
(() => {
  const cfg = window.VT_AUTH_CONFIG || {};
  const toastEl = document.getElementById("toast");
  const $ = (id) => document.getElementById(id);

  // ===== Storage keys =====
  const KEY_USERS_TXT = "vtUsersTxt"; // "users.txt" dạng text trong chrome.storage.local
  const KEY_SESSION   = "vtAuth";     // session đang dùng (giống google/facebook)

  // ===== Crypto params =====
  const PBKDF2_ITERS = 120000;
  const SALT_BYTES   = 16;

  function toast(msg, ms = 2600) {
    if (!toastEl) return alert(msg);
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
  }

  function mustChromeIdentity() {
    if (!window.chrome || !chrome.identity || !chrome.identity.launchWebAuthFlow) {
      toast('chrome.identity không sẵn sàng. Hãy kiểm tra manifest permission: "identity" và reload extension.');
      return false;
    }
    return true;
  }

  function mustChromeStorage() {
    if (!window.chrome || !chrome.storage || !chrome.storage.local) {
      toast('chrome.storage.local không sẵn sàng. Hãy kiểm tra manifest permission: "storage" và reload extension.');
      return false;
    }
    return true;
  }

  function getRedirectUri(path) {
    // Nếu bạn muốn tách redirect cho FB thì truyền 'facebook'
    // mặc định: chrome.identity.getRedirectURL()
    return path ? chrome.identity.getRedirectURL(path) : chrome.identity.getRedirectURL();
  }

  function randStr(len = 32) {
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    return [...a].map((x) => (x % 36).toString(36)).join("");
  }

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

  async function pbkdf2Hash(password, saltB64, iterations = PBKDF2_ITERS) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const saltBytes = base64urlToBytes(saltB64);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
      keyMaterial,
      256
    );
    return base64url(new Uint8Array(bits));
  }

  function emailLooksOk(email) {
    const e = String(email || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e);
  }

  function pwLooksOk(pw) {
    return String(pw || "").length >= 6;
  }

  // ===== chrome.storage helpers (promise) =====
  async function storageGet(keys) {
    if (!mustChromeStorage()) throw new Error("chrome.storage.local unavailable");
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  async function storageSet(obj) {
    if (!mustChromeStorage()) throw new Error("chrome.storage.local unavailable");
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  // ===== "users.txt" helpers =====
  function parseUsersTxt(txt) {
    const lines = String(txt || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const users = [];
    for (const line of lines) {
      try {
        const u = JSON.parse(line);
        if (u && u.email && u.salt && u.hash) users.push(u);
      } catch {
        // ignore bad line
      }
    }
    return users;
  }

  function toUsersTxt(users) {
    return (users || []).map((u) => JSON.stringify(u)).join("\n");
  }

  async function loadUsers() {
    const res = await storageGet([KEY_USERS_TXT]);
    const txt = res?.[KEY_USERS_TXT] || "";
    return { txt, users: parseUsersTxt(txt) };
  }

  async function saveUsers(users) {
    const txt = toUsersTxt(users);
    await storageSet({ [KEY_USERS_TXT]: txt });
    return txt;
  }

  // ===== UI switch =====
  const screenLogin  = $("screenLogin");
  const screenSignup = $("screenSignup");
  const toSignup     = $("toSignup");
  const toLogin      = $("toLogin");

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

  toSignup?.addEventListener("click", (e) => { e.preventDefault(); location.hash = "#signup"; });
  toLogin?.addEventListener("click",  (e) => { e.preventDefault(); location.hash = "#login"; });
  window.addEventListener("hashchange", syncByHash);
  syncByHash();

  // Close button
  $("btnClose")?.addEventListener("click", () => {
    window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
  });

  // ===== Notify host =====
  function notifySuccess(payload) {
    window.parent?.postMessage({ type: "VT_AUTH_SUCCESS", payload }, "*");
  }

  // ===== Password visibility toggles =====
  function bindPwToggle(btnId, inputId) {
    const btn = $(btnId);
    const inp = $(inputId);
    if (!btn || !inp) return;
    btn.addEventListener("click", () => {
      const isPw = inp.type === "password";
      inp.type = isPw ? "text" : "password";
      btn.textContent = isPw ? "Hide" : "Show";
    });
  }
  bindPwToggle("togglePw", "loginPass");
  bindPwToggle("togglePwS", "signupPass");
  bindPwToggle("togglePwS2", "signupPass2");

  // ===== EMAIL LOGIN/SIGNUP =====
  const loginEmail    = $("loginEmail");
  const loginPass     = $("loginPass");
  const btnEmailLogin = $("btnEmailLogin");

  const signupEmail    = $("signupEmail");
  const signupPass     = $("signupPass");
  const signupPass2    = $("signupPass2");
  const btnEmailSignup = $("btnEmailSignup");

  function refreshEmailButtons() {
    if (btnEmailLogin) {
      const ok = emailLooksOk(loginEmail?.value) && pwLooksOk(loginPass?.value);
      btnEmailLogin.disabled = !ok;
    }
    if (btnEmailSignup) {
      const ok =
        emailLooksOk(signupEmail?.value) &&
        pwLooksOk(signupPass?.value) &&
        String(signupPass?.value || "") === String(signupPass2?.value || "");
      btnEmailSignup.disabled = !ok;
    }
  }

  [loginEmail, loginPass, signupEmail, signupPass, signupPass2]
    .filter(Boolean)
    .forEach((el) => el.addEventListener("input", refreshEmailButtons));
  refreshEmailButtons();

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

  // ✅ SIGNUP: chỉ tạo user + toast + chuyển về login (KHÔNG auto-login)
  async function doEmailSignup() {
    try {
      const email = String(signupEmail?.value || "").trim().toLowerCase();
      const pw = String(signupPass?.value || "");
      const pw2 = String(signupPass2?.value || "");

      if (!emailLooksOk(email)) return toast("Email không hợp lệ.");
      if (!pwLooksOk(pw)) return toast("Password phải >= 6 ký tự.");
      if (pw !== pw2) return toast("Confirm password không khớp.");

      const { users } = await loadUsers();
      const exists = users.some((u) => String(u.email).toLowerCase() === email);
      if (exists) return toast("Email đã tồn tại. Hãy Log in.");

      const saltBytes = new Uint8Array(SALT_BYTES);
      crypto.getRandomValues(saltBytes);
      const salt = base64url(saltBytes);
      const hash = await pbkdf2Hash(pw, salt, PBKDF2_ITERS);

      const user = {
        email,
        salt,
        hash,
        iter: PBKDF2_ITERS,
        created_at: Date.now(),
      };
      users.push(user);
      await saveUsers(users);

      // ✅ toast + quay về login để user đăng nhập lại
      toast("Đăng ký thành công ✅ Vui lòng đăng nhập.", 2600);

      // chuyển về login + prefill email
      setTimeout(() => {
        location.hash = "#login";
        showLogin();
        if (loginEmail) loginEmail.value = email;
        if (loginPass) loginPass.value = "";
        if (signupPass) signupPass.value = "";
        if (signupPass2) signupPass2.value = "";
        refreshEmailButtons();
        loginPass?.focus?.();
      }, 600);
    } catch (e) {
      toast("Signup failed: " + String(e?.message || e));
    }
  }

  async function doEmailLogin() {
    try {
      const email = String(loginEmail?.value || "").trim().toLowerCase();
      const pw = String(loginPass?.value || "");

      if (!emailLooksOk(email)) return toast("Email không hợp lệ.");
      if (!pwLooksOk(pw)) return toast("Password phải >= 6 ký tự.");

      const { users } = await loadUsers();
      const u = users.find((x) => String(x.email).toLowerCase() === email);
      if (!u) return toast("Không tìm thấy tài khoản. Hãy Sign up.");

      const iter = Number(u.iter || PBKDF2_ITERS);
      const calc = await pbkdf2Hash(pw, u.salt, iter);
      if (calc !== u.hash) return toast("Sai mật khẩu.");

      const profile = profileFromEmail(email);
      const session = await setSession("email", profile, {});

      notifySuccess({ provider: "email", user: profile, tokens: {}, session });

      toast("Logged in ✅");
      window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
    } catch (e) {
      toast("Login failed: " + String(e?.message || e));
    }
  }

  btnEmailSignup?.addEventListener("click", doEmailSignup);
  btnEmailLogin?.addEventListener("click", doEmailLogin);

  $("forgotPw")?.addEventListener("click", (e) => {
    e.preventDefault();
    toast("Demo/local: chưa hỗ trợ reset password. Hãy tạo tài khoản mới hoặc tự xoá dòng user trong users.txt (vtUsersTxt).", 4200);
  });

  // ===== Google OAuth (Auth Code + PKCE) =====
  async function googleLogin() {
    if (!mustChromeIdentity()) return;

    const clientId = (cfg.GOOGLE_CLIENT_ID || "").trim();
    if (!clientId) return toast("Missing GOOGLE_CLIENT_ID (auth/config.js)");

    const redirectUri = getRedirectUri();

    // PKCE
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

    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      async (redirectedTo) => {
        const err = chrome.runtime?.lastError?.message;
        if (err) return toast("Google login error: " + err);
        if (!redirectedTo) return toast("Google login: no redirect URL returned.");

        const u = new URL(redirectedTo);
        const code = u.searchParams.get("code");
        const returnedState = u.searchParams.get("state");
        const error = u.searchParams.get("error");

        if (error) return toast("Google error: " + error);
        if (!code) return toast("Google: missing code in redirect.");
        if (returnedState && returnedState !== state) return toast("Google: state mismatch.");

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
          if (!tokenRes.ok) {
            return toast("Token exchange failed: " + JSON.stringify(tokenJson));
          }

          const accessToken = tokenJson.access_token;
          if (!accessToken) return toast("Google: missing access_token.");

          const meRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const me = await meRes.json();
          if (!meRes.ok) return toast("Userinfo failed: " + JSON.stringify(me));

          const profile = {
            id: me.sub,
            name: me.name || me.email || "Google user",
            email: me.email,
            picture: me.picture || "",
            provider: "google",
          };

          const session = await setSession("google", profile, tokenJson);

          notifySuccess({ provider: "google", user: profile, tokens: tokenJson, session });

          toast("Logged in with Google ✅");
          window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
        } catch (e) {
          toast("Google login failed: " + String(e));
        }
      }
    );
  }

  // ===== Facebook OAuth (Implicit token) =====
  async function facebookLogin() {
    if (!mustChromeIdentity()) return;

    const appId = (cfg.FACEBOOK_APP_ID || "").trim();
    if (!appId || appId === "PASTE_FACEBOOK_APP_ID_HERE") {
      return toast("Missing FACEBOOK_APP_ID (auth/config.js)");
    }

    // Bạn có thể dùng getRedirectUri('facebook') nếu đã set redirect riêng.
    // Ở đây giữ giống code của bạn (đơn giản):
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

    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      async (redirectedTo) => {
        const err = chrome.runtime?.lastError?.message;
        if (err) return toast("Facebook login error: " + err);
        if (!redirectedTo) return toast("Facebook login: no redirect URL returned.");

        const hash = redirectedTo.split("#")[1] || "";
        const params = new URLSearchParams(hash);
        const accessToken = params.get("access_token");
        const returnedState = params.get("state");
        const error = params.get("error") || params.get("error_description");

        if (error) return toast("Facebook error: " + error);
        if (!accessToken) return toast("Facebook: missing access_token.");
        if (returnedState && returnedState !== state) return toast("Facebook: state mismatch.");

        try {
          const meRes = await fetch(
            `https://graph.facebook.com/me?fields=id,name,email,picture.width(200).height(200)&access_token=${encodeURIComponent(accessToken)}`
          );
          const me = await meRes.json();
          if (!meRes.ok) return toast("Facebook /me failed: " + JSON.stringify(me));

          const profile = {
            id: me.id,
            name: me.name || me.email || "Facebook user",
            email: me.email,
            picture: me.picture?.data?.url || "",
            provider: "facebook",
          };

          const session = await setSession("facebook", profile, { access_token: accessToken });

          notifySuccess({ provider: "facebook", user: profile, tokens: { access_token: accessToken }, session });

          toast("Logged in with Facebook ✅");
          window.parent?.postMessage({ type: "VT_AUTH_CLOSE" }, "*");
        } catch (e) {
          toast("Facebook login failed: " + String(e));
        }
      }
    );
  }

  // Bind OAuth buttons
  const fbBtns = ["btnFbLogin", "btnFbSignup"].map($).filter(Boolean);
  const ggBtns = ["btnGgLogin", "btnGgSignup"].map($).filter(Boolean);

  fbBtns.forEach((b) => b.addEventListener("click", facebookLogin));
  ggBtns.forEach((b) => b.addEventListener("click", googleLogin));
})();
