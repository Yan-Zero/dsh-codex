// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICodexSettings } from "../src/client/OpenAICodexSettings.tsx";
import { en } from "../src/client/locales.ts";
import type { OpenAICodexSettingsKey } from "../src/client/locales.ts";

function t(
  key: OpenAICodexSettingsKey,
  params: Record<string, unknown> = {}
): string {
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key]
  );
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAI Codex settings model catalog", () => {
  it("renders model toggles and persists the provider-ordered visible subset", async () => {
    const availableModels = [
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        contextWindow: 128_000,
      },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272_000 },
    ];
    let selected = availableModels.slice(1).map((model) => model.id);
    let contextWindow: number | null = null;
    let overrideSparkContextWindow = false;
    const fetchMock = vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit
      ): Promise<Response> => {
        const path = String(input);
        if (path.endsWith("/auth/status"))
          return json({ status: "signed-out" });
        if (path.endsWith("/image-tools"))
          return json({
            modifyReadImage: true,
            shareImagegenWithOtherModels: true,
          });
        if (path.endsWith("/response-api"))
          return json({
            useWebSocketContextReuse: false,
            useNativeCompaction: false,
          });
        if (path.endsWith("/context-window")) {
          if (init?.method === "POST") {
            const patch = JSON.parse(String(init.body)) as Partial<{
              contextWindow: number | null;
              overrideSparkContextWindow: boolean;
            }>;
            if (patch.contextWindow !== undefined)
              contextWindow = patch.contextWindow;
            if (patch.overrideSparkContextWindow !== undefined)
              overrideSparkContextWindow = patch.overrideSparkContextWindow;
          }
          return json({ contextWindow, overrideSparkContextWindow });
        }
        if (path.endsWith("/models")) {
          if (init?.method === "POST")
            selected = (JSON.parse(String(init.body)) as { models: string[] })
              .models;
          return json({ availableModels, models: selected });
        }
        throw new Error(`unexpected settings request: ${path}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<OpenAICodexSettings t={t} />);
    const luna = await screen.findByRole<HTMLButtonElement>("switch", {
      name: /GPT-5\.6 Luna/u,
    });
    const sol = screen.getByRole<HTMLButtonElement>("switch", {
      name: /GPT-5\.6 Sol/u,
    });
    expect(
      screen.getByRole("group", { name: "GPT-5.3 Codex Spark" }).textContent
    ).toContain("Default window:128K tokens");
    expect(
      screen.getByRole("group", { name: "GPT-5.6 Luna" }).textContent
    ).toContain("Default window:272K tokens");
    expect(luna.getAttribute("aria-checked")).toBe("true");
    expect(sol.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(luna);
    await waitFor(() => {
      expect(luna.getAttribute("aria-checked")).toBe("false");
    });
    const modelPost = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/models") && init?.method === "POST"
    );
    expect(modelPost).toBeDefined();
    expect(JSON.parse(String(modelPost?.[1]?.body))).toEqual({
      models: ["gpt-5.6-sol"],
    });

    const sparkOverride = screen.getByRole<HTMLButtonElement>("switch", {
      name: en.overrideSparkContextWindow,
    });
    expect(sparkOverride.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sparkOverride);
    await waitFor(() => {
      expect(overrideSparkContextWindow).toBe(true);
      expect(sparkOverride.getAttribute("aria-checked")).toBe("true");
    });

    const capacity = await screen.findByRole<HTMLInputElement>("spinbutton", {
      name: en.contextWindowInput,
    });
    expect(capacity.value).toBe("");
    fireEvent.change(capacity, { target: { value: "512" } });
    fireEvent.click(screen.getByRole("button", { name: en.contextWindowSave }));
    await waitFor(() => {
      expect(contextWindow).toBe(512_000);
    });
    const contextPosts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith("/context-window") && init?.method === "POST"
      );
    expect(JSON.parse(String(contextPosts()[0]?.[1]?.body))).toEqual({
      overrideSparkContextWindow: true,
    });
    expect(JSON.parse(String(contextPosts()[1]?.[1]?.body))).toEqual({
      contextWindow: 512_000,
    });

    fireEvent.change(capacity, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: en.contextWindowSave }));
    await waitFor(() => {
      expect(contextWindow).toBeNull();
    });
    expect(JSON.parse(String(contextPosts()[2]?.[1]?.body))).toEqual({
      contextWindow: null,
    });
    expect(screen.getByText(en.contextWindowHint)).toBeDefined();

    fireEvent.change(capacity, { target: { value: "1.0001" } });
    fireEvent.click(screen.getByRole("button", { name: en.contextWindowSave }));
    expect(await screen.findByText(en.contextWindowInvalid)).toBeDefined();
    expect(contextPosts()).toHaveLength(3);
  });
});
