# Design: OpenAI Codex subscription bundle

Status: implemented

English | [中文](design.zh.md)

## Scope

`dsh-codex` is a standard DeepSeek Harness bundle. It adds ChatGPT OAuth, the Codex model catalog, a Codex standalone-search provider, browser account settings, an optional `read_image` URL extension, and `imagegen` without modifying dsh source code. The active dsh profile continues to own the agent loop, attachments, filesystem policy, tools, permissions, compaction, and Web composer.

## Authentication

The plugin delegates OAuth endpoints, PKCE/device-code behavior, account-id extraction, token refresh, and Codex request authentication to the pi-ai Codex provider supplied by dsh's base bundle. Users can start the same login lifecycle from the plugin's Settings section or its `dsh-openai-codex` executable. Web auth routes trust loopback same-origin requests by default and admit remote pages only after their exact origin is added to a separate owner-controlled allowlist. They return `no-store` JSON and never expose tokens. The account page reads the fixed ChatGPT Codex usage endpoint without issuing a model request, converts server-reported usage into remaining-percentage bars, and includes exact credit or workspace-limit amounts only when those fields are present.

Credentials are stored as a versioned JSON document at `$DSH_HOME/.openai-codex-auth.json`. Writes are atomic and a cross-process lock covers login, refresh, and logout. This store is intentionally separate from `~/.codex/auth.json`; sharing a rotating refresh token between independently writing clients would make either client able to invalidate the other.

## Model adapter and compaction

The bundle constructs the public `PiAiAdapter` with the installed `openai-codex` provider and model catalog. Its credential resolver refreshes OAuth state and supplies the resulting bearer token as an explicit request credential. It does not discover ambient API keys or require a private dsh adapter helper. A per-session Fast Mode registry adds `service_tier: priority` only to requests for sessions whose Web composer toggle is enabled. On rc.7, the adapter also lifts the previous pi-ai replay envelope into the current response/block form while reading history, preserving native reasoning and tool metadata from existing sessions.

Normal turns and `dsh-compaction-basic` therefore use the standard LLM service. Message conversion, streaming, tool calls, image attachment resolution, usage, overflow classification, encrypted reasoning replay, and cancellation remain adapter behavior. Codex requests always use `store: false`, so replay data and complete tool-call/result pairs stay in the Harness session rather than relying on server-persisted response ids.

With WebSocket context reuse disabled, the plugin explicitly selects SSE and each ordinary turn sends the complete Harness context. Enabling it selects pi-ai's `websocket-cached` transport, which mirrors the official Codex client: continuation state belongs to one session's reusable connection, and `previous_response_id` plus an input delta is sent only when non-input request properties match and the new input exactly extends the previous request and response. A mismatch, connection fallback, process restart, Fork session id, or compaction call uses a full request. The plugin stores no response continuation of its own.

Native compaction intercepts calls with `GenerateOptions.purpose === 'compaction'`, removes the private summarizer instruction appended by `dsh-compaction-basic`, and follows Codex's V2 flow through the normal `codex/responses` stream. It appends a `compaction_trigger` input item and expects one encrypted `compaction` output item. Recent client messages and that output are wrapped in a plugin marker so the existing compaction transaction still owns range validation, events, and surface replacement. When an ordinary Codex payload is built, the adapter replaces that marker with the native items. Expansion is independent of the current toggle, so checkpoints survive restarts and remain usable after the experiment is disabled. A V2 failure is handled before events escape the provider and falls back to the ordinary SSE summarization call with the complete Harness compaction prompt.

The ChatGPT Codex route does not apply the ordinary Responses output-token limit. Compaction still uses the catalog context capacity and standard checkpoint replacement, but the configured summary token cap cannot be enforced server-side on this route.

## Images

Codex models inherit their declared input modalities from the provider catalog. The existing dsh Web composer already converts pasted or dropped images into durable attachments, so the browser plugin only adds account settings and does not replace the composer.

