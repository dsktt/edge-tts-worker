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

const CONNECT_TIMEOUT_MS = 5_000;
const FIRST_CHUNK_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 8_000;
const TOTAL_TIMEOUT_MS = 45_000;
const MAX_CHUNK_CHARS = 800;

const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
const WSS_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
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

function adjustClockSkew(dateHeader: string | null): boolean {
  if (!dateHeader) return false;
  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) return false;
  const serverSeconds = serverMs / 1000;
  const clientSeconds = Date.now() / 1000 + clockSkewSeconds;
  clockSkewSeconds += serverSeconds - clientSeconds;
  return true;
}

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

// --- Text Processing & Chinese Voice Mapping ---
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

const OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: "zh-CN-XiaoxiaoNeural",
  nova: "zh-CN-XiaoyiNeural",
  shimmer: "zh-CN-XiaoxiaoNeural",
  coral: "zh-CN-XiaoyiNeural",
  fable: "zh-CN-liaoning-XiaobeiNeural",
  sage: "zh-CN-shaanxi-XiaoniNeural",
  marin: "zh-CN-XiaoxiaoNeural",
  onyx: "zh-CN-YunxiNeural",
  echo: "zh-CN-YunyangNeural",
  ash: "zh-CN-YunjianNeural",
  ballad: "zh-CN-YunxiaNeural",
  verse: "zh-CN-YunxiNeural",
  cedar: "zh-CN-YunyangNeural",
};

const CN_VOICE_LABELS: Record<string, string> = {
  "zh-CN-XiaoxiaoNeural": "晓晓（女 · 温暖自然）",
  "zh-CN-XiaoyiNeural": "晓伊（女 · 活泼清晰）",
  "zh-CN-liaoning-XiaobeiNeural": "晓北（女 · 辽宁东北话）",
  "zh-CN-shaanxi-XiaoniNeural": "晓妮（女 · 陕西话）",
  "zh-CN-YunxiNeural": "云希（男 · 阳光自然）",
  "zh-CN-YunyangNeural": "云扬（男 · 新闻播音）",
  "zh-CN-YunjianNeural": "云健（男 · 沉稳大气）",
  "zh-CN-YunxiaNeural": "云夏（男 · 少年音）",
};

function selectVoice(requestedVoice?: string, gender?: string): string {
  if (!requestedVoice || !requestedVoice.trim()) {
    return gender === "male" ? "zh-CN-YunxiNeural" : "zh-CN-XiaoxiaoNeural";
  }
  const trimmed = requestedVoice.trim();
  return OPENAI_VOICE_MAP[trimmed.toLowerCase()] || trimmed;
}

function extractXmlLang(voice: string): string {
  return /^([a-z]{2,}-[A-Z]{2,})/.exec(voice)?.[1] || "zh-CN";
}

