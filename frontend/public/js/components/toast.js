function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.innerText = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

/** In-app line when a reminder fires while the tab is visible (system notification may be subdued). */
function showReminderForegroundToast(message) {
  const el = document.getElementById("reminderForegroundToast");
  if (!el) return;
  const line =
    typeof t === "function"
      ? t("reminderForegroundLine").replace("{title}", String(message || "").trim() || t("reminderDefaultBody"))
      : `Reminder: ${String(message || "").trim()}`;
  el.textContent = line;
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  window.clearTimeout(showReminderForegroundToast._hide);
  showReminderForegroundToast._hide = window.setTimeout(() => {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
  }, 4000);
}
