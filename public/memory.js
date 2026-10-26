// The notes ("memory") system: an Obsidian-style vault of Markdown notes kept
// in IndexedDB. Notes link with [[Title]] / [[Title|alias]] and tag with #tag.
// This module owns the data: CRUD, links/backlinks, search, the tool executor
// Claude's note tools run through, and import/export.

import { getAllNotes, putNote, removeNote } from "./db.js";

const listeners = new Set();
export const onNotesChanged = (fn) => listeners.add(fn);
const changed = () => {
  cache = null;
  for (const fn of listeners) fn();
};

let cache = null;
async function allNotes() {
  cache ??= await getAllNotes();
  return cache;
}

export const normaliseTitle = (title) => String(title ?? "").replace(/\s+/g, " ").trim();
const idOf = (title) => normaliseTitle(title).toLowerCase();

const LINK_RE = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export function linksIn(content) {
  const out = new Map();
  for (const m of content.matchAll(LINK_RE)) {
    const t = normaliseTitle(m[1]);
    if (t) out.set(t.toLowerCase(), t);
  }
  return [...out.values()];
}

export function tagsIn(content) {
  return [...new Set([...content.matchAll(TAG_RE)].map((m) => m[2].toLowerCase()))];
}

// ---------- CRUD ----------

export async function listNotes() {
  return [...(await allNotes())].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getNote(title) {
  const id = idOf(title);
  return (await allNotes()).find((n) => n.id === id) ?? null;
}

export async function backlinksTo(title) {
  const id = idOf(title);
  return (await allNotes())
    .filter((n) => n.id !== id && linksIn(n.content).some((l) => l.toLowerCase() === id))
    .map((n) => n.title);
}

export async function saveNote(title, content, { createOnly = false } = {}) {
  const clean = normaliseTitle(title);
  if (!clean) throw new Error("A note needs a title.");
  if (/[\[\]|#\n]/.test(clean)) throw new Error("Titles can't contain [ ] | # or line breaks.");
  const existing = await getNote(clean);
  if (existing && createOnly) throw new Error(`A note called "${existing.title}" already exists.`);
  const now = Date.now();
  const note = {
    id: idOf(clean),
    title: existing?.title ?? clean,
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await putNote(note);
  changed();
  return note;
}

export async function deleteNote(title) {
  const note = await getNote(title);
  if (!note) throw new Error(`No note called "${title}".`);
  await removeNote(note.id);
  changed();
}

// Renames a note and rewrites [[links]] to it everywhere, keeping any
// #heading or |alias part of each link.
export async function renameNote(title, newTitle) {
  const note = await getNote(title);
  if (!note) throw new Error(`No note called "${title}".`);
  const clean = normaliseTitle(newTitle);
  if (!clean) throw new Error("The new title is empty.");
  if (/[\[\]|#\n]/.test(clean)) throw new Error("Titles can't contain [ ] | # or line breaks.");
  const clash = await getNote(clean);
  if (clash && clash.id !== note.id) throw new Error(`A note called "${clash.title}" already exists.`);

  const oldId = note.id;
  const relink = (content) =>
    content.replace(LINK_RE, (whole, target, heading = "", alias = "") =>
      normaliseTitle(target).toLowerCase() === oldId ? `[[${clean}${heading}${alias}]]` : whole,
    );
  const now = Date.now();
  const updated = [];
  for (const n of await allNotes()) {
    if (n.id === oldId) continue;
    const content = relink(n.content);
    if (content !== n.content) updated.push({ ...n, content, updatedAt: now });
  }
  await removeNote(oldId);
  await putNote({ ...note, id: idOf(clean), title: clean, content: relink(note.content), updatedAt: now });
  for (const n of updated) await putNote(n);
  changed();
  return { title: clean, linksUpdated: updated.length };
}

// ---------- Search ----------

const STOPWORDS = new Set(
  "a an and are as at be but by did do does for from had has have he her his how i if in into is it its me my of on or our she so than that the their them then there these they this to too was we were what when where which who why will with you your about any can could would should just not no yes".split(" "),
);

const tokenise = (text) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Ranks notes by keyword relevance (a BM25-style score), with title and tag
// matches weighted up. Terms match word prefixes, so "plan" finds "planning".
export async function searchNotes(query, limit = 8) {
  const notes = await allNotes();
  const terms = [...new Set(tokenise(query))];
  if (!terms.length || !notes.length) return [];

  const docs = notes.map((n) => ({ note: n, text: n.content.toLowerCase(), title: n.title.toLowerCase(), tags: tagsIn(n.content) }));
  const avgLen = docs.reduce((s, d) => s + d.text.length, 0) / docs.length || 1;
  const phrase = query.toLowerCase().trim();

  const termInfo = terms.map((term) => {
    const source = `(?<![\\p{L}\\p{N}])${escapeRe(term)}`;
    const count = new RegExp(source, "gu");
    const has = new RegExp(source, "u");
    const df = docs.filter((x) => has.test(x.text) || has.test(x.title)).length;
    return { term, count, has, idf: Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) };
  });

  const scored = docs.map((d) => {
    let score = 0;
    for (const { term, count, has, idf } of termInfo) {
      const tf = (d.text.match(count) ?? []).length;
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.text.length / avgLen))));
      if (has.test(d.title)) score += 3 * idf + 1;
      if (d.tags.some((t) => t.startsWith(term))) score += 2 * idf;
    }
    if (phrase.length > 3 && (d.title.includes(phrase) || d.text.includes(phrase))) score += 3;
    return { d, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ d }) => ({ title: d.note.title, snippet: snippet(d.note.content, terms), tags: d.tags }));
}

function snippet(content, terms, max = 280) {
  const lines = content.split("\n").filter((l) => l.trim());
  const hits = lines.filter((l) => terms.some((t) => l.toLowerCase().includes(t)));
  const picked = (hits.length ? hits : lines).slice(0, 3).join(" … ");
  return picked.length > max ? picked.slice(0, max) + "…" : picked;
}

// ---------- Claude's note tools ----------

const NOTE_READ_LIMIT = 60000;

const SCHEMAS = {
  search_notes: { query: "string", limit: "number?" },
  read_note: { title: "string" },
  list_notes: { tag: "string?" },
  create_note: { title: "string", content: "string" },
  edit_note: { title: "string", old_text: "string", new_text: "string" },
  append_to_note: { title: "string", text: "string" },
  rename_note: { title: "string", new_title: "string" },
  delete_note: { title: "string" },
};

export const isNoteTool = (name) => name in SCHEMAS;

// Inputs stream in eagerly, so a truncated or malformed input can reach us;
// check it before touching any notes.
function validate(name, input) {
  if (!input || typeof input !== "object") return "Tool input must be an object.";
  for (const [key, type] of Object.entries(SCHEMAS[name])) {
    const optional = type.endsWith("?");
    const base = type.replace("?", "");
    const value = input[key];
    if (value === undefined || value === null) {
      if (!optional) return `Missing required field "${key}".`;
      continue;
    }
    if (typeof value !== base) return `Field "${key}" must be a ${base}.`;
  }
  return null;
}

// Runs one tool call. Returns { content, is_error } for a tool_result block.
export async function runNoteTool(name, input) {
  const problem = validate(name, input);
  if (problem) return { content: problem, is_error: true };
  try {
    return { content: await TOOL_IMPL[name](input), is_error: false };
  } catch (err) {
    return { content: err.message, is_error: true };
  }
}

const TOOL_IMPL = {
  async search_notes({ query, limit = 8 }) {
    const results = await searchNotes(query, Math.max(1, Math.min(25, Math.round(limit))));
    if (!results.length) {
      const count = (await allNotes()).length;
      return count ? `No notes matched "${query}".` : "There are no notes yet.";
    }
    return results
      .map((r) => `## ${r.title}${r.tags.length ? `  (#${r.tags.join(" #")})` : ""}\n${r.snippet}`)
      .join("\n\n");
  },

  async read_note({ title }) {
    const note = await getNote(title);
    if (!note) {
      const close = await searchNotes(title, 5);
      throw new Error(
        `No note called "${title}".` + (close.length ? ` Similar titles: ${close.map((c) => `"${c.title}"`).join(", ")}.` : ""),
      );
    }
    const links = linksIn(note.content);
    const backlinks = await backlinksTo(note.title);
    let content = note.content;
    if (content.length > NOTE_READ_LIMIT) {
      content = content.slice(0, NOTE_READ_LIMIT) + `\n\n[Note truncated: showing ${NOTE_READ_LIMIT} of ${note.content.length} characters.]`;
    }
    return [
      `# ${note.title}`,
      `Last updated: ${new Date(note.updatedAt).toLocaleString("en-GB")}`,
      `Links to: ${links.length ? links.map((l) => `[[${l}]]`).join(", ") : "none"}`,
      `Linked from: ${backlinks.length ? backlinks.map((l) => `[[${l}]]`).join(", ") : "none"}`,
      "",
      content,
    ].join("\n");
  },

  async list_notes({ tag }) {
    let notes = await listNotes();
    if (tag) {
      const t = tag.replace(/^#/, "").toLowerCase();
      notes = notes.filter((n) => tagsIn(n.content).includes(t));
    }
    if (!notes.length) return tag ? `No notes tagged #${tag}.` : "There are no notes yet.";
    const shown = notes.slice(0, 500);
    const lines = shown.map((n) => `- ${n.title} (updated ${new Date(n.updatedAt).toLocaleDateString("en-GB")})`);
    if (notes.length > shown.length) lines.push(`…and ${notes.length - shown.length} more. Use search_notes to narrow down.`);
    return `${notes.length} note(s):\n${lines.join("\n")}`;
  },

  async create_note({ title, content }) {
    const note = await saveNote(title, content, { createOnly: true });
    return `Created [[${note.title}]].`;
  },

  async edit_note({ title, old_text, new_text }) {
    const note = await getNote(title);
    if (!note) throw new Error(`No note called "${title}".`);
    if (!old_text) throw new Error("old_text is empty. Use append_to_note to add text.");
    const count = note.content.split(old_text).length - 1;
    if (count === 0) throw new Error(`That text isn't in [[${note.title}]]. Read the note again and copy the text exactly.`);
    if (count > 1) throw new Error(`That text appears ${count} times in [[${note.title}]]. Include more surrounding text so it's unique.`);
    await saveNote(note.title, note.content.replace(old_text, () => new_text));
    return `Updated [[${note.title}]].`;
  },

  async append_to_note({ title, text }) {
    const note = await getNote(title);
    if (!note) {
      const created = await saveNote(title, text.trim() + "\n");
      return `Created [[${created.title}]].`;
    }
    const sep = note.content.endsWith("\n") || !note.content ? "" : "\n";
    await saveNote(note.title, `${note.content}${sep}${text.trim()}\n`);
    return `Appended to [[${note.title}]].`;
  },

  async rename_note({ title, new_title }) {
    const { title: renamed, linksUpdated } = await renameNote(title, new_title);
    return `Renamed to [[${renamed}]]; updated links in ${linksUpdated} other note(s).`;
  },

  async delete_note({ title }) {
    const note = await getNote(title);
    await deleteNote(title);
    return `Deleted "${note.title}".`;
  },
};

// ---------- Import / export ----------

// Imports .md/.txt files; the title is the filename without its extension.
export async function importFiles(files) {
  const existing = new Set((await allNotes()).map((n) => n.id));
  const incoming = [];
  for (const f of files) {
    if (!/\.(md|markdown|txt)$/i.test(f.name)) continue;
    const title = normaliseTitle(f.name.replace(/\.(md|markdown|txt)$/i, "").replace(/[\[\]|#]/g, "-"));
    if (title) incoming.push({ title, content: await f.text() });
  }
  const clashes = incoming.filter((n) => existing.has(idOf(n.title)));
  return { incoming, clashes };
}

export async function saveImported(notes) {
  for (const n of notes) await saveNote(n.title, n.content);
}

// Builds a .zip of every note as Title.md: open it in Obsidian as a vault.
export async function exportVaultZip() {
  const enc = new TextEncoder();
  const used = new Set();
  const files = (await listNotes()).map((n) => {
    let name = n.title.replace(/[\\/:*?"<>|]/g, "-");
    while (used.has(name.toLowerCase())) name += " (2)";
    used.add(name.toLowerCase());
    return { name: enc.encode(`${name}.md`), data: enc.encode(n.content), mtime: new Date(n.updatedAt) };
  });
  return new Blob([zipStore(files)], { type: "application/zip" });
}

// Minimal uncompressed ZIP writer (no dependencies).
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const crc = crc32(f.data);
    const { time, date } = dosTime(f.mtime);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, f.name.length, true);
    chunks.push(new Uint8Array(local.buffer), f.name, f.data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, f.name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), f.name);
    offset += 30 + f.name.length + f.data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)]);
}

let crcTable;
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
