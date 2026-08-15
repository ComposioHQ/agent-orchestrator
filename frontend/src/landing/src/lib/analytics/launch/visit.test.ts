import { describe, expect, it } from "vitest";

import { planLaunchEvents } from "./visit";

const base = {
	sessionStorageAvailable: true,
	localStorageAvailable: true,
};

describe("planLaunchEvents", () => {
	it("fires ph_referral_visit but not return_visit on a first-ever PH visit", () => {
		expect(
			planLaunchEvents({
				...base,
				source: "product_hunt",
				seenBefore: false,
				sessionCounted: false,
				phReferralFired: false,
			}),
		).toEqual({
			fireReturnVisit: false,
			firePhReferralVisit: true,
			markSessionCounted: true,
			markSeen: true,
			markPhReferralFired: true,
		});
	});

	it("does not treat a reload of a first-ever visit as a return visit", () => {
		// Regression: the session marker was only written when return_visit
		// fired, so the first reload of a brand-new visitor counted as a return.
		const plan = planLaunchEvents({
			...base,
			source: "direct",
			seenBefore: true,
			sessionCounted: true,
			phReferralFired: true,
		});
		expect(plan.fireReturnVisit).toBe(false);
		// Already recorded; do not rewrite.
		expect(plan.markSessionCounted).toBe(false);
		expect(plan.markSeen).toBe(false);
	});

	it("fires return_visit for a seen browser in a new tab session", () => {
		const plan = planLaunchEvents({
			...base,
			source: "direct",
			seenBefore: true,
			sessionCounted: false,
			phReferralFired: true,
		});
		expect(plan.fireReturnVisit).toBe(true);
		expect(plan.markSessionCounted).toBe(true);
	});

	it("fires ph_referral_visit once per tab session only", () => {
		const plan = planLaunchEvents({
			...base,
			source: "product_hunt",
			seenBefore: true,
			sessionCounted: true,
			phReferralFired: true,
		});
		expect(plan.firePhReferralVisit).toBe(false);
		expect(plan.markPhReferralFired).toBe(false);
	});

	it("never fires ph_referral_visit for other sources", () => {
		expect(
			planLaunchEvents({
				...base,
				source: "x",
				seenBefore: false,
				sessionCounted: false,
				phReferralFired: false,
			}).firePhReferralVisit,
		).toBe(false);
	});

	it("degrades to per-load ph_referral_visit when sessionStorage is unavailable", () => {
		const plan = planLaunchEvents({
			...base,
			sessionStorageAvailable: false,
			source: "product_hunt",
			seenBefore: false,
			sessionCounted: false,
			phReferralFired: false,
		});
		expect(plan.firePhReferralVisit).toBe(true);
		expect(plan.markSessionCounted).toBe(false);
		expect(plan.markPhReferralFired).toBe(false);
	});

	it("skips the return signal entirely when localStorage is unavailable", () => {
		// Without persistence there is no honest "seen before"; never guess.
		const plan = planLaunchEvents({
			...base,
			localStorageAvailable: false,
			source: "product_hunt",
			seenBefore: false,
			sessionCounted: false,
			phReferralFired: false,
		});
		expect(plan.fireReturnVisit).toBe(false);
		expect(plan.markSeen).toBe(false);
	});
});
