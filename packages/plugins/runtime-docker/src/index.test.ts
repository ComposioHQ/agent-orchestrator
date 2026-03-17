import { describe, expect, it } from "vitest";
import { create, manifest, normalizeDockerRuntimeConfig } from "./index.js";

describe("runtime-docker", () => {
  it("exports the docker runtime manifest", () => {
    expect(manifest).toMatchObject({
      name: "docker",
      slot: "runtime",
    });
  });

  it("requires an image in runtimeConfig", () => {
    expect(() => normalizeDockerRuntimeConfig()).toThrow(/runtimeConfig\.image/);
  });

  it("normalizes default Docker settings", () => {
    const config = normalizeDockerRuntimeConfig({ image: "ghcr.io/example/ao:latest" });
    expect(config.image).toBe("ghcr.io/example/ao:latest");
    expect(config.shell).toBe("/bin/sh");
    expect(config.mountHome).toBe(true);
  });

  it("passes through custom mounts and env settings", () => {
    const config = normalizeDockerRuntimeConfig({
      image: "ghcr.io/example/ao:latest",
      shell: "/bin/bash",
      mountHome: false,
      mounts: ["~/cache:/cache:ro"],
      env: { FOO: "bar" },
      passHostEnv: ["OPENAI_API_KEY"],
      extraArgs: ["--network", "host"],
      user: "1000:1000",
    });

    expect(config).toMatchObject({
      image: "ghcr.io/example/ao:latest",
      shell: "/bin/bash",
      mountHome: false,
      env: { FOO: "bar" },
      passHostEnv: ["OPENAI_API_KEY"],
      extraArgs: ["--network", "host"],
      user: "1000:1000",
    });
    expect(config.mounts[0]).toContain("/cache:ro");
  });

  it("creates a runtime instance", () => {
    const runtime = create();
    expect(runtime.name).toBe("docker");
  });
});
