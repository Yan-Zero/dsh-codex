# 设计：可移植的 OpenAI Codex facet

Status: implemented

[English](design.md) | 中文

## 范围

`dsh-codex` 是 Community v0.15 DSH 组件。发布的 Host facet 使用 DSH Standard 资源与 activation handler，贡献 `Command/codex`、`ModelProvider/openai-codex`、`Tool/imagegen`、针对 `read_image` 与按 provider 生效的 `web_search` 执行体的 `ToolOverride`，以及持久化的 Codex 搜索请求事件；显式包子路径提供独立 provider 与对应的 DSH session recorder。

组件不包含 profile patch、私有 HTTP 设置路由或 TUI adapter。普通 DSH 包入口在 Host 侧为空实现；可选浏览器 bundle 则通过 `@dsh-std/adapter-dsh` 发布标准 local-module UI facet，而且只有 DSH Web 的 client-module host 存在时才会加载。Host facet 还按 dsh-tui RFC 0006 声明并发布 `Scene` handler；只有安装了对应私有 surface 的 dsh-tui 才会绑定它，其他 Host 可以忽略未知 extension，而不会加载 TUI service。agent loop、session、附件、工作区策略、工具执行、presentation 与命令界面仍由 Host 负责。

## 认证与命令

OAuth 端点、PKCE／device code、account id 提取、token 刷新和 Codex 请求认证均来自 pi-ai 的 OpenAI Codex provider。凭据原子写入 `$DSH_HOME/.openai-codex-auth.json`，与 Codex CLI／Desktop 的凭据相互独立。

Manifest 包含完整的 `/codex` 命令树，包括 `login`、`set` 和 `on|off` 的取值，因此远端 client 无需认识本包也能提供补全。`/codex login` 默认使用 device code；`/codex login browser` 是显式选择：它要求本次调用的 `ExternalRedirect` client 独占 pi-ai 的精确 URI `http://localhost:1455/auth/callback`，通过可选的 `OpenExternal` 打开授权地址，再把结构化 redirect query 送回 pi-ai 现有的 manual-code prompt。本地部署若该 URI 已被占用，仍由 pi-ai 自己在 Runtime 侧的 listener 接管。两项 presentation 能力均为可选，因此只有 device code 的 client 仍可加载 facet。

`/codex set` 修改当前 activation 内模型和工具 handler 的实时偏好。Web 设置 contribution 使用同一条标准命令，因此写操作仍进入 session 的正常命令生命周期；它不会引入 Codex 专属 settings 协议或私有 HTTP API。

## 模型提供方

`OpenAICodexModelHandler` 基于 pi-ai 直接实现标准 `ModelProvider` 执行约定，不手工注册或注入 Host runtime service。它转换标准消息、工具、图片引用、工具结果、流事件、用量与 replay metadata。

工具结果中的图片通过请求级 `readImage` 设施解析，并作为提供方图片输入保留。加密推理签名与 response metadata 存入标准消息的 replay state。每次请求都响应取消，并保留旧实现五分钟的流空闲上限。

Codex 请求使用 `store: false`。可选 WebSocket 上下文复用由 `OpenAICodexResponseRuntime` 管理；复用只属于单个 session，当 transport 或请求前缀不合适时发送完整请求。compaction 不进入这条 continuation 链。

可选原生压缩会发送 `compaction_trigger`，把加密 checkpoint 保存到可移植标记，并在后续普通请求中展开。如果原生压缩在提供方输出对外发出前被拒绝，handler 会回退到普通标准压缩。Codex 路由有意不为 compaction 发送普通 Responses 输出 token 上限，与提供方行为一致。

## 图片与工具

标准 Tool 约定只携带可移植的执行数据：当前模型与模态、图片限制与校验、附件存取、工作区读写、嵌套 deferred content，以及原工具委托。DSH adapter 把这些设施映射到自己的附件、文件系统、沙箱、观察事件与工具 runtime。它们是同进程 activation value，不是新的跨端点协议。

`read_image` 是实时 override。工作区路径委托给 Host 原工具。HTTP(S) 输入拒绝内嵌凭据，逐次手工校验重定向，对声明长度和实际流字节实施上限，响应取消，识别 PNG/JPEG/WebP/GIF 签名，遵守部署 media 限制，保存附件并返回图片块。关闭 `modifyReadImage` 会撤销 override，恢复原定义。

`imagegen` 始终调用固定的 Codex `gpt-image-2` 端点。它可以接收最多五个工作区路径，或最近一至五张会话图片，但不能同时使用两种来源。引用图由 Host 校验，data URL 只会进入提供方请求。生成 PNG 会保存为附件并写入当前工作区；工作区拒绝写入时会报告错误，但不会丢弃附件。接收结果的模型必须声明图片输入能力。偏好开关可以限制非 Codex provider 调用。

二进制工作区发布属于 DSH adapter 职责。adapter 内部实现会应用 write intent 与沙箱策略；本地文件采用同目录临时文件原子发布，远端写入委托给当前文件系统 provider，并发布 observation state。`dsh-codex` 本身不包含文件系统 provider 实现。

## 搜索

`OpenAICodexSearchProvider` 继续实现 `@deepseek-ai/dsh-web` 的现有 provider 接缝。它保留固定的一方端点、可刷新 OAuth、cached/indexed/live 映射、发送前的精确无密请求回调、全阶段取消、诊断脱敏和规范化可引用结果。

recorder 是必填项，并会在发送前写入 `web/openai-codex-search-llm-request`。Manifest 声明同一个现行事件契约；DSH adapter 会在当前进程余下生命周期内持续识别见过的持久事件名，因此 facet 重载不会让已有记录变得不可读。

Host facet 发布按 provider 生效、仅替换执行体的 `web_search` `ToolOverride`。这与 dsh-tui 的实际 composition 一致：通用 Web service／provider 归 Host 所有，通用 Web tool 位于 agent scope。对 `openai-codex` agent，adapter 解析已有工具并只替换其 execution waterfall，不会在同层再注册一个同名工具。原 input/output schema、renderer、presentation metadata、timeout、并发属性与 TUI Web card 仍是权威定义。

DSH Standard 不为此定义 Codex 或 Web Search 资源。产品 composition 仍可通过显式的 `dsh-codex/search` 与 `dsh-codex/search-event` 子路径接入现有 DSH Web 和 Session 生命周期。

## 发布与测试

构建入口为 `src/standard.ts`、`src/bin.ts`、`src/search.ts` 与 `src/search-event.ts`。包根入口只承担 facet，不再机械转导出所有内部 helper；DSH 专属搜索 API 使用显式子路径。`pnpm test` 运行所有保留的测试文件。测试直接驱动标准 handler，覆盖提供方 wire request、response transport 与压缩、认证存储、用量解析、图片工具、搜索、偏好，以及 Manifest／activation 边界。通用 DSH Host 映射在 `@dsh-std/adapter-dsh` 中测试。

## 后果

任何兼容 Host 都能加载该组件，而无需手工 hook 私有 runtime registry。已经公开的 DSH 包仍可复用其正式类型与领域接缝。产品专属 UI 与 registry 集成留在本包之外。ChatGPT 套餐资格、模型权限、额度、OAuth 行为、图片端点和独立搜索端点仍由提供方控制，可能独立变化。
