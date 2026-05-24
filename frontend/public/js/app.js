let currentCategory = "";
let currentNotes = [];
let allNotes = [];
/** @type {object[]} */
let historyRemindersRaw = [];
let historyFilterMode = "all";
let historySortMode = "due-asc";
let historySearchTimer = null;
let notesFilterTimer = null;
const NOTE_PREVIEW_CACHE_MAX = 240;
const notePreviewHtmlCache = new Map();
const noteSearchHaystackCache = new Map();
let lastCategoryNotesRenderKey = "";
let lastAllNotesRenderKey = "";
const HISTORY_COLUMN_LIMIT = 5;
const LIST_RENDER_BATCH = 20;
const LIST_RENDER_BATCH_SCAN_CAM = 4;
const LIST_VIRTUALIZE_THRESHOLD = 32;
const LIST_VIRTUALIZE_THRESHOLD_SCAN_CAM = 1;
const SCAN_CAM_LIST_PREVIEW_MAX = 220;
const SCAN_CAM_LIST_STRIP_HEAD = 2400;
let listScrollBlockedUntil = 0;
let listScrollIdleTimer = 0;
const WEB_CHAT_DOM_MAX_ROWS = 44;
let historyPruneInFlight = false;
let allNotesSortMode = "newest";
let currentUser = getStoredUser();
let accessToken = getStoredAccessToken();
let refreshToken = getStoredRefreshToken();

/** After 401/refresh-fail; blocks noisy private calls until next successful login (see isAuthSessionReady). */
let authInvalidated = false;
/** Single in-flight refresh so parallel 401s do not spam /api/refresh. */
let refreshAccessTokenPromise = null;

/** True on localhost for quieter auth logging. */
function isAuthDevHost() {
  try {
    const h = String(location.hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1";
  } catch {
    return false;
  }
}

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
/** Lazy-loaded Scan Cam CDN bundles (startup / scroll no longer parses multi‑MB OCR stacks). */
let scanCamVendorScriptsPromise = null;
let scanCamTesseractVendorPromise = null;
const SCAN_CAM_VENDOR_PDF =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
const SCAN_CAM_VENDOR_TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

const NOTE_RICH_EDITOR_BUNDLE_SRC = "/js/note-rich-editor.bundle.js?v=apk-emb-260523-v1";
let noteRichEditorBundlePromise = null;

function appendNotesAiAppBundle(src, slug) {
  return new Promise((resolve, reject) => {
    if (slug === "note-rich-editor" && window.NoteRichEditor) {
      resolve();
      return;
    }
    const sel = `script[data-notes-ai-bundle="${slug}"]`;
    const existing = document.querySelector(sel);
    if (existing) {
      if (existing.dataset.loaded === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`bundle_${slug}`)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.notesAiBundle = slug;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`bundle_${slug}`));
    document.head.appendChild(s);
  });
}

/** Lazy-load TipTap editor bundle (multi‑MB); safe to call repeatedly. */
function ensureNoteRichEditorLoaded() {
  if (window.NoteRichEditor && typeof window.NoteRichEditor.initNoteRichEditorBridge === "function") {
    return Promise.resolve();
  }
  if (!noteRichEditorBundlePromise) {
    noteRichEditorBundlePromise = appendNotesAiAppBundle(NOTE_RICH_EDITOR_BUNDLE_SRC, "note-rich-editor")
      .then(() => {
        if (window.NoteRichEditor && typeof window.NoteRichEditor.initNoteRichEditorBridge === "function") {
          window.NoteRichEditor.initNoteRichEditorBridge();
        }
      })
      .catch((err) => {
        noteRichEditorBundlePromise = null;
        throw err;
      });
  }
  return noteRichEditorBundlePromise;
}

function scheduleNoteRichEditorPreload() {
  /* Editor loads on first open only — avoids parsing multi‑MB bundle at idle. */
}

const LAZY_APP_SCRIPTS = {
  noteExport: "/js/features/note-export.js?v=export-notif-v1",
  onboarding: "/js/onboarding-tutorial.js?v=perf-260523-v1",
  webChatIntents: "/js/features/web-chat-intents.js?v=webchat-plan-v1",
  webChatReminderParse: "/js/features/web-chat-reminder-parse.js?v=webchat-plan-v1",
  socketClient: "/js/services/socket-client.js?v=lazy-sock-v1"
};

let socketClientScriptPromise = null;

function ensureSocketClientScript() {
  if (typeof window.__notesAiEnsureSocket === "function") return Promise.resolve();
  if (!socketClientScriptPromise) {
    socketClientScriptPromise = appendNotesAiAppBundle(LAZY_APP_SCRIPTS.socketClient, "socket-client").catch(
      (err) => {
        socketClientScriptPromise = null;
        throw err;
      }
    );
  }
  return socketClientScriptPromise;
}

function ensureNoteExportLoaded() {
  return appendNotesAiAppBundle(LAZY_APP_SCRIPTS.noteExport, "note-export");
}

/** Scan Cam PDF export uses jsPDF from the lazy note-export bundle. */
function scanCamEnsureJsPdfReady() {
  return ensureNoteExportLoaded().then(() => {
    if (typeof window.ensureJsPdfVendorLoaded === "function") {
      return window.ensureJsPdfVendorLoaded();
    }
    return Promise.reject(new Error("export_bundle_missing"));
  });
}

function ensureOnboardingTutorialLoaded() {
  return appendNotesAiAppBundle(LAZY_APP_SCRIPTS.onboarding, "onboarding");
}

function ensureWebChatModulesLoaded() {
  return appendNotesAiAppBundle(LAZY_APP_SCRIPTS.webChatIntents, "web-chat-intents").then(() =>
    appendNotesAiAppBundle(LAZY_APP_SCRIPTS.webChatReminderParse, "web-chat-reminder-parse")
  );
}

function runNoteExportActionLazy(kind) {
  void ensureNoteExportLoaded().then(() => {
    if (typeof window.runNoteExportAction === "function" && window.runNoteExportAction !== runNoteExportActionLazy) {
      window.runNoteExportAction(kind);
    }
  });
}

function openNoteExportModalLazy(note) {
  return ensureNoteExportLoaded().then(() => {
    if (typeof window.openNoteExportModal === "function" && window.openNoteExportModal !== openNoteExportModalLazy) {
      return window.openNoteExportModal(note);
    }
    return undefined;
  });
}

function scheduleOnboardingTutorialAfterAuthLazy() {
  void ensureOnboardingTutorialLoaded().then(() => {
    if (
      typeof window.scheduleOnboardingTutorialAfterAuth === "function" &&
      window.scheduleOnboardingTutorialAfterAuth !== scheduleOnboardingTutorialAfterAuthLazy
    ) {
      window.scheduleOnboardingTutorialAfterAuth();
    }
  });
}

window.runNoteExportAction = runNoteExportActionLazy;
window.openNoteExportModal = openNoteExportModalLazy;
window.scheduleOnboardingTutorialAfterAuth = scheduleOnboardingTutorialAfterAuthLazy;

/** Plain preview when the rich editor bundle is not loaded yet. */
/** Avoid scanning multi‑MB scan_cam payloads when building list previews. */
function scanCamStripHeavyRaw(raw) {
  let s = String(raw || "");
  if (!s) return "";
  if (s.length > SCAN_CAM_LIST_STRIP_HEAD) {
    s = `${s.slice(0, SCAN_CAM_LIST_STRIP_HEAD)}${s.slice(-400)}`;
  }
  return s.replace(/data:[^\s"'\\]+;base64,[A-Za-z0-9+/=\s]+/gi, " ").replace(/\s+/g, " ").trim();
}

function noteStoredPlainPreview(raw, maxLen) {
  const limit = Math.max(1, Number(maxLen) || 50000);
  if (window.NoteRichEditor && typeof window.NoteRichEditor.storedToPreviewText === "function") {
    return window.NoteRichEditor.storedToPreviewText(raw, limit);
  }
  let s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("{")) {
    try {
      const parts = [];
      const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let m;
      while ((m = re.exec(s)) !== null && parts.join(" ").length < limit) {
        parts.push(
          m[1]
            .replace(/\\n/g, " ")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\")
        );
      }
      if (parts.length) return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit);
    } catch {
      /* ignore */
    }
  }
  if (s.includes("<")) s = s.replace(/<[^>]+>/g, " ");
  return s.replace(/\s+/g, " ").trim().slice(0, limit);
}

function appendNotesAiVendorScript(src, slug, globalReady) {
  return new Promise((resolve, reject) => {
    if (globalReady()) {
      resolve();
      return;
    }
    const sel = `script[data-notes-ai-vendor="${slug}"]`;
    const existing = document.querySelector(sel);
    if (existing) {
      if (globalReady()) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`vendor_${slug}`)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.notesAiVendor = slug;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`vendor_${slug}`));
    document.head.appendChild(s);
  });
}

function scanCamEnsureTesseractVendorOnly() {
  if (typeof Tesseract !== "undefined") return Promise.resolve();
  if (scanCamTesseractVendorPromise) return scanCamTesseractVendorPromise;
  scanCamTesseractVendorPromise = appendNotesAiVendorScript(
    SCAN_CAM_VENDOR_TESSERACT,
    "tesseract",
    () => typeof Tesseract !== "undefined"
  )
    .then(() => {
      if (typeof Tesseract === "undefined") throw new Error("vendor_missing_tesseract");
    })
    .catch((e) => {
      scanCamTesseractVendorPromise = null;
      throw e;
    });
  return scanCamTesseractVendorPromise;
}

function scanCamEnsureVendorScriptsLoaded() {
  if (typeof pdfjsLib !== "undefined" && typeof Tesseract !== "undefined") {
    return Promise.resolve();
  }
  if (scanCamVendorScriptsPromise) return scanCamVendorScriptsPromise;
  scanCamVendorScriptsPromise = Promise.all([
    appendNotesAiVendorScript(SCAN_CAM_VENDOR_PDF, "pdfjs", () => typeof pdfjsLib !== "undefined"),
    typeof Tesseract !== "undefined"
      ? Promise.resolve()
      : appendNotesAiVendorScript(
          SCAN_CAM_VENDOR_TESSERACT,
          "tesseract",
          () => typeof Tesseract !== "undefined"
        )
  ])
    .then(() => {
      if (typeof pdfjsLib === "undefined" || typeof Tesseract === "undefined") {
        throw new Error("vendor_missing_globals");
      }
    })
    .catch((e) => {
      scanCamVendorScriptsPromise = null;
      throw e;
    });
  return scanCamVendorScriptsPromise;
}

/** Quiet logs outside dev / explicit verbose flag — cuts WebView console overhead. */
function notesAiVerboseLogs() {
  try {
    if (typeof window !== "undefined" && window.__NOTES_AI_VERBOSE_LOGS__ === true) return true;
    return isAuthDevHost();
  } catch {
    return false;
  }
}

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
/** Max prior turns kept for Web Chat session memory. */
const WEB_CHAT_SESSION_MAX = 16;
/** Last user line that looked like a natural reminder (for follow-ups like “ndërro në 14:00”). */
let webChatLastReminderUserRaw = null;
/**
 * Multi-turn local reminder slot filling (chatbot mode). Reset on success, cancel, or new reminder command.
 * @type {{
 *   active: boolean;
 *   text: string;
 *   date: string | null;
 *   time: string | null;
 *   originalMessage: string;
 *   missing: string[];
 *   createdAt: number;
 *   draftLine: string;
 * }}
 */
let webChatPendingReminder = {
  active: false,
  text: "",
  date: null,
  time: null,
  originalMessage: "",
  missing: [],
  createdAt: 0,
  draftLine: ""
};

function resetWebChatPendingReminder() {
  webChatPendingReminder.active = false;
  webChatPendingReminder.text = "";
  webChatPendingReminder.date = null;
  webChatPendingReminder.time = null;
  webChatPendingReminder.originalMessage = "";
  webChatPendingReminder.missing = [];
  webChatPendingReminder.createdAt = 0;
  webChatPendingReminder.draftLine = "";
}

/** @type {{ role: "user" | "bot"; text: string }[]} */
let webChatSessionTurns = [];

const WEB_CHAT_BOT_AVATAR_SVG = `<svg class="web-chat-avatar__svg" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#0f172a" stroke="#38bdf8" stroke-width="1.2"/><circle cx="15" cy="18" r="1.8" fill="#e2e8f0"/><circle cx="25" cy="18" r="1.8" fill="#e2e8f0"/><path d="M14 24c2.2 2.8 9.8 2.8 12 0" stroke="#64748b" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>`;

/** IntersectionObserver for light scroll-in (transform + opacity only). */
let depthRevealObserver = null;
let premiumTiltEnabled = false;
let dailyPlannerMidnightTimer = null;
let dailyPlannerNotifyTimer = null;
let dailyPlannerNotifyLoopRegistered = false;
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
let supportContactEmail = "";
/** Set from GET /api/public/app-config (GOOGLE_CLIENT_ID). Used by Sign in with Google. */
let googleOAuthClientId = "";
/** True after `/api/public/app-config` finishes (success or failure). Avoids blocking OAuth before config loads. */
let googleOAuthConfigLoaded = false;
/** Coalesces overlapping /api/public/app-config fetches (e.g. DOMContentLoaded + goHome). */
let loadDiscordCommunityConfigInflight = null;
/** Successful app-config responses; avoids refetch on every navigation (Home spam). */
let appPublicConfigCacheExpiresAt = 0;
const APP_PUBLIC_CONFIG_CACHE_TTL_MS = 30 * 60 * 1000;
const APP_PUBLIC_CONFIG_RETRY_MS = 15000;

/** Dedupes overlapping web push subscribe attempts (permissions UI + reminders + settings). */
let registerWebPushInFlight = null;

/** Single offline flush interval (avoid duplicate timers if bootstrap is ever duplicated). */
let offlineNotesFlushIntervalId = null;
/** Coalesces overlapping GET /api/premium/status during login / navigation bursts. */
let mergePremiumFromServerInflight = null;
/** In-flight guards for category / all-notes fetches. */
let loadNotesInflight = null;
let loadNotesInflightCategory = "";
let loadMyNotesInflight = null;
function getRenderBackendOrigin() {
  try {
    if (typeof window !== "undefined" && window.API_BASE_URL) {
      return String(window.API_BASE_URL).replace(/\/+$/, "");
    }
  } catch {
    /* ignore */
  }
  return "https://notes-ai-app.onrender.com";
}
const REMINDER_NOTIFY_PREFS_KEY = "webReminderNotificationPrefs";
/** "0" = user turned off in-app reminder alerts (browser permission may still be "granted"). */
const WEB_REMINDER_NOTIFICATIONS_APP_ENABLED_KEY = "aiNotesWebReminderNotificationsAppEnabled";
/** Fresh channel id keeps importance/visibility/sound sane; reschedule happens on sync. */
const ANDROID_NOTES_AI_CHANNEL_ID = "notes-ai-main-v4";
const ANDROID_EXPORT_DOWNLOAD_CHANNEL_ID = "notes-ai-downloads-v1";
const EXPORT_NOTIF_EXTRA_TYPE = "notes_ai_export_file";
const NOTES_AI_LOCAL_NOTIF_ACTIONS_ID = "notes_ai_open_dismiss_v1";
const NOTES_AI_LOCAL_ACTION_OPEN = "open_notes_ai";
const NOTES_AI_LOCAL_ACTION_DISMISS = "dismiss_notes_ai";
/** Group key — stacked like modern productivity shells (Discord / Tasks feel). */
const NOTES_AI_ANDROID_NOTIFICATION_GROUP = "notes_ai_hub";
/** Status bar tint (matches app cyan accent). */
const NOTES_AI_ANDROID_ICON_COLOR = "#22D3EE";

let notesAiNativeNotificationShellReady = false;

/** Set when user clicks “Continue with Google” — handoff cookies are httpOnly, so we only POST handoff after this signal (or ?oauth_handoff=1). */
const OAUTH_GOOGLE_RETURN_PENDING_KEY = "oauth_google_return_pending";
/** After one handoff attempt (success or terminal failure); cleared on next Google click. */
const OAUTH_HANDOFF_SESSION_DONE_KEY = "oauth_handoff_session_done";
let oauthHandoffInFlight = false;
/** Handoff path finished for this bootstrap invocation. */
let oauthHandoffConsumed = false;

function capacitorPlatform() {
  try {
    if (window.Capacitor && typeof window.Capacitor.getPlatform === "function") {
      return window.Capacitor.getPlatform();
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** Icon URL for Notification API so mobile web / PWA get a banner style closer to native apps */
function notificationIconUrlHint() {
  try {
    return `${window.location.origin.replace(/\/+$/, "")}/icons/icon-192.png`;
  } catch {
    return "";
  }
}

function webReminderNotificationOpts(body, tag, dataExtra) {
  const iconSrc = notificationIconUrlHint();
  const extra = dataExtra && typeof dataExtra === "object" ? dataExtra : {};
  const rid = extra.reminderId != null ? String(extra.reminderId) : undefined;
  const openUrl = typeof extra.url === "string" && extra.url ? extra.url : buildAppHomeHashUrl();
  /** @type {NotificationOptions & { vibrate?: number[] }} */
  const o = {
    body: String(body || "").slice(0, 260),
    tag: String(tag || "reminder"),
    renotify: true,
    silent: false,
    ...(iconSrc ? { icon: iconSrc, badge: iconSrc } : {}),
    vibrate: [260, 100, 280],
    data: {
      ...(rid ? { reminderId: rid } : {}),
      url: openUrl
    }
  };
  return o;
}

function buildAppHomeHashUrl() {
  try {
    const u = new URL(window.location.href);
    u.hash = "#home";
    return u.href;
  } catch {
    try {
      return `${window.location.origin}/#home`;
    } catch {
      return "/#home";
    }
  }
}

/**
 * Prefer service worker `showNotification` so taps and background behavior match PWA expectations.
 */
async function showReminderSystemNotification(title, options) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    throw new Error("notifications unavailable");
  }
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, options);
        return;
      }
    }
  } catch (e) {
    if (notesAiVerboseLogs() && typeof console !== "undefined" && console.warn) {
      console.warn("[reminder] service worker showNotification failed", e);
    }
  }
  const n = new Notification(title, options);
  n.onclick = () => {
    try {
      window.focus();
    } catch {
      /* ignore */
    }
    n.close();
  };
}

async function maybePromptReminderNotificationPermission() {
  if (isNativeLocalNotificationsAvailable()) return true;
  if (!("Notification" in window)) {
    showToast(t("notificationsNotSupported"));
    return false;
  }
  if (Notification.permission === "granted") {
    void registerWebPushSubscription();
    return true;
  }
  if (Notification.permission === "denied") {
    showToast(t("reminderNotifyEnableInBrowser"));
    return false;
  }
  try {
    const p = await Notification.requestPermission();
    if (p === "denied") showToast(t("reminderNotifyEnableInBrowser"));
    else if (p === "granted") {
      showToast(t("notificationsEnabledToast"));
      void registerWebPushSubscription();
    }
    return p === "granted";
  } catch {
    return false;
  }
}

let serviceWorkerNotificationRoutingInitialized = false;

function initServiceWorkerNotificationRouting() {
  if (serviceWorkerNotificationRoutingInitialized) return;
  try {
    if (typeof isNativeApp === "function" && isNativeApp()) return;
  } catch {
    /* ignore */
  }
  if (!("serviceWorker" in navigator)) return;
  serviceWorkerNotificationRoutingInitialized = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const d = event && event.data;
    if (!d || d.type !== "NOTIFICATION_CLICK") return;
    goHome();
    try {
      const u = new URL(window.location.href);
      u.hash = "#home";
      history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => {
      const el = document.getElementById("homeRemindersEmbed");
      if (el) {
        try {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {
          /* ignore */
        }
      }
    });
  });
}

function urlBase64ToUint8Array(base64String) {
  const s = String(base64String || "").trim();
  const padding = "=".repeat((4 - (s.length % 4)) % 4);
  const base64 = (s + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function registerWebPushSubscription() {
  if (isNativeLocalNotificationsAvailable()) return false;
  if (authInvalidated || !isAuthSessionReady()) return false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  if (!currentUser || !accessToken) return false;
  if (!webReminderNotificationsAppEnabled()) return false;
  if (registerWebPushInFlight) return registerWebPushInFlight;
  registerWebPushInFlight = (async () => {
    try {
      const data = await apiFetch("/api/push/public-key");
      const pubB64 = data && data.publicKey;
      if (!pubB64) return false;

      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.pushManager) return false;
      const applicationServerKey = urlBase64ToUint8Array(pubB64);
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });
      }
      await apiFetch("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
      void updateSettingsNotificationStatus();
      return true;
    } catch (err) {
      if (notesAiVerboseLogs() && typeof console !== "undefined" && console.warn) {
        console.warn("[web-push] register failed", err && err.message ? err.message : err);
      }
      void updateSettingsNotificationStatus();
      return false;
    } finally {
      registerWebPushInFlight = null;
    }
  })();
  return registerWebPushInFlight;
}

async function unregisterWebPushSubscriptionFromServerAndBrowser() {
  if (isNativeLocalNotificationsAvailable()) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.pushManager) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const json = sub.toJSON();
    if (currentUser && accessToken && json && json.endpoint) {
      await apiFetch("/api/push/unsubscribe", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: json.endpoint })
      }).catch(() => {});
    }
    await sub.unsubscribe().catch(() => {});
  } catch {
    /* ignore */
  }
  void updateSettingsNotificationStatus();
}

function webReminderNotificationsAppEnabled() {
  try {
    return localStorage.getItem(WEB_REMINDER_NOTIFICATIONS_APP_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

function setWebReminderNotificationsAppEnabled(on) {
  try {
    if (on) localStorage.removeItem(WEB_REMINDER_NOTIFICATIONS_APP_ENABLED_KEY);
    else localStorage.setItem(WEB_REMINDER_NOTIFICATIONS_APP_ENABLED_KEY, "0");
  } catch {
    /* ignore */
  }
}

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

function backendAbsoluteUrl(path) {
  const base = getRenderBackendOrigin();
  const p = String(path || "").trim();
  if (!p) return base;
  return `${base}${p.startsWith("/") ? p : `/${p}`}`;
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

function sanitizeNotificationPlainText(raw) {
  let s = String(raw ?? "").replace(/\u00a0/g, " ");
  try {
    s = s.replace(/\p{Extended_Pictographic}/gu, " ");
  } catch {
    /* Engines without Unicode property escapes — skip strip */
  }
  return s.replace(/\s+/g, " ").trim();
}

/** ~2 rrjeshta në shumicën e pajisjeve; pa emoji dekorative në përmbajtje. */
function truncateNativeNotificationPreview(text, maxChars = 170) {
  const s = sanitizeNotificationPlainText(text);
  if (!s) return "";
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars - 1).trimEnd();
  const softBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("·"), cut.lastIndexOf(","));
  const base = softBreak > Math.floor(maxChars * 0.45) ? cut.slice(0, softBreak).trimEnd() : cut;
  return `${base}…`;
}

function formatPlannerNativeNotificationCaption(task) {
  const txt = sanitizeNotificationPlainText(String((task && task.text) || ""));
  const time = String((task && task.time) || "").trim();
  if (time && txt) return `${time} · ${txt}`;
  if (txt) return txt;
  if (time) return `${time}`;
  return "Daily planner";
}

function exportDownloadMimeType(kind) {
  if (kind === "pdf") return "application/pdf";
  if (kind === "jpg") return "image/jpeg";
  return "text/plain";
}

function nextExportDownloadNotificationId(filename) {
  return hashNotificationId(`export-dl:${String(filename || "")}:${Date.now()}`, 610000);
}

function getFileOpenerPlugin() {
  try {
    const c = window.Capacitor;
    if (!c) return null;
    if (c.Plugins && c.Plugins.FileOpener) return c.Plugins.FileOpener;
    if (typeof c.registerPlugin === "function") return c.registerPlugin("FileOpener");
  } catch {
    /* ignore */
  }
  return null;
}

async function openNativeExportFile(extra) {
  const meta = extra && typeof extra === "object" ? extra : {};
  const directory = meta.directory != null ? String(meta.directory) : "";
  const path = meta.path != null ? String(meta.path) : "";
  const mimeType =
    meta.mimeType != null ? String(meta.mimeType) : exportDownloadMimeType(String(meta.kind || ""));
  if (!directory || !path) return;

  const Fs =
    window.Capacitor &&
    window.Capacitor.Plugins &&
    window.Capacitor.Plugins.Filesystem
      ? window.Capacitor.Plugins.Filesystem
      : null;
  const opener = getFileOpenerPlugin();
  if (!Fs || typeof Fs.getUri !== "function" || !opener || typeof opener.open !== "function") {
    if (typeof showToast === "function") {
      showToast(
        typeof t === "function" ? t("noteExportOpenFailed") : "Could not open the file on this device."
      );
    }
    return;
  }

  try {
    const uriResult = await Fs.getUri({ directory, path });
    const filePath = uriResult && uriResult.uri ? String(uriResult.uri) : "";
    if (!filePath) throw new Error("missing uri");
    await opener.open({ filePath, contentType: mimeType, openWithDefault: true });
  } catch {
    if (typeof showToast === "function") {
      showToast(
        typeof t === "function" ? t("noteExportOpenFailed") : "Could not open the file on this device."
      );
    }
  }
}

async function ensureExportDownloadChannel() {
  if (!isNativeLocalNotificationsAvailable()) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications || typeof localNotifications.createChannel !== "function") return;
  try {
    await localNotifications.createChannel({
      id: ANDROID_EXPORT_DOWNLOAD_CHANNEL_ID,
      name: typeof t === "function" ? t("noteExportNotifChannelName") : "Downloads",
      description:
        typeof t === "function"
          ? t("noteExportNotifChannelDesc")
          : "File download progress and completed exports.",
      importance: 4,
      visibility: 1,
      vibration: false,
      lights: false
    });
  } catch {
    /* ignore */
  }
}

async function notesAiShowExportDownloadStarting(filename, kind) {
  if (!isNativeLocalNotificationsAvailable()) return null;
  await ensureExportDownloadChannel();
  const allowed = await requestNotificationPermissionIfNeeded(false);
  if (!allowed) return null;

  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications || typeof localNotifications.schedule !== "function") return null;

  const notifId = nextExportDownloadNotificationId(filename);
  const safeName = String(filename || "download");
  const title =
    typeof t === "function" ? t("noteExportNotifDownloading") : "Downloading…";
  const body =
    kind === "pdf"
      ? typeof t === "function"
        ? t("noteExportNotifPdfBody")
        : "Saving PDF…"
      : kind === "jpg"
        ? typeof t === "function"
          ? t("noteExportNotifJpgBody")
          : "Saving image…"
        : typeof t === "function"
          ? t("noteExportNotifTxtBody")
          : "Saving text…";

  try {
    await localNotifications.schedule({
      notifications: [
        {
          id: notifId,
          title,
          body: `${body} · ${safeName}`,
          channelId: ANDROID_EXPORT_DOWNLOAD_CHANNEL_ID,
          ongoing: true,
          autoCancel: false,
          ...(capacitorPlatform() === "android"
            ? {
                smallIcon: "ic_stat_notes_ai",
                iconColor: NOTES_AI_ANDROID_ICON_COLOR
              }
            : {})
        }
      ]
    });
    return notifId;
  } catch {
    return null;
  }
}

async function notesAiShowExportDownloadComplete(notifId, filename, kind, writeResult) {
  if (!isNativeLocalNotificationsAvailable() || notifId == null) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications || typeof localNotifications.schedule !== "function") return;

  const safeName = String(filename || "download");
  const title = typeof t === "function" ? t("noteExportNotifComplete") : "Download complete";
  const body = typeof t === "function" ? t("noteExportNotifTapToOpen") : "Tap to open";
  const directory =
    writeResult && writeResult.directory != null ? String(writeResult.directory) : "DOCUMENTS";
  const path =
    writeResult && writeResult.path != null
      ? String(writeResult.path)
      : `Notes-AI/${safeName}`;

  try {
    await localNotifications.schedule({
      notifications: [
        {
          id: Number(notifId),
          title,
          body: `${body} · ${safeName}`,
          largeBody: safeName,
          channelId: ANDROID_EXPORT_DOWNLOAD_CHANNEL_ID,
          ongoing: false,
          autoCancel: true,
          extra: {
            type: EXPORT_NOTIF_EXTRA_TYPE,
            directory,
            path,
            kind: String(kind || "txt"),
            mimeType: exportDownloadMimeType(String(kind || "txt"))
          },
          ...(capacitorPlatform() === "android"
            ? {
                smallIcon: "ic_stat_notes_ai",
                iconColor: NOTES_AI_ANDROID_ICON_COLOR
              }
            : {})
        }
      ]
    });
  } catch {
    /* ignore */
  }
}

