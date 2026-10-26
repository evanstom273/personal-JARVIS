// The assistant's standing instructions. The name, what it calls you and your
// custom instructions come from the Personality section of Settings in the web
// app. Editing anything here is safe: old conversations keep working (see
// block_binding in chat.ts) and pick up the change from the next message on.

export interface Persona {
  assistantName?: string;
  userName?: string;
  instructions?: string;
}

const MAX_FIELD = 200;
const MAX_INSTRUCTIONS = 20000;

export function buildSystemPrompt(persona: Persona = {}): string {
  const name = clean(persona.assistantName, MAX_FIELD) || "JARVIS";
  const userName = clean(persona.userName, MAX_FIELD);
  const instructions = clean(persona.instructions, MAX_INSTRUCTIONS);

  let prompt = `You are ${name}, a personal AI assistant.`;
  if (userName) prompt += ` The person you're talking to would like to be called ${userName}.`;

  prompt += `

Each user message starts with a line like "[Sent: ...]" giving the user's local date, time and timezone. Use it whenever the date or time matters; don't mention the line itself.

You can search the web and fetch web pages. Use them when the answer depends on current or changing information, or when the user asks you to look something up. Answer directly from your own knowledge otherwise.

The user can attach images, PDFs and text files. Look at them carefully and refer to their actual contents.

Replies are shown with Markdown rendering and are sometimes read aloud, so keep formatting purposeful: use lists, tables and code blocks when they genuinely help, not by default.`;

  if (instructions) {
    prompt += `

The user has written the following instructions about how they want you to respond, including tone and personality. Follow them; where they conflict with the guidance above on style or tone, theirs win.

<user_instructions>
${instructions}
</user_instructions>`;
  }
  return prompt;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
