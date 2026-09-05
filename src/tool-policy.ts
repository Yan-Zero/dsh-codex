import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_PROXY_PREFERENCES, normalizeProxyUrl } from './proxy.ts'
import type { ProxyPreferences } from './proxy.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'

/** User-controlled image-tool integration. */
export interface ImageToolPreferences {
  modifyReadImage: boolean
  shareImagegenWithOtherModels: boolean
}

/** Experimental request behavior used only by the OpenAI Codex adapter. */
export const OPENAI_CODEX_REASONING_SUMMARIES = ['auto', 'concise', 'detailed'] as const
export type OpenAICodexReasoningSummary = (typeof OPENAI_CODEX_REASONING_SUMMARIES)[number]

export interface ResponseApiPreferences {
  reasoningSummary: OpenAICodexReasoningSummary
  useWebSocketContextReuse: boolean
  useNativeCompaction: boolean
}

/** Browser presentation preferences shared by UI controls and /codex commands. */
export interface UsageUiPreferences {
  showUsageHud: boolean
  pinUsageHud: boolean
}

/** Client-side capacity override applied to OpenAI Codex models. */
export interface ContextWindowPreferences {
  /** Tokens advertised to dsh, or null to keep each provider catalog default. */
  contextWindow: number | null
  /** Whether the global override also applies to GPT-5.3 Codex Spark. */
  overrideSparkContextWindow: boolean
}

/** One selectable model from the complete provider catalog. */
export interface ModelCatalogEntry {
  id: string
  name: string
  contextWindow: number
}

/** Live subset advertised through dsh model discovery. */
export interface ModelCatalogPreferences {
  models: string[]
}

/** Fast Mode behavior applied to every Codex session. */
export interface FastModePreferences {
  /** Force the priority service tier on all sessions without the per-session toggle. */
  fastModeDefault: boolean
}

/** Browser projection containing both available and currently visible models. */
export interface ModelCatalogSettings extends ModelCatalogPreferences {
  availableModels: ModelCatalogEntry[]
}

interface OpenAICodexPreferences
  extends ImageToolPreferences,
    ResponseApiPreferences,
    UsageUiPreferences,
    ModelCatalogPreferences,
    ContextWindowPreferences,
    FastModePreferences,
    ProxyPreferences {
  /** Migration-only key written by the unreleased store:true experiment. */
  useStatefulResponses: boolean
}

/** Defaults keep generic vision-model interoperability enabled. */
export const DEFAULT_IMAGE_TOOL_PREFERENCES: ImageToolPreferences = {
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
}

/** Conservative defaults preserve the established stateless Harness behavior. */
export const DEFAULT_RESPONSE_API_PREFERENCES: ResponseApiPreferences = {
  reasoningSummary: 'auto',
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
}

export const DEFAULT_USAGE_UI_PREFERENCES: UsageUiPreferences = {
  showUsageHud: true,
  pinUsageHud: false,
}
/** Keep provider-declared capacities until the owner opts into an override. */
export const DEFAULT_CONTEXT_WINDOW_PREFERENCES: ContextWindowPreferences = {
  contextWindow: null,
  overrideSparkContextWindow: false,
}

/** Keep Fast Mode a per-session opt-in until the owner forces it globally. */
export const DEFAULT_FAST_MODE_PREFERENCES: FastModePreferences = {
  fastModeDefault: false,
}

const NAMESPACE = 'openai-codex' as SettingsNamespace

function preferenceSchema(defaultModels: readonly string[]): z<OpenAICodexPreferences> {
  return z.object({
    modifyReadImage: z.boolean().default(true),
    shareImagegenWithOtherModels: z.boolean().default(true),
    reasoningSummary: z.union(OPENAI_CODEX_REASONING_SUMMARIES).default('auto'),
    useWebSocketContextReuse: z.boolean().default(false),
    useStatefulResponses: z.boolean().default(false),
    useNativeCompaction: z.boolean().default(false),
    showUsageHud: z.boolean().default(true),
    pinUsageHud: z.boolean().default(false),
    contextWindow: z
      .union([z.const(null), z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)])
      .default(null),
    overrideSparkContextWindow: z.boolean().default(false),
    proxyMode: z.union(['off', 'scoped', 'global'] as const).default('off'),
    proxyUrl: z.string().default(''),
    models: z.array(z.string()).default([...defaultModels]),
    fastModeDefault: z.boolean().default(false),
  })
}

