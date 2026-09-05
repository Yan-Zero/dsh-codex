/** Durable request event owned by the OpenAI Codex search provider. */

import type { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type { OpenAICodexSearchRequestRecord } from './search.ts'

/** Dedicated log event written before an OpenAI Codex search dispatch. */
export const OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT = 'web/openai-codex-search-llm-request'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Exact secret-free OpenAI Codex standalone-search request. */
    'web/openai-codex-search-llm-request': OpenAICodexSearchRequestRecord
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact secret-free OpenAI Codex standalone-search request. */
    'web/openai-codex-search-llm-request': OpenAICodexSearchRequestRecord
  }
}

/**
 * Register the plugin-owned event in the running Harness vocabulary. The
 * public DSH build exports its known-event collection as read-only because
 * core code must not mutate it accidentally; the runtime value is the Set
 * deliberately consulted on every persistence read. Registration remains for
 * the process lifetime so sessions written before an HMR cycle stay readable.
 */
export function installOpenAICodexSearchEvent(): void {
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('dsh-openai-codex: this Harness build does not expose an extensible session event vocabulary')
  }
  KNOWN_SESSION_EVENT_TYPES.add(OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT)
}

/**
 * Append one resolved request to the initiating agent's session. Searches
 * outside an agent turn have no owning session and therefore produce no log.
 * @param ctx - plugin context carrying the optional active-agent service.
 * @param request - exact request after defaults, excluding credentials.
 */
export function recordOpenAICodexSearchRequest(
  ctx: Context,
  request: OpenAICodexSearchRequestRecord,
): void {
  (ctx.get('agents')?.currentInitiator()?.session as any)?.append(
    OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
    request,
  )
}
