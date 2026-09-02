/** OpenAI Codex adapter assembled from public dsh-llm-pi-ai extension points. */

import { createModels } from "@earendil-works/pi-ai";
import type {
  AuthContext,
  Context as PiContext,
  MutableModels,
  Provider,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import type {
  GenerateOptions,
  PreparedAdapterCall,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import type {
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestPolicy,
} from "@deepseek-ai/dsh-attachment";
import type { OpenAICodexCredentialStore } from "./store.ts";
import { OPENAI_CODEX_PROVIDER } from "./store.ts";
import { OpenAICodexResponseRuntime } from "./responses.ts";
import type {
  ModelCatalogEntry,
  ResponseApiPreferences,
} from "./tool-policy.ts";
import type { FastModeRegistry } from "./fast-mode.ts";

const GPT_5_3_CODEX_SPARK = "gpt-5.3-codex-spark";

/** Return a detached copy of the complete pi-ai Codex model catalog. */
export function openAICodexModelCatalog(): readonly ModelCatalogEntry[] {
  return openaiCodexProvider()
    .getModels()
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
    }));
}

/** Provider idle ceiling used by the composite route. */
export const OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Patch geometry used by Codex for `auto`/`high` prompt images. */
export const OPENAI_CODEX_IMAGE_PATCH_SIZE = 32;
/** Maximum patch count used by Codex for `auto`/`high` prompt images. */
export const OPENAI_CODEX_HIGH_DETAIL_MAX_PATCHES = 2_500;
/** Maximum width or height accepted by Codex's `auto`/`high` preparation. */
export const OPENAI_CODEX_HIGH_DETAIL_MAX_DIMENSION = 2_048;
/** Closest DSH pixel-budget projection of Codex's 2,500 32x32 patch limit. */
export const OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET =
  OPENAI_CODEX_HIGH_DETAIL_MAX_PATCHES * OPENAI_CODEX_IMAGE_PATCH_SIZE ** 2;
/**
 * Codex's high sanity guard for one prompt-image representation. DSH already
 * validates and normalizes attachments at much smaller ingestion limits, so
 * this deliberately avoids imposing a second lossy byte target on an image.
 */
export const OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES = 1024 * 1024 * 1024;

function projectedImageDimensions(
  width: number,
  height: number,
  maxPixels: number
): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale));
    let projectedHeight = Math.max(
      1,
      Math.round((projectedWidth * height) / width)
    );
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(
        1,
        Math.round((projectedWidth * height) / width)
      );
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale));
  let projectedWidth = Math.max(
    1,
    Math.round((projectedHeight * width) / height)
  );
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(
      1,
      Math.round((projectedHeight * width) / height)
    );
  }
  return { width: projectedWidth, height: projectedHeight };
}

function fitsOpenAICodexHighDetail(width: number, height: number): boolean {
  const patchesWide = Math.ceil(width / OPENAI_CODEX_IMAGE_PATCH_SIZE);
  const patchesHigh = Math.ceil(height / OPENAI_CODEX_IMAGE_PATCH_SIZE);
  return (
    width <= OPENAI_CODEX_HIGH_DETAIL_MAX_DIMENSION &&
    height <= OPENAI_CODEX_HIGH_DETAIL_MAX_DIMENSION &&
    patchesWide * patchesHigh <= OPENAI_CODEX_HIGH_DETAIL_MAX_PATCHES
  );
}

/**
 * Tighten DSH's area-only request projection until its resulting dimensions
 * also satisfy Codex's longest-edge and rounded patch-grid limits.
 */
