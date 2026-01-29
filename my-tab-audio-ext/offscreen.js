//home/truong/EXE/my-tab-audio-ext/offscreen.js:

let audioCtx = null;
let worklet = null;
let srcNode = null;
let monitorGain = null;  // nhánh phát lại tiếng tab
let silentGain = null;   // nhánh giữ worklet chạy nhưng không phát
let ws = null;
let mediaStream = null;

// Gửi trạng thái về SW (tuỳ chọn để debug trong popup hoặc console SW)
function postStatus(stage, detail) {
  try {
    chrome.runtime.sendMessage({
      __cmd: '__OFFSCREEN_STATUS__',
      payload: { stage, detail }
    });
  } catch {}
}

async function start({ streamId, server, chunkSize = 1024, meterEveryNChunks = 6, monitorVolume = 1.0 }) {
  try {
    postStatus('INIT', 'Starting offscreen...');

    // 1) Lấy audio của TAB hiện tại từ streamId (do SW cấp)
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',           // quan trọng: capture đúng TAB
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // 2) AudioContext + AudioWorklet
    audioCtx = new (self.AudioContext || self.webkitAudioContext)({ sampleRate: 48000 });
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }

    // Nạp module xử lý PCM
    await audioCtx.audioWorklet.addModule('audio-worklet/pcm-processor.js');

    // 3) Nguồn từ MediaStream (của tab)
    srcNode = audioCtx.createMediaStreamSource(mediaStream);

    // 4) Worklet để chunk PCM int16 (gửi WS)
    worklet = new AudioWorkletNode(audioCtx, 'pcm-processor', {
      processorOptions: {
        chunkSize,
        meterEveryNChunks
      }
    });

    // 5) Hai nhánh:
    //    - Nhánh xử lý cho STT (không phát ra loa): src -> worklet -> silent(0) -> destination
    //    - Nhánh monitor (phát lại để nghe):      src -> monitor(gain=1.0) -> destination
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0.0; // không phát, nhưng vẫn cần nối tới destination để clock chạy

    monitorGain = audioCtx.createGain();
    monitorGain.gain.value = Math.max(0, Math.min(1, Number(monitorVolume) || 1.0));

    // Kết nối graph
    srcNode.connect(worklet);
    worklet.connect(silentGain).connect(audioCtx.destination);

    srcNode.connect(monitorGain).connect(audioCtx.destination);

    // 6) Nhận PCM từ worklet và đẩy qua WebSocket
    worklet.port.onmessage = (ev) => {
      if (ev.data?.type === 'pcm-int16') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(ev.data.payload);
        }
      }
      // (meter có thể gửi về SW nếu bạn muốn, nhưng để nhẹ mình không forward ở đây)
    };

    // 7) WebSocket tới server STT
    ws = new WebSocket(server);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => postStatus('WS', 'open');
    ws.onerror = (e) => postStatus('WS', 'error');
    ws.onclose = () => postStatus('WS', 'close');

    // Chuẩn giao thức server.py: {type:'delta', append} | {type:'stable', full}
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const obj = JSON.parse(ev.data);
        if (obj?.type === 'delta' && typeof obj.append === 'string') {
          chrome.runtime.sendMessage({ __cmd: '__TRANSCRIPT_DELTA__', payload: { append: obj.append } });
        } else if (obj?.type === 'stable' && typeof obj.full === 'string') {
          chrome.runtime.sendMessage({ __cmd: '__TRANSCRIPT_STABLE__', payload: { full: obj.full } });
        } else {
          // status/hello/error khác (không bắt buộc forward)
          postStatus('SERVER', ev.data);
        }
      } catch {
        // không phải JSON
        postStatus('SERVER_RAW', ev.data);
      }
    };

    // 8) Nếu track dừng (tab đóng audio), tự stop
    mediaStream.getAudioTracks().forEach((t) => {
      t.onended = () => {
        postStatus('MEDIA', 'track ended');
        stop();
      };
    });

    postStatus('RUNNING', `streaming to ${server}`);
  } catch (err) {
    postStatus('ERROR', err?.message || String(err));
    await stop();
  }
}

async function stop() {
  try {
    // Hạ WS
    if (ws) { try { ws.close(); } catch {} ws = null; }

    // Ngắt graph audio
    if (worklet) { try { worklet.disconnect(); } catch {} worklet = null; }
    if (srcNode) { try { srcNode.disconnect(); } catch {} srcNode = null; }
    if (monitorGain) { try { monitorGain.disconnect(); } catch {} monitorGain = null; }
    if (silentGain) { try { silentGain.disconnect(); } catch {} silentGain = null; }

    // Dừng stream
    if (mediaStream) {
      try { mediaStream.getTracks().forEach(t => t.stop()); } catch {}
      mediaStream = null;
    }

    // Đóng AudioContext
    if (audioCtx) {
      try {
        if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }
        await audioCtx.close();
      } catch {}
      audioCtx = null;
    }

    postStatus('STOPPED', 'offscreen stopped');
  } catch (e) {
    postStatus('ERROR', 'stop: ' + (e?.message || String(e)));
  }
}

// Nhận lệnh từ Service Worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.__cmd) return;

    if (msg.__cmd === '__OFFSCREEN_START__') {
      await start(msg.payload || {});
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.__cmd === '__OFFSCREEN_STOP__') {
      await stop();
      sendResponse?.({ ok: true });
      return;
    }

    // Tuỳ chọn: chỉnh volume monitor trong lúc chạy
    if (msg.__cmd === '__OFFSCREEN_MONITOR_GAIN__') {
      const vol = Math.max(0, Math.min(1, Number(msg.payload?.gain)));
      if (monitorGain) monitorGain.gain.value = vol;
      sendResponse?.({ ok: true, gain: monitorGain?.gain?.value ?? vol });
      return;
    }
  })();
  return true;
});
