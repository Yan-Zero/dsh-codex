import { open, readFile, stat, writeFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../../src/store.ts'

const [action, filename, endpoint] = process.argv.slice(2)
if (action === undefined || filename === undefined) throw new Error('missing worker arguments')

const refreshed = {
  type: 'oauth' as const,
  access: 'fixture-access-new',
  refresh: 'fixture-refresh-new',
  expires: Date.now() + 60_000,
  accountId: 'fixture-account',
}

async function durableWrite(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 })
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

if (action === 'refresh' || action === 'crash-pre' || action === 'crash-post-rotation') {
  const store = new OpenAICodexCredentialStore(filename)
  await store.modify(OPENAI_CODEX_PROVIDER, async current => {
    if (current?.type === 'oauth' && current.expires > Date.now()) return undefined
    if (action === 'crash-pre') process.exit(71)
    if (endpoint === undefined) throw new Error('missing refresh endpoint')
    const response = await fetch(endpoint, { method: 'POST' })
    if (!response.ok) throw new Error('fixture refresh failed')
    if (action === 'crash-post-rotation') process.exit(72)
    return refreshed
  })
} else if (action === 'crash-post-write') {
  const info = await stat(filename)
  await durableWrite(`${filename}.refresh-intent.json`, `${JSON.stringify({
    version: 1,
    generationId: `fs:${String(info.dev)}:${String(info.ino)}`,
    state: 'pending',
    startedAt: new Date().toISOString(),
  })}\n`)
  const prior = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
  await writeFileAtomic(filename, `${JSON.stringify({ ...prior, credential: refreshed })}\n`, { mode: 0o600, dirMode: 0o700 })
  process.exit(73)
} else {
  throw new Error(`unknown worker action: ${action}`)
}
