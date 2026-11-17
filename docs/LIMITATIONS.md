# LexiSide 已知限制

LexiSide 使用 Obsidian 的公共 API 和标准 Web API，不伪造能力。以下是当前版本（1.0.0）的真实限制。

## Word Map 与 Pele

- Word Map 优先使用 Obsidian 1.15+ 的 Pele 渲染器；直接 mount 路径是未公开 API，渲染失败时回退到 `MarkdownRenderer` 和文本关系列表。
- Pele 的原生节点回调不由插件控制；点击详情由插件自己的事件层实现。
- Word Map 会缩放到侧栏可用宽度，保证整图可见；窄栏下可拉宽侧栏以提升文字可读性。
- 正常渲染时不显示额外关系按钮列；只有 SVG 渲染失败时才显示文本关系按钮。
- SVG 节点没有原生键盘语义；屏幕阅读器可使用隐藏文本列表。
- 关系由本地从已验证知识派生，缺少依据的关系不会补造。
- 当前交互提供节点详情，不提供自动查询另一个单词。

## 数据与缓存

- 旧扁平词库读取时适配为 canonical 视图；只有编辑/保存某个旧词条时才把它写成 canonical。
- 旧缓存保留在 `data.json`，但 Prompt/Schema 升级后不会用于新查询。
- 缓存键包含上下文 hash、语言配置、模型、Prompt version 和知识 schema version；lemma 通过记录元数据/别名匹配。
- 迁移前的自动备份是 best-effort；安装流程还会额外保留 `data.backup-before-2.0.0.json`。

## 选区捕获

- **Obsidian 没有公开的 selection-change 事件。** 插件使用标准 `document.selectionchange` 作为触发信号，再通过公共 API 读取选区。这是当前可用的稳定方案。
- **Reading View 没有公开的“DOM 选区 → Markdown 源偏移”API。** 阅读视图中的原句和上下文来自渲染后的文本，可能已丢失 Markdown 标记或经过 Obsidian 渲染器转换。Editing View 中则来自 Markdown 源文本并会做内联 Markdown 清理。
- Reading View 中跨多个语义块的选区会被忽略，以避免把多个不相关段落拼成上下文。
- Reading View 代码块内的选区会被忽略。
- 脚本检测只能排除 CJK、西里尔、希腊、阿拉伯等文字；法语、西班牙语等使用拉丁字母的语言仍可能被当作英文触发。模型会根据上下文解释，但不会做严格语言识别。
- 单次只处理最多 8 个单词 / 80 个字符的选区。选中整句或段落会忽略。
- 弹出窗口（pop-out）中的选区监听已经实现，但未在完整 Obsidian GUI 中自动化验证。

## API 与网络

- 只支持 OpenAI 兼容的 `POST {BaseURL}/chat/completions`。不支持 `/responses`、`/completions`、Anthropic 原生 API 或其他协议。
- 主要传输使用浏览器 Fetch + `AbortController`。如果 CORS 或网络层阻止 Fetch，LexiSide 会自动用 Obsidian `requestUrl` 再试一次。
- **`requestUrl` fallback 不能真正取消底层网络请求。** 快速切换单词时，LexiSide 会通过 request epoch 丢弃旧结果，但服务端请求可能仍会完成并计费。
- 请求超时通过 AbortController 实现；对于 requestUrl fallback，只能通过 Promise race 让 UI 超时，底层网络请求仍可能继续。
- 自定义服务可能不支持 `response_format`；LexiSide 会在 400/422 且错误信息明确相关时去掉该字段自动重试一次。若服务以其他方式拒绝请求，需要用户调整服务设置。
- 自定义服务可能不支持 SSE，或返回非标准的流格式。此时请关闭 Stream responses。流式响应格式异常会显示错误，不会静默退回伪造结果。
- DeepSeek V4 默认开启思考模式；LexiSide 只会在官方 `api.deepseek.com` + `deepseek-flash`/`deepseek-v4-pro` 时发送显式的非思考/思考开关。自定义 Base URL 不会收到 DeepSeek 专有的 `thinking` 字段。
- 开启 DeepSeek 思考模式会明显增加延迟和 token 消耗；默认 Maximum Tokens 为 1800，可能不足以容纳思考内容加最终 JSON。需要时可提高 Maximum Tokens 和 Timeout。
- DeepSeek 的模型命名会更新。当前文档模型为 `deepseek-flash` / `deepseek-v4-pro`；历史模型名可能继续以未文档化别名运行，但不保证长期可用。
- 部分代理服务会改写 Base URL 路径、阻断 CORS 或忽略 JSON mode；这些都属于服务端限制。
- 非常大的单句（例如没有标点、上万字符的段落）可能超过模型上下文或输出限制。LexiSide 会按完整句子提取上下文，不会在没有提示的情况下静默截断主句；请缩短文本或手动选择较小的短语。

