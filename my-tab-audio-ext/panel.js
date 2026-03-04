// panel.js (in-page injected)
// FIX:
// - Await start response + show lỗi rõ ràng (BUSY / ws fail)
// - Listen __OFFSCREEN_STATUS__ để update UI trạng thái
// - Listen __PANEL_NOTIFY__ (SW gửi) để show message “Hệ thống bận”
// - Disable/enable Start/Stop hợp lý
// ✅ AUTH REQUIRED: bắt buộc đăng nhập mới được dùng (start)

(() => {
  "use strict";

  const ROOT_ID = "stt-sidepanel-root";
  if (window.__stt_panel_injected__) return;
  window.__stt_panel_injected__ = true;

  const DEFAULT_SERVER = "wss://api.example.com/stt"; // TODO đổi domain thật
  const STORE_KEYS = ["sttServerWs", "sttApiToken", "vtAuth", "vtNeedAuth"];
  const SYSTEM_BUSY_TEXT = "Hệ thống đang bận, vui lòng thử lại sau.";

  function storeGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, resolve); } catch { resolve({}); }
    });
  }
  function storeSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, resolve); } catch { resolve(); }
    });
  }

  function sendMessageAsync(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const runtimeErr = chrome.runtime?.lastError;
          if (runtimeErr) return resolve({ ok: false, code: "SYSTEM_BUSY", error: SYSTEM_BUSY_TEXT });
          resolve(res || null);
        });
      } catch {
        resolve({ ok: false, code: "SYSTEM_BUSY", error: SYSTEM_BUSY_TEXT });
      }
    });
  }

  async function isAuthed() {
    const st = await storeGet(["vtAuth"]);
    const raw = st?.vtAuth || null;
    const profile = raw?.profile || raw?.currentSession?.profile || null;
    return !!(profile && (profile.email || profile.id || profile.name));
  }

  async function markNeedAuth(action = "start") {
    try {
      await storeSet({ vtNeedAuth: { at: Date.now(), action } });
    } catch {}
  }

  let $root = null;
  let $server = null;
  let $token = null;
  let $sub = null;
  let $log = null;
  let $btnStart = null;
  let $btnStop = null;

  // Đếm số câu đã log (không tính 1 câu cuối đang pending)
  let loggedSentCount = 0;
  let isActive = false;
  let isStarting = false;

  function setSub(text) {
    if ($sub) $sub.textContent = text || "";
  }

  function setButtons() {
    if ($btnStart) $btnStart.style.opacity = (isActive || isStarting) ? "0.6" : "1";
    if ($btnStart) $btnStart.style.pointerEvents = (isActive || isStarting) ? "none" : "auto";
    if ($btnStop) $btnStop.style.opacity = (isActive || isStarting) ? "1" : "0.6";
    if ($btnStop) $btnStop.style.pointerEvents = (isActive || isStarting) ? "auto" : "none";
  }

  function setActive(on, starting = false) {
    isActive = !!on;
    isStarting = !!starting;
    if (isStarting) setSub("• Đang kết nối...");
    else setSub(isActive ? "• Đang ghi" : "");
    setButtons();
  }

  function splitSentencesAndTail(text) {
    const sents = [];
    const re = /[^.!?…]*[.!?…]+(?:["”’']+)?(?:\s+|$)/g;
    let lastEnd = 0, m;
    while ((m = re.exec(text)) !== null) {
      sents.push(m[0]);
      lastEnd = re.lastIndex;
    }
    const tail = text.slice(lastEnd);
    return { sents, tail };
  }

  function addRow(timeStr, text, meta = "") {
    if (!$log) return;

    const row = document.createElement("div");
    row.className = "stt-row";

    const t = document.createElement("div");
    t.className = "stt-t";
    t.textContent = timeStr;

    const right = document.createElement("div");

    const tx = document.createElement("div");
    tx.className = "stt-text";
    tx.textContent = text;

    right.appendChild(tx);

    if (meta) {
      const mt = document.createElement("div");
      mt.className = "stt-meta";
      mt.textContent = meta;
      right.appendChild(mt);
    }

    row.appendChild(t);
    row.appendChild(right);

    $log.appendChild(row);
    $log.parentElement?.scrollTo({ top: $log.parentElement.scrollHeight, behavior: "smooth" });
  }

  function addSystem(text) {
    const now = new Date().toLocaleTimeString();
    addRow(now, text, "system");
  }

  async function loadSettingsToUI() {
    const st = await storeGet(STORE_KEYS);
    if ($server) $server.value = st.sttServerWs || DEFAULT_SERVER;
    if ($token) $token.value = st.sttApiToken || "";
  }

  async function onStartClick() {
    if (isActive || isStarting) return;

    // ✅ AUTH gate
    const ok = await isAuthed();
    if (!ok) {
      await markNeedAuth("start");
      addSystem("🔒 Bạn cần đăng nhập để sử dụng. Hãy mở Side Panel (icon extension) và đăng nhập.");
      alert("Bạn cần đăng nhập để sử dụng.\nHãy mở V-Transer Side Panel và đăng nhập.");
      return;
    }

    const server = ($server?.value || "").trim();
    const token = ($token?.value || "").trim(); // optional override

    let u;
    try { u = new URL(server); } catch {
      alert("Server URL không hợp lệ");
      return;
    }

    const isLocalDev = (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    const okProto = (u.protocol === "wss:") || (isLocalDev && u.protocol === "ws:");
    if (!okProto) {
      alert("Server phải là wss:// (hoặc ws://localhost cho dev)");
      return;
    }

    await storeSet({ sttServerWs: server, sttApiToken: token });

    setActive(false, true);
    addSystem("Đang kết nối...");

    const res = await sendMessageAsync({
      __cmd: "__PANEL_START__",
      payload: token ? { server, token } : { server },
    });

    if (!res?.ok) {
      setActive(false, false);

      // ✅ nếu bị AUTH_REQUIRED từ SW
      if (res?.code === "AUTH_REQUIRED") {
        await markNeedAuth("start");
        const msg = String(res?.error || "AUTH_REQUIRED");
        addSystem("❌ " + msg);
        alert(msg + "\nHãy mở Side Panel và đăng nhập.");
        return;
      }

      const msg = SYSTEM_BUSY_TEXT;
      addSystem("❌ " + msg);
      alert(msg);
      return;
    }

    // trạng thái "running" sẽ update từ __OFFSCREEN_STATUS__
    addSystem("✅ Start requested");
  }

  async function onStopClick() {
    if (!isActive && !isStarting) return;
    addSystem("Đang dừng...");
    await sendMessageAsync({ __cmd: "__PANEL_STOP__" });
    // __OFFSCREEN_STATUS__ sẽ setActive(false)
  }

  function mount() {
    if (document.getElementById(ROOT_ID)) return;

    document.documentElement.classList.add("stt-panel-open");

    const root = document.createElement("div");
    root.id = ROOT_ID;

    root.innerHTML = `
      <div id="stt-sp-header">
        <div id="stt-sp-dot"></div>
        <div id="stt-sp-title">V-Transer: AI hỗ trợ dịch thuật, Zoom, Youtube …</div>
        <div id="stt-sp-sub"></div>
        <button id="stt-sp-close" title="Đóng panel">Đóng</button>
      </div>

      <div id="stt-sp-body">
        <div class="stt-card">
          <div class="hd">Transcript
            <div class="url">Website: <span id="stt-sp-url"></span></div>
          </div>
          <div id="stt-log" class="stt-log"></div>
          <div class="stt-live">Live</div>
        </div>
      </div>

      <div id="stt-sp-footer">
        <div id="stt-sp-controls">
          <div class="stt-btn purple" id="btn-translate">Biên dịch</div>
          <div class="stt-btn gray" id="btn-interpret">Phiên dịch</div>
          <div class="stt-btn ghost" id="btn-explain">Thuyết minh</div>
        </div>

        <div id="stt-sp-server-row">
          <input id="stt-sp-server" type="text" placeholder="${DEFAULT_SERVER}" />
          <div class="stt-btn green" id="btn-start">Bắt đầu</div>
        </div>

        <div id="stt-sp-token-row">
          <input id="stt-sp-token" type="password" placeholder="(Advanced) Bearer / JWT / API token" autocomplete="off" spellcheck="false" />
        </div>

        <div class="stt-btn red" id="btn-stop">Dừng</div>
      </div>
    `;

    document.body.appendChild(root);

    // cache refs
    $root = root;
    $server = root.querySelector("#stt-sp-server");
    $token = root.querySelector("#stt-sp-token");
    $sub = root.querySelector("#stt-sp-sub");
    $log = root.querySelector("#stt-log");
    $btnStart = root.querySelector("#btn-start");
    $btnStop = root.querySelector("#btn-stop");

    // fill URL
    root.querySelector("#stt-sp-url").textContent = location.href;

    // wiring
    root.querySelector("#stt-sp-close").onclick = () => teardown();
    $btnStart.onclick = onStartClick;
    $btnStop.onclick = onStopClick;

    // restore
    loadSettingsToUI();

    // ping SW để sync state lần đầu
    chrome.runtime.sendMessage({ __cmd: "__OVERLAY_PING__" }, (res) => {
      const runtimeErr = chrome.runtime?.lastError;
      if (runtimeErr) {
        setActive(false, false);
        return;
      }
      setActive(!!(res && res.active), !!(res && res.starting));
    });

    setButtons();
  }

  function teardown() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.remove();
    document.documentElement.classList.remove("stt-panel-open");

    $root = $server = $token = $sub = $log = $btnStart = $btnStop = null;
    loggedSentCount = 0;
    isActive = false;
    isStarting = false;
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m.__cmd) return;

    if (m.__cmd === "__PANEL_MOUNT__") mount();
    if (m.__cmd === "__PANEL_TEARDOWN__") teardown();

    if (m.__cmd === "__PANEL_OPENED__") {
      setActive(!!m.payload?.active, !!m.payload?.starting);
      if ($server && m.payload?.server) $server.value = m.payload.server;
    }

    // SW -> notify errors, including BUSY
    if (m.__cmd === "__PANEL_NOTIFY__") {
      const p = m.payload || {};
      const text = p.level === "error" ? SYSTEM_BUSY_TEXT : String(p.text || "");
      if (text) addSystem("❌ " + text);
    }

    // OFFSCREEN status -> UI state
    if (m.__cmd === "__OFFSCREEN_STATUS__") {
      const p = m.payload || {};
      const s = p.state || "";

      if (s === "starting" || s === "ws-connecting") {
        setActive(false, true);
      }
      if (s === "running") {
        setActive(true, false);
      }
      if (s === "stopped") {
        setActive(false, false);
        addSystem("⏹ Đã dừng");
      }
      if (s === "server-busy") {
        setActive(false, false);
        addSystem("⚠️ " + SYSTEM_BUSY_TEXT);
      }
      if (s === "server-error") {
        setActive(false, false);
        addSystem("⚠️ " + SYSTEM_BUSY_TEXT);
      }
      if (s === "error") {
        setActive(false, false);
        addSystem("⚠️ " + SYSTEM_BUSY_TEXT);
      }
    }

    // Transcript stable -> log theo câu
    if (m.__cmd === "__TRANSCRIPT_STABLE__") {
      const full = String(m.payload?.full ?? m.full ?? "");
      if (!full || !$log) return;

      const { sents } = splitSentencesAndTail(full);
      const targetCount = Math.max(0, sents.length - 1); // giữ lại 1 câu cuối

      if (targetCount > loggedSentCount) {
        const now = new Date().toLocaleTimeString();
        for (let i = loggedSentCount; i < targetCount; i++) {
          const s = sents[i].trim();
          if (s) addRow(now, s, "Speaker • en • live");
        }
        loggedSentCount = targetCount;
      }
    }
  });

  // Auto-mount when injected
  mount();
})();
