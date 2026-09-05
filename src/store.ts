/**
 * Owner-only persistent OAuth credential storage for the OpenAI Codex bundle.
 * @module dsh-codex/store
 */

import { lstat, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { decodeCredentialDocument } from './credential-document.ts'

/** Provider route and pi-ai provider id owned by this bundle. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/** Basename of the OAuth document inside the Harness home. */
export const OPENAI_CODEX_AUTH_FILENAME = '.openai-codex-auth.json'

/** Current on-disk format; pre-release readers reject every other version. */
const AUTH_FORMAT_VERSION = 1

// Shared by store instances in this process; external tools need no lock protocol.
const pendingWrites = new Map<string, Promise<unknown>>()
async function serialize<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingWrites.get(filename) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  pendingWrites.set(filename, next)
  try { return await next } finally {
    if (pendingWrites.get(filename) === next) pendingWrites.delete(filename)
  }
}

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  credential: OAuthCredential
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Reject a credential document readable by another POSIX user. */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  /* v8 ignore next -- native Windows coverage takes the mode-less branch */
  if (process.platform === 'win32') return
  /* v8 ignore start -- POSIX tests cover this branch; Windows cannot express it */
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `openai-codex: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  /* v8 ignore stop */
}

/** Validate the strict JSON document without quoting token-bearing input. */
function parseDocument(text: string, filename: string): AuthDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`openai-codex: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`openai-codex: ${filename} must contain an object`)
  }
  const document = value as Record<string, unknown>
  if (document['version'] !== AUTH_FORMAT_VERSION) {
    throw new Error(`openai-codex: ${filename} has unsupported auth format version ${String(document['version'])}`)
  }
  if (Object.keys(document).some(key => key !== 'version' && key !== 'credential')) {
    throw new Error(`openai-codex: ${filename} contains an unknown top-level field`)
  }
  const raw = document['credential']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`openai-codex: ${filename} credential must be an object`)
  }
  const credential = raw as Record<string, unknown>
  if (Object.keys(credential).some(key => !['type', 'access', 'refresh', 'expires', 'accountId', 'idToken', 'email'].includes(key))) {
    throw new Error(`openai-codex: ${filename} credential contains an unknown field`)
  }
  if (credential['type'] !== 'oauth') throw new Error(`openai-codex: ${filename} credential type must be oauth`)
  for (const key of ['access', 'refresh', 'accountId'] as const) {
    if (typeof credential[key] !== 'string' || credential[key].length === 0) {
      throw new Error(`openai-codex: ${filename} credential ${key} must be a non-empty string`)
    }
  }
  if (typeof credential['expires'] !== 'number' || !Number.isFinite(credential['expires']) || credential['expires'] <= 0) {
    throw new Error(`openai-codex: ${filename} credential expires must be a positive finite number`)
  }
  for (const key of ['idToken', 'email']) {
    if (credential[key] !== undefined && (typeof credential[key] !== 'string' || !credential[key]))
      throw new Error(`openai-codex: invalid credential ${key}`)
  }
  return { version: AUTH_FORMAT_VERSION, credential: credential as unknown as OAuthCredential }
}

/** Detach a credential from callers that may mutate provider-owned extras. */
function cloneCredential(credential: OAuthCredential): OAuthCredential {
  return structuredClone(credential)
}

/**
 * Resolve the default OAuth document path.
 * @param dshHome - optional Harness-home override.
 * @returns the absolute owner-only document path.
 */
export function openAICodexAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_AUTH_FILENAME))
}

/** File-backed pi-ai store scoped to the single OpenAI Codex provider. */
export class OpenAICodexCredentialStore implements CredentialStore {
  /** Absolute credential document path. */
  readonly filename: string

  /**
   * @param filename - explicit document path, defaulting under `$DSH_HOME`.
   */
  private readonly shared: boolean
  constructor(filename?: string) {
    this.shared = filename !== undefined
    if (filename !== undefined && !isAbsolute(filename)) throw new Error('openai-codex: credentialFile must be an absolute path')
    this.filename = resolve(filename ?? openAICodexAuthPath())
  }

  /** Read and validate the current document without acquiring the writer lock. */
  private async readCurrent(): Promise<OAuthCredential | undefined> {
    if (this.shared) {
      try {
        const info = await lstat(this.filename)
        if (!info.isFile() || info.nlink !== 1)
          throw new Error('openai-codex: shared credential must be a single-link regular file')
      } catch (error) { if (!isENOENT(error)) throw error }
    }
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
    return this.shared ? decodeCredentialDocument(text).credential : cloneCredential(parseDocument(text, this.filename).credential)
  }

  /** @inheritdoc */
  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === OPENAI_CODEX_PROVIDER ? this.readCurrent() : undefined
  }

  /** @inheritdoc */
  async list(): Promise<readonly CredentialInfo[]> {
    return await this.readCurrent() === undefined
      ? []
      : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  /** @inheritdoc */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    }
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    const coordinate = this.shared ? serialize : withFileLock
    return coordinate(this.filename, async () => {
      const current = await this.readCurrent()
      const candidate = await fn(current === undefined ? undefined : cloneCredential(current))
      if (candidate === undefined) return current
      const document = parseDocument(JSON.stringify({
        version: AUTH_FORMAT_VERSION,
        credential: candidate,
      }), this.filename)
      let output: unknown = document
      if (this.shared) {
        // Re-read after refresh to retain concurrent edits to unrelated providers.
        await assertOwnerOnly(this.filename)
        try {
          const source = decodeCredentialDocument(await readFile(this.filename, 'utf8'))
          if (JSON.stringify(source.credential) !== JSON.stringify(current))
            throw new Error('openai-codex: credential changed during update; reload before retrying')
          output = source.update(document.credential)
          decodeCredentialDocument(JSON.stringify(output))
        } catch (error) {
          if (!isENOENT(error)) throw error
          if (current !== undefined) throw new Error('openai-codex: credential file was removed during update')
        }
      }
      await writeFileAtomic(this.filename, `${JSON.stringify(output, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
      return cloneCredential(document.credential)
    })
  }

  /** @inheritdoc */
  async delete(providerId: string): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    if (!this.shared) {
      await withFileLock(this.filename, () => rm(this.filename, { force: true }))
      return
    }
    await serialize(this.filename, async () => {
      await this.readCurrent()
      let text: string
      try { text = await readFile(this.filename, 'utf8') }
      catch (error) { if (isENOENT(error)) return; throw error }
      const document = decodeCredentialDocument(text)
      await writeFileAtomic(this.filename, `${JSON.stringify(document.update(undefined), null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  }
}
