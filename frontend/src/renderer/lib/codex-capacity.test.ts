import { describe, expect, it } from "vitest";
import { codexCapacityRemainingPercent, codexCapacitySummary, type CodexCapacity } from "./codex-capacity";

const capacity = (usedPercent?: number): CodexCapacity => ({
	state: "available",
	freshness: "fresh",
	plan: "pro",
	usedPercent,
	reasonCode: "capacity_available",
	reason: "Capacity is available.",
	additionalBuckets: [],
});

describe("Codex capacity presentation", () => {
	it("converts provider usage into remaining capacity", () => {
		expect(codexCapacityRemainingPercent(4)).toBe(96);
		expect(codexCapacityRemainingPercent(100)).toBe(0);
		expect(codexCapacityRemainingPercent(undefined)).toBeUndefined();
	});

	it("summarizes the remaining percentage instead of the used percentage", () => {
		expect(codexCapacitySummary(capacity(4), "Capacity available")).toBe("pro · 96% · Capacity available");
	});
});
