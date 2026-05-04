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

function debounce(fn, ms) {
  let id;
  return function (...args) {
    clearTimeout(id);
    id = setTimeout(() => fn.apply(this, args), ms);
  };
}

let editor = null;
let rootPersistNoteId = null;
let rootMode = "create";
let rootOrigin = "category";
let rootPresetCategory = null;
let saveTimer = null;
let lastSnapshot = "";
let openOptions = {};

const CATEGORY_ICONS = {
  shtepia: "🏠",
  puna: "💼",
  shkolla: "🎓",
  scan_cam: "📷"
};

function getNoteRichEditorTags() {
  const root = document.getElementById("noteRichEditorTagsChips");
  if (!root) return [];
  return Array.from(root.querySelectorAll(".note-rich-tag-chip[data-tag]"))
    .map((c) => String(c.getAttribute("data-tag") || "").trim())
    .filter(Boolean);
}

function clearNoteRichEditorTagChips() {
  const root = document.getElementById("noteRichEditorTagsChips");
  if (!root) return;
  root.querySelectorAll(".note-rich-tag-chip").forEach((n) => n.remove());
}

function addNoteRichEditorTagChip(text) {
  const raw = String(text || "").trim();
  if (!raw) return;
  const root = document.getElementById("noteRichEditorTagsChips");
  const input = document.getElementById("noteRichEditorTagInput");
  if (!root || !input) return;
  const exists = Array.from(root.querySelectorAll(".note-rich-tag-chip[data-tag]")).some(
    (c) => String(c.getAttribute("data-tag") || "").toLowerCase() === raw.toLowerCase()
  );
  if (exists) return;
  const chip = document.createElement("span");
  chip.className = "note-rich-tag-chip";
  chip.setAttribute("data-tag", raw);
  chip.innerHTML = `<span class="note-rich-tag-text">${escapeHtml(raw)}</span><button type="button" class="note-rich-tag-remove" aria-label="Remove tag">×</button>`;
  root.insertBefore(chip, input);
  const rm = chip.querySelector(".note-rich-tag-remove");
  if (rm) {
    rm.addEventListener("click", () => {
      chip.remove();
      schedulePersist();
    });
  }
}

function setNoteRichEditorTags(tags) {
  clearNoteRichEditorTagChips();
  const list = Array.isArray(tags) ? tags : [];
  list.forEach((t) => addNoteRichEditorTagChip(String(t)));
}

function syncCategoryIcon() {
  const sel = document.getElementById("noteRichEditorCategory");
  const icon = document.getElementById("noteRichEditorCategoryIcon");
  if (!sel || !icon) return;
  const key = String(sel.value || "");
  icon.textContent = CATEGORY_ICONS[key] || "📁";
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
  const tags = getNoteRichEditorTags()
    .slice()
    .sort((a, b) => a.localeCompare(b));
  return JSON.stringify({ storageText, title, tags });
}

function setStatus(kind, message) {
  const el = document.getElementById("noteRichEditorStatus");
  if (!el) return;
  el.classList.remove("note-rich-editor-status--ok", "note-rich-editor-status--err", "note-rich-editor-status--saving");
  if (kind === "saving") {
    el.classList.add("note-rich-editor-status--saving");
    el.textContent = message || "Saving…";
  } else if (kind === "ok") {
    el.classList.add("note-rich-editor-status--ok");
    el.textContent = message || "Saved ✓";
  } else if (kind === "err") {
    el.classList.add("note-rich-editor-status--err");
    el.textContent = message || "Save failed";
  } else {
    el.textContent = "";
  }
}

