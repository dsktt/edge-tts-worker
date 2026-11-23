import {
  CHROMIUM_MAJOR_VERSION,
  generateSecMsGecV2,
  SEC_MS_GEC_VERSION,
  TRUSTED_CLIENT_TOKEN,
} from "./drm";

interface Env {
  API_KEY?: string;
}

// --- Edge TTS Protocol Constants ---
const BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
const WSS_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
  "Pragma": "no-cache",
  "Cache-Control": "no-cache",
  "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
};

type Voice = {
  Name: string;
  ShortName: string;
  Gender: string;
  Locale: string;
  SuggestedCodec: string;
  FriendlyName: string;
  Status: string;
  VoiceTag: { ContentCategories: string[]; VoicePersonalities: string[] };
};

let cachedVoices: Voice[] | null = null;

// --- DRM / Auth Token ---
let clockSkewSeconds = 0;

async function generateSecMsGec(): Promise<string> {
  return generateSecMsGecV2(Date.now() / 1000 + clockSkewSeconds);
}

function generateMuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function connectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function dateToString(): string {
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}

// --- Text Processing ---
function removeIncompatibleCharacters(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const VOICE_MAP: Record<string, { female: string; male: string }> = {
  zh: { female: "zh-CN-XiaoxiaoNeural", male: "zh-CN-YunxiNeural" },
  ja: { female: "ja-JP-NanamiNeural", male: "ja-JP-KeitaNeural" },
  ko: { female: "ko-KR-SunHiNeural", male: "ko-KR-InJoonNeural" },
  en: { female: "en-US-EmmaMultilingualNeural", male: "en-US-AndrewMultilingualNeural" },
};

function detectVoice(text: string, gender: string = "female"): string {
  let zh = 0, ja = 0, ko = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x4E00 && c <= 0x9FFF || c >= 0x3400 && c <= 0x4DBF) zh++;
    if (c >= 0x3040 && c <= 0x309F || c >= 0x30A0 && c <= 0x30FF) ja++;
    if (c >= 0xAC00 && c <= 0xD7AF || c >= 0x1100 && c <= 0x11FF) ko++;
  }
  const g = gender === "male" ? "male" : "female";
  if (ja > 0) return VOICE_MAP.ja[g];
  if (ko > 0) return VOICE_MAP.ko[g];
  if (zh > 0) return VOICE_MAP.zh[g];
  return VOICE_MAP.en[g];
}

const OPENAI_VOICE_GENDER: Record<string, "female" | "male"> = {
  alloy: "female",
  coral: "female",
  fable: "female",
  nova: "female",
  sage: "female",
  shimmer: "female",
  marin: "female",
  ash: "male",
  ballad: "male",
  echo: "male",
  onyx: "male",
  verse: "male",
  cedar: "male",
};

function selectVoice(input: string, requestedVoice?: string, gender?: string): string {
  if (!requestedVoice) {
    return detectVoice(input, gender);
  }
  const mappedGender = OPENAI_VOICE_GENDER[requestedVoice.toLowerCase()];
  if (mappedGender) {
    return detectVoice(input, mappedGender);
  }
  return requestedVoice;
}

function mkssml(voice: string, rate: string, volume: string, pitch: string, text: string): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${text}</prosody></voice></speak>`;
}

function ssmlHeadersPlusData(requestId: string, timestamp: string, ssml: string): string {
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

// Resolve short voice name to full name
function resolveVoiceName(voice: string): string {
  const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(voice);
  if (match) {
    const [, lang] = match;
    let [, , region, name] = match;
    if (name.includes("-")) {
      const parts = name.split("-");
      region += `-${parts[0]}`;
      name = parts[1];
    }
    return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
  }
  return voice;
}

// --- Binary Protocol Parsing ---
function getHeadersAndDataFromBinary(buffer: Uint8Array): [Record<string, string>, Uint8Array] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const headerLength = view.getUint16(0, false);
  const headers: Record<string, string> = {};
  const headerString = new TextDecoder().decode(buffer.subarray(2, headerLength + 2));
  if (headerString) {
    for (const line of headerString.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        headers[line.substring(0, idx)] = line.substring(idx + 1).trim();
      }
    }
  }
  return [headers, buffer.subarray(headerLength + 2)];
}

function getHeadersAndDataFromText(text: string): [Record<string, string>, string] {
  const headerEnd = text.indexOf("\r\n\r\n");
  const headerString = headerEnd >= 0 ? text.substring(0, headerEnd) : text;
  const body = headerEnd >= 0 ? text.substring(headerEnd + 4) : "";
  const headers: Record<string, string> = {};
  for (const line of headerString.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.substring(0, idx)] = line.substring(idx + 1).trim();
    }
  }
  return [headers, body];
}

// --- TTS Streaming via WebSocket (Cloudflare Workers compatible) ---
async function openTtsWebSocket(): Promise<WebSocket> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const secMsGec = await generateSecMsGec();
    const connId = connectId();
    const url = `${WSS_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

    // Cloudflare Workers: connect via fetch with Upgrade header (use https:// instead of wss://)
    const httpUrl = url.replace("wss://", "https://");
    const resp = await fetch(httpUrl, {
      headers: {
        ...WSS_HEADERS,
        "Upgrade": "websocket",
        "Cookie": `muid=${generateMuid()};`,
      },
    });

    if (resp.webSocket) {
      return resp.webSocket;
    }

    if (resp.status === 403 && attempt === 0) {
      const dateHeader = resp.headers.get("Date");
      if (dateHeader) {
        const serverMs = Date.parse(dateHeader);
        if (!Number.isNaN(serverMs)) {
          const serverSeconds = serverMs / 1000;
          const clientSeconds = Date.now() / 1000 + clockSkewSeconds;
          clockSkewSeconds += serverSeconds - clientSeconds;
          await resp.body?.cancel();
          continue;
        }
      }
    }

    let detail = "";
    try {
      const text = (await resp.text()).trim();
      if (text) detail = `: ${text.slice(0, 200)}`;
    } catch {
      // Ignore response body read errors
    }
    throw new Error(`WebSocket upgrade failed (HTTP ${resp.status})${detail}`);
  }
  throw new Error("WebSocket upgrade failed");
}