## 流式输出

- SSE 开启时，已完整生成并通过本地类型检查的字段会渐进显示，顶部保持 Generating 状态。
- 未结束的字符串、数组或对象不会显示；最终完整 JSON 仍需通过严格 schema 校验，失败时切换到错误面板。
- 渐进预览期间不显示保存、复制和重新生成操作，避免把未完成结果当作正式结果。
- 关闭 Stream responses、使用非 SSE 响应，或使用 `requestUrl` fallback 时，没有渐进显示，只能等待完整结果。
- 进度以已接收字符数表示，不代表 token 使用量。

## AI 内容

- 解释、例句、翻译、音标和语法建议均由配置的模型生成，可能存在错误或遗漏。
- 系统提示词要求模型不要编造，但无法从工程上保证模型完全不产生幻觉。
- 音标来自模型输出，不是本地词典查询。
- 发音使用操作系统语音合成（Web Speech API），可用性、音质和口音取决于 Windows 安装的语音包；不调用在线发音服务。
- 中文翻译以 Simplified Chinese 为目标，但模型偶尔可能输出繁体或混合表达。
- 模型在上下文不足时仍可能给出不够准确的答案；不确定性提示卡片已移除。
- 为缩短生成时间，输出被限制为紧凑结构：至多 3 个搭配、2 个近义词、2 个其他含义、2 个例句。它不会穷尽一个词的全部用法；需要更完整内容时可以重新生成或在词库中编辑。

## 存储与隐私

- API Key、缓存和词库均保存在 `.obsidian/plugins/lexiside/data.json`，不是加密保险箱。拥有 vault 文件访问权限的程序/插件可能读取。
- LexiSide 自身不会把 Key 写入 Markdown、日志或导出文件，但不能阻止其他拥有完整 vault 权限的插件读取 Obsidian 插件数据。
- 如果你使用 Obsidian Sync 或第三方同步工具，`data.json` 是否同步取决于工具设置；API Key 可能随之同步。
- 选中文本和上下文会发送至你配置的 API Base URL。自定义中转服务的隐私政策不由 LexiSide 控制。
- 不要在不信任的第三方中转服务中发送包含敏感信息的原文。

## 界面与平台

- 当前 manifest 将插件标记为桌面端（`isDesktopOnly: true`）。移动端未测试。
- 右侧面板是一个独立 ItemView，不是悬浮字典或内联弹窗。
- 词汇库为 modal，搜索结果和编辑器字段都已实现本地 CRUD；暂不支持拖拽排序或自动标签。
- 导出位置固定为 vault 根目录的 `LexiSide Exports/`，暂不支持自定义导出目录。
- Anki CSV 是三列无表头格式（Front/Back/Tags），Back 包含 HTML。导入时需启用 Allow HTML in fields。
- 自动打开侧栏时使用 `ensureSideLeaf(..., { active: false })` 尽量避免抢焦点；Obsidian 版本差异可能导致焦点行为不同，可在设置中关闭 Auto-open sidebar。

## 缓存

- 缓存键包含模型、Prompt version、知识 schema version、语言配置和上下文 hash。更换模型/配置后不会复用旧缓存；更换 API Key 不会使缓存失效。
- 缓存最多保留 500 条，超出后丢弃最旧写入的条目。
- 没有自动过期时间；用户可通过设置或命令 Clear cache 手动清空。
- 词库与缓存相互独立：删除缓存不会删除已收藏词条，删除词条也不会清除缓存。


