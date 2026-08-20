# 设计：OpenAI Codex 订阅组合包

Status: implemented

[English](design.md) | 中文

## 范围

`dsh-codex` 是标准 DeepSeek Harness bundle。它在不修改 dsh 源码的前提下提供 ChatGPT OAuth、Codex 模型目录、Codex 独立搜索提供方、浏览器账号设置、可选的 `read_image` URL 扩展与 `imagegen`。当前 dsh profile 继续负责 agent loop、附件、文件系统策略、工具、权限、压缩与 Web 输入框。

## 认证

插件把 OAuth 端点、PKCE／device code 行为、account id 提取、token 刷新和 Codex 请求认证交给 dsh 基础 bundle 提供的 pi-ai Codex provider。用户可以从插件的设置页面或 `dsh-openai-codex` 可执行文件启动同一套登录生命周期。Web 认证路由默认信任回环地址上的同源请求；远端页面只有在设备所有者把完整 origin 加入独立 allowlist 后才可访问。路由返回 `no-store` JSON，且绝不暴露 token。账号页面会在不发送模型请求的情况下读取固定的 ChatGPT Codex usage 端点，把服务端用量转换为剩余百分比进度条；只有响应包含 credit 或 workspace limit 数值时才显示精确额度。

凭据以带版本的 JSON 文档存储在 `$DSH_HOME/.openai-codex-auth.json`。文件采用原子写入，跨进程锁覆盖登录、刷新和登出。该存储有意与 `~/.codex/auth.json` 分离；如果两个独立写入的客户端共享会轮换的 refresh token，其中任一方都可能使另一方的凭据失效。

## 模型适配器与压缩

bundle 使用公开的 `PiAiAdapter` 以及随附的 `openai-codex` provider 和模型目录。凭据解析器会刷新 OAuth 状态，并把所得 bearer token 作为显式的单次请求凭据传入。它不会发现环境中的 API Key，也不依赖 dsh 的私有适配器辅助函数。按会话维护的 Fast Mode registry 只会为 Web 输入框中已开启开关的会话加入 `service_tier: priority`。升级到 rc.7 后，adapter 还会在读取历史时把旧版 pi-ai replay envelope 提升为当前 response／block 结构，从而保留已有会话的原生 reasoning 与 tool 元数据。

因此，普通轮次与 `dsh-compaction-basic` 都经过标准 LLM 服务。消息转换、流式输出、工具调用、图片附件解析、用量、溢出分类、加密推理回放和取消仍由适配器负责。Codex 请求始终使用 `store: false`，所以回放数据及完整的工具调用／结果配对保存在 Harness session 中，不依赖服务端持久化的 response id。

关闭 WebSocket 上下文复用时，插件明确选择 SSE，每个普通轮次都会发送 Harness 完整上下文。开启后选择 pi-ai 的 `websocket-cached` 传输，其行为与官方 Codex 客户端一致：续接状态属于单个会话可复用的连接；只有非输入请求属性一致，且新输入严格延续上一份请求和响应时，才发送 `previous_response_id` 与输入增量。历史失配、连接回退、进程重启、Fork 后的新会话 id 或压缩调用都会发送完整请求。插件不再保存自己的 response continuation。

原生压缩模式在 `GenerateOptions.purpose === 'compaction'` 时去掉 `dsh-compaction-basic` 追加的私有摘要指令，按 Codex V2 流程通过普通 `codex/responses` 流发送请求：在历史末尾追加 `compaction_trigger`，并接收唯一的加密 `compaction` 输出 item。近期客户端消息和该输出会以插件标记封装成文本，让现有 compaction 事务继续负责范围校验、事件和表层替换。普通 Codex 请求构建完成后，adapter 会把该标记替换回原生 items；这项还原不依赖开关当前是否开启，因此检查点可以跨重启并在关闭实验后继续使用。V2 请求失败会在 provider 事件对外发出前切换到普通 SSE 摘要请求，并带上完整的 Harness 压缩提示词。

ChatGPT Codex 路由不会执行普通 Responses 的输出 token 上限。压缩仍使用模型目录中的上下文容量与标准检查点替换，但配置的摘要 token 上限无法在此路由由服务端强制执行。

## 图片

Codex 模型从 provider 目录继承其声明的输入模态。现有 dsh Web 输入框已经会把粘贴或拖放的图片转换为持久附件，因此浏览器插件只增加账号设置，不替换输入框。

