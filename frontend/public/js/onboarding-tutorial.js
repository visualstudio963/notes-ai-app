/**
 * First-time onboarding: single overlay + tooltip controller (vanilla JS).
 * Depends on globals from app.js: currentUser, accessToken, apiFetch, t, goHome, openMyNotes, openReminderHistory, openCoinsRewards, persistCurrentUserToStorage
 */
(function () {
  "use strict";

  const STEP_DEFS = [
    {
      center: true,
      target: null,
      titleKey: "onboardingWelcomeTitle",
      bodyKey: "onboardingWelcomeBody",
      primaryKind: "start",
      navigate: async () => {
        if (typeof goHome === "function") goHome();
      }
    },
    {
      titleKey: "onboardingNotesTitle",
      bodyKey: "onboardingNotesBody",
      primaryKind: "next",
      navigate: async () => {
        if (typeof openMyNotes === "function") openMyNotes();
      },
      target: "#notes-all .page-header"
    },
    {
      titleKey: "onboardingRemindersTitle",
      bodyKey: "onboardingRemindersBody",
      primaryKind: "next",
      navigate: async () => {
        if (typeof openReminderHistory === "function") openReminderHistory();
      },
      target: "#menuHistory"
    },
    {
      titleKey: "onboardingRewardsTitle",
      bodyKey: "onboardingRewardsBody",
      primaryKind: "next",
      navigate: async () => {
        if (typeof openCoinsRewards === "function") await openCoinsRewards();
      },
      target: ".coins-hub-streak-card"
    },
    {
      titleKey: "onboardingInviteTitle",
      bodyKey: "onboardingInviteBody",
      primaryKind: "next",
      navigate: async () => {
        if (typeof openCoinsRewards === "function") await openCoinsRewards();
      },
      target: ".coins-invite-panel"
    },
    {
      titleKey: "onboardingDoneTitle",
      bodyKey: "onboardingDoneBody",
      primaryKind: "finish",
      navigate: async () => {
        if (typeof goHome === "function") goHome();
      },
      target: "#menuHome"
    }
  ];

  const ROOT_ID = "onboardingTutorialRoot";
  let rootEl = null;
  let blockEl = null;
  let spotlightEl = null;
  let pulseEl = null;
  let tipEl = null;
  let titleEl = null;
  let bodyEl = null;
  let stepCountEl = null;
  let nextBtn = null;
  let skipLabel = null;
  let skipBtn = null;
  let closeBtn = null;
  let arrowEl = null;

  let active = false;
  let stepIndex = 0;
  let forceRun = false;
  let ro = null;
  let repositionTimer = null;
  let domReady = false;
  let targetElPinned = null;
  let tourLock = false;
  let scheduleTimer = null;

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

  /** Show only when the server/client user flag is explicitly false — not undefined (stale cached user). */
  function shouldOfferFirstTimeTutorial() {
    if (typeof currentUser === "undefined" || !currentUser || !currentUser.id) return false;
    if (typeof accessToken === "undefined" || !accessToken) return false;
    if (currentUser.hasSeenTutorial !== false) return false;
    if (clientMarkedDoneLocally()) return false;
    return true;
  }

  function isBlockingOverlayOpen() {
    const trial = document.getElementById("trialGiftModal");
    if (trial && !trial.classList.contains("hidden")) return true;
    const choose = document.getElementById("chooseUsernameScreen");
    if (choose && !choose.classList.contains("hidden")) return true;
    const auth = document.getElementById("authLanding");
    if (auth && !auth.classList.contains("hidden")) return true;
    const setPwd = document.getElementById("setPasswordScreen");
    if (setPwd && !setPwd.classList.contains("hidden")) return true;
    return false;
  }

  function teardownTargetDecoration() {
    if (targetElPinned) {
      targetElPinned.classList.remove("onboarding-target-pulse");
      targetElPinned = null;
    }
    if (ro) {
      try {
        ro.disconnect();
      } catch {
        /* ignore */
      }
      ro = null;
    }
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
    root.innerHTML =
      `<div class="onboarding-tutorial__block" aria-hidden="true"></div>
      <div class="onboarding-tutorial__pulse" aria-hidden="true"></div>
      <div class="onboarding-tutorial__spotlight" aria-hidden="true"></div>
      <article class="onboarding-tutorial__tip" role="dialog" aria-modal="true" aria-labelledby="onboarding-tutorial-title">
        <button type="button" class="onboarding-tutorial__close" aria-label="Close">✕</button>
        <p class="onboarding-tutorial__steps" aria-live="polite"></p>
        <h4 id="onboarding-tutorial-title" class="onboarding-tutorial__title"></h4>
        <p class="onboarding-tutorial__body"></p>
        <div class="onboarding-tutorial__footer">
          <button type="button" class="onboarding-tutorial__ghost" data-role="skip"></button>
          <button type="button" class="onboarding-tutorial__next" data-role="primary"></button>
        </div>
        <span class="onboarding-tutorial__arrow" aria-hidden="true"></span>
      </article>`;

    rootEl = root;
    blockEl = root.querySelector(".onboarding-tutorial__block");
    pulseEl = root.querySelector(".onboarding-tutorial__pulse");
    spotlightEl = root.querySelector(".onboarding-tutorial__spotlight");
    tipEl = root.querySelector(".onboarding-tutorial__tip");
    titleEl = root.querySelector(".onboarding-tutorial__title");
    bodyEl = root.querySelector(".onboarding-tutorial__body");
    stepCountEl = root.querySelector(".onboarding-tutorial__steps");
    nextBtn = root.querySelector('[data-role="primary"]');
    skipBtn = root.querySelector('[data-role="skip"]');
    closeBtn = root.querySelector(".onboarding-tutorial__close");
    arrowEl = root.querySelector(".onboarding-tutorial__arrow");

    const onPrimary = () => void handlePrimary();
    const onSkipOrClose = () => void dismissAndPersist();

    closeBtn.addEventListener("click", onSkipOrClose);
    skipBtn.addEventListener("click", onSkipOrClose);
    nextBtn.addEventListener("click", onPrimary);

    window.addEventListener("resize", scheduleReposition);
    window.addEventListener("scroll", scheduleReposition, true);
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

  function scheduleReposition() {
    if (!active) return;
    clearTimeout(repositionTimer);
    repositionTimer = setTimeout(() => {
      repositionTimer = null;
      positionForCurrentStep(false);
    }, 16);
  }

  /** @returns {HTMLElement | null} */
  function queryTarget(sel, step) {
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  /** @returns {boolean} */
  function isMeasuredVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 && r.height < 6) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  }

  function attachObserverTo(el) {
    teardownTargetDecoration();
    targetElPinned = el;
    el.classList.add("onboarding-target-pulse");
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => scheduleReposition());
      ro.observe(el);
    }
  }

  function positionSpotlight(rect) {
    if (!spotlightEl || !pulseEl) return;
    const pad = 8;
    const r = rect;
    const top = Math.max(8, r.top - pad + window.scrollY);
    const left = Math.max(8, r.left - pad + window.scrollX);
    const w = r.width + pad * 2;
    const h = r.height + pad * 2;
    spotlightEl.style.top = `${r.top - pad}px`;
    spotlightEl.style.left = `${r.left - pad}px`;
    spotlightEl.style.width = `${Math.max(w, 32)}px`;
    spotlightEl.style.height = `${Math.max(h, 32)}px`;

    pulseEl.style.top = `${r.top - pad}px`;
    pulseEl.style.left = `${r.left - pad}px`;
    pulseEl.style.width = spotlightEl.style.width;
    pulseEl.style.height = spotlightEl.style.height;
  }

  function positionTooltipNearRect(rect, placeBelow) {
    if (!tipEl || !arrowEl) return;
    const margin = 16;
    const tipRectGuess = tipEl.getBoundingClientRect();
    let top = placeBelow ? rect.bottom + margin : rect.top - tipRectGuess.height - margin;

    /** After first paint, clamp to viewport */
    tipEl.style.top = `${Math.max(18, Math.min(top, window.innerHeight - (tipRectGuess.height || 120) - 14))}px`;
    tipEl.style.left = "50%";
    tipEl.style.transform = "translateX(-50%) scale(1)";

    /** Second pass once layout updated */
    requestAnimationFrame(() => {
      const tR = tipEl.getBoundingClientRect();
      top = placeBelow ? rect.bottom + margin : rect.top - tR.height - margin;
      if (top + tR.height > window.innerHeight - 12 && !placeBelow) {
        tipEl.style.top = `${Math.max(18, rect.top - tR.height - margin)}px`;
      } else if (top < 12 && placeBelow) {
        tipEl.style.top = `${Math.min(window.innerHeight - tR.height - 12, rect.top - margin - tR.height)}px`;
      } else {
        tipEl.style.top = `${Math.max(18, Math.min(top, window.innerHeight - tR.height - 12))}px`;
      }

      /** Arrow indicator toward target horizontal center */
      const cxTarget = rect.left + rect.width / 2;
      const cxTip = tR.left + tR.width / 2;
      const dx = cxTarget - cxTip;
      const arrowClamp = Math.max(-Math.min(80, (tR.width || 260) / 2 - 20), Math.min(80, dx * 0.25));
      arrowEl.style.marginLeft = `${arrowClamp}px`;
      arrowEl.style.transform = placeBelow ? "rotate(180deg)" : "rotate(0deg)";
    });
  }

  function positionWelcomeCenter() {
    if (!spotlightEl || !pulseEl || !tipEl || !arrowEl) return;
    spotlightEl.style.width = "0";
    spotlightEl.style.height = "0";
    spotlightEl.style.opacity = "0";
    spotlightEl.style.top = `${window.innerHeight / 2}px`;
    spotlightEl.style.left = `${window.innerWidth / 2}px`;

    pulseEl.style.opacity = "0";

    arrowEl.style.display = "none";
    tipEl.style.top = "50%";
    tipEl.style.left = "50%";
    tipEl.style.transform = "translate(-50%, -50%) scale(1)";
  }

  function positionForCurrentStep(firstPaint) {
    if (!active) return;
    const step = STEP_DEFS[stepIndex];
    if (!step || !spotlightEl || !tipEl) return;

    arrowEl.style.display = "";

    if (step.center || !step.target) {
      positionWelcomeCenter();
      rootEl.style.opacity = String(firstPaint ? "0" : "1");
      requestAnimationFrame(() => {
        rootEl.style.opacity = "1";
        tipEl.animate([{ opacity: 0.55, transform: "translate(-50%, -46%) scale(0.96)" }, { opacity: 1, transform: "translate(-50%, -50%) scale(1)" }], {
          duration: 260,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        }).catch(() => {});
      });
      teardownTargetDecoration();
      return;
    }

    spotlightEl.style.opacity = "";

    /** @type {HTMLElement | null} */
    let el = queryTarget(step.target, step);
    if (!isMeasuredVisible(el)) {
      if (typeof step.target === "string" && step.target.includes("menuHistory")) {
        el = queryTarget("#menuHistory", step);
      }
    }

    if (el instanceof HTMLElement && isMeasuredVisible(el)) {
      try {
        el.scrollIntoView({ block: "center", behavior: "auto" });
      } catch {
        /* ignore scroll errors */
      }
      const r = el.getBoundingClientRect();
      spotlightEl.style.opacity = "1";

      attachObserverTo(el);
      positionSpotlight(r);

      const placeBelow = r.bottom + 220 < window.innerHeight ? true : r.top < window.innerHeight * 0.45;
      positionTooltipNearRect(r, placeBelow);
    } else {
      /** Fallback: center tooltip without spotlight */
      positionWelcomeCenter();
      teardownTargetDecoration();
    }

    rootEl.style.opacity = "1";
    tipEl.animate([{ opacity: 0.75, transform: "scale(0.98)" }, { opacity: 1, transform: "scale(1)" }], {
      duration: 200,
      easing: "cubic-bezier(0.33, 1, 0.68, 1)"
    }).catch(() => {});
  }

  async function persistTutorialSeen() {
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
    if (!rootEl || !tipEl || !spotlightEl) {
      tourLock = false;
      return;
    }
    active = false;
    rootEl.classList.add("hidden");
    tipEl.animate([{ opacity: 1, transform: tipEl.style.transform }, { opacity: 0 }], { duration: 140 }).catch(() => {});
    document.documentElement.classList.remove("onboarding-tutorial-open");

    teardownTargetDecoration();
    await persistTutorialSeen();
    forceRun = false;
    tourLock = false;
  }

  function applyStepLabels(step) {
    if (!step || !titleEl || !bodyEl || !nextBtn || !skipBtn || !stepCountEl) return;

    stepCountEl.textContent = Tf("onboardingStepCount", "{cur} / {total}")
      .replace("{cur}", String(stepIndex + 1))
      .replace("{total}", String(STEP_DEFS.length));

    titleEl.textContent = Tf(step.titleKey, "");
    bodyEl.textContent = Tf(step.bodyKey, "");

    if (step.primaryKind === "start") {
      nextBtn.textContent = Tf("onboardingStart", "Start");
    } else if (step.primaryKind === "finish") {
      nextBtn.textContent = Tf("onboardingFinish", "Start using app");
    } else {
      nextBtn.textContent = Tf("onboardingNext", "Next");
    }

    skipBtn.textContent = Tf("onboardingSkip", "Skip");
    closeBtn.setAttribute("aria-label", Tf("onboardingCloseAria", "Skip tutorial"));
  }

  /** Run navigation for arriving at `index` step (before positioning). */
  async function navigateToStepIndex(index) {
    const step = STEP_DEFS[index];
    if (step && typeof step.navigate === "function") {
      await step.navigate();
      await new Promise((r) => setTimeout(r, 80));
      return;
    }
    await Promise.resolve();
  }

  /** Show step `index`: assume DOM may need async paint */
  async function showStep(index) {
    ensureDom();
    if (!rootEl) return;
    stepIndex = Math.max(0, Math.min(index, STEP_DEFS.length - 1));
    const step = STEP_DEFS[stepIndex];

    await navigateToStepIndex(stepIndex);
    /** Wait for selectors (coins hub SSR paint) */

    applyStepLabels(step);
    active = true;
    rootEl.classList.remove("hidden");
    rootEl.style.opacity = "0";
    document.documentElement.classList.add("onboarding-tutorial-open");

    requestAnimationFrame(() => {
      positionForCurrentStep(true);
    });

    /** Retry positioning when slow DOM (e.g. coins hub refresh) */

    let tries = 0;
    const bump = () => {
      tries += 1;
      positionForCurrentStep(false);
      if (tries < 16 && STEP_DEFS[stepIndex]?.target && !queryTarget(String(STEP_DEFS[stepIndex].target))) {
        window.setTimeout(bump, 120);
      } else if (tries < 12 && STEP_DEFS[stepIndex]?.target && !isMeasuredVisible(queryTarget(String(STEP_DEFS[stepIndex].target)))) {
        window.setTimeout(bump, 120);
      }
    };

    window.setTimeout(bump, 180);
    window.setTimeout(bump, 450);
    window.setTimeout(bump, 900);
  }

  async function handlePrimary() {
    if (!active) return;
    const last = stepIndex >= STEP_DEFS.length - 1;
    if (last) {
      await dismissAndPersist();
      goHomeMaybe();
      return;
    }


    await showStep(stepIndex + 1);
  }

  function goHomeMaybe() {
    try {
      if (typeof goHome === "function") goHome();
    } catch {
      /* ignore */
    }
  }

  async function internalStart(opts) {
    if (tourLock) return;
    opts = opts || {};
    forceRun = Boolean(opts.force);
    if (!forceRun && !shouldOfferFirstTimeTutorial()) return;
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

      stepIndex = 0;
      await showStep(0);
    } catch (e) {
      console.warn("[onboarding]", e);
      active = false;
      if (rootEl) rootEl.classList.add("hidden");
      document.documentElement.classList.remove("onboarding-tutorial-open");
      teardownTargetDecoration();
      tourLock = false;
    }
  }

  /** Called from app after login / session restore */

  function scheduleOnboardingTutorialAfterAuth() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      if (tourLock || active) return;
      if (!shouldOfferFirstTimeTutorial()) return;
      void internalStart({ force: false });
    }, 700);
  }

  window.scheduleOnboardingTutorialAfterAuth = scheduleOnboardingTutorialAfterAuth;

  window.replayOnboardingTutorial = function replayOnboardingTutorial() {
    if (typeof requireAuth === "function" && !requireAuth("replay the tour")) return;
    void internalStart({ force: true });
  };

  window.OnboardingTutorial = {
    start: internalStart,
    replay: window.replayOnboardingTutorial,
    scheduleAfterAuth: scheduleOnboardingTutorialAfterAuth
  };
})();
