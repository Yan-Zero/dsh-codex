# dsh Codex

[English](README.md) | 中文

`dsh-codex` 以 Community v0.15 DSH 插件提供 OpenAI Codex。包根目录的 `dsh-plugin.json` 声明一个 Host facet、`codex` 命令和 `openai-codex` 模型提供方。

Host facet 提供 ChatGPT OAuth 账号管理、Codex 模型目录、流式 `ModelProviderHandler`、图片输入、工具调用、推理回放、用量报告、WebSocket 上下文复用和 Responses 原生压缩。Facet 只引用 DSH Standard 协议和 pi-ai。

## 安装

该实验分支从源码安装。构建环境和目标 profile 应当已经提供所需的 DSH Standard 包，以及 Community v0.15 Host 实现。

```sh
git clone --branch agent/std-facet-runtime https://github.com/Yan-Zero/dsh-codex.git
cd dsh-codex
pnpm install
pnpm build
dsh plugin --profile web add link:E:/absolute/path/to/dsh-codex
```

本仓库不选择或安装 DSH Standard adapter。链接后的组件假定 Host 环境能够解析 `@dsh-std/sdk`、`@dsh-std/command` 和 `@dsh-std/model`。

随后通过贡献的命令登录：

```text
/codex login
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

执行检查前，源码 checkout 中也必须已经能够解析这些 Standard peer 包。

许可证：Apache-2.0。
