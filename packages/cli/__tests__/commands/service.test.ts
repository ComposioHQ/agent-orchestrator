import { describe, it, expect } from "vitest";
import {
  sanitizeProjectId,
  escapeXml,
  quoteSystemdValue,
  generateLaunchdPlist,
  generateSystemdUnit,
} from "../../src/commands/service.js";

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
    expect(escapeXml("my-project")).toBe("my-project");
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

describe("generateLaunchdPlist", () => {
  it("generates valid XML with escaped values", () => {
    const plist = generateLaunchdPlist("my-app", "/usr/bin/ao", "/home/user/config.yaml");
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<string>com.composio.ao-lifecycle.my-app</string>");
    expect(plist).toContain("<string>/usr/bin/ao</string>");
    expect(plist).toContain("<string>my-app</string>");
    expect(plist).toContain("<string>/home/user/config.yaml</string>");
    expect(plist).toContain("<true/>");
  });

  it("escapes XML-unsafe characters in projectId", () => {
    const plist = generateLaunchdPlist("my<app", "/usr/bin/ao", "/config.yaml");
    expect(plist).toContain("<string>my&lt;app</string>");
    // Label uses sanitized version
    expect(plist).toContain("com.composio.ao-lifecycle.my-app");
  });

  it("escapes XML-unsafe characters in binary path", () => {
    const plist = generateLaunchdPlist("app", "/path/with & special/ao", "/config.yaml");
    expect(plist).toContain("<string>/path/with &amp; special/ao</string>");
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
  });

  it("properly quotes paths with spaces", () => {
    const unit = generateSystemdUnit("my app", "/path/with spaces/ao", "/config path/config.yaml");
    expect(unit).toContain('ExecStart="/path/with spaces/ao" lifecycle-worker "my app"');
    expect(unit).toContain('"AO_CONFIG_PATH=/config path/config.yaml"');
    // Description uses sanitized ID
    expect(unit).toContain("AO Lifecycle Worker (my-app)");
  });

  it("escapes shell-special characters in binary path", () => {
    const unit = generateSystemdUnit("app", '/path/with$dollar/"quotes"/ao', "/config.yaml");
    expect(unit).toContain('ExecStart="/path/with$$dollar/\\"quotes\\"/ao"');
  });
});
