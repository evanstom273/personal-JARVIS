# personal-JARVIS

A personal AI assistant built on **Claude Haiku 5.5**, running as a website on **Cloudflare Workers**.

- Replies stream in token by token, with Markdown rendering
- **Web search and web fetch** (Claude's server-side tools), with numbered citations and a sources list
- **Attachments:** images (JPEG/PNG/GIF/WebP), PDFs and text/code files. Use the paperclip, paste or drag-and-drop. Claude reads the actual content, including the pages of a PDF.
- **Speech-to-text:** tap the mic. By default it uses Whisper on Workers AI, which works in any browser (and in an Android WebView later). The browser's own engine is an option in Settings.
- **Text-to-speech:** a "Read aloud" button on every reply, plus auto-read (by default, only when you used the mic). Uses either the browser voice or Deepgram Aura on Workers AI.
- Conversations are saved in the browser (IndexedDB) and listed in the sidebar
- Locked with a password so nobody else can run up your API bill

## Layout

```
src/index.ts          Worker entry: routing + password check
src/chat.ts           /api/chat: streams Claude's reply as server-sent events
src/system-prompt.ts  JARVIS's standing instructions (edit freely)
src/voice.ts          /api/transcribe (Whisper) and /api/speak (Aura)
public/               The web app (plain HTML/CSS/JS, no build step)
  app.js              UI, attachments, streaming, settings
  voice.js            Recording, transcription and speech playback
  db.js               IndexedDB conversation storage
  vendor/             marked + DOMPurify (Markdown rendering)
wrangler.jsonc        Cloudflare config
```

## Setup

You need Node 20+, a Cloudflare account and a Claude API key from https://platform.claude.com.

```bash
npm install
npx wrangler login
```

### Run locally

```bash
cp .dev.vars.example .dev.vars   # then fill in your API key and a password
npm run dev                      # http://localhost:8787
```

Workers AI (the voice features) always runs on Cloudflare's servers, even in local dev, so `wrangler login` has to be done first.

### Deploy

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_PASSWORD
npm run deploy
```

Wrangler prints the URL (`https://personal-jarvis.<your-subdomain>.workers.dev`). Open it and enter the password.

## Tweaking

- **Model, effort, tool limits:** constants at the top of `src/chat.ts`. `EFFORT` is `"medium"` (Haiku's default). `"low"` is quicker and cheaper; `"high"` thinks harder.
- **Personality / instructions:** `src/system-prompt.ts`. Changing it doesn't break existing conversations.
- **Web search** uses the basic tool versions (`web_search_20250305`, `web_fetch_20250910`), capped at 5 searches and 5 fetches per message. Searches cost $10 per 1,000 on top of tokens.

## Costs, roughly

Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output tokens (for prompts up to 100K tokens). The whole conversation is resent with every message, so long chats full of images and PDFs cost more per message. Start a new chat when you change topic. Prompt caching is on, which makes the resent history much cheaper.

Workers AI (Whisper and Aura) has a free daily allowance on Cloudflare that casual voice use should fit inside.

## Notes and limitations

- **Word/Excel files** aren't read directly. Export them to PDF or CSV first.
- **Chat history lives in the browser** you're using, so it doesn't sync between devices yet.
- **The password** is a simple shared secret stored in the browser. For stronger protection, put the Worker behind Cloudflare Access (Zero Trust, free for personal use).
- **Android APK:** later. The front end is a plain static site, so it can be wrapped (e.g. with Capacitor). Whisper STT and Aura TTS already avoid the WebView's missing speech APIs.
