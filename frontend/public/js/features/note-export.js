/**
 * Client-only note export: TXT (all tiers), PDF (Standard+), JPG (Premium).
 * Depends on globals: noteTitleTrim, t, showToast, openBot, currentUser,
 * userCanExportNotePdf, userCanExportNoteTxt, userCanExportNoteJpg.
 */
(function () {
  "use strict";

  var pendingNote = null;

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

  function triggerDownloadBlob(blob, filename) {
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

  function triggerDownloadDataUrl(dataUrl, filename) {
    var a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function exportNoteTxt(note) {
    var title = typeof noteTitleTrim === "function" ? noteTitleTrim(note) : "";
    var body = (note && note.text) || "";
    var content = title ? title + "\r\n\r\n" + body : body;
    var blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    triggerDownloadBlob(blob, sanitizeExportBasename(note) + ".txt");
  }

  function exportNotePdf(note) {
    var JsPDF =
      (typeof window !== "undefined" && window.jspdf && window.jspdf.jsPDF) ||
      (typeof window !== "undefined" && window.jsPDF);
    if (!JsPDF) {
      if (typeof showToast === "function") {
        showToast(typeof t === "function" ? t("noteExportPdfUnavailable") : "PDF unavailable");
      }
      return;
    }
    var doc = new JsPDF({ unit: "mm", format: "a4" });
    var title = typeof noteTitleTrim === "function" ? noteTitleTrim(note) : "";
    var text = (note && note.text) || "";
    var margin = 18;
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 210, 38, "F");
    doc.setTextColor(248, 250, 252);
    doc.setFontSize(15);
    doc.text(
      title || (typeof t === "function" ? t("noteCardUntitled") : "Note"),
      margin,
      24
    );
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(11);
    var y = 48;
    var lines = doc.splitTextToSize(text, 210 - margin * 2);
    doc.text(lines, margin, y);
    doc.save(sanitizeExportBasename(note) + ".pdf");
  }

  function wrapLines(ctx, text, maxWidth) {
    var words = String(text || "").split(/\s+/);
    var lines = [];
    var line = "";
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function exportNoteJpg(note, done) {
    var w = 880;
    var h = 1120;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      if (typeof done === "function") done(null);
      return;
    }
    var grd = ctx.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, "#0f172a");
    grd.addColorStop(0.5, "#312e81");
    grd.addColorStop(1, "#1e1b4b");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    var pad = 44;
    var title =
      (typeof noteTitleTrim === "function" ? noteTitleTrim(note) : "") ||
      (typeof t === "function" ? t("noteCardUntitled") : "Note");
    var body = (note && note.text) || "";
    var imgSrc = note && note.scanCamImageDataUrl;

    function drawTextCard(topY) {
      var x = pad;
      var y0 = topY;
      var cw = w - 2 * pad;
      var cardH = h - topY - pad;
      ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
      ctx.fillRect(x, y0, cw, cardH);

      ctx.fillStyle = "#f1f5f9";
      ctx.font = "600 26px Segoe UI, system-ui, sans-serif";
      ctx.fillText(title.length > 42 ? title.slice(0, 40) + "…" : title, x + 24, y0 + 42);

      ctx.fillStyle = "#cbd5e1";
      ctx.font = "17px Segoe UI, system-ui, sans-serif";
      var lines = wrapLines(ctx, body, cw - 48);
      var ly = y0 + 78;
      var maxLines = Math.min(lines.length, 38);
      for (var li = 0; li < maxLines; li++) {
        ctx.fillText(lines[li], x + 24, ly);
        ly += 24;
      }
      if (lines.length > maxLines) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "italic 15px Segoe UI, system-ui, sans-serif";
        ctx.fillText("…", x + 24, ly);
      }
    }

    if (imgSrc) {
      var im = new Image();
      im.onload = function () {
        var maxW = w - 2 * pad;
        var maxImgH = 420;
        var sc = Math.min(maxW / im.width, maxImgH / im.height, 1);
        var dw = im.width * sc;
        var dh = im.height * sc;
        var ix = pad + (maxW - dw) / 2;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.4)";
        ctx.shadowBlur = 28;
        ctx.drawImage(im, ix, pad, dw, dh);
        ctx.restore();
        drawTextCard(pad + dh + 28);
        if (typeof done === "function") done(canvas.toDataURL("image/jpeg", 0.9));
      };
      im.onerror = function () {
        drawTextCard(pad + 24);
        if (typeof done === "function") done(canvas.toDataURL("image/jpeg", 0.9));
      };
      im.src = imgSrc;
    } else {
      drawTextCard(pad + 24);
      if (typeof done === "function") done(canvas.toDataURL("image/jpeg", 0.9));
    }
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
  };

  window.closeNoteExportModal = function () {
    pendingNote = null;
    var modal = document.getElementById("noteExportModal");
    if (modal) modal.classList.add("hidden");
    if (typeof releaseModalBackdropIfIdle === "function") releaseModalBackdropIfIdle();
  };

  window.runNoteExportAction = function (kind) {
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
      exportNotePdf(note);
      window.closeNoteExportModal();
      return;
    }

    if (kind === "jpg") {
      if (typeof userCanExportNoteJpg === "function" && !userCanExportNoteJpg(u)) {
        if (typeof showToast === "function") showToast(typeof t === "function" ? t("noteExportUpgradePlan") : "Upgrade plan");
        if (typeof openBot === "function") openBot();
        return;
      }
      exportNoteJpg(note, function (dataUrl) {
        if (dataUrl) {
          triggerDownloadDataUrl(dataUrl, sanitizeExportBasename(note) + ".jpg");
        }
        window.closeNoteExportModal();
      });
    }
  };
})();
