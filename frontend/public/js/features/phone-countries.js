/**
 * Dial codes for phone verification (E.164). Independent of UI language.
 * Sorted alphabetically by name for the dropdown; use longest-dial match for parsing.
 */
window.PHONE_COUNTRIES = [
  { dial: "355", code: "AL", name: "Albania", flag: "🇦🇱" },
  { dial: "49", code: "DE", name: "Germany", flag: "🇩🇪" },
  { dial: "39", code: "IT", name: "Italy", flag: "🇮🇹" },
  { dial: "33", code: "FR", name: "France", flag: "🇫🇷" },
  { dial: "34", code: "ES", name: "Spain", flag: "🇪🇸" },
  { dial: "351", code: "PT", name: "Portugal", flag: "🇵🇹" },
  { dial: "31", code: "NL", name: "Netherlands", flag: "🇳🇱" },
  { dial: "32", code: "BE", name: "Belgium", flag: "🇧🇪" },
  { dial: "41", code: "CH", name: "Switzerland", flag: "🇨🇭" },
  { dial: "43", code: "AT", name: "Austria", flag: "🇦🇹" },
  { dial: "45", code: "DK", name: "Denmark", flag: "🇩🇰" },
  { dial: "46", code: "SE", name: "Sweden", flag: "🇸🇪" },
  { dial: "47", code: "NO", name: "Norway", flag: "🇳🇴" },
  { dial: "358", code: "FI", name: "Finland", flag: "🇫🇮" },
  { dial: "48", code: "PL", name: "Poland", flag: "🇵🇱" },
  { dial: "420", code: "CZ", name: "Czech Republic", flag: "🇨🇿" },
  { dial: "36", code: "HU", name: "Hungary", flag: "🇭🇺" },
  { dial: "40", code: "RO", name: "Romania", flag: "🇷🇴" },
  { dial: "30", code: "GR", name: "Greece", flag: "🇬🇷" },
  { dial: "385", code: "HR", name: "Croatia", flag: "🇭🇷" },
  { dial: "386", code: "SI", name: "Slovenia", flag: "🇸🇮" },
  { dial: "387", code: "BA", name: "Bosnia and Herzegovina", flag: "🇧🇦" },
  { dial: "389", code: "MK", name: "North Macedonia", flag: "🇲🇰" },
  { dial: "383", code: "XK", name: "Kosovo", flag: "🇽🇰" },
  { dial: "381", code: "RS", name: "Serbia", flag: "🇷🇸" },
  { dial: "382", code: "ME", name: "Montenegro", flag: "🇲🇪" },
  { dial: "44", code: "GB", name: "United Kingdom", flag: "🇬🇧" },
  { dial: "353", code: "IE", name: "Ireland", flag: "🇮🇪" },
  { dial: "1", code: "US", name: "United States / Canada (+1)", flag: "🇺🇸" },
  { dial: "90", code: "TR", name: "Türkiye", flag: "🇹🇷" },
  { dial: "972", code: "IL", name: "Israel", flag: "🇮🇱" },
  { dial: "971", code: "AE", name: "United Arab Emirates", flag: "🇦🇪" },
  { dial: "61", code: "AU", name: "Australia", flag: "🇦🇺" }
];

window.PHONE_COUNTRY_STORAGE_KEY = "phoneVerificationDial";

window.getPhoneCountriesSortedByName = function getPhoneCountriesSortedByName() {
  return [...window.PHONE_COUNTRIES].sort((a, b) => a.name.localeCompare(b.name));
};

window.findPhoneCountryByE164 = function findPhoneCountryByE164(e164) {
  const normalized = String(e164 || "").replace(/\s+/g, "");
  if (!normalized.startsWith("+")) return null;
  const sorted = [...window.PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of sorted) {
    if (normalized.startsWith("+" + c.dial)) return c;
  }
  return null;
};

window.populatePhoneCountrySelect = function populatePhoneCountrySelect(selectEl) {
  if (!selectEl || selectEl.dataset.populated === "1") return;
  const list = window.getPhoneCountriesSortedByName();
  for (const c of list) {
    const opt = document.createElement("option");
    opt.value = "+" + c.dial;
    opt.textContent = `${c.flag} ${c.name} (+${c.dial})`;
    selectEl.appendChild(opt);
  }
  selectEl.dataset.populated = "1";
};
