import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type { OpenAICodexService } from "../src/service.ts";
import * as TuiAdapter from "../src/tui.ts";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

function fakeService(): OpenAICodexService {
  let imagePreferences = {
    modifyReadImage: true,
    shareImagegenWithOtherModels: true,
  };
  let responsePreferences = {
    useWebSocketContextReuse: false,
    useNativeCompaction: false,
  };
  let contextWindowPreferences = {
    contextWindow: null,
    overrideSparkContextWindow: false,
  };
  return {
    authStatus: vi.fn(async () => ({
      authenticated: true,
      expiresAt: new Date("2026-08-17T00:00:00Z"),
    })),
    usage: vi.fn(async () => ({
      rateLimits: [
        {
          id: "codex",
          name: "Codex",
          windows: [{ windowSeconds: 18_000, remainingPercent: 62.5 }],
        },
      ],
    })),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    imagePreferences: vi.fn(() => ({ ...imagePreferences })),
    updateImagePreferences: vi.fn(async (patch) => {
      imagePreferences = { ...imagePreferences, ...patch };
      return { ...imagePreferences };
    }),
    responsePreferences: vi.fn(() => ({ ...responsePreferences })),
    contextWindowPreferences: vi.fn(() => ({ ...contextWindowPreferences })),
    updateContextWindowPreferences: vi.fn(async (patch) => {
      contextWindowPreferences = { ...contextWindowPreferences, ...patch };
      return { ...contextWindowPreferences };
    }),
    modelCatalogSettings: vi.fn(() => ({
      models: ["gpt-5.6-luna"],
      availableModels: [
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          contextWindow: 128_000,
        },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
      ],
    })),
    updateResponsePreferences: vi.fn(async (patch) => {
      responsePreferences = { ...responsePreferences, ...patch };
      return { ...responsePreferences };
    }),
  } as unknown as OpenAICodexService;
}

async function command(ctx: Context): Promise<CommandDefinition> {
  const agent = { ctx } as never;
  const definition = ctx.commands.find(agent, "codex");
  if (definition === undefined) throw new Error("/codex was not registered");
  return definition;
}

describe("UI-neutral command with optional dsh-tui completion", () => {
  it("registers the command without requiring dsh-tui", async () => {
    const ctx = new Context();
    context = ctx;
    ctx.provide("openAICodex", fakeService());
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(TuiAdapter);

    expect(ctx.commands.list({ ctx } as never)).toEqual([
      expect.objectContaining({
        name: "codex",
        description: expect.stringContaining("OpenAI Codex"),
      }),
    ]);
    expect(ctx.get("openAICodexTui")).toBeUndefined();
  });

  it("registers one provider command when dsh-tui is present", async () => {
    const ctx = new Context();
    context = ctx;
    const service = fakeService();
    ctx.provide("openAICodex", service);
    let commandTree:
      | {
          descriptions?: Readonly<Partial<Record<"zh" | "en", string>>>;
          children(path: readonly string[]): readonly { name: string }[];
        }
      | undefined;
    ctx.provide("tuiCommandTrees", {
      register(provider: typeof commandTree & { root: string }) {
        commandTree = provider;
        return () => {
          commandTree = undefined;
        };
      },
    });
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(TuiAdapter);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const definition = await command(ctx);
    expect(definition.description).toContain("OpenAI Codex");
    if (commandTree === undefined)
      throw new Error("Codex command tree was not registered");
    expect(commandTree.descriptions?.zh).toBe(
      "管理 OpenAI Codex 账号与提供方设置"
    );
    expect(commandTree.children(["codex"]).map((item) => item.name)).toEqual([
      "status",
      "login",
      "logout",
      "usage",
      "config",
      "set",
    ]);
    expect(commandTree.children(["codex"])[0]).toMatchObject({
      descriptions: {
        en: "Show the ChatGPT sign-in state",
        zh: "查看 ChatGPT 登录状态",
      },
    });
    expect(
      commandTree.children(["codex", "set"]).map((item) => item.name)
    ).toEqual([
      "read-image",
      "imagegen-other-models",
      "websocket-context",
      "native-compaction",
      "spark-context-window",
    ]);
    expect(
      commandTree
        .children(["codex", "set", "native-compaction"])
        .map((item) => item.name)
    ).toEqual(["on", "off"]);
    await expect(
      definition.handler({ rawInput: " status" } as never)
    ).resolves.toEqual({
      kind: "success",
      text: "OpenAI Codex is signed in. Access token expires 2026-08-17T00:00:00.000Z; refresh is automatic.",
    });
    await expect(
      definition.handler({ rawInput: " usage" } as never)
    ).resolves.toEqual({
      kind: "success",
      text: "Codex (18000s): 62.5% remaining",
    });
    const config = await definition.handler({ rawInput: " config" } as never);
    expect(config).toMatchObject({
      kind: "success",
      text: expect.stringContaining("read-image: on"),
    });
    expect(config.text).toContain("spark-context-window: off");
    expect(config.text).toContain(
      [
        "model: GPT-5.3 Codex Spark",
        "  id: gpt-5.3-codex-spark",
        "  default-window: 128K tokens",
        "  enabled: off",
      ].join("\n")
    );
    expect(config.text).toContain(
      [
        "model: GPT-5.6 Luna",
        "  id: gpt-5.6-luna",
        "  default-window: 272K tokens",
        "  enabled: on",
      ].join("\n")
    );
    await expect(
      definition.handler({ rawInput: " set native-compaction on" } as never)
    ).resolves.toMatchObject({
      kind: "success",
      text: expect.stringContaining("native-compaction: on"),
    });
    expect(service.updateResponsePreferences).toHaveBeenCalledWith({
      useNativeCompaction: true,
    });
    await expect(
      definition.handler({ rawInput: " set spark-context-window on" } as never)
    ).resolves.toMatchObject({
      kind: "success",
      text: expect.stringContaining("spark-context-window: on"),
    });
    expect(service.updateContextWindowPreferences).toHaveBeenCalledWith({
      overrideSparkContextWindow: true,
    });
    expect(ctx.get("openAICodexTui")).toEqual({});
  });
});
