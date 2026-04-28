const subscriptionService = require("./subscriptionService");
const createRequirePremiumModule = require("./createRequirePremium");
const { createPremiumRouter } = require("./premium.routes");

module.exports = {
  ...subscriptionService,
  ...createRequirePremiumModule,
  createPremiumRouter
};
