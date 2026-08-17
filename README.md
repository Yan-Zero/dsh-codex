# dsh Codex

English | [中文](README.zh.md)

`dsh-codex` provides OpenAI Codex as a Community v0.15 DSH plugin. Its package-root `dsh-plugin.json` declares one Host facet, the `codex` command, and the `openai-codex` model provider.

The Host facet provides ChatGPT OAuth account management, the Codex model catalog, a streaming `ModelProviderHandler`, image input, tool calls, reasoning replay, usage reporting, WebSocket context reuse, and native Responses compaction. The facet imports only DSH Standard protocols and pi-ai.

## Installation

This experimental branch is installed from source. Its build environment and target profile are expected to provide the required DSH Standard packages and a Community v0.15 Host implementation.

```sh
git clone --branch agent/std-facet-runtime https://github.com/Yan-Zero/dsh-codex.git
cd dsh-codex
pnpm install
pnpm build
dsh plugin --profile web add link:E:/absolute/path/to/dsh-codex
```

This repository does not select or install a DSH Standard adapter. The linked component expects `@dsh-std/sdk`, `@dsh-std/command`, and `@dsh-std/model` to be resolvable from its Host environment.

Then sign in through the contributed command:

```text
/codex login
```

The standalone credential command is also available:

```sh
dsh-openai-codex login
dsh-openai-codex login --device-code
dsh-openai-codex status
dsh-openai-codex logout
```

Credentials are stored in `$DSH_HOME/.openai-codex-auth.json`, or `~/.dsh/.openai-codex-auth.json` when `DSH_HOME` is unset. This store is independent from Codex CLI/Desktop.

## Development

```sh
pnpm install
pnpm check
```

The Standard peer packages must already be available to the checkout before running the checks.

License: Apache-2.0.