/** Live policy shared by the host tools, Codex adapter, and settings HTTP surface. */
export class ImageToolPolicy {
  private current: OpenAICodexPreferences
  private scope: SettingsScope<OpenAICodexPreferences> | undefined
  private readonly imageWatchers = new Set<() => void>()
  private readonly proxyWatchers = new Set<() => void>()
  private readonly resolveModelCatalog: () => readonly ModelCatalogEntry[]

  private get modelCatalog(): readonly ModelCatalogEntry[] {
    return this.resolveModelCatalog()
  }

  constructor(
    base: Partial<OpenAICodexPreferences> = {},
    modelCatalog: readonly ModelCatalogEntry[] | (() => readonly ModelCatalogEntry[]) = [],
  ) {
    if (typeof modelCatalog === 'function') {
      this.resolveModelCatalog = modelCatalog
    } else {
      const initialCatalog = modelCatalog.map((model) => ({ ...model }))
      this.resolveModelCatalog = () => initialCatalog
    }
    this.current = {
      ...DEFAULT_IMAGE_TOOL_PREFERENCES,
      ...DEFAULT_RESPONSE_API_PREFERENCES,
      ...DEFAULT_USAGE_UI_PREFERENCES,
      ...DEFAULT_CONTEXT_WINDOW_PREFERENCES,
      ...DEFAULT_FAST_MODE_PREFERENCES,
      ...DEFAULT_PROXY_PREFERENCES,
      useStatefulResponses: false,
      ...base,
      models: [...(base.models ?? this.modelCatalog.map((model) => model.id))],
    }
    if (this.current.useStatefulResponses && base.useWebSocketContextReuse === undefined) {
      this.current = { ...this.current, useWebSocketContextReuse: true }
    }
  }

  /** Register durable live settings when the active profile supplies ctx.settings. */
  attach(ctx: Context): void {
    const scope = ctx.settings.register(NAMESPACE, preferenceSchema(this.current.models), {
      base: this.current,
      applies: 'live',
    })
    this.scope = scope
    this.replace(scope.get())
    const unwatch = scope.watch((next) => {
      this.replace(next)
    })
    ctx.effect(
      () => () => {
        unwatch()
        if (this.scope === scope) this.scope = undefined
      },
      'dsh-openai-codex: preferences',
    )
  }

  /** Return a detached settings projection for the browser. */
  snapshot(): ImageToolPreferences {
    return {
      modifyReadImage: this.current.modifyReadImage,
      shareImagegenWithOtherModels: this.current.shareImagegenWithOtherModels,
    }
  }

  /** Observe live changes that add or remove the scoped `read_image` enhancement. */
  watchImagePreferences(listener: () => void): () => void {
    this.imageWatchers.add(listener)
    return () => {
      this.imageWatchers.delete(listener)
    }
  }

