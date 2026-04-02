import { describe, it, expect } from "vitest";
import { buildDirectTerminalWsUrl, buildTerminalThemes } from "@/components/DirectTerminal";

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

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("buildTerminalThemes", () => {
  it("dark theme has valid hex colors for bg, fg, and all ANSI slots", () => {
    const { dark } = buildTerminalThemes("agent");
    expect(dark.background).toMatch(HEX_RE);
    expect(dark.foreground).toMatch(HEX_RE);
    for (const key of ANSI_KEYS) {
      expect(dark[key]).toMatch(HEX_RE);
    }
  });

  it("light theme has valid hex colors for bg, fg, and all ANSI slots", () => {
    const { light } = buildTerminalThemes("agent");
    expect(light.background).toBe("#fafafa");
    expect(light.foreground).toBe("#24292f");
    for (const key of ANSI_KEYS) {
      expect(light[key]).toMatch(HEX_RE);
    }
  });

  it("light theme ANSI colors maintain readable contrast on the terminal background", () => {
    const { light } = buildTerminalThemes("agent");
    for (const key of ANSI_KEYS) {
      expect(contrastRatio(light.background!, light[key]!)).toBeGreaterThanOrEqual(4);
    }
  });

  it("dark theme background is #0a0a0f", () => {
    const { dark } = buildTerminalThemes("agent");
    expect(dark.background).toBe("#0a0a0f");
  });

  it("orchestrator variant reuses the shared design-system accent", () => {
    const agent = buildTerminalThemes("agent");
    const orch = buildTerminalThemes("orchestrator");
    expect(agent.dark.cursor).toBe(orch.dark.cursor);
    expect(agent.light.cursor).toBe(orch.light.cursor);
    expect(agent.dark.selectionBackground).toBe(orch.dark.selectionBackground);
    expect(agent.light.selectionBackground).toBe(orch.light.selectionBackground);
  });

  it("keeps ANSI magenta distinct from ANSI blue", () => {
    const { dark, light } = buildTerminalThemes("agent");
    expect(dark.magenta).not.toBe(dark.blue);
    expect(dark.brightMagenta).not.toBe(dark.brightBlue);
    expect(light.magenta).not.toBe(light.blue);
    expect(light.brightMagenta).not.toBe(light.brightBlue);
  });

  it("selection colors differ between dark and light themes", () => {
    const { dark, light } = buildTerminalThemes("agent");
    expect(dark.selectionBackground).not.toBe(light.selectionBackground);
  });
});
