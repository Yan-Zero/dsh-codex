/** One-time repair for historical Sessions containing the retired Codex search event. */

import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { historicalSessionFormatCatalog as repairFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT } from './search-event.ts'
import { OPENAI_CODEX_SEARCH_URL } from './search.ts'

const PLACEHOLDER_EVENT = 'feedback/record'
const PLACEHOLDER_PREFIX = 'dsh-codex-repair:'
const ZSTD_MAGIC = 0xFD2FB528
const FRAME_CHUNK_BYTES = 1024 * 1024
const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)

type JsonRecord = Record<string, unknown>
type Artifact = ReturnType<ReturnType<typeof repairFormatCatalog.createRestore>['finish']>

export interface SessionRepairResult {
  readonly source: string
  readonly target: string
  readonly sourceVersion: number
  readonly targetVersion: number
  readonly sessionId: string
  readonly repairedEvents: number
  readonly applied: boolean
}

export interface SessionRepairFailure {
  readonly source: string
  readonly error: string
}

export interface SessionRepairBatchResult {
  readonly root: string
  readonly mode: 'file' | 'directory'
  readonly applied: boolean
  readonly scannedSessions: number
  readonly currentSessions: number
  readonly unaffectedSessions: number
  readonly matchedSessions: number
  readonly repairedEvents: number
  readonly results: readonly SessionRepairResult[]
  readonly failures: readonly SessionRepairFailure[]
}

interface Generation {
  readonly version: number
  readonly compression: 'none' | 'zstd'
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

class SessionRepairNotNeededError extends Error {}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`repair-session: ${label} must be an object`)
  }
  return value as JsonRecord
}

