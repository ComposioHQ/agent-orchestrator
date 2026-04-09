import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeHandle } from "@composio/ao-core";

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/host/home"),
  tmpdir: vi.fn(() => "/tmp"),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/tmp/ao-runtime-docker-test"),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;
const expectedDockerOptions = { timeout: 30_000 };
const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockLstatSync = fs.lstatSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = fs.mkdirSync as ReturnType<typeof vi.fn>;
const mockMkdtempSync = fs.mkdtempSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;
const mockRmSync = fs.rmSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = fs.writeFileSync as ReturnType<typeof vi.fn>;

function mockDockerSuccess(stdout = ""): void {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout ? `${stdout}\n` : "", stderr: "" });
}

function mockDockerError(message: string): void {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

function addFileSystemEntries(
  entries: Array<{ path: string; kind: "file" | "dir"; content?: string }>,
): void {
  const stats = new Map(entries.map((entry) => [entry.path, entry.kind]));
  const contents = new Map(
    entries
      .filter((entry) => entry.content !== undefined)
      .map((entry) => [entry.path, entry.content!]),
  );

  mockExistsSync.mockImplementation((candidate: string) => stats.has(candidate));
  mockLstatSync.mockImplementation((candidate: string) => {
    const kind = stats.get(candidate);
    if (!kind) {
      throw new Error(`ENOENT: ${candidate}`);
    }
    return {
      isFile: () => kind === "file",
      isDirectory: () => kind === "dir",
    };
  });
  mockReadFileSync.mockImplementation((candidate: string) => {
    const content = contents.get(candidate);
    if (content === undefined) {
      throw new Error(`ENOENT: ${candidate}`);
    }
    return content;
  });
}

function makeHandle(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return {
    id: "container-1",
    runtimeName: "docker",
    data: {
      containerName: "container-1",
      tmuxSessionName: "tmux-1",
      createdAt: 1_000,
      workspacePath: "/tmp/workspace",
      hostRuntimeDir: "/tmp/ao-runtime-handle",
    },
    ...overrides,
  };
}

import dockerPlugin, { create, manifest } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockLstatSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });
  mockMkdirSync.mockImplementation(() => undefined);
  mockMkdtempSync.mockImplementation(() => "/tmp/ao-runtime-docker-test");
  mockReadFileSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });
  mockRmSync.mockImplementation(() => undefined);
  mockWriteFileSync.mockImplementation(() => undefined);
});

describe("manifest & exports", () => {
  it("has the expected manifest", () => {
    expect(manifest).toEqual({
      name: "docker",
      slot: "runtime",
      description: "Runtime plugin: Docker containers with tmux-backed interactive sessions",
      version: "0.1.0",
    });
  });

  it("exports a valid plugin module", () => {
    expect(dockerPlugin.manifest).toBe(manifest);
    expect(dockerPlugin.create).toBe(create);
  });

  it("create() returns a runtime named docker", () => {
    expect(create().name).toBe("docker");
  });
});

