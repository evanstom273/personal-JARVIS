import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, type Persona } from "./system-prompt";

const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 64000;
// Haiku 5.5 defaults to "medium". "low" is snappier and cheaper for chat;
// "high" thinks harder before answering.
const EFFORT = "medium";
// The server pauses long tool-heavy turns (stop_reason "pause_turn"); we resume
// automatically up to this many times per user message.
const MAX_CONTINUATIONS = 5;
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["thinking-binding-controls-2026-08-01"];

type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "sources"; results: { title: string; url: string }[] }
  | { type: "fetched"; url: string; title?: string }
  | { type: "tool_error"; code: string }
  | { type: "message"; content: Anthropic.Beta.BetaContentBlock[] }
  | { type: "done"; stop_reason: string | null }
  | { type: "error"; message: string };

export async function handleChat(request: Request): Promise<Response> {
  // The key comes from the browser with every request and is only used to make
  // this one call; nothing is stored server-side.
  const apiKey = request.headers.get("X-Api-Key");
  if (!apiKey) {
    return Response.json({ error: "Add your Claude API key in Settings." }, { status: 401 });
  }

  const body = (await request.json()) as { messages?: Anthropic.Beta.BetaMessageParam[]; persona?: Persona };
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return Response.json({ error: "messages must be a non-empty array ending with a user turn." }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const system = buildSystemPrompt(body.persona);
  const tools = buildTools(request);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let clientGone = false;
  const send = async (event: ChatEvent) => {
    if (clientGone) return;
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      clientGone = true;
    }
  };

  const run = async () => {
    const history = [...messages];
    try {
      for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          betas: BETAS,
          system,
          // Thinking blocks are tied to the exact conversation prefix. If the
          // system prompt or tools change between deploys, drop stale blocks
          // instead of failing the whole request.
          thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
          output_config: { effort: EFFORT },
          cache_control: { type: "ephemeral" },
          tools,
          messages: history,
        });

        await forwardStream(stream, send, () => clientGone);
        if (clientGone) {
          stream.abort();
          return;
        }

        const final = await stream.finalMessage();
        // The client stores this verbatim and sends it back next time. Search
        // results carry encrypted_content that must round-trip unchanged.
        await send({ type: "message", content: final.content });

        if (final.stop_reason === "pause_turn" && turn < MAX_CONTINUATIONS) {
          history.push({ role: "assistant", content: final.content });
          continue;
        }
        await send({ type: "done", stop_reason: final.stop_reason });
        return;
      }
    } catch (err) {
      console.error(err);
      await send({ type: "error", message: describeError(err) });
    } finally {
      try {
        await writer.close();
      } catch {
        // already closed by the client disconnecting
      }
    }
  };

  // Keep running after the Response is returned, so tokens stream as they come.
  request.signal?.addEventListener?.("abort", () => (clientGone = true));
  void run();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function buildTools(request: Request): Anthropic.Beta.BetaToolUnion[] {
  // Cloudflare tells us roughly where the request came from, which makes
  // "weather near me" style searches work without asking.
  const cf = (request as { cf?: IncomingRequestCfProperties }).cf;
  const location: Anthropic.Beta.BetaUserLocation | undefined = cf?.country
    ? {
        type: "approximate",
        country: String(cf.country),
        city: cf.city ? String(cf.city) : undefined,
        region: cf.region ? String(cf.region) : undefined,
        timezone: cf.timezone ? String(cf.timezone) : undefined,
      }
    : undefined;

  // Basic (direct) web search/fetch. The _20260209+ variants add "dynamic
  // filtering" via code execution; swap them in later if search-heavy chats get
  // expensive.
  return [
    { type: "web_search_20250305", name: "web_search", max_uses: 5, user_location: location },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5, citations: { enabled: true } },
  ];
}

// Turn the raw SDK event stream into the small set of events the UI cares about.
async function forwardStream(
  stream: ReturnType<Anthropic["beta"]["messages"]["stream"]>,
  send: (e: ChatEvent) => Promise<void>,
  isGone: () => boolean,
) {
  const pendingTools = new Map<number, { name: string; json: string }>();

  for await (const event of stream) {
    if (isGone()) return;
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "server_tool_use") {
          pendingTools.set(event.index, { name: block.name, json: "" });
        } else if (block.type === "web_search_tool_result") {
          if (Array.isArray(block.content)) {
            await send({
              type: "sources",
              results: block.content.map((r: Anthropic.Beta.BetaWebSearchResultBlock) => ({ title: r.title, url: r.url })),
            });
          } else {
            await send({ type: "tool_error", code: block.content.error_code });
          }
        } else if (block.type === "web_fetch_tool_result") {
          const c = block.content;
          if (c.type === "web_fetch_result") {
            await send({ type: "fetched", url: c.url, title: c.content.title ?? undefined });
          } else {
            await send({ type: "tool_error", code: c.error_code });
          }
        }
        break;
      }
      case "content_block_delta": {
        if (event.delta.type === "text_delta") {
          await send({ type: "text", text: event.delta.text });
        } else if (event.delta.type === "input_json_delta") {
          const pending = pendingTools.get(event.index);
          if (pending) pending.json += event.delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const pending = pendingTools.get(event.index);
        if (pending) {
          pendingTools.delete(event.index);
          let input: unknown = {};
          try {
            input = pending.json ? JSON.parse(pending.json) : {};
          } catch {
            // status display only; the real input is in the final message
          }
          await send({ type: "tool", name: pending.name, input });
        }
        break;
      }
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Your Claude API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Give it a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `The Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
