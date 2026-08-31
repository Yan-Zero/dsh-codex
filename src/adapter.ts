/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { createModels } from '@earendil-works/pi-ai'
import type { Context as PiContext, MutableModels, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'
import type { ModelCatalogEntry, ResponseApiPreferences } from './tool-policy.ts'
import type { FastModeRegistry } from './fast-mode.ts'

/** Return a detached copy of the complete pi-ai Codex model catalog. */
export function openAICodexModelCatalog(): readonly ModelCatalogEntry[] {
  return openaiCodexProvider().getModels().map(model => ({ id: model.id, name: model.name }))
}

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

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

/** Keep account-policy reads bounded while matching the official client's startup refresh model. */
const OPENAI_CODEX_USAGE_CACHE_MS = 15_000

function isQuotaFailure(chunk: StreamChunk): boolean {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return false
  return /quota|usage.?limit|rate.?limit|429/i.test(
    `${chunk.reason.failure.code} ${chunk.reason.failure.message}`,
  )
}

function isQuotaError(error: unknown): boolean {
  return /quota|usage.?limit|rate.?limit|429/i.test(error instanceof Error ? error.message : String(error))
}

/** Select only a server-authorized fallback that is present in the active model catalog. */
export function selectOpenAICodexFallbackModel(
  usage: OpenAICodexUsage | undefined,
  currentModel: string,
  availableModels: readonly Pick<LlmModelInfo, 'id'>[],
): string | undefined {
  const banner = usage?.rateLimitUpsell
  if (banner?.blockedModelSlug !== currentModel) return undefined
  return banner.fallbackModelSlugs.find(candidate => candidate !== currentModel
    && availableModels.some(model => model.id === candidate))
}

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
  private usageCache: { expiresAt: number; value: Promise<OpenAICodexUsage | undefined> } | undefined

  constructor(
    options: ConstructorParameters<typeof PiAiAdapter>[0],
    private readonly responses: OpenAICodexResponseRuntime,
    private readonly visibleModelIds?: () => readonly string[],
    private readonly credentials?: OpenAICodexCredentialStore,
  ) {
    super(options)
  }

  /** Read backend-owned fallback policy without making an ordinary model request. */
  private readUsage(forceRefresh = false): Promise<OpenAICodexUsage | undefined> {
    if (this.credentials === undefined) return Promise.resolve(undefined)
    const now = Date.now()
    if (!forceRefresh && this.usageCache !== undefined && this.usageCache.expiresAt > now) {
      return this.usageCache.value
    }
    const value = readOpenAICodexRateLimits(this.credentials).catch(() => undefined)
    this.usageCache = { expiresAt: now + OPENAI_CODEX_USAGE_CACHE_MS, value }
    return value
  }

  /** Convert the official CLI's ordered backend fallback into a Harness request. */
  private async fallbackOptions(
    options: GenerateOptions,
    forceRefresh = false,
  ): Promise<GenerateOptions | undefined> {
    if (options.provider !== OPENAI_CODEX_PROVIDER) return undefined
    const banner = (await this.readUsage(forceRefresh))?.rateLimitUpsell
    if (banner?.blockedModelSlug !== options.model) return undefined
    const available = await super.listModels(options.provider)
    const candidate = selectOpenAICodexFallbackModel(
      { rateLimits: [], rateLimitUpsell: banner },
      options.model,
      available,
    )
    if (candidate === undefined) return undefined
    const resolved = await super.resolveModel(options.provider, candidate)
    const requested = options.reasoningEffort
    const compatible = requested !== undefined
      && resolved.reasoning?.efforts.some(effort => String(effort.id) === String(requested)) === true
    const reasoningEffort = compatible ? requested : resolved.reasoning?.defaultEffort
    const fallback: GenerateOptions = {
      ...options,
      model: candidate,
    }
    return reasoningEffort === undefined ? fallback : { ...fallback, reasoningEffort }
  }

  override async listModels(provider: string) {
    const models = await super.listModels(provider)
    const visibleModelIds = this.visibleModelIds?.()
    if (visibleModelIds === undefined) return models
    const visible = new Set(visibleModelIds)
    return models.filter(model => visible.has(model.id))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const release = options.purpose === 'compaction'
      ? this.responses.enterCompaction(options.sessionId === undefined ? undefined : String(options.sessionId))
      : undefined
    try {
      let active = migrateReplayHistory(options)
      // This is the same server-driven decision the official CLI applies after
      // reading its account rate-limit snapshot. No fallback is inferred from
      // model names; OpenAI must explicitly provide the blocked model and its
      // ordered replacements.
      const initialFallback = active.purpose === 'compaction'
        ? undefined
        : await this.fallbackOptions(active)
      if (initialFallback !== undefined) active = initialFallback

      for (let attempt = 0; attempt < 2; attempt++) {
        const buffered: StreamChunk[] = []
        let outputStarted = false
        let quotaFailure = false
        try {
          for await (const chunk of super.stream(active)) {
            const isContent = chunk.type !== 'usage' && chunk.type !== 'finish'
            if (!outputStarted && isContent) {
              outputStarted = true
              for (const pending of buffered) yield pending
            }
            if (!outputStarted && chunk.type === 'finish' && isQuotaFailure(chunk)) {
              quotaFailure = true
              continue
            }
            if (quotaFailure) continue
            if (outputStarted) yield chunk
            else buffered.push(chunk)
          }
        } catch (error: unknown) {
          if (!outputStarted && isQuotaError(error)) quotaFailure = true
          else throw error
        }

        if (quotaFailure && !outputStarted && attempt === 0) {
          const fallback = await this.fallbackOptions(active, true)
          if (fallback !== undefined) {
            active = fallback
            continue
          }
        }
        for (const pending of buffered) yield pending
        return
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
): PiAiAdapter {
  const provider = openaiCodexProvider()
  const responses = new OpenAICodexResponseRuntime(responsePreferences)
  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[OPENAI_CODEX_PROVIDER, {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: 'OpenAI Codex',
    streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: OPENAI_CODEX_RETRY_POLICY,
    configuredMaxTokens: new Map(),
    piProvider: responses.wrap(requestProvider(provider, fastMode)),
  }]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new OpenAICodexAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments,
  }, responses, visibleModelIds, credentials)
}