function getToolbarButtons(editorInstance) {
  const chain = () => editorInstance.chain().focus();
  const is = (name, attrs = {}) => editorInstance.isActive(name, attrs);

  const btn = (label, iconSvg, onClick, activeCheck) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-rich-toolbar-btn";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = `<span class="note-rich-toolbar-icon">${iconSvg}</span>`;
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
    h1: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v3h5.5v12h3V7H19V4z"/></svg>`,
    h2: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v3h4v13h3V7h4V4zm14 16h-3v-7h3z"/></svg>`,
    h3: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v3h4v13h3V7h4V4zm14 18l-4-7 4-7h-3l-2.5 4.5L12 4h-3l4 7-4 7h3l2.5-4.5L16 22z"/></svg>`,
    bullet: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/></svg>`,
    number: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z"/></svg>`,
    quote: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>`,
    code: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`,
    link: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>`,
    image: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`,
    check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>`,
    emoji: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`
  };

  const rowEl = () => {
    const r = document.createElement("div");
    r.className = "note-rich-toolbar-row";
    return r;
  };

  const row1 = rowEl();
  const row2 = rowEl();

  row1.appendChild(btn("Bold", svg.bold, () => chain().toggleBold().run(), () => is("bold")));
  row1.appendChild(btn("Italic", svg.italic, () => chain().toggleItalic().run(), () => is("italic")));
  row1.appendChild(btn("Underline", svg.underline, () => chain().toggleUnderline().run(), () => is("underline")));
  row1.appendChild(
    btn("Heading 1", svg.h1, () => chain().toggleHeading({ level: 1 }).run(), () => is("heading", { level: 1 }))
  );
  row1.appendChild(
    btn("Heading 2", svg.h2, () => chain().toggleHeading({ level: 2 }).run(), () => is("heading", { level: 2 }))
  );
  row1.appendChild(
    btn("Heading 3", svg.h3, () => chain().toggleHeading({ level: 3 }).run(), () => is("heading", { level: 3 }))
  );
  row1.appendChild(btn("Bullet list", svg.bullet, () => chain().toggleBulletList().run(), () => is("bulletList")));
  row1.appendChild(btn("Numbered list", svg.number, () => chain().toggleOrderedList().run(), () => is("orderedList")));
  row1.appendChild(btn("Task list", svg.check, () => chain().toggleTaskList().run(), () => is("taskList")));

  row2.appendChild(btn("Quote", svg.quote, () => chain().toggleBlockquote().run(), () => is("blockquote")));
  row2.appendChild(btn("Code block", svg.code, () => chain().toggleCodeBlock().run(), () => is("codeBlock")));
  row2.appendChild(
    btn("Link", svg.link, () => {
      const prev = editorInstance.getAttributes("link").href;
      const url = window.prompt("Link URL", prev || "https://");
      if (url === null) return;
      if (url === "") {
        chain().unsetLink().run();
        return;
      }
      chain().extendMarkRange("link").setLink({ href: url }).run();
    })
  );
  row2.appendChild(
    btn("Image", svg.image, () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        document.body.removeChild(input);
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const src = e.target && e.target.result;
          if (typeof src === "string") {
            chain().setImage({ src }).run();
          }
        };
        reader.readAsDataURL(file);
      });
      input.click();
    })
  );
  row2.appendChild(
    btn("Insert emoji", svg.emoji, () => {
      const c = window.prompt("Emoji", "✨");
      if (c == null) return;
      const t = String(c).trim();
      if (t) chain().insertContent(t).run();
    })
  );

  const wrap = document.createElement("div");
  wrap.className = "note-rich-toolbar-rows";
  wrap.appendChild(row1);
  wrap.appendChild(row2);
  return wrap;
}

async function runPersist() {
  if (!editor) return;
  const persistFn = typeof window.noteRichEditorPersist === "function" ? window.noteRichEditorPersist : null;
  if (!persistFn) return;

  const snapshot = buildPersistSnapshot();
  if (snapshot === lastSnapshot && rootMode === "edit") {
    return;
  }

  const plainText = editor.getText().trim();
  const titleEl = document.getElementById("noteRichEditorTitle");
  const title = titleEl ? String(titleEl.value || "").trim() : "";
  const tags = getNoteRichEditorTags();

  if (!title) {
    setTitleFieldError("Title is required");
    setStatus("", "");
    return;
  }
  clearTitleFieldError();

  if (!plainText && rootMode === "create" && !rootPersistNoteId) {
    return;
  }

  if (!plainText && rootMode === "edit") {
    setStatus("err", "Note body cannot be empty");
    return;
  }

  const doc = editor.getJSON();
  const storageText = encodeDocForStorage(doc);

  setStatus("saving", "Saving…");
  try {
    const result = await persistFn({
      mode: rootMode,
      origin: rootOrigin,
      presetCategory: rootPresetCategory,
      noteId: rootPersistNoteId,
      title,
      storageText,
      plainText,
      tags
    });
    lastSnapshot = buildPersistSnapshot();
    if (result && result.note && result.note._id) {
      rootPersistNoteId = String(result.note._id);
      rootMode = "edit";
    }
    setStatus("ok", "Saved ✓");
  } catch (err) {
    const msg = (err && err.message) || "Save failed";
    setStatus("err", msg);
  }
}

