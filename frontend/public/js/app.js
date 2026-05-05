let currentCategory = "";
let currentNotes = [];
let allNotes = [];
/** @type {object[]} */
let historyRemindersRaw = [];
let historyFilterMode = "all";
let historySortMode = "due-asc";
let historySearchTimer = null;
let notesFilterTimer = null;
const HISTORY_COLUMN_LIMIT = 5;
let historyPruneInFlight = false;
let allNotesSortMode = "newest";
let currentUser = getStoredUser();
let accessToken = getStoredAccessToken();
let refreshToken = getStoredRefreshToken();

/** @type {{ mode: "create" | "edit"; origin: "category" | "all"; editingNote: object | null }} */
let noteEditorState = { mode: "create", origin: "category", editingNote: null, presetCategory: null };

const webNotificationLock = new Set();

/** @type {MediaStream | null} */
let scanCamMediaStream = null;
/** @type {string | null} */
let scanCamPdfObjectUrl = null;
/** @type {null | ((ev: KeyboardEvent) => void)} */
let scanCamDocSheetEscHandler = null;

/** @type {import("tesseract.js").Worker | null} */
let scanCamTesseractWorker = null;
/** @type {Promise<import("tesseract.js").Worker> | null} */
let scanCamTesseractInitPromise = null;
let scanCamPdfWorkerConfigured = false;

/** Max PDF pages to OCR (keeps browser responsive on large files). */
const SCAN_CAM_PDF_OCR_MAX_PAGES = 20;

/** Client-only Scan Cam notes (simulation; no OCR/backend persistence for these ids). */
const SCAN_CAM_LOCAL_STORAGE_KEY = "aiNotesScanCamSimulated";
const SCAN_CAM_ONBOARDING_KEY = "aiNotesScanCamOnboardingDismissed";

/** Free tier (base Chat Bot): total user sends on this device while on Free, persisted in localStorage. */
const WEB_CHAT_MODE_KEY = "aiNotesWebChatMode";
const WEB_CHAT_RECENT_COMMANDS_KEY = "aiNotesWebChatRecentCmds";
const DAILY_PLANNER_KEY_PREFIX = "aiNotesDailyPlanner";
const DAILY_PLANNER_NOTIFIED_KEY_PREFIX = "aiNotesDailyPlannerNotified";
/** Max prior turns kept for Web Chat session memory (OpenAI context). */
const WEB_CHAT_SESSION_MAX = 16;
/** Warn when monthly OpenAI replies remaining are at or below this number (Premium). */
const WEB_CHAT_OPENAI_NEAR_WARN = 15;
let webChatAiLiveTimer = null;
/** Last user line that looked like a natural reminder (for follow-ups like “ndërro në 14:00”). */
let webChatLastReminderUserRaw = null;
/** @type {{ role: "user" | "bot"; text: string }[]} */
let webChatSessionTurns = [];

const WEB_CHAT_BOT_AVATAR_SVG = `<svg class="web-chat-avatar__svg" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#0f172a" stroke="#38bdf8" stroke-width="1.2"/><circle cx="15" cy="18" r="1.8" fill="#e2e8f0"/><circle cx="25" cy="18" r="1.8" fill="#e2e8f0"/><path d="M14 24c2.2 2.8 9.8 2.8 12 0" stroke="#64748b" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>`;

/** IntersectionObserver for light scroll-in (transform + opacity only). */
let depthRevealObserver = null;
let premiumTiltEnabled = false;
let dailyPlannerMidnightTimer = null;
let dailyPlannerNotifyTimer = null;
let dailyPlannerCompletedOpen = false;
let dailyPlannerLastAddedTaskId = "";
let dailyPlannerMovedTaskId = "";
let localNotificationPermissionAsked = false;
let settingsActiveSection = "account";
let webChatUnreadCount = 0;
let webChatFabTipTimer = null;
let webChatFabPromptCycleTimer = null;
let premiumLiteBillingMode = "monthly";
let discordCommunityUrl = "";
let discordUpdatesCount = 0;
let tiktokCommunityUrl = "";
let youtubeCommunityUrl = "";
let stripePublishableKey = "";
/** Set from GET /api/public/app-config (GOOGLE_CLIENT_ID). Used by Sign in with Google. */
let googleOAuthClientId = "";
/** True after `/api/public/app-config` finishes (success or failure). Avoids blocking OAuth before config loads. */
let googleOAuthConfigLoaded = false;
/** Coalesces overlapping /api/public/app-config fetches (e.g. DOMContentLoaded + goHome). */
let loadDiscordCommunityConfigInflight = null;
const REMINDER_NOTIFY_PREFS_KEY = "webReminderNotificationPrefs";
const ANDROID_REMINDERS_CHANNEL_ID = "reminders-high";

function isNativeLocalNotificationsAvailable() {
  return Boolean(
    window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform() &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.LocalNotifications
  );
}

function getLocalNotificationsPlugin() {
  if (!isNativeLocalNotificationsAvailable()) return null;
  return window.Capacitor.Plugins.LocalNotifications;
}

function hashNotificationId(seed, offset = 0) {
  const text = String(seed || "");
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  const positive = Math.abs(h);
  return (positive % 1000000000) + 1000 + offset;
}

function plannerNotificationId(taskId, dateKey = dailyPlannerTodayKey()) {
  return hashNotificationId(`planner:${dateKey}:${String(taskId || "")}`);
}

function reminderNotificationId(reminderId) {
  return hashNotificationId(`reminder:${String(reminderId || "")}`, 1);
}

function readReminderNotificationPrefs() {
  try {
    const raw = localStorage.getItem(REMINDER_NOTIFY_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeReminderNotificationPrefs(prefs) {
  try {
    localStorage.setItem(REMINDER_NOTIFY_PREFS_KEY, JSON.stringify(prefs || {}));
  } catch {
    /* ignore */
  }
}

function isReminderNotificationEnabled(reminderId) {
  const prefs = readReminderNotificationPrefs();
  const key = String(reminderId || "");
  return prefs[key] !== false;
}

function setReminderNotificationEnabled(reminderId, enabled) {
  const key = String(reminderId || "");
  if (!key) return;
  const prefs = readReminderNotificationPrefs();
  prefs[key] = !!enabled;
  writeReminderNotificationPrefs(prefs);
}

async function requestNotificationPermissionIfNeeded(forceAsk = false) {
  if (isNativeLocalNotificationsAvailable()) {
    const localNotifications = getLocalNotificationsPlugin();
    if (!localNotifications) return false;
    try {
      const current = await localNotifications.checkPermissions();
      if (current && current.display === "granted") return true;
      if (!forceAsk && localNotificationPermissionAsked) return false;
      localNotificationPermissionAsked = true;
      const requested = await localNotifications.requestPermissions();
      return !!(requested && requested.display === "granted");
    } catch {
      return false;
    }
  }

  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (!forceAsk && localNotificationPermissionAsked) return false;
  localNotificationPermissionAsked = true;
  try {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  } catch {
    return false;
  }
}

async function ensureNativeNotificationChannel() {
  if (!isNativeLocalNotificationsAvailable()) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications || typeof localNotifications.createChannel !== "function") return;
  try {
    await localNotifications.createChannel({
      id: ANDROID_REMINDERS_CHANNEL_ID,
      name: "Reminders",
      description: "High priority reminders and planner alerts",
      importance: 5,
      visibility: 1,
      sound: "default",
      vibration: true,
      lights: true
    });
  } catch {
    /* ignore */
  }
}

function dailyPlannerTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dailyPlannerStorageKey(dateKey = dailyPlannerTodayKey()) {
  return `${DAILY_PLANNER_KEY_PREFIX}:${dateKey}`;
}

function dailyPlannerNotifiedStorageKey(dateKey = dailyPlannerTodayKey()) {
  return `${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:${dateKey}`;
}

function readDailyPlannerTasks() {
  try {
    const raw = localStorage.getItem(dailyPlannerStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => ({
        id: String((x && x.id) || ""),
        text: String((x && x.text) || "").trim(),
        time: String((x && x.time) || "").trim(),
        done: !!(x && x.done),
        notificationEnabled: !!(x && x.notificationEnabled)
      }))
      .filter((x) => x.id && x.text);
  } catch {
    return [];
  }
}

function writeDailyPlannerTasks(tasks) {
  try {
    localStorage.setItem(dailyPlannerStorageKey(), JSON.stringify(tasks));
  } catch {
    /* ignore */
  }
}

function cleanupDailyPlannerStorage() {
  try {
    const todayKey = dailyPlannerTodayKey();
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(`${DAILY_PLANNER_KEY_PREFIX}:`)) {
        const dateKey = k.slice(`${DAILY_PLANNER_KEY_PREFIX}:`.length);
        if (dateKey && dateKey !== todayKey) keys.push(k);
        continue;
      }
      if (k.startsWith(`${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:`)) {
        const dateKey = k.slice(`${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:`.length);
        if (dateKey && dateKey !== todayKey) keys.push(k);
        continue;
      }
      if (k === DAILY_PLANNER_KEY_PREFIX || k === DAILY_PLANNER_NOTIFIED_KEY_PREFIX) {
        keys.push(k);
      }
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

function readDailyPlannerNotifiedSet() {
  try {
    const raw = localStorage.getItem(dailyPlannerNotifiedStorageKey());
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => String(x || "")));
  } catch {
    return new Set();
  }
}

function writeDailyPlannerNotifiedSet(set) {
  try {
    localStorage.setItem(dailyPlannerNotifiedStorageKey(), JSON.stringify(Array.from(set)));
  } catch {
    /* ignore */
  }
}

function plannerTaskToDate(task, dateBase = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String((task && task.time) || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return new Date(dateBase.getFullYear(), dateBase.getMonth(), dateBase.getDate(), hh, mm, 0, 0);
}

async function cancelPlannerLocalNotification(taskId, dateKey = dailyPlannerTodayKey()) {
  if (!isNativeLocalNotificationsAvailable()) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  try {
    await localNotifications.cancel({
      notifications: [{ id: plannerNotificationId(taskId, dateKey) }]
    });
  } catch {
    /* ignore */
  }
}

async function schedulePlannerLocalNotification(task) {
  if (!isNativeLocalNotificationsAvailable()) return;
  if (!task || !task.id || !task.notificationEnabled || !task.time || task.done) return;
  const when = plannerTaskToDate(task);
  if (!when || when.getTime() <= Date.now()) return;
  const allowed = await requestNotificationPermissionIfNeeded(true);
  if (!allowed) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  const id = plannerNotificationId(task.id);
  try {
    await localNotifications.cancel({ notifications: [{ id }] });
    await localNotifications.schedule({
      notifications: [
        {
          id,
          title: "Reminder ⏰",
          body: String(task.text || "").slice(0, 180),
          schedule: { at: when, allowWhileIdle: true },
          sound: "default",
          channelId: ANDROID_REMINDERS_CHANNEL_ID
        }
      ]
    });
  } catch {
    /* ignore */
  }
}

async function syncPlannerLocalNotifications() {
  if (!isNativeLocalNotificationsAvailable()) return;
  const tasks = readDailyPlannerTasks();
  const today = dailyPlannerTodayKey();
  const ids = tasks.map((task) => plannerNotificationId(task.id, today));
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  try {
    if (ids.length) {
      await localNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    }
    for (const task of tasks) {
      // Schedule only active, future tasks with enabled notifications.
      // eslint-disable-next-line no-await-in-loop
      await schedulePlannerLocalNotification(task);
    }
  } catch {
    /* ignore */
  }
}

async function cancelReminderLocalNotification(reminderId) {
  if (!isNativeLocalNotificationsAvailable()) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  try {
    await localNotifications.cancel({
      notifications: [{ id: reminderNotificationId(reminderId) }]
    });
  } catch {
    /* ignore */
  }
}

async function scheduleReminderLocalNotification(reminder) {
  if (!isNativeLocalNotificationsAvailable()) return;
  if (!reminder || !reminder._id || !reminder.time || reminder.sent) return;
  if (!isReminderNotificationEnabled(reminder._id)) return;
  const when = new Date(reminder.time);
  if (!Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) return;
  const allowed = await requestNotificationPermissionIfNeeded(true);
  if (!allowed) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  const id = reminderNotificationId(reminder._id);
  try {
    await localNotifications.cancel({ notifications: [{ id }] });
    await localNotifications.schedule({
      notifications: [
        {
          id,
          title: "Reminder ⏰",
          body: String(reminder.message || t("reminderDefaultBody")).slice(0, 180),
          schedule: { at: when, allowWhileIdle: true },
          sound: "default",
          channelId: ANDROID_REMINDERS_CHANNEL_ID
        }
      ]
    });
  } catch {
    /* ignore */
  }
}

async function syncReminderLocalNotifications(reminders) {
  if (!isNativeLocalNotificationsAvailable()) return;
  const list = Array.isArray(reminders) ? reminders : [];
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  try {
    const ids = list.map((r) => reminderNotificationId(r._id));
    if (ids.length) {
      await localNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
    }
    for (const reminder of list) {
      // eslint-disable-next-line no-await-in-loop
      await scheduleReminderLocalNotification(reminder);
    }
  } catch {
    /* ignore */
  }
}

function dailyPlannerMaybeTriggerNotifications() {
  if (isNativeLocalNotificationsAvailable()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const tasks = readDailyPlannerTasks();
  if (!tasks.length) return;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const notified = readDailyPlannerNotifiedSet();
  let changed = false;
  for (const task of tasks) {
    if (!task.notificationEnabled || task.done || !task.time) continue;
    if (notified.has(task.id)) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(task.time);
    if (!m) continue;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    if (mins !== nowMins) continue;
    try {
      const n = new Notification(t("webNotificationTitle"), {
        body: task.text,
        icon: "/icons/icon-192.png"
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* ignore */
    }
    notified.add(task.id);
    changed = true;
  }
  if (changed) writeDailyPlannerNotifiedSet(notified);
}

function scheduleDailyPlannerNotificationLoop() {
  if (isNativeLocalNotificationsAvailable()) {
    void syncPlannerLocalNotifications();
    return;
  }
  if (dailyPlannerNotifyTimer) window.clearInterval(dailyPlannerNotifyTimer);
  dailyPlannerNotifyTimer = window.setInterval(dailyPlannerMaybeTriggerNotifications, 30000);
  dailyPlannerMaybeTriggerNotifications();
}

function scheduleDailyPlannerMidnightReset() {
  if (dailyPlannerMidnightTimer) window.clearTimeout(dailyPlannerMidnightTimer);
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
  const wait = Math.max(1000, nextMidnight.getTime() - now.getTime());
  dailyPlannerMidnightTimer = window.setTimeout(() => {
    cleanupDailyPlannerStorage();
    renderDailyPlannerList();
    scheduleDailyPlannerMidnightReset();
  }, wait);
}

function escapeHtmlAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

function renderDailyPlannerList() {
  const list = document.getElementById("dailyPlannerList");
  const progress = document.getElementById("dailyPlannerProgress");
  if (!list) return;
  const tasks = readDailyPlannerTasks();
  const doneCount = tasks.filter((x) => x.done).length;
  const total = tasks.length;
  if (progress) {
    const label = t("dailyPlannerProgressLabel")
      .replace("{done}", String(doneCount))
      .replace("{total}", String(total));
    progress.innerHTML = `<div class="daily-planner-progress__line"><span>${escapeHtml(label)}</span></div><div class="daily-planner-progress__track"><span style="width:${total ? Math.round((doneCount / total) * 100) : 0}%"></span></div>`;
  }
  if (!tasks.length) {
    list.innerHTML = `<p class="daily-planner-empty" data-t="dailyPlannerEmpty">${escapeHtml(
      t("dailyPlannerEmpty")
    )}</p>`;
    if (typeof applyTranslations === "function") applyTranslations();
    return;
  }
  const todo = tasks.filter((x) => !x.done);
  const completed = tasks.filter((x) => x.done);
  const todoHtml = todo
    .map((task) => {
      const doneClass = "";
      const hasTime = !!task.time;
      const timeHtml = hasTime ? `<span class="daily-planner-item__time">${escapeHtml(task.time)}</span>` : "";
      const bellHtml = hasTime
        ? `<button type="button" class="daily-planner-item__bell${
            task.notificationEnabled ? " is-on" : ""
          }" onclick="dailyPlannerToggleNotification('${escapeHtmlAttr(task.id)}', this)" aria-label="Toggle reminder bell">🔔</button>`
        : "";
      const justAdded = task.id === dailyPlannerLastAddedTaskId ? " daily-planner-item--new" : "";
      return `<div class="daily-planner-item${doneClass}${justAdded}" data-daily-task-id="${escapeHtmlAttr(task.id)}">
        <button type="button" class="daily-planner-item__toggle" onclick="dailyPlannerToggleTask('${escapeHtmlAttr(
          task.id
        )}')" aria-label="Mark task complete" aria-pressed="false"><span class="daily-planner-item__toggle-check">✓</span></button>
        <div class="daily-planner-item__text-wrap">
          <span class="daily-planner-item__text">${escapeHtml(task.text)}</span>
          ${timeHtml}
        </div>
        <div class="daily-planner-item__meta">
          ${bellHtml}
        </div>
      </div>`;
    })
    .join("");
  const completedHtml = completed
    .map((task) => {
      const doneClass = " is-done";
      const hasTime = !!task.time;
      const timeHtml = hasTime ? `<span class="daily-planner-item__time">${escapeHtml(task.time)}</span>` : "";
      const bellHtml = hasTime
        ? `<button type="button" class="daily-planner-item__bell${
            task.notificationEnabled ? " is-on" : ""
          }" onclick="dailyPlannerToggleNotification('${escapeHtmlAttr(task.id)}', this)" aria-label="Toggle reminder bell">🔔</button>`
        : "";
      const moved = task.id === dailyPlannerMovedTaskId ? " daily-planner-item--moved" : "";
      return `<div class="daily-planner-item${doneClass}${moved}" data-daily-task-id="${escapeHtmlAttr(task.id)}">
        <button type="button" class="daily-planner-item__toggle" onclick="dailyPlannerToggleTask('${escapeHtmlAttr(
          task.id
        )}')" aria-label="Mark task not done" aria-pressed="true"><span class="daily-planner-item__toggle-check">✓</span></button>
        <div class="daily-planner-item__text-wrap">
          <span class="daily-planner-item__text">${escapeHtml(task.text)}</span>
          ${timeHtml}
        </div>
        <div class="daily-planner-item__meta">
          ${bellHtml}
        </div>
      </div>`;
    })
    .join("");
  list.innerHTML = `<section class="daily-planner-group">
    <div class="daily-planner-group__head"><h3>Për t'u bërë</h3><span>${todo.length}</span></div>
    <div class="daily-planner-group__body">${todoHtml || `<p class="daily-planner-empty">${escapeHtml(t("dailyPlannerEmpty"))}</p>`}</div>
  </section>
  <section class="daily-planner-group daily-planner-group--completed">
    <button type="button" class="daily-planner-group__head daily-planner-group__toggle" onclick="toggleDailyPlannerCompleted()">
      <h3>Të përfunduara</h3><span>${completed.length} ${dailyPlannerCompletedOpen ? "▾" : "▸"}</span>
    </button>
    <div class="daily-planner-group__body${dailyPlannerCompletedOpen ? "" : " hidden"}">${completedHtml || ""}</div>
  </section>`;
  if (dailyPlannerLastAddedTaskId) {
    window.setTimeout(() => {
      dailyPlannerLastAddedTaskId = "";
    }, 280);
  }
  if (dailyPlannerMovedTaskId) {
    window.setTimeout(() => {
      dailyPlannerMovedTaskId = "";
    }, 320);
  }
}

function toggleDailyPlannerCompleted() {
  dailyPlannerCompletedOpen = !dailyPlannerCompletedOpen;
  renderDailyPlannerList();
}

function userHasDailyPlannerAccess() {
  return Boolean(currentUser) && typeof userHasStandardTierFeatures === "function" && userHasStandardTierFeatures(currentUser);
}

function syncDailyPlannerAccessUi() {
  const fab = document.getElementById("dailyPlannerFab");
  if (!fab) return;
  const allowed = userHasDailyPlannerAccess();
  fab.classList.toggle("is-locked", !allowed);
  fab.setAttribute("aria-disabled", allowed ? "false" : "true");
  if (allowed) {
    fab.title = t("dailyPlannerFabTitle");
    fab.setAttribute("data-float-label", t("dailyPlannerFabTitle"));
  } else {
    fab.title = t("dailyPlannerRequiresStandard");
    fab.setAttribute("data-float-label", t("upgradePlan"));
  }
}

function openDailyPlannerModal() {
  if (!userHasDailyPlannerAccess()) {
    showToast(t("dailyPlannerRequiresStandard"));
    openBot();
    return;
  }
  const modal = document.getElementById("dailyPlannerModal");
  if (!modal) return;
  closeWebChatQuickActions();
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  renderDailyPlannerList();
  const input = document.getElementById("dailyPlannerTaskInput");
  if (input) input.focus();
}

function closeDailyPlannerModal() {
  const modal = document.getElementById("dailyPlannerModal");
  if (modal) modal.classList.add("hidden");
  releaseModalBackdropIfIdle();
}

function dailyPlannerAddTask() {
  if (!userHasDailyPlannerAccess()) {
    showToast(t("dailyPlannerRequiresStandard"));
    openBot();
    return;
  }
  const input = document.getElementById("dailyPlannerTaskInput");
  const timeInput = document.getElementById("dailyPlannerTimeInput");
  if (!input || !timeInput) return;
  const text = String(input.value || "").trim();
  const time = String(timeInput.value || "").trim();
  if (!text) {
    showToast(t("dailyPlannerTaskRequired"));
    input.focus();
    return;
  }
  const tasks = readDailyPlannerTasks();
  tasks.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    text,
    time,
    done: false,
    notificationEnabled: false
  });
  dailyPlannerLastAddedTaskId = tasks[0].id;
  writeDailyPlannerTasks(tasks.slice(0, 40));
  input.value = "";
  timeInput.value = "";
  renderDailyPlannerList();
  void syncPlannerLocalNotifications();
}

function dailyPlannerToggleTask(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return;
  const tasks = readDailyPlannerTasks().map((task) => (task.id === id ? { ...task, done: !task.done } : task));
  dailyPlannerMovedTaskId = id;
  writeDailyPlannerTasks(tasks);
  renderDailyPlannerList();
  void syncPlannerLocalNotifications();
}

async function dailyPlannerToggleNotification(taskId, btnEl) {
  const id = String(taskId || "").trim();
  if (!id) return;
  const originalTasks = readDailyPlannerTasks();
  const target = originalTasks.find((task) => task.id === id);
  if (!target) return;
  const nextEnabled = !target.notificationEnabled;
  if (nextEnabled) {
    const allowed = await requestNotificationPermissionIfNeeded(true);
    if (!allowed) {
      showToast(t("notificationsDenied"));
      return;
    }
  }
  const tasks = originalTasks.map((task) =>
    task.id === id ? { ...task, notificationEnabled: nextEnabled } : task
  );
  writeDailyPlannerTasks(tasks);
  if (btnEl && btnEl.classList) {
    btnEl.classList.remove("is-bounce");
    requestAnimationFrame(() => btnEl.classList.add("is-bounce"));
    window.setTimeout(() => btnEl.classList.remove("is-bounce"), 280);
  }
  renderDailyPlannerList();
  dailyPlannerMaybeTriggerNotifications();
  void syncPlannerLocalNotifications();
}

function initDepthRevealSystem() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.add("depth-motion-ready");
  const targets =
    ".note-card, .home-stats-panel, .hex-card, .home-reminders-shell, .settings-section, .home-intro, .web-chat-messenger";
  if (reduce) {
    document.querySelectorAll(targets).forEach((el) => {
      el.classList.add("depth-reveal", "depth-reveal--in");
    });
    return;
  }
  depthRevealObserver = new IntersectionObserver(
    (entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        ent.target.classList.add("depth-reveal--in");
        depthRevealObserver.unobserve(ent.target);
      }
    },
    { rootMargin: "22% 0px -7% 0px", threshold: 0.02 }
  );
  refreshDepthRevealObservers();
}

let depthRevealRefreshRaf = 0;

function refreshDepthRevealObservers() {
  if (depthRevealRefreshRaf) return;
  depthRevealRefreshRaf = requestAnimationFrame(() => {
    depthRevealRefreshRaf = 0;
    refreshDepthRevealObserversNow();
  });
}

function refreshDepthRevealObserversNow() {
  const targets =
    ".note-card, .home-stats-panel, .hex-card, .home-reminders-shell, .settings-section, .home-intro, .web-chat-messenger";
  if (!depthRevealObserver) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll(targets).forEach((el) => {
        el.classList.add("depth-reveal", "depth-reveal--in");
      });
    }
    return;
  }
  document.querySelectorAll(targets).forEach((el) => {
    el.classList.add("depth-reveal");
    if (!el.classList.contains("depth-reveal--in")) depthRevealObserver.observe(el);
  });
  refreshPremiumTiltTargets();
}

function initPremiumTiltSystem() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  premiumTiltEnabled = !reduce && !coarse;
  refreshPremiumTiltTargets();
}

function refreshPremiumTiltTargets() {
  const targets =
    ".home-categories-grid .hex-card, .note-card, .home-stats-panel, .home-reminders-shell, .home-stats-cta, .save-button, .primaryBtn, .web-chat-send, .add-button, .back-button";
  const maxDeg = 6;
  document.querySelectorAll(targets).forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    el.classList.add("tilt-target");
    if (el.dataset.tiltBound === "1") return;
    el.dataset.tiltBound = "1";
    if (!premiumTiltEnabled) return;
    let raf = 0;
    const paintTilt = (rx, ry, scale, gx, gy, glare) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty("--tilt-rx", `${rx}deg`);
        el.style.setProperty("--tilt-ry", `${ry}deg`);
        el.style.setProperty("--tilt-scale", String(scale));
        el.style.setProperty("--tilt-gx", `${gx}%`);
        el.style.setProperty("--tilt-gy", `${gy}%`);
        el.style.setProperty("--tilt-glare-o", String(glare));
      });
    };
    const reset = () => {
      cancelAnimationFrame(raf);
      el.classList.remove("is-tilting");
      el.style.setProperty("--tilt-rx", "0deg");
      el.style.setProperty("--tilt-ry", "0deg");
      el.style.setProperty("--tilt-scale", "1");
      el.style.setProperty("--tilt-gx", "50%");
      el.style.setProperty("--tilt-gy", "35%");
      el.style.setProperty("--tilt-glare-o", "0");
    };
    el.addEventListener("pointerenter", () => {
      if (!premiumTiltEnabled) return;
      el.classList.add("is-tilting");
    });
    el.addEventListener("pointermove", (ev) => {
      if (!premiumTiltEnabled) {
        reset();
        return;
      }
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = (ev.clientX - rect.left) / rect.width;
      const py = (ev.clientY - rect.top) / rect.height;
      const nx = Math.max(-0.5, Math.min(0.5, px - 0.5));
      const ny = Math.max(-0.5, Math.min(0.5, py - 0.5));
      const rx = -ny * maxDeg;
      const ry = nx * maxDeg;
      paintTilt(rx, ry, 1.016, px * 100, py * 100, 0.42);
    });
    el.addEventListener("pointerleave", reset);
    el.addEventListener("blur", reset);
    reset();
  });
}

