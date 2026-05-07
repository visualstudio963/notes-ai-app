/** @type {Record<string, string>} */
/** English fallback when `t()` is unavailable (keys match i18n in translations.js). */
var categories = {
  shtepia: "Home",
  puna: "Work",
  shkolla: "School",
  scan_cam: "Scan Cam"
};

/** Visual theme per category — matches home hex cards (warm / cool / fresh / lux). */
/** @type {Record<string, "warm" | "cool" | "fresh" | "lux">} */
var NOTE_CATEGORY_THEME = {
  shtepia: "warm",
  puna: "cool",
  shkolla: "fresh",
  scan_cam: "lux"
};
