import { describe, expect, it } from "vitest";
import { SSE_RETRY_BASE_MS, SSE_RETRY_MAX_MS, computeBackoffDelayMs } from "./sse-backoff";

describe("computeBackoffDelayMs", () => {
	const lo = (f: number) => computeBackoffDelayMs(f, SSE_RETRY_BASE_MS, SSE_RETRY_MAX_MS, () => 0);
	const hi = (f: number) => computeBackoffDelayMs(f, SSE_RETRY_BASE_MS, SSE_RETRY_MAX_MS, () => 0.999999);

	it("grows exponentially from base until it hits the ceiling", () => {
		expect(lo(0)).toBe(Math.round(SSE_RETRY_BASE_MS * 0.5)); // 2500
		expect(lo(1)).toBe(Math.round(10_000 * 0.5)); // 5000
		expect(lo(2)).toBe(Math.round(20_000 * 0.5)); // 10000
		const seq = [0, 1, 2, 3, 4, 5, 10, 20].map(lo);
		for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
	});

	it("never exceeds the max ceiling and never drops below the jitter floor", () => {
		for (const f of [0, 1, 2, 3, 4, 5, 10, 20, 30, 100]) {
			const d = computeBackoffDelayMs(f);
			expect(d).toBeLessThanOrEqual(SSE_RETRY_MAX_MS);
			expect(d).toBeGreaterThanOrEqual(Math.round(SSE_RETRY_BASE_MS * 0.5));
		}
	});

	it("applies jitter within [0.5, 1.0] of the step", () => {
		expect(lo(2)).toBe(10_000); // 0.5 * 20000
		expect(hi(2)).toBeGreaterThanOrEqual(19_999);
		expect(hi(2)).toBeLessThanOrEqual(20_000);
	});

	it("clamps very high failure counts to the max band (no overflow)", () => {
		expect(lo(20)).toBe(Math.round(SSE_RETRY_MAX_MS * 0.5));
		expect(computeBackoffDelayMs(1000)).toBeLessThanOrEqual(SSE_RETRY_MAX_MS);
	});

	it("treats non-positive/NaN failures as the first retry", () => {
		expect(lo(-5)).toBe(lo(0));
		expect(lo(Number.NaN)).toBe(lo(0));
	});
});
