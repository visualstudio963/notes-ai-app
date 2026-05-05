/**
 * TipTap full-screen note editor — bundled with esbuild to public/js/note-rich-editor.bundle.js
 */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { generateHTML } from "@tiptap/html";

const STORAGE_PREFIX = "TIPJSON:";

/**
 * @param {string} [placeholderText]
 */
function getExtensions(placeholderText) {
  const ph = placeholderText && String(placeholderText).trim() ? String(placeholderText).trim() : "Start writing…";
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      bulletList: { HTMLAttributes: { class: "note-rich-ul" } },
      orderedList: { HTMLAttributes: { class: "note-rich-ol" } },
      blockquote: { HTMLAttributes: { class: "note-rich-quote" } },
      codeBlock: { HTMLAttributes: { class: "note-rich-code" } }
    }),
    Underline,
    Link.configure({
      openOnClick: true,
      HTMLAttributes: { class: "note-rich-link", rel: "noopener noreferrer nofollow", target: "_blank" }
    }),
    Image.configure({
      allowBase64: true,
      HTMLAttributes: { class: "note-rich-img" }
    }),
    TaskList.configure({ HTMLAttributes: { class: "note-rich-task-list" } }),
    TaskItem.configure({ nested: true, HTMLAttributes: { class: "note-rich-task-item" } }),
    Placeholder.configure({ placeholder: ph })
  ];
}

function parseStoredContent(raw) {
  const s = String(raw ?? "");
  if (s.startsWith(STORAGE_PREFIX)) {
    try {
      return JSON.parse(s.slice(STORAGE_PREFIX.length));
    } catch {
      return null;
    }
  }
  return null;
}

function plainTextToDoc(text) {
  const lines = String(text ?? "").split(/\n/);
  const content = lines.map((line) => ({
    type: "paragraph",
    content: line.length ? [{ type: "text", text: line }] : []
  }));
  if (!content.length) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  return { type: "doc", content };
}

function storageToDocJSON(stored) {
  const j = parseStoredContent(stored);
  if (j && j.type === "doc") return j;
  return plainTextToDoc(stored);
}

function encodeDocForStorage(doc) {
  return STORAGE_PREFIX + JSON.stringify(doc);
}

function storedToHtml(stored) {
  const doc = storageToDocJSON(stored);
  try {
    return generateHTML(doc, getExtensions("Start writing…"));
  } catch {
    return `<p>${escapeHtml(String(stored ?? ""))}</p>`;
  }
}

