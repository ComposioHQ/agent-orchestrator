import { describe, expect, it, vi } from "vitest";
import type { TelemetryPolicySnapshot } from "../shared/telemetry-policy";
import { DesktopTelemetryController } from "./desktop-telemetry-controller";

describe("DesktopTelemetryController", () => {
	it("cancels visibility before disable and advances it with every trusted generation", async () => {
		const authority = new AuthorityFake(true, "generation-on");
		const visibility = { setPolicy: vi.fn(), disableAndDrain: vi.fn().mockResolvedValue(undefined), closeAndDrain: vi.fn().mockResolvedValue(undefined) };
		const transport = { closeAndDrain: vi.fn(), capture: vi.fn(), clearCache: vi.fn() };
		const daemon = {
			prepareDisable: vi.fn().mockResolvedValue({ status: "applied", consentGeneration: "generation-on", eventsEnabled: false, gateDrained: true, purgeConfirmed: false }),
			applyPolicy: vi.fn().mockImplementation(async (generation: string, enabled: boolean) => ({ status: "applied", consentGeneration: generation, eventsEnabled: enabled, gateDrained: !enabled, purgeConfirmed: !enabled })),
		};
		const controller = new DesktopTelemetryController({ authority, daemon, transportFactory: async () => transport, environmentAllowsEvents: true, productionEnabled: true, visibility });
		await controller.initialize();
		await controller.setEventsEnabled(false, "generation-on");
		expect(visibility.setPolicy).toHaveBeenCalledWith(false, "generation-on");
		expect(visibility.setPolicy).toHaveBeenLastCalledWith(false, "generation-1");
		expect(visibility.setPolicy.mock.invocationCallOrder[1]).toBeLessThan(transport.closeAndDrain.mock.invocationCallOrder[0]);
		await controller.close();
		expect(visibility.closeAndDrain).toHaveBeenCalled();
	});

	it("keeps opt-out cleanup pending when any desktop purge fails", async () => {
		const authority = new AuthorityFake(true, "generation-on");
		const transport = { closeAndDrain: vi.fn(), capture: vi.fn(), clearCache: vi.fn().mockRejectedValue(new Error("cache purge failed")) };
		const daemon = { prepareDisable: vi.fn().mockResolvedValue({ status: "applied", consentGeneration: "generation-on", eventsEnabled: false, gateDrained: true, purgeConfirmed: false }), applyPolicy: vi.fn().mockImplementation(async (generation: string, enabled: boolean) => ({ status: "applied", consentGeneration: generation, eventsEnabled: enabled, gateDrained: !enabled, purgeConfirmed: !enabled })) };
		const controller = new DesktopTelemetryController({ authority, daemon, transportFactory: async () => transport, environmentAllowsEvents: true, productionEnabled: true, clearRendererQueues: vi.fn().mockRejectedValue(new Error("queue purge failed")) });
		await controller.initialize();
		const result = await controller.setEventsEnabled(false, "generation-on");
		expect(result).toMatchObject({ eventsEnabled: false, state: "cleanup_pending", acknowledged: false, reason: "cleanup_failed" });
	});

	it("fails closed in memory when the durable off replacement fails", async () => {
		const authority = new AuthorityFake(true, "generation-on");
		authority.failWrites = true;
		const daemon = { prepareDisable: vi.fn().mockResolvedValue({ status: "applied", consentGeneration: "generation-on", eventsEnabled: false, gateDrained: true, purgeConfirmed: false }), applyPolicy: vi.fn().mockImplementation(async (generation: string, enabled: boolean) => ({ status: "applied", consentGeneration: generation, eventsEnabled: enabled, gateDrained: !enabled, purgeConfirmed: !enabled })) };
		const controller = new DesktopTelemetryController({ authority, daemon, transportFactory: async () => ({ closeAndDrain: async () => {}, capture: () => {}, clearCache: async () => {} }), environmentAllowsEvents: true, productionEnabled: true });
		await controller.initialize();
		await expect(controller.setEventsEnabled(false, "generation-on")).rejects.toThrow("write failed");
		expect(controller.snapshot()).toMatchObject({ eventsEnabled: false, acknowledged: false, state: "cleanup_failed" });
	});

	it("writes one durable off generation even when prepare is unavailable and remains pending without purge acknowledgement", async () => {
		const authority = new AuthorityFake(true, "generation-on");
		const transport = { closeAndDrain: vi.fn(), capture: vi.fn(), clearCache: vi.fn() };
		const daemon = { prepareDisable: vi.fn().mockRejectedValue(new Error("offline")), applyPolicy: vi.fn().mockResolvedValueOnce({ status: "applied", consentGeneration: "generation-on", eventsEnabled: true, gateDrained: false, purgeConfirmed: false }).mockRejectedValue(new Error("offline")) };
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
			prepareDisable: vi.fn().mockResolvedValue({ status: "applied", consentGeneration: "generation-off", eventsEnabled: false, gateDrained: true, purgeConfirmed: false }),
			applyPolicy: vi.fn().mockImplementation(async (generation: string, enabled: boolean) => ({ status: "applied", consentGeneration: generation, eventsEnabled: enabled, gateDrained: !enabled, purgeConfirmed: !enabled })),
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
	failWrites = false;
	writeSpy = vi.fn();
	private current: TelemetryPolicySnapshot;
	constructor(enabled: boolean, generation: string) { this.current = { eventsEnabled: enabled, consentGeneration: generation, updatedAt: "2026-08-28T10:15:30.000Z", acknowledged: true }; }
	snapshot() { return { ...this.current }; }
	async load() { return this.snapshot(); }
	async setEventsEnabled(enabled: boolean) { this.writes.push(enabled); this.writeSpy(); if (this.failWrites) throw new Error("write failed"); this.current = { eventsEnabled: enabled, consentGeneration: `generation-${this.writes.length}`, updatedAt: "2026-08-28T10:15:31.000Z", acknowledged: true }; return this.snapshot(); }
	readonly durabilitySupported = true;
}
