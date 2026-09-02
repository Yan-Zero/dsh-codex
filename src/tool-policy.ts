import type { Context } from "@deepseek-ai/cordis";
import type {
  SettingsNamespace,
  SettingsScope,
} from "@deepseek-ai/dsh-settings";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { OPENAI_CODEX_PROVIDER } from "./store.ts";

/** User-controlled image-tool integration. */
export interface ImageToolPreferences {
  modifyReadImage: boolean;
  shareImagegenWithOtherModels: boolean;
}

/** Experimental request behavior used only by the OpenAI Codex adapter. */
export interface ResponseApiPreferences {
  useWebSocketContextReuse: boolean;
  useNativeCompaction: boolean;
}

/** Client-side capacity override applied to OpenAI Codex models. */
export interface ContextWindowPreferences {
  /** Tokens advertised to dsh, or null to keep each provider catalog default. */
  contextWindow: number | null;
  /** Whether the global override also applies to GPT-5.3 Codex Spark. */
  overrideSparkContextWindow: boolean;
}

/** One selectable model from the complete provider catalog. */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  contextWindow: number;
}

/** Live subset advertised through dsh model discovery. */
export interface ModelCatalogPreferences {
  models: string[];
}

/** Browser projection containing both available and currently visible models. */
export interface ModelCatalogSettings extends ModelCatalogPreferences {
  availableModels: ModelCatalogEntry[];
}

interface OpenAICodexPreferences
  extends
    ImageToolPreferences,
    ResponseApiPreferences,
    ModelCatalogPreferences,
    ContextWindowPreferences {
  /** Migration-only key written by the unreleased store:true experiment. */
  useStatefulResponses: boolean;
}

/** Defaults keep generic vision-model interoperability enabled. */
export const DEFAULT_IMAGE_TOOL_PREFERENCES: ImageToolPreferences = {
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
};

/** Conservative defaults preserve the established stateless Harness behavior. */
export const DEFAULT_RESPONSE_API_PREFERENCES: ResponseApiPreferences = {
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
};

/** Keep provider-declared capacities until the owner opts into an override. */
export const DEFAULT_CONTEXT_WINDOW_PREFERENCES: ContextWindowPreferences = {
  contextWindow: null,
  overrideSparkContextWindow: false,
};

const NAMESPACE = "openai-codex" as SettingsNamespace;

function preferenceSchema(
  defaultModels: readonly string[]
): z<OpenAICodexPreferences> {
  return z.object({
    modifyReadImage: z.boolean().default(true),
    shareImagegenWithOtherModels: z.boolean().default(true),
    useWebSocketContextReuse: z.boolean().default(false),
    useStatefulResponses: z.boolean().default(false),
    useNativeCompaction: z.boolean().default(false),
    contextWindow: z
      .union([
        z.const(null),
        z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      ])
      .default(null),
    overrideSparkContextWindow: z.boolean().default(false),
    models: z.array(z.string()).default([...defaultModels]),
  });
}

/** Live policy shared by the host tools, Codex adapter, and settings HTTP surface. */
export class ImageToolPolicy {
  private current: OpenAICodexPreferences;
  private scope: SettingsScope<OpenAICodexPreferences> | undefined;
  private readonly imageWatchers = new Set<() => void>();
  private readonly modelCatalog: readonly ModelCatalogEntry[];

  constructor(
    base: Partial<OpenAICodexPreferences> = {},
    modelCatalog: readonly ModelCatalogEntry[] = []
  ) {
    this.modelCatalog = modelCatalog.map((model) => ({ ...model }));
    this.current = {
      ...DEFAULT_IMAGE_TOOL_PREFERENCES,
      ...DEFAULT_RESPONSE_API_PREFERENCES,
      ...DEFAULT_CONTEXT_WINDOW_PREFERENCES,
      useStatefulResponses: false,
      ...base,
      models: this.normalizeModels(
        base.models ?? this.modelCatalog.map((model) => model.id)
      ),
    };
    if (
      this.current.useStatefulResponses &&
      base.useWebSocketContextReuse === undefined
    ) {
      this.current = { ...this.current, useWebSocketContextReuse: true };
    }
  }

  /** Register durable live settings when the active profile supplies ctx.settings. */
  attach(ctx: Context): void {
    const scope = ctx.settings.register(
      NAMESPACE,
      preferenceSchema(this.current.models),
      { base: this.current, applies: "live" }
    );
    this.scope = scope;
    this.replace(scope.get());
    const unwatch = scope.watch((next) => {
      this.replace(next);
    });
    ctx.effect(
      () => () => {
        unwatch();
        if (this.scope === scope) this.scope = undefined;
      },
      "dsh-openai-codex: preferences"
    );
  }

