/** Explicit proxy modes for OpenAI Codex HTTP traffic. */

import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  ProxyAgent,
  setGlobalDispatcher,
} from "undici";
import type { Dispatcher } from "undici";

export type OpenAICodexProxyMode = "off" | "scoped" | "global";

export interface ProxyPreferences {
  /** Whether this plugin leaves networking alone, proxies Codex only, or proxies the process. */
  proxyMode: OpenAICodexProxyMode;
  /** Explicit HTTP(S) proxy URL; empty uses standard proxy environment variables. */
  proxyUrl: string;
}

export const DEFAULT_PROXY_PREFERENCES: ProxyPreferences = {
  proxyMode: "off",
  proxyUrl: "",
};

function invalidProxyUrl(): Error {
  return new Error("Proxy URL must use http:// or https://");
}

/** Validate a persisted proxy value without echoing possible credentials. */
export function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalidProxyUrl();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    throw invalidProxyUrl();
  }
  return trimmed;
}

function configuredProxyUrl(proxyUrl: string): string {
  const explicit = normalizeProxyUrl(proxyUrl);
  if (explicit.length > 0) return explicit;
  const pluginEnvironment = process.env.DSH_CODEX_PROXY?.trim() ?? "";
  return pluginEnvironment.length > 0
    ? normalizeProxyUrl(pluginEnvironment)
    : "";
}

function environmentProxyKey(): string {
  return [
    process.env.DSH_CODEX_PROXY,
    process.env.https_proxy,
    process.env.HTTPS_PROXY,
    process.env.http_proxy,
    process.env.HTTP_PROXY,
    process.env.all_proxy,
    process.env.ALL_PROXY,
    process.env.no_proxy,
    process.env.NO_PROXY,
  ]
    .map((value) => value?.trim() ?? "")
    .join("\u0000");
}

function proxyKey(proxyUrl: string): string {
  const explicit = configuredProxyUrl(proxyUrl);
  return explicit.length === 0
    ? `env:${environmentProxyKey()}`
    : `url:${explicit}`;
}

function createScopedDispatcher(proxyUrl: string): Dispatcher {
  const explicit = configuredProxyUrl(proxyUrl);
  return explicit.length > 0
    ? new ProxyAgent(explicit)
    : new EnvHttpProxyAgent();
}

function createFallbackGlobalDispatcher(proxyUrl: string): Dispatcher {
  const explicit = configuredProxyUrl(proxyUrl);
  const inheritedNoProxy =
    process.env.no_proxy?.trim() || process.env.NO_PROXY?.trim();
  const noProxy = [
    inheritedNoProxy,
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(",");
  return new EnvHttpProxyAgent({
    ...(explicit.length === 0
      ? {}
      : { httpProxy: explicit, httpsProxy: explicit }),
    noProxy,
  });
}

function globalProxyEnvironment(proxyUrl: string): {
  get(name: string): { value: string } | undefined;
} {
  const explicit = configuredProxyUrl(proxyUrl);
  return {
    get(name) {
      const lower = name.toLowerCase();
      if (
        explicit.length > 0 &&
        (lower === "http_proxy" || lower === "https_proxy")
      ) {
        return { value: explicit };
      }
      const value = process.env[name];
      return value === undefined ? undefined : { value };
    },
  };
}

type ProxyEnvironment = ReturnType<typeof globalProxyEnvironment>;
type ProxyDisposer = () => Promise<void>;

interface HarnessProxyModule {
  installProxyFromEnvironment?: (
    environment: ProxyEnvironment,
    report: (message: string) => void
  ) => Promise<ProxyDisposer>;
}

const HARNESS_PROXY_MODULE = "@deepseek-ai/dsh-http-proxy";

function moduleIsUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes(HARNESS_PROXY_MODULE)
  );
}

async function installFallbackGlobalProxy(
  proxyUrl: string
): Promise<ProxyDisposer> {
  const previous = getGlobalDispatcher();
  const dispatcher = createFallbackGlobalDispatcher(proxyUrl);
  setGlobalDispatcher(dispatcher);
  return async () => {
    if (getGlobalDispatcher() === dispatcher) {
      setGlobalDispatcher(previous);
    }
    await dispatcher.close();
  };
}

async function installHarnessGlobalProxy(
  proxyUrl: string
): Promise<ProxyDisposer> {
  let loaded: HarnessProxyModule;
  try {
    // DSH 0.1.3 owns this process-wide policy. Keep the import optional while
    // the plugin still supports the published 0.1.1 line that predates it.
    loaded = (await import(HARNESS_PROXY_MODULE)) as HarnessProxyModule;
  } catch (error) {
    if (!moduleIsUnavailable(error)) throw error;
    return await installFallbackGlobalProxy(proxyUrl);
  }
  if (loaded.installProxyFromEnvironment === undefined) {
    return await installFallbackGlobalProxy(proxyUrl);
  }
  return await loaded.installProxyFromEnvironment(
    globalProxyEnvironment(proxyUrl),
    (message) => {
      process.stderr.write(`[dsh-codex] ${message}\n`);
    }
  );
}

/**
 * Owns request-scoped dispatch and an optional nested Harness-wide policy.
 * Disposing the nested policy restores the launcher's original proxy policy.
 */
export class OpenAICodexProxyTransport {
  private readonly dispatchers = new Map<string, Dispatcher>();
  private globalDispose: (() => Promise<void>) | undefined;
  private appliedGlobalKey: string | undefined;
  private transition: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly preferences: () => ProxyPreferences) {}

  /** Reconcile process-global state after a live setting change. */
  apply(): Promise<void> {
    const preferences = this.preferences();
    normalizeProxyUrl(preferences.proxyUrl);
    const desiredKey =
      preferences.proxyMode === "global"
        ? proxyKey(preferences.proxyUrl)
        : undefined;
    this.transition = this.transition.catch(() => undefined).then(async () => {
      if (this.disposed || desiredKey === this.appliedGlobalKey) return;
      await this.restoreGlobal();
      if (desiredKey === undefined) return;
      this.globalDispose = await installHarnessGlobalProxy(
        preferences.proxyUrl
      );
      this.appliedGlobalKey = desiredKey;
    });
    return this.transition;
  }

  /** Fetch implementation injected into Codex-owned HTTP call sites. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    await this.apply();
    const preferences = this.preferences();
    if (preferences.proxyMode !== "scoped") {
      return await globalThis.fetch(input, init);
    }
    const options = {
      ...(init ?? {}),
      dispatcher: this.dispatcher(preferences.proxyUrl),
    } as Parameters<typeof undiciFetch>[1];
    return (await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      options
    )) as unknown as Response;
  };

  /** Restore host networking and close all provider-owned pools. */
  async dispose(): Promise<void> {
    await this.transition.catch(() => undefined);
    this.disposed = true;
    await this.restoreGlobal();
    const dispatchers = [...this.dispatchers.values()];
    this.dispatchers.clear();
    await Promise.allSettled(
      dispatchers.map(async (dispatcher) => await dispatcher.close())
    );
  }

  private dispatcher(proxyUrl: string): Dispatcher {
    const key = proxyKey(proxyUrl);
    let dispatcher = this.dispatchers.get(key);
    if (dispatcher === undefined) {
      dispatcher = createScopedDispatcher(proxyUrl);
      this.dispatchers.set(key, dispatcher);
    }
    return dispatcher;
  }

  private async restoreGlobal(): Promise<void> {
    const dispose = this.globalDispose;
    this.globalDispose = undefined;
    this.appliedGlobalKey = undefined;
    await dispose?.();
  }
}
