const $status = document.getElementById('status');
const $serverUrl = document.getElementById('serverUrl');
const $start = document.getElementById('startBtn');
const $stop  = document.getElementById('stopBtn');
const $meterBar  = document.getElementById('meterBar');
const $meterText = document.getElementById('meterText');
const $transcript = document.getElementById('transcript');
const $useMic = document.getElementById('useMic');
const $testToneBtn = document.getElementById('testToneBtn');

let mediaStream = null;
let audioCtx = null;
let mediaSource = null;
let workletNode = null;
let ws = null;
let running = false;
let meterLastAt = 0;
let toneCtx = null;

let bytesSentTotal = 0;
let bytesSentThisSec = 0;
let statTimer = null;

function log(msg, type='') {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console[type==='err' ? 'error' : 'log']('[CAPTURE]', msg);
  $status.textContent = line + '\n' + $status.textContent;
  if (type==='ok') $status.classList.add('ok');
  if (type==='err') $status.classList.add('err');
}

function printUpdate(kind, text) {
  const time = new Date().toLocaleTimeString();
  $transcript.textContent = `[${time}] ${kind.toUpperCase()}: ${text}\n` + $transcript.textContent;
}

function updateMeter(rms, peak) {
  const pct = Math.max(0, Math.min(100, Math.round(rms * 100)));
  $meterBar.style.width = pct + '%';
  $meterText.textContent = `level: rms=${rms.toFixed(2)} peak=${peak.toFixed(2)}`;
}

function startStatsTimer() {
  stopStatsTimer();
  statTimer = setInterval(() => {
    const kbps = (bytesSentThisSec * 8) / 1000.0;
    log(`TX: ${bytesSentThisSec} bytes/sec (≈${kbps.toFixed(1)} kbps), total=${bytesSentTotal}`);
    bytesSentThisSec = 0;
  }, 1000);
}
function stopStatsTimer() {
  if (statTimer) { clearInterval(statTimer); statTimer = null; }
}

async function getTabStream() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 }, 
    audio: true
  });
  stream.getVideoTracks().forEach(t => { t.enabled = false; });
  return stream;
}

async function getMicStream() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
  return stream;
}

async function playTestTone() {
  try {
    if (!toneCtx) toneCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (toneCtx.state === 'suspended') await toneCtx.resume();
    const osc = toneCtx.createOscillator();
    const gain = toneCtx.createGain();
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0.15, toneCtx.currentTime);
    osc.connect(gain).connect(toneCtx.destination);
    osc.start();
    setTimeout(() => { try { osc.stop(); } catch {} }, 2000);
    log('Đang nghe');
  } catch (e) {
    log('Lỗi' + (e?.message || String(e)), 'err');
  }
}

async function start() {
  if (running) { log('Đang chạy'); return; }
  const serverUrl = $serverUrl.value.trim();
  if (!/^wss?:\/\//i.test(serverUrl)) {
    log('WebSocket server sai', 'err'); return;
  }

  try {
    const stream = $useMic.checked ? await getMicStream() : await getTabStream();

    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error($useMic.checked
        ? 'Không lấy được micro.'
        : 'Không có audio track.');
    }
    mediaStream = stream;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (audioCtx.state === 'suspended') { await audioCtx.resume(); }
    await audioCtx.audioWorklet.addModule('audio-worklet/pcm-processor.js');

    mediaSource = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor', {
      processorOptions: { chunkSize: 2048, meterEveryNChunks: 6 }
    });

    workletNode.port.onmessage = (ev) => {
      if (ev.data?.type === 'pcm-int16') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const buf = ev.data.payload;
          bytesSentTotal += buf.byteLength;
          bytesSentThisSec += buf.byteLength;
          ws.send(buf);
        }
      } else if (ev.data?.type === 'meter') {
        const { rms, peak } = ev.data;
        const now = performance.now();
        if (now - meterLastAt > 100) { meterLastAt = now; updateMeter(rms, peak); }
      }
    };

    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    mediaSource.connect(workletNode).connect(mute).connect(audioCtx.destination);

    await new Promise((resolve, reject) => {
      ws = new WebSocket(serverUrl);
      ws.binaryType = 'arraybuffer';
      const to = setTimeout(() => reject(new Error('WS timeout')), 6000);
      ws.onopen = () => { clearTimeout(to); resolve(); };
      ws.onerror = () => log('WS error', 'err');
      ws.onclose = () => log('WS closed');
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const obj = JSON.parse(ev.data);
            if (obj && obj.type) {
              if (obj.type === 'update' || obj.type === 'stable') {
                const kind = obj.type === 'update' ? 'UPDATE' : 'STABLE';
                if (typeof obj.text === 'string') {
                  printUpdate(kind, obj.text);
                } else {
                  log(`SERVER(${kind}): ${JSON.stringify(obj)}`);
                }
              } else if (obj.type === 'status') {
                log(`STATUS: ${obj.stage} ${obj.detail ? JSON.stringify(obj.detail) : ''}`);
              } else if (obj.type === 'error') {
                log(`SERVER ERROR: ${obj.error}`, 'err');
              } else {
                log(`SERVER: ${ev.data}`);
              }
            } else {
              log(`SERVER: ${ev.data}`);
            }
          } catch {
            log(`SERVER: ${ev.data}`);
          }
        }
      };
    });

    mediaStream.getAudioTracks().forEach(tr => {
      tr.onended = () => { log('Audio track ended.'); stop(); };
    });

    bytesSentTotal = 0;
    bytesSentThisSec = 0;
    startStatsTimer();

    running = true;
    log(`Bắt đầu stream(${ $useMic.checked ? 'Mic mode' : 'Tab mode' })`, 'ok');
    if (!$useMic.checked) {
      log('bấm "Play test tone" để kiểm tra.', 'ok');
    }
  } catch (e) {
    log('❌ Start failed: ' + (e?.message || String(e)), 'err');
    await stop();
  }
}

async function stop() {
  try {
    stopStatsTimer();
    if (workletNode) { try { workletNode.disconnect(); } catch(e){} workletNode = null; }
    if (mediaSource) { try { mediaSource.disconnect(); } catch(e){} mediaSource = null; }
    if (audioCtx) { try { await audioCtx.close(); } catch(e){} audioCtx = null; }
    if (mediaStream) { try { mediaStream.getTracks().forEach(t => t.stop()); } catch(e){} mediaStream = null; }
    if (ws) { try { ws.close(); } catch(e){} ws = null; }
    updateMeter(0, 0);
    running = false;
    log('Đã dừng.', 'ok');
  } catch (e) {
    log('Lỗi dừng: ' + (e?.message || String(e)), 'err');
  }
}

$start.addEventListener('click', start);
$stop.addEventListener('click', stop);
$testToneBtn.addEventListener('click', playTestTone);

if (location.hash) {
  try {
    const url = decodeURIComponent(location.hash.slice(1));
    if (/^wss?:\/\//i.test(url)) $serverUrl.value = url;
  } catch {}
}

document.addEventListener('visibilitychange', async () => {
  if (audioCtx && audioCtx.state === 'suspended' && !document.hidden) {
    try { await audioCtx.resume(); log('AudioContext resumed'); } catch {}
  }
});
