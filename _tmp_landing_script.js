    (function(){
      const html = document.documentElement;
      const THEME_KEY = "vt_theme";
      const metaTheme = document.querySelector('meta[name="theme-color"]');

      const sunPath = 'M12 18a6 6 0 1 1 0-12a6 6 0 0 1 0 12Zm0-16a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm0 18a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1ZM3 11a1 1 0 0 1 1 1a1 1 0 1 1-1-1Zm18 0a1 1 0 0 1 1 1a1 1 0 1 1-1-1ZM5.05 5.05a1 1 0 0 1 1.41 0l.7.7A1 1 0 1 1 5.76 7.16l-.7-.7a1 1 0 0 1 0-1.41Zm12.49 12.49a1 1 0 0 1 1.41 0l.7.7a1 1 0 1 1-1.41 1.41l-.7-.7a1 1 0 0 1 0-1.41ZM18.95 5.05a1 1 0 0 1 0 1.41l-.7.7a1 1 0 0 1-1.41-1.41l.7-.7a1 1 0 0 1 1.41 0ZM7.16 16.84a1 1 0 0 1 0 1.41l-.7.7A1 1 0 1 1 5.05 18.95l.7-.7a1 1 0 0 1 1.41 0Z';
      const moonPath = 'M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z';

      const toggleBtn = document.getElementById("themeToggle");
      const iconSvg = document.getElementById("themeIcon");

      function setMetaTheme(theme){
        if (!metaTheme) return;
        metaTheme.setAttribute("content", theme === "light" ? "#ffffff" : "#07080a");
      }

      function renderIcon(theme){
        const path = iconSvg?.querySelector("path");
        if (!path) return;
        path.setAttribute("d", theme === "light" ? moonPath : sunPath);
      }

      function applyTheme(theme, persist){
        html.setAttribute("data-theme", theme);
        setMetaTheme(theme);
        renderIcon(theme);

        if (toggleBtn){
          toggleBtn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
          toggleBtn.setAttribute("aria-label", theme === "light" ? "Chuyá»ƒn sang giao diá»‡n tá»‘i" : "Chuyá»ƒn sang giao diá»‡n sÃ¡ng");
          toggleBtn.title = theme === "light" ? "Chuyá»ƒn sang tá»‘i" : "Chuyá»ƒn sang sÃ¡ng";
        }

        if (persist) {
          try { localStorage.setItem(THEME_KEY, theme); } catch {}
        }
      }

      function getInitialTheme(){
        try {
          const saved = localStorage.getItem(THEME_KEY);
          if (saved === "dark" || saved === "light") return saved;
        } catch {}
        const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
        return prefersLight ? "light" : "dark";
      }

      applyTheme(getInitialTheme(), false);

      toggleBtn?.addEventListener("click", () => {
        const current = html.getAttribute("data-theme") === "light" ? "light" : "dark";
        applyTheme(current === "light" ? "dark" : "light", true);
      });

      // Mobile menu
      const btn = document.getElementById("hamburger");
      const sheet = document.getElementById("mobileSheet");
      const closeSheet = () => {
        if (!sheet || !btn) return;
        sheet.style.display = "none";
        btn.setAttribute("aria-expanded","false");
      };
      const openSheet = () => {
        if (!sheet || !btn) return;
        sheet.style.display = "block";
        btn.setAttribute("aria-expanded","true");
      };
      btn?.addEventListener("click", () => {
        const isOpen = btn.getAttribute("aria-expanded") === "true";
        isOpen ? closeSheet() : openSheet();
      });
      sheet?.querySelectorAll("a").forEach(a => a.addEventListener("click", closeSheet));
      document.addEventListener("click", (e) => {
        if (!btn || !sheet) return;
        const isOpen = btn.getAttribute("aria-expanded") === "true";
        if (!isOpen) return;
        if (sheet.contains(e.target) || btn.contains(e.target)) return;
        closeSheet();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          closeSheet();
          closeTokenScreen();
        }
      });

      // Token screen
      const tokenScreen = document.getElementById("tokenScreen");
      const tokenCloseBtn = document.getElementById("tokenScreenClose");
      const tokenApiUrl = document.getElementById("tokenApiUrl");
      const tokenSttWsUrl = document.getElementById("tokenSttWsUrl");
      const tokenTrWsUrl = document.getElementById("tokenTrWsUrl");
      let tokenEndpointTimer = null;
      const METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];
      const LS_PUBLIC_BASE = "vt_public_base";

      function normalizeOriginCandidate(raw){
        const v = String(raw || "").trim();
        if (!v) return "";
        try {
          const withProto = v.includes("://") ? v : `https://${v}`;
          const u = new URL(withProto);
          let proto = u.protocol;
          if (proto === "ws:") proto = "http:";
          if (proto === "wss:") proto = "https:";
          if (proto !== "http:" && proto !== "https:") return "";
          return `${proto}//${u.host}`;
        } catch {
          return "";
        }
      }

      function toWsOrigin(httpOrigin){
        try {
          const u = new URL(String(httpOrigin || ""));
          const proto = u.protocol === "https:" ? "wss:" : "ws:";
          return `${proto}//${u.host}`;
        } catch {
          return "";
        }
      }

      async function probePublicOriginFromMetrics(){
        const metricBases = [];
        const sameOrigin = normalizeOriginCandidate(window.location.origin);
        if (sameOrigin) metricBases.push("");
        metricBases.push("http://127.0.0.1:8080", "http://localhost:8080");

        for (const port of METRICS_PORTS){
          for (const base of metricBases){
            try {
              const prefix = base ? `${base.replace(/\/+$/, "")}` : "";
              const res = await fetch(`${prefix}/__cloudflared_metrics/${port}/metrics?ts=${Date.now()}`, {
                cache: "no-store",
              });
              if (!res.ok) continue;
              const txt = await res.text();
              const m = txt.match(/cloudflared_tunnel_user_hostnames_counts\{[^}]*userHostname="([^"]+)"/i);
              if (!m || !m[1]) continue;
              const normalized = normalizeOriginCandidate(m[1]);
              if (normalized) return normalized;
            } catch {}
          }
        }
        return "";
      }

      async function resolvePublicOrigin(){
        const qs = new URLSearchParams(window.location.search);
        const explicitCandidates = [
          qs.get("public_base"),
          qs.get("public"),
          qs.get("base"),
          qs.get("origin"),
        ];
        for (const c of explicitCandidates){
          const n = normalizeOriginCandidate(c);
          if (n) return n;
        }

        const fromMetrics = await probePublicOriginFromMetrics();
        if (fromMetrics) {
          try { localStorage.setItem(LS_PUBLIC_BASE, fromMetrics); } catch {}
          return fromMetrics;
        }

        let cachedRaw = "";
        try { cachedRaw = localStorage.getItem(LS_PUBLIC_BASE) || ""; } catch {}
        const cached = normalizeOriginCandidate(cachedRaw);
        if (cached) return cached;

        return normalizeOriginCandidate(window.location.origin);
      }

      function setTokenEndpointTexts(api, stt, tr){
        if (tokenApiUrl) tokenApiUrl.textContent = api || "-";
        if (tokenSttWsUrl) tokenSttWsUrl.textContent = stt || "-";
        if (tokenTrWsUrl) tokenTrWsUrl.textContent = tr || "-";
      }

      async function updateTokenEndpoints(){
        const origin = await resolvePublicOrigin();
        if (!origin){
          setTokenEndpointTexts("-", "-", "-");
          return;
        }

        const originClean = origin.replace(/\/+$/, "");
        const wsOrigin = toWsOrigin(originClean);
        setTokenEndpointTexts(
          `${originClean}/docs`,
          wsOrigin ? `${wsOrigin}/stt` : "-",
          wsOrigin ? `${wsOrigin}/tr` : "-"
        );
      }

      async function copyTokenTarget(targetId, btn){
        const el = document.getElementById(targetId);
        const value = String(el?.textContent || "").trim();
        if (!value || value === "-") return;
        const old = btn ? btn.textContent : "";
        const okText = "ÄÃ£ copy";
        try {
          await navigator.clipboard.writeText(value);
          if (btn) {
            btn.textContent = okText;
            setTimeout(() => { btn.textContent = old; }, 1100);
          }
        } catch {
          if (btn) {
            btn.textContent = "Lá»—i copy";
            setTimeout(() => { btn.textContent = old; }, 1100);
          }
        }
      }

      function closeTokenScreen(){
        if (!tokenScreen) return;
        tokenScreen.classList.remove("open");
        tokenScreen.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
        if (tokenEndpointTimer) {
          clearInterval(tokenEndpointTimer);
          tokenEndpointTimer = null;
        }
      }
      function openTokenScreen(){
        if (!tokenScreen) return;
        tokenScreen.classList.add("open");
        tokenScreen.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
        updateTokenEndpoints().catch(() => {});
        if (tokenEndpointTimer) clearInterval(tokenEndpointTimer);
        tokenEndpointTimer = setInterval(() => {
          updateTokenEndpoints().catch(() => {});
        }, 3000);
      }

      document.querySelectorAll('[data-open-token-screen="1"]').forEach((el) => {
        el.addEventListener("click", (e) => {
          e.preventDefault();
          closeSheet();
          openTokenScreen();
        });
      });

      tokenCloseBtn?.addEventListener("click", closeTokenScreen);
      tokenScreen?.addEventListener("click", (e) => {
        const target = e.target;
        if (target && target.matches('[data-token-close="1"]')) {
          closeTokenScreen();
        }
      });
      document.querySelectorAll("[data-copy-target]").forEach((btn) => {
        btn.addEventListener("click", () => {
          copyTokenTarget(btn.getAttribute("data-copy-target"), btn);
        });
      });
      window.addEventListener("focus", () => {
        updateTokenEndpoints().catch(() => {});
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) updateTokenEndpoints().catch(() => {});
      });

      // Smooth scroll
      document.querySelectorAll('a[href^="#"]').forEach(a => {
        a.addEventListener("click", (e) => {
          const id = a.getAttribute("href");
          if (!id || id === "#") return;
          const el = document.querySelector(id);
          if (!el) return;
          e.preventDefault();
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });

      // FAQ accordion (auto height, no cut)
      function closeAllQA(){
        document.querySelectorAll(".qa.open").forEach(x => {
          x.classList.remove("open");
          const ans = x.querySelector(".ans");
          if (ans) ans.style.maxHeight = "0px";
        });
      }
      document.querySelectorAll(".qa .qBtn").forEach(b => {
        b.addEventListener("click", () => {
          const qa = b.closest(".qa");
          if (!qa) return;

          const ans = qa.querySelector(".ans");
          const inner = qa.querySelector(".ansInner");
          const isOpen = qa.classList.contains("open");

          closeAllQA();
          if (!isOpen){
            qa.classList.add("open");
            if (ans && inner){
              ans.style.maxHeight = inner.scrollHeight + "px";
            }
          }
        });
      });

      // Scroll reveal
      const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!prefersReduced && "IntersectionObserver" in window){
        const io = new IntersectionObserver((entries) => {
          entries.forEach(en => {
            if (en.isIntersecting){
              en.target.classList.add("in");
              io.unobserve(en.target);
            }
          });
        }, { threshold: 0.12 });

        document.querySelectorAll(".reveal").forEach(el => io.observe(el));
      } else {
        document.querySelectorAll(".reveal").forEach(el => el.classList.add("in"));
      }
    })();
