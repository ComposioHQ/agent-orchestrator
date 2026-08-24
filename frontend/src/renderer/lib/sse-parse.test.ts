import { describe, expect, it } from "vitest";
import { parseSseFrames } from "./sse-parse";

describe("parseSseFrames", () => {
	it("parses a complete event frame and leaves no remainder", () => {
		const { events, rest } = parseSseFrames("event: workspace_changed\ndata: {}\n\n");
		expect(events).toEqual([{ event: "workspace_changed", data: "{}", id: undefined }]);
		expect(rest).toBe("");
	});

	it("retains a partial trailing frame in rest", () => {
		const { events, rest } = parseSseFrames("event: a\ndata: 1\n\nevent: partial");
		expect(events).toHaveLength(1);
		expect(rest).toBe("event: partial");
	});

	it("ignores keepalive comment lines", () => {
		const { events } = parseSseFrames(": keepalive\n\n");
		expect(events).toEqual([]);
	});

	it("normalizes CRLF and strips one leading space after the colon", () => {
		const { events } = parseSseFrames("event:workspace_changed\r\ndata: x\r\n\r\n");
		expect(events[0]).toMatchObject({ event: "workspace_changed", data: "x" });
	});

	it("joins multi-line data and defaults the event name to message", () => {
		const { events } = parseSseFrames("data: a\ndata: b\n\n");
		expect(events[0]).toMatchObject({ event: "message", data: "a\nb" });
	});

	it("parses two frames from one buffer", () => {
		const { events } = parseSseFrames("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
		expect(events.map((e) => e.event)).toEqual(["a", "b"]);
	});
});
