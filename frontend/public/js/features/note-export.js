/**
 * Client-only note export: TXT (all tiers), PDF (Standard+), JPG (Premium).
 * Depends on globals: noteTitleTrim, t, showToast, openBot, currentUser,
 * userCanExportNotePdf, userCanExportNoteTxt, userCanExportNoteJpg.
 */
(function () {
  "use strict";

  var pendingNote = null;
  var EXPORT_THEME_KEY = "noteExportTheme";

  var ALLOWED_EXPORT_TAGS = {
    p: true,
    div: true,
    br: true,
    ul: true,
    ol: true,
    li: true,
    strong: true,
    b: true,
    em: true,
    i: true,
    u: true,
    span: true,
    blockquote: true
  };

  function sanitizeExportBasename(note) {
    var title = "";
    if (typeof noteTitleTrim === "function") title = noteTitleTrim(note) || "";
    if (!title) {
      title =
        "note-" +
        String((note && note._id) || "export")
          .replace(/[^a-z0-9_-]/gi, "")
          .slice(0, 14);
    }
    return (
      title
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "note"
    );
  }

  function downloadBlob(blob, filename) {
    if (!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2500);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        resolve(blob || null);
      }, type, quality);
    });
  }

  function getNoteStoredRaw(note) {
    return (note && note.text) != null ? String(note.text) : "";
  }

  function getNoteHtmlBody(note) {
    var raw = getNoteStoredRaw(note);
    if (!raw) return "";
    if (
      typeof window !== "undefined" &&
      window.NoteRichEditor &&
      typeof window.NoteRichEditor.storedToHtml === "function"
    ) {
      return window.NoteRichEditor.storedToHtml(raw);
    }
    return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  }

  function sanitizeExportHtml(html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(String(html || ""), "text/html");
    var body = doc.body;
    if (!body) return "";

    function cleanNode(node) {
      if (!node || !node.childNodes) return;
      var children = Array.prototype.slice.call(node.childNodes);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (!child) continue;
        if (child.nodeType === 8) {
          node.removeChild(child);
          continue;
        }
        if (child.nodeType !== 1) continue;
        var tag = String(child.tagName || "").toLowerCase();
        if (tag === "script" || tag === "style") {
          node.removeChild(child);
          continue;
        }
        if (!ALLOWED_EXPORT_TAGS[tag]) {
          var parent = child.parentNode;
          if (parent) {
            while (child.firstChild) parent.insertBefore(child.firstChild, child);
            parent.removeChild(child);
          }
          continue;
        }
        var attrs = Array.prototype.slice.call(child.attributes || []);
        for (var ai = 0; ai < attrs.length; ai++) {
          var name = String(attrs[ai].name || "").toLowerCase();
          if (name.indexOf("on") === 0 || name === "style" || name === "class" || name === "id") {
            child.removeAttribute(attrs[ai].name);
          }
        }
        cleanNode(child);
      }
    }

    cleanNode(body);
    return body.innerHTML;
  }

  function sanitizeExportText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getTxtBodyFromHtml(html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString("<div>" + String(html || "") + "</div>", "text/html");
    var root = doc.body && doc.body.firstElementChild ? doc.body.firstElementChild : doc.body;
    if (!root) return "";

    function walk(node, out, depth) {
      if (!node) return;
      if (node.nodeType === 3) {
        out.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = String(node.tagName || "").toLowerCase();
      if (tag === "br") {
        out.push("\n");
        return;
      }
      if (tag === "li") out.push("• ");
      var children = Array.prototype.slice.call(node.childNodes || []);
      for (var i = 0; i < children.length; i++) walk(children[i], out, depth + 1);
      if (tag === "li" || tag === "p" || tag === "div" || tag === "blockquote") out.push("\n");
      if (tag === "ul" || tag === "ol") out.push("\n");
    }

    var out = [];
    walk(root, out, 0);
    return sanitizeExportText(out.join(""));
  }

  function buildExportTemplateHtml(note) {
    var title =
      (typeof noteTitleTrim === "function" ? noteTitleTrim(note) : "") ||
      (typeof t === "function" ? t("noteCardUntitled") : "Note");
    var safeTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    var safeContent = sanitizeExportHtml(getNoteHtmlBody(note));
    return (
      '<div class="note-export-sheet">' +
      '<header class="note-export-head"><h1>' + safeTitle + "</h1></header>" +
      '<main class="note-export-content">' +
      (safeContent || "<p>—</p>") +
      "</main>" +
      "</div>"
    );
  }

  function getNoteExportTheme() {
    try {
      var v = localStorage.getItem(EXPORT_THEME_KEY);
      if (v === "dark" || v === "light") return v;
    } catch (e) {
      /* ignore */
    }
    return "light";
  }

  function setNoteExportTheme(theme) {
    if (theme !== "dark" && theme !== "light") theme = "light";
    try {
      localStorage.setItem(EXPORT_THEME_KEY, theme);
    } catch (e) {
      /* ignore */
    }
    syncNoteExportThemeUi();
  }

  function syncNoteExportThemeUi() {
    var theme = getNoteExportTheme();
    var light = document.getElementById("noteExportThemeLight");
    var dark = document.getElementById("noteExportThemeDark");
    if (light) {
      light.classList.toggle("is-active", theme === "light");
      light.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }
    if (dark) {
      dark.classList.toggle("is-active", theme === "dark");
      dark.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    }
  }

  window.noteExportSetTheme = function (theme) {
    setNoteExportTheme(theme);
  };

  function buildExportStyleBlock(theme) {
    var isDark = theme === "dark";
    var pageBg = isDark ? "#0b1220" : "#ffffff";
    var sheetBg = isDark ? "#0b1220" : "#ffffff";
    var headBg = isDark ? "#020617" : "#0f172a";
    var headColor = "#f8fafc";
    var bodyColor = isDark ? "#e2e8f0" : "#111827";
    var bqRule = isDark
      ? ".note-export-content blockquote{margin:0 0 10px;border-left:3px solid rgba(148,163,184,0.35);padding-left:14px;color:#cbd5e1;}"
      : ".note-export-content blockquote{margin:0 0 10px;border-left:3px solid rgba(148,163,184,0.45);padding-left:14px;color:#334155;}";

    return (
      "<style>" +
      "html,body{margin:0;padding:0;background:" + pageBg + ";color:" + bodyColor + ";font-family:Segoe UI,system-ui,-apple-system,Roboto,Arial,sans-serif;}" +
      ".note-export-sheet{width:794px;box-sizing:border-box;background:" + sheetBg + ";}" +
      ".note-export-head{background:" + headBg + ";color:" + headColor + ";padding:26px 44px 20px;" +
      (isDark ? "border-bottom:1px solid rgba(148,163,184,0.15);" : "") +
      "}" +
      ".note-export-head h1{margin:0;font-size:28px;line-height:1.25;font-weight:700;word-break:break-word;}" +
      ".note-export-content{padding:26px 44px 34px;font-size:18px;line-height:1.62;color:" + bodyColor + ";word-break:break-word;}" +
      ".note-export-content p,.note-export-content div{margin:0 0 10px;}" +
      bqRule +
      ".note-export-content ul,.note-export-content ol{margin:0 0 10px;padding-left:22px;}" +
      ".note-export-content li{margin:0 0 8px;}" +
      ".note-export-content strong,.note-export-content b{font-weight:700;}" +
      ".note-export-content em,.note-export-content i{font-style:italic;}" +
      ".note-export-content u{text-decoration:underline;}" +
      "</style>"
    );
  }

  function buildExportInnerHtml(note, theme) {
    return buildExportStyleBlock(theme) + buildExportTemplateHtml(note);
  }

  function withExportMeasure(note, theme, fn) {
    var host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-10000px";
    host.style.top = "0";
    host.style.width = "794px";
    host.style.zIndex = "-1";
    host.style.pointerEvents = "none";
    host.style.opacity = "0";
    host.innerHTML = buildExportInnerHtml(note, theme);
    document.body.appendChild(host);
    try {
      return fn(host);
    } finally {
      document.body.removeChild(host);
    }
  }

  function canvasPageBackground(theme) {
    return theme === "dark" ? "#0b1220" : "#ffffff";
  }

  function renderExportCanvas(note, theme) {
    theme = theme || getNoteExportTheme();
    return new Promise(function (resolve, reject) {
      var innerHtml = buildExportInnerHtml(note, theme);
      var dims = withExportMeasure(note, theme, function (host) {
        var sheet = host.querySelector(".note-export-sheet");
        var node = sheet || host;
        var w = Math.max(794, Math.ceil(node.scrollWidth || 794));
        var h = Math.max(400, Math.ceil(node.scrollHeight || 1123));
        return { width: w, height: h };
      });

      var wrapBg = canvasPageBackground(theme);
      var markup =
        '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' +
        dims.width +
        "px;height:" +
        dims.height +
        "px;background:" +
        wrapBg +
        ';overflow:hidden">' +
        innerHtml +
        "</div>";

      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + dims.width + '" height="' + dims.height + '">' +
        '<foreignObject x="0" y="0" width="100%" height="100%">' +
        markup +
        "</foreignObject></svg>";

      var svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(svgBlob);
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement("canvas");
        canvas.width = dims.width;
        canvas.height = dims.height;
        var ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error("Canvas unsupported"));
          return;
        }
        ctx.fillStyle = wrapBg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to render export image"));
      };
      img.src = url;
    });
  }

  function getNotePlainBody(note) {
    if (
      typeof window !== "undefined" &&
      window.NoteRichEditor &&
      typeof window.NoteRichEditor.storedToPreviewText === "function"
    ) {
      return window.NoteRichEditor.storedToPreviewText(getNoteStoredRaw(note), 100000);
    }
    return getNoteStoredRaw(note);
  }

  function exportNoteTxt(note) {
    var title = typeof noteTitleTrim === "function" ? noteTitleTrim(note) : "";
    var body = getTxtBodyFromHtml(sanitizeExportHtml(getNoteHtmlBody(note))) || sanitizeExportText(getNotePlainBody(note));
    var content = sanitizeExportText(title ? title + "\n\n" + body : body);
    var blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, sanitizeExportBasename(note) + ".txt");
  }

  function exportNotePdf(note) {
    return (async function () {
    var JsPDF =
      (typeof window !== "undefined" && window.jspdf && window.jspdf.jsPDF) ||
      (typeof window !== "undefined" && window.jsPDF);
    if (!JsPDF) {
      if (typeof showToast === "function") {
        showToast(typeof t === "function" ? t("noteExportPdfUnavailable") : "PDF unavailable");
      }
      return false;
    }
    var theme = getNoteExportTheme();
    var pageFill = canvasPageBackground(theme);
    var doc = new JsPDF({ unit: "mm", format: "a4" });
    var canvas = await renderExportCanvas(note, theme);
    var margin = 12;
    var pageW = 210;
    var pageH = 297;
    var innerW = pageW - margin * 2;
    var innerH = pageH - margin * 2;
    var slicePx = Math.max(1, Math.floor((innerH * canvas.width) / innerW));
    var offsetY = 0;
    var pageIndex = 0;

    while (offsetY < canvas.height) {
      if (pageIndex > 0) doc.addPage();
      var currentSlicePx = Math.min(slicePx, canvas.height - offsetY);
      var sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = currentSlicePx;
      var sctx = sliceCanvas.getContext("2d");
      if (!sctx) break;
      sctx.fillStyle = pageFill;
      sctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      sctx.drawImage(canvas, 0, offsetY, canvas.width, currentSlicePx, 0, 0, canvas.width, currentSlicePx);
      var imgData = sliceCanvas.toDataURL("image/jpeg", 0.94);
      var renderH = (currentSlicePx * innerW) / canvas.width;
      doc.addImage(imgData, "JPEG", margin, margin, innerW, Math.min(innerH, renderH), undefined, "FAST");
      offsetY += currentSlicePx;
      pageIndex += 1;
    }

    doc.save(sanitizeExportBasename(note) + ".pdf");
    return true;
    })().catch(function () {
      if (typeof showToast === "function") {
        showToast(typeof t === "function" ? t("noteExportPdfUnavailable") : "PDF unavailable");
      }
      return false;
    });
  }

  function exportNoteJpg(note) {
    var theme = getNoteExportTheme();
    return renderExportCanvas(note, theme)
      .then(function (canvas) {
        return canvasToBlob(canvas, "image/jpeg", 0.92);
      })
      .then(function (blob) {
        if (!blob) throw new Error("JPG export failed");
        downloadBlob(blob, sanitizeExportBasename(note) + ".jpg");
        return true;
      })
      .catch(function () {
        if (typeof showToast === "function") {
          showToast(typeof t === "function" ? t("noteExportJpgUnavailable") : "JPG unavailable");
        }
        return false;
      });
  }

  window.openNoteExportModal = function (note) {
    pendingNote = note;
    var modal = document.getElementById("noteExportModal");
    if (!modal) return;
    var u = typeof currentUser !== "undefined" ? currentUser : null;
    var canTxt = typeof userCanExportNoteTxt === "function" ? userCanExportNoteTxt(u) : !!u;
    var canPdf = typeof userCanExportNotePdf === "function" ? userCanExportNotePdf(u) : false;
    var canJpg = typeof userCanExportNoteJpg === "function" ? userCanExportNoteJpg(u) : false;

    var btnTxt = document.getElementById("noteExportBtnTxt");
    var btnPdf = document.getElementById("noteExportBtnPdf");
    var btnJpg = document.getElementById("noteExportBtnJpg");
    if (btnTxt) {
      btnTxt.disabled = !canTxt;
      btnTxt.classList.toggle("note-export-option--locked", !canTxt);
    }
    if (btnPdf) {
      btnPdf.disabled = !canPdf;
      btnPdf.classList.toggle("note-export-option--locked", !canPdf);
    }
    if (btnJpg) {
      btnJpg.disabled = !canJpg;
      btnJpg.classList.toggle("note-export-option--locked", !canJpg);
    }

    var hint = document.getElementById("noteExportPlanHint");
    if (hint) {
      hint.classList.toggle(
        "hidden",
        canTxt && canPdf && canJpg
      );
    }

    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    if (typeof applyTranslations === "function") applyTranslations();
    syncNoteExportThemeUi();
  };

  window.closeNoteExportModal = function () {
    pendingNote = null;
    var modal = document.getElementById("noteExportModal");
    if (modal) modal.classList.add("hidden");
    if (typeof releaseModalBackdropIfIdle === "function") releaseModalBackdropIfIdle();
  };

  window.runNoteExportAction = function (kind) {
    return (async function () {
    var note = pendingNote;
    if (!note) return;
    var u = typeof currentUser !== "undefined" ? currentUser : null;

    if (kind === "txt") {
      if (typeof userCanExportNoteTxt === "function" && !userCanExportNoteTxt(u)) {
        if (typeof showToast === "function") showToast(typeof t === "function" ? t("noteExportUpgradePlan") : "Upgrade plan");
        if (typeof openBot === "function") openBot();
        return;
      }
      exportNoteTxt(note);
      window.closeNoteExportModal();
      return;
    }

    if (kind === "pdf") {
      if (typeof userCanExportNotePdf === "function" && !userCanExportNotePdf(u)) {
        if (typeof showToast === "function") showToast(typeof t === "function" ? t("noteExportUpgradePlan") : "Upgrade plan");
        if (typeof openBot === "function") openBot();
        return;
      }
      await exportNotePdf(note);
      window.closeNoteExportModal();
      return;
    }

    if (kind === "jpg") {
      if (typeof userCanExportNoteJpg === "function" && !userCanExportNoteJpg(u)) {
        if (typeof showToast === "function") showToast(typeof t === "function" ? t("noteExportUpgradePlan") : "Upgrade plan");
        if (typeof openBot === "function") openBot();
        return;
      }
      await exportNoteJpg(note);
      window.closeNoteExportModal();
    }
    })();
  };
})();
