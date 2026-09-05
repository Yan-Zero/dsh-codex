import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('@earendil-works/pi-ai/bun-oauth')
  vi.doUnmock('@earendil-works/pi-ai/providers/openai-codex')
  vi.resetModules()
})

describe('stable OpenAI Codex provider construction', () => {
  it('registers static OAuth flows once before constructing providers', async () => {
    const order: string[] = []
    vi.doMock('@earendil-works/pi-ai/bun-oauth', () => ({
      registerBunOAuthFlows: () => { order.push('register') },
    }))
    vi.doMock('@earendil-works/pi-ai/providers/openai-codex', () => ({
      openaiCodexProvider: () => {
        order.push('provider')
        return { id: 'openai-codex' }
      },
    }))

    const { createOpenAICodexProvider } = await import('../src/provider.ts')
    createOpenAICodexProvider()
    createOpenAICodexProvider()

    expect(order).toEqual(['register', 'provider', 'provider'])
  })

  it('derives request auth from a stored credential through the static loader', async () => {
    const { createModels } = await import('@earendil-works/pi-ai')
    const { createOpenAICodexProvider } = await import('../src/provider.ts')
    const credential: Credential = {
      type: 'oauth',
      access: 'stored-access-token',
      refresh: 'stored-refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    }
    const store: CredentialStore = {
      read: async providerId => providerId === 'openai-codex' ? credential : undefined,
      list: async (): Promise<readonly CredentialInfo[]> => [{ providerId: 'openai-codex', type: 'oauth' }],
      modify: async (_providerId, update) => await update(credential),
      delete: async () => {},
    }
    const models = createModels({ credentials: store })
    models.setProvider(createOpenAICodexProvider())

    await expect(models.getAuth('openai-codex')).resolves.toEqual({
      auth: { apiKey: 'stored-access-token' },
      source: 'OAuth',
    })
  })

  it('refreshes an expired credential through the same static loader', async () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    const refreshedAccess = `${encode({ alg: 'none' })}.${encode({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-2' },
    })}.signature`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: refreshedAccess,
      refresh_token: 'rotated-refresh-token',
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const { createModels } = await import('@earendil-works/pi-ai')
    const { createOpenAICodexProvider } = await import('../src/provider.ts')
    let credential: Credential | undefined = {
      type: 'oauth',
      access: 'expired-access-token',
      refresh: 'expired-refresh-token',
      expires: Date.now() - 1,
      accountId: 'account-1',
    }
    const store: CredentialStore = {
      read: async providerId => providerId === 'openai-codex' ? credential : undefined,
      list: async (): Promise<readonly CredentialInfo[]> => credential === undefined
        ? []
        : [{ providerId: 'openai-codex', type: credential.type }],
      modify: async (_providerId, update) => {
        const next = await update(credential)
        if (next !== undefined) credential = next
        return credential
      },
      delete: async () => { credential = undefined },
    }
    const models = createModels({ credentials: store })
    models.setProvider(createOpenAICodexProvider())

    await expect(models.getAuth('openai-codex')).resolves.toEqual({
      auth: { apiKey: refreshedAccess },
      source: 'OAuth',
    })
    expect(credential).toMatchObject({
      type: 'oauth',
      refresh: 'rotated-refresh-token',
      accountId: 'account-2',
    })
  })
})