function releaseModalBackdropIfIdle() {
  const noteModal = document.getElementById("noteEditorModal");
  const reminderModal = document.getElementById("reminderEditModal");
  const exportModal = document.getElementById("noteExportModal");
  const shareModal = document.getElementById("noteShareModal");
  const noteViewModal = document.getElementById("noteViewModal");
  const scanCamUpgradeModal = document.getElementById("scanCamUpgradeModal");
  const scanCamShareModal = document.getElementById("scanCamShareModal");
  const dailyPlannerModal = document.getElementById("dailyPlannerModal");
  const noteOpen = noteModal && !noteModal.classList.contains("hidden");
  const reminderOpen = reminderModal && !reminderModal.classList.contains("hidden");
  const exportOpen = exportModal && !exportModal.classList.contains("hidden");
  const shareOpen = shareModal && !shareModal.classList.contains("hidden");
  const noteViewOpen = noteViewModal && !noteViewModal.classList.contains("hidden");
  const scanCamUpgradeOpen = scanCamUpgradeModal && !scanCamUpgradeModal.classList.contains("hidden");
  const scanCamShareOpen = scanCamShareModal && !scanCamShareModal.classList.contains("hidden");
  const dailyPlannerOpen = dailyPlannerModal && !dailyPlannerModal.classList.contains("hidden");
  if (
    !noteOpen &&
    !reminderOpen &&
    !exportOpen &&
    !shareOpen &&
    !noteViewOpen &&
    !scanCamUpgradeOpen &&
    !scanCamShareOpen &&
    !dailyPlannerOpen
  ) {
    document.body.classList.remove("modal-open");
    document.body.style.overflow = "";
  }
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function noteTitleTrim(note) {
  if (!note) return "";
  const raw = note.title != null ? note.title : note.Title;
  if (raw == null || raw === "") return "";
  const s = String(raw).trim();
  return s;
}

const NOTE_EDIT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

const NOTE_TRASH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

const NOTE_DOWNLOAD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

const NOTE_SHARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

/** @type {object | null} */
let noteShareModalNote = null;
/** @type {{ note: object | null; origin: "category" | "all" }} */
let noteViewModalState = { note: null, origin: "all" };

const NOTE_SHARE_WA_MAX_CHARS = 3800;

function getNoteShareParts(note) {
  const title = noteTitleTrim(note) || "";
  let content = "";
  if (window.NoteRichEditor && typeof window.NoteRichEditor.storedToPreviewText === "function") {
    content = window.NoteRichEditor.storedToPreviewText((note && note.text) || "", 50000);
  } else {
    content = (note && note.text) != null ? String(note.text) : "";
  }
  const fullText = title ? `${title}\n\n${content}` : content;
  const subject = title || (typeof t === "function" ? t("noteCardUntitled") : "Note");
  return { title, content, fullText, subject };
}

function openNoteShareModal(note) {
  noteShareModalNote = note;
  const modal = document.getElementById("noteShareModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  if (typeof applyTranslations === "function") applyTranslations();
}

function openNoteViewModal(note, origin = "all") {
  if (!note) return;
  noteViewModalState = { note, origin: origin === "category" ? "category" : "all" };

  const modal = document.getElementById("noteViewModal");
  const titleEl = document.getElementById("noteViewTitle");
  const badgeEl = document.getElementById("noteViewCategoryBadge");
  const dateEl = document.getElementById("noteViewDate");
  const bodyEl = document.getElementById("noteViewText");
  const actionsEl = document.getElementById("noteViewActions");
  if (!modal || !titleEl || !badgeEl || !dateEl || !bodyEl || !actionsEl) return;

  const theme = noteCategoryThemeKey(note.category);
  const title = noteTitleTrim(note);
  titleEl.textContent = title || t("noteCardUntitled");
  titleEl.classList.toggle("note-card-title--placeholder", !title);

  const categoryLabel = normalizeNoteCategoryLabel(note);
  badgeEl.className = `note-category-badge note-category-badge--${theme}`;
  badgeEl.textContent = categoryLabel;

  dateEl.textContent = new Date(note.createdAt).toLocaleString();
  if (window.NoteRichEditor && typeof window.NoteRichEditor.storedToHtml === "function") {
    bodyEl.innerHTML = window.NoteRichEditor.storedToHtml(note.text || "");
  } else {
    bodyEl.textContent = (note.text || "").toString();
  }

  const canManage = currentUser && !note.public;
  actionsEl.innerHTML = "";
  if (canManage) {
    actionsEl.classList.remove("hidden");
    const addBtn = (className, titleKey, svg, onClick) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `note-action-btn ${className}`;
      btn.title = t(titleKey);
      btn.setAttribute("aria-label", t(titleKey));
      btn.innerHTML = svg;
      btn.addEventListener("click", onClick);
      actionsEl.appendChild(btn);
    };

    addBtn("note-action-btn--edit", "editNoteTitle", NOTE_EDIT_SVG, () => {
      closeNoteViewModal();
      openNoteEditorEdit(note, noteViewModalState.origin);
    });
    addBtn("note-action-btn--download", "noteExportDownloadTitle", NOTE_DOWNLOAD_SVG, () => {
      closeNoteViewModal();
      if (typeof openNoteExportModal === "function") openNoteExportModal(note);
    });
    addBtn("note-action-btn--share", "noteShareTitle", NOTE_SHARE_SVG, () => {
      closeNoteViewModal();
      openNoteShareModal(note);
    });
    addBtn("note-action-btn--delete", "deleteNoteTitle", NOTE_TRASH_SVG, () => {
      closeNoteViewModal();
      void deleteNoteById(note);
    });
  } else {
    actionsEl.classList.add("hidden");
  }

  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeNoteViewModal() {
  noteViewModalState = { note: null, origin: "all" };
  const modal = document.getElementById("noteViewModal");
  if (modal) modal.classList.add("hidden");
  if (typeof releaseModalBackdropIfIdle === "function") releaseModalBackdropIfIdle();
}

function closeNoteShareModal() {
  noteShareModalNote = null;
  const modal = document.getElementById("noteShareModal");
  if (modal) modal.classList.add("hidden");
  if (typeof releaseModalBackdropIfIdle === "function") releaseModalBackdropIfIdle();
}

function shareNoteViaWhatsApp() {
  const note = noteShareModalNote;
  if (!note) return;
  const { fullText } = getNoteShareParts(note);
  let text = fullText;
  let truncated = false;
  if (text.length > NOTE_SHARE_WA_MAX_CHARS) {
    text = text.slice(0, NOTE_SHARE_WA_MAX_CHARS - 1) + "…";
    truncated = true;
  }
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  if (truncated && typeof showToast === "function") {
    showToast(typeof t === "function" ? t("noteShareTruncated") : "Long note was shortened for WhatsApp.");
  }
  closeNoteShareModal();
}

function shareNoteViaEmail() {
  const note = noteShareModalNote;
  if (!note) return;
  const { subject, content } = getNoteShareParts(note);
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(content)}`;
  window.location.href = mailto;
  closeNoteShareModal();
}

async function shareNoteCopyToClipboard() {
  const note = noteShareModalNote;
  if (!note) return;
  const { fullText } = getNoteShareParts(note);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(fullText);
    } else {
      const ta = document.createElement("textarea");
      ta.value = fullText;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    if (typeof showToast === "function") {
      showToast(typeof t === "function" ? t("noteShareCopied") : "Copied");
    }
  } catch {
    if (typeof showToast === "function") {
      showToast(typeof t === "function" ? t("noteShareCopyFailed") : "Copy failed");
    }
  }
  closeNoteShareModal();
}

function createNoteActionToolbar(note, origin) {
  const tools = document.createElement("div");
  tools.className = "note-actions note-actions--toolbar";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "note-action-btn note-action-btn--edit";
  editBtn.title = t("editNoteTitle");
  editBtn.setAttribute("aria-label", t("editNoteTitle"));
  editBtn.innerHTML = NOTE_EDIT_SVG;
  editBtn.addEventListener("click", () => openNoteEditorEdit(note, origin));

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "note-action-btn note-action-btn--delete";
  delBtn.title = t("deleteNoteTitle");
  delBtn.setAttribute("aria-label", t("deleteNoteTitle"));
  delBtn.innerHTML = NOTE_TRASH_SVG;
  delBtn.addEventListener("click", () => deleteNoteById(note));

  tools.appendChild(editBtn);
  if (currentUser && !note.public) {
    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "note-action-btn note-action-btn--share";
    shareBtn.title = t("noteShareTitle");
    shareBtn.setAttribute("aria-label", t("noteShareTitle"));
    shareBtn.innerHTML = NOTE_SHARE_SVG;
    shareBtn.addEventListener("click", () => openNoteShareModal(note));
    tools.appendChild(shareBtn);
  }
  if (currentUser && !note.public && typeof openNoteExportModal === "function") {
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "note-action-btn note-action-btn--download";
    dlBtn.title = t("noteExportDownloadTitle");
    dlBtn.setAttribute("aria-label", t("noteExportDownloadTitle"));
    dlBtn.innerHTML = NOTE_DOWNLOAD_SVG;
    dlBtn.addEventListener("click", () => openNoteExportModal(note));
    tools.appendChild(dlBtn);
  }
  tools.appendChild(delBtn);
  return tools;
}

function appendNoteCardHeadingAndBody(content, note) {
  const titleRow = document.createElement("div");
  titleRow.className = "note-card-title-row";
  const titleEl = document.createElement("h3");
  titleEl.className = "note-card-title";
  const title = noteTitleTrim(note);
  if (title) {
    titleEl.textContent = title;
  } else {
    titleEl.classList.add("note-card-title--placeholder");
    titleEl.textContent = t("noteCardUntitled");
  }
  titleRow.appendChild(titleEl);
  content.appendChild(titleRow);

  const body = document.createElement("p");
  body.className = "note-card-text";
  let preview = "";
  if (window.NoteRichEditor && typeof window.NoteRichEditor.storedToPreviewText === "function") {
    preview = window.NoteRichEditor.storedToPreviewText(note.text || "", 4000);
  } else {
    const text = note.text || "";
    preview = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  }
  body.textContent = preview;
  content.appendChild(body);

  const dateP = document.createElement("p");
  dateP.className = "note-card-date";
  dateP.textContent = new Date(note.createdAt).toLocaleString();
  content.appendChild(dateP);
}

function formatNoteSelectOptionLabel(note) {
  const title = noteTitleTrim(note);
  let text = "";
  if (window.NoteRichEditor && typeof window.NoteRichEditor.storedToPreviewText === "function") {
    text = window.NoteRichEditor.storedToPreviewText(note.text || "", 120).replace(/\s+/g, " ").trim();
  } else {
    text = (note.text || "").replace(/\s+/g, " ").trim();
  }
  if (!title) return text.length > 55 ? `${text.slice(0, 55)}…` : text;
  const combined = `${title}: ${text}`;
  return combined.length > 72 ? `${combined.slice(0, 70)}…` : combined;
}

function activateMenu(menuId) {
  document.querySelectorAll(".menu-item").forEach(button => {
    button.classList.toggle("active", button.id === menuId);
  });
  closeWebChatQuickActions();
  closeMobileNavIfNeeded();
  syncMobileHeaderActionUi();
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 840px)").matches;
}

function closeMobileNavIfNeeded() {
  if (!isMobileViewport()) return;
  closeMobileNav();
}

function openMobileNav() {
  if (!isMobileViewport()) return;
  const overlay = document.getElementById("mobileNavOverlay");
  const toggle = document.getElementById("mobileMenuToggle");
  document.body.classList.add("mobile-nav-open");
  if (overlay) overlay.classList.remove("hidden");
  if (toggle) toggle.setAttribute("aria-expanded", "true");
}

function closeMobileNav() {
  const overlay = document.getElementById("mobileNavOverlay");
  const toggle = document.getElementById("mobileMenuToggle");
  document.body.classList.remove("mobile-nav-open");
  if (overlay) overlay.classList.add("hidden");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function toggleMobileNav() {
  if (document.body.classList.contains("mobile-nav-open")) {
    closeMobileNav();
  } else {
    openMobileNav();
  }
}

function syncMobileHeaderActionUi() {
  const btn = document.getElementById("mobileHeaderActionBtn");
  if (!btn) return;
  const show = isMobileViewport();
  btn.classList.toggle("hidden", !show);
  if (!show) {
    closeMobileLogoutConfirm();
    return;
  }
  const logoutSvg = `<svg class="mobile-header-action-btn__svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M10 17H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M15 12H4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M12 8l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M20 12h-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
  const accountSvg = `<svg class="mobile-header-action-btn__svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M5.5 20.5v-.5a6.5 6.5 0 0 1 13 0v.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
  </svg>`;
  if (currentUser) {
    btn.innerHTML = logoutSvg;
    btn.classList.add("mobile-header-action-btn--logout");
    btn.classList.remove("mobile-header-action-btn--account");
    btn.setAttribute("aria-label", "Log out");
    btn.setAttribute("title", "Log out");
  } else {
    btn.innerHTML = accountSvg;
    btn.classList.add("mobile-header-action-btn--account");
    btn.classList.remove("mobile-header-action-btn--logout");
    btn.setAttribute("aria-label", "Account");
    btn.setAttribute("title", "Account");
  }
}

function mobileHeaderActionClick(ev) {
  if (ev) ev.stopPropagation();
  if (!isMobileViewport()) return;
  if (!currentUser) {
    openAccountModal();
    return;
  }
  const pop = document.getElementById("mobileLogoutConfirm");
  if (!pop) return;
  const opening = pop.classList.contains("hidden");
  if (opening) {
    pop.classList.remove("hidden");
  } else {
    pop.classList.add("hidden");
  }
}

function closeMobileLogoutConfirm() {
  const pop = document.getElementById("mobileLogoutConfirm");
  if (pop) pop.classList.add("hidden");
}

function confirmMobileLogout() {
  closeMobileLogoutConfirm();
  logoutUser();
}

function readScanCamLocalNotes() {
  try {
    const raw = localStorage.getItem(SCAN_CAM_LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeScanCamLocalNotes(notes) {
  localStorage.setItem(SCAN_CAM_LOCAL_STORAGE_KEY, JSON.stringify(notes.slice(0, 200)));
}

function appendScanCamLocalNote(note) {
  const arr = readScanCamLocalNotes();
  arr.unshift(note);
  writeScanCamLocalNotes(arr);
}

function removeScanCamLocalNote(id) {
  writeScanCamLocalNotes(readScanCamLocalNotes().filter((n) => String(n._id) !== String(id)));
}

function updateScanCamLocalNote(id, patch) {
  const arr = readScanCamLocalNotes();
  const i = arr.findIndex((n) => String(n._id) === String(id));
  if (i >= 0) {
    arr[i] = { ...arr[i], ...patch };
    writeScanCamLocalNotes(arr);
  }
}

function mergeNotesWithScanCamLocal(serverNotes) {
  const local = readScanCamLocalNotes();
  const byId = new Map();
  for (const n of [...local, ...(serverNotes || [])]) {
    if (n && n._id != null) byId.set(String(n._id), n);
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
}

function persistScanCamNoteLocally(text, title, imageDataUrl) {
  const note = {
    _id: `local-scan-${Date.now()}`,
    category: "scan_cam",
    text,
    title,
    createdAt: new Date().toISOString(),
    ...(imageDataUrl && String(imageDataUrl).startsWith("data:")
      ? { scanCamImageDataUrl: imageDataUrl }
      : {})
  };
  appendScanCamLocalNote(note);
  const id = String(note._id);
  allNotes = [note, ...allNotes.filter((n) => String(n._id) !== id)];
  if (currentCategory === "scan_cam") {
    currentNotes = [note, ...currentNotes.filter((n) => String(n._id) !== id)];
  }
  return note;
}

function scanCamStopCamera() {
  if (scanCamMediaStream) {
    scanCamMediaStream.getTracks().forEach((tr) => tr.stop());
    scanCamMediaStream = null;
  }
  const video = document.getElementById("scanCamVideo");
  if (video) video.srcObject = null;
}

function scanCamCloseResultPanel() {
  const panel = document.getElementById("scanCamResultPanel");
  if (panel) panel.classList.add("hidden");
}

function scanCamShowResultPanel() {
  const ta = document.getElementById("scanCamResultText");
  const body = document.getElementById("scanCamResultBody");
  const panel = document.getElementById("scanCamResultPanel");
  if (!ta || !body || !panel) return;
  body.textContent = String(ta.value || "");
  panel.classList.remove("hidden");
}

function scanCamUpdateStageVisibility() {
  const ph = document.getElementById("scanCamPlaceholder");
  const vw = document.getElementById("scanCamVideoWrap");
  const img = document.getElementById("scanCamPhotoPreview");
  const pdfWrap = document.getElementById("scanCamPdfWrap");
  if (!ph || !vw || !img) return;
  const hasVideo = !vw.classList.contains("hidden");
  const hasImg = !!img.getAttribute("src");
  const hasPdf = !!(pdfWrap && !pdfWrap.classList.contains("hidden"));
  ph.classList.toggle("hidden", !!(hasVideo || hasImg || hasPdf));
}

function openScanCamUpgradeModal() {
  const modal = document.getElementById("scanCamUpgradeModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  document.body.style.overflow = "hidden";
}

function closeScanCamUpgradeModal() {
  const modal = document.getElementById("scanCamUpgradeModal");
  if (!modal) return;
  modal.classList.add("hidden");
  if (typeof releaseModalBackdropIfIdle === "function") releaseModalBackdropIfIdle();
}

function closeScanCamShareModal() {
  const modal = document.getElementById("scanCamShareModal");
  if (!modal) return;
  modal.classList.add("hidden");
  if (typeof releaseModalBackdropIfIdle === "function") releaseModalBackdropIfIdle();
}

function openScanCamShareModal() {
  if (!scanCamEnsureConvertAccess()) return;
  const ta = document.getElementById("scanCamResultText");
  const text = ta ? String(ta.value || "").trim() : "";
  if (!text) {
    showToast(t("scanCamShareNoText"));
    return;
  }
  const modal = document.getElementById("scanCamShareModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  document.body.style.overflow = "hidden";
}

function scanCamShareWhatsApp() {
  if (!scanCamEnsureConvertAccess()) return;
  const ta = document.getElementById("scanCamResultText");
  const raw = ta ? String(ta.value || "").trim() : "";
  if (!raw) {
    showToast(t("scanCamShareNoText"));
    return;
  }
  const url = `https://wa.me/?text=${encodeURIComponent(raw)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  closeScanCamShareModal();
}

function scanCamShareEmail() {
  if (!scanCamEnsureConvertAccess()) return;
  const ta = document.getElementById("scanCamResultText");
  const raw = ta ? String(ta.value || "").trim() : "";
  if (!raw) {
    showToast(t("scanCamShareNoText"));
    return;
  }
  const subj = t("scanCamShareEmailSubject");
  window.location.href = `mailto:?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(raw)}`;
  closeScanCamShareModal();
}

function scanCamShareCopy() {
  if (!scanCamEnsureConvertAccess()) return;
  const ta = document.getElementById("scanCamResultText");
  const raw = ta ? String(ta.value || "").trim() : "";
  if (!raw) {
    showToast(t("scanCamShareNoText"));
    return;
  }
  navigator.clipboard.writeText(raw).then(
    () => {
      showToast(t("scanCamShareCopied"));
      closeScanCamShareModal();
    },
    () => showToast(t("scanCamShareCopyFailed"))
  );
}

function scanCamNewScan() {
  scanCamResetWorkflowUi();
}

function scanCamRetake() {
  scanCamResetWorkflowUi();
}

function scanCamClearPdf() {
  const embed = document.getElementById("scanCamPdfEmbed");
  const wrap = document.getElementById("scanCamPdfWrap");
  if (embed) embed.removeAttribute("src");
  if (wrap) wrap.classList.add("hidden");
  if (scanCamPdfObjectUrl) {
    try {
      URL.revokeObjectURL(scanCamPdfObjectUrl);
    } catch (e) {
      /* ignore */
    }
    scanCamPdfObjectUrl = null;
  }
}

function scanCamHasStillPreview() {
  const img = document.getElementById("scanCamPhotoPreview");
  const embed = document.getElementById("scanCamPdfEmbed");
  const wrap = document.getElementById("scanCamPdfWrap");
  if (img && img.getAttribute("src")) return true;
  if (wrap && !wrap.classList.contains("hidden") && embed && embed.getAttribute("src")) return true;
  return false;
}

function scanCamSyncActionUi() {
  const vw = document.getElementById("scanCamVideoWrap");
  const closeCam = document.getElementById("scanCamStageCloseCam");
  const shutter = document.getElementById("scanCamShutter");
  const previewBar = document.getElementById("scanCamPreviewBar");
  const convertBtn = document.getElementById("scanCamBtnConvert");
  const launch = document.getElementById("scanCamLaunch");
  const stageBlock = document.getElementById("scanCamStageBlock");
  const live = !!(vw && !vw.classList.contains("hidden") && scanCamMediaStream);
  const hasStill = scanCamHasStillPreview();
  if (closeCam) closeCam.classList.toggle("hidden", !live);
  if (shutter) shutter.classList.toggle("hidden", !live);
  if (previewBar) previewBar.classList.toggle("hidden", !hasStill);
  if (convertBtn) convertBtn.disabled = !hasStill;
  const idle = !live && !hasStill;
  if (idle) {
    if (launch) launch.classList.remove("hidden");
    if (stageBlock) stageBlock.classList.add("hidden");
  } else {
    if (launch) launch.classList.add("hidden");
    if (stageBlock) stageBlock.classList.remove("hidden");
  }
}

function scanCamResetWorkflowUi() {
  const stage = document.querySelector(".scan-cam-stage");
  if (stage) stage.classList.remove("scan-cam-stage--converting");
  const line = document.getElementById("scanCamScanline");
  if (line) line.classList.add("hidden");
  scanCamCloseResultPanel();
  closeScanCamShareModal();
  scanCamStopCamera();
  const videoWrap = document.getElementById("scanCamVideoWrap");
  if (videoWrap) videoWrap.classList.add("hidden");
  const preview = document.getElementById("scanCamPhotoPreview");
  if (preview) {
    preview.removeAttribute("src");
    preview.classList.add("hidden");
  }
  scanCamClearPdf();
  scanCamClearText();
  const titleInput = document.getElementById("scanCamNoteTitle");
  if (titleInput) titleInput.value = "";
  const st = document.getElementById("scanCamStatus");
  if (st) st.textContent = "";
  scanCamUpdateStageVisibility();
  scanCamSyncActionUi();
}

function hideScanCamPage() {
  scanCamStopCamera();
  if (typeof closeScanCamUpgradeModal === "function") closeScanCamUpgradeModal();
  if (typeof closeScanCamShareModal === "function") closeScanCamShareModal();
  if (typeof scanCamCloseDocSourceSheet === "function") scanCamCloseDocSourceSheet();
  const el = document.getElementById("scan-cam");
  if (el) el.classList.add("hidden");
}

function hideCoinsHubPage() {
  const el = document.getElementById("coins-hub");
  if (el) el.classList.add("hidden");
}

function getStoredAccessToken() {
  return localStorage.getItem("accessToken") || sessionStorage.getItem("accessToken");
}

function getStoredRefreshToken() {
  return localStorage.getItem("refreshToken") || sessionStorage.getItem("refreshToken");
}

function getStoredUser() {
  const stored = localStorage.getItem("currentUser") || sessionStorage.getItem("currentUser");
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    localStorage.removeItem("currentUser");
    sessionStorage.removeItem("currentUser");
    return null;
  }
}

function storeCurrentUser(user, token, refresh, remember) {
  if (remember) {
    localStorage.setItem("accessToken", token);
    localStorage.setItem("refreshToken", refresh);
    localStorage.setItem("currentUser", JSON.stringify(user));
    sessionStorage.removeItem("accessToken");
    sessionStorage.removeItem("refreshToken");
    sessionStorage.removeItem("currentUser");
  } else {
    sessionStorage.setItem("accessToken", token);
    sessionStorage.setItem("refreshToken", refresh);
    sessionStorage.setItem("currentUser", JSON.stringify(user));
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("currentUser");
  }
  currentUser = user;
  accessToken = token;
  refreshToken = refresh;
  if (user && ["classic", "normal", "advanced"].includes(user.theme)) {
    localStorage.setItem("theme", user.theme);
    applyTheme(user.theme);
    updateThemeSelector();
  }
  updateAccountUI();
  updatePremiumUi();
  if (token) {
    if (typeof socket !== "undefined" && socket && typeof socket.emit === "function") {
      socket.emit("authenticate", token);
    }
    // Load user settings from server
    loadUserSettings();
  }
}

function persistCurrentUserToStorage() {
  if (!currentUser) return;
  if (localStorage.getItem("refreshToken")) {
    localStorage.setItem("currentUser", JSON.stringify(currentUser));
  } else if (sessionStorage.getItem("refreshToken")) {
    sessionStorage.setItem("currentUser", JSON.stringify(currentUser));
  }
}

function captureInviteCodeFromLocation() {
  try {
    const path = window.location.pathname || "";
    const pathMatch = path.match(/\/invite\/([A-Za-z0-9]{4,})\/?$/i);
    if (pathMatch) {
      const code = pathMatch[1].toUpperCase();
      sessionStorage.setItem("aiNotesPendingInvite", code);
      const u = new URL(window.location.href);
      u.pathname = "/";
      u.searchParams.delete("invite");
      u.searchParams.delete("ref");
      u.searchParams.delete("referralCode");
      window.history.replaceState({}, document.title, `${u.pathname}${u.search}${u.hash}`);
      return;
    }
    const u = new URL(window.location.href);
    let code =
      u.searchParams.get("invite") || u.searchParams.get("ref") || u.searchParams.get("referralCode") || "";
    code = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length >= 4) {
      sessionStorage.setItem("aiNotesPendingInvite", code);
      u.searchParams.delete("invite");
      u.searchParams.delete("ref");
      u.searchParams.delete("referralCode");
      window.history.replaceState({}, document.title, `${u.pathname}${u.search}${u.hash}`);
    }
  } catch {
    /* ignore */
  }
}

function mergePremiumStatusIntoCurrentUser(data) {
  if (!currentUser || !data) return;
  Object.assign(currentUser, {
    isPremium: data.isPremium,
    tier: data.tier,
    plan: data.plan != null ? data.plan : data.tier || currentUser.plan || "free",
    membershipRole:
      data.plan != null ? data.plan : data.tier || currentUser.membershipRole || "free",
    subscriptionPlan:
      data.subscriptionPlan != null ? data.subscriptionPlan : currentUser.subscriptionPlan || "free",
    capabilities: data.capabilities,
    premiumExpiresAt: data.premiumExpiresAt,
    openAiWebChat: data.openAiWebChat !== undefined ? data.openAiWebChat : currentUser.openAiWebChat,
    subscriptionStatus: data.subscriptionStatus || null,
    cancelAtPeriodEnd: Boolean(data.cancelAtPeriodEnd),
    currentPeriodEnd: data.currentPeriodEnd || null,
    lifecycle: data.lifecycle != null ? data.lifecycle : currentUser.lifecycle || "free",
    trialEndsAt: data.trialEndsAt != null ? data.trialEndsAt : currentUser.trialEndsAt || null,
    standardCoinExpiresAt:
      data.standardCoinExpiresAt != null ? data.standardCoinExpiresAt : currentUser.standardCoinExpiresAt || null,
    coinBalance: data.coinBalance != null ? data.coinBalance : currentUser.coinBalance ?? 0,
    referralCode:
      data.referralCode != null && String(data.referralCode).trim()
        ? String(data.referralCode).trim()
        : currentUser.referralCode || ""
  });
}

async function tryConsumePendingInviteCode() {
  if (!accessToken || !currentUser) return;
  let pending = "";
  try {
    pending = String(sessionStorage.getItem("aiNotesPendingInvite") || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  } catch {
    return;
  }
  if (pending.length < 4) return;
  try {
    sessionStorage.removeItem("aiNotesPendingInvite");
    await apiFetch("/api/coins/invite/bind", {
      method: "POST",
      body: JSON.stringify({ referralCode: pending })
    });
    const data = await apiFetch("/api/premium/status");
    mergePremiumStatusIntoCurrentUser(data);
    persistCurrentUserToStorage();
    updatePremiumUi();
  } catch {
    /* ignore — invalid invite or offline */
  }
}

/**
 * Refreshes subscription fields from the server. Callers that gate paid features
 * should treat `false` as "cannot confirm access" and deny (avoids stale localStorage tiers).
 * @returns {Promise<boolean>} true if `/api/premium/status` succeeded
 */
async function mergePremiumFromServer() {
  if (!currentUser || !accessToken) return false;
  try {
    const data = await apiFetch("/api/premium/status");
    mergePremiumStatusIntoCurrentUser(data);
    persistCurrentUserToStorage();
    updatePremiumUi();
    await tryConsumePendingInviteCode();
    maybeShowTrialGiftWelcome();
    return true;
  } catch {
    return false;
  }
}

const TRIAL_GIFT_DISMISS_STORAGE = "aiNotesTrialGiftDismissed";

function trialGiftDismissStorageKey() {
  const id = currentUser && currentUser.id != null ? String(currentUser.id) : "";
  return id ? `${TRIAL_GIFT_DISMISS_STORAGE}_${id}` : TRIAL_GIFT_DISMISS_STORAGE;
}

function maybeShowTrialGiftWelcome() {
  if (!currentUser || !accessToken) return;
  const life = currentUser.lifecycle;
  if (life !== "trial") return;
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(trialGiftDismissStorageKey()) === "1") {
      return;
    }
  } catch {
    /* ignore */
  }
  const el = document.getElementById("trialGiftModal");
  if (!el) return;
  el.classList.remove("hidden");
  document.body.classList.add("trial-gift-modal-open");
  if (typeof applyTranslations === "function") applyTranslations();
}

function dismissTrialGiftModal() {
  const el = document.getElementById("trialGiftModal");
  if (el) el.classList.add("hidden");
  document.body.classList.remove("trial-gift-modal-open");
  try {
    localStorage.setItem(trialGiftDismissStorageKey(), "1");
  } catch {
    /* ignore */
  }
}

/** Optional sidebar Web Chat control (if present): lock when the user has no Standard-tier access. */
function syncPremiumGatedNav() {
  const webChatBtn = document.getElementById("menuWebChat");
  if (!webChatBtn) return;
  webChatBtn.disabled = false;
  const paid = Boolean(currentUser) && typeof userHasWebChatAccess === "function" && userHasWebChatAccess(currentUser);
  webChatBtn.classList.toggle("menu-item--locked", Boolean(currentUser) && !paid);
  if (paid) {
    webChatBtn.removeAttribute("title");
    webChatBtn.removeAttribute("aria-label");
  } else if (currentUser) {
    const tip = typeof t === "function" ? t("webChatRequiresStandard") : "Web Chat needs Standard or Premium.";
    webChatBtn.title = tip;
    const labelEl = webChatBtn.querySelector(".menu-label");
    const labelText = (labelEl && labelEl.textContent) || "Web Chat";
    webChatBtn.setAttribute("aria-label", `${labelText}. ${tip}`);
  } else {
    webChatBtn.removeAttribute("title");
    webChatBtn.removeAttribute("aria-label");
  }
}

function getWebChatMode() {
  try {
    const raw = localStorage.getItem(WEB_CHAT_MODE_KEY) || "auto";
    if (raw === "openai30") return "openai";
    if (raw === "auto" || raw === "chatbot" || raw === "openai") return raw;
  } catch {
    /* ignore */
  }
  return "auto";
}

function setWebChatMode(mode) {
  const value = mode === "chatbot" || mode === "auto" || mode === "openai" ? mode : "auto";
  try {
    localStorage.setItem(WEB_CHAT_MODE_KEY, value);
  } catch {
    /* ignore */
  }
  return value;
}

function webChatIsOpenAiLimitReached() {
  if (typeof userHasWebChatOpenAiAccess !== "function" || !userHasWebChatOpenAiAccess(currentUser)) {
    return true;
  }
  const u = currentUser && currentUser.openAiWebChat;
  if (!u || u.remaining == null) return false;
  return Number(u.remaining) <= 0;
}

function syncWebChatOpenAiUsageUi() {
  const wrap = document.getElementById("webChatOpenAiUsageWrap");
  const labelEl = document.getElementById("webChatOpenAiUsageLabel");
  const countsEl = document.getElementById("webChatOpenAiUsageCounts");
  const fill = document.getElementById("webChatOpenAiUsageFill");
  const track = document.getElementById("webChatOpenAiUsageTrack");
  const warn = document.getElementById("webChatOpenAiUsageWarn");
  if (!wrap || !labelEl || !countsEl || !fill) return;
  const canAi = typeof userHasWebChatOpenAiAccess === "function" && userHasWebChatOpenAiAccess(currentUser);
  if (!canAi) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const u = currentUser && currentUser.openAiWebChat;
  const limit = u && Number(u.monthlyLimit) > 0 ? Number(u.monthlyLimit) : 130;
  const used = u && u.used != null ? Number(u.used) : 0;
  const remaining = u && u.remaining != null ? Number(u.remaining) : Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  labelEl.textContent = t("webChatOpenAiUsageTitle");
  countsEl.textContent = `${used} / ${limit}`;
  fill.style.width = `${pct}%`;
  fill.classList.toggle("web-chat-openai-usage__fill--warn", remaining <= WEB_CHAT_OPENAI_NEAR_WARN && remaining > 0);
  if (track) {
    track.setAttribute("aria-valuemax", String(limit));
    track.setAttribute("aria-valuenow", String(used));
  }
  if (warn) {
    const showWarn = remaining > 0 && remaining <= WEB_CHAT_OPENAI_NEAR_WARN;
    warn.classList.toggle("hidden", !showWarn);
    if (showWarn) warn.textContent = t("webChatOpenAiNearLimit").replace("{n}", String(remaining));
  }
}

function syncWebChatModelSelectorUi() {
  const sel = document.getElementById("webChatModelMode");
  if (!sel) return;
  const canAi = typeof userHasWebChatOpenAiAccess === "function" && userHasWebChatOpenAiAccess(currentUser);
  const optAuto = sel.querySelector("option[value='auto']");
  const optOpenai = sel.querySelector("option[value='openai']");
  if (optAuto) optAuto.disabled = !canAi;
  const limitReached = webChatIsOpenAiLimitReached();
  if (optOpenai) optOpenai.disabled = !canAi || limitReached;

  let desired = getWebChatMode();
  if (desired === "openai30") desired = "openai";
  if (!canAi && (desired === "auto" || desired === "openai")) {
    desired = "chatbot";
    setWebChatMode("chatbot");
  } else if (canAi && limitReached && desired === "openai") {
    desired = "chatbot";
    setWebChatMode("chatbot");
  }
  sel.value = desired;
  syncWebChatOpenAiUsageUi();
  webChatModelSyncCustomUi();
  syncWebChatModePresentation(desired, false);
}

function setWebChatTranslatableText(el, key) {
  if (!el) return;
  el.setAttribute("data-t", key);
  el.textContent = t(key);
}

function syncWebChatModePresentation(modeValue, aiLive) {
  const page = document.getElementById("webChat");
  const titleEl = document.querySelector(".web-chat-messenger__title");
  const statusEl = document.querySelector(
    ".web-chat-messenger__status span[data-t], .web-chat-messenger__status span:not(.web-chat-messenger__status-dot)"
  );
  if (!page || !titleEl || !statusEl) return;
  const mode = modeValue === "auto" || modeValue === "openai" ? modeValue : "chatbot";
  page.classList.remove("web-chat-page--mode-chatbot", "web-chat-page--mode-auto", "web-chat-page--mode-openai", "web-chat-page--ai-live");
  page.classList.add(`web-chat-page--mode-${mode}`);
  if (aiLive) page.classList.add("web-chat-page--ai-live");

  const messenger = page.querySelector(".web-chat-messenger.chat-container");
  if (messenger) {
    messenger.classList.remove("chat-bot-mode", "auto-mode", "openai-mode");
    messenger.classList.add(mode === "openai" ? "openai-mode" : mode === "auto" ? "auto-mode" : "chat-bot-mode");
  }

  const titleTextEl = titleEl.querySelector(".web-chat-messenger__title-text") || titleEl;
  const titleKey =
    mode === "openai" ? "webChatTitleOpenAi" : mode === "auto" ? "webChatTitleAuto" : "webChatTitleChatbot";
  setWebChatTranslatableText(titleTextEl, titleKey);

  if (mode === "openai") {
    setWebChatTranslatableText(statusEl, aiLive ? "webChatOnlineStatusAiLive" : "webChatOnlineStatusOpenAi");
  } else if (mode === "auto") {
    setWebChatTranslatableText(statusEl, aiLive ? "webChatOnlineStatusAiLive" : "webChatOnlineStatusAuto");
  } else {
    setWebChatTranslatableText(statusEl, "webChatOnlineStatusChatbot");
  }
  refreshWebChatWelcomeForMode(mode);
}

function webChatModelEnsureDocClose() {
  if (window.__webChatModelDocClose) return;
  if (!document.getElementById("webChatModelPopover")) return;
  window.__webChatModelDocClose = true;
  document.addEventListener(
    "mousedown",
    (e) => {
      const wrap = document.getElementById("webChatModelCustomWrap");
      if (!wrap) return;
      const pop = document.getElementById("webChatModelPopover");
      if (!pop || pop.classList.contains("hidden")) return;
      if (!wrap.contains(e.target)) webChatModelClosePopover();
    },
    true
  );
}

function webChatModelClosePopover() {
  const pop = document.getElementById("webChatModelPopover");
  const trigger = document.getElementById("webChatModelTrigger");
  if (!pop && !trigger) return;
  if (pop) pop.classList.add("hidden");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function webChatModelToggle(ev) {
  if (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }
  webChatModelEnsureDocClose();
  const pop = document.getElementById("webChatModelPopover");
  const trigger = document.getElementById("webChatModelTrigger");
  if (!pop || !trigger) return;
  const opening = pop.classList.contains("hidden");
  if (opening) {
    webChatModelDismissLockBanner();
    pop.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
  } else {
    pop.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
  }
}

function webChatModelDismissLockBanner() {
  const b = document.getElementById("webChatModelLockBanner");
  if (b) b.classList.add("hidden");
}

function webChatModelShowLockBanner(kind) {
  const b = document.getElementById("webChatModelLockBanner");
  const textEl = document.getElementById("webChatModelLockBannerText");
  if (!b || !textEl) return;
  if (kind === "limit") {
    textEl.removeAttribute("data-t");
    textEl.textContent = t("webChatOpenAiLimitReached");
  } else {
    textEl.setAttribute("data-t", "webChatModelLockedUpgrade");
    textEl.textContent = t("webChatModelLockedUpgrade");
  }
  b.classList.remove("hidden");
}

function webChatModelCanUseMode(value) {
  const canAi = typeof userHasWebChatOpenAiAccess === "function" && userHasWebChatOpenAiAccess(currentUser);
  if (value === "chatbot") return true;
  if (value === "auto") return canAi;
  if (value === "openai") return canAi && !webChatIsOpenAiLimitReached();
  return false;
}

function webChatModelRefreshTriggerFromValue(value) {
  const nameEl = document.getElementById("webChatModelTriggerName");
  const badgeEl = document.getElementById("webChatModelTriggerBadge");
  const v = value === "auto" || value === "openai" ? value : "chatbot";
  if (nameEl && badgeEl) {
    badgeEl.classList.remove("web-chat-model-badge--basic", "web-chat-model-badge--recommended", "web-chat-model-badge--best");
    if (v === "auto") {
      nameEl.textContent = t("webChatModeAuto");
      badgeEl.textContent = t("webChatModeTierRecommended");
      badgeEl.classList.add("web-chat-model-badge--recommended");
    } else if (v === "openai") {
      nameEl.textContent = t("webChatModeOpenAi");
      badgeEl.textContent = t("webChatModeTierBest");
      badgeEl.classList.add("web-chat-model-badge--best");
    } else {
      nameEl.textContent = t("webChatModeChatbot");
      badgeEl.textContent = t("webChatModeTierBasic");
      badgeEl.classList.add("web-chat-model-badge--basic");
    }
  }
  const pillMap = { chatbot: "webChatPill-chatbot", auto: "webChatPill-auto", openai: "webChatPill-openai" };
  ["chatbot", "auto", "openai"].forEach((key) => {
    const pill = document.getElementById(pillMap[key]);
    if (!pill) return;
    pill.classList.toggle("is-active", key === v);
    pill.setAttribute("aria-selected", key === v ? "true" : "false");
  });
}

function webChatModelSyncPopoverState() {
  const sel = document.getElementById("webChatModelMode");
  if (!sel) return;
  const val = sel.value || "chatbot";
  webChatModelRefreshTriggerFromValue(val);
  const pillMap = { chatbot: "webChatPill-chatbot", auto: "webChatPill-auto", openai: "webChatPill-openai" };
  ["chatbot", "auto", "openai"].forEach((v) => {
    const btn = document.getElementById(pillMap[v]);
    if (!btn) return;
    const locked = !webChatModelCanUseMode(v);
    btn.setAttribute("aria-disabled", locked ? "true" : "false");
    btn.classList.toggle("web-chat-mode-pill--locked", locked);
    btn.setAttribute("aria-selected", v === val ? "true" : "false");
    btn.classList.toggle("is-active", v === val);
  });
}

function webChatModelSyncCustomUi() {
  webChatModelSyncPopoverState();
  document.querySelectorAll("#webChatModelPopover [data-t-title]").forEach((el) => {
    const key = el.getAttribute("data-t-title");
    if (!key) return;
    try {
      el.title = t(key);
    } catch (e) {
      /* ignore */
    }
  });
  ["webChatPill-chatbot", "webChatPill-auto", "webChatPill-openai"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const key = el.getAttribute("data-t-title");
    if (!key) return;
    try {
      el.title = t(key);
    } catch (e) {
      /* ignore */
    }
  });
  const dismiss = document.querySelector(".web-chat-model-lock-banner__dismiss");
  if (dismiss) {
    try {
      dismiss.setAttribute("aria-label", t("webChatModelLockDismissTip"));
    } catch (e) {
      dismiss.setAttribute("aria-label", "Dismiss");
    }
  }
}

function webChatModelSelectOption(ev, value) {
  if (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }
  webChatModelClosePopover();
  if (webChatModelCanUseMode(value)) {
    webChatModelDismissLockBanner();
    const sel = document.getElementById("webChatModelMode");
    if (sel) sel.value = value;
    setWebChatMode(value);
    webChatModelModeChanged();
    syncWebChatOpenAiUsageUi();
    return;
  }
  const canAi = typeof userHasWebChatOpenAiAccess === "function" && userHasWebChatOpenAiAccess(currentUser);
  if (value === "openai" && canAi && webChatIsOpenAiLimitReached()) {
    webChatModelShowLockBanner("limit");
  } else {
    webChatModelShowLockBanner("upgrade");
  }
}

function syncWebChatSoftPaywallUi() {
  const hint = document.getElementById("webChatSoftLockHint");
  const quotaEl = document.getElementById("webChatFreeQuotaHint");
  const input = document.getElementById("webChatInput");
  const sendBtn = document.querySelector(".web-chat-send");
  const quick = document.getElementById("webChatQuickActions");
  syncWebChatModelSelectorUi();
  if (!hint) return;
  const paid = Boolean(currentUser) && typeof userHasWebChatAccess === "function" && userHasWebChatAccess(currentUser);
  if (quotaEl) quotaEl.classList.add("hidden");
  if (paid || !currentUser) {
    hint.classList.add("hidden");
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (quick) quick.classList.remove("web-chat-quick-actions--disabled");
    return;
  }
  hint.classList.remove("hidden");
  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (quick) quick.classList.add("web-chat-quick-actions--disabled");
}

function updatePremiumUi() {
  syncPremiumGatedNav();
  syncDailyPlannerAccessUi();
  syncWebChatSoftPaywallUi();
  const upsell = document.getElementById("premiumWhatsAppUpsell");
  const guestStrip = document.getElementById("botGuestStrip");
  const premiumStrip = document.getElementById("botPremiumStrip");
  if (!upsell) return;

  upsell.classList.remove("hidden");

  if (!currentUser) {
    if (guestStrip) guestStrip.classList.remove("hidden");
    if (premiumStrip) premiumStrip.classList.add("hidden");
    return;
  }

  if (guestStrip) guestStrip.classList.add("hidden");
  const premium = typeof userHasPremiumCapabilities === "function" && userHasPremiumCapabilities(currentUser);
  if (premiumStrip) premiumStrip.classList.toggle("hidden", !premium);
}

function scrollPremiumMarketingSection(part) {
  const id = part === "how" ? "premiumHowSection" : "premiumPlansSection";
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function premiumHeroUpgradeClick() {
  scrollPremiumMarketingSection("plans");
  const card = document.querySelector(".premium-plan-card--featured");
  if (card) {
    card.classList.remove("premium-plan-card--pulse");
    void card.offsetWidth;
    card.classList.add("premium-plan-card--pulse");
  }
}

function premiumSelectPaymentMethod(kind) {
  const k = String(kind || "").toLowerCase();
  document.querySelectorAll("[data-payment-card]").forEach((el) => {
    el.classList.toggle("is-selected", el.getAttribute("data-payment-card") === k);
  });
}

async function premiumPlanCheckoutClick(tier) {
  if (tier !== "standard" && tier !== "premium") return;
  if (!currentUser || !accessToken) {
    showToast(t("premiumCheckoutLoginRequired"));
    openAccountModal();
    return;
  }
  try {
    const billing = premiumLiteBillingMode === "yearly" ? "yearly" : "monthly";
    const data = await apiFetch("/api/create-checkout-session", {
      method: "POST",
      body: JSON.stringify({ plan: tier, billing })
    });
    if (data && data.url) {
      window.location.href = data.url;
      return;
    }
    showToast(t("premiumBillingSoon"));
  } catch (e) {
    showToast(e && e.message ? e.message : t("paymentFailedTryAgain"));
  }
}

async function refreshCurrentUserFromBackend() {
  if (!currentUser || !accessToken) return false;
  try {
    let data = null;
    try {
      data = await apiFetch("/api/me", { method: "GET" });
    } catch {
      data = await apiFetch("/api/profile", { method: "GET" });
    }
    if (!data || !data.user) return false;
    Object.assign(currentUser, data.user);
    persistCurrentUserToStorage();
    updateAccountUI();
    displayAccountInfo();
    return true;
  } catch {
    return false;
  }
}

function consumeCheckoutQueryToast() {
  try {
    const params = new URLSearchParams(window.location.search);
    const path = String(window.location.pathname || "").toLowerCase();
    const checkout = params.get("checkout") || (path === "/success" ? "success" : path === "/pricing" ? "cancel" : "");
    if (checkout !== "success" && checkout !== "cancel") return;

    const cleanUrl = `/${window.location.hash || ""}`;
    window.history.replaceState({}, "", cleanUrl);

    if (checkout === "success") {
      void (async () => {
        await refreshCurrentUserFromBackend();
        await mergePremiumFromServer();
        showToast(t("paymentSuccessfulToast"));
        goHome();
        updatePremiumUi();
        syncPremiumGatedNav();
        setTimeout(() => {
          void mergePremiumFromServer().then(() => {
            updatePremiumUi();
            syncPremiumGatedNav();
          });
        }, 3000);
      })();
      return;
    }
    showToast(t("paymentFailedTryAgain"));
    goHome();
  } catch {
    /* ignore */
  }
}

function consumeBillingRoute() {
  try {
    const path = String(window.location.pathname || "").toLowerCase();
    if (path !== "/billing") return;
    const cleanUrl = `/${window.location.hash || ""}`;
    window.history.replaceState({}, "", cleanUrl);
    void openSettings();
    showToast("Billing loaded. You can review or cancel subscription in your account.");
  } catch {
    /* ignore */
  }
}

async function consumeEmailVerificationQuery() {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = String(params.get("verifyEmailToken") || "").trim();
    if (!token) return;
    const cleanUrl = `${window.location.pathname}${window.location.hash || ""}`;
    window.history.replaceState({}, "", cleanUrl);
    await apiFetch(`/api/verify-email?token=${encodeURIComponent(token)}`, {
      method: "GET"
    });
    showToast("Email verified successfully. You can now log in.");
  } catch (err) {
    showToast((err && err.message) || "Verification link is invalid or expired.");
  }
}

function premiumTestReminderClick() {
  showToast(t("premiumTestReminderToast"));
}

function setPremiumChannelPreview(channel) {
  document.querySelectorAll(".premium-channel-pill").forEach(btn => {
    btn.classList.toggle("is-active", btn.getAttribute("data-channel") === channel);
  });
  const el = document.getElementById("premiumChannelPreview");
  if (!el) return;
  const key =
    channel === "sms"
      ? "premiumChannelPreviewSms"
      : channel === "browser"
        ? "premiumChannelPreviewBrowser"
        : "premiumChannelPreviewWa";
  el.setAttribute("data-t", key);
  el.textContent = t(key);
}

function clearCurrentUser() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("currentUser");
  sessionStorage.removeItem("accessToken");
  sessionStorage.removeItem("refreshToken");
  sessionStorage.removeItem("currentUser");
  currentUser = null;
  accessToken = null;
  refreshToken = null;
  closeNoteEditor();
  closeReminderEditModal();
  currentNotes = [];
  allNotes = [];
  updateAccountUI();
  if (currentCategory) {
    renderNotes([]);
  }
  updatePremiumUi();
}

function getAuthHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function persistAccessToken(token) {
  accessToken = token;
  if (localStorage.getItem("refreshToken")) {
    localStorage.setItem("accessToken", token);
  } else if (sessionStorage.getItem("refreshToken")) {
    sessionStorage.setItem("accessToken", token);
  }
}

async function tryRefreshAccessToken() {
  const rt = refreshToken || getStoredRefreshToken();
  if (!rt) return false;
  const res = await fetch(buildApiUrl("/api/refresh"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: rt })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessToken) {
    return false;
  }
  persistAccessToken(data.accessToken);
  if (data.user && typeof data.user === "object" && currentUser) {
    Object.assign(currentUser, data.user);
    persistCurrentUserToStorage();
    updateAccountUI();
    displayAccountInfo();
  }
  if (typeof socket !== "undefined" && socket.emit) {
    socket.emit("authenticate", data.accessToken);
  }
  return true;
}

async function apiFetch(path, options = {}, isRetry) {
  const skipAuthRefresh =
    path === "/api/login" ||
    path === "/auth/login" ||
    path === "/api/register" ||
    path === "/api/refresh" ||
    path === "/api/auth/google" ||
    path === "/api/auth/pending-google" ||
    path === "/api/auth/complete-google-signup";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(buildApiUrl(path), {
      ...options,
      credentials: "include",
      headers: {
        ...getAuthHeaders(),
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    let data = await response.json().catch(() => ({}));

    if (response.status === 401 && !isRetry && !skipAuthRefresh && refreshToken) {
      const ok = await tryRefreshAccessToken();
      if (ok) {
        return apiFetch(path, options, true);
      }
    }

    if (!response.ok) {
      const err = new Error(data.error || data.message || "Request failed");
      err.status = response.status;
      err.payload = data;
      throw err;
    }

    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Request timed out. Is the server running?");
    }
    if (err instanceof TypeError && err.message.includes("Failed to fetch")) {
      throw new Error("Network error — is the server running?");
    }
    throw err;
  }
}

function isChooseUsernamePath() {
  const p = (window.location.pathname || "").replace(/\/$/, "") || "/";
  return /(^|\/)choose-username\/?$/.test(p);
}

function isSetPasswordPath() {
  return /\/set-password\/?$/.test(window.location.pathname || "");
}

let chooseUsernameInitStarted = false;

/** When true, guest user intentionally opened the login/sign-up overlay (sidebar Account / requireAuth). */
let authLoginModalOpen = false;

function syncAuthShellVisibility() {
  const landing = document.getElementById("authLanding");
  const choose = document.getElementById("chooseUsernameScreen");
  const setPwd = document.getElementById("setPasswordScreen");
  const appEl = document.querySelector(".app");
  const footer = document.querySelector(".site-footer");
  const fab = document.getElementById("dailyPlannerFab");
  const loggedIn = Boolean(currentUser && accessToken);

  if (!loggedIn && isSetPasswordPath()) {
    history.replaceState(null, "", "/" + (window.location.search || ""));
    setPwd?.classList.add("hidden");
  }

  if (loggedIn) {
    authLoginModalOpen = false;
    landing?.classList.add("hidden");
    choose?.classList.add("hidden");

    if (isSetPasswordPath() && userHasLocalPasswordFlag()) {
      history.replaceState(null, "", "/" + (window.location.search || ""));
    }

    if (isSetPasswordPath() && !userHasLocalPasswordFlag()) {
      setPwd?.classList.remove("hidden");
      appEl?.classList.add("hidden");
      footer?.classList.add("hidden");
      if (fab) fab.classList.add("hidden");
      document.body.classList.add("auth-shell-locked");
      window.setTimeout(() => document.getElementById("setPasswordNew")?.focus(), 0);
      return;
    }

    setPwd?.classList.add("hidden");
    appEl?.classList.remove("hidden");
    footer?.classList.remove("hidden");
    if (fab) fab.classList.remove("hidden");
    document.body.classList.remove("auth-shell-locked");
    return;
  }

  setPwd?.classList.add("hidden");

  if (isChooseUsernamePath()) {
    authLoginModalOpen = false;
    landing?.classList.add("hidden");
    choose?.classList.remove("hidden");
    chooseUsernameInitStarted = false;
    document.body.classList.add("auth-shell-locked");
    appEl?.classList.add("hidden");
    footer?.classList.add("hidden");
    if (fab) fab.classList.add("hidden");
    void initChooseUsernameFlow();
    return;
  }

  document.body.classList.remove("auth-shell-locked");
  appEl?.classList.remove("hidden");
  footer?.classList.remove("hidden");
  if (fab) fab.classList.remove("hidden");
  choose?.classList.add("hidden");
  chooseUsernameInitStarted = false;

  if (authLoginModalOpen) {
    landing?.classList.remove("hidden");
    syncAuthGoogleLinkHref();
  } else {
    landing?.classList.add("hidden");
  }
}

function syncAuthGoogleLinkHref() {
  const links = document.querySelectorAll("a.auth-google-link");
  if (!links || !links.length) return;
  let href;
  try {
    href = buildApiUrl("/auth/google");
  } catch {
    const base =
      typeof API_BASE_URL !== "undefined" && API_BASE_URL ? String(API_BASE_URL).replace(/\/+$/, "") : "";
    href = base ? `${base}/auth/google` : "/auth/google";
  }
  links.forEach((a) => {
    a.href = href;
    a.classList.remove("auth-shell__btn-google--disabled", "auth-shell__btn-google--unavailable");
    a.removeAttribute("aria-disabled");
  });
}

function switchAuthTab(mode) {
  const loginPanel = document.getElementById("authLoginPanel");
  const signupPanel = document.getElementById("authSignupPanel");
  const tabLogin = document.getElementById("authTabLogin");
  const tabSignup = document.getElementById("authTabSignup");
  const errL = document.getElementById("authLoginError");
  const errS = document.getElementById("authSignupError");
  if (!loginPanel || !signupPanel || !tabLogin || !tabSignup) return;
  const isLogin = mode !== "signup";
  loginPanel.classList.toggle("hidden", !isLogin);
  signupPanel.classList.toggle("hidden", isLogin);
  tabLogin.classList.toggle("is-active", isLogin);
  tabSignup.classList.toggle("is-active", !isLogin);
  tabLogin.setAttribute("aria-selected", isLogin ? "true" : "false");
  tabSignup.setAttribute("aria-selected", !isLogin ? "true" : "false");
  if (errL) {
    errL.classList.add("hidden");
    errL.textContent = "";
  }
  if (errS) {
    errS.classList.add("hidden");
    errS.textContent = "";
  }
}

const AUTH_REMEMBER_PREF_KEY = "aiNotesAuthRememberMe";

function authPostLoginShellSuccess(data, rememberMe) {
  const remember = rememberMe !== false;
  storeCurrentUser(data.user, data.accessToken, data.refreshToken, remember);
  try {
    localStorage.setItem(AUTH_REMEMBER_PREF_KEY, remember ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
  syncAuthShellVisibility();
  syncMobileHeaderActionUi();
  showToast(`Welcome, ${data.user.username}`);
  goHome();
  refreshReminderRelatedViews();
  void mergePremiumFromServer().then(() => {
    displayAccountInfo();
    void updateHomeDashboardStats();
  });
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  startWebNotificationScheduler();
  if (typeof scheduleOnboardingTutorialAfterAuth === "function") scheduleOnboardingTutorialAfterAuth();
}

async function submitAuthLogin(ev) {
  ev.preventDefault();
  const errEl = document.getElementById("authLoginError");
  const u = document.getElementById("authLoginUsername");
  const p = document.getElementById("authLoginPassword");
  if (errEl) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  }
  const username = (u && u.value.trim()) || "";
  const password = (p && p.value) || "";
  if (!username || !password) {
    if (errEl) {
      errEl.textContent = "Enter username and password.";
      errEl.classList.remove("hidden");
    }
    return;
  }
  const rememberEl = document.getElementById("authLoginRemember");
  const rememberMe = rememberEl ? Boolean(rememberEl.checked) : true;
  try {
    const data = await apiFetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    authPostLoginShellSuccess(data, rememberMe);
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Login failed.";
      errEl.classList.remove("hidden");
    }
  }
}

function initAuthLandingUi() {
  const rememberCb = document.getElementById("authLoginRemember");
  if (rememberCb) {
    try {
      rememberCb.checked = localStorage.getItem(AUTH_REMEMBER_PREF_KEY) !== "0";
    } catch {
      rememberCb.checked = true;
    }
    rememberCb.addEventListener("change", () => {
      try {
        localStorage.setItem(AUTH_REMEMBER_PREF_KEY, rememberCb.checked ? "1" : "0");
      } catch {
        /* ignore */
      }
    });
  }

  document.getElementById("authTabLogin")?.addEventListener("click", () => switchAuthTab("login"));
  document.getElementById("authTabSignup")?.addEventListener("click", () => switchAuthTab("signup"));
  document.getElementById("authLoginForm")?.addEventListener("submit", (ev) => void submitAuthLogin(ev));
  document.getElementById("setPasswordForm")?.addEventListener("submit", (ev) => void submitSetPassword(ev));
  const landing = document.getElementById("authLanding");
  landing?.addEventListener("click", (e) => {
    if (e.target === landing) closeAccountModal();
  });
  document.querySelectorAll("a.auth-google-link").forEach((g) => {
    g.addEventListener("click", () => {
      if (googleOAuthConfigLoaded && !googleOAuthClientId) {
        console.warn(
          "[Google sign-in] Public client id missing from app-config — still navigating to backend OAuth. " +
            "Ensure GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL are set on the server."
        );
      }
    });
  });
}

async function initChooseUsernameFlow() {
  if (chooseUsernameInitStarted) return;
  chooseUsernameInitStarted = true;
  const errEl = document.getElementById("chooseUsernameError");
  const emailEl = document.getElementById("chooseUsernameEmail");
  const input = document.getElementById("chooseUsernameInput");
  if (errEl) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  }
  try {
    const data = await apiFetch("/api/auth/pending-google", { method: "GET" });
    if (emailEl) emailEl.textContent = data.email ? `Signed in as ${data.email}` : "";
    if (input) input.value = "";
  } catch {
    if (errEl) {
      errEl.textContent = "Session expired. Please start Google sign-in again.";
      errEl.classList.remove("hidden");
    }
    chooseUsernameInitStarted = false;
  }
}

async function submitChooseUsername() {
  const errEl = document.getElementById("chooseUsernameError");
  const input = document.getElementById("chooseUsernameInput");
  const username = (input && input.value.trim().toLowerCase()) || "";
  if (errEl) errEl.classList.add("hidden");
  if (username.length < 3) {
    if (errEl) {
      errEl.textContent = "Username must be at least 3 characters.";
      errEl.classList.remove("hidden");
    }
    return;
  }
  try {
    const deviceId = typeof getOrCreateDeviceId === "function" ? getOrCreateDeviceId() : "";
    const data = await apiFetch("/api/auth/complete-google-signup", {
      method: "POST",
      body: JSON.stringify({ username, deviceId })
    });
    storeCurrentUser(data.user, data.accessToken, data.refreshToken, true);
    chooseUsernameInitStarted = false;
    history.replaceState(null, "", "/");
    syncAuthShellVisibility();
    showToast(`Welcome, ${data.user.username}`);
    goHome();
    refreshReminderRelatedViews();
    void mergePremiumFromServer().then(() => {
      displayAccountInfo();
      void updateHomeDashboardStats();
    });
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    startWebNotificationScheduler();
    if (typeof scheduleOnboardingTutorialAfterAuth === "function") scheduleOnboardingTutorialAfterAuth();
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Could not save username.";
      errEl.classList.remove("hidden");
    }
  }
}

function updateAccountUI() {
  const accountButton = document.getElementById("accountButton");
  const logoutButton = document.getElementById("logoutButton");

  if (!accountButton || !logoutButton) {
    return;
  }

  if (currentUser) {
    accountButton.classList.add("hidden");
    logoutButton.classList.remove("hidden");
  } else {
    accountButton.classList.remove("hidden");
    accountButton.innerText = "Sign in";
    logoutButton.classList.add("hidden");
  }
  syncAuthShellVisibility();
}

function openAccountModal() {
  if (currentUser) {
    showToast(`You are already signed in as ${currentUser.username || currentUser.emailOrPhone}`);
    return;
  }
  authLoginModalOpen = true;
  syncAuthShellVisibility();
  syncAuthGoogleLinkHref();
  switchAuthTab("login");
}

function closeAccountModal() {
  authLoginModalOpen = false;
  document.getElementById("authLanding")?.classList.add("hidden");
}

function requireAuth(actionName) {
  if (!currentUser) {
    showToast(`Sign in to ${actionName}.`);
    openAccountModal();
    return false;
  }
  return true;
}

function setBodyHomePage(isHome) {
  document.body.classList.toggle("app-page-home", !!isHome);
}

function goHome() {
  currentCategory = "";
  activateMenu("menuHome");
  void loadDiscordCommunityConfig();
  document.getElementById("home").classList.remove("hidden");
  document.getElementById("category").classList.add("hidden");
  document.getElementById("notes-all").classList.add("hidden");
  document.getElementById("bot").classList.add("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.add("hidden");
  document.getElementById("settings").classList.add("hidden");
  hideScanCamPage();
  hideCoinsHubPage();
  setBodyHomePage(true);
  void loadHomeEmbedRemindersList();
  void updateHomeDashboardStats();
}

function openMyNotes() {
  setBodyHomePage(false);
  activateMenu("menuNotes");
  const notesSearch = document.getElementById("notesSearchInput");
  if (notesSearch) notesSearch.value = "";
  const notesCategoryFilter = document.getElementById("notesCategoryFilter");
  if (notesCategoryFilter) notesCategoryFilter.value = "all";
  allNotesSortMode = "newest";
  const notesSortSelect = document.getElementById("notesSortSelect");
  if (notesSortSelect) notesSortSelect.value = allNotesSortMode;
  document.getElementById("home").classList.add("hidden");
  document.getElementById("category").classList.add("hidden");
  document.getElementById("notes-all").classList.remove("hidden");
  document.getElementById("bot").classList.add("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.add("hidden");
  document.getElementById("settings").classList.add("hidden");
  hideScanCamPage();
  hideCoinsHubPage();
  loadMyNotes();
}

function openCategory(cat) {
  setBodyHomePage(false);
  currentCategory = cat;
  activateMenu("");
  document.getElementById("home").classList.add("hidden");
  document.getElementById("category").classList.remove("hidden");
  document.getElementById("notes-all").classList.add("hidden");
  document.getElementById("bot").classList.add("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.add("hidden");
  document.getElementById("settings").classList.add("hidden");
  hideScanCamPage();
  hideCoinsHubPage();
  document.getElementById("catTitle").innerText = categories[cat] || cat;
  const scanBanner = document.getElementById("scanCamCategoryBanner");
  if (scanBanner) scanBanner.classList.toggle("hidden", cat !== "scan_cam" || !currentUser);

  const categoryAddBtn = document.getElementById("categoryAddNoteBtn");
  const categoryScanBtn = document.getElementById("categoryScanCamBtn");
  if (categoryAddBtn && categoryScanBtn) {
    const isScanCam = cat === "scan_cam";
    categoryAddBtn.classList.toggle("hidden", isScanCam);
    categoryScanBtn.classList.toggle("hidden", !isScanCam);
  }

  if (currentUser) {
    loadNotes();
  } else {
    renderNotes(getPublicNotes());
  }
  const webReminderSection = document.getElementById("webReminderSection");
  if (webReminderSection) webReminderSection.style.display = "none";
}

function openBot() {
  setBodyHomePage(false);
  activateMenu("menuBot");
  document.getElementById("home").classList.add("hidden");
  document.getElementById("category").classList.add("hidden");
  document.getElementById("notes-all").classList.add("hidden");
  document.getElementById("bot").classList.remove("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.add("hidden");
  document.getElementById("settings").classList.add("hidden");
  hideScanCamPage();
  hideCoinsHubPage();
  updatePremiumUi();
  premiumLiteInitPricingUi();
}

async function openCoinsRewards() {
  if (!requireAuth("use rewards")) return;
  setBodyHomePage(false);
  activateMenu("menuCoinsRewards");
  document.getElementById("home").classList.add("hidden");
  document.getElementById("category").classList.add("hidden");
  document.getElementById("notes-all").classList.add("hidden");
  document.getElementById("bot").classList.add("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.add("hidden");
  document.getElementById("settings").classList.add("hidden");
  hideScanCamPage();
  const hub = document.getElementById("coins-hub");
  if (hub) hub.classList.remove("hidden");
  applyTranslations();
  await refreshCoinsHubUi();
}

function coinsHubBuildInviteUrl(codeRaw) {
  const code =
    typeof codeRaw === "string" && codeRaw.trim().length > 0 && codeRaw.trim() !== "—"
      ? codeRaw
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
      : "";
  if (!code || code.length < 4) return "";
  return `${window.location.origin}/invite/${encodeURIComponent(code)}`;
}

function coinsHubApplyStreakUi(coins) {
  const grid = document.getElementById("coinsHubStreakGrid");
  const progressEl = document.getElementById("coinsHubStreakProgressText");
  const barFill = document.getElementById("coinsHubStreakBarFill");
  if (!grid) return;

  const dl = coins && coins.dailyLogin ? coins.dailyLogin : {};
  const nextIdx = Math.min(7, Math.max(1, Number(dl.nextStreakIndex) || 1));
  const claimedToday = Boolean(dl.claimedToday);
  const amounts =
    Array.isArray(dl.streakStepCoins) && dl.streakStepCoins.length === 7
      ? dl.streakStepCoins.map((x) => Math.max(0, Math.floor(Number(x) || 0)))
      : [10, 15, 20, 25, 30, 40, 60];

  const completed = Math.max(
    0,
    Math.min(7, claimedToday ? (nextIdx === 1 ? 7 : nextIdx - 1) : nextIdx - 1)
  );

  if (progressEl && typeof t === "function") {
    if (claimedToday && completed > 0) {
      const tpl = t("coinsDailyStreakChecked");
      const nStr = String(completed);
      const parts = tpl.split("{n}");
      const safe = (s) => escapeHtml(s || "");
      progressEl.innerHTML =
        `${safe(parts[0])}<span class="coins-daily-checkin-head__accent">${escapeHtml(nStr)}</span>${safe(parts.slice(1).join("{n}"))}`;
    } else if (claimedToday) {
      progressEl.textContent = t("coinsHubStreakDoneShort");
    } else {
      progressEl.textContent = t("coinsHubStreakDayProgress").replace("{n}", String(nextIdx));
    }
  }

  const pct = (completed / 7) * 100;
  if (barFill) barFill.style.width = `${pct}%`;

  grid.innerHTML = "";
  const dayOnly =
    typeof t === "function" ? (n) => t("coinsHubStreakDayOnly").replace("{d}", String(n)) : (n) => `Day ${n}`;
  const todayTag = typeof t === "function" ? t("coinsHubStreakTodayTag") : "Today";

  for (let d = 1; d <= 7; d += 1) {
    const amt = amounts[d - 1];
    const done = d <= completed;
    const claimable = !claimedToday && d === nextIdx;
    const locked = !done && !claimable;

    const labelHint = `${dayOnly(d)} · +${amt}`;

    if (claimable) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        `daily-checkin-slot daily-checkin-slot--claim${d === 7 ? " daily-checkin-slot--finale" : ""}`.trim();
      btn.setAttribute("data-day", String(d));
      btn.setAttribute("role", "listitem");
      btn.setAttribute("aria-label", `${todayTag}: +${amt}`);
      btn.innerHTML =
        `<span class="daily-checkin-slot__coin-ring" aria-hidden="true"><span class="daily-checkin-slot__coin">🪙</span></span>` +
        `<span class="daily-checkin-slot__amt">+${amt}</span>` +
        `<span class="daily-checkin-slot__meta">${escapeHtml(todayTag)}</span>`;
      btn.onclick = () => void coinsHubClaimDaily();
      grid.appendChild(btn);
      continue;
    }

    const box = document.createElement("div");
    box.className =
      `daily-checkin-slot${done ? " daily-checkin-slot--done" : " daily-checkin-slot--locked"}${
        d === 7 ? " daily-checkin-slot--finale" : ""
      }`.trim();
    box.setAttribute("data-day", String(d));
    box.setAttribute("role", "listitem");
    box.setAttribute(
      "aria-label",
      done ? `${labelHint} (${typeof t === "function" ? t("coinsHubStreakRowDone") : "Done"})` : labelHint
    );

    const coinMarkup = done
      ? `<span class="daily-checkin-slot__coin-ring" aria-hidden="true"><span class="daily-checkin-slot__coin">🪙</span><span class="daily-checkin-slot__tick">✓</span></span>` +
        `<span class="daily-checkin-slot__amt daily-checkin-slot__amt--muted">+${amt}</span>` +
        `<span class="daily-checkin-slot__meta daily-checkin-slot__meta--done">${escapeHtml(dayOnly(d))}</span>`
      : `<span class="daily-checkin-slot__coin-ring" aria-hidden="true"><span class="daily-checkin-slot__coin daily-checkin-slot__coin--muted">🪙</span></span>` +
        `<span class="daily-checkin-slot__amt daily-checkin-slot__amt--locked">+${amt}</span>` +
        `<span class="daily-checkin-slot__meta daily-checkin-slot__meta--locked">${escapeHtml(dayOnly(d))}</span>`;

    box.innerHTML = coinMarkup;
    grid.appendChild(box);
  }
}

function coinsHubAnimateClaimedDay(dayNum) {
  const d = Number(dayNum);
  if (!Number.isFinite(d) || d < 1 || d > 7) return;
  const el = document.querySelector(`#coinsHubStreakGrid .daily-checkin-slot[data-day="${d}"]`);
  if (!el) return;
  el.classList.remove("daily-checkin-slot--pop");
  void el.offsetWidth;
  el.classList.add("daily-checkin-slot--pop");
  window.setTimeout(() => el.classList.remove("daily-checkin-slot--pop"), 720);
}

function coinsHubPulseHero() {
  const pulseTargets = document.querySelectorAll(".coins-dash-card--hero, .coins-daily-checkin-card");
  pulseTargets.forEach((hero) => {
    if (!hero) return;
    hero.classList.remove("coins-dash-pulse");
    void hero.offsetWidth;
    hero.classList.add("coins-dash-pulse");
    window.setTimeout(() => hero.classList.remove("coins-dash-pulse"), 750);
  });
}

async function refreshCoinsHubUi() {
  const ok = await mergePremiumFromServer();
  if (!ok) {
    showToast(typeof t === "function" ? t("coinsHubUpdateFailed") : "Could not refresh your plan.");
    return;
  }
  let coins = null;
  try {
    coins = await apiFetch("/api/coins/status");
  } catch {
    coins = null;
  }

  const balEl = document.getElementById("coinsHubBalanceValue");
  const capDisplay = document.getElementById("coinsHubCapDisplay");
  const capFill = document.getElementById("coinsHubCapFill");
  const walletLabel = document.getElementById("coinsHubWalletLabel");
  const progFill = document.getElementById("coinsHubProgressFill");
  const progLabel = document.getElementById("coinsHubProgressLabel");
  const trialBan = document.getElementById("coinsHubTrialBanner");
  const trialText = document.getElementById("coinsHubTrialText");
  const btnVideo = document.getElementById("coinsHubVideoBtn");
  const btnRedeem = document.getElementById("coinsHubRedeemBtn");
  const videoLbl = document.getElementById("coinsHubVideoBtnLabel");
  const redeemLbl = document.getElementById("coinsHubRedeemBtnLabel");
  const codeEl = document.getElementById("coinsHubReferralCode");
  const linkInput = document.getElementById("coinsHubInviteLinkInput");
  const inviteStatsLine = document.getElementById("coinsHubInviteStatsLine");
  const multEl = document.getElementById("coinsHubEarnMult");
  const videoMeta = document.getElementById("coinsHubVideoCooldown");
  const videoRowMeta = document.getElementById("coinsHubVideoRowMeta");
  const topBalChip = document.getElementById("coinsHubTopBalance");
  const topCapChip = document.getElementById("coinsHubTopCap");

  if (!coins || coins.cap == null) {
    if (topBalChip) topBalChip.textContent = "0";
    if (balEl) balEl.textContent = "0";
    return;
  }

  const balance = Number(coins.balance) || 0;
  const cap = Number(coins.cap) || 1200;
  const cost = coins.standardCoinCost || 600;
  const vReward = coins.videoRewards && coins.videoRewards.rewardEach != null ? Number(coins.videoRewards.rewardEach) : 10;
  const codeStr =
    coins.referralCode && String(coins.referralCode).trim() ? String(coins.referralCode).trim() : "";
  const inviteUrl = coinsHubBuildInviteUrl(codeStr);

  coinsHubApplyStreakUi(coins);

  if (topBalChip) topBalChip.textContent = String(balance);
  if (topCapChip) topCapChip.textContent = String(cap);
  if (balEl) balEl.textContent = String(balance);
  if (capDisplay) capDisplay.textContent = String(cap);
  const capPct = cap ? Math.min(100, (balance / cap) * 100) : 0;
  if (capFill) capFill.style.width = `${capPct}%`;
  if (walletLabel && typeof t === "function") {
    walletLabel.textContent = t("coinsDashWalletProgress").replace("{b}", String(balance)).replace("{cap}", String(cap));
  }

  const goalPct = cost ? Math.min(100, (balance / cost) * 100) : 0;
  if (progFill) progFill.style.width = `${goalPct}%`;
  if (progLabel && typeof t === "function") {
    progLabel.textContent = t("coinsProgressToStandardShort").replace("{b}", String(balance)).replace("{cost}", String(cost));
  }

  const claimedToday = Boolean(coins.dailyLogin && coins.dailyLogin.claimedToday);
  if (videoLbl && typeof t === "function") {
    videoLbl.textContent = t("coinsHubVideoGo");
  }
  if (videoRowMeta && typeof t === "function" && coins.videoRewards) {
    const cnt = Number(coins.videoRewards.countToday) || 0;
    const maxv = Number(coins.videoRewards.maxToday) || 0;
    videoRowMeta.textContent = t("coinsHubVideoRowMeta")
      .replace("{n}", String(cnt))
      .replace("{max}", String(maxv))
      .replace("{reward}", String(vReward));
  } else if (videoRowMeta) {
    videoRowMeta.textContent = "";
  }
  if (redeemLbl && typeof t === "function") {
    redeemLbl.textContent = t("coinsRedeemBtnActive").replace("{cost}", String(cost));
  }

  if (trialBan && trialText) {
    if (coins.lifecycle === "trial") {
      const left = coins.trialDaysRemaining != null ? String(coins.trialDaysRemaining) : "—";
      trialBan.classList.remove("hidden");
      trialText.textContent = typeof t === "function" ? t("coinsTrialHint").replace("{d}", left) : "";
    } else {
      trialBan.classList.add("hidden");
      trialText.textContent = "";
    }
  }

  if (btnVideo) {
    const vCap = Boolean(coins.videoRewards && coins.videoRewards.countToday >= coins.videoRewards.maxToday);
    btnVideo.disabled = vCap;
    btnVideo.classList.toggle("coins-hub-task__go--disabled", vCap);
  }
  if (videoMeta && typeof t === "function") {
    const capHit = Boolean(coins.videoRewards && coins.videoRewards.countToday >= coins.videoRewards.maxToday);
    videoMeta.textContent = capHit ? t("coinsHubVideoCappedFoot") : "";
  }
  if (btnRedeem) {
    btnRedeem.disabled = coins.lifecycle === "premium" || balance < cost;
  }

  if (codeEl) {
    codeEl.textContent = codeStr || "—";
  }
  if (linkInput) {
    linkInput.value = inviteUrl;
    linkInput.toggleAttribute("disabled", !inviteUrl);
  }

  const friendsTotal = coins.inviteFriendsTotal != null ? Number(coins.inviteFriendsTotal) : null;
  const inviteEarned = coins.inviteCoinsEarnedThisMonth != null ? Number(coins.inviteCoinsEarnedThisMonth) : null;
  if (inviteStatsLine && typeof t === "function") {
    const f = friendsTotal != null ? String(friendsTotal) : "0";
    const iv = inviteEarned != null ? String(inviteEarned) : "0";
    inviteStatsLine.textContent =
      `${t("coinsDashFriendsStat").replace("{n}", f)} · ${t("coinsDashInviteCoinsStat").replace("{n}", iv)}`;
  }

  if (multEl && typeof t === "function") {
    const nm = coins.earnMultiplierPreview != null ? Number(coins.earnMultiplierPreview) : 1;
    multEl.textContent = nm < 0.995 ? t("coinsEarnReducedNotice") : "";
    multEl.classList.toggle("hidden", nm >= 0.995);
  }
}

async function coinsHubClaimDaily() {
  if (!requireAuth("collect rewards")) return;
  const cur = document.querySelector("#coinsHubStreakGrid .daily-checkin-slot--claim");
  const claimedDay = cur ? Number(cur.getAttribute("data-day")) : null;
  try {
    await apiFetch("/api/coins/daily-login", { method: "POST", body: JSON.stringify({}) });
  } catch (e) {
    showToast(e && e.message ? e.message : t("coinsActionFailed"));
    return;
  }
  await refreshCoinsHubUi();
  coinsHubPulseHero();
  if (claimedDay != null && Number.isFinite(claimedDay)) coinsHubAnimateClaimedDay(claimedDay);
}

async function coinsHubWatchVideoAd() {
  if (!requireAuth("watch rewarded ads")) return;
  const vidRow = document.querySelector(".coins-hub-task--video");
  try {
    await apiFetch("/api/coins/rewarded-ad", { method: "POST", body: JSON.stringify({}) });
  } catch (e) {
    showToast(e && e.message ? e.message : t("coinsActionFailed"));
    return;
  }
  if (vidRow) {
    vidRow.classList.remove("coins-hub-task--burst");
    void vidRow.offsetWidth;
    vidRow.classList.add("coins-hub-task--burst");
    window.setTimeout(() => vidRow.classList.remove("coins-hub-task--burst"), 600);
  }
  await refreshCoinsHubUi();
  coinsHubPulseHero();
}

async function coinsHubRedeemStandard() {
  if (!requireAuth("redeem rewards")) return;
  const msg = typeof t === "function" ? t("coinsRedeemConfirm") : "Spend 600 coins for 30 days of Standard access?";
  const okConfirm = typeof window !== "undefined" && window.confirm && window.confirm(msg);
  if (!okConfirm) return;
  try {
    await apiFetch("/api/coins/redeem-standard", { method: "POST", body: JSON.stringify({}) });
    showToast(typeof t === "function" ? t("coinsRedeemSuccess") : "Standard unlocked with coins.");
  } catch (e) {
    showToast(e && e.message ? e.message : typeof t === "function" ? t("coinsActionFailed") : "Action failed.");
    return;
  }
  await refreshCoinsHubUi();
  coinsHubPulseHero();
}

function coinsHubCopyInvite() {
  const inp = document.getElementById("coinsHubInviteLinkInput");
  const fromInput = inp && typeof inp.value === "string" && inp.value.trim() ? inp.value.trim() : "";
  if (fromInput) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(fromInput)
        .then(() => showToast(typeof t === "function" ? t("coinsInviteCopied") : "Link copied"))
        .catch(() => window.prompt("", fromInput));
    } else {
      window.prompt("", fromInput);
    }
    return;
  }
  const raw = document.getElementById("coinsHubReferralCode");
  const code =
    raw &&
    typeof raw.textContent === "string" &&
    raw.textContent.trim().length > 0 &&
    raw.textContent.trim() !== "—"
      ? raw.textContent.trim().toUpperCase()
      : currentUser && currentUser.referralCode
        ? String(currentUser.referralCode).trim().toUpperCase()
        : "";
  if (!code) {
    showToast(typeof t === "function" ? t("coinsInviteNoCode") : "Invite code unavailable.");
    return;
  }
  const link = coinsHubBuildInviteUrl(code);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(link)
      .then(() => showToast(typeof t === "function" ? t("coinsInviteCopied") : "Link copied"))
      .catch(() => window.prompt("", link));
    return;
  }
  window.prompt("", link);
}

function coinsHubShareInvite() {
  const inp = document.getElementById("coinsHubInviteLinkInput");
  const url = inp && inp.value ? String(inp.value).trim() : "";
  if (!url) {
    coinsHubCopyInvite();
    return;
  }
  const payload = {
    title: typeof t === "function" ? t("coinsDashInviteFriendsTitle") : "Notes AI",
    text: typeof t === "function" ? t("coinsDashShareSubject") : "",
    url
  };
  if (navigator.share) {
    navigator.share(payload).catch(() => coinsHubCopyInvite());
  } else {
    coinsHubCopyInvite();
  }
}

function premiumLiteInitPricingUi() {
  premiumLiteSelectPlan("premium", { initial: true });
  premiumLiteBillingToggle("monthly");
}

function premiumLiteSelectPlan(plan, opts = {}) {
  const target = String(plan || "").toLowerCase();
  const grid = document.querySelector(".pricing-lite-grid");
  const cards = document.querySelectorAll(".pricing-lite-card[data-lite-plan]");
  if (!cards.length) return;
  cards.forEach((card) => {
    const is = card.getAttribute("data-lite-plan") === target;
    card.classList.toggle("is-selected", is);
    card.classList.toggle("is-focus", is && target === "premium");
  });
  if (grid) grid.classList.add("has-selected");
  if (!opts.initial) {
    const selected = document.querySelector(`.pricing-lite-card[data-lite-plan="${target}"]`);
    if (selected && typeof selected.scrollIntoView === "function" && window.matchMedia("(max-width: 840px)").matches) {
      selected.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
}

function premiumLiteBillingToggle(mode) {
  const m = mode === "yearly" ? "yearly" : "monthly";
  premiumLiteBillingMode = m;
  document.querySelectorAll(".pricing-lite-billing-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-billing") === m);
  });
  const stdMain = document.getElementById("premiumLiteStandardPriceMain");
  const stdPeriod = document.getElementById("premiumLiteStandardPricePeriod");
  const stdSub = document.getElementById("premiumLiteStandardSub");
  const premMain = document.getElementById("premiumLitePremiumPriceMain");
  const premPeriod = document.getElementById("premiumLitePremiumPricePeriod");
  const premSub = document.getElementById("premiumLitePremiumSub");
  const stdCta = document.getElementById("premiumLiteStandardCta");
  const premCta = document.getElementById("premiumLitePremiumCta");
  const sticky = document.getElementById("premiumLiteStickyCta");
  const saveLine = document.getElementById("premiumLiteSaveLine");
  const social = document.getElementById("premiumLiteSocialProof");
  const root = document.getElementById("premiumPlansSection");
  if (saveLine) {
    saveLine.setAttribute("data-t", "premiumLitePremSubtitle");
    saveLine.textContent = t("premiumLitePremSubtitle");
  }
  if (root) root.classList.toggle("pricing-lite-plans--yearly", m === "yearly");
  if (m === "yearly") {
    if (stdMain) stdMain.textContent = "€29";
    if (stdPeriod) stdPeriod.textContent = "/year";
    if (premMain) premMain.textContent = "€49";
    if (premPeriod) premPeriod.textContent = "/year";
    if (stdSub) {
      stdSub.classList.remove("hidden");
      stdSub.textContent = t("premiumLiteYearlyStandardSub");
    }
    if (premSub) {
      premSub.classList.remove("hidden");
      premSub.textContent = t("premiumLiteYearlyPremiumSub");
    }
    if (stdCta) {
      stdCta.setAttribute("data-t", "premiumLiteCtaStandardYearly");
      stdCta.textContent = t("premiumLiteCtaStandardYearly");
    }
    if (premCta) {
      premCta.setAttribute("data-t", "premiumLiteCtaPremiumYearly");
      premCta.textContent = t("premiumLiteCtaPremiumYearly");
    }
    if (sticky) {
      sticky.setAttribute("data-t", "premiumLiteCtaPremiumYearly");
      sticky.textContent = t("premiumLiteCtaPremiumYearly");
    }
    if (social) {
      social.setAttribute("data-t", "premiumLitePremiumYearlyFootnote");
      social.textContent = t("premiumLitePremiumYearlyFootnote");
    }
  } else {
    if (stdMain) stdMain.textContent = "€2.99";
    if (stdPeriod) stdPeriod.textContent = "/month";
    if (premMain) premMain.textContent = "€4.99";
    if (premPeriod) premPeriod.textContent = "/month";
    if (stdSub) stdSub.classList.add("hidden");
    if (premSub) premSub.classList.add("hidden");
    if (stdCta) {
      stdCta.setAttribute("data-t", "premiumLiteCtaStandard");
      stdCta.textContent = t("premiumLiteCtaStandard");
    }
    if (premCta) {
      premCta.setAttribute("data-t", "premiumLiteCtaPremium2");
      premCta.textContent = t("premiumLiteCtaPremium2");
    }
    if (sticky) {
      sticky.setAttribute("data-t", "premiumLiteCtaPremium2");
      sticky.textContent = t("premiumLiteCtaPremium2");
    }
    if (social) {
      social.setAttribute("data-t", "premiumLiteSocialProofSoft");
      social.textContent = t("premiumLiteSocialProofSoft");
    }
  }
}

function premiumLiteToggleCompare() {
  const el = document.getElementById("pricingLiteCompare");
  if (!el) return;
  el.classList.toggle("hidden");
}

function webChatDrawerIsOpen() {
  const el = document.getElementById("webChat");
  return !!(el && !el.classList.contains("hidden"));
}

function webChatQuickPanelOpen() {
  const panel = document.getElementById("webChatQuickPanel");
  return !!(panel && !panel.classList.contains("hidden"));
}

function closeWebChatQuickActions() {
  const panel = document.getElementById("webChatQuickPanel");
  if (panel) panel.classList.add("hidden");
}

function toggleWebChatQuickActions(ev) {
  if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
  const panel = document.getElementById("webChatQuickPanel");
  if (!panel) return;
  if (panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
    const tip = document.getElementById("webChatFabTip");
    if (tip) tip.classList.add("hidden");
  } else {
    panel.classList.add("hidden");
  }
}

function openWebChatFromQuickAction(kind) {
  const k = String(kind || "ask");
  closeWebChatQuickActions();
  if (k === "planner") {
    openDailyPlannerModal();
    return;
  }
  void openWebChat().then(() => {
    if (k === "reminder") {
      try {
        webChatFillInput(t("webChatReminderExample1"));
      } catch {
        webChatFillInput("Më kujto nesër në 12:00");
      }
    }
  });
}

function getWebChatFabContextKey() {
  const pageMap = [
    ["notes-all", "webChatFabTipNotes"],
    ["home", "webChatFabTipHome"],
    ["scan-cam", "webChatFabTipScan"]
  ];
  for (const [id, key] of pageMap) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains("hidden")) return key;
  }
  return "webChatFabTip";
}

