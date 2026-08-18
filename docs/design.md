# Design: portable OpenAI Codex facet

Status: implemented

English | [中文](design.zh.md)

## Scope

`dsh-codex` is a Community v0.15 DSH component. Its published Host facet uses DSH Standard resources and activation handlers. It contributes `Command/codex`, `ModelProvider/openai-codex`, `Tool/imagegen`, `ToolOverride` resources for `read_image` and provider-scoped `web_search` execution, and the durable Codex search request event; explicit package subpaths expose the standalone provider and its DSH session recorder.

The component has no profile patch, private HTTP settings routes, or TUI adapter. Its ordinary DSH package entry is inert on the Host, while an optional browser bundle publishes a standard local-module UI facet through `@dsh-std/adapter-dsh`. The adapter loads that bundle only when DSH Web's client-module host exists. The Host facet also declares and publishes dsh-tui's RFC 0006 `Scene` handler; dsh-tui binds it only when its private surface is installed, and other Hosts may ignore the unknown extension without loading TUI services. A Host remains responsible for the agent loop, sessions, attachments, workspace policy, tool execution, presentation, and command UI.

## Authentication and commands

OAuth endpoints, PKCE/device-code behavior, account-id extraction, token refresh, and Codex request authentication come from pi-ai's OpenAI Codex provider. Credentials are stored atomically in `$DSH_HOME/.openai-codex-auth.json`, independently of Codex CLI/Desktop credentials.

The Manifest contains the complete `/codex` command tree, including the values for `login`, `set`, and `on|off`, so a remote client can offer completion without knowing this package. `/codex login` defaults to device code. `/codex login browser` is explicit: it asks the invocation-scoped `ExternalRedirect` client to reserve pi-ai's exact `http://localhost:1455/auth/callback` URI, opens the authorization URL through optional `OpenExternal`, then returns the structured redirect query through pi-ai's existing manual-code prompt. If the URI is already occupied on a local deployment, pi-ai's own Runtime listener remains the fallback. Both presentation capabilities are optional so device-code-only clients can still load the facet.

`/codex set` changes activation-local preferences for the live model and tool handlers. The Web settings contribution uses the same standard command, so its mutations keep the normal command lifecycle in the session log; it does not introduce a Codex-specific settings protocol or private HTTP API.

## Model provider

`OpenAICodexModelHandler` implements the standard `ModelProvider` execution contract directly on pi-ai. It converts standard messages, tools, image references, tool results, stream chunks, usage, and replay metadata without manually registering or injecting a Host runtime service.

Tool-result images are resolved through the request-scoped `readImage` facility and preserved as provider image input. Encrypted reasoning signatures and response metadata are stored in standard message replay state. Each request honors cancellation and retains the former five-minute stream-idle ceiling.

Codex requests use `store: false`. Optional WebSocket context reuse is owned by `OpenAICodexResponseRuntime`; reuse is session-scoped and falls back to a full request when the transport or request prefix is unsuitable. Compaction calls stay off that continuation chain.

Optional native compaction sends a `compaction_trigger`, stores the encrypted checkpoint in a portable marker, and expands it on a later normal request. If native compaction is rejected before provider output escapes, the handler falls back to ordinary standard compaction. The Codex route intentionally omits the ordinary Responses output-token cap for compaction, matching provider behavior.

## Images and tools

The standard Tool contract carries only portable execution data: the routed model and modalities, image limits and validation, attachment save/read facilities, workspace read/write facilities, nested deferred content, and original-tool delegation. The DSH adapter maps those facilities to its attachment, filesystem, sandbox, observation, and tool runtimes. They are same-process activation values, not a new cross-endpoint protocol.

`read_image` is a live override. Workspace paths delegate to the Host's original tool. HTTP(S) input rejects embedded credentials, manually validates every redirect, caps declared and streamed bytes, honors cancellation, recognizes PNG/JPEG/WebP/GIF signatures, applies deployment media limits, saves an attachment, and returns the image block. Disabling `modifyReadImage` removes the override and restores the original definition.

`imagegen` always calls the fixed Codex `gpt-image-2` endpoint. It accepts either up to five workspace paths or the most recent one to five conversation images, never both. References are validated by the Host and become data URLs only inside the provider request. The PNG result is saved as an attachment and written to the active workspace; a rejected workspace write is reported without discarding the attachment. Models that receive the result must declare image input. A preference may restrict calls from non-Codex providers.

Binary workspace publication is a DSH adapter concern. Its adapter-local implementation applies write intent and sandbox policy, uses an atomic same-directory publish for local files, delegates remote writes to the active filesystem provider, and emits observation state. `dsh-codex` contains no filesystem-provider implementation.

## Search

`OpenAICodexSearchProvider` remains a Codex provider implementing `@deepseek-ai/dsh-web`'s existing provider seam. It keeps the fixed first-party endpoint, refreshable OAuth, cached/indexed/live mapping, exact secret-free request callback, cancellation across all phases, diagnostic redaction, and normalized citeable results.

The recorder is required and appends `web/openai-codex-search-llm-request` before dispatch. The Manifest declares that same current event contract; the DSH adapter keeps observed durable event names recognizable for the rest of the process, so facet reload cannot make existing history unreadable.

The Host facet publishes a provider-scoped, execution-only `ToolOverride` for `web_search`. This follows dsh-tui's actual composition: the generic Web service/provider remains Host-owned and the generic web tool remains agent-scoped. For an `openai-codex` agent, the adapter resolves that existing tool and replaces only its execution waterfall; it does not register another same-layer tool. The original input/output schema, renderer, presentation metadata, timeout, concurrency behavior, and TUI Web card remain authoritative.

DSH Standard does not define a Codex or Web Search resource for this. Product composition may also use the explicit `dsh-codex/search` and `dsh-codex/search-event` subpaths through the existing DSH Web and Session lifecycles.

## Packaging and tests

The build entries are `src/standard.ts`, `src/bin.ts`, `src/search.ts`, and `src/search-event.ts`. The package root remains the facet entry instead of re-exporting every internal helper; DSH-specific search APIs use explicit subpaths. `pnpm test` runs every retained test file. Tests drive standard handlers directly and cover provider wire requests, response transport and compaction, authentication storage, usage parsing, image tools, search, preferences, and Manifest/activation boundaries. Generic DSH Host mapping is tested in `@dsh-std/adapter-dsh`.

## Consequences

The component can be loaded by any compatible Host without manually hooking its private runtime registries. Public DSH packages may still be reused for their established types and domain seams. Product-only UI and registry integrations stay outside this package. ChatGPT plan eligibility, model access, quotas, OAuth behavior, image endpoints, and the standalone-search endpoint remain provider-controlled and may change independently.