async function* ttsStream(
  text: string,
  voice: string,
  rate: string,
  volume: string = "+0%",
  pitch: string = "+0Hz",
): AsyncGenerator<Uint8Array> {
  const escapedText = escapeXml(removeIncompatibleCharacters(text));
  const fullVoice = resolveVoiceName(voice);
  const ws = await openTtsWebSocket();
  ws.accept();

  type QueueItem = { type: "audio"; data: Uint8Array } | { type: "close" } | { type: "error"; error: string };
  const messageQueue: QueueItem[] = [];
  let resolveMessage: (() => void) | null = null;

  const notify = () => { if (resolveMessage) { resolveMessage(); resolveMessage = null; } };

  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") {
      const [headers] = getHeadersAndDataFromText(data);
      const path = headers["Path"];
      if (path === "turn.end") {
        ws.close();
      }
      // Ignore other text messages (response, turn.start, audio.metadata)
    } else if (data instanceof ArrayBuffer) {
      const buffer = new Uint8Array(data);
      if (buffer.length >= 2) {
        const [headers, audioData] = getHeadersAndDataFromBinary(buffer);
        if (headers["Path"] === "audio" && headers["Content-Type"] === "audio/mpeg" && audioData.length > 0) {
          messageQueue.push({ type: "audio", data: audioData });
        }
      }
    }
    notify();
  });

  ws.addEventListener("error", (event) => {
    messageQueue.push({ type: "error", error: (event as ErrorEvent).message || "WebSocket error" });
    notify();
  });

  ws.addEventListener("close", () => {
    messageQueue.push({ type: "close" });
    notify();
  });

  try {
    // Send speech config
    ws.send(
      `X-Timestamp:${dateToString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
    );

    // Send SSML
    const ssml = mkssml(fullVoice, rate, volume, pitch, escapedText);
    ws.send(ssmlHeadersPlusData(connectId(), dateToString(), ssml));

    // Yield audio chunks
    let audioReceived = false;
    while (true) {
      if (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        if (msg.type === "close") {
          break;
        } else if (msg.type === "error") {
          throw new Error(msg.error);
        } else if (msg.type === "audio") {
          audioReceived = true;
          yield msg.data;
        }
      } else {
        await new Promise<void>((resolve) => {
          resolveMessage = resolve;
          setTimeout(resolve, 50);
        });
      }
    }

    if (!audioReceived) {
      throw new Error("No audio was received from TTS service");
    }
  } finally {
    try {
      ws.close();
    } catch {
      // Ignore close errors if already closed
    }
  }
}

// --- Helpers ---
function errorResponse(message: string, status: number) {
  return Response.json(
    { error: { message, type: "invalid_request_error", code: status } },
    { status, headers: corsHeaders() },
  );
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function checkAuth(request: Request, env: Env): Response | null {
  if (!env.API_KEY) return null;
  const auth = request.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${env.API_KEY}`) {
    return errorResponse("Invalid API key", 401);
  }
  return null;
}

