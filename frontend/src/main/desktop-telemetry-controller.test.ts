import { describe, expect, it, vi } from "vitest";
import type { TelemetryPolicySnapshot } from "../shared/telemetry-policy";
import { DesktopTelemetryController } from "./desktop-telemetry-controller";

describe("DesktopTelemetryController", () => {
	it("writes one durable off generation even when prepare is unavailable and remains pending without purge acknowledgement", async () => {
		const authority = new AuthorityFake(true, "generation-on");
		const transport = { closeAndDrain: vi.fn(), capture: vi.fn(), clearCache: vi.fn() };
		const daemon = { prepareDisable: vi.fn().mockRejectedValue(new Error("offline")), applyPolicy: vi.fn().mockResolvedValueOnce({ status: "applied", consentGeneration: "generation-on", eventsEnabled: true, purgeConfirmed: false }).mockRejectedValue(new Error("offline")) };
		const controller = new DesktopTelemetryController({ authority, daemon, transportFactory: async () => transport, environmentAllowsEvents: true, productionEnabled: true });
		await controller.initialize();
		const result = await controller.setEventsEnabled(false, "generation-on");
		expect(authority.writes).toEqual([false]);
		expect(transport.closeAndDrain.mock.invocationCallOrder[0]).toBeLessThan(authority.writeSpy.mock.invocationCallOrder[0]);
		expect(result).toMatchObject({ eventsEnabled: false, state: "cleanup_pending", acknowledged: false });
	});

	it("rejects stale renderer generations and broadcasts disable then enable to the same subscriber", async () => {
		const authority = new AuthorityFake(false, "generation-off");
		const daemon = {
			prepareDisable: vi.fn().mockResolvedValue({ status: "applied", consentGeneration: "generation-off", eventsEnabled: false, purgeConfirmed: true }),
			applyPolicy: vi.fn().mockImplementation(async (generation: string, enabled: boolean) => ({ status: "applied", consentGeneration: generation, eventsEnabled: enabled, purgeConfirmed: !enabled })),
		};
		const views: string[] = [];
		const controller = new DesktopTelemetryController({ authority, daemon, transportFactory: async () => ({ closeAndDrain: async () => {}, capture: () => {}, clearCache: async () => {} }), environmentAllowsEvents: true, productionEnabled: true, broadcast: (view) => views.push(view.consentGeneration) });
		await controller.initialize();
		await expect(controller.setEventsEnabled(true, "stale")).rejects.toThrow("stale");
		await controller.setEventsEnabled(true, "generation-off");
		expect(views.at(-1)).toBe("generation-1");
	});
});

class AuthorityFake {
	writes: boolean[] = [];
	writeSpy = vi.fn();
	private current: TelemetryPolicySnapshot;
	constructor(enabled: boolean, generation: string) { this.current = { eventsEnabled: enabled, consentGeneration: generation, updatedAt: "2026-08-28T10:15:30.000Z", acknowledged: true }; }
	snapshot() { return { ...this.current }; }
	async load() { return this.snapshot(); }
	async setEventsEnabled(enabled: boolean) { this.writes.push(enabled); this.writeSpy(); this.current = { eventsEnabled: enabled, consentGeneration: `generation-${this.writes.length}`, updatedAt: "2026-08-28T10:15:31.000Z", acknowledged: true }; return this.snapshot(); }
	readonly durabilitySupported = true;
}
