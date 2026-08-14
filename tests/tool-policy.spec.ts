import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { ImageToolPolicy } from '../src/tool-policy.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private stored: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored = { ...this.stored, [String(ns)]: structuredClone(section) }
    this.publish(this.stored)
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('ImageToolPolicy', () => {
  it('persists independent live toggles through the dsh settings seam', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(MemorySettings)
    const policy = new ImageToolPolicy()
    policy.attach(ctx)

    expect(policy.snapshot()).toEqual({
      shareViewImageWithOtherModels: true,
      shareImagegenWithOtherModels: true,
    })

    await policy.update({ shareImagegenWithOtherModels: false })

    expect(policy.snapshot()).toEqual({
      shareViewImageWithOtherModels: true,
      shareImagegenWithOtherModels: false,
    })
  })

  it('keeps Codex access while applying each toggle to another provider', () => {
    const policy = new ImageToolPolicy({
      shareViewImageWithOtherModels: false,
      shareImagegenWithOtherModels: false,
    })
    const execution = (provider: string) => ({
      agent: {
        options: {},
        session: { requestHeader: () => ({ config: { provider, model: 'vision-model' } }) },
      },
    }) as never

    expect(() => policy.assertAllowed(execution('openai-codex'), 'view_image')).not.toThrow()
    expect(() => policy.assertAllowed(execution('openai-codex'), 'imagegen')).not.toThrow()
    expect(() => policy.assertAllowed(execution('another-provider'), 'view_image')).toThrow('disabled for models outside')
    expect(() => policy.assertAllowed(execution('another-provider'), 'imagegen')).toThrow('disabled for models outside')
  })
})
