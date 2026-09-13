/** Backend-authorized model recovery at the Agent request boundary. */

import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  PreStepDecision,
  RequestErrorAction,
} from "@deepseek-ai/dsh-agent";
import {
  contentHasImage,
  QUOTA_EXCEEDED_CODE,
} from "@deepseek-ai/dsh-llm";
import type {
  LlmCallConfig,
  LlmResolvedModelInfo,
} from "@deepseek-ai/dsh-llm";
import { OPENAI_CODEX_LUNA_RESERVE_MODEL } from "./adapter.ts";
import type { OpenAICodexService } from "./service.ts";
import { OPENAI_CODEX_PROVIDER } from "./store.ts";
import type { OpenAICodexUsage } from "./usage.ts";

interface ImageRequirement {
  readonly turn: number;
  readonly step: number;
  readonly required: boolean;
}

interface ActiveFallback {
  readonly original: LlmCallConfig;
  readonly targetModel: string;
}

function sameRoute(left: LlmCallConfig, right: LlmCallConfig): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Recover Reserve's return route from ordinary request headers after restart. */
function reserveReturnConfig(agent: Agent): LlmCallConfig | undefined {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/header") continue;
    const config = record(record(event.data)?.["header"])?.["config"];
    const candidate = record(config);
    if (
      candidate?.["provider"] === OPENAI_CODEX_PROVIDER &&
      typeof candidate["model"] === "string" &&
      candidate["model"] !== OPENAI_CODEX_LUNA_RESERVE_MODEL
    ) {
      return structuredClone(candidate) as unknown as LlmCallConfig;
    }
  }
  return undefined;
}

/** Return the backend-ordered candidates for one exact blocked model. */
export function openAICodexFallbackCandidates(
  usage: OpenAICodexUsage | undefined,
  currentModel: string
): readonly string[] {
  const fallback = usage?.rateLimitUpsell;
  if (fallback === undefined) return [];
  if (fallback.kind === "luna-reserve") {
    if (
      currentModel === OPENAI_CODEX_LUNA_RESERVE_MODEL ||
      (fallback.blockedModelSlug !== undefined &&
        fallback.blockedModelSlug !== currentModel)
    ) {
      return [];
    }
    return [OPENAI_CODEX_LUNA_RESERVE_MODEL];
  }
  if (fallback.blockedModelSlug !== currentModel) return [];
  return fallback.fallbackModelSlugs.filter(
    (candidate) => candidate !== currentModel
  );
}

function supportsEffort(
  model: LlmResolvedModelInfo,
  effort: string
): boolean {
  return (
    model.reasoning?.efforts.some((candidate) => candidate.id === effort) ===
    true
  );
}

