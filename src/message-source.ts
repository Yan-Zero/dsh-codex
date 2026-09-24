import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'openai-codex': { readonly kind: 'openai-codex' }
  }
}

/** Canonical producer identity for context deferred by this plugin's image tools. */
export const OPENAI_CODEX_MESSAGE_SOURCE = Object.freeze({ kind: 'openai-codex' } as const)
