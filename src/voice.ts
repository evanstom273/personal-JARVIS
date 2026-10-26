import type { Env } from "./index";

const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const TTS_MODEL = "@cf/deepgram/aura-2-en";
const TTS_MAX_CHARS = 1900;

type AuraSpeaker = Ai_Cf_Deepgram_Aura_2_En_Input["speaker"];

// Body: raw audio bytes from MediaRecorder (webm/ogg/mp4). Returns { text }.
export async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return Response.json({ error: "No audio received." }, { status: 400 });

  const result = await env.AI.run(STT_MODEL, {
    audio: toBase64(bytes),
    task: "transcribe",
    vad_filter: true,
  });
  return Response.json({ text: (result.text ?? "").trim() });
}

// Body: { text, voice? }. Returns audio/mpeg.
export async function handleSpeak(request: Request, env: Env): Promise<Response> {
  const { text, voice } = (await request.json()) as { text?: string; voice?: string };
  if (!text?.trim()) return Response.json({ error: "No text to speak." }, { status: 400 });

  const result: unknown = await env.AI.run(TTS_MODEL, {
    text: text.slice(0, TTS_MAX_CHARS),
    speaker: (voice || "pandora") as AuraSpeaker,
    encoding: "mp3",
  });

  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" };
  // Workers AI has returned audio as a stream, raw bytes, or base64 depending
  // on model/runtime version; accept all three.
  if (result instanceof ReadableStream) return new Response(result, { headers });
  if (result instanceof ArrayBuffer || result instanceof Uint8Array) return new Response(result, { headers });
  const b64 = typeof result === "string" ? result : (result as { audio?: string } | null)?.audio;
  if (typeof b64 === "string") return new Response(fromBase64(b64), { headers });
  return Response.json({ error: "Unexpected TTS response from Workers AI." }, { status: 502 });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
