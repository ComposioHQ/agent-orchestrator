"use client";

import { useEffect } from "react";

import { track } from "@/lib/analytics";
import { MARKETING_ACCEPTED_CONSENT } from "@/lib/analytics/marketing-consent";
import { launchContextFromBrowser } from "@/lib/analytics/launch/context";
import { LAUNCH_EVENTS } from "@/lib/analytics/launch/events";
import {
	planLaunchEvents,
	type VisitPlan,
	type VisitState,
} from "@/lib/analytics/launch/visit";
import { ANALYTICS_CONSENT_KEY } from "@/lib/constants";

/**
 * Fires the once-per-visit launch events. Renders nothing.
 *
 * The launch super-properties themselves are NOT registered here: they are
 * registered from the init `loaded` callback in `instrumentation-client.ts`,
 * before consent opt-in, so even the first pageview of an already-consented
 * visitor carries them. Registering from a React effect would lose that race —
 * `opt_in_capturing()` emits the initial pageview synchronously during init,
 * before hydration (see `marketing-consent.ts` for the same lesson).
 *
 * Firing is consent-aware: nothing is captured — and no once-only flag is
 * consumed — until the visitor has accepted analytics. A first-time Product
 * Hunt visitor who accepts the cookie banner a minute into the visit still
 * gets `ph_referral_visit`; one who never accepts is simply not counted (which
 * is the point of opt-out-by-default).
 *
 * The firing/dedupe decisions live in `launch/visit.ts` (pure, unit-tested);
 * this component only gathers the guarded browser state and applies the plan.
 */

/** localStorage: this browser has visited before (return-visit signal). */
const SEEN_KEY = "ao.launch.seen";
/** sessionStorage: this tab session's initial visit has been counted. */
const RETURN_FIRED_KEY = "ao.launch.return_fired";
/** sessionStorage: ph_referral_visit already fired in this tab session. */
const PH_KEY = "ao.launch.ph_referral";

/** Poll for consent while the banner is up, so the events are not lost. */
const CONSENT_POLL_MS = 1_000;
const CONSENT_POLL_TRIES = 120;

function consentAccepted(): boolean {
	try {
		return (
			window.localStorage.getItem(ANALYTICS_CONSENT_KEY) ===
			MARKETING_ACCEPTED_CONSENT
		);
	} catch {
		return false;
	}
}

/**
 * Runs `fire` once consent is accepted — immediately if it already is,
 * otherwise on a bounded poll while the cookie banner is up. Returns a
 * cleanup that stops waiting (component unmount / strict-mode remount).
 */
function whenConsented(fire: () => void): () => void {
	if (consentAccepted()) {
		fire();
		return () => {};
	}
	let tries = 0;
	const timer = window.setInterval(() => {
		tries += 1;
		if (consentAccepted()) {
			window.clearInterval(timer);
			fire();
		} else if (tries >= CONSENT_POLL_TRIES) {
			window.clearInterval(timer);
		}
	}, CONSENT_POLL_MS);
	return () => window.clearInterval(timer);
}

/** Reads the dedupe markers; an unavailable storage reads as absent. */
function readVisitState(source: VisitState["source"]): VisitState {
	const state: VisitState = {
		source,
		seenBefore: false,
		sessionCounted: false,
		phReferralFired: false,
		sessionStorageAvailable: false,
		localStorageAvailable: false,
	};
	try {
		state.seenBefore = window.localStorage.getItem(SEEN_KEY) === "1";
		state.localStorageAvailable = true;
	} catch {
		// Storage blocked (private mode / cookies off).
	}
	try {
		state.sessionCounted =
			window.sessionStorage.getItem(RETURN_FIRED_KEY) === "1";
		state.phReferralFired = window.sessionStorage.getItem(PH_KEY) === "1";
		state.sessionStorageAvailable = true;
	} catch {
		// Storage blocked: per-load firing is the documented degradation.
	}
	return state;
}

/** Applies the plan's marker writes, each guarded independently. */
function writeVisitMarkers(plan: VisitPlan): void {
	try {
		if (plan.markSeen) window.localStorage.setItem(SEEN_KEY, "1");
	} catch {
		// Storage blocked.
	}
	try {
		if (plan.markSessionCounted) {
			window.sessionStorage.setItem(RETURN_FIRED_KEY, "1");
		}
		if (plan.markPhReferralFired) {
			window.sessionStorage.setItem(PH_KEY, "1");
		}
	} catch {
		// Storage blocked.
	}
}

export function LaunchAnalytics() {
	useEffect(() => {
		if (typeof window === "undefined") return;

		const context = launchContextFromBrowser();

		const stopWaiting = whenConsented(() => {
			const plan = planLaunchEvents(readVisitState(context.source));
			if (plan.fireReturnVisit) track(LAUNCH_EVENTS.returnVisit);
			if (plan.firePhReferralVisit) track(LAUNCH_EVENTS.phReferralVisit);
			writeVisitMarkers(plan);
		});

		return stopWaiting;
	}, []);

	return null;
}
