import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICodexAccounts } from '../src/accounts.ts'
import { OpenAICodexCredentialStore } from '../src/store.ts'
import { registerOpenAICodexAuthRoutes } from '../src/auth-routes.ts'
const mocked = vi.hoisted(() => ({ status: vi.fn(async () => ({ authenticated: false })), logout: vi.fn(async () => {}) }))
vi.mock('../src/auth.ts', async original => ({ ...await original<typeof import('../src/auth.ts')>(), openAICodexAuthStatus: mocked.status, logoutOpenAICodex: mocked.logout }))
const roots: string[] = []
const disposers: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.clearAllMocks() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-account-api-')); roots.push(root)
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  const accounts = new OpenAICodexAccounts(store)
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const ctx = { webServer: { register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => { routes.set(route.path, route.handler); return () => {} } }, effect: (fn: () => () => Promise<void>) => { disposers.push(fn()) } } as unknown as Context
  registerOpenAICodexAuthRoutes(ctx, store, undefined, undefined, undefined, undefined, undefined, undefined, accounts)
  async function request(path: string, method = 'GET', body?: unknown, crossSite = false) {
    const observed = { status: 0, body: '' }
    const req = { url: path, method, headers: { host: '127.0.0.1:3080', ...(crossSite ? { origin: 'https://other.example', 'sec-fetch-site': 'cross-site' } : {}) }, socket: { remoteAddress: '127.0.0.1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } as unknown as IncomingMessage
    const res = { writeHead: (status: number) => { observed.status = status }, end: (body: string) => { observed.body = body } } as unknown as ServerResponse
    await routes.get(path.split('?')[0]!)!(req, res)
    return { status: observed.status, body: JSON.parse(observed.body) as Record<string, unknown> }
  }
  return { accounts, store, request }
}
const base = '/plugins/dsh-openai-codex'
describe('named account settings routes', () => {
  it('keeps the existing default account and auto-switch opt-in', async () => {
    const { request } = await setup()
    expect(await request(base + '/accounts')).toMatchObject({ status: 200, body: { selectedAccountId: 'default', autoSwitch: false, accounts: [{ id: 'default', authenticated: false }] } })
  })
  it('creates, renames, selects and persists the auto-switch option', async () => {
    const { request, accounts } = await setup()
    expect((await request(base + '/accounts', 'POST', { name: 'Work' })).status).toBe(200)
    const id = (await accounts.overview()).accounts[1]!.id
    expect((await request(base + '/accounts', 'PATCH', { accountId: id, name: 'Backup', selectedAccountId: id, autoSwitch: true })).status).toBe(200)
    expect(await accounts.overview()).toMatchObject({ selectedAccountId: id, autoSwitch: true, accounts: [{ id: 'default' }, { id, name: 'Backup' }] })
  })
  it('rejects cross-site account access and mutations', async () => {
    const { request, accounts } = await setup()
    for (const method of ['GET', 'POST', 'PATCH']) expect((await request(base + '/accounts', method, { name: 'Bad' }, true)).status).toBe(403)
    expect((await accounts.overview()).accounts).toHaveLength(1)
  })
  it('rejects invalid types, unknown fields, unknown IDs and unsupported methods', async () => {
    const { request } = await setup()
    for (const body of [{ autoSwitch: 'true' }, { name: 'No id' }, { selectedAccountId: '../../auth' }, { credentialFile: '/tmp/x' }]) expect((await request(base + '/accounts', 'PATCH', body)).status).toBe(400)
    expect((await request(base + '/accounts', 'DELETE')).status).toBe(405)
    expect((await request(base + '/accounts', 'POST', { name: 'x', access: 'secret' })).status).toBe(400)
  })
  it('explicit auth account stays isolated from global selection', async () => {
    const { request, accounts, store } = await setup()
    await accounts.create('Backup')
    const id = (await accounts.overview()).accounts[1]!.id
    await accounts.update({ selectedAccountId: id })
    await request(base + '/auth/local-status?accountId=default')
    expect(mocked.status).toHaveBeenLastCalledWith(store)
    await request(base + '/auth/local-status')
    expect((mocked.status.mock.calls.at(-1) as unknown as [OpenAICodexCredentialStore])[0].filename).toBe((await accounts.store(id)).filename)
  })
  it('logout targets only the specified account', async () => {
    const { request, accounts, store } = await setup()
    await accounts.create('Backup')
    const id = (await accounts.overview()).accounts[1]!.id
    await request(base + '/auth/logout?accountId=' + id, 'POST')
    expect((mocked.logout.mock.calls.at(-1) as unknown as [OpenAICodexCredentialStore])[0].filename).toBe((await accounts.store(id)).filename)
    expect(mocked.logout).not.toHaveBeenCalledWith(store)
  })
  it('rejects invalid or repeated auth account selectors', async () => {
    const { request } = await setup()
    for (const query of ['accountId=unknown', 'accountId=', 'accountId=default&accountId=default']) expect((await request(base + '/auth/local-status?' + query)).status).toBe(400)
    expect(mocked.status).not.toHaveBeenCalled()
  })
})
