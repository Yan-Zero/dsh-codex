import { describe, expect, it } from 'vitest'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import {
  createOpenAICodexAdapter,
  openAICodexModelCatalog,
  OPENAI_CODEX_RETRY_POLICY,
} from '../src/adapter.ts'
import { Config } from '../src/index.ts'

describe('OpenAI Codex adapter policy', () => {
  it('validates optional catalog and context-window configuration', () => {
    expect(Config({}).models).toBeUndefined()
    expect(Config({}).contextWindow).toBeUndefined()
    expect(Config({ models: [], contextWindow: 512_000 })).toMatchObject({ models: [], contextWindow: 512_000 })
    expect(() => Config({ contextWindow: 0 })).toThrow()
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

  it('supplies complete positive-integer image request budgets to the provider profile', () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
    )
    const profile = (adapter as unknown as {
      config: {
        profiles(): Map<string, {
          maxRequestImageBytes: number
          requestImagePixelBudget: number
          requestImageMaxBytes: number
        }>
      }
    }).config.profiles().get(OPENAI_CODEX_PROVIDER)

    expect(profile).toMatchObject({
      maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 1024 * 1024,
    })
    expect([
      profile?.maxRequestImageBytes,
      profile?.requestImagePixelBudget,
      profile?.requestImageMaxBytes,
    ].every(value => Number.isSafeInteger(value) && (value ?? 0) > 0)).toBe(true)
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

  it('rotates snapshot-consistent profiles when the client-side capacity changes', async () => {
    let contextWindow: number | null = null
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
      undefined,
      undefined,
      () => contextWindow,
    )

    const profileLoader = (adapter as unknown as {
      config: { profiles(): Map<string, { piProvider: { getModels(): readonly { id: string; contextWindow: number }[] } }> }
    }).config.profiles
    const firstProfiles = profileLoader()
    await expect(adapter.resolveModel(OPENAI_CODEX_PROVIDER, 'gpt-5.6-sol')).resolves.toMatchObject({
      context: { contextWindow: 272_000 },
    })

    contextWindow = 512_000
    const secondProfiles = profileLoader()
    expect(secondProfiles).not.toBe(firstProfiles)
    expect(profileLoader()).toBe(secondProfiles)
    expect(firstProfiles.get(OPENAI_CODEX_PROVIDER)?.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')).toMatchObject({
      contextWindow: 272_000,
    })
    expect(secondProfiles.get(OPENAI_CODEX_PROVIDER)?.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')).toMatchObject({
      contextWindow: 512_000,
    })
    await expect(adapter.resolveModel(OPENAI_CODEX_PROVIDER, 'gpt-5.6-sol')).resolves.toMatchObject({
      context: { contextWindow: 512_000 },
    })
    await expect(adapter.resolveModel(OPENAI_CODEX_PROVIDER, 'gpt-5.3-codex-spark')).resolves.toMatchObject({
      context: { contextWindow: 512_000 },
    })
  })

  it('projects provider context capacities into the settings catalog', () => {
    expect(openAICodexModelCatalog().find(model => model.id === 'gpt-5.6-sol')).toMatchObject({
      contextWindow: 272_000,
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
