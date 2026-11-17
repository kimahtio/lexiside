# LexiSide API 配置说明

## 发音配置

- `pronunciationSource`：`deepseek` 或 `system`，默认 `deepseek`。
- `ttsVoice`：`stella`（女声）或 `tide`（男声），默认 `stella`。

DeepSeek 发音使用官方 `POST /v1/tools/tts`，复用同一个 API Key 和 Base URL。
音频按 DeepSeek 官方计费规则按字符计费；插件只在内存中缓存本次会话的音频，
不会写入 `data.json`。DeepSeek TTS 失败时会自动回退到系统语音。

## 学习配置

- `targetLanguage`：固定为 `en`。
- `explanationLanguage`：当前为 `zh-CN`。
- `learnerLevel`：`beginner` / `intermediate` / `advanced`，影响英语定义复杂度。
- `explanationDepth`：`concise` / `standard` / `detailed`，影响措辞长度，不改变 JSON schema。

这些字段会进入 Prompt 和缓存键，因此切换学习配置会重新生成，而不会命中旧配置缓存。

## 默认 DeepSeek 配置

| 字段 | 默认值 |
| --- | --- |
| Provider | `deepseek` |
| API key | 空（必须填写） |
| API Base URL | `https://api.deepseek.com` |
| Model | `deepseek-flash` |
| Temperature | `0.3` |
| Maximum tokens | `1800` |
| Timeout | `60` 秒 |
| Stream responses | 开启 |
| DeepSeek V4 thinking | 关闭 |

当前 DeepSeek 官方模型（2026-11）：

| 模型 ID | 模型版本 | 说明 |
| --- | --- | --- |
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 默认推荐；速度快、价格低 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 更强、更贵 |

`deepseek-chat` 是 DeepSeek-V3/V3.1 时代的 API 模型名，当前官方文档已不再列出。LexiSide 会在从旧版本升级、Base URL 为官方 `api.deepseek.com`、且模型为 `deepseek-chat` 时，一次性迁移为 `deepseek-flash`。自定义 Base URL 的模型设置不会被迁移改写。

配置步骤：

1. 在 DeepSeek 控制台创建 API Key。
2. Obsidian → Settings → Community plugins → LexiSide。
3. 将 Key 粘贴到 **API key**。字段默认以密码形式显示。
4. 保存是自动的；修改后稍等片刻或关闭设置页即可落盘。
5. 回到笔记，选中英文单词测试。

DeepSeek 官方文档通常使用 `https://api.deepseek.com`，也支持带 `/v1` 的写法。LexiSide 会自动补上 `/chat/completions`。

### DeepSeek V4 思考模式

因为 `deepseek-flash` / `deepseek-v4-pro` 在 DeepSeek 官方 API 上默认开启思考模式，LexiSide 默认会发送：

```json
{ "thinking": { "type": "disabled" } }
```

这样做是为了让查词更快、消耗更少 token，并降低 JSON 被思考内容挤占后截断的概率。

- 设置页中的 **DeepSeek V4 thinking** 可以改为开启。
- 开启后会生成思考 token，可能明显变慢；建议同时提高 Maximum Tokens（例如 4096 或更高）和 Timeout。
- 该字段只会发送给 `https://api.deepseek.com` 上的 `deepseek-flash` 和 `deepseek-v4-pro`。
- 自定义 Base URL / 本地兼容端点不会收到 `thinking` 字段，以免破坏只实现标准 OpenAI Chat Completions 的服务。
- 如果使用 `deepseek-chat` 旧别名，LexiSide 不会发送 `thinking` 字段。

## Ollama 本地模型

1. 安装并启动 Ollama，拉取至少一个模型，例如 `ollama pull qwen3.5:4b`。
2. 在 LexiSide 设置中把 **Provider** 改为 **Ollama (local)**。
3. Base URL 保持 `http://127.0.0.1:11434/v1`，API Key 留空。
4. 在 **Ollama model** 下拉框中选择已安装模型，或点击刷新。

Ollama 模式的行为：

- 通过 `GET http://127.0.0.1:11434/api/tags` 读取本地模型列表。
- 请求发往 OpenAI 兼容的 `POST /v1/chat/completions`。
- 不发送 API Key；即使 `data.json` 中保留了 DeepSeek Key，也不会转发给 Ollama。
- **Disable local reasoning** 默认开启，发送 `"reasoning_effort": "none"`。这对 `qwen3.5:4b` 等思考模型必要，否则思考内容会耗尽输出 token，正文返回空。
- Ollama 不支持 `response_format` 时会自动降级重试。

## 自定义 OpenAI 兼容接口

填写：

- **API Base URL**：例如 `https://api.openai.com/v1`、`https://your-gateway.example.com/v1`
- **Model**：服务端实际接受的模型 ID，例如 `gpt-4.1-mini`、`qwen-plus`、`llama3.1`
- **API Key**：若服务不要求鉴权可留空
- **DeepSeek V4 thinking**：对自定义端点不生效，也不会发送该字段

URL 规则：

