import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

const mockRouterReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  usePathname: () => "/sessions/test-session",
  useSearchParams: () => new URLSearchParams(),
}));

let mockResolvedTheme = "dark";
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

// Stub xterm CSS import
vi.mock("xterm/css/xterm.css", () => ({}));

// ── Terminal & addon stubs ───────────────────────────────────────────

function createTerminalStub() {
  return {
    cols: 80,
    rows: 24,
    options: { theme: null, minimumContrastRatio: 1 },
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
    clearSelection: vi.fn(),
    refresh: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    parser: {
      registerCsiHandler: vi.fn(),
      registerOscHandler: vi.fn(),
    },
  };
}

const mockTerminalInstance = createTerminalStub();
const mockFitAddon = { fit: vi.fn() };

const MockTerminalClass = vi.fn(() => mockTerminalInstance);
const MockFitAddonClass = vi.fn(() => mockFitAddon);
const MockWebLinksAddonClass = vi.fn(() => ({}));

vi.mock("xterm", () => ({
  Terminal: MockTerminalClass,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddonClass,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: MockWebLinksAddonClass,
}));

// Stub document.fonts.ready
Object.defineProperty(document, "fonts", {
  value: { ready: Promise.resolve() },
  writable: true,
});

// ── WebSocket stub ───────────────────────────────────────────────────

let capturedWs: {
  url: string;
  binaryType: string;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
};

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  binaryType = "blob";
  readyState = MockWebSocket.CONNECTING;
  send = vi.fn();
  close = vi.fn();
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    capturedWs = this as any;
  }
}

// ── Fetch stub ───────────────────────────────────────────────────────

function stubFetch() {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/api/runtime/terminal")) {
      return {
        ok: true,
        json: async () => ({ directTerminalPort: "14888", proxyWsPath: "/ao-terminal-ws" }),
      } as Response;
    }
    if (urlStr.includes("/remap")) {
      return {
        ok: true,
        json: async () => ({ opencodeSessionId: "oc-123" }),
      } as Response;
    }
    if (urlStr.includes("/send")) {
      return { ok: true, json: async () => ({}) } as Response;
    }
    if (urlStr.includes("/message")) {
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}

// ── Import the component under test AFTER mocks ─────────────────────

import { DirectTerminal, buildDirectTerminalWsUrl, buildTerminalThemes } from "../DirectTerminal";

