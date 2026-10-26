// Speech in and out. Two engines each:
//   STT  "cloud"   - record with MediaRecorder, transcribe with Whisper on Workers AI
//        "browser" - Web Speech API (Chrome/Edge; not available in Android WebViews)
//   TTS  "browser" - speechSynthesis, free and instant
//        "cloud"   - Deepgram Aura on Workers AI, consistent voice everywhere

export class Recorder {
  constructor({ engine, apiFetch, onState }) {
    this.engine = engine;
    this.apiFetch = apiFetch;
    this.onState = onState;
    this.active = false;
  }

  static browserSttAvailable() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // Resolves with the transcript when recording stops.
  async start() {
    if (this.active) return;
    this.active = true;
    this.onState("recording");
    try {
      return this.engine === "browser" && Recorder.browserSttAvailable()
        ? await this.#browser()
        : await this.#cloud();
    } finally {
      this.active = false;
      this.onState("idle");
    }
  }

  stop() {
    this.stopFn?.();
  }

  async #cloud() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    this.stopFn = () => rec.state !== "inactive" && rec.stop();
    rec.start();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());

    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    if (blob.size === 0) return "";
    this.onState("transcribing");
    const res = await this.apiFetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Transcription failed");
    return data.text;
  }

  #browser() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const sr = new SR();
    sr.lang = navigator.language || "en-GB";
    sr.interimResults = false;
    sr.continuous = true;
    let text = "";
    return new Promise((resolve, reject) => {
      sr.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) text += e.results[i][0].transcript + " ";
        }
      };
      sr.onerror = (e) => (e.error === "no-speech" ? resolve("") : reject(new Error(e.error)));
      sr.onend = () => resolve(text.trim());
      this.stopFn = () => sr.stop();
      sr.start();
    });
  }
}

export class Speaker {
  constructor({ apiFetch }) {
    this.apiFetch = apiFetch;
    this.audio = null;
    this.session = 0;
  }

  static browserVoices() {
    return window.speechSynthesis?.getVoices() ?? [];
  }

  stop() {
    this.session++;
    window.speechSynthesis?.cancel();
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
  }

  async speak(markdown, { engine, voice }) {
    this.stop();
    const session = this.session;
    const chunks = splitForSpeech(toSpeakable(markdown));
    for (const chunk of chunks) {
      if (session !== this.session) return;
      if (engine === "cloud") await this.#cloud(chunk, voice, session);
      else await this.#browser(chunk, voice);
    }
  }

  #browser(text, voiceName) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = Speaker.browserVoices().find((v) => v.name === voiceName);
      if (v) u.voice = v;
      u.onend = u.onerror = resolve;
      speechSynthesis.speak(u);
    });
  }

  async #cloud(text, voice, session) {
    const res = await this.apiFetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Speech failed");
    const url = URL.createObjectURL(await res.blob());
    if (session !== this.session) return URL.revokeObjectURL(url);
    await new Promise((resolve) => {
      this.audio = new Audio(url);
      this.audio.onended = this.audio.onerror = resolve;
      this.audio.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
  }
}

// Strip Markdown so it isn't read out as "asterisk asterisk".
function toSpeakable(md) {
  return md
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\n{2,}/g, ".\n")
    .trim();
}

// Sentence-ish chunks: short enough for the TTS endpoint, and lets playback
// start before the whole reply has been synthesised.
function splitForSpeech(text, max = 600) {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
