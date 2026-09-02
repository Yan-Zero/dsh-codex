# dsh Codex

[English](README.md) | 中文

通过 OpenAI Codex 登录流程，在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用 ChatGPT 订阅：无需 OpenAI Platform API Key，也无需修改 dsh 源码。

`dsh-codex` 是一个独立的 dsh bundle，提供：

- 在 dsh 设置面板或独立 CLI 中完成 ChatGPT OAuth 登录，并自动刷新 token
- Codex GPT 模型目录；账号提供视觉模型时自动声明其图片输入能力
- 可实时覆盖 dsh 用于上下文用量显示与压缩策略的客户端窗口容量
- 经标准 LLM 服务运行的流式响应、工具调用、推理回放、提示词缓存与 dsh 压缩
- 通过 dsh 现有 `web_search` 工具使用 Codex 独立联网搜索
- 为 Harness 现有 `read_image` 工具增加可选的 HTTP(S) URL 输入
- 由 `gpt-image-2` 执行的 `imagegen` 工具，支持工作区／会话参考图和自动工作区输出
- 复用 dsh Web 输入框的粘贴和拖放图片能力
- 在 Web 输入框提供按会话生效的 Fast Mode 开关与紧凑的每周额度指示器

ChatGPT 订阅认证与按量计费的 OpenAI API 是不同产品。本插件只使用 ChatGPT Codex 后端，不会把订阅转换成通用 OpenAI API 凭据。

## 安装

从 npm 把预构建 bundle 安装到选定的 dsh profile：

```sh
dsh plugin --profile web add dsh-codex
dsh web
```

从 DeepSeek Harness 源码 checkout 运行时，使用 `pnpm dsh plugin --profile web add dsh-codex`。开发插件时仍可用 `link:/absolute/path/to/dsh-codex` 安装本地 checkout。

打开 **设置 → OpenAI Codex → 使用 ChatGPT 登录**。插件会打开 OpenAI 授权页面，并通过 localhost 回调完成登录。账号页面会显示实时 Codex 额度进度条与精确剩余百分比；只有账号接口提供信用余额或工作区限额时，才会一并显示精确数值。

回环地址上的 Web 页面会自动受信任。若 dsh 运行在另一台机器上，账号页面会显示需要在 dsh 主机执行的精确 origin 授权命令，例如 `dsh plugin --profile web exec dsh-openai-codex trust-origin http://host:port`。allowlist 按完整 origin 匹配，与 OAuth 凭据分开保存，并可通过 `trusted-origins` 和 `untrust-origin` 查看或撤销。

终端和无界面环境仍可使用 CLI：

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex login --device-code
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex doctor --json
dsh plugin --profile web exec dsh-openai-codex logout
```

在 `dsh-tui` 中使用时，把 bundle 安装到同一个 profile：

```sh
dsh plugin --profile dsh-tui add dsh-codex
```

重新启动 TUI 后，`/model` 会列出 `openai-codex` 的模型；没有显式模型配置或已保存选择时，TUI 会采用 bundle 注册的 `gpt-5.6-sol`。`/codex status|login|logout|usage|config` 用于管理账号与查看配置，四个布尔开关可通过 `/codex set <read-image|imagegen-other-models|websocket-context|native-compaction> <on|off>` 修改。浏览器登录完成后，凭据与 Web profile 共用同一份 dsh 凭据文件。

Codex、Claude Code 及其他自动化 agent 应直接遵循 [INSTALL.md](INSTALL.md)。它是一份完整且可重复执行的 runbook，不要求安装者阅读源码或设计文档。

bundle 会为新建 agent 选择 `openai-codex` / `gpt-5.6-sol`，并选择 Codex 搜索提供方。dsh settings 中已经保存的模型仍然优先；模型选择器可以切换到当前账号可用的其他 Codex 模型。

## 模型目录

默认情况下，模型选择器会展示完整的 `openai-codex` 目录。打开 **设置 → OpenAI Codex**，通过模型复选框选择需要显示的条目。该选择实时生效并持久保存；修改后 dsh 会刷新 Web 与 TUI 的模型目录。

也可以在 `llm-openai-codex` 条目上通过 `models` 设置初始子集，并保持提供方原有顺序：

```yaml
- id: llm-openai-codex
  config:
    models:
      - gpt-5.6-luna
      - gpt-5.6-sol
      - gpt-5.6-terra
```

复选框与 `models` 设置都只控制模型发现。现有会话已经保存或显式指定的隐藏模型仍可解析，因此收窄选择器不会破坏旧记录。省略 `models` 时初始展示完整目录；空列表表示不展示任何模型。

## 上下文窗口

打开 **设置 → OpenAI Codex → 上下文窗口**，可以用 K tokens 为单位覆盖客户端容量。例如输入 `512` 表示 512,000 tokens；留空会恢复各模型在 pi-ai 目录中的默认值。保存后的值会在下一次请求时应用到全部 Codex 模型，并显示在 `/codex config` 中；已打开会话的用量分母会在该请求后刷新。

也可以在初始配置中填写精确 token 数：

```yaml
- id: llm-openai-codex
  config:
    contextWindow: 512000