function showWebChatFabTip() {
  if (webChatDrawerIsOpen() || webChatQuickPanelOpen()) return;
  const tip = document.getElementById("webChatFabTip");
  const fab = document.getElementById("webChatFab");
  if (!tip || !fab) return;
  const key = getWebChatFabContextKey();
  const textNode = tip.querySelector("span");
  if (textNode) {
    textNode.setAttribute("data-t", key);
    textNode.textContent = t(key);
  }
  tip.classList.remove("hidden");
  fab.classList.add("is-teasing");
  if (webChatFabTipTimer) window.clearTimeout(webChatFabTipTimer);
  webChatFabTipTimer = window.setTimeout(() => {
    tip.classList.add("hidden");
    fab.classList.remove("is-teasing");
  }, 4400);
}

function scheduleWebChatFabPromptCycle() {
  if (webChatFabPromptCycleTimer) window.clearInterval(webChatFabPromptCycleTimer);
  webChatFabPromptCycleTimer = window.setInterval(() => {
    showWebChatFabTip();
  }, 19000);
}

function webChatSetUnread(count) {
  webChatUnreadCount = Math.max(0, Number(count) || 0);
  const badge = document.getElementById("webChatFabBadge");
  if (!badge) return;
  if (webChatUnreadCount <= 0) {
    badge.classList.add("hidden");
    badge.textContent = "0";
    return;
  }
  badge.classList.remove("hidden");
  badge.textContent = webChatUnreadCount > 99 ? "99+" : String(webChatUnreadCount);
}

