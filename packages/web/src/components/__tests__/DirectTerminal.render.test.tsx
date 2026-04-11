import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

describe("DirectTerminal render", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    replaceMock.mockReset();
    MockWebSocket.instances = [];
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

  it("renders session name, CONNECTED badge, and connects via WS", async () => {
    render(<DirectTerminal sessionId="ao-orchestrator" variant="orchestrator" />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/runtime/terminal", expect.any(Object)));
    await waitFor(() =>
      expect(screen.getByText("CONNECTED")).toBeInTheDocument(),
    );

    expect(screen.getByText("ao-orchestrator")).toBeInTheDocument();
    expect(MockWebSocket.instances[0]?.url).toContain("/ao-terminal-ws?session=ao-orchestrator");
  });

  it("renders agent type badge when agentName is provided", async () => {
    render(<DirectTerminal sessionId="test-session" agentName="Claude Code" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("renders fullscreen button in the top bar", async () => {
    render(<DirectTerminal sessionId="test-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByTitle("Fullscreen")).toBeInTheDocument();
  });

  it("renders settings button and font info in status bar", async () => {
    render(<DirectTerminal sessionId="test-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    // Settings gear button in top bar
    expect(screen.getByTitle("Terminal settings")).toBeInTheDocument();
    // Status bar shows font family + size
    expect(screen.getByText(/JetBrains Mono · 14px/)).toBeInTheDocument();
  });

  it("renders PR link in status bar when prNumber is provided", async () => {
    render(<DirectTerminal sessionId="test-session" prNumber={1012} prUrl="https://github.com/test/repo/pull/1012" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    const prLink = screen.getByText("PR #1012");
    expect(prLink).toBeInTheDocument();
    expect(prLink.closest("a")).toHaveAttribute("href", "https://github.com/test/repo/pull/1012");
  });

  it("shows exit fullscreen button when startFullscreen is true", async () => {
    searchParams = new URLSearchParams("fullscreen=true");
    render(<DirectTerminal sessionId="test-session" startFullscreen />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByTitle("Exit fullscreen")).toBeInTheDocument();
  });

  it("opens settings panel with all controls when gear button is clicked", async () => {
    render(<DirectTerminal sessionId="test-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    // Click settings gear
    fireEvent.click(screen.getByTitle("Terminal settings"));

    // Panel should show all setting sections
    await waitFor(() => expect(screen.getByText("Font Family")).toBeInTheDocument());
    expect(screen.getByText("Font Size")).toBeInTheDocument();
    expect(screen.getByText("Cursor Style")).toBeInTheDocument();
    expect(screen.getByText("Cursor Blink")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();

    // Should have cursor style visual buttons
    expect(screen.getByTitle("Block")).toBeInTheDocument();
    expect(screen.getByTitle("Bar")).toBeInTheDocument();
    expect(screen.getByTitle("Underline")).toBeInTheDocument();

    // Should have theme swatches
    expect(screen.getByTitle("GitHub Dark")).toBeInTheDocument();
    expect(screen.getByTitle("Dracula")).toBeInTheDocument();
    expect(screen.getByTitle("Nord")).toBeInTheDocument();
  });

  it("renders OpenCode reload button when isOpenCodeSession is true", async () => {
    render(<DirectTerminal sessionId="test-oc" isOpenCodeSession />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByTitle("Restart OpenCode session")).toBeInTheDocument();
  });
});
