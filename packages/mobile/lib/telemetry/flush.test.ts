import { describe, expect, it } from "vitest";
import { createMobileTelemetry, type MobileTelemetryClient } from "./telemetry";

describe("createMobileTelemetry flush", () => {
	it("drains the underlying client when it supports flush", () => {
		let flushed = 0;
		const client: MobileTelemetryClient = {
			capture: () => {},
			register: () => {},
			flush: () => {
				flushed++;
			},
		};
		const t = createMobileTelemetry(client, {});
		t.flush();
		expect(flushed).toBe(1);
	});

	it("is a safe no-op when the client does not implement flush", () => {
		const client: MobileTelemetryClient = {
			capture: () => {},
			register: () => {},
		};
		const t = createMobileTelemetry(client, {});
		expect(() => t.flush()).not.toThrow();
	});
});