开关启用时，插件会在 agent scope 注册一个定义，覆盖 Harness 现有的 `read_image`。它保留 `file_path`，并在 Schema 中增加与之互斥的 `url` 输入。本地调用委托给原定义，继续沿用其文件系统提供方、沙箱策略、观察事件、校验和远程工作区行为。URL 调用拒绝内嵌凭据，以及所有本地、私网、文档、组播或其他特殊网络地址；每次重定向都会重新校验 DNS，并把该跳连接固定到已经接受的地址。下载继续限制重定向次数与字节数，响应取消，通过签名识别 PNG、JPEG、WebP 与 GIF，并先经附件服务保存再返回图片块。实际路由的模型必须声明图片输入能力。

移除独立工具后，早期会话中的 `view_image` 结果仍可读取。Harness 会直接重放持久化的 `tool/result` 消息和附件引用，不要求当前工具注册表仍包含历史名称。模型若再次发起新的 `view_image` 调用，会收到普通的未知工具结果，并可改用 `read_image` 重试。

`imagegen` 始终调用固定的 ChatGPT Codex `gpt-image-2` 端点，与当前对话模型相互独立。调用方仍须声明图片输入能力，因为工具结果包含供下一轮模型使用的图片块。纯生成不带参考图；编辑可以接收最多五个工作区路径，或最近一至五张会话图片附件。这两种选择器互斥。路径读取使用 `ctx.fs`，会话参考图使用附件存储。base64 data URL 只存在于私有的提供方请求中。

每张生成的 PNG 都会保存为附件并写入当前工作区。`output_path` 用来指定位置；省略时，插件会创建防冲突的 `generated-<时间戳>-<id>.png` 文件名。插件为 `imagegen` 注册了专用工具视图，通过所属会话读取持久附件，在对话中直接显示缩略图并支持查看原图。已发布的 dsh 版本尚未公开二进制写入原语，因此插件包含本地原子写入兼容层；它只处理 `file:` 目标，并在写入前执行当前沙箱策略。非文件执行世界必须提供 `writeBytes`；`dsh-remote-ssh` 已实现该方法，并且只在 AHP 传输内部把字节编码为 base64。远程目标绝不回退到宿主路径。如果沙箱策略或文件系统能力拒绝写入，附件仍然可用，工具结果会报告保存失败。

实时设置会持久化两个独立开关。`modifyReadImage` 为每个实时 agent 添加或撤销 scoped `read_image` 定义；关闭后立即恢复 Harness 原始定义及其 Schema。`shareImagegenWithOtherModels` 决定其他提供方的视觉模型能否执行 `imagegen`，Codex 视觉模型始终保留访问权。两项默认均为开启。

## 搜索与会话历史

bundle 为 dsh 现有的 `web_search` 工具注册提供方。它使用 Codex 独立搜索端点与同一份可刷新 OAuth 凭据，把结构化文本结果转换为规范化的 HTTP(S) 引用，并支持 cached、indexed 和 live 模式。端点固定，profile 配置无法把 bearer token 重定向到其他地址。

每次发送前，提供方都会把已经解析默认值且不含凭据的 `{ endpoint, body }` 精确记录为 `web/openai-codex-search-llm-request`。这个专用事件归插件所有：它通过声明合并加入 `SessionEventMap`，并在插件加载时注册到当前进程的 session 事件词汇。注册会保留到进程结束，避免热重载使已经写入的 session 突然无法读取。

插件绝不会写入已停用的通用 `web/search-model-request` 事件。包含 Codex 专用事件的 session 必须在本插件已加载时读取，因为该请求属于模型可见历史，不能标记为可忽略。

## 组合

`cordis.patch.yml` 提供一条 `llm-openai-codex` 配置项，为新建 agent 选择 `openai-codex` / `gpt-5.6-sol`，并选择对应的搜索提供方。用户 settings 中已经保存的模型仍然优先。shell、文件系统、skills、MCP、subagents、权限、附件、压缩与 `web_search` 工具仍由选定的 dsh profile 提供。

## 后果

用户可以在每个 Harness home 登录一次，无需 OpenAI Platform API Key 即可使用账号有权访问的 Codex 模型、视觉输入、压缩和 Codex 搜索。移除 bundle 不会删除凭据。ChatGPT 套餐资格、模型权限、配额、OAuth 行为和独立搜索协议仍由提供方控制，可能独立于本插件发生变化。
