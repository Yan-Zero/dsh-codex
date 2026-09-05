import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { openaiCodexProvider, refreshOpenAICodexCredential } from '../src/oauth-provider.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

const { login } = vi.hoisted(() => ({ login: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/openai-codex')>()
  return { openaiCodexProvider: () => {
    const provider = original.openaiCodexProvider()
    return { ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!, login } } }
  } }
})

const jwt = (email?: string) => `header.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'account' },
  ...(email ? { email } : {}),
})).toString('base64url')}.signature`
const old = { type: 'oauth' as const, access: jwt(), refresh: 'old-refresh', expires: 1, accountId: 'account' }
const response = () => ({ access_token: jwt(), refresh_token: 'new-refresh', id_token: jwt('new@example.invalid'), expires_in: 3600 })
let directory: string | undefined
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.clearAllMocks()
})

describe('complete Codex OAuth refresh', () => {
  it('uses the refresh grant and retains the returned identity token and email', async () => {
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data))
    const signal = new AbortController().signal
    const updated = await refreshOpenAICodexCredential(old, signal, fetch)
    expect(updated).toMatchObject({ access: data.access_token, refresh: data.refresh_token, idToken: data.id_token, email: 'new@example.invalid', accountId: 'account' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://auth.openai.com/oauth/token')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal })
    expect(new URLSearchParams(init!.body as URLSearchParams).get('refresh_token')).toBe('old-refresh')
  })

  it('lets pi-ai schedule refresh and atomically persists all fields in CPA format', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-complete-oauth-'))
    const filename = join(directory, 'auth.json')
    await writeFile(filename, JSON.stringify({ type: 'codex', access_token: old.access, refresh_token: old.refresh, account_id: 'account', id_token: 'old-id', expired: new Date(1).toISOString(), email: 'old@example.invalid', disabled: false }), { mode: 0o600 })
    const store = new OpenAICodexCredentialStore(filename)
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data))
    const models = createModels({ credentials: store })
    models.setProvider(openaiCodexProvider(fetch))
    expect((await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey).toBe(data.access_token)
    expect(JSON.parse(await readFile(filename, 'utf8'))).toMatchObject({ access_token: data.access_token, refresh_token: data.refresh_token, id_token: data.id_token, email: 'new@example.invalid', disabled: false })
    await models.getAuth(OPENAI_CODEX_PROVIDER)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('completes pi-ai login with one full refresh before returning credentials', async () => {
    login.mockResolvedValue(old)
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data))
    const interaction = { signal: new AbortController().signal } as AuthInteraction & { signal: AbortSignal }
    const credential = await openaiCodexProvider(fetch).auth.oauth!.login(interaction)
    expect(login).toHaveBeenCalledWith(interaction)
    expect(credential).toMatchObject({ refresh: data.refresh_token, idToken: data.id_token })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects missing ID tokens and hides failed response bodies', async () => {
    const { id_token: _, ...incomplete } = response()
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(incomplete))
      .mockResolvedValueOnce(new Response('secret-response', { status: 401 }))
    const signal = new AbortController().signal
    await expect(refreshOpenAICodexCredential(old, signal, fetch)).rejects.toThrow('missing id_token')
    await expect(refreshOpenAICodexCredential(old, signal, fetch)).rejects.toThrow('failed (401)')
  })

  it('does not send an already cancelled request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(refreshOpenAICodexCredential(old, AbortSignal.abort(), fetch)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
