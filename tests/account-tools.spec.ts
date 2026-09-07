import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import { OpenAICodexSearchProvider } from '../src/search.ts'
import { OpenAICodexImageClient } from '../src/imagegen.ts'

const roots: string[] = []
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
function token(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.fake-signature`
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['search', 'image'] as const)('%s resolves the selected account per call and pins authentication already in progress', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-account-tools-'))
  roots.push(root)
  const first = new OpenAICodexCredentialStore(join(root, 'first.json'))
  const second = new OpenAICodexCredentialStore(join(root, 'second.json'))
  for (const [store, accountId] of [[first, 'first'], [second, 'second']] as const) {
    await store.modify(OPENAI_CODEX_PROVIDER, async () => ({
      type: 'oauth', access: token(accountId), refresh: `fake-refresh-${accountId}`,
      expires: Date.now() + 3_600_000, accountId,
    }))
  }
  const forbiddenNetwork = vi.fn(async () => { throw new Error('Real network forbidden') })
  vi.stubGlobal('fetch', forbiddenNetwork)
  const sent: Array<{ authorization: string | null; accountId: string | null }> = []
  const requestFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    sent.push({ authorization: headers.get('authorization'), accountId: headers.get('chatgpt-account-id') })
    return new Response(JSON.stringify(kind === 'search'
      ? { output: 'Mock result', results: [] }
      : { data: [{ b64_json: pixel.toString('base64') }] }), { status: 200 })
  })
  let selected = first
  const resolveCredentials = vi.fn(async () => selected)
  const search = new OpenAICodexSearchProvider({ credentials: first, resolveCredentials,
    fetch: requestFetch, model: 'gpt-5.6-sol', mode: 'cached', contextSize: 'medium',
    maxOutputTokens: 100, resolveRequestId: () => 'fake-session' })
  const image = new OpenAICodexImageClient(first, requestFetch, resolveCredentials)
  const invoke = () => kind === 'search' ? search.search({ query: 'Test' })
    : image.generate('Test', [], new AbortController().signal)

  await invoke()
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const originalRead = first.read.bind(first)
  vi.spyOn(first, 'read').mockImplementationOnce(async (...args) => {
    entered()
    await gate
    return originalRead(...args)
  })
  const inProgress = invoke()
  await reading
  selected = second
  await invoke()
  unblock()
  await inProgress

  expect(sent).toEqual([
    { authorization: `Bearer ${token('first')}`, accountId: 'first' },
    { authorization: `Bearer ${token('second')}`, accountId: 'second' },
    { authorization: `Bearer ${token('first')}`, accountId: 'first' },
  ])
  expect(resolveCredentials).toHaveBeenCalledTimes(3)
  expect(forbiddenNetwork).not.toHaveBeenCalled()
})
