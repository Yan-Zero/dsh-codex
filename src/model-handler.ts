/** Portable ModelProvider handler backed by pi-ai's OpenAI Codex provider. */

import { createModels } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  Context as PiContext,
  Message as PiMessage,
  Tool as PiTool,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type {
  ModelExecutionContext,
  ModelContentBlock,
  ModelGenerateRequest,
  ModelMessage,
  ModelProviderHandler,
  ModelStreamChunk,
} from '@dsh-std/model'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from './store.ts'
import { OpenAICodexResponseRuntime } from './responses.ts'
import type { ResponseApiPreferences } from './preferences.ts'

/** Provider idle ceiling preserved from the former DSH-specific adapter. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000

async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  controller: AbortController,
  timeoutMs: number,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`OpenAI Codex stream was idle for ${timeoutMs}ms`)
          controller.abort(error)
          reject(error)
        }, timeoutMs)
      })
      let next: IteratorResult<T>
      try {
        next = await Promise.race([iterator.next(), timeout])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (next.done) return
      yield next.value
    }
  } finally {
    controller.abort()
    await iterator.return?.()
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function argumentsOf(value: unknown): Record<string, unknown> {
  if (record(value)) return value
  if (typeof value !== 'string') return {}
  try { const parsed: unknown = JSON.parse(value); return record(parsed) ? parsed : {} } catch { return {} }
}

function emptyUsage(): PiUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

interface PiReplayState {
  readonly kind: 'pi-ai'
  readonly version: 1
  readonly api: string
  readonly provider: string
  readonly model: string
  readonly responseModel?: string
  readonly responseId?: string
  readonly stopReason: AssistantMessage['stopReason']
  readonly blocks: readonly Readonly<Record<string, unknown>>[]
}

function replayState(value: unknown): PiReplayState | undefined {
  if (!record(value) || value.kind !== 'pi-ai' || value.version !== 1
    || typeof value.api !== 'string' || typeof value.provider !== 'string' || typeof value.model !== 'string'
    || typeof value.stopReason !== 'string' || !Array.isArray(value.blocks)) return undefined
  return value as unknown as PiReplayState
}

function createReplayState(message: AssistantMessage): PiReplayState {
  return {
    kind: 'pi-ai', version: 1, api: message.api, provider: message.provider, model: message.model,
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    stopReason: message.stopReason,
    blocks: message.content.map(block => block.type === 'text'
      ? { type: 'text', ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) }
      : block.type === 'thinking'
        ? { type: 'reasoning', ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
            ...(block.redacted === undefined ? {} : { redacted: block.redacted }) }
        : { type: 'tool-call', ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }) }),
  }
}

function assistantMessage(message: ModelMessage): AssistantMessage {
  const source = message.source
  const state = replayState(source?.replayState)
  const content: AssistantMessage['content'] = []
  message.content.forEach((block, index) => {
    const replay = state?.blocks[index]
    if (block.type === 'text') content.push({ type: 'text', text: block.text,
      ...(replay?.type === 'text' && typeof replay.textSignature === 'string' ? { textSignature: replay.textSignature } : {}) })
    else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text,
      ...(replay?.type === 'reasoning' && typeof replay.thinkingSignature === 'string' ? { thinkingSignature: replay.thinkingSignature } : {}),
      ...(replay?.type === 'reasoning' && typeof replay.redacted === 'boolean' ? { redacted: replay.redacted } : {}) })
    else if (block.type === 'tool-call') content.push({ type: 'toolCall', id: block.id, name: block.name,
      arguments: argumentsOf(block.arguments),
      ...(replay?.type === 'tool-call' && typeof replay.thoughtSignature === 'string' ? { thoughtSignature: replay.thoughtSignature } : {}) })
  })
  return {
    role: 'assistant', content,
    api: state?.api ?? 'dsh-standard',
    provider: state?.provider ?? (typeof source?.provider === 'string' ? source.provider : OPENAI_CODEX_PROVIDER),
    model: state?.model ?? (typeof source?.model === 'string' ? source.model : 'history'),
    ...(state?.responseModel === undefined ? {} : { responseModel: state.responseModel }),
    ...(state?.responseId === undefined ? {} : { responseId: state.responseId }),
    usage: emptyUsage(),
    stopReason: state?.stopReason ?? (content.some(row => row.type === 'toolCall') ? 'toolUse' : 'stop'),
    timestamp: 0,
  }
}

async function inputContent(content: readonly ModelContentBlock[], context: ModelExecutionContext) {
  const result: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') result.push({ type: 'text', text: block.text })
    if (block.type === 'image') {
      const image = await context.readImage(block.reference)
      result.push({ type: 'image', data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType })
    }
    if (block.type === 'tool-result') result.push(...await inputContent(block.content, context))
  }
  return result
}

async function toPiMessages(messages: readonly ModelMessage[], context: ModelExecutionContext): Promise<PiMessage[]> {
  const output: PiMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant') {
      output.push(assistantMessage(message))
      continue
    }
    const toolResult = message.content.find(block => block.type === 'tool-result')
    if (toolResult !== undefined && typeof toolResult.toolCallId === 'string') {
      output.push({ role: 'toolResult', toolCallId: toolResult.toolCallId,
        toolName: typeof toolResult.name === 'string' ? toolResult.name : 'tool',
        content: await inputContent(toolResult.content, context), isError: toolResult.isError === true, timestamp: 0 })
    } else {
      output.push({ role: 'user', content: await inputContent(message.content, context), timestamp: 0 })
    }
  }
  return output
}

function usage(value: PiUsage): ModelStreamChunk {
  return { type: 'usage', usage: { inputTokens: value.input, outputTokens: value.output,
    ...(value.cacheRead === 0 ? {} : { cacheReadTokens: value.cacheRead }),
    ...(value.cacheWrite === 0 ? {} : { cacheWriteTokens: value.cacheWrite }),
    ...(value.reasoning === undefined ? {} : { reasoningTokens: value.reasoning }) } }
}

export class OpenAICodexModelHandler implements ModelProviderHandler {
  private readonly models
  private readonly responses: OpenAICodexResponseRuntime
  constructor(
    credentials: OpenAICodexCredentialStore,
    private readonly preferences: () => ResponseApiPreferences,
    private readonly streamIdleTimeoutMs = OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
  ) {
    this.models = createModels({ credentials })
    this.responses = new OpenAICodexResponseRuntime(preferences)
    this.models.setProvider(this.responses.wrap(openaiCodexProvider()))
  }

  listModels() {
    const models = this.models.getModels(OPENAI_CODEX_PROVIDER)
    const modelOrder = new Map([
      ['gpt-5.6-luna', 0],
      ['gpt-5.6-terra', 1],
      ['gpt-5.6-sol', 2],
    ])
    const orderedModels = models.filter(model => modelOrder.has(model.id))
      .sort((left, right) => modelOrder.get(left.id)! - modelOrder.get(right.id)!)
    let orderedIndex = 0
    return models.map(model => modelOrder.has(model.id) ? orderedModels[orderedIndex++]! : model).map(model => ({
      id: model.id, name: model.name, inputModalities: model.input,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning,
      selectable: true,
    }))
  }

  async *stream(request: ModelGenerateRequest, execution: ModelExecutionContext): AsyncIterable<ModelStreamChunk> {
    const model = this.models.getModel(OPENAI_CODEX_PROVIDER, request.model)
    if (model === undefined) throw new Error(`OpenAI Codex does not provide model ${JSON.stringify(request.model)}`)
    const context: PiContext = {
      ...(request.system === undefined ? {} : { systemPrompt: request.system }),
      messages: await toPiMessages(request.messages, execution),
      ...(request.tools === undefined ? {} : { tools: request.tools.map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters as PiTool['parameters'],
      })) }),
    }
    const release = request.purpose === 'compaction'
      ? this.responses.enterCompaction(request.sessionId)
      : undefined
    const idle = new AbortController()
    const signal = AbortSignal.any([execution.signal, idle.signal])
    try {
      const events = this.models.streamSimple(model, context, {
        signal,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.reasoningEffort === undefined ? {} : { reasoning: request.reasoningEffort as never }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      })
      for await (const event of withIdleTimeout(events, idle, this.streamIdleTimeoutMs)) {
        if (event.type === 'text_start') yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        else if (event.type === 'text_delta') yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        else if (event.type === 'text_end') yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        else if (event.type === 'thinking_start') yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        else if (event.type === 'thinking_delta') yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        else if (event.type === 'thinking_end') yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        else if (event.type === 'toolcall_start') {
          const block = event.partial.content[event.contentIndex]
          yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
          if (block?.type === 'toolCall') yield { type: 'tool-call-delta', index: event.contentIndex, id: block.id, name: block.name, argumentsDelta: '' }
        } else if (event.type === 'toolcall_delta') {
          const block = event.partial.content[event.contentIndex]
          if (block?.type === 'toolCall') yield { type: 'tool-call-delta', index: event.contentIndex, id: block.id, name: block.name, argumentsDelta: event.delta }
        } else if (event.type === 'toolcall_end') {
          yield { type: 'block-end', index: event.contentIndex, block: { type: 'tool-call', id: event.toolCall.id,
            name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) } }
        } else if (event.type === 'done') {
          yield usage(event.message.usage)
          yield { type: 'finish', reason: { kind: event.reason === 'length' ? 'max-tokens' : event.reason === 'toolUse' ? 'tool-calls' : 'stop' },
            replayState: createReplayState(event.message) }
        } else if (event.type === 'error') {
          yield usage(event.error.usage)
          yield { type: 'finish', reason: { kind: event.reason, failure: { code: 'PROVIDER_ERROR', message: event.error.errorMessage ?? 'OpenAI Codex request failed' } } }
        }
      }
    } finally {
      idle.abort()
      release?.()
    }
  }
}
