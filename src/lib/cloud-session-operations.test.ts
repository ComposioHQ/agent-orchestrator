import { afterEach, expect, it, vi } from "vitest";

import {
  clearCloudSessionOperations,
  scheduleCloudSessionOperation,
} from "./cloud-session-operations";

afterEach(() => clearCloudSessionOperations());

it("coalesces duplicate work and serializes distinct operations for one session", async () => {
  let completeDiff: ((value: string) => void) | undefined;
  const diff = vi.fn(() => new Promise<string>((resolve) => {
    completeDiff = resolve;
  }));
  const list = vi.fn().mockResolvedValue("files");
  const options = { organizationId: "org-1", sessionId: "session-1" };

  const firstDiff = scheduleCloudSessionOperation({
    ...options,
    key: "workspace.diff",
    run: diff,
  });
  const duplicateDiff = scheduleCloudSessionOperation({
    ...options,
    key: "workspace.diff",
    run: diff,
  });
  const files = scheduleCloudSessionOperation({
    ...options,
    key: "workspace.list:",
    run: list,
  });

  expect(diff).toHaveBeenCalledTimes(1);
  expect(list).not.toHaveBeenCalled();

  completeDiff?.("diff");
  await expect(firstDiff).resolves.toBe("diff");
  await expect(duplicateDiff).resolves.toBe("diff");
  await expect(files).resolves.toBe("files");
  expect(list).toHaveBeenCalledTimes(1);
});

it("cancels an operation when every caller has moved on", async () => {
  const caller = new AbortController();
  let operationSignal: AbortSignal | undefined;
  const operation = scheduleCloudSessionOperation({
    organizationId: "org-1",
    sessionId: "session-1",
    key: "workspace.read:README.md",
    signal: caller.signal,
    run: (signal) => new Promise<string>((_resolve, reject) => {
      operationSignal = signal;
      signal.addEventListener("abort", () => reject(Object.assign(
        new Error("cancelled"),
        { name: "AbortError" },
      )));
    }),
  });

  caller.abort();

  await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  expect(operationSignal?.aborted).toBe(true);
});

it("allows different sessions to progress independently", async () => {
  let completeFirst: (() => void) | undefined;
  const first = scheduleCloudSessionOperation({
    organizationId: "org-1",
    sessionId: "session-1",
    key: "workspace.diff",
    run: () => new Promise<void>((resolve) => { completeFirst = resolve; }),
  });
  const second = scheduleCloudSessionOperation({
    organizationId: "org-1",
    sessionId: "session-2",
    key: "workspace.diff",
    run: () => Promise.resolve("second"),
  });

  await expect(second).resolves.toBe("second");
  completeFirst?.();
  await expect(first).resolves.toBeUndefined();
});
