import { describe, expect, it, vi } from "vitest";
import type {
  AttachmentStore,
  ImageAttachmentRef,
} from "@deepseek-ai/dsh-attachment";
import type { OpenAICodexCredentialStore } from "../src/store.ts";
import { OPENAI_CODEX_PROVIDER } from "../src/store.ts";
import {
  createOpenAICodexAdapter,
  createOpenAICodexModelProvider,
  openAICodexModelCatalog,
  OPENAI_CODEX_HIGH_DETAIL_MAX_PATCHES,
  OPENAI_CODEX_HIGH_DETAIL_MAX_DIMENSION,
  OPENAI_CODEX_IMAGE_PATCH_SIZE,
  OPENAI_CODEX_LUNA_RESERVE_MODEL,
  OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES,
  OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET,
  OPENAI_CODEX_RETRY_POLICY,
  openAICodexRequestImagePixelBudget,
  withCurrentOpenAICodexModels,
} from "../src/adapter.ts";
import { Config } from "../src/index.ts";

describe("OpenAI Codex adapter policy", () => {
  it("validates optional catalog and context-window configuration", () => {
    expect(Config({}).models).toBeUndefined();
    expect(Config({}).contextWindow).toBeUndefined();
    expect(Config({}).overrideSparkContextWindow).toBe(false);
    expect(Config({}).automaticModelFallback).toBe(false);
    expect(Config({}).proxyMode).toBe("off");
    expect(Config({}).proxyUrl).toBe("");
    expect(
      Config({
        models: [],
        contextWindow: 512_000,
        overrideSparkContextWindow: true,
      })
    ).toMatchObject({
      models: [],
      contextWindow: 512_000,
      overrideSparkContextWindow: true,
    });
    expect(() => Config({ contextWindow: 0 })).toThrow();
    expect(() => Config({ proxyMode: "sometimes" as never })).toThrow();
  });

  it("supplies the complete request-image policy required by current DSH runtimes", () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false })
    );
    const profile = (
      adapter as unknown as {
        config: { profiles: () => Map<string, Record<string, unknown>> };
      }
    ).config
      .profiles()
      .get(OPENAI_CODEX_PROVIDER);

    expect(profile).toMatchObject({
      maxRequestImageBytes: OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES,
      requestImagePixelBudget: OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET,
      requestImageMaxBytes: OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES,
    });
    expect(OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET).toBe(
      OPENAI_CODEX_HIGH_DETAIL_MAX_PATCHES * OPENAI_CODEX_IMAGE_PATCH_SIZE ** 2
    );
  });

  it("combines the Codex longest-edge and rounded patch-grid image limits", () => {
    const cases: readonly {
      source: readonly [number, number];
      expected?: readonly [number, number];
    }[] = [
      { source: [2048, 2048], expected: [1600, 1600] },
      { source: [8192, 512], expected: [2048, 128] },
      { source: [1599, 1601] },
      { source: [1200, 800], expected: [1200, 800] },
    ];

    for (const { source, expected } of cases) {
      const [width, height] = source;
      const budget = openAICodexRequestImagePixelBudget(
        width,
        height,
        OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET
      );
      const scale = Math.min(1, Math.sqrt(budget / (width * height)));
      const projectedWidth =
        width >= height
          ? Math.max(1, Math.floor(width * scale))
          : Math.max(
              1,
              Math.round(
                (Math.max(1, Math.floor(height * scale)) * width) / height
              )
            );
      const projectedHeight =
        width >= height
          ? Math.max(1, Math.round((projectedWidth * height) / width))
          : Math.max(1, Math.floor(height * scale));
      expect(projectedWidth).toBeLessThanOrEqual(
        OPENAI_CODEX_HIGH_DETAIL_MAX_DIMENSION
      );
      expect(projectedHeight).toBeLessThanOrEqual(
        OPENAI_CODEX_HIGH_DETAIL_MAX_DIMENSION
      );
      expect(
        Math.ceil(projectedWidth / OPENAI_CODEX_IMAGE_PATCH_SIZE) *
          Math.ceil(projectedHeight / OPENAI_CODEX_IMAGE_PATCH_SIZE)
      ).toBeLessThanOrEqual(OPENAI_CODEX_HIGH_DETAIL_MAX_PATCHES);
      if (expected !== undefined)
        expect([projectedWidth, projectedHeight]).toEqual(expected);
    }
  });

  it("applies the Codex dimension projection at the attachment-store boundary", async () => {
    const readImageRequest = vi.fn().mockResolvedValue({});
    const store = { readImageRequest } as unknown as AttachmentStore;
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => store,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false })
    );
    const resolved = (
      adapter as unknown as {
        config: { resolveAttachments: () => AttachmentStore | undefined };
      }
    ).config.resolveAttachments();
    const ref = { width: 8192, height: 512 } as ImageAttachmentRef;

    await resolved?.readImageRequest(ref, {
      maxPixels: OPENAI_CODEX_REQUEST_IMAGE_PIXEL_BUDGET,
      maxBytes: OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES,
    });

    expect(readImageRequest).toHaveBeenCalledWith(
      ref,
      {
        maxPixels: 2048 * 128,
        maxBytes: OPENAI_CODEX_PROMPT_IMAGE_INPUT_GUARD_BYTES,
      },
      undefined
    );
  });

  it("registers the extended bounded retry policy on the provider route", () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false })
    );

    expect(adapter.providerRetryPolicy(OPENAI_CODEX_PROVIDER)).toBe(
      OPENAI_CODEX_RETRY_POLICY
    );
    expect(OPENAI_CODEX_RETRY_POLICY).toMatchObject({
      mode: "normal",
      maxRetries: 5,
      retryableCodes: expect.arrayContaining([
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
      ]),
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.2,
    });
  });

  it("advertises only configured models while keeping hidden models resolvable", async () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
      undefined,
      () => ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-terra"]
    );

    const models = await adapter.listModels(OPENAI_CODEX_PROVIDER);
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);

    await expect(
      adapter.resolveModel(OPENAI_CODEX_PROVIDER, "gpt-5.4")
    ).resolves.toMatchObject({
      provider: OPENAI_CODEX_PROVIDER,
      id: "gpt-5.4",
    });
  });

  it("keeps Luna Reserve hidden while borrowing Luna's image and reasoning capabilities", async () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false })
    );

    expect(
      (await adapter.listModels(OPENAI_CODEX_PROVIDER)).some(
        (model) => model.id === OPENAI_CODEX_LUNA_RESERVE_MODEL
      )
    ).toBe(false);
    const [luna, reserve] = await Promise.all([
      adapter.resolveModel(OPENAI_CODEX_PROVIDER, "gpt-5.6-luna"),
      adapter.resolveModel(
        OPENAI_CODEX_PROVIDER,
        OPENAI_CODEX_LUNA_RESERVE_MODEL
      ),
    ]);
    expect(reserve).toMatchObject({
      id: OPENAI_CODEX_LUNA_RESERVE_MODEL,
      name: "Luna Reserve",
      inputModalities: expect.arrayContaining(["text", "image"]),
      context: luna.context,
      reasoning: luna.reasoning,
    });
    expect(openAICodexModelCatalog().some(
      (model) => model.id === OPENAI_CODEX_LUNA_RESERVE_MODEL
    )).toBe(false);
  });

  it("rotates snapshot-consistent profiles when the client-side capacity changes", async () => {
    let contextWindow: number | null = null;
    let overrideSparkContextWindow = false;
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
      undefined,
      undefined,
      () => contextWindow,
      () => overrideSparkContextWindow
    );

    const profileLoader = (
      adapter as unknown as {
        config: {
          profiles(): Map<
            string,
            {
              piProvider: {
                getModels(): readonly { id: string; contextWindow: number }[];
              };
            }
          >;
        };
      }
    ).config.profiles;
    const firstProfiles = profileLoader();
    await expect(
      adapter.resolveModel(OPENAI_CODEX_PROVIDER, "gpt-5.6-sol")
    ).resolves.toMatchObject({
      context: { contextWindow: 272_000 },
    });

    contextWindow = 512_000;
    const secondProfiles = profileLoader();
    expect(secondProfiles).not.toBe(firstProfiles);
    expect(profileLoader()).toBe(secondProfiles);
    expect(
      firstProfiles
        .get(OPENAI_CODEX_PROVIDER)
        ?.piProvider.getModels()
        .find((model) => model.id === "gpt-5.6-sol")
    ).toMatchObject({
      contextWindow: 272_000,
    });
    expect(
      secondProfiles
        .get(OPENAI_CODEX_PROVIDER)
        ?.piProvider.getModels()
        .find((model) => model.id === "gpt-5.6-sol")
    ).toMatchObject({
      contextWindow: 512_000,
    });
    await expect(
      adapter.resolveModel(OPENAI_CODEX_PROVIDER, "gpt-5.6-sol")
    ).resolves.toMatchObject({
      context: { contextWindow: 512_000 },
    });
    await expect(
      adapter.resolveModel(OPENAI_CODEX_PROVIDER, "gpt-5.3-codex-spark")
    ).resolves.toMatchObject({
      context: { contextWindow: 128_000 },
    });
    await expect(
      adapter.resolveModel(
        OPENAI_CODEX_PROVIDER,
        OPENAI_CODEX_LUNA_RESERVE_MODEL
      )
    ).resolves.toMatchObject({
      context: { contextWindow: 272_000 },
    });

    overrideSparkContextWindow = true;
    const thirdProfiles = profileLoader();
    expect(thirdProfiles).not.toBe(secondProfiles);
    await expect(
      adapter.resolveModel(OPENAI_CODEX_PROVIDER, "gpt-5.3-codex-spark")
    ).resolves.toMatchObject({
      context: { contextWindow: 512_000 },
    });
  });

  it("projects provider context capacities into the settings catalog", () => {
    const catalog = openAICodexModelCatalog();
    expect(catalog.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.3-codex-spark",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(catalog.find((model) => model.id === "gpt-6-astra")).toMatchObject({
      name: "GPT-6 Astra",
      contextWindow: 272_000,
    });
    expect(catalog.find((model) => model.id === "gpt-6-sol")).toMatchObject({
      name: "GPT-6 Sol",
      contextWindow: 272_000,
    });
    expect(catalog.find((model) => model.id === "gpt-6-luna")).toMatchObject({
      name: "GPT-6 Luna",
      contextWindow: 272_000,
    });
    const models = createOpenAICodexModelProvider().getModels();
    expect(models.find((model) => model.id === "gpt-6-sol")).toMatchObject({
      maxTokens: 128_000,
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      thinkingLevelMap: { off: "none", low: "low", max: "max" },
    });
    expect(models.find((model) => model.id === "gpt-6-luna")).toMatchObject({
      maxTokens: 128_000,
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      thinkingLevelMap: { off: "none", low: "low", max: "max" },
    });
  });

  it("uses the current generation as a fallback when legacy templates disappear", () => {
    const current = createOpenAICodexModelProvider();
    const astra = current.getModels().find((model) => model.id === "gpt-6-astra");
    expect(astra).toBeDefined();
    const supplemented = withCurrentOpenAICodexModels({
      ...current,
      getModels: () => astra === undefined ? [] : [astra],
    }).getModels();

    expect(supplemented.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(withCurrentOpenAICodexModels({ ...current, getModels: () => [] }).getModels())
      .toEqual([]);
  });

  it("keeps authoritative catalog entries when pi-ai gains the current models", () => {
    const current = createOpenAICodexModelProvider();
    const models = current.getModels().map((model) =>
      model.id === "gpt-6-sol" ? { ...model, name: "Upstream GPT-6 Sol" } : model
    );
    const supplemented = withCurrentOpenAICodexModels({
      ...current,
      getModels: () => models,
    }).getModels();

    expect(supplemented.filter((model) => model.id === "gpt-6-sol")).toHaveLength(1);
    expect(supplemented.find((model) => model.id === "gpt-6-sol")?.name)
      .toBe("Upstream GPT-6 Sol");
  });

  it("advertises the full provider catalog when no model list is configured", async () => {
    const adapter = createOpenAICodexAdapter(
      {} as OpenAICodexCredentialStore,
      () => undefined,
      () => ({ useWebSocketContextReuse: false, useNativeCompaction: false })
    );

    const models = await adapter.listModels(OPENAI_CODEX_PROVIDER);
    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-5.4",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
      ])
    );
  });
});
