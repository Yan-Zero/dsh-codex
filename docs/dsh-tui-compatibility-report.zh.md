# dsh-codex 与 dsh-tui 兼容性调查

> 2026-08-16 实施状态：本地工作树已完成 link profile 安装、带子命令补全的 `/codex`、`agentDefaultModel` 启动路由、Ctrl+V／`@image` 持久图片输入、`imagegen` 通用结果卡片和完整工具错误文本。终端内联像素预览仍留给 dsh-tui 的通用 attachment renderer；当前卡片显示生成参数、结果信息与工作区输出路径。

调查日期：2026-08-16

涉及仓库：

- `E:\source\ai\dsh\openai-codex`
- `E:\source\ai\dsh\dsh-tui`

## 结论

最初 `/model` 无法选择 `gpt-5.6-sol` 的直接原因是安装范围：`dsh-codex` 当时只安装在 `web` profile。适配完成后，本地 checkout 已用 link 方式加入 `dsh-tui` profile。

本机 profile 状态如下：

| Profile | Bundles / dependencies | dsh-codex |
| --- | --- | --- |
| `web` | 包含 `dsh-codex`，并以 `link:E:/source/ai/dsh/openai-codex` 安装 | 已安装 |
| `dsh-tui` | 包含 TUI、工作区插件与 `dsh-codex`；后者为 `link:E:/source/ai/dsh/openai-codex` | 已安装 |

`dsh-tui` 的 `/model` 会从当前 profile 的 LLM registry 枚举 provider。缺少 `dsh-codex` 时，registry 中没有 `openai-codex`，模型选择器自然无法提供 `gpt-5.6-sol`。`dsh-codex` 自己的 loader 测试已经确认：bundle 被装载后，`ctx.llm.listModels('openai-codex')` 包含 `gpt-5.6-sol`。

Codex 推理、模型目录、搜索、`read_image`、`imagegen`、会话续接和压缩链路都能在 TUI 的 host 侧运行。`/codex` 已补齐账户、额度和四个实时开关；`@image` 会生成持久图片附件。当前剩余缺口是终端内联像素预览。

## 现状判断

| 能力 | 当前 dsh-tui profile | 安装 dsh-codex 后 | 说明 |
| --- | --- | --- | --- |
| `/model` 显示 `gpt-5.6-sol` | 可用 | 已验证 composition 与模型目录 | TUI 枚举所有已注册 provider；首次启动还会读取 `agentDefaultModel` |
| Codex 文本对话 | 可用 | 已接入 | `PiAiAdapter` 是 host 插件，不依赖 Web client |
| 推理等级 `/effort` | 可用 | 已接入 | TUI 从当前模型的动态 `reasoning` 描述读取档位 |
| ChatGPT OAuth | 可用 | `/codex login` | 凭证位于共享 `$DSH_HOME/.openai-codex-auth.json` |
| `/login`、`/logout` | DeepSeek 语义 | Codex 使用 `/codex login\|logout` | provider 命名空间避免覆盖 TUI 内建命令 |
| Codex 用量／额度 | 可用 | `/codex usage` | 调用同一个 usage endpoint |
| Codex 搜索 | 不可用 | 可用，取决于 preset | standard/code preset 需要带 Web 工具；插件在 host 侧注册搜索 provider |
| `read_image(file_path)` | 插件增强不可用 | 模型可用 | TUI 不显示图片，图片块仍会进入会话和下一轮模型上下文 |
| `read_image(url)` | 不可用 | 模型可用 | URL 扩展位于 host 工具定义，与前端无关 |
| `imagegen` 纯生图 | 不可用 | 可执行并保存文件 | TUI 只能显示通用工具卡和文本结果，无法显示缩略图 |
| `imagegen` 参考图编辑 | 不可用 | 可用 | 工作区路径和最近会话附件均由 host 侧读取 |
| `@` 输入图片 | 可用 | 已接入持久 attachment | 经当前 workspace 的 `ctx.fs` 读取，兼容 provider-owned workspace |
| WebSocket 上下文复用 | 可用 | `/codex set websocket-context on` | 状态写入共享 settings |
| Codex 原生压缩 | 可用 | `/codex set native-compaction on` | TUI 的 `/compact` 会进入 adapter 的 compaction purpose |
| 生成图内联预览 | 不可用 | 仍不可用 | `ImagegenToolView` 属于 Web client slot |

