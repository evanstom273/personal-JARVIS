import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";
import {
  listConversations, getConversation, saveConversation, deleteConversation,
  getSetting, setSetting, deleteSetting,
} from "./db.js";
import { Recorder, Speaker } from "./voice.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  list: $("#conversation-list"),
  messages: $("#messages"),
  empty: $("#empty-state"),
  title: $("#chat-title"),
  form: $("#composer"),
  input: $("#input"),
  send: $("#send"),
  mic: $("#mic"),
  attach: $("#attach"),
  fileInput: $("#file-input"),
  tray: $("#attachment-tray"),
  stopSpeaking: $("#stop-speaking"),
  keyDialog: $("#key-dialog"),
  settings: $("#settings"),
};

// ---------- Settings & API key ----------

const DEFAULT_SETTINGS = {
  sttEngine: "cloud",
  autoSendVoice: true,
  autoSpeak: "voice",
  ttsEngine: "browser",
  browserVoice: "",
  cloudVoice: "pandora",
};
const AURA_VOICES = [
  "pandora", "draco", "amalthea", "andromeda", "apollo", "arcas", "aries", "asteria", "athena",
  "atlas", "aurora", "callista", "cora", "cordelia", "delia", "electra", "harmonia", "helena",
  "hera", "hermes", "hyperion", "iris", "janus", "juno", "jupiter", "luna", "mars", "minerva",
  "neptune", "odysseus", "ophelia", "orion", "orpheus", "phoebe", "pluto", "saturn", "thalia",
  "theia", "vesta", "zeus",
];

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode etc. - settings just won't persist
    }
  },
};

let settings = { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
// Your Claude API key lives only in this browser (IndexedDB) and is sent with
// each chat request; the Worker never stores it.
let apiKey = "";

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...opts.headers, "X-Api-Key": apiKey },
  });
  if (res.status === 401) showKeyDialog("Add your Claude API key to start chatting.");
  return res;
}

function showKeyDialog(message = "") {
  $("#key-error").textContent = message;
  $("#key-input").value = apiKey;
  if (!els.keyDialog.open) els.keyDialog.showModal();
  $("#key-input").focus();
}

$("#key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("#key-input").value.trim();
  if (!key.startsWith("sk-ant-")) {
    $("#key-error").textContent = "That doesn't look like a Claude API key (they start with sk-ant-).";
    return;
  }
  apiKey = key;
  await setSetting("apiKey", key);
  els.keyDialog.close();
});
$("#key-cancel").onclick = () => els.keyDialog.close();

// ---------- Conversations ----------

let current = null; // the open conversation record
let streaming = null; // AbortController while a reply is streaming

