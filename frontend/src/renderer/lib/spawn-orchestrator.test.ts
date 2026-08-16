import { describe, expect, it, vi, beforeEach } from "vitest";
import { isChatPreflightError, OrchestratorSpawnError, spawnOrchestrator } from "./spawn-orchestrator";
import { AgentNotInstalledError } from "./agent-install-preflight";
import { apiClient } from "./api-client";
import { captureRendererEvent } from "./telemetry";

vi.mock("./api-client", () => ({
	apiClient: { GET: vi.fn(), POST: vi.fn() },
	apiErrorCode: (error: unknown) =>
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: undefined,
	apiErrorRequestId: (error: unknown) =>
		typeof error === "object" && error !== null && "requestId" in error
			? String((error as { requestId: unknown }).requestId)
			: undefined,
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (typeof error === "object" && error !== null && "message" in error) {
			const body = error as { code?: unknown; message: unknown };
			const message = String(body.message);
			return typeof body.code === "string" && body.code !== "" ? `${message} (${body.code})` : message;
		}
		return fallback;
	},
}));

vi.mock("./telemetry", () => ({
	captureRendererEvent: vi.fn().mockResolvedValue(undefined),
}));

const captureMock = vi.mocked(captureRendererEvent);

// The project's configured orchestrator agent, installed. Every existing case
// expects the spawn to reach the daemon, so the default catalog is a machine
// where the agent's CLI is present.
function mockReadyProject(agentId = "claude-code") {
	(apiClient.GET as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
		if (url === "/api/v1/projects/{id}") {
			return Promise.resolve({
				data: { status: "ok", project: { config: { orchestrator: { agent: agentId } } } },
				error: undefined,
			});
		}
		if (url === "/api/v1/agents") {
			return Promise.resolve({
				data: {
					supported: [{ id: agentId, label: "Claude Code" }],
					installed: [{ id: agentId, label: "Claude Code" }],
					authorized: [],
				},
				error: undefined,
			});
		}
		return Promise.resolve({ data: undefined, error: { code: "NOT_FOUND" } });
	});
}

describe("spawnOrchestrator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReadyProject();
	});

	it("sends clean:true through to the request body when asked", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { orchestrator: { id: "proj-9" } },
			error: undefined,
			response: { status: 201 },
		});
		const id = await spawnOrchestrator("proj", "restore_dialog", true);
		expect(id).toBe("proj-9");
		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj", clean: true },
		});
	});

	it("defaults clean to false / omitted for the existing call sites", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { orchestrator: { id: "proj-1" } },
			error: undefined,
			response: { status: 201 },
		});
		await spawnOrchestrator("proj", "board");
		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj", clean: false },
		});
	});

	it("sends mode only when the user explicitly chooses it", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { orchestrator: { id: "proj-2" } },
			error: undefined,
			response: { status: 201 },
		});
		await spawnOrchestrator("proj", "board", false, "tui");
		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj", clean: false, mode: "tui" },
		});
	});

	it("emits the requested + succeeded triad keyed by source", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { orchestrator: { id: "proj-7" } },
			error: undefined,
			response: { status: 201 },
		});
		await spawnOrchestrator("proj", "sidebar");
		expect(captureMock).toHaveBeenCalledWith("ao.renderer.orchestrator_spawn_requested", {
			project_id: "proj",
			source: "sidebar",
		});
		expect(captureMock).toHaveBeenCalledWith("ao.renderer.orchestrator_spawn_succeeded", {
			project_id: "proj",
			source: "sidebar",
		});
	});

	it("emits the failed event and rethrows when the daemon rejects the spawn", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: undefined,
			error: { message: "boom" },
			response: { status: 500 },
		});
		await expect(spawnOrchestrator("proj", "topbar")).rejects.toThrow("boom");
		expect(captureMock).toHaveBeenCalledWith("ao.renderer.orchestrator_spawn_failed", {
			project_id: "proj",
			source: "topbar",
		});
		expect(captureMock).not.toHaveBeenCalledWith("ao.renderer.orchestrator_spawn_succeeded", expect.anything());
	});

	it("surfaces daemon spawn error messages and codes", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: undefined,
			error: {
				code: "CHAT_DRIVER_UNAVAILABLE",
				message: "chat driver is unavailable",
				requestId: "request-42",
			},
			response: { status: 400 },
		});

		const error = await spawnOrchestrator("proj", "board").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OrchestratorSpawnError);
		expect(error).toMatchObject({
			code: "CHAT_DRIVER_UNAVAILABLE",
			requestId: "request-42",
			status: 400,
		});
		expect((error as Error).message).toBe("chat driver is unavailable (CHAT_DRIVER_UNAVAILABLE)");
		expect(isChatPreflightError(error)).toBe(true);
	});

	// The daemon refuses this spawn too, but only after a round trip that lands in
	// spawn telemetry. A missing CLI is a setup gap, so the click never becomes a
	// spawn request.
	it("refuses to request a spawn when the project's orchestrator agent is not installed", async () => {
		(apiClient.GET as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
			if (url === "/api/v1/projects/{id}") {
				return Promise.resolve({
					data: { status: "ok", project: { config: { orchestrator: { agent: "goose" } } } },
					error: undefined,
				});
			}
			return Promise.resolve({
				data: { supported: [{ id: "goose", label: "Goose" }], installed: [], authorized: [] },
				error: undefined,
			});
		});
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { agent: { id: "goose", label: "Goose" }, supported: true, installed: false },
			error: undefined,
			response: { status: 200 },
		});

		const error = await spawnOrchestrator("proj", "board").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AgentNotInstalledError);
		expect(error).toMatchObject({ agentId: "goose", agentLabel: "Goose" });
		expect(apiClient.POST).not.toHaveBeenCalledWith("/api/v1/orchestrators", expect.anything());
		expect(captureMock).toHaveBeenCalledWith("ao.renderer.orchestrator_spawn_failed", {
			project_id: "proj",
			source: "board",
		});
	});

	// The gate is advisory: nothing it cannot answer may stop a spawn the daemon
	// would have accepted.
	it("still spawns when the project config cannot be read", async () => {
		(apiClient.GET as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("daemon restarting"));
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { orchestrator: { id: "proj-3" } },
			error: undefined,
			response: { status: 201 },
		});

		await expect(spawnOrchestrator("proj", "board")).resolves.toBe("proj-3");
	});
});
