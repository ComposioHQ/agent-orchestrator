import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES, useImageAttachments } from "./useImageAttachments";

const pngFile = (name: string, bytes = 8, type = "image/png") =>
	new File([new Uint8Array(bytes).fill(1)], name, { type });

const mb = 1024 * 1024;

describe("useImageAttachments", () => {
	it("retains images from two overlapping addFiles calls", async () => {
		// Regression probe for the cap-accounting-from-a-stale-snapshot bug: two
		// addFiles calls fired back-to-back (fast double paste, or paste-then-drop)
		// must both survive. With a closure snapshot the second call overwrote the
		// first and silently dropped an image.
		const { result } = renderHook(() => useImageAttachments());

		await act(async () => {
			const first = result.current.addFiles([pngFile("a.png")]);
			const second = result.current.addFiles([pngFile("b.png")]);
			await Promise.all([first, second]);
		});

		expect(result.current.attachments).toHaveLength(2);
		expect(result.current.error).toBeNull();
	});

	it("stages a supported image", async () => {
		const { result } = renderHook(() => useImageAttachments());
		await act(async () => {
			await result.current.addFiles([pngFile("a.png")]);
		});
		expect(result.current.attachments).toHaveLength(1);
		expect(result.current.attachments[0]?.mimeType).toBe("image/png");
		expect(result.current.error).toBeNull();
	});

	it("rejects unsupported image types (e.g. SVG) with inline feedback", async () => {
		const { result } = renderHook(() => useImageAttachments());
		await act(async () => {
			await result.current.addFiles([pngFile("vector.svg", 8, "image/svg+xml")]);
		});
		expect(result.current.attachments).toHaveLength(0);
		expect(result.current.error).toMatch(/supported/i);
	});

	it("enforces the count cap against current state", async () => {
		const { result } = renderHook(() => useImageAttachments());
		await act(async () => {
			await result.current.addFiles(Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => pngFile(`img-${i}.png`)));
		});
		expect(result.current.attachments).toHaveLength(MAX_ATTACHMENTS);
		expect(result.current.error).toMatch(/up to/i);
	});

	it("skips an image that exceeds the total cap without dropping later smaller images", async () => {
		// Regression probe for the break-vs-continue cap bug: one image that does not
		// fit into the remaining budget aborted the whole staging loop, silently
		// dropping every smaller image staged after it in the same batch.
		const { result } = renderHook(() => useImageAttachments());
		await act(async () => {
			await result.current.addFiles([
				pngFile("a.png", 9 * mb),
				pngFile("b.png", 9 * mb),
				pngFile("c.png", 9 * mb),
				pngFile("d.png", 5 * mb),
			]);
		});
		// a + b (18 MB) fit; c would push past MAX_ATTACHMENTS_BYTES and only it is
		// refused; d (5 MB) still fits (23 MB total) so the accepted order is
		// a, b, d — with the break bug it would have stopped at a, b.
		expect(result.current.attachments.map((a) => a.bytes)).toEqual([9 * mb, 9 * mb, 5 * mb]);
		expect(result.current.attachments.reduce((sum, a) => sum + a.bytes, 0)).toBeLessThanOrEqual(
			MAX_ATTACHMENTS_BYTES,
		);
		expect(result.current.error).toMatch(/total under/i);
	});
});