下文“代码依据”记录适配前的缺口与设计取舍；已完成项以顶部实施状态和上表为准。

## 代码依据

### 1. dsh-codex 的 host 与 Web 两半相互独立

`dsh-codex/package.json:53-63` 把 client 声明为 `platform: "web"`。Web client 只注册两个界面贡献：

- `src/client/index.tsx:60`：OpenAI Codex 设置页；
- `src/client/index.tsx:67`：`imagegen` 专用工具视图。

host 入口没有 Web 平台限制。`src/index.ts` 会注册：

- `openai-codex` LLM adapter；
- Codex 搜索 provider；
- `imagegen`；
- agent-scope 的 `read_image` 增强；
- settings 可用时的实时偏好。

因此 TUI 不加载 React client 很正常。模型请求和工具执行依然可以工作。

### 2. `/model` 依赖当前 profile 的 provider registry

`dsh-tui/src/channel.ts:2129-2139` 先调用 `llm.listProviders()`，再逐个调用 `llm.listModels(provider.id)`。模型选择器没有 Codex 专用过滤。

`dsh-codex/tests/loader-composition.spec.ts:60-62` 已验证插件装载后：

- provider 列表包含 `openai-codex`；
- 模型列表包含 `gpt-5.6-sol`。

当前 profile 没有安装插件，所以问题出现在 registry 形成之前。

### 3. TUI 不采用 agent-default-model

`dsh-codex/cordis.patch.yml` 把 `agent-default-model` 设为 `openai-codex / gpt-5.6-sol`。Web 和标准 Harness agent 创建流程会使用它。

`dsh-tui/src/modelRoute.ts:20-24` 另外定义了 `deepseek-official / deepseek-v4-flash` 作为最终默认值。TUI 的新会话路由优先级是：

1. TUI 配置中同时给出 provider 与 model；
2. `~/.dsh-tui/model.json` 中由 `/model` 保存的选择；
3. TUI 自己的 DeepSeek 默认值。

它没有读取 `ctx.agentDefaultModel.currentSelection()`。安装 `dsh-codex` 后，第一次启动仍可能显示 DeepSeek；用户成功选择一次 Codex 后，TUI 会把完整路由写入自己的偏好文件。

### 4. TUI 的账户命令固定为 DeepSeek

