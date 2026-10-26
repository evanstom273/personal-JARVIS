import { handleChat } from "./chat";
import { handleSpeak, handleTranscribe } from "./voice";

export interface Env {
  ANTHROPIC_API_KEY: string;
  APP_PASSWORD: string;
  AI: Ai;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const authError = checkAuth(request, env);
    if (authError) return authError;

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /api/ping":
          return Response.json({ ok: true });
        case "POST /api/chat":
          return await handleChat(request, env);
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

// Every /api/* call needs `Authorization: Bearer <APP_PASSWORD>`. Fails closed:
// if the secret was never set, nothing gets through.
function checkAuth(request: Request, env: Env): Response | null {
  if (!env.APP_PASSWORD) {
    return Response.json(
      { error: "APP_PASSWORD secret is not set on the Worker." },
      { status: 500 },
    );
  }
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(given, env.APP_PASSWORD)) {
    return Response.json({ error: "Wrong password." }, { status: 401 });
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
