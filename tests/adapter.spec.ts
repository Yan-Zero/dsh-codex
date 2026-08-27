import { describe, expect, it } from 'vitest'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import {
  createOpenAICodexAdapter,
  OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES,
  OPENAI_CODEX_REQUEST_IMAGE_POLICY,
  OPENAI_CODEX_RETRY_POLICY,
} from '../src/adapter.ts'
import { Config } from '../src/index.ts'

describe('OpenAI Codex adapter policy', () => {
  it('distinguishes an omitted model list from an explicitly empty list', () => {
    expect(Config({}).models).toBeUndefined()
    expect(Config({ models: [] }).models).toEqual([])
  })

  it('defines complete positive-integer request-image limits for the provider profile', () => {
    expect(OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES).toBe(20 * 1024 * 1024)
    expect(OPENAI_CODEX_REQUEST_IMAGE_POLICY).toEqual({
      maxPixels: 2048 * 2048,
      maxBytes: 1024 * 1024,
    })
    expect(Number.isSafeInteger(OPENAI_CODEX_MAX_REQUEST_IMAGE_BYTES)).toBe(true)
    expect(Number.isSafeInteger(OPENAI_CODEX_REQUEST_IMAGE_POLICY.maxPixels)).toBe(true)
    expect(Number.isSafeInteger(OPENAI_CODEX_REQUEST_IMAGE_POLICY.maxBytes)).toBe(true)
  })

  it('registers the extended bounded retry policy on the provider route', () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
    )

    expect(adapter.providerRetryPolicy(OPENAI_CODEX_PROVIDER)).toBe(OPENAI_CODEX_RETRY_POLICY)
    expect(OPENAI_CODEX_RETRY_POLICY).toMatchObject({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: expect.arrayContaining(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.2,
    })
  })

  it('advertises only configured models while keeping hidden models resolvable', async () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
      undefined,
      () => ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra'],
    )

    const models = await adapter.listModels(OPENAI_CODEX_PROVIDER)
    expect(models.map(model => model.id)).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra'])

    await expect(adapter.resolveModel(OPENAI_CODEX_PROVIDER, 'gpt-5.4')).resolves.toMatchObject({
      provider: OPENAI_CODEX_PROVIDER,
      id: 'gpt-5.4',
    })
  })

  it('advertises the full provider catalog when no model list is configured', async () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
    )

    const models = await adapter.listModels(OPENAI_CODEX_PROVIDER)
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining([
      'gpt-5.4',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]))
  })
})
