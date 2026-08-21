/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { createModels } from '@earendil-works/pi-ai'
import type { Context as PiContext, MutableModels, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import type { ModelCatalogEntry, ResponseApiPreferences } from './tool-policy.ts'
import type { FastModeRegistry } from './fast-mode.ts'

/** Return a detached copy of the complete pi-ai Codex model catalog. */
export function openAICodexModelCatalog(): readonly ModelCatalogEntry[] {
  return openaiCodexProvider().getModels().map(model => ({ id: model.id, name: model.name }))
}

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image request budgets for the composite profile, mirroring the
 * dsh-llm-pi-ai defaults. `ResolvedPiAiProviderProfile` gained these required
 * fields after the dsh `0.1.0-rc.7` this package pins: newer hosts hand them
 * to attachment policy validation, so an image-bearing request fails with
 * `Image request maxPixels must be a positive integer` when they are absent,
 * while older hosts ignore them. The spread keeps the profile literal free
 * of excess-property errors against the pinned rc.7 types.
 */
const OPENAI_CODEX_IMAGE_REQUEST_BUDGETS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
}

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

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const release = options.purpose === 'compaction'
      ? this.responses.enterCompaction(options.sessionId === undefined ? undefined : String(options.sessionId))
      : undefined
    try {
      for await (const chunk of super.stream(migrateReplayHistory(options))) yield chunk
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
    ...OPENAI_CODEX_IMAGE_REQUEST_BUDGETS,
    piProvider: responses.wrap(requestProvider(provider, fastMode)),
  }]])
  const models: MutableModels = createModels({ credentials })
  models.setProvider(provider)
  return new OpenAICodexAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments,
  }, responses, visibleModelIds)
}