function storedToPreviewText(stored, maxLen = 220) {
  const tmp = document.createElement("div");
  tmp.innerHTML = storedToHtml(stored);
  let t = (tmp.textContent || "").replace(/\s+/g, " ").trim();
  if (t.length > maxLen) t = `${t.slice(0, maxLen)}…`;
  return t;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let editor = null;
/** @type {number} */
let wordCountRaf = 0;
let rootPersistNoteId = null;
let rootMode = "create";
let rootOrigin = "category";
let rootPresetCategory = null;
/** Snapshot JSON after last successful save (or initial open). */
let baselineSnapshot = "";
/** True when current editor/title differs from baselineSnapshot. */
let dirty = false;
let openOptions = {};
/** Clears inline styles from visualViewport lock when closing editor */
let viewportLockCleanup = null;

function teardownEditorViewportLock() {
  if (!viewportLockCleanup) return;
  viewportLockCleanup();
  viewportLockCleanup = null;
}

/** Keeps fullscreen editor sized to the visible viewport above the mobile keyboard so chrome + toolbar stay reachable */
function setupEditorViewportLock(screen) {
  teardownEditorViewportLock();
  if (!screen || typeof window.visualViewport === "undefined" || !window.visualViewport) return;

  const vv = window.visualViewport;
  const sync = () => {
    const h = Math.max(180, Math.round(vv.height));
    const y = Math.max(0, Math.round(vv.offsetTop));
    screen.style.top = `${y}px`;
    screen.style.left = "0";
    screen.style.right = "0";
    screen.style.width = "100%";
    screen.style.height = `${h}px`;
    screen.style.bottom = "auto";
    screen.style.maxHeight = `${h}px`;
  };

  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();

  viewportLockCleanup = () => {
    vv.removeEventListener("resize", sync);
    vv.removeEventListener("scroll", sync);
    ["top", "left", "right", "width", "height", "bottom", "maxHeight"].forEach((prop) => screen.style.removeProperty(prop));
  };
}

function tKey(key, fallback) {
  return typeof window.t === "function" ? window.t(key) : fallback;
}

function setSaveBusy(busy) {
  const btn = document.getElementById("noteRichEditorSave");
  if (!btn) return;
  btn.disabled = !!busy;
  btn.classList.toggle("is-busy", !!busy);
  btn.setAttribute("aria-busy", busy ? "true" : "false");
}

function syncDirty() {
  if (!editor) {
    dirty = false;
    return;
  }
  dirty = buildPersistSnapshot() !== baselineSnapshot;
}

function updateWordCount(ed) {
  const el = document.getElementById("noteRichEditorWordCount");
  if (!el) return;
  if (!ed) {
    el.textContent = "0 words";
    return;
  }
  const text = ed.getText().trim();
  const n = text.length ? text.split(/\s+/).filter(Boolean).length : 0;
  el.textContent = n === 1 ? "1 word" : `${n} words`;
}

function scheduleWordCountUpdate(ed) {
  if (wordCountRaf) cancelAnimationFrame(wordCountRaf);
  if (!ed) {
    wordCountRaf = 0;
    updateWordCount(null);
    return;
  }
  wordCountRaf = requestAnimationFrame(() => {
    wordCountRaf = 0;
    updateWordCount(ed);
  });
}

function setTitleFieldError(message) {
  const titleEl = document.getElementById("noteRichEditorTitle");
  const errEl = document.getElementById("noteRichEditorTitleError");
  const msg = message ? String(message) : "";
  if (titleEl) {
    titleEl.classList.toggle("note-rich-editor-title-input--invalid", !!msg);
    titleEl.setAttribute("aria-invalid", msg ? "true" : "false");
  }
  if (errEl) {
    errEl.textContent = msg;
    errEl.classList.toggle("hidden", !msg);
  }
}

function clearTitleFieldError() {
  setTitleFieldError("");
}

function buildPersistSnapshot() {
  if (!editor) return "";
  const storageText = encodeDocForStorage(editor.getJSON());
  const titleEl = document.getElementById("noteRichEditorTitle");
  const title = titleEl ? String(titleEl.value || "").trim() : "";
  return JSON.stringify({ storageText, title });
}

function getToolbarButtons(editorInstance) {
  /** No `.focus()` — avoids scroll + keyboard churn on mobile when tapping the bar; selection kept via pointerdown preventDefault below. */
  const chain = () => editorInstance.chain();
  const is = (name, attrs = {}) => editorInstance.isActive(name, attrs);

  const btn = (label, iconSvg, onClick, activeCheck) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-rich-toolbar-btn";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("tabindex", "-1");
    b.innerHTML = `<span class="note-rich-toolbar-icon">${iconSvg}</span>`;
    b.addEventListener(
      "pointerdown",
      (e) => {
        if (!editorInstance || editorInstance.isDestroyed) return;
        e.preventDefault();
      },
      { passive: false }
    );
    if (activeCheck) {
      const sync = () => b.classList.toggle("is-active", !!activeCheck());
      b.addEventListener("click", () => {
        onClick();
        sync();
      });
      editorInstance.on("selectionUpdate", sync);
      editorInstance.on("transaction", sync);
      sync();
    } else {
      b.addEventListener("click", onClick);
    }
    return b;
  };

  const svg = {
    bold: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z"/></svg>`,
    italic: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z"/></svg>`,
    underline: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17c3.31 0 6-2.69 6-6V3h-2.5v8c0 1.93-1.57 3.5-3.5 3.5S8.5 12.93 8.5 11V3H6v8c0 3.31 2.69 6 6 6zm-7 2v2h14v-2H5z"/></svg>`,
    strike: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7.24 8.75c-.26-.48-.39-1.03-.39-1.67 0-.61.13-1.16.4-1.67.26-.5.63-.93 1.11-1.29a5.73 5.73 0 0 1 1.7-.83c.66-.2 1.37-.3 2.11-.3.95 0 1.81.16 2.58.48.77.32 1.41.78 1.91 1.38.5.59.85 1.29 1.05 2.09h-3.64c-.11-.31-.27-.58-.48-.81s-.51-.43-.85-.55c-.34-.13-.73-.19-1.18-.19-.52 0-.97.07-1.35.21-.39.13-.71.34-.93.61-.23.29-.34.61-.34.98 0 .26.06.52.17.74.11.22.31.43.61.61l-.01-.01zm6.375 6.086c-.14-.43-.339-.836-.596-1.198a3.579 3.579 0 0 0-1.154-.864c-.499-.239-1.095-.396-1.788-.478V11h10v1.076c-.57.086-1.062.239-1.477.459-.417.217-.759.489-1.027.817-.267.331-.478.744-.627 1.242h3.097v2H11v-.93c-.001 0-.001 0-.001-.001zm-4.743-8.086c-.34-.6-.738-1.15-1.193-1.65L5 5.06c1.073 1.25 2.494 2.214 4.264 2.914h-.001z"/></svg>`,
    h2: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v3h4v13h3V7h4V4zm14 16h-3v-7h3z"/></svg>`,
    bullet: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/></svg>`,
    number: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z"/></svg>`,
    quote: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>`,
    taskList: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H8v-2h6v2zm0-4H8v-2h6v2zm0-4H8V7h6v2z"/></svg>`
  };

  const rowEl = document.createElement("div");
  rowEl.className = "note-rich-toolbar-row note-rich-toolbar-row--single";

  rowEl.appendChild(btn("Bold", svg.bold, () => chain().toggleBold().run(), () => is("bold")));
  rowEl.appendChild(btn("Italic", svg.italic, () => chain().toggleItalic().run(), () => is("italic")));
  rowEl.appendChild(btn("Underline", svg.underline, () => chain().toggleUnderline().run(), () => is("underline")));
  rowEl.appendChild(btn("Strikethrough", svg.strike, () => chain().toggleStrike().run(), () => is("strike")));
  rowEl.appendChild(
    btn("Heading", svg.h2, () => chain().toggleHeading({ level: 2 }).run(), () => is("heading", { level: 2 }))
  );
  rowEl.appendChild(btn("Bullet list", svg.bullet, () => chain().toggleBulletList().run(), () => is("bulletList")));
  rowEl.appendChild(btn("Numbered list", svg.number, () => chain().toggleOrderedList().run(), () => is("orderedList")));
  rowEl.appendChild(btn("Task list", svg.taskList, () => chain().toggleTaskList().run(), () => is("taskList")));
  rowEl.appendChild(btn("Quote", svg.quote, () => chain().toggleBlockquote().run(), () => is("blockquote")));

  const wrap = document.createElement("div");
  wrap.className = "note-rich-toolbar-inner note-rich-toolbar-inner--single-row";
  wrap.appendChild(rowEl);
  return wrap;
}

