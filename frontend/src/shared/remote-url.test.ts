import { describe, expect, it } from "vitest";

import { validateRemoteUrl } from "./remote-url";

describe("validateRemoteUrl", () => {
	it("accepts a bare https host and normalizes the trailing slash", () => {
		expect(validateRemoteUrl("https://pi.tail1234.ts.net")).toEqual({
			ok: true,
			url: "https://pi.tail1234.ts.net",
		});
		expect(validateRemoteUrl("https://pi.tail1234.ts.net/")).toEqual({
			ok: true,
			url: "https://pi.tail1234.ts.net",
		});
	});

	it("accepts an explicit port", () => {
		expect(validateRemoteUrl("https://pi.tail1234.ts.net:8443")).toEqual({
			ok: true,
			url: "https://pi.tail1234.ts.net:8443",
		});
	});

	it("trims surrounding whitespace", () => {
		expect(validateRemoteUrl("  https://pi.tail1234.ts.net  ")).toEqual({
			ok: true,
			url: "https://pi.tail1234.ts.net",
		});
	});

	it.each([
		["", "Enter"],
		["not a url", "valid URL"],
		["http://pi.tail1234.ts.net", "HTTPS"],
		["https://user:pw@pi.tail1234.ts.net", "credentials"],
		["https://pi.tail1234.ts.net?x=1", "query"],
		["https://pi.tail1234.ts.net#frag", "fragment"],
		["https://pi.tail1234.ts.net/api/v1", "no path"],
	])("rejects %s", (input, reasonPart) => {
		const result = validateRemoteUrl(input);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain(reasonPart);
		}
	});
});
