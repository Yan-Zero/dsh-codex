/** Same-generation read compatibility for the retired Codex search Session event. */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { OpenAICodexSearchRequestRecord } from './search.ts'

/** Retired log event written by dsh-codex versions before 0.3.0. */
export const OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT = 'web/openai-codex-search-llm-request'

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
 * consulted by current-format reads. Historical formats require the explicit
 * `repair-session` command because their build-static migration runs first.
 */
export function installOpenAICodexSearchEvent(): void {
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('dsh-openai-codex: this Harness build does not expose an extensible session event vocabulary')
  }
  KNOWN_SESSION_EVENT_TYPES.add(OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT)
}
