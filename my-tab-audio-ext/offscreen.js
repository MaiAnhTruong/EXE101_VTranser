// offscreen.js
// FIX (2026-02):
// - WS handshake: timer starts AFTER ws.onopen (no connect/TLS counted)
// - Avoid deadlock: attach worklet port handler BEFORE awaiting handshake,
//   and allow handshake success on first audio chunk sent (or any server msg)
// - Accept server messages using type/event/kind/op/action, and support Blob text
// - Separate connect timeout vs handshake timeout
// - Keep BUSY early-detect: {type/event:"error",code:"BUSY"} or close 1013/busy reason => stopAll + notify

(() => {
  "use strict";

  const TAG = "[VT][OFF]";
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  let audioCtx = null;
  let mediaStream = null;

  let srcNode = null;
  let workletNode = null;
  let silentGain = null;
  let monitorGain = null;

  let ws = null;
  let wsOpen = false;
  let strictWs = true;

  // gate: only stream PCM after we sent start/config message
  let wsReadyToStream = false;

  let lastMeterLogAt = 0;
  let lastAudioAt = 0;

  let bytesSent = 0;
  let chunksSent = 0;

  // ---- handshake control ----
  let handshakeResolve = null;
  let handshakeReject = null;
  let handshakeTimer = null;
  let handshakeOk = false;

  // ---- connect timeout ----
  let connectTimer = null;

  function log(...args) { console.log(TAG, ...args); }

  function sendStatus(payload = {}) {
    try {
      chrome.runtime.sendMessage({
        __cmd: "__OFFSCREEN_STATUS__",
        payload: { ts: Date.now(), ...payload }
      });
    } catch {}
  }

  function clearHandshake() {
    if (handshakeTimer) {
      try { clearTimeout(handshakeTimer); } catch {}
    }
    handshakeTimer = null;
    handshakeResolve = null;
    handshakeReject = null;
  }

  function beginHandshake(timeoutMs = 8000) {
    clearHandshake();
    handshakeOk = false;

    return new Promise((resolve, reject) => {
      handshakeResolve = resolve;
      handshakeReject = reject;

      handshakeTimer = setTimeout(() => {
        reject(new Error("WS_HANDSHAKE_TIMEOUT"));
      }, timeoutMs);
    });
  }

  function resolveHandshakeIfAny(reason = "ok") {
    if (handshakeOk) return;
    handshakeOk = true;
    if (handshakeResolve) {
      try { handshakeResolve(reason); } catch {}
    }
    clearHandshake();
  }

  function rejectHandshakeIfAny(err) {
    if (handshakeOk) return;
    if (handshakeReject) {
      try { handshakeReject(err); } catch {}
    }
    clearHandshake();
  }

  function clearConnectTimer() {
    if (connectTimer) {
      try { clearTimeout(connectTimer); } catch {}
    }
    connectTimer = null;
  }

  function safeSendText(socket, obj) {
    try {
      socket.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function guessKind(obj) {
    const k = obj?.type ?? obj?.event ?? obj?.kind ?? obj?.op ?? obj?.action ?? "";
    return String(k || "").toLowerCase();
  }

  async function normalizeWsText(data) {
    // ws message can be string or Blob in browser
    if (typeof data === "string") return data;
    try {
      if (data && typeof data.text === "function") {
        return await data.text();
      }
    } catch {}
    return null;
  }

  async function closeWs({ sendStop = true } = {}) {
    try {
      if (wsOpen && ws && ws.readyState === WebSocket.OPEN && sendStop) {
        safeSendText(ws, { event: "stop" });
      }
    } catch {}

    try {
      wsOpen = false;
      wsReadyToStream = false;

      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        try { ws.close(); } catch {}
      }
    } catch {}

    ws = null;
    clearHandshake();
    clearConnectTimer();
  }

  async function stopAll(reason = "stop") {
    log("stopAll reason=", reason);
    sendStatus({ state: "stopping", reason });

    await closeWs({ sendStop: true });

    try { if (workletNode) workletNode.port.onmessage = null; } catch {}
    try { if (srcNode) srcNode.disconnect(); } catch {}
    try { if (workletNode) workletNode.disconnect(); } catch {}
    try { if (silentGain) silentGain.disconnect(); } catch {}
    try { if (monitorGain) monitorGain.disconnect(); } catch {}

    srcNode = null;
    workletNode = null;
    silentGain = null;
    monitorGain = null;

    try {
      if (mediaStream) {
        for (const t of mediaStream.getTracks()) {
          try { t.stop(); } catch {}
        }
      }
    } catch {}
    mediaStream = null;

    try { if (audioCtx) await audioCtx.close(); } catch {}
    audioCtx = null;

    wsOpen = false;
    wsReadyToStream = false;

    bytesSent = 0;
    chunksSent = 0;
    lastAudioAt = 0;
    handshakeOk = false;

    sendStatus({ state: "stopped", reason });
  }

  async function getTabCaptureStream(streamId) {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
  }

  async function getDisplayMediaStream() {
    sendStatus({ state: "picker", stage: "getDisplayMedia", note: "Chọn TAB và bật 'Share audio'." });

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });

    // stop video tracks (we only need audio)
    try { for (const vt of stream.getVideoTracks()) { try { vt.stop(); } catch {} } } catch {}

    const aTracks = stream.getAudioTracks();
    if (!aTracks.length) {
      try { stream.getTracks().forEach(t => { try { t.stop(); } catch {} }); } catch {}
      throw new Error("NO_AUDIO_TRACK_FROM_PICKER (Hãy chọn TAB và tick 'Share audio')");
    }

    try {
      aTracks[0].addEventListener("ended", () => {
        sendStatus({ state: "ended", reason: "user-stopped-sharing" });
        stopAll("track-ended");
      });
    } catch {}

    return new MediaStream(aTracks);
  }

  async function handleServerTextMessage(text) {
    // Any message from server is a handshake evidence
    // but we still try parse JSON to route transcript/status/errors.
    let obj = null;
    try { obj = JSON.parse(text); } catch {}

    if (!obj || typeof obj !== "object") {
      // plain text still means server responded
      resolveHandshakeIfAny("text");
      return;
    }

    const kind = guessKind(obj);

    // busy/error
    if (kind === "error") {
      const code = String(obj.code || obj.err_code || "").toUpperCase();
      const msg = obj.error || obj.message || obj.detail || "SERVER_ERROR";

      if (code === "BUSY" || /bận|busy/i.test(String(msg))) {
        sendStatus({ state: "server-busy", code: obj.code || "BUSY", error: String(msg) });
        rejectHandshakeIfAny(new Error("BUSY"));
        stopAll("busy");
        return;
      }

      sendStatus({ state: "server-error", code: obj.code || "", error: String(msg) });
      rejectHandshakeIfAny(new Error(String(msg)));
      if (strictWs) stopAll("server-error");
      return;
    }

    // hello/status: handshake evidence
    if (kind === "hello") {
      sendStatus({ state: "server-hello", detail: obj.detail || obj.data || {} });
      resolveHandshakeIfAny("hello");
      return;
    }

    if (kind === "status") {
      sendStatus({ state: "server-status", detail: obj.detail || obj.data || {}, stage: obj.stage || "" });
      resolveHandshakeIfAny("status");
      return;
    }

    // transcript relay (accept both type/event)
    if (kind === "delta") {
      chrome.runtime.sendMessage({ __cmd: "__TRANSCRIPT_DELTA__", payload: obj });
      resolveHandshakeIfAny("delta");
      return;
    }
    if (kind === "stable") {
      chrome.runtime.sendMessage({ __cmd: "__TRANSCRIPT_STABLE__", payload: obj });
      resolveHandshakeIfAny("stable");
      return;
    }
    if (kind === "patch") {
      chrome.runtime.sendMessage({ __cmd: "__TRANSCRIPT_PATCH__", payload: obj });
      resolveHandshakeIfAny("patch");
      return;
    }

    // any other JSON message counts as handshake evidence too
    resolveHandshakeIfAny("other");
  }

  async function openWs(serverUrl, auth = null, opts = {}) {
    const {
      connectTimeoutMs = 10000,
      handshakeTimeoutMs = 8000,
      sampleRate = 48000,
      dtype = "i16",
    } = opts;

    await closeWs({ sendStop: false });
    handshakeOk = false;

    return await new Promise((resolve, reject) => {
      try {
        log("WS connecting ->", serverUrl);
        sendStatus({ state: "ws-connecting", server: serverUrl });

        const socket = new WebSocket(serverUrl);
        ws = socket;
        socket.binaryType = "arraybuffer";

        // connect timeout (no onopen)
        clearConnectTimer();
        connectTimer = setTimeout(() => {
          sendStatus({ state: "ws-error", error: "WS_CONNECT_TIMEOUT" });
          try { socket.close(); } catch {}
          reject(new Error("WS_CONNECT_TIMEOUT"));
        }, Math.max(1000, Number(connectTimeoutMs) || 10000));

        socket.onopen = () => {
          clearConnectTimer();

          wsOpen = true;
          wsReadyToStream = false;

          log("WS open");
          sendStatus({ state: "ws-open" });

          // Start handshake timer only AFTER open
          const hs = beginHandshake(Math.max(1000, Number(handshakeTimeoutMs) || 8000));

          // Optional: auth message first (fallback mode)
          if (auth && auth.sendFirst && auth.token) {
            const ok = safeSendText(socket, { type: "auth", scheme: "bearer", token: auth.token });
            sendStatus({ state: ok ? "ws-auth-sent" : "ws-auth-send-failed" });
          }

          // Explicit start event for server session config
          safeSendText(socket, { event: "start", sample_rate: sampleRate, dtype });

          // allow streaming PCM AFTER start config sent
          wsReadyToStream = true;

          // Resolve openWs when handshake succeeds (server message OR first audio chunk sent)
          hs.then(() => resolve(true)).catch((e) => reject(e));
        };

        socket.onclose = (ev) => {
          clearConnectTimer();

          wsOpen = false;
          wsReadyToStream = false;

          const code = ev?.code;
          const reason = ev?.reason || "";
          log("WS close", code, reason);
          sendStatus({ state: "ws-close", code, reason });

          // Busy (single-user): code commonly 1013 or reason contains busy
          if (code === 1013 || /busy|bận/i.test(reason || "")) {
            sendStatus({ state: "server-busy", code, reason, error: "Hệ thống bận" });
            rejectHandshakeIfAny(new Error("BUSY"));
            stopAll("busy");
            return;
          }

          // If closed before handshake => reject handshake (causes start fail in strict)
          if (!handshakeOk) {
            rejectHandshakeIfAny(new Error(`WS_CLOSED_${code || 0}`));
          }

          if (strictWs) {
            stopAll("ws-close");
          }
        };

        socket.onerror = () => {
          clearConnectTimer();

          wsOpen = false;
          wsReadyToStream = false;

          log("WS error");
          sendStatus({ state: "ws-error" });

          rejectHandshakeIfAny(new Error("WS_CONNECT_FAILED"));
          reject(new Error("WS_CONNECT_FAILED"));
        };

        socket.onmessage = (ev) => {
          (async () => {
            const txt = await normalizeWsText(ev.data);
            if (!txt) return;
            await handleServerTextMessage(txt);
          })().catch(() => {});
        };
      } catch (e) {
        rejectHandshakeIfAny(e);
        reject(e);
      }
    });
  }

  async function start(payload) {
    const {
      streamId,
      server,
      captureSource,
      auth,
      strictWs: strictFlag,
      connectTimeoutMs,
      handshakeTimeoutMs,
    } = payload || {};

    if (!server) throw new Error("Missing server");

    strictWs = !!strictFlag;

    await stopAll("restart");

    log("start()", {
      captureSource,
      server,
      streamId: streamId ? String(streamId).slice(0, 10) + "..." : null,
      strictWs,
      connectTimeoutMs,
      handshakeTimeoutMs
    });

    sendStatus({ state: "starting", captureSource, strictWs });

    // 1) get media stream
    try {
      if (captureSource === "display") {
        mediaStream = await getDisplayMediaStream();
      } else {
        if (!streamId) throw new Error("Missing streamId");
        mediaStream = await getTabCaptureStream(streamId);
      }
    } catch (e) {
      log("get media failed:", e?.name, e?.message);
      sendStatus({ state: "error", stage: "getMedia", error: String(e?.message || e) });
      throw e;
    }

    const aTracks = mediaStream.getAudioTracks();
    log("audioTracks=", aTracks.length, aTracks[0]?.label || "");
    sendStatus({
      state: "media-ok",
      audioTracks: aTracks.length,
      audioLabel: aTracks[0]?.label || ""
    });

    if (!aTracks.length) {
      sendStatus({ state: "error", stage: "no-audio", error: "NO_AUDIO_TRACK" });
      throw new Error("NO_AUDIO_TRACK");
    }

    // 2) audio graph + worklet
    audioCtx = new AudioContext({ sampleRate: 48000 });
    await audioCtx.resume();

    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet/pcm-processor.js"));

    srcNode = audioCtx.createMediaStreamSource(mediaStream);

    workletNode = new AudioWorkletNode(audioCtx, "pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { chunkSize: 2048, meterEveryNChunks: 8 }
    });

    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0.0;

    monitorGain = audioCtx.createGain();
    monitorGain.gain.value = 0.0;

    srcNode.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    srcNode.connect(monitorGain);
    monitorGain.connect(audioCtx.destination);

    sendStatus({ state: "audio-graph-ok", sampleRate: audioCtx.sampleRate });

    // 3) IMPORTANT: attach worklet handler BEFORE we await WS handshake
    //    => avoids deadlock and allows handshake success on first audio chunk sent.
    let firstAudioChunkSent = false;

    workletNode.port.onmessage = (ev) => {
      const msg = ev?.data;
      if (!msg || !msg.type) return;

      if (msg.type === "meter") {
        const now = Date.now();
        lastAudioAt = now;

        if (now - lastMeterLogAt > 1000) {
          lastMeterLogAt = now;
          sendStatus({
            state: "meter",
            rms: Number(msg.rms || 0),
            peak: Number(msg.peak || 0),
            wsOpen: !!wsOpen,
            wsReadyToStream: !!wsReadyToStream,
            bytesSent,
            chunksSent
          });
        }
        return;
      }

      if (msg.type === "pcm-int16") {
        const buf = msg.payload;
        if (!(buf instanceof ArrayBuffer)) return;

        // stats
        chunksSent++;
        bytesSent += buf.byteLength;

        // send PCM only when ws is fully ready (after start event)
        if (wsOpen && wsReadyToStream && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(buf);

            // handshake can succeed on first sent audio chunk too
            if (!firstAudioChunkSent) {
              firstAudioChunkSent = true;
              resolveHandshakeIfAny("audio");
            }
          } catch {}
        }
        return;
      }
    };

    // 4) WS open + handshake (strict in prod)
    try {
      await openWs(server, auth || null, {
        connectTimeoutMs: connectTimeoutMs ?? 10000,
        handshakeTimeoutMs: handshakeTimeoutMs ?? 8000,
        sampleRate: 48000,
        dtype: "i16",
      });
    } catch (e) {
      sendStatus({ state: "error", stage: "ws", error: String(e?.message || e) });
      if (strictWs) {
        await stopAll("ws-fail");
        throw e;
      }
      // dev mode: allow meter debug even if ws fail
    }

    sendStatus({ state: "running", strictWs });
    log("start OK");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (!msg || !msg.__cmd) return;

      if (msg.__cmd === "__OFFSCREEN_START__") {
        try {
          await start(msg.payload || {});
          sendResponse?.({ ok: true });
        } catch (e) {
          sendResponse?.({ ok: false, error: String(e?.message || e) });
        }
        return;
      }

      if (msg.__cmd === "__OFFSCREEN_STOP__") {
        await stopAll("stop");
        sendResponse?.({ ok: true });
        return;
      }

      if (msg.__cmd === "__OFFSCREEN_MONITOR_GAIN__") {
        const v = Number(msg.payload?.gain ?? 0);
        try {
          if (monitorGain) monitorGain.gain.value = isFinite(v) ? v : 0;
          sendStatus({ state: "monitor", gain: isFinite(v) ? v : 0 });
        } catch {}
        sendResponse?.({ ok: true });
        return;
      }
    })();

    return true;
  });

  log("offscreen loaded:", offscreenUrl);
  sendStatus({ state: "ready" });
})();