function exact(value: JsonRecord, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const missing = keys.find(key => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new Error(`repair-session: ${label} lacks ${missing}`)
  const unexpected = Object.keys(value).find(key => !allowed.has(key))
  if (unexpected !== undefined) throw new Error(`repair-session: ${label} has unexpected field ${unexpected}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`repair-session: ${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`repair-session: ${label} must be a positive integer`)
}

/** Prove that one retired payload is the exact reference-free Codex request schema. */
function validateCodexSearchData(value: unknown): JsonRecord {
  const data = record(value, 'Codex search event data')
  exact(data, ['endpoint', 'body'], 'Codex search event data')
  if (data.endpoint !== OPENAI_CODEX_SEARCH_URL) throw new Error('repair-session: Codex search event has an unexpected endpoint')
  const body = record(data.body, 'Codex search body')
  exact(body, ['id', 'model', 'input', 'commands', 'settings', 'max_output_tokens'], 'Codex search body')
  text(body.id, 'Codex search body id')
  text(body.model, 'Codex search body model')
  positiveInteger(body.max_output_tokens, 'Codex search max_output_tokens')

  if (!Array.isArray(body.input) || body.input.length !== 1) throw new Error('repair-session: Codex search input must have one message')
  const message = record(body.input[0], 'Codex search input message')
  exact(message, ['type', 'role', 'content'], 'Codex search input message')
  if (message.type !== 'message' || message.role !== 'user') throw new Error('repair-session: Codex search input message is invalid')
  if (!Array.isArray(message.content) || message.content.length !== 1) throw new Error('repair-session: Codex search input must have one text block')
  const content = record(message.content[0], 'Codex search input content')
  exact(content, ['type', 'text'], 'Codex search input content')
  if (content.type !== 'input_text') throw new Error('repair-session: Codex search input content is invalid')
  text(content.text, 'Codex search input text')

  const commands = record(body.commands, 'Codex search commands')
  exact(commands, ['search_query'], 'Codex search commands')
  if (!Array.isArray(commands.search_query) || commands.search_query.length !== 1) throw new Error('repair-session: Codex search commands must have one query')
  const query = record(commands.search_query[0], 'Codex search query')
  exact(query, ['q'], 'Codex search query')
  text(query.q, 'Codex search query text')

  const settings = record(body.settings, 'Codex search settings')
  exact(settings, ['search_context_size', 'allowed_callers', 'external_web_access'], 'Codex search settings')
  if (!['low', 'medium', 'high'].includes(String(settings.search_context_size))) throw new Error('repair-session: Codex search context size is invalid')
  if (!Array.isArray(settings.allowed_callers) || settings.allowed_callers.length !== 1 || settings.allowed_callers[0] !== 'direct') {
    throw new Error('repair-session: Codex search allowed_callers is invalid')
  }
  if (settings.external_web_access !== false && settings.external_web_access !== true && settings.external_web_access !== 'indexed') {
    throw new Error('repair-session: Codex search external_web_access is invalid')
  }
  return data
}

function generation(filename: string): Generation {
  const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/u.exec(filename)
  if (match === null) throw new Error('repair-session: expected a canonical session[.vN].jsonl[.zstd] generation path')
  return { version: match[1] === undefined ? 0 : Number(match[1]), compression: match[2] === undefined ? 'none' : 'zstd' }
}

/** Parse DSH 0.1.5's concatenated-frame container; its physical scanner is not a public package export. */
function frames(buffer: Buffer): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`repair-session: corrupt or incomplete Zstandard frame at byte ${start}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) throw new Error(`repair-session: invalid Zstandard frame descriptor at byte ${offset - 1}`)
    const sizeFlag = descriptor >>> 6
    const single = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag
    const headerBytes = (single ? 0 : 1) + dictionaryBytes + sizeBytes
    if (buffer.length - offset < headerBytes) throw new Error(`repair-session: incomplete Zstandard frame header at byte ${start}`)
    offset += headerBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`repair-session: incomplete Zstandard block at byte ${start}`)
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (header & 1) !== 0
      const type = (header >>> 1) & 0x03
      if (type === 3) throw new Error(`repair-session: reserved Zstandard block type at byte ${offset - 3}`)
      const size = header >>> 3
      const payload = type === 1 ? 1 : size
      if (buffer.length - offset < payload) throw new Error(`repair-session: incomplete Zstandard block payload at byte ${start}`)
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`repair-session: incomplete Zstandard checksum at byte ${start}`)
      offset += 4
    }
    result.push({ start, end: offset })
  }
  return result
}

async function plaintext(source: Buffer, compression: Generation['compression']): Promise<string> {
  if (compression === 'none') return new TextDecoder('utf-8', { fatal: true }).decode(source)
  const chunks: Buffer[] = []
  for (const frame of frames(source)) chunks.push(await decompress(source.subarray(frame.start, frame.end)) as Buffer)
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

function parseLine(line: string, label: string): JsonRecord {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error(`repair-session: ${label} is not valid JSON`) }
  return record(value, label)
}

function migrate(lines: readonly string[], sourceVersion: number): { artifact: Artifact; repaired: number } {
  if (lines.length < 2) throw new Error('repair-session: Session generation has no event rows')
  const header = parseLine(lines[0]!, 'Session header')
  if (header.version !== sourceVersion) throw new Error('repair-session: filename and Session header versions disagree')
  const restore = repairFormatCatalog.createRestore(header, {
    recovery: 'strict', validation: 'transformed',
  })
  const token = `${PLACEHOLDER_PREFIX}${randomUUID()}:`
  const originals = new Map<string, JsonRecord>()
  for (let index = 1; index < lines.length; index += 1) {
    const row = parseLine(lines[index]!, `Session row ${index}`)
    if (row.type !== OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT) {
      restore.decodeRow(row)
      continue
    }
    const marker = `${token}${originals.size}`
    originals.set(marker, validateCodexSearchData(row.data))
    restore.decodeRow({ ...row, type: PLACEHOLDER_EVENT, data: { text: marker } })
  }
  if (originals.size === 0) throw new SessionRepairNotNeededError('repair-session: generation contains no retired Codex search events')
  const migrated = restore.finish()
  if (migrated.header.version !== repairFormatCatalog.currentVersion || sourceVersion >= migrated.header.version) {
    throw new Error('repair-session: source is not an older supported Session generation')
  }
  const recovered = new Set<string>()
  const events = migrated.events.map(event => {
    if (event.type !== PLACEHOLDER_EVENT) return event
    const value = record(event.data, 'migrated placeholder data').text
    if (typeof value !== 'string') return event
    const data = originals.get(value)
    if (data === undefined) return event
    recovered.add(value)
    return { ...event, type: OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT, data, ignorable: true as const }
  })
  if (recovered.size !== originals.size) throw new Error('repair-session: migration did not preserve every repair placeholder')
  const artifact = { ...migrated, events } as Artifact
  validateCurrent(artifact)
  return { artifact, repaired: originals.size }
}

function validateCurrent(artifact: Artifact): void {
  const restore = repairFormatCatalog.createRestore(
    repairFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount),
    { recovery: 'strict', validation: 'current' },
  )
  for (const event of artifact.events) restore.decodeRow(repairFormatCatalog.encodeCurrentEvent(event))
  restore.finish()
}

async function validatePhysical(path: string, compression: Generation['compression'], expected: Artifact): Promise<void> {
  const decoded = await plaintext(await readFile(path), compression)
  if (!decoded.endsWith('\n')) throw new Error('repair-session: staged generation ends inside a JSONL row')
  const lines = decoded.slice(0, -1).split(/\r?\n/u)
  const restore = repairFormatCatalog.createRestore(parseLine(lines[0]!, 'staged Session header'), {
    recovery: 'strict', validation: 'current',
  })
  for (let index = 1; index < lines.length; index += 1) {
    restore.decodeRow(parseLine(lines[index]!, `staged Session row ${index}`))
  }
  const actual = restore.finish()
  if (actual.header.id !== expected.header.id || actual.events.length !== expected.events.length) {
    throw new Error('repair-session: staged generation verification disagrees with the migration result')
  }
}

function identity(value: Awaited<ReturnType<typeof stat>>): FileIdentity {
  return {
    dev: Number(value.dev), ino: Number(value.ino), size: Number(value.size),
    mtimeMs: Number(value.mtimeMs), ctimeMs: Number(value.ctimeMs),
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function encodeFrame(value: string): Promise<Buffer> {
  return await compress(Buffer.from(value), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  }) as Buffer
}

async function writeData(
  handle: Awaited<ReturnType<typeof open>>,
  value: string,
  compression: Generation['compression'],
): Promise<void> {
  if (compression === 'zstd') await handle.write(await encodeFrame(value))
  else await handle.write(value)
}

async function writeArtifact(
  path: string,
  artifact: Artifact,
  compression: Generation['compression'],
  assertSourceStable: () => Promise<void>,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    const header = `${JSON.stringify(repairFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount))}\n`
    await writeData(handle, header, compression)
    let chunk = ''
    let chunkBytes = 0
    for (const event of artifact.events) {
      const line = `${JSON.stringify(repairFormatCatalog.encodeCurrentEvent(event))}\n`
      const lineBytes = Buffer.byteLength(line)
      if (chunk.length > 0 && chunkBytes + lineBytes > FRAME_CHUNK_BYTES) {
        await writeData(handle, chunk, compression)
        chunk = ''
        chunkBytes = 0
      }
      chunk += line
      chunkBytes += lineBytes
    }
    if (chunk.length > 0) await writeData(handle, chunk, compression)
    await handle.sync()
    await handle.close()
    handle = undefined
    await validatePhysical(temporary, compression, artifact)
    await assertSourceStable()
    try { await link(temporary, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`repair-session: target already exists: ${path}`)
      throw error
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * Inspect or explicitly publish a repaired current Session generation.
 * @param sourcePath - exact canonical v0, v1, or v2 generation path.
 * @param apply - whether to publish; omission performs a dry run.
 * @returns the inspected source, proposed target, and repaired-event count.
 */
export async function repairOpenAICodexSession(
  sourcePath: string,
  apply = false,
): Promise<SessionRepairResult> {
  const source = resolve(sourcePath)
  const selected = generation(basename(source))
  if (selected.version >= repairFormatCatalog.currentVersion) {
    throw new Error(`repair-session: source v${selected.version} is not older than repair target v${repairFormatCatalog.currentVersion}`)
  }
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) throw new Error('repair-session: source must be a single-link regular file')
  if (process.platform !== 'win32' && (sourceInfo.mode & 0o077) !== 0) throw new Error('repair-session: source must be owner-only (chmod 600)')
  const before = identity(await stat(source))
  const target = join(dirname(source), `session.v${repairFormatCatalog.currentVersion}.jsonl${selected.compression === 'zstd' ? '.zstd' : ''}`)
  const alternate = join(dirname(source), `session.v${repairFormatCatalog.currentVersion}.jsonl${selected.compression === 'zstd' ? '' : '.zstd'}`)
  if (await exists(target) || await exists(alternate)) throw new Error('repair-session: a current Session generation already exists')
  const sourceBytes = await readFile(source)
  const decoded = await plaintext(sourceBytes, selected.compression)
  if (!decoded.endsWith('\n')) throw new Error('repair-session: Session generation does not end at a complete JSONL row')
  const lines = decoded.slice(0, -1).split(/\r?\n/u)
  const { artifact, repaired } = migrate(lines, selected.version)
  const after = identity(await stat(source))
  if (!sameIdentity(before, after)) throw new Error('repair-session: source generation changed while it was being inspected')
  if (apply) {
    await writeArtifact(target, artifact, selected.compression, async () => {
      if (!sameIdentity(before, identity(await stat(source)))) {
        throw new Error('repair-session: source generation changed before publication')
      }
    })
  }
  return {
    source, target, sourceVersion: selected.version,
    targetVersion: repairFormatCatalog.currentVersion,
    sessionId: String(artifact.header.id), repairedEvents: repaired, applied: apply,
  }
}

interface DiscoveredGeneration extends Generation {
  readonly path: string
}

interface DiscoveryResult {
  readonly scannedSessions: number
  readonly currentSessions: number
  readonly sources: readonly string[]
  readonly failures: readonly SessionRepairFailure[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Recursively discover one authoritative historical generation per Session directory. */
async function discoverGenerations(root: string): Promise<DiscoveryResult> {
  const groups = new Map<string, DiscoveredGeneration[]>()
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      let parsed: Generation
      try { parsed = generation(entry.name) } catch { continue }
      const values = groups.get(directory) ?? []
      values.push({ ...parsed, path })
      groups.set(directory, values)
    }
  }
  await visit(root)

  const sources: string[] = []
  const failures: SessionRepairFailure[] = []
  let currentSessions = 0
  for (const [directory, values] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (values.some(value => value.version >= repairFormatCatalog.currentVersion)) {
      currentSessions += 1
      continue
    }
    const latest = Math.max(...values.map(value => value.version))
    const selected = values.filter(value => value.version === latest)
    if (selected.length !== 1) {
      failures.push({
        source: directory,
        error: `repair-session: Session has multiple v${latest} generations; select one file explicitly`,
      })
      continue
    }
    sources.push(selected[0]!.path)
  }
  return { scannedSessions: groups.size, currentSessions, sources, failures }
}

/**
 * Preview or apply repairs for one file, a directory tree, or the default
 * `$DSH_HOME/sessions` tree. Directory mode chooses the newest historical
 * generation in each Session directory and never follows symlinked directories.
 */
export async function repairOpenAICodexSessions(
  inputPath?: string,
  apply = false,
): Promise<SessionRepairBatchResult> {
  const defaultRoot = inputPath === undefined
  const root = resolve(inputPath ?? join(resolveDshHome(), 'sessions'))
  let rootInfo: Awaited<ReturnType<typeof lstat>>
  try { rootInfo = await lstat(root) } catch (error) {
    if (defaultRoot && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        root, mode: 'directory', applied: apply, scannedSessions: 0, currentSessions: 0,
        unaffectedSessions: 0, matchedSessions: 0, repairedEvents: 0, results: [], failures: [],
      }
    }
    throw error
  }
  if (rootInfo.isFile()) {
    const result = await repairOpenAICodexSession(root, apply)
    return {
      root, mode: 'file', applied: apply, scannedSessions: 1, currentSessions: 0,
      unaffectedSessions: 0, matchedSessions: 1, repairedEvents: result.repairedEvents,
      results: [result], failures: [],
    }
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('repair-session: input must be a regular generation file or a non-symlink directory')
  }

  const discovered = await discoverGenerations(root)
  const failures = [...discovered.failures]
  const previews: SessionRepairResult[] = []
  let unaffectedSessions = 0
  for (const source of discovered.sources) {
    try {
      previews.push(await repairOpenAICodexSession(source, false))
    } catch (error) {
      if (error instanceof SessionRepairNotNeededError) unaffectedSessions += 1
      else failures.push({ source, error: errorMessage(error) })
    }
  }

  const results: SessionRepairResult[] = []
  if (!apply) results.push(...previews)
  else {
    for (const preview of previews) {
      try { results.push(await repairOpenAICodexSession(preview.source, true)) } catch (error) {
        failures.push({ source: preview.source, error: errorMessage(error) })
      }
    }
  }
  return {
    root,
    mode: 'directory',
    applied: apply,
    scannedSessions: discovered.scannedSessions,
    currentSessions: discovered.currentSessions,
    unaffectedSessions,
    matchedSessions: previews.length,
    repairedEvents: results.reduce((total, result) => total + result.repairedEvents, 0),
    results,
    failures,
  }
}
