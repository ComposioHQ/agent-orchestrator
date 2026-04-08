import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { buildAgentPath, buildNodeWrapper, setupPathWrapperWorkspace } from "../agent-workspace-hooks.js";

const { mockWriteFile, mockMkdir, mockReadFile, mockRename, mockIsWindows } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockIsWindows: vi.fn().mockReturnValue(false),
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

vi.mock("../platform.js", () => ({
  isWindows: mockIsWindows,
}));

// On Windows, path.join('/home/testuser', '.ao', 'bin') => '\home\testuser\.ao\bin'
// Use join() so assertions match the runtime path format
const AO_BIN_DIR = join("/home/testuser", ".ao", "bin");

describe("buildAgentPath", () => {
  beforeEach(() => {
    mockIsWindows.mockReturnValue(false);
  });

  it("prepends ao bin dir to PATH", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    expect(result).toContain(AO_BIN_DIR);
    expect(result.startsWith(AO_BIN_DIR)).toBe(true);
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
    expect(result).toContain(AO_BIN_DIR);
    expect(result.startsWith(AO_BIN_DIR)).toBe(true);
    expect(result).toContain("/usr/bin");
  });

  it("ensures /usr/local/bin is early for gh resolution", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    const entries = result.split(":");
    const aoIdx = entries.indexOf(AO_BIN_DIR);
    const ghIdx = entries.indexOf("/usr/local/bin");
    expect(aoIdx).toBe(0);
    expect(ghIdx).toBe(1);
  });
});

describe("setupPathWrapperWorkspace (Unix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(false);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  it("creates ao bin directory", async () => {
    await setupPathWrapperWorkspace("/workspace");
    expect(mockMkdir).toHaveBeenCalledWith(
      AO_BIN_DIR,
      { recursive: true },
    );
  });

  it("writes wrapper scripts when version marker is missing", async () => {
    await setupPathWrapperWorkspace("/workspace");
    // atomicWriteFile writes to .tmp then renames
    expect(mockRename).toHaveBeenCalled();
    // .ao/AGENTS.md is written directly (path.join may use / or \ depending on platform)
    const agentsMdWrites = mockWriteFile.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
  });

  it("skips wrapper rewrite when version matches", async () => {
    mockReadFile
      .mockResolvedValueOnce("0.4.0") // version marker matches
      .mockRejectedValueOnce(new Error("ENOENT")); // AGENTS.md doesn't exist

    await setupPathWrapperWorkspace("/workspace");

    // No gh/git/marker renames when version matches
    const renamedPaths = mockRename.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(renamedPaths.filter((p: string) => p.includes("gh."))).toHaveLength(0);
    expect(renamedPaths.filter((p: string) => p.includes("git."))).toHaveLength(0);
  });

  it("writes .ao/AGENTS.md with session context", async () => {
    await setupPathWrapperWorkspace("/workspace");

    const agentsMdWrites = mockWriteFile.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
    expect(String(agentsMdWrites[0][1])).toContain("Agent Orchestrator");
  });

  it("writes bash wrappers (not .cmd) on Unix", async () => {
    await setupPathWrapperWorkspace("/workspace");

    const writtenPaths = mockWriteFile.mock.calls.map((c: unknown[]) => String(c[0]));
    const renamedPaths = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));
    const allPaths = [...writtenPaths, ...renamedPaths];

    // Should have bash scripts for gh and git (no extension)
    const hasBashGh = allPaths.some((p: string) => p.endsWith("/gh") || p.endsWith("\\gh"));
    const hasBashGit = allPaths.some((p: string) => p.endsWith("/git") || p.endsWith("\\git"));
    expect(hasBashGh).toBe(true);
    expect(hasBashGit).toBe(true);

    // Should NOT have .cmd shims on Unix
    const hasCmdFiles = allPaths.some((p: string) => p.endsWith(".cmd"));
    expect(hasCmdFiles).toBe(false);
  });
});

