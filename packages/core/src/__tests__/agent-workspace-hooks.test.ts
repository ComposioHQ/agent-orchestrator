import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAgentPath,
  setupPathWrapperWorkspace,
  AO_METADATA_HELPER,
  GH_WRAPPER,
} from "../agent-workspace-hooks.js";

const { mockWriteFile, mockMkdir, mockReadFile, mockRename } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  rename: mockRename,
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

describe("buildAgentPath", () => {
  it("prepends ao bin dir to PATH", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    expect(result).toMatch(/^\/home\/testuser\/.ao\/bin:/);
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("deduplicates entries", () => {
    const result = buildAgentPath("/usr/local/bin:/usr/bin:/usr/local/bin");
    const entries = result.split(":");
    const unique = new Set(entries);
    expect(entries.length).toBe(unique.size);
  });

  it("uses default PATH when basePath is undefined", () => {
    const result = buildAgentPath(undefined);
    expect(result).toMatch(/^\/home\/testuser\/.ao\/bin:/);
    expect(result).toContain("/usr/bin");
  });

  it("ensures /usr/local/bin is early for gh resolution", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    const entries = result.split(":");
    const aoIdx = entries.indexOf("/home/testuser/.ao/bin");
    const ghIdx = entries.indexOf("/usr/local/bin");
    expect(aoIdx).toBe(0);
    expect(ghIdx).toBe(1);
  });
});

describe("setupPathWrapperWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  it("creates ao bin directory", async () => {
    await setupPathWrapperWorkspace("/workspace");
    expect(mockMkdir).toHaveBeenCalledWith("/home/testuser/.ao/bin", { recursive: true });
  });

  it("writes wrapper scripts when version marker is missing", async () => {
    await setupPathWrapperWorkspace("/workspace");
    // atomicWriteFile writes to .tmp then renames
    expect(mockRename).toHaveBeenCalled();
    // .ao/AGENTS.md is written directly
    const agentsMdWrites = mockWriteFile.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes(".ao/AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
  });

  it("skips wrapper rewrite when version matches", async () => {
    mockReadFile
      .mockResolvedValueOnce("0.4.0") // version marker matches
      .mockRejectedValueOnce(new Error("ENOENT")); // AGENTS.md doesn't exist

    await setupPathWrapperWorkspace("/workspace");

    // Only metadata helper rename (1), no gh/git/marker renames
    const renamedPaths = mockRename.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(renamedPaths.filter((p: string) => p.includes("/gh."))).toHaveLength(0);
    expect(renamedPaths.filter((p: string) => p.includes("/git."))).toHaveLength(0);
  });

  it("writes .ao/AGENTS.md with session context", async () => {
    await setupPathWrapperWorkspace("/workspace");

    const agentsMdWrites = mockWriteFile.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes(".ao/AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
    expect(String(agentsMdWrites[0][1])).toContain("Agent Orchestrator");
  });
});

describe("AO_METADATA_HELPER", () => {
  it("contains update_ao_metadata function", () => {
    expect(AO_METADATA_HELPER).toContain("update_ao_metadata()");
  });

  it("contains read_ao_metadata function", () => {
    expect(AO_METADATA_HELPER).toContain("read_ao_metadata()");
  });

  it("contains cache helper functions", () => {
    expect(AO_METADATA_HELPER).toContain("ao_cache_dir()");
    expect(AO_METADATA_HELPER).toContain("ao_cache_fresh()");
    expect(AO_METADATA_HELPER).toContain("ao_cache_read()");
    expect(AO_METADATA_HELPER).toContain("ao_cache_write()");
  });

  it("uses .ghcache subdirectory for cache storage", () => {
    expect(AO_METADATA_HELPER).toContain(".ghcache");
  });

  it("validates environment in shared _ao_validate_env", () => {
    expect(AO_METADATA_HELPER).toContain("_ao_validate_env()");
    expect(AO_METADATA_HELPER).toContain("AO_DATA_DIR");
    expect(AO_METADATA_HELPER).toContain("AO_SESSION");
  });

  it("validates trusted roots for path traversal prevention", () => {
    expect(AO_METADATA_HELPER).toContain(".agent-orchestrator");
    expect(AO_METADATA_HELPER).toContain("/tmp/*");
  });
});

describe("GH_WRAPPER", () => {
  it("contains PR discovery cache intercept", () => {
    expect(GH_WRAPPER).toContain('$1" == "pr" && "$2" == "list"');
    expect(GH_WRAPPER).toContain("pr-discovery-");
    expect(GH_WRAPPER).toContain("ao_cache_fresh");
    expect(GH_WRAPPER).toContain("ao_cache_read");
  });

  it("requires --head and --limit 1 for PR discovery cache", () => {
    expect(GH_WRAPPER).toContain("_ao_head");
    expect(GH_WRAPPER).toContain("_ao_limit");
    expect(GH_WRAPPER).toContain('"$_ao_limit" == "1"');
  });

  it("does not cache empty PR discovery results", () => {
    expect(GH_WRAPPER).toContain('"$_ao_trimmed" != "[]"');
  });

  it("passes through on unsupported flags for PR discovery", () => {
    expect(GH_WRAPPER).toContain("--search");
    expect(GH_WRAPPER).toContain("--state");
    expect(GH_WRAPPER).toContain("--assignee");
    expect(GH_WRAPPER).toContain("--label");
    expect(GH_WRAPPER).toContain("--jq");
    expect(GH_WRAPPER).toContain("--template");
    expect(GH_WRAPPER).toContain("_ao_cacheable=false");
  });

  it("contains issue context cache intercept with 300s TTL", () => {
    expect(GH_WRAPPER).toContain('$1" == "issue" && "$2" == "view"');
    expect(GH_WRAPPER).toContain("issue-ctx-");
    expect(GH_WRAPPER).toContain("ao_cache_fresh");
    expect(GH_WRAPPER).toContain("300");
  });

  it("passes through on --web and --comments for issue view", () => {
    expect(GH_WRAPPER).toContain("--web");
    expect(GH_WRAPPER).toContain("--comments");
  });

  it("populates PR discovery cache after gh pr create", () => {
    expect(GH_WRAPPER).toContain("pr/create)");
    expect(GH_WRAPPER).toContain("read_ao_metadata branch");
    expect(GH_WRAPPER).toContain("ao_cache_write");
    expect(GH_WRAPPER).toContain("pr-discovery-");
  });

  it("still passes through unmatched commands", () => {
    expect(GH_WRAPPER).toContain('exec "$real_gh" "$@"');
  });

  it("uses current wrapper version in trace logging", () => {
    expect(GH_WRAPPER).toContain("0.4.0");
  });
});