  /** Persist a partial browser update through the settings service. */
  async update(patch: Partial<ImageToolPreferences>): Promise<ImageToolPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update(patch)
    this.replace(this.scope.get())
    return this.snapshot()
  }

  /** Return the current Codex-only Responses API experiments. */
  responseApiSnapshot(): ResponseApiPreferences {
    return {
      reasoningSummary: this.current.reasoningSummary,
      useWebSocketContextReuse: this.current.useWebSocketContextReuse,
      useNativeCompaction: this.current.useNativeCompaction,
    }
  }

  /** Persist a partial Responses API experiment update. */
  async updateResponseApi(patch: Partial<ResponseApiPreferences>): Promise<ResponseApiPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update({
      ...patch,
      ...(patch.useWebSocketContextReuse === undefined ? {} : { useStatefulResponses: false }),
    })
    this.replace(this.scope.get())
    return this.responseApiSnapshot()
  }

  usageUiSnapshot(): UsageUiPreferences {
    return { showUsageHud: this.current.showUsageHud, pinUsageHud: this.current.pinUsageHud }
  }

  async updateUsageUi(patch: Partial<UsageUiPreferences>): Promise<UsageUiPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update(patch)
    this.replace(this.scope.get())
    return this.usageUiSnapshot()
  }

  /** Return the live client-side context capacity override. */
  contextWindowSnapshot(): ContextWindowPreferences {
    return {
      contextWindow: this.current.contextWindow,
      overrideSparkContextWindow: this.current.overrideSparkContextWindow,
    }
  }

  /** Persist a context capacity override or restore provider defaults with null. */
  async updateContextWindow(patch: Partial<ContextWindowPreferences>): Promise<ContextWindowPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update(patch)
    this.replace(this.scope.get())
    return this.contextWindowSnapshot()
  }

  /** Return the live Fast Mode default shared by all sessions. */
  fastModeSnapshot(): FastModePreferences {
    return {
      fastModeDefault: this.current.fastModeDefault,
    }
  }

  /** Persist the Fast Mode default toggle. */
  async updateFastMode(patch: Partial<FastModePreferences>): Promise<FastModePreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    await this.scope.update(patch)
    this.replace(this.scope.get())
    return this.fastModeSnapshot()
  }

  /** Return the live provider proxy mode and explicit URL. */
  proxySnapshot(): ProxyPreferences {
    return {
      proxyMode: this.current.proxyMode,
      proxyUrl: this.current.proxyUrl,
    }
  }

  /** Observe proxy changes so the transport can reconcile global mode. */
  watchProxyPreferences(listener: () => void): () => void {
    this.proxyWatchers.add(listener)
    return () => {
      this.proxyWatchers.delete(listener)
    }
  }

  /** Persist a validated proxy mode or URL. */
  async updateProxy(patch: Partial<ProxyPreferences>): Promise<ProxyPreferences> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    const normalized =
      patch.proxyUrl === undefined ? patch : { ...patch, proxyUrl: normalizeProxyUrl(patch.proxyUrl) }
    await this.scope.update(normalized)
    this.replace(this.scope.get())
    return this.proxySnapshot()
  }

  /** Return available models and the live discovery subset for the browser. */
  modelCatalogSnapshot(): ModelCatalogSettings {
    return {
      availableModels: this.modelCatalog.map((model) => ({ ...model })),
      models: this.normalizeModels(this.current.models),
    }
  }

  /** Persist the model subset advertised by this provider. */
  async updateModelCatalog(patch: Partial<ModelCatalogPreferences>): Promise<ModelCatalogSettings> {
    if (this.scope === undefined) throw new Error('OpenAI Codex settings service is unavailable')
    if (patch.models === undefined) return this.modelCatalogSnapshot()
    const availableIds = new Set(this.modelCatalog.map((model) => model.id))
    const unavailableSelections = [...new Set(this.current.models.filter((id) => !availableIds.has(id)))]
    await this.scope.update({
      models: [...this.normalizeModels(patch.models), ...unavailableSelections],
    })
    this.replace(this.scope.get())
    return this.modelCatalogSnapshot()
  }

  /** Enforce imagegen's cross-provider toggle at execution time. */
  assertAllowed(exec: ToolExecution, tool: 'imagegen'): void {
    const configured = exec.agent?.session.requestHeader()?.config
    const provider = configured?.provider ?? exec.agent?.options.provider
    if (provider === OPENAI_CODEX_PROVIDER) return
    if (!this.current.shareImagegenWithOtherModels) {
      throw new Error(`${tool} is disabled for models outside the openai-codex provider in Settings`)
    }
  }

  private replace(next: OpenAICodexPreferences): void {
    next =
      next.useStatefulResponses && !next.useWebSocketContextReuse
        ? { ...next, useWebSocketContextReuse: true }
        : next
    // Keep saved ids if the optional Codex cache is temporarily unavailable.
    // Discovery filters against the current catalog without deleting preferences.
    next = { ...next, models: [...next.models] }
    const imageChanged =
      next.modifyReadImage !== this.current.modifyReadImage ||
      next.shareImagegenWithOtherModels !== this.current.shareImagegenWithOtherModels
    const proxyChanged = next.proxyMode !== this.current.proxyMode || next.proxyUrl !== this.current.proxyUrl
    this.current = next
    if (imageChanged) {
      for (const listener of this.imageWatchers) listener()
    }
    if (proxyChanged) {
      for (const listener of this.proxyWatchers) listener()
    }
  }

  private normalizeModels(models: readonly string[]): string[] {
    const selected = new Set(models)
    return this.modelCatalog.filter((model) => selected.has(model.id)).map((model) => model.id)
  }
}
