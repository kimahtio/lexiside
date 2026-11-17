# LexiSide 安装说明

## 环境要求

- 桌面版 Obsidian 1.15.0 或更新版本
- 一个可用的模型服务：
  - DeepSeek API
  - 本地 Ollama
  - 任意 OpenAI 兼容的 `/chat/completions` 服务
- 从源码构建时需要 Node.js 22.18+ 和 npm

## 安装已构建版本

发布包 `release/lexiside-1.0.0.zip` 只包含运行时需要的三个文件：

```text
main.js
manifest.json
styles.css
```

复制到：

```text
<vault>/.obsidian/plugins/lexiside/
```

然后重启 Obsidian，在 **设置 → 社区插件** 中启用 LexiSide。

### 使用安装脚本

```powershell
.\install.ps1 -VaultPath "D:\Obsidian Vault"
```

脚本只覆盖 `main.js`、`manifest.json` 和 `styles.css`，不会改动 `data.json`。

## 更新插件

1. 取得新版的三个运行时文件
2. 覆盖 `.obsidian/plugins/lexiside/` 中的同名文件
3. 重启 Obsidian

`data.json` 保存 API Key、设置、缓存和词库，升级时不要删除或覆盖。

## 配置模型

打开 **设置 → LexiSide → API**：

- **DeepSeek**：填写 API Key，Base URL 保持 `https://api.deepseek.com`
- **Ollama（本地）**：Base URL 保持 `http://127.0.0.1:11434/v1`，API Key 留空
- **自定义端点**：填写兼容 OpenAI Chat Completions 的 Base URL 和模型名

Ollama 模式需要本机已运行 Ollama，并至少执行过一次：

```powershell
ollama pull qwen3.5:4b
```

在设置页选择已安装模型。思考型本地模型建议保持 **Disable local reasoning** 开启。

## 数据与卸载

- `data.json` 只存在于插件目录内。
- 卸载插件不会自动删除词库、缓存或 API Key。
- 完全清除数据需要删除整个 `lexiside/` 插件目录。
