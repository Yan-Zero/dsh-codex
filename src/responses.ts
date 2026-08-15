/** Codex WebSocket transport selection and native compaction experiments. */

import {
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Api,
  Context as PiContext,
  Model,
  Provider,
  SimpleStreamOptions,
  Usage,
} from '@earendil-works/pi-ai'
import {
  convertResponsesMessages,
  convertResponsesTools,
} from '@earendil-works/pi-ai/api/openai-responses-shared'
import type { ResponseApiPreferences } from './tool-policy.ts'

/** Native compact endpoint used by the official Codex client. */
export const OPENAI_CODEX_COMPACT_URL = 'https://chatgpt.com/backend-api/codex/responses/compact'

const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode'])
const COMPACTION_MARKER_OPEN = '<dsh-openai-codex-compaction-4f5cf1b7-v1>'
const COMPACTION_MARKER_CLOSE = '</dsh-openai-codex-compaction-4f5cf1b7-v1>'
const NO_SESSION = '<no-session>'

type JsonRecord = Record<string, unknown>

interface CompactResponse {
  readonly id: string
  readonly output: readonly unknown[]
  readonly usage?: JsonRecord
}

/** Whether an opaque value is a non-array record. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a finite non-negative number from an API usage object. */
function usageNumber(record: JsonRecord | undefined, key: string): number {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Map Responses usage without assigning a price to subscription traffic. */
function compactUsage(raw: JsonRecord | undefined): Usage {
  if (raw === undefined) return emptyUsage()
  const inputDetails = isRecord(raw['input_tokens_details']) ? raw['input_tokens_details'] : undefined
  const outputDetails = isRecord(raw['output_tokens_details']) ? raw['output_tokens_details'] : undefined
  const inputTokens = usageNumber(raw, 'input_tokens')
  const cacheRead = usageNumber(inputDetails, 'cached_tokens')
  const cacheWrite = usageNumber(inputDetails, 'cache_write_tokens')
  const reasoning = usageNumber(outputDetails, 'reasoning_tokens')
  return {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output: usageNumber(raw, 'output_tokens'),
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens: usageNumber(raw, 'total_tokens'),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Extract the ChatGPT account id paired with a Codex OAuth access token. */
function accountIdFromToken(access: string): string {
  try {
    const parts = access.split('.')
    if (parts.length !== 3 || parts[1] === undefined) throw new Error('invalid JWT')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JsonRecord
    const auth = payload['https://api.openai.com/auth']
    if (!isRecord(auth)) throw new Error('missing auth claim')
    const accountId = auth['chatgpt_account_id']
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('missing account id')
    return accountId
  } catch (error: unknown) {
    throw new Error('OpenAI Codex credential has no usable account id; sign in again', { cause: error })
  }
}

/** Validate and encode provider-native compact output inside a durable text checkpoint. */
function nativeCompactionMarker(output: readonly unknown[]): string {
  if (!output.some(item => isRecord(item) && item['type'] === 'compaction')) {
    throw new Error('OpenAI Codex compact response did not contain a compaction item')
  }
  return `${COMPACTION_MARKER_OPEN}${JSON.stringify(output)}${COMPACTION_MARKER_CLOSE}`
}

/** Decode one plugin-owned marker. User text without a complete valid marker is untouched. */
function markerOutput(text: string): readonly unknown[] | undefined {
  const start = text.indexOf(COMPACTION_MARKER_OPEN)
  if (start < 0) return undefined
  const payloadStart = start + COMPACTION_MARKER_OPEN.length
  const end = text.indexOf(COMPACTION_MARKER_CLOSE, payloadStart)
  if (end < 0) return undefined
  const parsed: unknown = JSON.parse(text.slice(payloadStart, end))
  if (!Array.isArray(parsed) || !parsed.some(item => isRecord(item) && item['type'] === 'compaction')) {
    throw new Error('OpenAI Codex native compaction checkpoint is malformed')
  }
  return parsed
}

/** Replace a framed Harness checkpoint with the native items it durably carries. */
export function expandNativeCompactionMarkers(input: readonly unknown[]): unknown[] {
  const expanded: unknown[] = []
  for (const item of input) {
    if (!isRecord(item) || item['role'] !== 'user' || !Array.isArray(item['content'])) {
      expanded.push(item)
      continue
    }
    let replacement: readonly unknown[] | undefined
    for (const content of item['content']) {
      if (!isRecord(content) || content['type'] !== 'input_text' || typeof content['text'] !== 'string') continue
      const decoded = markerOutput(content['text'])
      if (decoded !== undefined) {
        replacement = decoded
        break
      }
    }
    if (replacement === undefined) expanded.push(item)
    else expanded.push(...replacement)
  }
  return expanded
}

function sessionKey(sessionId: string | undefined): string {
  return sessionId ?? NO_SESSION
}

/** Emit a one-block pi-ai response containing the durable native checkpoint marker. */
function markerStream(model: Model<Api>, response: CompactResponse): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const text = nativeCompactionMarker(response.output)
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: model.provider,
    model: model.id,
    responseId: response.id,
    usage: compactUsage(response.usage),
    stopReason: 'stop',
    timestamp: Date.now(),
  }
  queueMicrotask(() => {
    stream.push({ type: 'start', partial })
    partial.content.push({ type: 'text', text: '' })
    stream.push({ type: 'text_start', contentIndex: 0, partial })
    ;(partial.content[0] as { type: 'text'; text: string }).text = text
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial })
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial })
    stream.push({ type: 'done', reason: 'stop', message: partial })
  })
  return stream
}

function failedStream(model: Model<Api>, error: unknown, signal?: AbortSignal): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const aborted = signal?.aborted === true
  const failure: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  }
  queueMicrotask(() => {
    stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: failure })
  })
  return stream
}