When enabled, the plugin installs an agent-scoped definition that shadows Harness's existing `read_image`. Its schema keeps `file_path` and adds a mutually exclusive `url` input. Local calls delegate to the original definition, preserving its filesystem provider, sandbox policy, observation events, validation, and remote-workspace behavior. URL calls reject embedded credentials and every local, private, documentation, multicast, or otherwise special network address. DNS is revalidated on each redirect and the accepted address is pinned for that hop. Downloads remain redirect- and byte-bounded, honor cancellation, detect PNG/JPEG/WebP/GIF signatures, and save through the attachment service before returning an image block. The exact routed model must declare image input.

Earlier `view_image` results remain readable after the standalone tool is removed. Harness replays the durable `tool/result` message and attachment reference directly; it does not require the current tool registry to contain the historical name. A model that attempts a new `view_image` call receives the ordinary unknown-tool result and can retry with `read_image`.

`imagegen` always executes against the fixed ChatGPT Codex `gpt-image-2` endpoint, independently of the current conversation model. The caller must still declare image input because the tool result contains an image block used by the next model turn. A generation has no references; an edit accepts up to five workspace paths or the most recent one to five conversation image attachments. These two selectors are mutually exclusive. Path reads use `ctx.fs`; conversation references use the attachment store. Base64 data URLs exist only in the private provider request.

Every generated PNG is saved as an attachment and published into the active workspace. `output_path` selects the destination; without it, the plugin creates a collision-resistant `generated-<timestamp>-<id>.png` name. A keyed `imagegen` tool view resolves the durable attachment through the owning session and displays it inline with an original-size preview. Released dsh versions do not expose a binary write primitive, so the plugin includes an atomic local-file compatibility writer that enforces the active sandbox policy before touching a `file:` target. Non-file execution worlds must expose `writeBytes`; `dsh-remote-ssh` does so and encodes bytes as base64 only inside AHP transport. There is no host-path fallback for a remote target. If policy or filesystem capability rejects the workspace write, the attachment remains available and the result reports the write failure.

Live settings persist two independent switches. `modifyReadImage` adds or removes the scoped `read_image` definition for every live agent; disabling it immediately restores the original Harness definition and schema. `shareImagegenWithOtherModels` controls whether another provider's vision model may execute `imagegen`; Codex vision models retain access. Both default to enabled.

## Search and session history

The bundle registers a provider for dsh's existing `web_search` tool. It uses the Codex standalone search endpoint with the same refreshable OAuth credential, maps structured text results to normalized HTTP(S) citations, and supports cached, indexed, and live modes. The endpoint is fixed so profile configuration cannot redirect the bearer token.

Before dispatch, the provider records the exact resolved, secret-free `{ endpoint, body }` request as `web/openai-codex-search-llm-request`. This dedicated event belongs to the plugin; it is declaration-merged into `SessionEventMap` and registered with the running session vocabulary when the plugin loads. The registration remains installed for the process lifetime so hot reload cannot make an already-written session unreadable.

The plugin never writes the discontinued generic `web/search-model-request` event. A session containing the dedicated Codex event requires this plugin to be loaded because the request is model-visible history and is intentionally not ignorable.

## Composition

`cordis.patch.yml` contributes one `llm-openai-codex` row, selects `openai-codex` / `gpt-5.6-sol` for new agents, and selects the matching search provider. A model saved in user settings still wins. Shell, filesystem, skills, MCP, subagents, permissions, attachments, compaction, and the `web_search` tool remain supplied by the chosen dsh profile.

## Consequences

A user can authenticate once per Harness home and use eligible Codex models, vision input, compaction, and Codex search without an OpenAI Platform API key. Removing the bundle does not delete credentials. ChatGPT plan eligibility, model access, quotas, OAuth behavior, and the standalone-search protocol remain provider-controlled and may change independently of this plugin.
