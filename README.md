# dsh Codex

English | [中文](README.zh.md)

Use a ChatGPT subscription in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through OpenAI's Codex sign-in flow—no OpenAI Platform API key required and no dsh source patch required.

`dsh-codex` is an independent dsh bundle. It adds:

- ChatGPT OAuth from the dsh Settings panel or a standalone CLI, with automatic token refresh
- the Codex GPT catalog, including vision-capable models when the account offers them
- a live client-side context-window capacity override for dsh's token meter and compaction policy
- streaming, tool calls, reasoning replay, prompt caching, and dsh compaction through the normal LLM service
- Codex standalone web search through dsh's existing `web_search` tool
- optional HTTP(S) URL input added to Harness's existing `read_image` tool
- an `imagegen` tool backed by `gpt-image-2`, with workspace or conversation reference images and automatic workspace output
- browser image input through dsh's existing paste and drop controls
- a per-conversation Fast Mode switch and compact weekly quota indicator in the Web composer

ChatGPT subscription authentication and usage-based OpenAI API access are different products. This plugin uses the ChatGPT Codex backend only; it does not turn a subscription into a general-purpose OpenAI API credential.

## Install

Install the prebuilt bundle from npm into the selected dsh profile:

```sh
dsh plugin --profile web add dsh-codex
dsh web
```

From a DeepSeek Harness source checkout, use `pnpm dsh plugin --profile web add dsh-codex`. A local plugin checkout can still be installed with `link:/absolute/path/to/dsh-codex` for development.

Open **Settings → OpenAI Codex → Sign in with ChatGPT**. The plugin opens OpenAI's authorization page and completes the localhost callback. The account page shows live Codex quota bars and exact remaining percentages; exact credit balances or workspace limits appear only when the account API supplies them.

Loopback Web pages are trusted automatically. If dsh runs on another machine, the account page shows the exact origin command that must be approved on the dsh host, for example `dsh plugin --profile web exec dsh-openai-codex trust-origin http://host:port`. The allowlist is exact-origin, stored separately from OAuth credentials, and can be inspected or revoked with `trusted-origins` and `untrust-origin`.

The CLI remains available for terminal and headless installations:

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex login --device-code
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex doctor --json
dsh plugin --profile web exec dsh-openai-codex logout
```

For `dsh-tui`, install the bundle into the same profile:

```sh
dsh plugin --profile dsh-tui add dsh-codex
```

After restarting the TUI, `/model` lists the `openai-codex` catalog. With no explicit route or saved selection, the TUI adopts the bundle's `gpt-5.6-sol` default. Use `/codex status|login|logout|usage|config` for the account and live settings; the four boolean settings can be changed with `/codex set <read-image|imagegen-other-models|websocket-context|native-compaction> <on|off>`. Browser login shares the same dsh credential file used by the Web profile.

Codex, Claude Code, and other automation agents should follow [INSTALL.md](INSTALL.md). It is a complete, idempotent runbook and does not require reading this repository's source or design notes.

The bundle selects `openai-codex` / `gpt-5.6-sol` for new agents and selects the Codex search provider. A model already saved in dsh settings still takes precedence; the model picker can select any other Codex model visible to the signed-in account.

## Model catalog

By default, the model picker advertises the complete `openai-codex` catalog. Open **Settings → OpenAI Codex** and use the model checkboxes to choose which entries remain visible. The selection is live and durable; dsh refreshes the Web and TUI model directories after it changes.

The same initial subset can be seeded through `models` on the `llm-openai-codex` entry while preserving provider order:

```yaml
- id: llm-openai-codex
  config:
    models:
      - gpt-5.6-luna
      - gpt-5.6-sol
      - gpt-5.6-terra
```

The checkboxes and `models` setting control discovery only. A hidden model already stored in an existing session or supplied explicitly remains resolvable, so narrowing the picker does not invalidate older records. Omit `models` to start with the full catalog; an empty list advertises no models.

## Context window

Open **Settings → OpenAI Codex → Context window** to override the client-side capacity in K tokens. For example, enter `512` for 512,000 tokens. Leave the field empty to restore each model's pi-ai catalog default. The saved value applies to every Codex model on its next request and is shown by `/codex config`; an open conversation's meter refreshes after that request.

The initial value can also be seeded in exact tokens:

```yaml
- id: llm-openai-codex
  config:
    contextWindow: 512000