function normalizeSocialInviteUrl(raw) {
  const s = String(raw || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

function syncCommunitySocialLink(sidebarId, homeId, url, rowVisible) {
  const href = normalizeSocialInviteUrl(url);
  const active = Boolean(href);
  for (const id of [sidebarId, homeId]) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!rowVisible) {
      el.classList.add("hidden");
      el.removeAttribute("href");
      el.classList.remove("social-community-link--inactive");
      el.removeAttribute("aria-disabled");
      el.removeAttribute("tabindex");
      continue;
    }
    el.classList.remove("hidden");
    if (active) {
      el.setAttribute("href", href);
      el.classList.remove("social-community-link--inactive");
      el.removeAttribute("aria-disabled");
      el.removeAttribute("tabindex");
    } else {
      el.removeAttribute("href");
      el.classList.add("social-community-link--inactive");
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("tabindex", "-1");
    }
  }
  return active;
}

function applyDiscordCommunityUi() {
  const hasAny =
    normalizeSocialInviteUrl(discordCommunityUrl) ||
    normalizeSocialInviteUrl(tiktokCommunityUrl) ||
    normalizeSocialInviteUrl(youtubeCommunityUrl);
  const dOk = syncCommunitySocialLink(
    "sidebarSocialDiscord",
    "homeSocialDiscord",
    discordCommunityUrl,
    hasAny
  );
  syncCommunitySocialLink("sidebarSocialTiktok", "homeSocialTiktok", tiktokCommunityUrl, hasAny);
  syncCommunitySocialLink("sidebarSocialYoutube", "homeSocialYoutube", youtubeCommunityUrl, hasAny);
  const block = document.getElementById("sidebarSocialBlock");
  const card = document.getElementById("homeSocialCard");
  if (block) block.classList.toggle("hidden", !hasAny);
  if (card) card.classList.toggle("hidden", !hasAny);
  const badge = document.getElementById("sidebarDiscordBadge");
  if (badge) {
    const n = Math.max(0, Number(discordUpdatesCount) || 0);
    badge.classList.toggle("hidden", !(dOk && n > 0));
    badge.textContent = n > 99 ? "99+" : String(n);
  }
  const ariaPairs = [
    ["sidebarSocialDiscord", "socialAriaDiscord"],
    ["sidebarSocialTiktok", "socialAriaTiktok"],
    ["sidebarSocialYoutube", "socialAriaYoutube"],
    ["homeSocialDiscord", "socialAriaDiscord"],
    ["homeSocialTiktok", "socialAriaTiktok"],
    ["homeSocialYoutube", "socialAriaYoutube"]
  ];
  if (typeof t === "function") {
    for (const [id, key] of ariaPairs) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (!hasAny || el.classList.contains("hidden") || el.classList.contains("social-community-link--inactive")) {
        el.removeAttribute("aria-label");
      } else {
        el.setAttribute("aria-label", t(key));
      }
    }
  }
}