| 填写 | 实际请求 |
| --- | --- |
| `https://api.deepseek.com` | `https://api.deepseek.com/chat/completions` |
| `https://api.deepseek.com/v1` | `https://api.deepseek.com/v1/chat/completions` |
| `https://host/v1/chat/completions` | 保持不变 |
| `api.deepseek.com` | 自动补全为 `https://api.deepseek.com/chat/completions` |
| `http://localhost:1234/v1` | `http://localhost:1234/v1/chat/completions` |

仅允许 `http://` 和 `https://`。不允许把用户名/密码写在 URL 中；请使用 API Key 字段。

### 兼容性行为

1. **JSON mode**：LexiSide 默认发送 `response_format: { "type": "json_object" }`。部分兼容服务不支持此字段；若服务返回的状态码为 400/422，且错误信息提到 `response_format` / `json_object` / `json mode`，LexiSide 会自动去掉该字段重试一次。
2. **Streaming**：开启后会发送 `stream: true` 并解析 SSE，已完整生成的字段会渐进显示。如果代理不支持 SSE，可在设置中关闭 **Stream responses**。关闭后仍使用 Fetch + AbortController，但只能等完整响应后显示。
3. **JSON 字段**：渐进预览只接收已完成并通过类型检查的字段；最终整体 JSON 仍需通过严格 schema 校验。校验失败会显示可重试错误，不会把预览当作成功结果。`requestUrl` fallback 是非流式传输，因此没有渐进显示。
4. **CORS**：首先使用 Fetch。Fetch 失败时会自动使用 Obsidian 官方 `requestUrl` fallback，绕过部分 CORS 限制。若两种传输都失败，请检查代理、Base URL 或服务端跨域策略。

## 超时、Token 与成本

- **Timeout**：整个请求（包括流式响应接收）的总时限，单位秒，范围 5–300 秒。
- **Maximum tokens**：响应输出上限；不是上下文长度。JSON 被截断时会显示 `finish_reason: length` 相关错误，适当增大该值。
- 每次自动选词通常只会发一次请求；相同上下文和模型会优先使用本地缓存。切换模型、手动 Regenerate 或清空缓存才会重新请求。
- 建议先用较短文章和小额度 Key 测试。

## 错误信息对照

| 提示 | 常见原因 | 处理 |
| --- | --- | --- |
| Authentication failed (HTTP 401/403) | API Key 错误、过期或权限不足 | 重新复制 Key；确认没有多余空格 |
| Insufficient balance (HTTP 402) | 账户余额不足 | 充值或更换 Key |
| Endpoint/model not found (HTTP 404) | Base URL 或模型名错误 | 检查 URL 结尾和 Model |
| HTTP 400 | 请求字段不被服务支持 | 查看展开的技术详情；关闭 Streaming 后重试 |
| HTTP 429 | 限流 | 等待后重试 |
| HTTP 5xx | 服务端故障 | 稍后重试 |
| Timeout | 网络慢、代理问题或服务未响应 | 增大 Timeout；检查网络 |
| Could not reach the API with either Obsidian transport | DNS/代理/CORS/本地服务未启动 | 检查 Base URL、网络、代理和 CORS |
| JSON schema 校验失败 | 模型没有按固定结构输出 | 点 Try again；换更遵循 JSON 指令的模型 |

错误详情中不会包含 API Key。LexiSide 不把请求头、API Key 或密钥片段写入日志。

## API Key 安全

LexiSide 的安全设计：

- Key 存于 `.obsidian/plugins/lexiside/data.json`。
- Key 不会写入 Markdown、Markdown 导出或 Anki CSV。
- Key 不会出现在插件日志中。
- API 错误详情在渲染前会脱敏。
- Key 只作为 `Authorization: Bearer ...` 请求头发往你配置的 Base URL。
- API Key 字段使用密码输入框，点击眼睛图标可临时显示。

必须了解的边界：

- Obsidian 插件数据不是操作系统钥匙串，也不是加密存储。拥有 vault/插件文件夹访问权的其他插件或程序可以读取 `data.json`。
- 如果使用第三方中转服务，你的文本和 Key 会发送给该服务。请只使用可信端点。
- 不要把 `data.json` 提交到 Git，不要把含 Key 的文件分享给他人。
- 建议使用单独的、可撤销、有限额的 API Key。

## 提示词与发送内容

每次请求会发送：

- 系统提示词（英语教学助手、上下文优先、固定字段要求）。
- 目标单词或短语。
- 完整句子。
- 句子前后有限上下文。
- 来源笔记名称（仅名称，不发送整个 vault）。

不会自动发送其他笔记、文件路径树或 API Key 以外的本地设置。注意：原文内容本身可能包含敏感信息；在私有笔记中选词时，该段上下文会按上述说明发往 API。

## 支持的接口

- `POST {Base URL}/chat/completions`
- 标准 `choices[0].message.content` JSON 响应
- 标准 OpenAI SSE：`data: {...}` / `data: [DONE]`
- `Authorization: Bearer <key>`（Key 为空时不发送）

不支持的接口：`/responses`、`/completions`、非 OpenAI 兼容的自定义协议、需要 OAuth 交互式登录的接口。

