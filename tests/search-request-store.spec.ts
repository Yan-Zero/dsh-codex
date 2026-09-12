import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendOpenAICodexSearchRequest,
  openAICodexSearchRequestLogPath,
} from '../src/search-request-store.ts'
import type { OpenAICodexSearchRequestLogEntry } from '../src/search-request-store.ts'

let root: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function isolatedRecordPath(prefix: string): Promise<string> {
  root = await mkdtemp(join(await realpath(tmpdir()), prefix))
  vi.stubEnv('DSH_HOME', root)
  return openAICodexSearchRequestLogPath()
}

function entry(query: string, time: number): OpenAICodexSearchRequestLogEntry {
  return {
    time,
    endpoint: 'https://chatgpt.com/backend-api/codex/alpha/search',
    body: {
      id: 'session-1',
      model: 'gpt-5.6-sol',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: query }],
      }],
      commands: { search_query: [{ q: query }] },
      settings: {
        search_context_size: 'medium',
        allowed_callers: ['direct'],
        external_web_access: false,
      },
      max_output_tokens: 10_000,
    },
  }
}

describe('plugin-owned search request record', () => {
  it('appends one JSON line per resolved request under $DSH_HOME', async () => {
    const filename = await isolatedRecordPath('dsh-codex-record-')

    appendOpenAICodexSearchRequest(entry('first', 1), { filename })
    appendOpenAICodexSearchRequest(entry('second', 2), { filename })

    const lines = (await readFile(filename, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => JSON.parse(line).body.commands.search_query[0].q))
      .toEqual(['first', 'second'])
    expect(JSON.parse(String(lines[0])).time).toBe(1)
  })

  it('rotates one previous generation instead of growing without bound', async () => {
    const filename = await isolatedRecordPath('dsh-codex-record-rotate-')

    appendOpenAICodexSearchRequest(entry('kept', 1), { filename })
    appendOpenAICodexSearchRequest(entry('rotated', 2), { filename, maxBytes: 1 })

    const live = (await readFile(filename, 'utf8')).trim().split('\n')
    const previous = (await readFile(`${filename}.1`, 'utf8')).trim().split('\n')
    expect(live).toHaveLength(1)
    expect(JSON.parse(String(live[0])).body.commands.search_query[0].q).toBe('rotated')
    expect(previous).toHaveLength(1)
    expect(JSON.parse(String(previous[0])).body.commands.search_query[0].q).toBe('kept')
  })

  it('never fails a search because the record could not be written', async () => {
    const filename = await isolatedRecordPath('dsh-codex-record-unwritable-')
    // A regular file where the record's parent directory should be makes the
    // append fail; recording is an audit concern and must stay best-effort.
    await writeFile(filename, 'occupied\n')
    const blocked = join(filename, 'nested', 'record.jsonl')

    expect(() => { appendOpenAICodexSearchRequest(entry('ignored', 1), { filename: blocked }) })
      .not.toThrow()
    expect(await readFile(filename, 'utf8')).toBe('occupied\n')
  })
})
