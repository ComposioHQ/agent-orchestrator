import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "../DirectTerminal";

const replaceMock = vi.fn();
let searchParams = new URLSearchParams();
let resizeObserverCallback: ResizeObserverCallback | null = null;

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
  static instances: MockFitAddon[] = [];
  fit = vi.fn();

  constructor() {
    MockFitAddon.instances.push(this);
  }
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

  send = vi.fn();
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
    MockFitAddon.instances = [];
    resizeObserverCallback = null;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver {
        observe = vi.fn();
        disconnect = vi.fn();

        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }
      },
    );
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
    const { container } = render(<DirectTerminal sessionId="ao-orchestrator" variant="orchestrator" />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/runtime/terminal", expect.any(Object)));
    await waitFor(() =>
      expect(screen.getByText("Connected")).toBeInTheDocument(),
    );

    expect(screen.getByText("ao-orchestrator")).toHaveStyle({ color: "var(--color-accent)" });
    expect(screen.getByText("XDA")).toHaveStyle({ color: "var(--color-accent)" });
    expect(MockWebSocket.instances[0]?.url).toContain("/ao-terminal-ws?session=ao-orchestrator");

    const terminalArea = screen.getByText("Connected").closest("div")?.nextElementSibling as HTMLElement;
    expect(terminalArea).toHaveClass("p-1.5");
    expect(terminalArea.firstElementChild).toHaveClass("h-full", "w-full", "min-w-0");
    expect(container.querySelector(".p-1\\.5 > .min-w-0")).toBeTruthy();
  });

  it("re-fits and syncs the terminal size on window resize and resize observer updates", async () => {
    render(<DirectTerminal sessionId="ao-terminal-2" />);

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());

    const fit = MockFitAddon.instances[0];
    const socket = MockWebSocket.instances[0];

    expect(fit).toBeDefined();
    expect(socket).toBeDefined();

    fit.fit.mockClear();
    socket.send.mockClear();

    window.dispatchEvent(new Event("resize"));

    await waitFor(() => {
      expect(fit.fit).toHaveBeenCalledTimes(1);
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      );
    });

    fit.fit.mockClear();
    socket.send.mockClear();

    expect(resizeObserverCallback).toBeTruthy();
    resizeObserverCallback?.([], {} as ResizeObserver);

    await waitFor(() => {
      expect(fit.fit).toHaveBeenCalledTimes(1);
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      );
    });
  });
});
