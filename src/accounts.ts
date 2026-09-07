/** Named Codex accounts, with credentials isolated from browser-facing metadata. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { OPENAI_CODEX_PROVIDER, OpenAICodexCredentialStore } from './store.ts'

interface Account { id: string; name: string }
interface AccountDocument {
  version: 1
  selectedAccountId: string
  autoSwitch: boolean
  accounts: Account[]
}
export interface OpenAICodexAccountsOverview {
  selectedAccountId: string
  autoSwitch: boolean
  accounts: (Account & { authenticated: boolean; error?: string })[]
}
export interface OpenAICodexAccountsPatch {
  accountId?: string
  name?: string
  selectedAccountId?: string
  autoSwitch?: boolean
}

const validId = (id: unknown): id is string => typeof id === 'string'
  && (id === 'default' || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
const invalid = () => new Error('openai-codex: invalid account settings')
function nameOf(value: unknown): string {
  if (typeof value !== 'string') throw new Error('openai-codex: account name must be text')
  const name = value.trim().normalize('NFC')
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error('openai-codex: account name must contain 1–64 characters without control characters')
  return name
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validate(value: unknown): AccountDocument {
  if (!record(value) || Object.keys(value).some(key => !['version', 'selectedAccountId', 'autoSwitch', 'accounts'].includes(key))
    || value['version'] !== 1 || !validId(value['selectedAccountId']) || typeof value['autoSwitch'] !== 'boolean'
    || !Array.isArray(value['accounts']) || value['accounts'].length < 1 || value['accounts'].length > 20) throw invalid()
  const ids = new Set<string>(), names = new Set<string>()
  for (const account of value['accounts']) {
    if (!record(account) || Object.keys(account).some(key => !['id', 'name'].includes(key)) || !validId(account['id'])) throw invalid()
    const name = nameOf(account['name'])
    if (name !== account['name'] || ids.has(account['id']) || names.has(name.toLowerCase())) throw invalid()
    ids.add(account['id']); names.add(name.toLowerCase())
  }
  if (!ids.has('default') || !ids.has(value['selectedAccountId'])) throw invalid()
  return value as unknown as AccountDocument
}

export class OpenAICodexAccounts {
  readonly filename: string
  constructor(private readonly defaultStore: OpenAICodexCredentialStore) {
    this.filename = `${defaultStore.filename}.accounts.json`
  }

  private async read(): Promise<AccountDocument> {
    try {
      const info = await lstat(this.filename)
      if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw invalid()
      return validate(JSON.parse(await readFile(this.filename, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {
        version: 1, selectedAccountId: 'default', autoSwitch: false, accounts: [{ id: 'default', name: '默认账号' }],
      }
      // Never echo arbitrary metadata or credential document input in API errors.
      throw new Error('openai-codex: cannot read account settings; check file format and owner-only permissions')
    }
  }

  private async mutate(fn: (document: AccountDocument) => void): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, async () => {
      const document = await this.read()
      fn(document)
      validate(document)
      await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  }

  private accountStore(id: string): OpenAICodexCredentialStore {
    if (!validId(id)) throw invalid()
    return id === 'default' ? this.defaultStore
      : new OpenAICodexCredentialStore(join(`${this.defaultStore.filename}.accounts`, `${id}.json`))
  }

  async overview(): Promise<OpenAICodexAccountsOverview> {
    const document = await this.read()
    return {
      selectedAccountId: document.selectedAccountId, autoSwitch: document.autoSwitch,
      accounts: await Promise.all(document.accounts.map(async account => {
        try { return { ...account, authenticated: Boolean(await this.accountStore(account.id).read(OPENAI_CODEX_PROVIDER)) } }
        catch { return { ...account, authenticated: false, error: '无法读取账号凭证，请检查文件权限或重新登录' } }
      })),
    }
  }

  async create(name: string): Promise<OpenAICodexAccountsOverview> {
    const normalized = nameOf(name)
    await this.mutate(document => {
      if (document.accounts.length >= 20) throw new Error('openai-codex: at most 20 accounts are supported')
      if (document.accounts.some(account => account.name.toLowerCase() === normalized.toLowerCase()))
        throw new Error('openai-codex: account name already exists')
      document.accounts.push({ id: randomUUID(), name: normalized })
    })
    return this.overview()
  }

  async update(patch: OpenAICodexAccountsPatch): Promise<OpenAICodexAccountsOverview> {
    if (!record(patch) || Object.keys(patch).some(key => !['accountId', 'name', 'selectedAccountId', 'autoSwitch'].includes(key))
      || (patch.autoSwitch !== undefined && typeof patch.autoSwitch !== 'boolean')
      || (patch.accountId !== undefined && !validId(patch.accountId))
      || (patch.selectedAccountId !== undefined && !validId(patch.selectedAccountId))) throw invalid()
    await this.mutate(document => {
      if (patch.accountId !== undefined && !document.accounts.some(account => account.id === patch.accountId)) throw invalid()
      if (patch.name !== undefined) {
        const account = document.accounts.find(account => account.id === patch.accountId)
        if (!account) throw new Error('openai-codex: renaming requires an existing accountId')
        const name = nameOf(patch.name)
        if (document.accounts.some(other => other.id !== account.id && other.name.toLowerCase() === name.toLowerCase()))
          throw new Error('openai-codex: account name already exists')
        account.name = name
      }
      if (typeof patch.selectedAccountId === 'string') {
        if (!document.accounts.some(account => account.id === patch.selectedAccountId)) throw invalid()
        document.selectedAccountId = patch.selectedAccountId
      }
      if (typeof patch.autoSwitch === 'boolean') document.autoSwitch = patch.autoSwitch
    })
    return this.overview()
  }

  async store(accountId?: string): Promise<OpenAICodexCredentialStore> {
    const document = await this.read()
    const id = accountId ?? document.selectedAccountId
    if (!document.accounts.some(account => account.id === id)) throw new Error('openai-codex: unknown account')
    return this.accountStore(id)
  }

  async candidates(): Promise<{ id: string; store: OpenAICodexCredentialStore }[]> {
    const document = await this.read()
    const result = [{ id: document.selectedAccountId, store: this.accountStore(document.selectedAccountId) }]
    if (document.autoSwitch) {
      for (const account of document.accounts) {
        if (account.id === document.selectedAccountId) continue
        const store = this.accountStore(account.id)
        try { if (await store.read(OPENAI_CODEX_PROVIDER)) result.push({ id: account.id, store }) }
        catch { /* One damaged credential must not suppress usable alternatives. */ }
      }
    }
    return result
  }

  async selectAfterFailover(failedId: string, nextId: string): Promise<void> {
    await this.mutate(document => {
      if (document.autoSwitch && document.selectedAccountId === failedId && document.accounts.some(account => account.id === nextId))
        document.selectedAccountId = nextId
    })
  }
}
