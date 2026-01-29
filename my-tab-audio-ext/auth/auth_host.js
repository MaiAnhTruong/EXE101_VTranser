(() => {
  const cfg = window.VT_AUTH_CONFIG || {};

  // ========= DOM (Auth overlay) =========
  const overlay  = document.getElementById('vtAuthOverlay');
  const backdrop = document.getElementById('vtAuthBackdrop');
  const frame    = document.getElementById('vtAuthFrame');

  const btnAccount =
    document.getElementById('btnAccount') || document.querySelector('[data-vt-account]');

  // ========= DOM (Account overlay) =========
  const accOverlay   = document.getElementById('vtAccountOverlay');
  const accBackdrop  = document.getElementById('vtAccountBackdrop');
  const accNameEl    = document.getElementById('vtAccName');
  const accEmailEl   = document.getElementById('vtAccEmail');
  const accPlanEl    = document.getElementById('vtAccPlan');
  const accAvatarImg = document.getElementById('vtAccAvatar');
  const accAvatarFb  = document.getElementById('vtAccAvatarFallback');
  const accLogoutBtn = document.getElementById('vtAccLogout');
  const accToastEl   = document.getElementById('vtAccToast');

  if (!overlay || !frame || !btnAccount) {
    console.warn('[auth_host] Missing overlay/frame/account button');
    return;
  }

  // ========= Helpers =========
  const EXT_ORIGIN = location.origin; // chrome-extension://<id>
  let currentSession = null; // {provider, profile, tokens, updated_at}

  function qs(sel) { return document.querySelector(sel); }

  function toastAccount(msg, ms = 1800) {
    if (!accToastEl) return;
    accToastEl.textContent = msg;
    accToastEl.classList.remove('hidden');
    clearTimeout(accToastEl._t);
    accToastEl._t = setTimeout(() => accToastEl.classList.add('hidden'), ms);
  }

  function openAuthOverlay(hash = '#login') {
    closeAccountOverlay();
    overlay.classList.remove('vt-hidden');
    overlay.setAttribute('aria-hidden', 'false');

    const url = chrome.runtime.getURL('auth/auth.html') + (hash.startsWith('#') ? hash : ('#' + hash));
    if (frame.src !== url) frame.src = url;
  }

  function closeAuthOverlay() {
    overlay.classList.add('vt-hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function renderAccount(profile) {
    if (!profile) return;

    const name = profile?.name || profile?.email || 'User';
    const email = profile?.email || '';
    const pic = profile?.picture || '';

    if (accNameEl) accNameEl.textContent = name;
    if (accEmailEl) accEmailEl.textContent = email;

    if (accPlanEl) accPlanEl.textContent = 'Free';

    if (accAvatarImg && accAvatarFb) {
      if (pic) {
        accAvatarImg.src = pic;
        accAvatarImg.classList.remove('hidden');
        accAvatarFb.classList.add('hidden');
      } else {
        accAvatarImg.classList.add('hidden');
        accAvatarFb.classList.remove('hidden');
        accAvatarFb.textContent = (name || 'U').trim().slice(0, 1).toUpperCase();
      }
    }
  }

  function openAccountOverlay() {
    if (!accOverlay) return; // nếu bạn chưa thêm UI account thì thôi
    closeAuthOverlay();

    const profile = currentSession?.profile;
    if (!profile) return openAuthOverlay('#login');

    renderAccount(profile);

    accOverlay.classList.remove('vt-hidden');
    accOverlay.setAttribute('aria-hidden', 'false');
  }

  function closeAccountOverlay() {
    if (!accOverlay) return;
    accOverlay.classList.add('vt-hidden');
    accOverlay.setAttribute('aria-hidden', 'true');
  }

  function toggleAccountOrAuth() {
    if (currentSession?.profile) {
      // toggle account menu
      if (!accOverlay) return;
      const isHidden = accOverlay.classList.contains('vt-hidden');
      if (isHidden) openAccountOverlay();
      else closeAccountOverlay();
    } else {
      openAuthOverlay('#login');
    }
  }

  function updateAuthedUI(profile) {
    const name = profile?.name || profile?.email || 'User';

    // update login text (both views)
    document.querySelectorAll('.login-btn').forEach((b) => {
      b.textContent = `Hi, ${name}`;
    });

    // dot on account icon
    btnAccount.classList.add('vt-authed');
  }

  function updateLoggedOutUI() {
    document.querySelectorAll('.login-btn').forEach((b) => {
      b.textContent = 'Log in';
    });
    btnAccount.classList.remove('vt-authed');
  }

  function setSession(sess) {
    currentSession = sess || null;
    if (currentSession?.profile) updateAuthedUI(currentSession.profile);
    else updateLoggedOutUI();
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  // ========= Wire UI events =========
  btnAccount.addEventListener('click', (e) => {
    e.preventDefault?.();
    toggleAccountOrAuth();
  });

  backdrop?.addEventListener('click', closeAuthOverlay);
  accBackdrop?.addEventListener('click', closeAccountOverlay);

  // ESC to close
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAuthOverlay();
      closeAccountOverlay();
    }
  });

  // Logout
  accLogoutBtn?.addEventListener('click', async () => {
    await storageRemove(['vtAuth']);
    setSession(null);
    closeAccountOverlay();
    openAuthOverlay('#login');
  });

  // Menu actions (demo)
  document.querySelectorAll('[data-vt-acc-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-vt-acc-action') || '';
      if (act === 'logout') return;
      toastAccount('Coming soon…');
    });
  });

  // listen requests from iframe
  window.addEventListener('message', async (ev) => {
    const msg = ev?.data;
    if (!msg || typeof msg !== 'object') return;

    // đảm bảo message từ cùng extension origin
    if (ev.origin && ev.origin !== EXT_ORIGIN) return;

    if (msg.type === 'VT_AUTH_CLOSE') {
      closeAuthOverlay();
      return;
    }

    // ✅ quan trọng: iframe login thành công -> lưu vtAuth rồi -> host đọc lại để update UI
    if (msg.type === 'VT_AUTH_SUCCESS') {
      try {
        const res = await storageGet(['vtAuth']);
        if (res?.vtAuth?.profile) {
          setSession(res.vtAuth);
        } else {
          // fallback: nếu payload có user thì tự set
          const u = msg.payload?.user || msg.payload?.profile;
          const provider = msg.payload?.provider || 'unknown';
          if (u) {
            const sess = { provider, profile: u, tokens: msg.payload?.tokens || {}, updated_at: Date.now() };
            await storageSet({ vtAuth: sess });
            setSession(sess);
          }
        }
      } catch {}
      closeAuthOverlay();
      return;
    }

    // (Giữ lại luồng VT_OAUTH_START nếu bạn muốn cho iframe “nhờ host” làm OAuth sau này)
    if (msg.type === 'VT_OAUTH_START') {
      // Bạn có thể triển khai thêm sau (hiện không cần vì iframe tự login)
      return;
    }
  });

  // Restore session UI on load
  chrome.storage.local.get(['vtAuth'], (res) => {
    if (res?.vtAuth?.profile) setSession(res.vtAuth);
    else setSession(null);
  });

  // ========= Expose helpers for sidepanel.js =========
  window.__vtOpenAuthOverlay = (mode = 'login') => openAuthOverlay(mode);
  window.__vtOpenAccountOverlay = () => openAccountOverlay();
  window.__vtOpenAccountOrAuth = (mode = 'login') => {
    if (currentSession?.profile) openAccountOverlay();
    else openAuthOverlay(mode);
  };
})();
