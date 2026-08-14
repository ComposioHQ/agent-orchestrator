import { describe, expect, it } from "vitest";

import { classifySource, deviceType, launchContext } from "./context";

describe("classifySource", () => {
	it("prefers an explicit utm_source and normalizes its spellings", () => {
		for (const s of ["product_hunt", "producthunt", "product-hunt", "PH"]) {
			expect(classifySource(s, "https://google.com")).toBe("product_hunt");
		}
		expect(classifySource("twitter", undefined)).toBe("x");
	});

	it("falls back to the referrer hostname when there is no utm_source", () => {
		expect(classifySource(undefined, "https://www.producthunt.com/posts/x")).toBe("product_hunt");
		expect(classifySource(undefined, "https://t.co/abc")).toBe("x");
		expect(classifySource(undefined, "https://lnkd.in/abc")).toBe("linkedin");
	});

	it("treats an empty referrer with no utm as a direct visit", () => {
		expect(classifySource(undefined, "")).toBe("direct");
		expect(classifySource("", "")).toBe("direct");
	});

	it("returns other for an unknown source", () => {
		expect(classifySource("newsletter", undefined)).toBe("other");
		expect(classifySource(undefined, "https://example.com")).toBe("other");
	});
});

describe("deviceType", () => {
	it("classifies mobile, tablet, and desktop", () => {
		expect(deviceType("iPhone; CPU iPhone OS 17_0 like Mac OS X Mobile")).toBe("mobile");
		expect(deviceType("iPad; CPU OS 17_0 like Mac OS X")).toBe("tablet");
		expect(deviceType("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)")).toBe("desktop");
	});

	it("treats Android without 'mobile' as a tablet", () => {
		expect(deviceType("Mozilla/5.0 (Linux; Android 14; Tab)")).toBe("tablet");
		expect(deviceType("Mozilla/5.0 (Linux; Android 14; Pixel Mobile)")).toBe("mobile");
	});
});

describe("launchContext", () => {
	it("assembles the normalized super-properties", () => {
		expect(
			launchContext({
				utmSource: "product_hunt",
				referrer: "https://www.producthunt.com/",
				ua: "iPhone Mobile",
			}),
		).toEqual({
			source: "product_hunt",
			campaign: "launch_day",
			user_type: "anonymous",
			device: "mobile",
		});
	});
});
