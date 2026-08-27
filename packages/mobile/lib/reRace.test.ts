import { describe, expect, it } from "vitest";
import { RE_RACE_AFTER_FAILURES, RE_RACE_COOLDOWN_MS, shouldReRace } from "./reRace";

const at = (over: Partial<Parameters<typeof shouldReRace>[0]> = {}) => ({
	consecutiveFailures: RE_RACE_AFTER_FAILURES,
	lastReRaceAt: 0,
	now: 100_000,
	...over,
});

describe("shouldReRace", () => {
	// The failure that matters: paired over LAN, then Wi-Fi drops. The stored
	// endpoint is now unreachable and nothing else will notice — there is no
	// network-change listener — so a run of failed polls is the signal to race
	// the candidates again and land on the tunnel.
	it("re-races once the failures look like a dead endpoint", () => {
		expect(shouldReRace(at())).toBe(true);
	});

	// One failed poll is normal: a dropped packet, a backgrounded radio, a
	// daemon mid-restart. Re-racing on every blip would thrash the connection.
	it("tolerates a single failure", () => {
		expect(shouldReRace(at({ consecutiveFailures: 1 }))).toBe(false);
	});

	it("does nothing while the connection is healthy", () => {
		expect(shouldReRace(at({ consecutiveFailures: 0 }))).toBe(false);
	});

	// Racing every few seconds against a genuinely offline phone would burn
	// battery and hammer the daemon once it returns.
	it("will not re-race again inside the cooldown", () => {
		expect(shouldReRace(at({ lastReRaceAt: 100_000 - RE_RACE_COOLDOWN_MS + 1 }))).toBe(false);
	});

	it("re-races again once the cooldown has passed", () => {
		expect(shouldReRace(at({ lastReRaceAt: 100_000 - RE_RACE_COOLDOWN_MS - 1 }))).toBe(true);
	});

	// First ever failure run: there is no previous attempt to wait behind.
	it("re-races on the first failure run without waiting", () => {
		expect(shouldReRace(at({ lastReRaceAt: 0, now: 5_000 }))).toBe(true);
	});
});
