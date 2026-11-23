# edge-tts-worker

[English](./README.md) | **简体中文**

在自己的 Cloudflare 账号上部署微软 Edge TTS，提供免费且兼容 OpenAI 格式的语音合成 API。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sofish/edge-tts-worker)

## 部署

```bash
npm install
npx wrangler deploy
```

如需保护接口访问，可设置可选的 API 密钥：

```bash
npx wrangler secret put API_KEY
```

## API 接口

### `POST /v1/audio/speech`

兼容 OpenAI 格式的文本转语音接口。

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

| 参数 | 说明 | 默认值 |
|---|---|---|
| `model` | 忽略该字段（仅作接口兼容保留） | — |
| `input` | 需要合成语音的文本（必填） | — |
| `voice` | Edge TTS 音色名称（省略时自动检测语言） | 自动 |
| `gender` | `"female"`（女声）或 `"male"`（男声），仅在省略 `voice` 时生效 | `female` |
| `speed` | 语速，范围 0.5–2.0 | `1.0` |
| `response_format` | 仅支持 `mp3` | `mp3` |

如果未指定 `voice`，系统会根据输入文本自动识别语言并选择默认音色：

| 语言 | 女声 | 男声 |
|---|---|---|
| 中文 | `zh-CN-XiaoxiaoNeural` | `zh-CN-YunxiNeural` |
| 日语 | `ja-JP-NanamiNeural` | `ja-JP-KeitaNeural` |
| 韩语 | `ko-KR-SunHiNeural` | `ko-KR-InJoonNeural` |
| 英语 / 其他 | `en-US-EmmaMultilingualNeural` | `en-US-AndrewMultilingualNeural` |

如果设置了 `API_KEY`，请在请求头中附带 `Authorization: Bearer <key>`。

### `GET /v1/ws`

适用于阅读类应用的 WebSocket 接口，通过长连接顺序发送多个 TTS 合成请求。

```
wss://your-worker.workers.dev/v1/ws
```

如果设置了 `API_KEY`，请通过查询参数传入：`wss://your-worker.workers.dev/v1/ws?token=<key>`

**发送**（JSON 文本消息）：

```json
{"input": "Text to read", "voice": "en-US-EmmaMultilingualNeural", "gender": "female", "speed": 1.0}
```

**接收**：
- 二进制消息 — MP3 音频分片，可直接流式送入音频播放器
- `{"event": "done"}` — 当前文本合成完成，可继续发送下一段文本
- `{"event": "error", "message": "..."}` — 发生错误

**阅读应用调用流程**：建立一次连接 → 发送一段文本 → 接收音频分片并播放 → 收到 `done` 后发送下一段 → 循环直至结束。

### `GET /v1/voices`

以 JSON 格式返回可用音色列表。

```bash
curl https://your-worker.workers.dev/v1/voices
```

### `GET /`

提供一个简洁的 HTML 测试页面，包含文本输入框、音色选择器、语速滑块和播放按钮。

## 本地开发

```bash
npm install
npm run dev
```

## 注意事项

- 已适配微软新版 `Sec-MS-GEC` v2 鉴权（见 `src/drm.ts`）。若未来微软再次调整接口协议或浏览器版本要求，需同步更新 `CHROMIUM_FULL_VERSION`。
- 如果所在网络访问默认 `*.workers.dev` 域名不稳定或无法连接（例如部分国内网络环境），建议在 Cloudflare Worker 中绑定自定义域名。

## 免责声明

本项目使用的是微软非官方 Edge TTS 接口，不提供 SLA 或可用性保证，使用风险请自行承担。

## 许可证

AGPL-3.0
