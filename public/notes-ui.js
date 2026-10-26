// The Notes tab in the sidebar and the note reader/editor in the main pane.

import { renderMarkdown, setNoteResolver } from "./markdown.js";
import {
  listNotes, getNote, saveNote, deleteNote, renameNote, backlinksTo, searchNotes, tagsIn,
  onNotesChanged, importFiles, saveImported, exportVaultZip, normaliseTitle,
} from "./memory.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  tabs: document.querySelectorAll(".tabs button"),
  chatsPanel: $("#chats-panel"),
  notesPanel: $("#notes-panel"),
  list: $("#note-list"),
  search: $("#note-search"),
  fileInput: $("#note-file-input"),
  messages: $("#messages"),
  composer: $("#composer"),
  view: $("#note-view"),
  read: $("#note-read"),
  body: $("#note-body"),
  meta: $("#note-meta"),
  backlinks: $("#note-backlinks"),
  editor: $("#note-editor"),
  titleInput: $("#note-title-input"),
  contentInput: $("#note-content-input"),
  error: $("#note-error"),
  header: $("#chat-title"),
};

let openTitle = null; // note shown in the main pane, or null when in chat view
let editingTitle = null; // title being edited, or "" for a brand-new note
let knownIds = new Set();
let onShowChat = () => {};

setNoteResolver((title) => knownIds.has(normaliseTitle(title).toLowerCase()));

export function initNotesUI({ showChat }) {
  onShowChat = showChat;
  for (const tab of els.tabs) tab.onclick = () => selectTab(tab.dataset.tab);

  // Clicking any [[link]], anywhere in the app, opens that note.
  document.addEventListener("click", (e) => {
    const link = e.target.closest?.("a.wikilink");
    if (!link) return;
    e.preventDefault();
    openNote(link.dataset.note);
  });

  $("#new-note").onclick = () => startEditing("");
  $("#import-notes").onclick = () => els.fileInput.click();
  els.fileInput.onchange = async () => {
    await importNotes([...els.fileInput.files]);
    els.fileInput.value = "";
  };
  $("#export-notes").onclick = exportNotes;
  els.search.oninput = renderList;

  $("#note-edit").onclick = () => startEditing(openTitle);
  $("#note-delete").onclick = async () => {
    if (!openTitle || !confirm(`Delete the note "${openTitle}"? This can't be undone.`)) return;
    await deleteNote(openTitle);
    showChat();
  };
  $("#note-cancel").onclick = () => (editingTitle ? openNote(editingTitle) : openTitle ? openNote(openTitle) : showChat());
  els.editor.onsubmit = saveEditor;

  onNotesChanged(async () => {
    await refreshKnown();
    renderList();
    // Claude may have just edited the note on screen; show the new version.
    if (openTitle && editingTitle === null) {
      const note = await getNote(openTitle);
      if (note) renderNote(note);
    }
  });
  refreshKnown().then(renderList);
}

function selectTab(name) {
  for (const t of els.tabs) t.classList.toggle("active", t.dataset.tab === name);
  els.chatsPanel.hidden = name !== "chats";
  els.notesPanel.hidden = name !== "notes";
  if (name === "notes") renderList();
}

async function refreshKnown() {
  knownIds = new Set((await listNotes()).map((n) => n.id));
}

async function renderList() {
  const q = els.search.value.trim();
  const items = q
    ? (await searchNotes(q, 50)).map((r) => ({ title: r.title, sub: r.snippet }))
    : (await listNotes()).map((n) => ({ title: n.title, sub: firstLine(n.content) }));
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = q ? "No matches." : "No notes yet. Create one, upload some, or ask the assistant to remember something.";
    els.list.replaceChildren(empty);
    return;
  }
  els.list.replaceChildren(
    ...items.map(({ title, sub }) => {
      const row = document.createElement("div");
      row.className = "note-row" + (title.toLowerCase() === openTitle?.toLowerCase() ? " active" : "");
      const strong = document.createElement("strong");
      strong.textContent = title;
      const small = document.createElement("small");
      small.textContent = sub || " ";
      row.append(strong, small);
      row.onclick = () => openNote(title);
      return row;
    }),
  );
}

