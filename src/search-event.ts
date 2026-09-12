/** Read compatibility for the retired plugin-owned Session event. */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/**
 * Retired Session event that earlier releases appended before each standalone
 * search dispatch.
 *
 * New records go to the plugin-owned JSONL record (`appendOpenAICodexSearchRequest`
 * in `./search-request-store.ts`) instead. The name and the registration below
 * stay only so Sessions written by those earlier releases remain readable: the
 * Session vocabulary is generated from the Harness repository, so without this
 * registration a cold read of such a Session refuses the whole log. Both can be
 * removed once no Session written by those releases can still be loaded.
 */
export const OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT = 'web/openai-codex-search-llm-request'

/**
 * Add the retired event to the running Harness vocabulary for reads. The public
 * DSH build exports its known-event collection as read-only because core code
 * must not mutate it accidentally; the runtime value is the Set deliberately
 * consulted on every persistence read. Registration remains for the process
 * lifetime so Sessions written before an HMR cycle stay readable.
 */
export function installOpenAICodexSearchEvent(): void {
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('dsh-openai-codex: this Harness build does not expose an extensible session event vocabulary')
  }
  KNOWN_SESSION_EVENT_TYPES.add(OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT)
}
