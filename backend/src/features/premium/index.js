const subscriptionService = require("./subscriptionService");
const { createPremiumRouter } = require("./premium.routes");

module.exports = {
  ...subscriptionService,
  createPremiumRouter
};
