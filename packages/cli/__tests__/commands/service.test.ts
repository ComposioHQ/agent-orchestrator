import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

const { mockExistsSync, mockMkdirSync, mockUnlinkSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockMkdirSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

const { mockPlatform, mockHomedir } = vi.hoisted(() => ({
  mockPlatform: vi.fn().mockReturnValue("darwin"),
  mockHomedir: vi.fn().mockReturnValue("/home/testuser"),
}));

const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal() as typeof import("node:os");
  return {
    ...original,
    platform: () => mockPlatform(),
    homedir: () => mockHomedir(),
  };
});

vi.mock("@composio/ao-core", () => ({
  loadConfig: () => mockLoadConfig(),
}));

import {
  sanitizeProjectId,
  escapeXml,
  quoteSystemdValue,
  generateLaunchdPlist,
  generateSystemdUnit,
  getLaunchdPath,
  getSystemdPath,
  installService,
  uninstallService,
  getServiceStatus,
} from "../../src/commands/service.js";

import type { OrchestratorConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockConfig = {
  configPath: "/home/testuser/project/agent-orchestrator.yaml",
  projects: { "my-app": { path: "/home/testuser/project" } },
} as unknown as OrchestratorConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.mockReturnValue("darwin");
  mockHomedir.mockReturnValue("/home/testuser");
  mockExistsSync.mockReturnValue(false);
  // Stub process.argv for resolveAoBinary
  process.argv[1] = "/usr/local/bin/ao";
  mockExistsSync.mockImplementation((path: string) => path === "/usr/local/bin/ao");
});

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("sanitizeProjectId", () => {
  it("passes through valid alphanumeric IDs", () => {
    expect(sanitizeProjectId("my-app")).toBe("my-app");
    expect(sanitizeProjectId("app_v2")).toBe("app_v2");
    expect(sanitizeProjectId("TestProject123")).toBe("TestProject123");
  });

  it("replaces special characters with hyphens", () => {
    expect(sanitizeProjectId("my app")).toBe("my-app");
    expect(sanitizeProjectId("foo/bar")).toBe("foo-bar");
    expect(sanitizeProjectId("a.b.c")).toBe("a-b-c");
    expect(sanitizeProjectId("hello@world!")).toBe("hello-world-");
  });
});

describe("escapeXml", () => {
  it("escapes XML special characters", () => {
    expect(escapeXml("foo & bar")).toBe("foo &amp; bar");
    expect(escapeXml("<script>")).toBe("&lt;script&gt;");
    expect(escapeXml('"quoted"')).toBe("&quot;quoted&quot;");
    expect(escapeXml("it's")).toBe("it&apos;s");
  });

  it("passes through safe strings unchanged", () => {
    expect(escapeXml("/usr/local/bin/ao")).toBe("/usr/local/bin/ao");
  });

  it("handles combined special characters", () => {
    expect(escapeXml('a<b&c"d\'e>f')).toBe("a&lt;b&amp;c&quot;d&apos;e&gt;f");
  });
});

describe("quoteSystemdValue", () => {
  it("wraps simple values in quotes", () => {
    expect(quoteSystemdValue("/usr/bin/ao")).toBe('"/usr/bin/ao"');
  });

  it("escapes backslashes", () => {
    expect(quoteSystemdValue("C:\\Users\\test")).toBe('"C:\\\\Users\\\\test"');
  });

  it("escapes double quotes", () => {
    expect(quoteSystemdValue('say "hello"')).toBe('"say \\"hello\\""');
  });

  it("escapes dollar signs for systemd", () => {
    expect(quoteSystemdValue("$HOME/bin")).toBe('"$$HOME/bin"');
  });

  it("handles paths with spaces", () => {
    expect(quoteSystemdValue("/path/with spaces/ao")).toBe('"/path/with spaces/ao"');
  });
});

// ---------------------------------------------------------------------------
// Generator tests
// ---------------------------------------------------------------------------

