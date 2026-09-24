/** Shared host service consumed by optional OpenAI Codex front-door adapters. */

import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { Context } from "@deepseek-ai/cordis";
import {
  loginOpenAICodex,
  logoutOpenAICodex,
  openAICodexAuthStatus,
} from "./auth.ts";
import type { OpenAICodexAuthStatus } from "./auth.ts";
import { OpenAICodexCredentialStore } from "./store.ts";
import { OpenAICodexProxyTransport } from "./proxy.ts";
import type { ProxyPreferences } from "./proxy.ts";
import { ImageToolPolicy } from "./tool-policy.ts";
import type {
  ContextWindowPreferences,
  FastModePreferences,
  ImageToolPreferences,
  ModelCatalogEntry,
  ModelCatalogSettings,
  ModelFallbackPreferences,
  ResponseApiPreferences,
} from "./tool-policy.ts";
import { readOpenAICodexRateLimits } from "./usage.ts";
import type { OpenAICodexUsage } from "./usage.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Provider-owned account and preference service for optional front doors. */
    openAICodex: OpenAICodexService;
  }
}

/** Initial settings contributed by the bundle configuration. */
export interface OpenAICodexServiceOptions
  extends
    ImageToolPreferences,
    ResponseApiPreferences,
    ContextWindowPreferences,
    FastModePreferences,
    ModelFallbackPreferences,
    ProxyPreferences {
  credentialFile?: string;
  models?: string[];
  modelCatalog: readonly ModelCatalogEntry[] | (() => readonly ModelCatalogEntry[]);
}

/**
 * One provider-owned host service shared by Web routes and terminal adapters.
 * Credentials and live policy stay singletons even when several front doors are mounted.
 */
export class OpenAICodexService {
  readonly credentials: OpenAICodexCredentialStore;
  readonly policy: ImageToolPolicy;
  readonly proxy: OpenAICodexProxyTransport;
  private readonly stopProxyWatch: () => void;
  private usageCache:
    | { expiresAt: number; request: Promise<OpenAICodexUsage> }
    | undefined;
  private lastUsage: OpenAICodexUsage | undefined;

  constructor(options: OpenAICodexServiceOptions) {
    this.credentials = new OpenAICodexCredentialStore(options.credentialFile);
    // Only preferences belong in the settings composition base: `modelCatalog`
    // is a live thunk and `credentialFile` is not a preference, and either one
    // reaching the descriptor makes settings.describe() fail to materialize.
    const {
      modelCatalog,
      credentialFile: _credentialFile,
      ...preferences
    } = options;
    this.policy = new ImageToolPolicy(preferences, modelCatalog);
    this.proxy = new OpenAICodexProxyTransport(() =>
      this.policy.proxySnapshot()
    );
    void this.proxy.apply().catch((error: unknown) => {
      process.stderr.write(
        `[dsh-codex] failed to apply proxy settings: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
    this.stopProxyWatch = this.policy.watchProxyPreferences(() => {
      void this.proxy.apply().catch((error: unknown) => {
        process.stderr.write(
          `[dsh-codex] failed to apply proxy settings: ${error instanceof Error ? error.message : String(error)}\n`
        );
      });
    });
  }

  /** Bind browser writes to the owning plugin entry in the active profile. */
  attachSettings(ctx: Context, namespace: string, owner: Context["fiber"]): void {
    this.policy.attach(ctx, namespace, owner);
  }

  /** Accept values committed in place by Harness's volatile configuration path. */
  refreshSettings(options: Partial<OpenAICodexServiceOptions>): void {
    this.policy.refresh(options);
  }

  /** Start the provider-native OAuth lifecycle. */
  async login(interaction: AuthInteraction): Promise<void> {
    await this.proxy.apply();
    await loginOpenAICodex(interaction, this.credentials, this.proxy.fetch);
    this.usageCache = undefined;
    this.lastUsage = undefined;
  }

  /** Clear the selected credential; explicit shared files affect their other consumers too. */
  async logout(): Promise<void> {
    await logoutOpenAICodex(this.credentials);
    this.usageCache = undefined;
    this.lastUsage = undefined;
  }

  /** Read non-secret authentication metadata. */
  authStatus(): Promise<OpenAICodexAuthStatus> {
    return openAICodexAuthStatus(this.credentials);
  }

  /** Read current subscription limits without issuing a model request. */
  async usage(forceRefresh = false): Promise<OpenAICodexUsage> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.usageCache !== undefined &&
      this.usageCache.expiresAt > now
    ) {
      return await this.usageCache.request;
    }
    const request = readOpenAICodexRateLimits(
      this.credentials,
      this.proxy.fetch
    );
    this.usageCache = { expiresAt: now + 15_000, request };
    try {
      const usage = await request;
      if (this.usageCache?.request === request) this.lastUsage = usage;
      return usage;
    } catch (error: unknown) {
      if (this.usageCache?.request === request) this.usageCache = undefined;
      if (forceRefresh) this.lastUsage = undefined;
      throw error;
    }
  }

  /** Last successful account snapshot, used without delaying a healthy model request. */
  usageSnapshot(): OpenAICodexUsage | undefined {
    return this.lastUsage;
  }

  imagePreferences(): ImageToolPreferences {
    return this.policy.snapshot();
  }

  updateImagePreferences(
    patch: Partial<ImageToolPreferences>
  ): Promise<ImageToolPreferences> {
    return this.policy.update(patch);
  }

  responsePreferences(): ResponseApiPreferences {
    return this.policy.responseApiSnapshot();
  }

  updateResponsePreferences(
    patch: Partial<ResponseApiPreferences>
  ): Promise<ResponseApiPreferences> {
    return this.policy.updateResponseApi(patch);
  }

  contextWindowPreferences(): ContextWindowPreferences {
    return this.policy.contextWindowSnapshot();
  }

  updateContextWindowPreferences(
    patch: Partial<ContextWindowPreferences>
  ): Promise<ContextWindowPreferences> {
    return this.policy.updateContextWindow(patch);
  }

  fastModePreferences(): FastModePreferences {
    return this.policy.fastModeSnapshot();
  }

  updateFastModePreferences(
    patch: Partial<FastModePreferences>
  ): Promise<FastModePreferences> {
    return this.policy.updateFastMode(patch);
  }

  modelFallbackPreferences(): ModelFallbackPreferences {
    return this.policy.modelFallbackSnapshot();
  }

  updateModelFallbackPreferences(
    patch: Partial<ModelFallbackPreferences>
  ): Promise<ModelFallbackPreferences> {
    return this.policy.updateModelFallback(patch);
  }

  modelCatalogSettings(): ModelCatalogSettings {
    return this.policy.modelCatalogSnapshot();
  }

  proxyPreferences(): ProxyPreferences {
    return this.policy.proxySnapshot();
  }

  async updateProxyPreferences(
    patch: Partial<ProxyPreferences>
  ): Promise<ProxyPreferences> {
    const preferences = await this.policy.updateProxy(patch);
    await this.proxy.apply();
    return preferences;
  }

  async dispose(): Promise<void> {
    this.stopProxyWatch();
    await this.proxy.dispose();
  }
}
