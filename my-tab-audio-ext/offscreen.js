let audioCtx = null;
let workletNode = null;
let mediaSource = null;
let ws = null;
let mediaStream = null;
let meterLastSentAt = 0;

function uiStatus(stage, detail) {
  chrome.runtime.sendMessage({ __cmd: '__OFFSCREEN_STATUS__', payload: { stage, detail } });
}
function uiMeter(rms, peak) {
  const now = performance.now();
  if (now - meterLastSentAt < 120) return; 
  meterLastSentAt = now;
  chrome.runtime.sendMessage({
    __cmd: '__OFFSCREEN_STATUS__',
    payload: { stage: 'METER', meter: { rms, peak } }
  });
}

async function start({ streamId, serverUrl }) {
  try {
    uiStatus('INIT', 'Khởi tạo...');

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    audioCtx = new (self.AudioContext || self.webkitAudioContext)({ sampleRate: 48000 });
    await audioCtx.audioWorklet.addModule('audio-worklet/pcm-processor.js');

    mediaSource = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor', {
      processorOptions: {
        targetSampleRate: 48000,
        chunkSize: 4096,
        meterEveryNChunks: 6
      }
    });

    workletNode.port.onmessage = (ev) => {
      if (ev.data?.type === 'pcm-int16') {
        const buf = ev.data.payload;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
        }
      } else if (ev.data?.type === 'meter') {
        const { rms, peak } = ev.data;
        uiMeter(rms, peak);
      }
    };

    mediaSource.connect(workletNode);
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    workletNode.connect(mute).connect(audioCtx.destination);

    await new Promise((resolve, reject) => {
      ws = new WebSocket(serverUrl);
      ws.binaryType = 'arraybuffer';
      const t = setTimeout(() => reject(new Error('timeout')), 6000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => uiStatus('WS', 'Lỗi WS');
      ws.onclose = () => uiStatus('WS', 'Kết nối WS đã đóng');
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') uiStatus('SERVER', ev.data);
      };
    });

    uiStatus('RUNNING', 'Đang stream');
  } catch (err) {
    uiStatus('ERROR', err?.message || String(err));
    await stop();
  }
}

async function stop() {
  try {
    if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
    if (mediaSource) { try { mediaSource.disconnect(); } catch {} mediaSource = null; }
    if (audioCtx) { try { await audioCtx.close(); } catch {} audioCtx = null; }
    if (mediaStream) { try { for (const t of mediaStream.getTracks()) t.stop(); } catch {} mediaStream = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    uiStatus('STOPPED', 'Đã dừng.');
  } catch (e) {
    uiStatus('ERROR', 'Lỗi dừng: ' + (e?.message || String(e)));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.__cmd === '__OFFSCREEN_START__') {
        await start(msg.payload);
        sendResponse({ ok: true });
      } else if (msg.__cmd === '__OFFSCREEN_STOP__') {
        await stop();
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
