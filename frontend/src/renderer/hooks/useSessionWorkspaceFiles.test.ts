import { describe, expect, it } from "vitest";
import { workspaceFilesRefetchInterval } from "./useSessionWorkspaceFiles";

describe("workspaceFilesRefetchInterval", () => {
	it("polls only while workspace SSE is degraded", () => {
		expect(workspaceFilesRefetchInterval("connecting")).toBe(false);
		expect(workspaceFilesRefetchInterval("connected")).toBe(false);
		expect(workspaceFilesRefetchInterval("degraded")).toBe(30_000);
	});

	it("polls while recovering from a failed refresh with cached data", () => {
		expect(workspaceFilesRefetchInterval("connected", true)).toBe(30_000);
	});
});
