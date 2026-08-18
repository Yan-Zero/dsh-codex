import { OPENAI_CODEX_PROVIDER } from './store.ts'

/** User-controlled image-tool integration. */
export interface ImageToolPreferences {
  modifyReadImage: boolean
  shareImagegenWithOtherModels: boolean
}

/** Experimental request behavior used only by the OpenAI Codex adapter. */
export interface ResponseApiPreferences {
  useWebSocketContextReuse: boolean
  useNativeCompaction: boolean
}

export interface OpenAICodexPreferences extends ImageToolPreferences, ResponseApiPreferences {
  /** Migration-only key written by the unreleased store:true experiment. */
  useStatefulResponses: boolean
}

/** Defaults keep generic vision-model interoperability enabled. */
export const DEFAULT_IMAGE_TOOL_PREFERENCES: ImageToolPreferences = Object.freeze({
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
})

/** Conservative defaults preserve the established stateless behavior. */
export const DEFAULT_RESPONSE_API_PREFERENCES: ResponseApiPreferences = Object.freeze({
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
})

/** Live policy shared by the standard tools and Codex model handler. */
export class ImageToolPolicy {
  private current: OpenAICodexPreferences
  private readonly imageWatchers = new Set<() => void>()

  constructor(base: Partial<OpenAICodexPreferences> = {}) {
    this.current = {
      ...DEFAULT_IMAGE_TOOL_PREFERENCES,
      ...DEFAULT_RESPONSE_API_PREFERENCES,
      useStatefulResponses: false,
      ...base,
    }
    if (this.current.useStatefulResponses && base.useWebSocketContextReuse === undefined) {
      this.current = { ...this.current, useWebSocketContextReuse: true }
    }
  }

  /** Return a detached image-tool settings projection. */
  snapshot(): ImageToolPreferences {
    return {
      modifyReadImage: this.current.modifyReadImage,
      shareImagegenWithOtherModels: this.current.shareImagegenWithOtherModels,
    }
  }

  /** Observe live changes that add or remove the scoped read_image enhancement. */
  watchImagePreferences(listener: () => void): () => void {
    this.imageWatchers.add(listener)
    return () => { this.imageWatchers.delete(listener) }
  }

  /** Apply a partial image preference update. */
  async update(patch: Partial<ImageToolPreferences>): Promise<ImageToolPreferences> {
    this.replace({ ...this.current, ...patch })
    return this.snapshot()
  }

  /** Return the current Codex-only Responses API experiments. */
  responseApiSnapshot(): ResponseApiPreferences {
    return {
      useWebSocketContextReuse: this.current.useWebSocketContextReuse,
      useNativeCompaction: this.current.useNativeCompaction,
    }
  }

  /** Apply a partial Responses API preference update. */
  async updateResponseApi(patch: Partial<ResponseApiPreferences>): Promise<ResponseApiPreferences> {
    this.replace({
      ...this.current,
      ...patch,
      ...(patch.useWebSocketContextReuse === undefined ? {} : { useStatefulResponses: false }),
    })
    return this.responseApiSnapshot()
  }

  /** Enforce imagegen's cross-provider toggle at execution time. */
  assertAllowed(provider: string | undefined, tool: 'imagegen'): void {
    if (provider === OPENAI_CODEX_PROVIDER) return
    if (!this.current.shareImagegenWithOtherModels) {
      throw new Error(`${tool} is disabled for models outside the openai-codex provider in Settings`)
    }
  }

  private replace(next: OpenAICodexPreferences): void {
    next = next.useStatefulResponses && !next.useWebSocketContextReuse
      ? { ...next, useWebSocketContextReuse: true }
      : next
    const imageChanged = next.modifyReadImage !== this.current.modifyReadImage
      || next.shareImagegenWithOtherModels !== this.current.shareImagegenWithOtherModels
    this.current = next
    if (imageChanged) for (const listener of this.imageWatchers) listener()
  }
}
