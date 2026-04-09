import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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
    // Provide a spy-able ResizeObserver so component doesn't throw in jsdom
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("terminal container has no padding class that would skew FitAddon column calculation", async () => {
    render(<DirectTerminal sessionId="padding-session" variant="agent" />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    const wFullDivs = document.querySelectorAll("div.w-full");
    wFullDivs.forEach((el) => {
      expect(el.classList.contains("p-1.5")).toBe(false);
    });
  });

  it("renders the shared accent chrome for orchestrator terminals", async () => {
    render(<DirectTerminal sessionId="ao-orchestrator" variant="orchestrator" />);

    await waitFor(() =>
      expect(screen.getByText("Connected")).toBeInTheDocument(),
    );

    expect(screen.getByText("ao-orchestrator")).toHaveStyle({ color: "var(--color-accent)" });
    expect(screen.getByText("XDA")).toHaveStyle({ color: "var(--color-accent)" });
  });
});

describe("ResizeObserver-based resize handling", () => {
  let observeMock: Mock;
  let disconnectMock: Mock;
  let resizeCallback: (() => void) | undefined;

  beforeEach(() => {
    observeMock = vi.fn();
    disconnectMock = vi.fn();
    resizeCallback = undefined;
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn((cb: () => void) => {
        resizeCallback = cb;
        return { observe: observeMock, unobserve: vi.fn(), disconnect: disconnectMock };
      }),
    );
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
      })),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("observes the terminal container element for container-level size changes", async () => {
    render(<DirectTerminal sessionId="resize-session" variant="agent" />);
    await waitFor(() => expect(observeMock).toHaveBeenCalledWith(expect.any(HTMLElement)));
  });

  it("calls fit.fit() and sends resize message via WebSocket when resize fires", async () => {
    const fitSpy = vi.spyOn(MockFitAddon.prototype, "fit");
    render(<DirectTerminal sessionId="resize-callback-session" variant="agent" />);
    await waitFor(() => expect(observeMock).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));

    // Trigger the resize observer callback
    resizeCallback?.();

    expect(fitSpy).toHaveBeenCalled();
    fitSpy.mockRestore();
  });

  it("disconnects the ResizeObserver when the component unmounts", async () => {
    const { unmount } = render(<DirectTerminal sessionId="cleanup-session" variant="agent" />);
    await waitFor(() => expect(observeMock).toHaveBeenCalled());
    unmount();
    expect(disconnectMock).toHaveBeenCalled();
  });
});

describe("initial fit timing", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
      })),
    );
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() })),
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defers initial fit.fit() via requestAnimationFrame so the DOM has settled", async () => {
    let capturedRafCb: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      capturedRafCb = cb;
      return 0;
    });

    render(<DirectTerminal sessionId="raf-session" variant="agent" />);

    // Wait for the RAF to be scheduled (the component called requestAnimationFrame)
    await waitFor(() => expect(capturedRafCb).toBeDefined());

    // Spy set up after capture so we can verify the captured callback calls fit.fit()
    const fitSpy = vi.spyOn(MockFitAddon.prototype, "fit");
    capturedRafCb!(performance.now());
    expect(fitSpy).toHaveBeenCalled();

    fitSpy.mockRestore();
  });
});
