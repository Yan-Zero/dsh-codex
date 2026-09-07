# dsh Codex

[English](README.md) | 中文 | [AI 部署契约](README.ai.md)

> [!IMPORTANT]
> 本仓库是 [Yan-Zero/dsh-codex](https://github.com/Yan-Zero/dsh-codex) 的公开增强 fork，依赖其上游代码，并保留相同的包名、provider ID、OAuth 存储和路由。请用本增强版**替代安装** upstream `dsh-codex`；不要在同一个 dsh profile 中同时安装两份。

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
- 持久化、provider-neutral 的 SQLite Usage Ledger，由当前 session HUD 与设置页 **LLM Usage** 共用
- Provider／时间／精确模型／Reasoning 筛选、Task／Session 明细以及不含账户额度的 JSON 报告
- 在 Web 输入框提供按会话生效的 Fast Mode 开关与紧凑的每周额度指示器
- 可选择仅 Codex 或整个进程范围的三态 HTTP(S) 代理设置

ChatGPT 订阅认证与按量计费的 OpenAI API 是不同产品。本插件只使用 ChatGPT Codex 后端，不会把订阅转换成通用 OpenAI API 凭据。

**LLM Usage** 只统计 DSH 标准化流为当前 session 返回的 token，不查询账户余额或厂商额度。适配器返回哪些字段，就分别记录未缓存输入、缓存输入、输出、推理和总 token。当前已覆盖 DeepSeek、OpenCode Go、Kimi；其他能够发出 DSH 标准 usage chunk 的适配器也会自动纳入统计。Provider、模型与思考程度仍从用户已有的 DSH 模型配置中读取。

OpenAI Codex 的账户额度仍单独保留在账号页面和 `/codex usage`，不会混入 session token Analytics。


## 多账号

在 DSH 的 **设置 → OpenAI Codex → 账号管理** 中，为每个账号填写名称并点击“添加账号”，再使用页面原有的浏览器登录或设备码登录。已有登录保留为“默认账号”，不需要重新登录。账号列表可选择当前使用的账号，也可修改名称；退出登录只影响当前账号。

“额度耗尽时自动切换账号”默认关闭。关闭时，Codex 模型请求使用手动选中的账号。开启后，仅在当前请求尚未输出内容、且服务端明确返回额度耗尽时，按添加顺序尝试其他已登录账号，每个账号最多一次；成功后更新当前选择。普通限流、网络错误、登录失效和已输出内容的请求不会自动切换。所有账号都不可用时保留错误，不无限重试。在请求期间手动选其他账号或关闭开关，会停止后续自动尝试。

设置对使用同一凭证配置的 DSH 实例生效，新请求使用当前选择，已开始的请求固定原账号。搜索、图像工具和配额查询跟随当前选择；自动重试适用于 Codex 模型请求。各账号的登录与配额缓存独立保存；本地 token 历史仍按 provider 汇总。新增账号需要你分别完成 OAuth 授权，名称本身不代表已登录。

含 Codex 原生压缩记录的会话绑定原账号，不能自动跨账号迁移；此时会提示切回原账号或新建会话。普通可见会话历史可随请求切换，账号专属私有 replay 不会交给其他账号。

默认凭证文件保持原位。账号名称和选择保存在凭证文件旁的 `.accounts.json`，新增凭证保存在 `.accounts/` 目录，使用 owner-only 权限；最多可保存 20 个命名账号。不要将这些凭证目录提交到 Git。

## 安装

把预构建的 `v0.3.0` Release 包安装到选定的 dsh profile：

```sh
dsh plugin --profile web add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
dsh web
```

这个 GitHub Release 是 Analytics 增强版的权威发行物。npm 上的 `dsh-codex@0.2.3` 是 upstream 基础版，不包含本 fork 完整的 Usage Ledger 与 Analytics UI。

从 DeepSeek Harness 源码 checkout 运行时，在同一条命令前加 `pnpm`：

```sh
pnpm dsh plugin --profile web add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
```

本地 checkout 可先运行 `pnpm install && pnpm run build`，再用 `link:/absolute/path/to/dsh-codex` 安装。

打开 **设置 → OpenAI Codex**，选择登录方式。dsh-web 运行在 SSH 主机上时，推荐点击 **使用设备码登录**：在任意已登录 ChatGPT 的设备上打开页面中显示的授权网址，输入一次性代码，并保持 dsh 页面开启，直到它显示登录成功。**浏览器回调登录** 仍适用于本机浏览器，通过 localhost 回调完成授权。切换登录方式时，插件会取消另一种方式中卡住的登录任务。

账号页面只按 OpenAI 服务端实际返回的精度显示 Codex 额度进度；不会反推 Credit denominator，也不会显示拿不到的 Credit 值。

终端和无界面环境仍可使用 CLI：

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex login --device-code
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

在 `dsh-tui` 中使用时，把 bundle 安装到同一个 profile：

```sh
dsh plugin --profile dsh-tui add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
```

重新启动 TUI 后，`/model` 会列出 `openai-codex` 的模型；没有显式模型配置或已保存选择时，TUI 会采用 bundle 注册的 `gpt-5.6-sol`。`/codex status|login|logout|usage|config` 用于管理账号与查看配置，四个布尔开关可通过 `/codex set <read-image|imagegen-other-models|websocket-context|native-compaction> <on|off>` 修改，推理摘要详细度则使用 `/codex set reasoning-summary <auto|concise|detailed>`。浏览器登录完成后，凭据与 Web profile 共用同一份 dsh 凭据文件。

Codex、Claude Code 及其他自动化 agent 应直接遵循 [README.ai.md](README.ai.md)。它是紧凑、可重复执行的部署契约，不要求读取源码或设计文档。

bundle 会为新建 agent 选择 `openai-codex` / `gpt-5.6-sol`，并选择 Codex 搜索提供方。dsh settings 中已经保存的模型仍然优先；模型选择器可以切换到当前账号可用的其他 Codex 模型。

## 推理摘要

OpenAI 不会公开模型私有的原始 reasoning tokens。模型支持时，本插件会把提供方生成的推理摘要流式写入 dsh 可折叠的 **Think** 区块。你可以选择 **设置 → OpenAI Codex → 推理摘要 → 详细**，或在 profile 的 `llm-openai-codex` 配置中设置 `reasoningSummary: detailed`，请求尽可能明确的解释。具体返回内容仍由提供方决定，因此 `detailed` 也可能很短，且不能据此还原隐藏思维链。`auto` 是兼容性默认值，目前会选择该模型可用的最详细摘要器。
插件会读取 Codex CLI/Desktop 的 `models_cache.json`，补充 pi-ai 尚未收录的新模型，并使用缓存中的名称、输入能力、推理档位和默认 `context_window`。查找顺序为 `DSH_CODEX_MODELS_CACHE` 指定的文件、`CODEX_HOME/models_cache.json`、`~/.codex/models_cache.json`。只导入 `visibility: list` 的有效条目；缓存中声明的最大可扩展窗口不会自动替换默认容量。

缓存由 Codex CLI/Desktop 刷新；模型发现只读取模型元数据，不依赖启动 Codex 子进程。除非显式配置 `credentialFile`（见下文），OAuth 登录仍相互独立。更新 Codex 并打开一次后，再打开插件模型设置或刷新模型列表即可发现变化。缓存缺失、损坏或正在写入时保留最近可用目录；首次启动没有缓存时使用随包目录（含 GPT-6 Astra）。目录元数据不保证当前 dsh 登录账号拥有相应模型权限。

已保存的模型选择会保留。新增模型可以在下面的设置中启用；缓存暂时不可用不会删除已保存的模型 ID。新发现模型若没有随包价格信息，用量价格估算为 0，不能把它理解为该模型免费。

默认情况下，模型选择器会展示完整的 `openai-codex` 目录。打开 **设置 → OpenAI Codex**，通过模型复选框选择需要显示的条目。该选择实时生效并持久保存；修改后 dsh 会刷新 Web 与 TUI 的模型目录。

## WebSocket 恢复

**设置 → OpenAI Codex → WebSocket 上下文复用** 是实时配置：保存后，新请求会在开启时使用 WebSocket、关闭时使用 SSE，通常无需重启。缓存 WebSocket 异常关闭时，插件会把它标记为可恢复的传输失败；dsh 从失败的持久 agent step 边界发起重试，同时 pi-ai 废弃该连接并让重试走 SSE。之前步骤已经完成的工具调用会保留，不会再次执行。

## 上下文窗口

打开 **设置 → OpenAI Codex → 上下文窗口**，可以用 K tokens 为单位覆盖客户端容量。例如输入 `512` 表示 512,000 tokens；留空会恢复各模型在 pi-ai 目录中的默认值。保存后的值会在下一次请求时应用到全部 Codex 模型，并显示在 `/codex config` 中；已打开会话的用量分母会在该请求后刷新。

也可以在初始配置中填写精确 token 数：

```yaml
- id: llm-openai-codex
  config:
    contextWindow: 512000
```

该功能在 Harness 一侧对应 Codex CLI 的 `model_context_window` 概念，不会向 Responses 端点发送上下文窗口字段。解析后的容量会直接控制 dsh 的上下文用量分母、溢出判断、输出 token 收缩和自动压缩阈值；较小的值会更早压缩。较大的值不会提高后端模型的真实容量，模型不支持时仍可能返回上下文溢出错误。

## 网络代理

打开 **设置 → OpenAI Codex → 网络代理**，可以选择三种范围：

- **跟随 dsh** 不由插件覆盖网络设置；Codex 继承 dsh 启动时已经配置的进程级代理。
- **仅 Codex** 把所选代理注入 Codex 模型 SSE 请求、原生压缩、独立搜索、生图、额度读取与 OAuth Token 刷新；pi-ai 的首次登录交换和 WebSocket 仍遵循进程策略。
- **整个 dsh** 把代理应用到整个进程，并覆盖 OAuth；其他插件的请求也会受影响。关闭后会恢复插件覆盖前的宿主策略。

代理 URL 支持 `http://` 与 `https://`。留空时依次使用 `DSH_CODEX_PROXY`，以及标准的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 环境变量。默认模式是 **跟随 dsh**，因此安装插件不会静默改变整个进程的 dispatcher。

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

对符合条件的 Codex GPT 会话，Web 输入框还会显示仅对当前会话生效的 Fast Mode 开关。开启后只为该会话加入提供方的 priority service tier，不会修改已保存的模型设置；旁边的额度条显示对应的每周额度和提供方声明的重置时间。设置页另有默认关闭的 **默认强制开启 1.5 倍速** 开关，开启后所有会话默认使用 1.5 倍速，无需逐会话点击开关，但额度消耗更快。

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

dsh 登录默认与 Codex CLI／Desktop 相互独立：

- 凭据存储于 `$DSH_HOME/.openai-codex-auth.json`，默认位于 `~/.dsh`；
- 文件原子写入，token 刷新会在本地 dsh 进程之间加锁；
- 浏览器状态和诊断不会返回 token 值；
- 绝不复制或修改 `~/.codex/auth.json`。

分离存储可以避免两个客户端竞争同一个会轮换的 refresh token。移除 bundle 不会删除凭据；需要移除本地账号时，请使用账号页面或 `logout` 命令。

若要共享现有登录，将插件配置 `credentialFile` 设为 JSON 文件的绝对路径，例如 `C:/Users/you/.codex/auth.json`。已有文件按形状识别：Codex 的 `tokens`、CPA/CLIProxyAPI 的 `type: codex`、OpenCode 的 `openai`、Pi 的 `openai-codex`、扁平 OAuth，以及 dsh 原生格式。不认识、有歧义、字段不完整或只有 API key 的文件会明确报错；文件不存在时创建 dsh 原生格式。请使用普通文件而非符号链接或硬链接，POSIX 下要求仅属主可读写。

选中的凭据只允许包含已识别的字段；存在未知字段时，在刷新或写入前拒绝使用，诊断仅指出字段名、不输出字段值。更新保留识别出的布局、已知元数据和其他 provider 的独立条目。provider 专属 OAuth 刷新函数保留并写回新的 access、refresh、ID token，以及可获取的 email，不再使用 pi-ai 丢弃身份字段的 token 投影。登录复用 pi-ai 的交互流程，随后补一次完整刷新再保存。响应缺少 ID token 时明确失败，而非悄悄保留过时身份。退出登录只清空选中的 OAuth 字段，不删除整个共享文件，也会影响使用该登录的其他程序。

显式共享文件仅做进程内串行化，不使用 `.lock` 或刷新意图协议。写入前重新读取文件，检测到同一凭据被其他写入者更新则报错。同目录临时文件替换可在支持该语义的本地文件系统上避免本插件写出半截 JSON，但不保证断电持久性或与其他程序互斥。同时刷新仍可能竞争，写后读回校验也无法解决这一点。默认独立 dsh 存储继续保留原有跨进程锁。

## 兼容性说明

- 本分支面向成套发布的 DSH `0.1.2-rc.1` 插件表层。较新 Harness 提供正式 `dsh-http-proxy` 库时，全局代理模式会与其组合；旧版则使用可恢复的兼容 dispatcher。同时使用 `@earendil-works/pi-ai` `0.84.4`，adapter 会在读取历史时迁移旧版 pi-ai replay envelope，因此升级后已有 reasoning／tool 元数据仍可继续使用。
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
