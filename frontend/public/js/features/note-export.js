/**
 * Client-only note export: TXT (all tiers), PDF/JPG (Standard+).
 * html2canvas + jsPDF load on demand (first export / scan PDF) to keep initial page light.
 */
(function () {
  "use strict";

  var exportVendorQueryCache = null;
  function getExportVendorQuery() {
    if (exportVendorQueryCache !== null) return exportVendorQueryCache;
    exportVendorQueryCache = "";
    try {
      var ref = document.querySelector('script[src*="/js/app.js"]');
      if (ref && ref.src) {
        var u = new URL(ref.src, window.location.href);
        exportVendorQueryCache = u.search || "";
      }
    } catch (e) {
      exportVendorQueryCache = "";
    }
    return exportVendorQueryCache;
  }

  var scriptPromises = {};

  function loadScriptOnce(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        delete scriptPromises[src];
        reject(new Error("Failed to load " + src));
      };
      document.head.appendChild(s);
    });
    return scriptPromises[src];
  }

  var pendingNote = null;
  var EXPORT_THEME_KEY = "noteExportTheme";

  function getJsPdfConstructor() {
    if (typeof window === "undefined") return null;
    var fromModule = window.jspdf && window.jspdf.jsPDF;
    if (typeof fromModule === "function") return fromModule;
    if (typeof window.jsPDF === "function") return window.jsPDF;
    return null;
  }

  function getHtml2Canvas() {
    if (typeof window === "undefined") return null;
    return typeof window.html2canvas === "function" ? window.html2canvas : null;
  }

  /**
   * Loads jsPDF only (Scan Cam PDF uses text layout).
   * @returns {Promise<void>}
   */
  function ensureJsPdfLoaded() {
    if (getJsPdfConstructor()) return Promise.resolve();
    return loadScriptOnce("/vendor/jspdf.umd.min.js" + getExportVendorQuery());
  }

  /**
   * Loads html2canvas + jsPDF for rich note export (PDF/JPG quality path).
   * @returns {Promise<void>}
   */
  function ensureHeavyExportLibsLoaded() {
    var needPdf = !getJsPdfConstructor();
    var needH2c = !getHtml2Canvas();
    if (!needPdf && !needH2c) return Promise.resolve();
    var q = getExportVendorQuery();
    var chain = Promise.resolve();
    if (needH2c) {
      chain = chain.then(function () {
        return loadScriptOnce("/vendor/html2canvas.min.js" + q);
      });
    }
    if (needPdf) {
      chain = chain.then(function () {
        return loadScriptOnce("/vendor/jspdf.umd.min.js" + q);
      });
    }
    return chain;
  }

  if (typeof window !== "undefined") {
    window.ensureJsPdfVendorLoaded = ensureJsPdfLoaded;
    window.ensureHeavyExportLibsLoaded = ensureHeavyExportLibsLoaded;
  }

  function toastExportToolsLoading() {
    var msg =
      typeof t === "function"
        ? t("noteExportToolsLoading")
        : "Export tools are still loading. Try again in a few seconds.";
    if (typeof showToast === "function") showToast(msg);
  }

  function toastExportPdfFailed() {
    var msg = typeof t === "function" ? t("noteExportPdfUnavailable") : "Could not build the PDF.";
    if (typeof showToast === "function") showToast(msg);
  }

  function toastExportJpgFailed() {
    var msg = typeof t === "function" ? t("noteExportJpgUnavailable") : "Could not create the image.";
    if (typeof showToast === "function") showToast(msg);
  }

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

  function downloadBlobWithAnchor(blob, filename) {
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

  function isNativeExportTarget() {
    return (
      typeof window !== "undefined" &&
      typeof window.isNativeApp === "function" &&
      window.isNativeApp()
    );
  }

  function getCapFsPlugin() {
    var c = typeof window !== "undefined" ? window.Capacitor : null;
    if (!c) return null;
    if (c.Plugins && c.Plugins.Filesystem) return c.Plugins.Filesystem;
    if (typeof c.registerPlugin === "function") {
      try {
        return c.registerPlugin("Filesystem");
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function getCapSharePlugin() {
    var c = typeof window !== "undefined" ? window.Capacitor : null;
    if (!c || !c.Plugins) return null;
    return c.Plugins.Share || null;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        var data = reader.result;
        if (typeof data !== "string") {
          reject(new Error("Could not read file data"));
          return;
        }
        var comma = data.indexOf(",");
        resolve(comma >= 0 ? data.slice(comma + 1) : data);
      };
      reader.onerror = function () {
        reject(reader.error || new Error("Could not read file data"));
      };
      reader.readAsDataURL(blob);
    });
  }

  function toastExportNative(msgKey, fallback) {
    var msg =
      typeof t === "function" ? t(msgKey) : typeof fallback === "string" ? fallback : "Done.";
    if (typeof showToast === "function") showToast(msg);
  }

  var NATIVE_EXPORT_FOLDER = "Notes-AI";

  function inferNativeExportKind(blob, filename) {
    var name = String(filename || "").toLowerCase();
    if (/\.pdf$/i.test(name) || (blob && blob.type && String(blob.type).indexOf("pdf") >= 0)) {
      return "pdf";
    }
    if (/\.jpe?g$/i.test(name) || (blob && blob.type && String(blob.type).indexOf("image") >= 0)) {
      return "jpg";
    }
    return "txt";
  }

  function nativeExportSavedToastKey(kind) {
    if (kind === "pdf") return "noteExportPdfSaved";
    if (kind === "jpg") return "noteExportJpgSaved";
    return "noteExportTxtSaved";
  }

  function ensureNativeFilesystemPermissions(Fs) {
    if (!Fs || typeof Fs.checkPermissions !== "function") return Promise.resolve(true);
    return Fs.checkPermissions()
      .then(function (perms) {
        var st = perms && perms.publicStorage ? String(perms.publicStorage) : "granted";
        if (st === "granted") return true;
        if (typeof Fs.requestPermissions !== "function") return st !== "denied";
        return Fs.requestPermissions().then(function (req) {
          var next = req && req.publicStorage ? String(req.publicStorage) : "";
          return next === "granted";
        });
      })
      .catch(function () {
        return true;
      });
  }

  function tryNativeShareFallback(uri, safeName) {
    var Share = getCapSharePlugin();
    if (!Share || typeof Share.share !== "function" || !uri) return Promise.resolve(false);
    var dlg = typeof t === "function" ? t("noteExportShareDialogTitle") : "Export";
    var opts = { title: safeName, text: safeName, dialogTitle: dlg };
    if (/^content:|^file:/i.test(uri)) {
      opts.files = [uri];
    } else {
      opts.url = uri;
    }
    return Share.share(opts)
      .then(function () {
        return true;
      })
      .catch(function () {
        return false;
      });
  }

  function toastExportNativeError(err) {
    var base =
      typeof t === "function" ? t("noteExportNativeFailed") : "Could not save the file. Try again.";
    var extra = err && err.message ? String(err.message) : "";
    if (extra && typeof showToast === "function") {
      showToast(base + (extra.length < 120 ? " " + extra : ""));
      return;
    }
    if (typeof showToast === "function") showToast(base);
  }

  /**
   * Capacitor APK: save to public Documents/Notes-AI (visible in Files app). Share sheet only on failure.
   * Web / PWA keeps anchor-only behavior via saveOrDownloadBlob.
   */
  function saveBlobNative(blob, filename) {
    var Fs = getCapFsPlugin();
    var safeName = String(filename || "download").replace(/[\\/:*?"<>|]+/g, "-");
    var kind = inferNativeExportKind(blob, safeName);
    var savedKey = nativeExportSavedToastKey(kind);
    var savedFallback = kind === "pdf" ? "PDF saved" : kind === "jpg" ? "JPG saved" : "TXT saved";
    var relPath = NATIVE_EXPORT_FOLDER + "/" + safeName;
    var directory = "DOCUMENTS";

    if (!Fs || typeof Fs.writeFile !== "function") {
      toastExportNativeError(new Error("Filesystem plugin unavailable"));
      return tryNativeShareFallback(null, safeName).then(function (shared) {
        if (!shared) downloadBlobWithAnchor(blob, safeName);
      });
    }

    var isUtf8Text =
      (blob && blob.type && String(blob.type).indexOf("text/plain") === 0) ||
      /\.txt$/i.test(safeName);

    return ensureNativeFilesystemPermissions(Fs)
      .then(function (allowed) {
        if (!allowed) {
          throw new Error(
            typeof t === "function"
              ? t("noteExportStoragePermissionDenied")
              : "Allow storage permission in Settings to save files."
          );
        }
        if (isUtf8Text) {
          return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () {
              resolve(String(fr.result || ""));
            };
            fr.onerror = function () {
              reject(fr.error || new Error("read text"));
            };
            fr.readAsText(blob, "utf-8");
          }).then(function (text) {
            return Fs.writeFile({
              path: relPath,
              data: text,
              directory: directory,
              encoding: "utf8",
              recursive: true
            });
          });
        }
        return blobToBase64(blob).then(function (b64) {
          return Fs.writeFile({
            path: relPath,
            data: b64,
            directory: directory,
            recursive: true
          });
        });
      })
      .then(function () {
        toastExportNative(savedKey, savedFallback);
      })
      .catch(function (err) {
        toastExportNativeError(err);
        var uriPromise =
          typeof Fs.getUri === "function"
            ? Fs.getUri({ path: relPath, directory: directory }).catch(function () {
                return null;
              })
            : Promise.resolve(null);
        return uriPromise.then(function (uriResult) {
          var uri = uriResult && uriResult.uri ? String(uriResult.uri) : "";
          return tryNativeShareFallback(uri, safeName).then(function (shared) {
            if (!shared) {
              try {
                downloadBlobWithAnchor(blob, safeName);
              } catch (e2) {
                /* ignore */
              }
            }
          });
        });
      });
  }

  /**
   * @returns {Promise<void>} Resolves when download/share path completes (web resolves immediately).
   */
  function saveOrDownloadBlob(blob, filename) {
    if (!blob) return Promise.resolve();
    var name = String(filename || "download").replace(/[\\/:*?"<>|]+/g, "-");
    if (!isNativeExportTarget()) {
      downloadBlobWithAnchor(blob, name);
      return Promise.resolve();
    }
    return saveBlobNative(blob, name);
  }

  /** @deprecated use saveOrDownloadBlob — kept for any inline callers */
  function downloadBlob(blob, filename) {
    return saveOrDownloadBlob(blob, filename);
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
      ".export-template{margin:0;padding:0;box-sizing:border-box;background:" + pageBg + ";color:" + bodyColor + ";font-family:Segoe UI,system-ui,-apple-system,Roboto,Arial,sans-serif;}" +
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
    host.className = "export-template";
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = buildExportInnerHtml(note, theme);
    document.body.appendChild(host);
    try {
      return fn(host);
    } finally {
      try {
        if (host.parentNode) host.parentNode.removeChild(host);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function canvasPageBackground(theme) {
    return theme === "dark" ? "#0b1220" : "#ffffff";
  }

  function renderExportCanvasSvg(note, theme) {
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

  function renderExportCanvasHtml2Canvas(note, theme) {
    theme = theme || getNoteExportTheme();
    var h2c = getHtml2Canvas();
    if (!h2c) return Promise.reject(new Error("html2canvas missing"));

    var host = document.createElement("div");
    host.className = "export-template";
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = buildExportInnerHtml(note, theme);
    document.body.appendChild(host);

    function removeHost() {
      try {
        if (host.parentNode) host.parentNode.removeChild(host);
      } catch (e) {
        /* ignore */
      }
    }

    var target = host.querySelector(".note-export-sheet") || host;

    return new Promise(function (resolve, reject) {
      requestAnimationFrame(function () {
        h2c(target, {
          scale: Math.min(2, Math.max(1, typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1)),
          useCORS: true,
          allowTaint: false,
          logging: false,
          backgroundColor: canvasPageBackground(theme) || null,
          width: Math.max(794, Math.ceil(target.scrollWidth || 794)),
          windowWidth: 794,
          scrollX: 0,
          scrollY: 0
        })
          .then(function (canvas) {
            removeHost();
            if (!canvas || !canvas.width) {
              reject(new Error("empty canvas"));
              return;
            }
            resolve(canvas);
          })
          .catch(function (err) {
            removeHost();
            reject(err || new Error("html2canvas failed"));
          });
      });
    });
  }

  function renderExportCanvas(note, theme) {
    theme = theme || getNoteExportTheme();
    if (getHtml2Canvas()) {
      return renderExportCanvasHtml2Canvas(note, theme).catch(function () {
        return renderExportCanvasSvg(note, theme);
      });
    }
    return renderExportCanvasSvg(note, theme);
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
    return saveOrDownloadBlob(blob, sanitizeExportBasename(note) + ".txt");
  }

  function exportNotePdf(note) {
    return (async function () {
    await ensureHeavyExportLibsLoaded();
    var JsPDF = getJsPdfConstructor();
    if (!JsPDF) {
      toastExportToolsLoading();
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

    var outName = sanitizeExportBasename(note) + ".pdf";
    var pdfBlob = null;
    try {
      if (doc.output && typeof doc.output === "function") {
        pdfBlob = doc.output("blob");
      }
    } catch (e) {
      pdfBlob = null;
    }
    if (!(pdfBlob instanceof Blob) || pdfBlob.size < 1) {
      try {
        var ab =
          doc.output && typeof doc.output === "function" ? doc.output("arraybuffer") : null;
        if (ab && ab.byteLength) {
          pdfBlob = new Blob([ab], { type: "application/pdf" });
        }
      } catch (e2) {
        pdfBlob = null;
      }
    }
    if (!(pdfBlob instanceof Blob) || pdfBlob.size < 1) {
      toastExportPdfFailed();
      return false;
    }
    await saveOrDownloadBlob(pdfBlob, outName);
    return true;
    })().catch(function () {
      toastExportPdfFailed();
      return false;
    });
  }

  function exportNoteJpg(note) {
    var theme = getNoteExportTheme();
    return ensureHeavyExportLibsLoaded()
      .then(function () {
        return renderExportCanvas(note, theme);
      })
      .then(function (canvas) {
        return canvasToBlob(canvas, "image/jpeg", 0.92);
      })
      .then(function (blob) {
        if (!blob) throw new Error("JPG export failed");
        return saveOrDownloadBlob(blob, sanitizeExportBasename(note) + ".jpg");
      })
      .then(function () {
        return true;
      })
      .catch(function () {
        toastExportJpgFailed();
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
      try {
        await exportNoteTxt(note);
      } catch (e) {
        if (typeof showToast === "function") {
          showToast(typeof t === "function" ? t("noteExportNativeFailed") : "Could not save the file.");
        }
      }
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
