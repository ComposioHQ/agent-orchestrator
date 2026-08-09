import { beforeEach, describe, expect, it } from "vitest";
import {
	clearRenderProfile,
	getRenderProfile,
	RENDER_PROFILE_LIMIT,
	recordRenderProfile,
} from "./render-profiler";

describe("render profiler", () => {
	beforeEach(() => clearRenderProfile());

	it("records commit metadata for a profiled subtree", () => {
		recordRenderProfile("board", "update", 4.25, 18.5, 100, 105);

		expect(getRenderProfile()).toEqual([
			{
				id: "board",
				phase: "update",
				actualDuration: 4.25,
				baseDuration: 18.5,
				startTime: 100,
				commitTime: 105,
			},
		]);
	});

	it("keeps only the most recent bounded set of commits", () => {
		for (let index = 0; index <= RENDER_PROFILE_LIMIT; index += 1) {
			recordRenderProfile(`commit-${index}`, "update", index, index, index, index);
		}

		const profile = getRenderProfile();
		expect(profile).toHaveLength(RENDER_PROFILE_LIMIT);
		expect(profile[0]?.id).toBe("commit-1");
		expect(profile.at(-1)?.id).toBe(`commit-${RENDER_PROFILE_LIMIT}`);
	});

	it("returns a copy so callers cannot mutate the recorded history", () => {
		recordRenderProfile("sidebar", "mount", 1, 2, 3, 4);
		const profile = getRenderProfile();
		profile.length = 0;

		expect(getRenderProfile()).toHaveLength(1);
	});
});