  /** Return a detached settings projection for the browser. */
  snapshot(): ImageToolPreferences {
    return {
      modifyReadImage: this.current.modifyReadImage,
      shareImagegenWithOtherModels: this.current.shareImagegenWithOtherModels,
    };
  }

  /** Observe live changes that add or remove the scoped `read_image` enhancement. */
  watchImagePreferences(listener: () => void): () => void {
    this.imageWatchers.add(listener);
    return () => {
      this.imageWatchers.delete(listener);
    };
  }

  /** Persist a partial browser update through the settings service. */
  async update(
    patch: Partial<ImageToolPreferences>
  ): Promise<ImageToolPreferences> {
    if (this.scope === undefined)
      throw new Error("OpenAI Codex settings service is unavailable");
    await this.scope.update(patch);
    this.replace(this.scope.get());
    return this.snapshot();
  }

  /** Return the current Codex-only Responses API experiments. */
  responseApiSnapshot(): ResponseApiPreferences {
    return {
      useWebSocketContextReuse: this.current.useWebSocketContextReuse,
      useNativeCompaction: this.current.useNativeCompaction,
    };
  }

  /** Persist a partial Responses API experiment update. */
  async updateResponseApi(
    patch: Partial<ResponseApiPreferences>
  ): Promise<ResponseApiPreferences> {
    if (this.scope === undefined)
      throw new Error("OpenAI Codex settings service is unavailable");
    await this.scope.update({
      ...patch,
      ...(patch.useWebSocketContextReuse === undefined
        ? {}
        : { useStatefulResponses: false }),
    });
    this.replace(this.scope.get());
    return this.responseApiSnapshot();
  }

  /** Return the live client-side context capacity override. */
  contextWindowSnapshot(): ContextWindowPreferences {
    return {
      contextWindow: this.current.contextWindow,
      overrideSparkContextWindow: this.current.overrideSparkContextWindow,
    };
  }

  /** Persist a context capacity override or restore provider defaults with null. */
  async updateContextWindow(
    patch: Partial<ContextWindowPreferences>
  ): Promise<ContextWindowPreferences> {
    if (this.scope === undefined)
      throw new Error("OpenAI Codex settings service is unavailable");
    await this.scope.update(patch);
    this.replace(this.scope.get());
    return this.contextWindowSnapshot();
  }

  /** Return available models and the live discovery subset for the browser. */
  modelCatalogSnapshot(): ModelCatalogSettings {
    return {
      availableModels: this.modelCatalog.map((model) => ({ ...model })),
      models: [...this.current.models],
    };
  }

  /** Persist the model subset advertised by this provider. */
  async updateModelCatalog(
    patch: Partial<ModelCatalogPreferences>
  ): Promise<ModelCatalogSettings> {
    if (this.scope === undefined)
      throw new Error("OpenAI Codex settings service is unavailable");
    if (patch.models === undefined) return this.modelCatalogSnapshot();
    await this.scope.update({ models: this.normalizeModels(patch.models) });
    this.replace(this.scope.get());
    return this.modelCatalogSnapshot();
  }

  /** Enforce imagegen's cross-provider toggle at execution time. */
  assertAllowed(exec: ToolExecution, tool: "imagegen"): void {
    const configured = exec.agent?.session.requestHeader()?.config;
    const provider = configured?.provider ?? exec.agent?.options.provider;
    if (provider === OPENAI_CODEX_PROVIDER) return;
    if (!this.current.shareImagegenWithOtherModels) {
      throw new Error(
        `${tool} is disabled for models outside the openai-codex provider in Settings`
      );
    }
  }

  private replace(next: OpenAICodexPreferences): void {
    next =
      next.useStatefulResponses && !next.useWebSocketContextReuse
        ? { ...next, useWebSocketContextReuse: true }
        : next;
    next = { ...next, models: this.normalizeModels(next.models) };
    const imageChanged =
      next.modifyReadImage !== this.current.modifyReadImage ||
      next.shareImagegenWithOtherModels !==
        this.current.shareImagegenWithOtherModels;
    this.current = next;
    if (imageChanged) {
      for (const listener of this.imageWatchers) listener();
    }
  }

  private normalizeModels(models: readonly string[]): string[] {
    const selected = new Set(models);
    return this.modelCatalog
      .filter((model) => selected.has(model.id))
      .map((model) => model.id);
  }
}
