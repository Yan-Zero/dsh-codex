/** Bind each request to one account; only retry explicit quota failures before output. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { FetchFunction } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { OpenAICodexAccounts } from './accounts.ts'
import type { OpenAICodexCredentialStore } from './store.ts'

const quotaCode = /\b(?:usage_limit_reached|insufficient_quota|quota_exceeded)\b/i

const attempts = new AsyncLocalStorage<{ quota: boolean }>()

/** Retain provider quota codes before pi-ai replaces them with generic 429 text. */
export function withQuotaDetectionFetch(requestFetch: FetchFunction): FetchFunction {
  return async (input, init) => {
    const response = await requestFetch(input, init)
    const attempt = attempts.getStore()
    if (attempt !== undefined) attempt.quota = false
    if (attempt !== undefined && !response.ok && response.status !== 401 && response.status !== 403) {
      try {
        const body = await response.clone().json() as { error?: { code?: unknown; type?: unknown } }
        const code = body.error?.code ?? body.error?.type
        if (typeof code === 'string' && /^(?:usage_limit_reached|insufficient_quota|quota_exceeded)$/i.test(code)) {
          attempt.quota = true
        }
      } catch { /* Non-JSON errors remain unchanged. */ }
    }
    return response
  }
}

async function* scopedStream(source: AsyncIterable<StreamChunk>, attempt: { quota: boolean }): AsyncIterable<StreamChunk> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await attempts.run(attempt, () => iterator.next())
      if (next.done) return
      yield next.value
    }
  } finally {
    await attempts.run(attempt, () => iterator.return?.())
  }
}

function isQuotaFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const value = error as { code?: unknown; message?: unknown; name?: unknown; failure?: unknown }
  if (value.name === 'AbortError' || value.code === 'ABORTED' || value.code === 'AUTH') return false
  return (typeof value.code === 'string' && quotaCode.test(value.code)) ||
    (typeof value.message === 'string' && quotaCode.test(value.message))
}

const nativeMarker = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'
const accountMarker = /<dsh-openai-codex-account-v1>([^<]+)<\/dsh-openai-codex-account-v1>/

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Provider-private replay belongs to its producing account, not merely its model. */
function accountOptions(options: GenerateOptions, accountId: string): GenerateOptions {
  return { ...options, messages: options.messages.map(message => {
    const replay = message.source.kind === 'model' ? record(message.source.replayState) : undefined
    const owner = replay?.['dshCodexAccountId'] ?? 'default'
    for (const block of message.content) {
      if (block.type !== 'text' || !block.text.includes(nativeMarker)) continue
      // Compaction summaries may become user/context messages and lose provenance.
      // A text-side owner marker survives that durable checkpoint transformation.
      const checkpointOwner = accountMarker.exec(block.text)?.[1] ?? owner ?? 'default'
      if (checkpointOwner !== accountId) {
        throw new LlmError(
          'This conversation contains a native Codex compaction checkpoint from another account. Switch back to the original account or start a new conversation; automatic account switching cannot transfer this checkpoint.',
          'ACCOUNT_BOUND_CHECKPOINT',
        )
      }
    }
    if (message.source.kind !== 'model' || message.source.replayState === undefined || owner === accountId) return message
    const { replayState: _privateReplay, ...source } = message.source
    return { ...message, source }
  }) }
}

function stampNativeText(text: string, accountId: string): string {
  if (!text.includes(nativeMarker) || accountMarker.test(text)) return text
  return text.replace(nativeMarker, `<dsh-openai-codex-account-v1>${accountId}</dsh-openai-codex-account-v1>${nativeMarker}`)
}

function accountChunk(chunk: StreamChunk, accountId: string): StreamChunk {
  if (chunk.type === 'finish' && chunk.replayState !== undefined) {
    return { ...chunk, replayState: { ...chunk.replayState, dshCodexAccountId: accountId } as typeof chunk.replayState }
  }
  if (chunk.type === 'text-delta') return { ...chunk, text: stampNativeText(chunk.text, accountId) }
  if (chunk.type === 'block-end' && chunk.block.type === 'text') {
    return { ...chunk, block: { ...chunk.block, text: stampNativeText(chunk.block.text, accountId) } }
  }
  return chunk
}