describe("setupPathWrapperWorkspace (Windows)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  it("generates .cmd shims instead of bash scripts", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    // atomicWriteFile: writeFile(tmp) -> rename(tmp, final)
    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    const hasCmdGh = renamedFinal.some((p: string) => p.endsWith("gh.cmd"));
    const hasCmdGit = renamedFinal.some((p: string) => p.endsWith("git.cmd"));
    expect(hasCmdGh).toBe(true);
    expect(hasCmdGit).toBe(true);
  });

  it("generates .cjs wrapper files on Windows", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    const hasCjsGh = renamedFinal.some((p: string) => p.endsWith("gh.cjs"));
    const hasCjsGit = renamedFinal.some((p: string) => p.endsWith("git.cjs"));
    expect(hasCjsGh).toBe(true);
    expect(hasCjsGit).toBe(true);
  });

  it("does NOT generate bash wrappers on Windows", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    // Bash wrappers have no extension — check nothing ends with just /gh or \gh
    const hasBashGh = renamedFinal.some(
      (p: string) => p.endsWith("/gh") || p.endsWith("\\gh"),
    );
    const hasBashGit = renamedFinal.some(
      (p: string) => p.endsWith("/git") || p.endsWith("\\git"),
    );
    expect(hasBashGh).toBe(false);
    expect(hasBashGit).toBe(false);
  });

  it("does NOT generate ao-metadata-helper.sh on Windows", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));
    const hasHelper = renamedFinal.some((p: string) => p.includes("ao-metadata-helper"));
    expect(hasHelper).toBe(false);
  });

  it(".cmd shim content delegates to node wrapper", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    // Find .cmd write content — tmp file is written then renamed
    const tmpWrites = mockWriteFile.mock.calls;
    const cmdWrite = tmpWrites.find((c: unknown[]) => {
      const content = String(c[1]);
      return content.includes("@node") && content.includes("%~dp0");
    });
    expect(cmdWrite).toBeDefined();
    expect(String(cmdWrite![1])).toMatch(/@node "%~dp0(gh|git)\.cjs" %\*/);
  });

  it("writes .ao/AGENTS.md on Windows too", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const agentsMdWrites = mockWriteFile.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
    expect(String(agentsMdWrites[0][1])).toContain("Agent Orchestrator");
  });

  it("uses semicolon as PATH delimiter on Windows", () => {
    const result = buildAgentPath("C:\\tools;C:\\Windows\\System32");
    // On Windows, delimiter should be ;
    expect(result).toContain(";");
    expect(result).toContain("C:\\tools");
    expect(result).toContain("C:\\Windows\\System32");
    // The ao bin dir should be first entry (joined with ;)
    const entries = result.split(";");
    expect(entries[0]).toBe(AO_BIN_DIR);
  });
});

describe("buildNodeWrapper", () => {
  it("gh wrapper contains PR URL extraction pattern", () => {
    const script = buildNodeWrapper("gh", "");
    expect(script).toContain("pr/create");
    expect(script).toContain("pr/merge");
    // The regex pattern for github PR URLs (escaped inside a JS regex literal in the generated script)
    expect(script).toContain("github");
    expect(script).toContain("pull");
    expect(script).toContain("updateAoMetadata");
  });

  it("gh wrapper contains metadata update calls for pr_open", () => {
    const script = buildNodeWrapper("gh", "");
    expect(script).toContain("pr_open");
    expect(script).toContain('"pr"');
    expect(script).toContain('"status"');
  });

  it("git wrapper intercepts checkout -b and switch -c", () => {
    const script = buildNodeWrapper("git", "");
    expect(script).toContain("checkout/-b");
    expect(script).toContain("switch/-c");
    expect(script).toContain("updateAoMetadata");
    expect(script).toContain('"branch"');
  });

  it("git wrapper skips non-feature branches", () => {
    const script = buildNodeWrapper("git", "");
    // The script should check for / or - in branch name
    expect(script).toContain('branch.includes("/") || branch.includes("-")');
  });

  it("wrappers use path.delimiter for PATH splitting", () => {
    const ghScript = buildNodeWrapper("gh", "");
    const gitScript = buildNodeWrapper("git", "");
    expect(ghScript).toContain("path.delimiter");
    expect(gitScript).toContain("path.delimiter");
  });

  it("gh wrapper uses explicit realBinaryPath when provided", () => {
    const script = buildNodeWrapper("gh", "C:\\tools\\gh.exe");
    expect(script).toContain("C:\\\\tools\\\\gh.exe");
  });
});
