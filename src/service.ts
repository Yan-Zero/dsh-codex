/** Shared provider service consumed by standard command, model, and tool handlers. */

import type { AuthInteraction } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
import type { OpenAICodexAuthStatus } from './auth.ts'
import { OpenAICodexCredentialStore } from './store.ts'
import { ImageToolPolicy } from './preferences.ts'
import type { ImageToolPreferences, OpenAICodexPreferences, ResponseApiPreferences } from './preferences.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'

/** Initial settings contributed by the bundle configuration. */
export type OpenAICodexServiceOptions = Partial<OpenAICodexPreferences>

export interface OpenAICodexModelSummary {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/**
 * One provider-owned service shared by the facet's standard handlers.
 * Credentials and live policy stay singletons for one facet activation.
 */
export class OpenAICodexService {
  readonly credentials = new OpenAICodexCredentialStore()
  readonly preferences: ImageToolPolicy

  constructor(options: OpenAICodexServiceOptions = {}) {
    this.preferences = new ImageToolPolicy(options)
  }

  /** Start the provider-native OAuth lifecycle. */
  login(interaction: AuthInteraction): Promise<void> {
    return loginOpenAICodex(interaction, this.credentials)
  }

  /** Remove this plugin's credential without touching Codex CLI/Desktop. */
  logout(): Promise<void> {
    return logoutOpenAICodex(this.credentials)
  }

  /** Read non-secret authentication metadata. */
  authStatus(): Promise<OpenAICodexAuthStatus> {
    return openAICodexAuthStatus(this.credentials)
  }

  /** Enumerate the models contributed by this installed provider. */
  models(): readonly OpenAICodexModelSummary[] {
    return openaiCodexProvider().getModels().map(model => ({
      id: model.id,
      name: model.name,
    }))
  }

  /** Read current subscription limits without issuing a model request. */
  usage(): Promise<OpenAICodexUsage> {
    return readOpenAICodexRateLimits(this.credentials)
  }

  responsePreferences(): ResponseApiPreferences {
    return this.preferences.responseApiSnapshot()
  }

  updateResponsePreferences(patch: Partial<ResponseApiPreferences>): Promise<ResponseApiPreferences> {
    return this.preferences.updateResponseApi(patch)
  }

  imagePreferences(): ImageToolPreferences { return this.preferences.snapshot() }
  updateImagePreferences(patch: Partial<ImageToolPreferences>): Promise<ImageToolPreferences> {
    return this.preferences.update(patch)
  }
}
