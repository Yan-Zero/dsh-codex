import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { OpenAICodexModelCatalog, mergeOpenAICodexModels, openAICodexModelsCachePath } from "../src/model-catalog.ts";
import { createOpenAICodexAdapter, createOpenAICodexModelProvider, openAICodexModelCatalog } from "../src/adapter.ts";
import { ImageToolPolicy } from "../src/tool-policy.ts";
import type { OpenAICodexCredentialStore } from "../src/store.ts";

const bundled = openaiCodexProvider().getModels();
const astra = {
  slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list",
  context_window: 272_000, max_context_window: 872_000,
  input_modalities: ["text", "image"],
  supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
};
const directories: string[] = [];
function cacheFile() {
  const directory = mkdtempSync(join(tmpdir(), "dsh-codex-models-"));
  directories.push(directory);
  return join(directory, "models_cache.json");
}
function writeCache(filename: string, models: unknown[]) {
  writeFileSync(filename, JSON.stringify({ models }));
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Codex model discovery", () => {
  it("imports new models and capacities without inheriting another model's pricing or endpoint", () => {
    const models = mergeOpenAICodexModels(bundled, { models: [
      { ...astra, baseUrl: "https://untrusted.invalid", headers: { Authorization: "untrusted" } },
      { ...astra, slug: "gpt-future-model", input_modalities: ["text"] },
    ] });
    const astraModel = models.find((model) => model.id === "gpt-6-astra");
    expect(astraModel).toMatchObject({
      id: "gpt-6-astra", name: "GPT-6-Astra", contextWindow: 272_000,
      maxTokens: 128_000, input: ["text", "image"],
      baseUrl: "https://chatgpt.com/backend-api", provider: "openai-codex",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { minimal: "low", medium: null, max: "max" },
    });
    expect(astraModel?.headers).toBeUndefined();
    expect(models.find((model) => model.id === "gpt-future-model"))
      .toMatchObject({ id: "gpt-future-model", input: ["text"] });
    expect(models.slice(0, bundled.length).map((model) => model.id))
      .toEqual(bundled.map((model) => model.id));
    expect(models.slice(bundled.length).map((model) => model.id))
      .toEqual(["gpt-6-astra", "gpt-future-model"]);
    expect(models.some(model => model.id === "gpt-5.4")).toBe(true);
  });

  it("ignores hidden, malformed, and duplicate entries and preserves known model prices", () => {
    const models = mergeOpenAICodexModels(bundled, { models: [
      null, { ...astra, slug: "hidden", visibility: "hide" },
      { ...astra, slug: "invalid", context_window: -1 },
      { ...astra, slug: "image-only", input_modalities: ["image"] },
      { ...astra, slug: "gpt-5.6-sol" },
      { ...astra, slug: "gpt-5.6-sol", context_window: 999 },
    ] });
    expect(models).toHaveLength(bundled.length);
    const sol = models.find((model) => model.id === "gpt-5.6-sol");
    expect(sol?.contextWindow).toBe(272_000);
    expect(sol?.cost).toEqual(bundled.find(model => model.id === "gpt-5.6-sol")?.cost);
  });

  it("keeps the curated model order and appends unknown cache entries stably", () => {
    const filename = cacheFile();
    vi.stubEnv("DSH_CODEX_MODELS_CACHE", filename);
    writeCache(filename, [
      astra,
      { ...astra, slug: "gpt-5.6-sol" },
      { ...astra, slug: "gpt-future-b" },
      { ...astra, slug: "gpt-5.6-terra" },
      { ...astra, slug: "gpt-5.6-luna" },
      { ...astra, slug: "gpt-5.5" },
      { ...astra, slug: "gpt-5.4-mini" },
      { ...astra, slug: "gpt-5.3-codex-spark", input_modalities: ["text"] },
      { ...astra, slug: "gpt-future-a" },
    ]);

    expect(createOpenAICodexModelProvider().getModels().map((model) => model.id))
      .toEqual([
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.3-codex-spark",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-future-b",
        "gpt-future-a",
      ]);
  });

  it("uses explicit cache paths before CODEX_HOME and the user default", () => {
    vi.stubEnv("DSH_CODEX_MODELS_CACHE", "");
    vi.stubEnv("CODEX_HOME", join(tmpdir(), "custom codex"));
    expect(openAICodexModelsCachePath()).toBe(join(tmpdir(), "custom codex", "models_cache.json"));
    vi.stubEnv("DSH_CODEX_MODELS_CACHE", join(tmpdir(), "custom cache.json"));
    expect(openAICodexModelsCachePath()).toBe(join(tmpdir(), "custom cache.json"));
  });

  it("reloads replacements while retaining the last usable snapshot during missing or corrupt writes", () => {
    const filename = cacheFile();
    const catalog = new OpenAICodexModelCatalog(bundled, filename);
    expect(catalog.getModels()).toBe(bundled);
    writeFileSync(filename, '\uFEFF' + JSON.stringify({ models: [astra] }));
    const first = catalog.getModels();
    expect(first.find((model) => model.id === "gpt-6-astra")?.contextWindow)
      .toBe(272_000);
    expect(catalog.getModels()).toBe(first);
    writeFileSync(filename, "{");
    expect(catalog.getModels()).toBe(first);
    writeCache(filename, []);
    expect(catalog.getModels()).toBe(first);
    rmSync(filename);
    expect(catalog.getModels()).toBe(first);
    writeCache(filename, [{ ...astra, context_window: 512_000 }]);
    expect(catalog.getModels().find((model) => model.id === "gpt-6-astra")?.contextWindow)
      .toBe(512_000);
    expect(first.find((model) => model.id === "gpt-6-astra")?.contextWindow)
      .toBe(272_000);
  });

  it("shares updates between settings and actual request resolution without changing prepared calls", async () => {
    const filename = cacheFile();
    vi.stubEnv("DSH_CODEX_MODELS_CACHE", filename);
    writeCache(filename, [astra]);
    const provider = createOpenAICodexModelProvider();
    const policy = new ImageToolPolicy(
      { models: ["gpt-6-astra", "gpt-future-model"] },
      () => openAICodexModelCatalog(provider)
    );
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore, () => undefined,
      () => ({ reasoningSummary: 'auto',  useWebSocketContextReuse: false, useNativeCompaction: false }),
      undefined, () => policy.modelCatalogSnapshot().models,
      undefined, undefined, undefined, undefined, undefined, provider
    );
    const first = await adapter.prepareCall("openai-codex", "gpt-6-astra");
    expect(first.model.context?.contextWindow).toBe(272_000);
    expect(policy.modelCatalogSnapshot().models).toEqual(["gpt-6-astra"]);
    writeCache(filename, [{ ...astra, context_window: 512_000 }, { ...astra, slug: "gpt-future-model" }]);
    expect(policy.modelCatalogSnapshot().models).toEqual(["gpt-6-astra", "gpt-future-model"]);
    expect((await adapter.listModels("openai-codex")).map(model => model.id)).toEqual(["gpt-6-astra", "gpt-future-model"]);
    expect((await adapter.resolveModel("openai-codex", "gpt-future-model")).context?.contextWindow).toBe(272_000);
    expect((await adapter.prepareCall("openai-codex", "gpt-6-astra")).model.context?.contextWindow).toBe(512_000);
    expect(first.model.context?.contextWindow).toBe(272_000);
  });
});
