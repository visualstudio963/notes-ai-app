/**
 * Client-side plan helpers: Free vs Standard vs Premium (WhatsApp / SMS).
 * Server is authoritative; these mirror `/api/premium/status` capabilities.
 */

function userHasPremiumCapabilities(user) {
  if (!user) return false;
  if (user.capabilities && typeof user.capabilities.whatsAppSmsReminders === "boolean") {
    return user.capabilities.whatsAppSmsReminders;
  }
  return Boolean(user.isPremium);
}

/**
 * Standard or active Premium — Web Chat, Scan Cam, PDF export, chat web reminders.
 * @param {Record<string, unknown> | null | undefined} user
 */
function userHasStandardTierFeatures(user) {
  if (!user) return false;
  const cap = user.capabilities;
  if (cap && typeof cap.webChat === "boolean") return cap.webChat;
  if (cap && typeof cap.scanCam === "boolean") return cap.scanCam;
  const role = user.membershipRole || "";
  const tier = user.tier || "";
  const plan = user.plan || user.subscriptionPlan || "";
  return role === "standard" || role === "premium" || tier === "standard" || tier === "premium" || plan === "standard" || plan === "premium";
}

function userHasScanCamAccess(user) {
  return userHasStandardTierFeatures(user);
}

function userHasWebChatAccess(user) {
  return userHasStandardTierFeatures(user);
}

/** Premium only — OpenAI replies in Web Chat (monthly cap on server). */
function userHasWebChatOpenAiAccess(user) {
  if (!user || !user.capabilities) return false;
  return Boolean(user.capabilities.webChatOpenAI);
}

/** Note export: TXT for any signed-in user; PDF from Standard; JPG from Premium. */
function userCanExportNoteTxt(user) {
  return Boolean(user);
}

function userCanExportNotePdf(user) {
  return userHasStandardTierFeatures(user);
}

function userCanExportNoteJpg(user) {
  return userHasStandardTierFeatures(user);
}
