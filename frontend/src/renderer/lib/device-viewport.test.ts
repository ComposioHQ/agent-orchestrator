import { describe, expect, it } from "vitest";
import { pointerToFrame } from "./device-viewport";

const frame = { left: 100, top: 50, width: 400, height: 800 };

describe("pointerToFrame", () => {
	it("maps a pointer inside the rendered frame to framebuffer pixels", () => {
		// 400 CSS px wide maps to a 200px-wide framebuffer; 800 CSS px to 1600.
		const point = pointerToFrame(300, 250, frame, 200, 1600);
		expect(point).toEqual({ x: 100, y: 400 });
	});

	it("maps the exact corners", () => {
		expect(pointerToFrame(100, 50, frame, 200, 1600)).toEqual({ x: 0, y: 0 });
		expect(pointerToFrame(500, 850, frame, 200, 1600)).toEqual({ x: 200, y: 1600 });
	});

	it("returns null for clicks in the letterboxed margin around the frame", () => {
		expect(pointerToFrame(90, 250, frame, 200, 1600)).toBeNull(); // left margin
		expect(pointerToFrame(300, 900, frame, 200, 1600)).toBeNull(); // below frame
	});

	it("returns null when the frame or rect is degenerate", () => {
		expect(pointerToFrame(300, 250, frame, 0, 1600)).toBeNull();
		expect(pointerToFrame(300, 250, { left: 0, top: 0, width: 0, height: 0 }, 200, 1600)).toBeNull();
	});
});