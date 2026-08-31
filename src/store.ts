/** Owner-only persistent OAuth credential storage for OpenAI Codex. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstat, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const OPENAI_CODEX_PROVIDER = 'openai-codex'
export const OPENAI_CODEX_AUTH_FILENAME = '.openai-codex-auth.json'
export const OPENAI_CODEX_REAUTH_REQUIRED = 'OPENAI_CODEX_REAUTH_REQUIRED'
export const OPENAI_CODEX_REFRESH_IN_PROGRESS = 'OPENAI_CODEX_REFRESH_IN_PROGRESS'
const AUTH_FORMAT_VERSION = 1
const INTENT_FORMAT_VERSION = 1
const WAIT_TIMEOUT_MS = 30_000
const WAIT_INTERVAL_MS = 25

interface AuthDocument { version: 1, credential: OAuthCredential }
interface IntentDocument { version: 1, generationId: string, state: 'pending', startedAt: string }

export class OpenAICodexReauthRequiredError extends Error {
  readonly code = OPENAI_CODEX_REAUTH_REQUIRED
  constructor(message = 'openai-codex: canonical credential outcome is unknown; Owner reauth is required') {
    super(message)
    this.name = 'OpenAICodexReauthRequiredError'
  }
}

export class OpenAICodexRefreshInProgressError extends Error {
  readonly code = OPENAI_CODEX_REFRESH_IN_PROGRESS
  constructor() {
    super('openai-codex: canonical credential refresh remains in progress')
    this.name = 'OpenAICodexRefreshInProgressError'
  }
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function lstatOptional(filename: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(filename) } catch (error) { if (isENOENT(error)) return undefined; throw error }
}

async function assertNoSymlinkComponents(filename: string): Promise<void> {
  const absolute = resolve(filename)
  const root = parse(absolute).root
  let current = root
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    const info = await lstatOptional(current)
    if (info === undefined) return
    if (info.isSymbolicLink()) throw new Error(`openai-codex: shared credential path component is a symlink: ${current}`)
  }
}

async function assertOwnerOnly(filename: string): Promise<void> {
  const info = await lstatOptional(filename)
  if (info === undefined) return
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`openai-codex: ${filename} must be a regular file with link count 1`)
  }
  /* v8 ignore next -- Windows cannot express POSIX ownership mode. */
  if (process.platform === 'win32') return
  const mode = Number(info.mode)
  if ((mode & 0o077) !== 0) {
    throw new Error(`openai-codex: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)}); run "chmod 600 ${filename}" before starting again`)
  }
}

async function syncFileAndDirectory(filename: string): Promise<void> {
  const file = await open(filename, 'r')
  try { await file.sync() } finally { await file.close() }
  await syncDirectory(filename)
}

async function syncDirectory(filename: string): Promise<void> {
  const directory = await open(dirname(filename), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

function generation(info: Awaited<ReturnType<typeof stat>>): string {
  return `fs:${String(info.dev)}:${String(info.ino)}`
}

function parseIntent(text: string, filename: string): IntentDocument {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new OpenAICodexReauthRequiredError(`openai-codex: ${filename} is invalid; Owner reauth is required`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OpenAICodexReauthRequiredError()
  const document = value as Record<string, unknown>
  if (
    Object.keys(document).sort().join(',') !== 'generationId,startedAt,state,version'
    || document['version'] !== INTENT_FORMAT_VERSION
    || document['state'] !== 'pending'
    || typeof document['generationId'] !== 'string'
    || !/^fs:[0-9]+:[0-9]+$/.test(document['generationId'])
    || typeof document['startedAt'] !== 'string'
    || Number.isNaN(Date.parse(document['startedAt']))
  ) throw new OpenAICodexReauthRequiredError()
  return document as unknown as IntentDocument
}

function parseDocument(text: string, filename: string): AuthDocument {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(`openai-codex: ${filename} is not valid JSON`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`openai-codex: ${filename} must contain an object`)
  const document = value as Record<string, unknown>
  if (document['version'] !== AUTH_FORMAT_VERSION) throw new Error(`openai-codex: ${filename} has unsupported auth format version ${String(document['version'])}`)
  if (Object.keys(document).some(key => key !== 'version' && key !== 'credential')) throw new Error(`openai-codex: ${filename} contains an unknown top-level field`)
  const raw = document['credential']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`openai-codex: ${filename} credential must be an object`)
  const credential = raw as Record<string, unknown>
  if (Object.keys(credential).some(key => !['type', 'access', 'refresh', 'expires', 'accountId'].includes(key))) throw new Error(`openai-codex: ${filename} credential contains an unknown field`)
  if (credential['type'] !== 'oauth') throw new Error(`openai-codex: ${filename} credential type must be oauth`)
  for (const key of ['access', 'refresh', 'accountId'] as const) {
    if (typeof credential[key] !== 'string' || credential[key].length === 0) throw new Error(`openai-codex: ${filename} credential ${key} must be a non-empty string`)
  }
  if (typeof credential['expires'] !== 'number' || !Number.isFinite(credential['expires']) || credential['expires'] <= 0) throw new Error(`openai-codex: ${filename} credential expires must be a positive finite number`)
  return { version: 1, credential: credential as unknown as OAuthCredential }
}

function cloneCredential(credential: OAuthCredential): OAuthCredential { return structuredClone(credential) }

export function openAICodexAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_AUTH_FILENAME))
}

