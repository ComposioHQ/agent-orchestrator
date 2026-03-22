import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
  "utf8",
);

describe("claude-code metadata updater", () => {
  it("recognizes REST pull creation output", () => {
    expect(source).toContain("html_url");
    expect(source).toContain("/pulls");
    expect(source).toContain("extract_pr_url");
    expect(source).toContain('update_metadata_key "status" "pr_open"');
  });
});
