const express = require("express");
const { createAuthRouter } = require("./auth.routes");
const { createNotesRouter } = require("./notes.routes");
const { createRemindersRouter } = require("./reminders.routes");
const { createUserRouter } = require("./user.routes");
const { createPremiumRouter } = require("../features/premium/premium.routes");
const { createContactRouter } = require("./contact.routes");
const { createAdminRouter } = require("./admin.routes");
const { createWebChatRouter } = require("./webchat.routes");
const { createCoinsRouter } = require("./coins.routes");
const { createAppConfigRouter } = require("./app-config.routes");

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
    AppConfig,
    jwtSecret,
    jwtRefreshSecret,
    authMiddleware,
    adminMiddleware,
    authLimiter,
    signupLimiter,
    contactLimiter,
    sendWhatsAppMessage,
    aiMemoryService,
    premiumDevSecret,
    stripeSecretKey,
    stripeStandardMonthlyLookupKey,
    stripeStandardYearlyLookupKey,
    stripePremiumMonthlyLookupKey,
    stripePremiumYearlyLookupKey,
    stripePublishableKey,
    openAiApiKey,
    publicAppUrl,
    emailVerificationBypassUsernames,
    googleClientId
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
      stripePublishableKey: stripePublishableKey || "",
      googleClientId: googleClientId || ""
    })
  );

  api.use(
    "/admin",
    createAdminRouter({
      User,
      Note,
      Reminder,
      ContactMessage,
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
      sendWhatsAppMessage,
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
      premiumDevSecret: premiumDevSecret || null,
      stripeSecretKey: stripeSecretKey || null,
      stripeStandardMonthlyLookupKey: stripeStandardMonthlyLookupKey || null,
      stripeStandardYearlyLookupKey: stripeStandardYearlyLookupKey || null,
      stripePremiumMonthlyLookupKey: stripePremiumMonthlyLookupKey || null,
      stripePremiumYearlyLookupKey: stripePremiumYearlyLookupKey || null,
      publicAppUrl: publicAppUrl || null
    })
  );

  api.use(
    createRemindersRouter({
      User,
      Reminder,
      authMiddleware,
      aiMemoryService
    })
  );

  api.use(
    createUserRouter({
      User,
      authMiddleware
    })
  );

  api.use(
    createWebChatRouter({
      User,
      authMiddleware,
      openAiApiKey: openAiApiKey || null
    })
  );

  return api;
}

module.exports = { createApiRouter };