// --- Route Handlers ---
async function handleSpeech(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authError = checkAuth(request, env);
  if (authError) return authError;

  let body: {
    model?: string;
    input?: string;
    voice?: string;
    gender?: string;
    speed?: number;
    response_format?: string;
  };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const input = body.input;
  if (!input || typeof input !== "string" || input.trim() === "") {
    return errorResponse("'input' is required and must be a non-empty string", 400);
  }

  const voice = selectVoice(input, body.voice, body.gender);
  const speed = Math.min(2, Math.max(0.5, body.speed ?? 1.0));
  const rateValue = Math.round((speed - 1) * 100);
  const rate = rateValue >= 0 ? `+${rateValue}%` : `${rateValue}%`;

  const stream = ttsStream(input, voice, rate);
  let firstChunk: IteratorResult<Uint8Array>;
  try {
    firstChunk = await stream.next();
  } catch (e: any) {
    console.error("TTS stream error:", e);
    return errorResponse(`TTS failed: ${e?.message || "Unknown error"}`, 502);
  }
  if (firstChunk.done) {
    return errorResponse("TTS failed: No audio was received from TTS service", 502);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  ctx.waitUntil((async () => {
    try {
      await writer.write(firstChunk.value);
      for await (const audioData of stream) {
        await writer.write(audioData);
      }
    } catch (e) {
      console.error("TTS stream error:", e);
    } finally {
      await writer.close().catch(() => {});
    }
  })());

  return new Response(readable, {
    headers: {
      "Content-Type": "audio/mpeg",
      ...corsHeaders(),
    },
  });
}

async function handleVoices(request: Request, env: Env): Promise<Response> {
  const authError = checkAuth(request, env);
  if (authError) return authError;

  if (!cachedVoices) {
    const secMsGec = await generateSecMsGec();
    const url = `${VOICE_LIST_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        "Authority": "speech.platform.bing.com",
        "Sec-CH-UA": `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}", "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
        "Sec-CH-UA-Mobile": "?0",
        "Accept": "*/*",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
    });
    if (!resp.ok) {
      return errorResponse("Failed to fetch voices", 502);
    }
    cachedVoices = await resp.json() as Voice[];
  }

  return Response.json(cachedVoices, { headers: corsHeaders() });
}

function handleModels(request: Request, env: Env): Response {
  const authError = checkAuth(request, env);
  if (authError) return authError;

  return Response.json(
    {
      object: "list",
      data: [
        { id: "tts-1", object: "model", owned_by: "openai" },
        { id: "tts-1-hd", object: "model", owned_by: "openai" },
        { id: "gpt-4o-mini-tts", object: "model", owned_by: "openai" },
      ],
    },
    { headers: corsHeaders() },
  );
}

