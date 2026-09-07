# dsh Codex

English | [中文](README.zh.md) | [AI deployment contract](README.ai.md)

> [!IMPORTANT]
> This repository is an enhanced public fork of [Yan-Zero/dsh-codex](https://github.com/Yan-Zero/dsh-codex). It depends on that upstream codebase and keeps the same package name, provider ID, OAuth storage, and routes. Install this build **instead of** upstream `dsh-codex`; never install both in one dsh profile.

Use a ChatGPT subscription in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through OpenAI's Codex sign-in flow—no OpenAI Platform API key or dsh source patch required.

`dsh-codex` is an independent dsh bundle. It adds:

- ChatGPT OAuth from the dsh Settings panel or a standalone CLI, with automatic token refresh
- the Codex GPT catalog, including vision-capable models when the account offers them
- a live client-side context-window capacity override for dsh's token meter and compaction policy
- streaming, tool calls, reasoning replay, prompt caching, and dsh compaction through the normal LLM service
- Codex standalone web search through dsh's existing `web_search` tool
- optional HTTP(S) URL input added to Harness's existing `read_image` tool
- an `imagegen` tool backed by `gpt-image-2`, with workspace or conversation reference images and automatic workspace output
- browser image input through dsh's existing paste and drop controls
- a persistent, provider-neutral SQLite usage ledger shared by the current-session HUD and **LLM Usage** analytics panel
- provider/time/exact-model/reasoning filters, task/session drill-down, and quota-free JSON reports
- a per-conversation Fast Mode switch and compact weekly quota indicator in the Web composer
- a three-scope HTTP(S) proxy control for Codex-only or process-wide routing

ChatGPT subscription authentication and usage-based OpenAI API access are different products. This plugin uses the ChatGPT Codex backend only; it does not turn a subscription into a general-purpose OpenAI API credential.

The **LLM Usage** surface counts tokens returned by DSH's normalized stream for the active session; it does not query account balances or provider quotas. It records uncached input, cached input, output, reasoning, and total tokens when the adapter reports them. DeepSeek, OpenCode Go, and Kimi routes are covered, and any other DSH adapter that emits the standard usage chunk is tracked automatically. Provider/model/reasoning choices still come from the user's existing DSH model configuration.

OpenAI Codex account quota remains available separately on the account page and through `/codex usage`; it is not mixed into session token analytics.


## Multiple accounts

Use **Settings → OpenAI Codex → Accounts** in DSH to add a named account, then complete browser or device-code login using the existing controls. The existing login remains the default account. Select the account to use, rename it, or sign out of that account without replacing another account's credentials.

Automatic switching on quota exhaustion is off by default. When enabled, a Codex model request may try other signed-in accounts in insertion order only after an explicit quota-exhaustion response and before emitting content. Each account is tried at most once; successful fallback updates the selection. Generic rate limits, network failures, invalid authentication, and partially emitted responses do not trigger switching. Changing the selection or disabling the option during a request prevents subsequent fallback attempts.

Selection applies to DSH instances sharing this credential configuration: new requests use the selected account, while in-flight requests retain their account. Search, image tools, and quota queries also follow selection; automatic retries apply to Codex model requests. Credentials and quota caches are isolated per account, while local token history remains provider-wide. Each new account requires its own OAuth authorization.

Native Codex compaction checkpoints remain bound to their original account. Switching such a conversation to another account is rejected with a prompt to switch back or start a new conversation. Visible history is preserved for ordinary account switching; account-private replay metadata is not forwarded to other accounts.

The existing credential file stays in place. Account metadata is stored alongside it with an `.accounts.json` suffix; new credential files live in the adjacent `.accounts/` directory with owner-only permissions. Up to 20 named accounts are supported. Never commit these credential files.

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
The plugin reads the Codex CLI/Desktop `models_cache.json` to discover models not yet bundled by pi-ai and update their names, input modalities, reasoning levels, and default `context_window`. It checks the file specified by `DSH_CODEX_MODELS_CACHE`, then `CODEX_HOME/models_cache.json`, then `~/.codex/models_cache.json`. Only valid entries with `visibility: list` are imported; the maximum expandable window does not replace the default capacity.

Codex CLI/Desktop refreshes this cache. Catalog discovery reads model metadata only and does not launch a Codex subprocess. OAuth login remains separate unless `credentialFile` is explicitly configured (see below). After updating and opening Codex, reopen the plugin's model settings or refresh the model list to discover changes. Missing, corrupt, or partially written caches retain the last usable catalog; a fresh start without a cache uses bundled models, including GPT-6 Astra. Catalog metadata does not guarantee model access for the account signed into dsh.

Saved model selections are preserved. Enable newly discovered models in the settings below; a temporarily unavailable cache does not delete saved model IDs. Newly discovered models without bundled pricing use a zero cost estimate, which does not mean the model is free.

By default, the model picker advertises the complete `openai-codex` catalog. Open **Settings → OpenAI Codex** and use the model checkboxes to choose which entries remain visible. The selection is live and durable; dsh refreshes the Web and TUI model directories after it changes.

## WebSocket recovery

**Settings → OpenAI Codex → WebSocket context reuse** is a live preference: after saving, new requests use WebSocket when enabled and SSE when disabled, normally without a restart. A cached WebSocket that closes abnormally is reported as a recoverable transport failure. dsh retries from the failed durable agent-step boundary, while pi-ai retires that connection and sends the retry through SSE. Tool calls completed in earlier steps are retained rather than executed again.

## Context window

Open **Settings → OpenAI Codex → Context window** to override the client-side capacity in K tokens. For example, enter `512` for 512,000 tokens. Leave the field empty to restore each model's pi-ai catalog default. The saved value applies to every Codex model on its next request and is shown by `/codex config`; an open conversation's meter refreshes after that request.

The initial value can also be seeded in exact tokens:

```yaml
- id: llm-openai-codex
  config:
    contextWindow: 512000
```

This mirrors Codex CLI's `model_context_window` concept on the Harness side; no context-window field is sent to the Responses endpoint. The resolved capacity drives dsh's context meter, overflow classification, output-token clamping, and automatic-compaction threshold. A smaller value compacts earlier. A larger value does not increase the backend model's real capacity, so unsupported values can still end in a provider overflow error.

## Network proxy

Open **Settings → OpenAI Codex → Network proxy** to select one of three scopes:

- **Follow dsh** leaves networking untouched. Codex inherits any process-wide proxy configured when dsh started.
- **Codex only** injects the selected proxy into Codex model SSE requests, native compaction, standalone search, image generation, quota reads, and OAuth token refresh. pi-ai's initial login exchange and WebSocket transport still follow the process policy.
- **All dsh** applies the proxy process-wide, including OAuth; requests from other plugins are affected too. Turning it off restores the policy that was active before this plugin overrode it.

The URL accepts `http://` and `https://` proxies. Leave it blank to use `DSH_CODEX_PROXY`, then the standard `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables. The default mode is **Follow dsh**, so installing the plugin never silently changes the process dispatcher.

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

For an eligible Codex GPT conversation, the Web composer also exposes a session-local Fast Mode switch. Enabling it adds the provider's priority service tier only to that conversation; it does not change saved model settings. A neighboring quota bar shows the applicable weekly limit and provider-declared reset time. The Settings page also has a **Force 1.5× speed by default** switch (off by default) that applies Fast Mode to every conversation without the per-conversation toggle; quota is consumed faster while it is on.

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

dsh keeps this login separate from Codex CLI/Desktop by default:

- credentials are stored at `$DSH_HOME/.openai-codex-auth.json` (`~/.dsh` by default);
- writes are atomic and token refresh is locked across local dsh processes;
- browser status and diagnostics never return token values;
- `~/.codex/auth.json` is never copied or modified.

Keeping the stores separate prevents two clients from racing the same rotating refresh token. Removing the bundle does not delete the credential; use the account page or `logout` command when the local account should be removed.

To share an existing login, set the plugin's `credentialFile` to an absolute JSON file path, for example `C:/Users/you/.codex/auth.json`. Existing documents are recognized by shape: Codex `tokens`, CPA/CLIProxyAPI `type: codex`, OpenCode `openai`, Pi `openai-codex`, flat OAuth, or native dsh. Unknown, ambiguous, incomplete, and API-key-only documents fail explicitly; a missing file is created in native dsh format. Use a regular file, not a symlink or hard link, with owner-only permissions on POSIX.

The selected credential must contain only recognized fields; unknown fields are rejected before refresh or writing, with field names but not values in diagnostics. Updates preserve the detected layout, recognized metadata, and other providers' independent entries. A provider-local OAuth refresh handler retains and writes the new access, refresh, and ID tokens, plus email when available, instead of pi-ai's reduced token projection. Login reuses pi-ai's interaction flow followed by one full refresh before saving. A response without an ID token fails explicitly rather than silently retaining stale identity. Logout clears the selected OAuth fields rather than deleting the shared document, and affects other consumers of that login.

Explicit shared files use in-process serialization, with no `.lock` or refresh-intent protocol. Before writing, the plugin re-reads the document and rejects a detected competing credential change. Same-directory temporary-file replacement prevents partial JSON from this writer on supported local filesystems, but does not guarantee crash durability or mutual exclusion with other programs. Simultaneous refreshes can still race; read-back validation cannot solve that. Default separate dsh storage retains its existing cross-process lock.

## Compatibility notes

- This branch targets the coherent published DSH `0.1.2-rc.1` plugin surfaces. Process-wide proxy mode composes with the official `dsh-http-proxy` library when a newer Harness provides it and uses a reversible compatibility dispatcher otherwise. It uses `@earendil-works/pi-ai` `0.84.4` and migrates earlier pi-ai replay envelopes while reading history so existing reasoning/tool metadata remains usable after upgrades.
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