async function runPersist(opts = {}) {
  const force = !!opts.force;
  if (!editor) return;
  const persistFn = typeof window.noteRichEditorPersist === "function" ? window.noteRichEditorPersist : null;
  if (!persistFn) return;

  const snapshot = buildPersistSnapshot();
  if (force && snapshot === baselineSnapshot) {
    close();
    return;
  }

  const plainText = editor.getText().trim();
  const titleEl = document.getElementById("noteRichEditorTitle");
  const title = titleEl ? String(titleEl.value || "").trim() : "";

  clearTitleFieldError();

  if (!plainText && rootMode === "create" && !rootPersistNoteId) {
    if (typeof window.showToast === "function") {
      window.showToast(tKey("noteTextRequired", "Please enter note text."));
    }
    return;
  }

  if (!plainText && rootMode === "edit") {
    if (typeof window.showToast === "function") {
      window.showToast(tKey("noteTextRequired", "Please enter note text."));
    }
    return;
  }

  const doc = editor.getJSON();
  const storageText = encodeDocForStorage(doc);

  setSaveBusy(true);
  try {
    const result = await persistFn({
      mode: rootMode,
      origin: rootOrigin,
      presetCategory: rootPresetCategory,
      noteId: rootPersistNoteId,
      title,
      storageText,
      plainText
    });
    baselineSnapshot = buildPersistSnapshot();
    dirty = false;
    if (result && result.note && result.note._id) {
      rootPersistNoteId = String(result.note._id);
      rootMode = "edit";
    }
    if (typeof window.showToast === "function") {
      window.showToast(tKey("noteRichEditorSaved", "Saved"));
    }
    close();
  } catch (err) {
    const msg = (err && err.message) || tKey("saveFailed", "Save failed");
    if (typeof window.showToast === "function") window.showToast(msg);
  } finally {
    setSaveBusy(false);
  }
}