function handleIndex(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge TTS Worker</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; color: #333; display: flex; justify-content: center; padding: 40px 16px; }
  .container { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); padding: 32px; max-width: 520px; width: 100%; }
  h1 { font-size: 20px; margin-bottom: 24px; }
  label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; color: #555; }
  textarea { width: 100%; height: 100px; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; resize: vertical; font-family: inherit; }
  select, input[type=range], input[type=password] { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
  .field { margin-bottom: 16px; }
  .key-row { display: flex; gap: 8px; }
  .key-row input { flex: 1; }
  .speed-value { font-size: 13px; color: #888; float: right; }
  button { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  button:disabled { background: #93c5fd; cursor: not-allowed; }
  .btn-secondary { width: auto; padding: 8px 14px; background: #e5e7eb; color: #374151; font-size: 13px; white-space: nowrap; }
  .btn-secondary:hover { background: #d1d5db; }
  audio { width: 100%; margin-top: 16px; }
  .error { color: #dc2626; font-size: 13px; margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
  <h1>Edge TTS Worker</h1>
  <div class="field">
    <label for="api-key">API Key (optional)</label>
    <div class="key-row">
      <input type="password" id="api-key" placeholder="Enter API key if enabled">
      <button type="button" id="load-voices" class="btn-secondary">Load Voices</button>
    </div>
  </div>
  <div class="field">
    <label for="text">Text</label>
    <textarea id="text" placeholder="Enter text to synthesize...">Hello! This is a test of the Edge TTS Worker.</textarea>
  </div>
  <div class="field">
    <label for="voice">Voice</label>
    <select id="voice"><option value="">Loading voices...</option></select>
  </div>
  <div class="field">
    <label>Speed <span class="speed-value" id="speed-label">1.0x</span></label>
    <input type="range" id="speed" min="0.5" max="2" step="0.1" value="1">
  </div>
  <button id="play" onclick="synthesize()">Play</button>
  <div id="error" class="error"></div>
  <audio id="audio" controls style="display:none"></audio>
</div>
<script>
  const apiKeyInput = document.getElementById('api-key');
  const loadVoicesBtn = document.getElementById('load-voices');
  const voiceSelect = document.getElementById('voice');
  const speedInput = document.getElementById('speed');
  const speedLabel = document.getElementById('speed-label');
  const playBtn = document.getElementById('play');
  const audioEl = document.getElementById('audio');
  const errorEl = document.getElementById('error');
  const STORAGE_KEY = 'edge_tts_api_key';

  try {
    apiKeyInput.value = localStorage.getItem(STORAGE_KEY) || '';
  } catch {}

  apiKeyInput.addEventListener('input', () => {
    try { localStorage.setItem(STORAGE_KEY, apiKeyInput.value.trim()); } catch {}
  });

  speedInput.addEventListener('input', () => {
    speedLabel.textContent = parseFloat(speedInput.value).toFixed(1) + 'x';
  });

  function authHeaders() {
    const key = apiKeyInput.value.trim();
    return key ? { Authorization: 'Bearer ' + key } : {};
  }

  async function loadVoices() {
    try {
      const r = await fetch('/v1/voices', { headers: authHeaders() });
      if (r.status === 401) {
        voiceSelect.innerHTML = '<option value="">Enter API Key to load voices</option>';
        errorEl.textContent = 'Please enter a valid API Key';
        return;
      }
      if (!r.ok) {
        throw new Error('Failed to load voices (' + r.status + ')');
      }
      const voices = await r.json();
      voiceSelect.innerHTML = '';
      voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.ShortName;
        opt.textContent = v.ShortName + ' (' + v.Gender + ', ' + v.Locale + ')';
        if (v.ShortName === 'en-US-EmmaMultilingualNeural') opt.selected = true;
        voiceSelect.appendChild(opt);
      });
      if (errorEl.textContent === 'Please enter a valid API Key') {
        errorEl.textContent = '';
      }
    } catch {
      voiceSelect.innerHTML = '<option value="">Failed to load voices</option>';
    }
  }

  loadVoicesBtn.addEventListener('click', loadVoices);
  apiKeyInput.addEventListener('change', loadVoices);
  loadVoices();

  async function synthesize() {
    const text = document.getElementById('text').value.trim();
    if (!text) return;
    errorEl.textContent = '';
    playBtn.disabled = true;
    playBtn.textContent = 'Generating...';
    try {
      const res = await fetch('/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: voiceSelect.value || undefined,
          speed: parseFloat(speedInput.value),
          response_format: 'mp3'
        })
      });
      if (!res.ok) {
        const bodyText = await res.text();
        let msg = 'Request failed (' + res.status + ')';
        try {
          const err = JSON.parse(bodyText);
          if (err.error?.message) msg = err.error.message;
        } catch {
          if (bodyText) msg = bodyText;
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        throw new Error('No audio returned');
      }
      const url = URL.createObjectURL(blob);
      audioEl.src = url;
      audioEl.style.display = 'block';
      await audioEl.play().catch((err) => {
        throw new Error('Playback failed: ' + (err?.message || err));
      });
    } catch (e) {
      errorEl.textContent = e.message;
    } finally {
      playBtn.disabled = false;
      playBtn.textContent = 'Play';
    }
  }
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

async function handleWebSocket(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") {
    return errorResponse("Expected WebSocket upgrade", 426);
  }

  // Auth check via query param: wss://host/v1/ws?token=<key>
  if (env.API_KEY) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (token !== env.API_KEY) {
      return errorResponse("Invalid API key", 401);
    }
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  server.addEventListener("message", (event) => {
    const handle = async () => {
      let msg: { input?: string; voice?: string; gender?: string; speed?: number };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        server.send(JSON.stringify({ event: "error", message: "Invalid JSON" }));
        return;
      }

      const input = msg.input;
      if (!input || typeof input !== "string" || input.trim() === "") {
        server.send(JSON.stringify({ event: "error", message: "'input' is required" }));
        return;
      }

      const voice = selectVoice(input, msg.voice, msg.gender);
      const speed = Math.min(2, Math.max(0.5, msg.speed ?? 1.0));
      const rateValue = Math.round((speed - 1) * 100);
      const rate = rateValue >= 0 ? `+${rateValue}%` : `${rateValue}%`;

      try {
        for await (const audioData of ttsStream(input, voice, rate)) {
          server.send(audioData);
        }
        server.send(JSON.stringify({ event: "done" }));
      } catch (e: any) {
        server.send(JSON.stringify({ event: "error", message: e.message }));
      }
    };
    ctx.waitUntil(handle());
  });

  server.addEventListener("close", () => server.close());

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && request.method === "GET") {
      return handleIndex();
    }

    if (path.endsWith("/audio/speech") && request.method === "POST") {
      return handleSpeech(request, env, ctx);
    }

    if (path.endsWith("/models") && request.method === "GET") {
      return handleModels(request, env);
    }

    if (path.endsWith("/voices") && request.method === "GET") {
      return handleVoices(request, env);
    }

    if (path === "/v1/ws" || path === "/ws") {
      return handleWebSocket(request, env, ctx);
    }

    return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  },
} satisfies ExportedHandler<Env>;