type Candidate = { id: string; store: OpenAICodexCredentialStore }

export function withAccountRouting(
  base: PiAiAdapter,
  accounts: OpenAICodexAccounts,
  create: (store: OpenAICodexCredentialStore) => PiAiAdapter,
): PiAiAdapter {
  const adapters = new Map<string, PiAiAdapter>()
  function adapter(candidate: Candidate): PiAiAdapter {
    let instance = adapters.get(candidate.id)
    if (instance === undefined) {
      instance = create(candidate.store)
      adapters.set(candidate.id, instance)
    }
    return instance
  }
  async function candidates(): Promise<Candidate[]> {
    const seen = new Set<string>()
    return (await accounts.candidates()).filter(({ id }) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }
  async function* route(
    choices: Candidate[],
    options: GenerateOptions,
    prepared?: PreparedAdapterCall,
    preparationSignal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const first = choices[0]
    if (first === undefined) throw new LlmError('No connected OpenAI Codex account is selected', 'AUTH')
    for (const [index, candidate] of choices.entries()) {
      options.signal?.throwIfAborted()
      preparationSignal?.throwIfAborted()
      let emitted = false
      const attempt = { quota: false }
      // pi-ai emits usage before its terminal error, including for rejected requests.
      // Hold that single chunk until the terminal result so failed attempts stay invisible.
      let pendingUsage: Extract<StreamChunk, { type: 'usage' }> | undefined
      try {
        const request = accountOptions(options, candidate.id)
        const source = prepared === undefined
          ? adapter(candidate).stream(request)
          : (index === 0 ? prepared : await adapter(candidate).prepareCall(
              options.provider, options.model, preparationSignal,
            )).stream(request)
        for await (const chunk of scopedStream(source, attempt)) {
          if (chunk.type === 'usage' && !emitted && pendingUsage === undefined) {
            pendingUsage = chunk
            continue
          }
          if (chunk.type === 'finish' && chunk.reason.kind === 'error' && !emitted &&
            (attempt.quota || isQuotaFailure(chunk.reason.failure)) && !options.signal?.aborted && !preparationSignal?.aborted) {
            throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code)
          }
          if (pendingUsage !== undefined) {
            emitted = true
            yield pendingUsage
            pendingUsage = undefined
          }
          emitted = true
          if (chunk.type === 'finish' && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted' && index > 0 &&
            !options.signal?.aborted && !preparationSignal?.aborted) {
            // A later manual selection wins over this in-flight failover.
            await accounts.selectAfterFailover(first.id, candidate.id)
          }
          yield accountChunk(chunk, candidate.id)
        }
        if (pendingUsage !== undefined) yield pendingUsage
        return
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') ||
          (error instanceof LlmError && (error.code === 'ABORTED' || error.code === 'AUTH')) ||
          emitted || options.signal?.aborted || preparationSignal?.aborted || (!attempt.quota && !isQuotaFailure(error)) || index === choices.length - 1) {
          if (pendingUsage !== undefined) yield pendingUsage
          throw error
        }
        // Honor settings changed while this fixed-account request was in flight.
        // The new selection affects later requests; it must not redirect this one.
        const current = await candidates()
        const next = choices[index + 1]
        if (current[0]?.id !== first.id || next === undefined || !current.some(account => account.id === next.id)) {
          if (pendingUsage !== undefined) yield pendingUsage
          throw error
        }
      }
    }
  }
  return new Proxy(base, {
    get(target, property) {
      if (property === 'stream') return async function* (options: GenerateOptions) {
        yield* route(await candidates(), options)
      }
      if (property === 'prepareCall') return async (provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> => {
        signal?.throwIfAborted()
        const choices = await candidates()
        const first = choices[0]
        if (first === undefined) throw new LlmError('No connected OpenAI Codex account is selected', 'AUTH')
        const prepared = await adapter(first).prepareCall(provider, model, signal)
        return { model: prepared.model, stream: options => route(choices, options, prepared, signal) }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
