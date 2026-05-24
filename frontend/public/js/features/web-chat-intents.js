/**
 * Intent-based routing for the local Web Chat bot (no external AI).
 * Normalizes user text, scores intents (phrases + token combos), picks best match.
 */
(function () {
  "use strict";

  /** Strip reminder command prefix (Albanian + English variants). */
  var WEB_CHAT_REMINDER_STRIP_RE =
    /^(?:më\s+kujto|me\s+kujto|kujto|kujtomë|kujtom|remind\s+me(?:\s+to)?|can\s+you\s+remind(?:\s+me)?|please\s+remind(?:\s+me)?|set\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|schedule\s+(?:a\s+)?reminder|reminder|remember|notify\s+me(?:\s+to)?|alert\s+me(?:\s+to)?|vendos\s+kujtes[ëe]|njoftom[eë]|me\s+njofto)\s*:?\s*/i;

  var STOP = new Set([
    "a",
    "an",
    "the",
    "to",
    "me",
    "my",
    "i",
    "is",
    "it",
    "in",
    "on",
    "at",
    "for",
    "of",
    "and",
    "or",
    "do",
    "does",
    "can",
    "you",
    "please",
    "te",
    "të",
    "me",
    "në",
    "ne",
    "per",
    "për",
    "një",
    "nje",
    "më",
    "si",
    "jam",
    "dua",
    "dëshiroj",
    "deshiroj",
    "që",
    "qe",
    "nga",
    "po",
    "mos"
  ]);

  /**
   * Lowercase, collapse space, replace punctuation with spaces (keep letters + digits + Albanian chars).
   * @param {string} raw
   * @returns {string}
   */
  function normalizeWebChatInput(raw) {
    if (!raw || typeof raw !== "string") return "";
    var s = raw
      .toLowerCase()
      .trim()
      .replace(/[\u2018\u2019\u201B\u2032\u2035]/g, "'")
      .replace(/[\u201C\u201D\u00AB\u00BB]/g, " ")
      .replace(/[^a-z0-9ëç\s'-]/gi, " ");
    return s.replace(/\s+/g, " ").trim();
  }

  /**
   * @param {string} norm
   * @returns {string[]}
   */
  function tokenizeWebChatNormalized(norm) {
    if (!norm) return [];
    return norm.split(/\s+/).filter(function (t) {
      return t.length > 0 && !STOP.has(t);
    });
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Phrase or single token: short tokens use word boundaries to avoid false positives.
   * @param {string} norm
   * @param {string} pattern
   */
  function webChatPatternMatches(norm, pattern) {
    var p = (pattern || "").toLowerCase().trim().replace(/\s+/g, " ");
    if (!p) return false;

    if (p.indexOf(" ") >= 0) {
      return norm.indexOf(p) >= 0;
    }

    if (p.length <= 4) {
      var esc = escapeRegExp(p);
      return new RegExp("(^|[^a-z0-9ëç])" + esc + "([^a-z0-9ëç]|$)", "i").test(norm);
    }

    return norm.indexOf(p) >= 0;
  }

  function phraseScore(len) {
    return 4 + Math.min(len, 48) * 0.14;
  }

  /**
   * @typedef {{ id: string; patterns: string[]; weakTokens?: string[]; minScore?: number }} WebChatIntentDef
   */

  /** @type {WebChatIntentDef[]} */
  var WEB_CHAT_INTENTS = [
    {
      id: "help",
      patterns: [
        "help",
        "ndihme",
        "ndihmë",
        "what can you do",
        "what can you do for me",
        "what do you do",
        "how do i use this",
        "how does this work",
        "lista e komandave",
        "list of commands",
        "cilat jane komandat",
        "cilat janë komandat",
        "cfare mund te besh",
        "çfarë mund të bësh",
        "cfare ben",
        "çfarë bën",
        "komandat",
        "komanda",
        "udhezime",
        "udhëzime",
        "guide",
        "instructions"
      ],
      weakTokens: ["help", "ndihme", "komanda", "commands"]
    },
    {
      id: "greeting",
      patterns: [
        "hello",
        "hi there",
        "hey there",
        "hi",
        "hey",
        "good morning",
        "good afternoon",
        "good evening",
        "whats up",
        "what's up",
        "pershendetje",
        "përshëndetje",
        "ckemi",
        "çkemi",
        "tungjatjeta",
        "tung",
        "mirëdita",
        "miredita",
        "mirëmenë",
        "miremene",
        "mirëmbrëma",
        "mirembrema",
        "hello there"
      ],
      weakTokens: ["hello", "hi", "hey", "tung"]
    },
    {
      id: "thanks",
      patterns: [
        "thank you",
        "thanks",
        "thank u",
        "faleminderit",
        "faleminderit shumë",
        "faleminderit shume",
        "flm",
        "many thanks",
        "appreciate it"
      ],
      weakTokens: ["thanks", "flm"]
    },
    {
      id: "bye",
      patterns: [
        "goodbye",
        "bye bye",
        "bye",
        "see you",
        "mirupafshim",
        "lamtumirë",
        "lamtumire",
        "shifemi",
        "talk later",
        "catch you later"
      ],
      weakTokens: ["bye", "mirupafshim"]
    },
    {
      id: "plans",
      patterns: [
        "upgrade plan",
        "pricing",
        "subscription",
        "abonim",
        "pagese",
        "pagesë",
        "cmimi i planit",
        "çmimi i planit",
        "sa kushton standard",
        "free standard",
        "compare plans",
        "plan comparison",
        "dua standard",
        "më duhet standard",
        "me duhet standard",
        "standard",
        "pricing page",
        "about plans"
      ],
      weakTokens: ["standard", "plan", "pricing", "abonim", "upgrade"]
    },
    {
      id: "reminder",
      patterns: [
        "remind me to",
        "remind me at",
        "notify me to",
        "notify me at",
        "alert me to",
        "can you remind me",
        "please remind me",
        "set a reminder",
        "set reminder",
        "create a reminder",
        "schedule a reminder",
        "me kujto",
        "më kujto",
        "kujto",
        "reminder",
        "remember to",
        "remember at",
        "web reminder",
        "kujtesë web",
        "kujtese web",
        "njoftim me datë",
        "njoftim me date",
        "vendos kujtesë",
        "njoftomë",
        "alarm"
      ],
      weakTokens: ["kujto", "reminder", "remember", "schedule", "neser", "nesër", "tomorrow"]
    },
    {
      id: "scan_cam",
      patterns: [
        "scan cam",
        "scan document",
        "skano dokument",
        "skano dokumentin",
        "ocr",
        "foto në tekst",
        "foto ne tekst",
        "kamera për tekst",
        "kamera per tekst",
        "lexo nga foto",
        "tekst nga foto",
        "document to text"
      ],
      weakTokens: ["skano", "scan", "ocr", "dokument", "kamera", "foto"]
    },
    {
      id: "notes",
      patterns: [
        "my notes",
        "shënimet e mia",
        "shenimet e mia",
        "open notes",
        "kategori shënimesh",
        "kategori shenimesh",
        "create a note",
        "krijo shënim",
        "krijo shenim",
        "new note",
        "shënim i ri",
        "shenim i ri"
      ],
      weakTokens: ["notes", "shënim", "shenim", "category", "kategori"]
    },
    {
      id: "settings",
      patterns: [
        "open settings",
        "te cilësimet",
        "te cilesimet",
        "faqja e cilësimeve",
        "faqja e cilesimeve",
        "change language",
        "ndrysho gjuhën",
        "ndrysho gjuhen",
        "dark mode",
        "light mode",
        "tema e aplikacionit",
        "account settings"
      ],
      weakTokens: ["settings", "cilësimet", "cilesimet", "gjuhën", "gjuhen", "theme", "tema"]
    },
    {
      id: "home_reminders",
      patterns: [
        "browser reminder",
        "browser notifications",
        "njoftime në shfletues",
        "njoftime ne shfletues",
        "kujtesë në shtëpi",
        "kujtese ne shtepi",
        "date and time alerts",
        "alerts on home",
        "enable notifications",
        "aktivizo njoftimet"
      ],
      weakTokens: ["notification", "njoftime", "browser", "shfletues", "shtepi", "shtëpi"]
    },
    {
      id: "account_login",
      patterns: [
        "log in",
        "login",
        "sign in",
        "sign up",
        "register",
        "hyr në llogari",
        "hyr ne llogari",
        "krijo llogari",
        "create account",
        "jam i dalë",
        "jam i dale",
        "log out",
        "logout"
      ],
      weakTokens: ["login", "hyr", "llogari", "account", "register"]
    },
    {
      id: "time",
      patterns: [
        "what time is it",
        "what is the time",
        "current time",
        "sa është ora",
        "sa eshte ora",
        "ora tani",
        "what is the date",
        "what's today's date",
        "cfare date eshte",
        "çfarë date është",
        "sot eshte",
        "sot është"
      ],
      weakTokens: ["time", "date", "ora", "sot"]
    }
  ];

  function scoreIntent(norm, tokens, def) {
    var score = 0;
    var pi;
    var pn;
    for (pi = 0; pi < def.patterns.length; pi++) {
      pn = normalizeWebChatInput(def.patterns[pi]);
      if (pn && webChatPatternMatches(norm, pn)) {
        score = Math.max(score, phraseScore(pn.length));
      }
    }

    if (def.weakTokens && def.weakTokens.length) {
      var ti;
      for (ti = 0; ti < def.weakTokens.length; ti++) {
        var w = normalizeWebChatInput(def.weakTokens[ti]);
        if (!w) continue;
        if (webChatPatternMatches(norm, w) || tokens.indexOf(w) >= 0) {
          score += 1.15;
        }
      }
    }

    if (typeof def.minScore === "number" && score < def.minScore) score = 0;
    return score;
  }

  var MIN_CONFIDENCE = 3.35;

  /**
   * @param {string} raw
   * @returns {{ chosenId: string; bestId: string; bestScore: number; secondId: string; secondScore: number; norm: string; tokens: string[] }}
   */
  function webChatFindBestIntent(raw) {
    var norm = normalizeWebChatInput(raw);
    var tokens = tokenizeWebChatNormalized(norm);
    var bestId = "";
    var bestScore = 0;
    var secondScore = 0;
    var secondId = "";
    var i;
    var s;
    var id;

    for (i = 0; i < WEB_CHAT_INTENTS.length; i++) {
      id = WEB_CHAT_INTENTS[i].id;
      s = scoreIntent(norm, tokens, WEB_CHAT_INTENTS[i]);
      if (s > bestScore) {
        secondScore = bestScore;
        secondId = bestId;
        bestScore = s;
        bestId = id;
      } else if (s > secondScore) {
        secondScore = s;
        secondId = id;
      }
    }

    return {
      chosenId: bestScore >= MIN_CONFIDENCE ? bestId : "",
      bestId: bestId,
      bestScore: bestScore,
      secondId: secondId,
      secondScore: secondScore,
      norm: norm,
      tokens: tokens
    };
  }

  function stripWebChatReminderCommand(raw) {
    return String(raw || "")
      .trim()
      .replace(WEB_CHAT_REMINDER_STRIP_RE, "")
      .trim();
  }

  window.webChatIntents = {
    normalizeWebChatInput: normalizeWebChatInput,
    tokenizeWebChatNormalized: tokenizeWebChatNormalized,
    webChatFindBestIntent: webChatFindBestIntent,
    stripWebChatReminderCommand: stripWebChatReminderCommand,
    WEB_CHAT_INTENTS: WEB_CHAT_INTENTS,
    WEB_CHAT_MIN_CONFIDENCE: MIN_CONFIDENCE
  };
})();
