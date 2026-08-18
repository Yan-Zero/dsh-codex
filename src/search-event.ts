/** Durable request event owned by the OpenAI Codex search provider. */

import type { OpenAICodexSearchRequestRecord } from './search.ts'
import type {} from '@deepseek-ai/dsh-session/types'

/** Dedicated log event written before an OpenAI Codex search dispatch. */
export const OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT = 'web/openai-codex-search-llm-request'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact secret-free OpenAI Codex standalone-search request. */
    'web/openai-codex-search-llm-request': OpenAICodexSearchRequestRecord
  }
}