async function loadDiscordCommunityConfig() {
  if (loadDiscordCommunityConfigInflight) return loadDiscordCommunityConfigInflight;
  loadDiscordCommunityConfigInflight = (async () => {
    try {
      const res = await fetch(buildApiUrl("/api/public/app-config"), {
        method: "GET",
        credentials: "include",
        cache: "no-store"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load app config");
      discordCommunityUrl = String((data && data.discordInviteUrl) || "").trim();
      discordUpdatesCount = Math.max(0, Number((data && data.discordUpdatesCount) || 0));
      tiktokCommunityUrl = String((data && data.tiktokUrl) || "").trim();
      youtubeCommunityUrl = String((data && data.youtubeUrl) || "").trim();
      stripePublishableKey = String((data && data.stripePublishableKey) || "").trim();
      googleOAuthClientId = String((data && data.googleClientId) || "").trim();
    } catch {
      discordCommunityUrl = "";
      discordUpdatesCount = 0;
      tiktokCommunityUrl = "";
      youtubeCommunityUrl = "";
      stripePublishableKey = "";
      googleOAuthClientId = "";
    } finally {
      googleOAuthConfigLoaded = true;
    }
    applyDiscordCommunityUi();
    syncAuthGoogleLinkHref();
  })();
  try {
    await loadDiscordCommunityConfigInflight;
  } finally {
    loadDiscordCommunityConfigInflight = null;
  }
}

/** After OAuth redirect: tokens in #google_oauth=… then GET /api/me to load user (hash kept small). */
async function consumeGoogleOAuthFromHash() {
  const params = new URLSearchParams(window.location.search);
  const qErr = params.get("google_oauth_error");
  if (qErr) {
    const raw = decodeURIComponent(qErr);
    const friendly =
      raw === "account_exists"
        ? typeof t === "function"
          ? t("accountAlreadyExistsToast")
          : "Account already exists. Please log in."
        : raw === "account_conflict"
          ? "This email is linked to another sign-in method."
          : `Google sign-in: ${raw}`;
    showToast(friendly);
    params.delete("google_oauth_error");
    const qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    return;
  }
  const h = window.location.hash || "";
  if (!h.includes("google_oauth=")) return;
  try {
    const idx = h.indexOf("google_oauth=") + "google_oauth=".length;
    const parsed = JSON.parse(decodeURIComponent(h.substring(idx)));
    if (!parsed.accessToken || !parsed.refreshToken) {
      showToast("Google sign-in could not be completed.");
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return;
    }
    accessToken = parsed.accessToken;
    refreshToken = parsed.refreshToken;
    localStorage.setItem("accessToken", parsed.accessToken);
    localStorage.setItem("refreshToken", parsed.refreshToken);
    const data = await apiFetch("/api/me", { method: "GET" });
    if (!data || !data.user) {
      showToast("Could not load account after Google sign-in.");
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return;
    }
    storeCurrentUser(data.user, parsed.accessToken, parsed.refreshToken, true);
    syncMobileHeaderActionUi();
    history.replaceState(null, "", window.location.pathname + window.location.search);
    const finishGoogleOAuthSuccess = () => {
      refreshReminderRelatedViews();
      void mergePremiumFromServer().then(() => {
        displayAccountInfo();
        void updateHomeDashboardStats();
      });
    };

    if (isSetPasswordPath() && !userHasLocalPasswordFlag()) {
      showToast(`Welcome, ${data.user.username}`);
      finishGoogleOAuthSuccess();
      syncAuthShellVisibility();
      return;
    }

    showToast(`Welcome, ${data.user.username}`);
    goHome();
    if (/\/dashboard\/?$/.test(window.location.pathname || "")) {
      history.replaceState(null, "", "/" + (window.location.search || ""));
    }
    finishGoogleOAuthSuccess();
    if (typeof scheduleOnboardingTutorialAfterAuth === "function") scheduleOnboardingTutorialAfterAuth();
  } catch (e) {
    console.error(e);
    showToast("Google sign-in could not be completed.");
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function webChatMarkUnreadFromBot() {
  if (webChatDrawerIsOpen()) return;
  webChatSetUnread(webChatUnreadCount + 1);
  const fab = document.getElementById("webChatFab");
  if (fab) {
    fab.classList.remove("web-chat-fab--shake");
    requestAnimationFrame(() => fab.classList.add("web-chat-fab--shake"));
    window.setTimeout(() => fab.classList.remove("web-chat-fab--shake"), 320);
  }
}

function closeWebChatDrawer() {
  const el = document.getElementById("webChat");
  if (!el) return;
  el.classList.remove("web-chat-drawer--active", "web-chat-drawer--opening");
  window.setTimeout(() => {
    if (!el.classList.contains("web-chat-drawer--active")) el.classList.add("hidden");
  }, 260);
  document.body.classList.remove("web-chat-drawer-open");
}

async function openWebChat() {
  if (!requireAuth("use Web Chat")) return;
  const mergedOk = await mergePremiumFromServer();
  if (!mergedOk) {
    showToast(t("webChatPlanVerifyFailed"));
    openBot();
    return;
  }
  setBodyHomePage(false);
  const drawer = document.getElementById("webChat");
  if (!drawer) return;
  drawer.classList.remove("hidden");
  window.requestAnimationFrame(() => drawer.classList.add("web-chat-drawer--active"));
  drawer.classList.add("web-chat-drawer--opening");
  window.setTimeout(() => drawer.classList.remove("web-chat-drawer--opening"), 300);
  document.body.classList.add("web-chat-drawer-open");
  webChatSetUnread(0);
  closeWebChatQuickActions();
  webChatModelClosePopover();
  if (typeof applyTranslations === "function") applyTranslations();
  syncWebChatModelSelectorUi();
  syncWebChatModePresentation(getWebChatMode(), false);
  syncWebChatSoftPaywallUi();
  syncPremiumGatedNav();
  ensureWebChatWelcome();
  webChatRenderRecentCommands();
  const tip = document.getElementById("webChatFabTip");
  if (tip) tip.classList.add("hidden");
}

function ensureWebChatWelcome() {
  const box = document.getElementById("webChatMessages");
  if (!box || box.children.length) return;
  appendWebChatBubble("bot", "", { welcomeExamples: true, mode: getWebChatMode() });
}

function refreshWebChatWelcomeForMode(modeValue) {
  const box = document.getElementById("webChatMessages");
  if (!box) return;
  if (box.querySelector(".web-chat-row--user")) return;
  const welcomeBubble = box.querySelector(".web-chat-bubble--welcome");
  if (!welcomeBubble) return;
  welcomeBubble.innerHTML = "";
  renderWebChatWelcomeContent(welcomeBubble, modeValue);
}

function renderWebChatWelcomeContent(bubble, modeValue) {
  const mode = modeValue === "auto" || modeValue === "openai" ? modeValue : "chatbot";
  const p = document.createElement("p");
  p.className = "web-chat-welcome-one";
  const key = mode === "openai" ? "webChatWelcomeOneLineOpenAi" : "webChatWelcomeOneLine";
  p.setAttribute("data-t", key);
  try {
    p.textContent = t(key);
  } catch {
    p.textContent = "";
  }
  bubble.appendChild(p);
}

function webChatFadeWelcomeExamples() {
  const el = document.getElementById("webChatWelcomeExamples");
  if (!el || el.classList.contains("web-chat-welcome-examples--hidden")) return;
  el.classList.add("web-chat-welcome-examples--hidden");
}

function webChatFillInput(value) {
  const input = document.getElementById("webChatInput");
  if (!input) return;
  input.value = String(value || "");
  webChatAutoResizeInput(input);
  input.focus();
  if (typeof input.setSelectionRange === "function") {
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }
}

function webChatAutoResizeInput(inputEl) {
  const input = inputEl || document.getElementById("webChatInput");
  if (!input) return;
  input.style.height = "auto";
  const next = Math.min(input.scrollHeight, 140);
  input.style.height = `${Math.max(44, next)}px`;
}

/** Puts a translated starter line in the composer so the user can edit before Send. */
function webChatFillReminderExample(n) {
  const i = Number(n);
  if (i < 1 || i > 3) return;
  const key = `webChatReminderExample${i}`;
  try {
    webChatFillInput(t(key));
  } catch {
    webChatFillInput("");
  }
}

function webChatPushRecentCommand(cmd) {
  const s = String(cmd || "").trim();
  if (!s || s.length > 240) return;
  try {
    let arr = [];
    const raw = localStorage.getItem(WEB_CHAT_RECENT_COMMANDS_KEY);
    if (raw) arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = [];
    arr = arr.filter((x) => x !== s);
    arr.unshift(s);
    arr = arr.slice(0, 5);
    localStorage.setItem(WEB_CHAT_RECENT_COMMANDS_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
  webChatRenderRecentCommands();
}

function webChatRenderRecentCommands() {
  const wrap = document.getElementById("webChatRecentCommands");
  if (!wrap) return;
  let arr = [];
  try {
    const raw = localStorage.getItem(WEB_CHAT_RECENT_COMMANDS_KEY);
    if (raw) arr = JSON.parse(raw);
  } catch {
    arr = [];
  }
  if (!Array.isArray(arr) || !arr.length) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML = "";
  const label = document.createElement("p");
  label.className = "web-chat-recent__label";
  label.setAttribute("data-t", "webChatRecentCommandsLabel");
  try {
    label.textContent = t("webChatRecentCommandsLabel");
  } catch {
    label.textContent = "Recently sent";
  }
  wrap.appendChild(label);
  const row = document.createElement("div");
  row.className = "web-chat-chip-strip web-chat-chip-strip--recent";
  for (let i = 0; i < arr.length; i += 1) {
    const text = arr[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "web-chat-chip-strip__chip web-chat-chip-strip__chip--recent";
    const preview = text.length > 48 ? `${text.slice(0, 45)}…` : text;
    btn.textContent = preview;
    btn.title = text;
    btn.addEventListener("click", () => webChatFillInput(text));
    row.appendChild(btn);
  }
  wrap.appendChild(row);
}

function tryOpenScanCamCategory() {
  if (!requireAuth("use Scan Cam")) return;
  void mergePremiumFromServer().then(() => {
    if (typeof userHasScanCamAccess === "function" && userHasScanCamAccess(currentUser)) {
      openCategory("scan_cam");
    } else {
      showToast(t("scanCamRequiresStandard"));
      openBot();
    }
  });
}

function scanCamDismissOnboarding() {
  try {
    localStorage.setItem(SCAN_CAM_ONBOARDING_KEY, "1");
  } catch {
    /* ignore */
  }
  const el = document.getElementById("scanCamOnboardingTooltip");
  if (el) el.classList.add("hidden");
}

function scanCamMaybeShowOnboarding() {
  try {
    if (localStorage.getItem(SCAN_CAM_ONBOARDING_KEY) === "1") return;
  } catch {
    return;
  }
  const el = document.getElementById("scanCamOnboardingTooltip");
  if (!el) return;
  el.classList.remove("hidden");
}

function openScanCamPage() {
  if (!requireAuth("use Scan Cam")) return;
  void mergePremiumFromServer().then(() => {
    setBodyHomePage(false);
    activateMenu("menuScanCam");
    document.getElementById("home").classList.add("hidden");
    document.getElementById("category").classList.add("hidden");
    document.getElementById("notes-all").classList.add("hidden");
    document.getElementById("bot").classList.add("hidden");
    closeWebChatDrawer();
    document.getElementById("reminder-history").classList.add("hidden");
    document.getElementById("settings").classList.add("hidden");
    hideCoinsHubPage();
    const scan = document.getElementById("scan-cam");
    if (scan) scan.classList.remove("hidden");
    applyTranslations();

    const st = document.getElementById("scanCamStatus");
    if (st) st.textContent = "";
    scanCamResetWorkflowUi();
    scanCamMaybeShowOnboarding();
  });
}

function scanCamEnsureConvertAccess() {
  if (!requireAuth("use Scan Cam")) return false;
  const allowed = typeof userHasScanCamAccess === "function" && userHasScanCamAccess(currentUser);
  if (!allowed) {
    openScanCamUpgradeModal();
    return false;
  }
  return true;
}

async function scanCamOpenCamera() {
  const status = document.getElementById("scanCamStatus");
  const video = document.getElementById("scanCamVideo");
  const wrap = document.getElementById("scanCamVideoWrap");
  if (!video || !wrap) return;
  if (status) status.textContent = "";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (status) status.textContent = t("scanCamCameraUnsupported");
    return;
  }
  try {
    scanCamCloseResultPanel();
    scanCamStopCamera();
    const preview = document.getElementById("scanCamPhotoPreview");
    if (preview) {
      preview.removeAttribute("src");
      preview.classList.add("hidden");
    }
    scanCamClearPdf();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    scanCamMediaStream = stream;
    video.srcObject = stream;
    await video.play().catch(() => {});
    wrap.classList.remove("hidden");
    scanCamUpdateStageVisibility();
    scanCamSyncActionUi();
  } catch (e) {
    if (status) status.textContent = e.message || t("scanCamCameraError");
    scanCamSyncActionUi();
  }
}

function scanCamUploadPhoto() {
  const inp = document.getElementById("scanCamUploadInput");
  if (inp) inp.click();
}

function scanCamOpenDocSourceSheet() {
  const sheet = document.getElementById("scanCamDocSourceSheet");
  if (!sheet) return;
  sheet.classList.remove("hidden");
  document.body.classList.add("modal-open");
  if (scanCamDocSheetEscHandler) {
    document.removeEventListener("keydown", scanCamDocSheetEscHandler);
    scanCamDocSheetEscHandler = null;
  }
  scanCamDocSheetEscHandler = (ev) => {
    if (ev.key === "Escape") scanCamCloseDocSourceSheet();
  };
  document.addEventListener("keydown", scanCamDocSheetEscHandler);
}

function scanCamCloseDocSourceSheet() {
  const sheet = document.getElementById("scanCamDocSourceSheet");
  if (!sheet) return;
  sheet.classList.add("hidden");
  document.body.classList.remove("modal-open");
  if (scanCamDocSheetEscHandler) {
    document.removeEventListener("keydown", scanCamDocSheetEscHandler);
    scanCamDocSheetEscHandler = null;
  }
}

function scanCamUploadDocument() {
  scanCamDismissOnboarding();
  scanCamOpenDocSourceSheet();
}

/** PDF-focused picker (downloads / Files app on mobile). */
function scanCamDocPickFromFilesDevice() {
  scanCamCloseDocSourceSheet();
  const inp = document.getElementById("scanCamUploadInputDoc");
  if (inp) {
    inp.value = "";
    inp.click();
  }
}

/**
 * Opens the system document picker without MIME filtering (accept all) so mobile OS
 * can show storage, Downloads, Drive, etc., when supported.
 */
function scanCamDocPickFromDriversAndCloud() {
  scanCamCloseDocSourceSheet();
  const inp = document.getElementById("scanCamUploadInputDocAll");
  if (inp) {
    inp.value = "";
    inp.click();
  }
}

function scanCamHandlePhotoUpload(inputEl) {
  if (!inputEl || !inputEl.files || !inputEl.files[0]) return;
  const file = inputEl.files[0];
  if (!String(file.type || "").startsWith("image/")) {
    showToast(t("scanCamPhotoOnly"));
    inputEl.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const preview = document.getElementById("scanCamPhotoPreview");
    const status = document.getElementById("scanCamStatus");
    if (preview) {
      scanCamClearPdf();
      preview.src = String(reader.result || "");
      preview.classList.remove("hidden");
      scanCamCloseCameraUi();
      if (status) status.textContent = t("scanCamPhotoUploaded");
      scanCamCloseResultPanel();
      scanCamUpdateStageVisibility();
      scanCamSyncActionUi();
    }
    inputEl.value = "";
  };
  reader.onerror = () => {
    showToast(t("scanCamPhotoReadError"));
    inputEl.value = "";
  };
  reader.readAsDataURL(file);
}

function scanCamHandleDocumentUpload(inputEl) {
  if (!inputEl || !inputEl.files || !inputEl.files[0]) return;
  const file = inputEl.files[0];
  const mime = String(file.type || "");
  if (mime.startsWith("image/")) {
    const reader = new FileReader();
    reader.onload = () => {
      const preview = document.getElementById("scanCamPhotoPreview");
      const status = document.getElementById("scanCamStatus");
      if (preview) {
        scanCamClearPdf();
        preview.src = String(reader.result || "");
        preview.classList.remove("hidden");
        scanCamCloseCameraUi();
        if (status) status.textContent = t("scanCamPhotoUploaded");
        scanCamCloseResultPanel();
        scanCamUpdateStageVisibility();
        scanCamSyncActionUi();
      }
      inputEl.value = "";
    };
    reader.onerror = () => {
      showToast(t("scanCamPhotoReadError"));
      inputEl.value = "";
    };
    reader.readAsDataURL(file);
    return;
  }
  if (mime === "application/pdf" || /\.pdf$/i.test(file.name)) {
    scanCamClearPdf();
    const preview = document.getElementById("scanCamPhotoPreview");
    if (preview) {
      preview.removeAttribute("src");
      preview.classList.add("hidden");
    }
    const url = URL.createObjectURL(file);
    scanCamPdfObjectUrl = url;
    const embed = document.getElementById("scanCamPdfEmbed");
    const wrap = document.getElementById("scanCamPdfWrap");
    const status = document.getElementById("scanCamStatus");
    if (embed && wrap) {
      embed.src = url;
      wrap.classList.remove("hidden");
    }
    scanCamCloseCameraUi();
    scanCamCloseResultPanel();
    if (status) status.textContent = t("scanCamPdfUploaded");
    scanCamUpdateStageVisibility();
    scanCamSyncActionUi();
    inputEl.value = "";
    return;
  }
  showToast(t("scanCamInvalidDocument"));
  inputEl.value = "";
}

function scanCamClearImage() {
  scanCamCloseCameraUi();
  scanCamClearPdf();
  const preview = document.getElementById("scanCamPhotoPreview");
  const status = document.getElementById("scanCamStatus");
  if (preview) {
    preview.removeAttribute("src");
    preview.classList.add("hidden");
  }
  if (status) status.textContent = "";
  scanCamUpdateStageVisibility();
  scanCamSyncActionUi();
}

function scanCamCopyText() {
  const ta = document.getElementById("scanCamResultText");
  if (!ta) return;
  const text = String(ta.value || "").trim();
  if (!text) {
    showToast("No text to copy.");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => showToast("Text copied."),
    () => showToast("Could not copy text.")
  );
}

function scanCamClearText() {
  const ta = document.getElementById("scanCamResultText");
  if (ta) ta.value = "";
  const body = document.getElementById("scanCamResultBody");
  if (body) body.textContent = "";
}

function scanCamDownloadPdf() {
  if (!scanCamEnsureConvertAccess()) return;
  const ta = document.getElementById("scanCamResultText");
  const text = ta ? String(ta.value || "").trim() : "";
  if (!text) {
    showToast("No text to export.");
    return;
  }
  const Ctor =
    (typeof window !== "undefined" && window.jspdf && window.jspdf.jsPDF) ||
    (typeof window !== "undefined" && window.jsPDF);
  if (!Ctor) {
    showToast("PDF library unavailable.");
    return;
  }
  const doc = new Ctor({ unit: "pt", format: "a4" });
  const margin = 40;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const lines = doc.splitTextToSize(text, width);
  let y = margin;
  const step = 16;
  lines.forEach((line) => {
    if (y > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(line, margin, y);
    y += step;
  });
  doc.save("scan-note.pdf");
}

function scanCamDownloadImage() {
  if (!scanCamEnsureConvertAccess()) return;
  const preview = document.getElementById("scanCamPhotoPreview");
  const src = preview && preview.getAttribute("src");
  if (!src || !String(src).startsWith("data:")) {
    showToast(t("scanCamNoImageDownload"));
    return;
  }
  const a = document.createElement("a");
  a.href = src;
  a.download = "scan-capture.jpg";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function scanCamCloseCameraUi() {
  scanCamStopCamera();
  const videoWrap = document.getElementById("scanCamVideoWrap");
  if (videoWrap) videoWrap.classList.add("hidden");
  scanCamUpdateStageVisibility();
  scanCamSyncActionUi();
}

function scanCamCapturePhoto() {
  const video = document.getElementById("scanCamVideo");
  const preview = document.getElementById("scanCamPhotoPreview");
  const status = document.getElementById("scanCamStatus");
  if (!video || !preview) return;
  if (!video.videoWidth || !video.videoHeight) {
    if (status) status.textContent = t("scanCamCameraNotReady");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(video, 0, 0);
  scanCamClearPdf();
  preview.src = canvas.toDataURL("image/jpeg", 0.92);
  preview.classList.remove("hidden");
  scanCamCloseCameraUi();
  scanCamCloseResultPanel();
  if (status) status.textContent = t("scanCamPhotoCaptured");
  scanCamUpdateStageVisibility();
  scanCamSyncActionUi();
}

function scanCamLineBBox(ln) {
  const b = ln && ln.bbox ? ln.bbox : {};
  const x0 = Number(b.x0 ?? 0);
  const y0 = Number(b.y0 ?? 0);
  const x1 = Number(b.x1 ?? x0);
  const y1 = Number(b.y1 ?? y0);
  const rawH = Math.abs(y1 - y0);
  const h = rawH > 0 ? Math.max(10, rawH) : Math.max(12, Number(ln && ln.height) || 14);
  return { x0, y0, x1, y1, h };
}

/**
 * Merges OCR line boxes that sit on the same visual row (fewer words cut in the middle).
 */
function scanCamJoinOcrLines(rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length) return "";
  const items = rawLines
    .map((ln) => {
      const bbox = scanCamLineBBox(ln);
      const text = String(ln.text || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return null;
      return { ...bbox, text };
    })
    .filter(Boolean);
  if (!items.length) return "";
  items.sort((a, b) => {
    const rowDiff = a.y0 - b.y0;
    const thr = Math.min(a.h, b.h) * 0.55;
    if (Math.abs(rowDiff) < thr) return a.x0 - b.x0;
    return rowDiff;
  });
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y0 - last.y0) < Math.min(it.h, last.h) * 0.52) {
      last.parts.push(it);
    } else {
      rows.push({ y0: it.y0, h: it.h, parts: [it] });
    }
  }
  return rows
    .map((r) =>
      r.parts
        .sort((a, b) => a.x0 - b.x0)
        .map((p) => p.text)
        .join(" ")
    )
    .join("\n");
}

function scanCamCollectLinesFromOcrData(ocrData) {
  if (!ocrData) return [];
  if (Array.isArray(ocrData.lines) && ocrData.lines.length) return ocrData.lines;
  const out = [];
  if (Array.isArray(ocrData.blocks)) {
    for (const bl of ocrData.blocks) {
      const pars = bl && Array.isArray(bl.paragraphs) ? bl.paragraphs : [];
      for (const p of pars) {
        if (p && Array.isArray(p.lines)) out.push(...p.lines);
      }
    }
  }
  return out;
}

/** Prefer Tesseract layout (blocks / paragraphs / lines) instead of flattened text. */
function scanCamExtractStructuredText(ocrData) {
  if (!ocrData) return "";
  try {
    if (Array.isArray(ocrData.blocks) && ocrData.blocks.length) {
      const paras = [];
      for (const bl of ocrData.blocks) {
        if (!bl) continue;
        const plist = Array.isArray(bl.paragraphs) ? bl.paragraphs : [];
        for (const p of plist) {
          const piece = scanCamJoinOcrLines(p.lines || []);
          if (piece) paras.push(piece);
        }
      }
      const joined = paras.join("\n\n").trim();
      if (joined) return scanCamNormalizeOcrOutput(joined);
    }
    const flat = scanCamCollectLinesFromOcrData(ocrData);
    if (flat.length) {
      const fromLines = scanCamJoinOcrLines(flat);
      if (fromLines) return scanCamNormalizeOcrOutput(fromLines);
    }
  } catch (e) {
    console.warn("[Scan Cam] structured OCR", e);
  }
  return scanCamNormalizeOcrOutput(String(ocrData.text || "").trim());
}

function scanCamNormalizeOcrOutput(s) {
  let t = String(s || "").replace(/\r\n/g, "\n");
  /* Latin + Albanian letters; join " fjalë-\nçelësi" style breaks */
  t = t.replace(/([A-Za-z\u00c0-\u024f])-\s*\n\s*([A-Za-z\u00c0-\u024f0-9])/g, "$1$2");
  const lines = t.split("\n").map((ln) =>
    ln
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trimEnd()
  );
  t = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function scanCamCanvasFromImgElement(img, maxSide = 2800) {
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) return null;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

async function scanCamEnsureTesseractWorker() {
  if (typeof Tesseract === "undefined") {
    throw new Error("MISSING_TESSERACT");
  }
  if (scanCamTesseractWorker) return scanCamTesseractWorker;
  if (!scanCamTesseractInitPromise) {
    scanCamTesseractInitPromise = (async () => {
      const tryLangs = ["eng+sqi", "eng"];
      for (const lang of tryLangs) {
        try {
          scanCamTesseractWorker = await Tesseract.createWorker(lang, undefined, { logger: () => {} });
          try {
            await scanCamTesseractWorker.setParameters({
              tessedit_pageseg_mode: "3",
              preserve_interword_spaces: "1"
            });
          } catch (e) {
            console.warn("[Scan Cam] Tesseract setParameters", e && e.message);
          }
          return scanCamTesseractWorker;
        } catch (e) {
          console.warn("[Scan Cam] Tesseract init", lang, e && e.message);
          scanCamTesseractWorker = null;
        }
      }
      throw new Error("TESSERACT_INIT");
    })();
  }
  try {
    return await scanCamTesseractInitPromise;
  } catch (e) {
    scanCamTesseractInitPromise = null;
    scanCamTesseractWorker = null;
    throw e;
  }
}

async function scanCamRecognizeFromPdfUrl(pdfUrl) {
  if (typeof pdfjsLib === "undefined") {
    throw new Error("MISSING_PDFJS");
  }
  if (!scanCamPdfWorkerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    scanCamPdfWorkerConfigured = true;
  }
  const loadingTask = pdfjsLib.getDocument({ url: pdfUrl, verbosity: 0 });
  const pdf = await loadingTask.promise;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("NO_CANVAS");
  const worker = await scanCamEnsureTesseractWorker();
  const parts = [];
  const n = Math.min(pdf.numPages, SCAN_CAM_PDF_OCR_MAX_PAGES);
  for (let p = 1; p <= n; p += 1) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const renderTask = page.render({ canvasContext: ctx, viewport });
    await renderTask.promise;
    const { data } = await worker.recognize(canvas);
    const raw = data ? scanCamExtractStructuredText(data) : "";
    if (raw) parts.push(raw);
  }
  let out = parts.join("\n\n").trim();
  if (pdf.numPages > SCAN_CAM_PDF_OCR_MAX_PAGES) {
    const tail = t("scanCamOcrPdfTruncated").replace("{n}", String(SCAN_CAM_PDF_OCR_MAX_PAGES));
    out = out ? `${out}\n\n${tail}` : tail;
  }
  return out;
}

async function scanCamRunOcr() {
  const ta = document.getElementById("scanCamResultText");
  const status = document.getElementById("scanCamStatus");
  const stage = document.querySelector(".scan-cam-stage");
  const line = document.getElementById("scanCamScanline");
  const convertBtn = document.getElementById("scanCamBtnConvert");
  if (!ta) return;
  if (!scanCamHasStillPreview()) {
    if (status) status.textContent = t("scanCamNeedPhotoFirst");
    return;
  }
  if (!scanCamEnsureConvertAccess()) return;
  if (convertBtn) convertBtn.disabled = true;
  if (line) line.classList.remove("hidden");
  if (stage) stage.classList.add("scan-cam-stage--converting");
  if (status) status.textContent = t("scanCamProcessing");
  try {
    const preview = document.getElementById("scanCamPhotoPreview");
    const pdfWrap = document.getElementById("scanCamPdfWrap");
    const hasImg = !!(preview && preview.getAttribute("src") && !preview.classList.contains("hidden"));
    const hasPdf = !!(
      pdfWrap &&
      !pdfWrap.classList.contains("hidden") &&
      scanCamPdfObjectUrl
    );

    let text = "";

    if (hasImg) {
      if (typeof Tesseract === "undefined") {
        showToast(t("scanCamTesseractMissing"));
        return;
      }
      try {
        if (preview && typeof preview.decode === "function") {
          await preview.decode();
        }
      } catch {
        /* decode optional */
      }
      const worker = await scanCamEnsureTesseractWorker();
      const canvas = scanCamCanvasFromImgElement(preview);
      const { data } = canvas
        ? await worker.recognize(canvas)
        : await worker.recognize(preview.src);
      text = data ? scanCamExtractStructuredText(data) : "";
    } else if (hasPdf) {
      if (typeof Tesseract === "undefined" || typeof pdfjsLib === "undefined") {
        showToast(t("scanCamTesseractMissing"));
        return;
      }
      text = await scanCamRecognizeFromPdfUrl(scanCamPdfObjectUrl);
    } else {
      if (status) status.textContent = t("scanCamNeedPhotoFirst");
      return;
    }

    text = String(text || "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!text) {
      ta.value = "";
      if (status) status.textContent = t("scanCamOcrEmpty");
      showToast(t("scanCamOcrEmpty"));
      return;
    }
    ta.value = text;
    if (status) status.textContent = t("scanCamDone");
    scanCamShowResultPanel();
  } catch (e) {
    console.warn("[Scan Cam OCR]", e);
    let msg = t("scanCamOcrFailed");
    if (e && e.message === "MISSING_TESSERACT") msg = t("scanCamTesseractMissing");
    else if (e && e.message === "MISSING_PDFJS") msg = t("scanCamPdfJsMissing");
    showToast(msg);
    if (status) status.textContent = msg;
  } finally {
    if (line) line.classList.add("hidden");
    if (stage) stage.classList.remove("scan-cam-stage--converting");
    if (convertBtn) convertBtn.disabled = !scanCamHasStillPreview();
    scanCamSyncActionUi();
  }
}

/** @deprecated Use {@link scanCamRunOcr}; kept for older inline handlers. */
async function scanCamSimulateOcr() {
  return scanCamRunOcr();
}

function saveScanCamNoteFromOcr() {
  if (!requireAuth("save notes")) return;
  if (typeof userHasScanCamAccess === "function" && !userHasScanCamAccess(currentUser)) {
    showToast(t("scanCamRequiresStandard"));
    return;
  }
  const ta = document.getElementById("scanCamResultText");
  const titleInput = document.getElementById("scanCamNoteTitle");
  const preview = document.getElementById("scanCamPhotoPreview");
  const imgSrc = preview && preview.getAttribute("src");
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) {
    showToast(t("noteTextRequired"));
    return;
  }
  const title = titleInput && titleInput.value ? titleInput.value.trim() : "";
  persistScanCamNoteLocally(text, title, imgSrc || undefined);
  showToast(t("noteCreatedToast"));
  scanCamCloseResultPanel();
  hideScanCamPage();
  openCategory("scan_cam");
}

function webChatSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function webChatPushSessionTurn(role, text) {
  const s = String(text || "").trim();
  if (!s) return;
  webChatSessionTurns.push({ role, text: s });
  if (webChatSessionTurns.length > WEB_CHAT_SESSION_MAX) {
    webChatSessionTurns = webChatSessionTurns.slice(-WEB_CHAT_SESSION_MAX);
  }
}

function webChatLooksLikeReminderTimeFollowUp(t) {
  const s = String(t || "").trim();
  if (!s || s.length > 140) return false;
  if (/^(nd[eë]rro|ndrysho|nderro|change|set|rish|ri-)\b/i.test(s)) return true;
  if (/\b\d{1,2}[:.]\d{2}\b/.test(s)) return true;
  if (/\b(?:pas|after)\s+\d{1,3}\s*(?:or[ëa]sh|or[ëa]|hours?|minut[ëa]sh|minut[ëa]|minutes?)\b/i.test(s)) return true;
  if (/\b(?:në|ne|at)\s+\d{1,2}\b/i.test(s) && s.length < 48) return true;
  return false;
}

/**
 * Merges short follow-ups with the last reminder line so time-only edits still parse.
 * @param {string} trimmed
 */
function webChatMergeReminderFollowUp(trimmed) {
  const t = String(trimmed || "").trim();
  if (!t) return t;
  if (webChatHasReminderKeyword(t)) {
    webChatLastReminderUserRaw = t;
    return t;
  }
  if (webChatLastReminderUserRaw && webChatLooksLikeReminderTimeFollowUp(t)) {
    return `${webChatLastReminderUserRaw} ${t}`.trim();
  }
  return t;
}

function webChatFormatSessionForOpenAi() {
  if (!webChatSessionTurns.length) return "";
  return webChatSessionTurns
    .slice(-8)
    .map((x) => `${x.role === "user" ? "User" : "Assistant"}: ${x.text}`)
    .join("\n");
}

function webChatBuildOpenAiMessage(resolutionText) {
  const tail = String(resolutionText || "").trim();
  if (!tail) return "";
  const ctx = webChatFormatSessionForOpenAi();
  return ctx ? `${ctx}\nUser: ${tail}` : tail;
}

/**
 * Streams bot text into a new bubble (chunked) for a live “AI typing” feel.
 * @param {string} fullText
 * @param {{ ai?: boolean }} [opts]
 */
async function appendWebChatBotReplyStreaming(fullText, opts = {}) {
  removeWebChatTyping();
  const clean = String(fullText || "").trim() || t("webChatReplyUnknownSmart");
  const box = document.getElementById("webChatMessages");
  if (!box) return;
  const row = document.createElement("div");
  row.className = "web-chat-row web-chat-row--bot";
  const av = document.createElement("div");
  av.className = "web-chat-avatar";
  av.innerHTML = WEB_CHAT_BOT_AVATAR_SVG;
  const wrap = document.createElement("div");
  wrap.className = "web-chat-bubble-wrap";
  const bubble = document.createElement("div");
  bubble.className = "web-chat-bubble web-chat-bubble--bot";
  const body = document.createElement("span");
  body.className = "web-chat-bubble__stream";
  bubble.appendChild(body);
  if (opts.ai) {
    const label = document.createElement("span");
    label.className = "web-chat-ai-tag";
    label.textContent = t("webChatAiResponseLabel");
    bubble.insertBefore(label, body);
  }
  wrap.appendChild(bubble);
  row.appendChild(av);
  row.appendChild(wrap);
  box.appendChild(row);
  requestAnimationFrame(() => {
    row.classList.add("web-chat-row--visible");
  });

  const len = clean.length;
  const chunk = len > 280 ? 4 : len > 90 ? 3 : 2;
  const delayMs = len > 400 ? 10 : 14;
  let shown = "";
  for (let i = 0; i < len; i += chunk) {
    shown += clean.slice(i, i + chunk);
    body.textContent = shown;
    box.scrollTop = box.scrollHeight;
    await webChatSleep(delayMs);
  }

  const fb = document.createElement("div");
  fb.className = "web-chat-feedback";
  fb.setAttribute("role", "group");
  const up = document.createElement("button");
  up.type = "button";
  up.className = "web-chat-feedback__btn";
  up.setAttribute("aria-label", "👍");
  up.textContent = "👍";
  up.addEventListener("click", () => {
    showToast(t("webChatFeedbackThanks"));
  });
  const down = document.createElement("button");
  down.type = "button";
  down.className = "web-chat-feedback__btn";
  down.setAttribute("aria-label", "👎");
  down.textContent = "👎";
  down.addEventListener("click", () => {
    showToast(t("webChatFeedbackThanks"));
  });
  fb.appendChild(up);
  fb.appendChild(down);
  wrap.appendChild(fb);
  box.scrollTop = box.scrollHeight;
  webChatMarkUnreadFromBot();
}

function appendWebChatBubble(role, text, opts = {}) {
  const box = document.getElementById("webChatMessages");
  if (!box) return;
  const row = document.createElement("div");
  row.className = `web-chat-row web-chat-row--${role}`;
  if (role === "bot") {
    const av = document.createElement("div");
    av.className = "web-chat-avatar";
    av.innerHTML = WEB_CHAT_BOT_AVATAR_SVG;
    row.appendChild(av);
  }
  const wrap = document.createElement("div");
  wrap.className = "web-chat-bubble-wrap";
  const bubble = document.createElement("div");
  bubble.className = `web-chat-bubble web-chat-bubble--${role}`;
  if (role === "bot" && opts.welcomeExamples) {
    bubble.classList.add("web-chat-bubble--welcome");
    renderWebChatWelcomeContent(bubble, opts.mode || getWebChatMode());
  } else {
    bubble.textContent = text;
  }
  if (role === "bot" && opts.ai) {
    const label = document.createElement("span");
    label.className = "web-chat-ai-tag";
    label.textContent = t("webChatAiResponseLabel");
    bubble.prepend(label);
  }
  wrap.appendChild(bubble);
  row.appendChild(wrap);
  box.appendChild(row);
  requestAnimationFrame(() => {
    row.classList.add("web-chat-row--visible");
  });
  box.scrollTop = box.scrollHeight;
  if (role === "bot" && !opts.welcomeExamples) {
    webChatMarkUnreadFromBot();
  }
}

function removeWebChatTyping() {
  document.getElementById("webChatTypingRow")?.remove();
}

function appendWebChatTyping() {
  const box = document.getElementById("webChatMessages");
  if (!box) return;
  removeWebChatTyping();
  const row = document.createElement("div");
  row.id = "webChatTypingRow";
  row.className = "web-chat-row web-chat-row--bot web-chat-row--typing";
  const av = document.createElement("div");
  av.className = "web-chat-avatar";
  av.innerHTML = WEB_CHAT_BOT_AVATAR_SVG;
  const wrap = document.createElement("div");
  wrap.className = "web-chat-bubble-wrap";
  const hint = document.createElement("div");
  hint.className = "web-chat-typing-label";
  hint.setAttribute("data-t", "webChatTypingLabel");
  hint.textContent = t("webChatTypingLabel");
  wrap.appendChild(hint);
  const typing = document.createElement("div");
  typing.className = "web-chat-typing";
  typing.appendChild(document.createElement("span"));
  typing.appendChild(document.createElement("span"));
  typing.appendChild(document.createElement("span"));
  wrap.appendChild(typing);
  row.appendChild(av);
  row.appendChild(wrap);
  box.appendChild(row);
  requestAnimationFrame(() => {
    row.classList.add("web-chat-row--visible");
  });
  box.scrollTop = box.scrollHeight;
}

async function sendWebChatMessageWithText(text) {
  const input = document.getElementById("webChatInput");
  if (input) {
    input.value = String(text || "");
    webChatAutoResizeInput(input);
  }
  await sendWebChatMessage();
}

function webChatModelModeChanged() {
  const sel = document.getElementById("webChatModelMode");
  if (!sel) return;
  const value = String(sel.value || "chatbot");
  if (
    (value === "auto" || value === "openai") &&
    typeof userHasWebChatOpenAiAccess === "function" &&
    !userHasWebChatOpenAiAccess(currentUser)
  ) {
    sel.value = "chatbot";
    setWebChatMode("chatbot");
    showToast(t("webChatOpenAiStandardOnly"));
    webChatModelSyncPopoverState();
    return;
  }
  if (value === "openai" && webChatIsOpenAiLimitReached()) {
    sel.value = "chatbot";
    setWebChatMode("chatbot");
    showToast(t("webChatOpenAiLimitReached"));
    webChatModelSyncPopoverState();
    return;
  }
  setWebChatMode(value);
  webChatModelSyncPopoverState();
  syncWebChatModePresentation(value, false);
}

async function fetchWebChatAiReply(message) {
  const response = await fetch(buildApiUrl("/api/web-chat/ai-reply"), {
    method: "POST",
    credentials: "include",
    headers: getAuthHeaders(),
    body: JSON.stringify({ message: String(message || "") })
  });
  const data = await response.json().catch(() => ({}));
  if (currentUser && data.usage) {
    currentUser.openAiWebChat = data.usage;
    persistCurrentUserToStorage();
    syncWebChatOpenAiUsageUi();
    syncWebChatModelSelectorUi();
  }
  if (!response.ok) {
    const err = new Error(data.error || "Request failed");
    err.status = response.status;
    err.code = data.code;
    throw err;
  }
  return String(data.reply || "").trim();
}

function webChatShouldFallbackToAi(text) {
  const I = typeof window !== "undefined" ? window.webChatIntents : null;
  if (!I || typeof I.webChatFindBestIntent !== "function") return true;
  const hit = I.webChatFindBestIntent(String(text || ""));
  if (!hit || !hit.chosenId) return true;
  const score = Number(hit.bestScore || 0);
  return score < 2.2;
}

function stripWebChatReminderPrefix(raw) {
  if (typeof window !== "undefined" && window.webChatIntents && typeof window.webChatIntents.stripWebChatReminderCommand === "function") {
    return window.webChatIntents.stripWebChatReminderCommand(raw);
  }
  return String(raw || "")
    .trim()
    .replace(/^(kujto|me\s+kujto|më\s+kujto|reminder|remember)\s*:?\s*/i, "")
    .trim();
}

function pad2WebChatHour(h) {
  const v = Math.floor(Number(h));
  if (Number.isNaN(v)) return "00";
  return String(Math.min(23, Math.max(0, v))).padStart(2, "0");
}

function pad2WebChatMinute(m) {
  const v = Math.floor(Number(m));
  if (Number.isNaN(v)) return "00";
  return String(Math.min(59, Math.max(0, v))).padStart(2, "0");
}

/** Relative day keywords stripped from reminder body text (same tokens as schedule parser). */
function webChatRelativeDayWordStripRe() {
  return /\b(pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow|nesër|neser|tomorrow|sot|today)\b/gi;
}

/**
 * Removes scheduling/command fluff from stored reminder text (Albanian + English).
 * Keeps meaningful content like "te blej buke".
 */
function webChatCleanReminderBodyText(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const relRe = webChatRelativeDayWordStripRe();
  const cmdRe = /\b(?:më\s+kujto|me\s+kujto|kujto)\b/gi;
  for (let i = 0; i < 8; i += 1) {
    const prev = s;
    s = stripWebChatReminderPrefix(s);
    s = s.replace(cmdRe, " ");
    s = s.replace(relRe, " ");
    s = s.replace(/\bne\s+(?=t[eë]\b)/gi, "");
    s = s.replace(/\bnë\s+(?=t[eë]\b)/gi, "");
    s = s.replace(/\s+/g, " ").trim();
    if (s === prev) break;
  }
  return s;
}

/**
 * Parse date/time and remaining text from the reminder line (after command prefix removed).
 * @returns {{ when: Date | null; message: string }}
 */
function parseWebChatReminderLine(rest) {
  const full = rest.trim();
  if (!full) return { when: null, message: "" };

  const iso = full.match(/(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}):(\d{2})/);
  if (iso) {
    const when = new Date(`${iso[1]}T${pad2WebChatHour(iso[2])}:${pad2WebChatMinute(iso[3])}:00`);
    const message = full.replace(iso[0], " ").replace(/\s+/g, " ").trim();
    return { when, message };
  }

  const tail = full.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*$/);
  if (tail) {
    const when = new Date(`${tail[1]}T${pad2WebChatHour(tail[2])}:${pad2WebChatMinute(tail[3])}:00`);
    const message = full.slice(0, tail.index).trim();
    return { when, message };
  }

  if (/\b(sot|today)\b/i.test(full)) {
    const ts = webChatExtractTimeSpec(full);
    if (!ts) return { when: null, message: full };
    const d = new Date();
    const datePart = d.toISOString().slice(0, 10);
    const when = new Date(`${datePart}T${pad2WebChatHour(ts.h)}:${pad2WebChatMinute(ts.mi)}:00`);
    let message = full.replace(/\b(sot|today)\b/gi, " ");
    message = message.replace(ts.match, " ");
    message = message.replace(/\s+/g, " ").trim();
    return { when, message };
  }

  if (/\b(nesër|neser|tomorrow)\b/i.test(full)) {
    const ts = webChatExtractTimeSpec(full);
    if (!ts) return { when: null, message: full };
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const datePart = d.toISOString().slice(0, 10);
    const when = new Date(`${datePart}T${pad2WebChatHour(ts.h)}:${pad2WebChatMinute(ts.mi)}:00`);
    let message = full.replace(/\b(nesër|neser|tomorrow)\b/gi, " ");
    message = message.replace(ts.match, " ");
    message = message.replace(/\s+/g, " ").trim();
    return { when, message };
  }

  if (/\b(pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(full)) {
    const ts = webChatExtractTimeSpec(full);
    if (!ts) return { when: null, message: full };
    const d = new Date();
    d.setDate(d.getDate() + 2);
    const datePart = d.toISOString().slice(0, 10);
    const when = new Date(`${datePart}T${pad2WebChatHour(ts.h)}:${pad2WebChatMinute(ts.mi)}:00`);
    let message = full.replace(/\b(pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/gi, " ");
    message = message.replace(ts.match, " ");
    message = message.replace(/\s+/g, " ").trim();
    return { when, message };
  }

  const parsed = Date.parse(full);
  if (!Number.isNaN(parsed)) {
    const when = new Date(parsed);
    return { when, message: "" };
  }

  return { when: null, message: full };
}

const WEB_CHAT_SQ_MONTH_NAMES = {
  janar: 0,
  shkurt: 1,
  mars: 2,
  prill: 3,
  maj: 4,
  qershor: 5,
  korrik: 6,
  gusht: 7,
  shtator: 8,
  tetor: 9,
  nëntor: 10,
  nentor: 10,
  dhjetor: 11
};

const WEB_CHAT_EN_MONTH_NAMES = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

const WEB_CHAT_CALENDAR_MONTHS = { ...WEB_CHAT_SQ_MONTH_NAMES, ...WEB_CHAT_EN_MONTH_NAMES };

function webChatHasReminderKeyword(s) {
  const x = String(s || "").trim();
  if (
    /\b(?:më\s+kujto|me\s+kujto|kujto|remind(?:\s+me(?:\s+to)?)?|remember\s+to|set\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|schedule\s+(?:a\s+)?reminder)\b/i.test(
      x
    )
  ) {
    return true;
  }
  if (typeof window !== "undefined" && window.webChatIntents && typeof window.webChatIntents.stripWebChatReminderCommand === "function") {
    const st = window.webChatIntents.stripWebChatReminderCommand(x);
    if (st !== x && st.length) return true;
  }
  return false;
}

function webChatSplitReminderAroundKeyword(str) {
  const s = String(str || "").trim();
  const enStart =
    /^(?:remind\s+me(?:\s+to)?|remind(?!\s+me)\s+|remember\s+to|set\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|schedule\s+(?:a\s+)?reminder|reminder)\s+/i;
  const em = s.match(enStart);
  if (em) {
    const after = s.slice(em[0].length).trim();
    return { before: "", after, combined: after };
  }
  const re = /(më\s+kujto|me\s+kujto|kujto)/gi;
  let lastIndex = -1;
  let lastLen = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    lastIndex = m.index;
    lastLen = m[0].length;
  }
  if (lastIndex < 0) {
    return { before: "", after: s, combined: s };
  }
  const before = s.slice(0, lastIndex).trim();
  const after = s.slice(lastIndex + lastLen).trim();
  return { before, after, combined: `${before} ${after}`.trim() };
}

function webChatMatchCalendarMonthInBody(body) {
  const b = String(body || "");
  const monthNames = Object.keys(WEB_CHAT_CALENDAR_MONTHS).join("|");
  const reMe = new RegExp(`\\b(?:më|me)\\s+(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})\\b`, "i");
  const reDayFirst = new RegExp(`\\b(?:on\\s+)?(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})\\b`, "i");
  const reMonthFirst = new RegExp(`\\b(${monthNames})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i");
  let m = b.match(reMe);
  if (!m) m = b.match(reDayFirst);
  if (!m) m = b.match(reMonthFirst);
  if (!m) return null;
  let day;
  let monthToken;
  let year;
  if (/^\d+$/.test(String(m[1]))) {
    day = Number(m[1]);
    monthToken = String(m[2]).toLowerCase();
    year = Number(m[3]);
  } else {
    monthToken = String(m[1]).toLowerCase();
    day = Number(m[2]);
    year = Number(m[3]);
  }
  let monthIdx = WEB_CHAT_CALENDAR_MONTHS[monthToken];
  if (monthIdx == null) monthIdx = WEB_CHAT_CALENDAR_MONTHS[monthToken.replace(/ë/g, "e")];
  if (monthIdx == null) return null;
  if (Number.isNaN(day) || day < 1 || day > 31) return null;
  if (Number.isNaN(year) || year < 2000 || year > 2100) return null;
  return { day, monthIdx, year, fullMatch: m[0] };
}

/**
 * European-style calendar date in the reminder text (DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY).
 * @returns {{ day: number; monthIdx: number; year: number; fullMatch: string } | null}
 */
function webChatMatchSlashDate(body) {
  const b = String(body || "");
  const m = b.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return { day, monthIdx: month - 1, year, fullMatch: m[0] };
}

/**
 * @returns {{ h: number; mi: number; match: string } | null}
 */
function webChatExtractTimeSpec(combined) {
  const c = String(combined || "");
  const hm = c.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (hm) {
    const h = Number(hm[1]);
    const mi = Number(hm[2]);
    if (!Number.isNaN(h) && !Number.isNaN(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
      return { h, mi, match: hm[0] };
    }
  }
  const dayParts = [
    [/\b(mëngjes|mengjes|morning)\b/i, 9, 0],
    [/\b(paradite|noon)\b/i, 12, 0],
    [/\b(pasdite|afternoon)\b/i, 15, 0],
    [/\b(në\s+dark[eë]|nell\s+dark[eë]|dark[eë]|evening|tonight)\b/i, 20, 0]
  ];
  for (let i = 0; i < dayParts.length; i += 1) {
    const [re, h, mi] = dayParts[i];
    const mm = c.match(re);
    if (mm) return { h, mi, match: mm[0] };
  }
  const neat = c.match(/\b(?:në|ne|at)\s+(\d{1,2})\b(?!\s*[:.]\d)/i);
  if (neat) {
    const h = Number(neat[1]);
    if (!Number.isNaN(h) && h >= 0 && h <= 23) return { h, mi: 0, match: neat[0] };
  }
  if (
    /\b(nesër|neser|tomorrow|sot|today|pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(
      c
    )
  ) {
    const rel = c.match(
      /\b(nesër|neser|tomorrow|sot|today|pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i
    );
    if (rel) {
      const tailStart = (rel.index || 0) + rel[0].length;
      const tail = c.slice(tailStart);
      const mPref = tail.match(/^\s*(?:në|ne|at)\s+(\d{1,2})\b(?!\s*[:.]\d{2})/i);
      if (mPref) {
        const h = Number(mPref[1]);
        if (!Number.isNaN(h) && h >= 0 && h <= 23) {
          const match = c.slice(tailStart + mPref.index, tailStart + mPref.index + mPref[0].length);
          return { h, mi: 0, match };
        }
      }
      const mBare = tail.match(/^\s*(\d{1,2})\b(?!\s*[:.]\d{2})/);
      if (mBare) {
        const h = Number(mBare[1]);
        if (!Number.isNaN(h) && h >= 0 && h <= 23) {
          const match = c.slice(tailStart + mBare.index, tailStart + mBare.index + mBare[0].length);
          return { h, mi: 0, match };
        }
      }
    }
  }
  return null;
}

/**
 * @returns {{ type: "ok"; when: Date; message: string } | { type: "ask"; ask: "time" | "date" | "both" }}
 */
function webChatParseNaturalReminderSchedule(body, tailAfterKeyword) {
  const combined = String(body || "").trim();
  if (!combined) return { type: "ask", ask: "both" };

  const pasDur = combined.match(
    /\b(?:pas|after|in)\s+(\d{1,3})\s*(?:or[ëa]sh|or[ëa]|hours?|minut[ëa]sh|minut[ëa]|minutes?)\b/i
  );
  if (pasDur) {
    const n = Number(pasDur[1]);
    const unitRaw = String(pasDur[2] || "").toLowerCase();
    const isMin = /min/.test(unitRaw);
    if (!Number.isNaN(n) && n > 0 && n < 10080) {
      const when = new Date();
      if (isMin) when.setMinutes(when.getMinutes() + n);
      else when.setHours(when.getHours() + n);
      let message = combined
        .replace(pasDur[0], " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!message && tailAfterKeyword) message = tailAfterKeyword.trim();
      return { type: "ok", when, message: message || t("webChatReminderDefaultMessage") };
    }
  }

  const legacy = parseWebChatReminderLine(combined);
  if (legacy.when && !Number.isNaN(legacy.when.getTime())) {
    const prefer = (tailAfterKeyword && tailAfterKeyword.trim()) || (legacy.message && legacy.message.trim()) || "";
    return {
      type: "ok",
      when: legacy.when,
      message: prefer || legacy.message || combined || t("webChatReminderDefaultMessage")
    };
  }

  const hasRelativeTomorrow = /\b(nesër|neser|tomorrow)\b/i.test(combined);
  const hasRelativeToday = /\b(sot|today)\b/i.test(combined);
  const hasRelativePasneser = /\b(pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(
    combined
  );
  const timeSpec = webChatExtractTimeSpec(combined);
  const cal = webChatMatchCalendarMonthInBody(combined);
  const slash = webChatMatchSlashDate(combined);

  const relStrip = webChatRelativeDayWordStripRe();

  if (slash) {
    let ts = timeSpec;
    if (!ts) {
      const rest = combined.replace(slash.fullMatch, " ").trim();
      const lone = rest.match(/\b(\d{1,2})\b(?!\s*[:.]\d{2})/);
      if (lone) {
        const h = Number(lone[1]);
        if (!Number.isNaN(h) && h >= 0 && h <= 23) ts = { h, mi: 0, match: lone[0] };
      }
    }
    if (!ts) return { type: "ask", ask: "time" };
    const when = new Date(slash.year, slash.monthIdx, slash.day, ts.h, ts.mi, 0, 0);
    let message = combined
      .replace(slash.fullMatch, " ")
      .replace(ts.match, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!message && tailAfterKeyword) message = tailAfterKeyword.trim();
    return { type: "ok", when, message: message || t("webChatReminderDefaultMessage") };
  }

  if (cal) {
    let tsCal = timeSpec;
    if (!tsCal) {
      const rest = combined.replace(cal.fullMatch, " ").trim();
      const lone = rest.match(/\b(\d{1,2})\b(?!\s*[:.]\d{2})/);
      if (lone) {
        const h = Number(lone[1]);
        if (!Number.isNaN(h) && h >= 0 && h <= 23) tsCal = { h, mi: 0, match: lone[0] };
      }
    }
    if (!tsCal) return { type: "ask", ask: "time" };
    const when = new Date(cal.year, cal.monthIdx, cal.day, tsCal.h, tsCal.mi, 0, 0);
    let message = combined
      .replace(cal.fullMatch, " ")
      .replace(tsCal.match, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!message && tailAfterKeyword) message = tailAfterKeyword.trim();
    return { type: "ok", when, message: message || t("webChatReminderDefaultMessage") };
  }

  if (hasRelativeToday || hasRelativeTomorrow || hasRelativePasneser) {
    if (!timeSpec) return { type: "ask", ask: "time" };
    const base = new Date();
    if (hasRelativePasneser) base.setDate(base.getDate() + 2);
    else if (hasRelativeTomorrow) base.setDate(base.getDate() + 1);
    const when = new Date(base.getFullYear(), base.getMonth(), base.getDate(), timeSpec.h, timeSpec.mi, 0, 0);
    let message = combined
      .replace(relStrip, " ")
      .replace(timeSpec.match, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!message && tailAfterKeyword) message = tailAfterKeyword.trim();
    return { type: "ok", when, message: message || t("webChatReminderDefaultMessage") };
  }

  if (
    timeSpec &&
    !slash &&
    !cal &&
    !hasRelativeToday &&
    !hasRelativeTomorrow &&
    !hasRelativePasneser
  ) {
    const looksIso = /\b\d{4}-\d{2}-\d{2}\b/.test(combined);
    const looksSlash = /\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/.test(combined);
    if (!looksIso && !looksSlash && !webChatMatchCalendarMonthInBody(combined)) {
      return { type: "ask", ask: "date" };
    }
  }

  return { type: "ask", ask: "both" };
}

function webChatFormatReminderConfirmSummary(when, combinedLower) {
  const lang = typeof getCurrentLanguage === "function" ? getCurrentLanguage() : "en";
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const clock = `${hh}:${mm}`;
  const pasHm = combinedLower.match(
    /\b(?:pas|after|in)\s+(\d{1,3})\s*(?:or[ëa]sh|or[ëa]|hours?|minut[ëa]sh|minut[ëa]|minutes?)\b/i
  );
  if (pasHm) {
    try {
      return when.toLocaleString(lang === "sq" ? "sq-AL" : undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      const n = pasHm[1];
      const u = pasHm[2] || "";
      if (/min/.test(u)) {
        return `${t("webChatRelativeInMinutes").replace("{n}", n)} (${clock})`;
      }
      return `${t("webChatRelativeInHours").replace("{n}", n)} (${clock})`;
    }
  }
  if (/\b(pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(combinedLower)) {
    return `${t("webChatRelativePasneser")} ${t("webChatReminderAt")} ${clock}`;
  }
  if (/\b(nesër|neser|tomorrow)\b/i.test(combinedLower)) {
    return `${t("webChatRelativeTomorrow")} ${t("webChatReminderAt")} ${clock}`;
  }
  if (/\b(sot|today)\b/i.test(combinedLower)) {
    return `${t("webChatRelativeToday")} ${t("webChatReminderAt")} ${clock}`;
  }
  try {
    return when.toLocaleString(lang === "sq" ? "sq-AL" : undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (e) {
    return when.toLocaleString();
  }
}

async function webChatNaturalReminderHandler(trimmed) {
  if (!currentUser || !accessToken) return t("webChatReminderNeedLogin");

  const mergedOk = await mergePremiumFromServer();
  if (!mergedOk) return t("webChatPlanVerifyFailed");
  if (typeof userHasWebChatAccess === "function" && !userHasWebChatAccess(currentUser)) {
    return t("webChatReminderRequiresStandard");
  }

  const split = webChatSplitReminderAroundKeyword(trimmed);
  let body = stripWebChatReminderPrefix(trimmed);
  if (!body || body === trimmed) body = split.combined;
  if (!body) return t("webChatReminderNeedDetails");

  const parsed = webChatParseNaturalReminderSchedule(body, split.after);
  if (parsed.type === "ask") {
    if (parsed.ask === "time") return t("webChatReminderAskTime");
    if (parsed.ask === "date") return t("webChatReminderAskDate");
    return t("webChatReminderAskBoth");
  }

  const when = parsed.when;
  if (!when || Number.isNaN(when.getTime())) return `${t("webChatReminderParseFail")}\n\n${t("webChatReminderExample")}`;
  if (!isFutureReminderInput(when)) return t("reminderMustBeFuture");

  let msg = webChatCleanReminderBodyText(String(parsed.message || "").trim());
  if (!msg) msg = webChatCleanReminderBodyText(String(split.after || "").trim());
  if (!msg) msg = webChatCleanReminderBodyText(String(body || "").trim());
  if (!msg) msg = t("webChatReminderDefaultMessage");

  try {
    await apiFetch("/api/web-reminder", {
      method: "POST",
      body: JSON.stringify({
        reminderTime: when.toISOString(),
        message: msg,
        source: "web_chat"
      })
    });
    refreshReminderRelatedViews();
    webChatLastReminderUserRaw = String(trimmed || "").trim();
    const summary = webChatFormatReminderConfirmSummary(when, body.toLowerCase());
    const line = t("webChatReminderSavedLine").replace("{when}", summary);
    const detail =
      msg && msg.length && msg !== t("webChatReminderDefaultMessage")
        ? `\n${t("webChatReminderConfirmDetail").replace("{message}", msg)}`
        : "";
    return `${line}${detail}`;
  } catch (err) {
    return err.message || String(err);
  }
}

async function webChatCreateReminderFromBackend(raw) {
  return webChatNaturalReminderHandler(String(raw || "").trim());
}

async function resolveWebChatReply(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return t("webChatReplyUnknownSmart");

  const qOnly = trimmed.replace(/\s/g, "");
  const compact = trimmed.replace(/\s/g, "");
  if (/^\?+$/.test(qOnly) || /^(help|ndihme|ndihmë)\?$/i.test(compact)) {
    return t("webChatHelpList");
  }

  const effective = webChatMergeReminderFollowUp(trimmed);

  if (webChatHasReminderKeyword(effective)) {
    return await webChatNaturalReminderHandler(effective);
  }

  const I = typeof window !== "undefined" ? window.webChatIntents : null;
  if (!I || typeof I.webChatFindBestIntent !== "function") {
    return t("webChatReplyUnknownSmart");
  }

  const hit = I.webChatFindBestIntent(trimmed);

  if (hit.chosenId === "help") return t("webChatHelpList");
  if (hit.chosenId === "greeting") return t("webChatReplyHello");
  if (hit.chosenId === "thanks") return t("webChatReplyThanks");
  if (hit.chosenId === "bye") return t("webChatReplyBye");
  if (hit.chosenId === "plans") return t("webChatReplyPlans");
  if (hit.chosenId === "scan_cam") return t("webChatReplyScanCam");
  if (hit.chosenId === "notes") return t("webChatReplyNotes");
  if (hit.chosenId === "settings") return t("webChatReplySettings");
  if (hit.chosenId === "home_reminders") return t("webChatReplyHomeReminders");
  if (hit.chosenId === "account_login") return t("webChatReplyAccount");
  if (hit.chosenId === "time") {
    return t("webChatReplyTime").replace("{time}", new Date().toLocaleString());
  }
  if (hit.chosenId === "reminder") return webChatCreateReminderFromBackend(effective);

  if (!hit.chosenId) {
    if (hit.bestId === "reminder" && hit.bestScore >= 1.75) {
      return `${t("webChatUnknownNearReminder")}\n\n${t("webChatReplyUnknownSmart")}`;
    }
    if (hit.bestId === "plans" && hit.bestScore >= 1.75) {
      return `${t("webChatUnknownNearPlans")}\n\n${t("webChatReplyUnknownSmart")}`;
    }
    if (hit.bestId === "scan_cam" && hit.bestScore >= 1.75) {
      return `${t("webChatUnknownNearScanCam")}\n\n${t("webChatReplyUnknownSmart")}`;
    }
    return t("webChatReplyUnknownSmart");
  }

  return t("webChatReplyUnknownSmart");
}

async function sendWebChatMessage() {
  const input = document.getElementById("webChatInput");
  const sendBtn = document.querySelector(".web-chat-send");
  if (!input) return;
  if (currentUser && typeof userHasWebChatAccess === "function" && !userHasWebChatAccess(currentUser)) {
    showToast(t("webChatRequiresStandard"));
    syncWebChatSoftPaywallUi();
    syncPremiumGatedNav();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  const resolutionText = webChatMergeReminderFollowUp(text);
  let mode = getWebChatMode();
  if (mode === "openai30") mode = "openai";
  const requestedMode = mode;
  const canAi = typeof userHasWebChatOpenAiAccess === "function" && userHasWebChatOpenAiAccess(currentUser);
  const limitReached = webChatIsOpenAiLimitReached();
  if (requestedMode === "openai" && !canAi) {
    appendWebChatBubble("bot", t("webChatOpenAiStandardOnly"));
    showToast(t("webChatOpenAiStandardOnly"));
    return;
  }
  if (requestedMode === "openai" && limitReached) {
    appendWebChatBubble("bot", t("webChatOpenAiLimitReached"));
    showToast(t("webChatOpenAiLimitReached"));
    return;
  }
  if (!canAi) mode = "chatbot";
  else if (limitReached && mode === "openai") mode = "chatbot";
  syncWebChatModePresentation(mode, false);
  appendWebChatBubble("user", text);
  input.value = "";
  webChatAutoResizeInput(input);
  if (sendBtn) sendBtn.disabled = true;
  appendWebChatTyping();
  const t0 = Date.now();
  try {
    let reply = "";
    let aiUsed = false;
    if (mode === "chatbot") {
      reply = await resolveWebChatReply(text);
    } else if (mode === "openai") {
      if (canAi && !limitReached) {
        const aiReply = await fetchWebChatAiReply(webChatBuildOpenAiMessage(resolutionText));
        if (aiReply) {
          reply = aiReply;
          aiUsed = true;
        }
      }
      if (!reply) {
        throw new Error(t("webChatPlanVerifyFailed"));
      }
    } else {
      reply = await resolveWebChatReply(text);
      if (canAi && !limitReached && webChatShouldFallbackToAi(text)) {
        try {
          const aiReply = await fetchWebChatAiReply(webChatBuildOpenAiMessage(resolutionText));
          if (aiReply) {
            reply = aiReply;
            aiUsed = true;
          }
        } catch {
          /* keep local reply */
        }
      }
    }
    const elapsed = Date.now() - t0;
    const minTypingMs = 520;
    if (elapsed < minTypingMs) await webChatSleep(minTypingMs - elapsed);
    await webChatSleep(160);
    await appendWebChatBotReplyStreaming(reply || t("webChatReplyUnknownSmart"), { ai: aiUsed });
    webChatPushSessionTurn("user", text);
    webChatPushSessionTurn("bot", reply || t("webChatReplyUnknownSmart"));
    if (webChatAiLiveTimer) {
      clearTimeout(webChatAiLiveTimer);
      webChatAiLiveTimer = null;
    }
    if (aiUsed) {
      syncWebChatModePresentation(mode, true);
      webChatAiLiveTimer = setTimeout(() => {
        syncWebChatModePresentation(mode, false);
        webChatAiLiveTimer = null;
      }, 4200);
    } else {
      syncWebChatModePresentation(mode, false);
    }
    webChatPushRecentCommand(text);
  } catch (e) {
    removeWebChatTyping();
    const errText = e && e.message ? String(e.message) : t("webChatPlanVerifyFailed");
    appendWebChatBubble("bot", errText);
    webChatPushSessionTurn("user", text);
    webChatPushSessionTurn("bot", errText);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

function webChatInputKeydown(ev) {
  if (ev.key !== "Enter" || ev.shiftKey) return;
  ev.preventDefault();
  void sendWebChatMessage();
}

function openReminderHistory() {
  setBodyHomePage(false);
  activateMenu("menuHistory");
  document.getElementById("home").classList.add("hidden");
  document.getElementById("category").classList.add("hidden");
  document.getElementById("notes-all").classList.add("hidden");
  document.getElementById("bot").classList.add("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.remove("hidden");
  document.getElementById("settings").classList.add("hidden");
  hideScanCamPage();
  hideCoinsHubPage();
  resetHistoryPageUi();
  void renderReminderHistory();
}

async function openSettings() {
  setBodyHomePage(false);
  activateMenu("menuSettings");
  document.getElementById("home").classList.add("hidden");
  document.getElementById("category").classList.add("hidden");
  document.getElementById("notes-all").classList.add("hidden");
  document.getElementById("bot").classList.add("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.add("hidden");
  document.getElementById("settings").classList.remove("hidden");
  hideScanCamPage();
  hideCoinsHubPage();
  await mergePremiumFromServer();
  displayAccountInfo();
  updateLanguageSelector();
  updateThemeSelector();
  applyTranslations();
  updateSettingsNotificationStatus();
  openSettingsSection("account");
  toggleSettingsSecurityAccordion(false);
  toggleSettingsProfileEdit(false);
  const searchInput = document.getElementById("settingsSearchInput");
  if (searchInput) searchInput.value = "";
}

function openSettingsSection(sectionKey) {
  const key = String(sectionKey || "").trim() || "account";
  settingsActiveSection = key;
  document.querySelectorAll("[data-settings-pane]").forEach((el) => {
    el.classList.toggle("hidden", el.getAttribute("data-settings-pane") !== key);
  });
  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-settings-tab") === key);
  });
}

function settingsSearchInputChanged(value) {
  const q = String(value || "").toLowerCase().trim();
  if (!q) {
    openSettingsSection(settingsActiveSection || "account");
    return;
  }
  const map = [
    { key: "security", words: ["security", "password", "login", "session", "siguri", "fjalekalim"] },
    {
      key: "appearance",
      words: ["appearance", "theme", "language", "look", "dukje", "gjuha", "tema", "tutorial", "tour", "guid", "udhëz"]
    },
    { key: "notifications", words: ["notifications", "notification", "alerts", "njoftime", "sinjalizime"] },
    { key: "premium", words: ["premium", "plan", "subscription", "abonim"] },
    { key: "account", words: ["account", "profile", "email", "username", "llogari", "profil"] }
  ];
  const hit = map.find((item) => item.words.some((word) => word.includes(q) || q.includes(word)));
  openSettingsSection(hit ? hit.key : "account");
}

function toggleSettingsSecurityAccordion(forceOpen) {
  const body = document.getElementById("settingsSecurityAccordionBody");
  const btn = document.getElementById("settingsSecurityAccordionBtn");
  if (!body || !btn) return;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : body.classList.contains("hidden");
  body.classList.toggle("hidden", !shouldOpen);
  btn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

function isFutureReminderInput(value) {
  if (value == null || value === "") return false;
  const d = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(d.getTime()) && d.getTime() > Date.now() - 5000;
}

function toDatetimeLocalValue(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function refreshReminderRelatedViews() {
  loadWebReminders();
  loadHomeEmbedRemindersList();
  if (currentUser) {
    void renderReminderHistory();
  }
  if (!document.getElementById("home")?.classList.contains("hidden")) {
    void updateHomeDashboardStats();
  }
}

async function updateHomeDashboardStats() {
  const welcomeEl = document.getElementById("homeWelcomeLine");
  const notesEl = document.getElementById("homeStatNotes");
  const remEl = document.getElementById("homeStatReminders");
  if (!welcomeEl || !notesEl || !remEl) return;

  if (!currentUser || !accessToken) {
    welcomeEl.textContent = t("homeWelcomeGuest");
    notesEl.textContent = "—";
    remEl.textContent = "—";
    return;
  }

  const name = currentUser.firstName || currentUser.username || "";
  welcomeEl.textContent = t("homeWelcomeNamed").replace("{name}", name);

  try {
    const [notesData, remData] = await Promise.all([
      apiFetch("/api/notes?count=1"),
      fetchWebRemindersListDeduped()
    ]);
    /** Prefer lightweight `count`; if server ignores query (older deploy / proxy), fallback to notes array length. */
    let notesCount = 0;
    const rawCount = notesData && notesData.count;
    if (rawCount !== undefined && rawCount !== null && rawCount !== "") {
      const parsed = typeof rawCount === "number" ? rawCount : parseInt(String(rawCount), 10);
      if (!Number.isNaN(parsed)) notesCount = parsed;
    } else if (Array.isArray(notesData && notesData.notes)) {
      notesCount = notesData.notes.length;
    }
    /* Scan Cam shënime lokale (jo në DB) — përfshihen në listat e app-it, duhet edhe në kryefaqe */
    notesCount += readScanCamLocalNotes().length;

    const reminders = remData.reminders || [];
    notesEl.textContent = String(notesCount);
    remEl.textContent = String(reminders.length);
  } catch {
    notesEl.textContent = "—";
    remEl.textContent = "—";
  }
}

/** Shares one GET /api/reminders/web promise while concurrent callers await (hub + reminders panel + polling overlap). */
let webRemindersListFetchPromise = null;

function fetchWebRemindersListDeduped() {
  if (!currentUser || !accessToken) {
    return Promise.resolve({ reminders: [] });
  }
  if (!webRemindersListFetchPromise) {
    webRemindersListFetchPromise = apiFetch("/api/reminders/web").finally(() => {
      webRemindersListFetchPromise = null;
    });
  }
  return webRemindersListFetchPromise;
}

// ============ WEB REMINDERS (FREE) ============

async function saveWebReminder() {
  if (!currentUser || !accessToken) {
    showToast("Please login first");
    return;
  }

  const noteEl = document.getElementById("webReminderNote");
  const timeEl = document.getElementById("webReminderTime");
  const msgEl = document.getElementById("webReminderMessage");
  if (!noteEl || !timeEl || !msgEl) return;

  const noteId = noteEl.value;
  const reminderTime = timeEl.value;
  const message = msgEl.value;
  
  if (!reminderTime) {
    showToast("Please select a date and time");
    return;
  }

  if (!isFutureReminderInput(reminderTime)) {
    showToast(t("reminderMustBeFuture"));
    return;
  }
  
  if (!noteId && !message) {
    showToast("Please select a note or write a message");
    return;
  }
  
  try {
    const payload = {
      reminderTime: new Date(reminderTime).toISOString(),
      message: message || "Note reminder"
    };
    
    if (noteId) {
      payload.noteId = noteId;
    }
    
    const response = await apiFetch("/api/web-reminder", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    
    showToast("✅ Reminder set! You'll get a notification at: " + new Date(reminderTime).toLocaleString());
    
    noteEl.value = "";
    timeEl.value = "";
    msgEl.value = "";
    
    refreshReminderRelatedViews();
  } catch (err) {
    showToast("Error: " + err.message);
  }
}

async function saveStandaloneWebReminder(messageInputId, timeInputId) {
  if (!requireAuth("schedule reminders")) return;
  const msgEl = document.getElementById(messageInputId);
  const timeEl = document.getElementById(timeInputId);
  if (!msgEl || !timeEl) return;

  const message = msgEl.value.trim();
  const reminderTime = timeEl.value;

  if (!message) {
    showToast(t("hubReminderMessageRequired"));
    return;
  }
  if (!reminderTime) {
    showToast(t("reminderTimeRequired"));
    return;
  }
  if (!isFutureReminderInput(reminderTime)) {
    showToast(t("reminderMustBeFuture"));
    return;
  }

  try {
    await apiFetch("/api/web-reminder", {
      method: "POST",
      body: JSON.stringify({
        reminderTime: new Date(reminderTime).toISOString(),
        message
      })
    });
    showToast(t("hubReminderScheduled") + " " + new Date(reminderTime).toLocaleString());
    msgEl.value = "";
    timeEl.value = "";
    refreshReminderRelatedViews();
  } catch (err) {
    showToast(err.message);
  }
}

function saveHomeEmbedWebReminder() {
  void saveStandaloneWebReminder("homeEmbedReminderMessage", "homeEmbedReminderTime");
}

async function loadWebRemindersIntoList(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!currentUser || !accessToken) {
    container.innerHTML = `<p class="panel-note">${escapeHtml(t("loginForHubReminders"))}</p>`;
    return;
  }

  try {
    const data = await fetchWebRemindersListDeduped();
    const reminders = data.reminders || [];
    void syncReminderLocalNotifications(reminders);
    container.innerHTML = "";

    if (!reminders.length) {
      container.innerHTML = `<p class="panel-note">${escapeHtml(t("hubNoUpcomingReminders"))}</p>`;
      return;
    }

    reminders.forEach((reminder) => {
      const row = document.createElement("div");
      row.className = "reminder-item reminder-item-row";
      const main = document.createElement("div");
      main.className = "reminder-item-content";
      const timeDiv = document.createElement("div");
      timeDiv.className = "reminder-time";
      timeDiv.textContent = new Date(reminder.time).toLocaleString();
      const msgDiv = document.createElement("div");
      msgDiv.className = "reminder-msg";
      msgDiv.textContent = reminder.message || "";
      main.appendChild(timeDiv);
      main.appendChild(msgDiv);
      const bell = document.createElement("button");
      bell.type = "button";
      const bellEnabled = isReminderNotificationEnabled(reminder._id);
      bell.className = `daily-planner-item__bell${bellEnabled ? " is-on" : ""}`;
      bell.setAttribute("aria-label", "Toggle reminder notification");
      bell.textContent = "🔔";
      bell.addEventListener("click", () =>
        toggleReminderNotification(String(reminder._id), new Date(reminder.time), reminder.message || "", bell)
      );
      const del = document.createElement("button");
      del.type = "button";
      del.className = "reminder-item-delete";
      del.textContent = t("deleteReminderBtn");
      del.addEventListener("click", () => deleteReminderById(String(reminder._id)));
      row.appendChild(main);
      row.appendChild(bell);
      row.appendChild(del);
      container.appendChild(row);
    });
  } catch (err) {
    container.innerHTML = `<p class="panel-note">${escapeHtml(err.message)}</p>`;
  }
}

async function loadHomeEmbedRemindersList() {
  await loadWebRemindersIntoList("homeEmbedWebRemindersList");
}

async function deleteReminderById(id) {
  if (!requireAuth("delete reminders")) return;
  if (!window.confirm(t("deleteReminderConfirm"))) return;
  try {
    await apiFetch(`/api/reminder/${encodeURIComponent(id)}`, { method: "DELETE" });
    setReminderNotificationEnabled(id, false);
    void cancelReminderLocalNotification(id);
    showToast(t("reminderDeletedToast"));
    refreshReminderRelatedViews();
  } catch (err) {
    showToast(err.message);
  }
}

async function toggleReminderNotification(reminderId, whenDate, message, buttonEl) {
  const id = String(reminderId || "").trim();
  if (!id) return;
  const nextEnabled = !isReminderNotificationEnabled(id);
  if (nextEnabled) {
    const allowed = await requestNotificationPermissionIfNeeded(true);
    if (!allowed) {
      showToast(t("notificationsDenied"));
      return;
    }
  }
  setReminderNotificationEnabled(id, nextEnabled);
  if (buttonEl && buttonEl.classList) {
    buttonEl.classList.toggle("is-on", nextEnabled);
    buttonEl.classList.remove("is-bounce");
    requestAnimationFrame(() => buttonEl.classList.add("is-bounce"));
    window.setTimeout(() => buttonEl.classList.remove("is-bounce"), 280);
  }

  const reminderLike = {
    _id: id,
    time: (() => {
      const parsed = whenDate instanceof Date ? whenDate : new Date(whenDate);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
    })(),
    message
  };
  if (nextEnabled) {
    await scheduleReminderLocalNotification(reminderLike);
  } else {
    await cancelReminderLocalNotification(id);
  }
}

function requestNotificationPermission() {
  requestNotificationPermissionIfNeeded(true).then((granted) => {
    if (granted) {
      showToast(t("notificationsEnabledToast"));
      void syncPlannerLocalNotifications();
      if (currentUser && accessToken) {
        void fetchWebRemindersListDeduped()
          .then((data) => syncReminderLocalNotifications((data && data.reminders) || []))
          .catch(() => {});
      }
    } else {
      showToast(t("notificationsDenied"));
    }
    void updateSettingsNotificationStatus();
  });
}

function openReminderEditModal(reminder) {
  const idEl = document.getElementById("reminderEditId");
  const msgEl = document.getElementById("reminderEditMessage");
  const timeEl = document.getElementById("reminderEditTime");
  const modal = document.getElementById("reminderEditModal");
  if (!idEl || !msgEl || !timeEl || !modal || !reminder) return;

  idEl.value = String(reminder._id);
  msgEl.value = reminder.message || "";
  timeEl.value = toDatetimeLocalValue(reminder.time);
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  msgEl.focus();
}

function closeReminderEditModal() {
  const modal = document.getElementById("reminderEditModal");
  if (modal) modal.classList.add("hidden");
  releaseModalBackdropIfIdle();
  const idEl = document.getElementById("reminderEditId");
  if (idEl) idEl.value = "";
}

async function submitReminderEdit() {
  const idEl = document.getElementById("reminderEditId");
  const msgEl = document.getElementById("reminderEditMessage");
  const timeEl = document.getElementById("reminderEditTime");
  if (!idEl || !msgEl || !timeEl) return;

  const id = idEl.value.trim();
  const message = msgEl.value.trim();
  const reminderTime = timeEl.value;
  if (!id || !message || !reminderTime) {
    showToast(t("fillReminderFields"));
    return;
  }
  if (!isFutureReminderInput(reminderTime)) {
    showToast(t("reminderMustBeFuture"));
    return;
  }

  try {
    await apiFetch(`/api/reminder/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        reminderTime: new Date(reminderTime).toISOString()
      })
    });
    showToast(t("reminderUpdatedToast"));
    closeReminderEditModal();
    refreshReminderRelatedViews();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadWebReminders() {
  if (!currentUser || !accessToken) return;

  const container = document.getElementById("activeRemindersList");
  const containerParent = document.getElementById("activeRemindersContainer");
  if (!container || !containerParent) return;

  try {
    const data = await fetchWebRemindersListDeduped();
    const reminders = data.reminders || [];
    void syncReminderLocalNotifications(reminders);

    if (reminders.length === 0) {
      containerParent.style.display = "none";
      return;
    }

    containerParent.style.display = "block";
    container.innerHTML = "";

    reminders.forEach((reminder) => {
      const reminderEl = document.createElement("div");
      reminderEl.className = "reminder-item reminder-item-row";
      const main = document.createElement("div");
      main.className = "reminder-item-content";
      const timeEl = document.createElement("div");
      timeEl.className = "reminder-time";
      timeEl.textContent = new Date(reminder.time).toLocaleString();
      const msgEl = document.createElement("div");
      msgEl.className = "reminder-msg";
      msgEl.textContent = reminder.message || "";
      main.appendChild(timeEl);
      main.appendChild(msgEl);
      const bell = document.createElement("button");
      bell.type = "button";
      const bellEnabled = isReminderNotificationEnabled(reminder._id);
      bell.className = `daily-planner-item__bell${bellEnabled ? " is-on" : ""}`;
      bell.setAttribute("aria-label", "Toggle reminder notification");
      bell.textContent = "🔔";
      bell.addEventListener("click", () =>
        toggleReminderNotification(String(reminder._id), new Date(reminder.time), reminder.message || "", bell)
      );
      const del = document.createElement("button");
      del.type = "button";
      del.className = "reminder-item-delete";
      del.textContent = t("deleteReminderBtn");
      del.addEventListener("click", () => deleteReminderById(String(reminder._id)));
      reminderEl.appendChild(main);
      reminderEl.appendChild(bell);
      reminderEl.appendChild(del);
      container.appendChild(reminderEl);
    });
  } catch (err) {
    console.error("Error loading web reminders:", err);
  }
}

// ============ WEB NOTIFICATION SCHEDULER ============

let webNotificationSchedulerStarted = false;
let webNotificationSchedulerIntervalId = null;
let webNotificationVisibilityHooked = false;

function startWebNotificationScheduler() {
  if (webNotificationSchedulerStarted) return;
  webNotificationSchedulerStarted = true;
  if (isNativeLocalNotificationsAvailable()) {
    void syncPlannerLocalNotifications();
    return;
  }
  const intervalMs = 15000;
  webNotificationSchedulerIntervalId = window.setInterval(checkForDueReminders, intervalMs);
  if (!webNotificationVisibilityHooked) {
    webNotificationVisibilityHooked = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && currentUser && accessToken) {
        checkForDueReminders();
      }
    });
  }
  checkForDueReminders();
}

