import { describe, it, expect } from "vitest";
import { buildDirectTerminalWsUrl } from "@/components/DirectTerminal";

describe("buildDirectTerminalWsUrl", () => {
  it("keeps non-standard port when proxy path override is set", () => {
    const wsUrl = buildDirectTerminalWsUrl({
      location: {
        protocol: "https:",
        hostname: "example.com",
        host: "example.com:8443",
        port: "8443",
      },
      sessionId: "session-1",
      proxyWsPath: "/ao-terminal-ws",
    });

    expect(wsUrl).toBe("wss://example.com:8443/ao-terminal-ws?session=session-1");
  });

  it("uses proxy path without port when default port is used", () => {
    const wsUrl = buildDirectTerminalWsUrl({
      location: {
        protocol: "https:",
        hostname: "example.com",
        host: "example.com",
        port: "",
      },
      sessionId: "session-2",
      proxyWsPath: "/ao-terminal-ws",
    });

    expect(wsUrl).toBe("wss://example.com/ao-terminal-ws?session=session-2");
  });

  it("uses default path-based endpoint on standard ports when no proxy override is set", () => {
    const wsUrl = buildDirectTerminalWsUrl({
      location: {
        protocol: "https:",
        hostname: "example.com",
        host: "example.com",
        port: "443",
      },
      sessionId: "session-3",
    });

    expect(wsUrl).toBe("wss://example.com/ao-terminal-ws?session=session-3");
  });

  it("uses direct terminal port on non-standard ports when no proxy override is set", () => {
    const wsUrl = buildDirectTerminalWsUrl({
      location: {
        protocol: "http:",
        hostname: "localhost",
        host: "localhost:3000",
        port: "3000",
      },
      sessionId: "session-4",
      directTerminalPort: "14888",
    });

    expect(wsUrl).toBe("ws://localhost:14888/ws?session=session-4");
  });
});
