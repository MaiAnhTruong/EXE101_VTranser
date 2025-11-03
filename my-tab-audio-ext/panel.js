//home/truong/EXE/my-tab-audio-ext/panel.js:
(() => {
  const ROOT_ID = 'stt-sidepanel-root';
  if (window.__stt_panel_injected__) return;
  window.__stt_panel_injected__ = true;

  function mount() {
    if (document.getElementById(ROOT_ID)) return;

    // đánh dấu mở panel & set biến cho overlay canh giữa phần 3/4
    document.documentElement.classList.add('stt-panel-open');

    const root = document.createElement('div');
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
          <input id="stt-sp-server" type="text" placeholder="ws://localhost:8765" />
          <div class="stt-btn green" id="btn-start">Bắt đầu</div>
        </div>
        <div class="stt-btn red" id="btn-stop">Dừng</div>
      </div>
    `;
    document.body.appendChild(root);

    // fill URL
    root.querySelector('#stt-sp-url').textContent = location.href;

    // restore server
    const $server = root.querySelector('#stt-sp-server');
    $server.value = localStorage.getItem('sttServerWs') || 'ws://localhost:8765';

    // button wiring
    root.querySelector('#stt-sp-close').onclick = () => teardown();
    root.querySelector('#btn-start').onclick = async () => {
      const server = $server.value.trim();
      localStorage.setItem('sttServerWs', server);
      chrome.runtime.sendMessage({ __cmd: '__PANEL_START__', payload: { server } });
    };
    root.querySelector('#btn-stop').onclick = async () => {
      chrome.runtime.sendMessage({ __cmd: '__PANEL_STOP__' });
    };

    // status text
    const $sub = root.querySelector('#stt-sp-sub');
    function setActive(on) { $sub.textContent = on ? '• Đang ghi' : ''; }

    // transcript rendering (đơn giản, tạo dòng khi có stable; delta chỉ thể hiện ở overlay)
    const $log = root.querySelector('#stt-log');
    let lastStable = '';

    function addRow(timeStr, text, meta = '') {
      const row = document.createElement('div');
      row.className = 'stt-row';
      row.innerHTML = `
        <div class="stt-t">${timeStr}</div>
        <div>
          <div class="stt-text">${text}</div>
          ${meta ? `<div class="stt-meta">${meta}</div>` : ``}
        </div>
      `;
      $log.appendChild(row);
      $log.parentElement?.scrollTo({ top: $log.parentElement.scrollHeight, behavior: 'smooth' });
    }

    // tách câu để thêm mục giống ảnh
    function sentencesDiff(prev, now) {
      const seg = (s)=> (s||'').match(/[^.!?…]*[.!?…]+(?:["”’']+)?|\S[\s\S]*$/g) || [];
      const a = seg(prev).join('');
      const b = seg(now).join('');
      if (b.startsWith(a)) {
        const tail = now.slice(a.length);
        const newSents = seg(tail).filter(x => /[.!?…]|\n$/.test(x) || x.length > 20);
        return newSents;
      }
      return [now]; // fallback
    }

    // message hub (panel cũng nhận transcript như overlay)
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || !m.__cmd) return;

      if (m.__cmd === '__PANEL_OPENED__') {
        setActive(!!m.payload?.active);
        if (m.payload?.server) $server.value = m.payload.server;
      }

      if (m.__cmd === '__OFFSCREEN_STATUS__') {
        // có thể render RMS/queue ở đây nếu cần
      }

      if (m.__cmd === '__TRANSCRIPT_STABLE__') {
        const full = String(m.payload?.full ?? m.full ?? '');
        if (full && full.length >= lastStable.length) {
          const news = sentencesDiff(lastStable, full);
          const now = new Date();
          news.forEach(s => addRow(now.toLocaleTimeString(), s.trim(), 'Speaker • en • live'));
          lastStable = full;
          setActive(true);
        }
      }

      if (m.__cmd === '__TRANSCRIPT_DELTA__') {
        // delta để overlay xử lý overlap; panel không cần
      }
    });

    // ping SW để sync state lần đầu
    chrome.runtime.sendMessage({ __cmd: '__OVERLAY_PING__' }, (res) => {
      setActive(!!(res && res.active));
    });
  }

  function teardown() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.remove();
    document.documentElement.classList.remove('stt-panel-open');
  }

  // Commands from SW
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.__cmd) return;
    if (msg.__cmd === '__PANEL_MOUNT__') mount();
    if (msg.__cmd === '__PANEL_TEARDOWN__') teardown();
  });

  // Auto-mount when injected
  mount();
})();