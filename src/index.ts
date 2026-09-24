/**
 * Optional OpenAI Codex subscription bundle with ChatGPT OAuth, Codex models,
 * standalone search, browser settings, and vision-aware image input.
 * @module dsh-codex
 */

import type { Context, Volatile } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-attachment";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-web";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import {
  createOpenAICodexAdapter,
  createOpenAICodexModelProvider,
  openAICodexModelCatalog,
} from "./adapter.ts";
import { registerOpenAICodexAuthRoutes } from "./auth-routes.ts";
import { installReadImageEnhancement } from "./read-image-enhancement.ts";
import { imagegenTool } from "./imagegen.ts";
import { ImageToolPolicy } from "./tool-policy.ts";
import { FastModeRegistry } from "./fast-mode.ts";
import { installOpenAICodexModelFallback } from "./model-fallback.ts";
import { assertNoOpenAICodexProviderConflict } from "./doctor.ts";
import {
  installOpenAICodexSearchEvent,
} from "./search-event.ts";

export { READ_IMAGE_TOOL_NAME } from "./read-image-enhancement.ts";
export {
  IMAGEGEN_TOOL_NAME,
  OPENAI_CODEX_IMAGE_EDITS_URL,
  OPENAI_CODEX_IMAGE_GENERATIONS_URL,
  OPENAI_CODEX_IMAGE_MODEL,
  OpenAICodexImageClient,
} from "./imagegen.ts";
export {
  DEFAULT_CONTEXT_WINDOW_PREFERENCES,
  DEFAULT_FAST_MODE_PREFERENCES,
  DEFAULT_IMAGE_TOOL_PREFERENCES,
  DEFAULT_MODEL_FALLBACK_PREFERENCES,
  DEFAULT_RESPONSE_API_PREFERENCES,
  ImageToolPolicy,
} from "./tool-policy.ts";
export type {
  ContextWindowPreferences,
  FastModePreferences,
  ModelFallbackPreferences,
  ImageToolPreferences,
  ResponseApiPreferences,
} from "./tool-policy.ts";
export {
  isOpenAICodexReauthRequiredError,
  OPENAI_CODEX_REAUTH_REQUIRED_CODE,
  OPENAI_CODEX_REAUTH_REQUIRED_MESSAGE,
  OPENAI_CODEX_USAGE_URL,
  OpenAICodexReauthRequiredError,
  parseOpenAICodexUsage,
  readOpenAICodexRateLimits,
} from "./usage.ts";
export type {
  OpenAICodexCredits,
  OpenAICodexIndividualLimit,
  OpenAICodexRateLimit,
  OpenAICodexRateLimitWindow,
  OpenAICodexRateLimitUpsell,
  OpenAICodexUsage,
} from "./usage.ts";
export {
  installOpenAICodexSearchEvent,
  OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
} from "./search-event.ts";
import {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  OpenAICodexSearchProvider,
} from "./search.ts";
import type {
  OpenAICodexSearchContextSize,
  OpenAICodexSearchMode,
} from "./search.ts";
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from "./store.ts";
import { OpenAICodexService } from "./service.ts";
import { DEFAULT_PROXY_PREFERENCES } from "./proxy.ts";
import type { OpenAICodexProxyMode } from "./proxy.ts";
import {
  DEFAULT_OPENAI_CODEX_IMAGE_MODEL,
  OPENAI_CODEX_IMAGE_MODELS,
} from "./image-model.ts";
import type { OpenAICodexImageModel } from "./image-model.ts";

export { OpenAICodexService } from "./service.ts";
export type { OpenAICodexServiceOptions } from "./service.ts";
export {
  DEFAULT_PROXY_PREFERENCES,
  normalizeProxyUrl,
  OpenAICodexProxyTransport,
} from "./proxy.ts";
export type { OpenAICodexProxyMode, ProxyPreferences } from "./proxy.ts";
export {
  DEFAULT_OPENAI_CODEX_IMAGE_MODEL,
  OPENAI_CODEX_IMAGE_MODELS,
  isOpenAICodexImageModel,
} from "./image-model.ts";
export type { OpenAICodexImageModel } from "./image-model.ts";

export {
  assertNoOpenAICodexProviderConflict,
  diagnoseOpenAICodex,
  openAICodexConflictMessage,
} from "./doctor.ts";
export type {
  OpenAICodexDiagnosticOptions,
  OpenAICodexDiagnosticReport,
} from "./doctor.ts";
export {
  FastModeRegistry,
  isFastModeSessionId,
  OPENAI_CODEX_FAST_MODE_MAX_SESSIONS,
  OPENAI_CODEX_FAST_MODE_MAX_SESSION_ID_LENGTH,
} from "./fast-mode.ts";
export { OPENAI_CODEX_FAST_MODE_PATH } from "./fast-mode-paths.ts";
export {
  installOpenAICodexModelFallback,
  openAICodexFallbackCandidates,
  resolveOpenAICodexFallback,
} from "./model-fallback.ts";
export { OPENAI_CODEX_LUNA_RESERVE_MODEL } from "./adapter.ts";

