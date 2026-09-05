import { describe, expect, it } from 'vitest'
import { decodeCredentialDocument } from '../src/credential-document.ts'

const expires = 2_000_000_000_000
const access = `header.${Buffer.from(JSON.stringify({ exp: expires / 1000, 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.signature`
const credential = { type: 'oauth' as const, access, refresh: 'old-refresh', expires, accountId: 'account' }
const next = { ...credential, refresh: 'new-refresh' }
const oauth = { ...credential }
const snake = { access_token: access, refresh_token: credential.refresh, account_id: 'account', id_token: 'keep-id-token' }
const documents = [
  { version: 1, credential: oauth },
  { auth_mode: 'chatgpt', tokens: snake, OPENAI_API_KEY: null },
  { type: 'codex', ...snake, expired: new Date(expires).toISOString(), email: 'fixture@example.invalid', disabled: false },
  { openai: oauth, anthropic: { type: 'api', key: 'untouched' } },
  { 'openai-codex': oauth, anthropic: { type: 'api_key', key: 'untouched' } },
  oauth,
]

describe('credential JSON formats', () => {
  it.each(documents)('round-trips existing shape and preserves unrelated fields: %#', (document) => {
    const original = JSON.stringify(document)
    const decoded = decodeCredentialDocument(original)
    expect(decoded.credential).toMatchObject(credential)
    const saved = decoded.update(next)
    expect(decodeCredentialDocument(JSON.stringify(saved)).credential).toMatchObject(next)
    if ('disabled' in document) expect(saved.disabled).toBe(false)
    if ('anthropic' in document) expect(saved.anthropic).toEqual(document.anthropic)
    if ('tokens' in document) expect(saved.tokens).toMatchObject({ id_token: 'keep-id-token' })
    expect(JSON.stringify(document)).toBe(original)
    const loggedOut = decodeCredentialDocument(JSON.stringify(saved)).update(undefined)
    const empty = decodeCredentialDocument(JSON.stringify(loggedOut))
    expect(empty.credential).toBeUndefined()
    expect(decodeCredentialDocument(JSON.stringify(empty.update(next))).credential).toMatchObject(next)
  })

  it('rejects unknown, ambiguous, malformed and API-key-only documents without secrets', () => {
    for (const value of [{}, { openai: { type: 'api', key: 'secret' } }, { openai: oauth, 'openai-codex': oauth }, { type: 'codex', access_token: 'secret' }]) {
      expect(() => decodeCredentialDocument(JSON.stringify(value))).toThrow()
      try { decodeCredentialDocument(JSON.stringify(value)) } catch (error) { expect(String(error)).not.toContain('secret') }
    }
  })

  it('derives an absent account ID from the access-token claims', () => {
    const { accountId: _, ...withoutAccount } = credential
    expect(decodeCredentialDocument(JSON.stringify({ openai: withoutAccount })).credential).toEqual(credential)
  })

  it.each(documents)('rejects unknown fields in the selected credential: %#', (document) => {
    const root = structuredClone(document) as Record<string, any>
    const selected = root.credential ?? root.tokens ?? root.openai ?? root['openai-codex'] ?? root
    selected.future_token = 'secret-value'
    expect(() => decodeCredentialDocument(JSON.stringify(root))).toThrow('unsupported credential field "future_token"')
    try { decodeCredentialDocument(JSON.stringify(root)) } catch (error) { expect(String(error)).not.toContain('secret-value') }
  })

  it('does not combine a new account with an old ID token', () => {
    for (const document of [documents[1], documents[2]]) {
      const decoded = decodeCredentialDocument(JSON.stringify(document))
      expect(() => decoded.update({ ...next, accountId: 'different-account' })).toThrow('requires a new ID token')
      const saved = decoded.update({ ...next, accountId: 'different-account', idToken: 'new-id-token', email: 'new@example.invalid' })
      const value = 'tokens' in saved ? saved.tokens : saved
      expect(value).toMatchObject({ account_id: 'different-account', id_token: 'new-id-token' })
    }
  })
})
