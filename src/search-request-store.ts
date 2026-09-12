/** Plugin-owned durable record of standalone OpenAI Codex search requests. */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { OpenAICodexSearchRequestRecord } from './search.ts'

/** Plugin-owned append-only record file created under `$DSH_HOME`. */
export const OPENAI_CODEX_SEARCH_REQUEST_LOG_FILENAME = 'openai-codex-search-requests.jsonl'

/** One previous generation is kept beside the live record file. */
export const OPENAI_CODEX_SEARCH_REQUEST_LOG_ROTATED_SUFFIX = '.1'

/** Default rotation threshold, so the record never grows past one bounded file. */
export const OPENAI_CODEX_SEARCH_REQUEST_LOG_MAX_BYTES = 8 * 1024 * 1024

/** One persisted request record. */
export interface OpenAICodexSearchRequestLogEntry extends OpenAICodexSearchRequestRecord {
  /** Epoch milliseconds at which the request was resolved. */
  readonly time: number
}

/** Explicit record location and rotation threshold. */
export interface OpenAICodexSearchRequestLogOptions {
  /** Record file path, defaulting under `$DSH_HOME`. */
  readonly filename?: string
  /** Rotation threshold in bytes, defaulting to {@link OPENAI_CODEX_SEARCH_REQUEST_LOG_MAX_BYTES}. */
  readonly maxBytes?: number
}

/** Absolute path of the plugin-owned search-request record. */
export function openAICodexSearchRequestLogPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_SEARCH_REQUEST_LOG_FILENAME))
}

/**
 * Append one resolved request to the plugin-owned record.
 *
 * The record deliberately lives outside the Session log. A Session's event
 * vocabulary is generated from the Harness repository, so a plugin-owned event
 * type is unknown to every reader without this plugin's runtime registration,
 * and a Session containing one is refused wholesale on a cold read. An
 * audit-only record must not make resume depend on it, so it is written beside
 * the Session instead of into it.
 * @param entry - the resolved, credential-free request plus its timestamp.
 * @param options - optional explicit path and rotation threshold.
 */
export function appendOpenAICodexSearchRequest(
  entry: OpenAICodexSearchRequestLogEntry,
  options: OpenAICodexSearchRequestLogOptions = {},
): void {
  const filename =
    options.filename === undefined
      ? openAICodexSearchRequestLogPath()
      : resolve(options.filename)
  const maxBytes = options.maxBytes ?? OPENAI_CODEX_SEARCH_REQUEST_LOG_MAX_BYTES
  try {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    rotateOversizedLog(filename, maxBytes)
    appendFileSync(filename, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  } catch (error: unknown) {
    // Recording is an audit concern: a search must not fail because its record could not be written.
    process.stderr.write(
      `[dsh-codex] failed to record the standalone search request: ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

/**
 * Move one oversized record aside so the live file stays bounded.
 * @param filename - the live record file.
 * @param maxBytes - rotation threshold; a non-positive value disables rotation.
 */
function rotateOversizedLog(filename: string, maxBytes: number): void {
  if (maxBytes <= 0) return
  let size: number
  try {
    size = statSync(filename).size
  } catch {
    return
  }
  if (size < maxBytes) return
  const previous = `${filename}${OPENAI_CODEX_SEARCH_REQUEST_LOG_ROTATED_SUFFIX}`
  rmSync(previous, { force: true })
  renameSync(filename, previous)
}
