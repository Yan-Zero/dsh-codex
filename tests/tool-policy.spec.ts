import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SettingsProvider } from "@deepseek-ai/dsh-settings";
import type { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { ImageToolPolicy } from "../src/tool-policy.ts";

class MemorySettings extends SettingsProvider {
  readonly writable = true;
  private stored: Record<string, unknown> = {};

  seed(stored: Record<string, unknown>): void {
    this.stored = structuredClone(stored);
    this.publish(this.stored);
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored));
  }

  protected async persist(
    ns: SettingsNamespace,
    section: Record<string, unknown>
  ): Promise<void> {
    this.stored = { ...this.stored, [String(ns)]: structuredClone(section) };
    this.publish(this.stored);
  }
}

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

describe("ImageToolPolicy", () => {
  it("persists independent live toggles through the dsh settings seam", async () => {
    const ctx = new Context();
    context = ctx;
    await ctx.plugin(MemorySettings);
    const policy = new ImageToolPolicy();
    policy.attach(ctx);

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: true,
    });
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: false,
    });
    expect(policy.contextWindowSnapshot()).toEqual({
      contextWindow: null,
      overrideSparkContextWindow: false,
    });

    await policy.update({ shareImagegenWithOtherModels: false });
    await policy.updateResponseApi({ useNativeCompaction: true });
    await policy.updateContextWindow({
      contextWindow: 512_000,
      overrideSparkContextWindow: true,
    });

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
    });
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: true,
    });
    expect(policy.contextWindowSnapshot()).toEqual({
      contextWindow: 512_000,
      overrideSparkContextWindow: true,
    });
  });

  it("notifies the read_image enhancer when its live setting changes", async () => {
    const ctx = new Context();
    context = ctx;
    await ctx.plugin(MemorySettings);
    const policy = new ImageToolPolicy({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
    });
    policy.attach(ctx);
    let changes = 0;
    policy.watchImagePreferences(() => {
      changes++;
    });

    await policy.update({ modifyReadImage: false });

    expect(policy.snapshot().modifyReadImage).toBe(false);
    expect(changes).toBe(1);
  });

  it("migrates the retired store:true preference to WebSocket context reuse", () => {
    const policy = new ImageToolPolicy({ useStatefulResponses: true });

    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: true,
      useNativeCompaction: false,
    });
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
    const ctx = new Context();
    context = ctx;
    await ctx.plugin(MemorySettings);
    const policy = new ImageToolPolicy(
      { models: ["gpt-5.6-terra", "gpt-5.6-luna"] },
      [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272_000 },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 272_000 },
      ]
    );
    policy.attach(ctx);

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

  it("defaults an older partial settings document to the complete model catalog", async () => {
    const ctx = new Context();
    context = ctx;
    await ctx.plugin(MemorySettings);
    const settings = ctx.settings as MemorySettings;
    settings.seed({
      "openai-codex": { useNativeCompaction: true },
    });
    const policy = new ImageToolPolicy({}, [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272_000 },
    ]);

    policy.attach(ctx);

    expect(policy.modelCatalogSnapshot().models).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-sol",
    ]);
    expect(policy.responseApiSnapshot().useNativeCompaction).toBe(true);
    expect(policy.contextWindowSnapshot()).toEqual({
      contextWindow: null,
      overrideSparkContextWindow: false,
    });
  });
});