function mkssml(
  voice: string,
  rate: string,
  volume: string,
  pitch: string,
  text: string,
  xmlLang: string = "zh-CN",
): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${text}</prosody></voice></speak>`;
}

function ssmlHeadersPlusData(requestId: string, timestamp: string, ssml: string): string {
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

// Resolve short voice name to full name (including sub-region dialects like zh-CN-liaoning-XiaobeiNeural)
function resolveVoiceName(voice: string): string {
  const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(voice);
  if (match) {
    const [, lang] = match;
    let [, , region, name] = match;
    if (name.includes("-")) {
      const parts = name.split("-");
      region += `-${parts[0]}`;
      name = parts.slice(1).join("-");
    }
    return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
  }
  return voice;
}

function splitText(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const delimiters = ["\n", "。", "！", "？", "；", "，", ". ", "! ", "? ", "; ", ", ", " "];
  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    let splitAt = -1;
    for (const sep of delimiters) {
      const idx = remaining.lastIndexOf(sep, maxChars);
      if (idx > 0) {
        splitAt = idx + sep.length;
        break;
      }
    }
    if (splitAt <= 0) {
      splitAt = maxChars;
    }
    const part = remaining.slice(0, splitAt).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function createSilentMp3(frames: number = 5): Uint8Array {
  const frameSize = 144;
  const buf = new Uint8Array(frames * frameSize);
  for (let i = 0; i < frames; i++) {
    const offset = i * frameSize;
    buf[offset] = 0xff;
    buf[offset + 1] = 0xf3;
    buf[offset + 2] = 0x64;
    buf[offset + 3] = 0xc4;
  }
  return buf;
}

const SILENT_MP3 = createSilentMp3();

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
async function openTtsWebSocket(signal?: AbortSignal): Promise<WebSocket> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    const secMsGec = await generateSecMsGec();
    const connId = connectId();
    const url = `${WSS_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

    // Cloudflare Workers: connect via fetch with Upgrade header (use https:// instead of wss://)
    const httpUrl = url.replace("wss://", "https://");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), CONNECT_TIMEOUT_MS);
    const onCallerAbort = () => controller.abort("caller");
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    let resp: Response;
    try {
      resp = await fetch(httpUrl, {
        headers: {
          ...WSS_HEADERS,
          "Upgrade": "websocket",
          "Cookie": `muid=${generateMuid()};`,
        },
        signal: controller.signal,
      });
    } catch (e: any) {
      if (signal?.aborted) {
        throw new Error("Request aborted");
      }
      if (controller.signal.aborted) {
        throw new Error("Connection timed out");
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    if (resp.webSocket) {
      return resp.webSocket;
    }

    if (resp.status === 403 && attempt === 0 && adjustClockSkew(resp.headers.get("Date"))) {
      await resp.body?.cancel();
      continue;
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
  signal?: AbortSignal,
  volume: string = "+0%",
  pitch: string = "+0Hz",
): AsyncGenerator<Uint8Array> {
  const escapedText = escapeXml(removeIncompatibleCharacters(text));
  const fullVoice = resolveVoiceName(voice);
  const xmlLang = extractXmlLang(voice);
  const ws = await openTtsWebSocket(signal);
  ws.accept();

  type QueueItem = { type: "audio"; data: Uint8Array } | { type: "close" } | { type: "error"; error: string };
  const messageQueue: QueueItem[] = [];
  let resolveMessage: (() => void) | null = null;
  let ended = false;
  let lastActivityAt = Date.now();

  const notify = () => {
    if (resolveMessage) {
      resolveMessage();
      resolveMessage = null;
    }
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    messageQueue.push({ type: "close" });
    notify();
    try {
      ws.close();
    } catch {
      // Ignore close errors if already closed
    }
  };

  const onAbort = () => {
    if (!ended) {
      ended = true;
      messageQueue.push({ type: "error", error: "Request aborted" });
      notify();
    }
    try {
      ws.close();
    } catch {
      // Ignore close errors
    }
  };

  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  ws.addEventListener("message", (event) => {
    lastActivityAt = Date.now();
    const data = event.data;
    if (typeof data === "string") {
      const [headers] = getHeadersAndDataFromText(data);
      if (headers["Path"] === "turn.end") {
        finish();
        return;
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
    if (!ended) {
      ended = true;
      messageQueue.push({ type: "error", error: (event as ErrorEvent).message || "WebSocket error" });
      notify();
    }
  });

  ws.addEventListener("close", () => {
    finish();
  });

  try {
    // Send speech config
    ws.send(
      `X-Timestamp:${dateToString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
    );

    // Send SSML
    const ssml = mkssml(fullVoice, rate, volume, pitch, escapedText, xmlLang);
    ws.send(ssmlHeadersPlusData(connectId(), dateToString(), ssml));

    // Yield audio chunks with first-chunk, idle & total timeouts
    let audioReceived = false;
    const startedAt = Date.now();
    lastActivityAt = startedAt;

    while (true) {
      if (signal?.aborted) {
        throw new Error("Request aborted");
      }

      if (messageQueue.length > 0) {
        lastActivityAt = Date.now();
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
        const now = Date.now();
        if (now - startedAt > TOTAL_TIMEOUT_MS) {
          throw new Error("TTS synthesis timed out");
        }
        if (!audioReceived && now - startedAt > FIRST_CHUNK_TIMEOUT_MS) {
          throw new Error("TTS first audio chunk timed out");
        }
        if (audioReceived && now - lastActivityAt > IDLE_TIMEOUT_MS) {
          throw new Error("TTS stream stalled");
        }
        await new Promise<void>((resolve) => {
          resolveMessage = resolve;
          setTimeout(resolve, 100);
        });
      }
    }

    if (!audioReceived) {
      throw new Error("No audio was received from TTS service");
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      ws.close();
    } catch {
      // Ignore close errors if already closed
    }
  }
}

async function* ttsChunkWithRetry(
  text: string,
  voice: string,
  rate: string,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let yielded = false;
    try {
      for await (const data of ttsStream(text, voice, rate, signal)) {
        yielded = true;
        yield data;
      }
      return;
    } catch (e: any) {
      const msg = e?.message || "";
      const canRetry =
        attempt === 0 &&
        !yielded &&
        !signal?.aborted &&
        msg !== "Request aborted" &&
        msg !== "No audio was received from TTS service";
      if (!canRetry) {
        throw e;
      }
    }
  }
}

async function* ttsMultiChunkStream(
  textChunks: string[],
  voice: string,
  rate: string,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for (const chunk of textChunks) {
    yield* ttsChunkWithRetry(chunk, voice, rate, signal);
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
async function handleSpeech(request: Request, env: Env): Promise<Response> {
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

  const voice = selectVoice(body.voice, body.gender);
  const speed = Math.min(2, Math.max(0.5, body.speed ?? 1.0));
  const rateValue = Math.round((speed - 1) * 100);
  const rate = rateValue >= 0 ? `+${rateValue}%` : `${rateValue}%`;

  if (!hasSpeakableText(input)) {
    return new Response(SILENT_MP3, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(SILENT_MP3.byteLength),
        "Cache-Control": "no-store",
        "X-Edge-Voice": voice,
        ...corsHeaders(),
      },
    });
  }

  const streamAbort = new AbortController();
  const onReqAbort = () => streamAbort.abort("client-abort");
  if (request.signal.aborted) {
    streamAbort.abort("client-abort");
  } else {
    request.signal.addEventListener("abort", onReqAbort, { once: true });
  }

  const iterator = ttsMultiChunkStream(splitText(input), voice, rate, streamAbort.signal);
  let first: IteratorResult<Uint8Array>;
  try {
    first = await iterator.next();
  } catch (e: any) {
    request.signal.removeEventListener("abort", onReqAbort);
    streamAbort.abort();
    await iterator.return?.(undefined).catch(() => {});
    console.error("TTS stream error:", e);
    const msg = e?.message || "Unknown error";
    const status = msg === "Request aborted" ? 499 : (msg.includes("timed out") || msg.includes("stalled")) ? 504 : 502;
    return errorResponse(`TTS failed: ${msg}`, status);
  }

  if (first.done || !first.value) {
    request.signal.removeEventListener("abort", onReqAbort);
    streamAbort.abort();
    await iterator.return?.(undefined).catch(() => {});
    return errorResponse("TTS failed: No audio was received from TTS service", 502);
  }

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          request.signal.removeEventListener("abort", onReqAbort);
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (e) {
        request.signal.removeEventListener("abort", onReqAbort);
        streamAbort.abort();
        await iterator.return?.(undefined).catch(() => {});
        console.error("TTS pull error:", e);
        controller.error(e);
      }
    },
    async cancel() {
      request.signal.removeEventListener("abort", onReqAbort);
      streamAbort.abort("stream-cancelled");
      await iterator.return?.(undefined).catch(() => {});
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Edge-Voice": voice,
      ...corsHeaders(),
    },
  });
}

async function handleVoices(request: Request, env: Env): Promise<Response> {
  const authError = checkAuth(request, env);
  if (authError) return authError;

  if (!cachedVoices) {
    let fetched: Voice[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const secMsGec = await generateSecMsGec();
      const url = `${VOICE_LIST_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Authority": "speech.platform.bing.com",
          "Sec-CH-UA": `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}", "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
          "Sec-CH-UA-Mobile": "?0",
          "Accept": "*/*",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        },
      });
      if (resp.ok) {
        fetched = await resp.json() as Voice[];
        break;
      }
      if (resp.status === 403 && attempt === 0 && adjustClockSkew(resp.headers.get("Date"))) {
        await resp.body?.cancel();
        continue;
      }
      return errorResponse(`Failed to fetch voices (HTTP ${resp.status})`, 502);
    }
    if (!fetched) {
      return errorResponse("Failed to fetch voices", 502);
    }
    cachedVoices = fetched;
  }

  const reqUrl = new URL(request.url);
  const showAll = reqUrl.searchParams.get("all") === "1";
  const result = showAll
    ? cachedVoices
    : cachedVoices.filter((v) => v.Locale === "zh-CN" || v.Locale.startsWith("zh-CN-"));
  return Response.json(result, { headers: corsHeaders() });
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
  const mappingRows = Object.entries(OPENAI_VOICE_MAP)
    .map(([oa, edge]) => `<tr><td><code>${oa}</code></td><td>${CN_VOICE_LABELS[edge] || edge}</td><td><code>${edge}</code></td></tr>`)
    .join("");
  const edgeToOpenAI: Record<string, string[]> = {};
  for (const [oa, edge] of Object.entries(OPENAI_VOICE_MAP)) {
    (edgeToOpenAI[edge] ??= []).push(oa);
  }
  const cnLabelsJson = JSON.stringify(CN_VOICE_LABELS);
  const edgeToOpenAIJson = JSON.stringify(edgeToOpenAI);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge TTS Worker（中文 zh-CN）</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; color: #333; display: flex; justify-content: center; padding: 32px 16px; }
  .container { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); padding: 28px; max-width: 580px; width: 100%; }
  h1 { font-size: 20px; margin-bottom: 20px; }
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
  details { margin-top: 22px; border-top: 1px solid #eee; padding-top: 14px; font-size: 13px; }
  summary { cursor: pointer; font-weight: 600; color: #444; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f0f0f0; }
  th { color: #666; font-weight: 600; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
</style>
</head>
<body>
<div class="container">
  <h1>Edge TTS Worker（中文 zh-CN）</h1>
  <div class="field">
    <label for="api-key">API Key（如未启用鉴权可留空）</label>
    <div class="key-row">
      <input type="password" id="api-key" placeholder="输入 API_KEY（自动保存在本地浏览器）">
      <button type="button" id="load-voices" class="btn-secondary">刷新音色</button>
    </div>
  </div>
  <div class="field">
    <label for="text">朗读文本</label>
    <textarea id="text" placeholder="请输入要合成语音的中文文本...">你好！这是部署在 Cloudflare Workers 上的 Edge 中文语音合成测试。</textarea>
  </div>
  <div class="field">
    <label for="voice">中文音色（zh-CN）</label>
    <select id="voice"><option value="">正在加载音色...</option></select>
  </div>
  <div class="field">
    <label>语速 <span class="speed-value" id="speed-label">1.0x</span></label>
    <input type="range" id="speed" min="0.5" max="2" step="0.1" value="1">
  </div>
  <button id="play" onclick="synthesize()">试听</button>
  <div id="error" class="error"></div>
  <audio id="audio" controls style="display:none"></audio>

  <details open>
    <summary>Speech Central / OpenAI 音色对照表</summary>
    <table>
      <thead><tr><th>OpenAI 音色</th><th>中文音色说明</th><th>Edge 音色 ID</th></tr></thead>
      <tbody>${mappingRows}</tbody>
    </table>
  </details>
</div>
<script>
  const CN_LABELS = ${cnLabelsJson};
  const EDGE_TO_OPENAI = ${edgeToOpenAIJson};
  const apiKeyInput = document.getElementById('api-key');
  const loadVoicesBtn = document.getElementById('load-voices');
  const voiceSelect = document.getElementById('voice');
  const speedInput = document.getElementById('speed');
  const speedLabel = document.getElementById('speed-label');
  const playBtn = document.getElementById('play');
  const audioEl = document.getElementById('audio');
  const errorEl = document.getElementById('error');
  const STORAGE_KEY = 'edge_tts_api_key';
  let activeController = null;
  let lastAudioUrl = null;

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
        voiceSelect.innerHTML = '<option value="">请输入正确的 API Key 后刷新音色</option>';
        errorEl.textContent = '请输入有效的 API Key';
        return;
      }
      if (!r.ok) {
        throw new Error('加载音色失败 (' + r.status + ')');
      }
      const voices = await r.json();
      voices.sort((a, b) => a.ShortName.localeCompare(b.ShortName));
      voiceSelect.innerHTML = '';
      voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.ShortName;
        const label = CN_LABELS[v.ShortName];
        const oaNames = EDGE_TO_OPENAI[v.ShortName];
        if (oaNames && oaNames.length) {
          opt.textContent = (label || v.ShortName) + ' [' + oaNames.join(' / ') + '] (' + v.ShortName + ')';
        } else {
          opt.textContent = label ? (label + ' (' + v.ShortName + ')') : (v.ShortName + ' (' + v.Gender + ')');
        }
        if (v.ShortName === 'zh-CN-XiaoxiaoNeural') opt.selected = true;
        voiceSelect.appendChild(opt);
      });
      if (errorEl.textContent === '请输入有效的 API Key') {
        errorEl.textContent = '';
      }
    } catch {
      voiceSelect.innerHTML = '<option value="">加载音色失败</option>';
    }
  }

  loadVoicesBtn.addEventListener('click', loadVoices);
  apiKeyInput.addEventListener('change', loadVoices);
  loadVoices();

  async function synthesize() {
    const text = document.getElementById('text').value.trim();
    if (!text) return;
    if (activeController) {
      activeController.abort();
    }
    const controller = new AbortController();
    activeController = controller;

    errorEl.textContent = '';
    playBtn.disabled = true;
    playBtn.textContent = '正在合成...';
    try {
      const res = await fetch('/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        signal: controller.signal,
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
        let msg = '请求失败 (' + res.status + ')';
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
        throw new Error('未返回音频数据');
      }
      if (lastAudioUrl) {
        URL.revokeObjectURL(lastAudioUrl);
      }
      lastAudioUrl = URL.createObjectURL(blob);
      audioEl.src = lastAudioUrl;
      audioEl.style.display = 'block';
      await audioEl.play().catch((err) => {
        throw new Error('播放失败: ' + (err?.message || err));
      });
    } catch (e) {
      if (e?.name !== 'AbortError') {
        errorEl.textContent = e.message;
      }
    } finally {
      if (activeController === controller) {
        activeController = null;
        playBtn.disabled = false;
        playBtn.textContent = '试听';
      }
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

  const wsAbort = new AbortController();

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

      const voice = selectVoice(msg.voice, msg.gender);
      const speed = Math.min(2, Math.max(0.5, msg.speed ?? 1.0));
      const rateValue = Math.round((speed - 1) * 100);
      const rate = rateValue >= 0 ? `+${rateValue}%` : `${rateValue}%`;

      try {
        if (!hasSpeakableText(input)) {
          server.send(SILENT_MP3);
        } else {
          for await (const chunk of splitText(input)) {
            for await (const audioData of ttsChunkWithRetry(chunk, voice, rate, wsAbort.signal)) {
              server.send(audioData);
            }
          }
        }
        server.send(JSON.stringify({ event: "done" }));
      } catch (e: any) {
        server.send(JSON.stringify({ event: "error", message: e?.message || "Unknown error" }));
      }
    };
    ctx.waitUntil(handle());
  });

  server.addEventListener("close", () => {
    wsAbort.abort();
    server.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && request.method === "GET") {
      return handleIndex();
    }

    if (path.endsWith("/audio/speech") && request.method === "POST") {
      return handleSpeech(request, env);
    }

    if (path.endsWith("/models") && request.method === "GET") {
      return handleModels(request, env);
    }

    if (path.endsWith("/voices") && request.method === "GET") {
      return handleVoices(request, env);
    }

    if (path === "/v1/ws" || path === "/ws") {
      return handleWebSocket(request, env, _ctx);
    }

    return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  },
} satisfies ExportedHandler<Env>;
