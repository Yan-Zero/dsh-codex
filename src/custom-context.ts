/** OpenAI Codex custom context rendered through standard Responses input items. */

/** Context trust levels supported by the Codex app-server protocol. */
export type OpenAICodexCustomContextKind = 'application' | 'untrusted'

/** User-controlled custom context injected into each ordinary Codex request. */
export interface OpenAICodexCustomContextPreferences {
  customContext: string
  customContextKind: OpenAICodexCustomContextKind
}

/** Fixed source identifier keeps user text out of the XML-like wrapper name. */
export const OPENAI_CODEX_CUSTOM_CONTEXT_SOURCE = 'dsh_custom_context'

/** Bounded text size for one settings-owned context fragment. */
export const OPENAI_CODEX_CUSTOM_CONTEXT_MAX_CHARS = 4_000

/** Empty context preserves the established request payload. */
export const DEFAULT_OPENAI_CODEX_CUSTOM_CONTEXT: OpenAICodexCustomContextPreferences = {
  customContext: '',
  customContextKind: 'application',
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUntrusted(kind: OpenAICodexCustomContextKind): boolean {
  if (kind === 'untrusted') return true
  if (kind === 'application') return false
  throw new TypeError('OpenAI Codex custom context kind must be application or untrusted')
}

/**
 * Prefix one Codex-compatible context message without using an undocumented
 * top-level Responses field. A stable prefix lets pi-ai's WebSocket transport
 * continue to derive an input delta while unchanged context is active.
 * @param payload - generated Codex Responses request body.
 * @param preferences - current settings-owned context value and trust level.
 * @returns a detached payload when context is enabled, otherwise the original value.
 */
export function applyOpenAICodexCustomContext(
  payload: unknown,
  preferences: OpenAICodexCustomContextPreferences,
): unknown {
  const { customContext, customContextKind } = preferences
  if (customContext.trim().length === 0) return payload
  if (customContext.length > OPENAI_CODEX_CUSTOM_CONTEXT_MAX_CHARS) {
    throw new RangeError(`OpenAI Codex custom context exceeds ${OPENAI_CODEX_CUSTOM_CONTEXT_MAX_CHARS} characters`)
  }
  if (!isRecord(payload) || !Array.isArray(payload['input'])) {
    throw new TypeError('OpenAI Codex generated a Responses payload without an input array')
  }
  const untrusted = isUntrusted(customContextKind)
  const tag = untrusted
    ? `external_${OPENAI_CODEX_CUSTOM_CONTEXT_SOURCE}`
    : OPENAI_CODEX_CUSTOM_CONTEXT_SOURCE
  // Codex app-server leaves fragment values unescaped. The Responses role,
  // not the XML-like provenance hint, is the trust boundary for this content.
  const item = {
    type: 'message',
    role: untrusted ? 'user' : 'developer',
    content: [{
      type: 'input_text',
      text: `<${tag}>${customContext}</${tag}>`,
    }],
  }
  return { ...payload, input: [item, ...payload['input']] }
}
