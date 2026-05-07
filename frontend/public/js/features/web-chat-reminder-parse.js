/**
 * Centralized time / helper parsing for Web Chat local reminder flow.
 * Loaded after web-chat-intents.js; used from app.js via window.webChatReminderParse.
 */
(function () {
  "use strict";

  /**
   * @param {string} combined
   * @returns {{ h: number; mi: number; match: string } | null}
   */
  function extractTimeSpec(combined) {
    const c = String(combined || "");

    const withMeridiem = c.match(
      /\b(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.|p|a)\b/i
    );
    if (withMeridiem) {
      let h = Number(withMeridiem[1]);
      const mi = Number(withMeridiem[2]);
      const apRaw = String(withMeridiem[3] || "")
        .replace(/\./g, "")
        .toLowerCase();
      const ap = apRaw[0] === "a" ? "am" : "pm";
      if (
        !Number.isNaN(h) &&
        !Number.isNaN(mi) &&
        h >= 1 &&
        h <= 12 &&
        mi >= 0 &&
        mi <= 59
      ) {
        if (ap === "am") {
          if (h === 12) h = 0;
        } else {
          if (h !== 12) h += 12;
        }
        if (h >= 0 && h <= 23) return { h, mi, match: withMeridiem[0] };
      }
    }

    const bareMeridiem = c.match(/\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (bareMeridiem) {
      let h = Number(bareMeridiem[1]);
      const apRaw = String(bareMeridiem[2] || "")
        .replace(/\./g, "")
        .toLowerCase();
      const ap = apRaw[0] === "a" ? "am" : "pm";
      if (!Number.isNaN(h) && h >= 1 && h <= 12) {
        if (ap === "am") {
          if (h === 12) h = 0;
        } else {
          if (h !== 12) h += 12;
        }
        return { h, mi: 0, match: bareMeridiem[0] };
      }
    }

    const hm = c.match(/\b(\d{1,2})[:.](\d{2})\b/);
    if (hm) {
      const h = Number(hm[1]);
      const mi = Number(hm[2]);
      if (!Number.isNaN(h) && !Number.isNaN(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
        return { h, mi, match: hm[0] };
      }
    }

    const dayParts = [
      [/\b(mëngjes|mengjes|morning|tomorrow\s+morning|neser\s+mengjes|nesër\s+mëngjes)\b/i, 9, 0],
      [/\b(mesdit[eë]|noon)\b/i, 12, 0],
      [/\b(paradite)\b/i, 12, 0],
      [/\b(pasdite|afternoon)\b/i, 15, 0],
      [/\b(mbr[eë]mje|dark[eë]|evening|today\s+evening|sot\s+mbr[eë]mje)\b/i, 19, 0],
      [/\b(tonight|natën|naten)\b/i, 21, 0],
      [/\b(midnight|mesnat[eë])\b/i, 0, 0]
    ];
    for (let i = 0; i < dayParts.length; i += 1) {
      const [re, h, mi] = dayParts[i];
      const mm = c.match(re);
      if (mm) return { h, mi, match: mm[0] };
    }

    const oraPhrases = c.match(
      /\b(?:në|ne)\s+or[eë]n\s+(\d{1,2})(?:[:.](\d{2}))?\b/i
    );
    if (oraPhrases) {
      let h = Number(oraPhrases[1]);
      const mi = oraPhrases[2] != null ? Number(oraPhrases[2]) : 0;
      if (!Number.isNaN(h) && !Number.isNaN(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
        return { h, mi, match: oraPhrases[0] };
      }
    }

    const neat = c.match(/\b(?:në|ne|at)\s+(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*[ap]m\b)/i);
    if (neat) {
      const h = Number(neat[1]);
      const mi = neat[2] != null ? Number(neat[2]) : 0;
      if (!Number.isNaN(h) && !Number.isNaN(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
        return { h, mi, match: neat[0] };
      }
    }

    if (
      /\b(nesër|neser|tomorrow|sot|today|pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i.test(
        c
      )
    ) {
      const rel = c.match(
        /\b(nesër|neser|tomorrow|sot|today|pasnesër|pasneser|pas\s+nesër|pas\s+neser|day\s+after\s+tomorrow)\b/i
      );
      if (rel) {
        const tailStart = (rel.index || 0) + rel[0].length;
        const tail = c.slice(tailStart);
        const mPref = tail.match(/^\s*(?:në|ne|at)\s+(\d{1,2})\b(?!\s*[:.]\d{2})/i);
        if (mPref) {
          const h = Number(mPref[1]);
          if (!Number.isNaN(h) && h >= 0 && h <= 23) {
            const match = c.slice(
              tailStart + mPref.index,
              tailStart + mPref.index + mPref[0].length
            );
            return { h, mi: 0, match };
          }
        }
        const mBare = tail.match(/^\s*(\d{1,2})\b(?!\s*[:.]\d{2})/);
        if (mBare) {
          const h = Number(mBare[1]);
          if (!Number.isNaN(h) && h >= 0 && h <= 23) {
            const match = c.slice(
              tailStart + mBare.index,
              tailStart + mBare.index + mBare[0].length
            );
            return { h, mi: 0, match };
          }
        }
      }
    }

    const sqOraShort = c.match(/\bora\s+(\d{1,2})(?:[:.](\d{2}))?\b/i);
    if (sqOraShort) {
      const h = Number(sqOraShort[1]);
      const mi = sqOraShort[2] != null ? Number(sqOraShort[2]) : 0;
      if (!Number.isNaN(h) && !Number.isNaN(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
        return { h, mi, match: sqOraShort[0] };
      }
    }

    return null;
  }

  /**
   * @param {string} raw
   * @returns {boolean}
   */
  function isCancelMessage(raw) {
    const s = String(raw || "")
      .toLowerCase()
      .trim();
    if (!s) return false;
    return (
      /^(cancel|stop|forget\s+it|never\s*mind|nevermind|anulo|anuloje|harro|mos|mos\s+e\s+bëjme)\b/i.test(
        s
      ) || /^(jo|no)\s*$/i.test(s)
    );
  }

  /**
   * @param {string} raw
   * @returns {boolean}
   */
  function isChangeTimeMessage(raw) {
    return /^(change|set|ndrysho|nd[eë]rro|nderro|ri[- ]?vendos|rish)\b/i.test(String(raw || "").trim());
  }

  window.webChatReminderParse = {
    extractTimeSpec,
    isCancelMessage,
    isChangeTimeMessage
  };
})();