describe("runtime.create()", () => {
  it("requires runtimeConfig.image", async () => {
    await expect(
      create().create({
        sessionId: "docker-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "codex",
        environment: {},
      }),
    ).rejects.toThrow("Docker runtime requires runtimeConfig.image");
  });

  it("rejects invalid session IDs", async () => {
    await expect(
      create().create({
        sessionId: "bad session!",
        workspacePath: "/tmp/workspace",
        launchCommand: "codex",
        environment: {},
        runtimeConfig: { image: "ghcr.io/example/ao:latest" },
      }),
    ).rejects.toThrow('Invalid session ID "bad session!"');
  });

  it("rejects readOnlyRoot without a /tmp tmpfs", async () => {
    await expect(
      create().create({
        sessionId: "docker-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "codex",
        environment: {},
        runtimeConfig: {
          image: "ghcr.io/example/ao:latest",
          readOnlyRoot: true,
        },
      }),
    ).rejects.toThrow("requires tmpfs to include /tmp");
  });

  it("starts a container, creates tmux inside it, and sends the launch command", async () => {
    mockDockerSuccess("container-id");
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();

    const runtime = create();
    const handle = await runtime.create({
      sessionId: "docker-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "codex --model gpt-5",
      environment: { AO_SESSION: "docker-session", FOO: "bar" },
      runtimeConfig: {
        image: "ghcr.io/example/ao:latest",
        network: "bridge",
        readOnlyRoot: true,
        capDrop: ["ALL"],
        tmpfs: ["/tmp"],
        limits: {
          cpus: 2,
          memory: "4g",
          gpus: "all",
        },
      },
    });
    expect(handle).toEqual({
      id: "docker-session",
      runtimeName: "docker",
      data: expect.objectContaining({
        containerName: "docker-session",
        tmuxSessionName: "docker-session",
        workspacePath: "/tmp/workspace",
        hostRuntimeDir: "/tmp/ao-runtime-docker-test",
        execUser:
          typeof process.getuid === "function" && typeof process.getgid === "function"
            ? `${process.getuid()}:${process.getgid()}`
            : undefined,
      }),
    });

    const runArgs = mockExecFileCustom.mock.calls[0]?.[1] as string[];
    expect(runArgs).toEqual(
      expect.arrayContaining([
        "run",
        "-d",
        "--name",
        "docker-session",
        "--workdir",
        "/tmp/workspace",
        "--volume",
        "/tmp/workspace:/tmp/workspace",
        "--volume",
        "/tmp/ao-runtime-docker-test:/tmp/ao/runtime",
        "--env",
        "AO_SESSION=docker-session",
        "--env",
        "FOO=bar",
        "--env",
        "HOME=/tmp/ao-home",
        "--network",
        "bridge",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--tmpfs",
        "/tmp",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--gpus",
        "all",
        "ghcr.io/example/ao:latest",
      ]),
    );

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "exec",
        ...(typeof process.getuid === "function" && typeof process.getgid === "function"
          ? ["--user", "0:0"]
          : []),
        "docker-session",
        "/bin/sh",
        "-lc",
        expect.stringContaining("mkdir -p '/tmp/ao-home' '/tmp/ao-home/.cache'"),
      ],
      expectedDockerOptions,
    );

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "docker",
      [
        "exec",
        ...(typeof process.getuid === "function" && typeof process.getgid === "function"
          ? ["--user", `${process.getuid()}:${process.getgid()}`]
          : []),
        "docker-session",
        "tmux",
        "new-session",
        "-d",
        "-s",
        "docker-session",
        "-c",
        "/tmp/workspace",
        "-e",
        "AO_SESSION=docker-session",
        "-e",
        "FOO=bar",
        "-e",
        "HOME=/tmp/ao-home",
      ],
      expectedDockerOptions,
    );

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      4,
      "docker",
      [
        "exec",
        ...(typeof process.getuid === "function" && typeof process.getgid === "function"
          ? ["--user", `${process.getuid()}:${process.getgid()}`]
          : []),
        "docker-session",
        "tmux",
        "send-keys",
        "-t",
        "docker-session",
        "-l",
        "codex --model gpt-5",
      ],
      expectedDockerOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      5,
      "docker",
      [
        "exec",
        ...(typeof process.getuid === "function" && typeof process.getgid === "function"
          ? ["--user", `${process.getuid()}:${process.getgid()}`]
          : []),
        "docker-session",
        "tmux",
        "send-keys",
        "-t",
        "docker-session",
        "Enter",
      ],
      expectedDockerOptions,
    );
  });

  it("mounts requested agent home state, worktree git metadata, remaps wrappers, and strips host-only GH_PATH", async () => {
    addFileSystemEntries([
      {
        path: "/worktrees/docker-session/.git",
        kind: "file",
        content: "gitdir: /repo/.git/worktrees/docker-session\n",
      },
      { path: "/repo/.git/worktrees/docker-session/commondir", kind: "file", content: "../..\n" },
      { path: "/host/.ao/bin", kind: "dir" },
      { path: "/host/.ao/bin/ao-metadata-helper.sh", kind: "file", content: "#!/bin/sh\n" },
      { path: "/host/.agent/sessions", kind: "dir" },
      { path: "/host/home/.codex", kind: "dir" },
      { path: "/host/home/.gitconfig", kind: "file", content: "[user]\n\tname = Test\n" },
      { path: "/host/home/.git-credentials", kind: "file", content: "https://token@example.com\n" },
      { path: "/host/home/.config/gh", kind: "dir" },
    ]);

    mockDockerSuccess("container-id");
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();

    await create().create({
      sessionId: "docker-session",
      workspacePath: "/worktrees/docker-session",
      launchCommand: "codex --model gpt-5",
      agentRuntimeHints: {
        docker: {
          homeMounts: [{ path: ".codex", kind: "dir" }],
          envDefaults: { CODEX_HOME: ".codex" },
        },
      },
      environment: {
        AO_SESSION: "docker-session",
        PATH: "/host/.ao/bin:/usr/local/bin:/usr/bin:/bin",
        GH_PATH: "/usr/local/bin/gh",
        AO_DATA_DIR: "/host/.agent/sessions",
      },
      runtimeConfig: { image: "ao-fake-codex:latest" },
    });

    const runArgs = mockExecFileCustom.mock.calls[0]?.[1] as string[];
    expect(runArgs).toEqual(
      expect.arrayContaining([
        "run",
        "-d",
        "--name",
        "docker-session",
        "--workdir",
        "/worktrees/docker-session",
        "--volume",
        "/worktrees/docker-session:/worktrees/docker-session",
        "--volume",
        "/repo/.git:/repo/.git",
        "--volume",
        "/host/.ao/bin:/tmp/ao/bin:ro",
        "--volume",
        "/host/.agent/sessions:/tmp/ao/data",
        "--volume",
        "/tmp/ao-runtime-docker-test:/tmp/ao/runtime",
        "--volume",
        "/host/home/.codex:/tmp/ao-home/.codex",
        "--volume",
        "/host/home/.gitconfig:/tmp/ao-home/.gitconfig:ro",
        "--volume",
        "/host/home/.git-credentials:/tmp/ao-home/.git-credentials:ro",
        "--volume",
        "/host/home/.config/gh:/tmp/ao-home/.config/gh",
        "ao-fake-codex:latest",
      ]),
    );

    const tmuxArgs = mockExecFileCustom.mock.calls[2]?.[1] as string[];
    expect(tmuxArgs).toEqual([
      "exec",
      ...(typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : []),
      "docker-session",
      "tmux",
      "new-session",
      "-d",
      "-s",
      "docker-session",
      "-c",
      "/worktrees/docker-session",
      "-e",
      "AO_SESSION=docker-session",
      "-e",
      "PATH=/tmp/ao/bin:/usr/local/bin:/usr/bin:/bin",
      "-e",
      "AO_DATA_DIR=/tmp/ao/data",
      "-e",
      "HOME=/tmp/ao-home",
      "-e",
      "CODEX_HOME=/tmp/ao-home/.codex",
    ]);
  });

  it("does not mount agent home state unless the agent requests it", async () => {
    addFileSystemEntries([
      { path: "/host/home/.codex", kind: "dir" },
      { path: "/host/home/.gitconfig", kind: "file", content: "[user]\n\tname = Test\n" },
    ]);

    mockDockerSuccess("container-id");
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();

    await create().create({
      sessionId: "docker-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "codex --model gpt-5",
      environment: {
        AO_SESSION: "docker-session",
      },
      runtimeConfig: { image: "ao-fake-codex:latest" },
    });

    const runArgs = mockExecFileCustom.mock.calls[0]?.[1] as string[];
    expect(runArgs).toContain("/host/home/.gitconfig:/tmp/ao-home/.gitconfig:ro");
    expect(runArgs).not.toContain("/host/home/.codex:/tmp/ao-home/.codex");
    expect(runArgs).toContain("/tmp/ao-runtime-docker-test:/tmp/ao/runtime");
  });

  it("creates missing hinted home paths so first-time auth persists across containers", async () => {
    addFileSystemEntries([
      { path: "/host/home/.gitconfig", kind: "file", content: "[user]\n\tname = Test\n" },
    ]);

    mockDockerSuccess("container-id");
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();

    await create().create({
      sessionId: "docker-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "claude",
      agentRuntimeHints: {
        docker: {
          homeMounts: [
            { path: ".claude", kind: "dir" },
            { path: ".local/share/opencode/auth.json", kind: "file" },
          ],
        },
      },
      environment: {
        AO_SESSION: "docker-session",
      },
      runtimeConfig: { image: "ao-fake-claude:latest" },
    });

    expect(mockMkdirSync).toHaveBeenCalledWith("/host/home/.claude", { recursive: true });
    expect(mockMkdirSync).toHaveBeenCalledWith("/host/home/.local/share/opencode", {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/host/home/.local/share/opencode/auth.json",
      "",
      { flag: "a", mode: 0o600 },
    );

    const runArgs = mockExecFileCustom.mock.calls[0]?.[1] as string[];
    expect(runArgs).toEqual(
      expect.arrayContaining([
        "--volume",
        "/host/home/.claude:/tmp/ao-home/.claude",
        "--volume",
        "/host/home/.local/share/opencode/auth.json:/tmp/ao-home/.local/share/opencode/auth.json",
      ]),
    );
  });

  it("passes through requested host env vars when present", async () => {
    const originalOpenAiKey = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-test-openai";
    try {
      mockDockerSuccess("container-id");
      mockDockerSuccess();
      mockDockerSuccess();
      mockDockerSuccess();
      mockDockerSuccess();

      await create().create({
        sessionId: "docker-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "codex --model gpt-5",
        agentRuntimeHints: {
          docker: {
            envFromHost: ["OPENAI_API_KEY"],
          },
        },
        environment: {
          AO_SESSION: "docker-session",
        },
        runtimeConfig: { image: "ao-fake-codex:latest" },
      });

      const runArgs = mockExecFileCustom.mock.calls[0]?.[1] as string[];
      expect(runArgs).toContain("OPENAI_API_KEY=sk-test-openai");
      const tmuxArgs = mockExecFileCustom.mock.calls[2]?.[1] as string[];
      expect(tmuxArgs).toContain("OPENAI_API_KEY=sk-test-openai");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = originalOpenAiKey;
      }
    }
  });

  it("rewrites mounted host paths inside the launch command before sending it to tmux", async () => {
    addFileSystemEntries([
      { path: "/host/.agent/sessions", kind: "dir" },
    ]);

    mockDockerSuccess("container-id");
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();

    await create().create({
      sessionId: "docker-session",
      workspacePath: "/tmp/workspace",
      launchCommand:
        "claude --append-system-prompt \"$(cat '/host/.agent/sessions/orchestrator-prompt.md')\"",
      environment: {
        AO_SESSION: "docker-session",
        AO_DATA_DIR: "/host/.agent/sessions",
      },
      runtimeConfig: { image: "ao-real-claude:latest" },
    });

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      4,
      "docker",
      [
        "exec",
        ...(typeof process.getuid === "function" && typeof process.getgid === "function"
          ? ["--user", `${process.getuid()}:${process.getgid()}`]
          : []),
        "docker-session",
        "tmux",
        "send-keys",
        "-t",
        "docker-session",
        "-l",
        "claude --append-system-prompt \"$(cat '/tmp/ao/data/orchestrator-prompt.md')\"",
      ],
      expectedDockerOptions,
    );
  });

  it("removes the container if startup fails", async () => {
    mockDockerSuccess("container-id");
    mockDockerSuccess();
    mockDockerError("tmux missing");
    mockDockerSuccess();

    await expect(
      create().create({
        sessionId: "docker-session",
        workspacePath: "/tmp/workspace",
        launchCommand: "codex",
        environment: {},
        runtimeConfig: { image: "ghcr.io/example/ao:latest" },
      }),
    ).rejects.toThrow('Failed to create docker runtime for session "docker-session"');

    expect(mockExecFileCustom).toHaveBeenLastCalledWith(
      "docker",
      ["rm", "-f", "docker-session"],
      expectedDockerOptions,
    );
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/ao-runtime-docker-test", {
      recursive: true,
      force: true,
    });
  });
});

