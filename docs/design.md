# Design: OpenAI Codex subscription bundle

Status: implemented

English | [中文](design.zh.md)

## Scope

`dsh-codex` is a standard DeepSeek Harness bundle. It adds ChatGPT OAuth, the Codex model catalog, a Codex standalone-search provider, browser account settings, `view_image`, and `imagegen` without modifying dsh source code. The active dsh profile continues to own the agent loop, attachments, filesystem policy, tools, permissions, compaction, and Web composer.

## Authentication

The plugin delegates OAuth endpoints, PKCE/device-code behavior, account-id extraction, token refresh, and Codex request authentication to the pi-ai Codex provider supplied by dsh's base bundle. Users can start the same login lifecycle from the plugin's Settings section or its `dsh-openai-codex` executable. Web auth routes accept only loopback, same-origin requests, return `no-store` JSON, and never expose tokens. The account page reads the fixed ChatGPT Codex usage endpoint without issuing a model request, converts server-reported usage into remaining-percentage bars, and includes exact credit or workspace-limit amounts only when those fields are present.

Credentials are stored as a versioned JSON document at `$DSH_HOME/.openai-codex-auth.json`. Writes are atomic and a cross-process lock covers login, refresh, and logout. This store is intentionally separate from `~/.codex/auth.json`; sharing a rotating refresh token between independently writing clients would make either client able to invalidate the other.

## Model adapter and compaction

The bundle constructs the public `PiAiAdapter` with the installed `openai-codex` provider and model catalog. Its credential resolver refreshes OAuth state and supplies the resulting bearer token as an explicit request credential. It does not discover ambient API keys or require a private dsh adapter helper.

Normal turns and `dsh-compaction-basic` therefore use the standard LLM service. Message conversion, streaming, tool calls, image attachment resolution, usage, overflow classification, encrypted reasoning replay, and cancellation remain adapter behavior. Codex requests are stateless (`store: false`), so replay data and complete tool-call/result pairs are kept in the Harness session rather than relying on server-stored response ids.

The ChatGPT Codex route does not apply the ordinary Responses output-token limit. Compaction still uses the catalog context capacity and standard checkpoint replacement, but the configured summary token cap cannot be enforced server-side on this route.

## Images

Codex models inherit their declared input modalities from the provider catalog. The existing dsh Web composer already converts pasted or dropped images into durable attachments, so the browser plugin only adds account settings and does not replace the composer.

The plugin-owned `view_image` tool accepts a local path or an HTTP(S) URL. Local reads go through the configured filesystem service. Remote downloads reject embedded URL credentials, limit redirects and bytes, and honor cancellation. PNG, JPEG, WebP, and GIF bytes are detected by signature and saved through the attachment service before the tool returns an actual image content block. The tool refuses to run unless the selected model explicitly declares image input.

`imagegen` always executes against the fixed ChatGPT Codex `gpt-image-2` endpoint, independently of the current conversation model. The caller must still declare image input because the tool result contains an image block used by the next model turn. A generation has no references; an edit accepts up to five workspace paths or the most recent one to five conversation image attachments. These two selectors are mutually exclusive. Path reads use `ctx.fs`; conversation references use the attachment store. Base64 data URLs exist only in the private provider request.

Every generated PNG is saved as an attachment and published into the active workspace. `output_path` selects the destination; without it, the plugin creates a collision-resistant `generated-<timestamp>-<id>.png` name. A keyed `imagegen` tool view resolves the durable attachment through the owning session and displays it inline with an original-size preview. Released dsh versions do not expose a binary write primitive, so the plugin includes an atomic local-file compatibility writer that enforces the active sandbox policy before touching a `file:` target. Non-file execution worlds must expose `writeBytes`; `dsh-remote-ssh` does so and encodes bytes as base64 only inside AHP transport. There is no host-path fallback for a remote target. If policy or filesystem capability rejects the workspace write, the attachment remains available and the result reports the write failure.

Live settings persist two independent cross-provider switches. Codex vision models always retain access; the switches decide whether another provider's vision model may execute `view_image` or `imagegen`. Both defaults are enabled. Execution-time enforcement backs the browser controls.

## Search and session history

The bundle registers a provider for dsh's existing `web_search` tool. It uses the Codex standalone search endpoint with the same refreshable OAuth credential, maps structured text results to normalized HTTP(S) citations, and supports cached, indexed, and live modes. The endpoint is fixed so profile configuration cannot redirect the bearer token.

Before dispatch, the provider records the exact resolved, secret-free `{ endpoint, body }` request as `web/openai-codex-search-llm-request`. This dedicated event belongs to the plugin; it is declaration-merged into `SessionEventMap` and registered with the running session vocabulary when the plugin loads. The registration remains installed for the process lifetime so hot reload cannot make an already-written session unreadable.

The plugin never writes the discontinued generic `web/search-model-request` event. A session containing the dedicated Codex event requires this plugin to be loaded because the request is model-visible history and is intentionally not ignorable.

## Composition

`cordis.patch.yml` contributes one `llm-openai-codex` row, selects `openai-codex` / `gpt-5.6-sol` for new agents, and selects the matching search provider. A model saved in user settings still wins. Shell, filesystem, skills, MCP, subagents, permissions, attachments, compaction, and the `web_search` tool remain supplied by the chosen dsh profile.

## Consequences

A user can authenticate once per Harness home and use eligible Codex models, vision input, compaction, and Codex search without an OpenAI Platform API key. Removing the bundle does not delete credentials. ChatGPT plan eligibility, model access, quotas, OAuth behavior, and the standalone-search protocol remain provider-controlled and may change independently of this plugin.
