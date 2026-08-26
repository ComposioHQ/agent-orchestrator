import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { marqueeDurationMs, SidebarSessionName } from "./SidebarSessionName";

// jsdom lays nothing out, so scrollWidth/clientWidth are both 0 and no label
// ever looks overflowing. These stubs stand in for the layout: the track is a
// fixed width and the text is whatever the test says it is.
function stubWidths({ trackPx, textPx }: { trackPx: number; textPx: number }) {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get() {
			return this.hasAttribute("data-session-name") ? trackPx : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
		configurable: true,
		get() {
			return this.classList.contains("ao-session-name__text") ? textPx : 0;
		},
	});
}

function stubReducedMotion(reduce: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: reduce && query.includes("prefers-reduced-motion"),
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	}));
}

function label() {
	return document.querySelector<HTMLElement>("[data-session-name]");
}

function text() {
	return document.querySelector<HTMLElement>(".ao-session-name__text");
}

const LONG_NAME = "Implement support for longer AO session display names across every boundary";

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
	Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
});

describe("SidebarSessionName", () => {
	it("renders the full name without an ellipsis class", () => {
		stubWidths({ trackPx: 120, textPx: 480 });
		render(<SidebarSessionName active={false} title={LONG_NAME} />);

		expect(screen.getByText(LONG_NAME)).toBeInTheDocument();
		// `truncate` is what would add text-overflow: ellipsis. The name is clipped
		// and slid instead, so the full value stays in the DOM and readable.
		expect(text()).not.toHaveClass("truncate");
		expect(text()).toHaveClass("whitespace-nowrap");
	});

	it("exposes the full name as a tooltip even when it overflows", () => {
		stubWidths({ trackPx: 120, textPx: 480 });
		render(<SidebarSessionName active={false} title={LONG_NAME} />);

		expect(label()).toHaveAttribute("title", LONG_NAME);
	});

	it("marks an overflowing name and leaves a fitting one alone", () => {
		stubWidths({ trackPx: 480, textPx: 120 });
		const { unmount } = render(<SidebarSessionName active title="short" />);
		expect(label()).not.toHaveAttribute("data-overflowing");
		expect(label()).not.toHaveAttribute("data-marquee");
		unmount();

		stubWidths({ trackPx: 120, textPx: 480 });
		render(<SidebarSessionName active={false} title={LONG_NAME} />);
		expect(label()).toHaveAttribute("data-overflowing");
	});

	it("ignores a sub-pixel overflow", () => {
		// scrollWidth is an integer, so a name that visually fits can still report
		// one pixel more than the track. Animating that would be pure jitter.
		stubWidths({ trackPx: 200, textPx: 201 });
		render(<SidebarSessionName active title={LONG_NAME} />);

		expect(label()).not.toHaveAttribute("data-overflowing");
		expect(label()).not.toHaveAttribute("data-marquee");
	});

	it("runs only while active, and travels exactly the overflow", () => {
		stubWidths({ trackPx: 120, textPx: 480 });
		const { rerender } = render(<SidebarSessionName active={false} title={LONG_NAME} />);
		expect(label()).not.toHaveAttribute("data-marquee");
		expect(text()?.style.getPropertyValue("--ao-marquee-shift")).toBe("");

		// Hovering the row, or focusing its open button, is what flips `active`.
		rerender(<SidebarSessionName active title={LONG_NAME} />);
		expect(label()).toHaveAttribute("data-marquee", "running");
		expect(text()?.style.getPropertyValue("--ao-marquee-shift")).toBe("-360px");
		expect(text()?.style.getPropertyValue("--ao-marquee-duration")).toBe(`${marqueeDurationMs(360)}ms`);

		// Leaving resets cleanly: the custom properties go with the active
		// transition, so the text returns to its resting transform rather than
		// holding mid-slide.
		rerender(<SidebarSessionName active={false} title={LONG_NAME} />);
		expect(label()).not.toHaveAttribute("data-marquee");
		expect(text()?.style.getPropertyValue("--ao-marquee-shift")).toBe("");
	});

	it("does not animate under prefers-reduced-motion, but keeps the name readable", () => {
		stubReducedMotion(true);
		stubWidths({ trackPx: 120, textPx: 480 });
		render(<SidebarSessionName active title={LONG_NAME} />);

		expect(label()).not.toHaveAttribute("data-marquee");
		// The non-animated fallback: still marked as overflowing so the edge fade
		// applies, and the whole name is available as text and as a tooltip.
		expect(label()).toHaveAttribute("data-overflowing");
		expect(label()).toHaveAttribute("title", LONG_NAME);
		expect(screen.getByText(LONG_NAME)).toBeInTheDocument();
	});

	it("keeps the track from growing with the name so the row cannot reflow", () => {
		stubWidths({ trackPx: 120, textPx: 480 });
		render(<SidebarSessionName active title={LONG_NAME} />);

		// min-w-0 + overflow-hidden keeps a 120-character label within the full
		// card-width track; the separately layered actions do not resize it.
		expect(label()).toHaveClass("min-w-0", "overflow-hidden", "flex-1");
		expect(text()).toHaveClass("w-max");
	});

	it("scales the one-way travel time with distance so speed stays constant", () => {
		// A typical long sidebar name travels 360px. Keep that single pass
		// deliberately unhurried so the label remains readable while it moves.
		expect(marqueeDurationMs(360)).toBe(7_500);
		// Twice the overflow takes about twice as long, within the clamps.
		expect(marqueeDurationMs(600)).toBeGreaterThan(marqueeDurationMs(300));
		expect(marqueeDurationMs(600) / marqueeDurationMs(300)).toBeCloseTo(2, 1);
		// A tiny overflow still gets a readable minimum rather than a flicker, and
		// a pathological measurement is still capped rather than crawling for a
		// minute.
		expect(marqueeDurationMs(1)).toBe(1400);
		expect(marqueeDurationMs(100000)).toBe(40000);
	});
});