describe("generateLaunchdPlist", () => {
  it("generates valid XML with escaped values", () => {
    const plist = generateLaunchdPlist("my-app", "/usr/bin/ao", "/home/user/config.yaml");
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<string>com.composio.ao-lifecycle.my-app</string>");
    expect(plist).toContain("<string>/usr/bin/ao</string>");
    expect(plist).toContain("<string>my-app</string>");
    expect(plist).toContain("<string>/home/user/config.yaml</string>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("RunAtLoad");
    expect(plist).toContain("KeepAlive");
    expect(plist).toContain("ThrottleInterval");
    expect(plist).toContain("StandardOutPath");
    expect(plist).toContain("lifecycle-my-app.log");
  });

  it("escapes XML-unsafe characters in projectId", () => {
    const plist = generateLaunchdPlist("my<app", "/usr/bin/ao", "/config.yaml");
    expect(plist).toContain("<string>my&lt;app</string>");
    expect(plist).toContain("com.composio.ao-lifecycle.my-app");
  });

  it("escapes XML-unsafe characters in binary path", () => {
    const plist = generateLaunchdPlist("app", "/path/with & special/ao", "/config.yaml");
    expect(plist).toContain("<string>/path/with &amp; special/ao</string>");
  });

  it("includes PATH with homedir-based .local/bin", () => {
    const plist = generateLaunchdPlist("app", "/usr/bin/ao", "/config.yaml");
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain(".local/bin");
  });
});

describe("generateSystemdUnit", () => {
  it("generates a valid unit file", () => {
    const unit = generateSystemdUnit("my-app", "/usr/bin/ao", "/home/user/config.yaml");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("AO Lifecycle Worker (my-app)");
    expect(unit).toContain('ExecStart="/usr/bin/ao" lifecycle-worker "my-app"');
    expect(unit).toContain('"AO_CONFIG_PATH=/home/user/config.yaml"');
    expect(unit).toContain("SyslogIdentifier=ao-lifecycle-my-app");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("After=network.target");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("properly quotes paths with spaces", () => {
    const unit = generateSystemdUnit("my app", "/path/with spaces/ao", "/config path/config.yaml");
    expect(unit).toContain('ExecStart="/path/with spaces/ao" lifecycle-worker "my app"');
    expect(unit).toContain('"AO_CONFIG_PATH=/config path/config.yaml"');
    expect(unit).toContain("AO Lifecycle Worker (my-app)");
  });

  it("escapes shell-special characters in binary path", () => {
    const unit = generateSystemdUnit("app", '/path/with$dollar/"quotes"/ao', "/config.yaml");
    expect(unit).toContain('ExecStart="/path/with$$dollar/\\"quotes\\"/ao"');
  });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("getLaunchdPath", () => {
  it("returns path under ~/Library/LaunchAgents", () => {
    const path = getLaunchdPath("my-app");
    expect(path).toContain("Library/LaunchAgents");
    expect(path).toContain("com.composio.ao-lifecycle.my-app.plist");
  });

  it("sanitizes project ID in path", () => {
    const path = getLaunchdPath("my app/v2");
    expect(path).toContain("com.composio.ao-lifecycle.my-app-v2.plist");
  });
});

describe("getSystemdPath", () => {
  it("returns path under ~/.config/systemd/user", () => {
    const path = getSystemdPath("my-app");
    expect(path).toContain(".config/systemd/user");
    expect(path).toContain("ao-lifecycle-my-app.service");
  });

  it("sanitizes project ID in path", () => {
    const path = getSystemdPath("my app/v2");
    expect(path).toContain("ao-lifecycle-my-app-v2.service");
  });
});

// ---------------------------------------------------------------------------
// Install / Uninstall / Status
// ---------------------------------------------------------------------------

describe("installService", () => {
  it("installs launchd plist on macOS", () => {
    mockPlatform.mockReturnValue("darwin");

    const result = installService("my-app", mockConfig);

    expect(result.platform).toBe("launchd");
    expect(result.servicePath).toContain("com.composio.ao-lifecycle.my-app.plist");
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain("<?xml version=");
    expect(writtenContent).toContain("my-app");
  });

  it("activates launchd service on success", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExecFileSync.mockReturnValue("");

    const result = installService("my-app", mockConfig);

    expect(result.activated).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["load", expect.stringContaining("plist")],
      expect.any(Object),
    );
  });

  it("unloads existing plist before install", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      if (path === "/usr/local/bin/ao") return true;
      return false;
    });

    installService("my-app", mockConfig);

    // First call should be unload, second should be load
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["unload", expect.stringContaining("plist")],
      expect.any(Object),
    );
  });

  it("handles launchctl load failure gracefully", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "load") throw new Error("launchctl load failed");
      return "";
    });

    const result = installService("my-app", mockConfig);

    expect(result.activated).toBe(false);
  });

  it("installs systemd unit on Linux", () => {
    mockPlatform.mockReturnValue("linux");

    const result = installService("my-app", mockConfig);

    expect(result.platform).toBe("systemd");
    expect(result.servicePath).toContain("ao-lifecycle-my-app.service");
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain("[Unit]");
    expect(writtenContent).toContain("[Service]");
  });

  it("enables systemd service on success", () => {
    mockPlatform.mockReturnValue("linux");
    mockExecFileSync.mockReturnValue("");

    const result = installService("my-app", mockConfig);

    expect(result.activated).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "daemon-reload"],
      expect.any(Object),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "enable", "--now", "ao-lifecycle-my-app.service"],
      expect.any(Object),
    );
  });

  it("handles systemctl failure gracefully", () => {
    mockPlatform.mockReturnValue("linux");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("systemctl not found");
    });

    const result = installService("my-app", mockConfig);

    expect(result.activated).toBe(false);
  });

  it("throws on unsupported platform", () => {
    mockPlatform.mockReturnValue("win32");

    expect(() => installService("my-app", mockConfig)).toThrow("Unsupported platform");
  });

  it("falls back to 'ao' binary when which fails", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/usr/local/bin/ao") return false;
      return false;
    });
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === "which") throw new Error("not in PATH");
      return "";
    });

    const result = installService("my-app", mockConfig);
    expect(result.activated).toBe(true);
    // Verify the generated content uses fallback "ao" or resolved path
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain("<string>ao</string>");
  });

  it("handles writeFileSync failure during install", () => {
    mockPlatform.mockReturnValue("darwin");
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => installService("my-app", mockConfig)).toThrow("disk full");
  });
});

