import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import dockerPlugin from "@composio/ao-plugin-runtime-docker";
import type { RuntimeHandle } from "@composio/ao-core";
import { sleep } from "./helpers/polling.js";
import { isDockerAvailable, killContainersByPrefix } from "./helpers/docker.js";

const dockerOk = await isDockerAvailable();
const CONTAINER_PREFIX = "ao-inttest-docker-";
const TEST_IMAGE = "busybox:1.36";

describe.skipIf(!dockerOk)("runtime-docker (integration)", () => {
  const runtime = dockerPlugin.create();
  const sessionId = `${CONTAINER_PREFIX}${Date.now()}`;
  let handle: RuntimeHandle;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = await mkdtemp(join(homedir(), ".ao-docker-runtime-"));
    await killContainersByPrefix(CONTAINER_PREFIX);
  }, 60_000);

  afterAll(async () => {
    try {
      if (handle) {
        await runtime.destroy(handle);
      }
    } catch {
      /* best effort */
    }
    await killContainersByPrefix(CONTAINER_PREFIX);
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  }, 60_000);

  it("creates a Docker container", async () => {
    handle = await runtime.create({
      sessionId,
      workspacePath,
      launchCommand: "cat",
      environment: { AO_TEST: "1" },
      runtimeConfig: {
        image: TEST_IMAGE,
        mountHome: false,
      },
    });

    expect(handle.id).toBe(sessionId);
    expect(handle.runtimeName).toBe("docker");
  }, 60_000);

  it("isAlive returns true for a running container", async () => {
    expect(await runtime.isAlive(handle)).toBe(true);
  }, 30_000);

  it("sendMessage writes to the container stdin and getOutput captures it", async () => {
    await runtime.sendMessage(handle, "hello docker");
    await sleep(1_000);
    const output = await runtime.getOutput(handle);
    expect(output).toContain("hello docker");
  }, 30_000);

  it("getMetrics returns uptime", async () => {
    const metrics = await runtime.getMetrics!(handle);
    expect(metrics.uptimeMs).toBeGreaterThan(0);
  });

  it("getAttachInfo returns a docker attach command", async () => {
    const info = await runtime.getAttachInfo!(handle);
    expect(info.type).toBe("docker");
    expect(info.target).toBe(sessionId);
    expect(info.command).toContain("docker attach");
  });

  it("destroy removes the container", async () => {
    await runtime.destroy(handle);
    expect(await runtime.isAlive(handle)).toBe(false);
  }, 30_000);
});
