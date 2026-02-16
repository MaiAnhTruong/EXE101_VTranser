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
  // Khi false: WS fail sẽ fail session luôn (tránh trạng thái "running giả")
  const ALLOW_WS_FAIL_FOR_DEBUG = false;

  // gate: only stream PCM after we sent start/config message
  let wsReadyToStream = false;

  let lastMeterLogAt = 0;
  let lastAudioAt = 0;

  let bytesSent = 0;
  let chunksSent = 0;

  const SUPABASE_URL = "https://izziphjuznnzhcdbbptw.supabase.co";
  const SUPABASE_KEY = "sb_publishable_YNUg4THwvvBurGGn59s8Kg_OSkVpVfh";
  const STORAGE_BUCKET_CANDIDATES = [
    "video-recordings",
    "video_recordings",
    "recordings",
    "videos",
    "vtranser-recordings",
  ];

  let recordCfg = null;
  let recordStream = null;
  let mediaRecorder = null;
  let recorderChunks = [];
  let recorderMimeType = "";
  let recorderStartedAt = 0;

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

  function parseDbId(v) {
    const s = String(v ?? "").trim();
    return /^\d+$/.test(s) ? s : "";
  }

  function toIso(v) {
    const t = Date.parse(String(v || ""));
    if (Number.isFinite(t)) return new Date(t).toISOString();
    return new Date().toISOString();
  }

  function supaHeaders(authToken = "", extra = {}) {
    const bearer = String(authToken || "").trim() || SUPABASE_KEY;
    return {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${bearer}`,
      ...extra,
    };
  }

  function pickRecorderMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
    const cands = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=h264,opus",
      "video/webm",
    ];
    for (const mt of cands) {
      try {
        if (MediaRecorder.isTypeSupported(mt)) return mt;
      } catch {}
    }
    return "";
  }

  async function sha256Hex(blob) {
    try {
      const ab = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", ab);
      const arr = Array.from(new Uint8Array(digest));
      return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return "";
    }
  }

  function encodeStoragePath(path) {
    return String(path || "")
      .split("/")
      .map((x) => encodeURIComponent(x))
      .join("/");
  }

  async function uploadBlobToStorage(blob, cfg) {
    const uid = parseDbId(cfg?.userId);
    if (!uid || !blob || !blob.size) return { ok: false, error: "NO_VIDEO_BLOB" };

    const trSessionId = parseDbId(cfg?.trSessionId) || "na";
    const started = new Date(Number(cfg?.startedAt || Date.now()));
    const ts = started.toISOString().replace(/[:.]/g, "-");
    const ext = String(blob.type || "").includes("mp4") ? "mp4" : "webm";
    const path = `users/${uid}/transcript/${trSessionId}/${ts}.${ext}`;
    const encodedPath = encodeStoragePath(path);

    for (const bucket of STORAGE_BUCKET_CANDIDATES) {
      const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: supaHeaders(cfg?.authToken || "", {
            "content-type": blob.type || "video/webm",
            "x-upsert": "true",
          }),
          body: blob,
        });
        if (!r.ok) continue;
        return { ok: true, fileUri: `supabase://${bucket}/${path}`, bucket, path };
      } catch {}
    }
    return { ok: false, error: "STORAGE_UPLOAD_FAILED" };
  }

  async function insertVideoRecordingFlexible(row, cfg) {
    let body = { ...(row || {}) };
    for (let i = 0; i < 10; i++) {
      let r = null;
      try {
        r = await fetch(`${SUPABASE_URL}/rest/v1/video_recordings`, {
          method: "POST",
          headers: supaHeaders(cfg?.authToken || "", {
            "content-type": "application/json",
            Prefer: "return=representation",
          }),
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { ok: false, error: `VIDEO_RECORDINGS_INSERT_FETCH: ${String(e?.message || e)}` };
      }
      if (r.ok) {
        const j = await r.json().catch(() => []);
        return { ok: true, row: Array.isArray(j) ? (j[0] || null) : null };
      }
      const txt = await r.text().catch(() => "");
      const m = String(txt).match(/Could not find the '([^']+)' column/i);
      if (m && body[m[1]] !== undefined) {
        delete body[m[1]];
        continue;
      }
      return { ok: false, error: `VIDEO_RECORDINGS_INSERT_${r.status}: ${txt || "failed"}` };
    }
    return { ok: false, error: "VIDEO_RECORDINGS_INSERT_RETRY_EXCEEDED" };
  }

  async function persistRecordedBlob(blob, cfg = {}) {
    const uid = parseDbId(cfg?.userId);
    if (!uid) return { ok: false, error: "USER_ID_INVALID" };
    if (!blob || !blob.size) return { ok: false, error: "EMPTY_VIDEO_BLOB" };

    const startedAt = Number(cfg?.startedAt || Date.now());
    const endedAt = Number(cfg?.endedAt || Date.now());
    const durationMs = Math.max(0, endedAt - startedAt);

    let fileUrl = "";
    let uploadOk = false;
    let uploadErr = "";
    const upload = await uploadBlobToStorage(blob, cfg);
    if (upload.ok) {
      fileUrl = upload.fileUri;
      uploadOk = true;
    } else {
      uploadErr = String(upload?.error || "STORAGE_UPLOAD_FAILED");
      fileUrl = `recording://upload-failed/${Date.now()}`;
    }

    const trSessionId = parseDbId(cfg?.trSessionId);
    const checksum = await sha256Hex(blob);
    const baseRow = {
      user_id: uid,
      tr_session_id: trSessionId || null,
      chat_session_id: null,
      started_at: toIso(startedAt),
      ended_at: toIso(endedAt),
      duration_ms: durationMs,
      file_url: fileUrl,
      size_bytes: String(blob.size),
      mime_type: String(blob.type || "video/webm"),
      checksum: checksum || null,
      storage_class: "hot",
      encryption_key_id: null,
      status: uploadOk ? "ready" : "processing",
      constent_flag: "true",
      consent_flag: "true",
      purpose: "feature",
      retention_until: toIso(Date.now() + 30 * 24 * 60 * 60 * 1000),
      preview_url: null,
      caption_file_url: null,
    };

    let out = await insertVideoRecordingFlexible(baseRow, cfg);

    // If FK is strict or stale id happened, fallback to nullable FK columns.
    if (!out?.ok && /23503|foreign key/i.test(String(out.error || ""))) {
      out = await insertVideoRecordingFlexible(
        { ...baseRow, tr_session_id: null, chat_session_id: null },
        cfg
      );
    }
    if (!out?.ok && /23503|foreign key/i.test(String(out.error || ""))) {
      out = await insertVideoRecordingFlexible(
        { ...baseRow, user_id: null, tr_session_id: null, chat_session_id: null },
        cfg
      );
    }

    if (!out?.ok && uploadErr) {
      return { ok: false, error: `${String(out.error || "SAVE_FAILED")} | ${uploadErr}` };
    }
    return out;
  }

  function clearVideoRecorderState() {
    try {
      if (mediaRecorder) {
        mediaRecorder.ondataavailable = null;
        mediaRecorder.onstop = null;
        mediaRecorder.onerror = null;
      }
    } catch {}
    mediaRecorder = null;
    recordStream = null;
    recorderChunks = [];
    recorderMimeType = "";
    recorderStartedAt = 0;
    recordCfg = null;
  }

  async function startVideoRecorderIfNeeded(stream, cfg = {}) {
    if (!cfg || !cfg.enabled) return;
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MEDIA_RECORDER_UNSUPPORTED");
    }
    const vTracks = stream?.getVideoTracks?.() || [];
    const aTracks = stream?.getAudioTracks?.() || [];
    if (!vTracks.length) {
      throw new Error("NO_VIDEO_TRACK");
    }
    const mimeType = pickRecorderMimeType();
    const mixed = new MediaStream([...vTracks, ...aTracks]);
    const rec = mimeType
      ? new MediaRecorder(mixed, { mimeType, videoBitsPerSecond: 2_000_000 })
      : new MediaRecorder(mixed);

    recorderChunks = [];
    recorderMimeType = rec.mimeType || mimeType || "video/webm";
    recorderStartedAt = Date.now();
    recordCfg = {
      ...cfg,
      userId: parseDbId(cfg.userId),
      trSessionId: parseDbId(cfg.trSessionId),
      startedAt: recorderStartedAt,
    };
    recordStream = mixed;
    mediaRecorder = rec;

    rec.ondataavailable = (ev) => {
      const d = ev?.data;
      if (d && d.size > 0) recorderChunks.push(d);
    };
    rec.onerror = (ev) => {
      sendStatus({ state: "recording-error", stage: "runtime", error: String(ev?.error?.message || "RECORDER_ERROR") });
    };

    rec.start(1000);
    sendStatus({ state: "recording-started", mimeType: recorderMimeType });
  }

  async function stopVideoRecorderAndPersist(reason = "stop") {
    if (!mediaRecorder && !recordCfg) return;

    try {
      const rec = mediaRecorder;
      if (rec && rec.state !== "inactive") {
        await new Promise((resolve) => {
          const done = () => resolve();
          rec.onstop = done;
          try { rec.requestData(); } catch {}
          try { rec.stop(); } catch { resolve(); }
          setTimeout(resolve, 3000);
        });
      }

      const chunks = recorderChunks.slice();
      const mimeType = recorderMimeType || "video/webm";
      const startedAt = Number(recordCfg?.startedAt || recorderStartedAt || Date.now());
      const endedAt = Date.now();
      const blob = chunks.length ? new Blob(chunks, { type: mimeType }) : null;

      if (!blob || !blob.size) {
        sendStatus({ state: "recording-error", stage: "finalize", error: "EMPTY_VIDEO_BLOB", reason });
        return;
      }

      const persistCfg = { ...(recordCfg || {}), startedAt, endedAt };
      let out = null;
      try {
        out = await persistRecordedBlob(blob, persistCfg);
      } catch (e) {
        out = { ok: false, error: `PERSIST_THROW: ${String(e?.message || e)}` };
      }
      if (!out?.ok) {
        sendStatus({ state: "recording-error", stage: "persist", error: String(out?.error || "SAVE_FAILED"), reason });
      } else {
        sendStatus({
          state: "recording-saved",
          reason,
          size_bytes: blob.size,
          duration_ms: Math.max(0, endedAt - startedAt),
          tr_session_id: parseDbId(recordCfg?.trSessionId) || null,
        });
      }
    } catch (e) {
      sendStatus({ state: "recording-error", stage: "stop", error: String(e?.message || e), reason });
    } finally {
      try {
        if (recordStream) {
          for (const t of recordStream.getTracks()) {
            try { t.stop(); } catch {}
          }
        }
      } catch {}
      clearVideoRecorderState();
    }
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

    await stopVideoRecorderAndPersist(reason);

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

  async function getTabCaptureStream(streamId, keepVideo = false) {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: keepVideo
        ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxFrameRate: 30 } }
        : false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!keepVideo) {
      try { for (const vt of stream.getVideoTracks()) { try { vt.stop(); } catch {} } } catch {}
      return new MediaStream(stream.getAudioTracks());
    }
    return stream;
  }

  async function getDisplayMediaStream(keepVideo = false) {
    sendStatus({ state: "picker", stage: "getDisplayMedia", note: "Chọn TAB và bật 'Share audio'." });

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });

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

    if (!keepVideo) {
      try { for (const vt of stream.getVideoTracks()) { try { vt.stop(); } catch {} } } catch {}
      return new MediaStream(aTracks);
    }
    return stream;
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
      recording,
      strictWs: strictFlag,
      connectTimeoutMs,
      handshakeTimeoutMs,
    } = payload || {};

    if (!server) throw new Error("Missing server");

    strictWs = !!strictFlag;
    const recCfg = (recording && typeof recording === "object") ? recording : { enabled: false };
    const wantRecordVideo = !!recCfg.enabled;

    await stopAll("restart");

    log("start()", {
      captureSource,
      server,
      streamId: streamId ? String(streamId).slice(0, 10) + "..." : null,
      strictWs,
      connectTimeoutMs,
      handshakeTimeoutMs,
      wantRecordVideo,
    });

    sendStatus({ state: "starting", captureSource, strictWs, wantRecordVideo });

    // 1) get media stream
    try {
      if (captureSource === "display") {
        mediaStream = await getDisplayMediaStream(wantRecordVideo);
      } else {
        if (!streamId) throw new Error("Missing streamId");
        mediaStream = await getTabCaptureStream(streamId, wantRecordVideo);
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

    if (wantRecordVideo) {
      try {
        await startVideoRecorderIfNeeded(mediaStream, recCfg);
      } catch (e) {
        sendStatus({ state: "recording-error", stage: "init", error: String(e?.message || e) });
        throw e;
      }
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
      if (strictWs || !ALLOW_WS_FAIL_FOR_DEBUG) {
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
