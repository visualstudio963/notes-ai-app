(function () {
  const ACTIVE_LABEL = "Online";

  /** @type {null | { staffRole?: string; staffRank?: number; capabilities?: Record<string, boolean> }} */
  let caps = null;
  let messagesCache = [];
  let messagesFilterTimer = null;
  let selectedUserId = "";
  let discordConfigCache = {
    discordInviteUrl: "",
    discordUpdatesCount: 0,
    tiktokUrl: "",
    youtubeUrl: ""
  };

  /** @type {Map<string, object>} */
  const usersByIdCache = new Map();

  let usersFetchGen = 0;
  const usersState = {
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 1,
    search: "",
    tier: "all"
  };

  let usersSearchTimer = null;

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
    el.innerHTML = '<div class="admin-banner admin-banner--' + (kind || "info") + '">' + html + "</div>";
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

  function normalizePlan(value) {
    if (value === "premium" || value === "standard" || value === "free") return value;
    return "free";
  }

  function effectivePlanFromUser(u) {
    return normalizePlan(u && (u.plan || u.membershipRole || u.subscriptionPlan));
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
    const canChangeStaff = Boolean(c.canChangeStaffRoles);

    const discordUrl = document.getElementById("adminDiscordInviteUrl");
    const discordCount = document.getElementById("adminDiscordUpdatesCount");
    const tiktokUrl = document.getElementById("adminTiktokUrl");
    const youtubeUrl = document.getElementById("adminYoutubeUrl");
    const discordSaveBtn = document.querySelector('[data-act="save-discord-config"]');
    if (discordUrl) discordUrl.toggleAttribute("disabled", !canEditDiscord);
    if (discordCount) discordCount.toggleAttribute("disabled", !canEditDiscord);
    if (tiktokUrl) tiktokUrl.toggleAttribute("disabled", !canEditDiscord);
    if (youtubeUrl) youtubeUrl.toggleAttribute("disabled", !canEditDiscord);
    if (discordSaveBtn) {
      discordSaveBtn.hidden = !canEditDiscord;
      discordSaveBtn.disabled = !canEditDiscord;
    }

    const grantBlock = document.getElementById("adminDetailGrantBlock");
    if (grantBlock) grantBlock.hidden = !canGrantPremium;

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
    const pro = data.proUsers != null ? data.proUsers : data.premiumUsers;
    const cards = [
      { tone: "users", label: "Total users", value: data.totalUsers },
      { tone: "notes", label: "Total notes", value: data.totalNotes },
      { tone: "rem", label: "Total reminders", value: data.totalReminders },
      { tone: "prem", label: "Pro users", value: pro },
      { tone: "live", label: ACTIVE_LABEL + " (~" + mins + " min)", value: data.activeUsers }
    ];
    grid.innerHTML = cards
      .map(
        (card) =>
          '<div class="admin-stat-card admin-stat-card--' +
          escapeHtml(card.tone) +
          '"><div class="admin-stat-label">' +
          escapeHtml(card.label) +
          '</div><div class="admin-stat-value">' +
          escapeHtml(String(card.value ?? "—")) +
          "</div></div>"
      )
      .join("");
  }

  function renderNotesByCategory(rows) {
    const el = document.getElementById("adminNotesByCategory");
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<p class="admin-muted">No notes in the database yet.</p>';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => r.count));
    el.innerHTML = rows
      .map((r) => {
        const pct = Math.round((r.count / max) * 100);
        const name = escapeHtml(String(r.category || "—"));
        return (
          '<div class="admin-bar-row">' +
          '<span class="admin-bar-name">' +
          name +
          "</span>" +
          '<div class="admin-bar-track"><div class="admin-bar-fill" style="width:' +
          pct +
          '%"></div></div>' +
          '<span class="admin-bar-count">' +
          escapeHtml(String(r.count)) +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function planBadge(plan) {
    if (plan === "premium") return '<span class="admin-badge admin-badge--premium">Premium</span>';
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
        const pl = effectivePlanFromUser(u);
        const badge = planBadge(pl);
        const on = u.activeNow
          ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
          : '<span class="admin-badge admin-badge--offline">Away</span>';
        const nc = Number(u.notesCount) || 0;
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
          escapeHtml(String(nc)) +
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

  function renderDashNotesTable(notes) {
    const tbody = document.querySelector("#adminDashNotesTable tbody");
    if (!tbody) return;
    tbody.innerHTML = (notes || [])
      .map(
        (n) =>
          "<tr>" +
          '<td class="admin-cell-muted">' +
          escapeHtml(fmtDate(n.createdAt)) +
          "</td>" +
          "<td>" +
          escapeHtml(n.username || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(n.category || "—") +
          "</td>" +
          '<td class="admin-cell-preview">' +
          escapeHtml(
            (n.title ? String(n.title).trim() + " — " : "") + (n.textPreview || "")
          ) +
          "</td>" +
          "</tr>"
      )
      .join("");
  }

  function reminderChannelPill(type) {
    const t = (type || "web").toLowerCase();
    if (t === "whatsapp") return '<span class="admin-pill admin-pill--wa">WhatsApp</span>';
    return '<span class="admin-pill admin-pill--web">Web</span>';
  }

  function reminderStatusPill(r) {
    if (r.sent) return '<span class="admin-pill admin-pill--ok">Sent</span>';
    const s = (r.status || "pending").toLowerCase();
    if (s === "failed") return '<span class="admin-pill admin-pill--fail">Failed</span>';
    return '<span class="admin-pill admin-pill--pend">Pending</span>';
  }

  function renderDashRemindersTable(rows) {
    const tbody = document.querySelector("#adminDashRemindersTable tbody");
    if (!tbody) return;
    tbody.innerHTML = (rows || [])
      .map(
        (r) =>
          "<tr>" +
          '<td class="admin-cell-muted">' +
          escapeHtml(fmtDate(r.time)) +
          "</td>" +
          "<td>" +
          escapeHtml(r.username || "—") +
          "</td>" +
          "<td>" +
          reminderChannelPill(r.notificationType) +
          "</td>" +
          "<td>" +
          reminderStatusPill(r) +
          "</td>" +
          '<td class="admin-cell-preview">' +
          escapeHtml(r.messagePreview || "—") +
          "</td>" +
          "</tr>"
      )
      .join("");
  }

  function renderAnalyticsPanels(data) {
    const analytics = (data && data.analytics) || {};
    const stats = (data && data.stats) || {};

    const grid = document.getElementById("adminAnalyticsGrid");
    if (grid) {
      const pro = stats.proUsers != null ? stats.proUsers : stats.premiumUsers;
      const mini = [
        { tone: "users", label: "Sign-ups (7d)", value: analytics.signupsLast7Days ?? "—" },
        { tone: "prem", label: "Pro users", value: pro ?? "—" },
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

    const remEl = document.getElementById("adminAnalyticsReminders");
    if (remEl) {
      const rows = analytics.remindersByStatus || [];
      if (!rows.length) {
        remEl.innerHTML = '<p class="admin-muted">No reminders data.</p>';
        return;
      }
      remEl.innerHTML =
        '<ul class="admin-analytics-status-list">' +
        rows
          .map((r) => {
            const st = escapeHtml(String(r.status || "—"));
            const c = escapeHtml(String(r.count ?? 0));
            return '<li><span>' + st + '</span><span class="admin-analytics-num">' + c + "</span></li>";
          })
          .join("") +
        "</ul>";
    }
  }

  function hydrateDashboard(data) {
    dashboardBundleCache = data;
    renderStats(data.stats || {});
    renderAnalyticsPanels(data);
    renderNotesByCategory(data.notesByCategory || []);
    renderDashUsersTable(data.recentUsers || []);
    renderDashNotesTable(data.recentNotes || []);
    renderDashRemindersTable(data.recentReminders || []);
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
          notesByCategory: [],
          recentNotes: [],
          recentReminders: [],
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

  async function loadDashboard() {
    const data = await fetchAdminDashboardBundle();
    hydrateDashboard(data);
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

    tbody.innerHTML = (list || [])
      .map((u) => {
        const plan = effectivePlanFromUser(u);
        const sr = effectiveStaffRole(u);
        const planHtml = planBadge(plan);
        const staffHtml = staffBadgeLabel(sr);
        const active =
          u.activeNow === true
            ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
            : '<span class="admin-badge admin-badge--offline">Offline</span>';
        const nc = Number(u.notesCount) || 0;
        const rc = Number(u.remindersCount) || 0;
        const fc = Number(u.invitedFriendsCount) || 0;
        return (
          '<tr class="admin-user-row" data-user-row="1" data-id="' +
          escapeHtml(String(u.id || "")) +
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
          nc +
          "</td>" +
          '<td class="admin-num-cell">' +
          rc +
          "</td>" +
          '<td class="admin-num-cell">' +
          fc +
          "</td>" +
          '<td class="admin-cell-muted">' +
          escapeHtml(fmtDate(u.createdAt)) +
          "</td>" +
          "<td>" +
          '<span class="admin-cell-muted">Open →</span>' +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  async function loadUsersPage() {
    usersFetchGen += 1;
    const gen = usersFetchGen;
    const qs = new URLSearchParams({
      page: String(usersState.page),
      limit: String(usersState.limit),
      ...(usersState.search.trim() ? { search: usersState.search.trim() } : {}),
      ...(usersState.tier === "premium" ? { tier: "premium" } : {})
    });
    const path = `/api/admin/users?${qs}`;
    try {
      const data = await apiJson(path, { method: "GET" });
      if (gen !== usersFetchGen) return;
      usersState.total = typeof data.total === "number" ? data.total : 0;
      usersState.totalPages = typeof data.totalPages === "number" ? data.totalPages : 1;
      (data.users || []).forEach(stashUser);
      renderUsersRows(data.users || []);
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
    }, 280);
  }

  async function loadSubscriptionsPanel() {
    const qs = new URLSearchParams({
      tier: "premium",
      limit: "50",
      page: "1"
    });
    const data = await apiJson(`/api/admin/users?${qs}`, { method: "GET" });
    const tbody = document.querySelector("#adminSubsTable tbody");
    if (!tbody) return;

    tbody.innerHTML = (data.users || [])
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
          planBadge(pl) +
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
      .join("");

    (data.users || []).forEach(stashUser);
    if (!(data.users || []).length) {
      tbody.innerHTML = '<tr><td colspan="6" class="admin-cell-muted">No premium matches yet.</td></tr>';
    }
    mergeCapabilityUi();
  }

  async function hydrateAnalyticsFromCache() {
    if (dashboardBundleCache) {
      renderAnalyticsPanels(dashboardBundleCache);
      return;
    }
    await loadDashboard();
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
    if (planBadgeEl) planBadgeEl.innerHTML = planBadge(plan);

    const staffBadgeEl = document.getElementById("adminDetailStaffBadge");
    const staffSel = effectiveStaffRole(user);
    if (staffBadgeEl) staffBadgeEl.innerHTML = staffBadgeLabel(staffSel);

    const activeHtml = user.activeNow
      ? '<span class="admin-badge admin-badge--yes">' + ACTIVE_LABEL + "</span>"
      : '<span class="admin-badge admin-badge--offline">Offline</span>';
    const activeEl = document.getElementById("adminDetailActive");
    if (activeEl) activeEl.innerHTML = activeHtml;

    document.getElementById("adminDetailNotesCount").textContent = String(Number(user.notesCount) || 0);
    document.getElementById("adminDetailRemindersCount").textContent = String(Number(user.remindersCount) || 0);
    document.getElementById("adminDetailInvitesCount").textContent = String(Number(user.invitedFriendsCount) || 0);
    document.getElementById("adminDetailPremiumExpires").textContent = user.premiumExpires
      ? fmtDate(user.premiumExpires)
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
    const data = await apiJson("/api/admin/config/discord", { method: "GET" });
    discordConfigCache = {
      discordInviteUrl: String((data && data.discordInviteUrl) || ""),
      discordUpdatesCount: Math.max(0, Number((data && data.discordUpdatesCount) || 0)),
      tiktokUrl: String((data && data.tiktokUrl) || ""),
      youtubeUrl: String((data && data.youtubeUrl) || "")
    };
    const urlInput = document.getElementById("adminDiscordInviteUrl");
    if (urlInput) urlInput.value = discordConfigCache.discordInviteUrl;
    const countInput = document.getElementById("adminDiscordUpdatesCount");
    if (countInput) countInput.value = String(discordConfigCache.discordUpdatesCount || 0);
    const tiktokInput = document.getElementById("adminTiktokUrl");
    if (tiktokInput) tiktokInput.value = discordConfigCache.tiktokUrl;
    const youtubeInput = document.getElementById("adminYoutubeUrl");
    if (youtubeInput) youtubeInput.value = discordConfigCache.youtubeUrl;
  }

  function setNavActive(panel) {
    document.querySelectorAll(".admin-nav-item").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-panel") === panel);
    });
    document.querySelectorAll(".admin-panel").forEach((sec) => {
      sec.classList.toggle("hidden", sec.id !== "panel-" + panel);
    });
  }

  async function goPanel(panel) {
    setNavActive(panel);
    setAlert("");
    try {
      if (panel === "dashboard") await loadDashboard();
      if (panel === "users") {
        await loadUsersPage();
      }
      if (panel === "subscriptions") await loadSubscriptionsPanel();
      if (panel === "analytics") await hydrateAnalyticsFromCache();
      if (panel === "settings") {
        await Promise.all([loadDiscordConfig(), loadMessages()]);
      }
    } catch (err) {
      setAlert(err.message, "error");
    }
    mergeCapabilityUi();
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
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const go = t.getAttribute("data-go");
    if (go) {
      await goPanel(go);
      return;
    }

    const act = t.getAttribute("data-act");
    if (act === "refresh-dashboard") {
      try {
        await loadDashboard();
        setAlert("Dashboard refreshed.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "refresh-analytics") {
      try {
        await loadDashboard();
        setAlert("Analytics refreshed.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
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
      try {
        await loadSubscriptionsPanel();
        setAlert("Subscription list refreshed.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "users-page") {
      const dir = t.getAttribute("data-dir");
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
      const discordInviteUrl = urlInput ? String(urlInput.value || "").trim() : "";
      const discordUpdatesCount = countInput ? Math.max(0, Number(countInput.value || 0)) : 0;
      const tiktokUrl = tiktokInput ? String(tiktokInput.value || "").trim() : "";
      const youtubeUrl = youtubeInput ? String(youtubeInput.value || "").trim() : "";
      try {
        await apiJson("/api/admin/config/discord", {
          method: "PUT",
          body: JSON.stringify({ discordInviteUrl, discordUpdatesCount, tiktokUrl, youtubeUrl })
        });
        setAlert("Community links saved.", "info");
        await loadDiscordConfig();
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "grant-premium") {
      const preset = t.getAttribute("data-preset");
      if (!(caps && caps.capabilities && caps.capabilities.canGrantPremium)) return;
      if (!selectedUserId || !preset) return;
      try {
        const out = await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId) + "/grant-premium", {
          method: "POST",
          body: JSON.stringify({ preset })
        });
        if (out && out.user) stashUser(out.user);
        setAlert("Premium grant applied.", "info");
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
      const id = t.getAttribute("data-id");
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
      if (plan !== "free" && plan !== "standard" && plan !== "premium") return;
      try {
        const out = await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId) + "/plan", {
          method: "PATCH",
          body: JSON.stringify({ plan })
        });
        if (out && out.user) stashUser(out.user);
        setAlert("Plan updated.", "info");
        await Promise.all([loadUsersPage(), loadDashboard()]);
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
      const id = t.getAttribute("data-id");
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

  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const panel = btn.getAttribute("data-panel");
      await goPanel(panel);
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
      usersState.limit = Math.min(100, Math.max(5, parseInt(pageSize.value || "25", 10)));
      usersState.page = 1;
      await loadUsersPage();
    });
  }

  const messagesFilterEl = document.getElementById("adminMessagesFilter");
  if (messagesFilterEl) {
    messagesFilterEl.addEventListener("input", () => {
      clearTimeout(messagesFilterTimer);
      messagesFilterTimer = setTimeout(() => applyMessagesFilter(), 180);
    });
  }

  const userDetailsModal = document.getElementById("adminUserDetailsModal");
  if (userDetailsModal) {
    userDetailsModal.addEventListener("click", (ev) => {
      if (ev.target === userDetailsModal) closeUserDetailsModal();
    });
  }

  document.addEventListener("keydown", (evt) => {
    const maybeRow = evt.target instanceof Element ? evt.target.closest("tr[data-user-row='1']") : null;
    if (maybeRow && (evt.key === "Enter" || evt.key === " ")) {
      evt.preventDefault();
      const rid = maybeRow.getAttribute("data-id");
      if (rid) void openUserDetailsModal(rid);
      return;
    }
    if (evt.key === "Escape") {
      const modal = document.getElementById("adminUserDetailsModal");
      if (modal && !modal.classList.contains("hidden")) closeUserDetailsModal();
    }
  });

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
    hydrateDashboard(dash);
    mergeCapabilityUi();
  }

  init();
})();