async function checkForDueReminders() {
  if (isNativeLocalNotificationsAvailable()) return;
  if (!currentUser || !accessToken) return;
  
  try {
    const data = await fetchWebRemindersListDeduped();
    const reminders = data.reminders || [];
    
    const now = new Date();
    
    reminders.forEach(reminder => {
      if (reminder.sent) return; // Already sent
      
      const reminderTime = new Date(reminder.time);
      
      // If reminder time has passed, show notification
      if (reminderTime <= now) {
        showWebNotification(reminder);
      }
    });
  } catch (err) {
    console.warn("Error checking for due reminders:", err);
  }
}

function showWebNotification(reminder) {
  if (isNativeLocalNotificationsAvailable()) return;
  const id = String(reminder._id);
  if (webNotificationLock.has(id)) return;

  if (!("Notification" in window)) {
    showToast(t("notificationsNotSupported"));
    return;
  }

  if (Notification.permission === "granted") {
    webNotificationLock.add(id);
    try {
      const notification = new Notification(t("webNotificationTitle"), {
        body: reminder.message || t("reminderDefaultBody"),
        tag: id
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      markReminderAsSent(reminder._id)
        .catch(() => {})
        .finally(() => {
          webNotificationLock.delete(id);
          refreshReminderRelatedViews();
        });
    } catch {
      webNotificationLock.delete(id);
    }
  } else if (Notification.permission === "denied") {
    webNotificationLock.add(id);
    showToast(`${reminder.message || t("reminderDefaultBody")} — ${t("notificationsDeniedHint")}`);
    markReminderAsSent(reminder._id)
      .catch(() => {})
      .finally(() => {
        webNotificationLock.delete(id);
        refreshReminderRelatedViews();
      });
  } else {
    Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        showWebNotification(reminder);
      } else if (permission === "denied") {
        showToast(t("notificationsDenied"));
      }
    });
  }
}