async function notesAiDismissExportDownloadNotification(notifId) {
  if (!isNativeLocalNotificationsAvailable() || notifId == null) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications || typeof localNotifications.cancel !== "function") return;
  try {
    await localNotifications.cancel({ notifications: [{ id: Number(notifId) }] });
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  window.notesAiShowExportDownloadStarting = notesAiShowExportDownloadStarting;
  window.notesAiShowExportDownloadComplete = notesAiShowExportDownloadComplete;
  window.notesAiDismissExportDownloadNotification = notesAiDismissExportDownloadNotification;
  window.notesAiOpenNativeExportFile = openNativeExportFile;
}

async function ensureNativeNotificationChannel() {
  if (!isNativeLocalNotificationsAvailable()) return;
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications || typeof localNotifications.createChannel !== "function") return;
  try {
    /**
     * Android 8+: importance 5 lane heads-up · visibility 1 = public lock screen.
     * Sound fleksibel — pa res/raw përdoret default i canalit/OS.
     */
    await localNotifications.createChannel({
      id: ANDROID_NOTES_AI_CHANNEL_ID,
      name: "Notes AI",
      description: "Reminders & daily planner from your Notes AI workspace.",
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: NOTES_AI_ANDROID_ICON_COLOR
    });
    await ensureExportDownloadChannel();
  } catch {
    /* ignore */
  }
}

async function initNotesAiNativeLocalNotificationShell() {
  await ensureNativeNotificationChannel();
  if (!isNativeLocalNotificationsAvailable() || notesAiNativeNotificationShellReady) return;

  const plug = getLocalNotificationsPlugin();
  if (!plug || typeof plug.addListener !== "function") return;

  try {
    if (typeof plug.registerActionTypes === "function") {
      await plug.registerActionTypes({
        types: [
          {
            id: NOTES_AI_LOCAL_NOTIF_ACTIONS_ID,
            actions: [
              { id: NOTES_AI_LOCAL_ACTION_OPEN, title: "Open", foreground: true },
              { id: NOTES_AI_LOCAL_ACTION_DISMISS, title: "Dismiss" }
            ]
          }
        ]
      });
    }
    await plug.addListener("localNotificationActionPerformed", async (action) => {
      const aid = action && action.actionId;
      const notif = action && action.notification;
      const extra = notif && notif.extra && typeof notif.extra === "object" ? notif.extra : {};
      const nid = notif != null && notif.id != null ? Number(notif.id) : NaN;

      if (extra && extra.type === EXPORT_NOTIF_EXTRA_TYPE) {
        if (aid === NOTES_AI_LOCAL_ACTION_DISMISS) {
          if (Number.isFinite(nid) && typeof plug.removeDeliveredNotifications === "function") {
            try {
              await plug.removeDeliveredNotifications({ notifications: [{ id: nid }] });
            } catch {
              /* ignore */
            }
          }
          return;
        }
        await openNativeExportFile(extra);
        return;
      }

      if (aid !== NOTES_AI_LOCAL_ACTION_DISMISS || !Number.isFinite(nid)) return;
      if (typeof plug.removeDeliveredNotifications !== "function") return;
      try {
        await plug.removeDeliveredNotifications({ notifications: [{ id: nid }] });
      } catch {
        /* ignore */
      }
    });
  } catch {
    return;
  }

  notesAiNativeNotificationShellReady = true;
}

/**
 * @param {{ body?: string; at?: Date; variant?: "reminder" | "ai" }} common
 */
function scheduledLocalReminderPayload(common) {
  const variant = common && common.variant === "ai" ? "ai" : "reminder";
  const sanitizedFull = sanitizeNotificationPlainText(common && common.body != null ? common.body : "");
  const collapsed = sanitizedFull.slice(0, 720);

  /** Titull konsistent hierarkik; përdoruesi donte ⏰ në titullin e reminder-it. */
  const title = variant === "ai" ? "Notes AI" : "⏰ Reminder";

  let bodyLine = truncateNativeNotificationPreview(sanitizedFull, 174);
  if (!bodyLine) {
    bodyLine =
      variant === "ai"
        ? "You have something new inside Notes AI."
        : "Reminder is due — tap to open your workspace.";
  }

  const base = {
    title,
    body: bodyLine,
    largeBody: collapsed || undefined,
    schedule: common && common.at ? { at: common.at, allowWhileIdle: true } : undefined,
    channelId: ANDROID_NOTES_AI_CHANNEL_ID,
    autoCancel: true,
    ongoing: false,
    actionTypeId: NOTES_AI_LOCAL_NOTIF_ACTIONS_ID,
    extra: common && typeof common.extra === "object" && common.extra !== null ? common.extra : {},
    ...(capacitorPlatform() === "ios" ? { sound: "default" } : {}),
    ...(capacitorPlatform() === "ios" ? { threadIdentifier: NOTES_AI_ANDROID_NOTIFICATION_GROUP } : {}),
    ...(capacitorPlatform() === "android"
      ? {
          smallIcon: "ic_stat_notes_ai",
          largeIcon: "ic_notification_large_notes_ai",
          iconColor: NOTES_AI_ANDROID_ICON_COLOR,
          group: NOTES_AI_ANDROID_NOTIFICATION_GROUP
        }
      : {})
  };

  if (collapsed && collapsed.length > bodyLine.length && capacitorPlatform() === "android") {
    base.summaryText =
      variant === "ai"
        ? "Notes AI workspace"
        : "Stay on top of reminders";
  }

  return base;
}

function dailyPlannerTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Logged-in user id for scoped planner keys — empty when guest (fallback to legacy-shaped keys). */
function dailyPlannerEffectiveUserId() {
  if (typeof currentUser !== "undefined" && currentUser && currentUser.id != null) return String(currentUser.id);
  return "";
}

function dailyPlannerStorageKey(dateKey = dailyPlannerTodayKey()) {
  const uid = dailyPlannerEffectiveUserId();
  if (uid) return `${DAILY_PLANNER_KEY_PREFIX}:${uid}:${dateKey}`;
  return `${DAILY_PLANNER_KEY_PREFIX}:${dateKey}`;
}

function dailyPlannerNotifiedStorageKey(dateKey = dailyPlannerTodayKey()) {
  const uid = dailyPlannerEffectiveUserId();
  if (uid) return `${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:${uid}:${dateKey}`;
  return `${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:${dateKey}`;
}

/** @returns {{ legacy: boolean, dateKey: string } | null} */
function parseDailyPlannerDatedKey(key, prefix) {
  const p = `${prefix}:`;
  if (!key.startsWith(p)) return null;
  const rest = key.slice(p.length);
  const scoped = /^(.+):(\d{4}-\d{2}-\d{2})$/.exec(rest);
  if (scoped) return { legacy: false, dateKey: scoped[2], userSegment: scoped[1] };
  const leg = /^(\d{4}-\d{2}-\d{2})$/.exec(rest);
  if (leg) return { legacy: true, dateKey: leg[1], userSegment: null };
  return null;
}

/**
 * One-way migration: legacy per-device keys ({prefix}:{date}) → per-user ({prefix}:{userId}:{date}).
 * Logout/login keeps data on the same account; nightly cleanup still drops outdated dates only.
 */
function dailyPlannerMigrateLegacyForLoggedInUser(dateKey = dailyPlannerTodayKey()) {
  const uid = dailyPlannerEffectiveUserId();
  if (!uid) return;
  try {
    const legacyT = `${DAILY_PLANNER_KEY_PREFIX}:${dateKey}`;
    const scopedT = `${DAILY_PLANNER_KEY_PREFIX}:${uid}:${dateKey}`;
    const L = localStorage.getItem(legacyT);
    const S = localStorage.getItem(scopedT);
    if (L && !S) {
      localStorage.setItem(scopedT, L);
      localStorage.removeItem(legacyT);
    }

    const legacyN = `${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:${dateKey}`;
    const scopedN = `${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:${uid}:${dateKey}`;
    const Ln = localStorage.getItem(legacyN);
    const Sn = localStorage.getItem(scopedN);
    if (Ln && !Sn) {
      localStorage.setItem(scopedN, Ln);
      localStorage.removeItem(legacyN);
    }
    if (L && S) localStorage.removeItem(legacyT);
    if (Ln && Sn) localStorage.removeItem(legacyN);
  } catch {
    /* ignore quota / Safari private */
  }
}

