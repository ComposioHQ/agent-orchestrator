import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "../DirectTerminal";

const replaceMock = vi.fn();
let searchParams = new URLSearchParams();
let resolvedTheme = "dark";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/test-chrome",
  useSearchParams: () => searchParams,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme }),
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
  hasSelection() { return false; }
  getSelection() { return ""; }
  clearSelection() {}
  onSelectionChange() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
  onData() { return { dispose() {} }; }
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
  readyState = MockWebSocket.OPEN;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
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

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: function MockWebglAddon() {
    throw new Error("WebGL not available in test");
  },
}));

function createMockStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

describe("DirectTerminal chrome", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    resolvedTheme = "dark";
    replaceMock.mockReset();
    MockWebSocket.instances = [];
    vi.stubGlobal("localStorage", createMockStorage());
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Settings panel ──────────────────────────────────────────

  it("toggles settings panel when settings button is clicked", async () => {
    render(<DirectTerminal sessionId="test-settings" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    const settingsBtn = screen.getByTitle("Terminal settings");
    fireEvent.click(settingsBtn);

    // Panel should show section labels
    expect(screen.getByText("Font Family")).toBeInTheDocument();
    expect(screen.getByText("Font Size")).toBeInTheDocument();
    expect(screen.getByText("Cursor Style")).toBeInTheDocument();
    expect(screen.getByText("Cursor Blink")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByText("Terminal Settings")).toBeInTheDocument();

    // Cursor style visual buttons (by title)
    expect(screen.getByTitle("Block")).toBeInTheDocument();
    expect(screen.getByTitle("Bar")).toBeInTheDocument();
    expect(screen.getByTitle("Underline")).toBeInTheDocument();

    // Theme swatches (one per preset)
    const swatchButtons = screen.getAllByTitle(/GitHub Dark|Dracula|Tokyo Night|One Dark|Catppuccin|Nord/);
    expect(swatchButtons.length).toBe(6);

    // Font family pill buttons
    expect(screen.getByText("JetBrains Mono")).toBeInTheDocument();
    expect(screen.getByText("Fira Code")).toBeInTheDocument();

    // Selection Color and Reset
    expect(screen.getByText("Selection Color")).toBeInTheDocument();
    expect(screen.getByText("Reset to Defaults")).toBeInTheDocument();

    // Close the panel
    fireEvent.click(settingsBtn);
    expect(screen.queryByText("Font Family")).not.toBeInTheDocument();
  });

  it("changes font size via pill buttons in settings panel", async () => {
    render(<DirectTerminal sessionId="test-font-size" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Terminal settings"));

    // Click the "16px" font size pill
    const btn16 = screen.getByRole("button", { name: "16px" });
    fireEvent.click(btn16);

    const stored = JSON.parse(window.localStorage.getItem("ao-terminal-settings")!);
    expect(stored.fontSize).toBe(16);
  });

  it("changes cursor style via visual buttons in settings panel", async () => {
    render(<DirectTerminal sessionId="test-cursor" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Terminal settings"));

    fireEvent.click(screen.getByTitle("Block"));

    const stored = JSON.parse(window.localStorage.getItem("ao-terminal-settings")!);
    expect(stored.cursorStyle).toBe("block");
  });

  it("changes font family via pill buttons in settings panel", async () => {
    render(<DirectTerminal sessionId="test-font-family" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Terminal settings"));

    fireEvent.click(screen.getByText("SF Mono"));

    // Status bar should show SF Mono
    expect(screen.getByText(/SF Mono · 14px/)).toBeInTheDocument();
  });

  it("toggles cursor blink via toggle button", async () => {
    render(<DirectTerminal sessionId="test-blink" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Terminal settings"));

    // Find the toggle button (it's a sibling of the "Cursor Blink" span inside a div)
    const blinkLabel = screen.getByText("Cursor Blink");
    const container = blinkLabel.closest("div");
    const toggleBtn = container?.querySelector("button");
    expect(toggleBtn).toBeTruthy();
    fireEvent.click(toggleBtn!);

    const stored = JSON.parse(window.localStorage.getItem("ao-terminal-settings")!);
    expect(stored.cursorBlink).toBe(false);
  });

  it("changes theme via swatch buttons", async () => {
    render(<DirectTerminal sessionId="test-theme" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Terminal settings"));

    const draculaSwatch = screen.getByTitle("Dracula");
    fireEvent.click(draculaSwatch);

    const stored = JSON.parse(window.localStorage.getItem("ao-terminal-settings")!);
    expect(stored.themeName).toBe("dracula");
  });

  it("closes settings panel on click outside", async () => {
    render(<DirectTerminal sessionId="test-outside" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Terminal settings"));
    expect(screen.getByText("Font Family")).toBeInTheDocument();

    // Click outside the panel
    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByText("Font Family")).not.toBeInTheDocument();
    });
  });

  // ── OpenCode reload button ──────────────────────────────────

  it("renders reload button for OpenCode sessions", async () => {
    render(
      <DirectTerminal
        sessionId="opencode-1"
        isOpenCodeSession
        reloadCommand="/exit\nopencode --session abc\n"
      />,
    );

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByTitle("Restart OpenCode session")).toBeInTheDocument();
  });

  it("does not render reload button for non-OpenCode sessions", async () => {
    render(<DirectTerminal sessionId="normal-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.queryByTitle("Restart OpenCode session")).not.toBeInTheDocument();
  });

  it("handles reload button click for OpenCode session with reloadCommand", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DirectTerminal
        sessionId="opencode-2"
        isOpenCodeSession
        reloadCommand="/exit\nopencode --session xyz\n"
      />,
    );

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Restart OpenCode session"));

    await waitFor(() => {
      const sendCall = fetchMock.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("/send"),
      );
      expect(sendCall).toBeTruthy();
    });
  });

  it("shows reload error when reload fails", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/send")) {
        return { ok: false, status: 500 };
      }
      callCount++;
      return {
        ok: true,
        json: async () => (callCount === 1 ? { proxyWsPath: "/ao-terminal-ws" } : {}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DirectTerminal
        sessionId="opencode-err"
        isOpenCodeSession
        reloadCommand="/exit\nopencode --session fail\n"
      />,
    );

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Restart OpenCode session"));

    await waitFor(() => {
      expect(screen.getByText(/Failed to send reload command/)).toBeInTheDocument();
    });
  });

  // ── Light theme ─────────────────────────────────────────────

  it("renders light theme chrome colors", async () => {
    resolvedTheme = "light";

    render(<DirectTerminal sessionId="light-test" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    const container = screen.getByText("light-test").closest(".terminal-container");
    expect(container).toBeTruthy();
  });

  // ── Error and connecting states ─────────────────────────────

  it("shows CONNECTING badge initially before WS connects", () => {
    class SlowWebSocket {
      static OPEN = 1;
      readyState = 0;
      binaryType = "arraybuffer";
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", SlowWebSocket);

    render(<DirectTerminal sessionId="connecting-test" />);

    expect(screen.getByText("CONNECTING")).toBeInTheDocument();
  });

  // ── No PR link when not provided ───────────────────────────

  it("does not render PR link when prNumber is not provided", async () => {
    render(<DirectTerminal sessionId="no-pr" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
  });
});
