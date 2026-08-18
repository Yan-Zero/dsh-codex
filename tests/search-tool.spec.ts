import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutableToolDefinition, ToolExecutionContext, ToolJsonValue } from '@dsh-std/tool'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT } from '../src/search-event.ts'
import { openAICodexSearchTool } from '../src/search-tool.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

async function credentials(): Promise<OpenAICodexCredentialStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-search-tool-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  await store.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve({
    type: 'oauth', access: accessToken('tool-account'), refresh: 'refresh',
    expires: Date.now() + 3_600_000, accountId: 'tool-account',
  }))
  return store
}

function context(appendEvent: (type: string, data: ToolJsonValue) => void): ToolExecutionContext {
  const unsupported = async (): Promise<never> => { throw new Error('not used') }
  return {
    signal: new AbortController().signal,
    model: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
    session: { id: 'session-tool-search', appendEvent },
    validateImage: unsupported,
    saveImage: unsupported,
    recentImages: unsupported,
    readWorkspaceFile: unsupported,
    writeWorkspaceFile: unsupported,
  }
}

describe('OpenAI Codex provider-scoped web_search tool', () => {
  it('keeps the inherited schema, records before dispatch, and preserves DSH web presentation metadata', async () => {
    const parameters = { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
    const output = { type: 'object', required: ['sources', 'truncated'] }
    const original: ExecutableToolDefinition = {
      name: 'web_search', description: 'Inherited DSH web search.', parameters, output,
      async execute() { throw new Error('the inherited body must be shadowed') },
    }
    const replacement = openAICodexSearchTool(await credentials(), { maxResults: 1 }).resolve(original)!
    expect(replacement).toMatchObject({ name: 'web_search', description: 'Inherited DSH web search.' })
    expect(replacement.parameters).toBe(parameters)
    expect(replacement.output).toBe(output)

    const appendEvent = vi.fn()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: 'Provider answer.',
      results: [
        { type: 'text_result', url: 'https://example.com/a', title: 'A', snippet: 'first' },
        { type: 'text_result', url: 'https://example.com/b', title: 'B' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await replacement.execute({ query: 'latest' }, context(appendEvent))

    expect(result.data).toEqual({
      content: 'Provider answer.',
      sources: [{ url: 'https://example.com/a', title: 'A', snippet: 'first' }],
      truncated: true,
    })
    expect(result.content).toEqual([{ type: 'text', text: [
      'Provider answer.',
      'Sources:\n- [A](https://example.com/a) — first',
      '(Showing the first 1 sources. Refine the query for more.)',
      'Cite the relevant URLs above as markdown links in your answer.',
    ].join('\n\n') }])
    expect(result.presentation).toEqual({
      answer: 'Provider answer.',
      sources: [{ url: 'https://example.com/a', title: 'A', snippet: 'first' }],
      truncated: true,
    })
    expect(appendEvent).toHaveBeenCalledWith(
      OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
      expect.objectContaining({ body: expect.objectContaining({ id: 'session-tool-search' }) }),
    )
    expect(appendEvent.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
  })
})
