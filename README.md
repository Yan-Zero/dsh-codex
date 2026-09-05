# dsh Codex

English | [中文](README.zh.md) | [AI deployment contract](README.ai.md)

> [!IMPORTANT]
> This repository is an enhanced public fork of [Yan-Zero/dsh-codex](https://github.com/Yan-Zero/dsh-codex). It depends on that upstream codebase and keeps the same package name, provider ID, OAuth storage, and routes. Install this build **instead of** upstream `dsh-codex`; never install both in one dsh profile.

Use a ChatGPT subscription in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through OpenAI's Codex sign-in flow—no OpenAI Platform API key or dsh source patch required.

`dsh-codex` is an independent dsh bundle. It adds:

- ChatGPT OAuth from the dsh Settings panel or a standalone CLI, with automatic token refresh
- the Codex GPT catalog, including vision-capable models when the account offers them
- streaming, tool calls, reasoning replay, prompt caching, and dsh compaction through the normal LLM service
- Codex standalone web search through dsh's existing `web_search` tool
- optional HTTP(S) URL input added to Harness's existing `read_image` tool
- an `imagegen` tool backed by `gpt-image-2`, with workspace or conversation reference images and automatic workspace output
- browser image input through dsh's existing paste and drop controls
- a persistent, provider-neutral SQLite usage ledger shared by the current-session HUD and **LLM Usage** analytics panel
- provider/time/exact-model/reasoning filters, task/session drill-down, and quota-free JSON reports

ChatGPT subscription authentication and usage-based OpenAI API access are different products. This plugin uses the ChatGPT Codex backend only; it does not turn a subscription into a general-purpose OpenAI API credential.

The **LLM Usage** surface counts tokens returned by DSH's normalized stream for the active session; it does not query account balances or provider quotas. It records uncached input, cached input, output, reasoning, and total tokens when the adapter reports them. DeepSeek, OpenCode Go, and Kimi routes are covered, and any other DSH adapter that emits the standard usage chunk is tracked automatically. Provider/model/reasoning choices still come from the user's existing DSH model configuration.

OpenAI Codex account quota remains available separately on the account page and through `/codex usage`; it is not mixed into session token analytics.


## Install

Install the prebuilt `v0.3.0` release archive into the selected dsh profile:

```sh
dsh plugin --profile web add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
dsh web
```

This GitHub release is the authoritative Analytics build. The npm package `dsh-codex@0.2.3` is the upstream base and does not contain this fork's complete Usage Ledger and Analytics UI.

From a DeepSeek Harness source checkout, prefix the same command with `pnpm`:

```sh
pnpm dsh plugin --profile web add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
```

A local checkout can be built with `pnpm install && pnpm run build` and installed using `link:/absolute/path/to/dsh-codex`.

Open **Settings → OpenAI Codex** and choose a login method. **Sign in with device code** is recommended when dsh-web runs over SSH: open the displayed verification page on any device where ChatGPT is signed in, enter the one-time code, and leave the dsh page open until it reports success. **Browser sign-in** remains available for a local browser and completes through the localhost callback. Starting one method cancels any login attempt that is stuck in the other method.

The account page shows live Codex quota bars at exactly the precision returned by OpenAI. The UI does not invent a credit denominator or display unavailable credit values.

The CLI remains available for terminal and headless installations:

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex login --device-code
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

For `dsh-tui`, install the bundle into the same profile:

```sh
dsh plugin --profile dsh-tui add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
```

After restarting the TUI, `/model` lists the `openai-codex` catalog. With no explicit route or saved selection, the TUI adopts the bundle's `gpt-5.6-sol` default. Use `/codex status|login|logout|usage|config` for the account and live settings; the four boolean settings can be changed with `/codex set <read-image|imagegen-other-models|websocket-context|native-compaction> <on|off>`, and reasoning summary detail with `/codex set reasoning-summary <auto|concise|detailed>`. Browser login shares the same dsh credential file used by the Web profile.

Codex, Claude Code, and other automation agents should follow [README.ai.md](README.ai.md). It is the compact, idempotent deployment contract and does not require reading source or design notes.

The bundle selects `openai-codex` / `gpt-5.6-sol` for new agents and selects the Codex search provider. A model already saved in dsh settings still takes precedence; the model picker can select any other Codex model visible to the signed-in account.

## Reasoning summaries

OpenAI does not expose a model's private raw reasoning tokens. When the model supports it, this plugin streams the provider-authored reasoning summary into dsh's collapsible **Think** block. Select **Settings → OpenAI Codex → Reasoning summary → Detailed**, or configure `reasoningSummary: detailed` on the `llm-openai-codex` profile row, to request the most explicit available explanation. The provider decides the returned content, so `detailed` can still be brief and cannot be used to reconstruct hidden chain-of-thought. `auto` remains the compatibility default and currently selects the most detailed summarizer available to the model.

## WebSocket recovery

**Settings → OpenAI Codex → WebSocket context reuse** is a live preference: after saving, new requests use WebSocket when enabled and SSE when disabled, normally without a restart. A cached WebSocket that closes abnormally is reported as a recoverable transport failure. dsh retries from the failed durable agent-step boundary, while pi-ai retires that connection and sends the retry through SSE. Tool calls completed in earlier steps are retained rather than executed again.

## Images

Image support uses dsh's durable attachment path:

- paste an image into the Web composer with <kbd>Ctrl</kbd>+<kbd>V</kbd>, or drag and drop it;
- on Windows, paste a clipboard image with <kbd>Ctrl</kbd>+<kbd>V</kbd> in the adapted dsh-tui, or enter `@relative/image.png`; clipboard images go straight to the attachment store, while path images use the active workspace filesystem;
- ask the model to call `read_image` with either `file_path` for a workspace image or `url` for an HTTP(S) image;
- PNG, JPEG, WebP, and GIF are accepted within the active dsh attachment limits;
- only a model that explicitly advertises image input may receive an image.

`imagegen` is available to any vision-capable conversation model. The current model writes an ordinary prompt and may select either `referenced_image_paths` or `num_last_images_to_include`; the plugin reads the bytes from `ctx.fs` or the attachment store and sends them to `gpt-image-2`. The model never emits base64. Every result is shown inline, saved as a durable attachment, and written to the active workspace. `output_path` chooses the destination; omitting it creates a unique `generated-<timestamp>-<id>.png` file. Local saving is included in this plugin, while `dsh-remote-ssh` supplies the remote AHP write path when that plugin owns the workspace.

The Settings page has separate **Enhance read_image** and **Image generation for other models** toggles. Both default on. Turning off the first removes the plugin's agent-scoped override and restores Harness's original local-only `read_image` schema. Turning off the second keeps `imagegen` available to Codex vision models and rejects calls from other model providers at execution time.

`read_image` stores validated bytes as a dsh attachment before returning the actual image block. Local paths are delegated unchanged to Harness, including its configured filesystem and sandbox behavior. The URL extension bounds redirects and bytes and rejects credentials embedded in URLs.

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
