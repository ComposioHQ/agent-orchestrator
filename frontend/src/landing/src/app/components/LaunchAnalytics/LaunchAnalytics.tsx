"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

import { launchContext } from "@/lib/analytics/launch/context";
import {
	trackPhReferralVisit,
	trackReturnVisit,
} from "@/lib/analytics/launch/events";

/**
 * Registers the launch attribution context and fires the once-per-visit launch
 * events. Renders nothing.
 *
 * Registering `source` / `campaign` / `device` as PostHog super-properties is
 * the whole point: from here on, every event, including autocaptured
 * pageviews and the existing download / waitlist / section-viewed events, can
 * be broken down by launch source without touching any of those call sites.
 *
 * It is best-effort and side-effect free beyond analytics: PostHog may be
 * opted out (consent) or uninitialized (no key in local dev), in which case the
 * register/capture calls simply do nothing. All storage access is guarded.
 */
export function LaunchAnalytics() {
	useEffect(() => {
		if (typeof window === "undefined") return;

		const params = new URLSearchParams(window.location.search);
		const context = launchContext({
			utmSource: params.get("utm_source") ?? undefined,
			referrer: document.referrer,
			ua: navigator.userAgent,
		});
		try {
			posthog.register(context);
		} catch {
			// PostHog not initialized (no key in dev): nothing to attribute to.
		}

		// return_visit: seen before in this browser at all. localStorage, not
		// session: a return days later is still a return.
		try {
			const RETURN_KEY = "ao.launch.seen";
			if (window.localStorage.getItem(RETURN_KEY) === "1") {
				trackReturnVisit();
			}
			window.localStorage.setItem(RETURN_KEY, "1");
		} catch {
			// Storage blocked (private mode / cookies off): skip the return signal.
		}

		// ph_referral_visit: once per tab session, only for Product Hunt traffic.
		if (context.source === "product_hunt") {
			try {
				const PH_KEY = "ao.launch.ph_referral";
				if (window.sessionStorage.getItem(PH_KEY) !== "1") {
					trackPhReferralVisit();
					window.sessionStorage.setItem(PH_KEY, "1");
				}
			} catch {
				// No sessionStorage: fire once anyway rather than lose the signal.
				trackPhReferralVisit();
			}
		}
	}, []);

	return null;
}
