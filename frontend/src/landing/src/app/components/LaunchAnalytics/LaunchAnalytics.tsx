"use client";

import { useEffect } from "react";

import { track } from "@/lib/analytics";
import { MARKETING_ACCEPTED_CONSENT } from "@/lib/analytics/marketing-consent";
import { launchContext } from "@/lib/analytics/launch/context";
import { LAUNCH_EVENTS } from "@/lib/analytics/launch/events";
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
 * Best-effort and side-effect free beyond analytics: all storage access is
 * guarded.
 */

/** localStorage: this browser has visited before (return-visit signal). */
const SEEN_KEY = "ao.launch.seen";
/** sessionStorage: return_visit already fired in this tab session. */
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

export function LaunchAnalytics() {
	useEffect(() => {
		if (typeof window === "undefined") return;

		const params = new URLSearchParams(window.location.search);
		const context = launchContext({
			utmSource: params.get("utm_source") ?? undefined,
			utmCampaign: params.get("utm_campaign") ?? undefined,
			referrer: document.referrer,
			ua: navigator.userAgent,
			touchPoints: navigator.maxTouchPoints,
		});

		const stopWaiting = whenConsented(() => {
			// return_visit: seen before in this browser. localStorage marks the
			// browser; sessionStorage dedupes to once per tab session, so a
			// reload does not re-fire it.
			try {
				const seen = window.localStorage.getItem(SEEN_KEY) === "1";
				const firedThisSession =
					window.sessionStorage.getItem(RETURN_FIRED_KEY) === "1";
				if (seen && !firedThisSession) {
					track(LAUNCH_EVENTS.returnVisit);
					window.sessionStorage.setItem(RETURN_FIRED_KEY, "1");
				}
				window.localStorage.setItem(SEEN_KEY, "1");
			} catch {
				// Storage blocked (private mode / cookies off): skip the signal.
			}

			// ph_referral_visit: once per tab session, only for Product Hunt
			// traffic.
			if (context.source === "product_hunt") {
				try {
					if (window.sessionStorage.getItem(PH_KEY) !== "1") {
						track(LAUNCH_EVENTS.phReferralVisit);
						window.sessionStorage.setItem(PH_KEY, "1");
					}
				} catch {
					// No sessionStorage: fire anyway — at most once per page
					// load is the best dedupe available — rather than lose the
					// signal entirely.
					track(LAUNCH_EVENTS.phReferralVisit);
				}
			}
		});

		return stopWaiting;
	}, []);

	return null;
}
