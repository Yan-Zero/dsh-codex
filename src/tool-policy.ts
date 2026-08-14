import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { OPENAI_CODEX_PROVIDER } from './store.ts'

/** User-controlled access for image tools when the active model is not Codex. */
export interface ImageToolPreferences {
  shareViewImageWithOtherModels: boolean
  shareImagegenWithOtherModels: boolean
}

/** Defaults keep generic vision-model interoperability enabled. */
export const DEFAULT_IMAGE_TOOL_PREFERENCES: ImageToolPreferences = {
  shareViewImageWithOtherModels: true,
  shareImagegenWithOtherModels: true,
}

const NAMESPACE = settingsNamespace('openai-codex')
const schema: z<ImageToolPreferences> = z.object({
  shareViewImageWithOtherModels: z.boolean().default(true),
  shareImagegenWithOtherModels: z.boolean().default(true),
})

/** Live policy shared by the host tools and the settings HTTP surface. */
export class ImageToolPolicy {
  private current: ImageToolPreferences
  private scope: SettingsScope<ImageToolPreferences> | undefined

  constructor(base: Partial<ImageToolPreferences> = {}) {
    this.current = { ...DEFAULT_IMAGE_TOOL_PREFERENCES, ...base }
  }

  /** Register durable live settings when the active profile supplies ctx.settings. */
  attach(ctx: Context): void {
    const scope = ctx.settings.register(NAMESPACE, schema, { base: this.current, applies: 'live' })
    this.scope = scope
    this.current = scope.get()
    const unwatch = scope.watch(next => { this.current = next })
    ctx.effect(() => () => {
      unwatch()
      if (this.scope === scope) this.scope = undefined
    }, 'dsh-openai-codex: image tool preferences')
  }

  /** Return a detached settings projection for the browser. */
  snapshot(): ImageToolPreferences {
    return { ...this.current }
  }

  /** Persist a partial browser update through the settings service. */
  async update(patch: Partial<ImageToolPreferences>): Promise<ImageToolPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update(patch)
    this.current = this.scope.get()
    return this.snapshot()
  }

  /** Enforce one tool's cross-provider toggle at execution time. */
  assertAllowed(exec: ToolExecution, tool: 'view_image' | 'imagegen'): void {
    const configured = exec.agent?.session.requestHeader()?.config
    const provider = configured?.provider ?? exec.agent?.options.provider
    if (provider === OPENAI_CODEX_PROVIDER) return
    const allowed = tool === 'view_image'
      ? this.current.shareViewImageWithOtherModels
      : this.current.shareImagegenWithOtherModels
    if (!allowed) {
      throw new Error(`${tool} is disabled for models outside the openai-codex provider in Settings`)
    }
  }
}
