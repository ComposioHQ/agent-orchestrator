import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

// Session labels are capped at 120 characters, which is far wider than a
// sidebar row. Truncating with an ellipsis would hide the part that
// distinguishes two sessions from each other ("refactor auth: token refresh"
// vs "refactor auth: session cookies"), so the label is clipped instead and
// slid horizontally on demand: hover the row, or focus its open button, and the
// text travels far enough to read the tail, then eases back.
//
// Three things keep that from being annoying:
//   - The travel runs at a constant speed rather than a constant duration, so a
//     name two characters too wide does not crawl and a very long one does not
//     whip past.
//   - The track is a fixed width whether or not the row is hovered (the action
//     cluster is reserved space, not in-flow), so nothing reflows when the
//     animation starts or stops.
//   - A mask fades the leading and trailing edges, so the text reads as passing
//     under the row chrome instead of being chopped at a hard border.

// About ordinary reading pace (~200wpm over 14px type). Faster outruns the
// reader; slower makes a long name feel stuck.
const MARQUEE_SPEED_PX_PER_SEC = 100;
// Share of the cycle spent moving. The rest is the dwell at each end that makes
// the start and the tail legible before the direction flips.
const MARQUEE_TRAVEL_FRACTION = 0.7;
const MARQUEE_MIN_DURATION_MS = 1400;
// A 120-character name in a narrow sidebar overflows by roughly 600px, which
// lands just under this. The clamp is the backstop for an extreme sidebar width
// rather than a limit the normal case hits.
const MARQUEE_MAX_DURATION_MS = 20000;

// A round trip covers the overflow twice.
export function marqueeDurationMs(overflowPx: number): number {
	const travelMs = ((overflowPx * 2) / MARQUEE_SPEED_PX_PER_SEC) * 1000;
	const cycleMs = travelMs / MARQUEE_TRAVEL_FRACTION;
	return Math.round(Math.min(MARQUEE_MAX_DURATION_MS, Math.max(MARQUEE_MIN_DURATION_MS, cycleMs)));
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
	const [overflowPx, setOverflowPx] = useState(0);
	const prefersReducedMotion = usePrefersReducedMotion();

	const measure = useCallback(() => {
		const track = trackRef.current;
		const text = textRef.current;
		if (!track || !text) return;
		// scrollWidth is rounded to an integer, so a sub-pixel difference can
		// report a 1px overflow on a label that visually fits. Ignore that much.
		const overflow = text.scrollWidth - track.clientWidth;
		setOverflowPx(overflow > 1 ? overflow : 0);
	}, []);

	useEffect(() => {
		measure();
		const track = trackRef.current;
		if (!track || typeof ResizeObserver !== "function") return;
		// The sidebar is user-resizable, so the same name overflows at one width
		// and fits at another.
		const observer = new ResizeObserver(measure);
		observer.observe(track);
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
		</span>
	);
}
