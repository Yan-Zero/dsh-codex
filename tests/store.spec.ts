import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  OpenAICodexCredentialStore,
  OPENAI_CODEX_PROVIDER,
} from '../src/store.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function credential(access = 'access-secret'): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh: 'refresh-secret',
    expires: Date.now() + 60_000,
    accountId: 'account-1',
  }
}

async function store(): Promise<OpenAICodexCredentialStore> {
  root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-openai-codex-'))
  return new OpenAICodexCredentialStore(join(root, 'auth.json'))
}

describe('OpenAICodexCredentialStore', () => {
  it('persists, lists, detaches, and removes one OAuth credential owner-only', async () => {
    const auth = await store()
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toBeUndefined()

    await auth.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential()))
    expect(await auth.list()).toEqual([{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }])
    const first = await auth.read(OPENAI_CODEX_PROVIDER)
    expect(first).toMatchObject({ type: 'oauth', accountId: 'account-1' })
    if (first?.type !== 'oauth') throw new Error('expected OAuth credential')
    first.access = 'mutated-only-in-caller'
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'access-secret' })
    if (process.platform !== 'win32') expect((await stat(auth.filename)).mode & 0o777).toBe(0o600)

    await auth.delete(OPENAI_CODEX_PROVIDER)
    expect(await auth.list()).toEqual([])
  })

  it('serializes cross-instance refresh writes so each sees the prior value', async () => {
    const first = await store()
    const second = new OpenAICodexCredentialStore(first.filename)
    await first.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential('zero')))
    const seen: string[] = []
    await Promise.all([
      first.modify(OPENAI_CODEX_PROVIDER, async (current) => {
        seen.push(current?.type === 'oauth' ? current.access : 'missing')
        await new Promise(resolve => setTimeout(resolve, 20))
        return credential('one')
      }),
      second.modify(OPENAI_CODEX_PROVIDER, async (current) => {
        seen.push(current?.type === 'oauth' ? current.access : 'missing')
        return credential('two')
      }),
    ])
    expect(seen[0]).toBe('zero')
    expect(seen[1]).toMatch(/one|two/)
    expect(seen[1]).not.toBe('zero')
  })

  it('rejects malformed and over-broad documents without echoing their contents', async () => {
    const auth = await store()
    await writeFile(auth.filename, '{"version":1,"credential":{"type":"oauth","access":"leaked-secret"}}', { mode: 0o600 })
    const failure = await auth.read(OPENAI_CODEX_PROVIDER).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('refresh')
    expect(String(failure)).not.toContain('leaked-secret')

    if (process.platform !== 'win32') {
      await writeFile(auth.filename, JSON.stringify({ version: 1, credential: credential() }), { mode: 0o644 })
      await chmod(auth.filename, 0o644)
      await expect(auth.read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/readable beyond its owner/)
    }
  })

  it('writes the versioned document and refuses provider ids it does not own', async () => {
    const auth = await store()
    await auth.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential()))
    expect(JSON.parse(await readFile(auth.filename, 'utf8'))).toMatchObject({
      version: 1,
      credential: { type: 'oauth', accountId: 'account-1' },
    })
    await expect(auth.modify('other', () => Promise.resolve(credential())))
      .rejects.toThrow(/does not own provider/)
    expect(await auth.read('other')).toBeUndefined()
  })

  it('updates a Pi document atomically without lock files or losing concurrent provider changes', async () => {
    const auth = await store()
    const original = credential()
    await writeFile(auth.filename, JSON.stringify({ 'openai-codex': original, other: { key: 'old' } }), { mode: 0o600 })
    await auth.modify(OPENAI_CODEX_PROVIDER, async () => {
      await writeFile(auth.filename, JSON.stringify({ 'openai-codex': original, other: { key: 'new' } }), { mode: 0o600 })
      return credential('new-access')
    })
    expect(JSON.parse(await readFile(auth.filename, 'utf8'))).toMatchObject({ 'openai-codex': { access: 'new-access' }, other: { key: 'new' } })
    await expect(stat(`${auth.filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    await auth.delete(OPENAI_CODEX_PROVIDER)
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toBeUndefined()
    expect(JSON.parse(await readFile(auth.filename, 'utf8')).other).toEqual({ key: 'new' })
  })

  it('propagates callback failures and rejects a detected competing credential update', async () => {
    const auth = await store()
    await auth.modify(OPENAI_CODEX_PROVIDER, async () => credential())
    const failure = new Error('fixture failure')
    await expect(auth.modify(OPENAI_CODEX_PROVIDER, async () => { throw failure })).rejects.toBe(failure)
    await expect(auth.modify(OPENAI_CODEX_PROVIDER, async () => {
      await writeFile(auth.filename, JSON.stringify({ version: 1, credential: credential('external') }), { mode: 0o600 })
      return credential('local')
    })).rejects.toThrow('changed during update')
    expect(await auth.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'external' })
  })

  it('rejects unknown existing files before invoking refresh or writing', async () => {
    const auth = await store()
    const original = JSON.stringify({ unrelated: 'keep' })
    await writeFile(auth.filename, original, { mode: 0o600 })
    let called = false
    await expect(auth.modify(OPENAI_CODEX_PROVIDER, async () => {
      called = true
      return credential()
    })).rejects.toThrow('unsupported or ambiguous')
    expect(called).toBe(false)
    expect(await readFile(auth.filename, 'utf8')).toBe(original)
    const unsupported = JSON.stringify({ 'openai-codex': { ...credential(), future_token: 'secret' } })
    await writeFile(auth.filename, unsupported, { mode: 0o600 })
    await expect(auth.modify(OPENAI_CODEX_PROVIDER, async () => {
      called = true
      return credential()
    })).rejects.toThrow('unsupported credential field')
    expect(called).toBe(false)
    expect(await readFile(auth.filename, 'utf8')).toBe(unsupported)
  })
})