```

该功能在 Harness 一侧对应 Codex CLI 的 `model_context_window` 概念，不会向 Responses 端点发送上下文窗口字段。解析后的容量会直接控制 dsh 的上下文用量分母、溢出判断、输出 token 收缩和自动压缩阈值；较小的值会更早压缩。较大的值不会提高后端模型的真实容量，模型不支持时仍可能返回上下文溢出错误。

## 图片

图片功能使用 dsh 的持久附件路径：

- 在 Web 输入框中按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴图片，或把图片拖入输入框；
- 在 Windows 上的适配版 dsh-tui 按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴剪贴板图片，或输入 `@相对/图片.png`；剪贴板图片直接进入附件库，路径图片由当前 workspace 的文件系统读取；
- 让模型调用 `read_image`：工作区图片使用 `file_path`，HTTP(S) 图片使用 `url`；
- 在当前 dsh 附件限制内支持 PNG、JPEG、WebP 与 GIF；
- 只有明确声明支持图片输入的模型才能接收图片。

任何支持视觉输入的当前对话模型都可以使用 `imagegen`。当前模型只需编写普通提示词，并在 `referenced_image_paths` 与 `num_last_images_to_include` 中选择一种参考图来源；插件从 `ctx.fs` 或附件存储读取字节，再发送给 `gpt-image-2`。模型不会输出 base64。每个结果都会直接显示在对话中、保存为持久附件，并写入当前工作区。`output_path` 用来指定位置；省略时会创建唯一的 `generated-<时间戳>-<id>.png` 文件。本地保存能力包含在本插件中；当工作区由 `dsh-remote-ssh` 管理时，远程插件负责 AHP 写入路径。

设置页提供独立的 **增强 read_image** 与 **允许其他模型使用生图** 开关，默认均为开启。关闭第一项会撤销插件的 agent-scope 覆盖，恢复 Harness 原本只接受本地路径的 `read_image` Schema。关闭第二项后，Codex 视觉模型仍可使用 `imagegen`，其他模型提供方的调用会在执行入口被拒绝。

`read_image` 在返回实际图片块之前，会先验证图片并把字节持久化为 dsh 附件。本地路径原样委托给 Harness，继续沿用当前文件系统和沙箱行为；URL 扩展会限制重定向次数与下载字节数，拒绝内嵌凭据和本地／私网／特殊网络目标，并在每一跳把连接固定到已经验证的公网地址。

对符合条件的 Codex GPT 会话，Web 输入框还会显示仅对当前会话生效的 Fast Mode 开关。开启后只为该会话加入提供方的 priority service tier，不会修改已保存的模型设置；旁边的额度条显示对应的每周额度和提供方声明的重置时间。

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

## Responses API 实验功能

设置页提供两个默认关闭、仅作用于 `openai-codex` 的开关：

- **WebSocket 上下文复用**：保持 `store: false`，并选择 pi-ai 的 Codex WebSocket continuation 传输。同一会话继续复用连接，且下一轮与已有上下文严格衔接时，请求会通过 `previous_response_id` 只发送新增输入；历史改写、压缩、Fork、连接中断或进程重启后会自动发送完整上下文。关闭开关时，普通轮次使用 SSE，每次都发送 Harness 完整上下文。
- **原生 Responses 压缩**：按 Codex 当前的 V2 流程，把现有历史和一个 `compaction_trigger` item 发给 `codex/responses`。近期客户端消息与返回的加密 compaction item 会一起保存在 Harness 检查点中，并在后续 Codex 请求发送前还原；关闭开关不会破坏已经生成的检查点。V2 压缩不可用或请求失败时，同一次调用会自动回退到原来的 Harness 模型摘要。

两个开关互相独立。所有普通 Codex 请求都保持 `store: false`；默认配置使用 SSE 和 `dsh-compaction-basic` 的文本摘要路径。

## 凭据与隐私

dsh 登录与 Codex CLI／Desktop 相互独立：

- 凭据存储于 `$DSH_HOME/.openai-codex-auth.json`，默认位于 `~/.dsh`；
- 文件原子写入，token 刷新会在本地 dsh 进程之间加锁；
- 浏览器状态和诊断不会返回 token 值；
- 绝不复制或修改 `~/.codex/auth.json`。

分离存储可以避免两个客户端竞争同一个会轮换的 refresh token。移除 bundle 不会删除凭据；需要移除本地账号时，请使用账号页面或 `logout` 命令。

## 兼容性说明

- 本分支面向已发布的 DSH `0.1.1-rc.2` 插件表层，并兼容开发中的 `0.1.2-alpha.2` settings API；同时使用 `@earendil-works/pi-ai` `0.84.4`。adapter 会在读取历史时迁移旧版 pi-ai replay envelope，因此升级后已有 reasoning／tool 元数据仍可继续使用。
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
