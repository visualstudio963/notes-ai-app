(function () {
  const ACTIVE_LABEL = "Active (recent)";
  const API_BASE_URL = "https://notes-ai-backend-lykf.onrender.com";

  let usersCache = [];
  let messagesCache = [];
  let usersFilterTimer = null;
  let messagesFilterTimer = null;
  let selectedUserId = "";
  let discordConfigCache = { discordInviteUrl: "", discordUpdatesCount: 0 };

  function buildApiUrl(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return API_BASE_URL;
    if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
    return `${API_BASE_URL}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
  }

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

  function renderStats(data) {
    const grid = document.getElementById("adminStats");
    if (!grid) return;
    const mins = data.activeWithinMinutes != null ? String(data.activeWithinMinutes) : "7";
    const cards = [
      { tone: "users", label: "Total users", value: data.totalUsers },
      { tone: "notes", label: "Total notes", value: data.totalNotes },
      { tone: "rem", label: "Total reminders", value: data.totalReminders },
      { tone: "prem", label: "Premium users", value: data.premiumUsers },
      { tone: "live", label: ACTIVE_LABEL + " (~" + mins + " min)", value: data.activeUsers }
    ];
    grid.innerHTML = cards
      .map(
        (c) =>
          '<div class="admin-stat-card admin-stat-card--' +
          escapeHtml(c.tone) +
          '"><div class="admin-stat-label">' +
          escapeHtml(c.label) +
          '</div><div class="admin-stat-value">' +
          escapeHtml(String(c.value ?? "—")) +
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

  function renderDashUsersTable(users) {
    const tbody = document.querySelector("#adminDashUsersTable tbody");
    if (!tbody) return;
    tbody.innerHTML = (users || [])
      .map((u) => {
        const prem = u.isPremium
          ? '<span class="admin-badge admin-badge--yes">Yes</span>'
          : '<span class="admin-badge admin-badge--no">No</span>';
        return (
          "<tr>" +
          "<td><strong>" +
          escapeHtml(u.username) +
          "</strong><div class=\"admin-cell-muted\">" +
          escapeHtml(u.email || "") +
          "</div></td>" +
          "<td>" +
          prem +
          "</td>" +
          "<td class=\"admin-cell-muted\">" +
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

  function hydrateDashboard(data) {
    renderStats(data.stats || {});
    renderNotesByCategory(data.notesByCategory || []);
    renderDashUsersTable(data.recentUsers || []);
    renderDashNotesTable(data.recentNotes || []);
    renderDashRemindersTable(data.recentReminders || []);
  }

  /**
   * Prefer /admin/dashboard; if it is missing or errors (e.g. old server), fall back to /admin/stats only.
   */
  async function fetchAdminDashboardBundle() {
    try {
      return await apiJson("/api/admin/dashboard", { method: "GET" });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) throw err;
      try {
        const stats = await apiJson("/api/admin/stats", { method: "GET" });
        return {
          stats,
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

  const meUser = getStoredUser();
  const selfId = meUser && meUser.id ? String(meUser.id) : "";

  function normalizePlan(value) {
    if (value === "premium" || value === "standard" || value === "free") return value;
    return "free";
  }

  function effectivePlanFromUser(u) {
    return normalizePlan(u && (u.plan || u.membershipRole || u.subscriptionPlan));
  }

  function getUserById(id) {
    const sid = String(id || "");
    return usersCache.find((u) => String(u.id) === sid) || null;
  }

  function closeUserDetailsModal() {
    selectedUserId = "";
    const modal = document.getElementById("adminUserDetailsModal");
    if (modal) modal.classList.add("hidden");
  }

  function openUserDetailsModal(id) {
    const user = getUserById(id);
    if (!user) return;
    selectedUserId = String(user.id);

    const modal = document.getElementById("adminUserDetailsModal");
    if (!modal) return;

    const plan = effectivePlanFromUser(user);
    const planText =
      plan === "premium"
        ? '<span class="admin-badge admin-badge--premium">Premium</span>'
        : plan === "standard"
          ? '<span class="admin-badge admin-badge--standard">Standard</span>'
          : '<span class="admin-badge admin-badge--free">Free</span>';
    const activeText = user.activeNow
      ? '<span class="admin-badge admin-badge--yes">Yes</span>'
      : '<span class="admin-badge admin-badge--no">No</span>';

    const setText = (idEl, value) => {
      const el = document.getElementById(idEl);
      if (el) el.textContent = value;
    };
    setText("adminDetailUsername", user.username || "—");
    setText("adminDetailEmail", user.email || "—");
    setText("adminDetailPhone", user.phone || "—");
    setText("adminDetailCreated", fmtDate(user.createdAt));
    setText("adminDetailUserId", String(user.id || "—"));

    const planEl = document.getElementById("adminDetailPlanBadge");
    if (planEl) planEl.innerHTML = planText;
    const activeEl = document.getElementById("adminDetailActive");
    if (activeEl) activeEl.innerHTML = activeText;

    const select = document.getElementById("adminDetailPlanSelect");
    if (select) select.value = plan;

    const delBtn = document.getElementById("adminDetailDeleteBtn");
    if (delBtn) {
      delBtn.disabled = String(user.id) === selfId;
      delBtn.title = String(user.id) === selfId ? "You cannot delete your own account here" : "";
    }

    modal.classList.remove("hidden");
  }

  function buildUsersRows(list) {
    return (list || [])
      .map((u) => {
        const plan = effectivePlanFromUser(u);
        const planBadge =
          plan === "premium"
            ? '<span class="admin-badge admin-badge--premium">Premium</span>'
            : plan === "standard"
              ? '<span class="admin-badge admin-badge--standard">Standard</span>'
              : '<span class="admin-badge admin-badge--free">Free</span>';
        const act = u.activeNow
          ? '<span class="admin-badge admin-badge--yes">Yes</span>'
          : '<span class="admin-badge admin-badge--no">No</span>';
        return (
          '<tr class="admin-user-row" data-user-row="1" data-id="' +
          escapeHtml(String(u.id || "")) +
          '" tabindex="0" role="button" aria-label="Open user details for ' +
          escapeHtml(u.username || "user") +
          '">' +
          "<td>" +
          escapeHtml(u.username) +
          "</td>" +
          "<td>" +
          escapeHtml(u.email || "") +
          "</td>" +
          "<td>" +
          escapeHtml(u.phone || "—") +
          "</td>" +
          "<td>" +
          planBadge +
          "</td>" +
          "<td>" +
          act +
          "</td>" +
          "<td>" +
          escapeHtml(fmtDate(u.createdAt)) +
          "</td>" +
          "<td>" +
          '<span class="admin-cell-muted">Click row to manage</span>' +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  function applyUsersFilter() {
    const tbody = document.querySelector("#adminUsersTable tbody");
    if (!tbody) return;
    const q = (document.getElementById("adminUsersFilter")?.value || "").trim().toLowerCase();
    if (!q) {
      tbody.innerHTML = buildUsersRows(usersCache);
      return;
    }
    const filtered = usersCache.filter((u) => {
      const planLabel = effectivePlanFromUser(u);
      const hay = [u.username, u.email, u.phone, String(u.id || ""), planLabel]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    tbody.innerHTML = buildUsersRows(filtered);
  }

  async function loadUsers() {
    const data = await apiJson("/api/admin/users", { method: "GET" });
    usersCache = (data.users || []).map((u) => ({
      ...u,
      plan: effectivePlanFromUser(u),
      membershipRole: effectivePlanFromUser(u)
    }));
    applyUsersFilter();
  }

  function buildMessagesRows(list) {
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
          '<button type="button" class="admin-btn admin-btn--danger" data-act="del-msg" data-id="' +
          escapeHtml(String(m.id)) +
          '">Delete</button>' +
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
  }

  async function loadDiscordConfig() {
    const data = await apiJson("/api/admin/config/discord", { method: "GET" });
    discordConfigCache = {
      discordInviteUrl: String((data && data.discordInviteUrl) || ""),
      discordUpdatesCount: Math.max(0, Number((data && data.discordUpdatesCount) || 0))
    };
    const urlInput = document.getElementById("adminDiscordInviteUrl");
    if (urlInput) urlInput.value = discordConfigCache.discordInviteUrl;
    const countInput = document.getElementById("adminDiscordUpdatesCount");
    if (countInput) countInput.value = String(discordConfigCache.discordUpdatesCount || 0);
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
      if (panel === "users") await loadUsers();
      if (panel === "messages") await loadMessages();
      if (panel === "discord") await loadDiscordConfig();
    } catch (err) {
      setAlert(err.message, "error");
    }
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
    if (act === "reload-users") {
      try {
        await loadUsers();
        setAlert("Users reloaded.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "reload-messages") {
      try {
        await loadMessages();
        setAlert("Messages reloaded.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "reload-discord-config") {
      try {
        await loadDiscordConfig();
        setAlert("Discord config reloaded.", "info");
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "save-discord-config") {
      const urlInput = document.getElementById("adminDiscordInviteUrl");
      const countInput = document.getElementById("adminDiscordUpdatesCount");
      const discordInviteUrl = urlInput ? String(urlInput.value || "").trim() : "";
      const discordUpdatesCount = countInput ? Math.max(0, Number(countInput.value || 0)) : 0;
      try {
        await apiJson("/api/admin/config/discord", {
          method: "PUT",
          body: JSON.stringify({ discordInviteUrl, discordUpdatesCount })
        });
        setAlert("Discord config saved.", "info");
        await loadDiscordConfig();
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
      if (!selectedUserId) return;
      const planSelect = document.getElementById("adminDetailPlanSelect");
      const plan = planSelect ? planSelect.value : "";
      if (plan !== "free" && plan !== "standard" && plan !== "premium") return;
      try {
        await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId) + "/plan", {
          method: "PATCH",
          body: JSON.stringify({ plan })
        });
        setAlert("Plan updated.", "info");
        await loadUsers();
        await loadDashboard();
        openUserDetailsModal(selectedUserId);
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "copy-id-from-details") {
      if (!selectedUserId) return;
      try {
        await navigator.clipboard.writeText(selectedUserId);
        setAlert("User id copied to clipboard.", "info");
      } catch {
        setAlert("Could not copy (clipboard blocked). Id: " + escapeHtml(selectedUserId), "error");
      }
      return;
    }
    if (act === "del-user-from-details") {
      if (!selectedUserId) return;
      if (String(selectedUserId) === selfId) {
        setAlert("You cannot delete your own account here.", "error");
        return;
      }
      if (!confirm("Delete this user and all their notes and reminders?")) return;
      try {
        await apiJson("/api/admin/users/" + encodeURIComponent(selectedUserId), { method: "DELETE" });
        setAlert("User deleted.", "info");
        closeUserDetailsModal();
        await loadUsers();
        await loadDashboard();
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "del-user") {
      const id = t.getAttribute("data-id");
      if (!confirm("Delete this user and all their notes and reminders?")) return;
      try {
        await apiJson("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" });
        setAlert("User deleted.", "info");
        await loadUsers();
        await loadDashboard();
      } catch (err) {
        setAlert(err.message, "error");
      }
      return;
    }
    if (act === "del-msg") {
      const id = t.getAttribute("data-id");
      if (!confirm("Delete this message?")) return;
      try {
        await apiJson("/api/admin/messages/" + encodeURIComponent(id), { method: "DELETE" });
        setAlert("Message deleted.", "info");
        await loadMessages();
      } catch (err) {
        setAlert(err.message, "error");
      }
    }

    const row = t.closest("tr[data-user-row='1']");
    if (row) {
      const id = row.getAttribute("data-id");
      if (id) openUserDetailsModal(id);
    }
  });

  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const panel = btn.getAttribute("data-panel");
      await goPanel(panel);
    });
  });

  const usersFilterEl = document.getElementById("adminUsersFilter");
  if (usersFilterEl) {
    usersFilterEl.addEventListener("input", () => {
      clearTimeout(usersFilterTimer);
      usersFilterTimer = setTimeout(() => applyUsersFilter(), 180);
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
    userDetailsModal.addEventListener("click", (e) => {
      if (e.target === userDetailsModal) {
        closeUserDetailsModal();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    const row = e.target instanceof Element ? e.target.closest("tr[data-user-row='1']") : null;
    if (row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      const id = row.getAttribute("data-id");
      if (id) openUserDetailsModal(id);
      return;
    }
    if (e.key === "Escape") {
      const modal = document.getElementById("adminUserDetailsModal");
      if (modal && !modal.classList.contains("hidden")) {
        closeUserDetailsModal();
      }
    }
  });

  async function init() {
    const user = getStoredUser();
    const un = document.getElementById("adminUsername");
    if (un && user) un.textContent = user.username || user.emailOrPhone || "—";

    if (!getAccessToken() && !getRefreshToken()) {
      showGate("Log in from the main app first, then open this page again.");
      return;
    }

    let initialData;
    try {
      initialData = await fetchAdminDashboardBundle();
    } catch (err) {
      if (err.status === 403) {
        showGate("Access denied. Your account is not an admin.");
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
    hydrateDashboard(initialData);
  }

  init();
})();
