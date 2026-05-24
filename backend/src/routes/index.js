const express = require("express");
const { createAuthRouter } = require("./auth.routes");
const { createNotesRouter } = require("./notes.routes");
const { createRemindersRouter } = require("./reminders.routes");
const { createUserRouter } = require("./user.routes");
const { createPremiumRouter } = require("../features/premium/premium.routes");
const { createContactRouter } = require("./contact.routes");
const { createAdminRouter } = require("./admin.routes");
const { createCoinsRouter } = require("./coins.routes");
const { createAppConfigRouter } = require("./app-config.routes");
const { createPushRouter } = require("./push.routes");

/**
 * @param {import('express').Express} app
 * @param {object} deps
 */
function createApiRouter(app, deps) {
  const {
    User,
    Note,
    Reminder,
    ContactMessage,
    CoinGiftLog,
    AppConfig,
    jwtSecret,
    jwtRefreshSecret,
    authMiddleware,
    adminMiddleware,
    authLimiter,
    signupLimiter,
    contactLimiter,
    premiumDevSecret,
    publicAppUrl,
    emailVerificationBypassUsernames,
    googleClientId,
    vapidPublicKey
  } = deps;

  const getIo = () => app.get("io");

  const api = express.Router();

  api.use(
    createAuthRouter({
      User,
      jwtSecret,
      jwtRefreshSecret,
      authLimiter,
      signupLimiter,
      publicAppUrl,
      emailVerificationBypassUsernames
    })
  );

  api.use(
    createContactRouter({
      ContactMessage,
      contactLimiter
    })
  );

  api.use(
    createAppConfigRouter({
      AppConfig,
      googleClientId: googleClientId || ""
    })
  );

  api.use(
    createPushRouter({
      User,
      authMiddleware,
      vapidPublicKey: vapidPublicKey || null
    })
  );

  api.use(
    "/admin",
    createAdminRouter({
      User,
      Note,
      Reminder,
      ContactMessage,
      CoinGiftLog,
      AppConfig,
      authMiddleware,
      adminMiddleware
    })
  );

  api.use(
    createNotesRouter({
      User,
      Note,
      authMiddleware,
      getIo
    })
  );

  api.use(
    createCoinsRouter({
      User,
      authMiddleware
    })
  );

  api.use(
    createPremiumRouter({
      User,
      authMiddleware,
      premiumDevSecret: premiumDevSecret || null
    })
  );

  api.use(
    createRemindersRouter({
      User,
      Reminder,
      authMiddleware
    })
  );

  api.use(
    createUserRouter({
      User,
      authMiddleware
    })
  );

  return api;
}

module.exports = { createApiRouter };
