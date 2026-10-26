import { handleChat } from "./chat";
import { handleSpeak, handleTranscribe } from "./voice";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /api/chat":
          return await handleChat(request);
        case "POST /api/transcribe":
          return await handleTranscribe(request, env);
        case "POST /api/speak":
          return await handleSpeak(request, env);
        default:
          return Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