```

This mirrors Codex CLI's `model_context_window` concept on the Harness side; no context-window field is sent to the Responses endpoint. The resolved capacity drives dsh's context meter, overflow classification, output-token clamping, and automatic-compaction threshold. A smaller value compacts earlier. A larger value does not increase the backend model's real capacity, so unsupported values can still end in a provider overflow error.

## Images

Image support uses dsh's durable attachment path:

- paste an image into the Web composer with <kbd>Ctrl</kbd>+<kbd>V</kbd>, or drag and drop it;
- on Windows, paste a clipboard image with <kbd>Ctrl</kbd>+<kbd>V</kbd> in the adapted dsh-tui, or enter `@relative/image.png`; clipboard images go straight to the attachment store, while path images use the active workspace filesystem;
- ask the model to call `read_image` with either `file_path` for a workspace image or `url` for an HTTP(S) image;
- PNG, JPEG, WebP, and GIF are accepted within the active dsh attachment limits;
- only a model that explicitly advertises image input may receive an image.

`imagegen` is available to any vision-capable conversation model. The current model writes an ordinary prompt and may select either `referenced_image_paths` or `num_last_images_to_include`; the plugin reads the bytes from `ctx.fs` or the attachment store and sends them to `gpt-image-2`. The model never emits base64. Every result is shown inline, saved as a durable attachment, and written to the active workspace. `output_path` chooses the destination; omitting it creates a unique `generated-<timestamp>-<id>.png` file. Local saving is included in this plugin, while `dsh-remote-ssh` supplies the remote AHP write path when that plugin owns the workspace.

The Settings page has separate **Enhance read_image** and **Image generation for other models** toggles. Both default on. Turning off the first removes the plugin's agent-scoped override and restores Harness's original local-only `read_image` schema. Turning off the second keeps `imagegen` available to Codex vision models and rejects calls from other model providers at execution time.

`read_image` stores validated bytes as a dsh attachment before returning the actual image block. Local paths are delegated unchanged to Harness, including its configured filesystem and sandbox behavior. The URL extension bounds redirects and bytes, rejects credentials embedded in URLs, rejects local/private/special network targets, and pins each validated public address across the corresponding HTTP hop.

For an eligible Codex GPT conversation, the Web composer also exposes a session-local Fast Mode switch. Enabling it adds the provider's priority service tier only to that conversation; it does not change saved model settings. A neighboring quota bar shows the applicable weekly limit and provider-declared reset time.

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

## Responses API experiments

The Settings page provides two Codex-only switches. Both are off by default:

- **WebSocket context reuse** keeps `store: false` and selects pi-ai's Codex WebSocket continuation transport. While the same session keeps a reusable connection and the next request is an exact extension, it sends `previous_response_id` with only the new input. History edits, compaction, Fork, connection loss, and process restarts fall back to a full request. With the switch off, ordinary turns use SSE and always send the full Harness context.
- **Native Responses compaction** follows Codex's current V2 flow: it sends the existing history plus a `compaction_trigger` item through `codex/responses`, retains recent client messages with the returned encrypted compaction item inside the Harness checkpoint, and restores those native items on later requests. Existing checkpoints remain readable after the switch is disabled. If V2 compaction is unavailable or fails, the same call falls back to the existing Harness model summary.

The switches are independent. Every ordinary Codex request keeps `store: false`; the default uses SSE with the text-summary path from `dsh-compaction-basic`.

## Credentials and privacy

dsh keeps this login separate from Codex CLI/Desktop:

- credentials are stored at `$DSH_HOME/.openai-codex-auth.json` (`~/.dsh` by default);
- writes are atomic and token refresh is locked across local dsh processes;
- browser status and diagnostics never return token values;
- `~/.codex/auth.json` is never copied or modified.

Keeping the stores separate prevents two clients from racing the same rotating refresh token. Removing the bundle does not delete the credential; use the account page or `logout` command when the local account should be removed.

## Compatibility notes

- This branch targets the published DSH `0.1.1-rc.2` plugin surfaces and remains runtime-compatible with the in-development `0.1.2-alpha.2` settings API. It uses `@earendil-works/pi-ai` `0.84.4` and migrates earlier pi-ai replay envelopes while reading history so existing reasoning/tool metadata remains usable after upgrades.
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
