/**
 * First-time welcome: single centered sheet (no spotlight / reposition — avoids jitter).
 * Depends on globals from app.js: currentUser, accessToken, apiFetch, t, persistCurrentUserToStorage
 */
(function () {
  "use strict";

  const ROOT_ID = "onboardingTutorialRoot";

  /** Feature bullets shown to every new user (emoji prefixes in translations). */
  const BULLET_KEYS = ["welcomeBullet1", "welcomeBullet2", "welcomeBullet3", "welcomeBullet4", "welcomeBullet5", "welcomeBullet6"];

  let domReady = false;
  let rootEl = null;
  let backdropEl = null;
  let sheetEl = null;
  let titleEl = null;
  let subtitleEl = null;
  let listEl = null;
  let trialSectionEl = null;
  let trialTitleEl = null;
  let trialLeadEl = null;
  let trialNoteEl = null;
  let ctaBtn = null;
  let closeBtn = null;

  let active = false;
  let forceRun = false;
  let scheduleTimer = null;
  let tourLock = false;
  let dismissing = false;

  function Tf(key, fallback) {
    if (typeof t === "function") {
      const s = t(key);
      return s === key ? fallback || key : s;
    }
    return fallback || key;
  }

  function tutorialLocalDoneKey(uid) {
    const id = uid != null ? String(uid) : "";
    return id ? `aiNotesTutorialDone_${id}` : "aiNotesTutorialDone_guest";
  }

  async function hydrateTutorialFlagFromServer() {
    if (typeof apiFetch !== "function" || typeof accessToken === "undefined" || !accessToken) return;
    if (typeof currentUser === "undefined" || !currentUser || currentUser.id == null) return;
    try {
      const data = await apiFetch("/api/user/settings");
      if (data.settings && typeof data.settings.hasSeenTutorial === "boolean") {
        currentUser.hasSeenTutorial = data.settings.hasSeenTutorial;
        if (typeof persistCurrentUserToStorage === "function") persistCurrentUserToStorage();
      }
    } catch {
      /* offline */
    }
  }

  function clientMarkedDoneLocally() {
    try {
      if (typeof currentUser !== "undefined" && currentUser && currentUser.id != null) {
        if (localStorage.getItem(tutorialLocalDoneKey(currentUser.id)) === "1") return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function shouldOfferFirstTimeTutorial() {
    if (typeof currentUser === "undefined" || !currentUser || !currentUser.id) return false;
    if (typeof accessToken === "undefined" || !accessToken) return false;
    if (clientMarkedDoneLocally()) return false;
    if (currentUser.hasSeenTutorial !== false) return false;
    return true;
  }

  function isBlockingOverlayOpen() {
    const trial = document.getElementById("trialGiftModal");
    if (trial && !trial.classList.contains("hidden")) return true;
    const choose = document.getElementById("chooseUsernameScreen");
    if (choose && !choose.classList.contains("hidden")) return true;
    const auth = document.getElementById("authLanding");
    if (auth && !auth.classList.contains("hidden")) return true;
    return false;
  }

  function ensureDom() {
    if (domReady && rootEl) return;
    domReady = true;
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
    root.className = "welcome-root hidden";
    root.innerHTML =
      `<div class="welcome-sheet__backdrop" aria-hidden="true"></div>
      <div class="welcome-sheet" role="dialog" aria-modal="true" aria-labelledby="welcome-sheet-title" tabindex="-1">
        <button type="button" class="welcome-sheet__close" aria-label="Close">✕</button>
        <h2 id="welcome-sheet-title" class="welcome-sheet__title"></h2>
        <p class="welcome-sheet__subtitle"></p>
        <ul class="welcome-sheet__bullets"></ul>
        <div class="welcome-sheet__trial welcome-sheet__trial--hidden">
          <p class="welcome-sheet__trial-heading"></p>
          <p class="welcome-sheet__trial-lead"></p>
          <ul class="welcome-sheet__trial-bullets">
            <li class="welcome-sheet__trial-li" data-copy="trialGiftItem1"></li>
            <li class="welcome-sheet__trial-li" data-copy="trialGiftItem2"></li>
            <li class="welcome-sheet__trial-li" data-copy="trialGiftItem3"></li>
            <li class="welcome-sheet__trial-li" data-copy="trialGiftItem4"></li>
            <li class="welcome-sheet__trial-li" data-copy="trialGiftItem5"></li>
          </ul>
          <p class="welcome-sheet__trial-note"></p>
        </div>
        <button type="button" class="welcome-sheet__cta save-button"></button>
      </div>`;

    rootEl = root;
    backdropEl = root.querySelector(".welcome-sheet__backdrop");
    sheetEl = root.querySelector(".welcome-sheet");
    titleEl = root.querySelector(".welcome-sheet__title");
    subtitleEl = root.querySelector(".welcome-sheet__subtitle");
    listEl = root.querySelector(".welcome-sheet__bullets");
    trialSectionEl = root.querySelector(".welcome-sheet__trial");
    trialTitleEl = trialSectionEl.querySelector(".welcome-sheet__trial-heading");
    trialLeadEl = trialSectionEl.querySelector(".welcome-sheet__trial-lead");
    trialNoteEl = trialSectionEl.querySelector(".welcome-sheet__trial-note");
    ctaBtn = root.querySelector(".welcome-sheet__cta");
    closeBtn = root.querySelector(".welcome-sheet__close");

    const dismiss = () => void dismissAndPersist();
    closeBtn.addEventListener("click", dismiss);
    ctaBtn.addEventListener("click", dismiss);

    document.addEventListener("keydown", onDocumentKeydown, true);
  }

  function onDocumentKeydown(ev) {
    if (!active || !rootEl || rootEl.classList.contains("hidden")) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      void dismissAndPersist();
    }
  }

  function populateWelcomeContent() {
    if (!titleEl || !subtitleEl || !listEl || !ctaBtn || !closeBtn || !trialSectionEl) return;

    titleEl.textContent = Tf("welcomeScreenTitle", "");
    subtitleEl.textContent = Tf("welcomeScreenSubtitle", "");
    listEl.innerHTML = "";
    BULLET_KEYS.forEach((key) => {
      const li = document.createElement("li");
      li.className = "welcome-sheet__bullet";
      li.textContent = Tf(key, "");
      listEl.appendChild(li);
    });

    const onTrial =
      typeof currentUser !== "undefined" &&
      currentUser &&
      (currentUser.lifecycle === "trial" || Boolean(currentUser.trialEndsAt));

    trialSectionEl.classList.toggle("welcome-sheet__trial--hidden", !onTrial);

    trialTitleEl.textContent = onTrial ? Tf("welcomeTrialSectionTitle", "") : "";
    trialLeadEl.textContent = onTrial ? Tf("welcomeTrialLead", "") : "";
    trialNoteEl.textContent = onTrial ? Tf("welcomeTrialAfter", "") : "";
    trialSectionEl.querySelectorAll(".welcome-sheet__trial-li[data-copy]").forEach((li) => {
      const key = li.getAttribute("data-copy");
      li.textContent = key && onTrial ? Tf(key, "") : "";
    });

    ctaBtn.textContent = Tf("onboardingGotIt", "Got it, close");
    closeBtn.setAttribute("aria-label", Tf("onboardingCloseAriaWelcome", "Close welcome"));
  }

  function markTutorialSeenLocally() {
    try {
      if (typeof currentUser !== "undefined" && currentUser && currentUser.id != null) {
        localStorage.setItem(tutorialLocalDoneKey(currentUser.id), "1");
      }
    } catch {
      /* ignore */
    }
    if (typeof currentUser !== "undefined" && currentUser) {
      currentUser.hasSeenTutorial = true;
      if (typeof persistCurrentUserToStorage === "function") persistCurrentUserToStorage();
    }
  }

  async function persistTutorialSeen() {
    markTutorialSeenLocally();
    try {
      if (typeof apiFetch === "function" && typeof accessToken !== "undefined" && accessToken) {
        await apiFetch("/api/user/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hasSeenTutorial: true })
        });
      }
    } catch {
      /* non-fatal */
    }
  }

  async function dismissAndPersist() {
    if (dismissing) return;
    dismissing = true;
    try {
      active = false;
      if (rootEl) rootEl.classList.add("hidden");
      document.documentElement.classList.remove("onboarding-tutorial-open");
      document.body.classList.remove("welcome-screen-open");

      try {
        if (typeof markTrialGiftAnnounceIfNeeded === "function") markTrialGiftAnnounceIfNeeded();
      } catch {
        /* ignore */
      }

      await persistTutorialSeen();
    } finally {
      forceRun = false;
      tourLock = false;
      dismissing = false;
    }
  }

  async function internalStart(opts) {
    if (tourLock) return;
    opts = opts || {};
    forceRun = Boolean(opts.force);
    if (!forceRun) {
      await hydrateTutorialFlagFromServer();
      if (!shouldOfferFirstTimeTutorial()) return;
    }
    if (typeof currentUser === "undefined" || !currentUser || !currentUser.id) return;

    tourLock = true;
    try {
      ensureDom();

      if (isBlockingOverlayOpen()) {
        let retries = 0;
        await new Promise((resolve) => {
          const iv = window.setInterval(() => {
            retries += 1;
            if (!isBlockingOverlayOpen() || retries > 120) {
              window.clearInterval(iv);
              resolve(null);
            }
          }, 250);
        });
      }

      if (!forceRun && !shouldOfferFirstTimeTutorial()) {
        tourLock = false;
        return;
      }

      populateWelcomeContent();
      active = true;
      rootEl.classList.remove("hidden");
      document.documentElement.classList.add("onboarding-tutorial-open");
      document.body.classList.add("welcome-screen-open");

      requestAnimationFrame(() => {
        try {
          sheetEl.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      });
    } catch (e) {
      console.warn("[welcome]", e);
      active = false;
      if (rootEl) rootEl.classList.add("hidden");
      document.documentElement.classList.remove("onboarding-tutorial-open");
      document.body.classList.remove("welcome-screen-open");
      tourLock = false;
    }
  }

  function scheduleOnboardingTutorialAfterAuth() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      if (tourLock || active) return;
      void internalStart({ force: false });
    }, 700);
  }

  window.scheduleOnboardingTutorialAfterAuth = scheduleOnboardingTutorialAfterAuth;

  window.replayOnboardingTutorial = function replayOnboardingTutorial() {
    if (typeof requireAuth === "function" && !requireAuth("replay welcome")) return;
    void internalStart({ force: true });
  };

  /** Finishing replay should not revert hasSeenTutorial; dismiss still PUTs true (idempotent). */
  window.OnboardingTutorial = {
    start: internalStart,
    replay: window.replayOnboardingTutorial,
    scheduleAfterAuth: scheduleOnboardingTutorialAfterAuth
  };
})();
