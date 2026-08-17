/** Durable request event owned by the OpenAI Codex search provider. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { OpenAICodexSearchRequestRecord } from './search.ts'

/** Dedicated log event written before an OpenAI Codex search dispatch. */
export const OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT = 'web/openai-codex-search-llm-request'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact secret-free OpenAI Codex standalone-search request. */
    'web/openai-codex-search-llm-request': OpenAICodexSearchRequestRecord
  }
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
  ctx.get('agents')?.currentInitiator()?.session.append(
    OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
    request,
  )
}
