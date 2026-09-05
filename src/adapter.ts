/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { createModels } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import type { Context as PiContext, MutableModels, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import type { ModelCatalogEntry, ResponseApiPreferences } from './tool-policy.ts'
import type { FastModeRegistry } from './fast-mode.ts'
import { createOpenAICodexProvider } from './provider.ts'
import type { CodexUsageTracker } from './usage-ledger.ts'

/** Usage correlation for auxiliary calls without provider continuation state. */
export interface UsageCorrelationHint {
  readonly usageSessionId?: string
  readonly usagePurpose?: string
}

export function usageCorrelationFor(
  options: GenerateOptions,
  requestId: string,
  usageTracker: Pick<CodexUsageTracker, 'correlation'>,
) {
  const hint = options as GenerateOptions & UsageCorrelationHint
  const sessionId = hint.usageSessionId
    ?? (options.sessionId === undefined ? undefined : String(options.sessionId))
  return usageTracker.correlation(sessionId, requestId, hint.usagePurpose ?? options.purpose)
}

/** Return a detached copy of the complete pi-ai Codex model catalog. */
export function openAICodexModelCatalog(): readonly ModelCatalogEntry[] {
  return createOpenAICodexProvider().getModels().map(model => ({ id: model.id, name: model.name }))
}

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Request-level cap for the accumulated base64 image payload. */
export const OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Per-image pixel cap expected by the current durable attachment pipeline. */
export const OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Per-image encoded-byte cap before base64 expansion. */
export const OPENAI_CODEX_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Lift the pre-rc.7 pi-ai replay shape into the current envelope on read. */
export function migrateLegacyOpenAICodexReplayState(value: unknown): unknown {
  const legacy = record(value)
  if (legacy?.['kind'] !== 'pi-ai' || legacy['version'] !== 1 || !Array.isArray(legacy['blocks'])) return value
  const {
    blocks,
    kind: _kind,
    version: _version,
    ...response
  } = legacy
  return {
    response: { ...response, kind: 'pi-ai', version: 2 },
    blocks,
  }
}

function migrateReplayHistory(options: GenerateOptions): GenerateOptions {
  let changed = false
  const messages = options.messages.map(message => {
    if (message.source.kind !== 'model' || message.source.replayState === undefined) return message
    const replayState = migrateLegacyOpenAICodexReplayState(message.source.replayState)
    if (replayState === message.source.replayState) return message
    changed = true
    return {
      ...message,
      source: { ...message.source, replayState },
    }
  })
  return changed ? { ...options, messages } : options
}

/**
 * Codex traffic rides on chatgpt.com, which is frequently reached through a
 * local proxy tunnel that blips for tens of seconds at a time. The dsh
 * default stops after 2 retries and caps scheduled delays at 10 seconds, so
 * this provider retries longer and backs off further to ride out such a blip.
 */
export const OPENAI_CODEX_RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 5,
  backoff: { initialDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 },
}, 'dsh-openai-codex retryPolicy')

/**
 * Give the generic dsh adapter a request-scoped bearer-token entry without
 * changing the provider's user-facing OAuth flow. The resolver accepts only
 * the explicit override supplied by this plugin; it never discovers an API
 * key from the environment or persistent api-key credentials.
 */
function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Add the request-scoped Fast Mode hint without changing other payload fields. */
export function withOpenAICodexFastMode(
  provider: Provider,
  fastMode: FastModeRegistry | undefined,
): Provider {
  const streamSimple = provider.streamSimple
  return {
    ...provider,
    streamSimple(model, context: PiContext, options?: SimpleStreamOptions) {
      const enabled = provider.id === OPENAI_CODEX_PROVIDER
        && model.provider === OPENAI_CODEX_PROVIDER
        && fastMode?.isEnabled(options?.sessionId) === true
      if (!enabled) return streamSimple.call(provider, model, context, options)
      const previousOnPayload = options?.onPayload
      return streamSimple.call(provider, model, context, {
        ...options,
        async onPayload(payload, payloadModel) {
          const replaced = await previousOnPayload?.(payload, payloadModel)
          const nextPayload = replaced === undefined ? payload : replaced
          return isPayloadRecord(nextPayload)
            ? { ...nextPayload, service_tier: 'priority' }
            : nextPayload
        },
      })
    },
  }
}

function requestProvider(provider: Provider, fastMode?: FastModeRegistry): Provider {
  return {
    ...withOpenAICodexFastMode(provider, fastMode),
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'OpenAI Codex OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'OAuth' }
        },
      },
    },
  }
}

