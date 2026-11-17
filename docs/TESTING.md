# LexiSide 测试

## 自动化检查

```powershell
npm run typecheck
npm test
node esbuild.config.mjs production
node --check main.js
```

当前结果：

- TypeScript strict 检查通过
- 单元测试 **81/81 通过**
- esbuild 生产打包通过
- `data.json` 不写入、不覆盖

## 测试范围

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/text.test.mjs` | 英文选区清洗、非英文过滤、长度限制、上下文提取 |
| `tests/selection.test.mjs` | Reading View 选区快照、句子 Range、上下文 |
| `tests/parsing.test.mjs` | JSON 对象提取、Canonical 校验、Prompt 契约 |
| `tests/knowledge.test.mjs` | Canonical Schema、Legacy 适配、编辑器回写 |
| `tests/generation.test.mjs` | 生成输入、语言/难度 profile |
| `tests/api.test.mjs` | 认证头、SSE、超时、取消、CORS fallback、JSON mode 降级 |
| `tests/ollama.test.mjs` | Ollama tags URL、模型名解析 |
| `tests/storage.test.mjs` | 设置、缓存、词库、导出、Ollama provider |
| `tests/word-map.test.mjs` | 关系派生、Mermaid 生成、节点限制 |
| `tests/anki.test.mjs` | AnkiConnect 请求、错误、deck 创建、标签 |

## 手动验收

建议使用测试 vault：

1. Reading View 选中英文单词，确认侧栏生成结果
2. 点击侧栏原文块，确认回到源笔记原位置
3. 切换 Ollama provider，确认模型列表和生成
4. 添加/删除词库、复制、导出、Anki 同步
5. 重启 Obsidian，确认设置和 `data.json` 保留

真实 DeepSeek/Ollama 生成未纳入自动化测试；协议层由 mock 覆盖。
