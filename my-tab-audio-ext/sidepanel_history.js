// History view controller for sidepanel: list/search/detail/download/delete transcript sessions.
(() => {
  const SYSTEM_BUSY_TEXT = "Hệ thống đang bận, vui lòng thử lại sau.";
  const hasChromeRuntime =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === "function";

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
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
      return u.hostname || "Trang web không xác định";
    } catch {
      return "Trang web không xác định";
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

  function showBusyPopup() {
    try {
      if (typeof window.__vtShowBusyModal === "function") {
        window.__vtShowBusyModal(SYSTEM_BUSY_TEXT);
      }
    } catch {}
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
      deletePendingId: null,
      deletingIds: new Set(),
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
      deleteModal: null,
      deleteModalClose: null,
      deleteMeta: null,
      deleteText: null,
      deleteCancelBtn: null,
      deleteConfirmBtn: null,
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

      refs.deleteModal = document.getElementById("historyDeleteModal");
      refs.deleteModalClose = document.getElementById("historyDeleteClose");
      refs.deleteMeta = document.getElementById("historyDeleteMeta");
      refs.deleteText = document.getElementById("historyDeleteText");
      refs.deleteCancelBtn = document.getElementById("historyDeleteCancelBtn");
      refs.deleteConfirmBtn = document.getElementById("historyDeleteConfirmBtn");
    }

    function isModalVisible(el) {
      return !!(el && !el.classList.contains("hidden"));
    }

    function syncModalBodyLock() {
      const anyOpen = isModalVisible(refs.modal) || isModalVisible(refs.deleteModal);
      document.body.classList.toggle("history-modal-open", anyOpen);
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
        const noQuery = String(refs.search?.value || "").trim().length === 0;
        if (!state.items.length && noQuery) {
          setEmpty("Chưa có dữ liệu lịch sử.", true);
        } else {
          setEmpty("Không tìm thấy lịch sử phù hợp.", true);
        }
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
        const deleting = state.deletingIds.has(id);

        const card = document.createElement("div");
        card.className = "history-item" + (deleting ? " history-item-deleting" : "");
        card.dataset.sessionId = String(id);
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("aria-label", `Mở chi tiết bản ghi ${domain}`);
        card.innerHTML = `
          <div class="history-item-top">
            <span class="history-item-domain">${escapeHtml(domain)}</span>
            <div class="history-item-right">
              <span class="history-item-time">${escapeHtml(started)}</span>
              <button
                type="button"
                class="history-item-delete-btn"
                data-history-delete="1"
                data-session-id="${id}"
                aria-label="Xóa bản ghi này"
                ${deleting ? "disabled" : ""}
              >${deleting ? "Đang xóa..." : "Xóa"}</button>
            </div>
          </div>
          <div class="history-item-meta">
            <span>Tổng thời gian: ${escapeHtml(duration)}</span>
            <span>Trạng thái: ${escapeHtml(status)}</span>
          </div>
          <p class="history-item-preview">${escapeHtml(preview)}</p>
        `;
        frag.appendChild(card);
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
        await Promise.all(
          targets.map(async (item) => {
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
          })
        );
      } finally {
        state.prefetching = false;
        applyFilter();
        renderList();
      }
    }

    function isViewVisible() {
      return !!(refs.view && !refs.view.classList.contains("hidden"));
    }

    function removeSessionLocal(sessionId) {
      const sid = Number(sessionId || 0);
      if (!sid) return;

      state.items = state.items.filter((x) => Number(x?.id || 0) !== sid);
      state.filtered = state.filtered.filter((x) => Number(x?.id || 0) !== sid);
      state.details.delete(sid);
      state.previewHydratedIds.delete(sid);
      state.deletingIds.delete(sid);

      if (state.activeDetailId === sid) closeModal();
      if (state.deletePendingId === sid) closeDeleteModal();
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
          setEmpty(SYSTEM_BUSY_TEXT, true);
          if (refs.userNote) refs.userNote.textContent = "";
          showBusyPopup();
          state.loaded = true;
          return;
        }

        if (!res?.ok) {
          throw new Error(SYSTEM_BUSY_TEXT);
        }

        const rows = Array.isArray(res.items) ? res.items.slice() : [];
        state.items = sortSessionsDesc(rows);
        state.loaded = true;
        applyFilter();
        renderList();
        prefetchMissingPreviews();
      } catch (e) {
        state.items = [];
        state.filtered = [];
        renderList();
        setEmpty(SYSTEM_BUSY_TEXT, true);
        showBusyPopup();
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
      syncModalBodyLock();
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
      syncModalBodyLock();
    }

    function openDeleteModal(sessionId) {
      const sid = Number(sessionId || 0);
      if (!sid || !refs.deleteModal) return;

      const item = state.items.find((x) => Number(x?.id || 0) === sid);
      if (!item) return;

      state.deletePendingId = sid;
      if (refs.deleteMeta) {
        refs.deleteMeta.textContent = `${domainFrom(item)} • Bắt đầu: ${formatDateTime(item?.started_at)}`;
      }
      if (refs.deleteText) {
        refs.deleteText.textContent =
          "Bạn có chắc chắn muốn xóa bản ghi này không? Hành động này không thể hoàn tác.";
      }
      if (refs.deleteConfirmBtn) {
        refs.deleteConfirmBtn.disabled = false;
        refs.deleteConfirmBtn.textContent = "Xóa";
      }

      refs.deleteModal.classList.remove("hidden");
      syncModalBodyLock();
    }

    function closeDeleteModal() {
      if (!refs.deleteModal) return;
      refs.deleteModal.classList.add("hidden");
      state.deletePendingId = null;
      if (refs.deleteConfirmBtn) {
        refs.deleteConfirmBtn.disabled = false;
        refs.deleteConfirmBtn.textContent = "Xóa";
      }
      syncModalBodyLock();
    }

    async function deleteSessionOnServer(sessionId) {
      const sid = Number(sessionId || 0);
      if (!sid) throw new Error("INVALID_SESSION_ID");

      const res = await sendRuntime({
        __cmd: "__HISTORY_DELETE__",
        payload: { sessionId: sid },
      });

      if (res?.code === "AUTH_REQUIRED") {
        if (typeof state.openAuthOverlay === "function") state.openAuthOverlay();
        throw new Error("Bạn cần đăng nhập để xóa lịch sử.");
      }

      if (res?.code === "USER_ID_INVALID") {
        throw new Error(SYSTEM_BUSY_TEXT);
      }

      if (res?.code === "NOT_FOUND") {
        return { ok: true, notFound: true };
      }

      if (!res?.ok) {
        throw new Error(SYSTEM_BUSY_TEXT);
      }

      return { ok: true, notFound: false };
    }

    async function confirmDeletePending() {
      const sid = Number(state.deletePendingId || 0);
      if (!sid) return;
      if (state.deletingIds.has(sid)) return;

      state.deletingIds.add(sid);
      if (refs.deleteConfirmBtn) {
        refs.deleteConfirmBtn.disabled = true;
        refs.deleteConfirmBtn.textContent = "Đang xóa...";
      }
      renderList();

      try {
        await deleteSessionOnServer(sid);
        removeSessionLocal(sid);
        applyFilter();
        renderList();
        closeDeleteModal();
      } catch (e) {
        state.deletingIds.delete(sid);
        renderList();
        if (refs.deleteText) {
          refs.deleteText.textContent = `Xóa thất bại: ${SYSTEM_BUSY_TEXT}`;
        }
        if (refs.deleteConfirmBtn) {
          refs.deleteConfirmBtn.disabled = false;
          refs.deleteConfirmBtn.textContent = "Thử xóa lại";
        }
        showBusyPopup();
      }
    }

    async function openSessionDetail(sessionId) {
      const sid = Number(sessionId || 0);
      if (!sid) return;
      if (state.deletingIds.has(sid)) return;

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
        fillModalText(baseItem, SYSTEM_BUSY_TEXT);
        if (refs.modalDownload) refs.modalDownload.disabled = true;
        showBusyPopup();
        return;
      }

      if (!res?.ok) {
        fillModalText(baseItem, SYSTEM_BUSY_TEXT);
        if (refs.modalDownload) refs.modalDownload.disabled = true;
        showBusyPopup();
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
          const deleteBtn = e.target?.closest?.("[data-history-delete='1']");
          if (deleteBtn) {
            const sid = Number(deleteBtn.dataset.sessionId || 0);
            if (!sid) return;
            openDeleteModal(sid);
            return;
          }

          const row = e.target?.closest?.(".history-item");
          if (!row) return;
          const sid = Number(row.dataset.sessionId || 0);
          if (!sid) return;
          openSessionDetail(sid);
        });

        refs.list.addEventListener("keydown", (e) => {
          if (e.target?.closest?.("[data-history-delete='1']")) return;
          const row = e.target?.closest?.(".history-item");
          if (!row) return;
          const sid = Number(row.dataset.sessionId || 0);
          if (!sid) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openSessionDetail(sid);
          }
        });
      }

      if (refs.modal) {
        refs.modal.addEventListener("click", (e) => {
          const tgt = e.target;
          if (tgt && tgt.dataset?.historyClose === "1") closeModal();
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

      if (refs.deleteModal) {
        refs.deleteModal.addEventListener("click", (e) => {
          const tgt = e.target;
          if (tgt && tgt.dataset?.historyDeleteClose === "1") closeDeleteModal();
        });
      }

      if (refs.deleteModalClose) refs.deleteModalClose.addEventListener("click", closeDeleteModal);
      if (refs.deleteCancelBtn) refs.deleteCancelBtn.addEventListener("click", closeDeleteModal);
      if (refs.deleteConfirmBtn) refs.deleteConfirmBtn.addEventListener("click", confirmDeletePending);

      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (isModalVisible(refs.deleteModal)) {
          closeDeleteModal();
          return;
        }
        if (isModalVisible(refs.modal)) closeModal();
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
      state.deletePendingId = null;
      state.deletingIds.clear();
      if (refs.userNote) refs.userNote.textContent = "";
      closeDeleteModal();
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
