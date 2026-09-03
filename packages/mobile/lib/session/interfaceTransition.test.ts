import { describe, expect, it } from "vitest";
import {
	interfaceSwitchUnavailableMessage,
	interfaceTransitionPollInterval,
} from "./interfaceTransition";

const daemonReason =
	"session: native conversation id is not confirmed for the current terminal launch for claude-code";

describe("mobile interface transition polling", () => {
	it("polls quickly while a transition is active", () => {
		expect(interfaceTransitionPollInterval({ transition: { phase: "draining" } })).toBe(300);
	});

	it("does not poll while idle or after a transition settles", () => {
		expect(interfaceTransitionPollInterval()).toBeUndefined();
		expect(interfaceTransitionPollInterval({})).toBeUndefined();
		expect(interfaceTransitionPollInterval({ transition: { phase: "completed" } })).toBeUndefined();
	});

	it.each(["NATIVE_SESSION_MISSING", "NATIVE_SESSION_UNVERIFIED"])(
		"rechecks %s once a second, since it clears without the user doing anything",
		(reasonCode) => {
			expect(interfaceTransitionPollInterval({ reasonCode })).toBe(1_000);
		},
	);

	it.each(["CHAT_UNSUPPORTED", "INTERFACE_HANDOFF_UNSUPPORTED", "SESSION_TERMINATED"])(
		"never polls %s, which no amount of waiting resolves",
		(reasonCode) => {
			expect(interfaceTransitionPollInterval({ reasonCode })).toBeUndefined();
		},
	);

	it("keeps the fast cadence when a transition starts during a readiness wait", () => {
		expect(
			interfaceTransitionPollInterval({
				reasonCode: "NATIVE_SESSION_UNVERIFIED",
				transition: { phase: "requested" },
			}),
		).toBe(300);
	});
});

describe("chat unavailable copy", () => {
	it("replaces the daemon's Go error while the native session is still settling", () => {
		const message = interfaceSwitchUnavailableMessage({
			reasonCode: "NATIVE_SESSION_UNVERIFIED",
			reason: daemonReason,
		});
		expect(message).not.toContain(daemonReason);
		expect(message).toContain("Try again in a moment");
	});

	it("passes the daemon's reason through for a verdict the user has to act on", () => {
		expect(
			interfaceSwitchUnavailableMessage({
				reasonCode: "CHAT_UNSUPPORTED",
				reason: "cursor does not support Chat UI.",
			}),
		).toBe("cursor does not support Chat UI.");
	});

	it("falls back to the request error, then to generic copy", () => {
		expect(interfaceSwitchUnavailableMessage(undefined, "Network request failed")).toBe(
			"Network request failed",
		);
		expect(interfaceSwitchUnavailableMessage()).toMatch(/compatible native conversation handoff/);
	});
});