/** Apply one resolved fallback's exact capabilities to the next prepared call. */
function fallbackConfig(
  source: LlmCallConfig,
  model: LlmResolvedModelInfo
): LlmCallConfig {
  const requested = source.reasoningEffort;
  const reasoningEffort =
    requested !== undefined && supportsEffort(model, requested)
      ? requested
      : model.reasoning?.defaultEffort;
  const { reasoningEffort: _sourceEffort, ...base } = source;
  return {
    ...base,
    model: model.id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/** Resolve the first usable backend candidate without guessing a model route. */
export async function resolveOpenAICodexFallback(
  ctx: Context,
  usage: OpenAICodexUsage | undefined,
  source: LlmCallConfig,
  imageRequired: boolean,
  signal?: AbortSignal
): Promise<LlmCallConfig | undefined> {
  if (source.provider !== OPENAI_CODEX_PROVIDER) return undefined;
  for (const candidate of openAICodexFallbackCandidates(usage, source.model)) {
    let model: LlmResolvedModelInfo;
    try {
      model = await ctx.llm.resolveModelInfo(
        OPENAI_CODEX_PROVIDER,
        candidate,
        signal
      );
    } catch {
      continue;
    }
    if (
      imageRequired &&
      model.inputModalities?.includes("image") !== true
    ) {
      continue;
    }
    return fallbackConfig(source, model);
  }
  return undefined;
}

function requestNeedsImage(
  agent: Agent,
  decision: Extract<PreStepDecision, { kind: "enter" }>
): boolean {
  return [...agent.session.deriveMessages(), ...decision.messages].some(
    (message) => contentHasImage(message.content)
  );
}

/** Preserve image tools even before this exact request contains an image. */
async function mustPreserveImageCapability(
  ctx: Context,
  source: LlmCallConfig,
  requestContainsImage: boolean,
  signal?: AbortSignal
): Promise<boolean> {
  if (requestContainsImage) return true;
  try {
    const model = await ctx.llm.resolveModelInfo(
      source.provider,
      source.model,
      signal
    );
    return model.inputModalities?.includes("image") === true;
  } catch {
    // The normal prepared-call boundary will report an unresolvable source;
    // do not use fallback to weaken its declared capabilities first.
    return true;
  }
}

/**
 * Install account fallback around Agent routing, before DSH freezes an exact
 * prepared call. No stream is rewritten, so failures and actual model identity
 * remain visible to Harness retry and Session history.
 */
export function installOpenAICodexModelFallback(
  ctx: Context,
  service: OpenAICodexService
): () => void {
  const imageRequirements = new WeakMap<Agent, ImageRequirement>();
  const activeFallbacks = new WeakMap<Agent, ActiveFallback>();
  const disposePreStep = ctx.on(
    "agent/pre-step",
    async (payload, next): Promise<PreStepDecision> => {
      const decision = await next();
      if (
        decision.kind === "enter" &&
        service.modelFallbackPreferences().automaticModelFallback
      ) {
        imageRequirements.set(payload.agent, {
          turn: payload.turn,
          step: payload.step,
          required: requestNeedsImage(payload.agent, decision),
        });
      } else {
        imageRequirements.delete(payload.agent);
      }
      return decision;
    },
    { prepend: true }
  );
  const disposeRequest = ctx.on(
    "agent/request",
    async (payload, next): Promise<LlmCallConfig> => {
      const source = await next();
      if (source.provider !== OPENAI_CODEX_PROVIDER) {
        activeFallbacks.delete(payload.agent);
        return source;
      }
      if (!service.modelFallbackPreferences().automaticModelFallback) {
        const active = activeFallbacks.get(payload.agent);
        const original = active?.targetModel === source.model
          ? active.original
          : source.model === OPENAI_CODEX_LUNA_RESERVE_MODEL
            ? reserveReturnConfig(payload.agent)
            : undefined;
        activeFallbacks.delete(payload.agent);
        return original ?? source;
      }
      const requirement = imageRequirements.get(payload.agent);
      const requestContainsImage =
        requirement?.turn === payload.turn &&
        requirement.step === payload.step &&
        requirement.required;
      let active = activeFallbacks.get(payload.agent);
      if (
        active === undefined &&
        source.model === OPENAI_CODEX_LUNA_RESERVE_MODEL
      ) {
        const original = reserveReturnConfig(payload.agent);
        if (original !== undefined) {
          active = {
            original,
            targetModel: OPENAI_CODEX_LUNA_RESERVE_MODEL,
          };
          activeFallbacks.set(payload.agent, active);
        }
      }
      let usage = service.usageSnapshot();
      if (
        usage === undefined &&
        active !== undefined &&
        source.model === OPENAI_CODEX_LUNA_RESERVE_MODEL
      ) {
        // Match Codex's resume preflight: a hidden Reserve route must reconcile
        // account recovery before another user turn is sent after restart.
        try {
          usage = await service.usage();
        } catch {
          return source;
        }
      } else {
        // Keep recovery information fresh without adding usage-endpoint latency
        // to a healthy model request. A quota failure below forces and awaits it.
        void service.usage().catch(() => undefined);
      }
      let original = source;
      if (active !== undefined) {
        if (sameRoute(source, active.original)) {
          // Keep explicit effort and other user changes made on the original route.
          original = source;
        } else if (
          source.provider === active.original.provider &&
          source.model === active.targetModel
        ) {
          // Headless agents seed later requests from the last recorded header.
          original = active.original;
        } else {
          activeFallbacks.delete(payload.agent);
        }
      }
      const imageRequired = await mustPreserveImageCapability(
        ctx,
        original,
        requestContainsImage,
        payload.signal
      );
      const fallback = await resolveOpenAICodexFallback(
        ctx,
        usage,
        original,
        imageRequired,
        payload.signal
      );
      if (fallback === undefined) {
        if (active !== undefined && usage !== undefined) {
          activeFallbacks.delete(payload.agent);
          return original;
        }
        return source;
      }
      activeFallbacks.set(payload.agent, {
        original,
        targetModel: fallback.model,
      });
      return fallback;
    },
    { prepend: true }
  );
  const disposeError = ctx.on(
    "agent/request-error",
    async (payload, next): Promise<RequestErrorAction> => {
      if (
        !service.modelFallbackPreferences().automaticModelFallback ||
        payload.provider !== OPENAI_CODEX_PROVIDER ||
        payload.failure.code !== QUOTA_EXCEEDED_CODE
      ) {
        return await next();
      }
      const source = payload.agent.session.requestHeader()?.config;
      if (source?.provider !== OPENAI_CODEX_PROVIDER) return await next();
      const active = activeFallbacks.get(payload.agent);
      if (
        active !== undefined &&
        source.model === active.targetModel
      ) {
        return await next();
      }
      let usage: OpenAICodexUsage;
      try {
        usage = await service.usage(true);
      } catch {
        return await next();
      }
      const requirement = imageRequirements.get(payload.agent);
      const requestContainsImage =
        requirement?.turn === payload.turn &&
        requirement.step === payload.step &&
        requirement.required;
      const imageRequired = await mustPreserveImageCapability(
        ctx,
        source,
        requestContainsImage,
        payload.signal
      );
      const fallback = await resolveOpenAICodexFallback(
        ctx,
        usage,
        source,
        imageRequired,
        payload.signal
      );
      if (fallback === undefined) return await next();
      activeFallbacks.set(payload.agent, {
        original: source,
        targetModel: fallback.model,
      });
      return { kind: "retry" };
    },
    { prepend: true }
  );
  return () => {
    disposeError();
    disposeRequest();
    disposePreStep();
  };
}
