/** @type {Record<string, string>} */
var categories = {
  shtepia: "Shtepia",
  puna: "Puna",
  shkolla: "Shkolla",
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