function newConversation() {
  return { id: crypto.randomUUID(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

async function renderSidebar() {
  const convs = await listConversations();
  els.list.replaceChildren(
    ...convs.map((c) => {
      const row = document.createElement("div");
      row.className = "conv" + (c.id === current?.id ? " active" : "");
      const title = document.createElement("span");
      title.textContent = c.title;
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Delete";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${c.title}"?`)) return;
        await deleteConversation(c.id);
        if (current?.id === c.id) openConversation(null);
        renderSidebar();
      };
      row.onclick = () => openConversation(c.id);
      row.append(title, del);
      return row;
    }),
  );
}

async function openConversation(id) {
  if (streaming) return;
  current = id ? await getConversation(id) : null;
  document.body.classList.remove("sidebar-open");
  renderMessages();
  renderSidebar();
}

$("#new-chat").onclick = () => {
  openConversation(null);
  els.input.focus();
};
$("#toggle-sidebar").onclick = () => document.body.classList.toggle("sidebar-open");
$("#scrim").onclick = () => document.body.classList.remove("sidebar-open");

// ---------- Rendering ----------

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(md) {
  const html = DOMPurify.sanitize(marked.parse(md));
  const div = document.createElement("div");
  div.className = "markdown";
  div.innerHTML = html;
  for (const a of div.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return div;
}

// Consecutive assistant messages (pause_turn continuations) render as one bubble.
function groupMessages(messages) {
  const groups = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (m.role === "assistant" && last?.role === "assistant") last.items.push(m);
    else groups.push({ role: m.role, items: [m] });
  }
  return groups;
}

function renderMessages() {
  els.title.textContent = current?.title ?? "JARVIS";
  const nodes = [];
  for (const g of groupMessages(current?.messages ?? [])) {
    nodes.push(g.role === "user" ? userNode(g.items) : assistantNode(g.items.flatMap((m) => m.content)));
  }
  els.empty.classList.toggle("hidden", nodes.length > 0);
  els.messages.replaceChildren(els.empty, ...nodes);
  scrollToBottom(true);
}

function userNode(items) {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  for (const m of items) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    const attachments = document.createElement("div");
    attachments.className = "attachments";
    for (const b of blocks) {
      if (b.type === "image" && b.source?.type === "base64") {
        const img = document.createElement("img");
        img.src = `data:${b.source.media_type};base64,${b.source.data}`;
        img.alt = "attached image";
        attachments.append(img);
      } else if (b.type === "document") {
        attachments.append(chip(`📄 ${b.title || "document"}`));
      }
    }
    if (attachments.children.length) wrap.append(attachments);
    const text = m.display?.text ?? blocks.filter((b) => b.type === "text" && !b.text.startsWith("[Sent:")).map((b) => b.text).join("\n");
    if (text) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text;
      wrap.append(bubble);
    }
  }
  return wrap;
}

// Builds the bubble for a finished reply from stored API content blocks.
function assistantNode(blocks) {
  const view = createAssistantView();
  const sources = [];
  let md = "";
  for (const b of blocks) {
    if (b.type === "text") {
      md += b.text;
      for (const c of b.citations ?? []) {
        if (!c.url) continue;
        let n = sources.findIndex((s) => s.url === c.url) + 1;
        if (!n) n = sources.push({ url: c.url, title: c.title || c.url });
        md += ` [${n}](<${c.url}> "${(c.title || "").replace(/["<>]/g, "'")}")`;
      }
    } else if (b.type === "server_tool_use") {
      view.addTool(b.name, b.input);
    }
  }
  view.setText(md, { final: true });
  view.setSources(sources);
  view.finish(md);
  return view.node;
}

function chip(text, href) {
  const el = document.createElement("span");
  el.className = "chip";
  if (href) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    el.append(a);
  } else {
    el.textContent = text;
  }
  return el;
}

function createAssistantView() {
  const node = document.createElement("div");
  node.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const status = document.createElement("div");
  status.className = "status";
  const body = document.createElement("div");
  body.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  const sourcesEl = document.createElement("div");
  bubble.append(status, body, sourcesEl);
  node.append(bubble);

  // Highlight citation markers ("[1]" links) once rendered.
  const markCites = (root) => {
    for (const a of root.querySelectorAll("a")) if (/^\d+$/.test(a.textContent)) a.classList.add("cite");
  };

  return {
    node,
    addTool(name, input) {
      if (name === "web_search") status.append(chip(`🔍 ${input?.query ?? "Searching the web"}`));
      else if (name === "web_fetch") status.append(chip(`🌐 ${input?.url ?? "Reading a page"}`, input?.url));
      else status.append(chip(`⚙️ ${name}`));
    },
    setText(md, { final = false } = {}) {
      if (!md && !final) return;
      const rendered = renderMarkdown(md);
      markCites(rendered);
      body.replaceChildren(rendered);
    },
    setSources(list) {
      sourcesEl.replaceChildren();
      if (!list.length) return;
      sourcesEl.className = "sources";
      const ol = document.createElement("ol");
      for (const s of list) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = s.title;
        li.append(a);
        ol.append(li);
      }
      sourcesEl.append("Sources", ol);
    },
    notice(text, isError = false) {
      const p = document.createElement("p");
      p.className = "notice" + (isError ? " error" : "");
      p.textContent = text;
      bubble.append(p);
    },
    finish(md) {
      if (!md) return;
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.onclick = async () => {
        await navigator.clipboard.writeText(md.replace(/ \[\d+\]\(<[^>]*>[^)]*\)/g, ""));
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      };
      const speak = document.createElement("button");
      speak.textContent = "Read aloud";
      speak.onclick = () => speakText(md);
      actions.append(copy, speak);
      node.append(actions);
    },
  };
}

