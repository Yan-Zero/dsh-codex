import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolve } from 'node:path'
import { OpenAICodexService } from '../src/service.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private stored: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected async persist(
    ns: SettingsNamespace,
    section: Record<string, unknown>,
  ): Promise<void> {
    this.stored = { ...this.stored, [String(ns)]: structuredClone(section) }
    this.publish(this.stored)
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** The shape `apply()` really passes: a lazy catalog thunk plus an optional credential file. */
function serviceOptions() {
  return {
    modifyReadImage: true,
    shareImagegenWithOtherModels: true,
    useWebSocketContextReuse: false,
    useNativeCompaction: false,
    contextWindow: null,
    overrideSparkContextWindow: false,
    fastModeDefault: false,
    proxyMode: 'off' as const,
    proxyUrl: '',
    credentialFile: resolve('fixture-auth.json'),
    modelCatalog: () => [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 128_000 }],
  }
}

describe('openai-codex settings composition base', () => {
  it('keeps only lossless JSON in the registered descriptor', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)

    const service = new OpenAICodexService(serviceOptions())
    service.attachSettings(ctx)

    const descriptor = ctx.settings
      .describe()
      .find((entry) => String(entry.ns) === 'openai-codex')
    expect(descriptor).toBeDefined()

    // The descriptor travels to the browser, so every part of it must survive
    // lossless JSON materialization — a live function here fails the whole
    // describe() call, not just this namespace.
    expect(() => structuredClone(descriptor?.value)).not.toThrow()
    if (descriptor?.base !== undefined) {
      expect(() => structuredClone(descriptor.base)).not.toThrow()
    }

    expect(descriptor?.value).toHaveProperty('models')
    expect(descriptor?.value).not.toHaveProperty('modelCatalog')
    expect(descriptor?.value).not.toHaveProperty('credentialFile')
  })
})
