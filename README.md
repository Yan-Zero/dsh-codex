# dsh Codex

English | [中文](README.zh.md)

`dsh-codex` provides OpenAI Codex as a Community v0.15 DSH plugin. Its package-root `dsh-plugin.json` declares one Host facet, standard `Command/codex`, `ModelProvider/openai-codex`, `Tool/imagegen`, provider-scoped `ToolOverride/web_search`, `ToolOverride/read_image`, the durable Codex search request event, and a dsh-tui `Scene` contribution.

The Host facet provides ChatGPT OAuth account management, the Codex model catalog, a streaming model handler, image input, tool calls, reasoning replay, usage reporting, optional WebSocket context reuse, optional native Responses compaction, Codex image generation/editing, HTTP(S) support for the Host's existing `read_image`, and Codex-native execution for an existing agent-scoped `web_search`. The package also contains an optional Web-only client facet for the account settings page and the `imagegen` tool view. It is loaded through `@dsh-std/adapter-dsh` only when the DSH Web client-module host exists. On dsh-tui, the Host facet instead publishes the RFC 0006 `openai_codex` local-module scene; dsh-tui owns its renderer and lifecycle, while the scene invokes the same standard `/codex` command used by Web. Headless profiles require neither UI host and keep the provider active without a package-specific adapter.

The explicit `dsh-codex/search` subpath provides `OpenAICodexSearchProvider` against DSH's existing `@deepseek-ai/dsh-web` provider seam; `dsh-codex/search-event` provides its DSH session recorder. Every provider instance must supply a recorder, and the request is recorded before dispatch. The Host facet also overrides only the execution of the existing agent-scoped `web_search` when that agent selects `openai-codex`; the inherited schema, renderer, presentation metadata, and TUI web card stay authoritative. The standard facet declares the same current event name so existing records remain readable, including across facet reload. DSH Standard gains no Web/Search protocol.

## Installation

This experimental branch is installed from source. Its build environment and target profile are expected to provide the required DSH Standard packages and a Community v0.15 Host implementation.

```sh
git clone --branch agent/std-facet-runtime https://github.com/Yan-Zero/dsh-codex.git
cd dsh-codex
pnpm install
pnpm build
dsh plugin --profile web add link:E:/absolute/path/to/dsh-codex
```

This repository does not select or install a DSH Standard adapter. The linked component expects its DSH Standard peer packages to be resolvable from the Host environment. Image tools also require the Host adapter to provide attachment and workspace execution facilities; the `read_image` override activates only when the Host already provides that tool.

Then sign in through the contributed command:

```text
/codex login
```

`/codex login` uses the device-code flow by default, which works when the runtime is remote. Browser login remains an explicit opt-in:

```text
/codex login browser
```

The browser flow reserves pi-ai's exact `http://localhost:1455/auth/callback` URI through the invocation's `ExternalRedirect` presentation client, so a remote user-side client can receive the redirect and return its query to pi-ai's existing manual-code path. If that address is already occupied locally, pi-ai's own runtime-side listener remains the fallback.

In dsh-tui, open the contributed account and provider page with:

```text
/scene openai_codex
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

`pnpm test` runs every retained test file. The Standard peer packages must already be available to the checkout before running the checks.

License: Apache-2.0.