export class OpenAICodexCredentialStore implements CredentialStore {
  readonly filename: string
  readonly refreshIntentFilename: string
  private readonly shared: boolean
  private readonly ownerReauth = new AsyncLocalStorage<boolean>()

  constructor(filename?: string) {
    this.shared = filename !== undefined
    if (filename !== undefined && !isAbsolute(filename)) throw new Error('openai-codex: credentialFile must be an absolute path')
    this.filename = resolve(filename ?? openAICodexAuthPath())
    this.refreshIntentFilename = `${this.filename}.refresh-intent.json`
  }

  private async assertSharedBoundary(): Promise<void> {
    if (!this.shared) return
    await assertNoSymlinkComponents(this.filename)
    await assertOwnerOnly(this.filename)
    const parent = await lstatOptional(dirname(this.filename))
    if (parent !== undefined && (!parent.isDirectory() || (process.platform !== 'win32' && (Number(parent.mode) & 0o077) !== 0))) {
      throw new Error(`openai-codex: shared credential directory ${dirname(this.filename)} must be a private directory`)
    }
  }

  private async readRaw(): Promise<OAuthCredential | undefined> {
    await assertOwnerOnly(this.filename)
    try { return cloneCredential(parseDocument(await readFile(this.filename, 'utf8'), this.filename).credential) }
    catch (error) { if (isENOENT(error)) return undefined; throw error }
  }

  private async readIntent(): Promise<IntentDocument | undefined> {
    await assertOwnerOnly(this.refreshIntentFilename)
    try { return parseIntent(await readFile(this.refreshIntentFilename, 'utf8'), this.refreshIntentFilename) }
    catch (error) { if (isENOENT(error)) return undefined; throw error }
  }

  private async clearIntent(): Promise<void> {
    await rm(this.refreshIntentFilename, { force: true })
    await syncDirectory(this.refreshIntentFilename)
  }

  private async lockOwnerAlive(): Promise<boolean> {
    let text: string
    try { text = await readFile(`${this.filename}.lock`, 'utf8') }
    catch (error) { if (isENOENT(error)) return false; throw error }
    const pid = Number.parseInt(text.trim(), 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }

  private async resolvePendingIntent(wait: boolean): Promise<OAuthCredential | undefined> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    while (true) {
      const intent = await this.readIntent()
      if (intent === undefined) return this.readRaw()
      const currentInfo = await lstatOptional(this.filename)
      if (currentInfo !== undefined && generation(currentInfo) !== intent.generationId) {
        const current = await this.readRaw()
        if (current !== undefined && current.expires > Date.now()) {
          await this.clearIntent()
          return current
        }
      }
      if (!wait || !await this.lockOwnerAlive()) throw new OpenAICodexReauthRequiredError()
      if (Date.now() >= deadline) throw new OpenAICodexRefreshInProgressError()
      await new Promise(resolveWait => setTimeout(resolveWait, WAIT_INTERVAL_MS))
    }
  }

  private async persistIntent(currentInfo: Awaited<ReturnType<typeof stat>>): Promise<void> {
    const intent: IntentDocument = { version: 1, generationId: generation(currentInfo), state: 'pending', startedAt: new Date().toISOString() }
    await writeFileAtomic(this.refreshIntentFilename, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    await syncFileAndDirectory(this.refreshIntentFilename)
  }

  /** Scope exactly one explicit Owner login that may replace an unknown generation. */
  async withOwnerReauth<T>(operation: () => Promise<T>): Promise<T> {
    return this.ownerReauth.run(true, operation)
  }

  private async readCurrent(): Promise<OAuthCredential | undefined> {
    await this.assertSharedBoundary()
    return this.shared ? this.resolvePendingIntent(true) : this.readRaw()
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === OPENAI_CODEX_PROVIDER ? this.readCurrent() : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return await this.readCurrent() === undefined ? [] : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await this.assertSharedBoundary()
    try {
      return await withFileLock(this.filename, async () => {
        let current = await this.readRaw()
        const isOwnerReauth = this.ownerReauth.getStore() === true
        if (this.shared && await this.readIntent() !== undefined && !isOwnerReauth) current = await this.resolvePendingIntent(false)
        let intentPersisted = false
        if (this.shared && !isOwnerReauth && current?.expires !== undefined && current.expires <= Date.now()) {
          await this.persistIntent(await stat(this.filename))
          intentPersisted = true
        }
        let candidate: Credential | undefined
        try { candidate = await fn(current) }
        catch (error) { if (intentPersisted) throw new OpenAICodexReauthRequiredError(); throw error }
        if (candidate === undefined) {
          if (intentPersisted) throw new OpenAICodexReauthRequiredError()
          return current
        }
        const document = parseDocument(JSON.stringify({ version: AUTH_FORMAT_VERSION, credential: candidate }), this.filename)
        try {
          await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
          await syncFileAndDirectory(this.filename)
        } catch (error) { if (intentPersisted) throw new OpenAICodexReauthRequiredError(); throw error }
        if (this.shared) await this.clearIntent()
        return cloneCredential(document.credential)
      })
    } catch (error) {
      if (this.shared && !(error instanceof OpenAICodexReauthRequiredError)) {
        if (await this.readIntent() !== undefined) return this.resolvePendingIntent(true)
        const current = await this.readRaw()
        if (current !== undefined && current.expires > Date.now()) return current
      }
      throw error
    }
  }

  async delete(providerId: string): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, async () => {
      await rm(this.filename, { force: true })
      if (this.shared) await this.clearIntent()
    })
  }
}
