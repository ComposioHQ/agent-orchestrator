import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import type { TerminalTransportHealth } from "@/lib/types";
import { makeSession } from "@/__tests__/helpers";

const degradedHealth: TerminalTransportHealth = {
  status: "degraded",
  degraded: true,
  message: "Terminal transport degraded: direct terminal websocket",
  checkedAt: new Date().toISOString(),
  services: {
    terminalWebsocket: {
      key: "terminalWebsocket",
      label: "terminal websocket",
      port: 14800,
      healthPath: "/health",
      status: "healthy",
      healthy: true,
      message: "terminal websocket healthy",
      pid: 123,
      restartCount: 0,
      lastCheckedAt: new Date().toISOString(),
      lastHealthyAt: new Date().toISOString(),
      lastStartedAt: new Date().toISOString(),
      lastErrorAt: null,
      lastError: null,
      supervisorOwned: true,
    },
    directTerminalWebsocket: {
      key: "directTerminalWebsocket",
      label: "direct terminal websocket",
      port: 14801,
      healthPath: "/health",
      status: "restarting",
      healthy: false,
      message: "direct terminal websocket restarting on port 14801",
      pid: 456,
      restartCount: 2,
      lastCheckedAt: new Date().toISOString(),
      lastHealthyAt: null,
      lastStartedAt: new Date().toISOString(),
      lastErrorAt: new Date().toISOString(),
      lastError: "Process exited (1)",
      supervisorOwned: true,
    },
  },
};

describe("Dashboard terminal transport banner", () => {
  beforeEach(() => {
    global.EventSource = vi.fn(
      () => ({ onmessage: null, onerror: null, close: vi.fn() }) as unknown as EventSource,
    );
    global.fetch = vi.fn(() => new Promise(() => undefined)) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a degraded terminal banner when websocket services are unavailable", () => {
    render(<Dashboard initialSessions={[makeSession()]} initialTerminalHealth={degradedHealth} />);

    expect(screen.getAllByText(/Terminal transport degraded:/)).toHaveLength(1);
    expect(
      screen.getByText(/dashboard sessions stay visible while websocket services restart/i),
    ).toBeInTheDocument();
  });
});