async function markReminderAsSent(reminderId) {
  try {
    await apiFetch(`/api/reminder/${encodeURIComponent(String(reminderId))}/mark-sent`, {
      method: "PUT"
    });
  } catch {
    /* non-fatal */
  }
}

// Update category page to load web reminders when opened
function updateCategoryViewForWebReminders() {
  const section = document.getElementById("webReminderSection");
  if (!section) return;
  section.style.display = "none";
}

function getPublicNotes() {
  return [
    {
      _id: "public-1",
      text: "Public category preview: sign in to save and manage your own notes.",
      createdAt: new Date().toISOString(),
      public: true
    }
  ];
}

async function loadNotes() {
  try {
    const data = await apiFetch(`/api/notes/${currentCategory}`);
    let list = data.notes || [];
    if (currentCategory === "scan_cam") {
      list = mergeNotesWithScanCamLocal(list);
    }
    currentNotes = list;
    renderNotes(currentNotes);
  } catch (err) {
    showToast(err.message);
    currentNotes = [];
    renderNotes([]);
  }
}

function renderNotes(notes) {
  const container = document.getElementById("notes");
  const noteCount = document.getElementById("noteCount");
  if (!container || !noteCount) return;

  container.innerHTML = "";
  noteCount.innerText = `${notes.length} notes`;

  if (!notes.length) {
    const message = currentUser
      ? currentCategory === "scan_cam"
        ? t("scanCamClickToCreate")
        : t("clickToCreate")
      : t("loginToView");
    const emptyTitle = currentUser ? t("noNotesYet") : t("publicPreview");

    container.innerHTML = `
      <div class="note-card">
        <div class="note-content">
          <h3>${escapeHtml(emptyTitle)}</h3>
          <p>${escapeHtml(message)}</p>
        </div>
      </div>
    `;
    refreshDepthRevealObservers();
    return;
  }

  notes.forEach((note) => {
    const noteCard = document.createElement("div");
    noteCard.className = "note-card";
    const inner = document.createElement("div");
    inner.className = "note-card-inner";
    const content = document.createElement("div");
    content.className = "note-content";
    appendNoteCardHeadingAndBody(content, note);
    inner.appendChild(content);
    const canManage = currentUser && !note.public;
    if (canManage) {
      inner.appendChild(createNoteActionToolbar(note, "category"));
    }
    noteCard.setAttribute("role", "button");
    noteCard.setAttribute("tabindex", "0");
    noteCard.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".note-actions--toolbar")) return;
      openNoteViewModal(note, "category");
    });
    noteCard.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openNoteViewModal(note, "category");
    });
    noteCard.appendChild(inner);
    container.appendChild(noteCard);
  });
  refreshDepthRevealObservers();
}

function populateNoteEditorCategorySelect() {
  const select = document.getElementById("noteEditorCategory");
  if (!select) return;
  select.innerHTML = "";
  Object.keys(categories).forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = categories[key] || key;
    select.appendChild(option);
  });
}

async function noteRichEditorPersistRequest(payload) {
  const { mode, origin, presetCategory, noteId, title, storageText, plainText } = payload || {};

  const titleTrim = String(title || "").trim();

  const hasId = noteId && String(noteId).length > 0;

  if (mode === "create" && !hasId) {
    let category = currentCategory;
    if (origin === "all") {
      const keys = Object.keys(categories || {});
      category = keys.length ? keys[0] : "";
    } else if (origin === "home" && presetCategory) {
      category = presetCategory;
    }
    if (!category) {
      throw new Error(t("categoryRequired"));
    }

    if (category === "scan_cam") {
      try {
        await mergePremiumFromServer();
      } catch (_) {
        /* ignore */
      }
      if (typeof userHasScanCamAccess === "function" && !userHasScanCamAccess(currentUser)) {
        throw new Error(t("scanCamRequiresStandard"));
      }
      const note = persistScanCamNoteLocally(storageText, titleTrim);
      return { note };
    }

    const created = await apiFetch("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        category,
        text: storageText,
        title: titleTrim
      })
    });
    if (created && created.note && created.note._id) {
      const id = String(created.note._id);
      allNotes = [created.note, ...allNotes.filter((n) => String(n._id) !== id)];
      if (created.note.category === currentCategory) {
        currentNotes = [created.note, ...currentNotes.filter((n) => String(n._id) !== id)];
      }
      noteEditorState = {
        mode: "edit",
        origin,
        editingNote: created.note,
        presetCategory: null
      };
    }
    return created;
  }

  const idStr = noteId ? String(noteId) : "";
  if (!idStr) {
    throw new Error("Missing note id");
  }

  if (idStr.startsWith("local-scan-")) {
    updateScanCamLocalNote(idStr, { text: storageText, title: titleTrim });
    const prev = noteEditorState.editingNote || {};
    const updated = { ...prev, _id: idStr, text: storageText, title: titleTrim };
    const lid = idStr;
    const replace = (arr) => {
      const ix = arr.findIndex((n) => String(n._id) === lid);
      if (ix >= 0) arr[ix] = updated;
    };
    replace(allNotes);
    replace(currentNotes);
    noteEditorState.editingNote = updated;
    return { note: updated };
  }

  const updated = await apiFetch(`/api/notes/${noteId}`, {
    method: "PUT",
    body: JSON.stringify({
      text: storageText,
      title: titleTrim
    })
  });
  if (updated && updated.note && updated.note._id) {
    const uid = String(updated.note._id);
    const replace = (arr) => {
      const ix = arr.findIndex((n) => String(n._id) === uid);
      if (ix >= 0) arr[ix] = updated.note;
    };
    replace(allNotes);
    replace(currentNotes);
    noteEditorState.editingNote = updated.note;
  }
  return updated;
}

function openNoteEditorCreate(origin, presetCategory = null) {
  if (!requireAuth("add a note")) return;
  if (origin === "category" && !currentCategory) {
    showToast(t("pickCategoryFirst"));
    return;
  }
  if (origin === "home" && (!presetCategory || !categories[presetCategory])) {
    showToast(t("pickCategoryFirst"));
    return;
  }
  if (!window.NoteRichEditor || typeof window.NoteRichEditor.open !== "function") {
    showToast("Editor failed to load. Refresh the page.");
    return;
  }
  noteEditorState = { mode: "create", origin, editingNote: null, presetCategory };
  window.noteRichEditorPersist = noteRichEditorPersistRequest;
  window.NoteRichEditor.open({
    mode: "create",
    origin,
    presetCategory,
    categories,
    note: null,
    onClosed: () => {
      noteEditorState = { mode: "create", origin: "category", editingNote: null, presetCategory: null };
      if (currentCategory) {
        loadNotes();
      }
      if (!document.getElementById("notes-all")?.classList.contains("hidden")) {
        loadMyNotes();
      }
      if (currentCategory) {
        updateCategoryViewForWebReminders();
      }
      if (!document.getElementById("home")?.classList.contains("hidden")) {
        void updateHomeDashboardStats();
      }
    }
  });
}

function openNoteEditorEdit(note, origin) {
  if (!requireAuth("edit a note")) return;
  if (!note || !note._id) return;
  if (!window.NoteRichEditor || typeof window.NoteRichEditor.open !== "function") {
    showToast("Editor failed to load. Refresh the page.");
    return;
  }
  noteEditorState = { mode: "edit", origin, editingNote: note, presetCategory: null };
  window.noteRichEditorPersist = noteRichEditorPersistRequest;
  window.NoteRichEditor.open({
    mode: "edit",
    origin,
    presetCategory: null,
    categories,
    note,
    onClosed: () => {
      noteEditorState = { mode: "create", origin: "category", editingNote: null, presetCategory: null };
      if (currentCategory) {
        loadNotes();
      }
      if (!document.getElementById("notes-all")?.classList.contains("hidden")) {
        loadMyNotes();
      }
      if (currentCategory) {
        updateCategoryViewForWebReminders();
      }
      if (!document.getElementById("home")?.classList.contains("hidden")) {
        void updateHomeDashboardStats();
      }
    }
  });
}

function closeNoteEditor() {
  if (window.NoteRichEditor && typeof window.NoteRichEditor.close === "function") {
    window.NoteRichEditor.close();
  }
  const modal = document.getElementById("noteEditorModal");
  if (modal) modal.classList.add("hidden");
  const titleInput = document.getElementById("noteEditorTitleInput");
  if (titleInput) titleInput.value = "";
  releaseModalBackdropIfIdle();
  noteEditorState = { mode: "create", origin: "category", editingNote: null, presetCategory: null };
}

async function submitNoteEditor() {
  const textEl = document.getElementById("noteEditorText");
  const titleInput = document.getElementById("noteEditorTitleInput");
  if (!textEl) return;
  const text = textEl.value.trim();
  if (!text) {
    showToast(t("noteTextRequired"));
    return;
  }
  const title = titleInput ? titleInput.value.trim() : "";

  try {
    if (noteEditorState.mode === "create") {
      let category = currentCategory;
      if (noteEditorState.origin === "all") {
        const select = document.getElementById("noteEditorCategory");
        category = select && select.value ? select.value : "";
      } else if (noteEditorState.origin === "home" && noteEditorState.presetCategory) {
        category = noteEditorState.presetCategory;
      }
      if (!category) {
        showToast(t("categoryRequired"));
        return;
      }
      if (category === "scan_cam") {
        try {
          await mergePremiumFromServer();
        } catch (_) {
          /* ignore */
        }
        if (typeof userHasScanCamAccess === "function" && !userHasScanCamAccess(currentUser)) {
          showToast(t("scanCamRequiresStandard"));
          return;
        }
        persistScanCamNoteLocally(text, title);
        showToast(t("noteCreatedToast"));
      } else {
        const created = await apiFetch("/api/notes", {
          method: "POST",
          body: JSON.stringify({ category, text, title })
        });
        if (created && created.note && created.note._id) {
          const id = String(created.note._id);
          allNotes = [created.note, ...allNotes.filter((n) => String(n._id) !== id)];
          if (created.note.category === currentCategory) {
            currentNotes = [created.note, ...currentNotes.filter((n) => String(n._id) !== id)];
          }
        }
        showToast(t("noteCreatedToast"));
      }
    } else {
      const note = noteEditorState.editingNote;
      if (!note || !note._id) return;
      const lid = String(note._id);
      if (lid.startsWith("local-scan-")) {
        updateScanCamLocalNote(lid, { text, title });
        const updated = { ...note, text, title };
        const replace = (arr) => {
          const ix = arr.findIndex((n) => String(n._id) === lid);
          if (ix >= 0) arr[ix] = updated;
        };
        replace(allNotes);
        replace(currentNotes);
        showToast(t("noteUpdatedToast"));
      } else {
        const updated = await apiFetch(`/api/notes/${note._id}`, {
          method: "PUT",
          body: JSON.stringify({ text, title })
        });
        if (updated && updated.note && updated.note._id) {
          const id = String(updated.note._id);
          const replace = (arr) => {
            const ix = arr.findIndex((n) => String(n._id) === id);
            if (ix >= 0) arr[ix] = updated.note;
          };
          replace(allNotes);
          replace(currentNotes);
        }
        showToast(t("noteUpdatedToast"));
      }
    }

    closeNoteEditor();
    if (currentCategory) {
      loadNotes();
    }
    if (!document.getElementById("notes-all")?.classList.contains("hidden")) {
      loadMyNotes();
    }
    if (currentCategory) {
      updateCategoryViewForWebReminders();
    }
    if (!document.getElementById("home")?.classList.contains("hidden")) {
      void updateHomeDashboardStats();
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteNoteById(note) {
  if (!requireAuth("delete a note")) return;
  if (!note || !note._id) return;
  if (!window.confirm(t("deleteNoteConfirm"))) return;

  const idStr = String(note._id);
  if (idStr.startsWith("local-scan-")) {
    removeScanCamLocalNote(idStr);
    allNotes = allNotes.filter((n) => String(n._id) !== idStr);
    currentNotes = currentNotes.filter((n) => String(n._id) !== idStr);
    showToast(t("noteDeletedToast"));
    if (currentCategory) {
      loadNotes();
    }
    if (!document.getElementById("notes-all")?.classList.contains("hidden")) {
      loadMyNotes();
    }
    if (currentCategory) {
      updateCategoryViewForWebReminders();
    }
    if (!document.getElementById("home")?.classList.contains("hidden")) {
      void updateHomeDashboardStats();
    }
    return;
  }

  try {
    await apiFetch(`/api/notes/${encodeURIComponent(String(note._id))}`, { method: "DELETE" });
    showToast(t("noteDeletedToast"));
    if (currentCategory) {
      loadNotes();
    }
    if (!document.getElementById("notes-all")?.classList.contains("hidden")) {
      loadMyNotes();
    }
    if (currentCategory) {
      updateCategoryViewForWebReminders();
    }
    if (!document.getElementById("home")?.classList.contains("hidden")) {
      void updateHomeDashboardStats();
    }
  } catch (err) {
    showToast(err.message);
  }
}

function debouncedFilterAllNotes() {
  clearTimeout(notesFilterTimer);
  notesFilterTimer = setTimeout(() => filterAllNotesList(), 200);
}

function setAllNotesSort(value) {
  allNotesSortMode = value || "newest";
  filterAllNotesList();
}

function normalizeNoteCategoryKey(note) {
  return note && note.category != null ? String(note.category).trim() : "";
}

function normalizeNoteCategoryLabel(note) {
  const key = normalizeNoteCategoryKey(note);
  if (!key) return t("myNotesUncategorizedBadge");
  if (typeof categories !== "undefined" && categories[key]) return categories[key];
  return key;
}

function populateAllNotesCategoryFilter(notes) {
  const select = document.getElementById("notesCategoryFilter");
  if (!select) return;

  const currentValue = select.value || "all";
  const labelsByKey = new Map();
  (notes || []).forEach((note) => {
    const key = normalizeNoteCategoryKey(note) || UNCATEGORIZED_NOTE_KEY;
    if (!labelsByKey.has(key)) {
      labelsByKey.set(key, normalizeNoteCategoryLabel(note));
    }
  });

  const predefined = typeof categories !== "undefined" ? Object.keys(categories) : [];
  const orderedKeys = [
    ...predefined.filter((key) => labelsByKey.has(key)),
    ...[...labelsByKey.keys()]
      .filter((key) => !predefined.includes(key) && key !== UNCATEGORIZED_NOTE_KEY)
      .sort((a, b) => String(labelsByKey.get(a)).localeCompare(String(labelsByKey.get(b)))),
    ...(labelsByKey.has(UNCATEGORIZED_NOTE_KEY) ? [UNCATEGORIZED_NOTE_KEY] : [])
  ];

  select.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = t("notesCategoryFilterAll");
  select.appendChild(allOpt);

  orderedKeys.forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = labelsByKey.get(key) || t("myNotesUncategorizedBadge");
    select.appendChild(option);
  });

  select.value = [...select.options].some((o) => o.value === currentValue) ? currentValue : "all";
}

function getFilteredAndSortedAllNotes() {
  const q = (document.getElementById("notesSearchInput")?.value || "").trim().toLowerCase();
  const catFilter = document.getElementById("notesCategoryFilter")?.value || "all";

  let filtered = allNotes.filter((note) => {
    if (catFilter !== "all") {
      const key = normalizeNoteCategoryKey(note) || UNCATEGORIZED_NOTE_KEY;
      if (key !== catFilter) return false;
    }
    if (!q) return true;
    const hay = `${noteTitleTrim(note)}\n${note.text || ""}\n${normalizeNoteCategoryLabel(note)}`.toLowerCase();
    return hay.includes(q);
  });

  filtered = filtered.slice().sort((a, b) => {
    if (allNotesSortMode === "oldest") {
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    }
    if (allNotesSortMode === "title-asc") {
      return noteTitleTrim(a).localeCompare(noteTitleTrim(b), undefined, { sensitivity: "base" });
    }
    if (allNotesSortMode === "category-asc") {
      return normalizeNoteCategoryLabel(a).localeCompare(normalizeNoteCategoryLabel(b), undefined, { sensitivity: "base" });
    }
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  return filtered;
}

function filterAllNotesList() {
  const filtered = getFilteredAndSortedAllNotes();
  const countEl = document.getElementById("allNotesCount");
  if (countEl) countEl.textContent = `${filtered.length} ${t("notes")}`;
  renderAllNotesList(filtered);
}

async function loadMyNotes() {
  const container = document.getElementById("allNotesList");
  const countEl = document.getElementById("allNotesCount");
  if (!container || !countEl) return;

  if (!currentUser) {
    container.className = "notes-list";
    countEl.textContent = `0 ${t("notes")}`;
    container.innerHTML = `
      <div class="note-card">
        <div class="note-content">
          <h3>${escapeHtml(t("loginForNotesTitle"))}</h3>
          <p>${escapeHtml(t("loginForNotesBody"))}</p>
        </div>
      </div>
    `;
    refreshDepthRevealObservers();
    return;
  }

  try {
    const data = await apiFetch("/api/notes");
    const notes = data.notes || [];
    const merged = mergeNotesWithScanCamLocal(notes);
    allNotes = merged;
    populateAllNotesCategoryFilter(merged);
    const sortSelect = document.getElementById("notesSortSelect");
    if (sortSelect) sortSelect.value = allNotesSortMode;
    filterAllNotesList();
  } catch (err) {
    showToast(err.message);
    countEl.textContent = `0 ${t("notes")}`;
    container.className = "notes-list";
    container.innerHTML = `<div class="note-card"><div class="note-content"><p>${escapeHtml(err.message)}</p></div></div>`;
    refreshDepthRevealObservers();
  }
}

const UNCATEGORIZED_NOTE_KEY = "__uncategorized__";

function storageCategoryKey(note) {
  const c = note && note.category != null ? String(note.category).trim() : "";
  return c || UNCATEGORIZED_NOTE_KEY;
}

function noteCategoryThemeKey(category) {
  const key = category && String(category).trim();
  if (key && typeof NOTE_CATEGORY_THEME !== "undefined" && NOTE_CATEGORY_THEME[key]) {
    return NOTE_CATEGORY_THEME[key];
  }
  return "neutral";
}

/** Category keys present in `notes`, in app order then any extras sorted. */
function orderedCategoryKeysFromNotes(notes) {
  const present = new Set((notes || []).map((n) => storageCategoryKey(n)));
  const predefined = typeof categories !== "undefined" ? Object.keys(categories) : [];
  const ordered = [];
  for (const k of predefined) {
    if (present.has(k)) ordered.push(k);
  }
  const rest = [...present]
    .filter((k) => !ordered.includes(k) && k !== UNCATEGORIZED_NOTE_KEY)
    .sort();
  const tail = present.has(UNCATEGORIZED_NOTE_KEY) ? [UNCATEGORIZED_NOTE_KEY] : [];
  return [...ordered, ...rest, ...tail];
}

function appendMyNoteCard(container, note) {
  const theme = noteCategoryThemeKey(note.category);
  const noteCard = document.createElement("div");
  noteCard.className = `note-card note-card--accent-${theme}`;
  const inner = document.createElement("div");
  inner.className = "note-card-inner";
  const content = document.createElement("div");
  content.className = "note-content";
  const badge = document.createElement("span");
  badge.className = `note-category-badge note-category-badge--${theme}`;
  const rawCat = note.category && String(note.category).trim();
  badge.textContent = rawCat
    ? (typeof categories !== "undefined" && categories[rawCat]) || rawCat
    : t("myNotesUncategorizedBadge");
  content.appendChild(badge);
  appendNoteCardHeadingAndBody(content, note);
  inner.appendChild(content);
  inner.appendChild(createNoteActionToolbar(note, "all"));
  noteCard.setAttribute("role", "button");
  noteCard.setAttribute("tabindex", "0");
  noteCard.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".note-actions--toolbar")) return;
    openNoteViewModal(note, "all");
  });
  noteCard.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openNoteViewModal(note, "all");
  });
  noteCard.appendChild(inner);
  container.appendChild(noteCard);
}

function renderAllNotesList(notes) {
  const container = document.getElementById("allNotesList");
  if (!container) return;

  container.innerHTML = "";

  if (!notes.length) {
    container.className = "notes-list";
    const hasAny = Array.isArray(allNotes) && allNotes.length > 0;
    const title = hasAny ? t("notesSearchEmptyTitle") : t("noNotesYet");
    const body = hasAny ? t("notesSearchEmptyBody") : t("myNotesEmptyHint");
    container.innerHTML = `
      <div class="note-card">
        <div class="note-content">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(body)}</p>
        </div>
      </div>
    `;
    refreshDepthRevealObservers();
    return;
  }

  container.className = "notes-list notes-list--grid";
  notes.forEach((note) => appendMyNoteCard(container, note));
  refreshDepthRevealObservers();
}

function resetHistoryPageUi() {
  historyFilterMode = "all";
  historySortMode = "due-asc";
  const inp = document.getElementById("historySearchInput");
  if (inp) inp.value = "";
  const sel = document.getElementById("historySortSelect");
  if (sel) sel.value = "due-asc";
  document.querySelectorAll(".history-segment-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-history-filter") === "all");
  });
  const layout = document.getElementById("historyLayout");
  if (layout) {
    layout.classList.remove("history-layout--active-only", "history-layout--past-only");
  }
}

function setHistoryFilter(mode) {
  historyFilterMode = mode;
  document.querySelectorAll(".history-segment-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-history-filter") === mode);
  });
  const layout = document.getElementById("historyLayout");
  if (layout) {
    layout.classList.remove("history-layout--active-only", "history-layout--past-only");
    if (mode === "active") layout.classList.add("history-layout--active-only");
    if (mode === "past") layout.classList.add("history-layout--past-only");
  }
  applyHistoryFilterAndRender();
}

function setHistorySort(value) {
  historySortMode = value || "due-asc";
  applyHistoryFilterAndRender();
}

function debouncedRenderReminderHistory() {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => applyHistoryFilterAndRender(), 220);
}

function formatReminderShortDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d`;
  if (h >= 1) return `${h}h`;
  if (m >= 1) return `${m}m`;
  return "<1m";
}

function formatReminderRelativeLine(reminderTime, isPast, sent) {
  const now = Date.now();
  const dueMs = reminderTime.getTime();
  if (sent || isPast) {
    const ago = Math.max(0, now - dueMs);
    return `${formatReminderShortDuration(ago)}${t("historyAgoSuffix")}`;
  }
  const fut = dueMs - now;
  if (fut <= 0) return t("historyDueNow");
  return `${t("historyInPrefix")} ${formatReminderShortDuration(fut)}`;
}

function reminderNoteSnippet(reminder) {
  if (reminder.noteId && typeof reminder.noteId === "object" && reminder.noteId.text) {
    const title = noteTitleTrim(reminder.noteId);
    return title ? `${title} — ${reminder.noteId.text}` : reminder.noteId.text;
  }
  return "";
}

function reminderMatchesHistorySearch(reminder, q) {
  if (!q) return true;
  const hay = [reminder.message || "", reminderNoteSnippet(reminder)].join("\n").toLowerCase();
  return hay.includes(q);
}

function splitHistoryActivePast(reminders) {
  const nowTs = Date.now();
  const active = [];
  const past = [];
  (Array.isArray(reminders) ? reminders : []).forEach((reminder) => {
    const ts = new Date(reminder.time).getTime();
    const isPast = Boolean(reminder.sent) || ts <= nowTs;
    if (isPast) past.push(reminder);
    else active.push(reminder);
  });
  active.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  past.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return { active, past };
}

async function pruneHistoryReminderLimit() {
  if (historyPruneInFlight || !currentUser || !accessToken) return;
  const { active, past } = splitHistoryActivePast(historyRemindersRaw);
  const overflow = [...active.slice(HISTORY_COLUMN_LIMIT), ...past.slice(HISTORY_COLUMN_LIMIT)].filter((r) => r && r._id);
  if (!overflow.length) return;
  historyPruneInFlight = true;
  try {
    await Promise.allSettled(
      overflow.map((r) =>
        apiFetch(`/api/reminders/${encodeURIComponent(String(r._id))}`, {
          method: "DELETE"
        })
      )
    );
    const removeIds = new Set(overflow.map((r) => String(r._id)));
    historyRemindersRaw = historyRemindersRaw.filter((r) => !removeIds.has(String(r._id)));
    applyHistoryFilterAndRender();
  } finally {
    historyPruneInFlight = false;
  }
}

function buildReminderHistoryCard(reminder) {
  const now = new Date();
  const reminderTime = new Date(reminder.time);
  const isPast = Boolean(reminder.sent) || reminderTime.getTime() <= now.getTime();

  const card = document.createElement("div");
  card.className = `reminder-card ${isPast ? "past" : "active"}`;

  const top = document.createElement("div");
  top.className = "reminder-card-top";

  const status = document.createElement("span");
  status.className = "reminder-status-badge";
  status.textContent = isPast ? t("historyStatusPast") : t("historyStatusActive");

  const timeEl = document.createElement("time");
  timeEl.className = "reminder-card-datetime";
  timeEl.dateTime = reminderTime.toISOString();
  timeEl.textContent = reminderTime.toLocaleString();

  top.appendChild(status);
  top.appendChild(timeEl);

  const rel = document.createElement("p");
  rel.className = "reminder-card-relative";
  rel.textContent = formatReminderRelativeLine(reminderTime, isPast, reminder.sent);

  const snippet = reminderNoteSnippet(reminder);

  const msgP = document.createElement("p");
  msgP.className = "reminder-message";
  msgP.textContent = reminder.message || "—";

  const actions = document.createElement("div");
  actions.className = "reminder-actions";
  const canEdit = !reminder.sent && reminder.status === "pending";
  if (canEdit) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.dataset.action = "edit";
    editBtn.textContent = t("historyActionEdit");
    editBtn.addEventListener("click", () => editReminderReminder(reminder));
    actions.appendChild(editBtn);
  }
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.dataset.action = "delete";
  delBtn.textContent = t("historyActionDelete");
  delBtn.addEventListener("click", () => deleteReminderReminder(reminder));
  actions.appendChild(delBtn);

  card.appendChild(top);
  card.appendChild(rel);
  if (snippet) {
    const noteP = document.createElement("p");
    noteP.className = "reminder-note";
    noteP.textContent = snippet;
    card.appendChild(noteP);
  }
  card.appendChild(msgP);
  card.appendChild(actions);
  return card;
}

function applyHistoryFilterAndRender() {
  const activeContainer = document.getElementById("activeReminders");
  const pastContainer = document.getElementById("pastReminders");
  const statA = document.getElementById("historyStatActiveCount");
  const statP = document.getElementById("historyStatPastCount");
  if (!activeContainer || !pastContainer) return;

  activeContainer.innerHTML = "";
  pastContainer.innerHTML = "";

  if (!currentUser) {
    activeContainer.innerHTML = `<div class="reminder-card empty"><p>${escapeHtml(t("historyLoginActive"))}</p></div>`;
    pastContainer.innerHTML = `<div class="reminder-card empty"><p>${escapeHtml(t("historyLoginPast"))}</p></div>`;
    if (statA) statA.textContent = "0";
    if (statP) statP.textContent = "0";
    return;
  }

  let reminders = Array.isArray(historyRemindersRaw) ? [...historyRemindersRaw] : [];
  const q = (document.getElementById("historySearchInput")?.value || "").trim().toLowerCase();
  if (q) {
    reminders = reminders.filter((r) => reminderMatchesHistorySearch(r, q));
  }

  const split = splitHistoryActivePast(reminders);
  let activeList = split.active;
  let pastList = split.past;
  if (historySortMode === "due-desc") {
    activeList = activeList.slice().reverse();
    pastList = pastList.slice().reverse();
  }
  activeList = activeList.slice(0, HISTORY_COLUMN_LIMIT);
  pastList = pastList.slice(0, HISTORY_COLUMN_LIMIT);

  if (statA) statA.textContent = String(activeList.length);
  if (statP) statP.textContent = String(pastList.length);

  const showActive = historyFilterMode !== "past";
  const showPast = historyFilterMode !== "active";

  if (showActive) {
    if (!activeList.length) {
      activeContainer.innerHTML = `<div class="reminder-card empty"><p>${escapeHtml(t("historyNoActive"))}</p></div>`;
    } else {
      activeList.forEach((r) => activeContainer.appendChild(buildReminderHistoryCard(r)));
    }
  } else {
    activeContainer.innerHTML = "";
  }

  if (showPast) {
    if (!pastList.length) {
      pastContainer.innerHTML = `<div class="reminder-card empty"><p>${escapeHtml(t("historyNoPast"))}</p></div>`;
    } else {
      pastList.forEach((r) => pastContainer.appendChild(buildReminderHistoryCard(r)));
    }
  } else {
    pastContainer.innerHTML = "";
  }
}

async function renderReminderHistory() {
  const activeContainer = document.getElementById("activeReminders");
  const pastContainer = document.getElementById("pastReminders");
  if (!activeContainer || !pastContainer) return;

  if (!currentUser) {
    historyRemindersRaw = [];
    applyHistoryFilterAndRender();
    return;
  }

  try {
    const data = await apiFetch("/api/reminders");
    historyRemindersRaw = data.reminders || [];
    if (!historyRemindersRaw.length) {
      historyRemindersRaw = [];
    }
    void pruneHistoryReminderLimit();
    applyHistoryFilterAndRender();
  } catch {
    historyRemindersRaw = [];
    activeContainer.innerHTML = `<div class="reminder-card empty"><p>${escapeHtml(t("historyLoadError"))}</p></div>`;
    pastContainer.innerHTML = `<div class="reminder-card empty"><p>${escapeHtml(t("historyLoadError"))}</p></div>`;
    const statA = document.getElementById("historyStatActiveCount");
    const statP = document.getElementById("historyStatPastCount");
    if (statA) statA.textContent = "0";
    if (statP) statP.textContent = "0";
  }
}

function editReminderReminder(reminder) {
  if (!requireAuth("edit reminders")) return;
  const canEdit = reminder && !reminder.sent && reminder.status === "pending";
  if (!canEdit) {
    showToast(t("reminderEditNotAllowed"));
    return;
  }
  openReminderEditModal(reminder);
}

function deleteReminderReminder(reminder) {
  if (!reminder || !reminder._id) return;
  deleteReminderById(String(reminder._id));
}

function getOrCreateDeviceId() {
  const KEY = "notesAiDeviceId";
  try {
    const existing = String(localStorage.getItem(KEY) || "").trim();
    if (existing) return existing;
    const randomPart =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = `dev-${randomPart}`.toLowerCase();
    localStorage.setItem(KEY, created);
    return created;
  } catch {
    return "";
  }
}

function logoutUser() {
  if (webNotificationSchedulerIntervalId != null) {
    clearInterval(webNotificationSchedulerIntervalId);
    webNotificationSchedulerIntervalId = null;
  }
  webNotificationSchedulerStarted = false;
  webChatSessionTurns = [];
  webChatLastReminderUserRaw = null;
  clearCurrentUser();
  displayAccountInfo();
  syncMobileHeaderActionUi();
  updateAccountUI();
  goHome();
  showToast("Logged out successfully.");
}

// ===== SETTINGS FUNCTIONS =====

function getUsernameCooldownMeta() {
  if (!currentUser || currentUser.needsUsername) return { locked: false, availableAt: null };
  const raw = currentUser.usernameLastChangedAt;
  if (!raw) return { locked: false, availableAt: null };
  const lastMs =
    typeof raw === "string" ? Date.parse(raw) : raw instanceof Date ? raw.getTime() : NaN;
  if (!Number.isFinite(lastMs)) return { locked: false, availableAt: null };
  const nextMs = lastMs + 7 * 24 * 60 * 60 * 1000;
  if (Date.now() >= nextMs) return { locked: false, availableAt: null };
  return { locked: true, availableAt: nextMs };
}

function settingsUsernameInputChanged(el) {
  if (!el || el.disabled) return;
  clearSettingsUsernameInlineError();
  const v = String(el.value || "")
    .replace(/\s/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 30);
  el.value = v;
}

function clearSettingsUsernameInlineError() {
  const err = document.getElementById("settingsUsernameInlineError");
  if (err) {
    err.textContent = "";
    err.classList.add("hidden");
  }
  const form = document.getElementById("settingsProfileEditForm");
  syncSettingsUsernameFieldState(form && !form.classList.contains("hidden"));
}

function showSettingsUsernameInlineError(message) {
  const err = document.getElementById("settingsUsernameInlineError");
  if (!err) return;
  err.textContent = message;
  err.classList.remove("hidden");
}

function validateSettingsUsernameInput(raw) {
  const u = String(raw || "").trim().toLowerCase();
  if (u.length < 3) {
    return { ok: false, message: t("settingsUsernameErrTooShort") };
  }
  if (u.length > 30) {
    return { ok: false, message: t("settingsUsernameErrTooLong") };
  }
  if (!/^[a-z0-9_]+$/.test(u)) {
    return { ok: false, message: t("settingsUsernameErrChars") };
  }
  return { ok: true, username: u };
}

function syncSettingsUsernameFieldState(formOpen) {
  const input = document.getElementById("settingsEditUsername");
  const hint = document.getElementById("settingsUsernameCooldownHint");
  if (!input) return;
  if (!formOpen || !currentUser) {
    input.disabled = false;
    if (hint) {
      hint.classList.add("hidden");
      hint.textContent = "";
      delete hint.dataset.sticky;
    }
    return;
  }
  const { locked, availableAt } = getUsernameCooldownMeta();
  const blockEdit = locked && !currentUser.needsUsername;
  input.disabled = blockEdit;
  if (hint) {
    if (blockEdit && availableAt != null) {
      const when = new Date(availableAt).toLocaleString();
      hint.textContent = t("settingsUsernameCooldownHint").replace("{date}", when);
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
      hint.textContent = "";
    }
  }
}

function displayAccountInfo() {
  const fn = document.getElementById("settingsFirstName");
  const ln = document.getElementById("settingsLastName");
  const un = document.getElementById("settingsUsername");
  const em = document.getElementById("settingsEmail");
  const badge = document.getElementById("settingsPlanBadge");
  const upgradeBtn = document.getElementById("settingsPremiumUpgradeBtn");
  const premiumNote = document.getElementById("settingsPremiumActiveNote");
  const premiumLead = document.getElementById("settingsPremiumLead");
  const premiumActiveBadge = document.getElementById("settingsPremiumActiveBadge");
  const billingPlan = document.getElementById("settingsBillingPlan");
  const billingStatus = document.getElementById("settingsBillingStatus");
  const billingCancelAtPeriodEnd = document.getElementById("settingsBillingCancelAtPeriodEnd");
  const billingCurrentPeriodEnd = document.getElementById("settingsBillingCurrentPeriodEnd");
  const cancelBtn = document.getElementById("settingsCancelSubscriptionBtn");
  const cancelHint = document.getElementById("settingsCancelSubscriptionHint");
  const editFirst = document.getElementById("settingsEditFirstName");
  const editLast = document.getElementById("settingsEditLastName");
  if (!fn || !ln || !un || !em) return;

  if (!currentUser) {
    fn.textContent = "-";
    ln.textContent = "-";
    un.textContent = "-";
    em.textContent = "-";
    if (badge) {
      badge.textContent = "—";
      badge.classList.remove("settings-plan-badge--premium", "settings-plan-badge--standard");
    }
    if (upgradeBtn) upgradeBtn.classList.remove("hidden");
    if (premiumNote) premiumNote.classList.add("hidden");
    if (premiumLead) {
      premiumLead.setAttribute("data-t", "settingsPremiumPitch");
      premiumLead.textContent = t("settingsPremiumPitch");
    }
    if (premiumActiveBadge) premiumActiveBadge.classList.add("hidden");
    if (billingPlan) billingPlan.textContent = "free";
    if (billingStatus) billingStatus.textContent = "inactive";
    if (billingCancelAtPeriodEnd) billingCancelAtPeriodEnd.textContent = "No";
    if (billingCurrentPeriodEnd) billingCurrentPeriodEnd.textContent = "—";
    if (cancelBtn) {
      cancelBtn.classList.add("hidden");
      cancelBtn.disabled = true;
    }
    if (cancelHint) {
      cancelHint.classList.add("hidden");
      cancelHint.textContent = "";
    }
    if (editFirst) editFirst.value = "";
    if (editLast) editLast.value = "";
    const adminRowGuest = document.getElementById("settingsAdminRow");
    if (adminRowGuest) adminRowGuest.classList.add("hidden");
    const uBanner = document.getElementById("settingsUsernameBanner");
    const uInput = document.getElementById("settingsEditUsername");
    if (uBanner) uBanner.classList.add("hidden");
    if (uInput) uInput.value = "";
    syncSettingsUsernameFieldState(false);
    updateSettingsSecurityGuestState();
    return;
  }

  fn.textContent = currentUser.firstName || "-";
  ln.textContent = currentUser.lastName || "-";
  un.textContent = currentUser.username || "-";
  {
    const rawMail = String(currentUser.email || currentUser.emailOrPhone || "").trim();
    em.textContent = /@users\.notesai\.invalid$/i.test(rawMail) ? "—" : rawMail || "-";
  }

  const premium =
    typeof userHasPremiumCapabilities === "function" && userHasPremiumCapabilities(currentUser);
  const standardOrPaidPlan =
    typeof userHasStandardTierFeatures === "function" && userHasStandardTierFeatures(currentUser);
  let planLabel = t("premiumPlanFreeName");
  if (premium) planLabel = t("premiumPlanPremiumTierName");
  else if (standardOrPaidPlan) {
    const tier = currentUser.tier || "";
    const sub = currentUser.subscriptionPlan || "";
    planLabel =
      tier === "standard" || sub === "standard" ? t("premiumPlanStandardName") : t("premiumPlanPremiumTierName");
  }
  if (badge) {
    badge.textContent = planLabel;
    badge.classList.toggle("settings-plan-badge--premium", !!premium);
    badge.classList.toggle("settings-plan-badge--standard", !!standardOrPaidPlan && !premium);
  }
  if (upgradeBtn) upgradeBtn.classList.toggle("hidden", !!premium);
  if (premiumNote) premiumNote.classList.toggle("hidden", !premium);
  if (premiumActiveBadge) premiumActiveBadge.classList.toggle("hidden", !premium);
  if (premiumLead) {
    const leadKey = premium ? "settingsPremiumShort" : "settingsPremiumPitch";
    premiumLead.setAttribute("data-t", leadKey);
    premiumLead.textContent = t(leadKey);
  }
  if (editFirst) editFirst.value = currentUser.firstName || "";
  if (editLast) editLast.value = currentUser.lastName || "";

  const uBanner = document.getElementById("settingsUsernameBanner");
  const uInput = document.getElementById("settingsEditUsername");
  if (uInput) uInput.value = String(currentUser.username || "").trim();
  if (uBanner) {
    uBanner.classList.toggle("hidden", !currentUser.needsUsername);
    uBanner.setAttribute("data-t", "settingsUsernameBannerNeed");
  }
  {
    const form = document.getElementById("settingsProfileEditForm");
    syncSettingsUsernameFieldState(form && !form.classList.contains("hidden"));
  }

  const planText = String(currentUser.plan || currentUser.subscriptionPlan || "free").toLowerCase();
  const statusText = String(currentUser.subscriptionStatus || (premium ? "active" : "inactive"));
  const cancelScheduled = Boolean(currentUser.cancelAtPeriodEnd);
  const periodEndText = currentUser.currentPeriodEnd
    ? new Date(currentUser.currentPeriodEnd).toLocaleString()
    : "—";
  if (billingPlan) billingPlan.textContent = planText;
  if (billingStatus) billingStatus.textContent = statusText;
  if (billingCancelAtPeriodEnd) billingCancelAtPeriodEnd.textContent = cancelScheduled ? "Yes" : "No";
  if (billingCurrentPeriodEnd) billingCurrentPeriodEnd.textContent = periodEndText;
  if (cancelBtn) {
    const showCancel = premium && !!currentUser.subscriptionStatus;
    cancelBtn.classList.toggle("hidden", !showCancel);
    cancelBtn.disabled = cancelScheduled || !showCancel;
    if (!cancelBtn.dataset.defaultLabel) {
      cancelBtn.dataset.defaultLabel = cancelBtn.textContent || "Cancel Subscription";
    }
    if (!cancelBtn.dataset.loadingLabel) {
      cancelBtn.dataset.loadingLabel = "Canceling...";
    }
  }
  if (cancelHint) {
    if (cancelScheduled) {
      cancelHint.classList.remove("hidden");
      cancelHint.textContent = "Cancelation scheduled";
    } else {
      cancelHint.classList.add("hidden");
      cancelHint.textContent = "";
    }
  }

  const adminRow = document.getElementById("settingsAdminRow");
  if (adminRow) {
    const isAdmin = (currentUser.role || "user") === "admin";
    adminRow.classList.toggle("hidden", !isAdmin);
  }

  updateSettingsSecurityGuestState();
}

async function cancelSubscriptionFromSettings() {
  if (!requireAuth("manage billing")) return;
  const btn = document.getElementById("settingsCancelSubscriptionBtn");
  if (!btn || btn.disabled) return;
  const defaultLabel = btn.dataset.defaultLabel || btn.textContent || "Cancel Subscription";
  const loadingLabel = btn.dataset.loadingLabel || "Canceling...";
  btn.disabled = true;
  btn.textContent = loadingLabel;
  try {
    const data = await apiFetch("/api/premium/cancel-subscription", { method: "POST" });
    currentUser.cancelAtPeriodEnd = true;
    currentUser.subscriptionStatus = data && data.status ? data.status : currentUser.subscriptionStatus;
    currentUser.currentPeriodEnd =
      data && data.currentPeriodEnd ? data.currentPeriodEnd : currentUser.currentPeriodEnd;
    persistCurrentUserToStorage();
    displayAccountInfo();
    showToast("Your subscription will be canceled at the end of the billing period");
  } catch (err) {
    btn.disabled = false;
    showToast((err && err.message) || "Failed to cancel subscription");
  } finally {
    btn.textContent = defaultLabel;
  }
}

function toggleSettingsProfileEdit(show) {
  const form = document.getElementById("settingsProfileEditForm");
  const btn = document.getElementById("settingsEditProfileBtn");
  if (!form || !btn) return;
  const open = !!show;
  form.classList.toggle("hidden", !open);
  btn.classList.toggle("hidden", open);
  if (open && currentUser) {
    clearSettingsUsernameInlineError();
    const first = document.getElementById("settingsEditFirstName");
    const last = document.getElementById("settingsEditLastName");
    const userInput = document.getElementById("settingsEditUsername");
    if (first) first.value = currentUser.firstName || "";
    if (last) last.value = currentUser.lastName || "";
    if (userInput) userInput.value = String(currentUser.username || "").trim();
    syncSettingsUsernameFieldState(true);
    if (currentUser.needsUsername && userInput && !userInput.disabled) userInput.focus();
    else if (first) first.focus();
  }
  if (!open) syncSettingsUsernameFieldState(false);
}

async function saveSettingsProfileEdit() {
  if (!requireAuth("edit your profile")) return;
  clearSettingsUsernameInlineError();
  const first = document.getElementById("settingsEditFirstName");
  const last = document.getElementById("settingsEditLastName");
  const userEl = document.getElementById("settingsEditUsername");
  if (!first || !last || !userEl) return;
  const firstName = String(first.value || "").trim();
  const lastName = String(last.value || "").trim();
  if (!firstName || !lastName) {
    showToast(t("fillAllFields"));
    return;
  }
  const storedUsername = String((currentUser && currentUser.username) || "")
    .trim()
    .toLowerCase();
  let usernameToSave = storedUsername;
  if (!userEl.disabled) {
    const check = validateSettingsUsernameInput(userEl.value);
    if (!check.ok) {
      showSettingsUsernameInlineError(check.message);
      return;
    }
    usernameToSave = check.username;
  }
  const usernameWillChange = usernameToSave !== storedUsername;

  try {
    if (usernameWillChange) {
      const uData = await apiFetch("/api/user/username", {
        method: "PUT",
        body: JSON.stringify({ username: usernameToSave })
      });
      if (uData && uData.user) Object.assign(currentUser, uData.user);
      else {
        currentUser.username = usernameToSave;
        currentUser.needsUsername = false;
      }
      persistCurrentUserToStorage();
    }

    let data = null;
    let lastErr = null;
    const profilePaths = ["/api/user/profile", "/api/profile"];
    for (const path of profilePaths) {
      try {
        data = await apiFetch(path, {
          method: "PUT",
          body: JSON.stringify({ firstName, lastName })
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!data) throw lastErr || new Error(t("settingsProfileSaveFailed"));
    if (data && data.user) {
      currentUser.firstName = data.user.firstName || firstName;
      currentUser.lastName = data.user.lastName || lastName;
      persistCurrentUserToStorage();
    } else {
      currentUser.firstName = firstName;
      currentUser.lastName = lastName;
      persistCurrentUserToStorage();
    }
    displayAccountInfo();
    updateAccountUI();
    toggleSettingsProfileEdit(false);
    showToast(t("settingsProfileSaved"));
  } catch (err) {
    const st = err && err.status;
    const rawMsg = err && err.message ? String(err.message) : "";
    if (st === 409) {
      showSettingsUsernameInlineError(t("settingsUsernameErrTaken"));
      return;
    }
    if (st === 429) {
      const pay = err.payload || {};
      const iso = pay.usernameChangeAvailableAt;
      const when = iso ? new Date(iso).toLocaleString() : "";
      const msg = when
        ? t("settingsUsernameCooldownHint").replace("{date}", when)
        : rawMsg || t("settingsUsernameErrCooldown");
      showSettingsUsernameInlineError(msg);
      syncSettingsUsernameFieldState(true);
      return;
    }
    if (usernameWillChange && (st === 400 || rawMsg)) {
      showSettingsUsernameInlineError(rawMsg || t("settingsUsernameErrGeneric"));
      return;
    }
    if (/Request failed|Failed to fetch|timed out|Network error/i.test(rawMsg)) {
      showToast(t("settingsProfileSaveServerHint"));
      return;
    }
    showToast(rawMsg || t("settingsProfileSaveFailed"));
  }
}

function userHasLocalPasswordFlag() {
  if (!currentUser) return false;
  if (typeof currentUser.hasLocalPassword === "boolean") {
    return currentUser.hasLocalPassword;
  }
  if (String(currentUser.provider || "local").toLowerCase() === "google") {
    return false;
  }
  return true;
}

function syncSettingsPasswordFieldVisibility() {
  const wrap = document.getElementById("settingsCurrentPasswordWrap");
  if (!wrap) return;
  const show = userHasLocalPasswordFlag();
  wrap.classList.toggle("hidden", !show);
  const cur = document.getElementById("settingsCurrentPassword");
  if (cur && !show) cur.value = "";
}

function updateSettingsSecurityGuestState() {
  const forms = document.getElementById("settingsSecurityForms");
  const hint = document.getElementById("settingsSecurityLoginHint");
  const pwdBlock = document.getElementById("settingsPasswordBlock");
  const authed = !!(currentUser && accessToken);
  if (forms) forms.classList.toggle("hidden", !authed);
  if (hint) hint.classList.toggle("hidden", authed);
  if (pwdBlock) pwdBlock.classList.toggle("hidden", !authed);
  syncSettingsPasswordFieldVisibility();
}

async function updateSettingsNotificationStatus() {
  const el = document.getElementById("settingsNotifPermission");
  const toggle = document.getElementById("settingsNotifToggle");
  const enableBtn = document.getElementById("settingsNotifEnableBtn");
  if (!el) return;
  let perm = "default";
  if (isNativeLocalNotificationsAvailable()) {
    const localNotifications = getLocalNotificationsPlugin();
    if (localNotifications) {
      try {
        const status = await localNotifications.checkPermissions();
        perm = status && status.display ? status.display : "default";
      } catch {
        perm = "default";
      }
    }
  } else if ("Notification" in window) {
    perm = Notification.permission;
  } else {
    perm = "denied";
  }

  if (perm === "granted") {
    el.textContent = t("settingsNotifStatusGranted");
  } else if (perm === "denied") {
    el.textContent = t("settingsNotifStatusDenied");
  } else {
    el.textContent = t("settingsNotifStatusDefault");
  }
  if (toggle) {
    toggle.disabled = false;
    toggle.checked = perm === "granted";
  }
  if (enableBtn) {
    enableBtn.classList.toggle("hidden", perm === "granted");
  }
}

function settingsNotificationsToggleChanged(checked) {
  if (checked) {
    requestNotificationPermission();
  } else {
    showToast(t("settingsNotificationsGrantedHint"));
  }
  void updateSettingsNotificationStatus();
}

async function submitSetPassword(ev) {
  ev.preventDefault();
  if (!requireAuth("set your password")) return;
  const neu = document.getElementById("setPasswordNew");
  const conf = document.getElementById("setPasswordConfirm");
  const errEl = document.getElementById("setPasswordError");
  const submitBtn = document.getElementById("setPasswordSubmit");
  if (!neu || !conf) return;
  if (errEl) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  }
  const p1 = String(neu.value || "");
  const p2 = String(conf.value || "");
  if (!p1 || !p2) {
    if (errEl) {
      errEl.textContent = t("fillAllFields");
      errEl.classList.remove("hidden");
    } else {
      showToast(t("fillAllFields"));
    }
    return;
  }
  if (p1 !== p2) {
    if (errEl) {
      errEl.textContent = t("settingsPasswordMismatch");
      errEl.classList.remove("hidden");
    } else {
      showToast(t("settingsPasswordMismatch"));
    }
    return;
  }
  if (p1.length < 8) {
    if (errEl) {
      errEl.textContent = t("settingsPasswordShort");
      errEl.classList.remove("hidden");
    } else {
      showToast(t("settingsPasswordShort"));
    }
    return;
  }
  if (submitBtn) submitBtn.disabled = true;
  try {
    const data = await apiFetch("/auth/set-password", {
      method: "POST",
      body: JSON.stringify({ password: p1, confirmPassword: p2 })
    });
    if (data && data.user) {
      Object.assign(currentUser, data.user);
    } else if (currentUser) {
      currentUser.hasLocalPassword = true;
    }
    persistCurrentUserToStorage();
    neu.value = "";
    conf.value = "";
    history.replaceState(null, "", "/" + (window.location.search || ""));
    syncAuthShellVisibility();
    goHome();
    displayAccountInfo();
    syncSettingsPasswordFieldVisibility();
    showToast(data && data.message ? data.message : t("settingsPasswordChanged"));
    void mergePremiumFromServer().then(() => {
      displayAccountInfo();
      void updateHomeDashboardStats();
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : t("settingsProfileSaveFailed");
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove("hidden");
    } else {
      showToast(msg);
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function submitSettingsPasswordChange() {
  if (!requireAuth("update your password")) return;
  const cur = document.getElementById("settingsCurrentPassword");
  const neu = document.getElementById("settingsNewPassword");
  const conf = document.getElementById("settingsConfirmPassword");
  if (!cur || !neu || !conf) return;

  const currentPassword = cur.value;
  const newPassword = neu.value;
  const confirm = conf.value;
  const needsCurrent = userHasLocalPasswordFlag();

  if (!newPassword || !confirm) {
    showToast(t("fillAllFields"));
    return;
  }
  if (needsCurrent && !currentPassword) {
    showToast(t("fillAllFields"));
    return;
  }
  if (newPassword !== confirm) {
    showToast(t("settingsPasswordMismatch"));
    return;
  }
  if (newPassword.length < 8) {
    showToast(t("settingsPasswordShort"));
    return;
  }

  const body = needsCurrent ? { currentPassword, newPassword } : { newPassword };

  try {
    await apiFetch("/api/user/password", {
      method: "PUT",
      body: JSON.stringify(body)
    });
    cur.value = "";
    neu.value = "";
    conf.value = "";
    if (currentUser) {
      currentUser.hasLocalPassword = true;
      persistCurrentUserToStorage();
    }
    syncSettingsPasswordFieldVisibility();
    showToast(t("settingsPasswordChanged"));
  } catch (err) {
    const msg = err.message || "";
    if (msg.toLowerCase().includes("incorrect")) {
      showToast(t("settingsPasswordWrong"));
    } else {
      showToast(msg);
    }
  }
}

/** When true, `languageSelect` is being synced programmatically — ignore spurious `change` events. */
let syncingLanguageSelect = false;

function changeLanguage(lang) {
  if (syncingLanguageSelect) return;
  if (typeof translations !== "undefined" && !translations[lang]) {
    console.warn("Unsupported language:", lang);
    return;
  }
  setLanguage(lang);
  // Update all text content
  applyTranslations();
  // Save to backend if user is logged in
  if (currentUser && accessToken) {
    saveUserSettings({ language: lang });
  } else {
    // Just save to localStorage if not logged in
    localStorage.setItem('language', lang);
  }
  // Refresh current page
  if (currentCategory) {
    loadNotes();
  }
  if (!document.getElementById("home")?.classList.contains("hidden")) {
    void loadHomeEmbedRemindersList();
    void updateHomeDashboardStats();
  }
  if (!document.getElementById("settings")?.classList.contains("hidden")) {
    updateSettingsNotificationStatus();
  }
  if (!document.getElementById("reminder-history")?.classList.contains("hidden")) {
    applyHistoryFilterAndRender();
  }
}

function updateLanguageSelector() {
  const select = document.getElementById("languageSelect");
  if (!select) return;
  const lang = typeof getCurrentLanguage === "function" ? getCurrentLanguage() : "en";
  const resolved = typeof translations !== "undefined" && translations[lang] ? lang : "en";
  if (select.value === resolved) return;
  syncingLanguageSelect = true;
  try {
    select.value = resolved;
  } finally {
    syncingLanguageSelect = false;
  }
}

function changeTheme(theme) {
  localStorage.setItem('theme', theme);
  applyTheme(theme);
  // Save to backend if user is logged in
  if (currentUser && accessToken) {
    saveUserSettings({ theme: theme });
  }
  updateThemeSelector();
}

async function saveUserSettings(settings) {
  try {
    await apiFetch("/api/user/settings", {
      method: "PUT",
      body: JSON.stringify(settings)
    });
  } catch (err) {
    console.warn("⚠️ Failed to save settings to server:", err.message);
    // Settings are already saved to localStorage, so the app continues working
  }
}

async function loadUserSettings() {
  if (!currentUser || !accessToken) return;
  
  try {
    const data = await apiFetch("/api/user/settings");
    if (data.settings) {
      // Apply theme from server
      if (data.settings.theme) {
        localStorage.setItem('theme', data.settings.theme);
        applyTheme(data.settings.theme);
        updateThemeSelector();
      }
      // Apply language from server (must match a known bundle or we fall back to English)
      if (data.settings.language) {
        const serverLang = String(data.settings.language).trim();
        const lang =
          typeof translations !== "undefined" && translations[serverLang] ? serverLang : "en";
        localStorage.setItem("language", lang);
        setLanguage(lang);
        updateLanguageSelector();
        applyTranslations();
      }
      if (typeof data.settings.hasSeenTutorial === "boolean") {
        currentUser.hasSeenTutorial = data.settings.hasSeenTutorial;
        persistCurrentUserToStorage();
      }
    }
  } catch (err) {
    console.warn("⚠️ Failed to load settings from server:", err.message);
    // Fall back to localStorage
  }

  await mergePremiumFromServer();
}

function getCurrentTheme() {
  return localStorage.getItem('theme') || 'classic';
}

function applyTheme(theme) {
  // Remove all theme classes
  document.body.classList.remove('theme-classic', 'theme-normal', 'theme-advanced');
  // Add current theme class
  document.body.classList.add(`theme-${theme}`);
}

function updateThemeSelector() {
  const currentTheme = getCurrentTheme();
  document.querySelectorAll('.theme-button').forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('data-theme') === currentTheme) {
      btn.classList.add('active');
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  captureInviteCodeFromLocation();
  if (window.NoteRichEditor && typeof window.NoteRichEditor.initNoteRichEditorBridge === "function") {
    window.NoteRichEditor.initNoteRichEditorBridge();
  }
  initAuthLandingUi();
  await consumeGoogleOAuthFromHash();
  void ensureNativeNotificationChannel();
  // Initialize theme and language
  applyTheme(getCurrentTheme());
  applyTranslations();

  updateAccountUI();

  // If user is already logged in, load their settings from server
  if (currentUser && accessToken) {
    void mergePremiumFromServer();
    loadUserSettings();
    // Start web notification scheduler for logged-in users
    startWebNotificationScheduler();
    // Request notification permission
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  if (currentUser && accessToken) {
    const blockGoHome = isSetPasswordPath() && !userHasLocalPasswordFlag();
    if (!blockGoHome) {
      goHome();
    } else {
      syncAuthShellVisibility();
    }
    if (typeof scheduleOnboardingTutorialAfterAuth === "function") scheduleOnboardingTutorialAfterAuth();
  }
  initDepthRevealSystem();
  initPremiumTiltSystem();
  cleanupDailyPlannerStorage();
  scheduleDailyPlannerMidnightReset();
  scheduleDailyPlannerNotificationLoop();
  renderDailyPlannerList();
  premiumSelectPaymentMethod("card");
  premiumLiteInitPricingUi();
  consumeCheckoutQueryToast();
  consumeBillingRoute();
  void consumeEmailVerificationQuery();
  void loadDiscordCommunityConfig();
  webChatSetUnread(0);
  const fabTip = document.getElementById("webChatFabTip");
  if (fabTip) fabTip.classList.add("hidden");
  window.setTimeout(() => showWebChatFabTip(), 2200);
  scheduleWebChatFabPromptCycle();

  const dailyPlannerInput = document.getElementById("dailyPlannerTaskInput");
  if (dailyPlannerInput) {
    dailyPlannerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        dailyPlannerAddTask();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const setPasswordEl = document.getElementById("setPasswordScreen");
    if (setPasswordEl && !setPasswordEl.classList.contains("hidden")) {
      e.preventDefault();
      return;
    }
    const authLandingEl = document.getElementById("authLanding");
    if (authLandingEl && !authLandingEl.classList.contains("hidden")) {
      e.preventDefault();
      closeAccountModal();
      return;
    }
    if (webChatQuickPanelOpen()) {
      e.preventDefault();
      closeWebChatQuickActions();
      return;
    }
    const webChatDrawer = document.getElementById("webChat");
    if (webChatDrawer && !webChatDrawer.classList.contains("hidden")) {
      e.preventDefault();
      closeWebChatDrawer();
      return;
    }
    if (document.body.classList.contains("mobile-nav-open")) {
      e.preventDefault();
      closeMobileNav();
      return;
    }
    const noteViewModal = document.getElementById("noteViewModal");
    if (noteViewModal && !noteViewModal.classList.contains("hidden")) {
      e.preventDefault();
      closeNoteViewModal();
      return;
    }
    const reminderModal = document.getElementById("reminderEditModal");
    if (reminderModal && !reminderModal.classList.contains("hidden")) {
      e.preventDefault();
      closeReminderEditModal();
      return;
    }
    const dailyPlannerModal = document.getElementById("dailyPlannerModal");
    if (dailyPlannerModal && !dailyPlannerModal.classList.contains("hidden")) {
      e.preventDefault();
      closeDailyPlannerModal();
      return;
    }
    const noteModal = document.getElementById("noteEditorModal");
    if (noteModal && !noteModal.classList.contains("hidden")) {
      e.preventDefault();
      closeNoteEditor();
    }
  });

  document.addEventListener("click", (e) => {
    const panel = document.getElementById("webChatQuickPanel");
    const fab = document.getElementById("webChatFab");
    if (!panel || panel.classList.contains("hidden")) return;
    if (panel.contains(e.target) || (fab && fab.contains(e.target))) return;
    closeWebChatQuickActions();
  });

  window.addEventListener("resize", () => {
    if (!isMobileViewport()) closeMobileNav();
    syncMobileHeaderActionUi();
    initPremiumTiltSystem();
  });

  const syncMobileScrollState = () => {
    const canvas = document.querySelector(".background-canvas");
    if (canvas) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        canvas.style.setProperty("--depth-parallax-y", "0px");
      } else {
        const y = Math.min(window.scrollY * 0.065, 96);
        canvas.style.setProperty("--depth-parallax-y", `${y}px`);
      }
    }
    if (!isMobileViewport()) {
      document.body.classList.remove("mobile-scrolled");
      document.body.classList.toggle("floating-scrolled", window.scrollY > 8);
      return;
    }
    document.body.classList.toggle("mobile-scrolled", window.scrollY > 8);
    document.body.classList.toggle("floating-scrolled", window.scrollY > 8);
  };
  window.addEventListener("scroll", syncMobileScrollState, { passive: true });
  syncMobileScrollState();

  const chooseBtn = document.getElementById("chooseUsernameContinue");
  const chooseInput = document.getElementById("chooseUsernameInput");
  if (chooseBtn) chooseBtn.addEventListener("click", () => void submitChooseUsername());
  if (chooseInput) {
    chooseInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submitChooseUsername();
      }
    });
  }
  document.addEventListener("click", (e) => {
    const pop = document.getElementById("mobileLogoutConfirm");
    const btn = document.getElementById("mobileHeaderActionBtn");
    if (!pop || pop.classList.contains("hidden")) return;
    const t = e.target;
    if ((btn && btn.contains(t)) || pop.contains(t)) return;
    closeMobileLogoutConfirm();
  });

  const webChatInput = document.getElementById("webChatInput");
  if (webChatInput) {
    webChatInput.addEventListener("input", () => webChatAutoResizeInput(webChatInput));
    webChatAutoResizeInput(webChatInput);
  }

  syncMobileHeaderActionUi();
});

// Socket event listeners (debounced: multi-tab bursts coalesce into one refetch)
let socketNotesResyncTimer = null;

function scheduleSocketNotesResync() {
  clearTimeout(socketNotesResyncTimer);
  socketNotesResyncTimer = setTimeout(() => {
    socketNotesResyncTimer = null;
    if (currentCategory) void loadNotes();
    if (!document.getElementById("notes-all")?.classList.contains("hidden")) {
      void loadMyNotes();
    }
  }, 120);
}

socket.on("noteCreated", () => {
  scheduleSocketNotesResync();
});

socket.on("noteUpdated", () => {
  scheduleSocketNotesResync();
});

socket.on("noteDeleted", () => {
  scheduleSocketNotesResync();
});

// Register service worker for PWA
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .catch((error) => {
      console.log("Service Worker registration failed:", error);
    });
}

