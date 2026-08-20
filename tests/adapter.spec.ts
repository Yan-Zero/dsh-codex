import { describe, expect, it } from 'vitest'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import {
  createOpenAICodexAdapter,
  OPENAI_CODEX_RETRY_POLICY,
} from '../src/adapter.ts'

describe('OpenAI Codex adapter policy', () => {
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
})
