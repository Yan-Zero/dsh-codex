import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  OpenAICodexCredentialStore,
  OpenAICodexReauthRequiredError,
  OPENAI_CODEX_PROVIDER,
} from '../src/store.ts'

const worker = fileURLToPath(new URL('./fixtures/shared-refresh-worker.ts', import.meta.url))
let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots = []
})

function credential(expires: number, generation = 'old'): OAuthCredential {
  return {
    type: 'oauth',
    access: `fixture-access-${generation}`,
    refresh: `fixture-refresh-${generation}`,
    expires,
    accountId: 'fixture-account',
  }
}

async function sharedStore(): Promise<OpenAICodexCredentialStore> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-codex-shared-'))
  roots.push(root)
  await chmod(root, 0o700)
  const store = new OpenAICodexCredentialStore(join(root, '.openai-codex-auth.json'))
  await store.modify(OPENAI_CODEX_PROVIDER, () => Promise.resolve(credential(Date.now() - 60_000)))
  return store
}

function runWorker(action: string, filename: string, endpoint?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, action, filename, ...(endpoint === undefined ? [] : [endpoint])], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === null) reject(new Error('worker terminated without an exit code'))
      else if (code === 0 || code === 71 || code === 72 || code === 73) resolve(code)
      else reject(new Error(`worker failed (${code}): ${stderr}`))
    })
  })
}

async function refreshServer(delayMs = 0): Promise<{ endpoint: string, calls: () => number, close: () => Promise<void> }> {
  let count = 0
  const server = createServer((_request, response) => {
    count += 1
    setTimeout(() => { response.writeHead(204); response.end() }, delayMs)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server missing TCP address')
  return {
    endpoint: `http://127.0.0.1:${address.port}/refresh`,
    calls: () => count,
    close: () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
  }
}

async function burst(processes: number, delayMs = 0): Promise<number> {
  const store = await sharedStore()
  const remote = await refreshServer(delayMs)
  try {
    await Promise.all(Array.from({ length: processes }, () => runWorker('refresh', store.filename, remote.endpoint)))
    const current = await store.read(OPENAI_CODEX_PROVIDER)
    expect(current).toMatchObject({ access: 'fixture-access-new' })
    return remote.calls()
  } finally {
    await remote.close()
  }
}

describe('shared canonical credential serialization', () => {
  for (const processes of [10, 20, 50]) {
    it(`${processes}-process burst performs one remote refresh`, async () => {
      expect(await burst(processes)).toBe(1)
    }, 30_000)
  }

  it('slow lock waiters reread the committed inode and stale readers do not refresh twice', async () => {
    expect(await burst(10, 2_500)).toBe(1)
  }, 30_000)

  it('crash before dispatch fails closed without a remote call', async () => {
    const store = await sharedStore()
    const remote = await refreshServer()
    try {
      expect(await runWorker('crash-pre', store.filename, remote.endpoint)).toBe(71)
      expect(remote.calls()).toBe(0)
      await expect(store.read(OPENAI_CODEX_PROVIDER)).rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
    } finally { await remote.close() }
  })

  it('crash post-rotation/pre-write requires reauth and never retries the old token', async () => {
    const store = await sharedStore()
    const remote = await refreshServer()
    try {
      expect(await runWorker('crash-post-rotation', store.filename, remote.endpoint)).toBe(72)
      await expect(store.read(OPENAI_CODEX_PROVIDER)).rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
      let retryCallbacks = 0
      await expect(store.modify(OPENAI_CODEX_PROVIDER, async () => {
        retryCallbacks += 1
        return credential(Date.now() + 60_000, 'forbidden-retry')
      })).rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
      expect(retryCallbacks).toBe(0)
      expect(remote.calls()).toBe(1)
    } finally { await remote.close() }
  })

  it('crash post-write/pre-intent-clear accepts the new inode without refreshing', async () => {
    const store = await sharedStore()
    expect(await runWorker('crash-post-write', store.filename)).toBe(73)
    expect(await store.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'fixture-access-new' })
    await expect(stat(store.refreshIntentFilename)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('one canonical Owner reauth clears unknown outcome for every store instance', async () => {
    const store = await sharedStore()
    expect(await runWorker('crash-pre', store.filename)).toBe(71)
    await rm(`${store.filename}.lock`, { force: true }) // quiesced control-plane orphan recovery
    let logins = 0
    await store.withOwnerReauth(() => store.modify(OPENAI_CODEX_PROVIDER, async () => {
      logins += 1
      return credential(Date.now() + 60_000, 'reauth')
    }))
    const fleet = Array.from({ length: 91 }, () => new OpenAICodexCredentialStore(store.filename))
    expect(await Promise.all(fleet.map(item => item.read(OPENAI_CODEX_PROVIDER)))).toHaveLength(91)
    expect(logins).toBe(1)
  })

  it('rejects relative, symlinked, hardlinked, and over-broad shared paths', async () => {
    expect(() => new OpenAICodexCredentialStore('.openai-codex-auth.json')).toThrow(/absolute path/)
    const store = await sharedStore()
    const linked = join(dirname(store.filename), 'linked.json')
    await writeFile(linked, await readFile(store.filename), { mode: 0o600 })
    await chmod(linked, 0o644)
    await expect(new OpenAICodexCredentialStore(linked).read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/readable beyond its owner/)
    await chmod(linked, 0o600)
    const hardlink = join(dirname(store.filename), 'hardlink.json')
    await link(linked, hardlink)
    await expect(new OpenAICodexCredentialStore(linked).read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/link count 1/)
    const symbolic = join(dirname(store.filename), 'symbolic.json')
    await symlink(store.filename, symbolic)
    await expect(new OpenAICodexCredentialStore(symbolic).read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/symlink/)
  })
})
