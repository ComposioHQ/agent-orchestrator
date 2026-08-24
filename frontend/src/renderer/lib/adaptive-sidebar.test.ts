import { describe, expect, it } from "vitest";
import { adaptiveSidebarShouldCompact } from "./adaptive-sidebar";

describe("adaptiveSidebarShouldCompact", () => {
	it("enters compact mode only when the expanded layout cannot meet demand", () => {
		expect(
			adaptiveSidebarShouldCompact({ expandedContentWidth: 1040, workspaceDemand: 1068, isCompact: false }),
		).toBe(true);
		expect(
			adaptiveSidebarShouldCompact({ expandedContentWidth: 1120, workspaceDemand: 1068, isCompact: false }),
		).toBe(false);
	});

	it("uses a wider release boundary to avoid threshold oscillation", () => {
		expect(
			adaptiveSidebarShouldCompact({ expandedContentWidth: 1100, workspaceDemand: 1068, isCompact: true }),
		).toBe(true);
		expect(
			adaptiveSidebarShouldCompact({ expandedContentWidth: 1132, workspaceDemand: 1068, isCompact: true }),
		).toBe(false);
	});

	it("can reclaim navigation for Browser comfort before utility views need it", () => {
		expect(
			adaptiveSidebarShouldCompact({ expandedContentWidth: 1160, workspaceDemand: 1068, isCompact: false }),
		).toBe(false);
		expect(
			adaptiveSidebarShouldCompact({ expandedContentWidth: 1160, workspaceDemand: 1628, isCompact: false }),
		).toBe(true);
	});

	it("releases immediately when no workspace owns a demand", () => {
		expect(
			adaptiveSidebarShouldCompact({ expandedContentWidth: 900, workspaceDemand: null, isCompact: true }),
		).toBe(false);
	});
});
