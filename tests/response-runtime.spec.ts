import { describe, expect, it } from 'vitest'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { SimpleStreamOptions, Transport } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { OpenAICodexResponseRuntime } from '../src/responses.ts'

function runtimeHarness(initialReuse: boolean) {
  let reuse = initialReuse
  const transports: Array<Transport | undefined> = []
  const streamOptions: SimpleStreamOptions[] = []
  const base = openaiCodexProvider()
  const provider = {
    ...base,
    streamSimple: (_model, _context, options?: SimpleStreamOptions) => {
      transports.push(options?.transport)
      if (options !== undefined) streamOptions.push(options)
      return createAssistantMessageEventStream()
    },
  } satisfies typeof base
  const runtime = new OpenAICodexResponseRuntime(() => ({
    useWebSocketContextReuse: reuse,
    useNativeCompaction: false,
  }))
  const wrapped = runtime.wrap(provider)
  const model = base.getModels().find(candidate => candidate.id === 'gpt-5.6-sol')
    ?? base.getModels()[0]
  if (model === undefined) throw new Error('Codex provider has no test model')
  const call = (sessionId: string): void => {
    wrapped.streamSimple(model, { messages: [] }, { sessionId })
  }
  return {
    transports,
    streamOptions,
    runtime,
    model,
    call,
    setReuse(value: boolean): void { reuse = value },
  }
}

describe('OpenAICodexResponseRuntime transport policy', () => {
  it('uses explicit SSE while context reuse is disabled', () => {
    const harness = runtimeHarness(false)

    harness.call('session-sse')

    expect(harness.transports).toEqual(['sse'])
  })

  it('delegates matching continuation state to pi-ai WebSocket caching', () => {
    const harness = runtimeHarness(true)

    harness.call('session-websocket')

    expect(harness.transports).toEqual(['websocket-cached'])
  })

  it('preserves the provider-owned store:false payload', async () => {
    const harness = runtimeHarness(true)
    harness.call('session-store-false')

    const transformed = await harness.streamOptions[0]?.onPayload?.({ store: false, input: [] }, harness.model)

    expect(transformed).toEqual({ store: false, input: [] })
  })

  it('keeps Harness compaction calls off the conversation WebSocket chain', () => {
    const harness = runtimeHarness(true)
    const leaveCompaction = harness.runtime.enterCompaction('session-compact')

    harness.call('session-compact')
    leaveCompaction()
    harness.call('session-compact')

    expect(harness.transports).toEqual(['sse', 'websocket-cached'])
  })

  it('applies live preference changes without retaining plugin continuation state', () => {
    const harness = runtimeHarness(false)

    harness.call('session-live')
    harness.setReuse(true)
    harness.call('session-live')
    harness.setReuse(false)
    harness.call('session-live')

    expect(harness.transports).toEqual(['sse', 'websocket-cached', 'sse'])
  })
})
