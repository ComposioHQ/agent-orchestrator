import { describe, expect, it } from "vitest";
import { deriveTerminalWsUrl, normalizeWsUrl } from "./ws-url";

describe("deriveTerminalWsUrl", () => {
  it("uses same-origin wss for secure backends", () => {
    expect(deriveTerminalWsUrl("https://dash.example.com")).toBe("wss://dash.example.com");
  });

  it("keeps the direct terminal port for insecure LAN backends", () => {
    expect(deriveTerminalWsUrl("http://192.168.10.177:3000")).toBe("ws://192.168.10.177:14801");
  });
});

describe("normalizeWsUrl", () => {
  it("maps https to wss", () => {
    expect(normalizeWsUrl("https://abc.ngrok-free.app")).toBe("wss://abc.ngrok-free.app");
  });

  it("maps http to ws", () => {
    expect(normalizeWsUrl("http://192.168.10.177:14801")).toBe("ws://192.168.10.177:14801");
  });
});