describe("DirectTerminal component rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch();
    mockResolvedTheme = "dark";
    mockRouterReplace.mockClear();
    MockTerminalClass.mockClear();
    MockFitAddonClass.mockClear();
    Object.assign(mockTerminalInstance, createTerminalStub());
    mockFitAddon.fit.mockClear();
    global.WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders with session ID and status indicator", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    // Let the dynamic imports resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText("sess-abc")).toBeInTheDocument();
    expect(screen.getByText("XDA")).toBeInTheDocument();
  });

  it("shows connecting status initially", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // The status text shows "Connecting..." initially
    expect(screen.getByText(/Connecting/)).toBeInTheDocument();
  });

  it("shows connected status after WebSocket opens", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Simulate WS open
    await act(async () => {
      capturedWs.readyState = MockWebSocket.OPEN;
      capturedWs.onopen?.(new Event("open"));
    });

    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("toggles fullscreen when button is clicked", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const fullscreenBtn = screen.getByText("fullscreen");
    await act(async () => {
      fireEvent.click(fullscreenBtn);
    });

    expect(screen.getByText("exit fullscreen")).toBeInTheDocument();
  });

  it("starts in fullscreen when startFullscreen is true", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" startFullscreen />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText("exit fullscreen")).toBeInTheDocument();
  });

  it("shows the reload button for OpenCode sessions", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" isOpenCodeSession />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByLabelText("Restart OpenCode session")).toBeInTheDocument();
  });

  it("does not show reload button for non-OpenCode sessions", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" isOpenCodeSession={false} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.queryByLabelText("Restart OpenCode session")).not.toBeInTheDocument();
  });

  it("handles light theme", async () => {
    mockResolvedTheme = "light";
    await act(async () => {
      render(<DirectTerminal sessionId="sess-light" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText("sess-light")).toBeInTheDocument();
  });

  it("handles orchestrator variant", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-orch" variant="orchestrator" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText("sess-orch")).toBeInTheDocument();
  });

  it("shows error state on permanent WebSocket close code", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Simulate permanent close
    await act(async () => {
      capturedWs.onclose?.({
        code: 4004,
        reason: "Session not found",
      } as CloseEvent);
    });

    expect(screen.getByText("Session not found")).toBeInTheDocument();
  });

  it("reconnects on transient WebSocket close", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const firstWs = capturedWs;

    // Simulate transient close (normal close code)
    await act(async () => {
      firstWs.onclose?.({
        code: 1006,
        reason: "",
      } as CloseEvent);
    });

    // Should show connecting
    expect(screen.getByText(/Connecting/)).toBeInTheDocument();

    // Advance past reconnect delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // A new WebSocket should have been created
    expect(capturedWs).not.toBe(firstWs);
  });

  it("sends WebSocket data when terminal receives input", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Open the WebSocket
    await act(async () => {
      capturedWs.readyState = MockWebSocket.OPEN;
      capturedWs.onopen?.(new Event("open"));
    });

    // Simulate terminal onData callback
    const onDataCallback = mockTerminalInstance.onData.mock.calls[0]?.[0];
    if (onDataCallback) {
      onDataCallback("hello");
      expect(capturedWs.send).toHaveBeenCalledWith("hello");
    }
  });

  it("writes incoming WebSocket data to terminal", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Open the WS
    await act(async () => {
      capturedWs.readyState = MockWebSocket.OPEN;
      capturedWs.onopen?.(new Event("open"));
    });

    // Simulate incoming message
    await act(async () => {
      capturedWs.onmessage?.({ data: "terminal output" } as MessageEvent);
    });

    expect(mockTerminalInstance.write).toHaveBeenCalledWith("terminal output");
  });

  it("sends resize on WebSocket open", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-abc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await act(async () => {
      capturedWs.readyState = MockWebSocket.OPEN;
      capturedWs.onopen?.(new Event("open"));
    });

    expect(capturedWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"resize"'),
    );
  });

  it("handles reload with provided reloadCommand", async () => {
    await act(async () => {
      render(
        <DirectTerminal
          sessionId="sess-oc"
          isOpenCodeSession
          reloadCommand="/exit\nopencode --session oc-99\n"
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Open WS so reload button is enabled
    await act(async () => {
      capturedWs.readyState = MockWebSocket.OPEN;
      capturedWs.onopen?.(new Event("open"));
    });

    const reloadBtn = screen.getByLabelText("Restart OpenCode session");
    await act(async () => {
      fireEvent.click(reloadBtn);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/send"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("handles reload without reloadCommand (calls remap first)", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-oc2" isOpenCodeSession />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await act(async () => {
      capturedWs.readyState = MockWebSocket.OPEN;
      capturedWs.onopen?.(new Event("open"));
    });

    const reloadBtn = screen.getByLabelText("Restart OpenCode session");
    await act(async () => {
      fireEvent.click(reloadBtn);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/remap"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows reload error on fetch failure", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/remap")) {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    await act(async () => {
      render(<DirectTerminal sessionId="sess-fail" isOpenCodeSession />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await act(async () => {
      capturedWs.readyState = MockWebSocket.OPEN;
      capturedWs.onopen?.(new Event("open"));
    });

    const reloadBtn = screen.getByLabelText("Restart OpenCode session");
    await act(async () => {
      fireEvent.click(reloadBtn);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // The error message should appear
    await waitFor(() => {
      expect(screen.getByText(/Failed to remap/)).toBeInTheDocument();
    });
  });

  it("registers XDA (CSI > q) handler on terminal", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-xda" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(mockTerminalInstance.parser.registerCsiHandler).toHaveBeenCalledWith(
      { prefix: ">", final: "q" },
      expect.any(Function),
    );
  });

  it("registers OSC 52 handler for clipboard", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-osc" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(mockTerminalInstance.parser.registerOscHandler).toHaveBeenCalledWith(
      52,
      expect.any(Function),
    );
  });

  it("URL is updated when fullscreen toggles", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-fs" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const fullscreenBtn = screen.getByText("fullscreen");
    await act(async () => {
      fireEvent.click(fullscreenBtn);
    });

    expect(mockRouterReplace).toHaveBeenCalledWith(
      expect.stringContaining("fullscreen=true"),
      { scroll: false },
    );
  });

  it("handles custom height prop", async () => {
    await act(async () => {
      render(<DirectTerminal sessionId="sess-h" height="600px" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText("sess-h")).toBeInTheDocument();
  });
});

describe("buildDirectTerminalWsUrl additional coverage", () => {
  it("defaults to port 14801 when directTerminalPort is not set", () => {
    const url = buildDirectTerminalWsUrl({
      location: {
        protocol: "http:",
        hostname: "localhost",
        host: "localhost:3000",
        port: "3000",
      },
      sessionId: "s1",
    });
    expect(url).toBe("ws://localhost:14801/ws?session=s1");
  });

  it("uses http -> ws mapping", () => {
    const url = buildDirectTerminalWsUrl({
      location: {
        protocol: "http:",
        hostname: "example.com",
        host: "example.com",
        port: "80",
      },
      sessionId: "s2",
    });
    expect(url).toBe("ws://example.com/ao-terminal-ws?session=s2");
  });

  it("encodes special characters in session ID", () => {
    const url = buildDirectTerminalWsUrl({
      location: {
        protocol: "https:",
        hostname: "example.com",
        host: "example.com",
        port: "",
      },
      sessionId: "sess with spaces",
    });
    expect(url).toContain("session=sess%20with%20spaces");
  });
});

describe("buildTerminalThemes additional coverage", () => {
  it("agent and orchestrator themes have different selection colors", () => {
    const agent = buildTerminalThemes("agent");
    const orch = buildTerminalThemes("orchestrator");
    expect(agent.dark.selectionBackground).not.toBe(orch.dark.selectionBackground);
    expect(agent.light.selectionBackground).not.toBe(orch.light.selectionBackground);
  });

  it("themes have all required ANSI color properties", () => {
    const { dark, light } = buildTerminalThemes("agent");
    const ansiKeys = [
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
      "brightMagenta", "brightCyan", "brightWhite",
    ];
    for (const key of ansiKeys) {
      expect(dark[key as keyof typeof dark]).toBeDefined();
      expect(light[key as keyof typeof light]).toBeDefined();
    }
  });

  it("orchestrator has violet cursor", () => {
    const orch = buildTerminalThemes("orchestrator");
    expect(orch.dark.cursor).toBe("#a371f7");
    expect(orch.light.cursor).toBe("#a371f7");
  });
});
