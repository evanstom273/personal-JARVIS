import type Anthropic from "@anthropic-ai/sdk";

// Tools for the notes ("memory") system. Claude calls them; the browser runs
// them against the notes stored in IndexedDB (see public/memory.js) and sends
// the results back on the next request. The Worker only declares them.
//
// Keep this list stable: changing tools mid-conversation invalidates the
// prompt cache for every chat.

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): Anthropic.Beta.BetaTool => ({
  name,
  description,
  input_schema: { type: "object", properties, required, additionalProperties: false },
  // Stream large inputs (note contents) as they're generated instead of in
  // one burst at the end. The browser validates each input before running it.
  eager_input_streaming: true,
});

const title = { type: "string", description: "The note's title, e.g. \"Mum\" or \"Holiday plans 2027\". Case-insensitive." };

export const MEMORY_TOOLS: Anthropic.Beta.BetaTool[] = [
  tool(
    "search_notes",
    "Full-text search across all of the user's notes. Use it whenever the user mentions a person, place, project, plan, preference, event or anything else that might already be written down, before answering. Returns matching note titles with short snippets; read_note gets the full text. Try a couple of different keywords if the first search finds nothing.",
    {
      query: { type: "string", description: "Keywords to search for." },
      limit: { type: "integer", description: "Maximum results (default 8, max 25)." },
    },
    ["query"],
  ),
  tool(
    "read_note",
    "Read a note's full Markdown content, plus the notes it links to and the notes that link back to it.",
    { title },
    ["title"],
  ),
  tool(
    "list_notes",
    "List note titles, most recently updated first. Optionally only notes with a given #tag.",
    { tag: { type: "string", description: "Only list notes with this tag (without the #)." } },
  ),
  tool(
    "create_note",
    "Create a new note. Fails if a note with that title already exists (use edit_note or append_to_note instead). Write Markdown; link related notes with [[Note title]] and use #tags where useful.",
    { title, content: { type: "string", description: "The note's Markdown content." } },
    ["title", "content"],
  ),
  tool(
    "edit_note",
    "Replace one exact piece of text in an existing note. old_text must appear exactly once in the note; include enough surrounding text to make it unique. Use an empty new_text to delete the passage.",
    {
      title,
      old_text: { type: "string", description: "Exact text currently in the note." },
      new_text: { type: "string", description: "Replacement text." },
    },
    ["title", "old_text", "new_text"],
  ),
  tool(
    "append_to_note",
    "Add text to the end of a note, creating the note if it doesn't exist yet.",
    { title, text: { type: "string", description: "Markdown to append." } },
    ["title", "text"],
  ),
  tool(
    "rename_note",
    "Rename a note. [[Links]] to it in other notes are updated automatically.",
    { title, new_title: { type: "string", description: "The new title." } },
    ["title", "new_title"],
  ),
  tool(
    "delete_note",
    "Permanently delete a note. Only do this when the user explicitly asks for it.",
    { title },
    ["title"],
  ),
];
