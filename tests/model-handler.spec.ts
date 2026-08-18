import { describe, expect, it } from 'vitest'
import { OpenAICodexModelHandler } from '../src/model-handler.ts'
import { DEFAULT_RESPONSE_API_PREFERENCES } from '../src/preferences.ts'
import { OpenAICodexCredentialStore } from '../src/store.ts'

describe('OpenAI Codex model catalog', () => {
  it('orders the GPT-5.6 tiers from Luna through Terra to Sol', () => {
    const handler = new OpenAICodexModelHandler(
      new OpenAICodexCredentialStore('unused-auth.json'),
      () => DEFAULT_RESPONSE_API_PREFERENCES,
    )

    expect(handler.listModels().map(model => model.id).filter(id => id.startsWith('gpt-5.6-'))).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ])
  })
})
