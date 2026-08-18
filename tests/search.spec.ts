import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  OpenAICodexSearchMode,
  OpenAICodexSearchProviderOptions,
} from '../src/search.ts'
import {
  mapOpenAICodexSearchResponse,
  OpenAICodexSearchProvider,
} from '../src/search.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

async function credentialStore(): Promise<OpenAICodexCredentialStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-search-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  await store.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve({
    type: 'oauth',
    access: accessToken('account-from-jwt'),
    refresh: 'refresh-secret',
    expires: Date.now() + 3_600_000,
    accountId: 'account-from-store',
  }))
  return store
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function provider(
  overrides: Partial<OpenAICodexSearchProviderOptions> = {},
): Promise<OpenAICodexSearchProvider> {
  return new OpenAICodexSearchProvider({
    credentials: await credentialStore(),
    model: 'gpt-search-test',
    mode: 'cached',
    contextSize: 'medium',
    maxOutputTokens: 1234,
    resolveRequestId: () => 'session-search',
    recordRequest: () => {},
    ...overrides,
  })
}

const searchPayload = {
  output: 'A synthesized answer.',
  results: [
    { type: 'text_result', ref_id: 'turn0search0', url: 'https://example.com/a', title: 'A', snippet: 'First' },
    { type: 'text_result', ref_id: 'turn0search1', url: 'https://example.com/a', title: 'duplicate' },
    { type: 'text_result', ref_id: 'turn0search2', url: 'javascript:alert(1)', title: 'unsafe' },
    { type: 'unknown_future_result', url: 'https://example.com/future' },
    { type: 'text_result', ref_id: 'turn0search3', url: 'https://example.com/b' },
  ],
}

describe('OpenAI Codex search response mapping', () => {
  it('retains generated output and deduplicated citeable structured sources', () => {
    expect(mapOpenAICodexSearchResponse(searchPayload)).toEqual({
      content: 'A synthesized answer.',
      sources: [
        { url: 'https://example.com/a', title: 'A', snippet: 'First' },
        { url: 'https://example.com/b' },
      ],
      truncated: false,
    })
  })

  it('accepts an empty answer and absent results', () => {
    expect(mapOpenAICodexSearchResponse({ output: '' })).toEqual({
      sources: [],
      truncated: false,
    })
  })

  it('rejects malformed response envelope fields', () => {
    expect(() => mapOpenAICodexSearchResponse({ results: [] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => mapOpenAICodexSearchResponse({ output: 'answer', results: {} }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('OpenAI Codex standalone search request', () => {
  it.each([
    ['cached', false],
    ['indexed', 'indexed'],
    ['live', true],
  ] as const)('maps %s mode, authenticates, and records before dispatch', async (mode, externalWebAccess) => {
    const fetchMock = vi.fn(async () => jsonResponse(searchPayload))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const search = await provider({ mode, recordRequest })

    await expect(search.search({ query: 'current information' })).resolves.toMatchObject({
      content: 'A synthesized answer.',
      truncated: false,
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init.headers)
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(url).toBe('https://chatgpt.com/backend-api/codex/alpha/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken('account-from-jwt')}`)
    expect(headers.get('chatgpt-account-id')).toBe('account-from-jwt')
    expect(headers.get('originator')).toBe('deepseek-harness')
    expect(body).toEqual({
      id: 'session-search',
      model: 'gpt-search-test',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'current information' }] }],
      commands: { search_query: [{ q: 'current information' }] },
      settings: {
        search_context_size: 'medium',
        allowed_callers: ['direct'],
        external_web_access: externalWebAccess,
      },
      max_output_tokens: 1234,
    })
    expect(recordRequest).toHaveBeenCalledWith({ endpoint: url, body })
    expect(recordRequest.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
  })

  it('forwards cancellation and rejects a pre-aborted request before reading credentials', async () => {
    const store = await credentialStore()
    const read = vi.spyOn(store, 'read')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const search = new OpenAICodexSearchProvider({
      credentials: store,
      model: 'gpt-search-test',
      mode: 'cached',
      contextSize: 'low',
      maxOutputTokens: 1,
      resolveRequestId: () => 'request',
      recordRequest: () => {},
    })
    const controller = new AbortController()
    controller.abort(new Error('deadline'))

    await expect(search.search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(read).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

})

describe('OpenAI Codex standalone search failures', () => {
  it('requires a signed-in credential', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-search-missing-'))
    const search = new OpenAICodexSearchProvider({
      credentials: new OpenAICodexCredentialStore(join(root, 'missing.json')),
      model: 'gpt-search-test',
      mode: 'cached',
      contextSize: 'medium',
      maxOutputTokens: 100,
      resolveRequestId: () => 'request',
      recordRequest: () => {},
    })
    await expect(search.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
  })

  it('maps authorization, malformed JSON, malformed success, and transport failures', async () => {
    const search = await provider()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'expired' } }, 401)))
    await expect(search.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })))
    await expect(search.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ output: 42 })))
    await expect(search.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(search.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})
