import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

import { Dashboard } from "../Dashboard";
import { makeSession } from "../../__tests__/helpers";

describe("Dashboard render cadence", () => {
  let eventSourceMock: {
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: (() => void) | null;
    close: () => void;
  };

  beforeEach(() => {
    eventSourceMock = {
      onmessage: null,
      onerror: null,
      close: vi.fn(),
    };
    const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
    global.EventSource = Object.assign(eventSourceConstructor, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
    }) as unknown as typeof EventSource;
    global.fetch = vi.fn();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("applies SSE snapshot patches to session state without full refresh", async () => {
    const initialSessions = [
      makeSession({ id: "session-1", summary: "First session" }),
      makeSession({ id: "session-2", summary: "Second session" }),
    ];

    const { container } = render(<Dashboard initialSessions={initialSessions} />);

    // Verify initial render shows sessions
    expect(container.textContent).toContain("session-1");
    expect(container.textContent).toContain("session-2");

    await waitFor(() => expect(eventSourceMock.onmessage).not.toBeNull());

    // Dispatch a same-membership snapshot — should NOT trigger a full refresh fetch
    await act(async () => {
      eventSourceMock.onmessage!({
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            {
              id: "session-1",
              status: "working",
              activity: "idle",
              lastActivityAt: new Date().toISOString(),
            },
            {
              id: "session-2",
              status: initialSessions[1].status,
              activity: initialSessions[1].activity,
              lastActivityAt: initialSessions[1].lastActivityAt,
            },
          ],
        }),
      } as MessageEvent);
    });

    // Same membership — no full refresh should be triggered
    expect(fetch).not.toHaveBeenCalled();
  });
});
