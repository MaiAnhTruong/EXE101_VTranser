// History view controller for sidepanel: list/search/detail/download transcript sessions.
(() => {
  const hasChromeRuntime =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === "function";

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[m]));

  const pad2 = (n) => (n < 10 ? "0" + n : "" + n);

  function toDateOrNull(v) {
    const t = Date.parse(String(v || ""));
    return Number.isFinite(t) ? new Date(t) : null;
  }

  function formatDateTime(v) {
    const d = toDateOrNull(v);
    if (!d) return "N/A";
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function formatDurationMs(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function domainFrom(item) {
    const d = String(item?.tab_domain || "").trim();
    if (d) return d;
    try {
      const u = new URL(String(item?.tab_url || ""));
      return u.hostname || "Unknown website";
    } catch {
      return "Unknown website";
    }
  }

  function statusLabel(raw) {
    const s = String(raw || "").toLowerCase();
    if (s === "running") return "Đang chạy";
    if (s === "stopped") return "Đã dừng";
    if (!s) return "N/A";
    return s;
  }

  function hasTextValue(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  function pickTranscriptText(item, detailText = "") {
    const cands = [
      detailText,
      item?.preview_text,
      item?.latest_text_en,
      item?.latest_text_vi,
      item?.latest_text,
      item?.text_en,
      item?.text_vi,
      item?.text,
    ];
    for (const c of cands) {
      if (hasTextValue(c)) return String(c);
    }
    return "";
  }

  function normalizeTextPreview(s, maxLen = 180) {
    const clean = String(s || "").replace(/\s+/g, " ").trim();
    if (!clean) return "Đang cập nhật transcript...";
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, maxLen - 3) + "...";
  }

  function sortSessionsDesc(rows) {
    const ts = (r) => {
      const t = Date.parse(String(r?.started_at || r?.last_updated_at || ""));
      return Number.isFinite(t) ? t : 0;
    };
    return rows.sort((a, b) => ts(b) - ts(a) || (Number(b?.id || 0) - Number(a?.id || 0)));
  }

  function sanitizeFilenamePart(s) {
    return String(s || "")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "transcript";
  }

  function buildDownloadText(item, fullText) {
    const started = formatDateTime(item?.started_at);
    const ended = formatDateTime(item?.ended_at || item?.last_updated_at || "");
    const durationMs = calcDurationMs(item);
    const parts = [
      `Website: ${String(item?.tab_url || domainFrom(item))}`,
      `Bắt đầu: ${started}`,
      `Kết thúc: ${ended}`,
      `Tổng thời gian: ${formatDurationMs(durationMs)}`,
      "",
      "===== Transcript =====",
      String(fullText || "").trim(),
      "",
    ];
    return parts.join("\n");
  }

  function downloadTxt(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  }

  function sendRuntime(msg) {
    return new Promise((resolve) => {
      if (!hasChromeRuntime) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(res || null));
      } catch {
        resolve(null);
      }
    });
  }

  function formatUserIdDebug(debug) {
    if (!debug || typeof debug !== "object") return "";
    const parts = [];
    const email = String(debug.email || "").trim();
    const provider = String(debug.provider || "").trim();
    const id = String(debug.id || "").trim();
    const userId = String(debug.user_id || "").trim();
    const dbUserId = String(debug.db_user_id || "").trim();
    if (email) parts.push(`email=${email}`);
    if (provider) parts.push(`provider=${provider}`);
    if (id) parts.push(`id=${id}`);
    if (userId) parts.push(`user_id=${userId}`);
    if (dbUserId) parts.push(`db_user_id=${dbUserId}`);
    return parts.join(" | ");
  }

  function calcDurationMs(item) {
    const startMs = Date.parse(String(item?.started_at || ""));
    if (!Number.isFinite(startMs)) return 0;
    const endRaw = item?.ended_at || item?.last_updated_at || new Date().toISOString();
    const endMs = Date.parse(String(endRaw || ""));
    if (!Number.isFinite(endMs)) return 0;
    return Math.max(0, endMs - startMs);
  }

  function createController() {
    const state = {
      inited: false,
      loading: false,
      prefetching: false,
      loaded: false,
      items: [],
      filtered: [],
      details: new Map(), // sessionId -> { item, fullText }
      previewHydratedIds: new Set(),
      openAuthOverlay: null,
      activeDetailId: null,
    };

    const refs = {
      view: null,
      search: null,
      refreshBtn: null,
      list: null,
      empty: null,
      loading: null,
      userNote: null,
      modal: null,
      modalClose: null,
      modalTitle: null,
      modalMeta: null,
      modalText: null,
      modalDownload: null,
    };

    function bindRefs() {
      refs.view = document.getElementById("history-content");
      refs.search = document.getElementById("historySearchInput");
      refs.refreshBtn = document.getElementById("historyRefreshBtn");
      refs.list = document.getElementById("historyList");
      refs.empty = document.getElementById("historyEmpty");
      refs.loading = document.getElementById("historyLoading");
      refs.userNote = document.getElementById("historyUserIdNote");
      refs.modal = document.getElementById("historyDetailModal");
      refs.modalClose = document.getElementById("historyDetailClose");
      refs.modalTitle = document.getElementById("historyDetailTitle");
      refs.modalMeta = document.getElementById("historyDetailMeta");
      refs.modalText = document.getElementById("historyDetailContent");
      refs.modalDownload = document.getElementById("historyDownloadBtn");
    }

    function setLoading(on) {
      state.loading = !!on;
      if (refs.loading) refs.loading.classList.toggle("hidden", !on);
    }

    function setEmpty(text, show) {
      if (!refs.empty) return;
      refs.empty.textContent = String(text || "Không có dữ liệu.");
      refs.empty.classList.toggle("hidden", !show);
    }

    function applyFilter() {
      const q = String(refs.search?.value || "").trim().toLowerCase();
      if (!q) {
        state.filtered = state.items.slice();
        return;
      }
      state.filtered = state.items.filter((it) => {
        const hay = [
          String(it?.tab_domain || ""),
          String(it?.tab_url || ""),
          pickTranscriptText(it, state.details.get(Number(it?.id || 0))?.fullText || ""),
          String(it?.status || ""),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    function renderList() {
      if (!refs.list) return;
      refs.list.innerHTML = "";

      if (!state.filtered.length) {
        setEmpty("Không tìm thấy lịch sử phù hợp.", true);
        return;
      }
      setEmpty("", false);

      const frag = document.createDocumentFragment();
      for (const item of state.filtered) {
        const id = Number(item?.id || 0);
        if (!id) continue;

        const domain = domainFrom(item);
        const started = formatDateTime(item?.started_at);
        const duration = formatDurationMs(calcDurationMs(item));
        const status = statusLabel(item?.status);
        const detail = state.details.get(id);
        const preview = normalizeTextPreview(
          pickTranscriptText(item, detail?.fullText || "")
        );

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "history-item";
        btn.dataset.sessionId = String(id);
        btn.innerHTML = `
          <div class="history-item-top">
            <span class="history-item-domain">${escapeHtml(domain)}</span>
            <span class="history-item-time">${escapeHtml(started)}</span>
          </div>
          <div class="history-item-meta">
            <span>Tổng thời gian: ${escapeHtml(duration)}</span>
            <span>Trạng thái: ${escapeHtml(status)}</span>
          </div>
          <p class="history-item-preview">${escapeHtml(preview)}</p>
        `;
        frag.appendChild(btn);
      }

      refs.list.appendChild(frag);
    }

    async function prefetchMissingPreviews() {
      if (!hasChromeRuntime || state.prefetching) return;
      const targets = state.items
      .filter((item) => {
        const sid = Number(item?.id || 0);
        if (!sid) return false;
        if (state.previewHydratedIds.has(sid)) return false;
        return !hasTextValue(pickTranscriptText(item));
      })
      .slice(0, 48);
      if (!targets.length) return;

      state.prefetching = true;
      try {
        await Promise.all(targets.map(async (item) => {
          const sid = Number(item?.id || 0);
          if (!sid) return;

          const cached = state.details.get(sid);
          if (cached?.fullText) {
            item.latest_text_en = cached.fullText;
            state.previewHydratedIds.add(sid);
            return;
          }

          const res = await sendRuntime({
            __cmd: "__HISTORY_DETAIL__",
            payload: { sessionId: sid },
          });
          if (res?.ok) {
            const dItem = res.item || item;
            const fullText = String(res.fullText || pickTranscriptText(dItem) || "");
            state.details.set(sid, { item: dItem, fullText });
            if (hasTextValue(fullText)) item.latest_text_en = fullText;
          }
          state.previewHydratedIds.add(sid);
        }));
      } finally {
        state.prefetching = false;
        applyFilter();
        renderList();
      }
    }

    function isViewVisible() {
      return !!(refs.view && !refs.view.classList.contains("hidden"));
    }

    async function loadList(force = false) {
      if (!hasChromeRuntime || state.loading) return;
      if (state.loaded && !force) return;
      if (force) {
        state.details.clear();
        state.previewHydratedIds.clear();
      }

      setLoading(true);
      setEmpty("", false);
      try {
        const res = await sendRuntime({
          __cmd: "__HISTORY_LIST__",
          payload: { limit: 300, offset: 0 },
        });

        if (res?.code === "AUTH_REQUIRED") {
          state.items = [];
          state.filtered = [];
          renderList();
          setEmpty("Bạn cần đăng nhập để xem lịch sử.", true);
          if (refs.userNote) refs.userNote.textContent = "";
          if (typeof state.openAuthOverlay === "function") state.openAuthOverlay();
          state.loaded = true;
          return;
        }
        if (res?.code === "USER_ID_INVALID") {
          state.items = [];
          state.filtered = [];
          renderList();
          const dbg = formatUserIdDebug(res?.debug);
          setEmpty(
            dbg
              ? "Khong tim thay user id hop le cho tai khoan hien tai.\n[debug] " + dbg
              : "Khong tim thay user id hop le cho tai khoan hien tai.",
            true
          );
          if (refs.userNote) refs.userNote.textContent = "User ID: (khong xac dinh)";
          state.loaded = true;
          return;
        }

        if (!res?.ok) {
          throw new Error(String(res?.error || "HISTORY_LIST_FAILED"));
        }

        const rows = Array.isArray(res.items) ? res.items.slice() : [];
        state.items = sortSessionsDesc(rows);
        if (refs.userNote) {
          const uid = Number(res.userId || 0);
        }
        state.loaded = true;
        applyFilter();
        renderList();
        prefetchMissingPreviews();
        if (!state.items.length) {
          setEmpty("Chưa có transcript nào được lưu.", true);
        }
      } catch (e) {
        state.items = [];
        state.filtered = [];
        renderList();
        setEmpty(`Không tải được lịch sử: ${String(e?.message || e)}`, true);
      } finally {
        setLoading(false);
      }
    }

    function openModalSkeleton(item) {
      if (!refs.modal) return;
      refs.modal.classList.remove("hidden");
      refs.modalTitle.textContent = domainFrom(item);
      refs.modalMeta.textContent = `Bắt đầu: ${formatDateTime(item?.started_at)} • Tổng thời gian: ${formatDurationMs(calcDurationMs(item))}`;
      refs.modalText.textContent = "Đang tải nội dung transcript...";
      if (refs.modalDownload) refs.modalDownload.disabled = true;
      state.activeDetailId = Number(item?.id || 0) || null;
      document.body.classList.add("history-modal-open");
    }

    function fillModalText(item, fullText) {
      if (!refs.modal) return;
      refs.modalTitle.textContent = domainFrom(item);
      refs.modalMeta.textContent =
        `Website: ${item?.tab_url || domainFrom(item)} • Bắt đầu: ${formatDateTime(item?.started_at)} • Tổng thời gian: ${formatDurationMs(calcDurationMs(item))}`;
      refs.modalText.textContent = String(fullText || "Đang cập nhật transcript...");
      if (refs.modalDownload) refs.modalDownload.disabled = false;
    }

    function closeModal() {
      if (!refs.modal) return;
      refs.modal.classList.add("hidden");
      state.activeDetailId = null;
      document.body.classList.remove("history-modal-open");
    }

    async function openSessionDetail(sessionId) {
      const sid = Number(sessionId || 0);
      if (!sid) return;
      const baseItem = state.items.find((x) => Number(x?.id || 0) === sid);
      if (!baseItem) return;

      openModalSkeleton(baseItem);

      const cached = state.details.get(sid);
      if (cached) {
        if (hasTextValue(cached.fullText)) baseItem.latest_text_en = cached.fullText;
        fillModalText(cached.item, cached.fullText);
        return;
      }

      const res = await sendRuntime({
        __cmd: "__HISTORY_DETAIL__",
        payload: { sessionId: sid },
      });

      if (res?.code === "AUTH_REQUIRED") {
        closeModal();
        if (typeof state.openAuthOverlay === "function") state.openAuthOverlay();
        return;
      }
      if (res?.code === "USER_ID_INVALID") {
        const dbg = formatUserIdDebug(res?.debug);
        fillModalText(
          baseItem,
          dbg
            ? "Khong tim thay user id hop le cho tai khoan hien tai.\n\n[debug] " + dbg
            : "Khong tim thay user id hop le cho tai khoan hien tai."
        );
        if (refs.modalDownload) refs.modalDownload.disabled = true;
        return;
      }

      if (!res?.ok) {
        fillModalText(baseItem, `Không tải được nội dung transcript: ${String(res?.error || "DETAIL_FAILED")}`);
        if (refs.modalDownload) refs.modalDownload.disabled = true;
        return;
      }

      const item = res.item || baseItem;
      const fullText = String(res.fullText || pickTranscriptText(item) || "");
      if (hasTextValue(fullText)) baseItem.latest_text_en = fullText;
      state.details.set(sid, { item, fullText });
      fillModalText(item, fullText);
    }

    function bindEvents() {
      if (refs.search) {
        refs.search.addEventListener("input", () => {
          applyFilter();
          renderList();
        });
      }

      if (refs.refreshBtn) {
        refs.refreshBtn.addEventListener("click", () => {
          loadList(true);
        });
      }

      if (refs.list) {
        refs.list.addEventListener("click", (e) => {
          const btn = e.target?.closest?.(".history-item");
          if (!btn) return;
          const sid = Number(btn.dataset.sessionId || 0);
          if (!sid) return;
          openSessionDetail(sid);
        });
      }

      if (refs.modal) {
        refs.modal.addEventListener("click", (e) => {
          const tgt = e.target;
          if (tgt && (tgt.dataset?.historyClose === "1")) closeModal();
        });
      }

      if (refs.modalClose) refs.modalClose.addEventListener("click", closeModal);

      if (refs.modalDownload) {
        refs.modalDownload.addEventListener("click", () => {
          const sid = state.activeDetailId;
          if (!sid) return;
          const d = state.details.get(sid);
          if (!d) return;

          const when = toDateOrNull(d.item?.started_at) || new Date();
          const stamp = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}_${pad2(when.getHours())}-${pad2(when.getMinutes())}-${pad2(when.getSeconds())}`;
          const domain = sanitizeFilenamePart(domainFrom(d.item));
          const filename = `${domain}_${stamp}.txt`;
          const content = buildDownloadText(d.item, d.fullText);
          downloadTxt(filename, content);
        });
      }

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && refs.modal && !refs.modal.classList.contains("hidden")) {
          closeModal();
        }
      });
    }

    function init(opts = {}) {
      if (state.inited) return;
      bindRefs();
      bindEvents();
      state.openAuthOverlay = typeof opts.openAuthOverlay === "function" ? opts.openAuthOverlay : null;
      state.inited = true;
    }

    function onViewShown() {
      if (!state.inited) return;
      loadList(false);
    }

    function onAuthChanged() {
      if (!state.inited) return;
      state.loaded = false;
      state.items = [];
      state.filtered = [];
      state.details.clear();
      state.previewHydratedIds.clear();
      if (refs.userNote) refs.userNote.textContent = "";
      closeModal();
      applyFilter();
      renderList();
      if (isViewVisible()) loadList(true);
    }

    return {
      init,
      onViewShown,
      onAuthChanged,
      refresh: () => loadList(true),
    };
  }

  window.__vtHistoryView = createController();
})();
