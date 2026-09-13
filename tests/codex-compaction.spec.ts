import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

function responseEvents(id = 'resp_compaction', text = 'summary'): string {
  const events = [
    { type: 'response.created', response: { id } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_compaction', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_compaction',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: [],
        usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
      },
    },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

function compactionEvents(encryptedContent = 'encrypted-checkpoint'): string {
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'compaction', id: 'cmp_item_1', encrypted_content: encryptedContent },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_native_compaction',
        status: 'completed',
        output: [],
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      },
    },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

function requestJson(init: RequestInit): Record<string, unknown> {
  const headers = new Headers(init.headers)
  const raw = init.body
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>
  if (!(raw instanceof Uint8Array)) throw new Error('expected a string or byte request body')
  const bytes = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw) : raw
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

describe('OpenAI Codex compaction request', () => {
  it('keeps stateless reasoning and paired tool history without sending a standard output cap', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-compaction-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    let request: { url: string; init: RequestInit } | undefined
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (init === undefined) throw new Error('expected request init')
      request = { url: String(input), init }
      return new Response(responseEvents(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const callId = ToolCallId('call_1|fc_1')
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'checked the workspace' }],
      encrypted_content: 'encrypted-reasoning',
    }
    const messages = [
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'checked the workspace' },
          { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"README.md"}' },
        ],
        source: {
          provider: 'openai-codex',
          model: 'gpt-5.6-sol',
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-codex-responses',
            provider: 'openai-codex',
            model: 'gpt-5.6-sol',
            stopReason: 'toolUse',
            blocks: [
              { type: 'reasoning', thinkingSignature: JSON.stringify(reasoningItem) },
              { type: 'tool-call' },
            ],
          },
        },
      }),
      createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'repository readme' }],
        isError: false,
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'Summarize the conversation for compaction.' }],
        source: { kind: 'plugin', plugin: 'compaction-basic' },
      }),
    ]

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex)
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve decisions and unresolved work.',
      messages,
      maxTokens: 777,
      sessionId: 'session-compaction' as never,
    })) assembler.push(chunk)

    expect(assembler.message({ kind: 'model', provider: 'openai-codex', model: 'gpt-5.6-sol' }).content)
      .toEqual([{ type: 'text', text: 'summary' }])
    if (request === undefined) throw new Error('Codex request was not captured')
    const captured = request as { url: string; init: RequestInit }
    const headers = new Headers(captured.init.headers)
    const body = requestJson(captured.init)
    expect(captured.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken('account-1')}`)
    expect(headers.get('chatgpt-account-id')).toBe('account-1')
    expect(headers.get('session-id')).toBe('session-compaction')
    expect(body).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      instructions: 'Preserve decisions and unresolved work.',
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-compaction',
    })
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body.input).toEqual([
      reasoningItem,
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'repository readme' },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Summarize the conversation for compaction.' }],
      },
    ])
  })

  it('uses native compact output as a durable checkpoint and restores its response items', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-native-compact-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    const restoredOutput = [
      { role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { type: 'compaction', id: 'cmp_item_1', encrypted_content: 'encrypted-checkpoint' },
    ]
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (init === undefined) throw new Error('expected request init')
      const request = { url: String(input), init }
      requests.push(request)
      const body = requestJson(init)
      if (Array.isArray(body.input) && body.input.some(item => (
        typeof item === 'object' && item !== null && (item as { type?: string }).type === 'compaction_trigger'
      ))) {
        return new Response(compactionEvents(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(responseEvents('resp_after_compact', 'continued'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex, { useNativeCompaction: true })
    const compacted = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve durable context.',
      messages: [
        userMessage('keep this request'),
        createUserMessage({
          content: [{ type: 'text', text: 'private Harness summary instruction' }],
          source: { kind: 'plugin', plugin: 'compaction-basic' },
        }),
      ],
      sessionId: 'session-native-compact' as never,
    })) compacted.push(chunk)
    const marker = compacted.message({
      kind: 'model',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    }).content

    const continued = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      system: 'Preserve durable context.',
      messages: [
        createUserMessage({
          content: marker,
          source: { kind: 'plugin', plugin: 'compaction-basic' },
        }),
        userMessage('continue'),
      ],
      sessionId: 'session-native-compact' as never,
    })) continued.push(chunk)

    expect(requests.map(request => request.url)).toEqual([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses',
    ])
    const compactBody = requestJson(requests[0]!.init)
    const compactHeaders = new Headers(requests[0]!.init.headers)
    expect(compactHeaders.get('thread-id')).toBe('session-native-compact')
    expect(compactHeaders.get('x-codex-routing-hint')).toBe('model=gpt-5.6-sol')
    expect(compactBody).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      stream: true,
      instructions: 'Preserve durable context.',
      include: ['reasoning.encrypted_content'],
    })
    expect(compactBody.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { type: 'compaction_trigger' },
    ])
    const continuedBody = requestJson(requests[1]!.init)
    expect(continuedBody.input).toEqual([
      ...restoredOutput,
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ])
  })

  it('falls back to Harness compaction when the native endpoint is unavailable', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-native-fallback-'))
    vi.stubEnv('DSH_HOME', root)
    const store = new OpenAICodex.OpenAICodexCredentialStore()
    await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
      type: 'oauth',
      access: accessToken('account-1'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }))

    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (init === undefined) throw new Error('expected request init')
      const request = { url: String(input), init }
      requests.push(request)
      const body = requestJson(init)
      if (Array.isArray(body.input) && body.input.some(item => (
        typeof item === 'object' && item !== null && (item as { type?: string }).type === 'compaction_trigger'
      ))) {
        return Response.json({ detail: 'Unsupported input item' }, { status: 400 })
      }
      return new Response(responseEvents('resp_fallback', 'fallback summary'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime)
    await ctx.plugin(OpenAICodex, { useNativeCompaction: true })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      purpose: 'compaction',
      system: 'Preserve durable context.',
      messages: [
        userMessage('keep this request'),
        createUserMessage({
          content: [{ type: 'text', text: 'Summarize the conversation.' }],
          source: { kind: 'plugin', plugin: 'compaction-basic' },
        }),
      ],
      sessionId: 'session-native-fallback' as never,
    })) assembler.push(chunk)

    expect(assembler.message({
      kind: 'model',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    }).content).toEqual([{ type: 'text', text: 'fallback summary' }])
    expect(requests.map(request => request.url)).toEqual([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/responses',
    ])
    expect(requestJson(requests[1]!.init).input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Summarize the conversation.' }] },
    ])
  })
})