describe("uninstallService", () => {
  it("removes launchd plist on macOS", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      return false;
    });

    const result = uninstallService("my-app");

    expect(result.removed).toBe(true);
    expect(result.servicePath).toContain("plist");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["unload", expect.stringContaining("plist")],
      expect.any(Object),
    );
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("returns not removed when plist doesn't exist", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockReturnValue(false);

    const result = uninstallService("my-app");

    expect(result.removed).toBe(false);
  });

  it("removes systemd unit on Linux", () => {
    mockPlatform.mockReturnValue("linux");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".service")) return true;
      return false;
    });

    const result = uninstallService("my-app");

    expect(result.removed).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "disable", "--now", "ao-lifecycle-my-app.service"],
      expect.any(Object),
    );
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "daemon-reload"],
      expect.any(Object),
    );
  });

  it("returns not removed when service doesn't exist on Linux", () => {
    mockPlatform.mockReturnValue("linux");
    mockExistsSync.mockReturnValue(false);

    const result = uninstallService("my-app");

    expect(result.removed).toBe(false);
  });

  it("handles launchctl unload failure gracefully", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      return false;
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not loaded");
    });

    const result = uninstallService("my-app");

    expect(result.removed).toBe(true); // Still removes file
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("throws on unsupported platform", () => {
    mockPlatform.mockReturnValue("win32");
    expect(() => uninstallService("my-app")).toThrow("Unsupported platform");
  });

  it("handles systemctl disable failure gracefully", () => {
    mockPlatform.mockReturnValue("linux");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".service")) return true;
      return false;
    });
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "disable") throw new Error("not running");
      return "";
    });

    const result = uninstallService("my-app");
    expect(result.removed).toBe(true); // Still removes file
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("handles unlinkSync failure gracefully", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      return false;
    });
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(() => uninstallService("my-app")).toThrow("permission denied");
  });
});

describe("getServiceStatus", () => {
  it("returns not installed when plist doesn't exist on macOS", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockReturnValue(false);

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
  });

  it("detects installed and running on macOS", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      return false;
    });
    mockExecFileSync.mockReturnValue("123\t0\tcom.composio.ao-lifecycle.my-app\n");

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
  });

  it("detects installed but not running on macOS", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      return false;
    });
    mockExecFileSync.mockReturnValue("123\t0\tcom.other.service\n");

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
  });

  it("handles launchctl list failure on macOS", () => {
    mockPlatform.mockReturnValue("darwin");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      return false;
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("launchctl failed");
    });

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
  });

  it("returns not installed when unit doesn't exist on Linux", () => {
    mockPlatform.mockReturnValue("linux");
    mockExistsSync.mockReturnValue(false);

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
  });

  it("detects installed and running on Linux", () => {
    mockPlatform.mockReturnValue("linux");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".service")) return true;
      return false;
    });
    mockExecFileSync.mockReturnValue("active\n");

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
  });

  it("detects installed but not running on Linux", () => {
    mockPlatform.mockReturnValue("linux");
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".service")) return true;
      return false;
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("inactive");
    });

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
  });

  it("returns empty on unsupported platform", () => {
    mockPlatform.mockReturnValue("win32");

    const status = getServiceStatus("my-app");

    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.servicePath).toBe("");
  });
});
