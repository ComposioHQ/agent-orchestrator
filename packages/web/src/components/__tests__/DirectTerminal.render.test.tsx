import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "../DirectTerminal";

const replaceMock = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/test-direct",
  useSearchParams: () => searchParams,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

class MockTerminal {
  options: Record<string, unknown>;
  parser = {
    registerCsiHandler: vi.fn(),
    registerOscHandler: vi.fn(),
  };
  cols = 80;
  rows = 24;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  loadAddon() {}
  open() {}
  write() {}
  refresh() {}
  dispose() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  clearSelection() {}
  onSelectionChange() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
  onData() {
    return { dispose() {} };
  }
}

class MockFitAddon {
  fit() {}
}

function MockWebLinksAddon() {
  return undefined;
}

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  static autoOpen = true;
  readyState = MockWebSocket.OPEN;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    if (MockWebSocket.autoOpen) {
      setTimeout(() => this.onopen?.(), 0);
    }
  }

  send() {}
  close() {}
}

vi.mock("xterm", () => ({
  Terminal: MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: MockWebLinksAddon,
}));

describe("DirectTerminal render", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    replaceMock.mockReset();
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          proxyWsPath: "/ao-terminal-ws",
        }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the shared accent chrome for orchestrator terminals", async () => {
    render(<DirectTerminal sessionId="ao-orchestrator" variant="orchestrator" />);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/sessions/ao-orchestrator/terminal", {
        method: "POST",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    await waitFor(() => expect(screen.queryByText("Connected")).not.toBeNull());

    expect(screen.getByText("ao-orchestrator").getAttribute("style")).toContain("var(--color-accent)");
    expect(screen.getByText("XDA").getAttribute("style")).toContain("var(--color-accent)");
    expect(MockWebSocket.instances[0]?.url).toContain("/ao-terminal-ws?session=ao-orchestrator");
  });

  it("shows authorization error when terminal auth API returns permanent non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    );

    render(<DirectTerminal sessionId="ao-auth-fail" variant="agent" />);

    await waitFor(() => expect(screen.queryByText("Failed to authorize terminal: HTTP 404")).not.toBeNull());
  });

  it("retries transient auth fetch failures and eventually connects", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<DirectTerminal sessionId="ao-auth-retry" variant="agent" />);

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1), { timeout: 2500 });
    await waitFor(() => expect(screen.queryByText("Connected")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats auth close with permanent reason as terminal error", async () => {
    render(<DirectTerminal sessionId="ao-permanent-auth" />);

    await waitFor(() => expect(screen.queryByText("Connected")).not.toBeNull());

    const ws = MockWebSocket.instances[0];
    await act(async () => {
      ws?.onclose?.({ code: 1008, reason: "Session not found" });
    });

    await waitFor(() => expect(screen.queryByText("Session not found")).not.toBeNull());
  });

  it("retries transient auth close and invalidates runtime config", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<DirectTerminal sessionId="ao-transient-auth" />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

    const ws = MockWebSocket.instances[0];
    await act(async () => {
      ws?.onclose?.({ code: 1008, reason: "temporary auth failure" });
    });

    await waitFor(() => expect(screen.queryByText("Connecting…")).not.toBeNull());

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2), { timeout: 2500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows busy retry message for rate-limited websocket close", async () => {
    render(<DirectTerminal sessionId="ao-rate-limit" />);

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

    const ws = MockWebSocket.instances[0];
    await act(async () => {
      ws?.onclose?.({ code: 1013, reason: "" });
    });

    await waitFor(() => expect(screen.queryByText("Connecting…")).not.toBeNull());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2), { timeout: 2500 });
  });
});
