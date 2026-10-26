import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";

marked.setOptions({ gfm: true, breaks: true });

// Set by the notes UI so [[links]] to notes that don't exist yet render dimmed.
let noteExists = () => true;
export const setNoteResolver = (fn) => (noteExists = fn);

// [[Title]], [[Title#Heading]] and [[Title|shown text]] become in-app links
// (href "#note:<title>"). Code spans and fenced blocks are left alone.
function linkify(md) {
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_, title, heading, alias) => {
            const label = (alias || title + (heading ?? "")).replace(/[[\]]/g, "");
            return `[${label}](#note:${encodeURIComponent(title.trim())})`;
          }),
    )
    .join("");
}

export function renderMarkdown(md) {
  const div = document.createElement("div");
  div.className = "markdown";
  div.innerHTML = DOMPurify.sanitize(marked.parse(linkify(md)));
  for (const a of div.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#note:")) {
      const title = decodeURIComponent(href.slice(6));
      a.className = "wikilink" + (noteExists(title) ? "" : " missing");
      a.dataset.note = title;
    } else {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }
  return div;
}
