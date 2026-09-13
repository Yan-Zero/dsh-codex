import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT } from '../src/search-event.ts'
import { OPENAI_CODEX_SEARCH_URL } from '../src/search.ts'
import { repairOpenAICodexSession, repairOpenAICodexSessions } from '../src/session-repair.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
    seq: 0,
    time: 1,
    data: {
      endpoint: OPENAI_CODEX_SEARCH_URL,
      body: {
        id: 'session-fixture',
        model: 'gpt-5.6-sol',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'current news' }] }],
        commands: { search_query: [{ q: 'current news' }] },
        settings: { search_context_size: 'medium', allowed_callers: ['direct'], external_web_access: false },
        max_output_tokens: 10_000,
      },
    },
    ...overrides,
  }
}

function lines(version: 0 | 1 | 2, ...events: unknown[]): string {
  return [
    JSON.stringify({
      type: 'session', version, id: 'session-fixture', createdAt: 1, delegationDepth: 0,
      ...(version === 2 ? { isSeeded: false } : {}),
    }),
    ...events.map(value => JSON.stringify(value)),
    '',
  ].join('\n')
}

async function fixture(name = 'session.jsonl'): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-session-repair-'))
  const source = join(root, name)
  await writeFile(source, lines(0, event()), { mode: 0o600 })
  return source
}

