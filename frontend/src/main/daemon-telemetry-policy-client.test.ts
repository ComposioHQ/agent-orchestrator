import { describe, expect, it, vi } from "vitest";
import { DaemonTelemetryPolicyClient } from "./daemon-telemetry-policy-client";

describe("DaemonTelemetryPolicyClient", () => {
	it("accepts only an exact loopback control origin and typed acknowledgement", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			status: "applied", consentGeneration: "generation-1", eventsEnabled: false, purgeConfirmed: true,
		}), { status: 200, headers: { "content-type": "application/json" } }));
		const client = new DaemonTelemetryPolicyClient(() => "http://127.0.0.1:3001", fetcher);
		await expect(client.applyPolicy("generation-1", false)).resolves.toEqual({
			status: "applied", consentGeneration: "generation-1", eventsEnabled: false, purgeConfirmed: true,
		});
		expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:3001/internal/agent-switch-observability/apply-policy", expect.objectContaining({ method: "POST" }));
	});

	it("rejects non-loopback origins before issuing a request", async () => {
		const fetcher = vi.fn();
		const client = new DaemonTelemetryPolicyClient(() => "https://daemon.example", fetcher);
		await expect(client.prepareDisable()).rejects.toThrow("loopback");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects stale or malformed acknowledgements", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "applied", consentGeneration: "old", eventsEnabled: false, purgeConfirmed: true }), { status: 200 }));
		const client = new DaemonTelemetryPolicyClient(() => "http://127.0.0.1:3001", fetcher);
		await expect(client.applyPolicy("new", false)).rejects.toThrow("generation mismatch");
	});
});
