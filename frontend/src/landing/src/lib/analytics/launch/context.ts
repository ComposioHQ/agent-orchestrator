/**
 * Launch attribution context: the normalized properties attached to every
 * event during the launch so any funnel step can be broken down by where the
 * visitor came from.
 *
 * `campaign.ts` already captures the raw `utm_*` params. This layer adds a
 * single normalized `source` (so `product_hunt`, a `producthunt.com` referrer,
 * and `utm_source=product-hunt` all collapse to one value), plus the campaign,
 * a coarse device class, and the visitor's user type. These are registered as
 * PostHog super-properties, so they ride on autocaptured pageviews too.
 *
 * The functions are pure (they take the URL search, referrer, and user-agent as
 * arguments) so the classification rules are testable without a browser.
 */

import { LAUNCH_CAMPAIGN } from "./utm";

export type LaunchSource =
	| "product_hunt"
	| "x"
	| "linkedin"
	| "youtube"
	| "discord"
	| "github"
	| "reddit"
	| "direct"
	| "other";

export type DeviceType = "mobile" | "tablet" | "desktop";

export type LaunchContext = {
	source: LaunchSource;
	campaign: string;
	/** Always `anonymous` on the marketing site (no auth here). The app sets
	 * `signed_up` / `activated` for its own events. */
	user_type: "anonymous";
	device: DeviceType;
};

const UTM_SOURCE_MAP: Record<string, LaunchSource> = {
	product_hunt: "product_hunt",
	producthunt: "product_hunt",
	"product-hunt": "product_hunt",
	ph: "product_hunt",
	x: "x",
	twitter: "x",
	linkedin: "linkedin",
	youtube: "youtube",
	yt: "youtube",
	discord: "discord",
	github: "github",
	reddit: "reddit",
};

/** Referrer hostname substrings, most specific first. */
const REFERRER_RULES: Array<[string, LaunchSource]> = [
	["producthunt.com", "product_hunt"],
	["ph.co", "product_hunt"],
	["linkedin.com", "linkedin"],
	["lnkd.in", "linkedin"],
	["youtube.com", "youtube"],
	["youtu.be", "youtube"],
	["discord.com", "discord"],
	["discord.gg", "discord"],
	["github.com", "github"],
	["reddit.com", "reddit"],
	["t.co", "x"],
	["twitter.com", "x"],
	["x.com", "x"],
];

/**
 * Classifies the visit's source. A UTM source wins when present (it is the
 * intentional tag on our own links); otherwise the referrer hostname is
 * matched; an empty referrer is a direct visit; anything else is `other`.
 */
export function classifySource(
	utmSource: string | undefined,
	referrer: string | undefined,
): LaunchSource {
	const utm = utmSource?.trim().toLowerCase();
	if (utm && UTM_SOURCE_MAP[utm]) return UTM_SOURCE_MAP[utm];

	const ref = referrer?.trim().toLowerCase() ?? "";
	if (ref === "") return utm ? "other" : "direct";
	let host = ref;
	try {
		host = new URL(ref).hostname;
	} catch {
		// Not a full URL; match against the raw string below.
	}
	for (const [needle, source] of REFERRER_RULES) {
		if (host.includes(needle)) return source;
	}
	return "other";
}

/** Coarse device class from a user-agent string. */
export function deviceType(ua: string | undefined): DeviceType {
	const s = (ua ?? "").toLowerCase();
	if (/ipad|tablet|kindle|playbook|silk/.test(s)) return "tablet";
	if (/mobi|iphone|ipod|android.*mobile|windows phone/.test(s)) return "mobile";
	if (/android/.test(s)) return "tablet"; // Android without "mobile" is a tablet.
	return "desktop";
}

/** The normalized launch context to register as PostHog super-properties. */
export function launchContext(input: {
	utmSource?: string;
	referrer?: string;
	ua?: string;
}): LaunchContext {
	return {
		source: classifySource(input.utmSource, input.referrer),
		campaign: LAUNCH_CAMPAIGN,
		user_type: "anonymous",
		device: deviceType(input.ua),
	};
}
