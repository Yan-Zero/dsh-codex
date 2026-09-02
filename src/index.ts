/**
 * Optional OpenAI Codex subscription bundle with ChatGPT OAuth, Codex models,
 * standalone search, browser settings, and vision-aware image input.
 * @module dsh-codex
 */

import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-attachment";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-web";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-fs";
import {
  createOpenAICodexAdapter,
  openAICodexModelCatalog,
} from "./adapter.ts";
import { registerOpenAICodexAuthRoutes } from "./auth-routes.ts";
import { installReadImageEnhancement } from "./read-image-enhancement.ts";
import { imagegenTool } from "./imagegen.ts";
import { ImageToolPolicy } from "./tool-policy.ts";
import { FastModeRegistry } from "./fast-mode.ts";
import { assertNoOpenAICodexProviderConflict } from "./doctor.ts";
import {
  installOpenAICodexSearchEvent,
  recordOpenAICodexSearchRequest,
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
  DEFAULT_IMAGE_TOOL_PREFERENCES,
  DEFAULT_RESPONSE_API_PREFERENCES,
  ImageToolPolicy,
} from "./tool-policy.ts";
export type {
  ContextWindowPreferences,
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
  OpenAICodexUsage,
} from "./usage.ts";
export {
  installOpenAICodexSearchEvent,
  OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT,
  recordOpenAICodexSearchRequest,
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

export { OpenAICodexService } from "./service.ts";
export type { OpenAICodexServiceOptions } from "./service.ts";

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
  /** Model ids advertised by the provider; omitted to advertise the full catalog. */
  models?: string[] | undefined;
  /** Client-side model context capacity in tokens; omitted to keep provider defaults. */
  contextWindow?: number | undefined;
  /** Apply the context-window override to GPT-5.3 Codex Spark as well. */
  overrideSparkContextWindow?: boolean;
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
  /** Reuse matching Codex context through the session's WebSocket connection. */
  useWebSocketContextReuse?: boolean;
  /** Use Codex V2 Responses compaction for Harness compaction calls. */
  useNativeCompaction?: boolean;
}

export const Config: z<Config> = z.object({
  models: z.union([z.const(undefined), z.array(z.string())]),
  contextWindow: z.union([
    z.const(undefined),
    z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  ]),
  overrideSparkContextWindow: z.boolean().default(false),
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
  modifyReadImage: z.boolean().default(true),
  shareImagegenWithOtherModels: z.boolean().default(true),
  useWebSocketContextReuse: z.boolean().default(false),
  useNativeCompaction: z.boolean().default(false),
});

/**
 * Register the `openai-codex` LLM route and standalone web-search provider
 * with one provider-native OAuth credential store.
 * @param ctx - plugin context carrying the LLM and web registries plus optional agent and attachment services.
 * @param config - standalone-search model, access mode, context size, and output budget.
 */
export function apply(ctx: Context, config: Config): void {
  installOpenAICodexSearchEvent();
  const service = new OpenAICodexService({
    ...(config.models === undefined ? {} : { models: config.models }),
    contextWindow: config.contextWindow ?? null,
    overrideSparkContextWindow: config.overrideSparkContextWindow ?? false,
    modelCatalog: openAICodexModelCatalog(),
    modifyReadImage: config.modifyReadImage ?? true,
    shareImagegenWithOtherModels: config.shareImagegenWithOtherModels ?? true,
    useWebSocketContextReuse: config.useWebSocketContextReuse ?? false,
    useNativeCompaction: config.useNativeCompaction ?? false,
  });
  const credentials = service.credentials;
  const imageTools = service.policy;
  const fastMode = new FastModeRegistry();
  assertNoOpenAICodexProviderConflict(
    ctx.llm.listProviders().map((provider) => provider.id)
  );
  ctx.provide("openAICodex", service);
  ctx.inject(["settings"], (settingsCtx) => {
    service.attachSettings(settingsCtx);
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
      () => imageTools.contextWindowSnapshot().overrideSparkContextWindow
    )
  );
  ctx.web.registerSearchProvider(
    new OpenAICodexSearchProvider({
      credentials,
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
      recordRequest: (request) => {
        recordOpenAICodexSearchRequest(ctx, request);
      },
    })
  );
  ctx.inject(["webServer"], (webCtx) =>
    registerOpenAICodexAuthRoutes(
      webCtx,
      credentials,
      undefined,
      fastMode,
      imageTools
    )
  );
  ctx.inject(["tools", "fs", "attachments"], (toolCtx) => {
    toolCtx.tools.register(imagegenTool(toolCtx, credentials, imageTools));
  });
  ctx.inject(["tools", "fs", "attachments", "agents"], (toolCtx) => {
    installReadImageEnhancement(toolCtx, imageTools);
  });
}
