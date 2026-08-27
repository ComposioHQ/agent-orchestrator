import { describe, expect, it } from "vitest";
import { actionFor, BACKGROUND_SUSPENSION_MS } from "./connectionAction";

const connected = { status: "connected" as const, backgroundedForMs: 0, online: true };

describe("actionFor", () => {
	// The rule that decides whether the app feels instant on reopen. A healthy
	// session survives being backgrounded, so foregrounding checks it rather
	// than tearing it down — reconnecting here is what makes an app spin for
	// seconds every single time it is opened.
	it("probes an existing session on foreground rather than reconnecting", () => {
		expect(actionFor("foreground", connected)).toBe("probe");
	});

	// After a real suspension the OS may have killed the socket underneath us,
	// so the probe would just be a slower path to the same reconnect.
	it("re-races after a long background suspension", () => {
		expect(
			actionFor("foreground", { ...connected, backgroundedForMs: BACKGROUND_SUSPENSION_MS + 1 }),
		).toBe("re-race");
	});

	it("re-races on foreground when there was no session to keep", () => {
		expect(actionFor("foreground", { ...connected, status: "disconnected" })).toBe("re-race");
	});

	// Changing networks invalidates the winning endpoint outright: the LAN
	// address that won at home is a stranger's device on the next network.
	it("re-races on a network change", () => {
		expect(actionFor("network-change", connected)).toBe("re-race");
	});

	// Leaving a network usually hangs rather than errors, so the heartbeat is
	// what actually notices; a miss means the chosen endpoint is gone.
	it("re-races on a heartbeat miss", () => {
		expect(actionFor("heartbeat-miss", connected)).toBe("re-race");
	});

	it("re-races when the socket closes", () => {
		expect(actionFor("socket-close", connected)).toBe("re-race");
	});

	it("re-races when the user explicitly retries", () => {
		expect(actionFor("manual-retry", { ...connected, status: "error" })).toBe("re-race");
	});

	// Offline is not a failure. Racing endpoints with no network burns retry
	// budget and battery to learn something the OS already told us.
	it("does nothing while the device is offline", () => {
		for (const trigger of ["foreground", "network-change", "heartbeat-miss", "socket-close"] as const) {
			expect(actionFor(trigger, { ...connected, online: false })).toBe("none");
		}
	});

	// Coming back online is the signal to try again, without waiting for a
	// heartbeat to time out first.
	it("re-races when the network returns", () => {
		expect(actionFor("network-change", { ...connected, status: "disconnected", online: true })).toBe("re-race");
	});

	// A connect already in flight must not be restarted by an unrelated wake:
	// restarting an in-flight attempt only delays it.
	it("leaves an in-flight connection alone on foreground", () => {
		expect(actionFor("foreground", { ...connected, status: "connecting" })).toBe("none");
	});

	// A genuine suspension is the exception — the socket it is waiting on may
	// already be dead.
	it("restarts an in-flight connection after a real suspension", () => {
		expect(
			actionFor("foreground", {
				...connected,
				status: "connecting",
				backgroundedForMs: BACKGROUND_SUSPENSION_MS + 1,
			}),
		).toBe("re-race");
	});
});
