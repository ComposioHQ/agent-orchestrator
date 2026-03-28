import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, syntheticUntrackedHunks } from "../diffParse";

const SAMPLE = `diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,6 +10,8 @@ function example() {
   context line
-  removed line
+  added line
+  another added line
   context line
`;

describe("parseUnifiedDiff", () => {
  it("skips preamble and parses hunks with context, removed, added", () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toContain("@@ -10,6 +10,8 @@");
    const lines = hunks[0].lines;
    expect(lines.some((l) => l.type === "context" && l.content === "  context line")).toBe(true);
    expect(lines.some((l) => l.type === "removed" && l.content === "  removed line")).toBe(true);
    expect(lines.filter((l) => l.type === "added").map((l) => l.content)).toEqual([
      "  added line",
      "  another added line",
    ]);
  });

  it("skips \\ No newline at end of file lines", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "\\ No newline at end of file",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.every((l) => !l.content.includes("No newline"))).toBe(true);
    expect(hunks[0].lines.filter((l) => l.type === "removed")).toHaveLength(1);
    expect(hunks[0].lines.filter((l) => l.type === "added")).toHaveLength(1);
  });

  it("treats blank line in hunk as context (leading space, empty rest)", () => {
    const diff = ["@@ -1,2 +1,2 @@", " first", " ", " third"].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0]?.lines.some((l) => l.type === "context" && l.content === "")).toBe(true);
  });

  it("parses multiple hunks", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-a1", "+b1", "@@ -2,1 +2,1 @@", "-a2", "+b2"].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines.some((l) => l.type === "removed" && l.content === "a1")).toBe(true);
    expect(hunks[1].lines.some((l) => l.type === "added" && l.content === "b2")).toBe(true);
  });
});

describe("syntheticUntrackedHunks", () => {
  it("marks every line as added with 1-based new line numbers", () => {
    const hunks = syntheticUntrackedHunks("line1\nline2");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(2);
    expect(hunks[0].lines[0]).toMatchObject({
      type: "added",
      content: "line1",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    expect(hunks[0].lines[1]).toMatchObject({
      type: "added",
      content: "line2",
      oldLineNumber: null,
      newLineNumber: 2,
    });
  });
});
