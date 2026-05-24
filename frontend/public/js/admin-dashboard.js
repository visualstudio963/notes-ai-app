(function () {
  const ACTIVE_LABEL = "Online";

  /** @type {null | { staffRole?: string; staffRank?: number; capabilities?: Record<string, boolean> }} */
  let caps = null;
  let messagesCache = [];
  let messagesFilterTimer = null;
  let selectedUserId = "";
  let giftCoinsInFlight = false;
  let discordConfigCache = {
    discordInviteUrl: "",
    discordUpdatesCount: 0,
    tiktokUrl: "",
    youtubeUrl: "",
    supportEmail: ""
  };

  function normalizeCommunityUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
  }

  /** Hydrate inputs + cache from GET/PUT payloads (includes tiktok & youtube). */
  function applyDiscordConfigToInputs(data) {
    if (!data || typeof data !== "object") return;
    const prev = discordConfigCache;
    const own = Object.prototype.hasOwnProperty;
    const supportEmailFieldEl = document.getElementById("adminSupportEmail");
    const supportEmailTypedFallback = supportEmailFieldEl ? String(supportEmailFieldEl.value || "").trim() : "";
    discordConfigCache = {
      discordInviteUrl: own.call(data, "discordInviteUrl")
        ? String(data.discordInviteUrl != null ? data.discordInviteUrl : "").trim()
        : String(prev.discordInviteUrl || "").trim(),
      discordUpdatesCount: own.call(data, "discordUpdatesCount")
        ? Math.max(0, Number(data.discordUpdatesCount || 0))
        : Math.max(0, Number(prev.discordUpdatesCount || 0)),
      tiktokUrl: own.call(data, "tiktokUrl")
        ? String(data.tiktokUrl != null ? data.tiktokUrl : "").trim()
        : String(prev.tiktokUrl || "").trim(),
      youtubeUrl: own.call(data, "youtubeUrl")
        ? String(data.youtubeUrl != null ? data.youtubeUrl : "").trim()
        : String(prev.youtubeUrl || "").trim(),
      supportEmail: own.call(data, "supportEmail")
        ? String(data.supportEmail != null ? data.supportEmail : "").trim()
        : supportEmailTypedFallback || String(prev.supportEmail || "").trim()
    };
    const urlInput = document.getElementById("adminDiscordInviteUrl");
    if (urlInput) urlInput.value = discordConfigCache.discordInviteUrl;
    const countInput = document.getElementById("adminDiscordUpdatesCount");
    if (countInput) countInput.value = String(discordConfigCache.discordUpdatesCount || 0);
    const tiktokInput = document.getElementById("adminTiktokUrl");
    if (tiktokInput) tiktokInput.value = discordConfigCache.tiktokUrl;
    const youtubeInput = document.getElementById("adminYoutubeUrl");
    if (youtubeInput) youtubeInput.value = discordConfigCache.youtubeUrl;
    const supportEmailInput = document.getElementById("adminSupportEmail");
    if (supportEmailInput) supportEmailInput.value = discordConfigCache.supportEmail;
  }

  /** @type {Map<string, object>} */
  const usersByIdCache = new Map();

  let usersFetchGen = 0;
  const usersState = {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
    search: "",
    tier: "all"
  };

  let usersSearchTimer = null;
  let subsFetchGen = 0;
  let subsRefreshTimer = null;
  let subsListFingerprint = "";
  const subsState = {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1
  };
  let lastDashboardFingerprint = "";
  let lastAnalyticsRenderFingerprint = "";
  const PANEL_STALE_MS = 90000;
  const panelLoadedAt = {
    dashboard: 0,
    users: 0,
    subscriptions: 0,
    analytics: 0,
    settings: 0
  };
  let adminStaticUiBound = false;

  const ADMIN_MOBILE_LIST_LIMIT = 8;

  function adminListLimit() {
    return isMobileShell() ? ADMIN_MOBILE_LIST_LIMIT : Number.POSITIVE_INFINITY;
  }

  function clearDashTableBody(selector) {
    const tbody = document.querySelector(selector);
    if (tbody) tbody.replaceChildren();
  }

  function replaceChildrenFromHtml(el, html) {
    if (!el) return;
    const trimmed = String(html || "").trim();
    if (!trimmed) {
      el.replaceChildren();
      return;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = trimmed;
    el.replaceChildren(tpl.content);
  }

  function dashboardFingerprint(data) {
    if (!data) return "";
    const st = data.stats || {};
    const idList = (arr) =>
      (arr || [])
        .map((x) => String(x.id != null ? x.id : x._id != null ? x._id : ""))
        .join(",");
    const analytics = data.analytics || {};
    const signups = Array.isArray(analytics.signupsByDay) ? analytics.signupsByDay : [];
    return JSON.stringify({
      tu: st.totalUsers,
      tn: st.totalNotes,
      std: st.standardUsers,
      free: st.freeUsers,
      au: st.activeUsers,
      at: st.activeUsersToday,
      ru: idList(data.recentUsers),
      s7: analytics.signupsLast7Days,
      sbd: signups.map((d) => String(d.day || d.date) + ":" + d.count).join("|")
    });
  }

  function subsPanelFingerprint(users, meta) {
    return JSON.stringify({
      page: meta.page,
      total: meta.total,
      users: (users || []).map(
        (u) => String(u.id) + ":" + (u.activeNow ? 1 : 0) + ":" + String(u.premiumExpires || "")
      )
    });
  }

  /** Last successful dashboard response (for Analytics without refetch). */
  let dashboardBundleCache = null;

  function getAccessToken() {
    return localStorage.getItem("accessToken") || sessionStorage.getItem("accessToken");
  }

  function getRefreshToken() {
    return localStorage.getItem("refreshToken") || sessionStorage.getItem("refreshToken");
  }

  function getStoredUser() {
    try {
      const raw = localStorage.getItem("currentUser") || sessionStorage.getItem("currentUser");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function persistAccessToken(token) {
    if (localStorage.getItem("refreshToken")) {
      localStorage.setItem("accessToken", token);
    } else {
      sessionStorage.setItem("accessToken", token);
    }
  }

  async function tryRefreshAccessToken() {
    const rt = getRefreshToken();
    if (!rt) return false;
    const res = await fetch(buildApiUrl("/api/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.accessToken) return false;
    persistAccessToken(data.accessToken);
    if (data.user && typeof data.user === "object") {
      try {
        const raw = localStorage.getItem("currentUser") || sessionStorage.getItem("currentUser");
        if (raw) {
          const u = JSON.parse(raw);
          Object.assign(u, data.user);
          if (localStorage.getItem("refreshToken")) {
            localStorage.setItem("currentUser", JSON.stringify(u));
          } else {
            sessionStorage.setItem("currentUser", JSON.stringify(u));
          }
        }
      } catch {
        /* ignore */
      }
      const un = document.getElementById("adminUsername");
      if (un && data.user.username) un.textContent = data.user.username;
    }
    return true;
  }

  async function apiJson(path, options, didRefresh) {
    const headers = { "Content-Type": "application/json", ...(options && options.headers) };
    const at = getAccessToken();
    if (at) headers.Authorization = "Bearer " + at;
    const res = await fetch(buildApiUrl(path), {
      ...options,
      headers
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !didRefresh && getRefreshToken()) {
      const ok = await tryRefreshAccessToken();
      if (ok) return apiJson(path, options, true);
    }
    if (!res.ok) {
      const err = new Error(data.error || data.message || "Request failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function showGate(message) {
    const gate = document.getElementById("adminGate");
    const app = document.getElementById("adminApp");
    const msg = document.getElementById("adminGateMessage");
    if (msg) msg.textContent = message;
    if (gate) gate.classList.remove("hidden");
    if (app) app.classList.add("hidden");
  }

  function showApp() {
    const gate = document.getElementById("adminGate");
    const app = document.getElementById("adminApp");
    if (gate) gate.classList.add("hidden");
    if (app) app.classList.remove("hidden");
  }

  function setAlert(html, kind) {
    const el = document.getElementById("adminAlert");
    if (!el) return;
    if (!html) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = '<div class="admin-banner admin-banner--' + (kind || "info") + (kind === "success" ? " admin-banner--pulse" : "") + '">' + html + "</div>";
  }

  /** Scroll the alert strip into view (mobile users scroll past the top). */
  function focusAdminAlert() {
    const el = document.getElementById("adminAlert");
    if (!el) return;
    window.requestAnimationFrame(() => {
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        el.scrollIntoView();
      }
    });
  }

  function dashboardRowId(v) {
    if (v == null) return "";
    if (typeof v === "object" && v !== null && typeof v.toString === "function") return String(v.toString());
    return String(v);
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return "—";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  let dashboardRefreshTimer = null;
  function debouncedRefreshDashboard() {
    clearTimeout(dashboardRefreshTimer);
    dashboardRefreshTimer = setTimeout(async () => {
      dashboardRefreshTimer = null;
      try {
        await loadDashboard(true);
        panelLoadedAt.dashboard = Date.now();
        setAlert("Dashboard refreshed.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
    }, 400);
  }

  function debouncedReloadSubs(force) {
    clearTimeout(subsRefreshTimer);
    subsRefreshTimer = setTimeout(async () => {
      subsRefreshTimer = null;
      try {
        await loadSubscriptionsPanel(Boolean(force));
        panelLoadedAt.subscriptions = Date.now();
        if (force) setAlert("Subscription list refreshed.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
    }, 400);
  }

  const PANEL_LABELS = {
    dashboard: "Dashboard",
    users: "Users",
    subscriptions: "Subscriptions",
    analytics: "Analytics",
    settings: "Settings"
  };

  function setMobilePanelLabel(panel) {
    const el = document.getElementById("adminMobileSectionLabel");
    if (el) el.textContent = PANEL_LABELS[panel] || panel || "Admin";
  }

  function setBottomNavActive(panel) {
    document.querySelectorAll(".admin-bnav-btn[data-panel]").forEach((btn) => {
      const p = btn.getAttribute("data-panel");
      const on = p === panel;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
  }

  function isMobileShell() {
    return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;
  }

  function setAdminDrawerOpen(open) {
    const sb = document.getElementById("adminSidebar");
    const bd = document.getElementById("adminDrawerBackdrop");
    const btn = document.getElementById("adminMenuOpen");
    if (sb) sb.classList.toggle("is-open", open);
    if (bd) {
      if (open) bd.removeAttribute("hidden");
      else bd.setAttribute("hidden", "");
      bd.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeAdminMoreMenu() {
    const panel = document.getElementById("adminBnavMorePanel");
    const more = document.getElementById("adminBnavMore");
    if (panel) panel.classList.add("hidden");
    if (more) more.setAttribute("aria-expanded", "false");
  }

  function toggleAdminMoreMenu() {
    const panel = document.getElementById("adminBnavMorePanel");
    const more = document.getElementById("adminBnavMore");
    if (!panel || !more) return;
    const open = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !open);
    more.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function renderPlanMixDonut(stats) {
    const host = document.getElementById("adminDonutUsers");
    if (!host) return;
    const total = Number(stats.totalUsers) || 0;
    const std =
      stats.standardUsers != null && stats.standardUsers !== ""
        ? Number(stats.standardUsers)
        : NaN;
    const standard = Number.isFinite(std) ? std : 0;
    let free =
      stats.freeUsers != null && stats.freeUsers !== ""
        ? Number(stats.freeUsers)
        : Math.max(0, total - standard);
    if (!Number.isFinite(free) || free < 0) free = Math.max(0, total - standard);
    if (!total) {
      host.innerHTML = '<p class="admin-muted">No user data yet.</p>';
      return;
    }
    const pctStd = Math.min(100, Math.round((standard / total) * 100000) / 1000);
    const cumStd = pctStd;
    const bd =
      stats.standardBreakdown && typeof stats.standardBreakdown === "object"
        ? stats.standardBreakdown
        : null;
    const splitTrial = bd && bd.trial != null ? Number(bd.trial) : null;
    const splitCoin = bd && bd.coin != null ? Number(bd.coin) : null;
    const splitPaid = bd && bd.paid != null ? Number(bd.paid) : null;
    const hasSplit =
      bd &&
      splitTrial !== null &&
      splitCoin !== null &&
      splitPaid !== null &&
      Number.isFinite(splitTrial) &&
      Number.isFinite(splitCoin) &&
      Number.isFinite(splitPaid);
    const splitHtml = hasSplit
      ? '<div class="admin-standard-split">' +
        '<div class="admin-standard-split-title">Standard — ndarje</div>' +
        '<ul class="admin-standard-split-list">' +
        "<li><span>Trial 14 ditë</span><strong>" +
        escapeHtml(String(splitTrial)) +
        "</strong></li>" +
        "<li><span>Me coins</span><strong>" +
        escapeHtml(String(splitCoin)) +
        "</strong></li>" +
        "<li><span>Standard i paguar</span><strong>" +
        escapeHtml(String(splitPaid)) +
        "</strong></li>" +
        "</ul>" +
        '<p class="admin-standard-split-hint">Një përdorues numërohet vetëm një herë: së pari si paguar, pastaj coins, pastaj trial.</p>' +
        "</div>"
      : "";
    host.innerHTML =
      '<div class="admin-donut-wrap">' +
      '<div class="admin-donut admin-donut--dual" role="img" aria-label="Plan mix: Standard and Free"></div>' +
      '<div class="admin-donut-legend">' +
      '<span><span class="admin-donut-dot" style="background:linear-gradient(135deg,#38bdf8,#6366f1)"></span>Standard · <strong>' +
      escapeHtml(String(standard)) +
      "</strong></span>" +
      '<span><span class="admin-donut-dot" style="background:linear-gradient(135deg,#64748b,#94a3b8)"></span>Free · <strong>' +
      escapeHtml(String(free)) +
      "</strong></span>" +
      "</div>" +
      splitHtml +
      "</div>";
    const d = host.querySelector(".admin-donut");
    if (d) {
      d.style.background =
        "conic-gradient(rgba(56,189,248,0.88) 0% " +
        cumStd +
        "%, rgba(100,116,139,0.6) " +
        cumStd +
        "% 100%)";
      d.style.webkitMask =
        "radial-gradient(farthest-side, transparent calc(100% - 14px), #000 calc(100% - 13px))";
      d.style.mask =
        "radial-gradient(farthest-side, transparent calc(100% - 14px), #000 calc(100% - 13px))";
    }
  }

  function pctRatio(numer, denom) {
    const d = Number(denom) || 0;
    if (d <= 0) return 0;
    return Math.min(100, Math.round((Number(numer) / d) * 1000) / 10);
  }

  function ringSvg(label, valueLabel, pct, stroke) {
    const p = Math.max(0, Math.min(100, pct));
    const dash = p + " " + (100 - p);
    return (
      '<div class="admin-ring-item">' +
      '<svg class="admin-ring-svg" width="72" height="72" viewBox="0 0 40 40" aria-hidden="true">' +
      '<circle r="15" cx="20" cy="20" fill="none" stroke="rgba(148,163,184,0.18)" stroke-width="3.5"/>' +
      '<circle r="15" cx="20" cy="20" fill="none" stroke="' +
      stroke +
      '" stroke-width="3.5" stroke-dasharray="' +
      dash +
      "\" stroke-linecap=\"round\" transform=\"rotate(-90 20 20)\" pathLength=\"100\"/>" +
      "</svg>" +
      '<span class="admin-ring-val">' +
      escapeHtml(valueLabel) +
      '</span><span class="admin-ring-lbl">' +
      escapeHtml(label) +
      "</span></div>"
    );
  }

  function renderCircularGauges(data) {
    const host = document.getElementById("adminCircularGauges");
    if (!host) return;
    const stats = (data && data.stats) || {};
    const total = Number(stats.totalUsers) || 0;
    const online = Number(stats.activeUsers) || 0;
    const today = Number(stats.activeUsersToday) || 0;
    const standard = Number(stats.standardUsers) || 0;
    host.innerHTML =
      ringSvg("Online", String(online), pctRatio(online, total), "#38bdf8") +
      ringSvg("Standard", String(standard), pctRatio(standard, total), "#34d399") +
      ringSvg("Active today", String(today), pctRatio(today, total), "#a78bfa");
  }

  function renderSignupSparkline(data) {
    const host = document.getElementById("adminSignupSparkline");
    if (!host) return;
    const analytics = (data && data.analytics) || {};
    const days = Array.isArray(analytics.signupsByDay) ? analytics.signupsByDay : [];
    if (!days.length) {
      host.innerHTML = '<p class="admin-muted">No sign-up trend yet.</p>';
      return;
    }
    const counts = days.map((d) => Number(d.count) || 0);
    const max = Math.max(1, ...counts);
    const w = 320;
    const h = 120;
    const pad = 8;
    const pts = counts
      .map((c, i) => {
        const x = pad + (i * (w - pad * 2)) / Math.max(1, counts.length - 1);
        const y = h - pad - (c / max) * (h - pad * 2);
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    const last = counts[counts.length - 1] ?? 0;
    host.innerHTML =
      '<svg class="admin-sparkline" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" preserveAspectRatio="none" role="img" aria-label="Sign-ups last 7 days">' +
      '<defs><linearGradient id="admGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(56,189,248,0.5)"/><stop offset="100%" stop-color="rgba(56,189,248,0)"/></linearGradient></defs>' +
      '<polyline fill="none" stroke="rgba(56,189,248,0.15)" stroke-width="1" points="' +
      escapeHtml(pts) +
      '"/>' +
      '<polyline fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="' +
      escapeHtml(pts) +
      '"/>' +
      "</svg>" +
      '<p class="admin-sparkline-cta">Latest day: <strong>' +
      escapeHtml(String(last)) +
      "</strong> · UTC</p>";
  }

  function normalizePlan(value) {
    if (value === "premium") return "standard";
    if (value === "standard" || value === "free") return value;
    return "free";
  }

  function effectivePlanFromUser(u) {
    if (!u) return "free";
    if (u.standardActive === true) return "standard";
    const life = u.lifecycle ? String(u.lifecycle).toLowerCase() : "";
    if (life === "trial" || life === "standard") return "standard";
    return normalizePlan(u.plan || u.membershipRole || u.subscriptionPlan);
  }

  function planBadgeForUser(u) {
    const pl = effectivePlanFromUser(u);
    if (pl !== "standard") return planBadge(pl);
    const src = u && u.standardSource ? String(u.standardSource).toLowerCase() : "";
    const life = u && u.lifecycle ? String(u.lifecycle).toLowerCase() : "";
    if (src === "trial" || life === "trial") {
      return '<span class="admin-badge admin-badge--standard">Standard · Trial</span>';
    }
    if (src === "coins") {
      return '<span class="admin-badge admin-badge--standard">Standard · Coins</span>';
    }
    if (src === "stripe") {
      return '<span class="admin-badge admin-badge--standard">Standard · Paid</span>';
    }
    return planBadge("standard");
  }

  function effectiveStaffRole(u) {
    const r = ((u && (u.staffRole || u.role)) || "user").toLowerCase().trim();
    if (r === "admin" || r === "moderator" || r === "support") return r;
    return "user";
  }

  /** Prefer server caps; fallback to stored user so inputs stay editable if `/api/admin/me` failed silently. */
  function canEditCommunityLinks() {
    const c = caps && caps.capabilities ? caps.capabilities : {};
    if (typeof c.canEditDiscord === "boolean") return c.canEditDiscord;
    const role =
      caps && caps.staffRole
        ? String(caps.staffRole).toLowerCase().trim()
        : effectiveStaffRole(getStoredUser());
    return role === "admin" || role === "moderator" || role === "support";
  }

  function stashUser(u) {
    if (!u || !u.id) return;
    usersByIdCache.set(String(u.id), {
      ...u,
      plan: effectivePlanFromUser(u),
      membershipRole: effectivePlanFromUser(u),
      staffRole: effectiveStaffRole(u)
    });
  }

  function mergeCapabilityUi() {
    const c = caps && caps.capabilities ? caps.capabilities : {};
    const canEditDiscord = canEditCommunityLinks();
    const canDeleteMsgs = Boolean(c.canDeleteContactMessages);
    const canDeleteUsers = Boolean(c.canDeleteUsers);
    const canWritePlans = Boolean(c.canWritePlans);
    const canGrantPremium = Boolean(c.canGrantPremium);
    const canGiftCoins = Boolean(c.canGiftCoins);
    const canChangeStaff = Boolean(c.canChangeStaffRoles);

    const discordUrl = document.getElementById("adminDiscordInviteUrl");
    const discordCount = document.getElementById("adminDiscordUpdatesCount");
    const tiktokUrl = document.getElementById("adminTiktokUrl");
    const youtubeUrl = document.getElementById("adminYoutubeUrl");
    const supportEmail = document.getElementById("adminSupportEmail");
    const discordSaveBtn = document.querySelector('[data-act="save-discord-config"]');
    if (discordUrl) discordUrl.toggleAttribute("disabled", !canEditDiscord);
    if (discordCount) discordCount.toggleAttribute("disabled", !canEditDiscord);
    if (tiktokUrl) tiktokUrl.toggleAttribute("disabled", !canEditDiscord);
    if (youtubeUrl) youtubeUrl.toggleAttribute("disabled", !canEditDiscord);
    if (supportEmail) supportEmail.toggleAttribute("disabled", !canEditDiscord);
    if (discordSaveBtn) {
      discordSaveBtn.hidden = !canEditDiscord;
      discordSaveBtn.disabled = !canEditDiscord;
    }

    const grantBlock = document.getElementById("adminDetailGrantBlock");
    if (grantBlock) grantBlock.hidden = !canGrantPremium;

    const giftBlock = document.getElementById("adminDetailGiftCoinsBlock");
    if (giftBlock) giftBlock.hidden = !canGiftCoins;

    const planEditor = document.getElementById("adminDetailPlanEditor");
    if (planEditor) planEditor.hidden = !canWritePlans;

    const staffEditor = document.getElementById("adminDetailStaffEditor");
    if (staffEditor) staffEditor.hidden = !canChangeStaff;

    const delBtnMain = document.getElementById("adminDetailDeleteBtn");
    if (delBtnMain) {
      delBtnMain.hidden = !canDeleteUsers;
      delBtnMain.disabled = !canDeleteUsers;
    }

    document.querySelectorAll('[data-act="del-msg"]').forEach((btn) => {
      if (!(btn instanceof HTMLElement)) return;
      btn.hidden = !canDeleteMsgs;
      btn.toggleAttribute("disabled", !canDeleteMsgs);
    });
  }

  function renderStats(data) {
    const grid = document.getElementById("adminStats");
    if (!grid) return;
    const mins = data.activeWithinMinutes != null ? String(data.activeWithinMinutes) : "7";
    const cards = [
      { tone: "users", icon: "👥", label: "Total users", value: data.totalUsers },
      { tone: "notes", icon: "📝", label: "Total notes", value: data.totalNotes },
      { tone: "live", icon: "●", label: "Online (~" + mins + " min)", value: data.activeUsers },
      { tone: "today", icon: "◎", label: "Active today", value: data.activeUsersToday ?? "—" }
    ];
    grid.innerHTML = cards
      .map(
        (card) =>
          '<div class="admin-stat-card admin-stat-card--' +
          escapeHtml(card.tone) +
          '">' +
          '<div class="admin-stat-card-head">' +
          '<span class="admin-stat-ico" aria-hidden="true">' +
          escapeHtml(card.icon) +
          "</span>" +
          '<div class="admin-stat-label">' +
          escapeHtml(card.label) +
          "</div></div>" +
          '<div class="admin-stat-value">' +
          escapeHtml(String(card.value ?? "—")) +
          "</div></div>"
      )
      .join("");
  }

  function planBadge(plan) {
    if (plan === "standard") return '<span class="admin-badge admin-badge--standard">Standard</span>';
    return '<span class="admin-badge admin-badge--free">Free</span>';
  }

  function staffBadgeLabel(role) {
    const r = (role || "user").toLowerCase();
    if (r === "admin") return '<span class="admin-badge admin-badge--staff-admin">Admin</span>';
    if (r === "moderator") return '<span class="admin-badge admin-badge--staff-mod">Moderator</span>';
    if (r === "support") return '<span class="admin-badge admin-badge--staff-support">Support</span>';
    return '<span class="admin-badge admin-badge--muted">Customer</span>';
  }

  function renderDashUsersTable(users) {
    const tbody = document.querySelector("#adminDashUsersTable tbody");
    if (!tbody) return;
    tbody.innerHTML = (users || [])
      .map((u) => {
        const badge = planBadgeForUser(u);
        const on = u.activeNow
          ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
          : '<span class="admin-badge admin-badge--offline">Away</span>';
        const inv = Number(u.invitedFriendsCount) || 0;
        return (
          "<tr>" +
          "<td><strong>" +
          escapeHtml(u.username) +
          "</strong><div class=\"admin-cell-muted\">" +
          escapeHtml(u.email || "") +
          "</div></td>" +
          "<td>" +
          badge +
          "</td>" +
          "<td>" +
          on +
          "</td>" +
          '<td class="admin-num-cell">' +
          escapeHtml(String(inv)) +
          "</td>" +
          '<td class="admin-cell-muted">' +
          escapeHtml(fmtDate(u.createdAt)) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function renderDashUsersCards(users) {
    const wrap = document.getElementById("adminDashUsersCards");
    if (!wrap) return;
    const canPlan = Boolean(caps && caps.capabilities && caps.capabilities.canWritePlans);
    const rows = (users || []).slice(0, adminListLimit());
    if (!rows.length) {
      replaceChildrenFromHtml(wrap, '<p class="admin-muted">No recent users.</p>');
      return;
    }
    replaceChildrenFromHtml(
      wrap,
      rows
        .map((u) => {
          const pl = effectivePlanFromUser(u);
          const uid = escapeHtml(String(u.id || ""));
          const on = u.activeNow
            ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
            : '<span class="admin-badge admin-badge--offline">Away</span>';
          return (
            '<article class="admin-dash-user-card" data-user-card="1" data-id="' +
            uid +
            '">' +
            '<div class="admin-dash-user-card-top"><div>' +
            '<div class="admin-dash-user-name">' +
            escapeHtml(u.username || "—") +
            "</div>" +
            '<div class="admin-dash-user-email">' +
            escapeHtml(u.email || "") +
            "</div></div>" +
            planBadgeForUser(u) +
            "</div>" +
            '<div class="admin-dash-user-meta">' +
            on +
            "<span>" +
            escapeHtml(fmtDate(u.createdAt)) +
            "</span></div>" +
            '<div class="admin-dash-card-actions">' +
            '<button type="button" class="admin-card-ghost-btn admin-card-ghost-btn--primary" data-act="open-user" data-id="' +
            uid +
            '">View</button>' +
            (canPlan
              ? '<button type="button" class="admin-card-ghost-btn" data-act="open-user" data-id="' +
                uid +
                '">Plan</button>'
              : "") +
            "</div></article>"
          );
        })
        .join("")
    );
  }

  function renderAnalyticsPanels(data) {
    const analytics = (data && data.analytics) || {};
    const stats = (data && data.stats) || {};

    const grid = document.getElementById("adminAnalyticsGrid");
    if (grid) {
      const mini = [
        { tone: "users", label: "Sign-ups (7d)", value: analytics.signupsLast7Days ?? "—" },
        { tone: "notes", label: "Total notes", value: stats.totalNotes ?? "—" }
      ];
      grid.innerHTML = mini
        .map(
          (c) =>
            '<div class="admin-stat-card admin-stat-card--' +
            escapeHtml(c.tone) +
            '">' +
            '<div class="admin-stat-label">' +
            escapeHtml(c.label) +
            '</div><div class="admin-stat-value">' +
            escapeHtml(String(c.value)) +
            "</div></div>"
        )
        .join("");
    }

    const signupEl = document.getElementById("adminAnalyticsSignups");
    if (signupEl) {
      signupEl.innerHTML =
        '<p class="admin-analytics-muted">Accounts created during the trailing 7 UTC-day window:</p>' +
        "<p><strong>" +
        escapeHtml(String(analytics.signupsLast7Days ?? "—")) +
        "</strong> new registrations</p>";
    }
  }

  function hydrateDashboard(data, opts) {
    const force = Boolean(opts && opts.force);
    const fp = dashboardFingerprint(data);
    if (!force && fp && fp === lastDashboardFingerprint) return;
    lastDashboardFingerprint = fp;
    dashboardBundleCache = data;
    const st = data.stats || {};
    renderStats(st);
    renderAnalyticsPanels(data);
    renderPlanMixDonut(st);
    renderCircularGauges(data);
    renderSignupSparkline(data);
    const limit = adminListLimit();
    const ruAll = data.recentUsers || [];
    const ru = ruAll.slice(0, limit);
    if (isMobileShell()) {
      clearDashTableBody("#adminDashUsersTable tbody");
    } else {
      renderDashUsersTable(ruAll);
    }
    renderDashUsersCards(ru);
  }

  async function fetchAdminDashboardBundle() {
    try {
      return await apiJson("/api/admin/dashboard", { method: "GET" });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) throw err;
      try {
        const stats = await apiJson("/api/admin/stats", { method: "GET" });
        return {
          stats,
          analytics: {},
          recentUsers: []
        };
      } catch (err2) {
        const merged = new Error(
          err2 && err2.message
            ? err2.message
            : err && err.message
              ? err.message
              : "Admin API unavailable."
        );
        merged.status = (err2 && err2.status) || (err && err.status);
        throw merged;
      }
    }
  }

  async function loadDashboard(forceFetch) {
    if (!forceFetch && dashboardBundleCache) {
      hydrateDashboard(dashboardBundleCache);
      return;
    }
    const data = await fetchAdminDashboardBundle();
    hydrateDashboard(data, { force: true });
  }

  function renderPagination() {
    const el = document.getElementById("adminUsersPagination");
    if (!el) return;
    if (usersState.totalPages <= 1) {
      el.innerHTML =
        '<span class="admin-pagination-meta">' +
        escapeHtml(usersState.total + " users") +
        "</span>";
      return;
    }
    el.innerHTML =
      '<div class="admin-pagination-inner">' +
      '<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-act="users-page" data-dir="prev"' +
      (usersState.page <= 1 ? " disabled" : "") +
      ">Prev</button>" +
      '<span class="admin-pagination-meta">Page ' +
      escapeHtml(String(usersState.page)) +
      " / " +
      escapeHtml(String(usersState.totalPages)) +
      " · " +
      escapeHtml(String(usersState.total)) +
      " users</span>" +
      '<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-act="users-page" data-dir="next"' +
      (usersState.page >= usersState.totalPages ? " disabled" : "") +
      ">Next</button>" +
      "</div>";
  }

  function renderUsersRows(list) {
    const tbody = document.querySelector("#adminUsersTable tbody");
    if (!tbody) return;
    const canGift = Boolean(caps && caps.capabilities && caps.capabilities.canGiftCoins);

    replaceChildrenFromHtml(
      tbody,
      (list || [])
      .map((u) => {
        const planHtml = planBadgeForUser(u);
        const sr = effectiveStaffRole(u);
        const staffHtml = staffBadgeLabel(sr);
        const active =
          u.activeNow === true
            ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
            : '<span class="admin-badge admin-badge--offline">Offline</span>';
        const fc = Number(u.invitedFriendsCount) || 0;
        const coins = Number(u.coinBalance) || 0;
        const uid = escapeHtml(String(u.id || ""));
        const giftBtn = canGift
          ? '<button type="button" class="admin-gift-icon-btn" data-act="gift-coins-quick" data-id="' +
            uid +
            '" title="Gift coins" aria-label="Gift coins">🎁</button> '
          : "";
        return (
          '<tr class="admin-user-row" data-user-row="1" data-id="' +
          uid +
          '" tabindex="0" role="button">' +
          "<td>" +
          escapeHtml(u.username) +
          "</td>" +
          "<td>" +
          escapeHtml(u.email || "") +
          "</td>" +
          "<td>" +
          staffHtml +
          "</td>" +
          "<td>" +
          planHtml +
          "</td>" +
          "<td>" +
          active +
          "</td>" +
          '<td class="admin-num-cell">' +
          fc +
          "</td>" +
          '<td class="admin-num-cell">' +
          coins +
          "</td>" +
          '<td class="admin-cell-muted">' +
          escapeHtml(fmtDate(u.createdAt)) +
          "</td>" +
          "<td>" +
          giftBtn +
          '<span class="admin-cell-muted">Open →</span>' +
          "</td>" +
          "</tr>"
        );
      })
      .join("")
    );
  }

  function renderUserPanelCards(list) {
    const wrap = document.getElementById("adminUsersCards");
    if (!wrap) return;
    const canPlan = Boolean(caps && caps.capabilities && caps.capabilities.canWritePlans);
    const rows = (list || []).slice(0, adminListLimit());
    if (!rows.length) {
      wrap.innerHTML = '<p class="admin-muted">No users on this page.</p>';
      return;
    }
    wrap.innerHTML =
      rows
        .map((u) => {
          const pl = effectivePlanFromUser(u);
          const sr = effectiveStaffRole(u);
          const uid = escapeHtml(String(u.id || ""));
          const active =
            u.activeNow === true
              ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
              : '<span class="admin-badge admin-badge--offline">Offline</span>';
          return (
            '<article class="admin-user-card" data-user-card="1" data-id="' +
            uid +
            '">' +
            '<div class="admin-dash-user-card-top"><div>' +
            '<div class="admin-dash-user-name">' +
            escapeHtml(u.username) +
            "</div>" +
            '<div class="admin-dash-user-email">' +
            escapeHtml(u.email || "") +
            "</div></div>" +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-items:flex-start">' +
            planBadgeForUser(u) +
            staffBadgeLabel(sr) +
            "</div></div>" +
            '<div class="admin-dash-user-meta">' +
            active +
            "<span>Joined " +
            escapeHtml(fmtDate(u.createdAt)) +
            "</span></div>" +
            '<div class="admin-dash-card-actions">' +
            '<button type="button" class="admin-card-ghost-btn admin-card-ghost-btn--primary" data-act="open-user" data-id="' +
            uid +
            '">View</button>' +
            (canPlan
              ? '<button type="button" class="admin-card-ghost-btn" data-act="open-user" data-id="' +
                uid +
                '">Plan</button>'
              : "") +
            "</div></article>"
          );
        })
        .join("") +
      '<p class="admin-card-hint" style="margin-top:12px">Showing the first ' +
      rows.length +
      " accounts on this page — use the table on desktop for every column.</p>";
  }

  function renderSubsPanelCards(list) {
    const wrap = document.getElementById("adminSubsCards");
    if (!wrap) return;
    const rows = list || [];
    if (!rows.length) {
      replaceChildrenFromHtml(wrap, "");
      return;
    }
    replaceChildrenFromHtml(
      wrap,
      rows
        .map((u) => {
          const pl = effectivePlanFromUser(u);
          const expires = u.premiumExpires ? fmtDate(u.premiumExpires) : "—";
          const on = u.activeNow
            ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
            : '<span class="admin-badge admin-badge--offline">Offline</span>';
          const uid = escapeHtml(String(u.id || ""));
          return (
            '<article class="admin-subs-card" data-user-card="1" data-id="' +
            uid +
            '">' +
            '<div class="admin-subs-card-top"><div>' +
            '<div class="admin-dash-user-name">' +
            escapeHtml(u.username) +
            "</div>" +
            '<div class="admin-dash-user-email">' +
            escapeHtml(u.email || "") +
            "</div></div>" +
            planBadgeForUser(u) +
            "</div>" +
            '<div class="admin-dash-user-meta">' +
            on +
            "<span>Standard until " +
            escapeHtml(expires) +
            "</span></div>" +
            '<div class="admin-dash-card-actions">' +
            '<button type="button" class="admin-card-ghost-btn admin-card-ghost-btn--primary" data-act="open-user" data-id="' +
            uid +
            '">View</button>' +
            "</div></article>"
          );
        })
        .join("") +
      '<p class="admin-card-hint" style="margin-top:12px">Showing ' +
      rows.length +
      " Standard accounts on this page.</p>"
    );
  }

  async function loadUsersPage() {
    usersFetchGen += 1;
    const gen = usersFetchGen;
    const qs = new URLSearchParams({
      page: String(usersState.page),
      limit: String(usersState.limit),
      ...(usersState.search.trim() ? { search: usersState.search.trim() } : {}),
      ...(usersState.tier === "standard" ? { tier: "standard" } : {})
    });
    const path = `/api/admin/users?${qs}`;
    try {
      const data = await apiJson(path, { method: "GET" });
      if (gen !== usersFetchGen) return;
      usersState.total = typeof data.total === "number" ? data.total : 0;
      usersState.totalPages = typeof data.totalPages === "number" ? data.totalPages : 1;
      (data.users || []).forEach(stashUser);
      renderUsersRows(data.users || []);
      renderUserPanelCards(data.users || []);
      renderPagination();
    } catch {
      if (gen !== usersFetchGen) return;
      setAlert("Could not load users.", "error");
    }
  }

  function scheduleUsersReload() {
    clearTimeout(usersSearchTimer);
    usersSearchTimer = setTimeout(() => {
      usersSearchTimer = null;
      usersState.page = 1;
      void loadUsersPage();
    }, 400);
  }

  function renderSubsPagination() {
    const el = document.getElementById("adminSubsPagination");
    if (!el) return;
    if (subsState.totalPages <= 1) {
      replaceChildrenFromHtml(
        el,
        '<span class="admin-pagination-meta">' + escapeHtml(subsState.total + " subscribers") + "</span>"
      );
      return;
    }
    replaceChildrenFromHtml(
      el,
      '<div class="admin-pagination-inner">' +
        '<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-act="subs-page" data-dir="prev"' +
        (subsState.page <= 1 ? " disabled" : "") +
        ">Prev</button>" +
        '<span class="admin-pagination-meta">Page ' +
        escapeHtml(String(subsState.page)) +
        " / " +
        escapeHtml(String(subsState.totalPages)) +
        " · " +
        escapeHtml(String(subsState.total)) +
        " subscribers</span>" +
        '<button type="button" class="admin-btn admin-btn--ghost admin-btn--small" data-act="subs-page" data-dir="next"' +
        (subsState.page >= subsState.totalPages ? " disabled" : "") +
        ">Next</button>" +
        "</div>"
    );
  }

  async function loadSubscriptionsPanel(forceRender) {
    subsFetchGen += 1;
    const gen = subsFetchGen;
    const qs = new URLSearchParams({
      tier: "standard",
      limit: String(subsState.limit),
      page: String(subsState.page)
    });
    const data = await apiJson(`/api/admin/users?${qs}`, { method: "GET" });
    if (gen !== subsFetchGen) return;

    const users = data.users || [];
    subsState.total = typeof data.total === "number" ? data.total : users.length;
    subsState.totalPages = typeof data.totalPages === "number" ? data.totalPages : 1;

    const fp = subsPanelFingerprint(users, subsState);
    const tbody = document.querySelector("#adminSubsTable tbody");
    const cardsHost = document.getElementById("adminSubsCards");
    if (!tbody) return;

    if (!forceRender && fp === subsListFingerprint) {
      renderSubsPagination();
      return;
    }
    subsListFingerprint = fp;

    if (!users.length) {
      replaceChildrenFromHtml(
        tbody,
        '<tr><td colspan="6" class="admin-cell-muted">No Standard subscribers yet.</td></tr>'
      );
      if (cardsHost) replaceChildrenFromHtml(cardsHost, '<p class="admin-muted">No Standard subscribers yet.</p>');
      renderSubsPagination();
      mergeCapabilityUi();
      return;
    }

    replaceChildrenFromHtml(
      tbody,
      users
        .map((u) => {
          const pl = effectivePlanFromUser(u);
          const expires = u.premiumExpires ? fmtDate(u.premiumExpires) : "—";
          const on = u.activeNow
            ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
            : '<span class="admin-badge admin-badge--offline">Offline</span>';

          return (
            '<tr class="admin-user-row" data-user-row="1" data-id="' +
            escapeHtml(String(u.id || "")) +
            '" tabindex="0">' +
            "<td>" +
            escapeHtml(u.username) +
            "</td>" +
            "<td>" +
            escapeHtml(u.email || "") +
            "</td>" +
            "<td>" +
            planBadgeForUser(u) +
            "</td>" +
            "<td>" +
            on +
            "</td>" +
            '<td class="admin-cell-muted">' +
            escapeHtml(expires) +
            "</td>" +
            '<td><span class="admin-cell-muted">Open →</span></td>' +
            "</tr>"
          );
        })
        .join("")
    );

    users.forEach(stashUser);
    if (cardsHost) renderSubsPanelCards(users);
    renderSubsPagination();
    mergeCapabilityUi();
  }

  async function hydrateAnalyticsFromCache() {
    if (!dashboardBundleCache) {
      await loadDashboard(true);
    }
    const fp = dashboardFingerprint(dashboardBundleCache);
    if (fp && fp === lastAnalyticsRenderFingerprint) return;
    lastAnalyticsRenderFingerprint = fp;
    renderAnalyticsPanels(dashboardBundleCache);
    renderPlanMixDonut(dashboardBundleCache.stats || {});
    renderCircularGauges(dashboardBundleCache);
    renderSignupSparkline(dashboardBundleCache);
  }

  const meUser = getStoredUser();
  const selfId = meUser && meUser.id ? String(meUser.id) : "";

  function userFromCache(id) {
    return usersByIdCache.get(String(id)) || null;
  }

  function closeUserDetailsModal() {
    selectedUserId = "";
    const modal = document.getElementById("adminUserDetailsModal");
    if (modal) modal.classList.add("hidden");
  }

  function closeGiftCoinsModal() {
    giftCoinsInFlight = false;
    const modal = document.getElementById("adminGiftCoinsModal");
    const confirmBtn = document.getElementById("adminGiftConfirmBtn");
    if (modal) modal.classList.add("hidden");
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.classList.remove("is-busy");
    }
    const amountInput = document.getElementById("adminGiftAmount");
    const reasonInput = document.getElementById("adminGiftReason");
    if (amountInput) amountInput.value = "";
    if (reasonInput) reasonInput.value = "";
  }

  async function openGiftCoinsModal(userId) {
    if (!(caps && caps.capabilities && caps.capabilities.canGiftCoins)) return;
    const user = await ensureUserResolved(userId);
    if (!user) return;
    selectedUserId = String(user.id);

    const modal = document.getElementById("adminGiftCoinsModal");
    if (!modal) return;

    const nameEl = document.getElementById("adminGiftRecipientName");
    const balanceEl = document.getElementById("adminGiftCurrentBalance");
    const amountInput = document.getElementById("adminGiftAmount");
    const reasonInput = document.getElementById("adminGiftReason");

    if (nameEl) nameEl.textContent = user.username || "—";
    if (balanceEl) balanceEl.textContent = String(Number(user.coinBalance) || 0);
    if (amountInput) {
      amountInput.value = "";
      amountInput.max = "1200";
    }
    if (reasonInput) reasonInput.value = "";

    modal.classList.remove("hidden");
    if (amountInput) amountInput.focus();
  }

  async function ensureUserResolved(id) {
    let user = userFromCache(id);
    if (user) return user;
    const data = await apiJson("/api/admin/users/" + encodeURIComponent(id), { method: "GET" });
    if (data && data.user) {
      stashUser(data.user);
      return data.user;
    }
    return null;
  }

  async function openUserDetailsModal(id) {
    const user = await ensureUserResolved(id);
    if (!user) return;
    selectedUserId = String(user.id);

    const modal = document.getElementById("adminUserDetailsModal");
    if (!modal) return;

    const plan = effectivePlanFromUser(user);
    document.getElementById("adminDetailUsername").textContent = user.username || "—";
    document.getElementById("adminDetailEmail").textContent = user.email || "—";

    const planBadgeEl = document.getElementById("adminDetailPlanBadge");
    if (planBadgeEl) planBadgeEl.innerHTML = planBadgeForUser(user);

    const staffBadgeEl = document.getElementById("adminDetailStaffBadge");
    const staffSel = effectiveStaffRole(user);
    if (staffBadgeEl) staffBadgeEl.innerHTML = staffBadgeLabel(staffSel);

    const activeHtml = user.activeNow
      ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
      : '<span class="admin-badge admin-badge--offline">Offline</span>';
    const activeEl = document.getElementById("adminDetailActive");
    if (activeEl) activeEl.innerHTML = activeHtml;

    document.getElementById("adminDetailInvitesCount").textContent = String(Number(user.invitedFriendsCount) || 0);
    document.getElementById("adminDetailCoinBalance").textContent = String(Number(user.coinBalance) || 0);
    document.getElementById("adminDetailGiftedCoins").textContent = String(Number(user.totalGiftedCoins) || 0);
    const billingEnds =
      user.standardExpiresAt || user.trialEndsAt || user.premiumExpires || null;
    document.getElementById("adminDetailPremiumExpires").textContent = billingEnds
      ? fmtDate(billingEnds)
      : "Not set / lifetime";

    document.getElementById("adminDetailCreated").textContent = fmtDate(user.createdAt);
    document.getElementById("adminDetailUserId").textContent = String(user.id || "—");

    const selPlan = document.getElementById("adminDetailPlanSelect");
    if (selPlan) {
      selPlan.value = plan;
      const canWritePlans = Boolean(caps && caps.capabilities && caps.capabilities.canWritePlans);
      selPlan.disabled = !canWritePlans;
    }

    const staffSelect = document.getElementById("adminDetailStaffRoleSelect");
    if (staffSelect) {
      staffSelect.value = staffSel;
      const canStaff = Boolean(caps && caps.capabilities && caps.capabilities.canChangeStaffRoles);
      staffSelect.toggleAttribute("disabled", !canStaff);
    }

    mergeCapabilityUi();

    const saveStaffBtn =
      /** @type {HTMLButtonElement | null} */
      (document.querySelector('[data-act="save-staff-role"]'));
    if (saveStaffBtn && caps && caps.capabilities) saveStaffBtn.disabled = !caps.capabilities.canChangeStaffRoles;

    const savePlanBtn =
      /** @type {HTMLButtonElement | null} */
      (document.querySelector('[data-act="save-user-plan"]'));
    if (savePlanBtn && caps && caps.capabilities) savePlanBtn.disabled = !caps.capabilities.canWritePlans;

    const delBtn =
      /** @type {HTMLButtonElement | null} */
      (document.getElementById("adminDetailDeleteBtn"));
    if (delBtn) {
      delBtn.disabled = String(user.id) === selfId || !(caps && caps.capabilities && caps.capabilities.canDeleteUsers);
      delBtn.hidden = !(caps && caps.capabilities && caps.capabilities.canDeleteUsers);
      delBtn.title = String(user.id) === selfId ? "You cannot delete your own account here" : "";
    }

    modal.classList.remove("hidden");
  }

  function buildMessagesRows(list) {
    const canDel = !!(caps && caps.capabilities && caps.capabilities.canDeleteContactMessages);
    return (list || [])
      .map(
        (m) =>
          "<tr>" +
          "<td>" +
          escapeHtml(fmtDate(m.createdAt)) +
          "</td>" +
          "<td>" +
          escapeHtml(m.name) +
          "</td>" +
          "<td>" +
          escapeHtml(m.email) +
          "</td>" +
          '<td class="admin-msg-body">' +
          escapeHtml(m.message) +
          "</td>" +
          "<td>" +
          (canDel
            ? '<button type="button" class="admin-btn admin-btn--danger" data-act="del-msg" data-id="' +
              escapeHtml(String(m.id)) +
              '">Delete</button>'
            : "—") +
          "</td>" +
          "</tr>"
      )
      .join("");
  }

  function applyMessagesFilter() {
    const tbody = document.querySelector("#adminMessagesTable tbody");
    if (!tbody) return;
    const q = (document.getElementById("adminMessagesFilter")?.value || "").trim().toLowerCase();
    if (!q) {
      tbody.innerHTML = buildMessagesRows(messagesCache);
      return;
    }
    const filtered = messagesCache.filter((m) => {
      const hay = [m.name, m.email, m.message].join(" ").toLowerCase();
      return hay.includes(q);
    });
    tbody.innerHTML = buildMessagesRows(filtered);
  }

  async function loadMessages() {
    const data = await apiJson("/api/admin/messages", { method: "GET" });
    messagesCache = data.messages || [];
    applyMessagesFilter();
    mergeCapabilityUi();
  }

  async function loadDiscordConfig() {
    const data = await apiJson("/api/admin/config/discord", { method: "GET", cache: "no-store" });
    applyDiscordConfigToInputs(data);
  }

  function setNavActive(panel) {
    document.querySelectorAll(".admin-nav-item").forEach((btn) => {
      const p = btn.getAttribute("data-panel");
      const scrollT = btn.getAttribute("data-scroll-target");
      btn.classList.toggle("is-active", p === panel && !scrollT);
    });
    document.querySelectorAll(".admin-panel").forEach((sec) => {
      sec.classList.toggle("hidden", sec.id !== "panel-" + panel);
    });
  }

  async function goPanel(panel, scrollToId, opts) {
    const force = Boolean(opts && opts.force);
    setNavActive(panel);
    setMobilePanelLabel(panel);
    setBottomNavActive(panel);
    setAlert("");
    const now = Date.now();
    try {
      if (panel === "dashboard") {
        if (force || !dashboardBundleCache || now - panelLoadedAt.dashboard > PANEL_STALE_MS) {
          await loadDashboard(force);
          panelLoadedAt.dashboard = Date.now();
        }
      }
      if (panel === "users") {
        if (force || now - panelLoadedAt.users > PANEL_STALE_MS) {
          await loadUsersPage();
          panelLoadedAt.users = Date.now();
        }
      }
      if (panel === "subscriptions") {
        if (force || now - panelLoadedAt.subscriptions > PANEL_STALE_MS) {
          await loadSubscriptionsPanel(force);
          panelLoadedAt.subscriptions = Date.now();
        }
      }
      if (panel === "analytics") await hydrateAnalyticsFromCache();
      if (panel === "settings") {
        if (force || now - panelLoadedAt.settings > PANEL_STALE_MS) {
          await Promise.all([loadDiscordConfig(), loadMessages()]);
          panelLoadedAt.settings = Date.now();
        }
      }
    } catch (err) {
      setAlert(err.message, "error");
    }
    mergeCapabilityUi();
    if (scrollToId) {
      window.requestAnimationFrame(() => {
        const el = document.getElementById(scrollToId);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  async function bootstrapStaff() {
    try {
      caps = await apiJson("/api/admin/me", { method: "GET" });
      const chip = document.getElementById("adminStaffBadge");
      if (chip && caps.staffRole) {
        chip.textContent = caps.staffRole;
        chip.className =
          "admin-staff-chip admin-staff-chip--foot admin-staff-chip--" +
          caps.staffRole.replace(/[^a-z]/gi, "").toLowerCase();
      }
    } catch {
      const fallbackRole = effectiveStaffRole(getStoredUser());
      caps = { staffRole: fallbackRole, capabilities: {} };
      const chip = document.getElementById("adminStaffBadge");
      if (chip && fallbackRole !== "user") {
        chip.textContent = fallbackRole;
        chip.className =
          "admin-staff-chip admin-staff-chip--foot admin-staff-chip--" +
          fallbackRole.replace(/[^a-z]/gi, "").toLowerCase();
      }
    }
    mergeCapabilityUi();
  }

  document.addEventListener("click", async (e) => {
    let t = e.target;
    if (t && t.nodeType === Node.TEXT_NODE && t.parentElement) t = t.parentElement;
    if (!(t instanceof HTMLElement)) return;

    const moreItem = t.closest(".admin-bnav-more-item[data-panel]");
    if (moreItem instanceof HTMLElement) {
      const p = moreItem.getAttribute("data-panel");
      const sid = moreItem.getAttribute("data-scroll-target") || "";
      if (p) await goPanel(p, sid || null);
      closeAdminMoreMenu();
      if (isMobileShell()) setAdminDrawerOpen(false);
      return;
    }

    if (!t.closest("#adminBnavMorePanel") && !t.closest("#adminBnavMore")) {
      const mp = document.getElementById("adminBnavMorePanel");
      if (mp && !mp.classList.contains("hidden")) closeAdminMoreMenu();
    }

    if (t.id === "adminDrawerBackdrop") {
      setAdminDrawerOpen(false);
      return;
    }

    if (t.closest("#adminMenuOpen")) {
      const sb = document.getElementById("adminSidebar");
      setAdminDrawerOpen(!(sb && sb.classList.contains("is-open")));
      return;
    }

    const bnav = t.closest(".admin-bnav-btn[data-panel]");
    if (bnav instanceof HTMLElement) {
      const p = bnav.getAttribute("data-panel");
      if (p) await goPanel(p);
      closeAdminMoreMenu();
      if (isMobileShell()) setAdminDrawerOpen(false);
      return;
    }

    if (t.closest("#adminBnavMore")) {
      toggleAdminMoreMenu();
      return;
    }

    const uc = t.closest("[data-user-card='1']");
    if (uc instanceof HTMLElement && !t.closest("button")) {
      const id = uc.getAttribute("data-id");
      if (id) void openUserDetailsModal(id);
      return;
    }

    const goEl = t.closest("[data-go]");
    const go = goEl instanceof HTMLElement ? goEl.getAttribute("data-go") : null;
    if (go) {
      await goPanel(go);
      if (isMobileShell()) setAdminDrawerOpen(false);
      return;
    }

    const actHost = t.closest("[data-act]");
    const act = actHost instanceof HTMLElement ? actHost.getAttribute("data-act") : null;
    if (act === "open-user") {
      const id = actHost.getAttribute("data-id");
      if (id) void openUserDetailsModal(id);
      return;
    }
    if (act === "refresh-dashboard") {
      debouncedRefreshDashboard();
      return;
    }
    if (act === "refresh-analytics") {
      debouncedRefreshDashboard();
      return;
    }
    if (act === "reload-users") {
      try {
        await loadUsersPage();
        setAlert("Users refreshed.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "reload-subs") {
      debouncedReloadSubs(true);
      return;
    }
    if (act === "subs-page") {
      const dir = actHost.getAttribute("data-dir");
      if (dir === "prev" && subsState.page > 1) {
        subsState.page -= 1;
        subsListFingerprint = "";
        await loadSubscriptionsPanel(true);
      }
      if (dir === "next" && subsState.page < subsState.totalPages) {
        subsState.page += 1;
        subsListFingerprint = "";
        await loadSubscriptionsPanel(true);
      }
      return;
    }
    if (act === "users-page") {
      const dir = actHost.getAttribute("data-dir");
      if (dir === "prev" && usersState.page > 1) {
        usersState.page -= 1;
        await loadUsersPage();
      }
      if (dir === "next" && usersState.page < usersState.totalPages) {
        usersState.page += 1;
        await loadUsersPage();
      }
      return;
    }
    if (act === "reload-messages") {
      try {
        await loadMessages();
        setAlert("Messages refreshed.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "reload-discord-config") {
      try {
        await loadDiscordConfig();
        setAlert("Community links reloaded.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "save-discord-config") {
      if (!canEditCommunityLinks()) return;
      const urlInput = document.getElementById("adminDiscordInviteUrl");
      const countInput = document.getElementById("adminDiscordUpdatesCount");
      const tiktokInput = document.getElementById("adminTiktokUrl");
      const youtubeInput = document.getElementById("adminYoutubeUrl");
      const supportEmailInput = document.getElementById("adminSupportEmail");
      const discordInviteUrl = normalizeCommunityUrl(urlInput ? String(urlInput.value || "").trim() : "");
      const discordUpdatesCount = countInput ? Math.max(0, Number(countInput.value || 0)) : 0;
      const tiktokUrl = normalizeCommunityUrl(tiktokInput ? String(tiktokInput.value || "").trim() : "");
      const youtubeUrl = normalizeCommunityUrl(youtubeInput ? String(youtubeInput.value || "").trim() : "");
      const supportEmail = supportEmailInput ? String(supportEmailInput.value || "").trim() : "";
      try {
        const saved = await apiJson("/api/admin/config/discord", {
          method: "PUT",
          body: JSON.stringify({ discordInviteUrl, discordUpdatesCount, tiktokUrl, youtubeUrl, supportEmail })
        });
        applyDiscordConfigToInputs(saved);
        setAlert("Community links saved.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "open-gift-coins") {
      if (!(caps && caps.capabilities && caps.capabilities.canGiftCoins)) return;
      if (!selectedUserId) return;
      void openGiftCoinsModal(selectedUserId);
      return;
    }
    if (act === "gift-coins-quick") {
      if (!(caps && caps.capabilities && caps.capabilities.canGiftCoins)) return;
      const id = actHost.getAttribute("data-id");
      if (!id) return;
      actHost.closest("tr")?.blur?.();
      void openGiftCoinsModal(id);
      return;
    }
    if (act === "close-gift-coins") {
      closeGiftCoinsModal();
      return;
    }
    if (act === "confirm-gift-coins") {
      if (!(caps && caps.capabilities && caps.capabilities.canGiftCoins)) return;
      if (!selectedUserId || giftCoinsInFlight) return;
      const amountInput = document.getElementById("adminGiftAmount");
      const reasonInput = document.getElementById("adminGiftReason");
      const amount = amountInput ? Math.floor(Number(amountInput.value)) : 0;
      const reason = reasonInput ? String(reasonInput.value || "").trim() : "";
      if (!Number.isFinite(amount) || amount < 1) {
        setAlert("Enter a valid coin amount (1 or more).", "error");
        focusAdminAlert();
        return;
      }
      const confirmBtn = document.getElementById("adminGiftConfirmBtn");
      giftCoinsInFlight = true;
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.classList.add("is-busy");
      }
      void (async () => {
        try {
          const out = await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId) + "/gift-coins", {
            method: "POST",
            body: JSON.stringify({ amount, reason })
          });
          if (out && out.user) stashUser(out.user);
          const credited = out && out.gift && out.gift.amount != null ? out.gift.amount : amount;
          const after = out && out.gift && out.gift.balanceAfter != null ? out.gift.balanceAfter : "—";
          setAlert(
            "🎁 Gifted <strong>" +
              escapeHtml(String(credited)) +
              "</strong> coins. New balance: <strong>" +
              escapeHtml(String(after)) +
              "</strong>.",
            "success"
          );
          focusAdminAlert();
          closeGiftCoinsModal();
          await Promise.all([loadUsersPage(), loadDashboard()]);
          await openUserDetailsModal(selectedUserId);
        } catch (err) {
          setAlert(err.message || "Failed to gift coins.", "error");
          focusAdminAlert();
        } finally {
          giftCoinsInFlight = false;
          if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.classList.remove("is-busy");
          }
        }
      })();
      return;
    }
    if (act === "grant-premium") {
      const preset = actHost.getAttribute("data-preset");
      if (!(caps && caps.capabilities && caps.capabilities.canGrantPremium)) return;
      if (!selectedUserId || !preset) return;
      try {
        const out = await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId) + "/grant-premium", {
          method: "POST",
          body: JSON.stringify({ preset })
        });
        if (out && out.user) stashUser(out.user);
        setAlert("Standard grant applied.", "info");
        await Promise.all([loadUsersPage(), loadDashboard()]);
        await openUserDetailsModal(selectedUserId);
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "save-staff-role") {
      if (!(caps && caps.capabilities && caps.capabilities.canChangeStaffRoles)) return;
      if (!selectedUserId) return;
      const staffSelect =
        /** @type {HTMLSelectElement | null} */
        (document.getElementById("adminDetailStaffRoleSelect"));
      const staffRole = staffSelect ? staffSelect.value : "user";
      try {
        const out = await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId) + "/staff-role", {
          method: "PATCH",
          body: JSON.stringify({ staffRole })
        });
        if (out && out.user) stashUser(out.user);
        setAlert("Staff role updated.", "info");
        await Promise.all([loadUsersPage(), loadDashboard()]);
        await openUserDetailsModal(selectedUserId);
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "copy-id") {
      const id = actHost.getAttribute("data-id");
      if (!id) return;
      try {
        await navigator.clipboard.writeText(id);
        setAlert("User id copied to clipboard.", "info");
      } catch {
        setAlert("Could not copy (clipboard blocked). Id: " + escapeHtml(id), "error");
      }
      return;
    }
    if (act === "close-user-details") {
      closeUserDetailsModal();
      return;
    }
    if (act === "save-user-plan") {
      if (!(caps && caps.capabilities && caps.capabilities.canWritePlans)) return;
      if (!selectedUserId) return;
      const planSelect = document.getElementById("adminDetailPlanSelect");
      const plan = planSelect ? planSelect.value : "";
      if (plan !== "free" && plan !== "standard") return;
      try {
        const out = await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId) + "/plan", {
          method: "PATCH",
          body: JSON.stringify({ plan })
        });
        if (out && out.user) stashUser(out.user);
        setAlert("Plan updated.", "info");
        await Promise.all([loadUsersPage(), loadDashboard(true)]);
        subsListFingerprint = "";
        panelLoadedAt.subscriptions = 0;
        await openUserDetailsModal(selectedUserId);
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "copy-id-from-details") {
      if (!selectedUserId) return;
      try {
        await navigator.clipboard.writeText(selectedUserId);
        setAlert("User id copied.", "info");
      } catch {
        setAlert("Could not copy (clipboard blocked). Id: " + escapeHtml(selectedUserId), "error");
      }
      return;
    }
    if (act === "del-user-from-details") {
      if (!selectedUserId) return;
      if (!(caps && caps.capabilities && caps.capabilities.canDeleteUsers)) return;
      if (String(selectedUserId) === selfId) {
        setAlert("You cannot delete your own account here.", "error");
        return;
      }
      if (!confirm("Delete this user and all their notes and reminders?")) return;
      try {
        await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId), { method: "DELETE" });
        setAlert("User deleted.", "info");
        closeUserDetailsModal();
        await loadUsersPage();
        await loadDashboard();
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "del-msg") {
      if (!(caps && caps.capabilities && caps.capabilities.canDeleteContactMessages)) return;
      const id = actHost.getAttribute("data-id");
      if (!confirm("Delete this message?")) return;
      try {
        await apiJson("/api/admin/messages/" + encodeURIComponent(id), { method: "DELETE" });
        setAlert("Message deleted.", "info");
        await loadMessages();
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }

    const row = t.closest("tr[data-user-row='1']");
    if (row && !t.closest("button")) {
      const id = row.getAttribute("data-id");
      if (id) void openUserDetailsModal(id);
    }
  });

  function bindAdminStaticUi() {
    if (adminStaticUiBound) return;
    adminStaticUiBound = true;

  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const panel = btn.getAttribute("data-panel");
      const scrollToId = btn.getAttribute("data-scroll-target") || "";
      await goPanel(panel, scrollToId || null);
      if (isMobileShell()) setAdminDrawerOpen(false);
    });
  });

  const usersFilterEl =
    /** @type {HTMLInputElement | null} */
    (document.getElementById("adminUsersFilter"));
  if (usersFilterEl) {
    usersFilterEl.addEventListener("input", () => {
      usersState.search = usersFilterEl.value || "";
      scheduleUsersReload();
    });
  }

  const tierFilter =
    /** @type {HTMLSelectElement | null} */
    (document.getElementById("adminUsersTierFilter"));
  if (tierFilter) {
    tierFilter.addEventListener("change", async () => {
      usersState.tier = tierFilter.value || "all";
      usersState.page = 1;
      await loadUsersPage();
    });
  }

  const pageSize =
    /** @type {HTMLSelectElement | null} */
    (document.getElementById("adminUsersPageSize"));
  if (pageSize) {
    pageSize.addEventListener("change", async () => {
      usersState.limit = Math.min(100, Math.max(5, parseInt(pageSize.value || "20", 10)));
      usersState.page = 1;
      await loadUsersPage();
    });
  }

  const messagesFilterEl = document.getElementById("adminMessagesFilter");
  if (messagesFilterEl) {
    messagesFilterEl.addEventListener("input", () => {
      clearTimeout(messagesFilterTimer);
      messagesFilterTimer = setTimeout(() => applyMessagesFilter(), 350);
    });
  }

  const userDetailsModal = document.getElementById("adminUserDetailsModal");
  if (userDetailsModal) {
    userDetailsModal.addEventListener("click", (ev) => {
      if (ev.target === userDetailsModal) closeUserDetailsModal();
    });
  }

  const giftCoinsModal = document.getElementById("adminGiftCoinsModal");
  if (giftCoinsModal) {
    giftCoinsModal.addEventListener("click", (ev) => {
      if (ev.target === giftCoinsModal) closeGiftCoinsModal();
    });
  }

  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape") {
      const giftModal = document.getElementById("adminGiftCoinsModal");
      if (giftModal && !giftModal.classList.contains("hidden")) {
        closeGiftCoinsModal();
        return;
      }
      const modal = document.getElementById("adminUserDetailsModal");
      if (modal && !modal.classList.contains("hidden")) {
        closeUserDetailsModal();
        return;
      }
      closeAdminMoreMenu();
      setAdminDrawerOpen(false);
      return;
    }
    const maybeRow = evt.target instanceof Element ? evt.target.closest("tr[data-user-row='1']") : null;
    if (maybeRow && (evt.key === "Enter" || evt.key === " ")) {
      evt.preventDefault();
      const rid = maybeRow.getAttribute("data-id");
      if (rid) void openUserDetailsModal(rid);
    }
  });
  }

  bindAdminStaticUi();

  async function init() {
    const user = getStoredUser();
    const un =
      /** @type {HTMLElement | null} */
      (document.getElementById("adminUsername"));
    if (un && user) un.textContent = user.username || user.emailOrPhone || "—";

    if (!getAccessToken() && !getRefreshToken()) {
      showGate("Log in from the main app first, then open this page again.");
      return;
    }

    let dash;
    try {
      await bootstrapStaff();
      dash = await fetchAdminDashboardBundle();
    } catch (err) {
      if (err.status === 403) {
        showGate("Staff access denied. Your account role is not admin, moderator, or support.");
        return;
      }
      if (err.status === 401) {
        showGate("Session expired. Log in again from the main app.");
        return;
      }
      const suffix = err.status ? " (HTTP " + err.status + ")" : "";
      showGate((err.message || "Could not reach the server.") + suffix);
      return;
    }

    showApp();
    setAdminDrawerOpen(false);
    setMobilePanelLabel("dashboard");
    setBottomNavActive("dashboard");
    hydrateDashboard(dash, { force: true });
    panelLoadedAt.dashboard = Date.now();
    mergeCapabilityUi();
    try {
      await loadDiscordConfig();
    } catch {
      /* Community links are optional for dashboard; Settings will retry on navigate. */
    }
  }

  init();
})();
