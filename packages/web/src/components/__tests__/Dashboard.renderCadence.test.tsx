import { act, render, waitFor } from "@testing-library/react";
import { memo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderCounts = new Map<string, number>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/SessionCard", () => ({
  SessionCard: memo(({ session }: { session: { id: string } }) => {
    renderCounts.set(session.id, (renderCounts.get(session.id) ?? 0) + 1);
    return <div data-testid={`session-card-${session.id}`}>{session.id}</div>;
  }),
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
    renderCounts.clear();
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
  });

  it("rerenders only the changed session card for same-membership snapshots", async () => {
    const initialSessions = [
      makeSession({ id: "session-1", summary: "First session" }),
      makeSession({ id: "session-2", summary: "Second session" }),
    ];

    render(<Dashboard initialSessions={initialSessions} />);

    expect(renderCounts.get("session-1")).toBe(1);
    expect(renderCounts.get("session-2")).toBe(1);

    await waitFor(() => expect(eventSourceMock.onmessage).not.toBeNull());

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

    expect(renderCounts.get("session-1")).toBe(2);
    expect(renderCounts.get("session-2")).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
