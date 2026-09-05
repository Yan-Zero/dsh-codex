import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { OpenAICodexService } from '../src/service.ts'
import { openAICodexAuthPath } from '../src/store.ts'
import { resolve } from 'node:path'

const preferences = { reasoningSummary: 'auto' as const,
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
  contextWindow: null,
  overrideSparkContextWindow: false,
  fastModeDefault: false,
  proxyMode: 'off' as const,
  proxyUrl: '',
  modelCatalog: [],
}

describe('credentialFile configuration seam', () => {

  it('keeps service-only options out of durable settings descriptors', async () => {
    class MemorySettings extends SettingsProvider {
      readonly writable = true
      protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
      protected persist(): Promise<void> { return Promise.resolve() }
    }
    const ctx = new Context()
    const service = new OpenAICodexService({
      ...preferences,
      credentialFile: resolve('fixture-auth.json'),
      modelCatalog: () => [],
    })
    try {
      await ctx.plugin(MemorySettings)
      service.attachSettings(ctx)
      const descriptors = ctx.settings.describe()
      expect(() => structuredClone(descriptors)).not.toThrow()
      const base = descriptors.find(item => String(item.ns) === 'openai-codex')?.base
      expect(base).toBeDefined()
      expect(base).not.toHaveProperty('modelCatalog')
      expect(base).not.toHaveProperty('credentialFile')
    } finally {
      await service.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('passes the explicit credential filename into the shared service store', () => {
    const filename = resolve('fixture-auth.json')
    const config = new Config({ credentialFile: filename })
    const service = new OpenAICodexService({ ...preferences, credentialFile: filename })
    expect(config.credentialFile).toBe(filename)
    expect(service.credentials.filename).toBe(filename)
  })

  it('retains the DSH_HOME-derived filename when credentialFile is absent', () => {
    const config = new Config()
    const service = new OpenAICodexService(preferences)
    expect(config.credentialFile).toBeUndefined()
    expect(service.credentials.filename).toBe(openAICodexAuthPath())
  })
})
