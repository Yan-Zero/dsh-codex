import { Context } from "@deepseek-ai/cordis";
import { agentEvents } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { LlmCallConfig, LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_CODEX_LUNA_RESERVE_MODEL } from "../src/adapter.ts";
import {
  openAICodexFallbackCandidates,
  installOpenAICodexModelFallback,
  resolveOpenAICodexFallback,
} from "../src/model-fallback.ts";
import type { OpenAICodexService } from "../src/service.ts";
import { OPENAI_CODEX_PROVIDER } from "../src/store.ts";
import type { OpenAICodexUsage } from "../src/usage.ts";

function usage(
  rateLimitUpsell: OpenAICodexUsage["rateLimitUpsell"]
): OpenAICodexUsage {
  return {
    rateLimits: [],
    ...(rateLimitUpsell === undefined ? {} : { rateLimitUpsell }),
  };
}

function model(
  id: string,
  inputModalities: readonly ("text" | "image")[] = ["text", "image"],
  efforts: readonly string[] = ["low", "medium"]
): LlmResolvedModelInfo {
  return {
    provider: OPENAI_CODEX_PROVIDER,
    id,
    name: id,
    inputModalities: [...inputModalities],
    reasoning: {
      efforts: efforts.map((effort) => ({ id: effort, name: effort })),
      defaultEffort: efforts[0],
    },
  } as unknown as LlmResolvedModelInfo;
}

