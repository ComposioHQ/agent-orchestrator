import { describe, expect, it } from "vitest";
import {
	buildOscColorReports,
	createOscColorReportForwarder,
	cursorOscProbeRepliesForOutput,
	hexToOscRgb,
	isOscColorReport,
} from "./osc-color-report";

const palette = {
	foreground: "#24292f",
	background: "#f5f5f4",
	cursor: "#24292f",
};

describe("isOscColorReport", () => {
	it("accepts xterm OSC 10/11/12 background reports", () => {
		expect(isOscColorReport("\x1b]11;rgb:f5f5/f5f5/f4f4\x1b\\")).toBe(true);
		expect(isOscColorReport("\x1b]10;rgb:2424/2929/2f2f\x07")).toBe(true);
		expect(isOscColorReport("\x1b]12;rgb:2424/2929/2f2f\x1b\\")).toBe(true);
	});

	it("rejects other terminal-generated replies", () => {
		expect(isOscColorReport("\x1b[?1;2c")).toBe(false);
		expect(isOscColorReport("\x1b[6n")).toBe(false);
		expect(isOscColorReport("\x1b[?997;1n")).toBe(false);
		expect(isOscColorReport("\x1b]0;title\x07")).toBe(false);
	});
});

describe("hexToOscRgb", () => {
	it("expands hex colors into xterm rgb sequences", () => {
		expect(hexToOscRgb("#f5f5f4")).toBe("rgb:f5f5/f5f5/f4f4");
	});
});

describe("buildOscColorReports", () => {
	it("emits fg/bg/cursor OSC replies for the live palette", () => {
		expect(buildOscColorReports(palette)).toBe(
			"\x1b]10;rgb:2424/2929/2f2f\x07\x1b]11;rgb:f5f5/f5f5/f4f4\x07\x1b]12;rgb:2424/2929/2f2f\x07",
		);
	});
});

describe("cursorOscProbeRepliesForOutput", () => {
	it("answers OSC probes seen on the PTY output stream", () => {
		expect(cursorOscProbeRepliesForOutput("\x1b]11;?\x07", palette)).toBe(
			"\x1b]11;rgb:f5f5/f5f5/f4f4\x07",
		);
		expect(cursorOscProbeRepliesForOutput("\x1b]10;?\x1b]11;?\x07", palette)).toBe(
			"\x1b]10;rgb:2424/2929/2f2f\x07\x1b]11;rgb:f5f5/f5f5/f4f4\x07",
		);
		expect(cursorOscProbeRepliesForOutput("hello", palette)).toBeNull();
	});
});

describe("createOscColorReportForwarder", () => {
	it("buffers split OSC replies before forwarding", () => {
		const forwarded: string[] = [];
		const forwarder = createOscColorReportForwarder((report) => forwarded.push(report));
		forwarder.push("\x1b]11;rgb:f5f5/f5f5/f");
		expect(forwarded).toEqual([]);
		forwarder.push("4f4\x07");
		expect(forwarded).toEqual(["\x1b]11;rgb:f5f5/f5f5/f4f4\x07"]);
		forwarder.dispose();
	});
});