function readDailyPlannerTasks() {
  dailyPlannerMigrateLegacyForLoggedInUser();
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
        const meta = parseDailyPlannerDatedKey(k, DAILY_PLANNER_KEY_PREFIX);
        if (meta && meta.dateKey && meta.dateKey !== todayKey) keys.push(k);
        continue;
      }
      if (k.startsWith(`${DAILY_PLANNER_NOTIFIED_KEY_PREFIX}:`)) {
        const meta = parseDailyPlannerDatedKey(k, DAILY_PLANNER_NOTIFIED_KEY_PREFIX);
        if (meta && meta.dateKey && meta.dateKey !== todayKey) keys.push(k);
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
  dailyPlannerMigrateLegacyForLoggedInUser();
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
  if (!webReminderNotificationsAppEnabled()) return;
  if (!task || !task.id || !task.notificationEnabled || !task.time || task.done) return;
  const when = plannerTaskToDate(task);
  if (!when || when.getTime() <= Date.now()) return;
  const allowed = await requestNotificationPermissionIfNeeded(true);
  if (!allowed) return;
  await ensureNativeNotificationChannel();
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  const id = plannerNotificationId(task.id);
  try {
    await localNotifications.cancel({ notifications: [{ id }] });
    await localNotifications.schedule({
      notifications: [
        {
          id,
          ...scheduledLocalReminderPayload({
            body: formatPlannerNativeNotificationCaption(task),
            at: when,
            extra: { route: "planner", plannerTaskId: String(task.id) }
          })
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
  if (!webReminderNotificationsAppEnabled()) return;
  if (!reminder || !reminder._id || !reminder.time || reminder.sent) return;
  if (!isReminderNotificationEnabled(reminder._id)) return;
  const when = new Date(reminder.time);
  if (!Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) return;
  const allowed = await requestNotificationPermissionIfNeeded(true);
  if (!allowed) return;
  await ensureNativeNotificationChannel();
  const localNotifications = getLocalNotificationsPlugin();
  if (!localNotifications) return;
  const id = reminderNotificationId(reminder._id);
  try {
    await localNotifications.cancel({ notifications: [{ id }] });
    await localNotifications.schedule({
      notifications: [
        {
          id,
          ...scheduledLocalReminderPayload({
            body: String(reminder.message || t("reminderDefaultBody")),
            at: when,
            extra: { route: "reminders", reminderId: String(reminder._id || "") }
          })
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

async function dailyPlannerMaybeTriggerNotifications() {
  if (isNativeLocalNotificationsAvailable()) return;
  if (!webReminderNotificationsAppEnabled()) return;
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
      const title = t("webNotificationTitle");
      const opts = webReminderNotificationOpts(task.text, `planner-${task.id}`, {
        url: buildAppHomeHashUrl()
      });
      await showReminderSystemNotification(title, opts);
      if (document.visibilityState === "visible") {
        showReminderForegroundToast(task.text);
      }
    } catch {
      /* ignore */
    }
    notified.add(task.id);
    changed = true;
  }
  if (changed) writeDailyPlannerNotifiedSet(notified);
}

function scheduleDailyPlannerNotificationLoop() {
  if (dailyPlannerNotifyLoopRegistered) return;
  dailyPlannerNotifyLoopRegistered = true;
  if (isNativeLocalNotificationsAvailable()) {
    void syncPlannerLocalNotifications();
    return;
  }
  if (dailyPlannerNotifyTimer) window.clearInterval(dailyPlannerNotifyTimer);
  dailyPlannerNotifyTimer = window.setInterval(() => {
    if (isDocumentHidden()) return;
    void dailyPlannerMaybeTriggerNotifications();
  }, 30000);
  void dailyPlannerMaybeTriggerNotifications();
}

function scheduleDailyPlannerMidnightReset() {
  if (dailyPlannerMidnightTimer) window.clearTimeout(dailyPlannerMidnightTimer);
  const now = new Date();
  /** Next local calendar midnight — drop prior days’ buckets; today’s slot starts fresh as a new dated key when user adds tasks */
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const wait = Math.max(1500, nextMidnight.getTime() - now.getTime());
  dailyPlannerMidnightTimer = window.setTimeout(() => {
    cleanupDailyPlannerStorage();
    renderDailyPlannerList();
    /** Reschedule reminders for native after day roll */
    void syncPlannerLocalNotifications();
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
  const axBell = escapeHtmlAttr(t("dailyPlannerAriaReminderToggle"));
  const axKebab = escapeHtmlAttr(t("dailyPlannerAriaTaskMenu"));
  const axMarkDone = escapeHtmlAttr(t("dailyPlannerAriaMarkDone"));
  const axMarkUndone = escapeHtmlAttr(t("dailyPlannerAriaMarkUndone"));
  const txSectionTodo = escapeHtml(t("dailyPlannerSectionTodo"));
  const txSectionCompleted = escapeHtml(t("dailyPlannerSectionCompleted"));
  const tasks = readDailyPlannerTasks();
  const doneCount = tasks.filter((x) => x.done).length;
  const total = tasks.length;
  if (progress) {
    const pct = total ? Math.round((doneCount / total) * 100) : 0;
    const label = t("dailyPlannerProgressLabel")
      .replace("{done}", String(doneCount))
      .replace("{total}", String(total));
    progress.innerHTML = `<div class="daily-planner-progress__line"><span class="daily-planner-progress__label">${escapeHtml(
      label
    )}</span><span class="daily-planner-progress__pct">${pct}%</span></div><div class="daily-planner-progress__track"><span class="daily-planner-progress__fill" style="width:${pct}%"></span></div>`;
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
          }" onclick="dailyPlannerToggleNotification('${escapeHtmlAttr(task.id)}', this)" aria-label="${axBell}">🔔</button>`
        : "";
      const kebabHtml = `<button type="button" class="daily-planner-item__kebab" onclick="dailyPlannerToggleTask('${escapeHtmlAttr(
        task.id
      )}')" aria-label="${axKebab}"><span class="daily-planner-item__kebab-dot" aria-hidden="true"></span><span class="daily-planner-item__kebab-dot" aria-hidden="true"></span><span class="daily-planner-item__kebab-dot" aria-hidden="true"></span></button>`;
      const justAdded = task.id === dailyPlannerLastAddedTaskId ? " daily-planner-item--new" : "";
      return `<div class="daily-planner-item${doneClass}${justAdded}" data-daily-task-id="${escapeHtmlAttr(task.id)}">
        <button type="button" class="daily-planner-item__toggle" onclick="dailyPlannerToggleTask('${escapeHtmlAttr(
          task.id
        )}')" aria-label="${axMarkDone}" aria-pressed="false"><span class="daily-planner-item__toggle-check">✓</span></button>
        <div class="daily-planner-item__text-wrap">
          <span class="daily-planner-item__text">${escapeHtml(task.text)}</span>
          ${timeHtml}
        </div>
        <div class="daily-planner-item__meta">
          ${bellHtml}${kebabHtml}
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
          }" onclick="dailyPlannerToggleNotification('${escapeHtmlAttr(task.id)}', this)" aria-label="${axBell}">🔔</button>`
        : "";
      const kebabHtml = `<button type="button" class="daily-planner-item__kebab" onclick="dailyPlannerToggleTask('${escapeHtmlAttr(
        task.id
      )}')" aria-label="${axKebab}"><span class="daily-planner-item__kebab-dot" aria-hidden="true"></span><span class="daily-planner-item__kebab-dot" aria-hidden="true"></span><span class="daily-planner-item__kebab-dot" aria-hidden="true"></span></button>`;
      const moved = task.id === dailyPlannerMovedTaskId ? " daily-planner-item--moved" : "";
      return `<div class="daily-planner-item${doneClass}${moved}" data-daily-task-id="${escapeHtmlAttr(task.id)}">
        <button type="button" class="daily-planner-item__toggle" onclick="dailyPlannerToggleTask('${escapeHtmlAttr(
          task.id
        )}')" aria-label="${axMarkUndone}" aria-pressed="true"><span class="daily-planner-item__toggle-check">✓</span></button>
        <div class="daily-planner-item__text-wrap">
          <span class="daily-planner-item__text">${escapeHtml(task.text)}</span>
          ${timeHtml}
        </div>
        <div class="daily-planner-item__meta">
          ${bellHtml}${kebabHtml}
        </div>
      </div>`;
    })
    .join("");
  list.innerHTML = `<section class="daily-planner-group daily-planner-group--pending">
    <div class="daily-planner-group__head daily-planner-group__head--pending"><h3>${txSectionTodo}</h3><span class="daily-planner-group__count">${todo.length}</span></div>
    <div class="daily-planner-group__body">${todoHtml || `<p class="daily-planner-empty">${escapeHtml(t("dailyPlannerEmpty"))}</p>`}</div>
  </section>
  <section class="daily-planner-group daily-planner-group--completed">
    <button type="button" class="daily-planner-group__head daily-planner-group__head--completed daily-planner-group__toggle" onclick="toggleDailyPlannerCompleted()">
      <h3>${txSectionCompleted}</h3><span class="daily-planner-group__count">${completed.length}<span class="daily-planner-group__chev" aria-hidden="true">${dailyPlannerCompletedOpen ? "▾" : "▸"}</span></span>
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
  return Boolean(currentUser) && typeof hasStandardAccess === "function" && hasStandardAccess(currentUser);
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
  syncAppBackgroundActivity();
  renderDailyPlannerList();
  if (typeof applyTranslations === "function") applyTranslations();
  /* No programmatic focus — Android/Capacitor otherwise opens the soft keyboard immediately. */
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
  document.documentElement.classList.add("depth-motion-ready");
  if (typeof isNativeApp === "function" && isNativeApp()) {
    return;
  }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
let mobileScrollRaf = 0;
let resizeUiRaf = 0;
let appBackgroundHooksReady = false;
/** @type {AbortController | null} */
let webChatUiAbortController = null;
let depthRevealObserverPaused = false;
let reminderPollingSuspendedByHidden = false;
let dailyPlannerNotifySuspendedByHidden = false;
let offlineFlushSuspendedByHidden = false;

function isDocumentHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function isElementInVisiblePage(el) {
  if (!(el instanceof Element)) return false;
  let node = el;
  while (node && node !== document.body) {
    if (node.classList && node.classList.contains("hidden")) return false;
    node = node.parentElement;
  }
  return true;
}

function hasBlockingOverlay() {
  if (document.body.classList.contains("modal-open")) return true;
  if (document.body.classList.contains("mobile-nav-open")) return true;
  if (webChatDrawerIsOpen()) return true;
  const authLanding = document.getElementById("authLanding");
  if (authLanding && !authLanding.classList.contains("hidden")) return true;
  return false;
}

function cancelPendingScrollRafs() {
  if (mobileScrollRaf) {
    cancelAnimationFrame(mobileScrollRaf);
    mobileScrollRaf = 0;
  }
  if (resizeUiRaf) {
    cancelAnimationFrame(resizeUiRaf);
    resizeUiRaf = 0;
  }
  if (depthRevealRefreshRaf) {
    cancelAnimationFrame(depthRevealRefreshRaf);
    depthRevealRefreshRaf = 0;
  }
}

function pauseDepthRevealObserver() {
  if (!depthRevealObserver || depthRevealObserverPaused) return;
  depthRevealObserver.disconnect();
  depthRevealObserverPaused = true;
}

function resumeDepthRevealObserver() {
  if (!depthRevealObserverPaused || !depthRevealObserver) return;
  if (isDocumentHidden()) return;
  depthRevealObserverPaused = false;
  refreshDepthRevealObserversNow();
}

function pauseWebReminderPollingForHidden() {
  if (!reminderPollingStarted || reminderPollingSuspendedByHidden) return;
  if (webNotificationSchedulerIntervalId != null) {
    window.clearInterval(webNotificationSchedulerIntervalId);
    webNotificationSchedulerIntervalId = null;
    reminderPollingSuspendedByHidden = true;
  }
}

function resumeWebReminderPollingForHidden() {
  if (!reminderPollingSuspendedByHidden) return;
  reminderPollingSuspendedByHidden = false;
  if (!isAuthSessionReady() || authInvalidated || isNativeLocalNotificationsAvailable()) return;
  if (!reminderPollingStarted || webNotificationSchedulerIntervalId != null) return;
  webNotificationSchedulerIntervalId = window.setInterval(() => {
    if (isDocumentHidden()) return;
    void checkForDueReminders();
  }, REMINDER_POLL_INTERVAL_MS);
}

function pauseDailyPlannerNotifyLoopForHidden() {
  if (!dailyPlannerNotifyTimer || dailyPlannerNotifySuspendedByHidden) return;
  window.clearInterval(dailyPlannerNotifyTimer);
  dailyPlannerNotifyTimer = null;
  dailyPlannerNotifySuspendedByHidden = true;
}

function resumeDailyPlannerNotifyLoopForHidden() {
  if (!dailyPlannerNotifySuspendedByHidden || !dailyPlannerNotifyLoopRegistered) return;
  if (isNativeLocalNotificationsAvailable()) {
    dailyPlannerNotifySuspendedByHidden = false;
    return;
  }
  dailyPlannerNotifySuspendedByHidden = false;
  if (dailyPlannerNotifyTimer) return;
  dailyPlannerNotifyTimer = window.setInterval(() => {
    if (isDocumentHidden()) return;
    void dailyPlannerMaybeTriggerNotifications();
  }, 30000);
}

function pauseOfflineFlushForHidden() {
  if (offlineNotesFlushIntervalId == null || offlineFlushSuspendedByHidden) return;
  window.clearInterval(offlineNotesFlushIntervalId);
  offlineNotesFlushIntervalId = null;
  offlineFlushSuspendedByHidden = true;
}

function resumeOfflineFlushForHidden() {
  if (!offlineFlushSuspendedByHidden) return;
  offlineFlushSuspendedByHidden = false;
  ensureOfflineNotesFlushInterval();
}

function syncAppBackgroundActivity() {
  const hidden = isDocumentHidden();
  const overlayBlocksFx =
    document.body.classList.contains("modal-open") ||
    document.body.classList.contains("mobile-nav-open") ||
    (document.getElementById("authLanding") &&
      !document.getElementById("authLanding").classList.contains("hidden"));
  const pauseFx = hidden || overlayBlocksFx;
  document.documentElement.classList.toggle("app-effects-paused", pauseFx);

  if (hidden) {
    cancelPendingScrollRafs();
    pauseDepthRevealObserver();
    pauseWebReminderPollingForHidden();
    pauseDailyPlannerNotifyLoopForHidden();
    pauseOfflineFlushForHidden();
    pauseWebChatFabPromptCycle();
    premiumTiltEnabled = false;
  } else {
    resumeDepthRevealObserver();
    resumeWebReminderPollingForHidden();
    resumeDailyPlannerNotifyLoopForHidden();
    resumeOfflineFlushForHidden();
    initPremiumTiltSystem();
    if (!webChatDrawerIsOpen() && !webChatQuickPanelOpen()) {
      scheduleWebChatFabPromptCycle();
    } else {
      pauseWebChatFabPromptCycle();
    }
  }
}

function initAppBackgroundHooks() {
  if (appBackgroundHooksReady) return;
  appBackgroundHooksReady = true;
  document.addEventListener("visibilitychange", syncAppBackgroundActivity, { passive: true });
  window.addEventListener("pagehide", syncAppBackgroundActivity, { passive: true });
  syncAppBackgroundActivity();
}

function bindWebChatDrawerUi() {
  teardownWebChatDrawerUi();
  webChatUiAbortController = new AbortController();
  const { signal } = webChatUiAbortController;
  const input = document.getElementById("webChatInput");
  if (input) {
    input.addEventListener("input", () => webChatAutoResizeInput(input), { signal });
    webChatAutoResizeInput(input);
  }
}

function teardownWebChatDrawerUi() {
  if (webChatUiAbortController) {
    webChatUiAbortController.abort();
    webChatUiAbortController = null;
  }
}

function refreshDepthRevealObservers() {
  if (depthRevealRefreshRaf) return;
  depthRevealRefreshRaf = requestAnimationFrame(() => {
    depthRevealRefreshRaf = 0;
    refreshDepthRevealObserversNow();
  });
}

function refreshDepthRevealObserversNow() {
  if (isDocumentHidden() || depthRevealObserverPaused) return;
  if (isScanCamCategoryActive()) {
    document.querySelectorAll("#notes .note-card").forEach((el) => {
      if (depthRevealObserver) depthRevealObserver.unobserve(el);
      el.classList.remove("depth-reveal");
      el.classList.add("depth-reveal--in");
    });
    return;
  }
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
    if (!(el instanceof HTMLElement)) return;
    if (isScanCamCategoryActive() && el.closest("#notes")) return;
    if (!isElementInVisiblePage(el)) {
      if (depthRevealObserver) depthRevealObserver.unobserve(el);
      return;
    }
    if (!el.classList.contains("depth-reveal")) {
      el.classList.add("depth-reveal");
    }
    if (el.classList.contains("depth-reveal--in")) return;
    if (el.dataset.depthRevealObserved === "1") return;
    el.dataset.depthRevealObserved = "1";
    depthRevealObserver.observe(el);
  });
  if (!isDocumentHidden()) refreshPremiumTiltTargets();
}

function initPremiumTiltSystem() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const nativeApp = typeof isNativeApp === "function" && isNativeApp();
  premiumTiltEnabled = !reduce && !coarse && !nativeApp && !isMobileViewport();
  refreshPremiumTiltTargets();
}

function refreshPremiumTiltTargets() {
  if (isDocumentHidden() || !premiumTiltEnabled || isScanCamCategoryActive()) return;
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
  syncAppBackgroundActivity();
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

function getNoteShareParts(note) {
  const title = noteTitleTrim(note) || "";
  const content = noteStoredPlainPreview(note && note.text, 50000);
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
  syncAppBackgroundActivity();
  if (typeof applyTranslations === "function") applyTranslations();
}

function isScanCamLocalNoteId(id) {
  return String(id || "").startsWith("local-scan-");
}

async function resolveNoteForDetailView(note) {
  if (!note) return note;
  const id = note._id != null ? String(note._id) : "";
  if (id && isScanCamLocalNoteId(id)) {
    const local = readScanCamLocalNotes().find((n) => String(n._id) === id);
    if (local) return local;
  }
  if (!note.textPreviewOnly) return note;
  if (!id || isScanCamLocalNoteId(id)) return note;
  try {
    const data = await apiFetch(`/api/notes/detail/${encodeURIComponent(id)}`);
    if (data && data.note) return data.note;
  } catch {
    /* keep list copy */
  }
  return note;
}

async function openNoteViewModal(note, origin = "all") {
  if (!note) return;
  const viewNote = await resolveNoteForDetailView(note);
  noteViewModalState = { note: viewNote, origin: origin === "category" ? "category" : "all" };

  const modal = document.getElementById("noteViewModal");
  const titleEl = document.getElementById("noteViewTitle");
  const badgeEl = document.getElementById("noteViewCategoryBadge");
  const dateEl = document.getElementById("noteViewDate");
  const bodyEl = document.getElementById("noteViewText");
  const actionsEl = document.getElementById("noteViewActions");
  if (!modal || !titleEl || !badgeEl || !dateEl || !bodyEl || !actionsEl) return;

  const theme = noteCategoryThemeKey(viewNote.category);
  const title = noteTitleTrim(viewNote);
  titleEl.textContent = title || t("noteCardUntitled");
  titleEl.classList.toggle("note-card-title--placeholder", !title);

  const categoryLabel = normalizeNoteCategoryLabel(viewNote);
  badgeEl.className = `note-category-badge note-category-badge--${theme}`;
  badgeEl.textContent = categoryLabel;

  dateEl.textContent = new Date(viewNote.createdAt).toLocaleString();
  if (window.NoteRichEditor && typeof window.NoteRichEditor.storedToHtml === "function") {
    bodyEl.innerHTML = window.NoteRichEditor.storedToHtml(viewNote.text || "");
  } else {
    bodyEl.textContent = (viewNote.text || "").toString();
  }

  const canManage = currentUser && !viewNote.public;
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
      void resolveNoteForDetailView(viewNote).then((full) => openNoteEditorEdit(full, noteViewModalState.origin));
    });
    addBtn("note-action-btn--download", "noteExportDownloadTitle", NOTE_DOWNLOAD_SVG, () => {
      closeNoteViewModal();
      void resolveNoteForDetailView(viewNote).then((full) => {
        if (typeof openNoteExportModal === "function") openNoteExportModal(full);
      });
    });
    addBtn("note-action-btn--share", "noteShareTitle", NOTE_SHARE_SVG, () => {
      closeNoteViewModal();
      void resolveNoteForDetailView(viewNote).then((full) => openNoteShareModal(full));
    });
    addBtn("note-action-btn--delete", "deleteNoteTitle", NOTE_TRASH_SVG, () => {
      closeNoteViewModal();
      void deleteNoteById(viewNote);
    });
  } else {
    actionsEl.classList.add("hidden");
  }

  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  syncAppBackgroundActivity();
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

const WHATSAPP_SHARE_TEXT_MAX = 4000;

function truncateTextForWhatsApp(text) {
  const raw = String(text || "");
  if (raw.length <= WHATSAPP_SHARE_TEXT_MAX) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, WHATSAPP_SHARE_TEXT_MAX - 1)}…`, truncated: true };
}

async function openWhatsAppShareUrl(text) {
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const Browser =
    window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
  if (typeof isNativeApp === "function" && isNativeApp() && Browser && typeof Browser.open === "function") {
    try {
      await Browser.open({ url });
      return;
    } catch {
      /* fall through to window.open / location */
    }
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) window.location.href = url;
}

function shareNoteViaEmail() {
  const note = noteShareModalNote;
  if (!note) return;
  const { subject, content } = getNoteShareParts(note);
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(content)}`;
  window.location.href = mailto;
  closeNoteShareModal();
}

function shareNoteViaWhatsApp() {
  const note = noteShareModalNote;
  if (!note) return;
  const { fullText } = getNoteShareParts(note);
  const { text, truncated } = truncateTextForWhatsApp(fullText);
  if (truncated && typeof showToast === "function") {
    showToast(typeof t === "function" ? t("noteShareTruncated") : "Long note was shortened for WhatsApp.");
  }
  void openWhatsAppShareUrl(text);
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

function noteContentFingerprint(text) {
  const s = text != null ? String(text) : "";
  if (s.length <= 512) return s;
  return `${s.length}:${s.slice(0, 120)}:${s.slice(-60)}`;
}

const listIncrementalObservers = new WeakMap();

function bindScanCamListScrollGuard() {
  if (document.documentElement.dataset.scanCamScrollGuard === "1") return;
  document.documentElement.dataset.scanCamScrollGuard = "1";
  const onScroll = () => {
    if (!isScanCamCategoryActive()) return;
    listScrollBlockedUntil = performance.now() + 160;
    clearTimeout(listScrollIdleTimer);
    listScrollIdleTimer = window.setTimeout(() => {
      listScrollBlockedUntil = 0;
    }, 180);
  };
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
}

function listRenderBatchForCategory() {
  return isScanCamCategoryActive() ? LIST_RENDER_BATCH_SCAN_CAM : LIST_RENDER_BATCH;
}

function disconnectListIncremental(container) {
  const state = listIncrementalObservers.get(container);
  if (!state) return;
  state.observer?.disconnect();
  if (state.sentinel?.parentNode) state.sentinel.remove();
  listIncrementalObservers.delete(container);
}

/**
 * Renders long lists in batches (IntersectionObserver) to cut initial DOM/layout cost.
 * @param {HTMLElement} container
 * @param {Array} items
 * @param {(parent: DocumentFragment | HTMLElement, item: unknown) => void} appendItem
 * @param {{ onComplete?: () => void }} [opts]
 */
function renderIncrementalList(container, items, appendItem, opts = {}) {
  disconnectListIncremental(container);
  container.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    opts.onComplete?.();
    return;
  }
  if (list.length <= listVirtualizeThresholdForCategory()) {
    const fragment = document.createDocumentFragment();
    list.forEach((item) => appendItem(fragment, item));
    container.appendChild(fragment);
    opts.onComplete?.();
    return;
  }
  let cursor = 0;
  const sentinel = document.createElement("div");
  sentinel.className = "list-load-sentinel";
  sentinel.setAttribute("aria-hidden", "true");
  sentinel.hidden = true;
  container.appendChild(sentinel);

  const loadBatch = () => {
    if (cursor >= list.length) return;
    if (isScanCamCategoryActive() && performance.now() < listScrollBlockedUntil) {
      listScrollIdleTimer = window.setTimeout(loadBatch, 100);
      return;
    }
    const fragment = document.createDocumentFragment();
    const end = Math.min(cursor + listRenderBatchForCategory(), list.length);
    for (; cursor < end; cursor += 1) {
      appendItem(fragment, list[cursor]);
    }
    container.insertBefore(fragment, sentinel);
    if (typeof refreshDepthRevealObservers === "function" && !isScanCamCategoryActive()) {
      refreshDepthRevealObservers();
    }
    if (cursor >= list.length) {
      disconnectListIncremental(container);
      opts.onComplete?.();
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      loadBatch();
    },
    { root: null, rootMargin: "280px 0px 120px 0px", threshold: 0 }
  );
  listIncrementalObservers.set(container, { observer, sentinel });
  observer.observe(sentinel);
  loadBatch();
}

function isScanCamCategoryActive() {
  return currentCategory === "scan_cam";
}

function isScanCamListNote(note) {
  if (!note) return isScanCamCategoryActive();
  if (note.category === "scan_cam") return true;
  if (note.scanCamImageDataUrl) return true;
  const raw = note.text != null ? String(note.text) : "";
  if (raw.length > 12000 && /scan|ocr|data:image/i.test(raw.slice(0, 400))) return true;
  return isScanCamCategoryActive();
}

function noteStoredPlainPreviewForList(note, maxLen) {
  const limit = Math.max(1, Number(maxLen) || SCAN_CAM_LIST_PREVIEW_MAX);
  const raw = note && note.text != null ? String(note.text) : "";
  let plain = "";
  if (isScanCamListNote(note)) {
    plain = scanCamStripHeavyRaw(raw).slice(0, limit);
  } else {
    plain = noteStoredPlainPreview(raw, limit);
    plain = plain.replace(/data:[^\s]+;base64,[A-Za-z0-9+/=\s]+/gi, " ").replace(/\s+/g, " ").trim();
  }
  if (note && note.scanCamImageDataUrl) {
    const tag = "📷";
    plain = plain ? `${tag} ${plain}` : tag;
  }
  return plain.slice(0, limit);
}

function listVirtualizeThresholdForCategory() {
  return isScanCamCategoryActive() ? LIST_VIRTUALIZE_THRESHOLD_SCAN_CAM : LIST_VIRTUALIZE_THRESHOLD;
}

function trimWebChatMessageDom() {
  const box = document.getElementById("webChatMessages");
  if (!box) return;
  const rows = box.querySelectorAll(".web-chat-row:not(#webChatTypingRow)");
  const max = WEB_CHAT_DOM_MAX_ROWS;
  if (rows.length <= max) return;
  for (let i = 0; i < rows.length - max; i += 1) {
    rows[i].remove();
  }
}

function notesListRenderKey(notes, extra) {
  if (isScanCamCategoryActive()) {
    const body = (notes || [])
      .map((n) => {
        const textLen = n && n.text != null ? String(n.text).length : 0;
        return [
          n && n._id != null ? String(n._id) : "",
          noteTitleTrim(n),
          String(textLen),
          n && n.createdAt ? String(n.createdAt) : ""
        ].join("\u001f");
      })
      .join("\u001e");
    return `${extra}\u0000${body}`;
  }
  const body = (notes || [])
    .map((n) => {
      const text = n && n.text != null ? String(n.text) : "";
      return [
        n && n._id != null ? String(n._id) : "",
        noteTitleTrim(n),
        noteContentFingerprint(text),
        n && n.createdAt ? String(n.createdAt) : "",
        n && n.category != null ? String(n.category) : ""
      ].join("\u001f");
    })
    .join("\u001e");
  return `${extra}\u0000${body}`;
}

function noteSearchHaystack(note) {
  const id = note && note._id != null ? String(note._id) : "";
  const text = note && note.text != null ? String(note.text) : "";
  const title = noteTitleTrim(note);
  const cat = normalizeNoteCategoryLabel(note);
  const key = `${id}\0${title.length}\0${noteContentFingerprint(text)}\0${cat}`;
  if (noteSearchHaystackCache.has(key)) return noteSearchHaystackCache.get(key);
  const hay = `${title}\n${text}\n${cat}`.toLowerCase();
  noteSearchHaystackCache.set(key, hay);
  if (noteSearchHaystackCache.size > NOTE_PREVIEW_CACHE_MAX) {
    noteSearchHaystackCache.delete(noteSearchHaystackCache.keys().next().value);
  }
  return hay;
}

function buildNoteCardPreviewHtml(note) {
  const raw = note && note.text != null ? String(note.text) : "";
  if (!raw) return "";
  const lite = isScanCamListNote(note);
  const cacheKey = lite
    ? `${note && note._id != null ? String(note._id) : ""}\0lite\0${noteTitleTrim(note)}\0${raw.length}`
    : `${note && note._id != null ? String(note._id) : ""}\0${noteTitleTrim(note)}\0${noteContentFingerprint(raw)}`;
  if (notePreviewHtmlCache.has(cacheKey)) return notePreviewHtmlCache.get(cacheKey);
  let html = "";
  if (lite) {
    const plain = noteStoredPlainPreviewForList(note, SCAN_CAM_LIST_PREVIEW_MAX);
    html = escapeHtml(plain).replace(/\n/g, "<br>");
  } else if (window.NoteRichEditor && typeof window.NoteRichEditor.storedToHtml === "function") {
    html = window.NoteRichEditor.storedToHtml(raw);
  } else {
    const plain = noteStoredPlainPreview(raw, 8000);
    html = escapeHtml(plain).replace(/\n/g, "<br>");
  }
  notePreviewHtmlCache.set(cacheKey, html);
  if (notePreviewHtmlCache.size > NOTE_PREVIEW_CACHE_MAX) {
    notePreviewHtmlCache.delete(notePreviewHtmlCache.keys().next().value);
  }
  return html;
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

  const previewWrap = document.createElement("div");
  previewWrap.className = "note-card-preview";
  if (isScanCamListNote(note)) {
    previewWrap.classList.add("note-card-preview--plain");
    const plain = noteStoredPlainPreviewForList(note, SCAN_CAM_LIST_PREVIEW_MAX);
    previewWrap.textContent = plain || "—";
  } else {
    const previewHtml = buildNoteCardPreviewHtml(note);
    previewWrap.innerHTML = previewHtml || `<p>—</p>`;
  }
  content.appendChild(previewWrap);

  const dateP = document.createElement("p");
  dateP.className = "note-card-date";
  dateP.textContent = new Date(note.createdAt).toLocaleString();
  content.appendChild(dateP);
}

function formatNoteSelectOptionLabel(note) {
  const title = noteTitleTrim(note);
  const text = noteStoredPlainPreview(note.text || "", 120).replace(/\s+/g, " ").trim();
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

/** Scroll position preserved while body is position:fixed during mobile nav */
let mobileNavScrollLockY = 0;
let webChatScrollLockY = 0;
let webChatScrollLocked = false;
/** @type {{ parent: Element; next: Element | null } | null} */
let webChatDrawerPortalHome = null;

function attachWebChatDrawerToBody() {
  const el = document.getElementById("webChat");
  if (!el || el.parentElement === document.body) return;
  webChatDrawerPortalHome = { parent: el.parentElement, next: el.nextElementSibling };
  document.body.appendChild(el);
}

function restoreWebChatDrawerPortal() {
  const el = document.getElementById("webChat");
  const home = webChatDrawerPortalHome;
  if (!el || !home?.parent) return;
  home.parent.insertBefore(el, home.next);
  webChatDrawerPortalHome = null;
}

function lockWebChatScroll() {
  if (webChatScrollLocked || document.body.classList.contains("mobile-nav-open")) return;
  webChatScrollLockY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.position = "fixed";
  document.body.style.top = `-${webChatScrollLockY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
  webChatScrollLocked = true;
}

function unlockWebChatScroll() {
  if (!webChatScrollLocked) return;
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  window.scrollTo(0, webChatScrollLockY);
  webChatScrollLocked = false;
}

function lockMobileNavScroll() {
  mobileNavScrollLockY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.position = "fixed";
  document.body.style.top = `-${mobileNavScrollLockY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
}

function unlockMobileNavScroll() {
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  window.scrollTo(0, mobileNavScrollLockY);
}

function openMobileNav() {
  if (!isMobileViewport()) return;
  const overlay = document.getElementById("mobileNavOverlay");
  const toggle = document.getElementById("mobileMenuToggle");
  lockMobileNavScroll();
  document.body.classList.add("mobile-nav-open");
  if (overlay) overlay.classList.remove("hidden");
  if (toggle) toggle.setAttribute("aria-expanded", "true");
}

function closeMobileNav() {
  const overlay = document.getElementById("mobileNavOverlay");
  const toggle = document.getElementById("mobileMenuToggle");
  const wasOpen = document.body.classList.contains("mobile-nav-open");
  document.body.classList.remove("mobile-nav-open");
  if (overlay) overlay.classList.add("hidden");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  if (wasOpen) unlockMobileNavScroll();
}

function toggleMobileNav() {
  if (document.body.classList.contains("mobile-nav-open")) {
    closeMobileNav();
  } else {
    openMobileNav();
  }
}

function syncMobileHeaderActionUi() {
  if (authBootstrapPhaseActive) return;
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

function scanCamNoteListPreviewText(raw, maxLen) {
  return scanCamStripHeavyRaw(raw).slice(0, Math.max(80, Number(maxLen) || SCAN_CAM_LIST_PREVIEW_MAX));
}

function scanCamNotesForListDisplay(notes) {
  return (notes || []).map((n) => {
    if (!n || !isScanCamListNote(n)) return n;
    if (n.textPreviewOnly) return n;
    const raw = n.text != null ? String(n.text) : "";
    if (raw.length <= 720) return n;
    return { ...n, text: scanCamNoteListPreviewText(raw, 720) };
  });
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
    currentNotes = scanCamNotesForListDisplay([note, ...currentNotes.filter((n) => String(n._id) !== id)]);
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
  const docPreview = document.getElementById("scanCamDocPreview");
  if (!ph || !vw || !img) return;
  const hasVideo = !vw.classList.contains("hidden");
  const hasImg = !!img.getAttribute("src");
  const hasDoc = !!(docPreview && !docPreview.classList.contains("hidden"));
  const hasPdf = hasDoc || !!(pdfWrap && !pdfWrap.classList.contains("hidden"));
  ph.classList.toggle("hidden", !!(hasVideo || hasImg || hasPdf));
}

function openScanCamUpgradeModal() {
  const modal = document.getElementById("scanCamUpgradeModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  document.body.style.overflow = "hidden";
  syncAppBackgroundActivity();
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
  syncAppBackgroundActivity();
}

function scanCamShareWhatsApp() {
  if (!scanCamEnsureConvertAccess()) return;
  const ta = document.getElementById("scanCamResultText");
  const raw = ta ? String(ta.value || "").trim() : "";
  if (!raw) {
    showToast(t("scanCamShareNoText"));
    return;
  }
  const { text, truncated } = truncateTextForWhatsApp(raw);
  if (truncated && typeof showToast === "function") {
    showToast(typeof t === "function" ? t("noteShareTruncated") : "Long note was shortened for WhatsApp.");
  }
  void openWhatsAppShareUrl(text);
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
  scanCamClearDocPreview();
  if (scanCamPdfObjectUrl) {
    try {
      URL.revokeObjectURL(scanCamPdfObjectUrl);
    } catch (e) {
      /* ignore */
    }
    scanCamPdfObjectUrl = null;
  }
}

function scanCamClearDocPreview() {
  const card = document.getElementById("scanCamDocPreview");
  const thumb = document.getElementById("scanCamDocThumb");
  const nameEl = document.getElementById("scanCamDocName");
  const metaEl = document.getElementById("scanCamDocMeta");
  if (thumb) {
    thumb.removeAttribute("src");
    thumb.classList.add("hidden");
  }
  if (nameEl) nameEl.textContent = "";
  if (metaEl) metaEl.textContent = "";
  if (card) card.classList.add("hidden");
}

function scanCamFormatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function scanCamShowStageLoading(text) {
  const overlay = document.getElementById("scanCamStageLoading");
  const textEl = document.getElementById("scanCamStageLoadingText");
  const stage = document.querySelector(".scan-cam-stage");
  if (textEl && text) textEl.textContent = text;
  if (overlay) overlay.classList.remove("hidden");
  if (stage) stage.classList.add("scan-cam-stage--busy");
}

function scanCamHideStageLoading() {
  const overlay = document.getElementById("scanCamStageLoading");
  const stage = document.querySelector(".scan-cam-stage");
  if (overlay) overlay.classList.add("hidden");
  if (stage) stage.classList.remove("scan-cam-stage--busy");
}

function scanCamShowDocPreview({ name, size, thumb, pages }) {
  const card = document.getElementById("scanCamDocPreview");
  const thumbEl = document.getElementById("scanCamDocThumb");
  const nameEl = document.getElementById("scanCamDocName");
  const metaEl = document.getElementById("scanCamDocMeta");
  const wrap = document.getElementById("scanCamPdfWrap");
  const embed = document.getElementById("scanCamPdfEmbed");
  if (wrap) wrap.classList.add("hidden");
  if (embed) embed.removeAttribute("src");
  if (!card) return;
  if (nameEl) nameEl.textContent = name || "document.pdf";
  const parts = [];
  if (size != null) parts.push(scanCamFormatFileSize(size));
  if (pages != null) parts.push(t("scanCamDocPages").replace("{n}", String(pages)));
  if (metaEl) metaEl.textContent = parts.join(" · ");
  if (thumb && thumbEl) {
    thumbEl.src = thumb;
    thumbEl.classList.remove("hidden");
  } else if (thumbEl) {
    thumbEl.removeAttribute("src");
    thumbEl.classList.add("hidden");
  }
  card.classList.remove("hidden");
}

async function scanCamBuildPdfThumb(pdfUrl) {
  await scanCamEnsureVendorScriptsLoaded();
  if (typeof pdfjsLib === "undefined") {
    throw new Error("MISSING_PDFJS");
  }
  if (!scanCamPdfWorkerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    scanCamPdfWorkerConfigured = true;
  }
  const pdf = await pdfjsLib.getDocument({ url: pdfUrl, verbosity: 0 }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.4 });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("NO_CANVAS");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { thumb: canvas.toDataURL("image/jpeg", 0.82), pages: pdf.numPages };
}

async function scanCamRenderPdfPreview(file, url) {
  const status = document.getElementById("scanCamStatus");
  scanCamShowStageLoading(t("scanCamDocLoading"));
  scanCamCloseCameraUi();
  scanCamCloseResultPanel();
  const launch = document.getElementById("scanCamLaunch");
  const stageBlock = document.getElementById("scanCamStageBlock");
  if (launch) launch.classList.add("hidden");
  if (stageBlock) stageBlock.classList.remove("hidden");
  let thumb = null;
  let pages = null;
  try {
    const built = await scanCamBuildPdfThumb(url);
    thumb = built.thumb;
    pages = built.pages;
  } catch (e) {
    if (notesAiVerboseLogs() && typeof console !== "undefined" && console.warn) {
      console.warn("[Scan Cam PDF preview]", e);
    }
  }
  scanCamHideStageLoading();
  scanCamShowDocPreview({
    name: file.name || "document.pdf",
    size: file.size,
    thumb,
    pages,
  });
  if (status) status.textContent = t("scanCamPdfUploaded");
  scanCamUpdateStageVisibility();
  scanCamSyncActionUi();
}

function scanCamHasStillPreview() {
  const img = document.getElementById("scanCamPhotoPreview");
  const docPreview = document.getElementById("scanCamDocPreview");
  if (img && img.getAttribute("src")) return true;
  if (docPreview && !docPreview.classList.contains("hidden")) return true;
  if (scanCamPdfObjectUrl) return true;
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
  if (stage) stage.classList.remove("scan-cam-stage--converting", "scan-cam-stage--busy");
  scanCamHideStageLoading();
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
  document.body.classList.remove("coins-hub-open");
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

function storeCurrentUser(user, token, refresh, remember, options) {
  const skipUi = options && options.skipUi === true;
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
  authInvalidated = false;
  if (user && ["classic", "normal", "advanced"].includes(user.theme)) {
    localStorage.setItem("theme", user.theme);
    applyTheme(user.theme);
    updateThemeSelector();
  }
  if (!skipUi) {
    updateAccountUI();
    updatePremiumUi();
  }
  if (token) {
    ensureRealtimeSocket();
    if (typeof socket !== "undefined" && socket && typeof socket.emit === "function") {
      socket.emit("authenticate", token);
    }
    if (!skipUi) {
      loadUserSettings();
    }
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
    const pathMatch = path.match(/\/invite\/([A-Za-z0-9]+)\/?$/i);
    if (pathMatch) {
      const raw = pathMatch[1];
      const norm = raw ? String(raw).toUpperCase() : "";
      /* Backend expects ≥ 4 alphanumeric — real referral codes always satisfy this */
      if (norm.length >= 4) {
        sessionStorage.setItem("aiNotesPendingInvite", norm);
      }
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
  const serverActive = data.standardActive === true;
  const serverInactive = data.standardActive === false;
  const pickExpiry = (key) => {
    if (serverInactive) return null;
    if (Object.prototype.hasOwnProperty.call(data, key)) return data[key] || null;
    return currentUser[key] || null;
  };
  Object.assign(currentUser, {
    isPremium: data.isPremium,
    tier: data.tier,
    plan: data.plan != null ? data.plan : data.tier || currentUser.plan || "free",
    membershipRole:
      data.plan != null ? data.plan : data.tier || currentUser.membershipRole || "free",
    subscriptionPlan:
      data.subscriptionPlan != null ? data.subscriptionPlan : currentUser.subscriptionPlan || "free",
    capabilities: data.capabilities,
    standardActive: data.standardActive != null ? Boolean(data.standardActive) : currentUser.standardActive,
    standardExpiresAt: pickExpiry("standardExpiresAt"),
    standardSource: serverInactive
      ? null
      : data.standardSource != null
        ? data.standardSource
        : currentUser.standardSource || null,
    premiumExpiresAt: pickExpiry("premiumExpiresAt"),
    subscriptionStatus: data.subscriptionStatus || null,
    cancelAtPeriodEnd: Boolean(data.cancelAtPeriodEnd),
    currentPeriodEnd: data.currentPeriodEnd || null,
    lifecycle: serverInactive
      ? "free"
      : data.lifecycle != null
        ? data.lifecycle
        : currentUser.lifecycle || "free",
    trialEndsAt: pickExpiry("trialEndsAt"),
    standardCoinExpiresAt: pickExpiry("standardCoinExpiresAt"),
    coinBalance: data.coinBalance != null ? data.coinBalance : currentUser.coinBalance ?? 0,
    referralCode:
      data.referralCode != null && String(data.referralCode).trim()
        ? String(data.referralCode).trim()
        : currentUser.referralCode || ""
  });
  if (serverActive && !currentUser.standardExpiresAt && data.standardExpiresAt) {
    currentUser.standardExpiresAt = data.standardExpiresAt;
  }
}

/** Loads coin status once after auth; triggers server-side daily streak + referral finalization. */
async function tryQuietCoinsBootstrap() {
  if (!accessToken || !currentUser) return;
  try {
    const coins = await apiFetch("/api/coins/status");
    if (coins && coins.balance != null) {
      currentUser.coinBalance = Number(coins.balance) || 0;
      const rc =
        coins.referralCode != null && String(coins.referralCode).trim()
          ? String(coins.referralCode).trim()
          : "";
      if (rc) currentUser.referralCode = rc;
      if (coins.lifecycle != null) currentUser.lifecycle = coins.lifecycle;
      if (coins.trialEndsAt != null) currentUser.trialEndsAt = coins.trialEndsAt;
      if (coins.standardCoinExpiresAt != null) {
        currentUser.standardCoinExpiresAt = coins.standardCoinExpiresAt;
      }
      if (coins.standardActive != null) currentUser.standardActive = Boolean(coins.standardActive);
      if (coins.standardExpiresAt != null) currentUser.standardExpiresAt = coins.standardExpiresAt;
      if (coins.standardSource != null) currentUser.standardSource = coins.standardSource;
      if (coins.tier != null) {
        currentUser.tier = coins.tier;
        currentUser.plan = coins.tier;
        currentUser.membershipRole = coins.tier;
        currentUser.subscriptionPlan = coins.tier;
      }
      persistCurrentUserToStorage();
      updatePremiumUi();
    }
  } catch {
    /* offline / stale token */
  }
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
    await apiFetch("/api/coins/invite/bind", {
      method: "POST",
      body: JSON.stringify({ referralCode: pending })
    });
    sessionStorage.removeItem("aiNotesPendingInvite");
    const data = await apiFetch("/api/premium/status");
    mergePremiumStatusIntoCurrentUser(data);
    persistCurrentUserToStorage();
    updatePremiumUi();
  } catch (err) {
    const status = err && Number(err.status);
    if (status === 400 || status === 404 || status === 409) {
      try {
        sessionStorage.removeItem("aiNotesPendingInvite");
      } catch {
        /* ignore */
      }
    }
    /* ignore — invalid invite, existing user, or offline */
  }
}

/**
 * Refreshes subscription fields from the server. Callers that gate paid features
 * should treat `false` as "cannot confirm access" and deny (avoids stale localStorage tiers).
 * @returns {Promise<boolean>} true if `/api/premium/status` succeeded
 */
async function mergePremiumFromServer() {
  if (!currentUser || !accessToken || authInvalidated) return false;
  if (mergePremiumFromServerInflight) return mergePremiumFromServerInflight;
  mergePremiumFromServerInflight = (async () => {
    try {
      const data = await apiFetch("/api/premium/status");
      mergePremiumStatusIntoCurrentUser(data);
      persistCurrentUserToStorage();
      updatePremiumUi();
      await tryConsumePendingInviteCode();
      await tryQuietCoinsBootstrap();
      maybeShowTrialGiftWelcome();
      return true;
    } catch {
      return false;
    } finally {
      mergePremiumFromServerInflight = null;
    }
  })();
  return mergePremiumFromServerInflight;
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
  /** Trial copy is bundled into the first-time welcome sheet — avoid stacking two overlays. */
  if (currentUser.hasSeenTutorial === false) return;
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

/** After welcome closes for trial users, suppress the standalone trial gift popup. */
function markTrialGiftAnnounceIfNeeded() {
  if (!currentUser || currentUser.lifecycle !== "trial") return;
  try {
    localStorage.setItem(trialGiftDismissStorageKey(), "1");
  } catch {
    /* ignore */
  }
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
  const paid =
    Boolean(currentUser) &&
    typeof hasStandardAccess === "function" &&
    hasStandardAccess(currentUser);
  webChatBtn.classList.toggle("menu-item--locked", Boolean(currentUser) && !paid);
  if (paid) {
    webChatBtn.removeAttribute("title");
    webChatBtn.removeAttribute("aria-label");
  } else if (currentUser) {
    const tip = typeof t === "function" ? t("webChatRequiresStandard") : "Web Chat needs Standard.";
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
  return "chatbot";
}

function setWebChatMode(_mode) {
  try {
    localStorage.setItem(WEB_CHAT_MODE_KEY, "chatbot");
  } catch {
    /* ignore */
  }
  return "chatbot";
}

function webChatModelCanUseMode(value) {
  return value === "chatbot";
}

function syncWebChatModelSelectorUi() {
  setWebChatMode("chatbot");
  syncWebChatModePresentation("chatbot", false);
}

function setWebChatTranslatableText(el, key) {
  if (!el) return;
  el.setAttribute("data-t", key);
  el.textContent = t(key);
}

function syncWebChatModePresentation(_modeValue, _aiLive) {
  const page = document.getElementById("webChat");
  const titleEl = document.querySelector(".web-chat-messenger__title");
  const statusEl = document.querySelector(
    ".web-chat-messenger__status span[data-t], .web-chat-messenger__status span:not(.web-chat-messenger__status-dot)"
  );
  if (!page || !titleEl || !statusEl) return;
  page.classList.remove("web-chat-page--mode-auto", "web-chat-page--mode-openai", "web-chat-page--ai-live");
  page.classList.add("web-chat-page--mode-chatbot");

  const messenger = page.querySelector(".web-chat-messenger.chat-container");
  if (messenger) {
    messenger.classList.remove("auto-mode", "openai-mode");
    messenger.classList.add("chat-bot-mode");
  }

  const titleTextEl = titleEl.querySelector(".web-chat-messenger__title-text") || titleEl;
  setWebChatTranslatableText(titleTextEl, "webChatTitleChatbot");
  setWebChatTranslatableText(statusEl, "webChatOnlineStatus");
  refreshWebChatWelcomeForMode("chatbot");
}

function webChatModelDismissLockBanner() {
  /* lock banner removed — chatbot only */
}

function webChatModelShowLockBanner() {
  /* chatbot only */
}

function webChatModelSyncPopoverState() {
  /* mode pills removed — chatbot only */
}

function webChatDismissPremiumTabTooltip() {
  if (window.__webChatPremiumTabTooltipHideTimer) {
    clearTimeout(window.__webChatPremiumTabTooltipHideTimer);
    window.__webChatPremiumTabTooltipHideTimer = null;
  }
  const el = window.__webChatPremiumTabTooltipEl;
  if (el && el.parentNode) {
    el.classList.remove("is-visible");
    try {
      el.parentNode.removeChild(el);
    } catch (_) {
      /* ignore */
    }
  }
  window.__webChatPremiumTabTooltipEl = null;
}

function webChatShowPremiumTabTooltip(anchor) {
  if (!anchor || !document.body) return;
  webChatDismissPremiumTabTooltip();
  const tip = document.createElement("div");
  tip.className = "web-chat-premium-tab-tooltip";
  tip.setAttribute("role", "status");
  tip.textContent = typeof t === "function" ? t("webChatPremiumTabTooltip") : "Switch to Standard for this option.";
  document.body.appendChild(tip);
  window.__webChatPremiumTabTooltipEl = tip;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 10;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  let w = tip.offsetWidth || tip.getBoundingClientRect().width;
  let h = tip.offsetHeight || tip.getBoundingClientRect().height;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, vw - w - margin));
  let top = rect.top - h - gap;
  if (top < margin) top = rect.bottom + gap;
  tip.style.left = "0";
  tip.style.top = "0";
  tip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  requestAnimationFrame(() => tip.classList.add("is-visible"));
  window.__webChatPremiumTabTooltipHideTimer = window.setTimeout(webChatDismissPremiumTabTooltip, 2600);
}

function webChatModelSelectOption(_ev, _value) {
  /* chatbot only — no mode switching */
}

function syncWebChatSoftPaywallUi() {
  const hint = document.getElementById("webChatSoftLockHint");
  const quotaEl = document.getElementById("webChatFreeQuotaHint");
  const input = document.getElementById("webChatInput");
  const sendBtn = document.querySelector(".web-chat-send");
  syncWebChatModelSelectorUi();
  if (!hint) return;
  const paid =
    Boolean(currentUser) &&
    typeof hasStandardAccess === "function" &&
    hasStandardAccess(currentUser);
  if (quotaEl) quotaEl.classList.add("hidden");
  if (paid || !currentUser) {
    hint.classList.add("hidden");
    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    return;
  }
  hint.classList.remove("hidden");
  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
}

function updatePremiumUi() {
  if (authBootstrapPhaseActive) return;
  syncPremiumGatedNav();
  syncDailyPlannerAccessUi();
  syncWebChatSoftPaywallUi();
  const upsell = document.getElementById("premiumMarketingPanel") || document.getElementById("premiumWhatsAppUpsell");
  const guestStrip = document.getElementById("botGuestStrip");
  if (!upsell) return;

  upsell.classList.remove("hidden");

  if (!currentUser) {
    if (guestStrip) guestStrip.classList.remove("hidden");
    return;
  }

  if (guestStrip) guestStrip.classList.add("hidden");
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

async function premiumPlanCoinsActivate(tier, billingOverride) {
  if (tier !== "standard") return;
  if (!currentUser || !accessToken) {
    showToast(t("premiumCheckoutLoginRequired"));
    openAccountModal();
    return;
  }
  const billing =
    billingOverride === "yearly" || billingOverride === "monthly"
      ? billingOverride
      : premiumLiteBillingMode === "yearly"
        ? "yearly"
        : "monthly";
  let coinsStatus = null;
  try {
    coinsStatus = await apiFetch("/api/coins/status");
  } catch {
    coinsStatus = null;
  }
  const monthlyCost = Number(coinsStatus && coinsStatus.standardMonthlyCoinCost) || 1500;
  const yearlyCost = Number(coinsStatus && coinsStatus.standardYearlyCoinCost) || 14400;
  const cost = billing === "yearly" ? yearlyCost : monthlyCost;
  const days = billing === "yearly" ? 365 : 30;
  const balance = Number(coinsStatus && coinsStatus.balance) || Number(currentUser.coins) || 0;
  if (balance < cost) {
    showToast(
      typeof t === "function"
        ? t("coinsInsufficientForPlan").replace("{cost}", String(cost)).replace("{balance}", String(balance))
        : `Need ${cost} coins (you have ${balance}).`
    );
    void openCoinsRewards();
    return;
  }
  const msg =
    typeof t === "function"
      ? t("coinsRedeemConfirmPlan").replace("{cost}", String(cost)).replace("{days}", String(days))
      : `Spend ${cost} coins for ${days} days of Standard?`;
  if (typeof window !== "undefined" && window.confirm && !window.confirm(msg)) return;
  try {
    await apiFetch("/api/coins/redeem-standard", {
      method: "POST",
      body: JSON.stringify({ plan: billing })
    });
    showToast(typeof t === "function" ? t("coinsRedeemSuccess") : "Standard unlocked.");
    await mergePremiumFromServer();
    await refreshCoinsHubUi();
    updatePremiumUi();
    syncPremiumGatedNav();
    goHome();
  } catch (e) {
    if (e && e.status === 409) {
      showToast(typeof t === "function" ? t("coinsRedeemAlreadyActive") : e.message);
    } else {
      showToast(e && e.message ? e.message : typeof t === "function" ? t("coinsActionFailed") : "Failed.");
    }
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
    const checkout = params.get("checkout");
    if (!checkout) return;
    const cleanUrl = `/${window.location.hash || ""}`;
    window.history.replaceState({}, "", cleanUrl);
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
    void openCoinsRewards();
    showToast(
      typeof t === "function"
        ? t("premiumBillingCoinsOnly")
        : "Standard uses coins only — open Rewards & coins to earn or redeem."
    );
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

function clearCurrentUser() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("currentUser");
  sessionStorage.removeItem("accessToken");
  sessionStorage.removeItem("refreshToken");
  sessionStorage.removeItem("currentUser");
  sessionStorage.removeItem("oauth_handoff_tried");
  sessionStorage.removeItem(OAUTH_GOOGLE_RETURN_PENDING_KEY);
  sessionStorage.removeItem(OAUTH_HANDOFF_SESSION_DONE_KEY);
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
  return (await refreshAccessTokenSingleton()) === "ok";
}

/**
 * @returns {Promise<"ok" | "invalid" | "network" | "no_refresh">}
 */
async function refreshAccessTokenSingleton() {
  if (refreshAccessTokenPromise) return refreshAccessTokenPromise;
  refreshAccessTokenPromise = (async () => {
    const rt = refreshToken || getStoredRefreshToken();
    if (!rt) return "no_refresh";
    let res;
    try {
      res = await fetch(buildApiUrl("/api/refresh"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt })
      });
    } catch {
      return "network";
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 401) {
      invalidateAuthSessionSilently();
      return "invalid";
    }
    if (!res.ok || !data.accessToken) {
      invalidateAuthSessionSilently();
      return "invalid";
    }
    authInvalidated = false;
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
    return "ok";
  })().finally(() => {
    refreshAccessTokenPromise = null;
  });
  return refreshAccessTokenPromise;
}

function hasAnyAuthCredential() {
  return Boolean(accessToken || refreshToken || getStoredAccessToken() || getStoredRefreshToken());
}

function pathExpectsBearerAuth(pathRaw) {
  const path = String(pathRaw || "").split("?")[0];
  if (!path.startsWith("/api/")) return false;
  if (path.startsWith("/api/public/")) return false;
  if (path === "/api/push/public-key") return false;
  if (path.startsWith("/api/auth/")) return false;
  if (path.startsWith("/api/verify-email")) return false;
  const noAuthExact = new Set(["/api/login", "/api/register", "/api/refresh", "/api/contact"]);
  if (noAuthExact.has(path)) return false;
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
    path === "/api/auth/complete-google-signup" ||
    path === "/api/auth/oauth-handoff";

  if (pathExpectsBearerAuth(path) && authInvalidated && !isRetry) {
    const skip = new Error("Not authenticated");
    skip.status = 401;
    skip.authSkipped = true;
    throw skip;
  }

  if (pathExpectsBearerAuth(path) && !isRetry && !hasAnyAuthCredential()) {
    const skip = new Error("Not authenticated");
    skip.status = 401;
    skip.authSkipped = true;
    throw skip;
  }

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

    if (response.status === 401 && !isRetry && !skipAuthRefresh) {
      const ro = await refreshAccessTokenSingleton();
      if (ro === "ok") {
        return apiFetch(path, options, true);
      }
      if (ro === "invalid") {
        const err = new Error(data.error || data.message || "Session expired");
        err.status = 401;
        err.authSessionEnded = true;
        throw err;
      }
      if (ro === "no_refresh") {
        invalidateAuthSessionSilently();
        const err = new Error(data.error || data.message || "Unauthorized");
        err.status = 401;
        err.authSessionEnded = true;
        throw err;
      }
      const err = new Error(data.error || data.message || "Unauthorized");
      err.status = 401;
      err.refreshNetworkError = true;
      throw err;
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

/* —— Offline notes: local cache + mutation queue, sync when back online —— */
const OFFLINE_NOTES_QUEUE_PREFIX = "aiNotesOfflineNoteQueue:";
const OFFLINE_NOTES_CACHE_PREFIX = "aiNotesOfflineNotesCache:";

function isBrowserOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function isOfflineOrNetworkError(err) {
  if (!err || typeof err.message !== "string") return false;
  const m = err.message.toLowerCase();
  return m.includes("network error") || m.includes("failed to fetch") || m.includes("timed out");
}

function offlineMakeTempNoteId() {
  return `offline-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function offlineNotesCategoryNorm(note) {
  const c = note && note.category != null ? String(note.category).trim() : "";
  return c || "__uncategorized__";
}

function offlineNotesQueueKey() {
  return currentUser && currentUser.id != null ? `${OFFLINE_NOTES_QUEUE_PREFIX}${String(currentUser.id)}` : null;
}

function offlineNotesSnapshotKey() {
  return currentUser && currentUser.id != null ? `${OFFLINE_NOTES_CACHE_PREFIX}${String(currentUser.id)}` : null;
}

function offlineNotesDedupeById(notes) {
  const m = new Map();
  for (const n of notes || []) {
    if (!n || n._id == null) continue;
    m.set(String(n._id), n);
  }
  return [...m.values()];
}

function offlineNotesReadSnapshot() {
  const key = offlineNotesSnapshotKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    return {
      allNotes: Array.isArray(o.allNotes) ? o.allNotes : [],
      byCategory: o.byCategory && typeof o.byCategory === "object" ? o.byCategory : {}
    };
  } catch {
    return null;
  }
}

function offlineNotesWriteSnapshot(snap) {
  const key = offlineNotesSnapshotKey();
  if (!key || !snap) return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ allNotes: snap.allNotes || [], byCategory: snap.byCategory || {} })
    );
  } catch {
    /* quota */
  }
}

function offlineNotesRebuildByCategory(snap) {
  const byCat = {};
  for (const n of snap.allNotes || []) {
    const ck = offlineNotesCategoryNorm(n);
    if (!byCat[ck]) byCat[ck] = [];
    byCat[ck].push(n);
  }
  snap.byCategory = byCat;
}

function offlineNotesRecordSuccessfulLoadAll(mergedAllNotes) {
  const snap = offlineNotesReadSnapshot() || { allNotes: [], byCategory: {} };
  snap.allNotes = offlineNotesDedupeById(mergedAllNotes || []);
  offlineNotesRebuildByCategory(snap);
  offlineNotesWriteSnapshot(snap);
}

function offlineNotesRecordSuccessfulCategoryLoad(categoryKey, list) {
  const snap = offlineNotesReadSnapshot() || { allNotes: [], byCategory: {} };
  const filtered = (snap.allNotes || []).filter((n) => offlineNotesCategoryNorm(n) !== String(categoryKey));
  snap.allNotes = offlineNotesDedupeById([...(list || []), ...filtered]);
  offlineNotesRebuildByCategory(snap);
  offlineNotesWriteSnapshot(snap);
}

function offlineNotesPickCategoryList(categoryKey) {
  const snap = offlineNotesReadSnapshot();
  if (!snap) return null;
  const ck = String(categoryKey);
  if (snap.byCategory && Array.isArray(snap.byCategory[ck])) return snap.byCategory[ck];
  return (snap.allNotes || []).filter((n) => offlineNotesCategoryNorm(n) === ck);
}

function offlineNotesReadQueue() {
  const k = offlineNotesQueueKey();
  if (!k) return [];
  try {
    const raw = localStorage.getItem(k);
    const q = raw ? JSON.parse(raw) : [];
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function offlineNotesWriteQueue(q) {
  const k = offlineNotesQueueKey();
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(q || []));
  } catch {
    /* ignore */
  }
  syncOfflineIndicatorUi();
}

function offlineNotesEnqueue(op) {
  const k = offlineNotesQueueKey();
  if (!k) return;
  const q = offlineNotesReadQueue();
  q.push({
    ...op,
    qid: `${Date.now()}-${Math.random().toString(16).slice(2)}`
  });
  offlineNotesWriteQueue(q);
}

function offlineNotesPatchQueuedCreate(tempId, text, title) {
  const q = offlineNotesReadQueue();
  for (const o of q) {
    if (o.op === "create" && o.tempId === tempId) {
      o.text = text;
      o.title = title || "";
      break;
    }
  }
  offlineNotesWriteQueue(q);
}

function offlineNotesDropQueueOpsForNoteId(noteId) {
  const id = String(noteId);
  const q = offlineNotesReadQueue().filter((o) => {
    if (o.op === "create" && o.tempId === id) return false;
    if ((o.op === "update" || o.op === "delete") && o.noteId === id) return false;
    return true;
  });
  offlineNotesWriteQueue(q);
}

function offlineNotesRemapQueueIds(q, idMap) {
  return q.map((o) => {
    if ((o.op === "update" || o.op === "delete") && idMap.has(o.noteId))
      return { ...o, noteId: idMap.get(o.noteId) };
    return o;
  });
}

function offlineNotesReplaceTempNoteInMemory(tempId, serverNote) {
  const tid = String(tempId);
  const rep = (arr) =>
    Array.isArray(arr) ? arr.map((n) => (String(n._id) === tid ? serverNote : n)) : arr;
  allNotes = rep(allNotes);
  currentNotes = rep(currentNotes);
}

function offlineNotesReplaceNoteInMemory(noteId, serverNote) {
  const id = String(noteId);
  const rep = (arr) =>
    Array.isArray(arr) ? arr.map((n) => (String(n._id) === id ? serverNote : n)) : arr;
  allNotes = rep(allNotes);
  currentNotes = rep(currentNotes);
}

function offlineNotesRemoveNoteInMemory(noteId) {
  const id = String(noteId);
  allNotes = (allNotes || []).filter((n) => String(n._id) !== id);
  currentNotes = (currentNotes || []).filter((n) => String(n._id) !== id);
}

function offlineNotesReplaceTempInSnapshot(tempId, serverNote) {
  const snap = offlineNotesReadSnapshot();
  if (!snap) return;
  snap.allNotes = (snap.allNotes || []).map((n) => (String(n._id) === String(tempId) ? serverNote : n));
  offlineNotesRebuildByCategory(snap);
  offlineNotesWriteSnapshot(snap);
}

function offlineNotesReplaceNoteInSnapshot(noteId, serverNote) {
  const snap = offlineNotesReadSnapshot();
  if (!snap) return;
  const id = String(noteId);
  snap.allNotes = (snap.allNotes || []).map((n) => (String(n._id) === id ? serverNote : n));
  offlineNotesRebuildByCategory(snap);
  offlineNotesWriteSnapshot(snap);
}

function offlineNotesRemoveNoteInSnapshot(noteId) {
  const snap = offlineNotesReadSnapshot();
  if (!snap) return;
  const id = String(noteId);
  snap.allNotes = (snap.allNotes || []).filter((n) => String(n._id) !== id);
  offlineNotesRebuildByCategory(snap);
  offlineNotesWriteSnapshot(snap);
}

function syncOfflineIndicatorUi() {
  const badge = document.getElementById("appOfflineBadge");
  if (!badge) return;
  const pending = offlineNotesReadQueue().length;
  const offline = !isBrowserOnline();
  if (!offline && !pending) {
    badge.classList.add("hidden");
    badge.textContent = "";
    return;
  }
  badge.classList.remove("hidden");
  const parts = [];
  if (offline) parts.push(typeof t === "function" ? t("offlineModeShort") : "Offline");
  if (pending)
    parts.push(
      typeof t === "function"
        ? t("offlinePendingSync").replace("{n}", String(pending))
        : `${pending} pending`
    );
  badge.textContent = parts.join(" · ");
}

async function offlineNotesFlushQueue() {
  if (!isBrowserOnline() || !currentUser || !currentUser.id || !accessToken) return;
  const k = offlineNotesQueueKey();
  if (!k) return;
  let q = offlineNotesReadQueue();
  if (!q.length) {
    syncOfflineIndicatorUi();
    return;
  }
  const idMap = new Map();
  let mutated = false;
  while (q.length) {
    const op = q[0];
    try {
      if (op.op === "create") {
        const data = await apiFetch("/api/notes", {
          method: "POST",
          body: JSON.stringify({
            category: op.category,
            text: op.text,
            title: op.title || ""
          })
        });
        const note = data && data.note;
        if (note && note._id) {
          idMap.set(op.tempId, String(note._id));
          offlineNotesReplaceTempNoteInMemory(op.tempId, note);
          offlineNotesReplaceTempInSnapshot(op.tempId, note);
        }
        q = offlineNotesRemapQueueIds(q.slice(1), idMap);
        mutated = true;
      } else if (op.op === "update") {
        let nid = op.noteId;
        if (idMap.has(nid)) nid = idMap.get(nid);
        if (String(nid).startsWith("offline-")) break;
        const data = await apiFetch(`/api/notes/${encodeURIComponent(String(nid))}`, {
          method: "PUT",
          body: JSON.stringify({ text: op.text, title: op.title || "" })
        });
        if (data && data.note && data.note._id) {
          offlineNotesReplaceNoteInMemory(String(data.note._id), data.note);
          offlineNotesReplaceNoteInSnapshot(String(data.note._id), data.note);
        }
        q = offlineNotesRemapQueueIds(q.slice(1), idMap);
        mutated = true;
      } else if (op.op === "delete") {
        let nid = op.noteId;
        if (idMap.has(nid)) nid = idMap.get(nid);
        if (String(nid).startsWith("offline-")) {
          q = offlineNotesRemapQueueIds(q.slice(1), idMap);
          mutated = true;
          continue;
        }
        await apiFetch(`/api/notes/${encodeURIComponent(String(nid))}`, { method: "DELETE" });
        offlineNotesRemoveNoteInMemory(String(nid));
        offlineNotesRemoveNoteInSnapshot(String(nid));
        q = offlineNotesRemapQueueIds(q.slice(1), idMap);
        mutated = true;
      } else {
        q = q.slice(1);
      }
    } catch (e) {
      if (isOfflineOrNetworkError(e)) break;
      if (typeof showToast === "function") showToast((e && e.message) || "Sync failed");
      break;
    }
  }
  offlineNotesWriteQueue(q);
  if (mutated) {
    try {
      if (currentCategory) await loadNotes();
    } catch {
      /* ignore */
    }
    try {
      await loadMyNotes();
    } catch {
      /* ignore */
    }
    if (typeof showToast === "function" && !q.length)
      showToast(typeof t === "function" ? t("offlineSyncComplete") : "Synced");
  }
  syncOfflineIndicatorUi();
}

function isChooseUsernamePath() {
  const p = (window.location.pathname || "").replace(/\/$/, "") || "/";
  return /(^|\/)choose-username\/?$/.test(p);
}

let chooseUsernameInitStarted = false;

/** When true, guest user intentionally opened the login/sign-up overlay (sidebar Account / requireAuth). */
let authLoginModalOpen = false;

/** True during blocking auth bootstrap (storage + optional oauth handoff); UI updates must no-op. */
let authBootstrapPhaseActive = false;

/** After quiet OAuth persist during bootstrap, run welcome / goHome once the shell is visible. */
let pendingPostOAuthPresentation = false;

function refreshClientAuthFromStorage() {
  currentUser = getStoredUser();
  accessToken = getStoredAccessToken();
  refreshToken = getStoredRefreshToken();
  authInvalidated = false;
}

function isAuthSessionReady() {
  return Boolean(
    accessToken &&
      refreshToken &&
      currentUser &&
      typeof currentUser === "object" &&
      (currentUser.username || currentUser.email || currentUser.emailOrPhone || currentUser._id)
  );
}

/**
 * After tokens are in storage, ensure we have a user object (from storage or /api/me + refresh).
 * Prevents “dashboard with no user” and clears dead tokens.
 */
async function hydrateSessionUserFromTokens() {
  if (!accessToken || !refreshToken) return false;

  if (
    currentUser &&
    typeof currentUser === "object" &&
    (currentUser.username || currentUser.email || currentUser.emailOrPhone || currentUser._id)
  ) {
    return true;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await apiFetch("/api/me", { method: "GET" });
      if (data && data.user) {
        const remember = Boolean(localStorage.getItem("refreshToken"));
        storeCurrentUser(data.user, accessToken, refreshToken, remember, { skipUi: true });
        return true;
      }
    } catch {
      /* retry path below */
    }
    if (attempt === 0) {
      const refreshed = await tryRefreshAccessToken();
      if (!refreshed) break;
    }
  }
  return false;
}

/** SPA home lives at `/`. Legacy `/dashboard` and removed `/set-password` entry URLs → `/`. */
function normalizeSpaShellPaths() {
  const path = (window.location.pathname || "").replace(/\/+$/, "") || "/";
  if (path === "/set-password") {
    history.replaceState(null, "", "/" + (window.location.search || ""));
    return;
  }
  if (path === "/dashboard" && isAuthSessionReady()) {
    history.replaceState(null, "", "/" + (window.location.search || ""));
  }
}

function syncAuthShellVisibility() {
  if (authBootstrapPhaseActive) return;
  const landing = document.getElementById("authLanding");
  const choose = document.getElementById("chooseUsernameScreen");
  const appEl = document.querySelector(".app");
  const footer = document.querySelector(".site-footer");
  const fab = document.getElementById("dailyPlannerFab");
  const loggedIn = Boolean(currentUser && accessToken);

  if (loggedIn) {
    authLoginModalOpen = false;
    landing?.classList.add("hidden");
    choose?.classList.add("hidden");
    appEl?.classList.remove("hidden");
    footer?.classList.remove("hidden");
    if (fab) fab.classList.remove("hidden");
    document.body.classList.remove("auth-shell-locked");
    return;
  }

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
  /** OAuth must start on API origin (`API_BASE_URL`), never the WebView / Vercel origin. */
  let href = backendAbsoluteUrl("/auth/google");
  if (typeof isNativeApp === "function" && isNativeApp()) {
    href += href.includes("?") ? "&native=1" : "?native=1";
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
  if (typeof maybeShowTrialGiftWelcome === "function") maybeShowTrialGiftWelcome();
  void offlineNotesFlushQueue();
  void mergePremiumFromServer().then(() => {
    displayAccountInfo();
    void updateHomeDashboardStats();
  });
  startWebNotificationScheduler();
  ensureOfflineNotesFlushInterval();
  scheduleDailyPlannerMidnightReset();
  scheduleDailyPlannerNotificationLoop();
  scheduleWebChatFabPromptCycle();
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
  if (document.documentElement.dataset.authLandingUiBound === "1") return;
  document.documentElement.dataset.authLandingUiBound = "1";
  syncAuthGoogleLinkHref();
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
  const landing = document.getElementById("authLanding");
  landing?.addEventListener("click", (e) => {
    if (e.target === landing) closeAccountModal();
  });
  document.querySelectorAll("a.auth-google-link").forEach((g) => {
    g.addEventListener("click", async (ev) => {
      markGoogleOAuthFlowDeparting();
      if (googleOAuthConfigLoaded && !googleOAuthClientId) {
        console.warn(
          "[Google sign-in] Public client id missing from app-config — still navigating to backend OAuth. " +
            "Ensure GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL are set on the server."
        );
      }
      if (typeof isNativeApp === "function" && isNativeApp()) {
        ev.preventDefault();
        const hrefRaw = String((g.getAttribute("href") || "").trim() || backendAbsoluteUrl("/auth/google"));
        let url = hrefRaw;
        try {
          const u = new URL(hrefRaw);
          u.searchParams.set("native", "1");
          url = u.toString();
        } catch {
          url = hrefRaw.includes("native=1") ? hrefRaw : `${hrefRaw}${hrefRaw.includes("?") ? "&" : "?"}native=1`;
        }
        try {
          const Browser = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
          if (Browser && typeof Browser.open === "function") {
            await Browser.open({ url });
          } else {
            window.open(url, "_blank");
          }
        } catch (err) {
          console.warn("[Google sign-in] Browser.open failed:", err);
          window.open(url, "_blank");
        }
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
    let inviteFromLink = "";
    try {
      inviteFromLink = String(sessionStorage.getItem("aiNotesPendingInvite") || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    } catch {
      inviteFromLink = "";
    }
    const signupBody =
      inviteFromLink.length >= 4
        ? { username, deviceId, referralCode: inviteFromLink }
        : { username, deviceId };
    const data = await apiFetch("/api/auth/complete-google-signup", {
      method: "POST",
      body: JSON.stringify(signupBody)
    });
    storeCurrentUser(data.user, data.accessToken, data.refreshToken, true);
    chooseUsernameInitStarted = false;
    history.replaceState(null, "", "/");
    syncAuthShellVisibility();
    showToast(`Welcome, ${data.user.username}`);
    goHome();
    refreshReminderRelatedViews();
    if (typeof maybeShowTrialGiftWelcome === "function") maybeShowTrialGiftWelcome();
    void offlineNotesFlushQueue();
    void mergePremiumFromServer().then(() => {
      displayAccountInfo();
      void updateHomeDashboardStats();
    });
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
  if (authBootstrapPhaseActive) return;
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
  lastAllNotesRenderKey = "";
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
  lastCategoryNotesRenderKey = "";
  activateMenu("");
  const categoryPage = document.getElementById("category");
  if (categoryPage) categoryPage.dataset.activeCategory = cat;
  document.getElementById("home").classList.add("hidden");
  if (categoryPage) categoryPage.classList.remove("hidden");
  document.getElementById("notes-all").classList.add("hidden");
  document.getElementById("bot").classList.add("hidden");
  closeWebChatDrawer();
  document.getElementById("reminder-history").classList.add("hidden");
  document.getElementById("settings").classList.add("hidden");
  hideScanCamPage();
  hideCoinsHubPage();
  document.getElementById("catTitle").innerText = getCategoryDisplayLabel(cat);
  const scanBanner = document.getElementById("scanCamCategoryBanner");
  if (scanBanner) scanBanner.classList.toggle("hidden", cat !== "scan_cam" || !currentUser);

  const categoryAddBtn = document.getElementById("categoryAddNoteBtn");
  const categoryScanBtn = document.getElementById("categoryScanCamBtn");
  if (categoryAddBtn && categoryScanBtn) {
    const isScanCam = cat === "scan_cam";
    categoryAddBtn.classList.toggle("hidden", isScanCam);
    categoryScanBtn.classList.toggle("hidden", !isScanCam);
  }

  if (cat === "scan_cam") {
    bindScanCamListScrollGuard();
  }

  if (currentUser) {
    const runLoad = () => void loadNotes();
    if (cat === "scan_cam") {
      requestAnimationFrame(() => requestAnimationFrame(runLoad));
    } else {
      requestAnimationFrame(runLoad);
    }
  } else {
    requestAnimationFrame(() => renderNotes(getPublicNotes()));
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
  ensurePremiumLiteUiInitialized();
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
  document.body.classList.add("coins-hub-open");
  applyTranslations();
  await refreshCoinsHubUi();
}

function coinsHubEnsureStreakDelegate() {
  const grid = document.getElementById("coinsHubStreakGrid");
  if (!grid || grid.dataset.coinsStreakDelegated === "1") return;
  grid.dataset.coinsStreakDelegated = "1";
  grid.addEventListener("click", (ev) => {
    const slot = ev.target.closest(".daily-checkin-slot--claim");
    if (!slot || !grid.contains(slot)) return;
    ev.preventDefault();
    void coinsHubClaimDaily();
  });
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
  const base =
    typeof getPublicAppOrigin === "function"
      ? getPublicAppOrigin()
      : typeof PUBLIC_APP_ORIGIN === "string" && PUBLIC_APP_ORIGIN
        ? PUBLIC_APP_ORIGIN
        : window.location.origin.replace(/\/+$/, "");
  return `${base}/invite/${encodeURIComponent(code)}`;
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
  const streakGridEl = document.getElementById("coinsHubStreakGrid");
  const clearStreakGrid = () => {
    if (streakGridEl) streakGridEl.innerHTML = "";
  };

  let premiumOk = true;
  if (currentUser && accessToken) {
    premiumOk = await mergePremiumFromServer();
    if (!premiumOk) {
      /* Still load coins — rewards API is independent of premium/status blips */
    }
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
  const trialBan = document.getElementById("coinsHubTrialBanner");
  const trialText = document.getElementById("coinsHubTrialText");
  const btnVideo = document.getElementById("coinsHubVideoBtn");
  const videoLbl = document.getElementById("coinsHubVideoBtnLabel");
  const linkInput = document.getElementById("coinsHubInviteLinkInput");
  const inviteStatsLine = document.getElementById("coinsHubInviteStatsLine");
  const multEl = document.getElementById("coinsHubEarnMult");
  const videoMeta = document.getElementById("coinsHubVideoCooldown");
  const videoRowMeta = document.getElementById("coinsHubVideoRowMeta");

  if (!coins || coins.cap == null) {
    clearStreakGrid();
    if (balEl) balEl.textContent = "0";
    if (!premiumOk) {
      showToast(typeof t === "function" ? t("coinsHubUpdateFailed") : "Could not refresh your plan.");
    }
    return;
  }

  const balance = Number(coins.balance) || 0;
  const cap = Number(coins.cap) || 15000;
  const vReward = coins.videoRewards && coins.videoRewards.rewardEach != null ? Number(coins.videoRewards.rewardEach) : 10;
  const codeStr =
    coins.referralCode && String(coins.referralCode).trim() ? String(coins.referralCode).trim() : "";
  const inviteUrl = coinsHubBuildInviteUrl(codeStr);
  if (currentUser && codeStr) {
    currentUser.referralCode = codeStr;
    persistCurrentUserToStorage();
  }

  coinsHubApplyStreakUi(coins);

  if (balEl) balEl.textContent = String(balance);
  if (capDisplay) capDisplay.textContent = String(cap);
  const capPct = cap ? Math.min(100, (balance / cap) * 100) : 0;
  if (capFill) capFill.style.width = `${capPct}%`;
  if (walletLabel && typeof t === "function") {
    walletLabel.textContent = t("coinsDashWalletProgress").replace("{b}", String(balance)).replace("{cap}", String(cap));
  }

  const claimedToday = Boolean(coins.dailyLogin && coins.dailyLogin.claimedToday);
  const videoPassive = Boolean(coins.videoRewards && coins.videoRewards.passive);
  if (videoLbl && typeof t === "function") {
    videoLbl.textContent = videoPassive ? t("coinsHubVideoSoon") : t("coinsHubVideoGo");
  }
  if (videoRowMeta && typeof t === "function") {
    if (videoPassive) {
      videoRowMeta.textContent = t("coinsHubVideoRowMetaPassive");
    } else if (coins.videoRewards) {
      const cnt = Number(coins.videoRewards.countToday) || 0;
      const maxv = Number(coins.videoRewards.maxToday) || 0;
      videoRowMeta.textContent = t("coinsHubVideoRowMeta")
        .replace("{n}", String(cnt))
        .replace("{max}", String(maxv))
        .replace("{reward}", String(vReward));
    } else {
      videoRowMeta.textContent = "";
    }
  } else if (videoRowMeta) {
    videoRowMeta.textContent = "";
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
    if (videoPassive) {
      btnVideo.disabled = true;
      btnVideo.classList.add("coins-hub-task__go--disabled");
    } else {
      const vCap = Boolean(coins.videoRewards && coins.videoRewards.countToday >= coins.videoRewards.maxToday);
      btnVideo.disabled = vCap;
      btnVideo.classList.toggle("coins-hub-task__go--disabled", vCap);
    }
  }
  if (videoMeta && typeof t === "function") {
    if (videoPassive) {
      videoMeta.textContent = t("coinsHubVideoFootPassive");
    } else {
      const capHit = Boolean(coins.videoRewards && coins.videoRewards.countToday >= coins.videoRewards.maxToday);
      videoMeta.textContent = capHit ? t("coinsHubVideoCappedFoot") : "";
    }
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

  if (!premiumOk) {
    showToast(typeof t === "function" ? t("coinsHubUpdateFailed") : "Could not refresh your plan.");
  }
}

let coinsHubDailyClaimInFlight = false;

async function coinsHubClaimDaily() {
  if (!requireAuth("collect rewards")) return;
  if (coinsHubDailyClaimInFlight) return;
  coinsHubDailyClaimInFlight = true;
  try {
    let cur = document.querySelector("#coinsHubStreakGrid .daily-checkin-slot--claim");
    let claimedDay = cur ? Number(cur.getAttribute("data-day")) : null;

    if (!cur) {
      await refreshCoinsHubUi();
      cur = document.querySelector("#coinsHubStreakGrid .daily-checkin-slot--claim");
      claimedDay = cur ? Number(cur.getAttribute("data-day")) : null;
    }

    if (!cur) {
      showToast(typeof t === "function" ? t("coinsHubDailyNotAvailable") : "No reward is ready.");
      return;
    }

    try {
      await apiFetch("/api/coins/daily-login", { method: "POST", body: JSON.stringify({}) });
    } catch (e) {
      const st = e && e.status;
      if (st === 409) {
        await refreshCoinsHubUi();
        return;
      }
      showToast(e && e.message ? e.message : typeof t === "function" ? t("coinsActionFailed") : "Request failed.");
      return;
    }

    await refreshCoinsHubUi();
    coinsHubPulseHero();
    if (claimedDay != null && Number.isFinite(claimedDay)) coinsHubAnimateClaimedDay(claimedDay);
  } finally {
    coinsHubDailyClaimInFlight = false;
  }
}

async function coinsHubWatchVideoAd() {
  if (!requireAuth("watch rewarded ads")) return;
  try {
    await apiFetch("/api/coins/rewarded-ad", { method: "POST", body: JSON.stringify({}) });
    showToast(typeof t === "function" ? t("coinsVideoRewardSuccess") : "+10 coins added.");
    await refreshCoinsHubUi();
    coinsHubPulseHero();
  } catch (e) {
    const code = e && e.code ? String(e.code) : "";
    if (code === "VIDEO_CAP" || (e && e.status === 429)) {
      showToast(typeof t === "function" ? t("coinsHubVideoCappedFoot") : "Daily video limit reached.");
      await refreshCoinsHubUi();
      return;
    }
    if (code === "WALLET_FULL") {
      showToast(typeof t === "function" ? t("coinsWalletFull") : "Wallet is full.");
      return;
    }
    showToast(e && e.message ? e.message : typeof t === "function" ? t("coinsActionFailed") : "Failed.");
  }
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
  const code =
    currentUser && currentUser.referralCode
      ? String(currentUser.referralCode).trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
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
  premiumLiteSelectPlan("standard", { initial: true });
  premiumLiteBillingToggle("monthly");
}

let premiumLiteUiInitialized = false;
function ensurePremiumLiteUiInitialized() {
  if (premiumLiteUiInitialized) return;
  premiumLiteUiInitialized = true;
  premiumSelectPaymentMethod("card");
  premiumLiteInitPricingUi();
}

function premiumLiteSelectPlan(plan, opts = {}) {
  const target = String(plan || "").toLowerCase();
  if (target !== "free" && target !== "standard") return;
  const grid = document.querySelector(".pricing-lite-grid");
  const cards = document.querySelectorAll(".pricing-lite-card[data-lite-plan]");
  if (!cards.length) return;
  cards.forEach((card) => {
    const is = card.getAttribute("data-lite-plan") === target;
    card.classList.toggle("is-selected", is);
    card.classList.toggle("is-focus", is && target === "standard");
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
  const stdEquiv = document.getElementById("premiumLiteStandardEquiv");
  const stdBadge = document.getElementById("premiumLiteStandardBadge");
  const saveBadge = document.getElementById("premiumLiteStandardSaveBadge");
  const ctaMonthly = document.getElementById("premiumLiteStandardCta");
  const ctaYearly = document.getElementById("premiumLiteStandardCtaAlt");
  const stickyMonthly = document.getElementById("premiumLiteStickyCtaMonthly");
  const stickyYearly = document.getElementById("premiumLiteStickyCtaYearly");
  const root = document.getElementById("premiumPlansSection");
  const card = document.querySelector('.pricing-lite-card[data-lite-plan="standard"]');
  if (root) root.classList.toggle("pricing-lite-plans--yearly", m === "yearly");
  if (card) card.classList.toggle("pricing-lite-card--yearly-offer", m === "yearly");
  const coinIcon = '<span class="pricing-lite-coin" aria-hidden="true">🪙</span> ';
  if (m === "yearly") {
    if (stdMain) stdMain.innerHTML = `${coinIcon}<span class="pricing-lite-price-num">14,400</span>`;
    if (stdPeriod) {
      stdPeriod.textContent = typeof t === "function" ? t("premiumLiteCoinsPeriodYear") : "coins / 365 days";
      stdPeriod.classList.add("pricing-lite-price-period--yearly");
    }
    if (stdSub) {
      stdSub.classList.remove("hidden");
      stdSub.textContent = typeof t === "function" ? t("premiumLiteYearlyStandardSub") : "";
    }
    if (stdEquiv) {
      stdEquiv.classList.remove("hidden");
      stdEquiv.setAttribute("aria-hidden", "false");
      stdEquiv.textContent =
        typeof t === "function"
          ? t("premiumLiteYearlyEquiv").replace("{amount}", "1,200")
          : "~1,200 coins / month vs 1,500 monthly";
    }
    if (stdBadge) stdBadge.classList.add("hidden");
    if (saveBadge) saveBadge.classList.remove("hidden");
    if (ctaMonthly) ctaMonthly.classList.add("hidden");
    if (ctaYearly) ctaYearly.classList.remove("hidden");
    if (stickyMonthly) stickyMonthly.classList.add("hidden");
    if (stickyYearly) stickyYearly.classList.remove("hidden");
  } else {
    if (stdMain) stdMain.innerHTML = `${coinIcon}<span class="pricing-lite-price-num">1,500</span>`;
    if (stdPeriod) {
      stdPeriod.textContent = typeof t === "function" ? t("premiumLiteCoinsPeriodMonth") : "coins / 30 days";
      stdPeriod.classList.remove("pricing-lite-price-period--yearly");
    }
    if (stdSub) stdSub.classList.add("hidden");
    if (stdEquiv) {
      stdEquiv.classList.add("hidden");
      stdEquiv.setAttribute("aria-hidden", "true");
      stdEquiv.textContent = "";
    }
    if (stdBadge) stdBadge.classList.remove("hidden");
    if (saveBadge) saveBadge.classList.add("hidden");
    if (ctaMonthly) ctaMonthly.classList.remove("hidden");
    if (ctaYearly) ctaYearly.classList.add("hidden");
    if (stickyMonthly) stickyMonthly.classList.remove("hidden");
    if (stickyYearly) stickyYearly.classList.add("hidden");
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

function pauseWebChatFabPromptCycle() {
  if (webChatFabPromptCycleTimer) {
    window.clearInterval(webChatFabPromptCycleTimer);
    webChatFabPromptCycleTimer = null;
  }
}

function scheduleWebChatFabPromptCycle() {
  pauseWebChatFabPromptCycle();
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (webChatDrawerIsOpen() || webChatQuickPanelOpen()) return;
  webChatFabPromptCycleTimer = window.setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (webChatDrawerIsOpen() || webChatQuickPanelOpen()) return;
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

function normalizeSupportEmailForMailto(raw) {
  const s = String(raw || "").trim().replace(/^mailto:/i, "").trim();
  if (!s) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  return "mailto:" + s;
}

function syncCommunityMailtoLink(sidebarId, homeId, emailRaw, rowVisible) {
  const href = normalizeSupportEmailForMailto(emailRaw);
  const active = Boolean(href);
  for (const id of [sidebarId, homeId]) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!rowVisible) {
      el.classList.add("hidden");
      el.removeAttribute("href");
      el.removeAttribute("target");
      el.classList.remove("social-community-link--inactive");
      el.removeAttribute("aria-disabled");
      el.removeAttribute("tabindex");
      continue;
    }
    el.classList.remove("hidden");
    if (active) {
      el.setAttribute("href", href);
      el.removeAttribute("target");
      el.classList.remove("social-community-link--inactive");
      el.removeAttribute("aria-disabled");
      el.removeAttribute("tabindex");
    } else {
      el.removeAttribute("href");
      el.removeAttribute("target");
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
    normalizeSocialInviteUrl(youtubeCommunityUrl) ||
    Boolean(normalizeSupportEmailForMailto(supportContactEmail));
  const dOk = syncCommunitySocialLink(
    "sidebarSocialDiscord",
    "homeSocialDiscord",
    discordCommunityUrl,
    hasAny
  );
  syncCommunitySocialLink("sidebarSocialTiktok", "homeSocialTiktok", tiktokCommunityUrl, hasAny);
  syncCommunitySocialLink("sidebarSocialYoutube", "homeSocialYoutube", youtubeCommunityUrl, hasAny);
  syncCommunityMailtoLink("sidebarSocialSupportEmail", "homeSocialSupportEmail", supportContactEmail, hasAny);
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
    ["sidebarSocialSupportEmail", "socialAriaSupportEmail"],
    ["homeSocialDiscord", "socialAriaDiscord"],
    ["homeSocialTiktok", "socialAriaTiktok"],
    ["homeSocialYoutube", "socialAriaYoutube"],
    ["homeSocialSupportEmail", "socialAriaSupportEmail"]
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

async function loadDiscordCommunityConfig(forceReload) {
  const nowTs = Date.now();
  if (!forceReload && appPublicConfigCacheExpiresAt > nowTs && googleOAuthConfigLoaded) {
    applyDiscordCommunityUi();
    syncAuthGoogleLinkHref();
    return;
  }
  if (loadDiscordCommunityConfigInflight) return loadDiscordCommunityConfigInflight;
  loadDiscordCommunityConfigInflight = (async () => {
    const publicFetchOpts = {
      method: "GET",
      cache: "no-store",
      /* Public endpoint — omit cookies avoids WebView/third-party quirks in Capacitor; same on web/PWA */
      credentials: "omit"
    };
    try {
      const primaryUrl = buildApiUrl("/api/public/app-config");
      let res = await fetch(primaryUrl, publicFetchOpts);
      if (res.status === 404) {
        res = await fetch(backendAbsoluteUrl("/api/public/app-config"), publicFetchOpts);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load app config");
      discordCommunityUrl = String((data && data.discordInviteUrl) || "").trim();
      discordUpdatesCount = Math.max(0, Number((data && data.discordUpdatesCount) || 0));
      tiktokCommunityUrl = String((data && data.tiktokUrl) || "").trim();
      youtubeCommunityUrl = String((data && data.youtubeUrl) || "").trim();
      supportContactEmail = String((data && data.supportEmail) || "").trim();
      googleOAuthClientId = String((data && data.googleClientId) || "").trim();
      appPublicConfigCacheExpiresAt = Date.now() + APP_PUBLIC_CONFIG_CACHE_TTL_MS;
    } catch {
      discordCommunityUrl = "";
      discordUpdatesCount = 0;
      tiktokCommunityUrl = "";
      youtubeCommunityUrl = "";
      supportContactEmail = "";
      googleOAuthClientId = "";
      appPublicConfigCacheExpiresAt = Date.now() + APP_PUBLIC_CONFIG_RETRY_MS;
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

let nativeOAuthDeepLinkHandled = false;

function decodeNativeOAuthFragment(hash) {
  const h = String(hash || "").trim();
  if (!h) throw new Error("empty_oauth_fragment");
  let b64 = h.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const json = atob(b64);
  return JSON.parse(json);
}

/**
 * Prefer explicit hash; else query `t` (current backend). Android VIEW intents often drop the fragment.
 */
function extractNativeOAuthPayloadSegment(rawUrl) {
  const full = String(rawUrl || "").trim();
  const marker = "com.notesai.app://oauth";
  const at = full.indexOf(marker);
  if (at < 0) return "";
  const fromScheme = full.slice(at);

  const hashIdx = fromScheme.indexOf("#");
  if (hashIdx >= 0) {
    const seg = fromScheme.slice(hashIdx + 1).trim();
    if (seg) return seg;
  }
  try {
    const parsed = new URL(fromScheme);
    const t = parsed.searchParams.get("t");
    if (!t) return "";
    try {
      return decodeURIComponent(t);
    } catch {
      return String(t || "").trim();
    }
  } catch {
    return "";
  }
}

/**
 * Capacitor: backend redirects to `com.notesai.app://oauth?t=<base64url JSON>` (legacy: `#fragment`) after `?native=1`.
 */
async function consumeNativeOAuthUrlIfAny(rawUrl) {
  if (nativeOAuthDeepLinkHandled) return false;
  const url = String(rawUrl || "");
  if (!url.includes("com.notesai.app://oauth")) return false;
  try {
    if (typeof isNativeApp === "function" && isNativeApp() && typeof console !== "undefined" && console.info) {
      const short = url.length > 160 ? `${url.slice(0, 156)}…` : url;
      console.info("[native OAuth] deep link", short);
    }
  } catch {
    /* ignore */
  }
  const segment = extractNativeOAuthPayloadSegment(url);
  if (!segment) {
    nativeOAuthDeepLinkHandled = true;
    showToast("Google sign-in could not be completed.");
    return true;
  }
  let payload;
  try {
    payload = decodeNativeOAuthFragment(segment);
  } catch {
    nativeOAuthDeepLinkHandled = true;
    showToast("Google sign-in could not be completed.");
    return true;
  }
  try {
    const Browser = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (Browser && typeof Browser.close === "function") await Browser.close();
  } catch {
    /* ignore */
  }
  await finalizeGoogleOAuthSession(payload);
  oauthHandoffConsumed = true;
  nativeOAuthDeepLinkHandled = true;
  try {
    sessionStorage.removeItem(OAUTH_GOOGLE_RETURN_PENDING_KEY);
    sessionStorage.removeItem(OAUTH_HANDOFF_SESSION_DONE_KEY);
  } catch {
    /* ignore */
  }
  return true;
}

let nativeOAuthDeepLinkListenerReady = false;

async function initNativeOAuthDeepLinks() {
  if (typeof isNativeApp !== "function" || !isNativeApp()) return;
  if (nativeOAuthDeepLinkListenerReady) return;
  const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!AppPlugin || typeof AppPlugin.addListener !== "function") return;
  try {
    await AppPlugin.addListener("appUrlOpen", (ev) => {
      void consumeNativeOAuthUrlIfAny(ev && ev.url);
    });
    nativeOAuthDeepLinkListenerReady = true;
  } catch (e) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[native OAuth] App.addListener(appUrlOpen) failed:", e);
    }
    return;
  }
  try {
    const launch = await AppPlugin.getLaunchUrl();
    if (launch && launch.url) await consumeNativeOAuthUrlIfAny(launch.url);
  } catch {
    /* ignore */
  }
}

/** OAuth: backend sets short-lived httpOnly cookies on redirect; one POST exchanges them for tokens (nothing in URL). */
async function finalizeGoogleOAuthSession(payload) {
  const at = payload && payload.accessToken;
  const rt = payload && payload.refreshToken;
  const u = payload && payload.user;
  if (!at || !rt || !u) {
    if (!authBootstrapPhaseActive) {
      showToast("Google sign-in could not be completed.");
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    return;
  }

  storeCurrentUser(u, at, rt, true, { skipUi: authBootstrapPhaseActive });
  history.replaceState(null, "", "/");

  if (authBootstrapPhaseActive) {
    pendingPostOAuthPresentation = true;
    return;
  }

  syncMobileHeaderActionUi();
  presentPostGoogleOAuthChrome(u);
}

function presentPostGoogleOAuthChrome(u) {
  if (!isAuthSessionReady()) {
    showToast("Could not restore your session. Please sign in again.");
    return;
  }
  const welcomeUser = (u && u.username) || (currentUser && currentUser.username) || "";
  const finishGoogleOAuthSuccess = () => {
    refreshReminderRelatedViews();
    void mergePremiumFromServer().then(() => {
      displayAccountInfo();
      void updateHomeDashboardStats();
    });
  };

  showToast(`Welcome, ${welcomeUser}`);
  goHome();
  finishGoogleOAuthSuccess();
  if (typeof scheduleOnboardingTutorialAfterAuth === "function") scheduleOnboardingTutorialAfterAuth();
}

/** After shell is visible: toast + navigation for a session that was persisted during bootstrap. */
async function presentPendingPostOAuthLandingIfAny() {
  if (!pendingPostOAuthPresentation) return;
  if (!isAuthSessionReady()) {
    pendingPostOAuthPresentation = false;
    return;
  }
  pendingPostOAuthPresentation = false;
  await loadUserSettings();
  startWebNotificationScheduler();
  if (
    !isNativeLocalNotificationsAvailable() &&
    "Notification" in window &&
    Notification.permission === "granted" &&
    webReminderNotificationsAppEnabled()
  ) {
    void registerWebPushSubscription();
  }
  syncMobileHeaderActionUi();
  presentPostGoogleOAuthChrome(currentUser);
}

function markGoogleOAuthFlowDeparting() {
  nativeOAuthDeepLinkHandled = false;
  try {
    sessionStorage.setItem(OAUTH_GOOGLE_RETURN_PENDING_KEY, "1");
    sessionStorage.removeItem(OAUTH_HANDOFF_SESSION_DONE_KEY);
    oauthHandoffConsumed = false;
  } catch {
    /* ignore */
  }
}

/**
 * Call POST /api/auth/oauth-handoff only when a Google round-trip was started from this app
 * (session flag) or the URL explicitly requests it (optional future backend hint).
 */
function shouldAttemptOAuthHandoff() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth_handoff") === "1") return true;
    if (sessionStorage.getItem(OAUTH_HANDOFF_SESSION_DONE_KEY) === "1") return false;
    return sessionStorage.getItem(OAUTH_GOOGLE_RETURN_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

function stripOAuthHandoffQueryParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("oauth_handoff")) return;
    params.delete("oauth_handoff");
    const qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  } catch {
    /* ignore */
  }
}

function oauthHandoffFailCleanup() {
  try {
    sessionStorage.removeItem(OAUTH_GOOGLE_RETURN_PENDING_KEY);
    sessionStorage.setItem(OAUTH_HANDOFF_SESSION_DONE_KEY, "1");
  } catch {
    /* ignore */
  }
  stripOAuthHandoffQueryParam();
  oauthHandoffConsumed = true;
}

/**
 * Single handoff round-trip: no 401 retry loop, optional second URL only on network failure.
 */
async function attemptOAuthHandoffExchange() {
  if (oauthHandoffInFlight || oauthHandoffConsumed) return;
  oauthHandoffInFlight = true;
  const url = buildApiUrl("/api/auth/oauth-handoff");
  const fallbackUrl = backendAbsoluteUrl("/api/auth/oauth-handoff");
  let lastRes = /** @type {Response | null} */ (null);
  let data = /** @type {Record<string, unknown>} */ ({});

  const doFetch = async (target) => {
    const res = await fetch(target, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  };

  try {
    try {
      const out = await doFetch(url);
      lastRes = out.res;
      data = out.json;
    } catch (netErr) {
      if (isAuthDevHost()) console.warn("[oauth-handoff] network (primary)", netErr);
      try {
        const out = await doFetch(fallbackUrl);
        lastRes = out.res;
        data = out.json;
      } catch (netErr2) {
        if (isAuthDevHost()) console.warn("[oauth-handoff] network (fallback)", netErr2);
        oauthHandoffFailCleanup();
        refreshClientAuthFromStorage();
        return;
      }
    }

    if (!lastRes) {
      oauthHandoffFailCleanup();
      refreshClientAuthFromStorage();
      return;
    }

    if (lastRes.status === 401) {
      oauthHandoffFailCleanup();
      refreshClientAuthFromStorage();
      return;
    }

    if (lastRes.ok && data.accessToken && data.refreshToken && data.user) {
      try {
        sessionStorage.removeItem(OAUTH_GOOGLE_RETURN_PENDING_KEY);
        sessionStorage.removeItem(OAUTH_HANDOFF_SESSION_DONE_KEY);
        stripOAuthHandoffQueryParam();
        await finalizeGoogleOAuthSession(data);
        oauthHandoffConsumed = true;
      } catch (finErr) {
        if (isAuthDevHost()) console.error("[oauth-handoff] finalize", finErr);
        oauthHandoffFailCleanup();
        refreshClientAuthFromStorage();
      }
      return;
    }

    oauthHandoffFailCleanup();
    refreshClientAuthFromStorage();
  } finally {
    oauthHandoffInFlight = false;
  }
}

function handleGoogleOAuthQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const qErr = params.get("google_oauth_error");
  if (!qErr) return;
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
}

/**
 * Blocking auth bootstrap: storage, optional /api/me when tokens exist without user, then oauth cookie handoff.
 * (Query OAuth errors are handled after the shell is shown — see handleGoogleOAuthQueryParams.)
 */
async function runAuthBootstrap() {
  refreshClientAuthFromStorage();

  const params = new URLSearchParams(window.location.search);
  if (params.get("google_oauth_error")) {
    return;
  }

  if (accessToken && refreshToken) {
    const hydrated = await hydrateSessionUserFromTokens();
    if (!hydrated) {
      refreshAccessTokenPromise = null;
      clearCurrentUser();
    } else {
      try {
        sessionStorage.removeItem(OAUTH_GOOGLE_RETURN_PENDING_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
  }

  if (accessToken && refreshToken) {
    return;
  }

  if (!shouldAttemptOAuthHandoff()) {
    return;
  }

  await attemptOAuthHandoffExchange();
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
  teardownWebChatDrawerUi();
  window.setTimeout(() => {
    if (!el.classList.contains("web-chat-drawer--active")) el.classList.add("hidden");
    document.body.classList.remove("web-chat-drawer-open");
    restoreWebChatDrawerPortal();
    unlockWebChatScroll();
    scheduleWebChatFabPromptCycle();
    syncAppBackgroundActivity();
  }, 260);
}

async function openWebChat() {
  if (!requireAuth("use Web Chat")) return;
  try {
    await ensureWebChatModulesLoaded();
  } catch {
    showToast(typeof t === "function" ? t("webChatPlanVerifyFailed") : "Web Chat could not load.");
    return;
  }
  const mergedOk = await mergePremiumFromServer();
  if (!mergedOk) {
    showToast(t("webChatPlanVerifyFailed"));
    openBot();
    return;
  }
  const drawer = document.getElementById("webChat");
  if (!drawer) return;
  attachWebChatDrawerToBody();
  drawer.classList.remove("hidden");
  document.body.classList.add("web-chat-drawer-open");
  lockWebChatScroll();
  bindWebChatDrawerUi();
  drawer.classList.add("web-chat-drawer--opening");
  window.requestAnimationFrame(() => drawer.classList.add("web-chat-drawer--active"));
  window.setTimeout(() => drawer.classList.remove("web-chat-drawer--opening"), 300);
  pauseWebChatFabPromptCycle();
  syncAppBackgroundActivity();
  webChatSetUnread(0);
  closeWebChatQuickActions();
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

function renderWebChatWelcomeContent(bubble, _modeValue) {
  const p = document.createElement("p");
  p.className = "web-chat-welcome-one";
  p.setAttribute("data-t", "webChatWelcomeOneLine");
  try {
    p.textContent = t("webChatWelcomeOneLine");
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
    scanCamEnsureUploadInputsPortaled();
    applyTranslations();

    const st = document.getElementById("scanCamStatus");
    if (st) st.textContent = "";
    scanCamResetWorkflowUi();
    scanCamMaybeShowOnboarding();
    if (typeof userHasScanCamAccess === "function" && userHasScanCamAccess(currentUser)) {
      void scanCamEnsureJsPdfReady().catch(() => {});
    }
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

/**
 * Source rectangle (video pixel space) that matches CSS object-fit: cover for the current video element box.
 * Avoids “0.5×” ultrawide feel in preview vs capture mismatch.
 */
function scanCamGetVideoCoverCropSourceRect(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const cw = videoEl.clientWidth || vw;
  const ch = videoEl.clientHeight || vh;
  if (!vw || !vh || !cw || !ch) {
    return { sx: 0, sy: 0, sw: vw || 1, sh: vh || 1 };
  }
  const scale = Math.max(cw / vw, ch / vh);
  const sw = cw / scale;
  const sh = ch / scale;
  const sx = Math.max(0, Math.min(vw - sw, (vw - sw) / 2));
  const sy = Math.max(0, Math.min(vh - sh, (vh - sh) / 2));
  return { sx, sy, sw, sh };
}

/** Capacitor Camera plugin (native APK / iOS wrapper), when registered. */
function scanCamGetCapacitorCameraPlugin() {
  try {
    const c = typeof window !== "undefined" ? window.Capacitor : null;
    if (!c) return null;
    let plug = c.Plugins && c.Plugins.Camera ? c.Plugins.Camera : null;
    if (!plug && typeof c.registerPlugin === "function") {
      plug = c.registerPlugin("Camera");
    }
    if (!plug || typeof plug.requestPermissions !== "function") return null;
    if (typeof plug.takePhoto !== "function" && typeof plug.getPhoto !== "function") return null;
    return plug;
  } catch {
    return null;
  }
}

function scanCamGetCapacitorFilesystemPlugin() {
  try {
    const c = typeof window !== "undefined" ? window.Capacitor : null;
    if (!c) return null;
    if (c.Plugins && c.Plugins.Filesystem) return c.Plugins.Filesystem;
    if (typeof c.registerPlugin === "function") return c.registerPlugin("Filesystem");
    return null;
  } catch {
    return null;
  }
}

async function scanCamTakeCapacitorPhoto(CameraPlugin) {
  if (typeof CameraPlugin.takePhoto === "function") {
    return CameraPlugin.takePhoto({
      quality: 90,
      correctOrientation: true,
      saveToGallery: false,
      editable: "no"
    });
  }
  return CameraPlugin.getPhoto({
    quality: 90,
    source: "CAMERA",
    resultType: "uri",
    correctOrientation: true,
    saveToGallery: false,
    direction: "REAR"
  });
}

function scanCamIsCapacitorCameraUserCancelled(err) {
  if (!err) return false;
  const code = err.code != null ? String(err.code) : "";
  if (code === "OS-PLUG-CAMR-0006" || code === "OS-PLUG-CAMR-0013" || code === "OS-PLUG-CAMR-0020") {
    return true;
  }
  const m = String(err.message || "").toLowerCase();
  return (
    (m.includes("cancel") || m.includes("canceled") || m.includes("cancelled")) &&
    !m.includes("permission")
  );
}

/** Full-resolution JPEG as data URL (matches {@link scanCamHandlePhotoUpload} OCR / save flow). */
async function scanCamCapacitorPhotoResultToDataUrl(result) {
  if (!result || typeof result !== "object") return "";

  const fileRef = result.uri || result.path;
  if (typeof fileRef === "string" && fileRef.length) {
    const Fs = scanCamGetCapacitorFilesystemPlugin();
    if (Fs && typeof Fs.readFile === "function") {
      try {
        const read = await Fs.readFile({ path: fileRef });
        const data = read && read.data != null ? String(read.data) : "";
        if (data) {
          const fmtRaw =
            (result.metadata && result.metadata.format) || result.format || "jpeg";
          const fmt = String(fmtRaw).toLowerCase();
          const mime = fmt.includes("png") ? "image/png" : "image/jpeg";
          if (data.startsWith("data:")) return data;
          const b64 = data.includes(",") ? data.split(",").pop() || data : data;
          return `data:${mime};base64,${b64}`;
        }
      } catch {
        /* fall through */
      }
    }
  }

  try {
    const wp = result.webPath;
    if (typeof wp === "string" && wp.length) {
      const res = await fetch(wp);
      if (res.ok) {
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ""));
          fr.onerror = () => reject(fr.error || new Error("read"));
          fr.readAsDataURL(blob);
        });
        if (dataUrl && String(dataUrl).startsWith("data:")) return dataUrl;
      }
    }
  } catch {
    /* fall through — try thumbnail */
  }
  try {
    const tn = result.thumbnail;
    if (typeof tn === "string" && tn.length > 80) {
      if (tn.startsWith("data:")) return tn;
      const raw = tn.includes(",") ? tn.split(",").pop() || tn : tn;
      return `data:image/jpeg;base64,${raw}`;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function scanCamApplyCapturedImageDataUrl(dataUrl) {
  const preview = document.getElementById("scanCamPhotoPreview");
  const status = document.getElementById("scanCamStatus");
  if (!preview || !dataUrl) return;
  scanCamClearPdf();
  preview.src = dataUrl;
  preview.classList.remove("hidden");
  scanCamCloseCameraUi();
  if (status) status.textContent = typeof t === "function" ? t("scanCamPhotoUploaded") : "";
  scanCamCloseResultPanel();
  scanCamUpdateStageVisibility();
  scanCamSyncActionUi();
}

async function scanCamOpenCameraWithCapacitor(CameraPlugin) {
  const status = document.getElementById("scanCamStatus");
  try {
    if (status) status.textContent = "";
    const perm = await CameraPlugin.requestPermissions({ permissions: ["camera"] });
    const camState = perm && perm.camera ? String(perm.camera) : "";
    if (camState !== "granted" && camState !== "limited") {
      const msg =
        typeof t === "function"
          ? t("scanCamCameraPermissionDenied")
          : "Lejo kamerën në settings për të përdorur Scan Cam.";
      showToast(msg);
      if (status) status.textContent = msg;
      scanCamSyncActionUi();
      return;
    }

    scanCamCloseResultPanel();
    scanCamStopCamera();
    const preview = document.getElementById("scanCamPhotoPreview");
    if (preview) {
      preview.removeAttribute("src");
      preview.classList.add("hidden");
    }
    scanCamClearPdf();

    const result = await scanCamTakeCapacitorPhoto(CameraPlugin);

    const dataUrl = await scanCamCapacitorPhotoResultToDataUrl(result);
    if (!dataUrl) {
      showToast(typeof t === "function" ? t("scanCamPhotoReadError") : "Could not read the photo.");
      scanCamSyncActionUi();
      return;
    }
    scanCamApplyCapturedImageDataUrl(dataUrl);
  } catch (e) {
    if (scanCamIsCapacitorCameraUserCancelled(e)) {
      scanCamSyncActionUi();
      return;
    }
    showToast(typeof t === "function" ? t("scanCamCameraError") : e && e.message ? String(e.message) : "");
    if (status) status.textContent = typeof t === "function" ? t("scanCamCameraError") : e && e.message;
    scanCamSyncActionUi();
  }
}

async function scanCamOpenCamera() {
  const status = document.getElementById("scanCamStatus");
  const video = document.getElementById("scanCamVideo");
  const wrap = document.getElementById("scanCamVideoWrap");
  if (!video || !wrap) return;

  const capCam =
    typeof isNativeApp === "function" && isNativeApp() ? scanCamGetCapacitorCameraPlugin() : null;
  if (capCam) {
    await scanCamOpenCameraWithCapacitor(capCam);
    return;
  }

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
    /** Prefer main rear stream: higher resolution reduces grain; narrow aspect can skip some ultrawide profiles. */
    const videoConstraints = {
      facingMode: { ideal: "environment" },
      width: { ideal: 2560, min: 1280 },
      height: { ideal: 1440, min: 720 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30, max: 30 }
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false
      });
    }
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

function scanCamEnsureUploadInputsPortaled() {
  ["scanCamUploadInput", "scanCamUploadInputDoc"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.parentElement === document.body) return;
    el.classList.add("hidden");
    document.body.appendChild(el);
  });
}

function scanCamTriggerFileInput(inputEl) {
  if (!inputEl) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        inputEl.value = "";
        inputEl.click();
      } catch {
        /* ignore */
      }
    });
  });
}

function scanCamUploadPhoto() {
  scanCamEnsureUploadInputsPortaled();
  scanCamTriggerFileInput(document.getElementById("scanCamUploadInput"));
}

function scanCamOpenDocSourceSheet() {
  const sheet = document.getElementById("scanCamDocSourceSheet");
  if (!sheet) return;
  sheet.classList.remove("hidden");
  document.body.classList.add("modal-open");
  syncAppBackgroundActivity();
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
  if (scanCamDocSheetEscHandler) {
    document.removeEventListener("keydown", scanCamDocSheetEscHandler);
    scanCamDocSheetEscHandler = null;
  }
  releaseModalBackdropIfIdle();
}

function scanCamUploadDocument() {
  scanCamDismissOnboarding();
  /** Open device file picker directly (Samsung “My Files” / Downloads) — skip interim chooser sheet. */
  scanCamDocPickFromFilesDevice();
}

/**
 * Opens the system document picker (best effort). Web/PWA APIs cannot pin Samsung “Dokumente” /
 * a specific OEM category — only a native Android WebChromeClient EXTRA_INITIAL_URI can try that.
 * `accept` on the hidden input nudges toward document-like MIME groups on many devices.
 */
function scanCamDocPickFromFilesDevice() {
  scanCamCloseDocSourceSheet();
  scanCamEnsureUploadInputsPortaled();
  scanCamTriggerFileInput(document.getElementById("scanCamUploadInputDoc"));
}

/** Opens Google Drive in a new tab so the user can locate cloud files (upload still uses device picker). */
function scanCamDocPickFromDriversAndCloud() {
  scanCamCloseDocSourceSheet();
  const driveUrl = "https://drive.google.com/drive/my-drive";
  let opened = false;
  try {
    const w = window.open(driveUrl, "_blank", "noopener,noreferrer");
    opened = Boolean(w);
  } catch {
    opened = false;
  }
  if (typeof showToast === "function" && typeof t === "function") {
    if (opened) {
      showToast(t("scanCamDriveOpenHint"));
    } else {
      showToast(t("scanCamDrivePopupBlocked"));
    }
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
  let mime = String(file.type || "");
  /** Some Android picks return empty MIME; fall back by extension so Files / Downloads still work. */
  if (!mime) {
    if (/\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(file.name)) mime = "image/unknown-fallback";
    else if (/\.pdf$/i.test(file.name)) mime = "application/pdf";
  }
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
    inputEl.value = "";
    void scanCamRenderPdfPreview(file, url);
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
  void (async () => {
    try {
      await scanCamEnsureJsPdfReady();
    } catch {
      showToast(
        typeof t === "function" ? t("noteExportToolsLoading") : "Export tools could not load. Try again."
      );
      return;
    }
    const Ctor =
      (typeof window !== "undefined" && window.jspdf && window.jspdf.jsPDF) ||
      (typeof window !== "undefined" && window.jsPDF);
    if (!Ctor) {
      showToast(
        typeof t === "function" ? t("noteExportToolsLoading") : "Export tools are still loading. Try again in a few seconds."
      );
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
    const outName = "scan-note.pdf";
    let pdfBlob = null;
    try {
      if (doc.output && typeof doc.output === "function") {
        pdfBlob = doc.output("blob");
      }
    } catch {
      pdfBlob = null;
    }
    if (!(pdfBlob instanceof Blob) || pdfBlob.size < 1) {
      try {
        const ab = doc.output && typeof doc.output === "function" ? doc.output("arraybuffer") : null;
        if (ab && ab.byteLength) pdfBlob = new Blob([ab], { type: "application/pdf" });
      } catch {
        pdfBlob = null;
      }
    }
    if (!(pdfBlob instanceof Blob) || pdfBlob.size < 1) {
      showToast(typeof t === "function" ? t("noteExportPdfUnavailable") : "Could not build the PDF.");
      return;
    }
    if (typeof window.saveOrDownloadBlob === "function") {
      await window.saveOrDownloadBlob(pdfBlob, outName);
      return;
    }
    doc.save(outName);
  })();
}

function scanCamDownloadImage() {
  if (!scanCamEnsureConvertAccess()) return;
  const preview = document.getElementById("scanCamPhotoPreview");
  const src = preview && preview.getAttribute("src");
  if (!src || !String(src).startsWith("data:")) {
    showToast(t("scanCamNoImageDownload"));
    return;
  }
  void (async () => {
    try {
      await ensureNoteExportLoaded();
      const res = await fetch(src);
      const blob = await res.blob();
      if (typeof window.saveOrDownloadBlob === "function") {
        await window.saveOrDownloadBlob(blob, "scan-capture.jpg");
        return;
      }
    } catch {
      /* fall through to anchor */
    }
    const a = document.createElement("a");
    a.href = src;
    a.download = "scan-capture.jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
  })();
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
  const { sx, sy, sw, sh } = scanCamGetVideoCoverCropSourceRect(video);
  const canvas = document.createElement("canvas");
  const outW = Math.max(1, Math.round(sw));
  const outH = Math.max(1, Math.round(sh));
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
  scanCamClearPdf();
  preview.src = canvas.toDataURL("image/jpeg", 0.95);
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
    if (notesAiVerboseLogs() && typeof console !== "undefined" && console.warn) {
      console.warn("[Scan Cam] structured OCR", e);
    }
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

function scanCamCanvasFromImgElement(img, maxSide = 3600) {
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
  await scanCamEnsureTesseractVendorOnly();
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
              tessedit_pageseg_mode: "1",
              preserve_interword_spaces: "1",
              user_defined_dpi: "300"
            });
          } catch {
            try {
              await scanCamTesseractWorker.setParameters({
                tessedit_pageseg_mode: "3",
                preserve_interword_spaces: "1",
                user_defined_dpi: "300"
              });
            } catch (e2) {
              if (notesAiVerboseLogs() && typeof console !== "undefined" && console.warn) {
                console.warn("[Scan Cam] Tesseract setParameters", e2 && e2.message);
              }
            }
          }
          return scanCamTesseractWorker;
        } catch (e) {
          if (notesAiVerboseLogs() && typeof console !== "undefined" && console.warn) {
            console.warn("[Scan Cam] Tesseract init", lang, e && e.message);
          }
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

async function scanCamRecognizeFromPdfUrl(pdfUrl, onProgress) {
  await scanCamEnsureVendorScriptsLoaded();
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
    if (typeof onProgress === "function") onProgress(p, n);
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
  const preview = document.getElementById("scanCamPhotoPreview");
  const hasImg = !!(preview && preview.getAttribute("src") && !preview.classList.contains("hidden"));
  const hasPdf = !!scanCamPdfObjectUrl && !hasImg;
  if (line) line.classList.toggle("hidden", hasPdf);
  if (stage) stage.classList.add("scan-cam-stage--converting");
  scanCamShowStageLoading(t("scanCamProcessing"));
  if (status) status.textContent = t("scanCamProcessing");
  try {
    let text = "";

    if (hasImg) {
      try {
        await scanCamEnsureTesseractVendorOnly();
      } catch {
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
      try {
        await scanCamEnsureVendorScriptsLoaded();
      } catch {
        showToast(t("scanCamPdfJsMissing"));
        return;
      }
      text = await scanCamRecognizeFromPdfUrl(scanCamPdfObjectUrl, (current, total) => {
        scanCamShowStageLoading(
          t("scanCamOcrPageProgress")
            .replace("{current}", String(current))
            .replace("{total}", String(total))
        );
      });
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
    if (notesAiVerboseLogs() && typeof console !== "undefined" && console.warn) {
      console.warn("[Scan Cam OCR]", e);
    }
    let msg = t("scanCamOcrFailed");
    if (e && e.message === "MISSING_TESSERACT") msg = t("scanCamTesseractMissing");
    else if (e && e.message === "MISSING_PDFJS") msg = t("scanCamPdfJsMissing");
    showToast(msg);
    if (status) status.textContent = msg;
  } finally {
    scanCamHideStageLoading();
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
  if (/\b\d{1,2}[:.]\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)\b/i.test(s)) return true;
  if (/\b\d{1,2}[:.]\d{2}\b/.test(s)) return true;
  if (/\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)\b/i.test(s)) return true;
  if (/^(sot|today|neser|nesër|tomorrow|pasneser|pasnesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(s))
    return true;
  if (/\b(?:pas|after|in)\s+\d{1,3}\s*(?:or[ëa]sh|or[ëa]|hours?|minut[ëa]sh|minut[ëa]|minutes?)\b/i.test(s))
    return true;
  if (/\b(?:në|ne|at)\s+\d{1,2}\b/i.test(s) && s.length < 48) return true;
  if (/\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(s) && s.length < 56)
    return true;
  if (/\bte\s+h[eë]nen|t[ëe]\s+h[ëe]n[ëe]n|t[ëe]\s+mart[ëe]n|t[ëe]\s+premt[ëe]n\b/i.test(s) && s.length < 56)
    return true;
  if (/^(ora|or[eë]n)\s+\d{1,2}\b/i.test(s)) return true;
  if (/^\d{1,2}$/.test(s)) return true;
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

/** Web Chat bot copy in the language of the user's message (see {@link inferWebChatMessageLang}), not UI locale. */
function webChatT(key, userMessage) {
  if (typeof inferWebChatMessageLang === "function" && typeof tForLang === "function") {
    return tForLang(key, inferWebChatMessageLang(String(userMessage || "")));
  }
  return typeof t === "function" ? t(key) : key;
}

/**
 * Streams bot text into a new bubble (chunked) for a live typing feel.
 * @param {string} fullText
 * @param {{ ai?: boolean }} [opts]
 */
async function appendWebChatBotReplyStreaming(fullText, opts = {}) {
  removeWebChatTyping();
  const clean =
    String(fullText || "").trim() ||
    webChatT("webChatReplyUnknownSmart", opts.userMessage || "");
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
  trimWebChatMessageDom();
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
  trimWebChatMessageDom();
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
  setWebChatMode("chatbot");
  syncWebChatModePresentation("chatbot", false);
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
    /\b(?:më\s+kujto|me\s+kujto|kujto|remind(?:\s+me(?:\s+to)?)?|remember\s+to|set\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|schedule\s+(?:a\s+)?reminder|notify\s+me(?:\s+to)?|alert\s+me(?:\s+to)?|vendos\s+kujtes[ëe]|njoftom[eë]|me\s+njofto)\b/i.test(
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
    /^(?:remind\s+me(?:\s+to)?|remind(?!\s+me)\s+|remember\s+to|notify\s+me(?:\s+to)?|alert\s+me(?:\s+to)?|set\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|schedule\s+(?:a\s+)?reminder|reminder)\s+/i;
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
  if (typeof window !== "undefined" && window.webChatReminderParse && typeof window.webChatReminderParse.extractTimeSpec === "function") {
    return window.webChatReminderParse.extractTimeSpec(combined);
  }
  const c = String(combined || "");
  const hm = c.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (hm) {
    const h = Number(hm[1]);
    const mi = Number(hm[2]);
    if (!Number.isNaN(h) && !Number.isNaN(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
      return { h, mi, match: hm[0] };
    }
  }
  return null;
}

/**
 * @returns {{ dow: number; fullMatch: string; nextKeyword: boolean } | null}
 */
function webChatMatchWeekdayInBody(body) {
  const b = String(body || "");
  const map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const nextThis = b.match(
    /\b(next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i
  );
  if (nextThis) {
    const nk = nextThis[1].toLowerCase() === "next";
    const dow = map[nextThis[2].toLowerCase()];
    if (dow != null) return { dow, fullMatch: nextThis[0], nextKeyword: nk };
  }
  const sq = [
    [/\bt[eë]\s+diel[ëe]n\b|\bte\s+dielen\b|\be\s+diel[ëe]\b/i, 0],
    [/\bt[eë]\s+h[ëe]n[ëe]n\b|\bte\s+henen\b|\be\s+h[ëe]n[ëe]\b/i, 1],
    [/\bt[eë]\s+m[ëe]rt[ëe]n\b|\bte\s+marten\b|\be\s+m[ëe]rt[ëe]\b/i, 2],
    [/\bt[eë]\s+m[ëe]rkur[ëe]n\b|\bte\s+merkuren\b|\be\s+m[ëe]rkur[ëe]\b/i, 3],
    [/\bt[eë]\s+enjt[ëe]n\b|\bte\s+enjten\b|\be\s+enjt[ëe]\b/i, 4],
    [/\bt[eë]\s+premt[ëe]n\b|\bte\s+premten\b|\be\s+premt[ëe]\b/i, 5],
    [/\bt[eë]\s+shtun[ëe]n\b|\bte\s+shtunen\b|\be\s+shtun[ëe]\b/i, 6]
  ];
  for (let i = 0; i < sq.length; i += 1) {
    const m = b.match(sq[i][0]);
    if (m) return { dow: sq[i][1], fullMatch: m[0], nextKeyword: false };
  }
  const bare = b.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (bare) {
    const dow = map[bare[1].toLowerCase()];
    if (dow != null) return { dow, fullMatch: bare[0], nextKeyword: false };
  }
  return null;
}

/**
 * @param {{ dow: number; nextKeyword: boolean }} wd
 * @returns {Date} date at local midnight for that weekday
 */
function webChatDateFromWeekdayMatch(wd) {
  const now = new Date();
  const todayD = now.getDay();
  const target = wd.dow;
  let add = (target - todayD + 7) % 7;
  if (wd.nextKeyword && add === 0) add = 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + add);
}

/**
 * @returns {{ type: "ok"; when: Date; message: string } | { type: "ask"; ask: "time" | "date" | "both" }}
 */
function webChatParseNaturalReminderSchedule(body, tailAfterKeyword) {
  const combined = String(body || "").trim();
  if (!combined) return { type: "ask", ask: "both" };

  const pasDur = combined.match(
    /\b(?:pas|after|in)\s+(\d{1,3})\s*(or[eë]sh|or[ëa]|hours?|hour|minut[eë]sh|minut[eë]|minutes?|minute|mins?)\b/i
  );
  if (pasDur) {
    const n = Number(pasDur[1]);
    const unitRaw = String(pasDur[2] || "").toLowerCase();
    const isMin = /min|^mins$/.test(unitRaw);
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
  const wdInfo = webChatMatchWeekdayInBody(combined);

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

  if (wdInfo) {
    let tsW = timeSpec;
    if (!tsW) {
      const rest = combined.replace(wdInfo.fullMatch, " ").trim();
      const lone = rest.match(/\b(\d{1,2})\b(?!\s*[:.]\d{2})/);
      if (lone) {
        const h = Number(lone[1]);
        if (!Number.isNaN(h) && h >= 0 && h <= 23) tsW = { h, mi: 0, match: lone[0] };
      }
    }
    if (!tsW) return { type: "ask", ask: "time" };
    const dayBase = webChatDateFromWeekdayMatch(wdInfo);
    const when = new Date(dayBase.getFullYear(), dayBase.getMonth(), dayBase.getDate(), tsW.h, tsW.mi, 0, 0);
    let message = combined
      .replace(wdInfo.fullMatch, " ")
      .replace(tsW.match, " ")
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
    !wdInfo &&
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

/**
 * Centralized structured parse for local reminder UX (also used to derive pending slots).
 * @param {string} message
 * @param {{ pendingReminder?: typeof webChatPendingReminder }} [context]
 * @returns {{
 *   intent: "create_reminder" | "smalltalk" | "unknown";
 *   text: string | null;
 *   date: string | null;
 *   time: { h: number; m: number } | null;
 *   datetime: Date | null;
 *   missing: string[];
 *   confidence: number;
 * }}
 */
function parseReminderMessage(message, context) {
  const raw = String(message || "").trim();
  const pending = Boolean(context && context.pendingReminder && context.pendingReminder.active);
  const norm = raw.toLowerCase();

  if (!pending) {
    if (/^(hi|hello|hey|pershendetje|përshëndetje|tung)\b/i.test(raw) && raw.length < 42) {
      return {
        intent: "smalltalk",
        text: null,
        date: null,
        time: null,
        datetime: null,
        missing: [],
        confidence: 0.72
      };
    }
    if (/^(faleminderit|thank\s+you|thanks|flm)\b/i.test(norm)) {
      return {
        intent: "smalltalk",
        text: null,
        date: null,
        time: null,
        datetime: null,
        missing: [],
        confidence: 0.75
      };
    }
    if (
      /^what can you do\??$/i.test(norm) ||
      /^help$/i.test(norm) ||
      /^(ndihme|ndihmë)$/i.test(norm) ||
      /^çfarë mund të bësh/i.test(raw)
    ) {
      return {
        intent: "smalltalk",
        text: null,
        date: null,
        time: null,
        datetime: null,
        missing: [],
        confidence: 0.82
      };
    }
  }

  const hasKeyword = webChatHasReminderKeyword(raw) || pending;
  if (!hasKeyword) {
    return { intent: "unknown", text: null, date: null, time: null, datetime: null, missing: [], confidence: 0 };
  }

  const split = webChatSplitReminderAroundKeyword(raw);
  let body = stripWebChatReminderPrefix(raw);
  if (!body || body === raw) body = split.combined;

  const missing = [];
  let text = null;
  let date = null;
  let time = null;
  let datetime = null;
  let confidence = 0.62;

  if (!body) {
    missing.push("date", "time", "text");
    return {
      intent: "create_reminder",
      text,
      date,
      time,
      datetime,
      missing,
      confidence: 0.3
    };
  }

  const sched = webChatParseNaturalReminderSchedule(body, split.after);
  if (sched.type === "ok") {
    datetime = sched.when;
    text = String(sched.message || "").trim();
    time = { h: sched.when.getHours(), m: sched.when.getMinutes() };
    date = sched.when.toDateString();
    confidence = 0.92;
    return { intent: "create_reminder", text, date, time, datetime, missing, confidence };
  }

  if (sched.ask === "time") missing.push("time");
  else if (sched.ask === "date") missing.push("date");
  else missing.push("date", "time");

  const ts = webChatExtractTimeSpec(body);
  if (ts) {
    time = { h: ts.h, m: ts.mi };
    if (missing.includes("time")) missing.splice(missing.indexOf("time"), 1);
  }
  if (/\b(nesër|neser|tomorrow)\b/i.test(body)) date = "tomorrow";
  else if (/\b(sot|today)\b/i.test(body)) date = "today";
  else if (webChatMatchWeekdayInBody(body)) date = "weekday";
  const slashD = webChatMatchSlashDate(body);
  if (slashD) date = "absolute";
  if (webChatMatchCalendarMonthInBody(body)) date = "absolute";

  const cleaned = webChatCleanReminderBodyText(body);
  text = cleaned || null;
  if (!text) missing.push("text");

  return { intent: "create_reminder", text, date, time, datetime, missing, confidence };
}

function webChatAskTextForMissing(userMessage) {
  const src = String(userMessage || "").trim();
  const sq =
    typeof inferWebChatMessageLang === "function" ? inferWebChatMessageLang(src) === "sq" : false;
  return sq ? "Çfarë dëshiron të të kujtoj?" : "What should I remind you about?";
}

function webChatPlanErrorReply(err, userMessage) {
  const payload = err && err.payload && typeof err.payload === "object" ? err.payload : null;
  const code = payload && payload.code != null ? String(payload.code) : "";
  const msg = String((err && err.message) || "").toLowerCase();
  if (
    code === "WEB_CHAT_PLAN" ||
    (msg.includes("web chat") && msg.includes("reminder") && msg.includes("standard")) ||
    (msg.includes("standard") && msg.includes("premium"))
  ) {
    return webChatT("webChatReminderRequiresStandard", userMessage);
  }
  if (err && err.message) return String(err.message);
  return webChatT("webChatPlanVerifyFailed", userMessage);
}

async function webChatEnsureStandardForWebReminder(userMessage) {
  if (!currentUser || !accessToken) {
    return { ok: false, reply: webChatT("webChatReminderNeedLogin", userMessage) };
  }
  const mergedOk = await mergePremiumFromServer();
  if (!mergedOk) {
    return { ok: false, reply: webChatT("webChatPlanVerifyFailed", userMessage) };
  }
  if (typeof hasStandardAccess === "function" && !hasStandardAccess(currentUser)) {
    return { ok: false, reply: webChatT("webChatReminderRequiresStandard", userMessage) };
  }
  return { ok: true, reply: null };
}

function webChatBuildWhenFromPendingReminder(pending, ts) {
  if (!pending || !ts || !Number.isFinite(ts.h) || !Number.isFinite(ts.mi)) return null;
  const now = new Date();
  let base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateHint = pending.date ? String(pending.date) : "";
  const src = String(pending.originalMessage || pending.draftLine || "");

  if (dateHint === "tomorrow" || /\b(nesër|neser|tomorrow)\b/i.test(src)) {
    base.setDate(base.getDate() + 1);
  } else if (
    /\b(pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(src)
  ) {
    base.setDate(base.getDate() + 2);
  } else if (dateHint === "weekday") {
    const wd = webChatMatchWeekdayInBody(src);
    if (wd) {
      const d = webChatDateFromWeekdayMatch(wd);
      base = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
  } else if (dateHint !== "today" && !/\b(sot|today)\b/i.test(src)) {
    return null;
  }

  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), ts.h, ts.mi, 0, 0);
}

async function webChatSaveWebReminder(when, msg, langSource, bodyLower) {
  await apiFetch("/api/web-reminder", {
    method: "POST",
    body: JSON.stringify({
      reminderTime: when.toISOString(),
      message: msg,
      source: "web_chat"
    })
  });
  refreshReminderRelatedViews();
  webChatLastReminderUserRaw = String(langSource || "").trim();
  resetWebChatPendingReminder();
  void maybePromptReminderNotificationPermission();
  const summary = webChatFormatReminderConfirmSummary(
    when,
    String(bodyLower || langSource || "").toLowerCase(),
    langSource
  );
  const defMsg = webChatT("webChatReminderDefaultMessage", langSource);
  const line = webChatT("webChatReminderSavedLine", langSource).replace("{when}", summary);
  const detail =
    msg && msg.length && msg !== defMsg
      ? `\n${webChatT("webChatReminderConfirmDetail", langSource).replace("{message}", msg)}`
      : "";
  return `${line}${detail}`;
}

function webChatActivatePendingFromAsk(trimmed, parsedAsk, body) {
  const missing = [];
  if (parsedAsk.ask === "time") missing.push("time");
  if (parsedAsk.ask === "date") missing.push("date");
  if (parsedAsk.ask === "both") missing.push("date", "time");
  const clean = webChatCleanReminderBodyText(String(body || ""));
  if (!clean) missing.push("text");
  webChatPendingReminder.active = true;
  webChatPendingReminder.originalMessage = trimmed;
  webChatPendingReminder.draftLine = trimmed;
  webChatPendingReminder.missing = missing;
  webChatPendingReminder.createdAt = Date.now();
  webChatPendingReminder.text = clean || "";
  const ts = webChatExtractTimeSpec(body);
  webChatPendingReminder.time = ts ? `${ts.h}:${String(ts.mi).padStart(2, "0")}` : null;
  let dHint = null;
  if (/\b(nesër|neser|tomorrow)\b/i.test(body)) dHint = "tomorrow";
  else if (/\b(sot|today)\b/i.test(body)) dHint = "today";
  else if (webChatMatchWeekdayInBody(body)) dHint = "weekday";
  webChatPendingReminder.date = dHint;
  webChatLastReminderUserRaw = trimmed;
}

function webChatPendingAskMessage(missing, userMessage) {
  const src =
    String(userMessage || "").trim() ||
    (webChatPendingReminder && (webChatPendingReminder.draftLine || webChatPendingReminder.originalMessage)) ||
    "";
  const needs = new Set(missing);
  if (needs.has("text")) return webChatAskTextForMissing(src);
  if (needs.has("date") && needs.has("time")) return webChatT("webChatReminderAskBoth", src);
  if (needs.has("date")) return webChatT("webChatReminderAskDate", src);
  if (needs.has("time")) return webChatT("webChatReminderAskTime", src);
  return webChatT("webChatReminderAskBoth", src);
}

async function webChatTryResolvePendingReminder(trimmed) {
  if (!webChatPendingReminder.active) return { handled: false };

  const tHelp = trimmed.replace(/\s+/g, " ").trim();
  if (/^(help|ndihme|ndihmë)\??$/i.test(tHelp)) {
    resetWebChatPendingReminder();
    return { handled: true, reply: webChatT("webChatHelpList", trimmed) };
  }

  const P = typeof window !== "undefined" ? window.webChatReminderParse : null;

  if (P && typeof P.isCancelMessage === "function" && P.isCancelMessage(trimmed)) {
    resetWebChatPendingReminder();
    const sq = typeof inferWebChatMessageLang === "function" && inferWebChatMessageLang(trimmed) === "sq";
    return {
      handled: true,
      reply: sq ? "Në rregull, e anulova." : "Okay — I cancelled that reminder."
    };
  }

  let toMerge = trimmed;
  if (P && typeof P.isChangeTimeMessage === "function" && P.isChangeTimeMessage(trimmed)) {
    const ts = typeof P.extractTimeSpec === "function" ? P.extractTimeSpec(trimmed) : null;
    if (ts) toMerge = `${ts.h}:${String(ts.mi).padStart(2, "0")}`;
  }

  const newDraft = `${webChatPendingReminder.draftLine} ${toMerge}`.trim();
  webChatPendingReminder.draftLine = newDraft;

  const pendingMissing = new Set(webChatPendingReminder.missing || []);
  const reminderText = String(webChatPendingReminder.text || "").trim();
  if (pendingMissing.has("time") && !pendingMissing.has("date") && reminderText) {
    const tsOnly = webChatExtractTimeSpec(trimmed);
    if (tsOnly) {
      const whenFromSlots = webChatBuildWhenFromPendingReminder(webChatPendingReminder, tsOnly);
      if (whenFromSlots && !Number.isNaN(whenFromSlots.getTime()) && isFutureReminderInput(whenFromSlots)) {
        const gate = await webChatEnsureStandardForWebReminder(newDraft);
        if (!gate.ok) {
          return { handled: true, reply: gate.reply };
        }
        try {
          const reply = await webChatSaveWebReminder(
            whenFromSlots,
            reminderText,
            newDraft,
            newDraft.toLowerCase()
          );
          return { handled: true, reply };
        } catch (err) {
          return { handled: true, reply: webChatPlanErrorReply(err, newDraft) };
        }
      }
    }
  }

  const split = webChatSplitReminderAroundKeyword(newDraft);
  let body = stripWebChatReminderPrefix(newDraft);
  if (!body || body === newDraft) body = split.combined;
  if (!body) {
    return { handled: true, reply: webChatPendingAskMessage(webChatPendingReminder.missing, newDraft) };
  }

  const parsed = webChatParseNaturalReminderSchedule(body, split.after);
  if (parsed.type === "ask") {
    const missing = [];
    if (parsed.ask === "time") missing.push("time");
    else if (parsed.ask === "date") missing.push("date");
    else missing.push("date", "time");
    const clean = webChatCleanReminderBodyText(body);
    if (!clean) missing.push("text");
    webChatPendingReminder.missing = missing;
    webChatLastReminderUserRaw = newDraft;
    return { handled: true, reply: webChatPendingAskMessage(missing, newDraft) };
  }

  if (!currentUser || !accessToken) {
    resetWebChatPendingReminder();
    return { handled: true, reply: webChatT("webChatReminderNeedLogin", newDraft) };
  }
  const gate = await webChatEnsureStandardForWebReminder(newDraft);
  if (!gate.ok) {
    return { handled: true, reply: gate.reply };
  }

  const when = parsed.when;
  if (!when || Number.isNaN(when.getTime())) {
    return {
      handled: true,
      reply: `${webChatT("webChatReminderParseFail", newDraft)}\n\n${webChatT("webChatReminderExample", newDraft)}`
    };
  }
  if (!isFutureReminderInput(when)) {
    return { handled: true, reply: webChatT("reminderMustBeFuture", newDraft) };
  }

  let msg = webChatCleanReminderBodyText(String(parsed.message || "").trim());
  if (!msg) msg = webChatCleanReminderBodyText(String(split.after || "").trim());
  if (!msg) msg = webChatCleanReminderBodyText(String(body || "").trim());
  if (!msg) msg = String(webChatPendingReminder.text || "").trim();
  if (!msg) msg = webChatT("webChatReminderDefaultMessage", newDraft);

  try {
    const reply = await webChatSaveWebReminder(when, msg, newDraft, body.toLowerCase());
    return { handled: true, reply };
  } catch (err) {
    return { handled: true, reply: webChatPlanErrorReply(err, newDraft) };
  }
}

function webChatFormatReminderConfirmSummary(when, combinedLower, userMessageForLang) {
  const langSrc = String(userMessageForLang || combinedLower || "");
  const lang =
    typeof inferWebChatMessageLang === "function" ? inferWebChatMessageLang(langSrc) : "en";
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
        return `${webChatT("webChatRelativeInMinutes", langSrc).replace("{n}", n)} (${clock})`;
      }
      return `${webChatT("webChatRelativeInHours", langSrc).replace("{n}", n)} (${clock})`;
    }
  }
  if (/\b(pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(combinedLower)) {
    return `${webChatT("webChatRelativePasneser", langSrc)} ${webChatT("webChatReminderAt", langSrc)} ${clock}`;
  }
  if (/\b(nesër|neser|tomorrow)\b/i.test(combinedLower)) {
    return `${webChatT("webChatRelativeTomorrow", langSrc)} ${webChatT("webChatReminderAt", langSrc)} ${clock}`;
  }
  if (/\b(sot|today)\b/i.test(combinedLower)) {
    return `${webChatT("webChatRelativeToday", langSrc)} ${webChatT("webChatReminderAt", langSrc)} ${clock}`;
  }
  try {
    return when.toLocaleString(lang === "sq" ? "sq-AL" : undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (e) {
    return when.toLocaleString();
  }
}

async function webChatNaturalReminderHandler(trimmed) {
  const gate = await webChatEnsureStandardForWebReminder(trimmed);
  if (!gate.ok) return gate.reply;

  resetWebChatPendingReminder();

  const split = webChatSplitReminderAroundKeyword(trimmed);
  let body = stripWebChatReminderPrefix(trimmed);
  if (!body || body === trimmed) body = split.combined;
  if (!body) return webChatT("webChatReminderNeedDetails", trimmed);

  const parsed = webChatParseNaturalReminderSchedule(body, split.after);
  if (parsed.type === "ask") {
    webChatActivatePendingFromAsk(trimmed, parsed, body);
    return webChatPendingAskMessage(webChatPendingReminder.missing, trimmed);
  }

  const when = parsed.when;
  if (!when || Number.isNaN(when.getTime())) {
    return `${webChatT("webChatReminderParseFail", trimmed)}\n\n${webChatT("webChatReminderExample", trimmed)}`;
  }
  if (!isFutureReminderInput(when)) return webChatT("reminderMustBeFuture", trimmed);

  let msg = webChatCleanReminderBodyText(String(parsed.message || "").trim());
  if (!msg) msg = webChatCleanReminderBodyText(String(split.after || "").trim());
  if (!msg) msg = webChatCleanReminderBodyText(String(body || "").trim());
  if (!msg) msg = webChatT("webChatReminderDefaultMessage", trimmed);

  try {
    return await webChatSaveWebReminder(when, msg, trimmed, body.toLowerCase());
  } catch (err) {
    return webChatPlanErrorReply(err, trimmed);
  }
}

async function webChatCreateReminderFromBackend(raw) {
  return webChatNaturalReminderHandler(String(raw || "").trim());
}

async function resolveWebChatReply(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return webChatT("webChatReplyUnknownSmart", trimmed);

  const qOnly = trimmed.replace(/\s/g, "");
  const compact = trimmed.replace(/\s/g, "");
  if (/^\?+$/.test(qOnly) || /^(help|ndihme|ndihmë)\?$/i.test(compact)) {
    return webChatT("webChatHelpList", trimmed);
  }

  if (webChatPendingReminder.active) {
    const mergedIfKeyword = webChatMergeReminderFollowUp(trimmed);
    if (webChatHasReminderKeyword(mergedIfKeyword)) {
      return await webChatNaturalReminderHandler(mergedIfKeyword);
    }
    const pend = await webChatTryResolvePendingReminder(trimmed);
    if (pend.handled) return pend.reply;
  }

  if (/^what can you do\??$/i.test(trimmed.replace(/\s+/g, " ").trim())) {
    const sq = typeof inferWebChatMessageLang === "function" && inferWebChatMessageLang(trimmed) === "sq";
    return sq
      ? "Mund të krijoj kujtesa dhe të përputh komandat lokale (kujto / remind me). Shkruaj help për listën."
      : "I can create reminders and match local commands (remind me / kujto). Type help for the full list.";
  }

  const effective = webChatMergeReminderFollowUp(trimmed);

  if (webChatHasReminderKeyword(effective)) {
    return await webChatNaturalReminderHandler(effective);
  }

  const I = typeof window !== "undefined" ? window.webChatIntents : null;
  if (!I || typeof I.webChatFindBestIntent !== "function") {
    return webChatT("webChatReplyUnknownSmart", trimmed);
  }

  const hit = I.webChatFindBestIntent(trimmed);

  if (hit.chosenId === "help") return webChatT("webChatHelpList", trimmed);
  if (hit.chosenId === "greeting") return webChatT("webChatReplyHello", trimmed);
  if (hit.chosenId === "thanks") return webChatT("webChatReplyThanks", trimmed);
  if (hit.chosenId === "bye") return webChatT("webChatReplyBye", trimmed);
  if (hit.chosenId === "plans") return webChatT("webChatReplyPlans", trimmed);
  if (hit.chosenId === "scan_cam") return webChatT("webChatReplyScanCam", trimmed);
  if (hit.chosenId === "notes") return webChatT("webChatReplyNotes", trimmed);
  if (hit.chosenId === "settings") return webChatT("webChatReplySettings", trimmed);
  if (hit.chosenId === "home_reminders") return webChatT("webChatReplyHomeReminders", trimmed);
  if (hit.chosenId === "account_login") return webChatT("webChatReplyAccount", trimmed);
  if (hit.chosenId === "time") {
    const loc = typeof inferWebChatMessageLang === "function" && inferWebChatMessageLang(trimmed) === "sq" ? "sq-AL" : undefined;
    try {
      return webChatT("webChatReplyTime", trimmed).replace(
        "{time}",
        new Date().toLocaleString(loc)
      );
    } catch (e) {
      return webChatT("webChatReplyTime", trimmed).replace("{time}", new Date().toLocaleString());
    }
  }
  if (hit.chosenId === "reminder") return webChatCreateReminderFromBackend(effective);

  if (!hit.chosenId) {
    if (hit.bestId === "reminder" && hit.bestScore >= 1.75) {
      return `${webChatT("webChatUnknownNearReminder", trimmed)}\n\n${webChatT("webChatReplyUnknownSmart", trimmed)}`;
    }
    if (hit.bestId === "plans" && hit.bestScore >= 1.75) {
      return `${webChatT("webChatUnknownNearPlans", trimmed)}\n\n${webChatT("webChatReplyUnknownSmart", trimmed)}`;
    }
    if (hit.bestId === "scan_cam" && hit.bestScore >= 1.75) {
      return `${webChatT("webChatUnknownNearScanCam", trimmed)}\n\n${webChatT("webChatReplyUnknownSmart", trimmed)}`;
    }
    return webChatT("webChatReplyUnknownSmart", trimmed);
  }

  return webChatT("webChatReplyUnknownSmart", trimmed);
}

async function sendWebChatMessage() {
  const input = document.getElementById("webChatInput");
  const sendBtn = document.querySelector(".web-chat-send");
  if (!input) return;
  if (currentUser && typeof hasStandardAccess === "function" && !hasStandardAccess(currentUser)) {
    showToast(t("webChatRequiresStandard"));
    syncWebChatSoftPaywallUi();
    syncPremiumGatedNav();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  const mode = "chatbot";
  syncWebChatModePresentation(mode, false);
  appendWebChatBubble("user", text);
  input.value = "";
  webChatAutoResizeInput(input);
  if (sendBtn) sendBtn.disabled = true;
  appendWebChatTyping();
  const t0 = Date.now();
  try {
    const reply = await resolveWebChatReply(text);
    const elapsed = Date.now() - t0;
    const minTypingMs = 520;
    if (elapsed < minTypingMs) await webChatSleep(minTypingMs - elapsed);
    await webChatSleep(160);
    await appendWebChatBotReplyStreaming(reply || webChatT("webChatReplyUnknownSmart", text), {
      userMessage: text
    });
    webChatPushSessionTurn("user", text);
    webChatPushSessionTurn("bot", reply || webChatT("webChatReplyUnknownSmart", text));
    syncWebChatModePresentation(mode, false);
    webChatPushRecentCommand(text);
  } catch (e) {
    removeWebChatTyping();
    const errText =
      e && e.message ? String(e.message) : webChatT("webChatPlanVerifyFailed", text);
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

/**
 * User-facing release version from <meta name="notes-ai-app-version"> (bump in index.html when shipping APK).
 */
function refreshSettingsAppVersionLine() {
  const el = document.getElementById("settingsAppVersionLine");
  if (!el) return;
  try {
    const meta = document.querySelector('meta[name="notes-ai-app-version"]');
    const ver = String((meta && meta.getAttribute("content")) || "").trim() || "1.0";
    const template = typeof t === "function" ? t("settingsAppVersionLine") : "Version {version}";
    el.textContent = template.replace(/\{version\}/g, ver);
    el.classList.remove("hidden");
  } catch {
    el.textContent = "";
    el.classList.add("hidden");
  }
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
  refreshSettingsAppVersionLine();
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
  if (key === "premium") ensurePremiumLiteUiInitialized();
  refreshDepthRevealObservers();
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
      words: [
        "appearance",
        "theme",
        "language",
        "look",
        "dukje",
        "gjuha",
        "tema",
        "welcome",
        "mirëseardhje",
        "tutorial",
        "tour",
        "guid",
        "udhëz"
      ]
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

  if (!isAuthSessionReady() || authInvalidated) {
    welcomeEl.textContent = t("homeWelcomeGuest");
    notesEl.textContent = "—";
    remEl.textContent = "—";
    return;
  }

  if (homeDashboardStatsInFlight) return homeDashboardStatsInFlight;

  const p = (async () => {
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
    } catch (err) {
      if (err && (err.authSkipped || err.authSessionEnded)) {
        welcomeEl.textContent = t("homeWelcomeGuest");
        notesEl.textContent = "—";
        remEl.textContent = "—";
        return;
      }
      notesEl.textContent = "—";
      remEl.textContent = "—";
    }
  })();

  homeDashboardStatsInFlight = p.finally(() => {
    homeDashboardStatsInFlight = null;
  });
  return homeDashboardStatsInFlight;
}

/** Shares one GET /api/reminders/web promise while concurrent callers await (hub + reminders panel + polling overlap). */
let webRemindersListFetchPromise = null;
/** Dedupes Home stats (/api/notes?count + reminders) bursts from goHome + parallel UI. */
let homeDashboardStatsInFlight = null;

function fetchWebRemindersListDeduped() {
  if (!isAuthSessionReady() || authInvalidated) {
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
    void maybePromptReminderNotificationPermission();
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
    void maybePromptReminderNotificationPermission();
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
      if (!reminder.sent && new Date(reminder.time).getTime() <= Date.now()) {
        const overdueEl = document.createElement("span");
        overdueEl.className = "reminder-status-overdue";
        overdueEl.textContent = t("reminderStatusOverdue");
        timeDiv.appendChild(document.createTextNode(" "));
        timeDiv.appendChild(overdueEl);
      }
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
      setWebReminderNotificationsAppEnabled(true);
      void initNotesAiNativeLocalNotificationShell();
      showToast(t("notificationsEnabledToast"));
      void syncPlannerLocalNotifications();
      if (currentUser && accessToken) {
        void fetchWebRemindersListDeduped()
          .then((data) => syncReminderLocalNotifications((data && data.reminders) || []))
          .catch(() => {});
      }
      void registerWebPushSubscription();
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
  syncAppBackgroundActivity();
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
    void maybePromptReminderNotificationPermission();
  } catch (err) {
    showToast(err.message);
  }
}

async function loadWebReminders() {
  if (!isAuthSessionReady() || authInvalidated) return;

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
      if (!reminder.sent && new Date(reminder.time).getTime() <= Date.now()) {
        const overdueEl = document.createElement("span");
        overdueEl.className = "reminder-status-overdue";
        overdueEl.textContent = t("reminderStatusOverdue");
        timeEl.appendChild(document.createTextNode(" "));
        timeEl.appendChild(overdueEl);
      }
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
    if (err && (err.authSkipped || err.authSessionEnded)) return;
    if (isAuthDevHost()) console.warn("[web reminders] list:", err && err.message ? err.message : err);
  }
}

// ============ WEB NOTIFICATION SCHEDULER ============

/** Single guard so reminder polling interval + visibility hook are only registered once. */
let reminderPollingStarted = false;
let webNotificationSchedulerIntervalId = null;
let webNotificationVisibilityHooked = false;
/** Coalesces overlapping due-check passes (interval + visibility + concurrent UI). */
let reminderDueCheckInFlight = null;
let lastReminderVisibilityPollMs = 0;
const REMINDER_POLL_INTERVAL_MS = 90000;
const REMINDER_VISIBILITY_POLL_MIN_MS = 50000;

function stopWebReminderPollingScheduler() {
  if (webNotificationSchedulerIntervalId != null) {
    window.clearInterval(webNotificationSchedulerIntervalId);
    webNotificationSchedulerIntervalId = null;
  }
  reminderPollingStarted = false;
  reminderPollingSuspendedByHidden = false;
}

/** Clear session after invalid/expired tokens without toast; idempotent. */
function invalidateAuthSessionSilently() {
  refreshAccessTokenPromise = null;
  registerWebPushInFlight = null;
  webRemindersListFetchPromise = null;
  homeDashboardStatsInFlight = null;
  authInvalidated = true;
  appPublicConfigCacheExpiresAt = 0;
  stopWebReminderPollingScheduler();
  webChatSessionTurns = [];
  webChatLastReminderUserRaw = null;
  if (typeof resetWebChatPendingReminder === "function") resetWebChatPendingReminder();
  const hadTokens = Boolean(currentUser || accessToken || refreshToken);
  if (hadTokens) {
    clearCurrentUser();
    if (!authBootstrapPhaseActive) {
      syncAuthShellVisibility();
      syncMobileHeaderActionUi();
      updatePremiumUi();
    }
  }
}

function startWebNotificationScheduler() {
  if (reminderPollingStarted) return;
  reminderPollingStarted = true;
  if (isNativeLocalNotificationsAvailable()) {
    void syncPlannerLocalNotifications();
    return;
  }
  webNotificationSchedulerIntervalId = window.setInterval(() => {
    if (isDocumentHidden()) return;
    void checkForDueReminders();
  }, REMINDER_POLL_INTERVAL_MS);
  if (!webNotificationVisibilityHooked) {
    webNotificationVisibilityHooked = true;
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "visible") return;
        if (!isAuthSessionReady() || authInvalidated || authBootstrapPhaseActive) return;
        const now = Date.now();
        if (now - lastReminderVisibilityPollMs < REMINDER_VISIBILITY_POLL_MIN_MS) return;
        lastReminderVisibilityPollMs = now;
        void checkForDueReminders();
      },
      { passive: true }
    );
  }
  void checkForDueReminders();
}

async function checkForDueReminders() {
  if (reminderDueCheckInFlight) return reminderDueCheckInFlight;
  reminderDueCheckInFlight = (async () => {
    try {
      if (isNativeLocalNotificationsAvailable()) return;
      if (!webReminderNotificationsAppEnabled()) return;
      if (authBootstrapPhaseActive) return;
      if (authInvalidated) return;
      if (!isAuthSessionReady()) return;

      const data = await fetchWebRemindersListDeduped();
      const reminders = data.reminders || [];

      const now = new Date();

      for (const reminder of reminders) {
        if (reminder.sent) continue;
        if (!isReminderNotificationEnabled(reminder._id)) continue;
        const reminderTime = new Date(reminder.time);
        if (reminderTime <= now) {
          void showWebNotification(reminder);
        }
      }
    } catch (err) {
      if (err && (err.authSkipped || err.authSessionEnded || err.refreshNetworkError)) return;
      if (isAuthDevHost()) console.warn("[reminders] poll:", err && err.message ? err.message : err);
    } finally {
      reminderDueCheckInFlight = null;
    }
  })();
  return reminderDueCheckInFlight;
}

async function showWebNotification(reminder) {
  if (isNativeLocalNotificationsAvailable()) return;
  if (!webReminderNotificationsAppEnabled()) return;
  const id = String(reminder._id);
  if (webNotificationLock.has(id)) return;
  if (!isReminderNotificationEnabled(reminder._id)) return;

  if (!("Notification" in window)) {
    showToast(t("notificationsNotSupported"));
    return;
  }

  const title = t("webNotificationTitle");
  const body = reminder.message || t("reminderDefaultBody");
  const tag = `reminder-${id}`;
  const opts = webReminderNotificationOpts(body, tag, {
    reminderId: id,
    url: buildAppHomeHashUrl()
  });

  if (Notification.permission === "granted") {
    webNotificationLock.add(id);
    try {
      await showReminderSystemNotification(title, opts);
      if (document.visibilityState === "visible") {
        showReminderForegroundToast(body);
      }
      await markReminderAsSent(reminder._id).catch(() => {});
    } catch {
      /* non-fatal */
    } finally {
      webNotificationLock.delete(id);
      refreshReminderRelatedViews();
    }
  } else if (Notification.permission === "denied") {
    webNotificationLock.add(id);
    showToast(t("reminderNotifyEnableInBrowser"));
    await markReminderAsSent(reminder._id).catch(() => {});
    webNotificationLock.delete(id);
    refreshReminderRelatedViews();
  } else {
    try {
      const p = await Notification.requestPermission();
      if (p === "granted") {
        await showWebNotification(reminder);
        return;
      }
      showToast(t("reminderNotifyEnableInBrowser"));
    } catch {
      showToast(t("reminderNotifyEnableInBrowser"));
    }
    webNotificationLock.add(id);
    await markReminderAsSent(reminder._id).catch(() => {});
    webNotificationLock.delete(id);
    refreshReminderRelatedViews();
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
  const category = currentCategory;
  if (loadNotesInflight && loadNotesInflightCategory === category) return loadNotesInflight;
  loadNotesInflightCategory = category;
  loadNotesInflight = loadNotesInner(category).finally(() => {
    if (loadNotesInflightCategory === category) {
      loadNotesInflight = null;
      loadNotesInflightCategory = "";
    }
  });
  return loadNotesInflight;
}

async function loadNotesInner(category) {
  try {
    const data = await apiFetch(`/api/notes/${category}`);
    let list = data.notes || [];
    if (category === "scan_cam") {
      list = scanCamNotesForListDisplay(mergeNotesWithScanCamLocal(list));
    }
    currentNotes = list;
    offlineNotesRecordSuccessfulCategoryLoad(category, list);
    renderNotes(currentNotes);
    syncOfflineIndicatorUi();
  } catch (err) {
    const fallback =
      currentUser && category ? offlineNotesPickCategoryList(category) : null;
    if (fallback != null && Array.isArray(fallback)) {
      let list = fallback;
      if (category === "scan_cam") {
        list = scanCamNotesForListDisplay(mergeNotesWithScanCamLocal(list));
      }
      currentNotes = list;
      renderNotes(currentNotes);
      if (!isBrowserOnline() || isOfflineOrNetworkError(err))
        showToast(typeof t === "function" ? t("offlineShowingCachedCategory") : err.message);
      else showToast(err.message);
      syncOfflineIndicatorUi();
      return;
    }
    showToast(err.message);
    currentNotes = [];
    renderNotes([]);
    syncOfflineIndicatorUi();
  }
}

function renderNotes(notes) {
  const container = document.getElementById("notes");
  const noteCount = document.getElementById("noteCount");
  if (!container || !noteCount) return;

  const renderKey = notesListRenderKey(notes, currentCategory || "public");
  if (renderKey === lastCategoryNotesRenderKey && container.children.length > 0) {
    noteCount.innerText = `${notes.length} notes`;
    return;
  }
  lastCategoryNotesRenderKey = renderKey;

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

  renderIncrementalList(container, notes, appendCategoryNoteCard, {
    onComplete: () => {
      if (!isScanCamCategoryActive()) refreshDepthRevealObservers();
    }
  });
}

function populateNoteEditorCategorySelect() {
  const select = document.getElementById("noteEditorCategory");
  if (!select) return;
  select.innerHTML = "";
  Object.keys(categories).forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = getCategoryDisplayLabel(key);
    select.appendChild(option);
  });
}

function syncCategoryDependentUi() {
  try {
    const catPage = document.getElementById("category");
    if (catPage && !catPage.classList.contains("hidden") && currentCategory) {
      const el = document.getElementById("catTitle");
      if (el) el.textContent = getCategoryDisplayLabel(currentCategory);
    }
    populateNoteEditorCategorySelect();
    if (typeof allNotes !== "undefined" && Array.isArray(allNotes)) {
      populateAllNotesCategoryFilter(allNotes);
    }
    const notesAll = document.getElementById("notes-all");
    if (notesAll && !notesAll.classList.contains("hidden") && typeof filterAllNotesList === "function") {
      filterAllNotesList();
    }
  } catch (_) {}
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

    if (!isBrowserOnline()) {
      const tempId = offlineMakeTempNoteId();
      const note = {
        _id: tempId,
        category,
        text: storageText,
        title: titleTrim,
        createdAt: new Date().toISOString(),
        offlinePending: true
      };
      offlineNotesEnqueue({
        op: "create",
        tempId,
        category,
        text: storageText,
        title: titleTrim
      });
      const id = String(note._id);
      allNotes = [note, ...allNotes.filter((n) => String(n._id) !== id)];
      if (category === currentCategory) {
        currentNotes = [note, ...currentNotes.filter((n) => String(n._id) !== id)];
      }
      offlineNotesRecordSuccessfulLoadAll(mergeNotesWithScanCamLocal(allNotes));
      noteEditorState = {
        mode: "edit",
        origin,
        editingNote: note,
        presetCategory: null
      };
      syncOfflineIndicatorUi();
      if (typeof showToast === "function") showToast(t("offlineNoteSavedLocal"));
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

  if (idStr.startsWith("offline-")) {
    offlineNotesPatchQueuedCreate(idStr, storageText, titleTrim);
    const prev = noteEditorState.editingNote || {};
    const updated = { ...prev, _id: idStr, text: storageText, title: titleTrim };
    const lid = idStr;
    const replace = (arr) => {
      const ix = arr.findIndex((n) => String(n._id) === lid);
      if (ix >= 0) arr[ix] = updated;
    };
    replace(allNotes);
    replace(currentNotes);
    offlineNotesRecordSuccessfulLoadAll(mergeNotesWithScanCamLocal(allNotes));
    noteEditorState.editingNote = updated;
    syncOfflineIndicatorUi();
    return { note: updated };
  }

  if (!isBrowserOnline()) {
    offlineNotesEnqueue({
      op: "update",
      noteId: idStr,
      text: storageText,
      title: titleTrim
    });
    const prev = noteEditorState.editingNote || {};
    const updated = { ...prev, _id: idStr, text: storageText, title: titleTrim };
    const replace = (arr) => {
      const ix = arr.findIndex((n) => String(n._id) === idStr);
      if (ix >= 0) arr[ix] = updated;
    };
    replace(allNotes);
    replace(currentNotes);
    offlineNotesRecordSuccessfulLoadAll(mergeNotesWithScanCamLocal(allNotes));
    noteEditorState.editingNote = updated;
    syncOfflineIndicatorUi();
    if (typeof showToast === "function") showToast(t("offlineNoteSavedLocal"));
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
  void (async () => {
    try {
      await ensureNoteRichEditorLoaded();
    } catch {
      showToast("Editor failed to load. Refresh the page.");
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
  })();
}

function openNoteEditorEdit(note, origin) {
  if (!requireAuth("edit a note")) return;
  if (!note || !note._id) return;
  void (async () => {
    try {
      await ensureNoteRichEditorLoaded();
    } catch {
      showToast("Editor failed to load. Refresh the page.");
      return;
    }
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
  })();
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
      } else if (!isBrowserOnline()) {
        const tempId = offlineMakeTempNoteId();
        const note = {
          _id: tempId,
          category,
          text,
          title,
          createdAt: new Date().toISOString(),
          offlinePending: true
        };
        offlineNotesEnqueue({ op: "create", tempId, category, text, title });
        const id = String(note._id);
        allNotes = [note, ...allNotes.filter((n) => String(n._id) !== id)];
        if (category === currentCategory) {
          currentNotes = [note, ...currentNotes.filter((n) => String(n._id) !== id)];
        }
        offlineNotesRecordSuccessfulLoadAll(mergeNotesWithScanCamLocal(allNotes));
        syncOfflineIndicatorUi();
        showToast(t("offlineNoteSavedLocal"));
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
      } else if (lid.startsWith("offline-")) {
        offlineNotesPatchQueuedCreate(lid, text, title);
        const updated = { ...note, text, title };
        const replace = (arr) => {
          const ix = arr.findIndex((n) => String(n._id) === lid);
          if (ix >= 0) arr[ix] = updated;
        };
        replace(allNotes);
        replace(currentNotes);
        offlineNotesRecordSuccessfulLoadAll(mergeNotesWithScanCamLocal(allNotes));
        syncOfflineIndicatorUi();
        showToast(t("offlineNoteSavedLocal"));
      } else if (!isBrowserOnline()) {
        offlineNotesEnqueue({ op: "update", noteId: lid, text, title });
        const updated = { ...note, text, title };
        const replace = (arr) => {
          const ix = arr.findIndex((n) => String(n._id) === lid);
          if (ix >= 0) arr[ix] = updated;
        };
        replace(allNotes);
        replace(currentNotes);
        offlineNotesRecordSuccessfulLoadAll(mergeNotesWithScanCamLocal(allNotes));
        syncOfflineIndicatorUi();
        showToast(t("offlineNoteSavedLocal"));
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

  if (idStr.startsWith("offline-")) {
    offlineNotesDropQueueOpsForNoteId(idStr);
    offlineNotesRemoveNoteInMemory(idStr);
    offlineNotesRemoveNoteInSnapshot(idStr);
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
    syncOfflineIndicatorUi();
    return;
  }

  if (!isBrowserOnline()) {
    offlineNotesEnqueue({ op: "delete", noteId: idStr });
    offlineNotesRemoveNoteInMemory(idStr);
    offlineNotesRemoveNoteInSnapshot(idStr);
    showToast(t("offlineNoteDeletedPending"));
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
    syncOfflineIndicatorUi();
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

function getCategoryDisplayLabel(key) {
  if (key == null || key === "") return "";
  const k = String(key).trim();
  if (typeof categories !== "undefined" && Object.prototype.hasOwnProperty.call(categories, k)) {
    return typeof t === "function" ? t(k) : categories[k] || k;
  }
  return k;
}

function normalizeNoteCategoryLabel(note) {
  const key = normalizeNoteCategoryKey(note);
  if (!key) return t("myNotesUncategorizedBadge");
  if (typeof categories !== "undefined" && Object.prototype.hasOwnProperty.call(categories, key)) {
    return getCategoryDisplayLabel(key);
  }
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
    return noteSearchHaystack(note).includes(q);
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
  const q = (document.getElementById("notesSearchInput")?.value || "").trim().toLowerCase();
  const catFilter = document.getElementById("notesCategoryFilter")?.value || "all";
  const renderKey = notesListRenderKey(filtered, `${q}|${catFilter}|${allNotesSortMode}`);
  const container = document.getElementById("allNotesList");
  const countEl = document.getElementById("allNotesCount");
  if (renderKey === lastAllNotesRenderKey && container && container.children.length > 0) {
    if (countEl) countEl.textContent = `${filtered.length} ${t("notes")}`;
    return;
  }
  lastAllNotesRenderKey = renderKey;
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

  if (loadMyNotesInflight) return loadMyNotesInflight;
  loadMyNotesInflight = loadMyNotesInner().finally(() => {
    loadMyNotesInflight = null;
  });
  return loadMyNotesInflight;
}

async function loadMyNotesInner() {
  const container = document.getElementById("allNotesList");
  const countEl = document.getElementById("allNotesCount");
  if (!container || !countEl) return;

  try {
    const data = await apiFetch("/api/notes");
    const notes = data.notes || [];
    const merged = mergeNotesWithScanCamLocal(notes);
    allNotes = merged;
    offlineNotesRecordSuccessfulLoadAll(allNotes);
    populateAllNotesCategoryFilter(merged);
    const sortSelect = document.getElementById("notesSortSelect");
    if (sortSelect) sortSelect.value = allNotesSortMode;
    filterAllNotesList();
    syncOfflineIndicatorUi();
  } catch (err) {
    const snap = offlineNotesReadSnapshot();
    if (snap && Array.isArray(snap.allNotes) && currentUser) {
      const merged = mergeNotesWithScanCamLocal(snap.allNotes);
      allNotes = merged;
      populateAllNotesCategoryFilter(merged);
      const sortSelect = document.getElementById("notesSortSelect");
      if (sortSelect) sortSelect.value = allNotesSortMode;
      filterAllNotesList();
      if (!isBrowserOnline() || isOfflineOrNetworkError(err))
        showToast(typeof t === "function" ? t("offlineShowingCachedNotes") : err.message);
      else showToast(err.message);
      syncOfflineIndicatorUi();
      return;
    }
    showToast(err.message);
    countEl.textContent = `0 ${t("notes")}`;
    container.className = "notes-list";
    container.innerHTML = `<div class="note-card"><div class="note-content"><p>${escapeHtml(err.message)}</p></div></div>`;
    refreshDepthRevealObservers();
    syncOfflineIndicatorUi();
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

function appendCategoryNoteCard(parent, note) {
  const noteCard = document.createElement("div");
  noteCard.className = isScanCamListNote(note) ? "note-card note-card--scan-list" : "note-card";
  const content = document.createElement("div");
  content.className = "note-content";
  appendNoteCardHeadingAndBody(content, note);
  const canManage = currentUser && !note.public;
  if (canManage) {
    content.appendChild(createNoteActionToolbar(note, "category"));
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
  noteCard.appendChild(content);
  parent.appendChild(noteCard);
}

function appendMyNoteCard(container, note) {
  const theme = noteCategoryThemeKey(note.category);
  const noteCard = document.createElement("div");
  noteCard.className = `note-card note-card--accent-${theme}`;
  const content = document.createElement("div");
  content.className = "note-content";
  const badge = document.createElement("span");
  badge.className = `note-category-badge note-category-badge--${theme}`;
  const rawCat = note.category && String(note.category).trim();
  badge.textContent = rawCat
    ? getCategoryDisplayLabel(rawCat)
    : t("myNotesUncategorizedBadge");
  content.appendChild(badge);
  appendNoteCardHeadingAndBody(content, note);
  content.appendChild(createNoteActionToolbar(note, "all"));
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
  noteCard.appendChild(content);
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
  renderIncrementalList(
    container,
    notes,
    (parent, note) => appendMyNoteCard(parent, note),
    { onComplete: () => refreshDepthRevealObservers() }
  );
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

function clearAppLifecycleTimers() {
  if (dailyPlannerNotifyTimer) {
    window.clearInterval(dailyPlannerNotifyTimer);
    dailyPlannerNotifyTimer = null;
  }
  dailyPlannerNotifyLoopRegistered = false;
  if (dailyPlannerMidnightTimer) {
    window.clearTimeout(dailyPlannerMidnightTimer);
    dailyPlannerMidnightTimer = null;
  }
  if (offlineNotesFlushIntervalId != null) {
    window.clearInterval(offlineNotesFlushIntervalId);
    offlineNotesFlushIntervalId = null;
  }
  pauseWebChatFabPromptCycle();
  if (webChatFabTipTimer) {
    window.clearTimeout(webChatFabTipTimer);
    webChatFabTipTimer = null;
  }
  mergePremiumFromServerInflight = null;
  loadNotesInflight = null;
  loadNotesInflightCategory = "";
  loadMyNotesInflight = null;
  teardownWebChatDrawerUi();
}

function ensureOfflineNotesFlushInterval() {
  if (offlineNotesFlushIntervalId != null) return;
  offlineFlushSuspendedByHidden = false;
  offlineNotesFlushIntervalId = window.setInterval(() => {
    if (isDocumentHidden()) return;
    if (isBrowserOnline() && offlineNotesReadQueue().length) void offlineNotesFlushQueue();
  }, 45000);
}

function logoutUser() {
  nativeOAuthDeepLinkHandled = false;
  stopWebReminderPollingScheduler();
  clearAppLifecycleTimers();
  webRemindersListFetchPromise = null;
  homeDashboardStatsInFlight = null;
  webChatSessionTurns = [];
  webChatLastReminderUserRaw = null;
  authInvalidated = false;
  refreshAccessTokenPromise = null;
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
  const subscriptionRedeem = document.getElementById("settingsSubscriptionRedeem");
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
    if (subscriptionRedeem) subscriptionRedeem.classList.remove("hidden");
    if (premiumLead) {
      premiumLead.setAttribute("data-t", "settingsPlanPitch");
      premiumLead.textContent = t("settingsPlanPitch");
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
    const syntheticRe = /@users\.notesai\.invalid$/i;
    const emailPrimary = String(currentUser.email || "").trim();
    const emailFallback = String(currentUser.emailOrPhone || "").trim();
    const resolvedEmail =
      emailPrimary && !syntheticRe.test(emailPrimary)
        ? emailPrimary
        : emailFallback && !syntheticRe.test(emailFallback)
          ? emailFallback
          : emailPrimary || emailFallback;
    em.textContent = resolvedEmail && !syntheticRe.test(resolvedEmail) ? resolvedEmail : "—";
  }

  const standardActive =
    typeof hasStandardAccess === "function" && hasStandardAccess(currentUser);
  let planLabel = t("premiumPlanFreeName");
  if (standardActive) planLabel = t("premiumPlanStandardName");
  if (badge) {
    badge.textContent = planLabel;
    badge.classList.toggle("settings-plan-badge--premium", false);
    badge.classList.toggle("settings-plan-badge--standard", !!standardActive);
  }
  if (upgradeBtn) upgradeBtn.classList.toggle("hidden", !!standardActive);
  if (premiumNote) premiumNote.classList.toggle("hidden", !standardActive);
  if (premiumActiveBadge) premiumActiveBadge.classList.toggle("hidden", !standardActive);
  if (premiumLead) {
    const leadKey = standardActive ? "settingsStandardShort" : "settingsPlanPitch";
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
  const normalizedPlan = planText === "premium" ? "standard" : planText;
  const statusText = standardActive
    ? String(currentUser.standardSource || currentUser.lifecycle || "active")
    : "free";
  const cancelScheduled = false;
  const periodEndText = currentUser.currentPeriodEnd
    ? new Date(currentUser.currentPeriodEnd).toLocaleString()
    : currentUser.trialEndsAt || currentUser.standardExpiresAt || currentUser.premiumExpiresAt
      ? new Date(
          currentUser.trialEndsAt || currentUser.standardExpiresAt || currentUser.premiumExpiresAt
        ).toLocaleString()
      : "—";
  if (billingPlan) billingPlan.textContent = normalizedPlan;
  if (billingStatus) billingStatus.textContent = statusText;
  if (billingCancelAtPeriodEnd) billingCancelAtPeriodEnd.textContent = cancelScheduled ? "Yes" : "No";
  if (billingCurrentPeriodEnd) billingCurrentPeriodEnd.textContent = periodEndText;
  if (cancelBtn) cancelBtn.classList.add("hidden");
  if (cancelHint) cancelHint.classList.add("hidden");

  const adminRow = document.getElementById("settingsAdminRow");
  if (adminRow) {
    const isAdmin = (currentUser.role || "user") === "admin";
    adminRow.classList.toggle("hidden", !isAdmin);
  }

  updateSettingsSecurityGuestState();
}

async function cancelSubscriptionFromSettings() {
  showToast(typeof t === "function" ? t("premiumBillingCoinsOnly") : "Standard is unlocked with coins — no card subscription.");
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

  const appOn = webReminderNotificationsAppEnabled();
  if (perm === "granted") {
    el.textContent = appOn ? t("settingsNotifStatusGranted") : t("settingsNotifStatusGrantedPaused");
  } else if (perm === "denied") {
    /** Web uses Notification.permission (per-origin); Capacitor app uses OS plugin—messages can disagree across devices legitimately. */
    let deniedText = t("settingsNotifStatusDenied");
    if (!isNativeLocalNotificationsAvailable())
      deniedText += " " + t("settingsNotifDeniedBrowserNote");
    el.textContent = deniedText;
  } else {
    el.textContent = t("settingsNotifStatusDefault");
  }
  if (toggle) {
    if (perm === "denied") {
      toggle.disabled = true;
      toggle.checked = false;
    } else {
      toggle.disabled = false;
      if (perm === "granted") {
        toggle.checked = appOn;
      } else {
        toggle.checked = false;
      }
    }
  }
  if (enableBtn) {
    enableBtn.classList.toggle("hidden", perm === "granted");
  }

  const wrap = document.getElementById("settingsNotifSection");
  if (wrap) wrap.classList.toggle("settings-notif-card--paused", perm === "granted" && !appOn);

  const pushLine = document.getElementById("settingsWebPushDeliveryLine");
  if (pushLine) {
    if (isNativeLocalNotificationsAvailable()) {
      pushLine.textContent = "";
      pushLine.classList.add("hidden");
    } else if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      pushLine.textContent = t("settingsPushBackgroundUnsupported");
      pushLine.classList.remove("hidden");
    } else if (!("Notification" in window)) {
      pushLine.textContent = t("settingsPushBackgroundUnsupported");
      pushLine.classList.remove("hidden");
    } else if (perm === "denied") {
      pushLine.textContent = t("settingsPushBackgroundBlocked");
      pushLine.classList.remove("hidden");
    } else if (perm === "granted" && appOn) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
        pushLine.textContent = sub ? t("settingsPushBackgroundActive") : t("settingsPushBackgroundPending");
      } catch {
        pushLine.textContent = t("settingsPushBackgroundPending");
      }
      pushLine.classList.remove("hidden");
    } else {
      pushLine.textContent = t("settingsPushBackgroundPending");
      pushLine.classList.remove("hidden");
    }
  }
}

async function settingsNotificationsToggleChanged(checked) {
  const toggleEl = document.getElementById("settingsNotifToggle");

  const revertToggle = () => {
    if (toggleEl) toggleEl.checked = !checked;
    void updateSettingsNotificationStatus();
  };

  if (isNativeLocalNotificationsAvailable()) {
    if (checked) {
      setWebReminderNotificationsAppEnabled(true);
      const ok = await requestNotificationPermissionIfNeeded(true);
      if (!ok) {
        setWebReminderNotificationsAppEnabled(false);
        revertToggle();
        showToast(t("notificationsDenied"));
      } else {
        showToast(t("notificationsEnabledToast"));
        void syncPlannerLocalNotifications();
        if (currentUser && accessToken) {
          void fetchWebRemindersListDeduped()
            .then((data) => syncReminderLocalNotifications((data && data.reminders) || []))
            .catch(() => {});
        }
      }
    } else if (!window.confirm(t("settingsNotificationsDisableConfirm"))) {
      revertToggle();
      return;
    } else {
      setWebReminderNotificationsAppEnabled(false);
      void syncPlannerLocalNotifications();
      if (currentUser && accessToken) {
        void fetchWebRemindersListDeduped()
          .then((data) => syncReminderLocalNotifications((data && data.reminders) || []))
          .catch(() => {});
      }
      showToast(t("settingsNotificationsDisabledToast"));
    }
    void updateSettingsNotificationStatus();
    return;
  }

  if (!("Notification" in window)) {
    revertToggle();
    showToast(t("notificationsNotSupported"));
    return;
  }

  if (checked) {
    if (Notification.permission !== "granted") {
      await requestNotificationPermissionIfNeeded(true);
    }
    if (Notification.permission !== "granted") {
      setWebReminderNotificationsAppEnabled(false);
      revertToggle();
      showToast(t("notificationsDenied"));
      void updateSettingsNotificationStatus();
      return;
    }
    setWebReminderNotificationsAppEnabled(true);
    showToast(t("notificationsEnabledToast"));
    void syncPlannerLocalNotifications();
    if (currentUser && accessToken) {
      void fetchWebRemindersListDeduped()
        .then((data) => syncReminderLocalNotifications((data && data.reminders) || []))
        .catch(() => {});
    }
    startWebNotificationScheduler();
    void registerWebPushSubscription();
  } else if (Notification.permission === "granted") {
    if (!window.confirm(t("settingsNotificationsDisableConfirm"))) {
      revertToggle();
      return;
    }
    setWebReminderNotificationsAppEnabled(false);
    void unregisterWebPushSubscriptionFromServerAndBrowser();
    showToast(t("settingsNotificationsDisabledToast"));
    void syncPlannerLocalNotifications();
    if (currentUser && accessToken) {
      void fetchWebRemindersListDeduped()
        .then((data) => syncReminderLocalNotifications((data && data.reminders) || []))
        .catch(() => {});
    }
  }

  void updateSettingsNotificationStatus();
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
    refreshSettingsAppVersionLine();
  }
  if (!document.getElementById("reminder-history")?.classList.contains("hidden")) {
    applyHistoryFilterAndRender();
  }
  const dailyPlannerModal = document.getElementById("dailyPlannerModal");
  if (dailyPlannerModal && !dailyPlannerModal.classList.contains("hidden")) {
    renderDailyPlannerList();
  }
  if (typeof syncDailyPlannerAccessUi === "function") {
    syncDailyPlannerAccessUi();
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
  if (!isAuthSessionReady() || authInvalidated) return;

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
    if (err && (err.authSkipped || err.authSessionEnded)) return;
    if (isAuthDevHost()) {
      console.warn("[settings] not loaded from server:", err && err.message ? err.message : err);
    }
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
  if (window.__appListenersReady) return;
  window.__appListenersReady = true;

  initServiceWorkerNotificationRouting();
  normalizeSpaShellPaths();
  authBootstrapPhaseActive = true;
  try {
    captureInviteCodeFromLocation();
    await initNativeOAuthDeepLinks();
    await runAuthBootstrap();
  } catch (err) {
    console.error("[auth-bootstrap]", err);
  } finally {
    authBootstrapPhaseActive = false;
    document.documentElement.classList.remove("auth-bootstrap-pending");
  }

  normalizeSpaShellPaths();
  handleGoogleOAuthQueryParams();

  initAuthLandingUi();
  void initNotesAiNativeLocalNotificationShell();
  // Initialize theme and language
  applyTheme(getCurrentTheme());
  applyTranslations();

  coinsHubEnsureStreakDelegate();

  updateAccountUI();
  syncAuthShellVisibility();
  updatePremiumUi();

  if (pendingPostOAuthPresentation) {
    await presentPendingPostOAuthLandingIfAny();
  } else if (isAuthSessionReady()) {
    await loadUserSettings();
    startWebNotificationScheduler();
    if (
      !isNativeLocalNotificationsAvailable() &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      webReminderNotificationsAppEnabled()
    ) {
      void registerWebPushSubscription();
    }
    goHome();
    if (typeof scheduleOnboardingTutorialAfterAuth === "function") scheduleOnboardingTutorialAfterAuth();
  }
  if (isAuthSessionReady() && isBrowserOnline()) void offlineNotesFlushQueue();

  window.addEventListener("online", () => {
    syncOfflineIndicatorUi();
    if (typeof applyTranslations === "function") applyTranslations();
    void offlineNotesFlushQueue();
  });
  window.addEventListener("offline", () => {
    syncOfflineIndicatorUi();
    if (typeof applyTranslations === "function") applyTranslations();
  });
  if (offlineNotesFlushIntervalId != null) {
    window.clearInterval(offlineNotesFlushIntervalId);
  }
  ensureOfflineNotesFlushInterval();
  syncOfflineIndicatorUi();

  initDepthRevealSystem();
  initAppBackgroundHooks();
  cleanupDailyPlannerStorage();
  scheduleDailyPlannerMidnightReset();
  scheduleDailyPlannerNotificationLoop();
  renderDailyPlannerList();
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

  let lastDepthParallaxRounded = -1;
  let lastFloatingScrolledState = null;
  let lastMobileScrolledState = null;
  let lastTopbarScrollY = 0;
  let topbarAutoHidden = false;
  const useCompactScrollHeader = () => {
    if (typeof isNativeApp === "function" && isNativeApp()) return false;
    if (isMobileViewport()) return false;
    return true;
  };
  const useAutoHideTopbar = () =>
    isMobileViewport() || (typeof isNativeApp === "function" && isNativeApp());
  const skipFloatingScrollFx = () =>
    isMobileViewport() || (typeof isNativeApp === "function" && isNativeApp());
  const syncTopbarAutoHide = (y) => {
    if (!useAutoHideTopbar()) {
      if (topbarAutoHidden) {
        topbarAutoHidden = false;
        document.body.classList.remove("topbar-auto-hidden");
      }
      lastTopbarScrollY = y;
      return;
    }
    if (
      document.body.classList.contains("mobile-nav-open") ||
      document.body.classList.contains("web-chat-drawer-open")
    ) {
      if (topbarAutoHidden) {
        topbarAutoHidden = false;
        document.body.classList.remove("topbar-auto-hidden");
      }
      lastTopbarScrollY = y;
      return;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let hidden = topbarAutoHidden;
    const delta = y - lastTopbarScrollY;
    if (y <= 10) {
      hidden = false;
    } else if (!reduceMotion && delta > 5) {
      hidden = true;
    } else if (!reduceMotion && delta < -5) {
      hidden = false;
    }
    lastTopbarScrollY = y;
    if (hidden !== topbarAutoHidden) {
      topbarAutoHidden = hidden;
      document.body.classList.toggle("topbar-auto-hidden", hidden);
    }
  };
  const syncMobileScrollState = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    const canvas = document.querySelector(".background-canvas");
    const skipParallax =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      (typeof isNativeApp === "function" && isNativeApp()) ||
      isMobileViewport();
    if (canvas) {
      if (skipParallax) {
        if (lastDepthParallaxRounded !== 0) {
          lastDepthParallaxRounded = 0;
          canvas.style.setProperty("--depth-parallax-y", "0px");
        }
      } else {
        const parallax = Math.min(y * 0.065, 96);
        const rounded = Math.round(parallax * 4) / 4;
        if (rounded !== lastDepthParallaxRounded) {
          lastDepthParallaxRounded = rounded;
          canvas.style.setProperty("--depth-parallax-y", `${rounded}px`);
        }
      }
    }
    const scrolled = y > 12;
    if (useCompactScrollHeader()) {
      if (lastMobileScrolledState !== false) {
        lastMobileScrolledState = false;
        document.body.classList.remove("mobile-scrolled");
      }
      if (!skipFloatingScrollFx() && lastFloatingScrolledState !== scrolled) {
        lastFloatingScrolledState = scrolled;
        document.body.classList.toggle("floating-scrolled", scrolled);
      }
      syncTopbarAutoHide(y);
      return;
    }
    if (lastMobileScrolledState) {
      lastMobileScrolledState = false;
      document.body.classList.remove("mobile-scrolled");
    }
    if (!skipFloatingScrollFx() && lastFloatingScrolledState !== scrolled) {
      lastFloatingScrolledState = scrolled;
      document.body.classList.toggle("floating-scrolled", scrolled);
    }
    syncTopbarAutoHide(y);
  };
  const onScrollParallaxThrottled = () => {
    if (isDocumentHidden()) return;
    if (mobileScrollRaf) return;
    mobileScrollRaf = requestAnimationFrame(() => {
      mobileScrollRaf = 0;
      if (isDocumentHidden()) return;
      syncMobileScrollState();
    });
  };
  window.addEventListener("scroll", onScrollParallaxThrottled, { passive: true });
  syncMobileScrollState();

  window.addEventListener("resize", () => {
    if (isDocumentHidden()) return;
    if (resizeUiRaf) return;
    resizeUiRaf = requestAnimationFrame(() => {
      resizeUiRaf = 0;
      if (isDocumentHidden()) return;
      if (!isMobileViewport()) closeMobileNav();
      syncMobileHeaderActionUi();
      initPremiumTiltSystem();
      lastDepthParallaxRounded = -1;
      lastFloatingScrolledState = null;
      lastMobileScrolledState = null;
      lastTopbarScrollY = 0;
      topbarAutoHidden = false;
      document.body.classList.remove("topbar-auto-hidden");
      syncMobileScrollState();
    });
  });
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

  syncMobileHeaderActionUi();
  if (isAuthSessionReady()) ensureRealtimeSocket();
});

function ensureRealtimeSocket() {
  void ensureSocketClientScript()
    .then(() => {
      if (typeof window.__notesAiEnsureSocket === "function") {
        window.__notesAiEnsureSocket();
      }
      registerRealtimeNoteSyncHandlers();
      const token = getStoredAccessToken();
      if (token && typeof socket !== "undefined" && socket && typeof socket.emit === "function") {
        socket.emit("authenticate", token);
      }
    })
    .catch(() => {});
}

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

function registerRealtimeNoteSyncHandlers() {
  if (window.__notesAiSocketSyncRegistered) return;
  if (!socket || typeof socket.on !== "function" || socket.__notesAiNoop) return;
  window.__notesAiSocketSyncRegistered = true;
  socket.on("noteCreated", () => {
    scheduleSocketNotesResync();
  });

  socket.on("noteUpdated", () => {
    scheduleSocketNotesResync();
  });

  socket.on("noteDeleted", () => {
    scheduleSocketNotesResync();
  });
}

window.__notesAiOnSocketReady = function notesAiOnSocketReady() {
  registerRealtimeNoteSyncHandlers();
};