function wireEditorHooks(ed) {
  ed.on("update", () => {
    scheduleWordCountUpdate(ed);
    syncDirty();
  });
}

function destroyEditor() {
  if (wordCountRaf) {
    cancelAnimationFrame(wordCountRaf);
    wordCountRaf = 0;
  }
  if (editor) {
    editor.destroy();
    editor = null;
  }
  const tb = document.getElementById("noteRichEditorToolbar");
  if (tb) tb.innerHTML = "";
  baselineSnapshot = "";
  dirty = false;
  setSaveBusy(false);
  clearTitleFieldError();
  updateWordCount(null);
}

function close() {
  teardownEditorViewportLock();
  const cb = openOptions && typeof openOptions.onClosed === "function" ? openOptions.onClosed : null;
  destroyEditor();
  const screen = document.getElementById("noteRichEditorScreen");
  if (screen) {
    screen.classList.add("hidden");
    screen.setAttribute("aria-hidden", "true");
  }
  document.body.classList.remove("note-rich-editor-open");
  rootPersistNoteId = null;
  rootMode = "create";
  openOptions = {};
  if (cb) {
    try {
      cb();
    } catch (_) {}
  }
}

function open(opts = {}) {
  openOptions = opts;
  teardownEditorViewportLock();
  destroyEditor();

  rootMode = opts.mode === "edit" ? "edit" : "create";
  rootOrigin = opts.origin || "category";
  rootPresetCategory = opts.presetCategory || null;
  const note = opts.note || null;
  rootPersistNoteId = note && note._id ? String(note._id) : null;

  const screen = document.getElementById("noteRichEditorScreen");
  const titleEl = document.getElementById("noteRichEditorTitle");

  if (!screen) return;

  if (titleEl) {
    titleEl.value = note ? String(note.title || "").trim() : "";
    clearTitleFieldError();
  }

  const mount = document.getElementById("noteRichEditorMount");
  if (!mount) return;

  const placeholderFromDom =
    mount.getAttribute("data-placeholder") || "Fillon të shkruash idetë e tua…";

  const initialDoc = note ? storageToDocJSON(note.text) : { type: "doc", content: [{ type: "paragraph" }] };

  editor = new Editor({
    element: mount,
    extensions: getExtensions(placeholderFromDom),
    content: initialDoc,
    editorProps: {
      attributes: {
        class: "note-rich-editor-content ProseMirror-focused-note"
      },
      scrollMargin: { top: 0, right: 0, bottom: 0, left: 0 }
    }
  });

  baselineSnapshot = buildPersistSnapshot();
  dirty = false;

  const tbHost = document.getElementById("noteRichEditorToolbar");
  if (tbHost) {
    tbHost.innerHTML = "";
    tbHost.appendChild(getToolbarButtons(editor));
  }

  wireEditorHooks(editor);
  updateWordCount(editor);

  if (titleEl) {
    titleEl.oninput = () => {
      clearTitleFieldError();
      syncDirty();
    };
  }

  screen.classList.remove("hidden");
  screen.setAttribute("aria-hidden", "false");
  document.body.classList.add("note-rich-editor-open");

  setupEditorViewportLock(screen);
  /* Keyboard opens only after user taps title or note body — avoids jumping chrome on entry */
}

function requestClose() {
  if (dirty) {
    const ok = window.confirm(tKey("noteRichEditorUnsavedConfirm", "You have unsaved changes. Leave without saving?"));
    if (!ok) return;
  }
  close();
}

function initNoteRichEditorBridge() {
  document.getElementById("noteRichEditorBack")?.addEventListener("click", () => requestClose());

  document.getElementById("noteRichEditorSave")?.addEventListener("click", () => void runPersist({ force: true }));

  window.addEventListener("beforeunload", (e) => {
    const screen = document.getElementById("noteRichEditorScreen");
    if (!screen || screen.classList.contains("hidden")) return;
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const screen = document.getElementById("noteRichEditorScreen");
    if (!screen || screen.classList.contains("hidden")) return;
    requestClose();
  });
}

window.NoteRichEditor = {
  open,
  close,
  STORAGE_PREFIX,
  storageToDocJSON,
  encodeDocForStorage,
  storedToHtml,
  storedToPreviewText,
  getExtensions,
  initNoteRichEditorBridge
};
