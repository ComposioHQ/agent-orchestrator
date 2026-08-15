/**
 * Deciding which once-per-visit launch events fire.
 *
 * Extracted from the `LaunchAnalytics` effect so the dedupe semantics are
 * unit-testable: they are the difference between counting a return visit and
 * counting a reload, and between once-per-tab and every-page-load.
 */

import type { LaunchSource } from "./context";

export type VisitState = {
	source: LaunchSource;
	/** The browser has visited before (persistent marker present). */
	seenBefore: boolean;
	/** This tab session's initial visit has been counted. */
	sessionCounted: boolean;
	/** ph_referral_visit already fired in this tab session. */
	phReferralFired: boolean;
	sessionStorageAvailable: boolean;
	localStorageAvailable: boolean;
};

export type VisitPlan = {
	/** A seen browser in a NEW tab session (not a reload of its first visit). */
	fireReturnVisit: boolean;
	/** Product Hunt traffic, once per tab session. */
	firePhReferralVisit: boolean;
	/** Count this session's initial visit, even when nothing fired: it is what
	 * stops a reload of a first-ever visit from counting as a return. */
	markSessionCounted: boolean;
	/** Persist the seen marker for future sessions. */
	markSeen: boolean;
	/** Record ph_referral_visit so it does not re-fire in this session. */
	markPhReferralFired: boolean;
};

export function planLaunchEvents(state: VisitState): VisitPlan {
	const firePhReferralVisit =
		state.source === "product_hunt" && !state.phReferralFired;
	return {
		fireReturnVisit: state.seenBefore && !state.sessionCounted,
		firePhReferralVisit,
		markSessionCounted:
			state.sessionStorageAvailable && !state.sessionCounted,
		markSeen: state.localStorageAvailable && !state.seenBefore,
		markPhReferralFired:
			state.sessionStorageAvailable && firePhReferralVisit,
	};
}
