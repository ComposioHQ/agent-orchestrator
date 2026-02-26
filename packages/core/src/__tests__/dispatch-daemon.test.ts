import { describe, expect, it, vi } from "vitest";
import { DispatchDaemon, type DispatchDaemonStore } from "../dispatch-daemon.js";

describe("DispatchDaemon", () => {
  it("assigns pending tasks to idle workers", async () => {
    const store: DispatchDaemonStore = {
      listPendingTasks: vi.fn(async () => [{ id: "t1" }, { id: "t2" }]),
      listWorkers: vi.fn(async () => [
        { id: "w1", busy: false },
        { id: "w2", busy: true },
        { id: "w3", busy: false },
      ]),
      assignTask: vi.fn(async () => {}),
    };
    const daemon = new DispatchDaemon(store);
    await daemon.pollOnce();

    expect(store.assignTask).toHaveBeenCalledTimes(2);
    expect(store.assignTask).toHaveBeenCalledWith("t1", "w1");
    expect(store.assignTask).toHaveBeenCalledWith("t2", "w3");
  });

  it("does nothing when no idle workers are available", async () => {
    const store: DispatchDaemonStore = {
      listPendingTasks: vi.fn(async () => [{ id: "t1" }]),
      listWorkers: vi.fn(async () => [{ id: "w1", busy: true }]),
      assignTask: vi.fn(async () => {}),
    };
    const daemon = new DispatchDaemon(store);
    await daemon.pollOnce();

    expect(store.assignTask).not.toHaveBeenCalled();
  });
});