function scrollToBottom(force = false) {
  const m = els.messages;
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 160;
  if (force || nearBottom) m.scrollTop = m.scrollHeight;
}

// ---------- Attachments ----------

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|ya?ml|toml|ini|cfg|conf|log|srt|vtt|tex|rtf|gd|lua|swift|dart|vue|svelte)$/i;
const MAX_IMAGE_EDGE = 1568; // larger images are downscaled by the API anyway
let pending = []; // [{ id, name, block, preview? }]

async function addFiles(files) {
  for (const file of files) {
    try {
      const item = await fileToAttachment(file);
      pending.push({ id: crypto.randomUUID(), ...item });
    } catch (err) {
      alert(err.message);
    }
  }
  renderTray();
}

async function fileToAttachment(file) {
  const name = file.name || "pasted file";
  if (IMAGE_TYPES.includes(file.type)) {
    const { mediaType, data } = await prepareImage(file);
    return {
      name,
      preview: `data:${mediaType};base64,${data}`,
      block: { type: "image", source: { type: "base64", media_type: mediaType, data } },
    };
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(name)) {
    return {
      name,
      block: { type: "document", title: name, source: { type: "base64", media_type: "application/pdf", data: await toBase64(file) } },
    };
  }
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.test(name) || file.type === "application/json") {
    return {
      name,
      block: { type: "document", title: name, source: { type: "text", media_type: "text/plain", data: await file.text() } },
    };
  }
  throw new Error(`Can't read "${name}" yet. Images (JPEG/PNG/GIF/WebP), PDFs and text/code files work. For Word or Excel files, export to PDF or CSV first.`);
}

async function prepareImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  const tooBig = bitmap && Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_EDGE;
  // GIFs are kept as-is so animation frames aren't flattened by re-encoding.
  if (!bitmap || file.type === "image/gif" || (!tooBig && file.size < 3.5e6)) {
    bitmap?.close();
    return { mediaType: file.type, data: await toBase64(file) };
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  const keepAlpha = file.type === "image/png" || file.type === "image/webp";
  if (!keepAlpha) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const mediaType = keepAlpha ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(mediaType, 0.9);
  return { mediaType, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.slice(r.result.indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function renderTray() {
  els.tray.replaceChildren(
    ...pending.map((p) => {
      const wrap = document.createElement("div");
      wrap.className = "pending";
      if (p.preview) {
        const img = document.createElement("img");
        img.src = p.preview;
        img.alt = p.name;
        wrap.append(img);
      } else {
        wrap.append(chip(`📄 ${p.name}`));
      }
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = "Remove";
      x.onclick = () => {
        pending = pending.filter((q) => q.id !== p.id);
        renderTray();
      };
      wrap.append(x);
      return wrap;
    }),
  );
  updateSendState();
}

els.attach.onclick = () => els.fileInput.click();
els.fileInput.onchange = () => {
  addFiles([...els.fileInput.files]);
  els.fileInput.value = "";
};
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// ---------- Sending & streaming ----------

function sentStamp() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = now.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });
  return `[Sent: ${when}, ${tz}]`;
}

// Strip UI-only fields before sending to the API.
const apiMessages = (conv) => conv.messages.map(({ role, content }) => ({ role, content }));