export function openAICodexRequestImagePixelBudget(
  width: number,
  height: number,
  maxPixels: number
): number {
  const projected = projectedImageDimensions(width, height, maxPixels);
  if (fitsOpenAICodexHighDetail(projected.width, projected.height))
    return maxPixels;

  let lower = 1;
  let upper = Math.min(maxPixels, width * height - 1);
  let accepted = 1;
  while (lower <= upper) {
    const candidate = lower + Math.floor((upper - lower) / 2);
    const dimensions = projectedImageDimensions(width, height, candidate);
    if (fitsOpenAICodexHighDetail(dimensions.width, dimensions.height)) {
      accepted = candidate;
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }
  const dimensions = projectedImageDimensions(width, height, accepted);
  return dimensions.width * dimensions.height;
}

function withOpenAICodexImagePolicy(store: AttachmentStore): AttachmentStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "readImageRequest") {
        return (
          ref: ImageAttachmentRef,
          policy: ImageRequestPolicy,
          signal?: AbortSignal
        ) =>
          target.readImageRequest(
            ref,
            {
              ...policy,
              maxPixels: openAICodexRequestImagePixelBudget(
                ref.width,
                ref.height,
                policy.maxPixels
              ),
            },
            signal
          );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Codex authentication is deliberately confined to this plugin's OAuth store. */
const OPENAI_CODEX_AUTH_CONTEXT: AuthContext = {
  async env() {
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

/**
 * Image-policy fields added to resolved pi-ai profiles after the oldest DSH
 * version this plugin still compiles against. Keeping the compatibility shape
 * local lets one build serve both that baseline and current runtimes.
 */
type ImageCompatibleResolvedPiAiProviderProfile =
  ResolvedPiAiProviderProfile & {
    maxRequestImageBytes: number;
    requestImagePixelBudget: number;
    requestImageMaxBytes: number;
  };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Lift the pre-rc.7 pi-ai replay shape into the current envelope on read. */
export function migrateLegacyOpenAICodexReplayState(value: unknown): unknown {
  const legacy = record(value);
  if (
    legacy?.["kind"] !== "pi-ai" ||
    legacy["version"] !== 1 ||
    !Array.isArray(legacy["blocks"])
  )
    return value;
  const { blocks, kind: _kind, version: _version, ...response } = legacy;
  return {
    response: { ...response, kind: "pi-ai", version: 2 },
    blocks,
  };
}

function migrateReplayHistory(options: GenerateOptions): GenerateOptions {
  let changed = false;
  const messages = options.messages.map((message) => {
    if (
      message.source.kind !== "model" ||
      message.source.replayState === undefined
    )
      return message;
    const replayState = migrateLegacyOpenAICodexReplayState(
      message.source.replayState
    );
    if (replayState === message.source.replayState) return message;
    changed = true;
    return {
      ...message,
      source: { ...message.source, replayState },
    };
  });
  return changed ? { ...options, messages } : options;
}

/**
 * Codex traffic rides on chatgpt.com, which is frequently reached through a
 * local proxy tunnel that blips for tens of seconds at a time. The dsh
 * default stops after 2 retries and caps scheduled delays at 10 seconds, so
 * this provider retries longer and backs off further to ride out such a blip.
 */
export const OPENAI_CODEX_RETRY_POLICY = resolveRetryPolicy(
  {
    mode: "normal",
    maxRetries: 5,
    backoff: { initialDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 },
  },
  "dsh-openai-codex retryPolicy"
);

/**
 * Give the generic dsh adapter a request-scoped bearer-token entry without
 * changing the provider's user-facing OAuth flow. The resolver accepts only
 * the explicit override supplied by this plugin; it never discovers an API
 * key from the environment or persistent api-key credentials.
 */
function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Add the request-scoped Fast Mode hint without changing other payload fields. */
export function withOpenAICodexFastMode(
  provider: Provider,
  fastMode: FastModeRegistry | undefined
): Provider {
  const streamSimple = provider.streamSimple;
  return {
    ...provider,
    streamSimple(model, context: PiContext, options?: SimpleStreamOptions) {
      const enabled =
        provider.id === OPENAI_CODEX_PROVIDER &&
        model.provider === OPENAI_CODEX_PROVIDER &&
        fastMode?.isEnabled(options?.sessionId) === true;
      if (!enabled) return streamSimple.call(provider, model, context, options);
      const previousOnPayload = options?.onPayload;
      return streamSimple.call(provider, model, context, {
        ...options,
        async onPayload(payload, payloadModel) {
          const replaced = await previousOnPayload?.(payload, payloadModel);
          const nextPayload = replaced === undefined ? payload : replaced;
          return isPayloadRecord(nextPayload)
            ? { ...nextPayload, service_tier: "priority" }
            : nextPayload;
        },
      });
    },
  };
}

/** Override provider model capacities without changing request payload fields. */
function withOpenAICodexContextWindow(
  provider: Provider,
  contextWindow: number | null | undefined,
  overrideSparkContextWindow = false
): Provider {
  if (contextWindow === null || contextWindow === undefined) return provider;
  const getModels = provider.getModels;
  return {
    ...provider,
    getModels() {
      return getModels
        .call(provider)
        .map((model) =>
          model.id === GPT_5_3_CODEX_SPARK && !overrideSparkContextWindow
            ? model
            : { ...model, contextWindow }
        );
    },
  };
}

function requestProvider(
  provider: Provider,
  fastMode?: FastModeRegistry
): Provider {
  return {
    ...withOpenAICodexFastMode(provider, fastMode),
    auth: {
      ...provider.auth,
      apiKey: {
        name: "OpenAI Codex OAuth bearer token",
        async resolve({ credential }) {
          const apiKey = credential?.key;
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: "OAuth" };
        },
      },
    },
  };
}

/** Preserve Harness call purpose until the generic pi-ai adapter reaches the provider. */
class OpenAICodexAdapter extends PiAiAdapter {
  constructor(
    options: ConstructorParameters<typeof PiAiAdapter>[0],
    private readonly responses: OpenAICodexResponseRuntime,
    private readonly visibleModelIds?: () => readonly string[]
  ) {
    super(options);
  }

  override async listModels(provider: string) {
    const models = await super.listModels(provider);
    const visibleModelIds = this.visibleModelIds?.();
    if (visibleModelIds === undefined) return models;
    const visible = new Set(visibleModelIds);
    return models.filter((model) => visible.has(model.id));
  }

  private async *streamPrepared(
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
    options: GenerateOptions
  ): AsyncIterable<StreamChunk> {
    const release =
      options.purpose === "compaction"
        ? this.responses.enterCompaction(
            options.sessionId === undefined
              ? undefined
              : String(options.sessionId)
          )
        : undefined;
    try {
      for await (const chunk of stream(migrateReplayHistory(options)))
        yield chunk;
    } finally {
      release?.();
    }
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<PreparedAdapterCall> {
    const prepared = await super.prepareCall(provider, model, signal);
    return {
      model: prepared.model,
      stream: (options) => this.streamPrepared(prepared.stream, options),
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamPrepared((next) => super.stream(next), options);
  }
}

/**
 * Create the Codex subscription adapter without requiring a dsh fork. The
 * public pi-ai adapter owns Harness message conversion, image attachment
 * resolution, streaming, and reasoning metadata. This plugin adds optional
 * Codex-native request state/compaction and supplies the provider OAuth token.
 */
export function createOpenAICodexAdapter(
  credentials: OpenAICodexCredentialStore,
  resolveAttachments: () => AttachmentStore | undefined,
  responsePreferences: () => ResponseApiPreferences,
  fastMode?: FastModeRegistry,
  visibleModelIds?: () => readonly string[],
  contextWindow?: () => number | null | undefined,
  overrideSparkContextWindow?: () => boolean | undefined
): PiAiAdapter {
  const provider = requestProvider(openaiCodexProvider(), fastMode);
  const responses = new OpenAICodexResponseRuntime(responsePreferences);
  const unset = Symbol("unset context window");
  let resolvedContextWindow: number | null | undefined | typeof unset = unset;
  let resolvedOverrideSparkContextWindow: boolean | undefined;
  let resolvedProfiles: Map<string, ResolvedPiAiProviderProfile> | undefined;
  const profiles = (): Map<string, ResolvedPiAiProviderProfile> => {
    const nextContextWindow = contextWindow?.();
    const nextOverrideSparkContextWindow = overrideSparkContextWindow?.();
    if (
      resolvedProfiles !== undefined &&
      nextContextWindow === resolvedContextWindow &&
      nextOverrideSparkContextWindow === resolvedOverrideSparkContextWindow
    )
      return resolvedProfiles;
    const configuredProvider = withOpenAICodexContextWindow(
      provider,
      nextContextWindow,
      nextOverrideSparkContextWindow
    );
    const profile: ImageCompatibleResolvedPiAiProviderProfile = {
      provider: OPENAI_CODEX_PROVIDER,
      displayName: "OpenAI Codex",
      streamIdleTimeoutMs: OPENAI_CODEX_STREAM_IDLE_TIMEOUT_MS,
      // pi-ai emits `detail: "auto"`. The profile carries Codex's patch-derived
      // area budget; the provider-scoped attachment wrapper below further
      // tightens it per image for the 2048px edge and rounded patch-grid limits.
      requestImagePixelBudget: OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET,
      // DSH exposes an aggregate history limit rather than Codex's per-image
      // input guard. Reusing the 1GiB sanity ceiling keeps pathological history
      // bounded without evicting normal image turns at an arbitrary 20MiB.
      maxRequestImageBytes: OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES,
      requestImageMaxBytes: OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES,
      retryPolicy: OPENAI_CODEX_RETRY_POLICY,
      configuredMaxTokens: new Map(),
      piProvider: responses.wrap(configuredProvider),
    };
    resolvedContextWindow = nextContextWindow;
    resolvedOverrideSparkContextWindow = nextOverrideSparkContextWindow;
    resolvedProfiles = new Map([[OPENAI_CODEX_PROVIDER, profile]]);
    return resolvedProfiles;
  };
  const auth = { credentials, authContext: OPENAI_CODEX_AUTH_CONTEXT };
  const models: MutableModels = createModels(auth);
  models.setProvider(provider);
  let attachmentStore: AttachmentStore | undefined;
  let codexAttachmentStore: AttachmentStore | undefined;
  return new OpenAICodexAdapter(
    {
      profiles,
      resolveApiKey: async () =>
        (await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey,
      auth,
      resolveAttachments: () => {
        const resolved = resolveAttachments();
        if (resolved === undefined) return undefined;
        if (resolved !== attachmentStore) {
          attachmentStore = resolved;
          codexAttachmentStore = withOpenAICodexImagePolicy(resolved);
        }
        return codexAttachmentStore;
      },
    },
    responses,
    visibleModelIds
  );
}
