import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

// Session labels are capped at 120 characters, which is far wider than a
// sidebar row. Truncating with an ellipsis would hide the part that
// distinguishes two sessions from each other ("refactor auth: token refresh"
// vs "refactor auth: session cookies"), so the label is clipped instead and
// slid horizontally on demand: hover the row, or focus its open button, and the
// text travels far enough to read the tail and stays there until hover/focus
// ends, then eases back to the start.
//
// Three things keep that from being annoying:
//   - The travel runs at a constant speed rather than a constant duration, so a
//     name two characters too wide does not crawl and a very long one does not
//     whip past.
//   - The track keeps the full card width whether or not the row is hovered;
//     the action cluster overlays it rather than entering flow, so nothing
//     reflows when the transition starts or stops.
//   - Narrow edge gradients fade the leading and trailing edges, so the text
//     reads as passing under the row chrome instead of being chopped at a hard
//     border.

// Keep the label comfortably below ordinary reading pace. At 48px/s, a typical
// 360px overflow takes seven and a half seconds to cross, so the user can
// follow the text rather than chase it.
const MARQUEE_SPEED_PX_PER_SEC = 48;
const MARQUEE_MIN_DURATION_MS = 1400;
// A 120-character name in a narrow sidebar overflows by roughly 600px and now
// takes about 14s to reach the tail. Leave headroom for that normal case; the
// clamp only guards pathological measurements.
const MARQUEE_MAX_DURATION_MS = 40000;

// The label crosses the overflow once, then remains at the tail until the
// active state ends.
export function marqueeDurationMs(overflowPx: number): number {
	const travelMs = (overflowPx / MARQUEE_SPEED_PX_PER_SEC) * 1000;
	return Math.round(Math.min(MARQUEE_MAX_DURATION_MS, Math.max(MARQUEE_MIN_DURATION_MS, travelMs)));
}

// Read straight from matchMedia rather than through motion/react's hook: this
// component has no motion component to hand a transition to, and the query is
// the whole dependency.
function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(query.matches);
		const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
		query.addEventListener?.("change", onChange);
		return () => query.removeEventListener?.("change", onChange);
	}, []);

	return reduced;
}

export function SidebarSessionName({
	className,
	title,
	// True while the row is hovered or its open button holds focus. Hover lives
	// on the row rather than on the label, so it is passed in.
	active,
}: {
	className?: string;
	title: string;
	active: boolean;
}) {
	const trackRef = useRef<HTMLSpanElement | null>(null);
	const textRef = useRef<HTMLSpanElement | null>(null);
	const [{ overflowPx, shadowInsetPx }, setMeasurement] = useState({
		overflowPx: 0,
		shadowInsetPx: 0,
	});
	const prefersReducedMotion = usePrefersReducedMotion();

	const measure = useCallback(() => {
		const track = trackRef.current;
		const text = textRef.current;
		if (!track || !text) return;

		// At rest the name owns the full label track. While actions are visible,
		// only their actual overlap with that track is occluded; measuring the
		// geometry keeps this independent of button count, gaps, and row padding.
		let nextShadowInsetPx = 0;
		if (active) {
			const actions = track
				.closest("[data-session-row]")
				?.querySelector<HTMLElement>("[data-session-actions]");
			if (actions) {
				const trackRect = track.getBoundingClientRect();
				const actionsRect = actions.getBoundingClientRect();
				nextShadowInsetPx = Math.max(0, trackRect.right - actionsRect.left);
			}
		}

		// scrollWidth is rounded to an integer, so a sub-pixel difference can
		// report a 1px overflow on a label that visually fits. Ignore that much.
		const readableWidth = Math.max(0, track.clientWidth - nextShadowInsetPx);
		const overflow = text.scrollWidth - readableWidth;
		const nextOverflowPx = overflow > 1 ? overflow : 0;
		setMeasurement((current) =>
			current.overflowPx === nextOverflowPx && current.shadowInsetPx === nextShadowInsetPx
				? current
				: { overflowPx: nextOverflowPx, shadowInsetPx: nextShadowInsetPx },
		);
	}, [active]);

	useLayoutEffect(() => {
		measure();
		const track = trackRef.current;
		if (!track || typeof ResizeObserver !== "function") return;
		// The sidebar is user-resizable, so the same name overflows at one width
		// and fits at another. The action cluster is observed too because its
		// measured overlap defines the readable endpoint while active.
		const observer = new ResizeObserver(measure);
		observer.observe(track);
		const actions = track
			.closest("[data-session-row]")
			?.querySelector<HTMLElement>("[data-session-actions]");
		if (actions) observer.observe(actions);
		return () => observer.disconnect();
	}, [measure, title]);

	const overflowing = overflowPx > 0;
	const running = overflowing && active && !prefersReducedMotion;

	return (
		<span
			className={cn("ao-session-name relative block min-w-0 flex-1 overflow-hidden", className)}
			data-marquee={running ? "running" : undefined}
			data-overflowing={overflowing ? "" : undefined}
			data-session-name=""
			ref={trackRef}
			style={{ "--ao-session-name-shadow-inset": `${shadowInsetPx}px` } as CSSProperties}
			// The full label stays reachable without motion: as the row's own
			// tooltip, and as text content for assistive technology. This is also
			// the readable fallback under prefers-reduced-motion.
			title={title}
		>
			<span
				className="ao-session-name__text block w-max max-w-none whitespace-nowrap"
				ref={textRef}
				style={
					running
						? ({
								"--ao-marquee-shift": `-${overflowPx}px`,
								"--ao-marquee-duration": `${marqueeDurationMs(overflowPx)}ms`,
							} as CSSProperties)
						: undefined
				}
			>
				{title}
			</span>
			{overflowing ? <span aria-hidden="true" className="ao-session-name__shadow" /> : null}
		</span>
	);
}
