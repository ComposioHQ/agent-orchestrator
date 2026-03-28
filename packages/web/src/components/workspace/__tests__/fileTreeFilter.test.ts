import { describe, it, expect } from "vitest";
import { filterTreeToChanged } from "../fileTreeFilter";
import type { FileNode } from "@/app/api/sessions/[id]/files/route";

describe("filterTreeToChanged", () => {
  it("keeps only files with git status and prunes empty directories", () => {
    const tree: FileNode[] = [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          { name: "foo.ts", path: "src/foo.ts", type: "file" },
          { name: "bar", path: "src/bar", type: "directory", children: [{ name: "baz.ts", path: "src/bar/baz.ts", type: "file" }] },
          { name: "unused", path: "src/unused", type: "directory", children: [{ name: "x.ts", path: "src/unused/x.ts", type: "file" }] },
        ],
      },
      { name: "readme.md", path: "readme.md", type: "file" },
    ];

    const gitStatus = { "src/foo.ts": "M" as const, "src/bar/baz.ts": "A" as const };

    const out = filterTreeToChanged(tree, gitStatus);

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("src");
    const src = out[0];
    expect(src.type).toBe("directory");
    if (src.type !== "directory" || !src.children) throw new Error("expected directory");
    expect(src.children).toHaveLength(2);
    expect(src.children[0].path).toBe("src/foo.ts");
    const bar = src.children[1];
    expect(bar.name).toBe("bar");
    if (bar.type !== "directory" || !bar.children) throw new Error("expected bar dir");
    expect(bar.children).toHaveLength(1);
    expect(bar.children[0].path).toBe("src/bar/baz.ts");
  });

  it("returns empty when no paths match", () => {
    const tree: FileNode[] = [{ name: "a.ts", path: "a.ts", type: "file" }];
    expect(filterTreeToChanged(tree, {})).toHaveLength(0);
  });
});
