import { describe, expect, it } from "vitest";
import { bundledTmuxBinaryPath } from "./bundled-tmux";

describe("bundledTmuxBinaryPath", () => {
	it.each(["darwin", "linux"] as const)("uses the packaged tmux on %s", (platform) => {
		expect(bundledTmuxBinaryPath(true, "/opt/ao/resources", platform)).toBe(
			"/opt/ao/resources/tmux/bin/tmux",
		);
	});

	it("does not override tmux in development", () => {
		expect(bundledTmuxBinaryPath(false, "/opt/ao/resources", "darwin")).toBeNull();
	});

	it("does not require tmux on Windows", () => {
		expect(bundledTmuxBinaryPath(true, "C:\\AO\\resources", "win32")).toBeNull();
	});
});
