import { describe, expect, it, vi } from "vitest";
import { resolveMarkdownImageSrc } from "./markdown-image-resolver";

vi.mock("./api-client", () => ({
	getApiBaseUrl: () => "http://127.0.0.1:4567",
}));

describe("resolveMarkdownImageSrc", () => {
	it("resolves encoded relative paths against the markdown file directory", () => {
		const resolved = resolveMarkdownImageSrc(
			"session/with space",
			"docs/guides/README.md",
			"../assets/flow%20chart.png?raw=1#preview",
		);
		const url = new URL(resolved!);

		expect(url.pathname).toBe("/api/v1/sessions/session%2Fwith%20space/workspace/file/blob");
		expect(url.searchParams.get("path")).toBe("docs/assets/flow chart.png");
		expect(url.searchParams.get("side")).toBe("after");
	});

	it("clamps parent traversal at the workspace root", () => {
		const resolved = resolveMarkdownImageSrc("sess-1", "README.md", "../../../diagram.png");
		expect(new URL(resolved!).searchParams.get("path")).toBe("diagram.png");
	});

	it("passes absolute sources through and leaves an empty source unset", () => {
		expect(resolveMarkdownImageSrc("sess-1", "README.md", "https://example.com/diagram.png")).toBe(
			"https://example.com/diagram.png",
		);
		expect(resolveMarkdownImageSrc("sess-1", "README.md", "data:image/png;base64,AA==")).toBe(
			"data:image/png;base64,AA==",
		);
		expect(resolveMarkdownImageSrc("sess-1", "README.md", "/assets/diagram.png")).toBe(
			"/assets/diagram.png",
		);
		expect(resolveMarkdownImageSrc("sess-1", "README.md", undefined)).toBeUndefined();
	});

	it("does not throw on malformed percent encoding", () => {
		expect(() => resolveMarkdownImageSrc("sess-1", "README.md", "bad%2name.png")).not.toThrow();
	});
});