async function send({ viaVoice = false } = {}) {
  const text = els.input.value.trim();
  if (streaming || (!text && !pending.length)) return;
  if (!apiKey) return showKeyDialog("Add your Claude API key to start chatting.");

  // The timestamp is stored as part of the message (not injected server-side)
  // so the history we send back is always byte-identical to what Claude saw.
  const content = [{ type: "text", text: sentStamp() }, ...pending.map((p) => p.block)];
  if (text) content.push({ type: "text", text });

  if (!current) current = newConversation();
  if (current.messages.length === 0) {
    current.title = (text || pending[0]?.name || "New chat").slice(0, 60);
  }
  current.messages.push({ role: "user", content, display: { text } });
  current.updatedAt = Date.now();
  await saveConversation(current);

  els.input.value = "";
  autoGrow();
  pending = [];
  renderTray();
  renderMessages();
  renderSidebar();

  await streamReply(current, { speakAfter: settings.autoSpeak === "always" || (viaVoice && settings.autoSpeak === "voice") });
}

async function streamReply(conv, { speakAfter }) {
  const view = createAssistantView();
  els.messages.append(view.node);
  scrollToBottom(true);

  streaming = new AbortController();
  updateSendState();

  let liveText = "";
  let renderQueued = false;
  const sources = [];
  let gotMessage = false;
  let stopReason = null;
  let errorText = null;

  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      view.setText(liveText);
      scrollToBottom();
    });
  };

  try {
    const res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: apiMessages(conv) }),
      signal: streaming.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error ${res.status}`);
    }

    for await (const event of readEvents(res.body)) {
      switch (event.type) {
        case "text":
          liveText += event.text;
          queueRender();
          break;
        case "tool":
          view.addTool(event.name, event.input);
          scrollToBottom();
          break;
        case "sources":
          for (const s of event.results) if (!sources.some((x) => x.url === s.url)) sources.push(s);
          break;
        case "tool_error":
          view.notice(`Tool problem: ${event.code.replace(/_/g, " ")}`);
          break;
        case "message":
          gotMessage = true;
          conv.messages.push({ role: "assistant", content: event.content });
          conv.updatedAt = Date.now();
          await saveConversation(conv);
          break;
        case "done":
          stopReason = event.stop_reason;
          break;
        case "error":
          errorText = event.message;
          break;
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") errorText = err.message;
  } finally {
    streaming = null;
    updateSendState();
  }

  // Swap the live bubble for one rendered from the saved content, which has
  // proper citation markers. Keep it if nothing was saved (error/abort).
  if (gotMessage && current?.id === conv.id) {
    const lastUser = conv.messages.findLastIndex((m) => m.role === "user");
    const finalNode = assistantNode(conv.messages.slice(lastUser + 1).flatMap((m) => m.content));
    view.node.replaceWith(finalNode);
    addNotices(finalNode, stopReason, errorText);
  } else {
    if (!liveText) view.setText("", { final: true });
    if (sources.length) view.setSources(sources);
    addNotices(view.node, stopReason, errorText ?? (liveText ? "Stopped." : null));
  }
  scrollToBottom();
  renderSidebar();

  if (speakAfter && gotMessage && stopReason !== "refusal") {
    const lastUser = conv.messages.findLastIndex((m) => m.role === "user");
    const replyText = conv.messages
      .slice(lastUser + 1)
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    speakText(replyText);
  }
}

function addNotices(node, stopReason, errorText) {
  const bubble = node.querySelector(".bubble");
  const add = (text, isError) => {
    const p = document.createElement("p");
    p.className = "notice" + (isError ? " error" : "");
    p.textContent = text;
    bubble.append(p);
  };
  if (stopReason === "refusal") add("Claude declined to continue with this one.");
  if (stopReason === "max_tokens") add("Reply hit the length limit and was cut off.");
  if (stopReason === "pause_turn") add("Paused after a lot of tool use. Send “carry on” to continue.");
  if (errorText) add(errorText, true);
}

async function* readEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6));
    }
  }
}

function updateSendState() {
  const busy = Boolean(streaming);
  els.send.classList.toggle("streaming", busy);
  els.send.setAttribute("aria-label", busy ? "Stop" : "Send");
  els.send.disabled = !busy && !els.input.value.trim() && !pending.length;
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (streaming) streaming.abort();
  else send();
});

const isTouch = matchMedia("(pointer: coarse)").matches;
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = els.input.scrollHeight + "px";
}
els.input.addEventListener("input", () => {
  autoGrow();
  updateSendState();
});

// ---------- Voice ----------

const speaker = new Speaker({ apiFetch });

async function speakText(md) {
  els.stopSpeaking.classList.remove("hidden");
  try {
    await speaker.speak(md, {
      engine: settings.ttsEngine,
      voice: settings.ttsEngine === "cloud" ? settings.cloudVoice : settings.browserVoice,
    });
  } catch (err) {
    alert(`Couldn't speak: ${err.message}`);
  } finally {
    els.stopSpeaking.classList.add("hidden");
  }
}
els.stopSpeaking.onclick = () => {
  speaker.stop();
  els.stopSpeaking.classList.add("hidden");
};

