import { describe, expect, it } from "vitest";
import { androidStreamUrlFromApiBase } from "./android-stream";

describe("androidStreamUrlFromApiBase", () => {
	it("converts an http(s) API base to ws(s) and appends the stream path", () => {
		expect(androidStreamUrlFromApiBase("http://127.0.0.1:4317")).toBe(
			"ws://127.0.0.1:4317/api/v1/android-device/stream",
		);
		expect(androidStreamUrlFromApiBase("https://host:8443/")).toBe(
			"wss://host:8443/api/v1/android-device/stream",
		);
	});

	it("uses the current origin for a relative dev API base", () => {
		expect(androidStreamUrlFromApiBase("")).toBe("ws://localhost:3000/api/v1/android-device/stream");
	});
});
