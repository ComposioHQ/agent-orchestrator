import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIRECT_TERMINAL_CONTROL_PREFIX, DirectTerminal } from "../DirectTerminal";

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
  static instances: MockTerminal[] = [];
  options: Record<string, unknown>;
  parser = {
    registerCsiHandler: vi.fn(),
    registerOscHandler: vi.fn(),
  };
  cols = 80;
  rows = 24;
  resize = vi.fn((cols: number, rows: number) => {
    this.cols = cols;
    this.rows = rows;
  });
  scrollToBottom = vi.fn();

  constructor(options: Record<string, unknown>) {
    this.options = options;
    MockTerminal.instances.push(this);
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

vi.mock("@/hooks/useMux", () => ({
  useMux: () => ({
    subscribeTerminal: vi.fn(() => vi.fn()),
    writeTerminal: vi.fn(),
    openTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    status: "connected",
    sessions: [],
    terminals: [],
  }),
}));

describe("DirectTerminal render", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    replaceMock.mockReset();
    MockWebSocket.instances = [];
    MockTerminal.instances = [];
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
      expect(screen.getByText("Connected")).toBeInTheDocument(),
    );

    expect(screen.getByText("ao-orchestrator")).toHaveStyle({ color: "var(--color-accent)" });
    expect(screen.getByText("XDA")).toHaveStyle({ color: "var(--color-accent)" });
  });

  it("applies shared terminal sizes sent by the server", async () => {
    render(<DirectTerminal sessionId="ao-mobile-shared" />);

    await waitFor(() =>
      expect(screen.getByText("Connected")).toBeInTheDocument(),
    );

    const terminal = MockTerminal.instances[0];
    const ws = MockWebSocket.instances[0];

    ws.onmessage?.({
      data: `${DIRECT_TERMINAL_CONTROL_PREFIX}${JSON.stringify({
        type: "sync_size",
        cols: 120,
        rows: 40,
      })}`,
    });

    expect(terminal.resize).toHaveBeenCalledWith(120, 40);
    await waitFor(() => expect(terminal.scrollToBottom).toHaveBeenCalled());
  });
});
