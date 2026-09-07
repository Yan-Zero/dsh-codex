import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAICodexService } from '../src/service.ts'
import { readOpenAICodexRateLimits } from '../src/usage.ts'
import type { OpenAICodexUsage } from '../src/usage.ts'

vi.mock('../src/usage.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/usage.ts')>(), readOpenAICodexRateLimits: vi.fn(),
}))
const preferences = { reasoningSummary: 'auto' as const, modifyReadImage: true,
  shareImagegenWithOtherModels: true, useWebSocketContextReuse: false, useNativeCompaction: false,
  contextWindow: null, overrideSparkContextWindow: false, fastModeDefault: false,
  proxyMode: 'off' as const, proxyUrl: '', modelCatalog: [] }
const quota = (remainingPercent: number): OpenAICodexUsage => ({ rateLimits: [{ id: 'codex',
  windows: [{ remainingPercent, windowSeconds: 604800 }] }] })
let root: string
let service: OpenAICodexService
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-account-quota-'))
  vi.stubEnv('DSH_HOME', root)
  service = new OpenAICodexService({ ...preferences, credentialFile: join(root, 'auth.json') })
})
afterEach(async () => {
  await service.dispose()
  service.usageTracker.ledger.close()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function add() {
  return (await service.accounts.create('备用')).accounts.find(account => account.name === '备用')!.id
}

describe('account quota caches', () => {
  it('retains legacy quota and isolates new account snapshots, including refresh failures', async () => {
    await service.usageTracker.ledger.saveQuota(quota(15))
    expect(await service.latestQuota()).toMatchObject([{ remainingPercent: 15 }])
    const id = await add()
    await service.accounts.update({ selectedAccountId: id })
    expect(await service.latestQuota()).toEqual([])
    vi.mocked(readOpenAICodexRateLimits).mockRejectedValueOnce(new Error('unavailable'))
    await expect(service.usage()).rejects.toThrow('unavailable')
    expect(await service.latestQuota()).toEqual([])
    vi.mocked(readOpenAICodexRateLimits).mockResolvedValueOnce(quota(85))
    await service.usage()
    expect(await service.latestQuota()).toMatchObject([{ remainingPercent: 85 }])
    expect(await service.usageTracker.ledger.latestQuota()).toMatchObject([{ remainingPercent: 15 }])
    await service.accounts.update({ selectedAccountId: 'default' })
    expect(await service.latestQuota()).toMatchObject([{ remainingPercent: 15 }])
    await service.dispose()
    service.usageTracker.ledger.close()
    service = new OpenAICodexService({ ...preferences, credentialFile: join(root, 'auth.json') })
    await service.accounts.update({ selectedAccountId: id })
    expect(await service.latestQuota()).toMatchObject([{ remainingPercent: 85 }])
  })

  it('pins pending refresh writes to the original account when selection changes', async () => {
    const id = await add()
    let finish!: (usage: OpenAICodexUsage) => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    vi.mocked(readOpenAICodexRateLimits).mockImplementationOnce(async store => {
      expect(store.filename).toBe(service.credentials.filename)
      started()
      return new Promise(resolve => { finish = resolve })
    })
    const pending = service.usage()
    await entered
    await service.accounts.update({ selectedAccountId: id })
    vi.mocked(readOpenAICodexRateLimits).mockResolvedValueOnce(quota(95))
    await service.usage()
    finish(quota(5))
    await pending
    expect(await service.latestQuota()).toMatchObject([{ remainingPercent: 95 }])
    await service.accounts.update({ selectedAccountId: 'default' })
    expect(await service.latestQuota()).toMatchObject([{ remainingPercent: 5 }])
  })
})