const recorder = new Recorder({
  engine: settings.sttEngine,
  apiFetch,
  onState: (state) => {
    els.mic.classList.toggle("recording", state === "recording");
    els.mic.classList.toggle("transcribing", state === "transcribing");
  },
});

els.mic.onclick = async () => {
  if (recorder.active) return recorder.stop();
  speaker.stop();
  recorder.engine = settings.sttEngine;
  try {
    const text = await recorder.start();
    if (!text) return;
    els.input.value = els.input.value ? `${els.input.value} ${text}` : text;
    autoGrow();
    updateSendState();
    if (settings.autoSendVoice) send({ viaVoice: true });
    else els.input.focus();
  } catch (err) {
    alert(`Voice input failed: ${err.message}`);
  }
};

// ---------- Settings dialog ----------

const sform = $("#settings-form");

function fillVoiceLists() {
  const bv = sform.elements.browserVoice;
  const voices = Speaker.browserVoices();
  // English voices first, British ones at the top.
  const rank = (v) => (v.lang === "en-GB" ? 0 : v.lang.startsWith("en") ? 1 : 2);
  const sorted = [...voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  bv.replaceChildren(new Option("System default", ""), ...sorted.map((v) => new Option(`${v.name} (${v.lang})`, v.name)));
  bv.value = settings.browserVoice;
  const cv = sform.elements.cloudVoice;
  if (!cv.options.length) cv.append(...AURA_VOICES.map((v) => new Option(v[0].toUpperCase() + v.slice(1), v)));
  cv.value = settings.cloudVoice;
}
window.speechSynthesis?.addEventListener?.("voiceschanged", fillVoiceLists);

function syncEngineRows() {
  const engine = sform.elements.ttsEngine.value;
  for (const row of sform.querySelectorAll("[data-engine]")) row.hidden = row.dataset.engine !== engine;
}

$("#open-settings").onclick = () => {
  for (const [k, v] of Object.entries(settings)) {
    const el = sform.elements[k];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
  if (!Recorder.browserSttAvailable()) sform.elements.sttEngine.querySelector('[value="browser"]').disabled = true;
  fillVoiceLists();
  syncEngineRows();
  els.settings.showModal();
};
sform.elements.ttsEngine.onchange = syncEngineRows;

function readSettingsForm() {
  const next = { ...settings };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const el = sform.elements[k];
    next[k] = el.type === "checkbox" ? el.checked : el.value;
  }
  return next;
}
sform.addEventListener("change", () => {
  settings = readSettingsForm();
  store.set("settings", settings);
});
$("#test-voice").onclick = () => speakText("Hello. This is how I'll sound when I read replies aloud.");
$("#change-key").onclick = () => {
  els.settings.close();
  showKeyDialog();
};
$("#forget-key").onclick = async () => {
  if (!confirm("Remove the API key from this browser?")) return;
  apiKey = "";
  await deleteSetting("apiKey");
  els.settings.close();
  showKeyDialog();
};

// ---------- Boot ----------

(async () => {
  renderMessages();
  renderSidebar();
  updateSendState();
  apiKey = (await getSetting("apiKey")) ?? "";
  if (!apiKey) showKeyDialog();
})();
