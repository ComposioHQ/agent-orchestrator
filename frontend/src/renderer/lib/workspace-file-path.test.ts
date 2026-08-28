import { describe, expect, it } from "vitest";
import { matchWorkspaceFilePath } from "./workspace-file-path";

describe("matchWorkspaceFilePath", () => {
	const files = [
		{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0, binary: false, size: 12 },
		{ path: "docs/report.md", status: "added" as const, additions: 10, deletions: 0, binary: false, size: 40 },
	];

	it("matches an exact workspace path", () => {
		expect(matchWorkspaceFilePath("src/a.ts", files)).toBe("src/a.ts");
	});

	it("matches a basename from a turn diff", () => {
		expect(matchWorkspaceFilePath("report.md", files)).toBe("docs/report.md");
	});

	it("matches a suffix path", () => {
		expect(matchWorkspaceFilePath("a.ts", files)).toBe("src/a.ts");
	});

	it("normalizes leading ./", () => {
		expect(matchWorkspaceFilePath("./src/a.ts", files)).toBe("src/a.ts");
	});

	it("falls back to the normalized request when nothing matches", () => {
		expect(matchWorkspaceFilePath("missing.txt", files)).toBe("missing.txt");
	});
});
