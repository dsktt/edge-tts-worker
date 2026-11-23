# edge-tts-worker

Deploy Microsoft Edge TTS as an OpenAI-compatible API on your own Cloudflare account. Free.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sofish/edge-tts-worker)

## 中文说明

将微软 Edge TTS 部署到 Cloudflare Workers，提供免费、兼容 OpenAI 协议的语音合成 API、WebSocket 流式接口以及自带网页测试界面。

- **主要接口**：
  - `GET /`：自带的网页试听测试页
  - `POST /v1/audio/speech`：OpenAI 兼容的 MP3 语音合成接口（不传 `voice` 时自动识别中/日/韩/英文音色）
  - `GET /v1/ws`：WebSocket 长连接流式合成接口，适合阅读器逐段连续播报
  - `GET /v1/voices`：获取可用音色列表
- **部署与鉴权**：
  - 本地手动部署：执行 `npm install && npx wrangler deploy`
  - 自动部署：推送到 `main` 分支后，可通过 Cloudflare Workers Builds 或 GitHub Actions（需配置 `CF_API_TOKEN` 与 `CF_ACCOUNT_ID` Secrets）自动发布
  - 可选鉴权：运行 `npx wrangler secret put API_KEY` 设置密钥（设置后接口需传 `Authorization: Bearer <key>`，WebSocket 需带 `?token=<key>`；注意自带网页测试页未传鉴权头）
- **使用提示**：
  - 已适配微软新版 `Sec-MS-GEC` v2 鉴权（见 `src/drm.ts`）；若未来微软再次调整接口或浏览器版本，需同步更新 `CHROMIUM_FULL_VERSION`
  - 若在国内访问默认 `*.workers.dev` 域名不稳定，建议在 Cloudflare Worker 中绑定自定义域名

## Deploy

```bash
npm install
npx wrangler deploy
```

Optionally set an API key to protect your endpoint:

```bash
npx wrangler secret put API_KEY
```

## API

### `POST /v1/audio/speech`

OpenAI-compatible text-to-speech endpoint.

```bash
curl -X POST https://your-worker.workers.dev/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "Hello, world!",
    "voice": "en-US-EmmaMultilingualNeural",
    "speed": 1.0,
    "response_format": "mp3"
  }' \
  --output speech.mp3
```

| Parameter | Description | Default |
|---|---|---|
| `model` | Ignored (accepted for compatibility) | — |
| `input` | Text to synthesize (required) | — |
| `voice` | Edge TTS voice name (auto-detected if omitted) | auto |
| `gender` | `"female"` or `"male"` (used when `voice` is omitted) | `female` |
| `speed` | Speech rate, 0.5–2.0 | `1.0` |
| `response_format` | Only `mp3` supported | `mp3` |

If `voice` is omitted, it auto-detects the language from the input text:

| Language | Female | Male |
|---|---|---|
| Chinese | `zh-CN-XiaoxiaoNeural` | `zh-CN-YunxiNeural` |
| Japanese | `ja-JP-NanamiNeural` | `ja-JP-KeitaNeural` |
| Korean | `ko-KR-SunHiNeural` | `ko-KR-InJoonNeural` |
| English / other | `en-US-EmmaMultilingualNeural` | `en-US-AndrewMultilingualNeural` |

If `API_KEY` is set, include `Authorization: Bearer <key>` header.

### `GET /v1/ws`

WebSocket endpoint for reading apps. Keeps a persistent connection for sequential TTS requests.

```
wss://your-worker.workers.dev/v1/ws
```

If `API_KEY` is set, pass it as a query parameter: `wss://your-worker.workers.dev/v1/ws?token=<key>`

**Send** (JSON text message):

```json
{"input": "Text to read", "voice": "en-US-EmmaMultilingualNeural", "gender": "female", "speed": 1.0}
```

**Receive**:
- Binary messages — MP3 audio chunks, stream directly to your audio player
- `{"event": "done"}` — synthesis complete, safe to send next text
- `{"event": "error", "message": "..."}` — error occurred

**Reading app flow**: connect once → send paragraph → receive audio chunks → play → on `done`, send next paragraph → repeat.

### `GET /v1/voices`

Returns the list of available voices as JSON.

```bash
curl https://your-worker.workers.dev/v1/voices
```

### `GET /`

A minimal HTML test page with text input, voice selector, speed slider, and play button.

## Development

```bash
npm install
npm run dev
```

## Disclaimer

This project uses Microsoft's unofficial Edge TTS endpoint. There is no SLA or uptime guarantee. Use at your own risk.

## License

AGPL-3.0