const schedulePersist = debounce(() => {
  void runPersist();
}, 2000);

function wireEditorHooks(ed) {
  ed.on("update", () => {
    updateWordCount(ed);
    schedulePersist();
  });
}

function destroyEditor() {
  if (editor) {
    editor.destroy();
    editor = null;
  }
  const tb = document.getElementById("noteRichEditorToolbar");
  if (tb) tb.innerHTML = "";
  saveTimer = null;
  lastSnapshot = "";
  clearNoteRichEditorTagChips();
  clearTitleFieldError();
  updateWordCount(null);
}

function close() {
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
  setStatus("", "");
  if (cb) {
    try {
      cb();
    } catch (_) {}
  }
}

function open(opts = {}) {
  openOptions = opts;
  destroyEditor();

  rootMode = opts.mode === "edit" ? "edit" : "create";
  rootOrigin = opts.origin || "category";
  rootPresetCategory = opts.presetCategory || null;
  const note = opts.note || null;
  rootPersistNoteId = note && note._id ? String(note._id) : null;

  const screen = document.getElementById("noteRichEditorScreen");
  const titleEl = document.getElementById("noteRichEditorTitle");
  const catRow = document.getElementById("noteRichEditorCategoryRow");
  const catSelect = document.getElementById("noteRichEditorCategory");

  if (!screen) return;

  if (titleEl) {
    titleEl.value = note ? String(note.title || "").trim() : "";
    clearTitleFieldError();
  }

  if (note && Array.isArray(note.tags)) {
    setNoteRichEditorTags(note.tags);
  } else {
    clearNoteRichEditorTagChips();
  }

  if (catRow && catSelect) {
    catSelect.innerHTML = "";
    const cats = opts.categories || {};
    Object.keys(cats).forEach((key) => {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = cats[key];
      catSelect.appendChild(o);
    });
    const showCat =
      rootMode === "create" &&
      rootOrigin === "all";
    catRow.classList.toggle("hidden", !showCat);
    if (showCat && rootOrigin === "all" && catSelect.options.length) {
      catSelect.value = catSelect.options[0].value;
    }
    if (rootMode === "create" && rootOrigin === "home" && rootPresetCategory) {
      catSelect.value = rootPresetCategory;
    }
    syncCategoryIcon();
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
      }
    }
  });

  lastSnapshot = note ? buildPersistSnapshot() : "";

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
      schedulePersist();
    };
  }
  if (catSelect) {
    catSelect.onchange = () => {
      syncCategoryIcon();
      schedulePersist();
    };
  }

  const tagInput = document.getElementById("noteRichEditorTagInput");
  if (tagInput) {
    tagInput.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = String(tagInput.value || "").trim();
      if (!v) return;
      addNoteRichEditorTagChip(v);
      tagInput.value = "";
      schedulePersist();
    };
    tagInput.oninput = () => {};
  }

  screen.classList.remove("hidden");
  screen.setAttribute("aria-hidden", "false");
  document.body.classList.add("note-rich-editor-open");

  setStatus("", "");

  window.setTimeout(() => editor.commands.focus("end"), 50);
}

function initNoteRichEditorBridge() {
  document.getElementById("noteRichEditorBack")?.addEventListener("click", () => {
    void runPersist().finally(() => close());
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const screen = document.getElementById("noteRichEditorScreen");
    if (!screen || screen.classList.contains("hidden")) return;
    void runPersist().finally(() => close());
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
