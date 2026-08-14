# dsh Codex

English | [中文](README.zh.md)

Use a ChatGPT subscription in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through OpenAI's Codex sign-in flow—no OpenAI Platform API key required and no dsh source patch required.

`dsh-codex` is an independent dsh bundle. It adds:

- ChatGPT OAuth from the dsh Settings panel or a standalone CLI, with automatic token refresh
- the Codex GPT catalog, including vision-capable models when the account offers them
- streaming, tool calls, reasoning replay, prompt caching, and dsh compaction through the normal LLM service
- Codex standalone web search through dsh's existing `web_search` tool
- a `view_image` tool that can load a local path or an HTTP(S) image URL
- an `imagegen` tool backed by `gpt-image-2`, with workspace or conversation reference images and automatic workspace output
- browser image input through dsh's existing paste and drop controls

ChatGPT subscription authentication and usage-based OpenAI API access are different products. This plugin uses the ChatGPT Codex backend only; it does not turn a subscription into a general-purpose OpenAI API credential.

## Install

Install the prebuilt bundle from npm into the selected dsh profile:

```sh
dsh plugin --profile web add dsh-codex
dsh web
```

From a DeepSeek Harness source checkout, use `pnpm dsh plugin --profile web add dsh-codex`. A local plugin checkout can still be installed with `link:/absolute/path/to/dsh-codex` for development.

Open **Settings → OpenAI Codex → Sign in with ChatGPT**. The plugin opens OpenAI's authorization page and completes the localhost callback. The account page shows live Codex quota bars and exact remaining percentages; exact credit balances or workspace limits appear only when the account API supplies them.

The CLI remains available for terminal and headless installations:

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex login --device-code
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

Codex, Claude Code, and other automation agents should follow [INSTALL.md](INSTALL.md). It is a complete, idempotent runbook and does not require reading this repository's source or design notes.

The bundle selects `openai-codex` / `gpt-5.6-sol` for new agents and selects the Codex search provider. A model already saved in dsh settings still takes precedence; the model picker can select any other Codex model visible to the signed-in account.

## Images

Image support uses dsh's durable attachment path:

- paste an image into the Web composer with <kbd>Ctrl</kbd>+<kbd>V</kbd>, or drag and drop it;
- ask the model to call `view_image` with `source` set to a local absolute/relative path or an HTTP(S) URL;
- PNG, JPEG, WebP, and GIF are accepted within the active dsh attachment limits;
- only a model that explicitly advertises image input may receive an image.

`imagegen` is available to any vision-capable conversation model. The current model writes an ordinary prompt and may select either `referenced_image_paths` or `num_last_images_to_include`; the plugin reads the bytes from `ctx.fs` or the attachment store and sends them to `gpt-image-2`. The model never emits base64. Every result is shown inline, saved as a durable attachment, and written to the active workspace. `output_path` chooses the destination; omitting it creates a unique `generated-<timestamp>-<id>.png` file. Local saving is included in this plugin, while `dsh-remote-ssh` supplies the remote AHP write path when that plugin owns the workspace.

The Settings page has separate **View Image for other models** and **Image generation for other models** toggles. Both default on. Turning one off keeps that tool available to `openai-codex` vision models and rejects calls from other model providers at execution time.

The tool stores validated bytes as a dsh attachment before returning the actual image block. Local paths pass through the configured filesystem service. Remote redirects are bounded and credentials embedded in URLs are rejected.

## Search

The provider connects dsh's `web_search` tool to the standalone search protocol used by Codex. It returns ordinary dsh text and HTTP(S) citations, so later turns and compaction retain the tool history.

Configure the `llm-openai-codex` row in a profile patch:

```yaml
- id: llm-openai-codex
  config:
    searchMode: live
    searchContextSize: medium
```

| Field | Default | Values |
|---|---:|---|
| `searchModel` | `gpt-5.6-sol` | a Codex model id |
| `searchMode` | `cached` | `cached`, `indexed`, `live` |
| `searchContextSize` | `medium` | `low`, `medium`, `high` |
| `searchMaxOutputTokens` | `10000` | positive integer |

Each resolved, secret-free auxiliary request is recorded before dispatch as the dedicated `web/openai-codex-search-llm-request` session event. The event is owned and registered by this plugin; no generic search event or dsh fork is required.

## Credentials and privacy

dsh keeps this login separate from Codex CLI/Desktop:

- credentials are stored at `$DSH_HOME/.openai-codex-auth.json` (`~/.dsh` by default);
- writes are atomic and token refresh is locked across local dsh processes;
- browser status and diagnostics never return token values;
- `~/.codex/auth.json` is never copied or modified.

Keeping the stores separate prevents two clients from racing the same rotating refresh token. Removing the bundle does not delete the credential; use the account page or `logout` command when the local account should be removed.

## Compatibility notes

- The plugin runs on released dsh plugin surfaces and does not require a modified Harness checkout. It can generate attachments and save local output when installed alone.
- ChatGPT plan eligibility, model access, quotas, and backend behavior are controlled by OpenAI and may change.
- The Codex endpoint does not enforce the ordinary Responses `max_output_tokens` field. Compaction works, but its configured summary cap cannot be imposed server-side on this route.
- Filesystem, shell, skills, MCP, subagents, permissions, attachments, compaction, and the `web_search` tool itself still come from the active dsh profile.
- The standalone search endpoint is not a public OpenAI Platform API. Compatibility follows the pinned Codex/pi-ai implementation.

See [the design document](docs/design.md) for protocol, persistence, and lifecycle details.

## Development

```sh
pnpm install
pnpm run check
```

The check performs strict Host and browser TypeScript checking, focused tests, and both runtime bundles.

## License

Apache-2.0
