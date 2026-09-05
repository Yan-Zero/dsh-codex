import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher } from "undici";
import {
  normalizeProxyUrl,
  OpenAICodexProxyTransport,
} from "../src/proxy.ts";
import type { ProxyPreferences } from "../src/proxy.ts";

const transports = new Set<OpenAICodexProxyTransport>();

afterEach(async () => {
  await Promise.all([...transports].map(async (transport) => transport.dispose()));
  transports.clear();
});

function transportFor(preferences: ProxyPreferences): OpenAICodexProxyTransport {
  const transport = new OpenAICodexProxyTransport(() => preferences);
  transports.add(transport);
  return transport;
}

describe("OpenAICodexProxyTransport", () => {
  it("accepts only HTTP(S) proxy URLs without reflecting credentials", () => {
    expect(normalizeProxyUrl("  http://127.0.0.1:7890  ")).toBe(
      "http://127.0.0.1:7890"
    );
    expect(() => normalizeProxyUrl("socks5://secret@example.test:1080")).toThrow(
      "http:// or https://"
    );
    expect(() => normalizeProxyUrl("socks5://secret@example.test:1080")).not.toThrow(
      /secret/u
    );
  });

  it("leaves the process dispatcher untouched when disabled", async () => {
    const original = getGlobalDispatcher();
    const transport = transportFor({ proxyMode: "off", proxyUrl: "" });

    await transport.apply();

    expect(getGlobalDispatcher()).toBe(original);
  });

  it("restores the previous process dispatcher after global mode", async () => {
    const original = getGlobalDispatcher();
    const preferences: ProxyPreferences = {
      proxyMode: "global",
      proxyUrl: "http://127.0.0.1:7890",
    };
    const transport = transportFor(preferences);

    await transport.apply();
    expect(getGlobalDispatcher()).not.toBe(original);

    preferences.proxyMode = "off";
    await transport.apply();
    expect(getGlobalDispatcher()).toBe(original);
  });

  it("routes a scoped Codex request through the configured proxy", async () => {
    let observedUrl: string | undefined;
    const server = createServer((request, response) => {
      observedUrl = request.url;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("proxied");
    });
    const address = await new Promise<AddressInfo>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(server.address() as AddressInfo);
      });
    });
    try {
      const transport = transportFor({
        proxyMode: "scoped",
        proxyUrl: `http://127.0.0.1:${String(address.port)}`,
      });

      const response = await transport.fetch("http://codex-probe.invalid/test");

      expect(await response.text()).toBe("proxied");
      expect(observedUrl).toBe("http://codex-probe.invalid/test");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
