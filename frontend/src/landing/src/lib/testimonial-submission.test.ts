import { describe, expect, it } from "vitest";

import {
	countWords,
	isLinkedInProfileUrl,
	isTweetUrl,
	limitWords,
} from "./testimonial-submission";

describe("testimonial word limits", () => {
	it("counts words separated by any whitespace", () => {
		expect(countWords("  AO makes\nparallel work\tclear.  ")).toBe(5);
	});

	it("leaves submissions within the limit unchanged", () => {
		expect(limitWords("one  two\nthree", 3)).toBe("one  two\nthree");
	});

	it("truncates text after the final allowed word", () => {
		expect(limitWords("one  two\nthree four", 3)).toBe("one  two\nthree");
	});

	it("enforces the submission cap for pasted text", () => {
		const pastedText = Array.from({ length: 501 }, (_, index) => `word-${index}`).join(" ");
		expect(countWords(limitWords(pastedText))).toBe(500);
	});
});

describe("testimonial profile links", () => {
	it("accepts LinkedIn profile URLs", () => {
		expect(isLinkedInProfileUrl("https://www.linkedin.com/in/example-person/")).toBe(true);
	});

	it("rejects non-profile LinkedIn URLs", () => {
		expect(isLinkedInProfileUrl("https://www.linkedin.com/company/example")).toBe(false);
	});

	it("accepts X and legacy Twitter status URLs", () => {
		expect(isTweetUrl("https://x.com/example/status/1234567890")).toBe(true);
		expect(isTweetUrl("https://twitter.com/example/status/1234567890")).toBe(true);
	});

	it("rejects social profile URLs without a status", () => {
		expect(isTweetUrl("https://x.com/example")).toBe(false);
	});
});
