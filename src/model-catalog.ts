import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Only model metadata is shared with Codex; its credentials are never read. */
export function openAICodexModelsCachePath(): string {
  return process.env["DSH_CODEX_MODELS_CACHE"]?.trim() ||
    join(process.env["CODEX_HOME"]?.trim() || join(homedir(), ".codex"), "models_cache.json");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Merge picker-visible Codex metadata while preserving bundled transport and pricing. */
export function mergeOpenAICodexModels(
  bundled: readonly Model<Api>[],
  document: unknown
): readonly Model<Api>[] {
  const entries = record(document)?.["models"];
  const transport = bundled[0];
  if (!Array.isArray(entries) || transport === undefined) return bundled;
  const known = new Map(bundled.map(model => [model.id, model]));
  const discovered = new Map<string, Model<Api>>();
  for (const value of entries) {
    const entry = record(value);
    const id = entry?.["slug"];
    const contextWindow = entry?.["context_window"];
    if (!entry || entry["visibility"] !== "list" ||
      typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ||
      !positiveInteger(contextWindow) || discovered.has(id)) continue;
    const existing = known.get(id);
    const modalities = entry["input_modalities"];
    const input: ("text" | "image")[] = Array.isArray(modalities)
      ? modalities.filter((item): item is "text" | "image" => item === "text" || item === "image")
      : existing?.input ?? ["text", "image"];
    if (!input.includes("text")) continue;
    const levels = entry["supported_reasoning_levels"];
    const efforts = Array.isArray(levels)
      ? levels.flatMap(level => {
        const effort = record(level)?.["effort"];
        return typeof effort === "string" ? [effort] : [];
      }) : undefined;
    const thinkingLevelMap: ThinkingLevelMap = {};
    if (efforts !== undefined) {
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        thinkingLevelMap[level] = efforts.includes(level) ? level : null;
      }
      if (!efforts.includes("minimal") && efforts.includes("low")) thinkingLevelMap.minimal = "low";
    }
    discovered.set(id, {
      ...(existing ?? {
        id,
        api: transport.api,
        provider: transport.provider,
        baseUrl: transport.baseUrl,
        // Subscription usage has no discoverable per-token price. Do not copy
        // an unrelated model's rates or its model-specific compatibility flags.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      name: typeof entry["display_name"] === "string" && entry["display_name"].trim()
        ? entry["display_name"] : existing?.name ?? id,
      contextWindow,
      maxTokens: Math.min(existing?.maxTokens ?? 128_000, contextWindow),
      input,
      reasoning: efforts === undefined ? existing?.reasoning ?? true : efforts.length > 0,
      ...(efforts === undefined ? {} : { thinkingLevelMap }),
    });
  }
  if (discovered.size === 0) return bundled;
  const bundledIds = new Set(bundled.map((model) => model.id));
  return [
    ...bundled.map((model) => discovered.get(model.id) ?? model),
    ...[...discovered.values()].filter((model) => !bundledIds.has(model.id)),
  ];
}

/** Reload changed metadata without invalidating in-flight request snapshots. */
export class OpenAICodexModelCatalog {
  private signature: string | undefined;
  private current: readonly Model<Api>[];

  constructor(
    private readonly bundled: readonly Model<Api>[],
    private readonly filename = openAICodexModelsCachePath()
  ) {
    this.current = bundled;
  }

  getModels(): readonly Model<Api>[] {
    try {
      const stat = statSync(this.filename);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return this.current;
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (signature === this.signature) return this.current;
      const document: unknown = JSON.parse(readFileSync(this.filename, "utf8").replace(/^\uFEFF/, ""));
      const next = mergeOpenAICodexModels(this.bundled, document);
      // A partial rewrite, unsupported schema, or empty response must not erase
      // the last usable catalog. Try again when Codex replaces the file.
      if (next !== this.bundled) this.current = next;
      this.signature = signature;
    } catch {
      // Codex is optional. Missing, unreadable, and interrupted writes all
      // fall back to the last good snapshot (initially the bundled catalog).
    }
    return this.current;
  }
}
