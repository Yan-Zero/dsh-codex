# dsh Codex

[English](README.md) | 中文

`dsh-codex` 以 Community v0.15 DSH 插件提供 OpenAI Codex。包根目录的 `dsh-plugin.json` 声明一个 Host facet、标准的 `Command/codex`、`ModelProvider/openai-codex`、`Tool/imagegen`、按 provider 生效的 `ToolOverride/web_search`、`ToolOverride/read_image`、持久化的 Codex 搜索请求事件，以及一项 dsh-tui `Scene` contribution。

Host facet 提供 ChatGPT OAuth 账号管理、Codex 模型目录、流式模型处理器、图片输入、工具调用、推理回放、用量报告、可选的 WebSocket 上下文复用和 Responses 原生压缩、Codex 图片生成／编辑、对 Host 现有 `read_image` 的 HTTP(S) 支持，以及对现有 agent-scoped `web_search` 的 Codex 原生执行。包内还提供可选、仅 Web 生效的 client facet，用于账号设置页和 `imagegen` 工具视图；只有 DSH Web client-module host 存在时，`@dsh-std/adapter-dsh` 才会加载它。dsh-tui 下则由 Host facet 发布 RFC 0006 的 `openai_codex` local-module scene；renderer 与生命周期归 dsh-tui 所有，scene 调用的仍是 Web 共用的标准 `/codex` 命令。headless profile 不要求任何 UI host，provider 也不依赖本包专用 adapter。

显式子路径 `dsh-codex/search` 基于 DSH 现有的 `@deepseek-ai/dsh-web` provider 接缝提供 `OpenAICodexSearchProvider`；`dsh-codex/search-event` 提供对应的 DSH session recorder。每个 provider 实例都必须提供 recorder，请求会在发送前写入事件。Host facet 还会在 agent 选择 `openai-codex` 时，仅替换已有 agent-scoped `web_search` 的执行体；继承的 schema、renderer、presentation metadata 与 TUI Web card 仍是权威定义。标准 facet 声明的是同一个现行事件名，因此已有记录在 facet 重载前后都保持可读。DSH Standard 不会因此增加 Web／Search 协议。

## 安装

该实验分支从源码安装。构建环境和目标 profile 应当已经提供所需的 DSH Standard 包，以及 Community v0.15 Host 实现。

```sh
git clone --branch agent/std-facet-runtime https://github.com/Yan-Zero/dsh-codex.git
cd dsh-codex
pnpm install
pnpm build
dsh plugin --profile web add link:E:/absolute/path/to/dsh-codex
```

本仓库不选择或安装 DSH Standard adapter。链接后的组件假定 Host 环境能够解析其 DSH Standard peer 包。图片工具还要求 Host adapter 提供附件与工作区执行设施；只有 Host 已经提供 `read_image` 时，对应 override 才会生效。

随后通过贡献的命令登录：

```text
/codex login
```

`/codex login` 默认使用设备码流程，适用于远端 Runtime。浏览器登录保留为显式选择：

```text
/codex login browser
```

浏览器流程通过本次调用的 `ExternalRedirect` presentation client 独占 pi-ai 的精确 URI `http://localhost:1455/auth/callback`，因此远端用户侧 client 可以接收 redirect，再把 query 交回 pi-ai 现有的 manual-code 路径。如果该地址在本机已被占用，则仍由 pi-ai 自己在 Runtime 侧的 listener 自然接管。

在 dsh-tui 中，可通过以下命令打开贡献的账号与提供方页面：

```text
/scene openai_codex
```

也可以使用独立凭据命令：

```sh
dsh-openai-codex login
dsh-openai-codex login --device-code
dsh-openai-codex status
dsh-openai-codex logout
```

凭据存放于 `$DSH_HOME/.openai-codex-auth.json`；未设置 `DSH_HOME` 时使用 `~/.dsh/.openai-codex-auth.json`。该文件与 Codex CLI／Desktop 的凭据相互独立。

## 开发

```sh
pnpm install
pnpm check
```

`pnpm test` 会运行全部保留的测试文件。执行检查前，源码 checkout 中也必须已经能够解析这些 Standard peer 包。

许可证：Apache-2.0。