const firstLine = (content) => content.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";

// ---------- Main pane ----------

function showNotePane() {
  els.messages.hidden = true;
  els.composer.hidden = true;
  els.view.hidden = false;
  document.body.classList.remove("sidebar-open");
}

// Called by app.js whenever a chat is opened.
export function hideNotePane() {
  openTitle = null;
  editingTitle = null;
  els.view.hidden = true;
  els.messages.hidden = false;
  els.composer.hidden = false;
  renderList();
}

export async function openNote(title) {
  const note = await getNote(title);
  if (!note) {
    // A [[link]] to a note that doesn't exist yet: start it, Obsidian-style.
    startEditing("", normaliseTitle(title));
    return;
  }
  selectTab("notes");
  editingTitle = null;
  openTitle = note.title;
  renderNote(note);
  showNotePane();
  renderList();
}

async function renderNote(note) {
  els.header.textContent = note.title;
  els.editor.hidden = true;
  els.read.hidden = false;
  const tags = tagsIn(note.content);
  els.meta.textContent = `Updated ${new Date(note.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` +
    (tags.length ? ` · #${tags.join(" #")}` : "");
  els.body.replaceChildren(note.content.trim() ? renderMarkdown(note.content) : emptyNote());

  const backlinks = await backlinksTo(note.title);
  els.backlinks.replaceChildren();
  if (backlinks.length) {
    const ul = document.createElement("ul");
    for (const t of backlinks) {
      const li = document.createElement("li");
      li.append(renderMarkdown(`[[${t}]]`).firstChild.firstChild);
      ul.append(li);
    }
    els.backlinks.append(`Linked from ${backlinks.length} note${backlinks.length === 1 ? "" : "s"}`, ul);
  }
}

function emptyNote() {
  const p = document.createElement("p");
  p.className = "empty-list";
  p.textContent = "This note is empty.";
  return p;
}

async function startEditing(title, newTitle = "") {
  selectTab("notes");
  const note = title ? await getNote(title) : null;
  editingTitle = note?.title ?? "";
  openTitle = note?.title ?? null;
  els.header.textContent = note ? `Editing: ${note.title}` : "New note";
  els.titleInput.value = note?.title ?? newTitle;
  els.contentInput.value = note?.content ?? "";
  els.error.textContent = "";
  els.read.hidden = true;
  els.editor.hidden = false;
  showNotePane();
  (note || newTitle ? els.contentInput : els.titleInput).focus();
}

async function saveEditor(e) {
  e.preventDefault();
  const title = normaliseTitle(els.titleInput.value);
  const content = els.contentInput.value;
  try {
    if (!editingTitle) {
      await saveNote(title, content, { createOnly: true });
    } else {
      let current = editingTitle;
      if (title !== editingTitle) {
        current = (await renameNote(editingTitle, title)).title;
      }
      await saveNote(current, content);
    }
    editingTitle = null;
    await openNote(title);
  } catch (err) {
    els.error.textContent = err.message;
  }
}

// ---------- Import / export ----------

async function importNotes(files) {
  const { incoming, clashes } = await importFiles(files);
  if (!incoming.length) return alert("No Markdown (.md) or text files in that selection.");
  let toSave = incoming;
  if (clashes.length) {
    const names = clashes.slice(0, 8).map((c) => `• ${c.title}`).join("\n") + (clashes.length > 8 ? `\n…and ${clashes.length - 8} more` : "");
    const overwrite = confirm(`${clashes.length} of these already exist:\n${names}\n\nOK to overwrite them, Cancel to skip them.`);
    if (!overwrite) {
      const skip = new Set(clashes.map((c) => c.title.toLowerCase()));
      toSave = incoming.filter((n) => !skip.has(n.title.toLowerCase()));
    }
  }
  await saveImported(toSave);
  selectTab("notes");
  alert(`Imported ${toSave.length} note${toSave.length === 1 ? "" : "s"}.`);
}

async function exportNotes() {
  const notes = await listNotes();
  if (!notes.length) return alert("There are no notes to export yet.");
  const blob = await exportVaultZip();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `jarvis-notes-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