/** Preserve Harness call purpose until the generic pi-ai adapter reaches the provider. */
class OpenAICodexAdapter extends PiAiAdapter {
  constructor(
    options: ConstructorParameters<typeof PiAiAdapter>[0],
    private readonly responses: OpenAICodexResponseRuntime,
    private readonly visibleModelIds?: () => readonly string[],
    private readonly usageTracker?: CodexUsageTracker,
  ) {
    super(options)
  }

  override async listModels(provider: string) {
    const models = await super.listModels(provider)
    const visibleModelIds = this.visibleModelIds?.()
    if (visibleModelIds === undefined) return models
    const visible = new Set(visibleModelIds)
    return models.filter(model => visible.has(model.id))
  }

  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: unknown
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    const parent = (PiAiAdapter.prototype as unknown as {
      prepareCall?: (p: string, m: string, s?: AbortSignal) => Promise<{
        model: unknown
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
      }>
    }).prepareCall
    const base = parent !== undefined
      ? parent.call(this, provider, model, signal)
      : this.resolveModel(provider, model, signal).then(resolved => ({
          model: resolved,
          stream: (options: GenerateOptions) => this.stream(options),
        }))
    return Promise.resolve(base).then(prepared => ({
      ...prepared,
      stream: (options: GenerateOptions) => this.streamWrapped(options, prepared.stream),
    }))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamWrapped(options, opts => super.stream(opts))
  }

  private async *streamWrapped(
    options: GenerateOptions,
    delegate: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const effectiveOptions: GenerateOptions = options.model === 'gpt-5.6-luna'
      && (options.reasoningEffort === undefined || options.reasoningEffort === 'medium')
      ? { ...options, reasoningEffort: ReasoningEffortId('max') }
      : options
    const migratedOptions = migrateReplayHistory(effectiveOptions)
    const release = migratedOptions.purpose === 'compaction'
      ? this.responses.enterCompaction(migratedOptions.sessionId === undefined ? undefined : String(migratedOptions.sessionId))
      : undefined
    const requestId = randomUUID()
    const requestStartedAt = Date.now()
    let usageRecorded = false
    try {
      for await (const chunk of delegate(migratedOptions)) {
        if (chunk.type === 'usage' && !usageRecorded && this.usageTracker !== undefined) {
          usageRecorded = true
          const providerUsage = chunk.usage as typeof chunk.usage & { serverCredits?: unknown; credits?: unknown }
          const directCredits = typeof providerUsage.serverCredits === 'number'
            ? providerUsage.serverCredits
            : typeof providerUsage.credits === 'number' ? providerUsage.credits : undefined
          await this.usageTracker.record({
            requestId,
            durationMs: Date.now() - requestStartedAt,
            correlation: usageCorrelationFor(migratedOptions, requestId, this.usageTracker),
            provider: OPENAI_CODEX_PROVIDER,
            model: migratedOptions.model,
            ...migratedOptions.reasoningEffort === undefined ? {} : { reasoningEffort: String(migratedOptions.reasoningEffort) },
            ...directCredits === undefined || !Number.isFinite(directCredits) || directCredits < 0
              ? {}
              : { serverCredits: directCredits },
            usage: chunk.usage,
          }).catch((error: unknown) => {
            process.emitWarning(`dsh-openai-codex: failed to persist usage: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
        yield chunk
      }
    } finally {
      release?.()
    }
  }
}

/**
 * Create the Codex subscription adapter without requiring a dsh fork. The
 * public pi-ai adapter owns Harness message conversion, image attachment
 * resolution, streaming, and reasoning metadata. This plugin adds optional
 * Codex-native request state/compaction and supplies the provider OAuth token.
 */
export function createOpenAICodexAdapter(
  credentials: OpenAICodexCredentialStore,
  resolveAttachments: () => AttachmentStore | undefined,
  responsePreferences: () => ResponseApiPreferences,
  fastMode?: FastModeRegistry,
  visibleModelIds?: () => readonly string[],
  usageTracker?: CodexUsageTracker,
): PiAiAdapter {
  const provider = createOpenAICodexProvider()
  const responses = new OpenAICodexResponseRuntime(responsePreferences)
  const profile: ResolvedPiAiProviderProfile & {
    maxRequestImageBytes: number
    requestImagePixelBudget: number
    requestImageMaxBytes: number
  } = {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: OPENAI_CODEX_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: OPENAI_CODEX_RETRY_POLICY,
    configuredMaxTokens: new Map(),
    piProvider: responses.wrap(requestProvider(provider, fastMode)),
  }
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[OPENAI_CODEX_PROVIDER, profile]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new OpenAICodexAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments,
  }, responses, visibleModelIds, usageTracker)
}
