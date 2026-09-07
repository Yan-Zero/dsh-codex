import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICodexAccounts } from '../src/accounts.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-accounts-'))
  roots.push(root)
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  return { store, accounts: new OpenAICodexAccounts(store) }
}
async function login(store: OpenAICodexCredentialStore) {
  await store.modify(OPENAI_CODEX_PROVIDER, async () => ({
    type: 'oauth', access: 'secret-access', refresh: 'secret-refresh', expires: Date.now() + 3600000, accountId: 'remote-account',
  }))
}
async function add(accounts: OpenAICodexAccounts, name: string) {
  return (await accounts.create(name)).accounts.find(account => account.name === name)!.id
}

describe('named Codex accounts', () => {
  it('retains existing credentials at their original path without copying or exposing them', async () => {
    const { store, accounts } = await setup()
    await login(store)
    const before = await readFile(store.filename, 'utf8')
    expect(await accounts.store()).toBe(store)
    expect(await accounts.overview()).toEqual({ selectedAccountId: 'default', autoSwitch: false,
      accounts: [{ id: 'default', name: '默认账号', authenticated: true }] })
    await accounts.create('工作')
    expect(await readFile(store.filename, 'utf8')).toBe(before)
    expect(JSON.stringify(await accounts.overview())).not.toContain('secret')
  })

  it('persists isolated account credentials, names, selection and switching settings owner-only', async () => {
    const { store, accounts } = await setup()
    const id = await add(accounts, '工作')
    const second = await accounts.store(id)
    expect(second.filename).toBe(join(`${store.filename}.accounts`, `${id}.json`))
    await login(second)
    await accounts.update({ accountId: id, name: '主账号', selectedAccountId: id, autoSwitch: true })
    const restored = new OpenAICodexAccounts(store)
    expect(await restored.overview()).toMatchObject({ selectedAccountId: id, autoSwitch: true,
      accounts: [{ id: 'default', authenticated: false }, { id, name: '主账号', authenticated: true }] })
    expect((await restored.store()).filename).toBe(second.filename)
    expect(await store.read(OPENAI_CODEX_PROVIDER)).toBeUndefined()
    if (process.platform !== 'win32') {
      expect((await stat(accounts.filename)).mode & 0o777).toBe(0o600)
      expect((await stat(second.filename)).mode & 0o777).toBe(0o600)
      expect((await stat(`${store.filename}.accounts`)).mode & 0o777).toBe(0o700)
    }
  })

  it('serializes updates from separate managers without losing independently changed fields', async () => {
    const { store, accounts } = await setup()
    const second = new OpenAICodexAccounts(store)
    const id = await add(accounts, '工作')
    await Promise.all([
      accounts.update({ autoSwitch: true }), second.update({ selectedAccountId: id }),
      accounts.update({ accountId: id, name: '重命名' }), second.create('备用'),
    ])
    expect(await accounts.overview()).toMatchObject({ autoSwitch: true, selectedAccountId: id,
      accounts: [{ id: 'default' }, { id, name: '重命名' }, { name: '备用' }] })
  })

  it('validates names, unique names, selection and traversal attempts without leaking input', async () => {
    const { accounts } = await setup()
    for (const name of ['', '   ', 'a\n b', 'a'.repeat(65)]) await expect(accounts.create(name)).rejects.toThrow('account name')
    const id = await add(accounts, 'Work')
    await expect(accounts.create(' work ')).rejects.toThrow('already exists')
    await expect(accounts.update({ accountId: id, name: '默认账号' })).rejects.toThrow('already exists')
    await expect(accounts.update({ selectedAccountId: '../../secret' })).rejects.toThrow('invalid account settings')
    await expect(accounts.store('../../secret')).rejects.toThrow('unknown account')
    await expect(accounts.update({ name: 'missing id' })).rejects.toThrow('accountId')
    await expect(accounts.update({ autoSwitch: 'yes' } as never)).rejects.toThrow('invalid account settings')
    expect((await accounts.overview()).accounts).toHaveLength(2)
  })

  it('returns only selected by default; auto switch adds logged-in backups and skips damaged credentials', async () => {
    const { store, accounts } = await setup()
    const good = await add(accounts, 'Good'), bad = await add(accounts, 'Bad')
    await add(accounts, 'Empty')
    await login(await accounts.store(good))
    const badStore = await accounts.store(bad)
    await writeFile(badStore.filename, 'secret malformed content', { mode: 0o600 })
    expect((await accounts.candidates()).map(candidate => candidate.id)).toEqual(['default'])
    await accounts.update({ autoSwitch: true })
    expect((await accounts.candidates()).map(candidate => candidate.id)).toEqual(['default', good])
    expect(await accounts.overview()).toMatchObject({ accounts: [
      { id: 'default', authenticated: false }, { id: good, authenticated: true },
      { id: bad, authenticated: false, error: expect.any(String) }, { authenticated: false },
    ] })
    expect(JSON.stringify(await accounts.overview())).not.toContain('secret')
    await login(store)
    await accounts.update({ selectedAccountId: good })
    expect((await accounts.candidates()).map(candidate => candidate.id)).toEqual([good, 'default'])
    await accounts.update({ autoSwitch: false })
    expect((await accounts.candidates()).map(candidate => candidate.id)).toEqual([good])
  })

  it('CAS failover preserves intervening user selection and disabling automatic switching', async () => {
    const { accounts } = await setup()
    const one = await add(accounts, 'One'), two = await add(accounts, 'Two')
    await accounts.update({ autoSwitch: true })
    await accounts.selectAfterFailover('default', one)
    expect((await accounts.overview()).selectedAccountId).toBe(one)
    await accounts.selectAfterFailover('default', two)
    expect((await accounts.overview()).selectedAccountId).toBe(one)
    await accounts.update({ autoSwitch: false })
    await accounts.selectAfterFailover(one, two)
    expect((await accounts.overview()).selectedAccountId).toBe(one)
  })

  it('rejects invalid metadata and unsafe permissions without exposing document values', async () => {
    const { accounts } = await setup()
    await accounts.create('Work')
    const valid = await readFile(accounts.filename, 'utf8')
    for (const raw of ['secret-token', valid.replace('"version": 1', '"version": "secret-token"'),
      valid.replace('"id": "default"', '"id": "../../secret-token"')]) {
      await writeFile(accounts.filename, raw, { mode: 0o600 })
      await expect(accounts.overview()).rejects.toThrow('cannot read account settings')
    }
    await writeFile(accounts.filename, valid)
    if (process.platform !== 'win32') {
      await chmod(accounts.filename, 0o644)
      await expect(accounts.overview()).rejects.toThrow('owner-only permissions')
    }
  })

  it('bounds account creation and rejects concurrent duplicate names', async () => {
    const { accounts } = await setup()
    const results = await Promise.allSettled([accounts.create('Same'), accounts.create('Same')])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    for (let index = 2; index < 20; index++) await accounts.create(`Account ${index}`)
    await expect(accounts.create('Overflow')).rejects.toThrow('at most 20')
    expect((await accounts.overview()).accounts).toHaveLength(20)
  })
})
