// offscreen.js
(() => {
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

  let lastMeterLogAt = 0;
  let lastAudioAt = 0;
  let bytesSent = 0;
  let chunksSent = 0;

  function log(...args) {
    console.log(TAG, ...args);
  }

  function sendStatus(payload = {}) {
    try {
      chrome.runtime.sendMessage({
        __cmd: "__OFFSCREEN_STATUS__",
        payload: { ts: Date.now(), ...payload }
      });
    } catch {}
  }

  async function closeWs() {
    try {
      wsOpen = false;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try { ws.close(); } catch {}
      }
    } catch {}
    ws = null;
  }

  async function stopAll(reason = "stop") {
    log("stopAll reason=", reason);
    sendStatus({ state: "stopping", reason });

    await closeWs();

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
    bytesSent = 0;
    chunksSent = 0;
    lastAudioAt = 0;

    sendStatus({ state: "stopped" });
  }

  // ---- getUserMedia helpers ----
  async function getTabCaptureStream(streamId) {
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
  }

  // ✅ NEW: getDisplayMedia picker (tab/window/screen)
  async function getDisplayMediaStream() {
    sendStatus({ state: "picker", stage: "getDisplayMedia", note: "Chọn TAB và bật 'Share audio'." });

    // Bắt buộc xin video:true để dialog hiện đầy đủ; xong sẽ stop video track ngay.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });

    // stop video tracks (chỉ cần audio)
    try {
      for (const vt of stream.getVideoTracks()) {
        try { vt.stop(); } catch {}
      }
    } catch {}

    const aTracks = stream.getAudioTracks();
    if (!aTracks.length) {
      // user chọn không share audio hoặc chọn screen/window không có audio
      try { stream.getTracks().forEach(t => { try { t.stop(); } catch {} }); } catch {}
      throw new Error("NO_AUDIO_TRACK_FROM_PICKER (Hãy chọn TAB và tick 'Share audio')");
    }

    // Khi user bấm "Stop sharing" -> track end => tự dừng
    try {
      aTracks[0].addEventListener("ended", () => {
        sendStatus({ state: "ended", reason: "user-stopped-sharing" });
        stopAll("track-ended");
      });
    } catch {}

    return new MediaStream(aTracks);
  }

  async function openWs(serverUrl) {
    await closeWs();

    return await new Promise((resolve, reject) => {
      try {
        log("WS connecting ->", serverUrl);
        sendStatus({ state: "ws-connecting", server: serverUrl });

        const socket = new WebSocket(serverUrl);
        ws = socket;

        socket.binaryType = "arraybuffer";

        socket.onopen = () => {
          wsOpen = true;
          log("WS open");
          sendStatus({ state: "ws-open" });
          resolve(true);
        };

        socket.onclose = () => {
          wsOpen = false;
          log("WS close");
          sendStatus({ state: "ws-close" });
        };

        socket.onerror = (err) => {
          wsOpen = false;
          log("WS error", err);
          sendStatus({ state: "ws-error" });
          reject(new Error("WS_CONNECT_FAILED"));
        };

        socket.onmessage = (ev) => {
          if (typeof ev.data !== "string") return;
          let obj = null;
          try { obj = JSON.parse(ev.data); } catch { return; }
          if (!obj || !obj.type) return;

          if (obj.type === "delta") {
            chrome.runtime.sendMessage({ __cmd: "__TRANSCRIPT_DELTA__", payload: obj });
          } else if (obj.type === "stable") {
            chrome.runtime.sendMessage({ __cmd: "__TRANSCRIPT_STABLE__", payload: obj });
          } else if (obj.type === "patch") {
            chrome.runtime.sendMessage({ __cmd: "__TRANSCRIPT_PATCH__", payload: obj });
          }
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  async function start(payload) {
    const { streamId, server, captureSource } = payload || {};
    if (!server) throw new Error("Missing server");

    await stopAll("restart");

    log("start()", { captureSource, server, streamId: streamId ? String(streamId).slice(0, 10) + "..." : null });
    sendStatus({ state: "starting", captureSource });

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
      const err = new Error("NO_AUDIO_TRACK");
      sendStatus({ state: "error", stage: "no-audio", error: "NO_AUDIO_TRACK" });
      throw err;
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
      processorOptions: {
        chunkSize: 2048,
        meterEveryNChunks: 8
      }
    });

    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0.0;

    monitorGain = audioCtx.createGain();
    monitorGain.gain.value = 0.0; // mặc định không monitor

    srcNode.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    srcNode.connect(monitorGain);
    monitorGain.connect(audioCtx.destination);

    sendStatus({ state: "audio-graph-ok", sampleRate: audioCtx.sampleRate });

    // 3) WS open
    try {
      await openWs(server);
    } catch (e) {
      sendStatus({ state: "error", stage: "ws", error: String(e?.message || e) });
      // vẫn cho chạy audio graph để debug meter
    }

    // 4) worklet messages: pcm + meter
    workletNode.port.onmessage = (ev) => {
      const msg = ev?.data;
      if (!msg || !msg.type) return;

      if (msg.type === "meter") {
        const now = Date.now();
        lastAudioAt = now;

        if (now - lastMeterLogAt > 1000) {
          lastMeterLogAt = now;
          const rms = Number(msg.rms || 0).toFixed(4);
          const peak = Number(msg.peak || 0).toFixed(4);
          log("AUDIO meter rms=", rms, "peak=", peak);

          sendStatus({
            state: "meter",
            rms: Number(msg.rms || 0),
            peak: Number(msg.peak || 0),
            wsOpen: !!wsOpen,
            bytesSent,
            chunksSent
          });
        }
        return;
      }

      if (msg.type === "pcm-int16") {
        const buf = msg.payload;
        if (!(buf instanceof ArrayBuffer)) return;

        chunksSent++;
        bytesSent += buf.byteLength;

        if (wsOpen && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(buf);
          } catch {}
        }
        return;
      }
    };

    sendStatus({ state: "running" });
    log("start OK");
  }

  // ---- message bus from SW ----
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

  // ping when loaded
  log("offscreen loaded:", offscreenUrl);
  sendStatus({ state: "ready" });
})();