`dsh-tui/src/screens/Chat.tsx:774-787` 的 `/login` 只查看 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_BASE_URL`，`/logout` 也只提示删除该环境变量。切换到 Codex 模型不会改变这两个命令的行为。

`dsh-codex` 已提供独立的 `dsh-openai-codex login|logout|status`，但尚未向 DSH command registry 注册 `/codex` 一类的命令。因此 TUI 内找不到 ChatGPT 登录、登出、额度与实验开关。

### 5. 图片能力在模型侧可用，在终端显示侧丢失

`imagegen` 的工具结果包含：

- 一段带尺寸、字节数和输出路径的文本；
- 一个持久 `image` attachment block；
- 始终尝试写入工作区的 PNG 文件。

`dsh-tui/src/channel.ts:2858-2859` 在工具结果中只提取 `text` block，其他 block 被忽略。模型会继续收到图片附件，TUI 只留下文本和输出路径。

TUI 的 `ToolCallView` 结构子集位于 `dsh-tui/src/channel.ts:79-82`，支持 generic、terminal、diff，没有 attachment/image 视图。`imagegen` 会落到 generic 卡片；Ctrl+O 可以看到完整参数和文本结果，缩略图与点击查看原图缺失。

输入方向也存在同样问题。`dsh-tui/src/channel.ts:3623-3645` 将 `@` mention 展开限定为 `{ type: 'text' }[]`，图片文件会经过 `readText`，无法生成持久 image attachment。用户仍可直接告诉模型图片路径，让模型调用 `read_image`。

### 6. 工具错误信息不够完整

`dsh-tui/src/channel.ts:3188-3189` 只显示 `${failure.name}: ${failure.code}`，没有显示 failure message 或 cause。`imagegen`、`read_image` 遇到 OAuth、网络、格式或写入问题时，终端很难判断实际原因。

## 建议方案

### P0：把 dsh-codex 安装到 dsh-tui profile

开发环境应使用现有 checkout 的 link 安装：

```powershell
dsh plugin --profile dsh-tui add link:E:/source/ai/dsh/openai-codex
```

安装后检查：

```powershell
dsh --profile dsh-tui --dump-config
dsh plugin --profile dsh-tui exec dsh-openai-codex status
```

验收条件：

1. `~/.dsh/profiles/dsh-tui/package.json` 的 dependencies 和 bundle 列表各出现一次 `dsh-codex`；
2. effective config 中存在 `llm-openai-codex`；
3. `/model` 显示 `openai-codex / GPT-5.6 Sol`；
4. 选择后能发起一轮普通文本请求；
5. 重新启动 TUI 后仍沿用保存的 Codex 路由。

现有 Web profile 的 OAuth 凭证位于共享 DSH home。`status` 若显示已登录，可以直接复用，无需启动第二次 OAuth。

这一步只改变用户 profile，不需要修改 dsh-tui 或 DeepSeek Harness 源码。执行前应保留 profile 中已有的 TUI、Remote SSH 与用户 patch。

### P1：在 dsh-codex 增加 provider 自有的终端命令

建议由 `dsh-codex` 可选注入 `commands` 服务，注册一个外部命令：

```text
/codex status
/codex login
/codex logout
/codex usage
/codex config
/codex set read-image on|off
/codex set imagegen-other-models on|off
/codex set websocket-context on|off
/codex set native-compaction on|off
```

使用单一 `/codex` 命名空间可以避开 TUI 现有 `/login`、`/logout` 的 DeepSeek 语义，也能被 Web 或其他命令型前端复用。命令返回普通 `CommandResult`，dsh-tui 已经会合并 command registry 中的外部命令。

登录流程建议复用现有 OAuth 生命周期：打开系统浏览器、立即在命令结果中显示非敏感状态，回调完成后写入同一 credential store。登录操作需要由插件 lifecycle 持有，TUI 切会话时不能取消它。device-code 可以作为 `/codex login device` 的无浏览器路径。

这是 dsh-codex 仓库内收益最高的一项改动，也不需要依赖 dsh-tui 包。

### P1：让 dsh-tui 采用 Harness 的默认模型服务

TUI 应在没有显式完整路由、没有已保存 `/model` 偏好时读取：

```ts
ctx.get('agentDefaultModel')?.currentSelection()
```

只有该服务不可用时才回落到 `deepseek-official / deepseek-v4-flash`。这样 dsh-codex、Claude、OpenRouter 或其他 provider bundle 都能正确影响 TUI 的首轮默认模型，dsh-codex 无需给 TUI patch 一条专用配置。

建议优先级：

1. 显式 TUI provider+model；
2. TUI 持久化 `/model` 偏好；
3. Harness `agentDefaultModel.currentSelection()`；
4. TUI 内建 DeepSeek fallback。

### P1：修复 TUI 的 provider 账户语义

长期方案应由 Harness 提供 provider-neutral auth/account registry，TUI 的 `/login`、`/logout` 和 `/status` 根据当前 provider 路由。当前没有这层统一服务时，先保留 `/codex` 命令，避免 TUI 直接 import `dsh-codex`。

TUI 自带 `/login` 至少应明确写成 DeepSeek credential status，避免用户切到 Codex 后误以为 ChatGPT 未登录。

### P2：先做好图片路径体验，再考虑终端内联图片

`imagegen` 已经始终写入工作区，终端端的可靠最小体验可以是：

- 工具卡标题显示 Generate/Edit image；
- 卡片正文显示 prompt 摘要、尺寸与字节数；
- 明确显示成功输出路径或 writeError；
- 本地路径支持 OSC 8 链接时允许点击；
- Ctrl+O 保留完整 prompt 和参数。

这可以通过 dsh-codex 增加 `presentResult` 文本视图，以及 dsh-tui 对 generic view 的小幅完善完成。

Kitty graphics、iTerm2 inline image、Sixel 等协议适合放在 dsh-tui 的通用 attachment renderer。它应服务所有产生图片块的工具，避免 dsh-codex 维护一套终端检测与渲染代码。Remote SSH 场景还需要区分远端工作区路径和本地终端可打开路径，首版不应自动把远端文件当成本地文件打开。

### P2：为 TUI 增加真正的图片输入

`@image.png` 应走通用附件链路：

1. 通过当前 `ctx.fs` 读取 bytes；
2. 检测并校验 PNG/JPEG/WebP/GIF；
3. 保存到 attachment store；
4. 向 user message 添加 `{ type: 'image', attachment }`；
5. 输入区只显示简短的附件 chip／文件名。

这项功能属于 dsh-tui，因为任何视觉模型都需要它。dsh-codex 的 `read_image` 路径仍可作为兼容方案和模型主动读图手段。

剪贴板位图可以后续实现。Windows FileDropList 已能把文件路径插入输入框，先把图片路径识别为附件即可覆盖大部分使用场景。

### P2：保留完整工具错误

TUI 工具卡应显示经过脱敏的 `failure.message`，展开状态再显示 cause/code。最低限度需要区分：

- 未登录或 token 失效；
- 网络／代理失败；
- 模型不支持图片输入；
- 图片格式或大小不符合限制；
- 工作区写入被策略拒绝。

## 不建议的做法

- 不要给 `dsh-codex` 增加对 `@deepseek-harness-tui/dsh-tui` 的硬依赖；命令 registry、工具 presentation 和 attachment block 已足够承载集成。
- 不要复制 Web React 设置页到 Ink。终端用命令配置更稳定，也不会形成两套状态模型。
- 不要在 dsh-codex 内实现 Kitty/iTerm2/Sixel；终端图片渲染应是 TUI 的通用能力。
- 不要通过修改 dsh-tui bundle patch 强行插入 Codex provider。profile 插件安装负责组合，TUI 保持 provider-neutral。
- 不要用 base64 文本展示生成图。图片字节已经在 attachment store 和工作区文件中。

## 建议实施顺序

1. 将当前 checkout link 安装到 `dsh-tui` profile，验证 `/model` 与文本请求。
2. 在 dsh-codex 增加 `/codex` 命令与测试，覆盖登录状态、usage 和四个开关。
3. 在 dsh-tui 接入 `agentDefaultModel`，修正首次启动路由。
4. 改善 `imagegen` 通用卡片和错误信息。
5. 在 dsh-tui 实现 `@image` attachment 输入。
6. 评估通用终端图片协议渲染。

## 跨仓库验收清单

- fresh profile 安装 TUI、dsh-codex 与 Remote SSH 后能一次完成 composition；
- `/model` 能看到并切换 `openai-codex / gpt-5.6-sol`；
- 新会话、resume、rewind、fork 和 model switch 保持合法 route；
- `/codex status` 不泄露 token，已有 Web 登录可复用；
- 普通 Codex 请求能显示 reasoning、token、cache 与 retry 状态；
- `read_image` 可读取本地路径和 HTTP(S) URL，下一轮模型确实收到图片；
- `imagegen` 无 `output_path` 时仍在当前工作区生成唯一文件；
- `imagegen` 能用工作区路径和最近会话图片执行 edit；
- TUI 至少显示 prompt、参数、尺寸、输出路径和完整失败原因；
- `/compact` 在原生压缩开关启用时走 Codex V2 `compaction_trigger` 流程；
- WebSocket 复用开关启用后，多会话与 fork 不串联 continuation；
- Remote SSH 下不把远端路径误当作本地路径打开。