describe("runtime.destroy()", () => {
  it("removes the backing container", async () => {
    mockDockerSuccess();

    await create().destroy(makeHandle());

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "container-1"],
      expectedDockerOptions,
    );
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/ao-runtime-handle", {
      recursive: true,
      force: true,
    });
  });
});

describe("runtime.sendMessage()", () => {
  it("clears the current prompt and sends short messages with tmux send-keys", async () => {
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();

    await create().sendMessage(makeHandle(), "please fix ci");

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["exec", "container-1", "tmux", "send-keys", "-t", "tmux-1", "C-u"],
      expectedDockerOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["exec", "container-1", "tmux", "send-keys", "-t", "tmux-1", "-l", "please fix ci"],
      expectedDockerOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "docker",
      ["exec", "container-1", "tmux", "send-keys", "-t", "tmux-1", "Enter"],
      expectedDockerOptions,
    );
  });

  it("uses runtime temp buffers for multiline messages", async () => {
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();
    mockDockerSuccess();

    const message = "line one\nline two";
    await create().sendMessage(makeHandle(), message);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/ao-runtime-handle/.ao-tmux-buffer-test-uuid-1234.txt",
      message,
      { encoding: "utf-8", mode: 0o600 },
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "exec",
        "container-1",
        "tmux",
        "load-buffer",
        "-b",
        "ao-test-uuid-1234",
        "/tmp/ao/runtime/.ao-tmux-buffer-test-uuid-1234.txt",
      ],
      expectedDockerOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "docker",
      [
        "exec",
        "container-1",
        "tmux",
        "paste-buffer",
        "-b",
        "ao-test-uuid-1234",
        "-t",
        "tmux-1",
        "-d",
      ],
      expectedDockerOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      4,
      "docker",
      [
        "exec",
        "container-1",
        "tmux",
        "delete-buffer",
        "-b",
        "ao-test-uuid-1234",
      ],
      expectedDockerOptions,
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      "/tmp/ao-runtime-handle/.ao-tmux-buffer-test-uuid-1234.txt",
    );
  });
});