export {
  loginOpenAICodex,
  logoutOpenAICodex,
  openAICodexAuthStatus,
} from "./auth.ts";
export type { OpenAICodexAuthStatus } from "./auth.ts";
export {
  OpenAICodexCredentialStore,
  OPENAI_CODEX_AUTH_FILENAME,
  OPENAI_CODEX_PROVIDER,
  openAICodexAuthPath,
} from "./store.ts";
export {
  DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
  DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_CODEX_SEARCH_MODE,
  DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
  mapOpenAICodexSearchResponse,
  OpenAICodexSearchProvider,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_SEARCH_PROVIDER,
  OPENAI_CODEX_SEARCH_URL,
} from "./search.ts";
export type {
  OpenAICodexSearchContextSize,
  OpenAICodexSearchMode,
  OpenAICodexSearchProviderOptions,
  OpenAICodexSearchRequestRecord,
} from "./search.ts";

/** Stable Cordis plugin name. */
export const name = "llm-openai-codex";

/** LLM and web registries required before the composite provider can register. */
export const inject = ["llm", "web"];

/** Composite model and standalone-search configuration. */
export interface Config {
  /** Absolute shared OAuth JSON path; omitted to retain independent dsh storage. */
  credentialFile?: string;
  /** Model ids advertised by the provider; omitted to advertise the full catalog. */
  models?: string[];
  /** Client-side model context capacity in tokens; omitted to keep provider defaults. */
  contextWindow?: number | null;
  /** Model used for auxiliary standalone searches. */
  searchModel?: string;
  /** Cached, indexed, or live web access. */
  searchMode?: OpenAICodexSearchMode;
  /** Amount of search context returned by the provider. */
  searchContextSize?: OpenAICodexSearchContextSize;
  /** Maximum generated tokens returned by the standalone search endpoint. */
  searchMaxOutputTokens?: number;
  /** Extend Harness read_image with HTTP(S) URL input. */
  modifyReadImage?: boolean;
  /** Allow non-Codex vision models to call imagegen. */
  shareImagegenWithOtherModels?: boolean;
  /** GPT Image backend used by imagegen. */
  imageGenerationModel?: OpenAICodexImageModel;
  /** Reuse matching Codex context through the session's WebSocket connection. */
  useWebSocketContextReuse?: boolean;
  /** Use Codex V2 Responses compaction for Harness compaction calls. */
  useNativeCompaction?: boolean;
  /** Force the priority service tier on every Codex session. */
  fastModeDefault?: boolean;
  /** Follow only model recovery explicitly authorized by the account backend. */
  automaticModelFallback?: boolean;
  /** How this plugin applies its proxy URL. */
  proxyMode?: OpenAICodexProxyMode;
  /** HTTP(S) proxy URL; empty uses the launch environment. */
  proxyUrl?: string;
}

export const Config = z.object({
  credentialFile: z.union([z.const(undefined), z.string()]),
  models: z.union([z.const(undefined), z.array(z.string())]).volatile(),
  contextWindow: z.union([
    z.const(null),
    z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  ]).default(null).volatile(),
  searchModel: z.string().default(DEFAULT_OPENAI_CODEX_SEARCH_MODEL),
  searchMode: z
    .union(["cached", "indexed", "live"] as const)
    .default(DEFAULT_OPENAI_CODEX_SEARCH_MODE),
  searchContextSize: z
    .union(["low", "medium", "high"] as const)
    .default(DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE),
  searchMaxOutputTokens: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS),
  modifyReadImage: z.boolean().default(true).volatile(),
  shareImagegenWithOtherModels: z.boolean().default(true).volatile(),
  imageGenerationModel: z
    .union(OPENAI_CODEX_IMAGE_MODELS.map((model) => model.id) as [
      OpenAICodexImageModel,
      ...OpenAICodexImageModel[],
    ])
    .default(DEFAULT_OPENAI_CODEX_IMAGE_MODEL)
    .volatile(),
  useWebSocketContextReuse: z.boolean().default(false).volatile(),
  useNativeCompaction: z.boolean().default(false).volatile(),
  fastModeDefault: z.boolean().default(false).volatile(),
  automaticModelFallback: z.boolean().default(false).volatile(),
  proxyMode: z
    .union(["off", "scoped", "global"] as const)
    .default(DEFAULT_PROXY_PREFERENCES.proxyMode)
    .volatile(),
  proxyUrl: z.string().default(DEFAULT_PROXY_PREFERENCES.proxyUrl).volatile(),
});

