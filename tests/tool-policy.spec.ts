import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { ImageToolPolicy } from "../src/tool-policy.ts";

class MemorySettings {
  private stored: Record<string, unknown> = {};

  configure(): () => void {
    return () => {};
  }

  async update(ns: string, section: Record<string, unknown>): Promise<void> {
    this.stored = { ...this.stored, [String(ns)]: structuredClone(section) };
  }
}

function attach(policy: ImageToolPolicy): Context {
  const ctx = new Context();
  ctx.provide("settings", new MemorySettings() as never);
  policy.attach(ctx, "llm-openai-codex", ctx.fiber);
  return ctx;
}

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

describe("ImageToolPolicy", () => {
  it("persists independent live toggles through the dsh settings seam", async () => {
    const policy = new ImageToolPolicy();
    context = attach(policy);

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: true,
      imageGenerationModel: "gpt-image-2",
    });
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: false,
    });
    expect(policy.contextWindowSnapshot()).toEqual({
      contextWindow: null,
    });
    expect(policy.fastModeSnapshot()).toEqual({ fastModeDefault: false });
    expect(policy.modelFallbackSnapshot()).toEqual({
      automaticModelFallback: false,
    });
    expect(policy.proxySnapshot()).toEqual({
      proxyMode: "off",
      proxyUrl: "",
    });

    await policy.update({
      shareImagegenWithOtherModels: false,
      imageGenerationModel: "gpt-image-2.5-flare",
    });
    await policy.updateResponseApi({ useNativeCompaction: true });
    await policy.updateContextWindow({
      contextWindow: 512_000,
    });
    await policy.updateFastMode({ fastModeDefault: true });
    await policy.updateModelFallback({ automaticModelFallback: true });
    await policy.updateProxy({
      proxyMode: "scoped",
      proxyUrl: "http://127.0.0.1:7890",
    });

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
      imageGenerationModel: "gpt-image-2.5-flare",
    });
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: true,
    });
    expect(policy.contextWindowSnapshot()).toEqual({
      contextWindow: 512_000,
    });
    expect(policy.fastModeSnapshot()).toEqual({ fastModeDefault: true });
    expect(policy.modelFallbackSnapshot()).toEqual({
      automaticModelFallback: true,
    });
    expect(policy.proxySnapshot()).toEqual({
      proxyMode: "scoped",
      proxyUrl: "http://127.0.0.1:7890",
    });
  });

  it("notifies the read_image enhancer when its live setting changes", async () => {
    const policy = new ImageToolPolicy({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
    });
    context = attach(policy);
    let changes = 0;
    policy.watchImagePreferences(() => {
      changes++;
    });

    await policy.update({ modifyReadImage: false });

    expect(policy.snapshot().modifyReadImage).toBe(false);
    expect(changes).toBe(1);
  });

  it("keeps Codex imagegen access while applying its toggle to another provider", () => {
    const policy = new ImageToolPolicy({ shareImagegenWithOtherModels: false });
    const execution = (provider: string) =>
      ({
        agent: {
          options: {},
          session: {
            requestHeader: () => ({
              config: { provider, model: "vision-model" },
            }),
          },
        },
      }) as never;

    expect(() =>
      policy.assertAllowed(execution("openai-codex"), "imagegen")
    ).not.toThrow();
    expect(() =>
      policy.assertAllowed(execution("another-provider"), "imagegen")
    ).toThrow("disabled for models outside");
  });

  it("persists a provider-ordered model discovery subset without affecting the full catalog", async () => {
    const policy = new ImageToolPolicy(
      { models: ["gpt-5.6-terra", "gpt-5.6-luna"] },
      [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272_000 },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 272_000 },
      ]
    );
    context = attach(policy);

    expect(policy.modelCatalogSnapshot()).toEqual({
      availableModels: [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272_000 },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 272_000 },
      ],
      models: ["gpt-5.6-luna", "gpt-5.6-terra"],
    });

    await policy.updateModelCatalog({ models: ["gpt-5.6-sol"] });
    expect(policy.modelCatalogSnapshot().models).toEqual(["gpt-5.6-sol"]);
  });

  it("preserves selected model ids while they are temporarily unavailable", async () => {
    let catalog = [
      { id: "gpt-current", name: "GPT Current", contextWindow: 272_000 },
    ];
    const policy = new ImageToolPolicy(
      { models: ["gpt-current", "gpt-future"] },
      () => catalog
    );
    context = attach(policy);

    expect(policy.modelCatalogSnapshot().models).toEqual(["gpt-current"]);
    await policy.updateModelCatalog({ models: [] });
    expect(policy.modelCatalogSnapshot().models).toEqual([]);

    catalog = [
      ...catalog,
      { id: "gpt-future", name: "GPT Future", contextWindow: 272_000 },
    ];
    expect(policy.modelCatalogSnapshot().models).toEqual(["gpt-future"]);
  });

  it("validates proxy URLs before persisting them", async () => {
    const policy = new ImageToolPolicy();
    context = attach(policy);

    await expect(
      policy.updateProxy({ proxyUrl: "socks5://127.0.0.1:1080" })
    ).rejects.toThrow("http:// or https://");
    expect(policy.proxySnapshot()).toEqual({ proxyMode: "off", proxyUrl: "" });
  });
});