describe("runtime.getOutput()", () => {
  it("captures pane output from tmux", async () => {
    mockDockerSuccess("hello\nworld");

    await expect(create().getOutput(makeHandle(), 25)).resolves.toBe("hello\nworld");

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "docker",
      ["exec", "container-1", "tmux", "capture-pane", "-t", "tmux-1", "-p", "-S", "-25"],
      expectedDockerOptions,
    );
  });

  it("returns an empty string when capture fails", async () => {
    mockDockerError("capture failed");
    await expect(create().getOutput(makeHandle())).resolves.toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when docker inspect reports a running container", async () => {
    mockDockerSuccess("true");
    await expect(create().isAlive(makeHandle())).resolves.toBe(true);
  });

  it("returns false when docker inspect fails", async () => {
    mockDockerError("missing");
    await expect(create().isAlive(makeHandle())).resolves.toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("reports uptime plus docker cpu and memory metrics when available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(11_000);
    mockDockerSuccess('{"CPUPerc":"12.5%","MemUsage":"128MiB / 2GiB"}');
    const runtime = create();
    expect(runtime.getMetrics).toBeDefined();
    await expect(runtime.getMetrics!(makeHandle())).resolves.toEqual({
      uptimeMs: 10_000,
      cpuPercent: 12.5,
      memoryMb: 128,
    });
  });

  it("falls back to uptime-only metrics when docker stats fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(11_000);
    mockDockerError("stats failed");
    const runtime = create();
    expect(runtime.getMetrics).toBeDefined();
    await expect(runtime.getMetrics!(makeHandle())).resolves.toEqual({ uptimeMs: 10_000 });
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns structured docker attach information", async () => {
    const runtime = create();
    expect(runtime.getAttachInfo).toBeDefined();
    await expect(runtime.getAttachInfo!(makeHandle())).resolves.toEqual({
      type: "docker",
      target: "container-1",
      command: "docker exec -it container-1 tmux attach -t tmux-1",
      program: "docker",
      args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      requiresPty: true,
    });
  });
});
