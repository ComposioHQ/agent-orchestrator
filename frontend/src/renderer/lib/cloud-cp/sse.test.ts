import { describe, expect, it } from "vitest";
import { createSseFrameParser } from "./sse";

describe("createSseFrameParser", () => {
	it("parses a multi-event chunk in the control plane's wire shape", () => {
		const parser = createSseFrameParser();
		const frames = parser.push(
			"retry: 2000\n\n" +
				'id: 1\nevent: chat\ndata: {"sequence":1}\n\n' +
				'id: 2\nevent: status\ndata: {"sequence":2}\n\n',
		);
		expect(frames).toEqual([
			{ id: "1", event: "chat", data: '{"sequence":1}' },
			{ id: "2", event: "status", data: '{"sequence":2}' },
		]);
	});

	it("buffers frames split across arbitrary chunk boundaries", () => {
		const parser = createSseFrameParser();
		expect(parser.push("id: 7\neve")).toEqual([]);
		expect(parser.push("nt: chat\ndata: {\"a\"")).toEqual([]);
		expect(parser.push(":1}\n\nid: 8\n")).toEqual([{ id: "7", event: "chat", data: '{"a":1}' }]);
		expect(parser.push("data: {}\n\n")).toEqual([{ id: "8", data: "{}" }]);
	});

	it("ignores keepalive comments and blank lines", () => {
		const parser = createSseFrameParser();
		expect(parser.push(": keepalive\n\n: keepalive\n\ndata: x\n\n")).toEqual([{ data: "x" }]);
	});

	it("joins multi-line data fields with newlines", () => {
		const parser = createSseFrameParser();
		expect(parser.push("data: line one\ndata: line two\n\n")).toEqual([{ data: "line one\nline two" }]);
	});

	it("strips only the first space after the field colon", () => {
		const parser = createSseFrameParser();
		expect(parser.push("data:  padded\n\ndata:tight\n\n")).toEqual([{ data: " padded" }, { data: "tight" }]);
	});

	it("normalizes CRLF line endings, including a CRLF split across chunks", () => {
		const parser = createSseFrameParser();
		expect(parser.push("id: 1\r\ndata: a\r")).toEqual([]);
		expect(parser.push("\n\r\ndata: b\r\n\r\n")).toEqual([
			{ id: "1", data: "a" },
			{ data: "b" },
		]);
	});

	it("flushes a final unterminated frame at end of stream", () => {
		const parser = createSseFrameParser();
		expect(parser.push("id: 9\ndata: tail")).toEqual([]);
		expect(parser.flush()).toEqual([{ id: "9", data: "tail" }]);
		expect(parser.flush()).toEqual([]);
	});

	it("drops frames that carry no data", () => {
		const parser = createSseFrameParser();
		expect(parser.push("id: 3\nevent: ping\n\nretry: 500\n\n")).toEqual([]);
		expect(parser.flush()).toEqual([]);
	});
});