/**
 * Register the `openai-codex` LLM route and standalone web-search provider
 * with one provider-native OAuth credential store.
 * @param ctx - plugin context carrying the LLM and web registries plus optional agent and attachment services.
 * @param config - standalone-search model, access mode, context size, and output budget.
 */
function liveValue<T>(value: T | undefined, fallback: T): T {
  const candidate = value as T | Volatile<T> | undefined;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "get" in candidate &&
    typeof candidate.get === "function"
  ) {
    return (candidate.get() ?? fallback) as T;
  }
  return (candidate ?? fallback) as T;
}

export function apply(ctx: Context, config: Config): void {
  installOpenAICodexSearchEvent();
  const modelProvider = createOpenAICodexModelProvider((input, init) => service.proxy.fetch(input, init));
  const livePreferences = () => ({
    models: [...liveValue(config.models, openAICodexModelCatalog(modelProvider).map((model) => model.id))],
    contextWindow: liveValue(config.contextWindow, null),
    modifyReadImage: liveValue(config.modifyReadImage, true),
    shareImagegenWithOtherModels: liveValue(config.shareImagegenWithOtherModels, true),
    imageGenerationModel: liveValue(config.imageGenerationModel, DEFAULT_OPENAI_CODEX_IMAGE_MODEL),
    useWebSocketContextReuse: liveValue(config.useWebSocketContextReuse, false),
    useNativeCompaction: liveValue(config.useNativeCompaction, false),
    fastModeDefault: liveValue(config.fastModeDefault, false),
    automaticModelFallback: liveValue(config.automaticModelFallback, false),
    proxyMode: liveValue(config.proxyMode, DEFAULT_PROXY_PREFERENCES.proxyMode),
    proxyUrl: liveValue(config.proxyUrl, DEFAULT_PROXY_PREFERENCES.proxyUrl),
  });
  const service = new OpenAICodexService({
    ...(config.credentialFile === undefined ? {} : { credentialFile: config.credentialFile }),
    modelCatalog: () => openAICodexModelCatalog(modelProvider),
    ...livePreferences(),
  });
  const credentials = service.credentials;
  const imageTools = service.policy;
  const fastMode = new FastModeRegistry();
  assertNoOpenAICodexProviderConflict(
    ctx.llm.listProviders().map((provider) => provider.id)
  );
  ctx.provide("openAICodex", service);
  ctx.effect(
    () => async () => {
      await service.dispose();
    },
    "dsh-openai-codex: proxy transport"
  );
  ctx.inject(["settings"], (settingsCtx) => {
    const namespace = (ctx.fiber as unknown as {
      entry?: { options?: { id?: string } };
    }).entry?.options?.id ?? name;
    service.attachSettings(settingsCtx, namespace, ctx.fiber);
  });
  ctx.on("loader/volatile-update", () => {
    service.refreshSettings(livePreferences());
  });
  ctx.llm.registerAdapter(
    [OPENAI_CODEX_PROVIDER],
    createOpenAICodexAdapter(
      credentials,
      () => ctx.get("attachments"),
      () => imageTools.responseApiSnapshot(),
      fastMode,
      () => imageTools.modelCatalogSnapshot().models,
      () => imageTools.contextWindowSnapshot().contextWindow,
      service.proxy.fetch,
      () => imageTools.fastModeSnapshot().fastModeDefault,
      modelProvider
    )
  );
  ctx.effect(
    () => installOpenAICodexModelFallback(ctx, service),
    "dsh-openai-codex: backend model fallback"
  );
  ctx.web.registerSearchProvider(
    new OpenAICodexSearchProvider({
      credentials,
      fetch: service.proxy.fetch,
      model: config.searchModel ?? DEFAULT_OPENAI_CODEX_SEARCH_MODEL,
      mode: config.searchMode ?? DEFAULT_OPENAI_CODEX_SEARCH_MODE,
      contextSize:
        config.searchContextSize ?? DEFAULT_OPENAI_CODEX_SEARCH_CONTEXT_SIZE,
      maxOutputTokens:
        config.searchMaxOutputTokens ??
        DEFAULT_OPENAI_CODEX_SEARCH_MAX_OUTPUT_TOKENS,
      resolveRequestId: () =>
        String(
          ctx.get("agents")?.currentInitiator()?.session.id ?? randomUUID()
        ),
    })
  );
  ctx.inject(["webServer"], (webCtx) =>
    registerOpenAICodexAuthRoutes(
      webCtx,
      credentials,
      undefined,
      fastMode,
      imageTools,
      service,
      service.proxy.fetch,
      () => service.proxy.apply()
    )
  );
  ctx.inject(["tools", "fs", "attachments"], (toolCtx) => {
    toolCtx.tools.register(
      imagegenTool(toolCtx, credentials, imageTools, service.proxy.fetch)
    );
  });
  ctx.inject(["tools", "fs", "attachments", "agents"], (toolCtx) => {
    installReadImageEnhancement(toolCtx, imageTools);
  });
}