function compactResponse(value: unknown): CompactResponse {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !Array.isArray(value['output'])) {
    throw new Error('OpenAI Codex returned a malformed compact response')
  }
  if (!value['output'].some(item => isRecord(item) && item['type'] === 'compaction')) {
    throw new Error('OpenAI Codex compact response did not contain a compaction item')
  }
  const usage = value['usage']
  if (usage !== undefined && !isRecord(usage)) throw new Error('OpenAI Codex returned malformed compact usage')
  return { id: value['id'], output: value['output'], ...usage === undefined ? {} : { usage } }
}

/** Mutable request policy shared by the Harness adapter and its pi-ai provider. */
export class OpenAICodexResponseRuntime {
  private readonly compactionCalls = new Map<string, number>()

  constructor(private readonly preferences: () => ResponseApiPreferences) {}

  /** Mark one Harness stream call as compaction until its iterator closes. */
  enterCompaction(sessionId: string | undefined): () => void {
    const key = sessionKey(sessionId)
    this.compactionCalls.set(key, (this.compactionCalls.get(key) ?? 0) + 1)
    return () => {
      const remaining = (this.compactionCalls.get(key) ?? 1) - 1
      if (remaining <= 0) this.compactionCalls.delete(key)
      else this.compactionCalls.set(key, remaining)
    }
  }

  /** Add Codex-only request behavior without changing the provider catalog or OAuth flow. */
  wrap(provider: Provider): Provider {
    return {
      ...provider,
      streamSimple: (model, context, options) => this.streamSimple(provider, model, context, options),
    }
  }

  private streamSimple(
    provider: Provider,
    model: Model<Api>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const key = sessionKey(options?.sessionId)
    const compaction = (this.compactionCalls.get(key) ?? 0) > 0
    const preferences = this.preferences()
    if (compaction && preferences.useNativeCompaction) {
      return this.nativeCompactionStream(model, context, options)
    }
    return this.standardStream(provider, model, context, options, !compaction && preferences.useWebSocketContextReuse)
  }

  private standardStream(
    provider: Provider,
    model: Model<Api>,
    context: PiContext,
    options: SimpleStreamOptions | undefined,
    reuseWebSocketContext: boolean,
  ): AssistantMessageEventStream {
    return provider.streamSimple(model, context, {
      ...options,
      transport: reuseWebSocketContext ? 'websocket-cached' : 'sse',
      onPayload: async (payload, payloadModel) => {
        if (!isRecord(payload)) throw new Error('OpenAI Codex generated a non-object Responses payload')
        const input = Array.isArray(payload['input']) ? expandNativeCompactionMarkers(payload['input']) : payload['input']
        const transformed = { ...payload, input }
        return options?.onPayload === undefined
          ? transformed
          : await options.onPayload(transformed, payloadModel)
      },
    })
  }

  private nativeCompactionStream(
    model: Model<Api>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const target = createAssistantMessageEventStream()
    void this.requestNativeCompaction(model, context, options).then(
      response => {
        const source = markerStream(model, response)
        void (async () => { for await (const event of source) target.push(event) })()
      },
      error => {
        const failure = failedStream(model, error, options?.signal)
        void (async () => { for await (const event of failure) target.push(event) })()
      },
    )
    return target
  }

  private async requestNativeCompaction(
    model: Model<Api>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): Promise<CompactResponse> {
    const access = options?.apiKey
    if (access === undefined || access.length === 0) throw new Error('OpenAI Codex compact request has no OAuth token')
    const messages = context.messages.length === 0 ? [] : context.messages.slice(0, -1)
    const input = expandNativeCompactionMarkers(convertResponsesMessages(
      model,
      { ...context, messages },
      CODEX_TOOL_CALL_PROVIDERS,
      { includeSystemPrompt: false },
    ))
    const compat = model.compat as { supportsStrictMode?: boolean; supportsOpenAIGrammarTools?: boolean } | undefined
    const supportsStrictMode = compat?.supportsStrictMode ?? true
    const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools ?? false
    const tools = context.tools === undefined || context.tools.length === 0
      ? undefined
      : convertResponsesTools(context.tools, {
          strict: null,
          supportsStrictMode,
          supportsOpenAIGrammarTools,
        })
    const mappedEffort = options?.reasoning === undefined
      ? undefined
      : model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning
    const body = {
      model: model.id,
      input,
      instructions: context.systemPrompt ?? '',
      ...tools === undefined ? {} : { tools },
      parallel_tool_calls: true,
      ...mappedEffort === undefined || mappedEffort === null
        ? {}
        : { reasoning: { effort: mappedEffort, summary: 'auto' } },
      ...options?.sessionId === undefined ? {} : { prompt_cache_key: options.sessionId },
      text: { verbosity: 'low' },
    }
    const headers = new Headers(model.headers)
    for (const [key, value] of Object.entries(options?.headers ?? {})) {
      if (value === null) headers.delete(key)
      else headers.set(key, value)
    }
    headers.set('authorization', `Bearer ${access}`)
    headers.set('chatgpt-account-id', accountIdFromToken(access))
    headers.set('originator', 'dsh-codex')
    headers.set('accept', 'application/json')
    headers.set('content-type', 'application/json')
    headers.set('openai-beta', 'responses=experimental')
    if (options?.sessionId !== undefined) {
      headers.set('session-id', options.sessionId)
      headers.set('x-client-request-id', options.sessionId)
    }
    const response = await fetch(OPENAI_CODEX_COMPACT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...options?.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000)
      throw new Error(`OpenAI Codex compact request failed with HTTP ${response.status}${detail.length === 0 ? '' : `: ${detail}`}`)
    }
    return compactResponse(await response.json())
  }
}