describe('retired Codex search Session repair', () => {
  it('previews without writing, then publishes v3 while retaining v0 bytes', async () => {
    const source = await fixture()
    const original = await readFile(source)
    const preview = await repairOpenAICodexSession(source)
    expect(preview).toMatchObject({ sourceVersion: 0, targetVersion: 3, repairedEvents: 1, applied: false })
    await expect(stat(preview.target)).rejects.toMatchObject({ code: 'ENOENT' })

    const applied = await repairOpenAICodexSession(source, true)
    expect(applied).toMatchObject({ target: preview.target, sessionId: 'session-fixture', applied: true })
    expect(await readFile(source)).toEqual(original)
    const repaired = (await readFile(applied.target, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(repaired[0]).toMatchObject({ type: 'session', version: 3, id: 'session-fixture' })
    expect(repaired[1]).toMatchObject({
      type: OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
      seq: 0,
      time: 1,
      ignorable: true,
      data: { endpoint: OPENAI_CODEX_SEARCH_URL },
    })
    const targetInfo = await stat(applied.target)
    expect(targetInfo.nlink).toBe(1)
    if (process.platform !== 'win32') expect(targetInfo.mode & 0o777).toBe(0o600)
  })

  it('reads every frame of a concatenated Zstandard generation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-session-repair-zstd-'))
    const source = join(root, 'session.jsonl.zstd')
    const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
    const [header, row] = lines(0, event()).trimEnd().split('\n')
    await writeFile(source, Buffer.concat([
      zstdCompressSync(`${header}\n`, options),
      zstdCompressSync(`${row}\n`, options),
    ]), { mode: 0o600 })

    const result = await repairOpenAICodexSession(source, true)
    expect(result).toMatchObject({ repairedEvents: 1, applied: true })
    expect(result.target).toMatch(/session\.v3\.jsonl\.zstd$/u)
    expect((await stat(result.target)).size).toBeGreaterThan(0)
  })

  it('rejects unrecognized payload fields and existing current generations', async () => {
    const source = await fixture()
    const invalid = event({ data: { ...(event().data as object), unexpected: true } })
    await writeFile(source, lines(0, invalid), { mode: 0o600 })
    await expect(repairOpenAICodexSession(source, true)).rejects.toThrow('unexpected field')
    const target = join(root!, 'session.v3.jsonl')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(source, lines(0, event()), { mode: 0o600 })
    await writeFile(target, 'occupied\n', { mode: 0o600 })
    await expect(repairOpenAICodexSession(source)).rejects.toThrow('current Session generation already exists')
    expect(await readFile(target, 'utf8')).toBe('occupied\n')
  })

  it('rejects filenames whose selected version disagrees with the header', async () => {
    const source = await fixture('session.v1.jsonl')
    await expect(repairOpenAICodexSession(source)).rejects.toThrow('filename and Session header versions disagree')
  })

  it.each([1, 2] as const)('repairs a native v%d generation through the remaining official edges', async (version) => {
    root = await mkdtemp(join(tmpdir(), `dsh-codex-session-repair-v${version}-`))
    const source = join(root, `session.v${version}.jsonl`)
    await writeFile(source, lines(version, event()), { mode: 0o600 })
    await expect(repairOpenAICodexSession(source, true)).resolves.toMatchObject({
      sourceVersion: version, targetVersion: 3, repairedEvents: 1, applied: true,
    })
  })

  it('recursively scans the default Session root and repairs only affected latest generations', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-session-repair-tree-'))
    vi.stubEnv('DSH_HOME', root)
    const sessions = join(root, 'sessions')
    const affected = join(sessions, 'workspace', 'affected')
    const unaffected = join(sessions, 'workspace', 'unaffected')
    const current = join(sessions, 'other', 'current')
    await Promise.all([
      mkdir(affected, { recursive: true }),
      mkdir(unaffected, { recursive: true }),
      mkdir(current, { recursive: true }),
    ])
    await writeFile(join(affected, 'session.jsonl'), 'superseded and intentionally unreadable\n', { mode: 0o600 })
    await writeFile(join(affected, 'session.v1.jsonl'), lines(1, event()), { mode: 0o600 })
    await writeFile(join(unaffected, 'session.jsonl'), lines(0, {
      type: 'feedback/record', seq: 0, time: 1, data: { text: 'ordinary' },
    }), { mode: 0o600 })
    await writeFile(join(current, 'session.v3.jsonl'), 'already current and intentionally unreadable\n', { mode: 0o600 })

    const preview = await repairOpenAICodexSessions()
    expect(preview).toMatchObject({
      root: sessions,
      mode: 'directory',
      applied: false,
      scannedSessions: 3,
      currentSessions: 1,
      unaffectedSessions: 1,
      matchedSessions: 1,
      repairedEvents: 1,
      failures: [],
    })
    expect(preview.results).toHaveLength(1)
    expect(preview.results[0]?.source).toBe(join(affected, 'session.v1.jsonl'))

    const applied = await repairOpenAICodexSessions(undefined, true)
    expect(applied).toMatchObject({ applied: true, matchedSessions: 1, repairedEvents: 1, failures: [] })
    await expect(stat(join(affected, 'session.v3.jsonl'))).resolves.toMatchObject({ nlink: 1 })
    await expect(stat(join(unaffected, 'session.v3.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats an absent default Session root as an empty batch', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-session-repair-empty-'))
    vi.stubEnv('DSH_HOME', root)
    await expect(repairOpenAICodexSessions()).resolves.toMatchObject({
      root: join(root, 'sessions'),
      mode: 'directory',
      scannedSessions: 0,
      matchedSessions: 0,
      repairedEvents: 0,
      failures: [],
    })
  })

  it('reports ambiguous and invalid Sessions without blocking valid batch repairs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-session-repair-mixed-'))
    const valid = join(root, 'valid')
    const ambiguous = join(root, 'ambiguous')
    const invalid = join(root, 'invalid')
    await Promise.all([
      mkdir(valid, { recursive: true }),
      mkdir(ambiguous, { recursive: true }),
      mkdir(invalid, { recursive: true }),
    ])
    await writeFile(join(valid, 'session.jsonl'), lines(0, event()), { mode: 0o600 })
    await writeFile(join(ambiguous, 'session.jsonl'), lines(0, event()), { mode: 0o600 })
    await writeFile(join(ambiguous, 'session.jsonl.zstd'), zstdCompressSync(lines(0, event())), { mode: 0o600 })
    await writeFile(join(invalid, 'session.jsonl'), lines(0, event({
      data: { ...(event().data as object), unexpected: true },
    })), { mode: 0o600 })

    const result = await repairOpenAICodexSessions(root, true)
    expect(result).toMatchObject({
      scannedSessions: 3,
      currentSessions: 0,
      unaffectedSessions: 0,
      matchedSessions: 1,
      repairedEvents: 1,
    })
    expect(result.failures).toHaveLength(2)
    expect(result.failures.map(failure => failure.error).join('\n')).toContain('multiple v0 generations')
    expect(result.failures.map(failure => failure.error).join('\n')).toContain('unexpected field')
    await expect(stat(join(valid, 'session.v3.jsonl'))).resolves.toBeDefined()
  })
})
