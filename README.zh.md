# dsh Codex

[English](README.md) | 中文

通过 OpenAI Codex 登录流程，在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用 ChatGPT 订阅：无需 OpenAI Platform API Key，也无需修改 dsh 源码。

`dsh-codex` 是一个独立的 dsh bundle，提供：

- 在 dsh 设置面板或独立 CLI 中完成 ChatGPT OAuth 登录，并自动刷新 token
- Codex GPT 模型目录；账号提供视觉模型时自动声明其图片输入能力
- 经标准 LLM 服务运行的流式响应、工具调用、推理回放、提示词缓存与 dsh 压缩
- 通过 dsh 现有 `web_search` 工具使用 Codex 独立联网搜索
- 可读取本地路径或 HTTP(S) 图片 URL 的 `view_image` 工具
- 由 `gpt-image-2` 执行的 `imagegen` 工具，支持工作区／会话参考图和自动工作区输出
- 复用 dsh Web 输入框的粘贴和拖放图片能力

ChatGPT 订阅认证与按量计费的 OpenAI API 是不同产品。本插件只使用 ChatGPT Codex 后端，不会把订阅转换成通用 OpenAI API 凭据。

## 安装

从 npm 把预构建 bundle 安装到选定的 dsh profile：

```sh
dsh plugin --profile web add dsh-codex
dsh web
```

从 DeepSeek Harness 源码 checkout 运行时，使用 `pnpm dsh plugin --profile web add dsh-codex`。开发插件时仍可用 `link:/absolute/path/to/dsh-codex` 安装本地 checkout。

打开 **设置 → OpenAI Codex → 使用 ChatGPT 登录**。插件会打开 OpenAI 授权页面，并通过 localhost 回调完成登录。账号页面会显示实时 Codex 额度进度条与精确剩余百分比；只有账号接口提供信用余额或工作区限额时，才会一并显示精确数值。

终端和无界面环境仍可使用 CLI：

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex login --device-code
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

Codex、Claude Code 及其他自动化 agent 应直接遵循 [INSTALL.md](INSTALL.md)。它是一份完整且可重复执行的 runbook，不要求安装者阅读源码或设计文档。

bundle 会为新建 agent 选择 `openai-codex` / `gpt-5.6-sol`，并选择 Codex 搜索提供方。dsh settings 中已经保存的模型仍然优先；模型选择器可以切换到当前账号可用的其他 Codex 模型。

## 图片

图片功能使用 dsh 的持久附件路径：

- 在 Web 输入框中按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴图片，或把图片拖入输入框；
- 让模型调用 `view_image`，把 `source` 设为本地绝对／相对路径或 HTTP(S) URL；
- 在当前 dsh 附件限制内支持 PNG、JPEG、WebP 与 GIF；
- 只有明确声明支持图片输入的模型才能接收图片。

任何支持视觉输入的当前对话模型都可以使用 `imagegen`。当前模型只需编写普通提示词，并在 `referenced_image_paths` 与 `num_last_images_to_include` 中选择一种参考图来源；插件从 `ctx.fs` 或附件存储读取字节，再发送给 `gpt-image-2`。模型不会输出 base64。每个结果都会直接显示在对话中、保存为持久附件，并写入当前工作区。`output_path` 用来指定位置；省略时会创建唯一的 `generated-<时间戳>-<id>.png` 文件。本地保存能力包含在本插件中；当工作区由 `dsh-remote-ssh` 管理时，远程插件负责 AHP 写入路径。

设置页提供独立的 **允许其他模型使用 View Image** 与 **允许其他模型使用生图** 开关，默认均为开启。关闭某一项后，`openai-codex` 视觉模型仍可使用该工具，其他模型提供方的调用会在执行入口被拒绝。

工具在返回实际图片块之前，会先验证图片并把字节持久化为 dsh 附件。本地路径经过已配置的文件系统服务；远程重定向次数受限，URL 中也不允许嵌入凭据。

## 搜索

提供方会把 dsh 的 `web_search` 工具连接到 Codex 使用的独立搜索协议。搜索结果是普通 dsh 文本和 HTTP(S) 引用，因此后续轮次与压缩会保留同一份工具历史。

在 profile patch 中配置 `llm-openai-codex`：

```yaml
- id: llm-openai-codex
  config:
    searchMode: live
    searchContextSize: medium
```

| 字段 | 默认值 | 可选值 |
|---|---:|---|
| `searchModel` | `gpt-5.6-sol` | Codex 模型 id |
| `searchMode` | `cached` | `cached`、`indexed`、`live` |
| `searchContextSize` | `medium` | `low`、`medium`、`high` |
| `searchMaxOutputTokens` | `10000` | 正整数 |

每个已经解析默认值且不含凭据的辅助请求，都会在发送前记录为专用的 `web/openai-codex-search-llm-request` 会话事件。该事件由本插件拥有并注册，不需要通用搜索事件或 dsh fork。

## 凭据与隐私

dsh 登录与 Codex CLI／Desktop 相互独立：

- 凭据存储于 `$DSH_HOME/.openai-codex-auth.json`，默认位于 `~/.dsh`；
- 文件原子写入，token 刷新会在本地 dsh 进程之间加锁；
- 浏览器状态和诊断不会返回 token 值；
- 绝不复制或修改 `~/.codex/auth.json`。

分离存储可以避免两个客户端竞争同一个会轮换的 refresh token。移除 bundle 不会删除凭据；需要移除本地账号时，请使用账号页面或 `logout` 命令。

## 兼容性说明

- 插件只使用已发布的 dsh 插件表层，不要求修改版 Harness checkout。单独安装时即可生成附件并保存本地输出。
- ChatGPT 套餐资格、模型权限、配额及后端行为由 OpenAI 控制，可能发生变化。
- Codex 端点不执行普通 Responses 的 `max_output_tokens` 字段。压缩可以工作，但该路由无法在服务端落实配置的摘要上限。
- 文件系统、shell、skills、MCP、subagents、权限、附件、压缩和 `web_search` 工具本身仍来自当前 dsh profile。
- 独立搜索端点不是公开的 OpenAI Platform API；兼容性取决于固定版本的 Codex／pi-ai 实现。

协议、持久化与生命周期细节见[设计文档](docs/design.zh.md)。

## 开发

```sh
pnpm install
pnpm run check
```

该检查会执行严格的 Host 与浏览器 TypeScript 检查、聚焦测试以及两个运行时 bundle 的构建。

## 许可证

Apache-2.0
