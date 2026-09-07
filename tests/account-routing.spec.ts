import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { OpenAICodexAccounts } from '../src/accounts.ts'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import { withAccountRouting, withQuotaDetectionFetch } from '../src/account-routing.ts'

const options = { provider: 'openai-codex', model: 'gpt-6-astra', messages: [] } as GenerateOptions
const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const failure: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'You have hit your ChatGPT usage limit.' } } }
const quota = () => new LlmError('usage_limit_reached', 'RATE_LIMIT')
type Stream = (options: GenerateOptions) => AsyncIterable<StreamChunk>
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
function setup(streams: Stream[], autoSwitch = true) {
  let selected = 0
  const stores = streams.map(() => ({} as OpenAICodexCredentialStore))
  const calls = streams.map(stream => vi.fn(stream))
  const instances = calls.map(stream => ({
    stream,
    prepareCall: vi.fn(async () => ({ model: { provider: options.provider, id: options.model, name: 'test' }, stream })),
  } as unknown as PiAiAdapter))
  const persist = vi.fn(async (failed: string, next: string) => { if (String(selected) === failed) selected = Number(next) })
  const accounts = {
    candidates: async () => [selected, ...streams.map((_, i) => i).filter(i => i !== selected)]
      .slice(0, autoSwitch ? streams.length : 1).map(i => ({ id: String(i), store: stores[i]! })),
    selectAfterFailover: persist,
  } as unknown as OpenAICodexAccounts
  return {
    adapter: withAccountRouting(instances[0]!, accounts, store => instances[stores.indexOf(store)]!),
    calls, instances, persist, select: (id: number) => { selected = id }, setAutoSwitch: (enabled: boolean) => { autoSwitch = enabled }, selected: () => selected,
  }
}
async function* success() { yield { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk; yield finish }
async function* exhausted(): AsyncIterable<StreamChunk> { throw quota() }

describe('account routing', () => {
  it('switches only on quota and persists after successful completion', async () => {
    const state = setup([exhausted, success])
    expect(await collect(state.adapter.stream(options))).toHaveLength(2)
    expect(state.persist).toHaveBeenCalledWith('0', '1')
    expect(state.selected()).toBe(1)
  })
  it('does not switch with automatic switching disabled', async () => {
    const state = setup([exhausted, success], false)
    await expect(collect(state.adapter.stream(options))).rejects.toThrow('usage_limit_reached')
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it.each(['rate limit', 'network disconnected', 'unauthorized'])('does not switch on %s', async message => {
    const state = setup([async function* () { throw new Error(message) }, success])
    await expect(collect(state.adapter.stream(options))).rejects.toThrow(message)
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it.each<StreamChunk>([
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-start', index: 0, blockType: 'tool-call' },
  ])('does not replay after $type output', async chunk => {
    const state = setup([async function* () { yield chunk; throw quota() }, success])
    await expect(collect(state.adapter.stream(options))).rejects.toThrow()
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it('does not switch aborted requests', async () => {
    const controller = new AbortController()
    const state = setup([async function* () { controller.abort(); throw quota() }, success])
    await expect(collect(state.adapter.stream({ ...options, signal: controller.signal }))).rejects.toThrow()
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it('tries every account at most once and preserves the last failure', async () => {
    const last = new LlmError('insufficient_quota final', 'RATE_LIMIT')
    const state = setup([exhausted, async function* () { throw last }])
    await expect(collect(state.adapter.stream(options))).rejects.toBe(last)
    state.calls.forEach(call => expect(call).toHaveBeenCalledTimes(1))
    expect(state.persist).not.toHaveBeenCalled()
  })
  it('freezes prepared requests across concurrent manual selections', async () => {
    const state = setup([success, success])
    const first = await state.adapter.prepareCall(options.provider, options.model)
    state.select(1)
    const second = await state.adapter.prepareCall(options.provider, options.model)
    await Promise.all([collect(first.stream(options)), collect(second.stream(options))])
    state.calls.forEach(call => expect(call).toHaveBeenCalledTimes(1))
  })
  it.each(['disable', 'select'])('honors %s changes after preparing a request', async action => {
    const state = setup([exhausted, success])
    const prepared = await state.adapter.prepareCall(options.provider, options.model)
    if (action === 'disable') state.setAutoSwitch(false)
    else state.select(1)
    await expect(collect(prepared.stream(options))).rejects.toThrow('usage_limit_reached')
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it.each(['disable', 'select'])('honors %s changes during a request', async action => {
    const state = setup([async function* () {
      if (action === 'disable') state.setAutoSwitch(false)
      else state.select(1)
      throw quota()
    }, success])
    await expect(collect(state.adapter.stream(options))).rejects.toThrow('usage_limit_reached')
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it('reuses an account adapter when candidates returns fresh credential-store wrappers', async () => {
    let selected = 'first'
    const instances: PiAiAdapter[] = []
    const create = vi.fn(() => {
      const instance = { stream: vi.fn(success) } as unknown as PiAiAdapter
      instances.push(instance)
      return instance
    })
    const accounts = {
      candidates: async () => [{ id: selected, store: {} as OpenAICodexCredentialStore }],
      selectAfterFailover: vi.fn(),
    } as unknown as OpenAICodexAccounts
    const adapter = withAccountRouting({} as PiAiAdapter, accounts, create)
    await collect(adapter.stream(options))
    selected = 'second'
    await collect(adapter.stream(options))
    selected = 'first'
    await collect(adapter.stream(options))
    expect(create).toHaveBeenCalledTimes(2)
    expect(instances[0]!.stream).toHaveBeenCalledTimes(2)
    expect(instances[1]!.stream).toHaveBeenCalledTimes(1)
  })
  it('routes prepared-call failover through the backup prepared adapter', async () => {
    const state = setup([exhausted, success])
    const prepared = await state.adapter.prepareCall(options.provider, options.model)
    await collect(prepared.stream(options))
    expect(state.instances[1]!.prepareCall).toHaveBeenCalledTimes(1)
    expect(state.persist).toHaveBeenCalledWith('0', '1')
  })
  it('does not replace a manual selection made while failover is running', async () => {
    const state = setup([exhausted, async function* () { state.select(2); yield finish }, success])
    await collect(state.adapter.stream(options))
    expect(state.selected()).toBe(2)
  })
  it.each([
    ['usage_limit_reached', 429, true], ['insufficient_quota', 429, true],
    ['rate_limit_exceeded', 429, false], ['usage_limit_reached', 401, false],
    ['usage_limit_reached', 403, false],
  ])('retains wire code %s / %i with switch=%s without changing the response', async (code, status, switches) => {
    const wire = withQuotaDetectionFetch(async () => new Response(JSON.stringify({ error: { code } }), { status }))
    const state = setup([async function* () {
      const response = await wire('https://example.invalid')
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: { code } })
      yield usage
      yield failure
    }, success])
    const chunks = await collect(state.adapter.stream(options))
    expect(state.calls[1]).toHaveBeenCalledTimes(switches ? 1 : 0)
    expect(chunks.at(-1)).toEqual(switches ? finish : failure)
    if (switches) expect(chunks).not.toContainEqual(usage)
  })
  it('forgets a quota response when a later internal retry has a different outcome', async () => {
    let call = 0
    const wire = withQuotaDetectionFetch(async () => new Response(JSON.stringify({ error: {
      code: ++call === 1 ? 'usage_limit_reached' : 'rate_limit_exceeded',
    } }), { status: 429 }))
    const state = setup([async function* () {
      await wire('https://example.invalid')
      await wire('https://example.invalid')
      yield usage
      yield failure
    }, success])
    expect((await collect(state.adapter.stream(options))).at(-1)).toEqual(failure)
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it('strips foreign and untagged replay while retaining visible history and source facts', async () => {
    const state = setup([success])
    const messages = [undefined, 'other', '0'].map(owner => ({
      id: 'message', content: [{ type: 'text', text: 'Visible answer' }],
      source: { kind: 'model', provider: options.provider, model: options.model,
        replayState: { response: { kind: 'pi-ai' }, blocks: [], ...(owner ? { dshCodexAccountId: owner } : {}) } },
    })) as unknown as GenerateOptions['messages']
    await collect(state.adapter.stream({ ...options, messages }))
    const actual = state.calls[0]!.mock.calls[0]![0].messages
    expect(actual[0]!.source).toEqual({ kind: 'model', provider: options.provider, model: options.model })
    expect(actual[1]!.source).toEqual(actual[0]!.source)
    expect(actual[2]).toEqual(messages[2])
    expect(actual[0]!.content).toEqual(messages[0]!.content)
    expect(messages[0]!.source).toHaveProperty('replayState')
  })
  it('preserves legacy untagged replay on default and strips it on new accounts', async () => {
    let selected = 'default'
    const stream = vi.fn((_request: GenerateOptions) => success())
    const accounts = { candidates: async () => [{ id: selected, store: {} as OpenAICodexCredentialStore }] } as unknown as OpenAICodexAccounts
    const adapter = withAccountRouting({} as PiAiAdapter, accounts, () => ({ stream } as unknown as PiAiAdapter))
    const replayState = { response: { kind: 'pi-ai', version: 2 }, blocks: [{ type: 'reasoning', thinkingSignature: 'legacy' }] }
    const messages = [{ id: 'legacy', source: { kind: 'model', provider: options.provider, model: options.model, replayState },
      content: [{ type: 'reasoning', text: 'Visible reasoning' }] }] as unknown as GenerateOptions['messages']
    await collect(adapter.stream({ ...options, messages }))
    expect(stream.mock.calls[0]![0].messages[0]!.source).toHaveProperty('replayState', replayState)
    selected = 'new-account'
    await collect(adapter.stream({ ...options, messages }))
    expect(stream.mock.calls[1]![0].messages[0]!.source).not.toHaveProperty('replayState')
    expect(messages[0]!.source).toHaveProperty('replayState', replayState)
  })
  it('stamps returned replay without replacing the pi-ai envelope', async () => {
    const replayState = { response: { kind: 'pi-ai', version: 2 }, blocks: [{ type: 'text' }] }
    const state = setup([async function* () { yield { ...finish, replayState } as StreamChunk }])
    const chunks = await collect(state.adapter.stream(options))
    expect(chunks[0]).toEqual({ ...finish, replayState: { ...replayState, dshCodexAccountId: '0' } })
    expect(replayState).not.toHaveProperty('dshCodexAccountId')
  })
  it('tags native checkpoint text so its owner survives compaction provenance removal', async () => {
    const marker = '<dsh-openai-codex-compaction-4f5cf1b7-v1>[{"type":"compaction"}]</dsh-openai-codex-compaction-4f5cf1b7-v1>'
    const state = setup([async function* () {
      yield { type: 'text-delta', index: 0, text: marker }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: marker } }
      yield finish
    }, success])
    const chunks = await collect(state.adapter.stream(options))
    const checkpoint = (chunks[0] as Extract<StreamChunk, { type: 'text-delta' }>).text
    expect(checkpoint).toContain('<dsh-openai-codex-account-v1>0</dsh-openai-codex-account-v1>')
    expect(chunks[1]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: checkpoint } })
    const messages = [{ id: 'summary', source: { kind: 'user' }, content: [{ type: 'text', text: checkpoint }] }] as unknown as GenerateOptions['messages']
    await collect(state.adapter.stream({ ...options, messages }))
    state.select(1)
    await expect(collect(state.adapter.stream({ ...options, messages }))).rejects.toThrow('original account')
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it('permits legacy native checkpoints only on the default account', async () => {
    let selected = 'default'
    const stream = vi.fn((_request: GenerateOptions) => success())
    const accounts = { candidates: async () => [{ id: selected, store: {} as OpenAICodexCredentialStore }] } as unknown as OpenAICodexAccounts
    const adapter = withAccountRouting({} as PiAiAdapter, accounts, () => ({ stream } as unknown as PiAiAdapter))
    const messages = [{ id: 'summary', source: { kind: 'user' }, content: [{ type: 'text', text: '<dsh-openai-codex-compaction-4f5cf1b7-v1>[]</dsh-openai-codex-compaction-4f5cf1b7-v1>' }] }] as unknown as GenerateOptions['messages']
    await collect(adapter.stream({ ...options, messages }))
    selected = 'new-account'
    await expect(collect(adapter.stream({ ...options, messages }))).rejects.toThrow('new conversation')
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it('does not send native checkpoints to a fallback account after quota exhaustion', async () => {
    const state = setup([exhausted, success])
    const messages = [{ id: 'summary', source: { kind: 'model', provider: options.provider, model: options.model,
      replayState: { dshCodexAccountId: '0' } }, content: [{ type: 'text', text: '<dsh-openai-codex-compaction-4f5cf1b7-v1>[]</dsh-openai-codex-compaction-4f5cf1b7-v1>' }] }] as unknown as GenerateOptions['messages']
    await expect(collect(state.adapter.stream({ ...options, messages }))).rejects.toThrow('native Codex compaction checkpoint')
    expect(state.calls[0]).toHaveBeenCalledTimes(1)
    expect(state.calls[1]).not.toHaveBeenCalled()
  })
  it('isolates wire quota detection between concurrent requests', async () => {
    const wire = withQuotaDetectionFetch(async input => new Response(JSON.stringify({ error: { code: String(input).endsWith('/quota') ? 'usage_limit_reached' : 'rate_limit_exceeded' } }), { status: 429 }))
    const state = setup([async function* (request) {
      await wire(`https://example.invalid/${request.model}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      yield usage
      yield failure
    }, success])
    const [quotaResult, rateResult] = await Promise.all([
      collect(state.adapter.stream({ ...options, model: 'quota' })),
      collect(state.adapter.stream({ ...options, model: 'rate' })),
    ])
    expect(quotaResult.at(-1)).toEqual(finish)
    expect(rateResult.at(-1)).toEqual(failure)
    expect(state.calls[1]).toHaveBeenCalledTimes(1)
  })
})