describe("backend-authorized model fallback", () => {
  it("distinguishes Luna Reserve from an ordered ordinary recovery", () => {
    expect(
      openAICodexFallbackCandidates(
        usage({ kind: "luna-reserve" }),
        "gpt-5.6-sol"
      )
    ).toEqual([OPENAI_CODEX_LUNA_RESERVE_MODEL]);
    expect(
      openAICodexFallbackCandidates(
        usage({
          kind: "model-recovery",
          blockedModelSlug: "gpt-5.6-sol",
          fallbackModelSlugs: [
            "missing",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
          ],
        }),
        "gpt-5.6-sol"
      )
    ).toEqual(["missing", "gpt-5.6-terra"]);
    expect(
      openAICodexFallbackCandidates(
        usage({ kind: "luna-reserve", blockedModelSlug: "gpt-5.6-sol" }),
        "gpt-5.6-luna"
      )
    ).toEqual([]);
  });

  it("skips unknown and text-only candidates for an image-bearing request", async () => {
    const resolveModelInfo = vi.fn(async (_provider: string, id: string) => {
      if (id === "missing") throw new Error("unknown model");
      if (id === "text-only") return model(id, ["text"]);
      return model(id, ["text", "image"], ["medium"]);
    });
    const ctx = { llm: { resolveModelInfo } } as unknown as Context;
    const selected = await resolveOpenAICodexFallback(
      ctx,
      usage({
        kind: "model-recovery",
        blockedModelSlug: "gpt-5.6-sol",
        fallbackModelSlugs: ["missing", "text-only", "vision"],
      }),
      {
        provider: OPENAI_CODEX_PROVIDER,
        model: "gpt-5.6-sol",
        reasoningEffort: "high" as never,
      },
      true
    );

    expect(selected).toEqual({
      provider: OPENAI_CODEX_PROVIDER,
      model: "vision",
      reasoningEffort: "medium",
    });
    expect(resolveModelInfo.mock.calls.map((call) => call[1])).toEqual([
      "missing",
      "text-only",
      "vision",
    ]);
  });

  it("preserves a compatible effort and refuses unrelated provider routes", async () => {
    const ctx = {
      llm: { resolveModelInfo: vi.fn(async () => model("gpt-5.6-terra")) },
    } as unknown as Context;
    const fallbackUsage = usage({
      kind: "model-recovery",
      blockedModelSlug: "gpt-5.6-sol",
      fallbackModelSlugs: ["gpt-5.6-terra"],
    });

    await expect(
      resolveOpenAICodexFallback(
        ctx,
        fallbackUsage,
        {
          provider: OPENAI_CODEX_PROVIDER,
          model: "gpt-5.6-sol",
          reasoningEffort: "medium" as never,
        },
        false
      )
    ).resolves.toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    await expect(
      resolveOpenAICodexFallback(
        ctx,
        fallbackUsage,
        { provider: "another-provider", model: "model" },
        false
      )
    ).resolves.toBeUndefined();
  });

  it("switches before prepared-call resolution and owns a retry only for a resolved quota fallback", async () => {
    const ctx = new Context();
    const resolveModelInfo = vi.fn(async (_provider: string, id: string) => model(id));
    ctx.provide("llm", { resolveModelInfo } as never);
    let snapshot: OpenAICodexUsage | undefined;
    const forced = usage({
      kind: "model-recovery",
      blockedModelSlug: "gpt-5.6-sol",
      fallbackModelSlugs: ["gpt-5.6-terra"],
    });
    const service = {
      modelFallbackPreferences: () => ({ automaticModelFallback: true }),
      usageSnapshot: () => snapshot,
      usage: vi.fn(async (forceRefresh?: boolean) => {
        if (forceRefresh) snapshot = forced;
        return snapshot ?? { rateLimits: [] };
      }),
    } as unknown as OpenAICodexService;
    const dispose = installOpenAICodexModelFallback(ctx, service);
    const source: LlmCallConfig = {
      provider: OPENAI_CODEX_PROVIDER,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium" as never,
    };
    let requestHeader = source;
    const agent = {
      id: "session" as never,
      ctx,
      options: source,
      session: {
        deriveMessages: () => [],
        requestHeader: () => ({ config: requestHeader }),
      },
    } as unknown as Agent;
    const events = agentEvents(ctx, agent);
    const signal = new AbortController().signal;

    await events.waterfall(
      "agent/pre-step",
      { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: "enter", messages: [] })
    );
    await expect(
      events.waterfall(
        "agent/request-error",
        {
          turn: 1,
          step: 1,
          provider: OPENAI_CODEX_PROVIDER,
          failure: { code: "QUOTA", message: "usage exhausted" },
          retryPolicy: undefined,
          signal,
        },
        () => Promise.resolve(undefined)
      )
    ).resolves.toEqual({ kind: "retry" });
    await expect(
      events.waterfall(
        "agent/request",
        { turn: 1, step: 1, signal },
        () => Promise.resolve(source)
      )
    ).resolves.toMatchObject({
      provider: OPENAI_CODEX_PROVIDER,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    expect(service.usage).toHaveBeenCalledWith(true);

    requestHeader = { ...source, model: "gpt-5.6-terra" };
    const delegatedFallbackFailure = vi.fn(async () => undefined);
    await expect(
      events.waterfall(
        "agent/request-error",
        {
          turn: 1,
          step: 1,
          provider: OPENAI_CODEX_PROVIDER,
          failure: { code: "QUOTA", message: "fallback also exhausted" },
          retryPolicy: undefined,
          signal,
        },
        delegatedFallbackFailure
      )
    ).resolves.toBeUndefined();
    expect(delegatedFallbackFailure).toHaveBeenCalledOnce();

    snapshot = { rateLimits: [] };
    await expect(
      events.waterfall(
        "agent/request",
        { turn: 2, step: 1, signal },
        () => Promise.resolve({
          ...source,
          model: "gpt-5.6-terra",
        })
      )
    ).resolves.toEqual(source);

    dispose();
    await ctx.fiber.dispose();
  });

  it("preserves the original failure path when recovery is disabled or unresolved", async () => {
    const ctx = new Context();
    ctx.provide("llm", {
      resolveModelInfo: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    } as never);
    let enabled = false;
    const service = {
      modelFallbackPreferences: () => ({ automaticModelFallback: enabled }),
      usageSnapshot: () => undefined,
      usage: vi.fn(async () => usage({
        kind: "model-recovery",
        blockedModelSlug: "gpt-5.6-sol",
        fallbackModelSlugs: ["missing"],
      })),
    } as unknown as OpenAICodexService;
    const dispose = installOpenAICodexModelFallback(ctx, service);
    const source = { provider: OPENAI_CODEX_PROVIDER, model: "gpt-5.6-sol" };
    const agent = {
      id: "session" as never,
      ctx,
      options: source,
      session: {
        deriveMessages: () => [],
        requestHeader: () => ({ config: source }),
      },
    } as unknown as Agent;
    const events = agentEvents(ctx, agent);
    const signal = new AbortController().signal;
    const delegated = vi.fn(async () => undefined);
    const failure = {
      turn: 1,
      step: 1,
      provider: OPENAI_CODEX_PROVIDER,
      failure: { code: "QUOTA", message: "original quota error" },
      retryPolicy: undefined,
      signal,
    } as const;

    await expect(
      events.waterfall("agent/request-error", failure, delegated)
    ).resolves.toBeUndefined();
    expect(delegated).toHaveBeenCalledOnce();
    expect(service.usage).not.toHaveBeenCalled();

    enabled = true;
    delegated.mockClear();
    await expect(
      events.waterfall("agent/request-error", failure, delegated)
    ).resolves.toBeUndefined();
    expect(delegated).toHaveBeenCalledOnce();
    expect(service.usage).toHaveBeenCalledWith(true);

    dispose();
    await ctx.fiber.dispose();
  });

  it("restores the pre-Reserve route from standard request headers when disabled after restart", async () => {
    const ctx = new Context();
    ctx.provide("llm", { resolveModelInfo: vi.fn() } as never);
    const service = {
      modelFallbackPreferences: () => ({ automaticModelFallback: false }),
      usageSnapshot: () => undefined,
      usage: vi.fn(async () => ({ rateLimits: [] })),
    } as unknown as OpenAICodexService;
    const dispose = installOpenAICodexModelFallback(ctx, service);
    const original = {
      provider: OPENAI_CODEX_PROVIDER,
      model: "gpt-5.6-sol",
      reasoningEffort: "medium" as never,
    };
    const reserve = {
      provider: OPENAI_CODEX_PROVIDER,
      model: OPENAI_CODEX_LUNA_RESERVE_MODEL,
      reasoningEffort: "medium" as never,
    };
    const agent = {
      id: "resumed" as never,
      ctx,
      options: original,
      session: {
        snapshotEvents: () => [
          { type: "request/header", data: { header: { config: original } } },
          { type: "request/header", data: { header: { config: reserve } } },
        ],
        deriveMessages: () => [],
        requestHeader: () => ({ config: reserve }),
      },
    } as unknown as Agent;
    const signal = new AbortController().signal;

    await expect(
      agentEvents(ctx, agent).waterfall(
        "agent/request",
        { turn: 2, step: 1, signal },
        () => Promise.resolve(reserve)
      )
    ).resolves.toEqual(original);

    dispose();
    await ctx.fiber.dispose();
  });
});
