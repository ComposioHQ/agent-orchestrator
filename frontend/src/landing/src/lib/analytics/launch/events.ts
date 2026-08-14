/**
 * Product Hunt launch events.
 *
 * These are the launch-specific events that do not already exist. They go
 * through the shared `track()` wrapper, so they inherit the campaign
 * attribution and the best-effort/no-throw behavior, and they are broken down
 * by the normalized launch super-properties registered in `LaunchAnalytics`.
 *
 * Deliberately NOT re-declared here (already tracked elsewhere): download,
 * waitlist signup, install-command copy, section viewed, video progress, and
 * generic outbound link clicks. And deliberately NOT tracked on the marketing
 * site at all: signup/login/workspace/agent/workflow/orchestration events —
 * those happen inside the product and are emitted by the app/daemon.
 */

import { track } from "../index";

export const LAUNCH_EVENTS = {
	/** First event of a visit that came from Product Hunt. */
	phReferralVisit: "ph_referral_visit",
	/** Click on an embedded Product Hunt badge on our site. */
	phBadgeClick: "ph_badge_click",
	/** Click on a CTA that sends the visitor back to Product Hunt to upvote. */
	phUpvoteCtaClick: "ph_upvote_cta_click",
	/** Click on a CTA that sends the visitor to comment/review on Product Hunt. */
	phCommentCtaClick: "ph_comment_cta_click",
	/** A visitor we have seen before in this browser. */
	returnVisit: "return_visit",
} as const;

export function trackPhReferralVisit(properties?: Record<string, unknown>): void {
	track(LAUNCH_EVENTS.phReferralVisit, properties);
}

export function trackPhBadgeClick(properties?: Record<string, unknown>): void {
	track(LAUNCH_EVENTS.phBadgeClick, properties);
}

export function trackPhUpvoteCtaClick(properties?: Record<string, unknown>): void {
	track(LAUNCH_EVENTS.phUpvoteCtaClick, properties);
}

export function trackPhCommentCtaClick(properties?: Record<string, unknown>): void {
	track(LAUNCH_EVENTS.phCommentCtaClick, properties);
}

export function trackReturnVisit(properties?: Record<string, unknown>): void {
	track(LAUNCH_EVENTS.returnVisit, properties);
}
